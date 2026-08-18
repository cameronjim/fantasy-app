"""the rate-estimation math the tournament compares. PURE FUNCTIONS ONLY.

everything here is a function of an appearance history and nothing else - no
fitting, no frames-with-side-effects, no I/O. the two things that make a rate
estimator honest live in exactly two places and both are here:

  1. the EWMA/weighted-EWMA is computed INCLUSIVE of the current appearance,
     exactly as ``features.per_minute_rate_features`` does, and the shift is
     supplied by the ``allow_exact_matches=False`` as-of join in
     :func:`attach_rate_columns`. these frames must never be joined on equality.
  2. the ratio is ``stat / max(MIN, RATE_MINUTES_FLOOR)`` - the floor is on the
     DENOMINATOR, not a filter on the rows, so a fringe player's cameos (which are
     most of the history he has) still count without a one-possession night
     projecting 45 points in 30 minutes.

WHY THE MINUTES-WEIGHTED FORM IS A DIFFERENT ESTIMATOR AND NOT A TWEAK. the
incumbent is an EWMA of RATIOS: a 2-minute garbage-time possession and a 36-minute
starter's night enter the average with the same weight. the minutes-weighted form
is a ratio of decayed SUMS, so the 36-minute night counts nine times as much. the
identity that makes it cheap to compute -

    sum(lambda^k * w_i * r_i) / sum(lambda^k * w_i)  ==  ewm(stat) / ewm(w)

because w_i * r_i == stat_i by construction - is pinned by a unit test, because it
is the whole reason a two-line implementation is the right one.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from fnba_ml.config import RATE_MINUTES_FLOOR, RATE_TARGETS

# the halflife grid, pre-registered in TOURNAMENT.md section 0.6. named here so the
# runner, the tests and the report cannot disagree about what was swept.
HALFLIVES: tuple[float, ...] = (3.0, 5.0, 8.0, 12.0, 20.0)
INCUMBENT_HALFLIFE: float = 5.0

# shrinkage constants, in games: k is where the player's own rate and the prior get
# equal weight (w = 1/2 at n = k).
SHRINK_KS: tuple[float, ...] = (2.0, 5.0, 10.0, 20.0, 50.0)

# the as-of count of the player's own rate rows. the shrinkage weight's n.
RATE_N = "rate_n"

SCHEME_PLAIN = "ewma"
SCHEME_MINUTES_WEIGHTED = "mwewma"


def rate_column(scheme: str, target: str, halflife: float) -> str:
    """the cache column name for one (scheme, target, halflife) triple."""
    return f"{scheme}_{target}_per_min_h{halflife:g}"


def floored_minutes(minutes: pd.Series | np.ndarray,
                    floor: float = RATE_MINUTES_FLOOR) -> pd.Series:
    """the rate denominator. a Series so downstream groupby ops keep their index."""
    return pd.Series(np.asarray(minutes, dtype=float)).clip(lower=float(floor))


def per_game_rate(stat, minutes, floor: float = RATE_MINUTES_FLOOR) -> np.ndarray:
    """``stat / max(minutes, floor)``, the single-game observation every method eats."""
    stat = np.asarray(stat, dtype=float)
    denominator = np.clip(np.asarray(minutes, dtype=float), floor, None)
    return stat / denominator


def ewma_rate(values, groups, halflife: float) -> np.ndarray:
    """per-player EWMA of a per-game observation, INCLUSIVE of the current row.

    the incumbent's estimator, with the halflife exposed. ``adjust=True`` matches
    ``features.per_minute_rate_features`` exactly, which is what makes halflife 5
    here reproduce the shipped ``ewma_<stat>_per_min`` column rather than merely
    resemble it.
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
    """ratio of decayed sums: ``sum(l^k stat) / sum(l^k max(MIN, floor))``.

    each game's rate is weighted by the minutes it was observed over, so a
    two-minute cameo cannot carry the same authority as a 36-minute night. see the
    module docstring for the identity that reduces it to two ``ewm`` calls, and
    ``test_rates.py`` for the test that pins the identity rather than trusting it.
    """
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
    """``w * rate + (1 - w) * prior``, ``w = n / (n + k)``. the standard EB weight.

    ``k`` is in games and is the number of appearances at which the player's own
    rate and the prior get equal weight. ``k = 0`` is the identity (no shrinkage)
    and is admitted deliberately: an estimator family whose null member is not
    reachable cannot report "shrinkage bought nothing".

    a null ``rate`` shrinks to the prior rather than staying null - a player with no
    history is exactly the case shrinkage exists for, and returning NaN would hand
    him to the fallback instead.
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
    """(per-position-group prior, league prior) from TRAINING rate rows only.

    a RATE, not a mean of rates: ``sum(stat) / sum(max(MIN, floor))``, which weights
    a 30-minute night thirty times a one-minute one. the unweighted mean of
    per-player ratios is dominated by scrubs with three minutes of history and is
    roughly 20% too high as a prior for anyone who actually plays - the same
    argument ``models.PerMinuteRate`` makes about its own fallback.

    FITTED ON TRAIN ONLY. a prior computed over the whole frame would put a small
    amount of every future game into every past row's shrunk rate, which is exactly
    the quiet leakage the honest-features phase exists to remove.

    a group with fewer than ``min_rows`` training rows does not get its own prior:
    it gets the league one. 18% of this frame has a null ``POS_GROUP`` and those
    rows must land somewhere principled rather than on a three-row group mean.
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
    """the per-row prior a shrinkage estimator pulls toward. league for unknowns."""
    if group_col not in frame.columns:
        return np.full(len(frame), float(league))
    keys = frame[group_col].astype("object").map(lambda v: str(v) if pd.notna(v) else None)
    return keys.map(lambda k: priors.get(k, league) if k is not None else league).to_numpy(
        dtype=float
    )


def rate_row_set(frame: pd.DataFrame) -> pd.DataFrame:
    """appearances with minutes > 0, chronological within player.

    the same row set ``features.per_minute_rate_features`` uses, and the same
    exclusions for the same reasons: a non-appearance has no rate at all, and a
    recorded zero-minute appearance carries no information about how fast a player
    scores. dropped rather than imputed - imputing a zero-minute night would pull a
    real rate toward zero.
    """
    app = frame[(frame["PLAYED"] == 1) & (frame["MIN"] > 0)].copy()
    return app.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)


def build_rate_columns(
    frame: pd.DataFrame,
    halflives: tuple[float, ...] = HALFLIVES,
    targets: tuple[str, ...] = RATE_TARGETS,
    floor: float = RATE_MINUTES_FLOOR,
) -> pd.DataFrame:
    """every (scheme x target x halflife) rate plus the as-of count, ready to join.

    ONE frame for the whole bracket, so every method's rate travels through the same
    single ``merge_asof`` and no method can accidentally get a different join.
    """
    app = rate_row_set(frame)
    groups = app["PLAYER_ID"].to_numpy()
    out = app[["PLAYER_ID", "GAME_DATE"]].copy()

    # inclusive count of the player's own rate rows; the as-of join turns it into a
    # strictly-prior count, which is the n the shrinkage weight needs.
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

    ``allow_exact_matches=False`` IS THE LEAKAGE GUARD - the appearance on the target
    date can never be matched, which is what turns an inclusive EWMA into a strictly
    prior feature. the caller's positional order is restored on the way out because
    the runner holds arrays aligned to it.
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
