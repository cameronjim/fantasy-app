"""canonical in-memory frame shapes, shared by both data sources.

a source's only job is to return these four frames. everything downstream
(universe, features, models) is source-agnostic and never learns whether the
rows came from postgres or from parquet.
"""

from __future__ import annotations

import pandas as pd

from ..config import ID_COLS

# stats carried from the game log onto the universe row. a scheduled row where
# the player did not appear gets 0.0 for all of them.
STAT_COLS: tuple[str, ...] = (
    "MIN", "PTS", "AST", "FGA", "REB", "FG3M", "FTM", "TOV", "STL", "BLK",
)

PLAYER_LOG_COLS: tuple[str, ...] = (
    "PLAYER_ID", "PLAYER_NAME", "GAME_ID", "SEASON", "SEASON_TYPE", "GAME_DATE",
    "TEAM_ID", "TEAM_ABBREVIATION", "STARTED", "DNP_REASON", "PLUS_MINUS",
) + STAT_COLS

TEAM_LOG_COLS: tuple[str, ...] = (
    "TEAM_ID", "GAME_ID", "SEASON", "GAME_DATE", "PTS",
)

SCHEDULE_COLS: tuple[str, ...] = (
    "GAME_ID", "SEASON", "SEASON_TYPE", "GAME_DATE", "SCHEDULED_AT",
    "HOME_TEAM_ID", "AWAY_TEAM_ID", "GAME_STATUS",
)

STATUS_COLS: tuple[str, ...] = (
    "PLAYER_ID", "GAME_ID", "TEAM_ID", "ROSTERED", "LISTED_INACTIVE",
    "STARTED", "PLAYED", "DNP_REASON", "MIN",
)

_SCHEDULE_ID_COLS = ("GAME_ID", "HOME_TEAM_ID", "AWAY_TEAM_ID")


def normalise_ids(df: pd.DataFrame) -> pd.DataFrame:
    """cast every identifier column present to str.

    postgres stores nba ids as TEXT, the spike parquet as int64. merging a str
    key against an int key silently produces zero matches, so both sources are
    forced onto str before anything joins.
    """
    out = df.copy()
    for col in set(ID_COLS) | set(_SCHEDULE_ID_COLS):
        if col in out.columns:
            out[col] = out[col].astype("string").astype(object)
    return out


def normalise_dates(df: pd.DataFrame, cols: tuple[str, ...] = ("GAME_DATE",)) -> pd.DataFrame:
    """coerce date columns to midnight-normalised datetime64."""
    out = df.copy()
    for col in cols:
        if col in out.columns:
            out[col] = pd.to_datetime(out[col]).dt.normalize()
    return out


def require_columns(df: pd.DataFrame, cols: tuple[str, ...], what: str) -> None:
    missing = [c for c in cols if c not in df.columns]
    if missing:
        raise ValueError(f"{what} frame is missing required columns: {missing}")
