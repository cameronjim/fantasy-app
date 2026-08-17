"""the model ladder, the EWMA champion, and the decomposed estimator.

deliberately a LADDER, not a leaderboard: every target starts with the dumbest
defensible baseline (a shifted historical mean), then a linear model, then
LightGBM. if the gradient booster cannot beat a shifted rolling mean, that is a
finding about the target, not a bug to tune away.

WHAT ACTUALLY SHIPS (config.CHAMPIONS, from REPORT.md section 6):

  availability   LightGBM classifier   -22.8% Brier vs the shifted appearance
                                       rate. the one large, stable win.
  minutes|played EWMA(halflife 5)      LightGBM beat it by 1.4% overall and
                                       LOST on stars. not promoted.
  production|played EWMA(halflife 5)   ridge beat it by 1.0% on PTS, 1.2% on
                                       AST; LightGBM lost on AST outright.
                                       ridge stays a challenger.

so there is NO trained production model in the promoted path. the unconditional
estimate is P(play) x EWMA conditional production, and the only learned part is
P(play).

OUT-OF-FOLD DISCIPLINE. the decomposition multiplies an availability
probability into a downstream estimate. if that probability came from a model
whose training window included the row being predicted, the whole unconditional
number is contaminated and nothing downstream can detect it. every P(play) is
therefore carried together with the cutoff of the model that produced it, and
:func:`validate_out_of_fold` refuses any row whose cutoff is not strictly at or
before its own game date.

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

from .config import CHAMPIONS, EWMA_HALFLIFE, LGBM_PARAMS, RANDOM_STATE, ROLL_STATS

log = logging.getLogger(__name__)

EPS = 1e-3

P_PLAY = "P_PLAY"
P_PLAY_CUTOFF = "P_PLAY_CUTOFF"


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


def validate_out_of_fold(frame: pd.DataFrame) -> pd.DataFrame:
    """assert every P(play) came from a model trained strictly before its row.

    this is the guard REPORT.md section 6 implication 4 asks for. it is cheap
    and it is the only thing standing between a decomposed estimate and a
    silently contaminated one.
    """
    for col in (P_PLAY, P_PLAY_CUTOFF, "GAME_DATE"):
        if col not in frame.columns:
            raise LeakageError(f"cannot validate out-of-fold P(play): missing column {col!r}")

    if frame[P_PLAY].isna().any():
        raise LeakageError(f"{int(frame[P_PLAY].isna().sum())} rows have a null P(play)")
    if frame[P_PLAY_CUTOFF].isna().any():
        raise LeakageError(
            f"{int(frame[P_PLAY_CUTOFF].isna().sum())} rows carry no training cutoff, "
            f"so their P(play) cannot be shown to be out of fold"
        )

    cutoff = pd.to_datetime(frame[P_PLAY_CUTOFF])
    game_date = pd.to_datetime(frame["GAME_DATE"])
    bad = cutoff > game_date
    if bad.any():
        worst = int(bad.sum())
        raise LeakageError(
            f"{worst} rows carry an IN-FOLD P(play): the availability model's "
            f"training window extends past the game being predicted "
            f"(max overshoot {int((cutoff - game_date)[bad].dt.days.max())} days)"
        )
    return frame


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
    """champion conditional-production estimate: EWMA(halflife 5) over appearances.

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


@dataclass
class DecomposedEstimator:
    """P(play) x EWMA conditional production, the promoted unconditional model."""

    target: str = "PTS"
    availability_kind: str = CHAMPIONS["availability"]
    availability: AvailabilityModel | None = None
    production: EwmaProduction | None = None

    def fit(self, train: pd.DataFrame, feature_cols: list[str],
            cutoff: pd.Timestamp) -> "DecomposedEstimator":
        self.availability = AvailabilityModel(kind=self.availability_kind).fit(
            train, feature_cols, cutoff
        )
        self.production = EwmaProduction(self.target).fit(train)
        return self

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        if self.availability is None or self.production is None:
            raise RuntimeError("DecomposedEstimator is not fitted")
        scored = self.availability.attach(frame)
        return decomposed_estimate(scored, self.production.predict(frame))
