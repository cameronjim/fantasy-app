"""data sources. both return the canonical frames declared in ``schema``."""

from __future__ import annotations

from pathlib import Path

from .parquet_source import ParquetSource
from .schema import (
    PLAYER_LOG_COLS,
    SCHEDULE_COLS,
    STAT_COLS,
    STATUS_COLS,
    TEAM_LOG_COLS,
    normalise_dates,
    normalise_ids,
    require_columns,
)

__all__ = [
    "ParquetSource",
    "PostgresSource",
    "PLAYER_LOG_COLS",
    "SCHEDULE_COLS",
    "STAT_COLS",
    "STATUS_COLS",
    "TEAM_LOG_COLS",
    "normalise_dates",
    "normalise_ids",
    "require_columns",
    "make_source",
]


def __getattr__(name: str):
    # postgres pulls in psycopg2 the moment it connects; keep it out of the
    # import path so parquet-only runs need no database driver installed.
    if name == "PostgresSource":
        from .postgres_source import PostgresSource

        return PostgresSource
    raise AttributeError(name)


def make_source(kind: str, data_dir: str | Path | None = None, **kwargs):
    """build a source by name, as the CLIs' ``--source`` flag spells it."""
    if kind == "parquet":
        if data_dir is None:
            raise ValueError("--source parquet requires --data-dir")
        return ParquetSource(data_dir, **kwargs)
    if kind == "postgres":
        from .postgres_source import PostgresSource

        return PostgresSource(**kwargs)
    raise ValueError(f"unknown source {kind!r}; expected 'parquet' or 'postgres'")
