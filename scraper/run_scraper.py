"""
NBA Stats Scraper - uses nba_api package for reliable data fetching.

Usage:
    cd scraper/
    pip install -r requirements.txt
    python run_scraper.py
"""

import logging
import os
import re
import sys
import time
import unicodedata
from datetime import datetime, timedelta

import psycopg2
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from nba_api.stats.endpoints import (
    leaguedashplayerstats,
    leaguedashteamstats,
    scoreboardv3,
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

SEASON = "2025-26"

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


def get_db() -> psycopg2.extensions.connection:
    url = os.getenv("DATABASE_URL")
    if not url:
        logger.error("DATABASE_URL not set in .env")
        sys.exit(1)
    conn = psycopg2.connect(url)
    conn.autocommit = True
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
        abbr = row.get("TEAM_ABBREVIATION", "")
        meta = TEAM_META.get(abbr, {})
        ratings = adv_ratings.get(team_id, {})

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


def _fetch_scoreboard_for_date(
    conn: psycopg2.extensions.connection,
    date_str: str,
    cur: psycopg2.extensions.cursor,
) -> int:
    """fetch and upsert games for a single date using ScoreboardV3. returns count upserted."""
    try:
        sb = scoreboardv3.ScoreboardV3(
            game_date=date_str,
            league_id="00",
            timeout=60,
        )
        data = sb.get_dict()
        games_data = data.get("scoreboard", {}).get("games", [])
    except Exception as e:
        logger.error("error fetching %s: %s", date_str, e)
        return 0

    if not games_data:
        return 0

    count = 0
    for g in games_data:
        game_id = str(g.get("gameId", ""))

        home = g.get("homeTeam", {})
        away = g.get("awayTeam", {})

        home_team_name = (
            f"{home.get('teamCity', '')} {home.get('teamName', '')}".strip() or "Unknown"
        )
        away_team_name = (
            f"{away.get('teamCity', '')} {away.get('teamName', '')}".strip() or "Unknown"
        )

        # gameStatus: 1=scheduled, 2=live, 3=final
        game_status = g.get("gameStatus", 1)
        game_status_text = str(g.get("gameStatusText", "")).strip()

        if game_status == 1:
            status = game_status_text if game_status_text else "Scheduled"
        elif game_status == 2:
            status = "In Progress"
        else:
            status = "Final"

        game_time_utc = g.get("gameTimeUTC", "") or g.get("gameEt", "")
        try:
            game_date_val = datetime.strptime(game_time_utc[:10], "%Y-%m-%d").strftime(
                "%Y-%m-%d"
            )
        except (ValueError, TypeError):
            try:
                game_date_val = datetime.strptime(date_str, "%m/%d/%Y").strftime(
                    "%Y-%m-%d"
                )
            except ValueError:
                game_date_val = datetime.now().strftime("%Y-%m-%d")

        # don't store score for unstarted games
        if game_status == 1:
            home_score = None
            away_score = None
        else:
            try:
                home_score = int(home.get("score", 0))
            except (ValueError, TypeError):
                home_score = None
            try:
                away_score = int(away.get("score", 0))
            except (ValueError, TypeError):
                away_score = None

        cur.execute(
            """
            INSERT INTO games (nba_game_id, home_team, away_team, game_date,
                               home_score, away_score, status, arena, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (nba_game_id) DO UPDATE SET
                home_team = EXCLUDED.home_team, away_team = EXCLUDED.away_team,
                game_date = EXCLUDED.game_date, home_score = EXCLUDED.home_score,
                away_score = EXCLUDED.away_score, status = EXCLUDED.status,
                arena = EXCLUDED.arena, updated_at = NOW()
            """,
            (
                game_id,
                home_team_name,
                away_team_name,
                game_date_val,
                home_score,
                away_score,
                status,
                "",
            ),
        )
        count += 1

    return count


def scrape_scoreboard(conn: psycopg2.extensions.connection) -> None:
    logger.info("fetching games (yesterday, today, next 3 days)...")
    time.sleep(2)

    cur = conn.cursor()
    total = 0
    today = datetime.now()

    for offset in range(-1, 4):
        d = today + timedelta(days=offset)
        date_str = d.strftime("%m/%d/%Y")
        label = d.strftime("%Y-%m-%d")
        count = _fetch_scoreboard_for_date(conn, date_str, cur)
        if count > 0:
            logger.info("%s: %d games", label, count)
        total += count
        time.sleep(1)  # rate limit between days

    cur.execute("DELETE FROM games WHERE nba_game_id IS NULL")
    deleted = cur.rowcount
    if deleted > 0:
        logger.info("cleaned up %d old seed games", deleted)

    cur.close()
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


def main() -> None:
    conn = get_db()

    scrape_players(conn)
    scrape_teams(conn)
    scrape_scoreboard(conn)
    scrape_injuries(conn)

    conn.close()
    logger.info("all done!")


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    main()
