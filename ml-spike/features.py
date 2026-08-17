"""
Phase 0 spike: leakage-safe feature construction.

AS-OF RULE: every feature on the row for game G may use information from
strictly before G. Two mechanisms enforce this, and only these two:

  1. merge_asof(..., allow_exact_matches=False) for anything derived from the
     player's APPEARANCE history. Rolling stats are computed on the appearance
     frame INCLUSIVE of the current appearance, then as-of joined onto the
     universe picking the last appearance STRICTLY BEFORE the target date. The
     appearance on the target date itself can never be matched.

  2. explicit .shift(1) before every .rolling()/.expanding() for anything
     computed directly on the universe/schedule frames (availability rate,
     rest days, opponent defensive form).

Rolling windows over the player's stat history are taken over APPEARANCES only
(a 0-minute non-appearance should not drag the scoring average down), while
availability rate is taken over SCHEDULED games (that is the whole point).

Output: data/features.parquet
Run:    python features.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent / "data"

ROLL_WINDOWS = [3, 5, 10]
ROLL_STATS = ["MIN", "PTS", "AST", "FGA"]
AVAIL_WINDOW = 10
OPP_FORM_WINDOW = 10


# --------------------------------------------------------------------------
# player features from APPEARANCE history (as-of joined)
# --------------------------------------------------------------------------
def player_appearance_features(universe: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """
    Build the appearance frame with rolling/expanding stats INCLUSIVE of each
    appearance, ready to be as-of joined onto the universe.

    Returns TWO frames because they have different scopes and therefore need
    different as-of join keys:

      career : rolling-N and EWMA windows over the player's whole chronological
               appearance history. Joined by PLAYER_ID only, so a player's
               first game of a new season still carries his prior-season form
               (which is exactly when in-season history is unavailable).

      season : season-to-date expanding means. Joined by PLAYER_ID + SEASON so
               they correctly reset at the season boundary.

    Doing this as a single join would force one scope on both and silently
    corrupt one of them.
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

        # season-to-date expanding mean, resets each season
        col = f"std_{stat}"  # season-to-date
        app[col] = app.groupby(["PLAYER_ID", "SEASON"])[stat].transform(
            lambda s: s.expanding(min_periods=1).mean()
        )
        season_cols.append(col)

        # exponentially weighted mean (halflife 5 appearances) - a baseline
        col = f"ewma_{stat}"
        app[col] = grp.transform(lambda s: s.ewm(halflife=5, adjust=True).mean())
        career_cols.append(col)

    # count of appearances so far (inclusive) - history depth signal
    app["n_appearances"] = app.groupby("PLAYER_ID").cumcount() + 1
    career_cols.append("n_appearances")

    # the date of this appearance, carried through the join so we can compute
    # "days since last appearance" on the target row
    app["LAST_APP_DATE"] = app["GAME_DATE"]
    career_cols.append("LAST_APP_DATE")

    career = app[career_cols].sort_values("GAME_DATE").reset_index(drop=True)
    season = app[season_cols].sort_values("GAME_DATE").reset_index(drop=True)
    return career, season


# --------------------------------------------------------------------------
# schedule-level features (team rest, opponent defensive form)
# --------------------------------------------------------------------------
def schedule_features(universe: pd.DataFrame) -> pd.DataFrame:
    """One row per (season, team, game): rest days, b2b, shifted defensive form."""
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

    # defensive form: mean points allowed over the previous OPP_FORM_WINDOW
    # games. .shift(1) FIRST so the target game is excluded.
    sched["DEF_FORM"] = grp["TEAM_PTS_ALLOWED"].transform(
        lambda s: s.shift(1).rolling(OPP_FORM_WINDOW, min_periods=3).mean()
    )

    return sched[["SEASON", "TEAM_ID", "GAME_ID", "TEAM_REST_DAYS", "IS_B2B", "DEF_FORM"]]


# --------------------------------------------------------------------------
# main assembly
# --------------------------------------------------------------------------
def build_features() -> pd.DataFrame:
    universe = pd.read_parquet(DATA_DIR / "universe.parquet")
    universe["GAME_DATE"] = pd.to_datetime(universe["GAME_DATE"])
    universe = universe.sort_values(
        ["PLAYER_ID", "GAME_DATE", "GAME_ID"]
    ).reset_index(drop=True)

    # ---- availability history: over SCHEDULED games, explicit shift(1) ----
    g = universe.groupby("PLAYER_ID")["PLAYED"]
    universe["avail_rate_10"] = g.transform(
        lambda s: s.shift(1).rolling(AVAIL_WINDOW, min_periods=1).mean()
    )
    universe["avail_rate_20"] = g.transform(
        lambda s: s.shift(1).rolling(20, min_periods=1).mean()
    )
    universe["avail_rate_std"] = universe.groupby(["PLAYER_ID", "SEASON"])[
        "PLAYED"
    ].transform(lambda s: s.shift(1).expanding(min_periods=1).mean())

    # UNCONDITIONAL season-to-date means over ALL SCHEDULED rows (misses count
    # as 0). This is the honest naive baseline for the unconditional target -
    # contrast with std_PTS, which is conditional on appearing.
    for stat in ["PTS", "MIN", "AST"]:
        universe[f"uncond_std_{stat}"] = universe.groupby(
            ["PLAYER_ID", "SEASON"]
        )[stat].transform(lambda s: s.shift(1).expanding(min_periods=1).mean())

    # games (scheduled team-games) missed since the last appearance.
    # block id increments immediately AFTER each appearance.
    prior = universe.groupby("PLAYER_ID")["PLAYED"].shift(1).fillna(0)
    universe["_block"] = prior.groupby(universe["PLAYER_ID"]).cumsum()
    universe["games_since_last_app"] = universe.groupby(
        ["PLAYER_ID", "_block"]
    ).cumcount()
    # before a player's first ever appearance there is no "last appearance"
    ever_played = universe.groupby("PLAYER_ID")["PLAYED"].shift(1).groupby(
        universe["PLAYER_ID"]
    ).cummax()
    universe.loc[ever_played.fillna(0) == 0, "games_since_last_app"] = np.nan
    universe = universe.drop(columns=["_block"])

    # ---- player appearance rollings, as-of joined (STRICTLY before) ----
    career_feats, season_feats = player_appearance_features(universe)
    universe = universe.sort_values("GAME_DATE").reset_index(drop=True)

    # career-scoped: rolling-N / EWMA windows may span the offseason
    universe = pd.merge_asof(
        universe,
        career_feats,
        on="GAME_DATE",
        by="PLAYER_ID",
        direction="backward",
        allow_exact_matches=False,   # <-- the leakage guard
    )
    # season-scoped: season-to-date means reset at the season boundary
    universe = pd.merge_asof(
        universe,
        season_feats,
        on="GAME_DATE",
        by=["PLAYER_ID", "SEASON"],
        direction="backward",
        allow_exact_matches=False,   # <-- the leakage guard
    )

    universe["days_since_last_app"] = (
        universe["GAME_DATE"] - universe["LAST_APP_DATE"]
    ).dt.days

    # ---- schedule features for own team and opponent ----
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
    universe = universe.merge(
        opp, on=["SEASON", "OPP_TEAM_ID", "GAME_ID"], how="left"
    )

    # ---- missingness indicator ----
    universe["has_history"] = universe["roll5_MIN"].notna().astype(int)
    universe["insufficient_history"] = (
        universe["roll5_MIN"].isna()
        | universe["n_appearances"].isna()
        | (universe["n_appearances"].fillna(0) < 3)
    ).astype(int)

    # ---- minutes tier for segment reporting (from PRIOR rolling mean only) ----
    tier_basis = universe["roll10_MIN"]
    universe["MIN_TIER"] = pd.cut(
        tier_basis,
        bins=[-np.inf, 10, 20, 30, np.inf],
        labels=["fringe (<10)", "bench (10-20)", "starter (20-30)", "star (>=30)"],
    ).astype(object)
    universe["MIN_TIER"] = universe["MIN_TIER"].fillna("unknown (no history)")

    universe = universe.sort_values(
        ["GAME_DATE", "GAME_ID", "TEAM_ID", "PLAYER_ID"]
    ).reset_index(drop=True)
    return universe


FEATURE_COLS = (
    [f"roll{w}_{s}" for s in ROLL_STATS for w in ROLL_WINDOWS]
    + [f"std_{s}" for s in ROLL_STATS]
    + [f"ewma_{s}" for s in ROLL_STATS]
    + ["uncond_std_PTS", "uncond_std_MIN", "uncond_std_AST"]
    + [
        "n_appearances",
        "days_since_last_app",
        "games_since_last_app",
        "avail_rate_10",
        "avail_rate_20",
        "avail_rate_std",
        "TEAM_REST_DAYS",
        "IS_B2B",
        "IS_HOME",
        "OPP_DEF_FORM",
        "OPP_REST_DAYS",
        "insufficient_history",
        "has_history",
    ]
)


def main() -> int:
    feats = build_features()
    out = DATA_DIR / "features.parquet"
    feats.to_parquet(out, index=False)

    print("--- FEATURES ---")
    print(f"rows: {len(feats):,}   feature cols: {len(FEATURE_COLS)}")
    print(f"saved -> {out}\n")

    print("null rate per feature:")
    nulls = feats[FEATURE_COLS].isna().mean().sort_values(ascending=False)
    for k, v in nulls.items():
        print(f"  {k:26s} {v:7.4f}")

    print("\nminutes-tier distribution (all scheduled rows):")
    print(feats["MIN_TIER"].value_counts().to_string())

    print("\nplayed rate by minutes tier:")
    print(feats.groupby("MIN_TIER")["PLAYED"].agg(["mean", "size"]).to_string())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
