"""
Unit tests for the data truth layer's pure logic.

No database, no network. Everything under test is a plain function over plain
data, which is why the truth-layer helpers were written that way: the write
paths themselves need a live Neon connection and cannot be covered here.

Fixtures use the real column names from the endpoints this scraper calls, taken
from nba_api 1.11.4's own `expected_data` declarations:

    playergamelogs.PlayerGameLogs        -> "PlayerGameLogs" result set
    leaguegamelog.LeagueGameLog          -> "LeagueGameLog" result set
    boxscoresummaryv2.BoxScoreSummaryV2  -> "InactivePlayers" (PLAYER_ID, TEAM_ID, ...)
    boxscoresummaryv3.BoxScoreSummaryV3  -> "InactivePlayers" (personId, teamId, ...)
    scheduleleaguev2.ScheduleLeagueV2    -> "SeasonGames" result set

A fixture that drifts from those shapes is a test that passes while production
breaks, so they are copied verbatim rather than invented.

Run:
    python -m pytest scraper/test_truth_layer.py
"""

from datetime import date, timedelta

import pytest

from run_scraper import (
    GAME_LOG_CORRECTION_WINDOW_DAYS,
    PLAYER_LOG_DATE_INDEX,
    ROSTER_SNAPSHOT_SOURCE,
    SEASON,
    TEAM_LOG_DATE_INDEX,
    V2_INACTIVE_UNRELIABLE_FROM,
    _parse_args,
    box_score_violations,
    v2_inactive_is_unreliable,
    build_player_game_log_row,
    build_team_game_log_row,
    derive_game_status_rows,
    game_log_fetch_from,
    in_season,
    is_write_statement,
    normalize_inactive_rows,
    normalize_injury_status,
    parse_game_date,
    parse_matchup,
    parse_minutes,
    plan_roster_snapshot,
    plan_stint_change,
    schedule_rows_from_league_schedule,
    schedule_rows_from_team_logs,
    season_end_date,
    season_start_date,
    season_type_from_game_id,
    split_rows_on_season_boundary,
    supplement_player_log_rows,
)


# --- fixtures modelled on real nba_api response rows ------------------------

PLAYER_GAME_LOG_ROW = {
    "SEASON_YEAR": "2024-25",
    "PLAYER_ID": 1628369,
    "PLAYER_NAME": "Jayson Tatum",
    "TEAM_ID": 1610612738,
    "TEAM_ABBREVIATION": "BOS",
    "TEAM_NAME": "Boston Celtics",
    "GAME_ID": "0022400061",
    "GAME_DATE": "2024-10-22T00:00:00",
    "MATCHUP": "BOS vs. NYK",
    "WL": "W",
    "MIN": 34.2,
    "FGM": 12,
    "FGA": 25,
    "FG_PCT": 0.48,
    "FG3M": 5,
    "FG3A": 12,
    "FG3_PCT": 0.417,
    "FTM": 8,
    "FTA": 9,
    "FT_PCT": 0.889,
    "OREB": 1,
    "DREB": 10,
    "REB": 11,
    "AST": 5,
    "TOV": 3,
    "STL": 2,
    "BLK": 1,
    "PTS": 37,
    "PLUS_MINUS": 14,
}

TEAM_GAME_LOG_ROWS = [
    {
        "SEASON_ID": "22024",
        "TEAM_ID": 1610612738,
        "TEAM_ABBREVIATION": "BOS",
        "TEAM_NAME": "Boston Celtics",
        "GAME_ID": "0022400061",
        "GAME_DATE": "2024-10-22",
        "MATCHUP": "BOS vs. NYK",
        "WL": "W",
        "MIN": 240,
        "FGM": 46,
        "FGA": 96,
        "FG3M": 22,
        "FG3A": 61,
        "FTM": 18,
        "FTA": 22,
        "REB": 46,
        "AST": 28,
        "STL": 8,
        "BLK": 5,
        "TOV": 12,
        "PTS": 132,
        "PLUS_MINUS": 23,
    },
    {
        "SEASON_ID": "22024",
        "TEAM_ID": 1610612752,
        "TEAM_ABBREVIATION": "NYK",
        "TEAM_NAME": "New York Knicks",
        "GAME_ID": "0022400061",
        "GAME_DATE": "2024-10-22",
        "MATCHUP": "NYK @ BOS",
        "WL": "L",
        "MIN": 240,
        "FGM": 40,
        "FGA": 89,
        "FG3M": 12,
        "FG3A": 36,
        "FTM": 17,
        "FTA": 20,
        "REB": 39,
        "AST": 22,
        "STL": 5,
        "BLK": 3,
        "TOV": 15,
        "PTS": 109,
        "PLUS_MINUS": -23,
    },
]

# BoxScoreSummaryV3's InactivePlayers columns.
INACTIVE_ROWS_V3 = [
    {
        "gameId": "0022400061",
        "teamId": 1610612738,
        "personId": 1629684,
        "firstName": "Xavier",
        "familyName": "Tillman",
        "jerseyNum": "26",
    }
]

# BoxScoreSummaryV2's InactivePlayers columns — the fallback path.
INACTIVE_ROWS_V2 = [
    {
        "PLAYER_ID": 1629684,
        "FIRST_NAME": "Xavier",
        "LAST_NAME": "Tillman",
        "JERSEY_NUM": "26",
        "TEAM_ID": 1610612738,
        "TEAM_CITY": "Boston",
        "TEAM_NAME": "Celtics",
        "TEAM_ABBREVIATION": "BOS",
    }
]

# ScheduleLeagueV2's SeasonGames columns, trimmed to the ones we read.
SEASON_GAME_ROW = {
    "leagueId": "00",
    "seasonYear": "2025-26",
    "gameDate": "2026-03-04T00:00:00",
    "gameId": "0022500789",
    "gameStatus": 1,
    "gameStatusText": "7:30 pm ET",
    "gameDateTimeUTC": "2026-03-05T00:30:00Z",
    "postponedStatus": "A",
    "homeTeam_teamId": 1610612738,
    "homeTeam_teamTricode": "BOS",
    "awayTeam_teamId": 1610612747,
    "awayTeam_teamTricode": "LAL",
}


# --- minutes parsing --------------------------------------------------------


class TestParseMinutes:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("34:12", 34.2),
            ("0:36", 0.6),
            ("12:00", 12.0),
            ("PT34M12.00S", 34.2),
            ("PT0M36.00S", 0.6),
            ("PT40M", 40.0),
            (34.2, 34.2),
            (240, 240.0),
            ("38", 38.0),
        ],
    )
    def test_parses_every_shape_the_endpoints_return(self, raw, expected):
        # act + assert
        assert parse_minutes(raw) == pytest.approx(expected)

    @pytest.mark.parametrize("raw", [None, "", "   ", "DNP", float("nan"), True])
    def test_missing_input_is_none_not_zero(self, raw):
        # a player with no minutes reported did not play zero minutes
        assert parse_minutes(raw) is None


# --- date and matchup parsing ----------------------------------------------


class TestParseGameDate:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("2024-10-22", date(2024, 10, 22)),
            ("2024-10-22T00:00:00", date(2024, 10, 22)),
            ("OCT 22, 2024", date(2024, 10, 22)),
            ("10/22/2024", date(2024, 10, 22)),
            # scheduleleaguev2 gameDate for the 2026-27 season
            ("10/22/2026 00:00:00", date(2026, 10, 22)),
            (date(2024, 10, 22), date(2024, 10, 22)),
        ],
    )
    def test_parses_each_endpoint_format(self, raw, expected):
        assert parse_game_date(raw) == expected

    @pytest.mark.parametrize("raw", [None, "", "not a date"])
    def test_unparseable_is_none(self, raw):
        assert parse_game_date(raw) is None


class TestParseMatchup:
    def test_home_matchup(self):
        assert parse_matchup("BOS vs. NYK") == (True, "NYK")

    def test_away_matchup(self):
        assert parse_matchup("NYK @ BOS") == (False, "BOS")

    @pytest.mark.parametrize("raw", [None, "", "BOS", "something else entirely"])
    def test_unparseable_yields_no_guess(self, raw):
        # an is_home that is wrong half the time is worse than one that is absent
        assert parse_matchup(raw) == (None, None)


class TestSeasonTypeFromGameId:
    @pytest.mark.parametrize(
        "game_id, expected",
        [
            ("0022400061", "Regular Season"),
            ("0012400002", "Pre Season"),
            ("0032400001", "All Star"),
            ("0042300401", "Playoffs"),
            ("0052300011", "PlayIn"),
        ],
    )
    def test_known_prefixes(self, game_id, expected):
        assert season_type_from_game_id(game_id) == expected

    @pytest.mark.parametrize("game_id", ["0092400061", "", None, "x"])
    def test_unknown_prefix_is_not_silently_regular_season(self, game_id):
        assert season_type_from_game_id(game_id) == "Unknown"


# --- watermark logic --------------------------------------------------------


class TestGameLogWatermark:
    def test_walks_back_by_the_correction_window(self):
        # arrange
        latest = date(2026, 3, 10)

        # act
        result = game_log_fetch_from(latest, "2025-26")

        # assert
        assert result == latest - timedelta(days=GAME_LOG_CORRECTION_WINDOW_DAYS)

    def test_empty_table_fetches_the_whole_season(self):
        assert game_log_fetch_from(None, "2025-26") == season_start_date("2025-26")

    def test_never_reaches_back_past_the_season_boundary(self):
        # arrange: a watermark right at the season floor
        floor = season_start_date("2025-26")

        # act
        result = game_log_fetch_from(floor, "2025-26", correction_window_days=30)

        # assert
        assert result == floor

    def test_season_start_bound_cannot_overlap_the_previous_season(self):
        assert season_start_date("2025-26") == date(2025, 7, 1)
        assert season_start_date("2024-25") < season_start_date("2025-26")


# --- stint transitions ------------------------------------------------------


class TestPlanStintChange:
    def test_same_team_is_no_change(self):
        # arrange
        open_stint = ("1610612738", date(2025, 10, 21))

        # act
        change = plan_stint_change(
            open_stint, "1610612738", date(2026, 3, 1), date(2026, 3, 1)
        )

        # assert
        assert change is None

    def test_first_ever_stint_opens_without_closing_anything(self):
        # act
        change = plan_stint_change(None, "1610612738", date(2025, 10, 21), None)

        # assert
        assert change["open_team_id"] == "1610612738"
        assert change["open_valid_from"] == date(2025, 10, 21)
        assert change["close_team_id"] is None

    def test_trade_closes_the_old_stint_on_his_last_game_for_it(self):
        # arrange: BOS since opening night, last BOS game Feb 4, LAL debut Feb 8
        open_stint = ("1610612738", date(2025, 10, 21))

        # act
        change = plan_stint_change(
            open_stint, "1610612747", date(2026, 2, 8), date(2026, 2, 4)
        )

        # assert: the Feb 5-7 gap belongs to neither team
        assert change["close_team_id"] == "1610612738"
        assert change["close_valid_from"] == date(2025, 10, 21)
        assert change["close_valid_to"] == date(2026, 2, 4)
        assert change["open_team_id"] == "1610612747"
        assert change["open_valid_from"] == date(2026, 2, 8)

    def test_close_date_never_precedes_the_stint_it_closes(self):
        # arrange: a stint opened after the last observed game for that team,
        # which should not produce a backwards interval
        open_stint = ("1610612738", date(2026, 2, 1))

        # act
        change = plan_stint_change(
            open_stint, "1610612747", date(2026, 2, 8), date(2026, 1, 3)
        )

        # assert
        assert change["close_valid_to"] == date(2026, 2, 1)

    def test_close_date_never_reaches_the_new_stints_start(self):
        # arrange: no game recorded for the old team at all
        open_stint = ("1610612738", date(2025, 10, 21))

        # act
        change = plan_stint_change(
            open_stint, "1610612747", date(2026, 2, 8), date(2026, 2, 20)
        )

        # assert: clamped to the day before the new stint opens
        assert change["close_valid_to"] == date(2026, 2, 7)


# --- validation predicates --------------------------------------------------


class TestBoxScoreViolations:
    def test_consistent_row_has_no_violations(self):
        assert box_score_violations(
            {"fgm": 12, "fga": 25, "fg3m": 5, "fg3a": 12, "ftm": 8, "fta": 9}
        ) == []

    def test_more_makes_than_attempts_is_caught(self):
        assert "fgm_le_fga" in box_score_violations({"fgm": 12, "fga": 5})

    def test_three_pointers_must_also_be_field_goals(self):
        # arrange: internally consistent on its own terms, but 6 threes cannot
        # come out of 4 made field goals
        row = {"fgm": 4, "fga": 10, "fg3m": 6, "fg3a": 8}

        # act
        violations = box_score_violations(row)

        # assert
        assert violations == ["fg3m_le_fgm"]

    def test_free_throws(self):
        assert box_score_violations({"ftm": 10, "fta": 4}) == ["ftm_le_fta"]

    def test_nulls_are_not_violations(self):
        # an unreported stat is not a wrong stat
        assert box_score_violations({"fgm": None, "fga": 2, "fg3m": 1, "fg3a": None}) == []


# --- injury status normalization -------------------------------------------


class TestNormalizeInjuryStatus:
    @pytest.mark.parametrize(
        "raw, expected",
        [
            ("Out", "out"),
            ("Out For Season", "out"),
            ("Season-Ending Surgery", "out"),
            ("Doubtful", "doubtful"),
            ("Questionable", "questionable"),
            ("Probable", "probable"),
            ("Day-To-Day", "day_to_day"),
            ("Game Time Decision", "day_to_day"),
            ("GTD", "day_to_day"),
            ("Available", "available"),
        ],
    )
    def test_buckets_known_wording(self, raw, expected):
        assert normalize_injury_status(raw) == expected

    def test_longest_phrase_wins(self):
        # "out for season" must not be swallowed by the bare "out" rule, and
        # must not be swallowed by "season" either
        assert normalize_injury_status("out for season") == "out"

    @pytest.mark.parametrize("raw", [None, "", "Reconditioning", "G League Two-Way"])
    def test_unrecognised_degrades_to_unknown(self, raw):
        assert normalize_injury_status(raw) == "unknown"


# --- inactive list derivation ----------------------------------------------


class TestNormalizeInactiveRows:
    def test_reads_the_v3_column_names(self):
        assert normalize_inactive_rows(INACTIVE_ROWS_V3) == [
            {"nba_player_id": "1629684", "team_id": "1610612738"}
        ]

    def test_reads_the_v2_column_names(self):
        assert normalize_inactive_rows(INACTIVE_ROWS_V2) == [
            {"nba_player_id": "1629684", "team_id": "1610612738"}
        ]

    def test_ids_stay_text(self):
        # NBA ids are TEXT; parsing them as numbers loses leading zeros
        assert normalize_inactive_rows(INACTIVE_ROWS_V3)[0]["nba_player_id"] == "1629684"

    def test_rows_without_a_player_are_dropped(self):
        assert normalize_inactive_rows([{"personId": None, "teamId": 1}]) == []


class TestDeriveGameStatusRows:
    def _played(self, player_id, minutes=30.0, dnp_reason=None):
        return {
            "nba_player_id": player_id,
            "team_id": "1610612738",
            "started": True,
            "minutes": minutes,
            "dnp_reason": dnp_reason,
        }

    def test_an_appearance_is_played_and_active(self):
        # act
        rows = derive_game_status_rows(
            "0022400061", [self._played("1628369")], [], "test"
        )

        # assert
        assert rows == [
            {
                "nba_player_id": "1628369",
                "nba_game_id": "0022400061",
                "team_id": "1610612738",
                "rostered": True,
                "listed_inactive": False,
                "started": True,
                "played": True,
                "dnp_reason": None,
                "minutes": 30.0,
                "source": "test",
            }
        ]

    def test_an_inactive_entry_is_rostered_but_did_not_play(self):
        # act
        rows = derive_game_status_rows("0022400061", [], INACTIVE_ROWS_V3, "test")

        # assert
        assert len(rows) == 1
        assert rows[0]["nba_player_id"] == "1629684"
        assert rows[0]["rostered"] is True
        assert rows[0]["listed_inactive"] is True
        assert rows[0]["played"] is False
        assert rows[0]["minutes"] is None

    def test_a_dressed_dnp_is_rostered_active_and_did_not_play(self):
        # arrange: NBA box scores set COMMENT only when a player did not appear
        played = [self._played("1234", minutes=None, dnp_reason="DNP - Coach's Decision")]

        # act
        rows = derive_game_status_rows("0022400061", played, [], "test")

        # assert: the distinction a roster approximation cannot represent
        assert rows[0]["rostered"] is True
        assert rows[0]["listed_inactive"] is False
        assert rows[0]["played"] is False
        assert rows[0]["dnp_reason"] == "DNP - Coach's Decision"

    def test_blank_comment_still_counts_as_played(self):
        rows = derive_game_status_rows(
            "0022400061", [self._played("1234", dnp_reason="   ")], [], "test"
        )
        assert rows[0]["played"] is True
        assert rows[0]["dnp_reason"] is None

    def test_the_universe_is_the_union_of_both_populations(self):
        # act
        rows = derive_game_status_rows(
            "0022400061", [self._played("1628369")], INACTIVE_ROWS_V3, "test"
        )

        # assert
        assert {r["nba_player_id"] for r in rows} == {"1628369", "1629684"}
        assert all(r["rostered"] for r in rows)
        assert sum(1 for r in rows if r["played"]) == 1

    def test_a_contradiction_stays_visible_instead_of_being_resolved(self):
        # arrange: same player in the game log AND the inactive list
        played = [self._played("1629684")]

        # act
        rows = derive_game_status_rows("0022400061", played, INACTIVE_ROWS_V3, "test")

        # assert: one row, played kept, inactive flag still raised
        assert len(rows) == 1
        assert rows[0]["played"] is True
        assert rows[0]["listed_inactive"] is True


# --- row builders -----------------------------------------------------------


class TestBuildPlayerGameLogRow:
    def test_maps_a_real_response_row(self):
        # act
        row = build_player_game_log_row(PLAYER_GAME_LOG_ROW, "2024-25", 7)

        # assert
        (
            player_id, game_id, season, season_type, game_date, team_id, team_abbr,
            opponent_team_id, is_home, started, minutes, pts, reb, ast, stl, blk,
            tov, fgm, fga, fg3m, fg3a, ftm, fta, plus_minus, dnp_reason, source,
            run_id,
        ) = row

        assert player_id == "1628369"
        assert game_id == "0022400061"
        assert season == "2024-25"
        assert season_type == "Regular Season"
        assert game_date == date(2024, 10, 22)
        assert team_id == "1610612738"
        assert team_abbr == "BOS"
        assert opponent_team_id == "1610612752"  # NYK, resolved from the matchup
        assert is_home is True
        assert minutes == pytest.approx(34.2)
        assert (pts, reb, ast, stl, blk, tov) == (37, 11, 5, 2, 1, 3)
        assert (fgm, fga, fg3m, fg3a, ftm, fta) == (12, 25, 5, 12, 8, 9)
        assert plus_minus == 14
        assert source == "playergamelogs"
        assert run_id == 7

    def test_started_and_dnp_are_null_because_this_endpoint_cannot_report_them(self):
        row = build_player_game_log_row(PLAYER_GAME_LOG_ROW, "2024-25", None)
        assert row[9] is None   # started
        assert row[24] is None  # dnp_reason

    def test_ids_keep_their_leading_zeros(self):
        row = build_player_game_log_row(PLAYER_GAME_LOG_ROW, "2024-25", None)
        assert row[1] == "0022400061"

    @pytest.mark.parametrize(
        "missing", ["PLAYER_ID", "GAME_ID", "GAME_DATE"]
    )
    def test_a_row_that_cannot_be_joined_is_dropped(self, missing):
        # arrange
        raw = dict(PLAYER_GAME_LOG_ROW, **{missing: None})

        # act + assert
        assert build_player_game_log_row(raw, "2024-25", None) is None

    def test_a_leaguegamelog_row_maps_with_its_own_source_tag(self):
        # arrange: leaguegamelog's player mode has no SEASON_YEAR and reports
        # whole minutes, but shares every other column this builder reads
        raw = dict(PLAYER_GAME_LOG_ROW, MIN=34)
        del raw["SEASON_YEAR"]

        # act
        row = build_player_game_log_row(raw, "2024-25", 7, source="leaguegamelog")

        # assert
        assert row[2] == "2024-25"  # season fell back to the argument
        assert row[10] == pytest.approx(34.0)
        assert row[25] == "leaguegamelog"


class TestSupplementPlayerLogRows:
    def test_only_missing_keys_are_taken_from_the_league_log(self):
        # arrange: playergamelogs returned Tatum; leaguegamelog returned Tatum
        # (whole minutes) plus a zero-minute appearance it alone reports —
        # modelled on Dennis Schröder's 0-minute game in 0022200140
        primary = [build_player_game_log_row(PLAYER_GAME_LOG_ROW, "2024-25", 7)]
        zero_minute = dict(
            PLAYER_GAME_LOG_ROW, PLAYER_ID=203471, PLAYER_NAME="Dennis Schröder",
            MIN=0, PTS=0, FGM=0, FGA=0,
        )
        league = [dict(PLAYER_GAME_LOG_ROW, MIN=34), zero_minute]

        # act
        supplements = supplement_player_log_rows(primary, league, "2024-25", 7)

        # assert: Tatum's league-log copy is NOT taken (playergamelogs wins on
        # precision), the zero-minute appearance is
        assert len(supplements) == 1
        assert supplements[0][0] == "203471"
        assert supplements[0][10] == pytest.approx(0.0)
        assert supplements[0][25] == "leaguegamelog"

    def test_duplicate_league_rows_are_taken_once(self):
        row = dict(PLAYER_GAME_LOG_ROW, MIN=0)
        supplements = supplement_player_log_rows([], [row, dict(row)], "2024-25", None)
        assert len(supplements) == 1


class TestBuildTeamGameLogRow:
    def test_maps_the_away_side(self):
        # act
        row = build_team_game_log_row(TEAM_GAME_LOG_ROWS[1], "2024-25", None)

        # assert
        assert row[0] == "1610612752"
        assert row[1] == "0022400061"
        assert row[6] == "1610612738"  # opponent BOS
        assert row[7] is False  # is_home
        assert row[9] == 109  # pts


# --- schedule construction --------------------------------------------------


class TestScheduleFromTeamLogs:
    def test_two_team_rows_collapse_into_one_game(self):
        # act
        rows = schedule_rows_from_team_logs(TEAM_GAME_LOG_ROWS, "2024-25")

        # assert
        assert len(rows) == 1
        game = rows[0]
        assert game["nba_game_id"] == "0022400061"
        assert game["home_team_id"] == "1610612738"
        assert game["away_team_id"] == "1610612752"
        assert game["home_team_abbr"] == "BOS"
        assert game["away_team_abbr"] == "NYK"
        assert game["game_date"] == date(2024, 10, 22)
        assert game["season_type"] == "Regular Season"
        assert game["source"] == "leaguegamelog"

    def test_completed_games_only(self):
        # this source cannot know about unplayed games, which is why it is the
        # fallback and not the primary schedule source
        rows = schedule_rows_from_team_logs(TEAM_GAME_LOG_ROWS, "2024-25")
        assert rows[0]["game_status"] == "Final"
        assert rows[0]["scheduled_at"] is None

    def test_a_lone_team_row_still_produces_a_game(self):
        # arrange: only the away side survived the response
        rows = schedule_rows_from_team_logs([TEAM_GAME_LOG_ROWS[1]], "2024-25")

        # assert: opponent recovered from the matchup string
        assert rows[0]["away_team_id"] == "1610612752"
        assert rows[0]["home_team_id"] is None
        assert rows[0]["home_team_abbr"] == "BOS"

    def test_a_neutral_site_game_keeps_both_teams(self):
        # arrange: neutral-site games (NBA Cup semifinals, Mexico City, Paris)
        # report an "@" matchup for BOTH teams — modelled on the real rows for
        # 0022400147, where the second away claim used to overwrite the first
        # and the losing side vanished from the schedule row entirely
        neutral = [
            dict(TEAM_GAME_LOG_ROWS[0], GAME_ID="0022400147", MATCHUP="MIA @ WAS",
                 TEAM_ID=1610612748, TEAM_ABBREVIATION="MIA", GAME_DATE="2024-11-02"),
            dict(TEAM_GAME_LOG_ROWS[1], GAME_ID="0022400147", MATCHUP="WAS @ MIA",
                 TEAM_ID=1610612764, TEAM_ABBREVIATION="WAS", GAME_DATE="2024-11-02"),
        ]

        # act
        rows = schedule_rows_from_team_logs(neutral, "2024-25")

        # assert: which slot is which is arbitrary here, but BOTH teams must be
        # present — a missing side means every join on (game, team) drops it
        assert len(rows) == 1
        game = rows[0]
        assert {game["home_team_id"], game["away_team_id"]} == {
            "1610612748", "1610612764",
        }
        assert {game["home_team_abbr"], game["away_team_abbr"]} == {"MIA", "WAS"}

    def test_a_double_home_claim_also_keeps_both_teams(self):
        # the mirror-image defect: both rows claiming "vs." must not collide
        both_home = [
            dict(TEAM_GAME_LOG_ROWS[0], MATCHUP="BOS vs. NYK"),
            dict(TEAM_GAME_LOG_ROWS[1], MATCHUP="NYK vs. BOS"),
        ]

        rows = schedule_rows_from_team_logs(both_home, "2024-25")

        game = rows[0]
        assert {game["home_team_id"], game["away_team_id"]} == {
            "1610612738", "1610612752",
        }


class TestScheduleFromLeagueSchedule:
    def test_maps_an_unplayed_game(self):
        # act
        rows = schedule_rows_from_league_schedule([SEASON_GAME_ROW], "2025-26")

        # assert
        game = rows[0]
        assert game["nba_game_id"] == "0022500789"
        assert game["season"] == "2025-26"
        assert game["game_date"] == date(2026, 3, 4)
        assert game["home_team_abbr"] == "BOS"
        assert game["away_team_abbr"] == "LAL"
        assert game["game_status"] == "7:30 pm ET"
        assert game["postponed_status"] == "A"
        assert game["source"] == "scheduleleaguev2"

    def test_utc_tipoff_is_kept_separately_from_the_et_game_date(self):
        # a 7:30pm ET tip is the next day in UTC; the game date must not follow it
        game = schedule_rows_from_league_schedule([SEASON_GAME_ROW], "2025-26")[0]
        assert game["game_date"] == date(2026, 3, 4)
        assert game["scheduled_at"].isoformat() == "2026-03-05T00:30:00+00:00"

    def test_rows_without_a_game_id_are_dropped(self):
        raw = dict(SEASON_GAME_ROW, gameId="")
        assert schedule_rows_from_league_schedule([raw], "2025-26") == []


# --- dry-run statement classification --------------------------------------


class TestIsWriteStatement:
    @pytest.mark.parametrize(
        "sql",
        [
            "INSERT INTO player_game_logs VALUES %s",
            "  update players set x = 1",
            "DELETE FROM games",
            "CREATE TABLE t (id INT)",
        ],
    )
    def test_writes_are_detected(self, sql):
        assert is_write_statement(sql) is True

    @pytest.mark.parametrize(
        "sql",
        [
            "SELECT MAX(game_date) FROM player_game_logs",
            "\n    SELECT 1\n",
            "WITH x AS (SELECT 1) SELECT * FROM x",
            "",
        ],
    )
    def test_reads_are_not_skipped(self, sql):
        # a dry run must still read: it reports how many rows *would* be written
        assert is_write_statement(sql) is False

    def test_a_leading_comment_does_not_disguise_a_write(self):
        assert is_write_statement("-- upsert the logs\nINSERT INTO t VALUES (1)") is True

    def test_a_data_modifying_cte_is_treated_as_a_write(self):
        # a WITH-prefixed write is indistinguishable from a read by its first
        # keyword, and letting one through would make --dry-run write
        sql = "WITH moved AS (DELETE FROM a RETURNING *) INSERT INTO b SELECT * FROM moved"
        assert is_write_statement(sql) is True


class TestV2InactiveReliability:
    """The V2 inactive list is documented as having no data on/after the cutoff.

    Past it, an empty V2 answer means "no data", not "nobody was inactive" —
    trusting it would silently recreate the availability bias the truth layer
    exists to remove, so the tag decision is pinned here.
    """

    def test_day_before_cutoff_is_trusted(self):
        assert v2_inactive_is_unreliable(V2_INACTIVE_UNRELIABLE_FROM - timedelta(days=1)) is False

    def test_cutoff_day_itself_is_unreliable(self):
        assert v2_inactive_is_unreliable(V2_INACTIVE_UNRELIABLE_FROM) is True

    def test_after_cutoff_is_unreliable(self):
        assert v2_inactive_is_unreliable(date(2026, 1, 15)) is True

    def test_unknown_date_is_unreliable_not_trusted(self):
        # the cost of wrongly distrusting is one suspect tag; the cost of
        # wrongly trusting is a biased label indistinguishable from a real one
        assert v2_inactive_is_unreliable(None) is True

    def test_old_seasons_still_use_v2_freely(self):
        assert v2_inactive_is_unreliable(date(2023, 3, 1)) is False


# --- season boundary --------------------------------------------------------


class TestSeasonWindow:
    """The July 1 - June 30 window that decides which season a game belongs to.

    The two bounds have to partition the calendar with no gap and no overlap, or
    a game on the seam belongs to two seasons or to none.
    """

    def test_start_is_july_first_of_the_first_year(self):
        assert season_start_date("2026-27") == date(2026, 7, 1)

    def test_end_is_june_thirtieth_of_the_second_year(self):
        assert season_end_date("2026-27") == date(2027, 6, 30)

    def test_consecutive_seasons_tile_the_calendar_without_a_gap(self):
        # the day after one season ends is the day the next one starts
        assert season_end_date("2025-26") + timedelta(days=1) == season_start_date("2026-27")

    def test_a_game_inside_the_window_is_in_season(self):
        assert in_season(date(2026, 10, 20), "2026-27") is True
        assert in_season(date(2027, 4, 11), "2026-27") is True

    def test_a_game_from_the_previous_season_is_not(self):
        # the exact confusion the guard exists to catch: an April 2026 game
        # returned by a 2026-27 request
        assert in_season(date(2026, 4, 12), "2026-27") is False

    def test_a_game_from_the_next_season_is_not(self):
        assert in_season(date(2027, 10, 20), "2026-27") is False

    def test_an_unknown_date_is_never_in_season(self):
        # a row we cannot place must not be labelled with whichever season was
        # asked for; that is the mislabelling the guard exists to prevent
        assert in_season(None, "2026-27") is False


class TestSeasonBoundaryGuard:
    """No row dated inside season X-1 may be written by a season-X sync.

    build_player_game_log_row stamps the REQUESTED season onto any row whose own
    SEASON_YEAR is missing, so an out-of-range row is not merely wrong: it is
    stored under a season it was never played in, and the truth layer then holds
    the same game twice.
    """

    @staticmethod
    def _player_row(game_date):
        row = list(build_player_game_log_row(PLAYER_GAME_LOG_ROW, "2026-27", None))
        row[PLAYER_LOG_DATE_INDEX] = game_date
        return tuple(row)

    def test_rows_inside_the_season_are_kept(self):
        rows = [self._player_row(date(2026, 10, 20)), self._player_row(date(2027, 3, 1))]

        inside, outside = split_rows_on_season_boundary(
            rows, "2026-27", PLAYER_LOG_DATE_INDEX
        )

        assert inside == rows
        assert outside == []

    def test_a_previous_season_row_is_split_out_not_written(self):
        keep = self._player_row(date(2026, 10, 20))
        stray = self._player_row(date(2026, 4, 12))  # a 2025-26 game

        inside, outside = split_rows_on_season_boundary(
            [keep, stray], "2026-27", PLAYER_LOG_DATE_INDEX
        )

        assert inside == [keep]
        assert outside == [stray]

    def test_a_next_season_row_is_split_out_too(self):
        stray = self._player_row(date(2027, 10, 21))

        inside, outside = split_rows_on_season_boundary(
            [stray], "2026-27", PLAYER_LOG_DATE_INDEX
        )

        assert inside == []
        assert outside == [stray]

    def test_the_team_log_date_index_finds_the_date_column(self):
        row = build_team_game_log_row(TEAM_GAME_LOG_ROWS[0], "2024-25", None)

        assert isinstance(row[TEAM_LOG_DATE_INDEX], date)

        inside, outside = split_rows_on_season_boundary(
            [row], "2024-25", TEAM_LOG_DATE_INDEX
        )
        assert inside == [row]
        assert outside == []

    def test_an_empty_season_partitions_to_two_empty_lists(self):
        # the preseason case: nothing fetched, nothing kept, nothing refused
        assert split_rows_on_season_boundary(
            [], "2026-27", PLAYER_LOG_DATE_INDEX
        ) == ([], [])


# --- roster snapshot --------------------------------------------------------


SNAPSHOT_DAY = date(2026, 9, 15)
LAL = "1610612747"
BOS = "1610612738"
GSW = "1610612744"


class TestPlanRosterSnapshot:
    """The offseason patch for a stint table that can only learn from game logs.

    A trade in July is invisible to the game-log planner until the player has
    APPEARED for his new team, which is October at the earliest. Everything below
    pins what a roster page is and is not allowed to assert.
    """

    def test_a_player_already_on_the_right_team_is_no_change(self):
        changes = plan_roster_snapshot(
            {"201939": GSW}, {"201939": (GSW, date(2025, 10, 21))}, SNAPSHOT_DAY
        )

        assert changes == []

    def test_a_moved_player_opens_a_new_stint_on_the_snapshot_date(self):
        changes = plan_roster_snapshot(
            {"201939": LAL}, {"201939": (GSW, date(2025, 10, 21))}, SNAPSHOT_DAY
        )

        assert len(changes) == 1
        assert changes[0]["player_id"] == "201939"
        assert changes[0]["open_team_id"] == LAL
        assert changes[0]["open_valid_from"] == SNAPSHOT_DAY

    def test_the_old_stint_closes_the_day_before_the_snapshot(self):
        # NOT on his last game with the old team: we observed that he is on the
        # new roster today and never observed when he left the old one. Closing
        # at the last game would assert a transaction date nobody saw.
        changes = plan_roster_snapshot(
            {"201939": LAL}, {"201939": (GSW, date(2025, 10, 21))}, SNAPSHOT_DAY
        )

        assert changes[0]["close_team_id"] == GSW
        assert changes[0]["close_valid_from"] == date(2025, 10, 21)
        assert changes[0]["close_valid_to"] == SNAPSHOT_DAY - timedelta(days=1)

    def test_a_stint_never_closes_before_it_opened(self):
        # a snapshot taken the same day a stint opened yields a zero-length
        # stint, not a negative one
        changes = plan_roster_snapshot(
            {"201939": LAL}, {"201939": (GSW, SNAPSHOT_DAY)}, SNAPSHOT_DAY
        )

        assert changes[0]["close_valid_to"] == SNAPSHOT_DAY
        assert changes[0]["close_valid_to"] >= changes[0]["close_valid_from"]

    def test_a_player_with_no_open_stint_only_opens_one(self):
        # a rookie, or any player the game-log-derived table has never seen
        changes = plan_roster_snapshot({"1642268": BOS}, {}, SNAPSHOT_DAY)

        assert len(changes) == 1
        assert changes[0]["close_team_id"] is None
        assert changes[0]["close_valid_from"] is None
        assert changes[0]["close_valid_to"] is None
        assert changes[0]["open_team_id"] == BOS

    def test_a_player_missing_from_every_roster_is_left_open(self):
        # absence has two indistinguishable causes - unsigned, or one team's
        # fetch failed - so closing on absence would turn one HTTP error into a
        # whole roster of wrongly-ended stints
        changes = plan_roster_snapshot(
            {}, {"201939": (GSW, date(2025, 10, 21))}, SNAPSHOT_DAY
        )

        assert changes == []

    def test_several_players_are_planned_independently(self):
        changes = plan_roster_snapshot(
            {"1": LAL, "2": BOS, "3": GSW},
            {"1": (GSW, date(2025, 11, 1)), "2": (BOS, date(2025, 11, 1))},
            SNAPSHOT_DAY,
        )

        moved = {c["player_id"]: c for c in changes}
        assert set(moved) == {"1", "3"}   # 2 was already on BOS
        assert moved["1"]["close_team_id"] == GSW
        assert moved["3"]["close_team_id"] is None

    def test_the_plan_is_idempotent_once_applied(self):
        first = plan_roster_snapshot(
            {"201939": LAL}, {"201939": (GSW, date(2025, 10, 21))}, SNAPSHOT_DAY
        )
        applied = {"201939": (first[0]["open_team_id"], first[0]["open_valid_from"])}

        assert plan_roster_snapshot({"201939": LAL}, applied, SNAPSHOT_DAY) == []

    def test_the_source_label_is_distinct_from_the_game_log_one(self):
        # a game-log stint is an observation, a snapshot stint is a declaration;
        # a query that cannot tell them apart cannot say which it has
        assert ROSTER_SNAPSHOT_SOURCE == "roster_snapshot"
        assert ROSTER_SNAPSHOT_SOURCE != "playergamelogs"


# --- season as a CLI concern ------------------------------------------------


class TestSeasonCli:
    """--season replaces editing the SEASON constant to roll the season over."""

    def test_season_defaults_to_the_module_constant(self):
        assert _parse_args([]).season == SEASON

    def test_season_can_be_overridden(self):
        assert _parse_args(["--season", "2026-27"]).season == "2026-27"

    def test_sync_truth_and_roster_snapshot_are_off_by_default(self):
        args = _parse_args([])
        assert args.sync_truth is False
        assert args.roster_snapshot is False

    def test_the_opening_week_command_parses(self):
        args = _parse_args(["--dev", "--sync-truth", "--season", "2026-27"])

        assert args.target == "dev"
        assert args.sync_truth is True
        assert args.season == "2026-27"

    def test_the_roster_snapshot_command_parses_with_dry_run(self):
        args = _parse_args(
            ["--dev", "--roster-snapshot", "--season", "2026-27", "--dry-run"]
        )

        assert args.roster_snapshot is True
        assert args.season == "2026-27"
        assert args.dry_run is True

    def test_the_backfill_to_season_default_is_unchanged(self):
        # --season must not have quietly become --to; they are different bounds
        assert _parse_args(["--season", "2026-27"]).to_season == SEASON
