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
"""

import argparse
import json
import logging
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timedelta
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

_SEASON_PATTERN = re.compile(r"^(\d{4})-\d{2}$")

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


def scrape_players(conn: psycopg2.extensions.connection) -> None:
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

    cur = conn.cursor()
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


def scrape_teams(conn: psycopg2.extensions.connection) -> None:
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

    cur = conn.cursor()
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


def scrape_scoreboard(conn: psycopg2.extensions.connection) -> None:
    """Fetch games from ESPN for a rolling 10-day window (2 days back, 7 days ahead)."""
    logger.info("fetching games from ESPN (2 days back → 7 days ahead)...")

    et = ZoneInfo("America/New_York")
    today = datetime.now(et)

    cur = conn.cursor()
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


def scrape_injuries(conn: psycopg2.extensions.connection) -> None:
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

    cur = conn.cursor()
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

            if player_name:
                cur.execute(
                    """
                    UPDATE players SET injury_status = %s, injury_detail = %s,
                        updated_at = NOW()
                    WHERE LOWER(name) = LOWER(%s)
                    """,
                    (
                        injury_status or "Day-To-Day",
                        injury_detail or "Unknown",
                        player_name,
                    ),
                )
                if cur.rowcount > 0:
                    count += 1

    cur.close()
    logger.info("updated %d player injuries", count)


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
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = _parse_args(argv)

    if args.backfill_history:
        try:
            season_range(args.from_season, args.to_season)
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

    conn = get_db(args.target)
    try:
        if args.backfill_history:
            backfill_history(conn, args.from_season, args.to_season)
        elif args.sync_2k:
            sync_2k_ratings(conn, team_types)
        else:
            scrape_players(conn)
            scrape_teams(conn)
            scrape_scoreboard(conn)
            scrape_injuries(conn)
    finally:
        conn.close()

    logger.info("all done!")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    main()
