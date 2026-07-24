"""postgres data source.

reads the four tables the data-truth layer owns and returns the canonical
frames declared in :mod:`fnba_ml.data.schema`:

    player_game_logs, player_game_status, team_game_logs, nba_schedule

NOT EXERCISED BY THE TEST SUITE. there is no test database in this repo and no
integration test opens a connection (AGENTS.md section 6). the SQL below is
written against the migration-013 contract and is the piece to re-read first if
that schema moves. ``psycopg2`` and ``python-dotenv`` are imported lazily so
the module - and its SQL - can be imported and inspected without either
package installed.

connection string comes from ``DATABASE_URL``. queries are parameterised; no
identifier or value is ever interpolated into a SQL string.
"""

from __future__ import annotations

import logging
import os

import pandas as pd

from ..config import SEASON_TYPES, SEASONS
from .schema import (
    PLAYER_LOG_COLS,
    SCHEDULE_COLS,
    STATUS_COLS,
    TEAM_LOG_COLS,
    normalise_dates,
    normalise_ids,
    require_columns,
)

log = logging.getLogger(__name__)

PLAYER_LOGS_SQL = """
SELECT
    pgl.nba_player_id      AS "PLAYER_ID",
    pgl.nba_game_id        AS "GAME_ID",
    pgl.season             AS "SEASON",
    pgl.season_type        AS "SEASON_TYPE",
    pgl.game_date          AS "GAME_DATE",
    pgl.team_id            AS "TEAM_ID",
    pgl.team_abbr          AS "TEAM_ABBREVIATION",
    pgl.started            AS "STARTED",
    pgl.dnp_reason         AS "DNP_REASON",
    pgl.plus_minus         AS "PLUS_MINUS",
    pgl.minutes            AS "MIN",
    pgl.pts                AS "PTS",
    pgl.ast                AS "AST",
    pgl.fga                AS "FGA",
    pgl.reb                AS "REB",
    pgl.fg3m               AS "FG3M",
    pgl.ftm                AS "FTM",
    pgl.tov                AS "TOV",
    pgl.stl                AS "STL",
    pgl.blk                AS "BLK"
FROM player_game_logs pgl
WHERE pgl.season = ANY(%(seasons)s)
  AND pgl.season_type = ANY(%(season_types)s)
ORDER BY pgl.nba_player_id, pgl.game_date
"""

TEAM_LOGS_SQL = """
SELECT
    tgl.team_id            AS "TEAM_ID",
    tgl.nba_game_id        AS "GAME_ID",
    s.season               AS "SEASON",
    s.game_date            AS "GAME_DATE",
    tgl.pts                AS "PTS"
FROM team_game_logs tgl
JOIN nba_schedule s
  ON s.nba_game_id = tgl.nba_game_id
WHERE s.season = ANY(%(seasons)s)
  AND s.season_type = ANY(%(season_types)s)
ORDER BY tgl.team_id, s.game_date
"""

SCHEDULE_SQL = """
SELECT
    s.nba_game_id          AS "GAME_ID",
    s.season               AS "SEASON",
    s.season_type          AS "SEASON_TYPE",
    s.game_date            AS "GAME_DATE",
    s.scheduled_at         AS "SCHEDULED_AT",
    s.home_team_id         AS "HOME_TEAM_ID",
    s.away_team_id         AS "AWAY_TEAM_ID",
    s.game_status          AS "GAME_STATUS"
FROM nba_schedule s
WHERE s.season = ANY(%(seasons)s)
  AND s.season_type = ANY(%(season_types)s)
ORDER BY s.game_date, s.nba_game_id
"""

# the universe comes from here whenever rows exist: rostered players per
# team-game, with the official inactive flag. this is the table that removes
# the approximation bias documented in REPORT.md section 5.
STATUS_SQL = """
SELECT
    st.nba_player_id       AS "PLAYER_ID",
    st.nba_game_id         AS "GAME_ID",
    st.team_id             AS "TEAM_ID",
    st.rostered            AS "ROSTERED",
    st.listed_inactive     AS "LISTED_INACTIVE",
    st.started             AS "STARTED",
    st.played              AS "PLAYED",
    st.dnp_reason          AS "DNP_REASON",
    st.minutes             AS "MIN"
FROM player_game_status st
JOIN nba_schedule s
  ON s.nba_game_id = st.nba_game_id
WHERE s.season = ANY(%(seasons)s)
  AND s.season_type = ANY(%(season_types)s)
ORDER BY st.nba_player_id, s.game_date
"""

# schedule rows only ever supply future context, so a prediction run may read
# them past the cutoff; every other table is bounded by the cutoff date.
CUTOFF_CLAUSE = " AND {col} < %(cutoff)s"


def _load_database_url() -> str:
    try:
        from dotenv import load_dotenv  # noqa: PLC0415 - optional dependency

        load_dotenv()
    except ImportError:
        log.debug("python-dotenv not installed; reading DATABASE_URL from the environment")
    url = os.environ.get("DATABASE_URL")
    if not url:
        raise RuntimeError(
            "DATABASE_URL is not set - the postgres source cannot connect. "
            "use --source parquet for offline runs."
        )
    return url


class PostgresSource:
    """canonical frames straight out of the data-truth tables."""

    name = "postgres"

    def __init__(
        self,
        seasons: list[str] | None = None,
        season_types: list[str] | None = None,
        cutoff: pd.Timestamp | None = None,
        database_url: str | None = None,
    ) -> None:
        self.seasons = list(seasons or SEASONS)
        self.season_types = list(season_types or SEASON_TYPES)
        self.cutoff = cutoff
        self._database_url = database_url

    # ------------------------------------------------------------------
    def _params(self) -> dict[str, object]:
        params: dict[str, object] = {
            "seasons": self.seasons,
            "season_types": self.season_types,
        }
        if self.cutoff is not None:
            params["cutoff"] = pd.Timestamp(self.cutoff).to_pydatetime()
        return params

    def _sql(self, base: str, cutoff_col: str | None) -> str:
        if self.cutoff is None or cutoff_col is None:
            return base
        head, _, tail = base.partition("ORDER BY")
        return f"{head.rstrip()}{CUTOFF_CLAUSE.format(col=cutoff_col)}\nORDER BY{tail}"

    def _read(self, sql: str) -> pd.DataFrame:
        import psycopg2  # noqa: PLC0415 - optional at import time, required at call time

        with psycopg2.connect(self._database_url or _load_database_url()) as conn:
            return pd.read_sql_query(sql, conn, params=self._params())

    # ------------------------------------------------------------------
    def load_player_game_logs(self) -> pd.DataFrame:
        df = self._read(self._sql(PLAYER_LOGS_SQL, "pgl.game_date"))
        df["PLAYER_NAME"] = pd.NA
        for col in ("MIN", "PTS", "AST", "FGA", "REB", "FG3M", "FTM", "TOV", "STL", "BLK"):
            df[col] = pd.to_numeric(df[col], errors="coerce").astype(float)
        df = normalise_ids(normalise_dates(df))
        require_columns(df, PLAYER_LOG_COLS, "canonical player log")
        return df.reset_index(drop=True)

    def load_team_game_logs(self) -> pd.DataFrame:
        df = normalise_ids(normalise_dates(self._read(self._sql(TEAM_LOGS_SQL, "s.game_date"))))
        require_columns(df, TEAM_LOG_COLS, "canonical team log")
        return df.reset_index(drop=True)

    def load_schedule(self) -> pd.DataFrame:
        df = normalise_ids(normalise_dates(self._read(self._sql(SCHEDULE_SQL, None))))
        require_columns(df, SCHEDULE_COLS, "canonical schedule")
        return df.reset_index(drop=True)

    def load_player_game_status(self) -> pd.DataFrame | None:
        df = self._read(self._sql(STATUS_SQL, "s.game_date"))
        if df.empty:
            log.warning(
                "player_game_status is empty for seasons %s - falling back to the "
                "BIASED game-log-presence approximation",
                self.seasons,
            )
            return None
        for col in STATUS_COLS:
            if col not in df.columns:
                df[col] = pd.NA
        return normalise_ids(df[list(STATUS_COLS)]).reset_index(drop=True)
