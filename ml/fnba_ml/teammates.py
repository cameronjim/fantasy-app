"""teammate context: usage rate, expected vacated resources (v3), and the v2
realized family kept as the oracle comparator.

the v2 realized columns read target-game PLAYED labels of other players, so they
are oracle-only and never served. the v3 served columns replace each realized
indicator with an as-of, out-of-fold, teammate-context-free play probability.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import (
    CONTEXT_P_PRIOR,
    EWMA_HALFLIFE,
    FT_POSSESSION_WEIGHT,
    MAGNITUDE_PRIORS,
    MAGNITUDE_SHRINK_K,
    MAGNITUDE_WINDOW,
    POS_GROUP_ORDER,
    RATE_MINUTES_FLOOR,
    STAR_USAGE_MIN_APPEARANCES,
    TEAMMATE_EXPECTED_COLS,
    TEAMMATE_FEATURE_COLS,
    TEAMMATE_ORACLE_COLS,
    TOP_USAGE_N,
)

log = logging.getLogger(__name__)

USAGE_COLUMN = "usg_ewma"

MAGNITUDE_SOURCES: dict[str, str] = {"MIN": "tm_MIN", "FGA": "tm_FGA", "USG": "tm_USG"}
MAGNITUDE_ESS = "magnitude_ess"

EXPECTED_SOURCES: dict[str, str] = {
    "tm_MIN": "exp_vacated_minutes",
    "tm_FGA": "exp_vacated_fga",
    "tm_USG": "exp_vacated_usg",
}

TEAMMATE_ESS = "teammate_magnitude_ess"

# std_MIN / std_FGA are season-scoped expanding means over APPEARANCES, i.e. per
# game played; usg_ewma is career-scoped.
VACATED_SOURCES: dict[str, str] = {
    "std_MIN": "vacated_minutes",
    "std_FGA": "vacated_fga",
    USAGE_COLUMN: "vacated_usg",
}

USAGE_CEILING = 100.0


def usage_share(frame: pd.DataFrame) -> pd.Series:
    """box-score usage approximation, per game, as a percentage.

    (TeamMIN / 5) rather than 48 because overtime lengthens the game. the
    denominator minutes are floored so a short cameo cannot report an absurd rate.
    """
    needed = ("FGA", "FTA", "TOV", "MIN", "TEAM_MIN", "TEAM_FGA", "TEAM_FTA", "TEAM_TOV")
    missing = [c for c in needed if c not in frame.columns]
    if missing:
        log.warning("cannot compute usage: frame is missing %s", ", ".join(missing))
        return pd.Series(np.nan, index=frame.index, dtype=float)

    player_poss = (
        frame["FGA"].astype(float)
        + FT_POSSESSION_WEIGHT * frame["FTA"].astype(float)
        + frame["TOV"].astype(float)
    )
    team_poss = (
        frame["TEAM_FGA"].astype(float)
        + FT_POSSESSION_WEIGHT * frame["TEAM_FTA"].astype(float)
        + frame["TEAM_TOV"].astype(float)
    )
    minutes = frame["MIN"].astype(float).clip(lower=RATE_MINUTES_FLOOR)
    team_minutes = frame["TEAM_MIN"].astype(float)

    denominator = minutes * team_poss
    usage = 100.0 * player_poss * (team_minutes / 5.0) / denominator
    usage = usage.where(denominator > 0)
    usage = usage.where(team_minutes > 0)
    return usage.replace([np.inf, -np.inf], np.nan).clip(lower=0.0, upper=USAGE_CEILING)


def usage_rate_features(universe: pd.DataFrame) -> pd.DataFrame:
    """career-scoped EWMA of per-game usage, ready to be as-of joined.

    the EWMA is inclusive of the current appearance; the shift comes from the
    allow_exact_matches=False as-of join in build_features, so this frame must
    never be joined on equality.
    """
    app = universe[(universe["PLAYED"] == 1) & (universe["MIN"] > 0)].copy()
    app = app.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)

    app["_usg_game"] = usage_share(app)
    app[USAGE_COLUMN] = (
        app.groupby("PLAYER_ID")["_usg_game"]
        .transform(lambda s: s.ewm(halflife=EWMA_HALFLIFE, adjust=True).mean())
    )
    return (
        app[["PLAYER_ID", "GAME_DATE", USAGE_COLUMN]]
        .sort_values("GAME_DATE")
        .reset_index(drop=True)
    )


def shrink(raw: pd.Series, n: pd.Series, prior: float, k: float = MAGNITUDE_SHRINK_K):
    """``w * raw + (1 - w) * prior`` with ``w = n / (n + k)``.

    n = 0 or a null raw both return the prior exactly, so a player with no history
    contributes replacement level rather than a NaN that would poison the sum. the
    prior is a config constant, never a mean over the frame being featurised.
    """
    weight = n.astype(float) / (n.astype(float) + float(k))
    weight = weight.where(np.isfinite(weight), 0.0)
    shrunk = weight * raw.astype(float) + (1.0 - weight) * float(prior)
    return shrunk.where(raw.notna(), float(prior))


def magnitude_features(universe: pd.DataFrame) -> pd.DataFrame:
    """career-scoped shrunk rolling magnitudes, ready to be as-of joined.

    every window is inclusive of the current appearance; the shift comes from the
    allow_exact_matches=False as-of join in build_features, so this frame must
    never be joined on equality.
    """
    app = universe[universe["PLAYED"] == 1].copy()
    app = app.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)

    app["_usg_game"] = usage_share(app).where(app["MIN"].astype(float) > 0)

    app[MAGNITUDE_ESS] = np.minimum(
        app.groupby("PLAYER_ID").cumcount() + 1, MAGNITUDE_WINDOW
    ).astype(float)

    cols = ["PLAYER_ID", "GAME_DATE", MAGNITUDE_ESS]
    for stat, column in MAGNITUDE_SOURCES.items():
        source = "_usg_game" if stat == "USG" else stat
        if source not in app.columns:
            log.warning("no %s column; magnitude %s will be the prior", source, column)
            app[column] = float(MAGNITUDE_PRIORS[stat])
            cols.append(column)
            continue
        raw = app.groupby("PLAYER_ID")[source].transform(
            lambda s: s.rolling(MAGNITUDE_WINDOW, min_periods=1).mean()
        )
        app[column] = shrink(raw, app[MAGNITUDE_ESS], MAGNITUDE_PRIORS[stat])
        cols.append(column)

    return app[cols].sort_values("GAME_DATE").reset_index(drop=True)


def roster_context_features(universe: pd.DataFrame) -> pd.DataFrame:
    """``games_with_current_team``, ``is_traded``, ``is_rookie``: added in place.

    the caller must pass a frame sorted by (PLAYER_ID, GAME_DATE, GAME_ID); row
    order is preserved. is_rookie counts appearances in strictly earlier seasons,
    not the first season in which the player ever appeared, which would read ahead
    for someone rostered in S who debuts in S+1.
    """
    out = universe
    out["games_with_current_team"] = (
        out.groupby(["PLAYER_ID", "TEAM_ID"]).cumcount().astype(float)
    )

    first_team = out.groupby(["PLAYER_ID", "SEASON"])["TEAM_ID"].transform("first")
    out["is_traded"] = (out["TEAM_ID"].astype(str) != first_team.astype(str)).astype(float)

    played = pd.to_numeric(out["PLAYED"], errors="coerce").fillna(0.0)
    per_season = played.groupby([out["PLAYER_ID"], out["SEASON"]]).sum()
    prior_seasons = (
        per_season.groupby(level=0).cumsum() - per_season
    ).rename("prior_season_apps")
    keys = pd.MultiIndex.from_arrays([out["PLAYER_ID"], out["SEASON"]])
    out["is_rookie"] = (
        prior_seasons.reindex(keys).to_numpy() <= 0
    ).astype(float)
    return out


def absence_mask(frame: pd.DataFrame) -> np.ndarray:
    """LISTED_INACTIVE or rostered-with-no-appearance, for one team-game."""
    played = pd.to_numeric(frame["PLAYED"], errors="coerce").fillna(0.0).to_numpy() == 0
    if "LISTED_INACTIVE" in frame.columns:
        inactive = (
            frame["LISTED_INACTIVE"].astype("boolean").fillna(False).to_numpy(dtype=bool)
        )
        return played | inactive
    return played


def _group_codes(*keys: pd.Series) -> np.ndarray:
    """dense integer codes for a composite group key, nulls propagating to -1.

    -1 marks "no group" and must not be aggregated over, or bucketless rows pool
    into one giant pseudo-group.
    """
    columns = [k.astype("string").reset_index(drop=True) for k in keys]
    null = np.zeros(len(columns[0]), dtype=bool)
    joined = None
    for column in columns:
        null |= column.isna().to_numpy()
        filled = column.fillna("\x00")
        joined = filled if joined is None else joined + "\x1f" + filled
    codes = pd.factorize(joined)[0]
    codes[null] = -1
    return codes


def _sum_excluding_self(
    group: np.ndarray, value: pd.Series, include: np.ndarray
) -> np.ndarray:
    """sum of ``value`` over the group's ``include`` rows, minus this row's own.

    the own contribution is subtracted arithmetically, so a row cannot influence
    its own feature. a null magnitude contributes 0 rather than NaN, which would
    poison the whole team-game's sum.
    """
    contribution = pd.to_numeric(value, errors="coerce").fillna(0.0).to_numpy()
    contribution = np.where(include, contribution, 0.0)
    total = pd.Series(contribution).groupby(group).transform("sum").to_numpy()
    out = total - contribution
    return np.where(group < 0, np.nan, out)


def _weighted_count_greater(
    group: np.ndarray, value: pd.Series, weight: np.ndarray
) -> np.ndarray:
    """``sum_{j in group, value_j > value_i} weight_j`` for every row i.

    not groupby().rank(): this is defined for every row including zero-weight ones,
    so a feature that is null exactly when a player is out cannot leak his own
    availability. the tie-block minimum trick relies on non-negative weights.
    """
    n = len(value)
    order = pd.DataFrame({
        "g": group,
        "v": pd.to_numeric(value, errors="coerce").fillna(-np.inf).to_numpy(),
        "w": pd.to_numeric(pd.Series(weight), errors="coerce").fillna(0.0).to_numpy(),
    })
    if (order["w"].to_numpy() < 0).any():
        raise ValueError(
            "negative weights break the tie-block minimum trick: the running total "
            "must be non-decreasing with sort position"
        )
    order = order.sort_values(["g", "v"], ascending=[True, False], kind="stable")
    cumulative = order.groupby("g", sort=False)["w"].cumsum()
    before = cumulative - order["w"]
    order["cnt"] = before.groupby([order["g"], order["v"]]).transform("min")
    counts = order["cnt"].sort_index().to_numpy()
    if len(counts) != n:
        raise ValueError(
            f"rank restore lost rows: {len(counts)} of {n}. the sort round-trip "
            f"relies on a clean positional index"
        )
    return np.where(group < 0, np.nan, counts)


def _count_greater(
    group: np.ndarray, value: pd.Series, eligible: np.ndarray
) -> np.ndarray:
    """``#{j in group : eligible_j and value_j > value_i}``, the v2 realized rank."""
    return _weighted_count_greater(group, value, eligible.astype(float))


def vacated_features(frame: pd.DataFrame) -> pd.DataFrame:
    """the nine v2 oracle teammate-context columns, added to an as-of joined frame.

    needs std_MIN, std_FGA, usg_ewma, n_appearances, PLAYED, LISTED_INACTIVE,
    POS_GROUP and the team-game key. row order is preserved.
    """
    out = frame.copy()
    original_index = out.index
    out = out.reset_index(drop=True)

    for column in ("GAME_ID", "TEAM_ID", "PLAYED"):
        if column not in out.columns:
            raise ValueError(f"vacated_features needs {column!r} on the frame")

    team_game = _group_codes(out["GAME_ID"], out["TEAM_ID"])
    absent = absence_mask(out)
    available = ~absent

    if "POS_GROUP" in out.columns:
        pos_group = _group_codes(out["GAME_ID"], out["TEAM_ID"], out["POS_GROUP"])
    else:
        pos_group = np.full(len(out), -1)

    for source, target in VACATED_SOURCES.items():
        if source not in out.columns:
            log.warning("no %s on the frame; %s will be null", source, target)
            out[target] = np.nan
            continue
        out[target] = _sum_excluding_self(team_game, out[source], absent)

    if "std_MIN" in out.columns:
        out["vacated_minutes_pos"] = _sum_excluding_self(
            pos_group, out["std_MIN"], absent
        )
    else:
        out["vacated_minutes_pos"] = np.nan

    if "std_MIN" in out.columns:
        out["depth_rank_available"] = 1.0 + _count_greater(
            team_game, out["std_MIN"], available
        )
        out["depth_rank_available_pos"] = 1.0 + _count_greater(
            pos_group, out["std_MIN"], available
        )
    else:
        out["depth_rank_available"] = np.nan
        out["depth_rank_available_pos"] = np.nan

    if USAGE_COLUMN in out.columns and "n_appearances" in out.columns:
        established = (
            out[USAGE_COLUMN].notna()
            & (
                pd.to_numeric(out["n_appearances"], errors="coerce").fillna(0.0)
                >= STAR_USAGE_MIN_APPEARANCES
            )
        ).to_numpy()
        usage_rank = 1.0 + _count_greater(team_game, out[USAGE_COLUMN], established)
        is_top1 = established & (usage_rank <= 1)
        is_topn = established & (usage_rank <= TOP_USAGE_N)
        out["star_out"] = (
            _sum_excluding_self(team_game, pd.Series(is_top1.astype(float)), absent) > 0
        ).astype(float)
        out["top3_usage_out_count"] = np.clip(
            _sum_excluding_self(team_game, pd.Series(is_topn.astype(float)), absent),
            0.0,
            float(TOP_USAGE_N),
        )
    else:
        log.warning("no %s / n_appearances on the frame; star_out will be null",
                    USAGE_COLUMN)
        out["star_out"] = np.nan
        out["top3_usage_out_count"] = np.nan

    out.index = original_index
    return out


def expected_vacated_features(
    frame: pd.DataFrame, probability: pd.Series | np.ndarray
) -> pd.DataFrame:
    """the eight served teammate-context columns plus the teammate reliability one.

    ``probability`` is the as-of play probability of the row's own player,
    positionally aligned to ``frame``. it must be out of fold for its own row and
    come from a model with no teammate-context features, or the construction is
    circular. no target-game outcome column is read here. row order is preserved.
    """
    out = frame.copy()
    original_index = out.index
    out = out.reset_index(drop=True)

    for column in ("GAME_ID", "TEAM_ID"):
        if column not in out.columns:
            raise ValueError(f"expected_vacated_features needs {column!r} on the frame")

    p = pd.to_numeric(pd.Series(np.asarray(probability, dtype=float)), errors="coerce")
    if len(p) != len(out):
        raise ValueError(
            f"probability has {len(p)} values for {len(out)} rows; it must be "
            f"positionally aligned to the frame"
        )
    # an unscoreable row falls back to the prior rather than NaN, which would
    # poison the whole team-game's sum
    p = p.fillna(float(CONTEXT_P_PRIOR)).clip(0.0, 1.0)
    absent_probability = 1.0 - p
    everyone = np.ones(len(out), dtype=bool)

    team_game = _group_codes(out["GAME_ID"], out["TEAM_ID"])
    if "POS_GROUP" in out.columns:
        pos_group = _group_codes(out["GAME_ID"], out["TEAM_ID"], out["POS_GROUP"])
    else:
        pos_group = np.full(len(out), -1)

    for source, target in EXPECTED_SOURCES.items():
        if source not in out.columns:
            log.warning("no %s on the frame; %s will be null", source, target)
            out[target] = np.nan
            continue
        out[target] = _sum_excluding_self(
            team_game, absent_probability * out[source].astype(float), everyone
        )

    if "tm_MIN" in out.columns:
        out["exp_vacated_minutes_pos"] = _sum_excluding_self(
            pos_group, absent_probability * out["tm_MIN"].astype(float), everyone
        )
    else:
        out["exp_vacated_minutes_pos"] = np.nan

    # E[depth rank] = 1 + sum_{j != i} p_j 1(m_j > m_i); a real number, not an int
    if "tm_MIN" in out.columns:
        out["exp_depth_rank"] = 1.0 + _weighted_count_greater(
            team_game, out["tm_MIN"], p.to_numpy()
        )
        out["exp_depth_rank_pos"] = 1.0 + _weighted_count_greater(
            pos_group, out["tm_MIN"], p.to_numpy()
        )
    else:
        out["exp_depth_rank"] = np.nan
        out["exp_depth_rank_pos"] = np.nan

    if "tm_USG" in out.columns and "n_appearances" in out.columns:
        established = (
            out["tm_USG"].notna()
            & (
                pd.to_numeric(out["n_appearances"], errors="coerce").fillna(0.0)
                >= STAR_USAGE_MIN_APPEARANCES
            )
        ).to_numpy()
        usage_rank = 1.0 + _count_greater(team_game, out["tm_USG"], established)
        is_top1 = established & (usage_rank <= 1)
        is_topn = established & (usage_rank <= TOP_USAGE_N)
        out["p_star_out"] = np.clip(
            _sum_excluding_self(
                team_game,
                pd.Series(is_top1.astype(float)) * absent_probability,
                everyone,
            ),
            0.0, 1.0,
        )
        out["exp_top3_usage_out"] = np.clip(
            _sum_excluding_self(
                team_game,
                pd.Series(is_topn.astype(float)) * absent_probability,
                everyone,
            ),
            0.0, float(TOP_USAGE_N),
        )
    else:
        log.warning("no tm_USG / n_appearances on the frame; p_star_out will be null")
        out["p_star_out"] = np.nan
        out["exp_top3_usage_out"] = np.nan

    # absence-weighted mean sample size; NaN when nobody is expected out, because a
    # mean over an empty set is not 0
    if MAGNITUDE_ESS in out.columns:
        weighted = _sum_excluding_self(
            team_game,
            absent_probability * out[MAGNITUDE_ESS].astype(float).fillna(0.0),
            everyone,
        )
        mass = _sum_excluding_self(team_game, absent_probability, everyone)
        with np.errstate(invalid="ignore", divide="ignore"):
            out[TEAMMATE_ESS] = np.where(mass > 1e-9, weighted / mass, np.nan)
    else:
        out[TEAMMATE_ESS] = np.nan

    absent_columns = [c for c in TEAMMATE_EXPECTED_COLS if c not in out.columns]
    if absent_columns:
        raise ValueError(
            f"expected_vacated_features did not produce {', '.join(absent_columns)}; "
            f"config.TEAMMATE_EXPECTED_COLS and this function have drifted apart"
        )

    out.index = original_index
    return out


def teammate_feature_summary(frame: pd.DataFrame) -> pd.DataFrame:
    """null rate and distribution of both families, for the dataset build's stdout."""
    wanted = [
        *TEAMMATE_FEATURE_COLS,
        *(c for c in TEAMMATE_ORACLE_COLS if c not in TEAMMATE_FEATURE_COLS),
        *(c for c in MAGNITUDE_SOURCES.values()),
    ]
    present = [c for c in wanted if c in frame.columns]
    if not present:
        return pd.DataFrame()
    described = frame[present].describe().T
    described["null_rate"] = frame[present].isna().mean()
    return described[["null_rate", "mean", "std", "min", "50%", "max"]]


def position_group_counts(frame: pd.DataFrame) -> pd.Series:
    """rows per position bucket, including the unmatched ones."""
    if "POS_GROUP" not in frame.columns:
        return pd.Series(dtype=int)
    counts = frame["POS_GROUP"].fillna("(unknown)").value_counts()
    order = [g for g in POS_GROUP_ORDER if g in counts.index]
    return counts.reindex(order + [i for i in counts.index if i not in order])
