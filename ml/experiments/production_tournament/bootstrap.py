"""the moving-block bootstrap the decision rule runs on. pure functions only.

rows are not independent within a date, so deltas are summed to date level and dates
are resampled in moving blocks drawn within origin, never spanning two origins.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

BLOCK_DAYS = 7
N_REPLICATES = 2000


@dataclass(frozen=True)
class BootstrapResult:
    """the whole decision input for one (method, target) pair, in one object."""

    theta: float           # relative improvement, positive is better
    lo: float
    hi: float
    p_value: float
    n_rows: int
    n_dates: int
    n_replicates: int

    @property
    def ci_excludes_zero(self) -> bool:
        return (self.lo > 0.0) or (self.hi < 0.0)

    def clears(self, floor: float) -> bool:
        """the pre-registered bar: CI excludes zero and the effect is >= floor."""
        return self.ci_excludes_zero and self.theta >= floor


def date_aggregate(
    delta: np.ndarray,
    base_abs: np.ndarray,
    dates: pd.Series,
    origins: pd.Series,
) -> pd.DataFrame:
    """collapse per-row deltas to one row per (origin, date), summed."""
    frame = pd.DataFrame({
        "origin": np.asarray(origins),
        "date": pd.to_datetime(pd.Series(np.asarray(dates))).to_numpy(),
        "delta": np.asarray(delta, dtype=float),
        "base_abs": np.asarray(base_abs, dtype=float),
        "rows": 1,
    })
    return (
        frame.groupby(["origin", "date"], as_index=False)[["delta", "base_abs", "rows"]]
        .sum()
        .sort_values(["origin", "date"])
        .reset_index(drop=True)
    )


def _block_sums(values: np.ndarray, block: int) -> np.ndarray:
    """sum of every admissible ``block``-long contiguous run, one per start position.

    a series shorter than the block yields one block: the whole series.
    """
    n = len(values)
    if n == 0:
        return np.zeros(0)
    if n <= block:
        return np.array([values.sum()])
    cumulative = np.concatenate([[0.0], np.cumsum(values)])
    return cumulative[block:] - cumulative[:-block]


def moving_block_bootstrap(
    delta: np.ndarray,
    base_abs: np.ndarray,
    dates: pd.Series,
    origins: pd.Series,
    block: int = BLOCK_DAYS,
    n_replicates: int = N_REPLICATES,
    seed: int = 17,
    level: float = 0.95,
) -> BootstrapResult:
    """percentile CI and a two-sided p-value for the relative-improvement ratio.

    ``delta`` is ``|y - incumbent| - |y - challenger|`` per row, so POSITIVE MEANS THE
    CHALLENGER IS BETTER, and ``base_abs`` is ``|y - incumbent|``. theta is
    ``sum(delta) / sum(base_abs)``.

    the p-value is the usual two-sided bootstrap one,
    ``2 * min(P(theta* <= 0), P(theta* >= 0))``, floored at ``1 / n_replicates``
    because a bootstrap cannot resolve a p smaller than its own resolution and
    reporting 0.0 would claim it can.
    """
    agg = date_aggregate(delta, base_abs, dates, origins)
    if agg.empty:
        return BootstrapResult(float("nan"), float("nan"), float("nan"),
                              float("nan"), 0, 0, 0)

    total_delta = float(agg["delta"].sum())
    total_base = float(agg["base_abs"].sum())
    theta = total_delta / total_base if total_base > 0 else float("nan")

    rng = np.random.default_rng(seed)
    numerator = np.zeros(n_replicates)
    denominator = np.zeros(n_replicates)

    for _, group in agg.groupby("origin", sort=True):
        d = group["delta"].to_numpy(dtype=float)
        b = group["base_abs"].to_numpy(dtype=float)
        d_blocks = _block_sums(d, block)
        b_blocks = _block_sums(b, block)
        # enough blocks to cover the origin's own length, so a resample of an origin
        # has roughly the origin's own number of dates in it
        n_draw = max(1, int(np.ceil(len(d) / block)))
        picks = rng.integers(0, len(d_blocks), size=(n_replicates, n_draw))
        numerator += d_blocks[picks].sum(axis=1)
        denominator += b_blocks[picks].sum(axis=1)

    with np.errstate(invalid="ignore", divide="ignore"):
        thetas = np.where(denominator > 0, numerator / denominator, np.nan)
    thetas = thetas[np.isfinite(thetas)]
    if thetas.size == 0:
        return BootstrapResult(theta, float("nan"), float("nan"), float("nan"),
                              int(agg["rows"].sum()), int(len(agg)), 0)

    tail = (1.0 - level) / 2.0
    lo, hi = np.quantile(thetas, [tail, 1.0 - tail])
    share_le = float(np.mean(thetas <= 0.0))
    share_ge = float(np.mean(thetas >= 0.0))
    p = min(1.0, 2.0 * min(share_le, share_ge))
    p = max(p, 1.0 / thetas.size)
    return BootstrapResult(
        theta=float(theta), lo=float(lo), hi=float(hi), p_value=float(p),
        n_rows=int(agg["rows"].sum()), n_dates=int(len(agg)),
        n_replicates=int(thetas.size),
    )


def holm_bonferroni(p_values: dict[str, float], alpha: float = 0.05) -> dict[str, bool]:
    """step-down family-wise correction over the candidates within one target.

    eight candidates per target means eight chances to clear a 5% threshold by luck,
    and an uncorrected 95% interval is the wrong instrument for eight simultaneous
    questions. Holm is used rather than plain Bonferroni because it is uniformly more
    powerful and needs no independence assumption - which matters here, where the
    candidates are all built on overlapping views of the same appearance history and
    their test statistics are strongly positively correlated.

    returns {name: rejected at family-wise alpha}.
    """
    if not p_values:
        return {}
    ordered = sorted(p_values.items(), key=lambda kv: (kv[1], kv[0]))
    m = len(ordered)
    out: dict[str, bool] = {}
    still_rejecting = True
    for i, (name, p) in enumerate(ordered):
        threshold = alpha / (m - i)
        if still_rejecting and p <= threshold:
            out[name] = True
        else:
            still_rejecting = False
            out[name] = False
    return out
