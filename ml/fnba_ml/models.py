"""the model ladder, the two trained champions, and the minutes-propagating
composition that multiplies them together.

deliberately a LADDER, not a leaderboard: every target starts with the dumbest
defensible baseline (a shifted historical mean), then a linear model, then
LightGBM. if the gradient booster cannot beat a shifted rolling mean, that is a
finding about the target, not a bug to tune away.

WHAT ACTUALLY SHIPS (config.CHAMPIONS):

  availability      LightGBM classifier    -34% Brier vs the shifted appearance
                                           rate. the one large, stable win.
  minutes|played    LightGBM regressor     beat EWMA by 2.1% MAE across all five
                                           origins; promoted 2026-08-17.
  production rate   EWMA(halflife 5) of    no trained model beats a smoothed
                    stat-per-minute        per-minute rate by more than noise.
  composition       P x E[min] x rate      how the three are combined.

THE COMPOSITION, and why it changed on 2026-08-17. it used to be

    E[stat] = P(play) x EWMA(stat)

which is arithmetically fine and structurally broken: EWMA(stat) is an average of
past whole-game totals, so it silently embeds the minutes the player USED TO get.
A backup whose minutes model says 30 tonight still got the points EWMA of his
14-minute nights, and no amount of minutes signal could reach the number. the
promoted form is

    E[stat | plays] = E[minutes | plays] x EWMA(stat per minute)
    E[stat]         = P(plays) x E[stat | plays]

so predicted minutes propagate into every production stat, and the conditional
number on a player card is the product of the two rows above it rather than an
unrelated third estimate. the aggregate MAE is unchanged within noise (4.005 vs
4.007 over five origins) - that is the expected result, because most players'
predicted minutes are close to their recent minutes. the change is for the
players where they are not, which is exactly where fantasy value moves.

OUT-OF-FOLD DISCIPLINE, now over THREE quantities. the composition multiplies an
availability probability AND a minutes prediction into a downstream estimate. if
either came from a model whose training window included the row being predicted,
the whole number is contaminated and nothing downstream can detect it. both
therefore travel with the cutoff of the model that produced them, and
:func:`validate_out_of_fold` refuses any row whose cutoff is not at or before its
own game date. :func:`minutes_propagated_estimate` runs the guard on both before
it multiplies anything.

THE THIRD QUANTITY, new in feature_version v3: p_context, the teammates' play
probabilities that the served teammate-context FEATURES are built from. It is the
same guard applied one layer earlier - not to a number that gets multiplied, but to
a number that gets featurised. :func:`cross_fit_base_probabilities` is stages 1 and
2 of the two-stage pipeline: a base availability model that sees NO teammate
context, cross-fitted over forward-chaining calendar blocks so that every scheduled
row - training rows included - carries a probability produced strictly before its
own block. Its docstring argues why a per-origin refit cannot do the same job.

nothing in this module does any splitting - evaluate.py owns the rolling-origin
scheme.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.metrics import log_loss, mean_absolute_error
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

import lightgbm as lgb

from .config import (
    BASE_FEATURE_COLS,
    CHAMPIONS,
    COHERENCE_CONSTRAINTS,
    CROSS_FIT_FREQ,
    CROSS_FIT_MIN_TRAIN_ROWS,
    EWMA_HALFLIFE,
    LGBM_PARAMS,
    MINUTES_TARGET,
    P_CONTEXT,
    P_CONTEXT_CUTOFF,
    RANDOM_STATE,
    RATE_MINUTES_FLOOR,
    RATE_TARGETS,
    ROLL_STATS,
    TEAMMATE_FEATURE_COLS,
    TEAMMATE_ORACLE_COLS,
    rate_estimator,
    rate_halflife,
)

log = logging.getLogger(__name__)

EPS = 1e-3

P_PLAY = "P_PLAY"
P_PLAY_CUTOFF = "P_PLAY_CUTOFF"

# E[minutes | plays] and the cutoff of the model that produced it. named
# separately from the frame's own MIN (the outcome) and from predict.py's
# E_MIN_COND (the served column) so that no code path can confuse a prediction
# with an outcome by getting a column name almost right.
MIN_PRED = "MIN_PRED"
MIN_PRED_CUTOFF = "MIN_PRED_CUTOFF"


class LeakageError(RuntimeError):
    """raised when an in-fold quantity is about to be used downstream."""


# ---- metrics ----
def brier(y_true, p) -> float:
    return float(np.mean((np.asarray(p, dtype=float) - np.asarray(y_true, dtype=float)) ** 2))


def logloss(y_true, p) -> float:
    p = np.clip(np.asarray(p, dtype=float), EPS, 1 - EPS)
    return float(log_loss(np.asarray(y_true), p, labels=[0, 1]))


def mae(y_true, y_pred) -> float:
    return float(mean_absolute_error(np.asarray(y_true, dtype=float),
                                     np.asarray(y_pred, dtype=float)))


def skill_score(model_metric: float, baseline_metric: float) -> float:
    """fraction of the baseline's error removed. positive means better."""
    if baseline_metric == 0:
        return float("nan")
    return float(1.0 - model_metric / baseline_metric)


def residual_interval(residuals, level: float) -> tuple[float, float]:
    """symmetric empirical prediction interval offsets at a nominal level."""
    r = np.asarray(residuals, dtype=float)
    r = r[np.isfinite(r)]
    if r.size == 0:
        return (float("nan"), float("nan"))
    tail = (1.0 - level) / 2.0
    return float(np.quantile(r, tail)), float(np.quantile(r, 1.0 - tail))


def quantile_coverage(y_true, y_pred, lo: float, hi: float) -> float:
    """share of outcomes falling inside pred+lo .. pred+hi."""
    y_true = np.asarray(y_true, dtype=float)
    y_pred = np.asarray(y_pred, dtype=float)
    inside = (y_true >= y_pred + lo) & (y_true <= y_pred + hi)
    return float(np.mean(inside))


# ---- estimator constructors ----
def make_logistic() -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("clf", LogisticRegression(max_iter=2000, C=1.0, random_state=RANDOM_STATE)),
    ])


def make_ridge() -> Pipeline:
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("reg", Ridge(alpha=1.0, random_state=RANDOM_STATE)),
    ])


def make_lgbm_classifier() -> lgb.LGBMClassifier:
    return lgb.LGBMClassifier(**LGBM_PARAMS)


def make_lgbm_regressor() -> lgb.LGBMRegressor:
    return lgb.LGBMRegressor(**LGBM_PARAMS)


ESTIMATORS = {
    "logistic": make_logistic,
    "ridge": make_ridge,
    "lightgbm_classifier": make_lgbm_classifier,
    "lightgbm": make_lgbm_regressor,
}


# ---- fit/predict helpers ----
def fit_predict_proba(model, train, valid, feature_cols, target) -> np.ndarray:
    model.fit(train[feature_cols], train[target].astype(int))
    return model.predict_proba(valid[feature_cols])[:, 1]


def fit_predict(model, train, valid, feature_cols, target, clip_min: float | None = 0.0):
    model.fit(train[feature_cols], train[target])
    pred = model.predict(valid[feature_cols])
    if clip_min is not None:
        pred = np.clip(pred, clip_min, None)
    return pred


def baseline_column(valid: pd.DataFrame, col: str, fallback: float) -> np.ndarray:
    """a baseline that is simply a precomputed shifted-history column."""
    return valid[col].fillna(fallback).to_numpy(dtype=float)


# ---- availability ----
@dataclass
class AvailabilityModel:
    """the one trained model in the promoted path.

    ``cutoff`` is the exclusive upper bound of the training window and travels
    with every probability this model emits, so downstream code can prove the
    probability was out of fold.
    """

    kind: str = CHAMPIONS["availability"]
    feature_cols: list[str] = field(default_factory=list)
    cutoff: pd.Timestamp | None = None
    estimator: object | None = None

    def fit(self, train: pd.DataFrame, feature_cols: list[str],
            cutoff: pd.Timestamp, target: str = "PLAYED") -> "AvailabilityModel":
        cutoff = pd.Timestamp(cutoff)
        late = train["GAME_DATE"] >= cutoff
        if late.any():
            raise LeakageError(
                f"{int(late.sum())} training rows are on or after the cutoff "
                f"{cutoff.date()} - the training window would include the games "
                f"it is meant to predict"
            )
        factory = ESTIMATORS["lightgbm_classifier" if self.kind == "lightgbm" else self.kind]
        self.estimator = factory()
        self.feature_cols = list(feature_cols)
        self.cutoff = cutoff
        self.estimator.fit(train[self.feature_cols], train[target].astype(int))
        return self

    def predict_proba(self, frame: pd.DataFrame) -> np.ndarray:
        if self.estimator is None:
            raise RuntimeError("availability model is not fitted")
        return self.estimator.predict_proba(frame[self.feature_cols])[:, 1]

    def attach(self, frame: pd.DataFrame) -> pd.DataFrame:
        """return frame + P_PLAY + the cutoff that makes it auditable."""
        out = frame.copy()
        out[P_PLAY] = self.predict_proba(frame)
        out[P_PLAY_CUTOFF] = self.cutoff
        return out

    def feature_gain(self) -> pd.Series:
        booster = getattr(self.estimator, "booster_", None)
        if booster is None:
            return pd.Series(dtype=float)
        return pd.Series(
            booster.feature_importance("gain"), index=self.feature_cols
        ).sort_values(ascending=False)


def validate_out_of_fold(
    frame: pd.DataFrame,
    value_col: str = P_PLAY,
    cutoff_col: str = P_PLAY_CUTOFF,
    label: str = "P(play)",
) -> pd.DataFrame:
    """assert every value came from a model trained strictly before its row.

    this is the guard REPORT.md section 6 implication 4 asks for. it is cheap
    and it is the only thing standing between a composed estimate and a
    silently contaminated one.

    parameterised over the (value, cutoff) pair because the composition now
    multiplies TWO model outputs together - P(play) and E[minutes | plays] - and
    a guard that only covered the first would leave the second free to leak.
    """
    for col in (value_col, cutoff_col, "GAME_DATE"):
        if col not in frame.columns:
            raise LeakageError(f"cannot validate out-of-fold {label}: missing column {col!r}")

    if frame[value_col].isna().any():
        raise LeakageError(f"{int(frame[value_col].isna().sum())} rows have a null {label}")
    if frame[cutoff_col].isna().any():
        raise LeakageError(
            f"{int(frame[cutoff_col].isna().sum())} rows carry no training cutoff, "
            f"so their {label} cannot be shown to be out of fold"
        )

    cutoff = pd.to_datetime(frame[cutoff_col])
    game_date = pd.to_datetime(frame["GAME_DATE"])
    bad = cutoff > game_date
    if bad.any():
        worst = int(bad.sum())
        raise LeakageError(
            f"{worst} rows carry an IN-FOLD {label}: the model's "
            f"training window extends past the game being predicted "
            f"(max overshoot {int((cutoff - game_date)[bad].dt.days.max())} days)"
        )
    return frame


def validate_minutes_out_of_fold(frame: pd.DataFrame) -> pd.DataFrame:
    """the same guard, for the minutes prediction the composition multiplies."""
    return validate_out_of_fold(frame, MIN_PRED, MIN_PRED_CUTOFF, "E[minutes|plays]")


def assert_same_cutoff(frame: pd.DataFrame) -> pd.DataFrame:
    """P(play) and E[minutes|plays] must come from the SAME information boundary.

    both being individually out of fold is not enough. if the availability model
    stopped at January and the minutes model at March, the composed number mixes
    two different views of the world, and the March half is in-fold with respect
    to any February row the January half was chosen to be honest about. the
    promoted path trains both at one cutoff, so a mismatch means an artifact was
    mixed and matched - a loading bug, not a modelling choice.
    """
    for col in (P_PLAY_CUTOFF, MIN_PRED_CUTOFF):
        if col not in frame.columns:
            raise LeakageError(f"cannot compare training cutoffs: missing column {col!r}")
    p_cutoff = pd.to_datetime(frame[P_PLAY_CUTOFF])
    m_cutoff = pd.to_datetime(frame[MIN_PRED_CUTOFF])
    bad = p_cutoff != m_cutoff
    if bad.any():
        raise LeakageError(
            f"{int(bad.sum())} rows compose a P(play) trained through "
            f"{p_cutoff[bad].max().date()} with an E[minutes|plays] trained through "
            f"{m_cutoff[bad].max().date()}: the two halves of the composition must "
            f"share one cutoff"
        )
    return frame


# ---- stage 1 + 2 of the two-stage pipeline: base probabilities ----
BASE_MODEL_KIND = CHAMPIONS["availability"]


def cross_fit_base_probabilities(
    features: pd.DataFrame,
    feature_cols: list[str] | None = None,
    freq: str = CROSS_FIT_FREQ,
    min_train_rows: int = CROSS_FIT_MIN_TRAIN_ROWS,
    kind: str = BASE_MODEL_KIND,
) -> pd.DataFrame:
    """strictly out-of-fold P(play) for EVERY scheduled row, by forward chaining.

    STAGES 1 AND 2 OF THE P1b PIPELINE, and the reason the v3 features are not
    circular. The expected-context columns are functions of p_j. If p_j came from a
    model whose training window contained row j, then row i's feature encodes a
    fitted view of j's own target-game label - the same cross-player leak v2 had,
    one indirection further away and correspondingly harder to see.

    THE SCHEME, stated so it can be argued with:

      * stage 1: the base model reads ``config.BASE_FEATURE_COLS`` only. No teammate
        context of any kind, realized or expected. That is what makes it safe to
        build teammate context FROM it.
      * stage 2: the history is cut into consecutive calendar blocks (month starts
        by default). For each block, one model is fitted on every row STRICTLY
        BEFORE the block start and used to score the block. A row's probability
        therefore never depends on any game at or after its own block start, which
        is at or before its own game date.
      * every probability carries its block start as ``P_CONTEXT_CUTOFF``, and
        :func:`validate_out_of_fold` refuses any row whose cutoff is after its own
        game date. The guard is the same one P(play) and E[minutes|plays] already
        pass through; nothing new had to be invented for it.

    WHY BLOCKS RATHER THAN A PER-ORIGIN REFIT. A base model trained strictly before
    an origin's validation window is out of fold for the VALIDATION rows and
    hopelessly in-fold for the TRAINING rows - and the training rows' context
    features are what the final model is fitted on, so the leak would simply move
    from the metric to the fit. The block cross-fit is the only scheme that is out of
    fold on both sides at once. It is forward-chaining rather than random K-fold for
    the usual reason: a random fold reads the future.

    WHY IT DOES NOT NEED REDOING PER ORIGIN. The blocks are strictly time-ordered, so
    one cross-fit is simultaneously valid for every origin: whichever origin a row
    belongs to, its p was produced without seeing its own block. Recomputing per
    origin would produce identical numbers at five times the cost.

    THE COLD BLOCKS. The first block(s) have too little history to fit anything
    useful; ``min_train_rows`` gates them and their rows fall back to the stage-0
    baseline (``features.stage0_context_probability`` - the shifted appearance rate,
    itself as-of safe). That is a weaker probability, not a leaky one, and the
    returned frame flags it in ``P_CONTEXT_SOURCE`` so the dataset build can report
    the share.
    """
    from .features import stage0_context_probability  # noqa: PLC0415 - features imports models' names in tests

    cols = list(feature_cols or BASE_FEATURE_COLS)
    present = [c for c in cols if c in features.columns]
    leaked = [c for c in present if c in TEAMMATE_FEATURE_COLS or c in TEAMMATE_ORACLE_COLS]
    if leaked:
        raise LeakageError(
            f"the base availability model was handed teammate-context features "
            f"({', '.join(leaked)}). stage 1 exists precisely to be free of them - "
            f"building expected context from a model that already saw teammate "
            f"context is circular"
        )

    frame = features.copy()
    frame["GAME_DATE"] = pd.to_datetime(frame["GAME_DATE"])
    frame = frame.sort_values("GAME_DATE").reset_index(drop=True)

    fallback = stage0_context_probability(frame).to_numpy(dtype=float)
    p = np.full(len(frame), np.nan)
    cutoff = np.full(len(frame), np.datetime64("NaT", "ns"), dtype="datetime64[ns]")
    source = np.array(["baseline"] * len(frame), dtype=object)

    dates = frame["GAME_DATE"].to_numpy()
    edges = pd.date_range(
        frame["GAME_DATE"].min().normalize(),
        frame["GAME_DATE"].max().normalize() + pd.Timedelta(days=1),
        freq=freq,
    )
    # the first edge is at or before the first game, so the opening block would be
    # empty; the last edge closes the final block.
    edges = pd.DatetimeIndex([frame["GAME_DATE"].min().normalize(), *edges,
                              frame["GAME_DATE"].max().normalize() + pd.Timedelta(days=1)])
    edges = pd.DatetimeIndex(sorted(set(edges)))

    fitted = 0
    for start, end in zip(edges[:-1], edges[1:]):
        block = (dates >= np.datetime64(start)) & (dates < np.datetime64(end))
        if not block.any():
            continue
        train_mask = dates < np.datetime64(start)
        if int(train_mask.sum()) < min_train_rows:
            p[block] = fallback[block]
            cutoff[block] = np.datetime64(start)
            continue
        train = frame.loc[train_mask]
        model = AvailabilityModel(kind=kind).fit(train, present, start)
        p[block] = model.predict_proba(frame.loc[block])
        cutoff[block] = np.datetime64(start)
        source[block] = "base-model"
        fitted += 1

    out = pd.DataFrame({
        "PLAYER_ID": frame["PLAYER_ID"].to_numpy(),
        "GAME_ID": frame["GAME_ID"].to_numpy(),
        "TEAM_ID": frame["TEAM_ID"].to_numpy(),
        "GAME_DATE": frame["GAME_DATE"].to_numpy(),
        P_CONTEXT: p,
        P_CONTEXT_CUTOFF: cutoff,
        "P_CONTEXT_SOURCE": source,
    })
    log.info(
        "cross-fit base probabilities: %d blocks fitted, %d/%d rows from the base "
        "model (%.1f%%), the rest from the stage-0 baseline",
        fitted, int((source == "base-model").sum()), len(out),
        100.0 * float((source == "base-model").mean()),
    )
    return validate_out_of_fold(out, P_CONTEXT, P_CONTEXT_CUTOFF, "p_context")


def out_of_fold_availability(
    features: pd.DataFrame,
    origins: list[tuple[str, str, str]],
    feature_cols: list[str],
    kind: str = CHAMPIONS["availability"],
) -> pd.DataFrame:
    """forward-chaining P(play) for every validation row across all origins.

    one model per origin, each trained strictly before its own validation
    window. the result is the persisted artifact the decomposed estimator reads
    (REPORT.md section 6, implication 4).
    """
    out: list[pd.DataFrame] = []
    for name, vstart, vend in origins:
        vstart_ts, vend_ts = pd.Timestamp(vstart), pd.Timestamp(vend)
        train = features[features["GAME_DATE"] < vstart_ts]
        valid = features[
            (features["GAME_DATE"] >= vstart_ts) & (features["GAME_DATE"] <= vend_ts)
        ]
        if train.empty or valid.empty:
            log.warning("origin %s has no rows on one side; skipped", name)
            continue
        model = AvailabilityModel(kind=kind).fit(train, feature_cols, vstart_ts)
        scored = model.attach(valid)
        scored["ORIGIN"] = name
        out.append(scored[["PLAYER_ID", "GAME_ID", "TEAM_ID", "GAME_DATE",
                           "ORIGIN", P_PLAY, P_PLAY_CUTOFF]])
    if not out:
        raise ValueError("no origin produced out-of-fold probabilities")
    return validate_out_of_fold(pd.concat(out, ignore_index=True))


# ---- conditional production: the champion ----
class EwmaProduction:
    """EWMA(halflife 5) of whole-game totals over appearances.

    DEMOTED 2026-08-17, and still here on purpose. it was the conditional-production
    champion until the composition changed; it is now a challenger, the parity
    reference the minutes-propagating form is measured against in evaluate.py, and
    the minutes baseline ``MinutesModel(kind='ewma')`` falls back to. a challenger
    that stops being runnable stops being a challenger, and the ladder's whole claim
    is that the promoted path was measured against the dumbest defensible thing.

    do NOT reintroduce it into the composition: an average of past whole-game TOTALS
    already contains the minutes the player used to get, which makes it constant
    with respect to any minutes forecast. see :func:`minutes_propagated_estimate`.

    the value is precomputed in features.py (``ewma_<target>``) via an as-of
    join, so this is a lookup plus a fallback, not a fit. ``fit`` exists only to
    learn the fallback constant for players with no appearance history.
    """

    kind = "ewma"

    def __init__(self, target: str, halflife: float = EWMA_HALFLIFE) -> None:
        self.target = target
        self.halflife = halflife
        self.column = f"ewma_{target}"
        self.fallback: float | None = None

    def fit(self, train: pd.DataFrame) -> "EwmaProduction":
        appearances = train[train["PLAYED"] == 1] if "PLAYED" in train.columns else train
        self.fallback = float(appearances[self.target].mean())
        return self

    @classmethod
    def from_fallback(cls, target: str, fallback: float,
                      halflife: float = EWMA_HALFLIFE) -> "EwmaProduction":
        """rebuild from a persisted snapshot instead of refitting."""
        obj = cls(target, halflife)
        obj.fallback = float(fallback)
        return obj

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        if self.fallback is None:
            raise RuntimeError("EwmaProduction.fit must run before predict")
        return np.clip(baseline_column(frame, self.column, self.fallback), 0.0, None)


# ---- conditional minutes: the champion ----
@dataclass
class MinutesModel:
    """E[minutes | plays], the second learned quantity in the promoted path.

    fitted on APPEARANCE rows only - the target is minutes given he plays, and a
    non-appearance's zero is an availability fact the P(play) model already owns.
    folding those zeros in here would produce an estimator that answers neither
    question.

    carries its training cutoff for the same reason ``AvailabilityModel`` does,
    and it matters more here: this number is now a MULTIPLIER on every production
    stat, so an in-fold minutes prediction contaminates points and assists as
    well as minutes.

    ``kind='ewma'`` is the demoted baseline, kept because the champion policy is a
    ladder and a challenger has to remain runnable to stay a challenger.
    """

    kind: str = CHAMPIONS["minutes"]
    target: str = MINUTES_TARGET
    feature_cols: list[str] = field(default_factory=list)
    cutoff: pd.Timestamp | None = None
    estimator: object | None = None
    ewma: "EwmaProduction | None" = None

    def fit(self, train_appearances: pd.DataFrame, feature_cols: list[str],
            cutoff: pd.Timestamp) -> "MinutesModel":
        cutoff = pd.Timestamp(cutoff)
        late = train_appearances["GAME_DATE"] >= cutoff
        if late.any():
            raise LeakageError(
                f"{int(late.sum())} training rows are on or after the cutoff "
                f"{cutoff.date()} - the training window would include the games "
                f"it is meant to predict"
            )
        self.feature_cols = list(feature_cols)
        self.cutoff = cutoff
        if self.kind == "ewma":
            self.ewma = EwmaProduction(self.target).fit(train_appearances)
            self.estimator = None
        else:
            self.estimator = ESTIMATORS[self.kind]()
            self.estimator.fit(train_appearances[self.feature_cols],
                               train_appearances[self.target])
        return self

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        if self.ewma is not None:
            return self.ewma.predict(frame)
        if self.estimator is None:
            raise RuntimeError("minutes model is not fitted")
        return np.clip(
            self.estimator.predict(frame[self.feature_cols]).astype(float), 0.0, None
        )

    def attach(self, frame: pd.DataFrame) -> pd.DataFrame:
        """return frame + MIN_PRED + the cutoff that makes it auditable."""
        out = frame.copy()
        out[MIN_PRED] = self.predict(frame)
        out[MIN_PRED_CUTOFF] = self.cutoff
        return out

    def feature_gain(self) -> pd.Series:
        """split gain per feature, empty for the EWMA baseline (it has none).

        the same accessor ``AvailabilityModel`` exposes. minutes is where a
        teammate-absence feature should show up first - vacated minutes are, quite
        literally, the minutes this model is trying to predict.
        """
        booster = getattr(self.estimator, "booster_", None)
        if booster is None:
            return pd.Series(dtype=float)
        return pd.Series(
            booster.feature_importance("gain"), index=self.feature_cols
        ).sort_values(ascending=False)


# ---- conditional production: per-minute rates ----
class PerMinuteRate:
    """the composition rate: a smoothed stat-per-minute over appearances.

    the value is precomputed in features.py (``ewma_<target>_per_min`` or
    ``exp_<target>_per_min``) via an as-of join, so this is a lookup plus a
    fallback, not a fit. ``fit`` exists only to learn the fallback for players
    with no per-minute history.

    TWO THINGS ARE PER-STAT as of the 9-cat extension, and both default to what
    the class did before, so ``PerMinuteRate('PTS')`` is the same object it always
    was:

      halflife   ``config.rate_halflife(target)``. PTS and AST are frozen at 5 by
                 the production tournament's verdict; the nine new stats each
                 carry a halflife selected on inner folds.
      estimator  ``config.rate_estimator(target)``, 'ewma' or 'expanding'. The
                 expanding-career-mean is the baseline every new stat was measured
                 against, and it ships for any stat that actually won with it.

    passing either explicitly overrides the config, which is what the halflife
    sweep in evaluate.py does - it has to be able to instantiate the same
    estimator at five different memories over identical rows.

    THE FALLBACK IS A LEAGUE RATE, NOT A LEAGUE MEAN OF RATES: it is
    sum(stat) / sum(minutes) over the training appearances, which weights a
    30-minute night thirty times as heavily as a 1-minute one. the unweighted mean
    of per-player ratios is dominated by scrubs with three minutes of history and
    is roughly 20% too high as a prior for anyone who actually plays.

    DERIVED FALLBACK for frames with no rate column: ``ewma_<stat>`` divided by
    ``max(ewma_MIN, RATE_MINUTES_FLOOR)``. that is a ratio of EWMAs rather than an
    EWMA of ratios, which is a different (and slightly biased) quantity - it is a
    compatibility path for datasets built before the rate columns existed, and
    :func:`features.attach_per_minute_rates` removes the need for it. a warning is
    logged when it triggers so it cannot quietly become the normal path.
    """

    kind = "ewma_per_minute"

    def __init__(self, target: str, halflife: float | None = None,
                 minutes_floor: float = RATE_MINUTES_FLOOR,
                 estimator: str | None = None) -> None:
        self.target = target
        self.estimator = rate_estimator(target) if estimator is None else estimator
        # an expanding mean has no halflife. it is recorded as NaN rather than as
        # a number nobody uses, so a metadata reader cannot mistake a leftover 5
        # for a claim about an estimator that has no memory parameter at all.
        if self.estimator == "expanding":
            self.halflife = float("nan")
        else:
            self.halflife = (
                rate_halflife(target) if halflife is None else float(halflife)
            )
        self.minutes_floor = float(minutes_floor)
        self.column = (
            f"exp_{target}_per_min" if self.estimator == "expanding"
            else f"ewma_{target}_per_min"
        )
        self.fallback: float | None = None

    def fit(self, train: pd.DataFrame) -> "PerMinuteRate":
        rows = train
        if "PLAYED" in rows.columns:
            rows = rows[rows["PLAYED"] == 1]
        rows = rows[rows["MIN"] > 0]
        minutes = float(rows["MIN"].sum())
        self.fallback = float(rows[self.target].sum() / minutes) if minutes > 0 else 0.0
        return self

    @classmethod
    def from_fallback(cls, target: str, fallback: float,
                      halflife: float | None = None,
                      minutes_floor: float = RATE_MINUTES_FLOOR,
                      estimator: str | None = None) -> "PerMinuteRate":
        """rebuild from a persisted snapshot instead of refitting."""
        obj = cls(target, halflife, minutes_floor, estimator)
        obj.fallback = float(fallback)
        return obj

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        if self.fallback is None:
            raise RuntimeError("PerMinuteRate.fit must run before predict")
        if self.column in frame.columns:
            rate = frame[self.column]
        else:
            log.warning(
                "%s missing from the frame; deriving the rate as ewma_%s / "
                "max(ewma_MIN, %.1f). run features.attach_per_minute_rates to get "
                "the real EWMA of per-game ratios.",
                self.column, self.target, self.minutes_floor,
            )
            numerator = f"ewma_{self.target}"
            if numerator not in frame.columns or "ewma_MIN" not in frame.columns:
                return np.full(len(frame), self.fallback, dtype=float)
            rate = frame[numerator] / frame["ewma_MIN"].clip(lower=self.minutes_floor)
        rate = rate.replace([np.inf, -np.inf], np.nan).fillna(self.fallback)
        return np.clip(rate.to_numpy(dtype=float), 0.0, None)


def snapshot_ewma_state(features: pd.DataFrame, cutoff: pd.Timestamp) -> pd.DataFrame:
    """per-player EWMA values as of the cutoff, plus the global fallbacks.

    this is what ``train.py`` persists so a prediction run can reproduce the
    champion estimate without recomputing the whole appearance history.
    """
    cutoff = pd.Timestamp(cutoff)
    hist = features[features["GAME_DATE"] < cutoff]
    if hist.empty:
        raise ValueError(f"no rows before cutoff {cutoff.date()} to snapshot")

    cols = [f"ewma_{s}" for s in ROLL_STATS if f"ewma_{s}" in hist.columns]
    # BOTH rate families are snapshotted, not only the one currently promoted per
    # stat. The snapshot is the artifact's record of "what every player's rate was
    # at this cutoff", and an artifact that persisted only the champion column
    # would make a later re-read of the losing estimator impossible without
    # replaying four seasons of appearance history - which is exactly the cost the
    # snapshot exists to avoid.
    cols += [
        col
        for t in RATE_TARGETS
        for col in (f"ewma_{t}_per_min", f"exp_{t}_per_min")
        if col in hist.columns
    ]
    latest = (
        hist.sort_values("GAME_DATE")
        .drop_duplicates("PLAYER_ID", keep="last")[["PLAYER_ID", "GAME_DATE", *cols]]
        .rename(columns={"GAME_DATE": "AS_OF"})
        .reset_index(drop=True)
    )
    appearances = hist[hist["PLAYED"] == 1]
    for stat in ROLL_STATS:
        if stat in appearances.columns:
            latest.attrs.setdefault("fallbacks", {})[stat] = float(appearances[stat].mean())
    for target in RATE_TARGETS:
        if target in appearances.columns:
            latest.attrs.setdefault("rate_fallbacks", {})[target] = (
                PerMinuteRate(target).fit(hist).fallback
            )
    latest.attrs["cutoff"] = str(cutoff.date())
    return latest


# ---- the decomposition ----
def decomposed_estimate(scored: pd.DataFrame, conditional: np.ndarray) -> np.ndarray:
    """E[stat over the schedule] = P(play) x E[stat | played].

    ``scored`` must carry a validated out-of-fold P(play); the guard runs here
    rather than being left to the caller because this multiplication is the
    exact place an in-fold probability would do its damage.
    """
    validate_out_of_fold(scored)
    return np.clip(scored[P_PLAY].to_numpy(dtype=float) * np.asarray(conditional, dtype=float),
                   0.0, None)


def conditional_estimate(minutes, rate) -> np.ndarray:
    """E[stat | plays] = E[minutes | plays] x production per minute.

    the conditional number the player card shows. it is a PRODUCT of the card's
    own minutes row and the player's per-minute rate, which is the internal
    coherence the previous formulation did not have: the old card showed a
    LightGBM minutes projection next to an EWMA points projection that had no
    idea what the minutes projection said.
    """
    return np.clip(
        np.asarray(minutes, dtype=float) * np.asarray(rate, dtype=float), 0.0, None
    )


def minutes_propagated_estimate(
    scored: pd.DataFrame, rate
) -> tuple[np.ndarray, np.ndarray]:
    """the promoted composition. returns (conditional, unconditional).

    ``scored`` must carry BOTH stamped quantities - P(play) from
    ``AvailabilityModel.attach`` and E[minutes | plays] from
    ``MinutesModel.attach``. all three guards run before anything is multiplied:
    each quantity out of fold, and both from the same cutoff.

    returning the pair rather than just the unconditional value is deliberate.
    the two numbers must be the same conditional estimate scaled by the same
    probability; computing them in two places is how a card ends up showing a
    conditional 20 next to an unconditional 14 that came from a different 20.
    """
    validate_out_of_fold(scored)
    validate_minutes_out_of_fold(scored)
    assert_same_cutoff(scored)
    conditional = conditional_estimate(scored[MIN_PRED], rate)
    unconditional = np.clip(
        scored[P_PLAY].to_numpy(dtype=float) * conditional, 0.0, None
    )
    return conditional, unconditional


# ---- coherence: the arithmetic a box score cannot violate ----
def coherence_clip(
    values: dict[str, np.ndarray],
    constraints: tuple[tuple[str, str], ...] = COHERENCE_CONSTRAINTS,
) -> tuple[dict[str, np.ndarray], dict[str, int]]:
    """clip ``bounded`` down to ``bound``, in order. returns (clipped, bind counts).

    THE CONSTRAINT AND WHY IT IS NOT AUTOMATIC. A made shot is an attempted shot
    and a made three is a made shot, so FG3M <= FGM <= FGA and FTM <= FTA hold in
    every game ever played. They do NOT automatically hold for the EXPECTATIONS,
    because each stat's per-minute rate is smoothed independently: at a common
    halflife the two EWMAs are the same weighted average of the same rows and
    monotonicity survives, but at DIFFERENT halflives they are different weighted
    averages and it does not. The league-rate fallbacks are a second, smaller
    source - a player with attempts history and no makes history takes his two
    numbers from two different places.

    So the clip is a real correction with a measurable frequency, not a defensive
    no-op, and the frequency is returned rather than logged away: how often it
    binds is the direct price of per-stat halflife selection, and MODEL.md quotes
    the number.

    ORDER MATTERS AND IS THE CONSTRAINT'S OWN. ``COHERENCE_CONSTRAINTS`` lists
    (FGM, FGA) before (FG3M, FGM), so FGM is pulled under FGA first and FG3M is
    then pulled under the ALREADY-CORRECTED FGM. Running the chain the other way
    would leave FG3M under a value of FGM that no longer exists.

    CLIPPING DOWN, NEVER UP. When FGM exceeds FGA the honest reading is that the
    makes estimate is too high, not that the attempts estimate is too low: attempts
    are the higher-volume, lower-variance quantity of the pair and are the better
    estimated of the two. Raising the bound to meet the bounded value would inflate
    a number nobody had evidence for.

    a missing stat on either side of a constraint is skipped rather than treated as
    zero - "we did not project attempts" and "we projected zero attempts" are
    different facts and only the second one is a licence to clip makes to nothing.
    """
    out = {key: np.asarray(value, dtype=float) for key, value in values.items()}
    counts: dict[str, int] = {}
    for bounded, bound in constraints:
        if bounded not in out or bound not in out:
            continue
        binds = np.isfinite(out[bounded]) & np.isfinite(out[bound]) & (
            out[bounded] > out[bound]
        )
        counts[f"{bounded}<={bound}"] = int(binds.sum())
        out[bounded] = np.where(binds, out[bound], out[bounded])
    return out, counts


def coherence_clip_frame(
    frame: pd.DataFrame,
    template: str,
    constraints: tuple[tuple[str, str], ...] = COHERENCE_CONSTRAINTS,
) -> tuple[pd.DataFrame, dict[str, int]]:
    """the same clip applied in place to a frame, over a column-name template.

    ``template`` is a format string with one ``{target}`` field - ``'E_{target}'``
    for the unconditional estimates, ``'E_{target}_COND'`` for the conditional ones,
    ``'Q90_{target}'`` for one quantile level. Calling it once per template is what
    makes "every emitted row is coherent" true of every emitted NUMBER rather than
    only of the headline expectation, and it is why the quantile levels are clipped
    against each OTHER level-wise rather than against the point estimate.
    """
    columns = {
        target: template.format(target=target)
        for target in {name for pair in constraints for name in pair}
    }
    present = {t: c for t, c in columns.items() if c in frame.columns}
    if not present:
        return frame, {}
    clipped, counts = coherence_clip(
        {t: frame[c].to_numpy(dtype=float) for t, c in present.items()}, constraints
    )
    out = frame.copy()
    for target, column in present.items():
        out[column] = clipped[target]
    return out, counts


@dataclass
class DecomposedEstimator:
    """the promoted unconditional model: P(play) x E[min | play] x rate per minute.

    three fitted pieces, one cutoff. the cutoff is passed once and handed to both
    trained models, which is what makes ``assert_same_cutoff`` a tautology on the
    happy path and a real check on a hand-assembled one.
    """

    target: str = "PTS"
    availability_kind: str = CHAMPIONS["availability"]
    minutes_kind: str = CHAMPIONS["minutes"]
    availability: AvailabilityModel | None = None
    minutes: MinutesModel | None = None
    rate: PerMinuteRate | None = None

    def fit(self, train: pd.DataFrame, feature_cols: list[str],
            cutoff: pd.Timestamp) -> "DecomposedEstimator":
        self.availability = AvailabilityModel(kind=self.availability_kind).fit(
            train, feature_cols, cutoff
        )
        appearances = train[train["PLAYED"] == 1] if "PLAYED" in train.columns else train
        self.minutes = MinutesModel(kind=self.minutes_kind).fit(
            appearances, feature_cols, cutoff
        )
        self.rate = PerMinuteRate(self.target).fit(train)
        return self

    def _scored(self, frame: pd.DataFrame) -> pd.DataFrame:
        if self.availability is None or self.minutes is None or self.rate is None:
            raise RuntimeError("DecomposedEstimator is not fitted")
        return self.minutes.attach(self.availability.attach(frame))

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        """the unconditional estimate over scheduled rows."""
        scored = self._scored(frame)
        return minutes_propagated_estimate(scored, self.rate.predict(frame))[1]

    def predict_conditional(self, frame: pd.DataFrame) -> np.ndarray:
        """E[stat | plays], the same product without the probability."""
        scored = self._scored(frame)
        return minutes_propagated_estimate(scored, self.rate.predict(frame))[0]
