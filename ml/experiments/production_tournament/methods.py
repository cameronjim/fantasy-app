"""the eight rate estimators, and the inner-fold machinery that tunes them.

hyperparameters are chosen on the last 30 days of the training window, never on the
validation month, and scored by a proxy built only from out-of-fold quantities.
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

INNER_DAYS = 30

RIDGE_ALPHAS: tuple[float, ...] = (0.1, 1.0, 10.0, 100.0, 1000.0)
TWEEDIE_POWER = 1.5


@dataclass
class OriginContext:
    """everything a method may look at for one origin, and nothing it may not.

    all fitting happens in ``prepare``, which only ever sees ``train_all``.
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

    read off the as-of-joined ``rate_n``, so the mask is shared across methods and
    halflives.
    """
    return pd.to_numeric(rows[RATE_N], errors="coerce").notna().to_numpy()


class RateMethod:
    """a rate estimator. ``prepare`` may only look at ``ctx.train_*``."""

    name = "abstract"
    label = "abstract"
    # descriptive members are scored and reported but are not in the Holm family and
    # cannot promote anything.
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
    """EWMA of per-game ratios at a fixed halflife, plain or minutes-weighted."""

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
        # ties break to the shorter halflife, the more conservative estimator
        self.halflife = min(scores, key=lambda s: (s[0], s[1]))[1]

    def _raw_rate(self, rows: pd.DataFrame) -> np.ndarray:
        return rows[rate_column(self.scheme, self.target, self.halflife)].to_numpy(dtype=float)

    def chosen(self) -> dict[str, object]:
        return {"halflife": self.halflife}


class ShrunkRate(RateMethod):
    """empirical-Bayes shrinkage toward a position prior fitted on train rows only.

    ``halflife=None`` selects the halflife jointly with k; a fixed halflife tunes k.
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
        # ties break to the shorter halflife then the larger k, more shrinkage
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
    """ridge on ``r - ewma_5(r)`` over the v3 honest features."""

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
        # ties break to the larger alpha, the more conservative model
        self.alpha = min(scores, key=lambda s: (s[0], -s[1]))[1]
        self.model = self._fit(ctx.train_rate, target, self.alpha)

    def _raw_rate(self, rows: pd.DataFrame) -> np.ndarray:
        return self._apply(rows, self.model, self.target)

    def chosen(self) -> dict[str, object]:
        return {"alpha": self.alpha, "halflife": self.halflife}


class PoissonOffsetRate(RateMethod):
    """LightGBM Poisson on raw counts with ``log(OOF minutes)`` as the offset.

    the offset is the cross-fit out-of-fold minutes prediction; realized target-game
    minutes would leak.
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
        # raw_score excludes the fit-time init_score, so exp(f(x)) is the rate
        return np.exp(self.model.predict(self._design(rows), raw_score=True))

    def chosen(self) -> dict[str, object]:
        return {"objective": "poisson", "params": "config.LGBM_PARAMS"}


class TweedieRate(RateMethod):
    """LightGBM Tweedie on rates with minutes as the sample weight."""

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
    """the pre-registered decision family, incumbent first."""
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
    """the rest of the five-point halflife sweep, in both schemes, descriptive only."""
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
