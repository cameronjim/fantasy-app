"""
Phase 0 spike: build the SCHEDULED-PLAYER-GAME universe.

This is the heart of the "predict availability first" design. A model trained
only on recorded appearances answers "how much will he produce GIVEN he plays",
which is selection-biased: for fantasy you need E[production] over the games
that are actually on the schedule, including the ones he misses.

So the unit of analysis is (eligible player, team-game), NOT (player, game log).

ROSTER APPROXIMATION (important - see README):
    We do not call per-game boxscores (that would be ~2,500 requests/season and
    stats.nba.com throttles hard). Instead the eligible roster for a team-game
    on date d is approximated as:

        every player who recorded >= 1 game log for THAT team within [d-15, d+15]

    The +/-15 day forward-looking window is used only to RECONSTRUCT ROSTER
    MEMBERSHIP, never as a model feature. It is nonetheless an approximation
    with known biases (documented in README.md / REPORT.md):
      - a player injured for >15 days on either side drops out of the universe
        entirely, so long-term injuries are under-counted -> availability base
        rate is biased UPWARD
      - traded players stay "eligible" for their old team for up to 15 days
      - 10-day contracts / two-way call-ups appear only around their stint

    The real implementation will use official inactive lists / injury reports.

Output: data/universe.parquet
Run:    python build_universe.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent / "data"
SEASONS = ["2023-24", "2024-25"]
ROSTER_WINDOW_DAYS = 15

STAT_COLS = ["MIN", "PTS", "AST", "FGA", "REB", "FG3M", "FTM", "TOV", "STL", "BLK"]


def load_logs() -> tuple[pd.DataFrame, pd.DataFrame]:
    """Load and normalise player + team game logs across seasons."""
    players, teams = [], []
    for season in SEASONS:
        tag = season.replace("-", "_")

        p = pd.read_parquet(DATA_DIR / f"player_logs_{tag}.parquet")
        p = p[["PLAYER_ID", "PLAYER_NAME", "TEAM_ID", "TEAM_ABBREVIATION",
               "GAME_ID", "GAME_DATE"] + STAT_COLS].copy()
        p["SEASON"] = season
        players.append(p)

        t = pd.read_parquet(DATA_DIR / f"team_logs_{tag}.parquet")
        t = t[["TEAM_ID", "TEAM_ABBREVIATION", "GAME_ID", "GAME_DATE",
               "MATCHUP", "WL", "PTS"]].copy()
        t["SEASON"] = season
        teams.append(t)

    pl = pd.concat(players, ignore_index=True)
    tm = pd.concat(teams, ignore_index=True)

    pl["GAME_DATE"] = pd.to_datetime(pl["GAME_DATE"]).dt.normalize()
    tm["GAME_DATE"] = pd.to_datetime(tm["GAME_DATE"]).dt.normalize()

    pl["PLAYER_ID"] = pl["PLAYER_ID"].astype("int64")
    pl["TEAM_ID"] = pl["TEAM_ID"].astype("int64")
    tm["TEAM_ID"] = tm["TEAM_ID"].astype("int64")
    pl["GAME_ID"] = pl["GAME_ID"].astype(str)
    tm["GAME_ID"] = tm["GAME_ID"].astype(str)

    return pl, tm


def build_schedule(tm: pd.DataFrame) -> pd.DataFrame:
    """One row per (team, game): opponent id, home flag, team points allowed."""
    sched = tm[["SEASON", "GAME_ID", "GAME_DATE", "TEAM_ID",
                "TEAM_ABBREVIATION", "MATCHUP", "WL", "PTS"]].copy()
    sched["IS_HOME"] = (~sched["MATCHUP"].str.contains("@")).astype(int)

    # opponent = the other row sharing the GAME_ID
    other = sched[["GAME_ID", "TEAM_ID", "PTS"]].rename(
        columns={"TEAM_ID": "OPP_TEAM_ID", "PTS": "OPP_PTS"}
    )
    sched = sched.merge(other, on="GAME_ID")
    sched = sched[sched["TEAM_ID"] != sched["OPP_TEAM_ID"]].copy()

    # PTS_ALLOWED for this team in this game = opponent's points
    sched = sched.rename(columns={"PTS": "TEAM_PTS", "OPP_PTS": "TEAM_PTS_ALLOWED"})
    return sched.reset_index(drop=True)


def build_eligibility(pl: pd.DataFrame, sched: pd.DataFrame) -> pd.DataFrame:
    """
    For each team-game, the approximate eligible roster.

    Vectorised with searchsorted: for each (season, team, player) we hold the
    sorted array of that player's appearance dates for that team, then ask -
    for every team game date d - whether any appearance falls in [d-15, d+15].
    """
    window = np.timedelta64(ROSTER_WINDOW_DAYS, "D")
    rows = []

    appearances = (
        pl.groupby(["SEASON", "TEAM_ID", "PLAYER_ID"])["GAME_DATE"]
        .apply(lambda s: np.sort(s.to_numpy()))
        .reset_index(name="APP_DATES")
    )

    for (season, team_id), team_games in sched.groupby(["SEASON", "TEAM_ID"]):
        game_dates = team_games["GAME_DATE"].to_numpy()
        game_ids = team_games["GAME_ID"].to_numpy()

        lo = game_dates - window
        hi = game_dates + window

        roster = appearances[
            (appearances["SEASON"] == season) & (appearances["TEAM_ID"] == team_id)
        ]

        for player_id, app_dates in zip(roster["PLAYER_ID"], roster["APP_DATES"]):
            left = np.searchsorted(app_dates, lo, side="left")
            right = np.searchsorted(app_dates, hi, side="right")
            eligible = right > left
            if not eligible.any():
                continue
            rows.append(
                pd.DataFrame({
                    "SEASON": season,
                    "TEAM_ID": team_id,
                    "PLAYER_ID": player_id,
                    "GAME_ID": game_ids[eligible],
                    "GAME_DATE": game_dates[eligible],
                })
            )

    return pd.concat(rows, ignore_index=True)


def main() -> int:
    pl, tm = load_logs()
    print(f"player logs : {len(pl):,} rows, {pl['PLAYER_ID'].nunique()} players")
    print(f"team logs   : {len(tm):,} rows, {tm['GAME_ID'].nunique()} games")

    sched = build_schedule(tm)
    print(f"schedule    : {len(sched):,} team-games")

    elig = build_eligibility(pl, sched)
    print(f"eligibility : {len(elig):,} (player, team-game) pairs")

    # Attach schedule context
    universe = elig.merge(
        sched[["SEASON", "GAME_ID", "TEAM_ID", "TEAM_ABBREVIATION", "OPP_TEAM_ID",
               "IS_HOME", "TEAM_PTS", "TEAM_PTS_ALLOWED"]],
        on=["SEASON", "GAME_ID", "TEAM_ID"],
        how="left",
    )

    # Attach outcome: did this player actually record a log for this exact
    # (player, game, team)? Joining on team matters for traded players.
    actual = pl[["PLAYER_ID", "GAME_ID", "TEAM_ID", "PLAYER_NAME"] + STAT_COLS].copy()
    actual["PLAYED"] = 1

    universe = universe.merge(
        actual, on=["PLAYER_ID", "GAME_ID", "TEAM_ID"], how="left"
    )
    universe["PLAYED"] = universe["PLAYED"].fillna(0).astype(int)
    for c in STAT_COLS:
        universe[c] = universe[c].fillna(0.0)

    # Player name for rows where he did not play: backfill from any log
    names = pl.groupby("PLAYER_ID")["PLAYER_NAME"].first()
    universe["PLAYER_NAME"] = universe["PLAYER_NAME"].fillna(
        universe["PLAYER_ID"].map(names)
    )

    universe = universe.sort_values(
        ["SEASON", "PLAYER_ID", "GAME_DATE"]
    ).reset_index(drop=True)

    out = DATA_DIR / "universe.parquet"
    universe.to_parquet(out, index=False)

    print("\n--- UNIVERSE SUMMARY ---")
    print(f"rows                 : {len(universe):,}")
    print(f"distinct players     : {universe['PLAYER_ID'].nunique()}")
    print(f"distinct team-games  : {universe.groupby(['GAME_ID','TEAM_ID']).ngroups:,}")
    print(f"avg roster size      : {len(universe) / universe.groupby(['GAME_ID','TEAM_ID']).ngroups:.2f}")
    print(f"overall played rate  : {universe['PLAYED'].mean():.4f}")
    for season, g in universe.groupby("SEASON"):
        print(f"  {season}: {len(g):,} rows, played rate {g['PLAYED'].mean():.4f}, "
              f"roster {len(g)/g.groupby(['GAME_ID','TEAM_ID']).ngroups:.2f}")

    # sanity: every actual appearance should be captured by the universe
    covered = universe[universe["PLAYED"] == 1]
    print(f"\nappearances in universe: {len(covered):,} of {len(pl):,} player logs "
          f"({len(covered)/len(pl):.4%})")
    print(f"saved -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
