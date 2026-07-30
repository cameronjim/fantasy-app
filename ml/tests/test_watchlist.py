"""rules tests for the watchlist reference implementation.

these pin the SAME thresholds asserted in
backend/tests/unit/watchlist.test.ts. if a test here changes, the matching
TypeScript test has to change with it - that pairing is the only thing keeping
the two implementations honest.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import date

import pytest

from fnba_ml.watchlist import (
    HOT_STREAK,
    HOT_STREAK_STDDEV_MULTIPLE,
    REASON_CODES,
    REASON_WEIGHTS,
    RETURN_GAP_DAYS,
    RETURNING_FROM_ABSENCE,
    ROLE_INCREASE,
    ROLE_INCREASE_MIN_DELTA,
    SHOT_VOLUME_SURGE,
    SHOT_VOLUME_SURGE_FGA_DELTA,
    STAR_EXCLUSION_PPG,
    TEAMMATE_ABSENCE,
    TEAMMATE_ABSENCE_MIN_MINUTES,
    WATCHLIST_LIMIT,
    Candidate,
    Teammate,
    day_gap,
    evidence_for,
    find_absent_teammate,
    has_role_increase,
    has_shot_volume_surge,
    is_discovery_candidate,
    is_hot_streak,
    is_returning_from_absence,
    rank_candidates,
    reasons_for,
    score_for,
)

BASE = Candidate(nba_player_id="1001", name="Test Candidate", team_abbr="LAL", season_ppg=9.4)


class TestRoleIncrease:
    def test_fires_exactly_at_the_threshold(self):
        assert has_role_increase(24 + ROLE_INCREASE_MIN_DELTA, 24) is True

    def test_stays_quiet_just_below(self):
        assert has_role_increase(27.9, 24) is False

    def test_never_fires_on_a_drop(self):
        assert has_role_increase(18, 26) is False

    @pytest.mark.parametrize("r5,r15", [(30, None), (None, 20), (None, None)])
    def test_needs_both_windows(self, r5, r15):
        assert has_role_increase(r5, r15) is False


class TestShotVolumeSurge:
    def test_fires_exactly_at_the_threshold(self):
        assert has_shot_volume_surge(8 + SHOT_VOLUME_SURGE_FGA_DELTA, 8) is True

    def test_stays_quiet_just_below(self):
        assert has_shot_volume_surge(10.4, 8) is False

    def test_needs_both_windows(self):
        assert has_shot_volume_surge(12, None) is False


class TestReturningFromAbsence:
    def test_fires_at_the_gap_threshold_after_an_appearance(self):
        assert is_returning_from_absence(RETURN_GAP_DAYS, True) is True

    def test_a_shorter_gap_is_just_a_rest_day(self):
        assert is_returning_from_absence(6, True) is False

    def test_does_not_fire_for_a_player_still_out(self):
        # the gap is long, but the most recent scheduled game was a DNP
        assert is_returning_from_absence(21, False) is False

    def test_needs_a_measurable_gap(self):
        assert is_returning_from_absence(None, True) is False


class TestHotStreak:
    def test_fires_at_the_stddev_multiple(self):
        # sd 4 -> the bar is +6
        assert is_hot_streak(20, 14, 4) is True
        assert is_hot_streak(19.9, 14, 4) is False

    def test_scales_by_the_player_not_a_fixed_total(self):
        # the same +5 swing, different volatility
        assert is_hot_streak(19, 14, 2) is True
        assert is_hot_streak(19, 14, 10) is False
        assert HOT_STREAK_STDDEV_MULTIPLE == 1.5

    @pytest.mark.parametrize("sd", [0, None, -1])
    def test_never_fires_without_volatility_to_scale_by(self, sd):
        assert is_hot_streak(20, 14, sd) is False

    def test_never_fires_on_a_cold_stretch(self):
        assert is_hot_streak(8, 14, 3) is False


class TestAbsentTeammate:
    def test_returns_a_ruled_out_rotation_teammate(self):
        found = find_absent_teammate(
            [Teammate("Star Guard", TEAMMATE_ABSENCE_MIN_MINUTES, "Out")]
        )
        assert found is not None
        assert found.name == "Star Guard"

    def test_ignores_a_low_minutes_absence(self):
        assert find_absent_teammate([Teammate("Deep Bench", 12, "Out")]) is None

    @pytest.mark.parametrize("status", ["Day-To-Day", "Questionable", None])
    def test_ignores_statuses_short_of_out(self, status):
        assert find_absent_teammate([Teammate("Star Guard", 34, status)]) is None

    def test_picks_the_highest_minutes_absence(self):
        found = find_absent_teammate(
            [Teammate("Third Option", 29, "Out"), Teammate("Franchise Player", 36, "Out")]
        )
        assert found is not None
        assert found.name == "Franchise Player"


class TestDiscoveryExclusion:
    def test_excludes_established_scorers_at_the_cutoff(self):
        assert is_discovery_candidate(STAR_EXCLUSION_PPG) is False
        assert is_discovery_candidate(19.9) is True

    def test_keeps_a_player_with_no_season_line(self):
        # exactly the rookie / call-up case the list exists for
        assert is_discovery_candidate(None) is True


class TestReasonsAndEvidence:
    def test_no_reasons_for_an_unchanged_situation(self):
        candidate = replace(BASE, min_r5=20, min_r15=20, fga_r5=8, fga_r15=8)
        assert reasons_for(candidate) == ()

    def test_stacks_every_rule_in_code_order(self):
        candidate = replace(
            BASE,
            min_r5=30,
            min_r15=20,
            fga_r5=12,
            fga_r15=8,
            pts_r5=20,
            pts_season=12,
            pts_stddev=4,
            gap_days=9,
            played_last_game=True,
            teammates=(Teammate("Star Guard", 34, "Out"),),
        )
        assert reasons_for(candidate) == REASON_CODES

    def test_evidence_covers_only_the_reasons_that_fired(self):
        candidate = replace(
            BASE, min_r5=30.24, min_r15=20.1, pts_r5=18, pts_season=12, pts_stddev=3
        )
        reasons = reasons_for(candidate)

        assert reasons == (ROLE_INCREASE, HOT_STREAK)
        assert evidence_for(candidate, reasons) == {
            "min_r5": 30.2,
            "min_r15": 20.1,
            "min_delta": 10.1,
            "pts_r5": 18,
            "pts_season": 12,
            "pts_stddev": 3,
            "pts_delta": 6,
        }

    def test_return_evidence_carries_the_date(self):
        candidate = replace(
            BASE, gap_days=12, played_last_game=True, last_game_date=date(2026, 2, 3)
        )
        assert evidence_for(candidate, reasons_for(candidate)) == {
            "gap_days": 12,
            "last_game_date": "2026-02-03",
        }


class TestScore:
    def test_sums_weights_when_no_run_exists(self):
        assert score_for([ROLE_INCREASE, HOT_STREAK], None) == (
            REASON_WEIGHTS[ROLE_INCREASE] + REASON_WEIGHTS[HOT_STREAK]
        )

    def test_discounts_by_availability(self):
        assert score_for([ROLE_INCREASE], 0.5) == 1.5

    @pytest.mark.parametrize(
        "prob,expected", [(4.0, REASON_WEIGHTS[ROLE_INCREASE]), (-2.0, 0.0)]
    )
    def test_clamps_a_malformed_probability(self, prob, expected):
        assert score_for([ROLE_INCREASE], prob) == expected

    def test_empty_reasons_score_zero(self):
        assert score_for([], 0.9) == 0.0

    def test_opportunity_outweighs_a_hot_streak(self):
        # minutes already granted beat points that may not repeat
        assert REASON_WEIGHTS[ROLE_INCREASE] > REASON_WEIGHTS[HOT_STREAK]
        assert REASON_WEIGHTS[TEAMMATE_ABSENCE] > REASON_WEIGHTS[SHOT_VOLUME_SURGE]
        assert REASON_WEIGHTS[SHOT_VOLUME_SURGE] > REASON_WEIGHTS[RETURNING_FROM_ABSENCE]


class TestRanking:
    def test_drops_players_with_no_reason(self):
        assert rank_candidates([replace(BASE, min_r5=20, min_r15=20)]) == []

    def test_drops_established_scorers_even_when_every_rule_fires(self):
        star = replace(
            BASE,
            name="Established Star",
            season_ppg=27.5,
            min_r5=36,
            min_r15=30,
            pts_r5=34,
            pts_season=27.5,
            pts_stddev=4,
        )
        assert rank_candidates([star]) == []

    def test_orders_by_score_then_reason_count_then_name(self):
        role_only = replace(BASE, nba_player_id="1", name="A Role", min_r5=30, min_r15=20)
        hot_only = replace(
            BASE, nba_player_id="2", name="B Hot", pts_r5=20, pts_season=12, pts_stddev=4
        )
        both = replace(
            BASE,
            nba_player_id="3",
            name="C Both",
            min_r5=30,
            min_r15=20,
            pts_r5=20,
            pts_season=12,
            pts_stddev=4,
        )

        ranked = rank_candidates([hot_only, role_only, both])

        assert [c.name for c in ranked] == ["C Both", "A Role", "B Hot"]
        assert ranked[0].score == REASON_WEIGHTS[ROLE_INCREASE] + REASON_WEIGHTS[HOT_STREAK]

    def test_availability_reorders_identical_reason_sets(self):
        likely = replace(
            BASE, nba_player_id="1", name="Likely Starter", min_r5=30, min_r15=20, prob_active=0.95
        )
        doubtful = replace(
            BASE, nba_player_id="2", name="Doubtful Starter", min_r5=30, min_r15=20, prob_active=0.2
        )

        ranked = rank_candidates([doubtful, likely])

        assert [c.name for c in ranked] == ["Likely Starter", "Doubtful Starter"]

    def test_caps_at_the_published_limit(self):
        many = [
            replace(BASE, nba_player_id=str(i), name=f"Player {i:02d}", min_r5=30, min_r15=20)
            for i in range(25)
        ]
        assert len(rank_candidates(many)) == WATCHLIST_LIMIT

    def test_respects_an_explicit_limit(self):
        many = [
            replace(BASE, nba_player_id=str(i), name=f"P{i}", min_r5=30, min_r15=20)
            for i in range(5)
        ]
        assert len(rank_candidates(many, limit=2)) == 2


class TestDayGap:
    def test_counts_whole_days(self):
        assert day_gap(date(2026, 2, 10), date(2026, 2, 1)) == 9

    def test_spans_a_month_boundary(self):
        assert day_gap(date(2026, 3, 2), date(2026, 2, 25)) == 5

    @pytest.mark.parametrize(
        "later,earlier", [(date(2026, 2, 10), None), (None, date(2026, 2, 1)), (None, None)]
    )
    def test_is_none_when_a_day_is_missing(self, later, earlier):
        assert day_gap(later, earlier) is None
