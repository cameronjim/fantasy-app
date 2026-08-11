"""the eight rate estimators, and the inner-fold machinery that tunes them.

EVERY METHOD PRODUCES ONE THING: a per-minute rate, one number per scheduled
validation row. The composition that turns it into a projection
(``P(play) x E[min|plays] x rate``) is fitted once per origin by the runner and
shared verbatim, so the bracket is a one-variable comparison and the leakage guards
in ``models.minutes_propagated_estimate`` run on all eight.

THE INNER FOLD, and why hyperparameters cannot be chosen anywhere else. the reported
number comes from an origin's validation month. choosing a halflife by looking at
that month and then reporting the winning halflife's score on it is how a 1% noise
difference becomes a 1% "finding" - the choice has already spent the evidence. so
every hyperparameter here is chosen on the LAST 30 DAYS OF THE TRAINING WINDOW,
scored by a proxy of the real endpoint built entirely from out-of-fold quantities the
frame already carries:

    proxy = P_CONTEXT x OOF_MIN x rate

``P_CONTEXT`` is the cross-fit base availability probability the v3 dataset build
already produced for every scheduled row; ``OOF_MIN`` is the cross-fit minutes
prediction from :mod:`crossfit`. Both are strictly out of fold for every row by
construction, so the selection criterion needs no extra fits and cannot peek. It is a
PROXY - it uses the base availability model rather than the final one - and it is used
only to rank candidates within a family, never to produce a reported number.

THE COMMON FALLBACK IS TERMINAL. 3.83% of scheduled rows belong to a player with no
prior appearance-with-minutes at all. Every method - including the ones whose own
definition would happily supply a number there (shrinkage returns the prior, the
boosters return a feature-based guess) - is overridden on those rows with the
incumbent's own league fallback, ``sum(stat) / sum(MIN)`` over the origin's training
appearances. That is deliberately conservative: it denies the fancier methods a free
win on cold-start rows and makes the bracket a test of the rate estimator on players
who have a history, which is what the question was about.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import Ridge
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler

import lightgbm as lgb

from fnba_ml.config import (
    FEATURE_COLS,
    LGBM_PARAMS,
    P_CONTEXT,
    RANDOM_STATE,
    RATE_MINUTES_FLOOR,
)
from fnba_ml.models import PerMinuteRate, mae

from .crossfit import OOF_MIN
from .rates import (
    HALFLIVES,
    INCUMBENT_HALFLIFE,
    RATE_N,
    SCHEME_MINUTES_WEIGHTED,
    SCHEME_PLAIN,
    SHRINK_KS,
    per_game_rate,
    position_priors,
    prior_vector,
    rate_column,
    shrink_toward_prior,
)

log = logging.getLogger(__name__)

# the inner-validation window, in days back from the origin's cutoff. one month, so
# it is the same shape of window as the outer validation month it stands in for.
INNER_DAYS = 30

RIDGE_ALPHAS: tuple[float, ...] = (0.1, 1.0, 10.0, 100.0, 1000.0)
TWEEDIE_POWER = 1.5


# ---------------------------------------------------------------------------
# per-origin context
# ---------------------------------------------------------------------------
@dataclass
class OriginContext:
    """everything a method may look at for one origin, and nothing it may not.

    the validation frame is here because methods have to SCORE it; no method is ever
    handed its outcome columns for fitting, and the runner asserts that the rate a
    method emits is a function of the validation features alone by construction (all
    fitting happens in ``prepare``, which only ever sees ``train_all``).
    """

    name: str
    vstart: pd.Timestamp
    train_all: pd.DataFrame
    valid_all: pd.DataFrame
    train_rate: pd.DataFrame = field(init=False)
    inner_cut: pd.Timestamp = field(init=False)
    inner_train_rate: pd.DataFrame = field(init=False)
    inner_valid: pd.DataFrame = field(init=False)

    def __post_init__(self) -> None:
        rate_rows = (self.train_all["PLAYED"] == 1) & (self.train_all["MIN"] > 0)
        self.train_rate = self.train_all[rate_rows].copy()
        self.inner_cut = pd.Timestamp(self.vstart) - pd.Timedelta(days=INNER_DAYS)
        self.inner_valid = self.train_all[
            self.train_all["GAME_DATE"] >= self.inner_cut
        ].copy()
        self.inner_train_rate = self.train_rate[
            self.train_rate["GAME_DATE"] < self.inner_cut
        ].copy()


def proxy_mae(rows: pd.DataFrame, target: str, rate: np.ndarray) -> float:
    """the inner-fold selection criterion: unconditional MAE from OOF quantities."""
    p = pd.to_numeric(rows[P_CONTEXT], errors="coerce").fillna(0.7).to_numpy(dtype=float)
    minutes = pd.to_numeric(rows[OOF_MIN], errors="coerce").fillna(0.0).to_numpy(dtype=float)
    pred = np.clip(p * minutes * np.asarray(rate, dtype=float), 0.0, None)
    return mae(rows[target].to_numpy(dtype=float), pred)


def has_rate_history(rows: pd.DataFrame) -> np.ndarray:
    """rows whose player has at least one strictly-prior appearance with minutes.

    read off the as-of-joined ``rate_n``, so it is the same mask for every method and
    for every halflife - the join that produced it is shared.
    """
    return pd.to_numeric(rows[RATE_N], errors="coerce").notna().to_numpy()


# ---------------------------------------------------------------------------
# the method interface
# ---------------------------------------------------------------------------
class RateMethod:
    """a rate estimator. ``prepare`` may only look at ``ctx.train_*``."""

    name = "abstract"
    label = "abstract"
    # DESCRIPTIVE members are scored on exactly the same rows as the decision family
    # and reported in exactly the same tables, but they are NOT in the Holm family and
    # cannot promote anything. they exist because "halflife 12 helps" is a claim about a
    # curve, and a curve with two points on it is not a curve. TOURNAMENT.md section 0.6
    # pre-registers the five-point sweep as descriptive for precisely this reason.
    descriptive = False

    def prepare(self, ctx: OriginContext, target: str, fallback: float) -> None:
        self.target = target
        self.fallback = float(fallback)

    def _raw_rate(self, rows: pd.DataFrame) -> np.ndarray:
        raise NotImplementedError

    def predict_rate(self, rows: pd.DataFrame) -> np.ndarray:
        """the method's rate, with the terminal common fallback applied."""
        raw = np.asarray(self._raw_rate(rows), dtype=float)
        known = has_rate_history(rows)
        out = np.where(known & np.isfinite(raw), raw, self.fallback)
        return np.clip(out, 0.0, None)

    def chosen(self) -> dict[str, object]:
        """the hyperparameters the inner fold picked, for the report."""
        return {}


class EwmaRate(RateMethod):
    """EWMA of per-game ratios at a FIXED halflife, plain or minutes-weighted.

    M0 (plain, h=5) and M2 (plain, h=12) are decision members; the rest of the
    five-point sweep in both schemes is instantiated from this class with
    ``descriptive=True``.
    """

    def __init__(self, halflife: float, name: str, label: str,
                 scheme: str = SCHEME_PLAIN, descriptive: bool = False) -> None:
        self.halflife = float(halflife)
        self.name = name
        self.label = label
        self.scheme = scheme
        self.descriptive = bool(descriptive)

    def _raw_rate(self, rows: pd.DataFrame) -> np.ndarray:
        col = rate_column(self.scheme, self.target, self.halflife)
        return rows[col].to_numpy(dtype=float)

    def chosen(self) -> dict[str, object]:
        return {"halflife": self.halflife}


class SelectedHalflifeRate(RateMethod):
    """EWMA (plain or minutes-weighted) with the halflife chosen on the inner fold."""

    def __init__(self, scheme: str, name: str, label: str,
                 halflives: tuple[float, ...] = HALFLIVES) -> None:
        self.scheme = scheme
        self.name = name
        self.label = label
        self.halflives = tuple(halflives)
        self.halflife = INCUMBENT_HALFLIFE

    def prepare(self, ctx: OriginContext, target: str, fallback: float) -> None:
        super().prepare(ctx, target, fallback)
        rows = ctx.inner_valid
        scores: list[tuple[float, float]] = []
        for h in self.halflives:
            rate = rows[rate_column(self.scheme, target, h)].to_numpy(dtype=float)
            rate = np.where(np.isfinite(rate), rate, self.fallback)
            scores.append((proxy_mae(rows, target, rate), h))
        # ties break to the SHORTER halflife: the more conservative estimator, and the
        # one that does not claim a memory the inner fold could not distinguish
        self.halflife = min(scores, key=lambda s: (s[0], s[1]))[1]

    def _raw_rate(self, rows: pd.DataFrame) -> np.ndarray:
        return rows[rate_column(self.scheme, self.target, self.halflife)].to_numpy(dtype=float)

    def chosen(self) -> dict[str, object]:
        return {"halflife": self.halflife}


class ShrunkRate(RateMethod):
    """empirical-Bayes shrinkage toward a position prior fitted on TRAIN rows only.

    ``halflife=None`` selects the halflife jointly with k over the full grid (the
    hybrid candidate M8); a fixed halflife tunes only k (M4, which changes exactly one
    thing about the incumbent).
    """

    def __init__(self, name: str, label: str, halflife: float | None = INCUMBENT_HALFLIFE,
                 scheme: str = SCHEME_PLAIN,
                 halflives: tuple[float, ...] = HALFLIVES,
                 ks: tuple[float, ...] = SHRINK_KS) -> None:
        self.name = name
        self.label = label
        self.scheme = scheme
        self.fixed_halflife = halflife
        self.halflives = (halflife,) if halflife is not None else tuple(halflives)
        self.ks = tuple(ks)
        self.halflife = halflife if halflife is not None else INCUMBENT_HALFLIFE
        self.k = 10.0

    def prepare(self, ctx: OriginContext, target: str, fallback: float) -> None:
        super().prepare(ctx, target, fallback)
        self.priors, self.league = position_priors(ctx.train_rate, target)
        rows = ctx.inner_valid
        prior = prior_vector(rows, self.priors, self.league)
        n = pd.to_numeric(rows[RATE_N], errors="coerce").to_numpy(dtype=float)
        scores: list[tuple[float, float, float]] = []
        for h in self.halflives:
            base = rows[rate_column(self.scheme, target, h)].to_numpy(dtype=float)
            for k in self.ks:
                rate = shrink_toward_prior(base, n, prior, k)
                scores.append((proxy_mae(rows, target, rate), h, k))
        # ties break to the shorter halflife and then the LARGER k - more shrinkage is
        # the more conservative estimator
        best = min(scores, key=lambda s: (s[0], s[1], -s[2]))
        self.halflife, self.k = best[1], best[2]

    def _raw_rate(self, rows: pd.DataFrame) -> np.ndarray:
        base = rows[rate_column(self.scheme, self.target, self.halflife)].to_numpy(dtype=float)
        n = pd.to_numeric(rows[RATE_N], errors="coerce").to_numpy(dtype=float)
        prior = prior_vector(rows, self.priors, self.league)
        return shrink_toward_prior(base, n, prior, self.k)

    def chosen(self) -> dict[str, object]:
        return {"halflife": self.halflife, "k": self.k}


class RidgeResidualRate(RateMethod):
    """ridge on ``r - ewma_5(r)`` over the v3 honest features. M5.

    THE FRAMING BEING TESTED: form (the EWMA) is the level, and the features explain
    tonight's DEVIATION from it - a back-to-back, a soft defence, a night with 30
    vacated minutes. It is a strictly weaker ask than predicting the rate outright,
    which is why it is the shape a linear model has the best chance in: the EWMA
    already carries the player identity, so the coefficients only have to carry
    context.
    """

    name = "M5_ridge_residual"
    label = "ridge on the residual r - EWMA5(r), v3 honest features"

    def __init__(self, halflife: float = INCUMBENT_HALFLIFE,
                 alphas: tuple[float, ...] = RIDGE_ALPHAS) -> None:
        self.halflife = float(halflife)
        self.alphas = tuple(alphas)
        self.alpha = 1.0

    def _design(self, rows: pd.DataFrame) -> pd.DataFrame:
        return rows[[c for c in FEATURE_COLS if c in rows.columns]]

    def _residual_target(self, rows: pd.DataFrame, target: str) -> np.ndarray:
        actual = per_game_rate(rows[target], rows["MIN"], RATE_MINUTES_FLOOR)
        base = rows[rate_column(SCHEME_PLAIN, target, self.halflife)].to_numpy(dtype=float)
        return actual - np.where(np.isfinite(base), base, 0.0)

    def _fit(self, train_rows: pd.DataFrame, target: str, alpha: float) -> Pipeline:
        pipeline = Pipeline([
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("reg", Ridge(alpha=float(alpha), random_state=RANDOM_STATE)),
        ])
        y = self._residual_target(train_rows, target)
        keep = np.isfinite(y)
        pipeline.fit(self._design(train_rows[keep]), y[keep])
        return pipeline

    def _apply(self, rows: pd.DataFrame, model: Pipeline, target: str) -> np.ndarray:
        base = rows[rate_column(SCHEME_PLAIN, target, self.halflife)].to_numpy(dtype=float)
        resid = model.predict(self._design(rows))
        return np.where(np.isfinite(base), base, np.nan) + resid

    def prepare(self, ctx: OriginContext, target: str, fallback: float) -> None:
        super().prepare(ctx, target, fallback)
        scores: list[tuple[float, float]] = []
        for alpha in self.alphas:
            inner = self._fit(ctx.inner_train_rate, target, alpha)
            rate = self._apply(ctx.inner_valid, inner, target)
            rate = np.where(np.isfinite(rate), rate, self.fallback)
            scores.append((proxy_mae(ctx.inner_valid, target, np.clip(rate, 0.0, None)), alpha))
        # ties break to the LARGER alpha: more regularisation is the more conservative
        # model, and the one closer to the incumbent it is trying to beat
        self.alpha = min(scores, key=lambda s: (s[0], -s[1]))[1]
        self.model = self._fit(ctx.train_rate, target, self.alpha)

    def _raw_rate(self, rows: pd.DataFrame) -> np.ndarray:
        return self._apply(rows, self.model, self.target)

    def chosen(self) -> dict[str, object]:
        return {"alpha": self.alpha, "halflife": self.halflife}


class PoissonOffsetRate(RateMethod):
    """LightGBM Poisson on raw counts with ``log(OOF minutes)`` as the offset. M6.

    THE COUNT-NATIVE FRAMING. points and assists are counts, not continuous
    quantities, and their variance grows with their mean; a squared-error regression on
    a ratio fights both facts. a Poisson GBM with a log-minutes offset models
    ``stat ~ Poisson(minutes * rate)`` directly, so what the trees learn IS the
    per-minute intensity: ``rate = exp(f(x))``, and the offset is exactly what makes
    that identification hold.

    the offset is the CROSS-FIT out-of-fold minutes prediction, never the realized
    target-game minutes. using realized minutes here would be the single most
    flattering leak available in this whole bracket - the model would be told how long
    the player was on the floor before being asked how much he produced.

    hyperparameters are FIXED at ``config.LGBM_PARAMS``, pre-registered, so this
    candidate spends no selection budget at all.
    """

    name = "M6_lgbm_poisson_offset"
    label = "LightGBM Poisson on counts, log(OOF minutes) offset"

    def _design(self, rows: pd.DataFrame) -> pd.DataFrame:
        return rows[[c for c in FEATURE_COLS if c in rows.columns]]

    @staticmethod
    def _offset(rows: pd.DataFrame) -> np.ndarray:
        minutes = pd.to_numeric(rows[OOF_MIN], errors="coerce").fillna(RATE_MINUTES_FLOOR)
        return np.log(np.clip(minutes.to_numpy(dtype=float), 1e-3, None))

    def prepare(self, ctx: OriginContext, target: str, fallback: float) -> None:
        super().prepare(ctx, target, fallback)
        params = dict(LGBM_PARAMS)
        params["objective"] = "poisson"
        self.model = lgb.LGBMRegressor(**params)
        train = ctx.train_rate
        y = train[target].to_numpy(dtype=float)
        self.model.fit(self._design(train), y, init_score=self._offset(train))

    def _raw_rate(self, rows: pd.DataFrame) -> np.ndarray:
        # raw_score excludes the fit-time init_score, so exp(f(x)) is the per-minute
        # intensity the offset factored the count into
        return np.exp(self.model.predict(self._design(rows), raw_score=True))

    def chosen(self) -> dict[str, object]:
        return {"objective": "poisson", "params": "config.LGBM_PARAMS"}


class TweedieRate(RateMethod):
    """LightGBM Tweedie on rates with minutes as the sample weight. M7.

    THE RATE-NATIVE FRAMING with the weighting defect fixed inside the LOSS rather
    than inside the feature. the target is the per-game ratio, so no offset and no
    predicted minutes are involved at all; the sample weight says a 36-minute
    observation of a rate is nine times the evidence a 4-minute one is. Tweedie rather
    than squared error because a per-minute rate is non-negative, right-skewed and has
    a point mass at zero (a bench player who did not score), which is the exact shape
    Tweedie's variance function is for.

    hyperparameters FIXED and pre-registered, as for M6.
    """

    name = "M7_lgbm_tweedie_rate"
    label = "LightGBM Tweedie on rates, minutes as sample weight"

    def _design(self, rows: pd.DataFrame) -> pd.DataFrame:
        return rows[[c for c in FEATURE_COLS if c in rows.columns]]

    def prepare(self, ctx: OriginContext, target: str, fallback: float) -> None:
        super().prepare(ctx, target, fallback)
        params = dict(LGBM_PARAMS)
        params["objective"] = "tweedie"
        params["tweedie_variance_power"] = TWEEDIE_POWER
        self.model = lgb.LGBMRegressor(**params)
        train = ctx.train_rate
        y = per_game_rate(train[target], train["MIN"], RATE_MINUTES_FLOOR)
        weight = np.clip(train["MIN"].to_numpy(dtype=float), RATE_MINUTES_FLOOR, None)
        self.model.fit(self._design(train), y, sample_weight=weight)

    def _raw_rate(self, rows: pd.DataFrame) -> np.ndarray:
        return self.model.predict(self._design(rows))

    def chosen(self) -> dict[str, object]:
        return {"objective": "tweedie", "variance_power": TWEEDIE_POWER,
                "params": "config.LGBM_PARAMS"}


INCUMBENT = "M0_ewma_h5"


def build_methods() -> list[RateMethod]:
    """the pre-registered bracket, in the order TOURNAMENT.md section 0.6 lists it."""
    return [
        EwmaRate(INCUMBENT_HALFLIFE, INCUMBENT,
                 "INCUMBENT: EWMA halflife 5 of stat/max(MIN,4)"),
        SelectedHalflifeRate(SCHEME_PLAIN, "M1_ewma_hl_selected",
                             "EWMA, halflife selected on the inner fold"),
        EwmaRate(12.0, "M2_ewma_h12",
                 "EWMA halflife 12 (the DEPTH_REPORT hypothesis, fixed)"),
        SelectedHalflifeRate(SCHEME_MINUTES_WEIGHTED, "M3_mwewma_hl_selected",
                             "minutes-weighted EWMA, halflife selected"),
        ShrunkRate("M4_eb_shrunk_h5", "EB shrinkage of EWMA5 toward a position prior",
                   halflife=INCUMBENT_HALFLIFE),
        RidgeResidualRate(),
        PoissonOffsetRate(),
        TweedieRate(),
        ShrunkRate("M8_hybrid_shrunk_hl", "hybrid: EB shrinkage on a selected halflife",
                   halflife=None),
    ]


def build_descriptive_methods() -> list[RateMethod]:
    """the rest of the five-point halflife sweep, in both schemes. DESCRIPTIVE ONLY.

    plain halflife 5 and 12 are already in the decision family as M0 and M2, so they are
    not duplicated here. everything else in the 2 x 5 grid is scored on the same rows so
    the report can print the CURVE the DEPTH_REPORT hypothesis is a point on - including
    the case where the curve turns out to be flat, which a two-point table could not
    show either way.
    """
    out: list[RateMethod] = []
    for h in HALFLIVES:
        if h not in (INCUMBENT_HALFLIFE, 12.0):
            out.append(EwmaRate(h, f"D_ewma_h{h:g}",
                                f"sweep: EWMA halflife {h:g}", descriptive=True))
    for h in HALFLIVES:
        out.append(EwmaRate(h, f"D_mwewma_h{h:g}",
                            f"sweep: minutes-weighted EWMA halflife {h:g}",
                            scheme=SCHEME_MINUTES_WEIGHTED, descriptive=True))
    return out


def build_bracket() -> list[RateMethod]:
    """everything the runner scores: the decision family first, then the sweep."""
    return [*build_methods(), *build_descriptive_methods()]


def decision_methods() -> set[str]:
    """the Holm family: the names that are allowed to promote something."""
    return {m.name for m in build_methods() if m.name != INCUMBENT}
