"""
NBA Stats Scraper - uses nba_api package for reliable data fetching.

Usage:
    cd scraper/
    pip install -r requirements.txt
    python run_scraper.py

One-time historical backfill (run locally from a residential IP — stats.nba.com
is Akamai-blocked from AWS/GitHub Actions, and it rate-limits hard, so this is
deliberately NOT part of the 6-hour cron):

    python run_scraper.py --backfill-history
    python run_scraper.py --backfill-history --from 1979-80 --to 2025-26

The backfill is resumable: seasons already in the database are skipped, so a
killed run can simply be started again.

NBA 2K ratings sync (also opt-in, also NOT part of the 6-hour cron — the classic
and all-time rosters are large and only change when 2K adds a card):

    python run_scraper.py --sync-2k
    python run_scraper.py --sync-2k --team-types curr,class,allt

Defaults to current players only. Data comes from the unauthenticated public
nba2kapi.com endpoint (which mirrors 2kratings.com); no key or signup is needed.

Data truth layer (schedule, per-game logs, per-scheduled-player-game status).
The incremental half runs as part of the normal un-flagged scrape. The one-time
historical half is opt-in and, like --backfill-history, must be run locally from
a residential IP:

    python run_scraper.py --backfill-game-logs
    python run_scraper.py --backfill-game-logs --from 2022-23 --to 2025-26
    python run_scraper.py --validate-game-logs

Every write path honours --dry-run, which reports what it would have written and
executes nothing. Migration 013 must be applied first (see check_migrations.py).
"""

import argparse
import json
import logging
import os
import re
import sys
import time
import unicodedata
from collections.abc import Mapping, Sequence
from datetime import date, datetime, timedelta
from typing import Callable, TypeVar
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import psycopg2
import requests
from bs4 import BeautifulSoup
from psycopg2.extras import execute_values
from dotenv import load_dotenv
from nba_api.stats.endpoints import (
    leaguedashplayerstats,
    leaguedashteamstats,
    leaguegamelog,
    playergamelogs,
)

env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
load_dotenv(dotenv_path=env_path)

logger = logging.getLogger(__name__)

TEAM_META = {
    "ATL": {"conference": "East", "division": "Southeast", "full_name": "Atlanta Hawks"},
    "BOS": {"conference": "East", "division": "Atlantic", "full_name": "Boston Celtics"},
    "BKN": {"conference": "East", "division": "Atlantic", "full_name": "Brooklyn Nets"},
    "CHA": {"conference": "East", "division": "Southeast", "full_name": "Charlotte Hornets"},
    "CHI": {"conference": "East", "division": "Central", "full_name": "Chicago Bulls"},
    "CLE": {"conference": "East", "division": "Central", "full_name": "Cleveland Cavaliers"},
    "DAL": {"conference": "West", "division": "Southwest", "full_name": "Dallas Mavericks"},
    "DEN": {"conference": "West", "division": "Northwest", "full_name": "Denver Nuggets"},
    "DET": {"conference": "East", "division": "Central", "full_name": "Detroit Pistons"},
    "GSW": {"conference": "West", "division": "Pacific", "full_name": "Golden State Warriors"},
    "HOU": {"conference": "West", "division": "Southwest", "full_name": "Houston Rockets"},
    "IND": {"conference": "East", "division": "Central", "full_name": "Indiana Pacers"},
    "LAC": {"conference": "West", "division": "Pacific", "full_name": "Los Angeles Clippers"},
    "LAL": {"conference": "West", "division": "Pacific", "full_name": "Los Angeles Lakers"},
    "MEM": {"conference": "West", "division": "Southwest", "full_name": "Memphis Grizzlies"},
    "MIA": {"conference": "East", "division": "Southeast", "full_name": "Miami Heat"},
    "MIL": {"conference": "East", "division": "Central", "full_name": "Milwaukee Bucks"},
    "MIN": {"conference": "West", "division": "Northwest", "full_name": "Minnesota Timberwolves"},
    "NOP": {"conference": "West", "division": "Southwest", "full_name": "New Orleans Pelicans"},
    "NYK": {"conference": "East", "division": "Atlantic", "full_name": "New York Knicks"},
    "OKC": {"conference": "West", "division": "Northwest", "full_name": "Oklahoma City Thunder"},
    "ORL": {"conference": "East", "division": "Southeast", "full_name": "Orlando Magic"},
    "PHI": {"conference": "East", "division": "Atlantic", "full_name": "Philadelphia 76ers"},
    "PHX": {"conference": "West", "division": "Pacific", "full_name": "Phoenix Suns"},
    "POR": {"conference": "West", "division": "Northwest", "full_name": "Portland Trail Blazers"},
    "SAC": {"conference": "West", "division": "Pacific", "full_name": "Sacramento Kings"},
    "SAS": {"conference": "West", "division": "Southwest", "full_name": "San Antonio Spurs"},
    "TOR": {"conference": "East", "division": "Atlantic", "full_name": "Toronto Raptors"},
    "UTA": {"conference": "West", "division": "Northwest", "full_name": "Utah Jazz"},
    "WAS": {"conference": "East", "division": "Southeast", "full_name": "Washington Wizards"},
}

# leaguedashteamstats (Base measure type) returns TEAM_ID and TEAM_NAME but NOT
# TEAM_ABBREVIATION, so we can't read the abbreviation off the response. NBA team
# IDs are permanent, so map from those. Falls back to a name lookup below.
TEAM_ID_TO_ABBR = {
    "1610612737": "ATL", "1610612738": "BOS", "1610612751": "BKN",
    "1610612766": "CHA", "1610612741": "CHI", "1610612739": "CLE",
    "1610612742": "DAL", "1610612743": "DEN", "1610612765": "DET",
    "1610612744": "GSW", "1610612745": "HOU", "1610612754": "IND",
    "1610612746": "LAC", "1610612747": "LAL", "1610612763": "MEM",
    "1610612748": "MIA", "1610612749": "MIL", "1610612750": "MIN",
    "1610612740": "NOP", "1610612752": "NYK", "1610612760": "OKC",
    "1610612753": "ORL", "1610612755": "PHI", "1610612756": "PHX",
    "1610612757": "POR", "1610612758": "SAC", "1610612759": "SAS",
    "1610612761": "TOR", "1610612762": "UTA", "1610612764": "WAS",
}

# Truth-layer game logs report the opponent only as an abbreviation (inside
# MATCHUP), so this is how an opponent team id is recovered.
ABBR_TO_TEAM_ID = {abbr: team_id for team_id, abbr in TEAM_ID_TO_ABBR.items()}

# Reverse of TEAM_META's full_name, used when a team id is unexpectedly missing
# (e.g. NBA changes an id, or a future expansion team appears).
NAME_TO_ABBR = {
    meta["full_name"].lower(): abbr for abbr, meta in TEAM_META.items()
}
# NBA's data is inconsistent about the Clippers' name across endpoints.
NAME_TO_ABBR["la clippers"] = "LAC"


def _resolve_team_abbr(team_id: str, team_name: str) -> str:
    """Best-effort abbreviation for a team row.

    leaguedashteamstats' Base measure type omits TEAM_ABBREVIATION, so resolve
    from the permanent team id first, then fall back to matching the full name.
    Returns "" only if both lookups miss, which would mean genuinely unknown data.
    """
    abbr = TEAM_ID_TO_ABBR.get(str(team_id), "")
    if abbr:
        return abbr
    return NAME_TO_ABBR.get((team_name or "").strip().lower(), "")

SEASON = "2025-26"

# Historical backfill defaults. 1979-80 is the first season with a three-point
# line, which is as far back as the per-game stat set is meaningful — but how far
# back leaguedashplayerstats actually reports is NOT assumed anywhere: the
# backfill records whatever each season returns and treats an empty result as a
# normal "no data" outcome.
BACKFILL_DEFAULT_FROM_SEASON = "1979-80"
# stats.nba.com resets connections after a handful of rapid requests from a
# residential IP, so the backfill is slow on purpose.
BACKFILL_REQUEST_DELAY_SECONDS = 5.0
BACKFILL_MAX_ATTEMPTS = 4
# Advanced measure type (off/def/net rating) has no data before this season, so
# don't spend rate-limit budget asking for it.
ADVANCED_RATINGS_FIRST_SEASON_START_YEAR = 1996

# nba_api documents BoxScoreSummaryV2 as having no inactive-list data for games
# on or after this date. Past it, an empty V2 answer means "no data", NOT
# "nobody was inactive" — conflating the two would silently recreate the exact
# availability bias the truth layer exists to remove.
V2_INACTIVE_UNRELIABLE_FROM = date(2025, 4, 10)


def v2_inactive_is_unreliable(game_date: date | None) -> bool:
    """Whether a V2 inactive list for a game on this date can be trusted.

    An unknown date is treated as unreliable: the cost of wrongly distrusting
    a good answer is one 'suspect' tag, the cost of wrongly trusting a bad one
    is a biased training label that looks identical to a real one.
    """
    return game_date is None or game_date >= V2_INACTIVE_UNRELIABLE_FROM

# NBA 2K ratings. nba2kapi.com is a free third-party mirror of 2kratings.com;
# only the unauthenticated public endpoint is used, so there is no key or signup.
NBA_2K_API_URL = "https://api.nba2kapi.com/api/public/players"
NBA_2K_PAGE_LIMIT = 100
# the endpoint allows 60 requests/minute per IP, so stay just under one per second.
NBA_2K_REQUEST_DELAY_SECONDS = 1.1
NBA_2K_RETRY_DELAY_SECONDS = 2.0
NBA_2K_MAX_ATTEMPTS = 4
# curr = current NBA rosters, class = classic teams, allt = all-time teams.
NBA_2K_TEAM_TYPES = ("curr", "class", "allt")
# only current players by default: class and allt are larger and essentially
# static, so pulling them is an explicit opt-in.
NBA_2K_DEFAULT_TEAM_TYPES = "curr"

# ---- data truth layer ----

SEASON_TYPE_REGULAR = "Regular Season"

# Re-fetch this many days behind the stored watermark on every incremental run.
# stats.nba.com revises box scores after the fact — scorer corrections usually
# land the following morning — so the newest rows are the least final ones.
GAME_LOG_CORRECTION_WINDOW_DAYS = 3

# How far back the incremental status pass looks for completed games that still
# have no player_game_status rows. Bounded so a cron run can never quietly turn
# into a full-season backfill; that is what --backfill-game-logs is for.
GAME_STATUS_RECENT_WINDOW_DAYS = 10
# Hard ceiling on per-game inactive-list calls in one cron run. Each game is a
# separate request to stats.nba.com, and the cron fires every 6 hours.
GAME_STATUS_MAX_GAMES_PER_RUN = 40

# The truth layer only goes back as far as the availability model needs. Rule
# and roster-construction changes make older seasons less transferable, and each
# season costs ~1,230 per-game requests to fetch inactive lists for.
BACKFILL_GAME_LOGS_DEFAULT_FROM_SEASON = "2022-23"

# NBA encodes the season type in the first three characters of a game id, which
# is the only place it appears on some endpoints.
GAME_ID_PREFIX_TO_SEASON_TYPE = {
    "001": "Pre Season",
    "002": "Regular Season",
    "003": "All Star",
    "004": "Playoffs",
    "005": "PlayIn",
}
SEASON_TYPE_UNKNOWN = "Unknown"

# Box-score points are integers on both sides, so player-sum vs team-total
# should agree exactly. The only legitimate slack is a scorer correction that
# has landed in one table but not yet the other.
VALIDATION_POINTS_TOLERANCE = 1
# validation prints offenders rather than just counting them, but not all of them.
VALIDATION_MAX_EXAMPLES = 15

TRUTH_LAYER_TABLES = (
    "nba_schedule",
    "player_game_logs",
    "team_game_logs",
    "player_game_status",
    "player_team_stints",
    "player_injury_reports",
    "ingestion_runs",
)

_SEASON_PATTERN = re.compile(r"^(\d{4})-\d{2}$")
_MATCHUP_PATTERN = re.compile(
    r"^\s*(?P<team>[A-Za-z]{2,4})\s+(?P<sep>vs\.?|@)\s+(?P<opp>[A-Za-z]{2,4})\s*$",
    re.IGNORECASE,
)
# v3 box scores report minutes as an ISO-8601 duration, e.g. "PT34M12.00S".
_MINUTES_ISO_PATTERN = re.compile(
    r"^PT(?:(?P<min>\d+(?:\.\d+)?)M)?(?:(?P<sec>\d+(?:\.\d+)?)S)?$", re.IGNORECASE
)

# maps NBA broad positions to specific positions for multi-position support
_BROAD_TO_SPECIFIC: dict[str, list[str]] = {
    "G": ["PG", "SG"],
    "G-F": ["SG", "SF"],
    "F-G": ["SG", "SF"],
    "F": ["SF", "PF"],
    "F-C": ["PF", "C"],
    "C-F": ["PF", "C"],
    "C": ["C"],
}


# Which database a run targets. Prod is the default so an un-flagged run (the
# GitHub Actions cron) keeps its existing behaviour untouched.
TARGET_PROD = "prod"
TARGET_DEV = "dev"

# env var per target. dev is optional: only people who test against the dev
# Neon branch need it set.
TARGET_ENV_VARS = {
    TARGET_PROD: "DATABASE_URL",
    TARGET_DEV: "DATABASE_URL_DEV",
}


def resolve_database_url(target: str) -> str:
    """Connection string for `target`, or exit with an actionable message.

    Kept separate from get_db so the resolution rules are testable without a
    live database.
    """
    var = TARGET_ENV_VARS[target]
    url = os.getenv(var)
    if url:
        return url
    if target == TARGET_DEV:
        logger.error(
            "%s is not set. Add it to .env with your Neon dev branch connection "
            "string (Neon console -> Branches -> dev -> Connection string), or "
            "drop --dev to run against prod.",
            var,
        )
    else:
        logger.error("%s is not set in .env", var)
    sys.exit(1)


def get_db(target: str = TARGET_PROD) -> psycopg2.extensions.connection:
    url = resolve_database_url(target)
    conn = psycopg2.connect(url)
    conn.autocommit = True
    # Log which database we actually landed on. There is more than one Neon
    # branch in play (prod vs dev), and a shell DATABASE_URL silently overrides
    # .env, so "table does not exist" is usually "right migration, wrong
    # database" rather than a missing migration. Host + db name only, never
    # credentials.
    try:
        parsed = urlparse(url)
        logger.info(
            "target=%s -> connected to %s/%s",
            target.upper(),
            parsed.hostname,
            (parsed.path or "").lstrip("/").split("?")[0] or "?",
        )
    except Exception:  # noqa: BLE001 - diagnostics must never break the run
        pass
    return conn


def _pct(val: object) -> float:
    """convert 0.456 -> 45.6."""
    if val is None:
        return 0.0
    return round(float(val) * 100, 1)


def _safe_float(val: object) -> float:
    if val is None:
        return 0.0
    return round(float(val), 1)


def _is_missing(val: object) -> bool:
    """True for None, non-numeric junk, and pandas NaN.

    NaN matters: psycopg2 would happily store it in a NUMERIC column, and a
    NUMERIC NaN then poisons every AVG/ORDER BY over that column.
    """
    if val is None:
        return True
    try:
        num = float(val)
    except (TypeError, ValueError):
        return True
    return num != num


def _opt_float(val: object) -> float | None:
    """Nullable variant of _safe_float — historical seasons have real gaps."""
    return None if _is_missing(val) else _safe_float(val)


def _opt_pct(val: object) -> float | None:
    """Nullable variant of _pct."""
    return None if _is_missing(val) else _pct(val)


def _opt_int(val: object) -> int | None:
    return None if _is_missing(val) else int(float(val))


def _normalize_name(name: str) -> str:
    """strip accents, suffixes, and punctuation for fuzzy name matching."""
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_name = "".join(c for c in nfkd if not unicodedata.combining(c))
    ascii_name = ascii_name.lower().strip()
    # remove name suffixes so Jr./Sr./III don't break matching
    ascii_name = re.sub(r"\b(jr\.?|sr\.?|iii|ii|iv)\b", "", ascii_name)
    ascii_name = ascii_name.replace(".", "").replace("'", "").replace("-", " ")
    ascii_name = re.sub(r"\s+", " ", ascii_name).strip()
    return ascii_name


def _fetch_cbs_positions() -> dict[str, str]:
    """scrape specific positions (PG, SG, SF, PF, C) from CBS Sports stats pages."""
    position_map: dict[str, str] = {}
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        )
    }
    for page in range(1, 15):  # up to 14 pages to be safe
        try:
            resp = requests.get(
                "https://www.cbssports.com/nba/stats/player/scoring/nba/regular/"
                f"all-pos/all/?page={page}",
                headers=headers,
                timeout=15,
            )
            resp.raise_for_status()
        except Exception:
            break

        soup = BeautifulSoup(resp.text, "html.parser")
        rows = soup.select("tr.TableBase-bodyTr")
        if not rows:
            break

        for row in rows:
            cells = row.find_all("td")
            if not cells:
                continue
            cell0 = cells[0]
            name_el = cell0.select_one("span.CellPlayerName--long a")
            pos_el = cell0.select_one("span.CellPlayerName-position")
            if name_el and pos_el:
                name = name_el.get_text(strip=True)
                pos = pos_el.get_text(strip=True)
                if name and pos in ("PG", "SG", "SF", "PF", "C"):
                    position_map[_normalize_name(name)] = pos

        time.sleep(0.5)  # rate limit

    return position_map


def _fetch_nba_positions() -> dict[str, str]:
    """fetch raw broad positions (G, G-F, F, C, etc.) from NBA playerindex as fallback."""
    from nba_api.stats.endpoints import playerindex

    position_map: dict[str, str] = {}
    try:
        pi = playerindex.PlayerIndex(season=SEASON, league_id="00", timeout=60)
        df = pi.get_data_frames()[0]
        for _, row in df.iterrows():
            pid = str(row.get("PERSON_ID", ""))
            pos = str(row.get("POSITION", "")).strip()
            if pid and pos:
                position_map[pid] = pos
    except Exception as e:
        logger.warning("could not fetch NBA playerindex positions: %s", e)
    return position_map


def resolve_positions(cbs_pos: str, nba_broad_pos: str) -> str:
    """combine CBS specific position with NBA broad position for multi-position support."""
    specific_from_broad = _BROAD_TO_SPECIFIC.get(nba_broad_pos, [])

    if cbs_pos:
        positions = [cbs_pos]
        for p in specific_from_broad:
            if p != cbs_pos:
                positions.append(p)
        return ",".join(positions)

    if specific_from_broad:
        return ",".join(specific_from_broad)

    return ""


def scrape_players(
    conn: psycopg2.extensions.connection, dry_run: bool = False
) -> None:
    logger.info("fetching player stats...")

    logger.info("fetching player positions from CBS Sports...")
    cbs_positions = _fetch_cbs_positions()
    logger.info("got positions for %d players from CBS Sports", len(cbs_positions))

    logger.info("fetching fallback positions from NBA playerindex...")
    nba_positions = _fetch_nba_positions()
    logger.info("got fallback positions for %d players from NBA", len(nba_positions))

    time.sleep(2)  # rate limit

    try:
        stats = leaguedashplayerstats.LeagueDashPlayerStats(
            season=SEASON,
            per_mode_detailed="PerGame",
            season_type_all_star="Regular Season",
            timeout=60,
        )
        df = stats.get_data_frames()[0]
        logger.info("got %d players from NBA API", len(df))
    except Exception as e:
        logger.error("error fetching player stats: %s", e)
        return

    cur = maybe_write_cursor(conn.cursor(), dry_run)
    count = 0
    for _, row in df.iterrows():
        player_id = str(row["PLAYER_ID"])
        cur.execute(
            """
            INSERT INTO players (nba_id, name, team, position,
                                 points_per_game, rebounds_per_game, assists_per_game, steals_per_game, blocks_per_game,
                                 field_goal_percentage, three_point_percentage, free_throw_percentage, three_pointers_made,
                                 turnovers_per_game, minutes_per_game, games_played,
                                 headshot_url, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (nba_id) DO UPDATE SET
                name = EXCLUDED.name, team = EXCLUDED.team, position = EXCLUDED.position,
                points_per_game = EXCLUDED.points_per_game, rebounds_per_game = EXCLUDED.rebounds_per_game,
                assists_per_game = EXCLUDED.assists_per_game, steals_per_game = EXCLUDED.steals_per_game,
                blocks_per_game = EXCLUDED.blocks_per_game, field_goal_percentage = EXCLUDED.field_goal_percentage,
                three_point_percentage = EXCLUDED.three_point_percentage, free_throw_percentage = EXCLUDED.free_throw_percentage,
                three_pointers_made = EXCLUDED.three_pointers_made, turnovers_per_game = EXCLUDED.turnovers_per_game,
                minutes_per_game = EXCLUDED.minutes_per_game, games_played = EXCLUDED.games_played,
                headshot_url = EXCLUDED.headshot_url, updated_at = NOW()
            """,
            (
                player_id,
                row["PLAYER_NAME"],
                row.get("TEAM_ABBREVIATION", ""),
                resolve_positions(
                    cbs_positions.get(_normalize_name(row["PLAYER_NAME"]), ""),
                    nba_positions.get(player_id, ""),
                ),
                _safe_float(row.get("PTS")),
                _safe_float(row.get("REB")),
                _safe_float(row.get("AST")),
                _safe_float(row.get("STL")),
                _safe_float(row.get("BLK")),
                _pct(row.get("FG_PCT")),
                _pct(row.get("FG3_PCT")),
                _pct(row.get("FT_PCT")),
                _safe_float(row.get("FG3M")),
                _safe_float(row.get("TOV")),
                _safe_float(row.get("MIN")),
                int(row.get("GP", 0)),
                f"https://cdn.nba.com/headshots/nba/latest/1040x760/{player_id}.png",
            ),
        )
        count += 1

    cur.execute(
        "DELETE FROM my_roster WHERE player_id IN "
        "(SELECT id FROM players WHERE nba_id IS NULL)"
    )
    deleted_roster = cur.rowcount
    cur.execute("DELETE FROM players WHERE nba_id IS NULL")
    deleted = cur.rowcount
    if deleted > 0:
        logger.info(
            "cleaned up %d old seed players (%d roster entries)", deleted, deleted_roster
        )

    cur.close()
    logger.info("upserted %d players", count)


def scrape_teams(
    conn: psycopg2.extensions.connection, dry_run: bool = False
) -> None:
    logger.info("fetching team stats...")
    time.sleep(2)
    try:
        stats = leaguedashteamstats.LeagueDashTeamStats(
            season=SEASON,
            per_mode_detailed="PerGame",
            season_type_all_star="Regular Season",
            timeout=60,
        )
        df = stats.get_data_frames()[0]
        logger.info("got %d teams from NBA API", len(df))
    except Exception as e:
        logger.error("error fetching team stats: %s", e)
        return

    time.sleep(2)
    adv_ratings: dict[str, dict[str, float]] = {}
    try:
        adv_stats = leaguedashteamstats.LeagueDashTeamStats(
            season=SEASON,
            per_mode_detailed="PerGame",
            measure_type_detailed_defense="Advanced",
            season_type_all_star="Regular Season",
            timeout=60,
        )
        adv_df = adv_stats.get_data_frames()[0]
        for _, row in adv_df.iterrows():
            tid = str(row["TEAM_ID"])
            adv_ratings[tid] = {
                "defensive_rating": _safe_float(row.get("DEF_RATING")),
                "offensive_rating": _safe_float(row.get("OFF_RATING")),
                "net_rating": _safe_float(row.get("NET_RATING")),
            }
        logger.info("got advanced ratings for %d teams", len(adv_ratings))
    except Exception as e:
        logger.warning("could not fetch advanced team stats: %s", e)

    cur = maybe_write_cursor(conn.cursor(), dry_run)
    count = 0
    for _, row in df.iterrows():
        team_id = str(row["TEAM_ID"])
        team_name = row.get("TEAM_NAME", "")
        # Don't trust TEAM_ABBREVIATION — the Base measure type doesn't include it.
        abbr = row.get("TEAM_ABBREVIATION") or _resolve_team_abbr(team_id, team_name)
        meta = TEAM_META.get(abbr, {})
        ratings = adv_ratings.get(team_id, {})

        if not abbr:
            logger.warning("could not resolve abbreviation for team %s (%s)", team_name, team_id)

        cur.execute(
            """
            INSERT INTO teams (nba_id, name, abbreviation, conference, division,
                               wins, losses,
                               points_per_game, rebounds_per_game, assists_per_game, steals_per_game, blocks_per_game,
                               field_goal_percentage, three_point_percentage, free_throw_percentage, turnovers_per_game,
                               defensive_rating, offensive_rating, net_rating,
                               logo_url, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (nba_id) DO UPDATE SET
                name = EXCLUDED.name, abbreviation = EXCLUDED.abbreviation,
                conference = EXCLUDED.conference, division = EXCLUDED.division,
                wins = EXCLUDED.wins, losses = EXCLUDED.losses,
                points_per_game = EXCLUDED.points_per_game, rebounds_per_game = EXCLUDED.rebounds_per_game,
                assists_per_game = EXCLUDED.assists_per_game, steals_per_game = EXCLUDED.steals_per_game,
                blocks_per_game = EXCLUDED.blocks_per_game, field_goal_percentage = EXCLUDED.field_goal_percentage,
                three_point_percentage = EXCLUDED.three_point_percentage, free_throw_percentage = EXCLUDED.free_throw_percentage,
                turnovers_per_game = EXCLUDED.turnovers_per_game, defensive_rating = EXCLUDED.defensive_rating,
                offensive_rating = EXCLUDED.offensive_rating, net_rating = EXCLUDED.net_rating,
                logo_url = EXCLUDED.logo_url, updated_at = NOW()
            """,
            (
                team_id,
                row.get("TEAM_NAME", meta.get("full_name", "")),
                abbr,
                meta.get("conference", ""),
                meta.get("division", ""),
                int(row.get("W", 0)),
                int(row.get("L", 0)),
                _safe_float(row.get("PTS")),
                _safe_float(row.get("REB")),
                _safe_float(row.get("AST")),
                _safe_float(row.get("STL")),
                _safe_float(row.get("BLK")),
                _pct(row.get("FG_PCT")),
                _pct(row.get("FG3_PCT")),
                _pct(row.get("FT_PCT")),
                _safe_float(row.get("TOV")),
                ratings.get("defensive_rating", 0.0),
                ratings.get("offensive_rating", 0.0),
                ratings.get("net_rating", 0.0),
                f"https://cdn.nba.com/logos/nba/{team_id}/global/L/logo.svg",
            ),
        )
        count += 1

    cur.execute("DELETE FROM teams WHERE nba_id IS NULL")
    deleted = cur.rowcount
    if deleted > 0:
        logger.info("cleaned up %d old seed teams", deleted)

    cur.close()
    logger.info("upserted %d teams", count)


def _fetch_espn_scoreboard(date_str: str) -> list[dict]:
    """Fetch games for one date from ESPN public API.

    date_str must be YYYYMMDD format (e.g. "20260522").
    ESPN stores event dates as UTC midnight, so we convert to Eastern Time
    to get the canonical game date — same logic as the backend /games/live endpoint.
    """
    url = (
        "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
        f"?dates={date_str}"
    )
    try:
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        logger.error("ESPN fetch failed for %s: %s", date_str, e)
        return []

    events = data.get("events", [])
    games = []

    for event in events:
        game_id = str(event.get("id", ""))
        status_obj = event.get("status", {})
        status_type = status_obj.get("type", {})
        status_name = status_type.get("name", "")

        if status_name == "STATUS_FINAL":
            status = "Final"
        elif status_name == "STATUS_IN_PROGRESS":
            status = "In Progress"
        else:
            status = status_type.get("detail", "Scheduled").strip() or "Scheduled"

        # ESPN date is UTC midnight — convert to ET for the real game date.
        # e.g. "2026-05-22T00:00Z" = 8 PM ET May 21 → game_date = "2026-05-21"
        event_date_str = event.get("date", "")
        try:
            date_utc = datetime.fromisoformat(event_date_str.replace("Z", "+00:00"))
            game_date = date_utc.astimezone(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
        except (ValueError, TypeError):
            game_date = datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")

        competition = (event.get("competitions") or [{}])[0]
        competitors = competition.get("competitors", [])
        home = next((c for c in competitors if c.get("homeAway") == "home"), {})
        away = next((c for c in competitors if c.get("homeAway") == "away"), {})

        is_pre_game = status_name not in ("STATUS_FINAL", "STATUS_IN_PROGRESS")
        try:
            home_score = int(home.get("score", 0)) if not is_pre_game else None
        except (TypeError, ValueError):
            home_score = None
        try:
            away_score = int(away.get("score", 0)) if not is_pre_game else None
        except (TypeError, ValueError):
            away_score = None

        arena = (competition.get("venue") or {}).get("fullName", "")

        games.append({
            "nba_game_id": game_id,
            "home_team": (home.get("team") or {}).get("displayName", "Unknown"),
            "away_team": (away.get("team") or {}).get("displayName", "Unknown"),
            "game_date": game_date,
            "home_score": home_score,
            "away_score": away_score,
            "status": status,
            "arena": arena,
        })

    return games


def scrape_scoreboard(
    conn: psycopg2.extensions.connection, dry_run: bool = False
) -> None:
    """Fetch games from ESPN for a rolling 10-day window (2 days back, 7 days ahead)."""
    logger.info("fetching games from ESPN (2 days back → 7 days ahead)...")

    et = ZoneInfo("America/New_York")
    today = datetime.now(et)

    cur = maybe_write_cursor(conn.cursor(), dry_run)
    total = 0

    for offset in range(-2, 8):  # -2 = day before yesterday, 7 = 7 days from now
        day = today + timedelta(days=offset)
        date_str = day.strftime("%Y%m%d")  # ESPN expects YYYYMMDD
        label = day.strftime("%Y-%m-%d")

        games = _fetch_espn_scoreboard(date_str)
        for g in games:
            cur.execute(
                """
                INSERT INTO games (nba_game_id, home_team, away_team, game_date,
                                   home_score, away_score, status, arena, updated_at)
                VALUES (%(nba_game_id)s, %(home_team)s, %(away_team)s, %(game_date)s,
                        %(home_score)s, %(away_score)s, %(status)s, %(arena)s, NOW())
                ON CONFLICT (nba_game_id) DO UPDATE SET
                    home_team  = EXCLUDED.home_team,
                    away_team  = EXCLUDED.away_team,
                    game_date  = EXCLUDED.game_date,
                    home_score = EXCLUDED.home_score,
                    away_score = EXCLUDED.away_score,
                    status     = EXCLUDED.status,
                    arena      = EXCLUDED.arena,
                    updated_at = NOW()
                """,
                g,
            )
        if games:
            logger.info("%s: %d games", label, len(games))
        total += len(games)

    cur.execute("DELETE FROM games WHERE nba_game_id IS NULL")
    deleted = cur.rowcount
    if deleted > 0:
        logger.info("cleaned up %d old seed games", deleted)

    cur.close()
    conn.commit()
    logger.info("total games upserted: %d", total)


def scrape_injuries(
    conn: psycopg2.extensions.connection, dry_run: bool = False
) -> None:
    logger.info("fetching injury report from CBS Sports...")
    time.sleep(1)
    try:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            )
        }
        resp = requests.get(
            "https://www.cbssports.com/nba/injuries/", headers=headers, timeout=30
        )
        resp.raise_for_status()
    except Exception as e:
        logger.error("error fetching injuries: %s", e)
        return

    soup = BeautifulSoup(resp.text, "html.parser")

    cur = maybe_write_cursor(conn.cursor(), dry_run)
    cur.execute("UPDATE players SET injury_status = NULL, injury_detail = NULL")

    team_name_to_abbr = {
        "Atlanta Hawks": "ATL", "Boston Celtics": "BOS", "Brooklyn Nets": "BKN",
        "Charlotte Hornets": "CHA", "Chicago Bulls": "CHI",
        "Cleveland Cavaliers": "CLE", "Dallas Mavericks": "DAL",
        "Denver Nuggets": "DEN", "Detroit Pistons": "DET",
        "Golden State Warriors": "GSW", "Houston Rockets": "HOU",
        "Indiana Pacers": "IND", "Los Angeles Clippers": "LAC",
        "LA Clippers": "LAC", "Los Angeles Lakers": "LAL", "LA Lakers": "LAL",
        "Memphis Grizzlies": "MEM", "Miami Heat": "MIA", "Milwaukee Bucks": "MIL",
        "Minnesota Timberwolves": "MIN", "New Orleans Pelicans": "NOP",
        "New York Knicks": "NYK", "Oklahoma City Thunder": "OKC",
        "Orlando Magic": "ORL", "Philadelphia 76ers": "PHI",
        "Phoenix Suns": "PHX", "Portland Trail Blazers": "POR",
        "Sacramento Kings": "SAC", "San Antonio Spurs": "SAS",
        "Toronto Raptors": "TOR", "Utah Jazz": "UTA",
        "Washington Wizards": "WAS",
    }

    count = 0
    logged = 0
    tables = soup.select("div.TableBase")
    for table in tables:
        team_el = table.select_one("span.TeamName a")
        team_name = team_el.get_text(strip=True) if team_el else ""
        team_abbr = team_name_to_abbr.get(team_name, team_name)

        rows = table.select("tr.TableBase-bodyTr")
        for row in rows:
            cells = row.select("td")
            if len(cells) < 4:
                continue

            name_el = cells[0].select_one("span.CellPlayerName--long a") or cells[0].select_one("a")
            player_name = name_el.get_text(strip=True) if name_el else ""
            injury_detail = cells[2].get_text(strip=True) if len(cells) > 2 else ""
            injury_status = cells[3].get_text(strip=True) if len(cells) > 3 else "Day-To-Day"

            if not player_name:
                continue

            status = injury_status or "Day-To-Day"
            detail = injury_detail or "Unknown"
            # RETURNING nba_id so the append-only history below can key on the
            # NBA player id. CBS publishes names only, so the players table is
            # the only place that mapping exists.
            cur.execute(
                """
                UPDATE players SET injury_status = %s, injury_detail = %s,
                    updated_at = NOW()
                WHERE LOWER(name) = LOWER(%s)
                RETURNING nba_id
                """,
                (status, detail, player_name),
            )
            matched = cur.fetchall()
            if matched:
                count += len(matched)

            # append-only history, one row per scrape per matched player. Never
            # an upsert: "what did we know at 6am" is the question the model
            # asks, and overwriting the row destroys the answer.
            for (nba_id,) in matched:
                if not nba_id:
                    continue
                logged += 1
                cur.execute(
                    """
                    INSERT INTO player_injury_reports (nba_player_id, captured_at,
                                                       status_raw, status_normalized,
                                                       reason, source)
                    VALUES (%s, NOW(), %s, %s, %s, 'cbssports')
                    """,
                    (str(nba_id), status, normalize_injury_status(status), detail),
                )

    cur.close()
    logger.info(
        "updated %d player injuries%s, logged %d report row(s)",
        count,
        " (dry run: no rows written)" if dry_run else "",
        logged,
    )


def season_start_year(season: str) -> int:
    """Parse "1996-97" -> 1996. Raises ValueError on anything else."""
    match = _SEASON_PATTERN.match(season.strip())
    if not match:
        raise ValueError(f"season must look like 1996-97, got {season!r}")
    return int(match.group(1))


def season_label(start_year: int) -> str:
    """Render 1996 -> "1996-97" (and 1999 -> "1999-00")."""
    return f"{start_year}-{(start_year + 1) % 100:02d}"


def season_range(from_season: str, to_season: str) -> list[str]:
    """Season labels between two bounds, newest first.

    Newest-first because the recent seasons are the ones users actually look at,
    so a run that gets throttled to death still leaves the most useful data
    behind. Bounds may be given in either order.
    """
    a = season_start_year(from_season)
    b = season_start_year(to_season)
    lo, hi = min(a, b), max(a, b)
    return [season_label(year) for year in range(hi, lo - 1, -1)]


def _is_retryable(exc: Exception) -> bool:
    """Whether a failed stats.nba.com call is worth retrying.

    requests.RequestException is checked first because it subclasses OSError,
    so the isinstance order below is load-bearing.
    """
    if isinstance(exc, requests.exceptions.RequestException):
        status = getattr(getattr(exc, "response", None), "status_code", None)
        if status is None:
            return True  # connection reset / timeout / dns, no response at all
        return status == 429 or status >= 500
    if isinstance(exc, (ConnectionResetError, TimeoutError, OSError)):
        return True
    # nba_api hands back a decode error when Akamai returns an html error page
    return isinstance(exc, json.JSONDecodeError)


_FetchResult = TypeVar("_FetchResult")


def _fetch_with_retry(
    label: str,
    fetch: Callable[[], _FetchResult],
    max_attempts: int = BACKFILL_MAX_ATTEMPTS,
    initial_delay: float = BACKFILL_REQUEST_DELAY_SECONDS,
) -> _FetchResult:
    """Call fetch() with exponential backoff on throttling-shaped failures.

    Re-raises the last exception so the caller can fail one season without
    aborting the whole run. The attempt count and starting delay are overridable
    because the 2K sync talks to a friendlier host than stats.nba.com and does
    not need a 5-second opening backoff.
    """
    delay = initial_delay
    for attempt in range(1, max_attempts + 1):
        try:
            return fetch()
        except Exception as exc:
            if attempt == max_attempts or not _is_retryable(exc):
                raise
            logger.warning(
                "%s failed (attempt %d/%d): %s — retrying in %.0fs",
                label, attempt, max_attempts, exc, delay,
            )
            time.sleep(delay)
            delay *= 2
    raise RuntimeError(f"{label}: retry loop exhausted")  # unreachable


def _existing_history_seasons(conn: psycopg2.extensions.connection) -> set[str]:
    """Seasons already written, so a killed run can be re-run cheaply."""
    cur = conn.cursor()
    cur.execute(
        """
        SELECT season FROM player_season_stats
        UNION
        SELECT season FROM team_season_stats
        """
    )
    seasons = {row[0] for row in cur.fetchall()}
    cur.close()
    return seasons


def _upsert_player_season(
    cur: psycopg2.extensions.cursor, season: str, row: dict
) -> None:
    cur.execute(
        """
        INSERT INTO player_season_stats (nba_player_id, player_name, season, team, games_played,
                                         minutes_per_game, points_per_game, rebounds_per_game,
                                         assists_per_game, steals_per_game, blocks_per_game,
                                         turnovers_per_game, field_goal_percentage,
                                         three_point_percentage, free_throw_percentage,
                                         three_pointers_made)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (nba_player_id, season) DO UPDATE SET
            player_name = EXCLUDED.player_name, team = EXCLUDED.team,
            games_played = EXCLUDED.games_played, minutes_per_game = EXCLUDED.minutes_per_game,
            points_per_game = EXCLUDED.points_per_game, rebounds_per_game = EXCLUDED.rebounds_per_game,
            assists_per_game = EXCLUDED.assists_per_game, steals_per_game = EXCLUDED.steals_per_game,
            blocks_per_game = EXCLUDED.blocks_per_game, turnovers_per_game = EXCLUDED.turnovers_per_game,
            field_goal_percentage = EXCLUDED.field_goal_percentage,
            three_point_percentage = EXCLUDED.three_point_percentage,
            free_throw_percentage = EXCLUDED.free_throw_percentage,
            three_pointers_made = EXCLUDED.three_pointers_made
        """,
        (
            str(row["PLAYER_ID"]),
            row["PLAYER_NAME"],
            season,
            # whatever abbreviation the API reported for that season (SEA, VAN,
            # NJN, ...), never a lookup through the current-team maps.
            row.get("TEAM_ABBREVIATION") or None,
            _opt_int(row.get("GP")),
            _opt_float(row.get("MIN")),
            _opt_float(row.get("PTS")),
            _opt_float(row.get("REB")),
            _opt_float(row.get("AST")),
            _opt_float(row.get("STL")),
            _opt_float(row.get("BLK")),
            _opt_float(row.get("TOV")),
            _opt_pct(row.get("FG_PCT")),
            _opt_pct(row.get("FG3_PCT")),
            _opt_pct(row.get("FT_PCT")),
            _opt_float(row.get("FG3M")),
        ),
    )


def _upsert_team_season(
    cur: psycopg2.extensions.cursor, season: str, row: dict, ratings: dict
) -> None:
    team_name = row.get("TEAM_NAME") or ""
    # NOT _resolve_team_abbr: NBA team ids are permanent across relocations, so
    # resolving by id would label the 1995-96 SuperSonics as OKC. Trust the
    # response, then fall back to a name match (which only hits still-existing
    # franchises), then store NULL and let team_name carry the identity.
    abbr = row.get("TEAM_ABBREVIATION") or NAME_TO_ABBR.get(team_name.strip().lower(), "")

    cur.execute(
        """
        INSERT INTO team_season_stats (nba_team_id, team_name, team_abbreviation, season,
                                       games_played, wins, losses,
                                       minutes_per_game, points_per_game, rebounds_per_game,
                                       assists_per_game, steals_per_game, blocks_per_game,
                                       turnovers_per_game, field_goal_percentage,
                                       three_point_percentage, free_throw_percentage,
                                       defensive_rating, offensive_rating, net_rating)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (nba_team_id, season) DO UPDATE SET
            team_name = EXCLUDED.team_name, team_abbreviation = EXCLUDED.team_abbreviation,
            games_played = EXCLUDED.games_played, wins = EXCLUDED.wins, losses = EXCLUDED.losses,
            minutes_per_game = EXCLUDED.minutes_per_game, points_per_game = EXCLUDED.points_per_game,
            rebounds_per_game = EXCLUDED.rebounds_per_game, assists_per_game = EXCLUDED.assists_per_game,
            steals_per_game = EXCLUDED.steals_per_game, blocks_per_game = EXCLUDED.blocks_per_game,
            turnovers_per_game = EXCLUDED.turnovers_per_game,
            field_goal_percentage = EXCLUDED.field_goal_percentage,
            three_point_percentage = EXCLUDED.three_point_percentage,
            free_throw_percentage = EXCLUDED.free_throw_percentage,
            defensive_rating = EXCLUDED.defensive_rating,
            offensive_rating = EXCLUDED.offensive_rating,
            net_rating = EXCLUDED.net_rating
        """,
        (
            str(row["TEAM_ID"]),
            team_name,
            abbr or None,
            season,
            _opt_int(row.get("GP")),
            _opt_int(row.get("W")),
            _opt_int(row.get("L")),
            _opt_float(row.get("MIN")),
            _opt_float(row.get("PTS")),
            _opt_float(row.get("REB")),
            _opt_float(row.get("AST")),
            _opt_float(row.get("STL")),
            _opt_float(row.get("BLK")),
            _opt_float(row.get("TOV")),
            _opt_pct(row.get("FG_PCT")),
            _opt_pct(row.get("FG3_PCT")),
            _opt_pct(row.get("FT_PCT")),
            ratings.get("defensive_rating"),
            ratings.get("offensive_rating"),
            ratings.get("net_rating"),
        ),
    )


def _fetch_season_player_rows(season: str) -> list[dict]:
    def fetch() -> leaguedashplayerstats.LeagueDashPlayerStats:
        return leaguedashplayerstats.LeagueDashPlayerStats(
            season=season,
            per_mode_detailed="PerGame",
            season_type_all_star="Regular Season",
            timeout=60,
        )

    stats = _fetch_with_retry(f"player stats {season}", fetch)
    return stats.get_data_frames()[0].to_dict("records")


def _fetch_season_team_rows(season: str) -> list[dict]:
    def fetch() -> leaguedashteamstats.LeagueDashTeamStats:
        return leaguedashteamstats.LeagueDashTeamStats(
            season=season,
            per_mode_detailed="PerGame",
            season_type_all_star="Regular Season",
            timeout=60,
        )

    stats = _fetch_with_retry(f"team stats {season}", fetch)
    return stats.get_data_frames()[0].to_dict("records")


def _fetch_season_team_ratings(season: str) -> dict[str, dict[str, float | None]]:
    """Off/def/net rating per team id. Empty dict when unavailable."""
    if season_start_year(season) < ADVANCED_RATINGS_FIRST_SEASON_START_YEAR:
        return {}

    def fetch() -> leaguedashteamstats.LeagueDashTeamStats:
        return leaguedashteamstats.LeagueDashTeamStats(
            season=season,
            per_mode_detailed="PerGame",
            measure_type_detailed_defense="Advanced",
            season_type_all_star="Regular Season",
            timeout=60,
        )

    try:
        stats = _fetch_with_retry(f"advanced team stats {season}", fetch)
    except Exception as e:
        # ratings are a nice-to-have; a season is still worth writing without them
        logger.warning("%s: advanced ratings unavailable (%s)", season, e)
        return {}

    ratings: dict[str, dict[str, float | None]] = {}
    for row in stats.get_data_frames()[0].to_dict("records"):
        ratings[str(row["TEAM_ID"])] = {
            "defensive_rating": _opt_float(row.get("DEF_RATING")),
            "offensive_rating": _opt_float(row.get("OFF_RATING")),
            "net_rating": _opt_float(row.get("NET_RATING")),
        }
    return ratings


def backfill_season(
    conn: psycopg2.extensions.connection, season: str
) -> tuple[int, int]:
    """Write one season's player and team rows. Returns (player_rows, team_rows).

    An empty response is a normal outcome — it means the NBA API has no data
    that far back — and is reported as 0 rows rather than raised as an error.
    """
    player_rows = _fetch_season_player_rows(season)
    time.sleep(BACKFILL_REQUEST_DELAY_SECONDS)
    team_rows = _fetch_season_team_rows(season)
    time.sleep(BACKFILL_REQUEST_DELAY_SECONDS)
    ratings = _fetch_season_team_ratings(season)

    cur = conn.cursor()
    try:
        for row in player_rows:
            _upsert_player_season(cur, season, row)
        for row in team_rows:
            _upsert_team_season(cur, season, row, ratings.get(str(row["TEAM_ID"]), {}))
    finally:
        cur.close()

    return len(player_rows), len(team_rows)


def backfill_history(
    conn: psycopg2.extensions.connection,
    from_season: str,
    to_season: str,
) -> None:
    """One-time historical backfill over a range of seasons.

    Opt-in only (--backfill-history) and never part of the cron: stats.nba.com
    is Akamai-blocked from CI and throttles residential IPs after a handful of
    rapid calls, so this crawls deliberately and tolerates per-season failure.
    """
    seasons = season_range(from_season, to_season)
    already_present = _existing_history_seasons(conn)

    logger.info(
        "backfilling %d candidate seasons (%s → %s), %d already present",
        len(seasons), seasons[0], seasons[-1], len(already_present),
    )

    written: list[str] = []
    empty: list[str] = []
    skipped: list[str] = []
    failed: list[str] = []

    for season in seasons:
        if season in already_present:
            skipped.append(season)
            logger.info("%s: already in database, skipping", season)
            continue

        try:
            players, teams = backfill_season(conn, season)
        except Exception as e:
            failed.append(season)
            logger.error("%s: failed, moving on (%s)", season, e)
            # a failure here is almost always throttling, so give the host a
            # longer rest before the next season
            time.sleep(BACKFILL_REQUEST_DELAY_SECONDS * 4)
            continue

        if players == 0 and teams == 0:
            empty.append(season)
            logger.info("%s: no data returned by the NBA API", season)
        else:
            written.append(season)
            logger.info("%s: wrote %d players, %d teams", season, players, teams)

        time.sleep(BACKFILL_REQUEST_DELAY_SECONDS)

    logger.info(
        "backfill summary: %d written, %d empty (no data), %d skipped, %d failed",
        len(written), len(empty), len(skipped), len(failed),
    )
    if written:
        logger.info("written: %s", ", ".join(written))
    if empty:
        logger.info("empty: %s", ", ".join(empty))
    if failed:
        logger.info("failed (re-run to retry): %s", ", ".join(failed))


def parse_team_types(raw: str) -> list[str]:
    """Validate a comma-separated --team-types value.

    Order is preserved and duplicates dropped, so "curr,curr,allt" syncs curr
    then allt exactly once each. Raises ValueError on anything unrecognized
    rather than silently syncing a subset.
    """
    requested = [part.strip().lower() for part in (raw or "").split(",")]
    requested = [part for part in requested if part]
    valid = ", ".join(NBA_2K_TEAM_TYPES)

    if not requested:
        raise ValueError(f"--team-types needs at least one of: {valid}")

    unknown = [part for part in requested if part not in NBA_2K_TEAM_TYPES]
    if unknown:
        raise ValueError(
            f"unknown team type(s): {', '.join(unknown)} (choose from {valid})"
        )

    ordered: list[str] = []
    for part in requested:
        if part not in ordered:
            ordered.append(part)
    return ordered


def _text_or_none(val: object) -> str | None:
    """Trimmed text, or NULL for empty input.

    2K returns "" rather than omitting a field it has no value for — most cards
    have no build — and "" would be indistinguishable from a real empty answer.
    """
    if val is None:
        return None
    text = str(val).strip()
    return text or None


def _dedupe_badges(badges: list[dict]) -> list[dict]:
    """Badges with a unique name, keeping the first occurrence.

    The source data has at least one card carrying the same badge at two
    different tiers, which would violate the (player_slug, badge_name) primary
    key. The API lists badges strongest tier first, so first-wins keeps the
    higher tier.
    """
    seen: set[str] = set()
    unique: list[dict] = []
    for badge in badges:
        name = _text_or_none(badge.get("name"))
        if not name or name in seen:
            continue
        seen.add(name)
        unique.append(badge)
    return unique


def _fetch_2k_page(team_type: str, cursor: str) -> dict:
    """One page of the public nba2kapi players endpoint."""

    def fetch() -> dict:
        resp = requests.get(
            NBA_2K_API_URL,
            params={
                "limit": NBA_2K_PAGE_LIMIT,
                "cursor": cursor,
                "teamType": team_type,
            },
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()

    payload = _fetch_with_retry(
        f"2k {team_type} page (cursor {cursor})",
        fetch,
        max_attempts=NBA_2K_MAX_ATTEMPTS,
        initial_delay=NBA_2K_RETRY_DELAY_SECONDS,
    )

    if not payload.get("success"):
        raise RuntimeError(f"nba2kapi reported failure for teamType={team_type}")
    return payload


def _fetch_2k_players(team_type: str) -> list[dict]:
    """Every card for one roster type, cursor-paginated until hasMore is false."""
    players: list[dict] = []
    cursor = "0"

    while True:
        payload = _fetch_2k_page(team_type, cursor)
        players.extend(payload.get("data") or [])

        pagination = (payload.get("meta") or {}).get("pagination") or {}
        total = pagination.get("total")
        logger.info(
            "2k %s: fetched %d/%s cards",
            team_type, len(players), total if total is not None else "?",
        )

        if not pagination.get("hasMore"):
            break

        next_cursor = pagination.get("nextCursor")
        if next_cursor is None or str(next_cursor) == cursor:
            # a cursor that doesn't advance would page forever
            logger.warning(
                "2k %s: cursor stuck at %s, stopping early", team_type, cursor
            )
            break

        cursor = str(next_cursor)
        time.sleep(NBA_2K_REQUEST_DELAY_SECONDS)

    return players


def _upsert_2k_player(cur: psycopg2.extensions.cursor, player: dict) -> None:
    """Write one card and replace its attributes, badges, and rating history.

    The child rows are deleted and re-inserted rather than upserted, so an
    attribute or badge 2K dropped this year doesn't linger from a previous sync.
    The caller wraps this in a transaction, so a card is never left stripped of
    its attributes.
    """
    slug = _text_or_none(player.get("slug"))
    name = _text_or_none(player.get("name"))
    if not slug or not name:
        raise ValueError(f"2k card is missing a slug or name: {player.get('slug')!r}")

    positions = ",".join(
        str(pos).strip() for pos in (player.get("positions") or []) if str(pos).strip()
    )

    cur.execute(
        """
        INSERT INTO nba_2k_players (slug, name, normalized_name, team, team_type,
                                    overall, positions, game_version, archetype,
                                    build, height, weight, wingspan, player_image,
                                    updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
        ON CONFLICT (slug) DO UPDATE SET
            name = EXCLUDED.name, normalized_name = EXCLUDED.normalized_name,
            team = EXCLUDED.team, team_type = EXCLUDED.team_type,
            overall = EXCLUDED.overall, positions = EXCLUDED.positions,
            game_version = EXCLUDED.game_version, archetype = EXCLUDED.archetype,
            build = EXCLUDED.build, height = EXCLUDED.height,
            weight = EXCLUDED.weight, wingspan = EXCLUDED.wingspan,
            player_image = EXCLUDED.player_image, updated_at = NOW()
        """,
        (
            slug,
            name,
            # the only join key back to the players table — 2K publishes no NBA
            # player id. must match backend normalizeName in ratings2kParams.ts.
            _normalize_name(name),
            _text_or_none(player.get("team")),
            _text_or_none(player.get("teamType")),
            _opt_int(player.get("overall")),
            _text_or_none(positions),
            _text_or_none(player.get("gameVersion")),
            _text_or_none(player.get("archetype")),
            _text_or_none(player.get("build")),
            _text_or_none(player.get("height")),
            _text_or_none(player.get("weight")),
            _text_or_none(player.get("wingspan")),
            _text_or_none(player.get("playerImage")),
        ),
    )

    cur.execute("DELETE FROM nba_2k_attributes WHERE player_slug = %s", (slug,))
    cur.execute("DELETE FROM nba_2k_badges WHERE player_slug = %s", (slug,))
    cur.execute("DELETE FROM nba_2k_rating_history WHERE player_slug = %s", (slug,))

    # attributes is a flat name -> integer map, 35 keys in 2K27. an unrated
    # rookie has none at all, which is a normal outcome, not a failure.
    attribute_rows = [
        (slug, str(attr_name), _opt_int(value))
        for attr_name, value in sorted((player.get("attributes") or {}).items())
    ]
    if attribute_rows:
        execute_values(
            cur,
            "INSERT INTO nba_2k_attributes (player_slug, attribute_name, value) VALUES %s",
            attribute_rows,
        )

    badge_rows = [
        (
            slug,
            _text_or_none(badge.get("name")),
            _text_or_none(badge.get("tier")),
            _text_or_none(badge.get("category")),
            _text_or_none(badge.get("description")),
            _text_or_none(badge.get("imageUrl")),
        )
        for badge in _dedupe_badges((player.get("badges") or {}).get("list") or [])
    ]
    if badge_rows:
        execute_values(
            cur,
            """
            INSERT INTO nba_2k_badges (player_slug, badge_name, tier, category,
                                       description, image_url)
            VALUES %s
            """,
            badge_rows,
        )

    # one entry per 2K game the card appeared in. the oldest entry has no delta
    # (nothing to diff against), and the API omits the key rather than sending 0.
    history_rows: list[tuple] = []
    seen_versions: set[str] = set()
    for entry in player.get("ratingHistory") or []:
        version = _text_or_none(entry.get("gameVersion"))
        if not version or version in seen_versions:
            continue
        seen_versions.add(version)
        history_rows.append(
            (slug, version, _opt_int(entry.get("overall")), _opt_int(entry.get("delta")))
        )
    if history_rows:
        execute_values(
            cur,
            """
            INSERT INTO nba_2k_rating_history (player_slug, game_version, overall, delta)
            VALUES %s
            """,
            history_rows,
        )


def _prune_2k_players(
    conn: psycopg2.extensions.connection, team_type: str, seen_slugs: set[str]
) -> int:
    """Drop cards 2K no longer lists for this roster type. Returns rows removed.

    Scoped to the roster type just synced, so syncing only `curr` never touches
    the classic or all-time cards. Child rows go with it via ON DELETE CASCADE.
    """
    cur = conn.cursor()
    try:
        cur.execute(
            "DELETE FROM nba_2k_players WHERE team_type = %s AND NOT (slug = ANY(%s))",
            (team_type, list(seen_slugs)),
        )
        removed = cur.rowcount
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
    return removed


def sync_2k_ratings(
    conn: psycopg2.extensions.connection, team_types: list[str]
) -> None:
    """Sync NBA 2K ratings for the given roster types.

    Opt-in only (--sync-2k) and deliberately NOT part of the 6-hour cron: even
    `curr` alone is 7 paginated requests against a 60/min budget, and the classic
    and all-time rosters are far larger and change only when 2K adds a card.
    """
    # each card commits on its own. its attributes and badges are deleted before
    # being re-inserted, so a failure mid-card must not leave it stripped.
    previous_autocommit = conn.autocommit
    conn.autocommit = False

    written = 0
    failed = 0
    pruned = 0
    unavailable: list[str] = []

    try:
        for team_type in team_types:
            logger.info("2k: syncing teamType=%s", team_type)
            try:
                players = _fetch_2k_players(team_type)
            except Exception as e:
                unavailable.append(team_type)
                logger.error("2k %s: fetch failed, skipping (%s)", team_type, e)
                continue

            seen_slugs: set[str] = set()
            for player in players:
                cur = conn.cursor()
                try:
                    _upsert_2k_player(cur, player)
                    conn.commit()
                    seen_slugs.add(str(player.get("slug") or ""))
                    written += 1
                except Exception as e:
                    conn.rollback()
                    failed += 1
                    logger.error(
                        "2k %s: failed to write %s (%s)",
                        team_type, player.get("slug"), e,
                    )
                finally:
                    cur.close()

            logger.info("2k %s: wrote %d cards", team_type, len(seen_slugs))

            # only prune against a roster we actually fetched in full
            if seen_slugs:
                removed = _prune_2k_players(conn, team_type, seen_slugs)
                pruned += removed
                if removed > 0:
                    logger.info(
                        "2k %s: pruned %d card(s) no longer listed", team_type, removed
                    )
    finally:
        conn.autocommit = previous_autocommit

    logger.info(
        "2k sync summary: %d cards written, %d failed, %d pruned, %d roster type(s) unavailable",
        written, failed, pruned, len(unavailable),
    )
    if unavailable:
        logger.info("2k unavailable (re-run to retry): %s", ", ".join(unavailable))


# ---------------------------------------------------------------------------
# Data truth layer — pure helpers.
#
# Everything in this section is a plain function over plain data: no database,
# no network. That is deliberate, and it is what scraper/test_truth_layer.py
# covers, since the write paths below cannot be exercised without a real Neon
# connection.
# ---------------------------------------------------------------------------


def parse_minutes(val: object) -> float | None:
    """Decimal minutes from whatever shape a source reports.

    Three are in play across the endpoints this scraper touches: the league-wide
    game logs return a number (34.2), the v2 box scores return "MM:SS"
    ("34:12"), and the v3 box scores return an ISO-8601 duration
    ("PT34M12.00S"). All three mean the same thing, so all three are stored the
    same way.

    Returns None — never 0.0 — for missing, blank, or unparseable input. A
    player with no minutes reported did not play zero minutes; we were simply
    not told, and the availability model turns on that distinction.
    """
    if val is None:
        return None

    if isinstance(val, bool):
        return None
    if isinstance(val, (int, float)):
        num = float(val)
        return None if num != num else round(num, 2)  # NaN check

    text = str(val).strip()
    if not text:
        return None

    iso = _MINUTES_ISO_PATTERN.match(text)
    if iso:
        minutes = float(iso.group("min") or 0)
        seconds = float(iso.group("sec") or 0)
        return round(minutes + seconds / 60, 2)

    if ":" in text:
        head, _, tail = text.partition(":")
        try:
            return round(float(head or 0) + float(tail or 0) / 60, 2)
        except ValueError:
            return None

    try:
        return round(float(text), 2)
    except ValueError:
        return None


def parse_game_date(val: object) -> date | None:
    """Game date from the several formats the NBA endpoints hand back.

    playergamelogs returns "2024-10-22T00:00:00", leaguegamelog returns
    "2024-10-22", and the older per-player log returns "OCT 22, 2024". Any time
    component is discarded rather than converted: these are already the
    canonical Eastern-time game dates, so shifting them by a timezone would move
    late games onto the wrong night.
    """
    if val is None:
        return None
    if isinstance(val, datetime):
        return val.date()
    if isinstance(val, date):
        return val

    text = str(val).strip()
    if not text:
        return None

    # ISO first: "2024-10-22" and "2024-10-22T00:00:00" share a leading date
    try:
        return date.fromisoformat(text.split("T", 1)[0])
    except ValueError:
        pass
    for fmt in ("%b %d, %Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    return None


def parse_matchup(matchup: object) -> tuple[bool | None, str | None]:
    """(is_home, opponent abbreviation) from a MATCHUP string.

    "BOS vs. LAL" -> (True, "LAL"); "BOS @ LAL" -> (False, "LAL"). The league
    game log carries no explicit home flag, so this string is the only place the
    information exists. Returns (None, None) rather than guessing when the
    string does not parse — an is_home that is wrong half the time is worse than
    one that is absent.
    """
    match = _MATCHUP_PATTERN.match(str(matchup or ""))
    if not match:
        return None, None
    is_home = match.group("sep").startswith("@") is False
    return is_home, match.group("opp").upper()


def season_type_from_game_id(game_id: object) -> str:
    """Season type encoded in the first three characters of an NBA game id.

    "0022300061" -> "Regular Season". Returns "Unknown" for an unrecognised
    prefix rather than defaulting to Regular Season: a mislabelled playoff game
    would quietly contaminate a regular-season training set.
    """
    text = str(game_id or "").strip()
    return GAME_ID_PREFIX_TO_SEASON_TYPE.get(text[:3], SEASON_TYPE_UNKNOWN)


def season_start_date(season: str) -> date:
    """Earliest date a game of `season` could fall on.

    July 1 rather than the actual opener: this is a bound, not a date, and it
    cannot overlap the previous season no matter how early the league schedules
    or how far into summer a suspended season runs.
    """
    return date(season_start_year(season), 7, 1)


def game_log_fetch_from(
    latest_logged_date: date | None,
    season: str,
    correction_window_days: int = GAME_LOG_CORRECTION_WINDOW_DAYS,
) -> date:
    """Earliest game date the incremental sync should ask the API for.

    The watermark is the newest game date already stored, walked back by the
    correction window so revised box scores get re-read. With nothing stored the
    whole season is in scope, and the window never reaches back past the season
    boundary.
    """
    floor = season_start_date(season)
    if latest_logged_date is None:
        return floor
    return max(floor, latest_logged_date - timedelta(days=correction_window_days))


def plan_stint_change(
    open_stint: tuple[str, date] | None,
    current_team_id: str,
    current_team_first_game_date: date,
    open_team_last_game_date: date | None,
) -> dict | None:
    """What to write when a player's latest game-log team changes.

    Returns None when the open stint already names the right team — the common
    case, evaluated for every player on every run. Otherwise a dict describing
    both halves of the transition: the previous stint ends on the last date he
    actually played for that team, and the new one starts on the first date he
    played for the new one. The gap between a trade and his debut therefore
    belongs to neither team, rather than being silently assigned to one.
    """
    if open_stint is not None and open_stint[0] == current_team_id:
        return None

    change: dict = {
        "open_team_id": current_team_id,
        "open_valid_from": current_team_first_game_date,
        "close_team_id": None,
        "close_valid_from": None,
        "close_valid_to": None,
    }
    if open_stint is None:
        return change

    prev_team_id, prev_valid_from = open_stint
    close_to = open_team_last_game_date or prev_valid_from
    # a stint can never end before it began, nor on/after the next one starts
    close_to = max(close_to, prev_valid_from)
    close_to = min(close_to, max(prev_valid_from, current_team_first_game_date - timedelta(days=1)))
    change.update(
        close_team_id=prev_team_id,
        close_valid_from=prev_valid_from,
        close_valid_to=close_to,
    )
    return change


# (rule name, the stat that must not exceed, the stat it must not exceed).
BOX_SCORE_RULES: tuple[tuple[str, str, str], ...] = (
    ("fgm_le_fga", "fgm", "fga"),
    ("fg3m_le_fg3a", "fg3m", "fg3a"),
    # a made three is also a made field goal, so this catches a class of
    # mis-mapped columns that the two rules above cannot.
    ("fg3m_le_fgm", "fg3m", "fgm"),
    ("ftm_le_fta", "ftm", "fta"),
)


def box_score_violations(row: Mapping) -> list[str]:
    """Names of the internal-consistency rules a box-score row breaks.

    An empty list means consistent. A NULL on either side is never a violation:
    an unreported stat is not a wrong stat, and treating it as one would flag
    every historical row whose coverage is thin.
    """
    violations: list[str] = []
    for name, left, right in BOX_SCORE_RULES:
        lhs, rhs = row.get(left), row.get(right)
        if lhs is None or rhs is None:
            continue
        if float(lhs) > float(rhs):
            violations.append(name)
    return violations


# Longest phrase first: "out for season" must not be matched by the "out" rule,
# and "day-to-day" must not be matched by "day".
_INJURY_STATUS_BUCKETS: tuple[tuple[str, str], ...] = (
    ("out for season", "out"),
    ("season-ending", "out"),
    ("game time decision", "day_to_day"),
    ("day-to-day", "day_to_day"),
    ("day to day", "day_to_day"),
    ("questionable", "questionable"),
    ("doubtful", "doubtful"),
    ("probable", "probable"),
    ("available", "available"),
    ("active", "available"),
    ("out", "out"),
    ("gtd", "day_to_day"),
)


def normalize_injury_status(raw: object) -> str:
    """Bucket a source's injury wording into a small fixed vocabulary.

    Stored alongside the verbatim status_raw, never instead of it: every source
    invents new phrasing each season, and an unrecognised value must degrade to
    "unknown" rather than silently landing in the wrong bucket.
    """
    text = str(raw or "").strip().lower()
    if not text:
        return "unknown"
    for phrase, bucket in _INJURY_STATUS_BUCKETS:
        if phrase in text:
            return bucket
    return "unknown"


def normalize_inactive_rows(rows: Sequence[Mapping]) -> list[dict]:
    """Player/team ids from a box-score InactivePlayers result set.

    Handles both shapes, because the endpoints disagree and the fallback matters:
    BoxScoreSummaryV3 reports personId/teamId, BoxScoreSummaryV2 reports
    PLAYER_ID/TEAM_ID. Rows without a player id are dropped — an inactive entry
    that names nobody cannot be joined to anything.
    """
    normalized: list[dict] = []
    for row in rows:
        player_id = row.get("personId", row.get("PLAYER_ID"))
        team_id = row.get("teamId", row.get("TEAM_ID"))
        if player_id in (None, ""):
            continue
        normalized.append(
            {
                "nba_player_id": str(player_id),
                "team_id": str(team_id) if team_id not in (None, "") else None,
            }
        )
    return normalized


def derive_game_status_rows(
    nba_game_id: str,
    played_rows: Sequence[Mapping],
    inactive_rows: Sequence[Mapping],
    source: str,
) -> list[dict]:
    """One player_game_status row per player who was on a roster for this game.

    Three populations merge here, and keeping them apart is the whole point:

      * a game-log row with no dnp_reason  -> played, active
      * a game-log row *with* a dnp_reason -> dressed but did not play (a healthy
        scratch or a late scratch); NBA box scores set COMMENT only when a
        player did not appear, so a non-empty comment is the signal
      * an inactive-list entry              -> listed inactive, did not play

    rostered is the union of all three. A player who somehow appears in both the
    game log and the inactive list keeps his played status and is still flagged
    listed_inactive, so the contradiction stays visible in the data instead of
    being resolved by whichever branch happened to run last.
    """
    by_player: dict[str, dict] = {}

    for row in played_rows:
        player_id = str(row.get("nba_player_id") or "")
        if not player_id:
            continue
        dnp_reason = (row.get("dnp_reason") or "").strip() or None
        by_player[player_id] = {
            "nba_player_id": player_id,
            "nba_game_id": nba_game_id,
            "team_id": row.get("team_id"),
            "rostered": True,
            "listed_inactive": False,
            "started": row.get("started"),
            "played": dnp_reason is None,
            "dnp_reason": dnp_reason,
            "minutes": row.get("minutes"),
            "source": source,
        }

    for row in normalize_inactive_rows(inactive_rows):
        player_id = row["nba_player_id"]
        existing = by_player.get(player_id)
        if existing is not None:
            existing["listed_inactive"] = True
            continue
        by_player[player_id] = {
            "nba_player_id": player_id,
            "nba_game_id": nba_game_id,
            "team_id": row["team_id"],
            "rostered": True,
            "listed_inactive": True,
            "started": False,
            "played": False,
            "dnp_reason": None,
            "minutes": None,
            "source": source,
        }

    return list(by_player.values())


def schedule_rows_from_team_logs(
    team_rows: Sequence[Mapping], season: str
) -> list[dict]:
    """Schedule rows reconstructed from a league team game log.

    Two rows per game come back, one per team, and the MATCHUP string on each
    says which side it is. That makes one request enough to rebuild a whole
    season's completed schedule — the alternative being 1,230 per-game calls.

    Only completed games can be recovered this way, which is why it is the
    fallback and not the primary source: same-day prediction needs rows for
    games that have not been played.
    """
    by_game: dict[str, dict] = {}
    for row in team_rows:
        game_id = str(row.get("GAME_ID") or "").strip()
        game_date = parse_game_date(row.get("GAME_DATE"))
        if not game_id or game_date is None:
            continue

        is_home, opponent_abbr = parse_matchup(row.get("MATCHUP"))
        team_id = str(row.get("TEAM_ID") or "") or None
        team_abbr = (row.get("TEAM_ABBREVIATION") or "") or None

        entry = by_game.setdefault(
            game_id,
            {
                "nba_game_id": game_id,
                "season": season,
                "season_type": season_type_from_game_id(game_id),
                "game_date": game_date,
                "scheduled_at": None,
                "home_team_id": None,
                "away_team_id": None,
                "home_team_abbr": None,
                "away_team_abbr": None,
                # every game a team game log knows about has been played
                "game_status": "Final",
                "postponed_status": None,
                "source": "leaguegamelog",
            },
        )
        if is_home is True:
            entry["home_team_id"] = team_id
            entry["home_team_abbr"] = team_abbr
            entry["away_team_abbr"] = entry["away_team_abbr"] or opponent_abbr
        elif is_home is False:
            entry["away_team_id"] = team_id
            entry["away_team_abbr"] = team_abbr
            entry["home_team_abbr"] = entry["home_team_abbr"] or opponent_abbr

    return sorted(by_game.values(), key=lambda g: (g["game_date"], g["nba_game_id"]))


def schedule_rows_from_league_schedule(
    raw_rows: Sequence[Mapping], season: str
) -> list[dict]:
    """Schedule rows from the scheduleleaguev2 SeasonGames result set.

    This endpoint publishes the full season in advance, including games with no
    box score yet, which is the property that makes same-day prediction possible.
    Its columns are camelCase (the modern NBA feeds) rather than the SHOUTY_CASE
    of the stats endpoints.
    """
    rows: list[dict] = []
    for raw in raw_rows:
        game_id = str(raw.get("gameId") or "").strip()
        game_date = parse_game_date(raw.get("gameDate"))
        if not game_id or game_date is None:
            continue

        scheduled_at = raw.get("gameDateTimeUTC") or None
        if scheduled_at:
            try:
                scheduled_at = datetime.fromisoformat(
                    str(scheduled_at).replace("Z", "+00:00")
                )
            except ValueError:
                scheduled_at = None

        rows.append(
            {
                "nba_game_id": game_id,
                "season": str(raw.get("seasonYear") or season),
                "season_type": season_type_from_game_id(game_id),
                "game_date": game_date,
                "scheduled_at": scheduled_at,
                "home_team_id": str(raw.get("homeTeam_teamId") or "") or None,
                "away_team_id": str(raw.get("awayTeam_teamId") or "") or None,
                "home_team_abbr": raw.get("homeTeam_teamTricode") or None,
                "away_team_abbr": raw.get("awayTeam_teamTricode") or None,
                "game_status": raw.get("gameStatusText") or None,
                # non-null only for the handful of games the league moves
                "postponed_status": _text_or_none(raw.get("postponedStatus")),
                "source": "scheduleleaguev2",
            }
        )
    return rows


def build_player_game_log_row(
    raw: Mapping, season: str, run_id: int | None
) -> tuple | None:
    """One player_game_logs tuple from a playergamelogs record.

    Returns None when the record has no usable key (player id, game id, date),
    because a row that cannot be joined is worse than a row that is absent.
    Tuple order matches the column list in _PLAYER_GAME_LOG_UPSERT_SQL.
    """
    player_id = str(raw.get("PLAYER_ID") or "").strip()
    game_id = str(raw.get("GAME_ID") or "").strip()
    game_date = parse_game_date(raw.get("GAME_DATE"))
    if not player_id or not game_id or game_date is None:
        return None

    is_home, opponent_abbr = parse_matchup(raw.get("MATCHUP"))
    return (
        player_id,
        game_id,
        str(raw.get("SEASON_YEAR") or season),
        season_type_from_game_id(game_id),
        game_date,
        str(raw.get("TEAM_ID") or "") or None,
        raw.get("TEAM_ABBREVIATION") or None,
        ABBR_TO_TEAM_ID.get(opponent_abbr or ""),
        is_home,
        # the league-wide log reports no starting five; a per-game box score
        # would, and the upsert below preserves whatever is already stored.
        None,
        parse_minutes(raw.get("MIN")),
        _opt_int(raw.get("PTS")),
        _opt_int(raw.get("REB")),
        _opt_int(raw.get("AST")),
        _opt_int(raw.get("STL")),
        _opt_int(raw.get("BLK")),
        _opt_int(raw.get("TOV")),
        _opt_int(raw.get("FGM")),
        _opt_int(raw.get("FGA")),
        _opt_int(raw.get("FG3M")),
        _opt_int(raw.get("FG3A")),
        _opt_int(raw.get("FTM")),
        _opt_int(raw.get("FTA")),
        _opt_int(raw.get("PLUS_MINUS")),
        # likewise: this endpoint only returns players who appeared, so it can
        # never supply a COMMENT.
        None,
        "playergamelogs",
        run_id,
    )


def build_team_game_log_row(
    raw: Mapping, season: str, run_id: int | None
) -> tuple | None:
    """One team_game_logs tuple from a leaguegamelog (team mode) record."""
    team_id = str(raw.get("TEAM_ID") or "").strip()
    game_id = str(raw.get("GAME_ID") or "").strip()
    game_date = parse_game_date(raw.get("GAME_DATE"))
    if not team_id or not game_id or game_date is None:
        return None

    is_home, opponent_abbr = parse_matchup(raw.get("MATCHUP"))
    return (
        team_id,
        game_id,
        season,
        season_type_from_game_id(game_id),
        game_date,
        raw.get("TEAM_ABBREVIATION") or None,
        ABBR_TO_TEAM_ID.get(opponent_abbr or ""),
        is_home,
        parse_minutes(raw.get("MIN")),
        _opt_int(raw.get("PTS")),
        _opt_int(raw.get("REB")),
        _opt_int(raw.get("AST")),
        _opt_int(raw.get("STL")),
        _opt_int(raw.get("BLK")),
        _opt_int(raw.get("TOV")),
        _opt_int(raw.get("FGM")),
        _opt_int(raw.get("FGA")),
        _opt_int(raw.get("FG3M")),
        _opt_int(raw.get("FG3A")),
        _opt_int(raw.get("FTM")),
        _opt_int(raw.get("FTA")),
        _opt_int(raw.get("PLUS_MINUS")),
        "leaguegamelog",
        run_id,
    )


_WRITE_VERBS = frozenset(
    {"insert", "update", "delete", "create", "alter", "drop", "truncate", "merge"}
)


def is_write_statement(sql: str) -> bool:
    """Whether a SQL string would modify data.

    Used by the --dry-run cursor to decide what to skip. Reads must still run in
    a dry run — reporting how many rows *would* be written means querying the
    current watermark and the keys already present.

    Errs toward "write" for CTE-prefixed statements: a data-modifying CTE
    (WITH ... INSERT) is indistinguishable from a read by its first keyword, and
    misclassifying one would let --dry-run write to the database. Skipping a
    read by mistake only makes a dry-run count wrong.
    """
    stripped = (sql or "").strip()
    # skip leading line comments so "-- upsert\nINSERT ..." is still a write
    while stripped.startswith("--"):
        _, _, stripped = stripped.partition("\n")
        stripped = stripped.strip()
    if not stripped:
        return False

    first = stripped.split(None, 1)[0].lower()
    if first in _WRITE_VERBS:
        return True
    if first == "with":
        lowered = stripped.lower()
        return any(re.search(rf"\b{verb}\b", lowered) for verb in _WRITE_VERBS)
    return False


class DryRunCursor:
    """Cursor wrapper that runs reads and only counts writes.

    Wrapping rather than branching at every call site keeps the write paths
    identical between a real run and a dry run, so --dry-run exercises the same
    code that production does instead of a parallel copy of it.
    """

    def __init__(self, cur: psycopg2.extensions.cursor) -> None:
        self._cur = cur
        self._last_skipped = False
        self.skipped_statements = 0
        self.skipped_rows = 0

    def execute(self, sql: str, params: object = None) -> None:
        if is_write_statement(sql):
            self._last_skipped = True
            self.skipped_statements += 1
            self.skipped_rows += 1
            return
        self._last_skipped = False
        self._cur.execute(sql, params)

    def execute_values(self, sql: str, rows: Sequence[tuple]) -> None:
        self._last_skipped = True
        self.skipped_statements += 1
        self.skipped_rows += len(rows)

    def fetchall(self) -> list:
        # a skipped write has no result set; RETURNING clauses read as "nothing
        # matched" rather than blowing up the dry run
        return [] if self._last_skipped else self._cur.fetchall()

    def fetchone(self) -> tuple | None:
        return None if self._last_skipped else self._cur.fetchone()

    @property
    def rowcount(self) -> int:
        return 0 if self._last_skipped else self._cur.rowcount

    def close(self) -> None:
        self._cur.close()


def maybe_write_cursor(
    cur: psycopg2.extensions.cursor, dry_run: bool
) -> psycopg2.extensions.cursor | DryRunCursor:
    """The cursor itself, or a write-swallowing wrapper when dry_run is set."""
    return DryRunCursor(cur) if dry_run else cur


def _batch_upsert(cur: object, sql: str, rows: Sequence[tuple]) -> int:
    """execute_values, or a counted no-op under --dry-run. Returns rows sent."""
    if not rows:
        return 0
    if isinstance(cur, DryRunCursor):
        cur.execute_values(sql, rows)
        return len(rows)
    execute_values(cur, sql, rows, page_size=500)
    return len(rows)


# ---------------------------------------------------------------------------
# Data truth layer — ingestion run bookkeeping.
# ---------------------------------------------------------------------------


def _start_ingestion_run(
    conn: psycopg2.extensions.connection,
    kind: str,
    watermark_from: object = None,
    watermark_to: object = None,
    dry_run: bool = False,
) -> int | None:
    """Open an ingestion_runs row. Returns its id, or None under --dry-run.

    A None run id is written into the log tables as NULL, which is exactly what
    a row with no traceable run should carry.
    """
    if dry_run:
        return None
    cur = conn.cursor()
    try:
        cur.execute(
            """
            INSERT INTO ingestion_runs (kind, watermark_from, watermark_to, status)
            VALUES (%s, %s, %s, 'running')
            RETURNING id
            """,
            (
                kind,
                None if watermark_from is None else str(watermark_from),
                None if watermark_to is None else str(watermark_to),
            ),
        )
        row = cur.fetchone()
        return int(row[0]) if row else None
    finally:
        cur.close()


def _finish_ingestion_run(
    conn: psycopg2.extensions.connection,
    run_id: int | None,
    status: str,
    rows_written: int,
    notes: str | None = None,
    watermark_to: object = None,
) -> None:
    """Close an ingestion_runs row. A no-op when there is no run to close."""
    if run_id is None:
        return
    cur = conn.cursor()
    try:
        cur.execute(
            """
            UPDATE ingestion_runs
               SET finished_at = NOW(), status = %s, rows_written = %s,
                   notes = COALESCE(%s, notes),
                   watermark_to = COALESCE(%s, watermark_to)
             WHERE id = %s
            """,
            (
                status,
                rows_written,
                notes,
                None if watermark_to is None else str(watermark_to),
                run_id,
            ),
        )
    finally:
        cur.close()


# ---------------------------------------------------------------------------
# Data truth layer — upsert SQL.
# ---------------------------------------------------------------------------

# fetched_at is omitted from the insert column lists on purpose: the column
# defaults to NOW() on insert, and the DO UPDATE branches refresh it explicitly.
# That keeps "when did we last see this row" honest without passing a timestamp
# through every tuple.

_SCHEDULE_UPSERT_SQL = """
INSERT INTO nba_schedule (nba_game_id, season, season_type, game_date, scheduled_at,
                          home_team_id, away_team_id, home_team_abbr, away_team_abbr,
                          game_status, postponed_status, source)
VALUES %s
ON CONFLICT (nba_game_id) DO UPDATE SET
    season = EXCLUDED.season,
    season_type = EXCLUDED.season_type,
    game_date = EXCLUDED.game_date,
    -- COALESCE, not overwrite: the leaguegamelog fallback knows no tip-off time
    -- and must not erase one the schedule endpoint already supplied.
    scheduled_at = COALESCE(EXCLUDED.scheduled_at, nba_schedule.scheduled_at),
    home_team_id = COALESCE(EXCLUDED.home_team_id, nba_schedule.home_team_id),
    away_team_id = COALESCE(EXCLUDED.away_team_id, nba_schedule.away_team_id),
    home_team_abbr = COALESCE(EXCLUDED.home_team_abbr, nba_schedule.home_team_abbr),
    away_team_abbr = COALESCE(EXCLUDED.away_team_abbr, nba_schedule.away_team_abbr),
    game_status = COALESCE(EXCLUDED.game_status, nba_schedule.game_status),
    postponed_status = COALESCE(EXCLUDED.postponed_status, nba_schedule.postponed_status),
    source = EXCLUDED.source,
    fetched_at = NOW(),
    updated_at = NOW()
"""

_PLAYER_GAME_LOG_UPSERT_SQL = """
INSERT INTO player_game_logs (nba_player_id, nba_game_id, season, season_type, game_date,
                              team_id, team_abbr, opponent_team_id, is_home, started,
                              minutes, pts, reb, ast, stl, blk, tov, fgm, fga, fg3m,
                              fg3a, ftm, fta, plus_minus, dnp_reason, source,
                              ingestion_run_id)
VALUES %s
ON CONFLICT (nba_player_id, nba_game_id) DO UPDATE SET
    season = EXCLUDED.season,
    season_type = EXCLUDED.season_type,
    game_date = EXCLUDED.game_date,
    team_id = COALESCE(EXCLUDED.team_id, player_game_logs.team_id),
    team_abbr = COALESCE(EXCLUDED.team_abbr, player_game_logs.team_abbr),
    opponent_team_id = COALESCE(EXCLUDED.opponent_team_id, player_game_logs.opponent_team_id),
    is_home = COALESCE(EXCLUDED.is_home, player_game_logs.is_home),
    -- started and dnp_reason only ever come from a per-game box score. The
    -- league-wide log sends NULL for both, and must not wipe what a box-score
    -- pass already established.
    started = COALESCE(EXCLUDED.started, player_game_logs.started),
    dnp_reason = COALESCE(EXCLUDED.dnp_reason, player_game_logs.dnp_reason),
    minutes = EXCLUDED.minutes,
    pts = EXCLUDED.pts, reb = EXCLUDED.reb, ast = EXCLUDED.ast,
    stl = EXCLUDED.stl, blk = EXCLUDED.blk, tov = EXCLUDED.tov,
    fgm = EXCLUDED.fgm, fga = EXCLUDED.fga,
    fg3m = EXCLUDED.fg3m, fg3a = EXCLUDED.fg3a,
    ftm = EXCLUDED.ftm, fta = EXCLUDED.fta,
    plus_minus = EXCLUDED.plus_minus,
    source = EXCLUDED.source,
    fetched_at = NOW(),
    ingestion_run_id = COALESCE(EXCLUDED.ingestion_run_id, player_game_logs.ingestion_run_id)
"""

_TEAM_GAME_LOG_UPSERT_SQL = """
INSERT INTO team_game_logs (team_id, nba_game_id, season, season_type, game_date,
                            team_abbr, opponent_team_id, is_home, minutes, pts, reb,
                            ast, stl, blk, tov, fgm, fga, fg3m, fg3a, ftm, fta,
                            plus_minus, source, ingestion_run_id)
VALUES %s
ON CONFLICT (team_id, nba_game_id) DO UPDATE SET
    season = EXCLUDED.season,
    season_type = EXCLUDED.season_type,
    game_date = EXCLUDED.game_date,
    team_abbr = COALESCE(EXCLUDED.team_abbr, team_game_logs.team_abbr),
    opponent_team_id = COALESCE(EXCLUDED.opponent_team_id, team_game_logs.opponent_team_id),
    is_home = COALESCE(EXCLUDED.is_home, team_game_logs.is_home),
    minutes = EXCLUDED.minutes,
    pts = EXCLUDED.pts, reb = EXCLUDED.reb, ast = EXCLUDED.ast,
    stl = EXCLUDED.stl, blk = EXCLUDED.blk, tov = EXCLUDED.tov,
    fgm = EXCLUDED.fgm, fga = EXCLUDED.fga,
    fg3m = EXCLUDED.fg3m, fg3a = EXCLUDED.fg3a,
    ftm = EXCLUDED.ftm, fta = EXCLUDED.fta,
    plus_minus = EXCLUDED.plus_minus,
    source = EXCLUDED.source,
    fetched_at = NOW(),
    ingestion_run_id = COALESCE(EXCLUDED.ingestion_run_id, team_game_logs.ingestion_run_id)
"""

_GAME_STATUS_UPSERT_SQL = """
INSERT INTO player_game_status (nba_player_id, nba_game_id, team_id, rostered,
                                listed_inactive, started, played, dnp_reason,
                                minutes, source, ingestion_run_id)
VALUES %s
ON CONFLICT (nba_player_id, nba_game_id) DO UPDATE SET
    team_id = COALESCE(EXCLUDED.team_id, player_game_status.team_id),
    rostered = EXCLUDED.rostered,
    -- COALESCE so a later pass that only has game logs cannot reset a known
    -- inactive flag back to "unknown".
    listed_inactive = COALESCE(EXCLUDED.listed_inactive, player_game_status.listed_inactive),
    started = COALESCE(EXCLUDED.started, player_game_status.started),
    played = EXCLUDED.played,
    dnp_reason = COALESCE(EXCLUDED.dnp_reason, player_game_status.dnp_reason),
    minutes = COALESCE(EXCLUDED.minutes, player_game_status.minutes),
    source = EXCLUDED.source,
    fetched_at = NOW(),
    ingestion_run_id = COALESCE(EXCLUDED.ingestion_run_id, player_game_status.ingestion_run_id)
"""


def _upsert_schedule_rows(cur: object, rows: Sequence[Mapping]) -> int:
    tuples = [
        (
            r["nba_game_id"], r["season"], r["season_type"], r["game_date"],
            r["scheduled_at"], r["home_team_id"], r["away_team_id"],
            r["home_team_abbr"], r["away_team_abbr"], r["game_status"],
            r["postponed_status"], r["source"],
        )
        for r in rows
    ]
    return _batch_upsert(cur, _SCHEDULE_UPSERT_SQL, tuples)


def _upsert_game_status_rows(
    cur: object, rows: Sequence[Mapping], run_id: int | None
) -> int:
    tuples = [
        (
            r["nba_player_id"], r["nba_game_id"], r["team_id"], r["rostered"],
            r["listed_inactive"], r["started"], r["played"], r["dnp_reason"],
            r["minutes"], r["source"], run_id,
        )
        for r in rows
    ]
    return _batch_upsert(cur, _GAME_STATUS_UPSERT_SQL, tuples)


# ---------------------------------------------------------------------------
# Data truth layer — fetchers.
# ---------------------------------------------------------------------------


def _fetch_player_game_logs(
    season: str, date_from: date | None, season_type: str = SEASON_TYPE_REGULAR
) -> list[dict]:
    """League-wide player game logs, optionally bounded below by a date.

    One request covers every player for the whole window. Per-player calls would
    be ~570 requests for the same data.
    """

    def fetch() -> playergamelogs.PlayerGameLogs:
        return playergamelogs.PlayerGameLogs(
            season_nullable=season,
            season_type_nullable=season_type,
            date_from_nullable=date_from.strftime("%m/%d/%Y") if date_from else "",
            timeout=60,
        )

    logs = _fetch_with_retry(f"player game logs {season}", fetch)
    return logs.get_data_frames()[0].to_dict("records")


def _fetch_team_game_logs(
    season: str, date_from: date | None, season_type: str = SEASON_TYPE_REGULAR
) -> list[dict]:
    """League-wide team game logs — two rows per completed game."""

    def fetch() -> leaguegamelog.LeagueGameLog:
        return leaguegamelog.LeagueGameLog(
            season=season,
            season_type_all_star=season_type,
            player_or_team_abbreviation="T",
            date_from_nullable=date_from.strftime("%m/%d/%Y") if date_from else "",
            timeout=60,
        )

    logs = _fetch_with_retry(f"team game logs {season}", fetch)
    return logs.get_data_frames()[0].to_dict("records")


def _fetch_league_schedule(season: str) -> list[dict]:
    """Full-season schedule from scheduleleaguev2, including unplayed games.

    Imported lazily and behind an ImportError guard: this endpoint does not
    exist in older nba_api releases, and the caller falls back to reconstructing
    completed games from the team game log when it is missing.
    """
    from nba_api.stats.endpoints import scheduleleaguev2

    def fetch() -> object:
        return scheduleleaguev2.ScheduleLeagueV2(season=season, timeout=60)

    schedule = _fetch_with_retry(f"league schedule {season}", fetch)
    return schedule.season_games.get_data_frame().to_dict("records")


def _fetch_inactive_players(game_id: str, game_date: date | None) -> tuple[list[dict], str]:
    """The official inactive list for one game, plus which source produced it.

    BoxScoreSummaryV3 first: nba_api documents V2 as having no data for games on
    or after V2_INACTIVE_UNRELIABLE_FROM, and V2 raises a UserWarning on
    construction saying so. V2 remains the fallback for older games where V3
    coverage is patchy. Both expose an InactivePlayers result set;
    normalize_inactive_rows reconciles their column naming.

    Returns (rows, tag) where tag is 'v3', 'v2', or 'v2-suspect':
    - a successful V3 answer is trusted as-is for games past the V2 cutoff,
      INCLUDING a legitimately empty list — falling through to V2 there would
      let "V2 has no data" masquerade as "nobody was inactive";
    - a V2 answer for a game past the cutoff is tagged 'v2-suspect' so the
      rows stay identifiable and the validation report can flag them.
    """
    from nba_api.stats.endpoints import boxscoresummaryv2, boxscoresummaryv3

    def fetch_v3() -> object:
        return boxscoresummaryv3.BoxScoreSummaryV3(game_id=game_id, timeout=60)

    def fetch_v2() -> object:
        return boxscoresummaryv2.BoxScoreSummaryV2(game_id=game_id, timeout=60)

    v2_unreliable = v2_inactive_is_unreliable(game_date)

    try:
        summary = _fetch_with_retry(f"box score summary v3 {game_id}", fetch_v3)
        rows = summary.inactive_players.get_data_frame().to_dict("records")
        if rows or v2_unreliable:
            return rows, "v3"
    except Exception as e:  # noqa: BLE001 - v2 is the whole point of the fallback
        logger.debug("v3 summary failed for %s (%s), trying v2", game_id, e)

    time.sleep(BACKFILL_REQUEST_DELAY_SECONDS)
    summary = _fetch_with_retry(f"box score summary v2 {game_id}", fetch_v2)
    rows = summary.inactive_players.get_data_frame().to_dict("records")
    return rows, "v2-suspect" if v2_unreliable else "v2"


# ---------------------------------------------------------------------------
# Data truth layer — reads.
# ---------------------------------------------------------------------------


def _latest_logged_game_date(
    conn: psycopg2.extensions.connection, season: str
) -> date | None:
    """Newest game date already in player_game_logs for a season, or None."""
    cur = conn.cursor()
    try:
        cur.execute(
            "SELECT MAX(game_date) FROM player_game_logs WHERE season = %s", (season,)
        )
        row = cur.fetchone()
        return row[0] if row else None
    finally:
        cur.close()


def _games_needing_status(
    conn: psycopg2.extensions.connection,
    season: str,
    since: date | None,
    limit: int | None,
) -> list[str]:
    """Completed games with game logs but no player_game_status rows yet.

    Driven off team_game_logs rather than nba_schedule so it only ever returns
    games that actually finished — asking for the inactive list of a game that
    has not tipped off wastes a request and returns nothing.
    """
    sql = [
        """
        SELECT DISTINCT t.nba_game_id, t.game_date
          FROM team_game_logs t
         WHERE t.season = %s
           AND NOT EXISTS (
                 SELECT 1 FROM player_game_status s
                  WHERE s.nba_game_id = t.nba_game_id
               )
        """
    ]
    params: list[object] = [season]
    if since is not None:
        sql.append("AND t.game_date >= %s")
        params.append(since)
    sql.append("ORDER BY t.game_date DESC, t.nba_game_id")
    if limit is not None:
        sql.append("LIMIT %s")
        params.append(limit)

    cur = conn.cursor()
    try:
        cur.execute(" ".join(sql), tuple(params))
        # game_date rides along so the inactive-list fetch can judge whether a
        # V2 fallback answer is trustworthy for that game's era.
        return [(str(row[0]), row[1]) for row in cur.fetchall()]
    finally:
        cur.close()


def _played_rows_for_games(
    conn: psycopg2.extensions.connection, game_ids: Sequence[str]
) -> dict[str, list[dict]]:
    """player_game_logs rows for the given games, grouped by game id."""
    if not game_ids:
        return {}
    cur = conn.cursor()
    try:
        cur.execute(
            """
            SELECT nba_game_id, nba_player_id, team_id, started, minutes, dnp_reason
              FROM player_game_logs
             WHERE nba_game_id = ANY(%s)
            """,
            (list(game_ids),),
        )
        grouped: dict[str, list[dict]] = {}
        for game_id, player_id, team_id, started, minutes, dnp_reason in cur.fetchall():
            grouped.setdefault(str(game_id), []).append(
                {
                    "nba_player_id": str(player_id),
                    "team_id": team_id,
                    "started": started,
                    "minutes": float(minutes) if minutes is not None else None,
                    "dnp_reason": dnp_reason,
                }
            )
        return grouped
    finally:
        cur.close()


# ---------------------------------------------------------------------------
# Data truth layer — write paths.
# ---------------------------------------------------------------------------


def scrape_schedule(
    conn: psycopg2.extensions.connection,
    season: str = SEASON,
    dry_run: bool = False,
) -> None:
    """Upsert the current season's schedule into nba_schedule.

    Primary source is scheduleleaguev2, which publishes the whole season in
    advance — including tonight's game, which is the point. If it is unavailable
    (older nba_api, or the endpoint erroring) the completed half of the season is
    rebuilt from the team game log instead, and the gap is logged loudly rather
    than papered over: without future rows, same-day prediction has nothing to
    predict against.

    ESPN is deliberately NOT used as the fallback even though _fetch_espn_scoreboard
    already exists. ESPN keys on its own event ids, which do not join to any
    stats.nba.com game id, so ESPN rows in this table would be unjoinable to
    every game log and status row.
    """
    logger.info("truth layer: syncing %s schedule...", season)
    run_id = _start_ingestion_run(
        conn, "schedule", watermark_from=season, watermark_to=season, dry_run=dry_run
    )

    rows: list[dict] = []
    try:
        rows = schedule_rows_from_league_schedule(_fetch_league_schedule(season), season)
        logger.info("schedule: %d game(s) from scheduleleaguev2", len(rows))
    except Exception as e:  # noqa: BLE001 - falling back is the handling
        logger.warning(
            "scheduleleaguev2 unavailable (%s); falling back to completed games "
            "from the team game log — upcoming games will be missing until it "
            "recovers",
            e,
        )
        try:
            team_rows = _fetch_team_game_logs(season, None)
            rows = schedule_rows_from_team_logs(team_rows, season)
            logger.info("schedule: %d completed game(s) from leaguegamelog", len(rows))
        except Exception as fallback_error:  # noqa: BLE001
            logger.error("schedule: both sources failed (%s)", fallback_error)
            _finish_ingestion_run(
                conn, run_id, "failed", 0, notes=str(fallback_error)[:500]
            )
            return

    cur = maybe_write_cursor(conn.cursor(), dry_run)
    try:
        written = _upsert_schedule_rows(cur, rows)
    finally:
        cur.close()

    _finish_ingestion_run(conn, run_id, "succeeded", written)
    logger.info(
        "schedule: %d row(s) upserted%s",
        written,
        " (dry run: nothing written)" if dry_run else "",
    )


def scrape_game_logs(
    conn: psycopg2.extensions.connection,
    season: str = SEASON,
    dry_run: bool = False,
) -> None:
    """Incremental player + team game-log sync for the current season.

    Watermarked on MAX(game_date) in player_game_logs, walked back by a trailing
    correction window so revised box scores are re-read. Two requests total,
    regardless of how far behind the watermark is.
    """
    latest = _latest_logged_game_date(conn, season)
    date_from = game_log_fetch_from(latest, season)
    logger.info(
        "truth layer: syncing %s game logs from %s (watermark %s)",
        season,
        date_from.isoformat(),
        latest.isoformat() if latest else "none",
    )

    run_id = _start_ingestion_run(
        conn,
        "game_logs_incremental",
        watermark_from=date_from.isoformat(),
        dry_run=dry_run,
    )

    try:
        player_raw = _fetch_player_game_logs(season, date_from)
        time.sleep(BACKFILL_REQUEST_DELAY_SECONDS)
        team_raw = _fetch_team_game_logs(season, date_from)
    except Exception as e:  # noqa: BLE001 - one phase failing must not end the run
        logger.error("game logs: fetch failed (%s)", e)
        _finish_ingestion_run(conn, run_id, "failed", 0, notes=str(e)[:500])
        return

    player_rows = [
        row
        for row in (build_player_game_log_row(raw, season, run_id) for raw in player_raw)
        if row is not None
    ]
    team_rows = [
        row
        for row in (build_team_game_log_row(raw, season, run_id) for raw in team_raw)
        if row is not None
    ]

    cur = maybe_write_cursor(conn.cursor(), dry_run)
    try:
        written = _batch_upsert(cur, _PLAYER_GAME_LOG_UPSERT_SQL, player_rows)
        written += _batch_upsert(cur, _TEAM_GAME_LOG_UPSERT_SQL, team_rows)
    finally:
        cur.close()

    # game_date sits at index 4 of the player tuple; see PLAYER_GAME_LOG column order
    newest = max((row[4] for row in player_rows), default=latest)
    _finish_ingestion_run(
        conn,
        run_id,
        "succeeded",
        written,
        watermark_to=newest.isoformat() if newest else None,
    )
    logger.info(
        "game logs: %d player row(s), %d team row(s) upserted%s",
        len(player_rows),
        len(team_rows),
        " (dry run: nothing written)" if dry_run else "",
    )

    _sync_player_team_stints(conn, season, dry_run=dry_run)


def scrape_game_status(
    conn: psycopg2.extensions.connection,
    season: str = SEASON,
    dry_run: bool = False,
    since: date | None = None,
    limit: int | None = GAME_STATUS_MAX_GAMES_PER_RUN,
    delay_seconds: float = BACKFILL_REQUEST_DELAY_SECONDS,
    run_kind: str = "game_status_incremental",
) -> int:
    """Build player_game_status rows for completed games that lack them.

    This is the expensive phase — one request per game — so the incremental path
    is bounded twice over: to games in the recent window, and to a hard ceiling
    on games per run. Anything older is the backfill's job.

    Resumable by construction: a game is selected only if it has no status rows
    at all, so a killed run picks up exactly where it stopped.

    Returns the number of status rows written.
    """
    if since is None:
        since = date.today() - timedelta(days=GAME_STATUS_RECENT_WINDOW_DAYS)

    games = _games_needing_status(conn, season, since, limit)
    if not games:
        logger.info("game status: nothing to do, every recent game has status rows")
        return 0

    logger.info("truth layer: deriving status for %d game(s)", len(games))
    run_id = _start_ingestion_run(
        conn,
        run_kind,
        watermark_from=since.isoformat() if since else None,
        dry_run=dry_run,
    )

    played_by_game = _played_rows_for_games(conn, [gid for gid, _ in games])
    written = 0
    failed = 0
    suspect = 0

    cur = maybe_write_cursor(conn.cursor(), dry_run)
    try:
        for index, (game_id, game_date) in enumerate(games):
            try:
                inactive_raw, inactive_src = _fetch_inactive_players(game_id, game_date)
            except Exception as e:  # noqa: BLE001 - one game must not end the phase
                failed += 1
                logger.warning("game status: %s inactive list failed (%s)", game_id, e)
                # almost always throttling, so back off harder before the next
                time.sleep(delay_seconds * 2)
                continue

            if inactive_src == "v2-suspect":
                suspect += 1
                logger.warning(
                    "game status: %s inactive list came from BoxScoreSummaryV2 past its "
                    "data cutoff — rows tagged suspect; the validation report lists them",
                    game_id,
                )

            rows = derive_game_status_rows(
                game_id,
                played_by_game.get(game_id, []),
                inactive_raw,
                f"boxscoresummary{inactive_src}+playergamelogs",
            )
            written += _upsert_game_status_rows(cur, rows, run_id)

            # the inactive-list crawl runs for hours at this pacing; a silent
            # loop is indistinguishable from a hang, so report every 25 games.
            done = index + 1
            if done % 25 == 0 or done == len(games):
                remaining = len(games) - done
                eta_min = remaining * delay_seconds / 60
                logger.info(
                    "game status: %d/%d games (%d rows, %d failed, %d suspect, ~%.0f min left)",
                    done, len(games), written, failed, suspect, eta_min,
                )

            if index + 1 < len(games):
                time.sleep(delay_seconds)
    finally:
        cur.close()

    run_notes: list[str] = []
    if failed:
        run_notes.append(f"{failed} game(s) failed")
    if suspect:
        run_notes.append(f"{suspect} game(s) tagged v2-suspect")
    _finish_ingestion_run(
        conn,
        run_id,
        "succeeded" if failed == 0 else "partial",
        written,
        notes="; ".join(run_notes) if run_notes else None,
    )
    logger.info(
        "game status: %d row(s) across %d game(s), %d failed, %d suspect%s",
        written,
        len(games) - failed,
        failed,
        suspect,
        " (dry run: nothing written)" if dry_run else "",
    )
    return written


def _sync_player_team_stints(
    conn: psycopg2.extensions.connection, season: str, dry_run: bool = False
) -> None:
    """Close and open player_team_stints rows from the latest game logs.

    Incremental and cheap: one query returns every player's current team plus
    the dates needed to close the previous stint, and plan_stint_change decides
    per player whether anything actually changed. In a normal run that is zero
    changes; on a trade deadline it is a handful.
    """
    cur = conn.cursor()
    try:
        # DISTINCT ON gives the newest game-log row per player, which is the team
        # he currently belongs to as far as the truth layer can observe.
        cur.execute(
            """
            SELECT DISTINCT ON (nba_player_id)
                   nba_player_id, team_id, game_date
              FROM player_game_logs
             WHERE season = %s AND team_id IS NOT NULL
             ORDER BY nba_player_id, game_date DESC, nba_game_id DESC
            """,
            (season,),
        )
        latest_by_player = {
            str(pid): (str(team_id), game_date) for pid, team_id, game_date in cur.fetchall()
        }

        cur.execute(
            """
            SELECT nba_player_id, team_id, valid_from
              FROM player_team_stints
             WHERE valid_to IS NULL
            """
        )
        open_by_player = {
            str(pid): (str(team_id), valid_from) for pid, team_id, valid_from in cur.fetchall()
        }
    finally:
        cur.close()

    changes: list[tuple[str, dict]] = []
    for player_id, (team_id, _latest_date) in latest_by_player.items():
        open_stint = open_by_player.get(player_id)
        if open_stint is not None and open_stint[0] == team_id:
            continue

        boundaries = _stint_boundaries(conn, player_id, team_id, open_stint)
        change = plan_stint_change(
            open_stint,
            team_id,
            boundaries["first_with_new_team"],
            boundaries["last_with_open_team"],
        )
        if change is not None:
            changes.append((player_id, change))

    if not changes:
        logger.info("stints: no team changes to record")
        return

    write_cur = maybe_write_cursor(conn.cursor(), dry_run)
    try:
        for player_id, change in changes:
            if change["close_team_id"] is not None:
                write_cur.execute(
                    """
                    UPDATE player_team_stints
                       SET valid_to = %s, updated_at = NOW()
                     WHERE nba_player_id = %s AND team_id = %s
                       AND valid_from = %s AND valid_to IS NULL
                    """,
                    (
                        change["close_valid_to"],
                        player_id,
                        change["close_team_id"],
                        change["close_valid_from"],
                    ),
                )
            write_cur.execute(
                """
                INSERT INTO player_team_stints (nba_player_id, team_id, valid_from, source)
                VALUES (%s, %s, %s, 'playergamelogs')
                ON CONFLICT (nba_player_id, team_id, valid_from) DO NOTHING
                """,
                (player_id, change["open_team_id"], change["open_valid_from"]),
            )
    finally:
        write_cur.close()

    logger.info(
        "stints: recorded %d team change(s)%s",
        len(changes),
        " (dry run: nothing written)" if dry_run else "",
    )


def _stint_boundaries(
    conn: psycopg2.extensions.connection,
    player_id: str,
    new_team_id: str,
    open_stint: tuple[str, date] | None,
) -> dict:
    """First game date with the new team, and last with the currently open one."""
    cur = conn.cursor()
    try:
        cur.execute(
            """
            SELECT MIN(game_date) FROM player_game_logs
             WHERE nba_player_id = %s AND team_id = %s AND game_date >= %s
            """,
            (player_id, new_team_id, open_stint[1] if open_stint else date.min),
        )
        row = cur.fetchone()
        first_with_new = row[0] if row and row[0] else date.today()

        last_with_open: date | None = None
        if open_stint is not None:
            cur.execute(
                """
                SELECT MAX(game_date) FROM player_game_logs
                 WHERE nba_player_id = %s AND team_id = %s AND game_date >= %s
                """,
                (player_id, open_stint[0], open_stint[1]),
            )
            row = cur.fetchone()
            last_with_open = row[0] if row else None

        return {
            "first_with_new_team": first_with_new,
            "last_with_open_team": last_with_open,
        }
    finally:
        cur.close()


# ---------------------------------------------------------------------------
# Data truth layer — historical backfill.
# ---------------------------------------------------------------------------


def backfill_game_logs_season(
    conn: psycopg2.extensions.connection,
    season: str,
    dry_run: bool = False,
    delay_seconds: float = BACKFILL_REQUEST_DELAY_SECONDS,
) -> dict:
    """Backfill one season: schedule, game logs, then per-game inactive lists.

    Ordered cheapest-first on purpose. The two league-wide calls at the top cost
    one request each and give the schedule, the team logs, and every player log
    for the season. Only the inactive lists need a request per game, and by then
    the schedule already exists — so a run killed during that phase has already
    banked the expensive-to-lose part, and the next run skips every game that
    already has status rows.
    """
    logger.info("%s: fetching team game logs...", season)
    team_raw = _fetch_team_game_logs(season, None)
    time.sleep(delay_seconds)
    logger.info("%s: fetching player game logs...", season)
    player_raw = _fetch_player_game_logs(season, None)

    run_id = _start_ingestion_run(
        conn,
        "game_logs_backfill",
        watermark_from=season,
        watermark_to=season,
        dry_run=dry_run,
    )

    schedule_rows = schedule_rows_from_team_logs(team_raw, season)
    player_rows = [
        row
        for row in (build_player_game_log_row(raw, season, run_id) for raw in player_raw)
        if row is not None
    ]
    team_rows = [
        row
        for row in (build_team_game_log_row(raw, season, run_id) for raw in team_raw)
        if row is not None
    ]

    cur = maybe_write_cursor(conn.cursor(), dry_run)
    try:
        schedule_written = _upsert_schedule_rows(cur, schedule_rows)
        log_written = _batch_upsert(cur, _PLAYER_GAME_LOG_UPSERT_SQL, player_rows)
        log_written += _batch_upsert(cur, _TEAM_GAME_LOG_UPSERT_SQL, team_rows)
    finally:
        cur.close()

    logger.info(
        "%s: %d schedule row(s), %d player log(s), %d team log(s)",
        season, schedule_written, len(player_rows), len(team_rows),
    )
    _finish_ingestion_run(
        conn, run_id, "succeeded", schedule_written + log_written
    )

    # unbounded window and no per-run ceiling here: the backfill's whole job is
    # to work through every game the season has.
    status_written = scrape_game_status(
        conn,
        season=season,
        dry_run=dry_run,
        since=season_start_date(season),
        limit=None,
        delay_seconds=delay_seconds,
        run_kind="game_status_backfill",
    )

    return {
        "schedule": schedule_written,
        "player_logs": len(player_rows),
        "team_logs": len(team_rows),
        "status": status_written,
    }


def backfill_game_logs(
    conn: psycopg2.extensions.connection,
    from_season: str,
    to_season: str,
    dry_run: bool = False,
) -> None:
    """One-time truth-layer backfill over a range of seasons.

    Opt-in only and never part of the cron, for the same reasons
    --backfill-history is not: stats.nba.com is Akamai-blocked from CI and
    throttles residential IPs. Per-season failure is tolerated so one bad season
    does not cost the whole run.

    Budget roughly 1,230 games per season at BACKFILL_REQUEST_DELAY_SECONDS
    apiece for the inactive-list phase — about 2 hours per season, longer with
    retries.
    """
    seasons = season_range(from_season, to_season)
    logger.info(
        "truth-layer backfill: %d season(s), %s -> %s%s",
        len(seasons), seasons[0], seasons[-1], " (dry run)" if dry_run else "",
    )

    succeeded: list[str] = []
    failed: list[str] = []

    for season in seasons:
        try:
            counts = backfill_game_logs_season(conn, season, dry_run=dry_run)
        except Exception as e:  # noqa: BLE001 - one season must not end the run
            failed.append(season)
            logger.error("%s: failed, moving on (%s)", season, e)
            time.sleep(BACKFILL_REQUEST_DELAY_SECONDS * 4)
            continue

        succeeded.append(season)
        logger.info(
            "%s: done — %d schedule, %d player logs, %d team logs, %d status",
            season, counts["schedule"], counts["player_logs"],
            counts["team_logs"], counts["status"],
        )

    logger.info(
        "truth-layer backfill summary: %d succeeded, %d failed",
        len(succeeded), len(failed),
    )
    if failed:
        logger.info("failed (re-run to retry): %s", ", ".join(failed))


# ---------------------------------------------------------------------------
# Data truth layer — validation.
# ---------------------------------------------------------------------------


def _scalar(conn: psycopg2.extensions.connection, sql: str, params: tuple = ()) -> object:
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        row = cur.fetchone()
        return row[0] if row else None
    finally:
        cur.close()


def _rows(conn: psycopg2.extensions.connection, sql: str, params: tuple = ()) -> list[tuple]:
    cur = conn.cursor()
    try:
        cur.execute(sql, params)
        return cur.fetchall()
    finally:
        cur.close()


def _report_examples(label: str, rows: Sequence[tuple]) -> None:
    """Print a rule's offenders, capped, so a broken season is diagnosable."""
    if not rows:
        logger.info("    %-42s OK", label)
        return
    logger.warning("    %-42s %d offender(s)", label, len(rows))
    for row in rows[:VALIDATION_MAX_EXAMPLES]:
        logger.warning("        %s", ", ".join(str(v) for v in row))
    if len(rows) > VALIDATION_MAX_EXAMPLES:
        logger.warning("        ... and %d more", len(rows) - VALIDATION_MAX_EXAMPLES)


def validate_game_logs(
    conn: psycopg2.extensions.connection, from_season: str, to_season: str
) -> None:
    """Read-only integrity report over the truth layer, one section per season.

    Writes nothing and takes no locks — safe to run against prod while the cron
    is mid-scrape. Every check is phrased so that "OK" means the invariant held,
    not merely that the query returned.
    """
    seasons = season_range(from_season, to_season)
    logger.info("truth-layer validation: %s -> %s", seasons[-1], seasons[0])

    for season in seasons:
        games = _scalar(
            conn,
            "SELECT COUNT(DISTINCT nba_game_id) FROM team_game_logs WHERE season = %s",
            (season,),
        )
        player_logs = _scalar(
            conn, "SELECT COUNT(*) FROM player_game_logs WHERE season = %s", (season,)
        )
        status_rows = _scalar(
            conn,
            """
            SELECT COUNT(*) FROM player_game_status s
             WHERE EXISTS (SELECT 1 FROM team_game_logs t
                            WHERE t.nba_game_id = s.nba_game_id AND t.season = %s)
            """,
            (season,),
        )

        logger.info("")
        logger.info(
            "%s: %s completed game(s), %s player log(s), %s status row(s)",
            season, games, player_logs, status_rows,
        )
        if not games:
            logger.info("    (nothing stored for this season)")
            continue

        _report_examples(
            "team rows per game == 2",
            _rows(
                conn,
                """
                SELECT nba_game_id, COUNT(*) FROM team_game_logs
                 WHERE season = %s GROUP BY nba_game_id HAVING COUNT(*) <> 2
                 ORDER BY nba_game_id
                """,
                (season,),
            ),
        )
        # the UNIQUE constraint makes this impossible; checked anyway, because a
        # constraint that was never applied to this database is not a constraint.
        _report_examples(
            "no duplicate (player, game) keys",
            _rows(
                conn,
                """
                SELECT nba_player_id, nba_game_id, COUNT(*) FROM player_game_logs
                 WHERE season = %s GROUP BY nba_player_id, nba_game_id HAVING COUNT(*) > 1
                """,
                (season,),
            ),
        )
        # inactive lists sourced from BoxScoreSummaryV2 past its data cutoff:
        # the rows exist but their listed_inactive flags cannot be trusted.
        # fix: delete these games' status rows and re-run the backfill once v3
        # answers for them (the backfill re-fetches games with no status rows).
        _report_examples(
            "no status rows sourced from v2 past its data cutoff (v2-suspect)",
            _rows(
                conn,
                """
                SELECT DISTINCT s.nba_game_id, s.source FROM player_game_status s
                 WHERE s.source LIKE '%%v2-suspect%%'
                   AND EXISTS (SELECT 1 FROM team_game_logs t
                                WHERE t.nba_game_id = s.nba_game_id AND t.season = %s)
                 ORDER BY s.nba_game_id
                """,
                (season,),
            ),
        )
        # a game where nobody at all was listed inactive is possible but rare;
        # a cluster of them is the signature of an empty-because-no-data source.
        _report_examples(
            "games whose status rows list zero inactive players (verify if many)",
            _rows(
                conn,
                """
                SELECT s.nba_game_id,
                       COUNT(*) FILTER (WHERE s.listed_inactive) AS inactives
                  FROM player_game_status s
                 WHERE EXISTS (SELECT 1 FROM team_game_logs t
                                WHERE t.nba_game_id = s.nba_game_id AND t.season = %s)
                 GROUP BY s.nba_game_id
                HAVING COUNT(*) FILTER (WHERE s.listed_inactive) = 0
                 ORDER BY s.nba_game_id
                """,
                (season,),
            ),
        )

        for name, left, right in BOX_SCORE_RULES:
            _report_examples(
                f"{left} <= {right}",
                _rows(
                    conn,
                    f"""
                    SELECT nba_player_id, nba_game_id, {left}, {right}
                      FROM player_game_logs
                     WHERE season = %s AND {left} IS NOT NULL AND {right} IS NOT NULL
                       AND {left} > {right}
                     ORDER BY nba_game_id
                    """,
                    (season,),
                ),
            )

        _report_examples(
            f"player pts sum == team pts (+/-{VALIDATION_POINTS_TOLERANCE})",
            _rows(
                conn,
                """
                SELECT t.nba_game_id, t.team_id, t.pts, COALESCE(p.player_pts, 0)
                  FROM team_game_logs t
                  LEFT JOIN (
                        SELECT nba_game_id, team_id, SUM(pts) AS player_pts
                          FROM player_game_logs
                         WHERE season = %s
                         GROUP BY nba_game_id, team_id
                       ) p
                    ON p.nba_game_id = t.nba_game_id AND p.team_id = t.team_id
                 WHERE t.season = %s AND t.pts IS NOT NULL
                   AND ABS(t.pts - COALESCE(p.player_pts, 0)) > %s
                 ORDER BY t.nba_game_id
                """,
                (season, season, VALIDATION_POINTS_TOLERANCE),
            ),
        )
        _report_examples(
            "completed schedule games have logs",
            _rows(
                conn,
                """
                SELECT s.nba_game_id, s.game_date, s.home_team_abbr, s.away_team_abbr
                  FROM nba_schedule s
                 WHERE s.season = %s
                   AND s.game_date < CURRENT_DATE
                   AND s.postponed_status IS NULL
                   AND NOT EXISTS (SELECT 1 FROM team_game_logs t
                                    WHERE t.nba_game_id = s.nba_game_id)
                 ORDER BY s.game_date
                """,
                (season,),
            ),
        )
        _report_examples(
            "completed games have status rows",
            _rows(
                conn,
                """
                SELECT DISTINCT t.nba_game_id, t.game_date
                  FROM team_game_logs t
                 WHERE t.season = %s
                   AND NOT EXISTS (SELECT 1 FROM player_game_status s
                                    WHERE s.nba_game_id = t.nba_game_id)
                 ORDER BY t.game_date
                """,
                (season,),
            ),
        )

    logger.info("")
    logger.info("storage:")
    for table in TRUTH_LAYER_TABLES:
        # to_regclass returns NULL instead of erroring when migration 013 has
        # not been applied to whichever database this is pointed at.
        size = _scalar(
            conn,
            "SELECT pg_size_pretty(pg_total_relation_size(to_regclass(%s)))",
            (table,),
        )
        logger.info("    %-24s %s", table, size or "not present")


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="NBA stats scraper")
    # Mutually exclusive so `--dev --prod` is rejected rather than silently
    # picking one. Default is prod, which keeps the un-flagged cron unchanged.
    target = parser.add_mutually_exclusive_group()
    target.add_argument(
        "--dev",
        dest="target",
        action="store_const",
        const=TARGET_DEV,
        help="write to the dev Neon branch (uses DATABASE_URL_DEV)",
    )
    target.add_argument(
        "--prod",
        dest="target",
        action="store_const",
        const=TARGET_PROD,
        help="write to the prod database (uses DATABASE_URL, the default)",
    )
    parser.set_defaults(target=TARGET_PROD)
    parser.add_argument(
        "--backfill-history",
        action="store_true",
        help="run the one-time historical season backfill instead of the normal scrape",
    )
    parser.add_argument(
        "--from",
        dest="from_season",
        default=BACKFILL_DEFAULT_FROM_SEASON,
        help=f"oldest season to attempt, e.g. 1979-80 (default {BACKFILL_DEFAULT_FROM_SEASON})",
    )
    parser.add_argument(
        "--to",
        dest="to_season",
        default=SEASON,
        help=f"newest season to attempt, e.g. 2025-26 (default {SEASON})",
    )
    parser.add_argument(
        "--sync-2k",
        dest="sync_2k",
        action="store_true",
        help="sync NBA 2K ratings instead of the normal scrape",
    )
    parser.add_argument(
        "--team-types",
        dest="team_types",
        default=NBA_2K_DEFAULT_TEAM_TYPES,
        help=(
            "comma-separated 2K roster types to sync: "
            f"{', '.join(NBA_2K_TEAM_TYPES)} (default {NBA_2K_DEFAULT_TEAM_TYPES})"
        ),
    )
    parser.add_argument(
        "--backfill-game-logs",
        dest="backfill_game_logs",
        action="store_true",
        help=(
            "run the one-time truth-layer backfill (schedule, game logs, "
            "per-game inactive lists) instead of the normal scrape; honours "
            f"--from/--to, defaulting to {BACKFILL_GAME_LOGS_DEFAULT_FROM_SEASON}"
        ),
    )
    parser.add_argument(
        "--validate-game-logs",
        dest="validate_game_logs",
        action="store_true",
        help="print a read-only truth-layer integrity report and exit",
    )
    parser.add_argument(
        "--dry-run",
        dest="dry_run",
        action="store_true",
        help="log what would be written and write nothing (reads still run)",
    )
    return parser.parse_args(argv)


def _truth_layer_season_bounds(args: argparse.Namespace) -> tuple[str, str]:
    """--from/--to for the truth-layer commands.

    They share the flags with --backfill-history, whose default reaches back to
    1979-80. Honouring that here would ask for 45 seasons of per-game inactive
    lists, so an untouched --from falls back to the truth layer's own default.
    """
    from_season = args.from_season
    if from_season == BACKFILL_DEFAULT_FROM_SEASON:
        from_season = BACKFILL_GAME_LOGS_DEFAULT_FROM_SEASON
    return from_season, args.to_season


def _run_phase(name: str, phase: Callable[[], None]) -> None:
    """Run one scrape phase, logging and swallowing its failure.

    Each phase is independent: a stats.nba.com outage during the game-log sync
    must not cost the injury scrape that would have run after it.
    """
    try:
        phase()
    except Exception as e:  # noqa: BLE001 - independence is the whole point
        logger.error("%s failed, continuing (%s)", name, e)


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)

    truth_from, truth_to = _truth_layer_season_bounds(args)

    if args.backfill_history:
        try:
            season_range(args.from_season, args.to_season)
        except ValueError as e:
            logger.error("%s", e)
            sys.exit(2)

    if args.backfill_game_logs or args.validate_game_logs:
        try:
            season_range(truth_from, truth_to)
        except ValueError as e:
            logger.error("%s", e)
            sys.exit(2)

    team_types: list[str] = []
    if args.sync_2k:
        try:
            team_types = parse_team_types(args.team_types)
        except ValueError as e:
            logger.error("%s", e)
            sys.exit(2)

    if args.dry_run:
        logger.info("--dry-run: reads will run, writes will be counted and skipped")

    conn = get_db(args.target)
    try:
        if args.backfill_history:
            backfill_history(conn, args.from_season, args.to_season)
        elif args.backfill_game_logs:
            backfill_game_logs(conn, truth_from, truth_to, dry_run=args.dry_run)
        elif args.validate_game_logs:
            validate_game_logs(conn, truth_from, truth_to)
        elif args.sync_2k:
            sync_2k_ratings(conn, team_types)
        else:
            scrape_players(conn, dry_run=args.dry_run)
            scrape_teams(conn, dry_run=args.dry_run)
            scrape_scoreboard(conn, dry_run=args.dry_run)
            scrape_injuries(conn, dry_run=args.dry_run)
            # truth layer runs last: it is the newest and least battle-tested
            # part of the cron, and the four scrapes above back user-visible
            # pages that must not be held hostage to it.
            _run_phase("schedule", lambda: scrape_schedule(conn, dry_run=args.dry_run))
            _run_phase("game logs", lambda: scrape_game_logs(conn, dry_run=args.dry_run))
            _run_phase(
                "game status", lambda: scrape_game_status(conn, dry_run=args.dry_run)
            )
    finally:
        conn.close()

    logger.info("all done!")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    main()
