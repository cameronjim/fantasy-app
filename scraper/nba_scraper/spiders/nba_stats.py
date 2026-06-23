import json
import logging
from datetime import datetime
from typing import Generator

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
    allowed_domains = ["stats.nba.com", "www.cbssports.com"]

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

        today = datetime.now().strftime("%m/%d/%Y")
        yield scrapy.Request(
            url=(
                "https://stats.nba.com/stats/scoreboardv2"
                f"?DayOffset=0&GameDate={today}&LeagueID=00"
            ),
            headers=NBA_API_HEADERS,
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
        data = json.loads(response.text)
        result_sets = {rs["name"]: rs for rs in data.get("resultSets", [])}

        game_header = result_sets.get("GameHeader")
        line_score = result_sets.get("LineScore")

        if not game_header:
            logger.info("no games on today's scoreboard")
            return

        games = self._result_set_to_dicts(game_header)
        scores = self._result_set_to_dicts(line_score) if line_score else []

        # build GAME_ID -> {team_id: points} for quick score lookup
        score_map: dict[str, dict[str, object]] = {}
        for s in scores:
            gid = str(s.get("GAME_ID", ""))
            tid = str(s.get("TEAM_ID", ""))
            pts = s.get("PTS")
            if gid not in score_map:
                score_map[gid] = {}
            score_map[gid][tid] = pts

        logger.info("parsing %d games from scoreboard", len(games))

        for g in games:
            game_id = str(g.get("GAME_ID", ""))
            home_team_id = str(g.get("HOME_TEAM_ID", ""))
            away_team_id = str(g.get("VISITOR_TEAM_ID", ""))
            game_scores = score_map.get(game_id, {})

            status_id = g.get("GAME_STATUS_ID", 1)
            if status_id == 1:
                status = "Scheduled"
            elif status_id == 2:
                status = "In Progress"
            else:
                status = "Final"

            game_date_str = g.get("GAME_DATE_EST", "")
            try:
                game_date = datetime.strptime(
                    game_date_str[:10], "%Y-%m-%d"
                ).strftime("%Y-%m-%d")
            except (ValueError, TypeError):
                game_date = datetime.now().strftime("%Y-%m-%d")

            yield GameItem(
                nba_game_id=game_id,
                home_team=g.get("HOME_TEAM_NAME", "Unknown"),
                away_team=g.get("VISITOR_TEAM_NAME", "Unknown"),
                game_date=game_date,
                home_score=self._safe_int(game_scores.get(home_team_id)),
                away_score=self._safe_int(game_scores.get(away_team_id)),
                status=status,
                arena=g.get("ARENA_NAME", ""),
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
