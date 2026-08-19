"""
Phase 0 spike: raw data pull from stats.nba.com via nba_api.

Pulls, for each target season (Regular Season only):
  1. League-wide PLAYER game logs  -> data/player_logs_<season>.parquet
  2. League-wide TEAM   game logs  -> data/team_logs_<season>.parquet

The team logs give us the full schedule of completed games (two rows per game,
one per team), which is the backbone of the "scheduled player-game" universe.

Design notes:
  * ONE request per (season, mode). No per-game boxscore calls - that would be
    ~2500 requests per season and stats.nba.com will throttle/ban.
  * Idempotent: if the parquet already exists, the pull is skipped.
  * Polite: 3s sleep between calls, 60s timeout, browser-ish headers (nba_api
    sets these itself, but we bump the timeout).

Run:
    python pull_data.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

import pandas as pd

from nba_api.stats.endpoints import leaguegamelog, playergamelogs

DATA_DIR = Path(__file__).resolve().parent / "data"
SEASONS = ["2023-24", "2024-25"]
SEASON_TYPE = "Regular Season"

TIMEOUT = 60
SLEEP_BETWEEN_CALLS = 3.0
MAX_RETRIES = 3


def _sleep(seconds: float, why: str) -> None:
    print(f"    ... sleeping {seconds:.0f}s ({why})", flush=True)
    time.sleep(seconds)


def _with_retries(fn, label: str):
    """Call fn() with bounded retries and backoff. Raise on persistent failure."""
    last_err = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            print(f"  -> {label} (attempt {attempt}/{MAX_RETRIES})", flush=True)
            return fn()
        except Exception as err:  # noqa: BLE001 - we want to report anything
            last_err = err
            print(f"     FAILED: {type(err).__name__}: {err}", flush=True)
            if attempt < MAX_RETRIES:
                _sleep(SLEEP_BETWEEN_CALLS * attempt * 2, "backoff after failure")
    raise RuntimeError(
        f"{label} failed after {MAX_RETRIES} attempts. Last error: {last_err}"
    )


def pull_player_logs(season: str) -> pd.DataFrame:
    def _call():
        ep = playergamelogs.PlayerGameLogs(
            season_nullable=season,
            season_type_nullable=SEASON_TYPE,
            timeout=TIMEOUT,
        )
        return ep.get_data_frames()[0]

    return _with_retries(_call, f"PlayerGameLogs {season}")


def pull_team_logs(season: str) -> pd.DataFrame:
    def _call():
        ep = leaguegamelog.LeagueGameLog(
            season=season,
            season_type_all_star=SEASON_TYPE,
            player_or_team_abbreviation="T",
            timeout=TIMEOUT,
        )
        return ep.get_data_frames()[0]

    return _with_retries(_call, f"LeagueGameLog(team) {season}")


def _save(df: pd.DataFrame, path: Path, label: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # Normalise object columns that pyarrow may choke on
    df = df.copy()
    df.to_parquet(path, index=False)
    print(f"     saved {label}: {len(df):,} rows, {len(df.columns)} cols -> {path.name}")


def main() -> int:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Data dir: {DATA_DIR}")

    jobs = []
    for season in SEASONS:
        tag = season.replace("-", "_")
        jobs.append((f"player_logs_{tag}.parquet", lambda s=season: pull_player_logs(s),
                     f"player logs {season}"))
        jobs.append((f"team_logs_{tag}.parquet", lambda s=season: pull_team_logs(s),
                     f"team logs {season}"))

    did_network_call = False
    for filename, fetch, label in jobs:
        path = DATA_DIR / filename
        if path.exists():
            existing = pd.read_parquet(path)
            print(f"  SKIP {label}: {path.name} exists ({len(existing):,} rows)")
            continue

        if did_network_call:
            _sleep(SLEEP_BETWEEN_CALLS, "between API calls")

        df = fetch()
        did_network_call = True
        _save(df, path, label)

    print("\nPull complete. Files on disk:")
    for p in sorted(DATA_DIR.glob("*.parquet")):
        df = pd.read_parquet(p)
        print(f"  {p.name:32s} {len(df):>8,} rows  {len(df.columns):>3} cols")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except RuntimeError as err:
        print(f"\nFATAL: {err}", file=sys.stderr)
        print(
            "stats.nba.com appears to be blocking or timing out. "
            "STOPPING rather than hammering the endpoint.",
            file=sys.stderr,
        )
        sys.exit(2)
