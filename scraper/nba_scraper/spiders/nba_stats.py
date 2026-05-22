import json
import logging
from datetime import datetime, timezone
from typing import Generator
from zoneinfo import ZoneInfo

import scrapy
from scrapy.http import Request, Response

from nba_scraper.items import GameItem, InjuryItem, PlayerItem, TeamItem

logger = logging.getLogger(__name__)

# fills in conference / division / logo_url — leaguedashteamstats doesn't include them
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

# required by stats.nba.com to avoid 403 errors
NBA_API_HEADERS = {
    "Host": "stats.nba.com",
    "Referer": "https://www.nba.com/",
    "Origin": "https://www.nba.com",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "x-nba-stats-origin": "stats",
    "x-nba-stats-token": "true",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
}


class NbaStatsSpider(scrapy.Spider):
    name = "nba_stats"
    allowed_domains = ["stats.nba.com", "site.api.espn.com", "www.cbssports.com"]

    SEASON = "2025-26"

    def start_requests(self) -> Generator[Request, None, None]:
        yield scrapy.Request(
            url=(
                "https://stats.nba.com/stats/leaguedashplayerbiostats"
                "?College=&Conference=&Country=&DateFrom=&DateTo="
                "&Division=&DraftPick=&DraftYear=&GameScope="
                "&GameSegment=&Height=&ISTRound=&LastNGames=0"
                "&LeagueID=00&Location=&Month=0"
                "&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N"
                "&PerMode=PerGame&Period=0&PlayerExperience="
                "&PlayerPosition=&PlusMinus=N&Rank=N"
                f"&Season={self.SEASON}&SeasonSegment="
                "&SeasonType=Regular+Season&ShotClockRange="
                "&StarterBench=&TeamID=0&VsConference=&VsDivision="
            ),
            headers=NBA_API_HEADERS,
            callback=self.parse_player_bio,
            errback=self.handle_error,
            meta={"endpoint": "player_bio"},
        )

        yield scrapy.Request(
            url=(
                "https://stats.nba.com/stats/leaguedashteamstats"
                "?Conference=&DateFrom=&DateTo=&Division="
                "&GameScope=&GameSegment=&Height=&ISTRound="
                "&LastNGames=0&LeagueID=00&Location="
                "&MeasureType=Base&Month=0&OpponentTeamID=0"
                "&Outcome=&PORound=0&PaceAdjust=N"
                "&PerMode=PerGame&Period=0&PlayerExperience="
                "&PlayerPosition=&PlusMinus=N&Rank=N"
                f"&Season={self.SEASON}&SeasonSegment="
                "&SeasonType=Regular+Season&ShotClockRange="
                "&StarterBench=&TeamID=0&VsConference=&VsDivision="
            ),
            headers=NBA_API_HEADERS,
            callback=self.parse_team_stats,
            errback=self.handle_error,
            meta={"endpoint": "team_stats"},
        )

        # ESPN scoreboard — accessible from servers (unlike stats.nba.com/cdn.nba.com
        # which block non-browser requests). Returns today's games with live scores.
        yield scrapy.Request(
            url="https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard",
            callback=self.parse_scoreboard,
            errback=self.handle_error,
            meta={"endpoint": "scoreboard"},
        )

        # CBS Sports injury data is more reliable than NBA.com
        yield scrapy.Request(
            url="https://www.cbssports.com/nba/injuries/",
            callback=self.parse_injuries,
            errback=self.handle_error,
            meta={"endpoint": "injuries"},
        )

    @staticmethod
    def _result_set_to_dicts(result_set: dict) -> list[dict]:
        """convert an NBA stats API resultSet into a list of row dicts."""
        headers = result_set["headers"]
        rows = result_set["rowSet"]
        return [dict(zip(headers, row)) for row in rows]

    def parse_player_bio(
        self, response: Response
    ) -> Generator[Request, None, None]:
        data = json.loads(response.text)
        result_sets = data.get("resultSets", [])

        position_map: dict[str, str] = {}
        if result_sets:
            players = self._result_set_to_dicts(result_sets[0])
            logger.info("parsed positions for %d players from biostats", len(players))
            for p in players:
                pid = str(p.get("PLAYER_ID", ""))
                pos = p.get("PLAYER_POSITION", "")
                if pid and pos:
                    position_map[pid] = self._normalize_position(pos)
        else:
            logger.warning("no resultSets in player bio response")

        yield scrapy.Request(
            url=(
                "https://stats.nba.com/stats/leaguedashplayerstats"
                "?College=&Conference=&Country=&DateFrom=&DateTo="
                "&Division=&DraftPick=&DraftYear=&GameScope="
                "&GameSegment=&Height=&ISTRound=&LastNGames=0"
                "&LeagueID=00&Location=&MeasureType=Base&Month=0"
                "&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N"
                "&PerMode=PerGame&Period=0&PlayerExperience="
                "&PlayerPosition=&PlusMinus=N&Rank=N"
                f"&Season={self.SEASON}&SeasonSegment="
                "&SeasonType=Regular+Season&ShotClockRange="
                "&StarterBench=&TeamID=0&VsConference=&VsDivision="
                "&Weight="
            ),
            headers=NBA_API_HEADERS,
            callback=self.parse_player_stats,
            errback=self.handle_error,
            meta={"endpoint": "player_stats", "position_map": position_map},
        )

    def parse_player_stats(
        self, response: Response
    ) -> Generator[PlayerItem, None, None]:
        data = json.loads(response.text)
        result_sets = data.get("resultSets", [])
        if not result_sets:
            logger.warning("no resultSets in player stats response")
            return

        position_map: dict[str, str] = response.meta.get("position_map", {})
        players = self._result_set_to_dicts(result_sets[0])
        logger.info("parsing %d players from leaguedashplayerstats", len(players))

        for p in players:
            player_id = str(p.get("PLAYER_ID", ""))
            yield PlayerItem(
                nba_id=player_id,
                name=p.get("PLAYER_NAME", ""),
                team=p.get("TEAM_ABBREVIATION", ""),
                position=position_map.get(player_id, ""),
                points_per_game=self._safe_float(p.get("PTS")),
                rebounds_per_game=self._safe_float(p.get("REB")),
                assists_per_game=self._safe_float(p.get("AST")),
                steals_per_game=self._safe_float(p.get("STL")),
                blocks_per_game=self._safe_float(p.get("BLK")),
                field_goal_percentage=self._pct_to_display(p.get("FG_PCT")),
                three_point_percentage=self._pct_to_display(p.get("FG3_PCT")),
                free_throw_percentage=self._pct_to_display(p.get("FT_PCT")),
                turnovers_per_game=self._safe_float(p.get("TOV")),
                minutes_per_game=self._safe_float(p.get("MIN")),
                games_played=int(p.get("GP", 0)),
                headshot_url=(
                    f"https://cdn.nba.com/headshots/nba/latest/1040x760/{player_id}.png"
                ),
            )

    def parse_team_stats(
        self, response: Response
    ) -> Generator[TeamItem, None, None]:
        data = json.loads(response.text)
        result_sets = data.get("resultSets", [])
        if not result_sets:
            logger.warning("no resultSets in team stats response")
            return

        teams = self._result_set_to_dicts(result_sets[0])
        logger.info("parsing %d teams from leaguedashteamstats", len(teams))

        for t in teams:
            team_id = str(t.get("TEAM_ID", ""))
            abbr = t.get("TEAM_ABBREVIATION", "")
            meta = TEAM_META.get(abbr, {})

            yield TeamItem(
                nba_id=team_id,
                name=t.get("TEAM_NAME", meta.get("full_name", "")),
                abbreviation=abbr,
                conference=meta.get("conference", ""),
                division=meta.get("division", ""),
                wins=int(t.get("W", 0)),
                losses=int(t.get("L", 0)),
                points_per_game=self._safe_float(t.get("PTS")),
                rebounds_per_game=self._safe_float(t.get("REB")),
                assists_per_game=self._safe_float(t.get("AST")),
                steals_per_game=self._safe_float(t.get("STL")),
                blocks_per_game=self._safe_float(t.get("BLK")),
                field_goal_percentage=self._pct_to_display(t.get("FG_PCT")),
                three_point_percentage=self._pct_to_display(t.get("FG3_PCT")),
                free_throw_percentage=self._pct_to_display(t.get("FT_PCT")),
                turnovers_per_game=self._safe_float(t.get("TOV")),
                logo_url=(
                    f"https://cdn.nba.com/logos/nba/{team_id}/global/L/logo.svg"
                ),
            )

    def parse_scoreboard(
        self, response: Response
    ) -> Generator[GameItem, None, None]:
        """Parse today's scoreboard from ESPN.

        ESPN stores dates as UTC midnight. Convert to Eastern Time to get the
        correct game date (e.g. "2026-05-22T00:00Z" = 8 PM ET May 21 → May 21).
        """
        data = json.loads(response.text)
        events = data.get("events", [])

        if not events:
            logger.info("no games on today's ESPN scoreboard")
            return

        logger.info("parsing %d games from ESPN scoreboard", len(events))

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

            # ESPN date is UTC midnight — convert to ET for canonical game date
            date_str = event.get("date", "")
            try:
                date_utc = datetime.fromisoformat(date_str.replace("Z", "+00:00"))
                game_date = date_utc.astimezone(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                game_date = datetime.now(ZoneInfo("America/New_York")).strftime("%Y-%m-%d")

            competition = (event.get("competitions") or [{}])[0]
            competitors = competition.get("competitors", [])
            home = next((c for c in competitors if c.get("homeAway") == "home"), {})
            away = next((c for c in competitors if c.get("homeAway") == "away"), {})

            is_pre_game = status_name not in ("STATUS_FINAL", "STATUS_IN_PROGRESS")
            home_score = self._safe_int(home.get("score")) if not is_pre_game else None
            away_score = self._safe_int(away.get("score")) if not is_pre_game else None

            arena = (competition.get("venue") or {}).get("fullName", "")

            yield GameItem(
                nba_game_id=game_id,
                home_team=(home.get("team") or {}).get("displayName", "Unknown"),
                away_team=(away.get("team") or {}).get("displayName", "Unknown"),
                game_date=game_date,
                home_score=home_score,
                away_score=away_score,
                status=status,
                arena=arena,
            )

    def parse_injuries(
        self, response: Response
    ) -> Generator[InjuryItem, None, None]:
        # CBS Sports renders one injury table per team
        team_tables = response.css("div.TableBase")

        if not team_tables:
            logger.warning("no injury tables found on CBS Sports")
            return

        for table in team_tables:
            # team name sits in the heading element above the rows
            team_name = table.css("span.TeamName a::text").get("").strip()
            team_abbr = self._team_name_to_abbr(team_name)

            rows = table.css("tr.TableBase-bodyTr")
            for row in rows:
                cells = row.css("td")
                if len(cells) < 4:
                    continue

                player_name = cells[0].css(
                    "span.CellPlayerName--long a::text"
                ).get("")
                if not player_name:
                    player_name = cells[0].css("a::text").get("").strip()

                injury_detail = cells[2].css("::text").get("").strip()
                injury_status = cells[3].css("::text").get("").strip()

                if player_name:
                    yield InjuryItem(
                        name=player_name.strip(),
                        team=team_abbr,
                        injury_status=injury_status if injury_status else "Day-To-Day",
                        injury_detail=injury_detail if injury_detail else "Unknown",
                    )

    def handle_error(self, failure: object) -> None:
        endpoint = failure.request.meta.get("endpoint", "unknown")
        logger.error(
            "request to %s failed: %s",
            endpoint,
            failure.getErrorMessage(),
        )

    @staticmethod
    def _safe_float(val: object) -> float:
        try:
            return round(float(val), 1)
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def _safe_int(val: object) -> int | None:
        try:
            return int(val)
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _pct_to_display(val: object) -> float:
        """convert 0.456 to 45.6 for display."""
        try:
            return round(float(val) * 100, 1)
        except (TypeError, ValueError):
            return 0.0

    @staticmethod
    def _normalize_position(pos: str) -> str:
        """map NBA API position strings to standard abbreviations."""
        if not pos:
            return ""
        pos = pos.strip()
        mapping = {
            "Guard": "PG",
            "Point Guard": "PG",
            "Shooting Guard": "SG",
            "Guard-Forward": "SG",
            "Forward-Guard": "SG",
            "Forward": "SF",
            "Small Forward": "SF",
            "Power Forward": "PF",
            "Forward-Center": "PF",
            "Center-Forward": "PF",
            "Center": "C",
        }
        return mapping.get(pos, pos)

    @staticmethod
    def _team_name_to_abbr(team_name: str) -> str:
        """convert a full team name to its NBA abbreviation."""
        lookup = {
            "Atlanta Hawks": "ATL",
            "Boston Celtics": "BOS",
            "Brooklyn Nets": "BKN",
            "Charlotte Hornets": "CHA",
            "Chicago Bulls": "CHI",
            "Cleveland Cavaliers": "CLE",
            "Dallas Mavericks": "DAL",
            "Denver Nuggets": "DEN",
            "Detroit Pistons": "DET",
            "Golden State Warriors": "GSW",
            "Houston Rockets": "HOU",
            "Indiana Pacers": "IND",
            "Los Angeles Clippers": "LAC",
            "LA Clippers": "LAC",
            "Los Angeles Lakers": "LAL",
            "LA Lakers": "LAL",
            "Memphis Grizzlies": "MEM",
            "Miami Heat": "MIA",
            "Milwaukee Bucks": "MIL",
            "Minnesota Timberwolves": "MIN",
            "New Orleans Pelicans": "NOP",
            "New York Knicks": "NYK",
            "Oklahoma City Thunder": "OKC",
            "Orlando Magic": "ORL",
            "Philadelphia 76ers": "PHI",
            "Phoenix Suns": "PHX",
            "Portland Trail Blazers": "POR",
            "Sacramento Kings": "SAC",
            "San Antonio Spurs": "SAS",
            "Toronto Raptors": "TOR",
            "Utah Jazz": "UTA",
            "Washington Wizards": "WAS",
        }
        return lookup.get(team_name, team_name)
