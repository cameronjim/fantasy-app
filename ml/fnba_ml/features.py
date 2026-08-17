"""leakage-safe feature construction, ported from the phase-0 spike.

AS-OF RULE: every feature on the row for game G may use information from
strictly before G. exactly two mechanisms enforce this, and only these two:

  1. ``merge_asof(..., allow_exact_matches=False)`` for anything derived from
     the player's APPEARANCE history. rolling stats are computed on the
     appearance frame inclusive of the current appearance, then as-of joined
     onto the universe picking the last appearance STRICTLY BEFORE the target
     date. the appearance on the target date itself can never be matched.

  2. explicit ``.shift(1)`` before every ``.rolling()``/``.expanding()`` for
     anything computed directly on the universe/schedule frames (availability
     rate, rest days, opponent defensive form).

TWO AS-OF JOINS, NOT ONE. this is the trap the spike hit and fixed: rolling
windows are grouped by PLAYER_ID alone (career scope, may span the offseason)
while season-to-date means are grouped by PLAYER_ID + SEASON. a single join
keyed on PLAYER_ID + SEASON gave returning players NaN form in their first game
of a new season while their second game silently pulled the prior season into
the window. the scope of the join must match the scope of the window.

rolling windows over the player's stat history are taken over APPEARANCES only
(a 0-minute non-appearance should not drag the scoring average down), while
availability rate is taken over SCHEDULED games - that is the whole point.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import (
    AVAIL_WINDOWS,
    EWMA_HALFLIFE,
    FEATURE_COLS,
    OPP_FORM_MIN_PERIODS,
    OPP_FORM_WINDOW,
    ROLL_STATS,
    ROLL_WINDOWS,
    TIER_BASIS,
    TIER_EDGES,
    TIER_LABELS,
    UNCOND_STATS,
    UNKNOWN_TIER,
)

log = logging.getLogger(__name__)

MIN_APPEARANCES_FOR_HISTORY = 3


def player_appearance_features(
    universe: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """rolling/expanding stats on the appearance frame, ready to be as-of joined.

    returns two frames because they have different scopes and therefore need
    different as-of join keys:

      career : rolling-N and EWMA windows over the player's whole chronological
               appearance history. joined by PLAYER_ID only, so a player's
               first game of a new season still carries prior-season form -
               which is exactly when in-season history is unavailable.

      season : season-to-date expanding means. joined by PLAYER_ID + SEASON so
               they reset correctly at the season boundary.
    """
    app = universe[universe["PLAYED"] == 1].copy()
    app = app.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)

    career_cols = ["PLAYER_ID", "GAME_DATE"]
    season_cols = ["PLAYER_ID", "SEASON", "GAME_DATE"]

    for stat in ROLL_STATS:
        grp = app.groupby("PLAYER_ID")[stat]
        for w in ROLL_WINDOWS:
            col = f"roll{w}_{stat}"
            # inclusive of this appearance; the as-of join supplies the shift
            app[col] = grp.transform(lambda s, w=w: s.rolling(w, min_periods=1).mean())
            career_cols.append(col)

        col = f"std_{stat}"
        app[col] = app.groupby(["PLAYER_ID", "SEASON"])[stat].transform(
            lambda s: s.expanding(min_periods=1).mean()
        )
        season_cols.append(col)

        # the promoted conditional-production estimate. spike finding: this
        # beats or matches every trained model on established players.
        col = f"ewma_{stat}"
        app[col] = grp.transform(lambda s: s.ewm(halflife=EWMA_HALFLIFE, adjust=True).mean())
        career_cols.append(col)

    app["n_appearances"] = app.groupby("PLAYER_ID").cumcount() + 1
    career_cols.append("n_appearances")

    app["LAST_APP_DATE"] = app["GAME_DATE"]
    career_cols.append("LAST_APP_DATE")

    career = app[career_cols].sort_values("GAME_DATE").reset_index(drop=True)
    season = app[season_cols].sort_values("GAME_DATE").reset_index(drop=True)
    return career, season


def schedule_features(universe: pd.DataFrame) -> pd.DataFrame:
    """one row per (season, team, game): rest days, b2b, shifted defensive form."""
    sched = (
        universe[["SEASON", "TEAM_ID", "GAME_ID", "GAME_DATE", "TEAM_PTS_ALLOWED"]]
        .drop_duplicates(["SEASON", "TEAM_ID", "GAME_ID"])
        .sort_values(["TEAM_ID", "GAME_DATE"])
        .reset_index(drop=True)
    )

    grp = sched.groupby(["TEAM_ID", "SEASON"])

    prev_date = grp["GAME_DATE"].shift(1)
    sched["TEAM_REST_DAYS"] = (sched["GAME_DATE"] - prev_date).dt.days
    sched["IS_B2B"] = (sched["TEAM_REST_DAYS"] == 1).astype(float)
    sched.loc[sched["TEAM_REST_DAYS"].isna(), "IS_B2B"] = np.nan

    # shift(1) FIRST so the target game's own points allowed is excluded
    sched["DEF_FORM"] = grp["TEAM_PTS_ALLOWED"].transform(
        lambda s: s.shift(1).rolling(OPP_FORM_WINDOW, min_periods=OPP_FORM_MIN_PERIODS).mean()
    )

    return sched[["SEASON", "TEAM_ID", "GAME_ID", "TEAM_REST_DAYS", "IS_B2B", "DEF_FORM"]]


def _availability_history(universe: pd.DataFrame) -> pd.DataFrame:
    """availability rates over SCHEDULED rows, every window explicitly shifted."""
    g = universe.groupby("PLAYER_ID")["PLAYED"]
    for w in AVAIL_WINDOWS:
        universe[f"avail_rate_{w}"] = g.transform(
            lambda s, w=w: s.shift(1).rolling(w, min_periods=1).mean()
        )
    universe["avail_rate_std"] = universe.groupby(["PLAYER_ID", "SEASON"])["PLAYED"].transform(
        lambda s: s.shift(1).expanding(min_periods=1).mean()
    )

    # unconditional season-to-date means over ALL scheduled rows (misses count
    # as 0). the honest naive baseline for the unconditional target - contrast
    # with std_PTS, which is conditional on appearing.
    for stat in UNCOND_STATS:
        universe[f"uncond_std_{stat}"] = universe.groupby(["PLAYER_ID", "SEASON"])[
            stat
        ].transform(lambda s: s.shift(1).expanding(min_periods=1).mean())

    # scheduled team-games missed since the last appearance. the block id
    # increments immediately AFTER each appearance.
    prior = universe.groupby("PLAYER_ID")["PLAYED"].shift(1).fillna(0)
    universe["_block"] = prior.groupby(universe["PLAYER_ID"]).cumsum()
    universe["games_since_last_app"] = universe.groupby(["PLAYER_ID", "_block"]).cumcount()
    ever_played = (
        universe.groupby("PLAYER_ID")["PLAYED"]
        .shift(1)
        .groupby(universe["PLAYER_ID"])
        .cummax()
    )
    universe.loc[ever_played.fillna(0) == 0, "games_since_last_app"] = np.nan
    return universe.drop(columns=["_block"])


def assign_minutes_tier(frame: pd.DataFrame) -> pd.Series:
    """segment label from a strictly prior rolling mean, so it is as-of safe."""
    tier = pd.cut(
        frame[TIER_BASIS],
        bins=[-np.inf, *TIER_EDGES, np.inf],
        labels=list(TIER_LABELS),
    ).astype(object)
    return tier.fillna(UNKNOWN_TIER)


def build_features(universe: pd.DataFrame) -> pd.DataFrame:
    """the full feature frame for a universe. pure: no io, no globals."""
    universe = universe.copy()
    universe["GAME_DATE"] = pd.to_datetime(universe["GAME_DATE"])
    universe = universe.sort_values(["PLAYER_ID", "GAME_DATE", "GAME_ID"]).reset_index(drop=True)

    universe = _availability_history(universe)

    career_feats, season_feats = player_appearance_features(universe)
    universe = universe.sort_values("GAME_DATE").reset_index(drop=True)

    # career-scoped: rolling-N / EWMA windows may span the offseason
    universe = pd.merge_asof(
        universe,
        career_feats,
        on="GAME_DATE",
        by="PLAYER_ID",
        direction="backward",
        allow_exact_matches=False,  # the leakage guard
    )
    # season-scoped: season-to-date means reset at the season boundary
    universe = pd.merge_asof(
        universe,
        season_feats,
        on="GAME_DATE",
        by=["PLAYER_ID", "SEASON"],
        direction="backward",
        allow_exact_matches=False,  # the leakage guard
    )

    universe["days_since_last_app"] = (
        universe["GAME_DATE"] - universe["LAST_APP_DATE"]
    ).dt.days

    sf = schedule_features(universe)
    universe = universe.merge(
        sf[["SEASON", "TEAM_ID", "GAME_ID", "TEAM_REST_DAYS", "IS_B2B"]],
        on=["SEASON", "TEAM_ID", "GAME_ID"],
        how="left",
    )
    opp = sf[["SEASON", "TEAM_ID", "GAME_ID", "DEF_FORM", "TEAM_REST_DAYS"]].rename(
        columns={
            "TEAM_ID": "OPP_TEAM_ID",
            "DEF_FORM": "OPP_DEF_FORM",
            "TEAM_REST_DAYS": "OPP_REST_DAYS",
        }
    )
    universe = universe.merge(opp, on=["SEASON", "OPP_TEAM_ID", "GAME_ID"], how="left")

    universe["has_history"] = universe["roll5_MIN"].notna().astype(int)
    universe["insufficient_history"] = (
        universe["roll5_MIN"].isna()
        | universe["n_appearances"].isna()
        | (universe["n_appearances"].fillna(0) < MIN_APPEARANCES_FOR_HISTORY)
    ).astype(int)

    universe["MIN_TIER"] = assign_minutes_tier(universe)

    return universe.sort_values(
        ["GAME_DATE", "GAME_ID", "TEAM_ID", "PLAYER_ID"]
    ).reset_index(drop=True)


def build_dataset(source) -> pd.DataFrame:
    """source -> universe -> features, the whole offline pipeline."""
    from .universe import build_universe  # local import avoids a cycle

    universe = build_universe(source)
    feats = build_features(universe)
    log.info("features: %d rows, %d feature columns", len(feats), len(FEATURE_COLS))
    return feats


def available_features(frame: pd.DataFrame) -> list[str]:
    """the configured feature list, restricted to what this frame actually has."""
    return [c for c in FEATURE_COLS if c in frame.columns]
