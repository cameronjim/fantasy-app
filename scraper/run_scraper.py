"""
NBA Stats Scraper - uses nba_api package for reliable data fetching.

Usage:
    cd scraper/
    pip install -r requirements.txt
    python run_scraper.py
"""

import os
import sys
import time
import psycopg2
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

# Load .env from project root
env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")
load_dotenv(dotenv_path=env_path)

from nba_api.stats.endpoints import (
    leaguedashplayerstats,
    leaguedashteamstats,
)
from nba_api.live.nba.endpoints import scoreboard as live_scoreboard
from nba_api.stats.endpoints import scoreboardv2
from nba_api.stats.static import teams as nba_teams
from datetime import datetime


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


def get_db():
    url = os.getenv("DATABASE_URL")
    if not url:
        print("ERROR: DATABASE_URL not set in .env")
        sys.exit(1)
    conn = psycopg2.connect(url)
    conn.autocommit = True
    return conn


def pct(val):
    """Convert 0.456 -> 45.6"""
    if val is None:
        return 0.0
    return round(float(val) * 100, 1)


def safe_float(val):
    if val is None:
        return 0.0
    return round(float(val), 1)


def _normalize_name(name):
    """Strip accents, suffixes, and punctuation for fuzzy name matching."""
    import unicodedata
    # Decompose unicode and strip combining marks (accents)
    nfkd = unicodedata.normalize("NFKD", name)
    ascii_name = "".join(c for c in nfkd if not unicodedata.combining(c))
    # Lowercase
    ascii_name = ascii_name.lower().strip()
    # Remove suffixes like Jr., III, II, IV, Sr.
    import re
    ascii_name = re.sub(r'\b(jr\.?|sr\.?|iii|ii|iv)\b', '', ascii_name)
    # Remove periods and extra spaces
    ascii_name = ascii_name.replace(".", "").replace("'", "").replace("-", " ")
    ascii_name = re.sub(r'\s+', ' ', ascii_name).strip()
    return ascii_name


def _fetch_cbs_positions():
    """Scrape specific positions (PG, SG, SF, PF, C) from CBS Sports stats pages."""
    position_map = {}  # normalized_name -> position
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    for page in range(1, 15):  # up to 14 pages to be safe
        try:
            resp = requests.get(
                f"https://www.cbssports.com/nba/stats/player/scoring/nba/regular/all-pos/all/?page={page}",
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


# Fallback: map NBA API broad positions to specific ones
_NBA_POS_FALLBACK = {
    "G": "PG", "G-F": "SG", "F-G": "SG",
    "F": "SF", "F-C": "PF", "C-F": "PF", "C": "C",
}


def _fetch_nba_positions():
    """Fetch positions from NBA playerindex as fallback (broad G/F/C)."""
    from nba_api.stats.endpoints import playerindex
    position_map = {}  # nba_player_id (str) -> position abbreviation
    try:
        pi = playerindex.PlayerIndex(season=SEASON, league_id="00", timeout=60)
        df = pi.get_data_frames()[0]
        for _, row in df.iterrows():
            pid = str(row.get("PERSON_ID", ""))
            pos = str(row.get("POSITION", "")).strip()
            if pid and pos:
                position_map[pid] = _NBA_POS_FALLBACK.get(pos, pos)
    except Exception as e:
        print(f"  WARNING: Could not fetch NBA playerindex positions: {e}")
    return position_map


def scrape_players(conn):
    print("Fetching player stats...")

    # Primary: specific positions from CBS Sports
    print("  Fetching player positions from CBS Sports...")
    cbs_positions = _fetch_cbs_positions()
    print(f"  Got positions for {len(cbs_positions)} players from CBS Sports")

    # Fallback: NBA playerindex for anyone CBS misses
    print("  Fetching fallback positions from NBA playerindex...")
    nba_positions = _fetch_nba_positions()
    print(f"  Got fallback positions for {len(nba_positions)} players from NBA")

    time.sleep(2)  # rate limit

    try:
        stats = leaguedashplayerstats.LeagueDashPlayerStats(
            season=SEASON,
            per_mode_detailed="PerGame",
            season_type_all_star="Regular Season",
            timeout=60,
        )
        df = stats.get_data_frames()[0]
        print(f"  Got {len(df)} players from NBA API")
    except Exception as e:
        print(f"  ERROR fetching player stats: {e}")
        return

    cur = conn.cursor()
    count = 0
    for _, row in df.iterrows():
        player_id = str(row["PLAYER_ID"])
        cur.execute("""
            INSERT INTO players (nba_id, name, team, position, ppg, rpg, apg, spg, bpg,
                                 fg_pct, three_pct, ft_pct, three_pm, tov, mpg, gp, headshot_url, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (nba_id) DO UPDATE SET
                name = EXCLUDED.name, team = EXCLUDED.team, position = EXCLUDED.position,
                ppg = EXCLUDED.ppg, rpg = EXCLUDED.rpg, apg = EXCLUDED.apg,
                spg = EXCLUDED.spg, bpg = EXCLUDED.bpg, fg_pct = EXCLUDED.fg_pct,
                three_pct = EXCLUDED.three_pct, ft_pct = EXCLUDED.ft_pct, three_pm = EXCLUDED.three_pm,
                tov = EXCLUDED.tov, mpg = EXCLUDED.mpg, gp = EXCLUDED.gp,
                headshot_url = EXCLUDED.headshot_url, updated_at = NOW()
        """, (
            player_id,
            row["PLAYER_NAME"],
            row.get("TEAM_ABBREVIATION", ""),
            cbs_positions.get(_normalize_name(row["PLAYER_NAME"]), "") or nba_positions.get(player_id, ""),
            safe_float(row.get("PTS")),
            safe_float(row.get("REB")),
            safe_float(row.get("AST")),
            safe_float(row.get("STL")),
            safe_float(row.get("BLK")),
            pct(row.get("FG_PCT")),
            pct(row.get("FG3_PCT")),
            pct(row.get("FT_PCT")),
            safe_float(row.get("FG3M")),
            safe_float(row.get("TOV")),
            safe_float(row.get("MIN")),
            int(row.get("GP", 0)),
            f"https://cdn.nba.com/headshots/nba/latest/1040x760/{player_id}.png",
        ))
        count += 1

    # Now delete any old seed players that don't have an nba_id
    cur.execute("DELETE FROM my_roster WHERE player_id IN (SELECT id FROM players WHERE nba_id IS NULL)")
    deleted_roster = cur.rowcount
    cur.execute("DELETE FROM players WHERE nba_id IS NULL")
    deleted = cur.rowcount
    if deleted > 0:
        print(f"  Cleaned up {deleted} old seed players ({deleted_roster} roster entries)")

    cur.close()
    print(f"  Upserted {count} players")


def scrape_teams(conn):
    print("Fetching team stats...")
    time.sleep(2)  # rate limit
    try:
        stats = leaguedashteamstats.LeagueDashTeamStats(
            season=SEASON,
            per_mode_detailed="PerGame",
            season_type_all_star="Regular Season",
            timeout=60,
        )
        df = stats.get_data_frames()[0]
        print(f"  Got {len(df)} teams from NBA API")
    except Exception as e:
        print(f"  ERROR fetching team stats: {e}")
        return

    cur = conn.cursor()
    count = 0
    for _, row in df.iterrows():
        team_id = str(row["TEAM_ID"])
        abbr = row.get("TEAM_ABBREVIATION", "")
        meta = TEAM_META.get(abbr, {})

        cur.execute("""
            INSERT INTO teams (nba_id, name, abbreviation, conference, division,
                               wins, losses, ppg, rpg, apg, spg, bpg,
                               fg_pct, three_pct, ft_pct, tov, logo_url, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (nba_id) DO UPDATE SET
                name = EXCLUDED.name, abbreviation = EXCLUDED.abbreviation,
                conference = EXCLUDED.conference, division = EXCLUDED.division,
                wins = EXCLUDED.wins, losses = EXCLUDED.losses,
                ppg = EXCLUDED.ppg, rpg = EXCLUDED.rpg, apg = EXCLUDED.apg,
                spg = EXCLUDED.spg, bpg = EXCLUDED.bpg, fg_pct = EXCLUDED.fg_pct,
                three_pct = EXCLUDED.three_pct, ft_pct = EXCLUDED.ft_pct,
                tov = EXCLUDED.tov, logo_url = EXCLUDED.logo_url, updated_at = NOW()
        """, (
            team_id,
            row.get("TEAM_NAME", meta.get("full_name", "")),
            abbr,
            meta.get("conference", ""),
            meta.get("division", ""),
            int(row.get("W", 0)),
            int(row.get("L", 0)),
            safe_float(row.get("PTS")),
            safe_float(row.get("REB")),
            safe_float(row.get("AST")),
            safe_float(row.get("STL")),
            safe_float(row.get("BLK")),
            pct(row.get("FG_PCT")),
            pct(row.get("FG3_PCT")),
            pct(row.get("FT_PCT")),
            safe_float(row.get("TOV")),
            f"https://cdn.nba.com/logos/nba/{team_id}/global/L/logo.svg",
        ))
        count += 1

    # Clean up old seed teams
    cur.execute("DELETE FROM teams WHERE nba_id IS NULL")
    deleted = cur.rowcount
    if deleted > 0:
        print(f"  Cleaned up {deleted} old seed teams")

    cur.close()
    print(f"  Upserted {count} teams")


def _fetch_scoreboard_for_date(conn, date_str, cur):
    """Fetch and upsert games for a single date. Returns count of games upserted."""
    try:
        sb = scoreboardv2.ScoreboardV2(
            game_date=date_str,
            league_id="00",
            timeout=60,
        )
        frames = sb.get_data_frames()
        game_header = frames[0] if len(frames) > 0 else None
        line_score = frames[1] if len(frames) > 1 else None
    except Exception as e:
        print(f"    ERROR fetching {date_str}: {e}")
        return 0

    if game_header is None or game_header.empty:
        return 0

    # Build team info lookup from LineScore (DataFrame 1):
    #   TEAM_ID -> { name: "City Name", abbr: "ABR", pts: score }
    team_info = {}  # team_id -> { "name": str, "pts": int|None }
    score_map = {}  # game_id -> { team_id: pts }
    if line_score is not None and not line_score.empty:
        for _, s in line_score.iterrows():
            gid = str(s.get("GAME_ID", ""))
            tid = str(s.get("TEAM_ID", ""))
            city = str(s.get("TEAM_CITY_NAME", "")).strip()
            nickname = str(s.get("TEAM_NAME", "")).strip()
            full_name = f"{city} {nickname}" if city and nickname else (city or nickname or "Unknown")
            pts = s.get("PTS")
            team_info[tid] = full_name
            if gid not in score_map:
                score_map[gid] = {}
            score_map[gid][tid] = pts

    count = 0
    for _, g in game_header.iterrows():
        game_id = str(g.get("GAME_ID", ""))
        home_team_id = str(g.get("HOME_TEAM_ID", ""))
        away_team_id = str(g.get("VISITOR_TEAM_ID", ""))
        scores = score_map.get(game_id, {})

        home_team_name = team_info.get(home_team_id, "Unknown")
        away_team_name = team_info.get(away_team_id, "Unknown")

        status_id = g.get("GAME_STATUS_ID", 1)
        status_text = str(g.get("GAME_STATUS_TEXT", "")).strip()
        if status_id == 1:
            status = status_text if status_text else "Scheduled"
        elif status_id == 2:
            status = "In Progress"
        else:
            status = "Final"

        game_date_val = str(g.get("GAME_DATE_EST", ""))[:10]
        try:
            game_date_val = datetime.strptime(game_date_val, "%Y-%m-%d").strftime("%Y-%m-%d")
        except (ValueError, TypeError):
            game_date_val = datetime.now().strftime("%Y-%m-%d")

        home_score = scores.get(home_team_id)
        away_score = scores.get(away_team_id)
        try:
            home_score = int(home_score) if home_score is not None else None
        except (ValueError, TypeError):
            home_score = None
        try:
            away_score = int(away_score) if away_score is not None else None
        except (ValueError, TypeError):
            away_score = None

        cur.execute("""
            INSERT INTO games (nba_game_id, home_team, away_team, game_date,
                               home_score, away_score, status, arena, updated_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
            ON CONFLICT (nba_game_id) DO UPDATE SET
                home_team = EXCLUDED.home_team, away_team = EXCLUDED.away_team,
                game_date = EXCLUDED.game_date, home_score = EXCLUDED.home_score,
                away_score = EXCLUDED.away_score, status = EXCLUDED.status,
                arena = EXCLUDED.arena, updated_at = NOW()
        """, (
            game_id,
            home_team_name,
            away_team_name,
            game_date_val,
            home_score,
            away_score,
            status,
            str(g.get("ARENA_NAME", "")),
        ))
        count += 1

    return count


def scrape_scoreboard(conn):
    from datetime import timedelta
    print("Fetching games (yesterday, today, next 3 days)...")
    time.sleep(2)

    cur = conn.cursor()
    total = 0
    today = datetime.now()

    # Fetch yesterday, today, and 3 days ahead
    for offset in range(-1, 4):
        d = today + timedelta(days=offset)
        date_str = d.strftime("%m/%d/%Y")
        label = d.strftime("%Y-%m-%d")
        count = _fetch_scoreboard_for_date(conn, date_str, cur)
        if count > 0:
            print(f"    {label}: {count} games")
        total += count
        time.sleep(1)  # rate limit between days

    # Clean up seed games
    cur.execute("DELETE FROM games WHERE nba_game_id IS NULL")
    deleted = cur.rowcount
    if deleted > 0:
        print(f"  Cleaned up {deleted} old seed games")

    cur.close()
    print(f"  Total games upserted: {total}")


def scrape_injuries(conn):
    print("Fetching injury report from CBS Sports...")
    time.sleep(1)
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        resp = requests.get("https://www.cbssports.com/nba/injuries/", headers=headers, timeout=30)
        resp.raise_for_status()
    except Exception as e:
        print(f"  ERROR fetching injuries: {e}")
        return

    soup = BeautifulSoup(resp.text, "html.parser")

    # First clear all injury statuses
    cur = conn.cursor()
    cur.execute("UPDATE players SET injury_status = NULL, injury_detail = NULL")

    team_name_to_abbr = {
        "Atlanta Hawks": "ATL", "Boston Celtics": "BOS", "Brooklyn Nets": "BKN",
        "Charlotte Hornets": "CHA", "Chicago Bulls": "CHI", "Cleveland Cavaliers": "CLE",
        "Dallas Mavericks": "DAL", "Denver Nuggets": "DEN", "Detroit Pistons": "DET",
        "Golden State Warriors": "GSW", "Houston Rockets": "HOU", "Indiana Pacers": "IND",
        "Los Angeles Clippers": "LAC", "LA Clippers": "LAC",
        "Los Angeles Lakers": "LAL", "LA Lakers": "LAL",
        "Memphis Grizzlies": "MEM", "Miami Heat": "MIA", "Milwaukee Bucks": "MIL",
        "Minnesota Timberwolves": "MIN", "New Orleans Pelicans": "NOP",
        "New York Knicks": "NYK", "Oklahoma City Thunder": "OKC",
        "Orlando Magic": "ORL", "Philadelphia 76ers": "PHI", "Phoenix Suns": "PHX",
        "Portland Trail Blazers": "POR", "Sacramento Kings": "SAC",
        "San Antonio Spurs": "SAS", "Toronto Raptors": "TOR",
        "Utah Jazz": "UTA", "Washington Wizards": "WAS",
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
                cur.execute("""
                    UPDATE players SET injury_status = %s, injury_detail = %s, updated_at = NOW()
                    WHERE LOWER(name) = LOWER(%s)
                """, (injury_status or "Day-To-Day", injury_detail or "Unknown", player_name))
                if cur.rowcount > 0:
                    count += 1

    cur.close()
    print(f"  Updated {count} player injuries")


def main():
    conn = get_db()

    scrape_players(conn)
    scrape_teams(conn)
    scrape_scoreboard(conn)
    scrape_injuries(conn)

    # No longer need to re-link old fantasy roster — using simplified my_roster table now

    conn.close()
    print("\nAll done!")


if __name__ == "__main__":
    main()
