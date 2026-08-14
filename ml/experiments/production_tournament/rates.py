"""the rate-estimation math the tournament compares. pure functions only.

the EWMAs here are inclusive of the current appearance; the shift comes from the
``allow_exact_matches=False`` as-of join in :func:`attach_rate_columns`, so these
frames must never be joined on equality. the minutes floor is on the denominator
rather than a row filter, so cameos still count.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from fnba_ml.config import RATE_MINUTES_FLOOR, RATE_TARGETS

HALFLIVES: tuple[float, ...] = (3.0, 5.0, 8.0, 12.0, 20.0)
INCUMBENT_HALFLIFE: float = 5.0

# in games: k is where the player's own rate and the prior get equal weight.
SHRINK_KS: tuple[float, ...] = (2.0, 5.0, 10.0, 20.0, 50.0)

RATE_N = "rate_n"

SCHEME_PLAIN = "ewma"
SCHEME_MINUTES_WEIGHTED = "mwewma"


def rate_column(scheme: str, target: str, halflife: float) -> str:
    """the cache column name for one (scheme, target, halflife) triple."""
    return f"{scheme}_{target}_per_min_h{halflife:g}"


def floored_minutes(minutes: pd.Series | np.ndarray,
                    floor: float = RATE_MINUTES_FLOOR) -> pd.Series:
    """the rate denominator, as a Series so downstream groupby ops keep their index."""
    return pd.Series(np.asarray(minutes, dtype=float)).clip(lower=float(floor))


def per_game_rate(stat, minutes, floor: float = RATE_MINUTES_FLOOR) -> np.ndarray:
    """``stat / max(minutes, floor)``, the single-game observation."""
    stat = np.asarray(stat, dtype=float)
    denominator = np.clip(np.asarray(minutes, dtype=float), floor, None)
    return stat / denominator


def ewma_rate(values, groups, halflife: float) -> np.ndarray:
    """per-player EWMA of a per-game observation, inclusive of the current row.

    ``adjust=True`` matches ``features.per_minute_rate_features``, so halflife 5
    reproduces the shipped column exactly.
    """
    s = pd.Series(np.asarray(values, dtype=float))
    g = pd.Series(np.asarray(groups))
    return (
        s.groupby(g, sort=False)
        .transform(lambda x: x.ewm(halflife=float(halflife), adjust=True).mean())
        .to_numpy(dtype=float)
    )


def minutes_weighted_ewma_rate(
    stat, minutes, groups, halflife: float, floor: float = RATE_MINUTES_FLOOR
) -> np.ndarray:
    """ratio of decayed sums: ``sum(l^k stat) / sum(l^k max(MIN, floor))``."""
    stat = pd.Series(np.asarray(stat, dtype=float))
    weight = floored_minutes(minutes, floor)
    g = pd.Series(np.asarray(groups))

    def smooth(s: pd.Series) -> pd.Series:
        return s.groupby(g, sort=False).transform(
            lambda x: x.ewm(halflife=float(halflife), adjust=True).mean()
        )

    numerator = smooth(stat).to_numpy(dtype=float)
    denominator = smooth(weight).to_numpy(dtype=float)
    out = np.divide(
        numerator, denominator,
        out=np.full(len(numerator), np.nan), where=denominator > 0,
    )
    return out


def shrink_toward_prior(rate, n, prior, k: float) -> np.ndarray:
    """``w * rate + (1 - w) * prior``, ``w = n / (n + k)``.

    a null ``rate`` shrinks fully to the prior rather than staying null.
    """
    rate = np.asarray(rate, dtype=float)
    n = np.nan_to_num(np.asarray(n, dtype=float), nan=0.0)
    prior = np.asarray(prior, dtype=float)
    k = float(k)
    if k < 0:
        raise ValueError(f"shrinkage k must be non-negative, got {k}")
    denominator = n + k
    w = np.divide(n, denominator, out=np.ones_like(n), where=denominator > 0)
    own = np.where(np.isfinite(rate), rate, 0.0)
    w = np.where(np.isfinite(rate), w, 0.0)
    return w * own + (1.0 - w) * prior


def position_priors(
    train_rate_rows: pd.DataFrame,
    target: str,
    group_col: str = "POS_GROUP",
    min_rows: int = 500,
    floor: float = RATE_MINUTES_FLOOR,
) -> tuple[dict[str, float], float]:
    """(per-position-group prior, league prior) from training rate rows only.

    a minutes-weighted rate, not a mean of ratios, and fitted on train only so no
    future game reaches a past row's shrunk rate. thin groups fall back to league.
    """
    rows = train_rate_rows
    weight = np.clip(rows["MIN"].to_numpy(dtype=float), floor, None)
    stat = rows[target].to_numpy(dtype=float)
    total_weight = float(weight.sum())
    league = float(stat.sum() / total_weight) if total_weight > 0 else 0.0

    priors: dict[str, float] = {}
    if group_col in rows.columns:
        groups = rows[group_col].astype("object")
        for key in [g for g in pd.unique(groups) if pd.notna(g)]:
            mask = (groups == key).to_numpy()
            if int(mask.sum()) < min_rows:
                continue
            w = float(weight[mask].sum())
            if w > 0:
                priors[str(key)] = float(stat[mask].sum() / w)
    return priors, league


def prior_vector(
    frame: pd.DataFrame,
    priors: dict[str, float],
    league: float,
    group_col: str = "POS_GROUP",
) -> np.ndarray:
    """the per-row prior a shrinkage estimator pulls toward, league for unknowns."""
    if group_col not in frame.columns:
        return np.full(len(frame), float(league))
    keys = frame[group_col].astype("object").map(lambda v: str(v) if pd.notna(v) else None)
    return keys.map(lambda k: priors.get(k, league) if k is not None else league).to_numpy(
        dtype=float
    )


def rate_row_set(frame: pd.DataFrame) -> pd.DataFrame:
    """appearances with minutes > 0, chronological within player."""
    app = frame[(frame["PLAYED"] == 1) & (frame["MIN"] > 0)].copy()
    return app.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)


def build_rate_columns(
    frame: pd.DataFrame,
    halflives: tuple[float, ...] = HALFLIVES,
    targets: tuple[str, ...] = RATE_TARGETS,
    floor: float = RATE_MINUTES_FLOOR,
) -> pd.DataFrame:
    """every (scheme x target x halflife) rate plus the as-of count, ready to join."""
    app = rate_row_set(frame)
    groups = app["PLAYER_ID"].to_numpy()
    out = app[["PLAYER_ID", "GAME_DATE"]].copy()

    # inclusive count; the as-of join turns it into the strictly-prior n.
    out[RATE_N] = app.groupby("PLAYER_ID").cumcount().to_numpy() + 1

    for target in targets:
        if target not in app.columns:
            continue
        r = per_game_rate(app[target], app["MIN"], floor)
        for h in halflives:
            out[rate_column(SCHEME_PLAIN, target, h)] = ewma_rate(r, groups, h)
            out[rate_column(SCHEME_MINUTES_WEIGHTED, target, h)] = (
                minutes_weighted_ewma_rate(app[target], app["MIN"], groups, h, floor)
            )
    return out.sort_values("GAME_DATE").reset_index(drop=True)


def attach_rate_columns(frame: pd.DataFrame, rate_frame: pd.DataFrame) -> pd.DataFrame:
    """as-of join the whole rate cache on, preserving the caller's row order.

    ``allow_exact_matches=False`` is the leakage guard that turns an inclusive EWMA
    into a strictly prior feature.
    """
    out = frame.copy()
    out["_row_order"] = np.arange(len(out))
    out["GAME_DATE"] = pd.to_datetime(out["GAME_DATE"])
    out = out.sort_values("GAME_DATE").reset_index(drop=True)
    right = rate_frame.copy()
    right["GAME_DATE"] = pd.to_datetime(right["GAME_DATE"])
    joined = pd.merge_asof(
        out, right,
        on="GAME_DATE", by="PLAYER_ID", direction="backward",
        allow_exact_matches=False,
    )
    return (
        joined.sort_values("_row_order")
        .drop(columns=["_row_order"])
        .reset_index(drop=True)
    )
