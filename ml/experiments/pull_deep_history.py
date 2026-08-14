"""pull deep NBA history (player + team game logs) into a gitignored parquet dir.

LeagueGameLog returns MIN as an integer for every season, so minutes measured on
this data are not comparable to the PlayerGameLogs-based dataset.
"""

from __future__ import annotations

import argparse
import logging
import random
import sys
import time
from pathlib import Path
from typing import Callable, TypeVar

import pandas as pd

EXPERIMENTS_DIR = Path(__file__).resolve().parent
ML_ROOT = EXPERIMENTS_DIR.parent
if str(ML_ROOT) not in sys.path:
    sys.path.insert(0, str(ML_ROOT))

from fnba_ml.config import season_tag  # noqa: E402

log = logging.getLogger("pull_deep_history")

DEEP_DATA_DIR = ML_ROOT / "data" / "deep"

FIRST_SEASON_START_YEAR = 1996
LAST_SEASON_START_YEAR = 2025

SEASON_TYPE = "Regular Season"

REQUEST_DELAY_MIN_SECONDS = 3.0
REQUEST_DELAY_MAX_SECONDS = 5.0
MAX_ATTEMPTS = 4
INITIAL_BACKOFF_SECONDS = 5.0
REQUEST_TIMEOUT_SECONDS = 90

PLAYER_KEEP: tuple[str, ...] = (
    "PLAYER_ID", "PLAYER_NAME", "GAME_ID", "GAME_DATE", "TEAM_ID",
    "TEAM_ABBREVIATION", "MATCHUP", "MIN", "PTS", "AST", "FGA", "FTA", "REB",
    "FG3M", "FTM", "TOV", "STL", "BLK", "PLUS_MINUS",
)
# MATCHUP is load-bearing: load_schedule reconstructs home/away from the '@'.
TEAM_KEEP: tuple[str, ...] = (
    "TEAM_ID", "TEAM_ABBREVIATION", "GAME_ID", "GAME_DATE", "MATCHUP",
    "PTS", "MIN", "FGA", "FTA", "TOV",
)
PLAYER_NUMERIC: tuple[str, ...] = (
    "MIN", "PTS", "AST", "FGA", "FTA", "REB", "FG3M", "FTM", "TOV", "STL",
    "BLK", "PLUS_MINUS",
)
TEAM_NUMERIC: tuple[str, ...] = ("PTS", "MIN", "FGA", "FTA", "TOV")


def all_seasons() -> list[str]:
    return [
        f"{y}-{str(y + 1)[2:]}"
        for y in range(FIRST_SEASON_START_YEAR, LAST_SEASON_START_YEAR + 1)
    ]


def _is_retryable(exc: Exception) -> bool:
    """whether a failed stats.nba.com call is worth retrying.

    RequestException subclasses OSError, so the isinstance order is load-bearing.
    """
    import json as _json

    import requests

    if isinstance(exc, requests.exceptions.RequestException):
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status is None:
            return True
        return status == 429 or status >= 500
    if isinstance(exc, (ConnectionResetError, TimeoutError, OSError)):
        return True
    return isinstance(exc, _json.JSONDecodeError)


_FetchResult = TypeVar("_FetchResult")


def _fetch_with_retry(
    label: str,
    fetch: Callable[[], _FetchResult],
    max_attempts: int = MAX_ATTEMPTS,
    initial_delay: float = INITIAL_BACKOFF_SECONDS,
) -> _FetchResult:
    """call fetch() with exponential backoff on throttling-shaped failures."""
    delay = initial_delay
    for attempt in range(1, max_attempts + 1):
        try:
            return fetch()
        except Exception as exc:
            if attempt == max_attempts or not _is_retryable(exc):
                raise
            log.warning(
                "%s failed (attempt %d/%d): %s - retrying in %.0fs",
                label, attempt, max_attempts, exc, delay,
            )
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(f"{label}: retry loop exhausted")


def _pace() -> None:
    time.sleep(random.uniform(REQUEST_DELAY_MIN_SECONDS, REQUEST_DELAY_MAX_SECONDS))


def _fetch_league_game_log(season: str, side: str) -> pd.DataFrame:
    """one LeagueGameLog page. ``side`` is 'P' (players) or 'T' (teams)."""
    from nba_api.stats.endpoints import leaguegamelog

    def fetch():
        return leaguegamelog.LeagueGameLog(
            season=season,
            player_or_team_abbreviation=side,
            season_type_all_star=SEASON_TYPE,
            timeout=REQUEST_TIMEOUT_SECONDS,
        )

    endpoint = _fetch_with_retry(f"leaguegamelog {side} {season}", fetch)
    frames = endpoint.get_data_frames()
    if not frames:
        raise ValueError(f"leaguegamelog {side} {season} returned no data frames")
    return frames[0]


def _normalise(raw: pd.DataFrame, keep: tuple[str, ...],
               numeric: tuple[str, ...], season: str, what: str) -> pd.DataFrame:
    """subset + coerce to the fnba_ml frame shape. raises on a missing column."""
    missing = [c for c in keep if c not in raw.columns]
    if missing:
        raise ValueError(f"{what} {season}: endpoint returned no {missing}")
    out = raw[list(keep)].copy()
    out["SEASON"] = season
    out["GAME_DATE"] = pd.to_datetime(out["GAME_DATE"]).dt.normalize()
    for col in numeric:
        out[col] = pd.to_numeric(out[col], errors="coerce")
    for col in ("PLAYER_ID", "GAME_ID", "TEAM_ID"):
        if col in out.columns:
            out[col] = out[col].astype(str)
    return out.reset_index(drop=True)


def _check_player_frame(df: pd.DataFrame, season: str) -> dict:
    """per-season shape checks. warnings, not exceptions, plus recorded numbers."""
    dupes = int(df.duplicated(["PLAYER_ID", "GAME_ID"]).sum())
    if dupes:
        log.warning("%s: %d duplicate (player, game) rows", season, dupes)
    null_min = int(df["MIN"].isna().sum())
    if null_min:
        log.warning("%s: %d appearance rows with a null MIN", season, null_min)
    return {
        "rows": int(len(df)),
        "players": int(df["PLAYER_ID"].nunique()),
        "games": int(df["GAME_ID"].nunique()),
        "duplicate_player_games": dupes,
        "null_minutes": null_min,
        "zero_minute_rows": int((df["MIN"].fillna(0) == 0).sum()),
        "mean_minutes": round(float(df["MIN"].mean()), 3),
        "mean_points": round(float(df["PTS"].mean()), 3),
        "first_date": str(df["GAME_DATE"].min().date()),
        "last_date": str(df["GAME_DATE"].max().date()),
    }


def _check_team_frame(df: pd.DataFrame, season: str) -> dict:
    """checks the ingest gate: exactly two team rows per game."""
    sizes = df.groupby("GAME_ID").size()
    bad = sizes[sizes != 2]
    if len(bad):
        log.warning(
            "%s: %d games without exactly two team-log rows (these games lose "
            "their schedule row downstream)", season, len(bad),
        )
    return {
        "rows": int(len(df)),
        "games": int(df["GAME_ID"].nunique()),
        "teams": int(df["TEAM_ID"].nunique()),
        "games_not_two_sided": int(len(bad)),
        "mean_team_minutes": round(float(df["MIN"].mean()), 2),
        "mean_team_points": round(float(df["PTS"].mean()), 2),
    }


def pull_season(season: str, data_dir: Path, force: bool = False) -> dict:
    """both sides of one season. returns a manifest entry; never raises."""
    tag = season_tag(season)
    player_path = data_dir / f"player_logs_{tag}.parquet"
    team_path = data_dir / f"team_logs_{tag}.parquet"

    if player_path.exists() and team_path.exists() and not force:
        p = pd.read_parquet(player_path)
        t = pd.read_parquet(team_path)
        log.info("%s: already on disk (%d player rows, %d team rows) - skipped",
                 season, len(p), len(t))
        return {"season": season, "status": "cached",
                "player": _check_player_frame(p, season),
                "team": _check_team_frame(t, season)}

    entry: dict = {"season": season, "status": "ok"}
    try:
        raw_players = _fetch_league_game_log(season, "P")
        _pace()
        raw_teams = _fetch_league_game_log(season, "T")
        _pace()
        players = _normalise(raw_players, PLAYER_KEEP, PLAYER_NUMERIC, season, "player logs")
        teams = _normalise(raw_teams, TEAM_KEEP, TEAM_NUMERIC, season, "team logs")
        if players.empty or teams.empty:
            raise ValueError(
                f"empty frame (players={len(players)}, teams={len(teams)})"
            )
        entry["player"] = _check_player_frame(players, season)
        entry["team"] = _check_team_frame(teams, season)
        players.to_parquet(player_path, index=False)
        teams.to_parquet(team_path, index=False)
        log.info(
            "%s: %6d player rows / %4d team rows / %4d games / %d players "
            "(%s .. %s)",
            season, entry["player"]["rows"], entry["team"]["rows"],
            entry["player"]["games"], entry["player"]["players"],
            entry["player"]["first_date"], entry["player"]["last_date"],
        )
    except Exception as exc:
        log.error("%s: SKIPPED - %s", season, exc)
        entry["status"] = "failed"
        entry["error"] = f"{type(exc).__name__}: {exc}"
    return entry


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seasons", nargs="*", default=None,
                        help="explicit season list; default 1996-97 .. 2025-26")
    parser.add_argument("--data-dir", default=str(DEEP_DATA_DIR))
    parser.add_argument("--force", action="store_true",
                        help="re-pull seasons already on disk")
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
    random.seed(17)

    data_dir = Path(args.data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    seasons = args.seasons or all_seasons()
    log.info("pulling %d seasons into %s", len(seasons), data_dir)

    manifest = [pull_season(s, data_dir, force=args.force) for s in seasons]

    ok = [e for e in manifest if e["status"] != "failed"]
    failed = [e for e in manifest if e["status"] == "failed"]
    total_player_rows = sum(e["player"]["rows"] for e in ok)
    total_team_rows = sum(e["team"]["rows"] for e in ok)

    manifest_path = data_dir / "manifest.csv"
    rows = []
    for entry in manifest:
        row = {"season": entry["season"], "status": entry["status"],
               "error": entry.get("error", "")}
        for side in ("player", "team"):
            for key, value in entry.get(side, {}).items():
                row[f"{side}_{key}"] = value
        rows.append(row)
    pd.DataFrame(rows).to_csv(manifest_path, index=False)

    log.info("done: %d seasons ok, %d failed; %d player rows, %d team rows",
             len(ok), len(failed), total_player_rows, total_team_rows)
    for e in failed:
        log.error("  failed: %s (%s)", e["season"], e.get("error"))
    log.info("manifest -> %s", manifest_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
