"""the preseason path: a season with a schedule, rosters, and no games played.

THREE THINGS ARE UNDER TEST HERE and they fail in different ways:

  the cold-start FLAG        a pure function of GAME_DATE against a frozen
                             constant. Cheap to get right, and the tests exist
                             because it is a MANDATORY REPORTING SPLIT (MODEL.md
                             13.7) and a flag that is silently false is
                             indistinguishable from a window that never opened.

  the prospective UNIVERSE   rows for games nobody has played. The interesting
                             property is not that it produces rows, it is that a
                             player with zero games in the NEW season still
                             carries his prior-season form, and a player with
                             zero NBA games at all still gets a ROW.

  the per-date FEATURE BUILD the load-bearing rule of fnba_ml.prospective. A
                             future row carrying PLAYED = 0 must not enter a LATER
                             future row's availability windows as a fabricated
                             absence. The test below does not merely assert the
                             good behaviour - it also demonstrates the leak the
                             one-date-at-a-time build prevents, because a
                             correctness rule whose violation nobody has seen is a
                             rule nobody can be sure is doing anything.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.config import (
    PROSPECTIVE_COLD_START_FLAG,
    PROSPECTIVE_COLD_START_THROUGH,
    is_cold_start,
)
from fnba_ml.features import MIN_APPEARANCES_FOR_HISTORY, build_features
from fnba_ml.models import P_PLAY
from fnba_ml.store import STAT_NAMES, build_prediction_rows
from fnba_ml.prospective import (
    SOURCE_PROSPECTIVE,
    build_prospective_features,
    history_from_dataset,
    prospective_universe,
    roster_assignments,
)
from fnba_ml.universe import UNIVERSE_COLS

# a season after everything the fixtures contain, so "no games played in the
# current season" is true by construction rather than by filtering.
FUTURE_SEASON = "2025-26"
FUTURE_DATES = ("2025-10-21", "2025-10-23", "2025-10-25")


# ---------------------------------------------------------------------------
# the cold-start flag
# ---------------------------------------------------------------------------
class TestColdStartFlag:
    """MODEL.md 13.7: every prediction with GAME_DATE <= 2026-11-30 carries it."""

    def test_the_last_day_of_the_window_is_inside_it(self):
        # "on or before", so the boundary day itself is flagged
        assert is_cold_start(PROSPECTIVE_COLD_START_THROUGH) is True

    def test_the_day_after_is_outside(self):
        after = pd.Timestamp(PROSPECTIVE_COLD_START_THROUGH) + pd.Timedelta(days=1)
        assert is_cold_start(after) is False

    def test_october_of_the_prospective_season_is_flagged(self):
        assert is_cold_start("2026-10-20") is True

    def test_the_window_runs_past_october_on_purpose(self):
        # tied to MAGNITUDE_SHRINK_K = 10 rather than to a calendar month: a
        # player is only ~2/3 his own numbers at ten appearances, which teams
        # reach in late November
        assert is_cold_start("2026-11-15") is True
        assert is_cold_start("2026-12-01") is False

    def test_an_evening_tipoff_on_the_boundary_day_is_still_inside(self):
        # comparison is on the normalised date. An hour of the evening must not
        # decide which side of a reporting split a game falls on.
        assert is_cold_start(f"{PROSPECTIVE_COLD_START_THROUGH} 19:30:00") is True

    def test_a_series_returns_a_boolean_series_aligned_to_it(self):
        dates = pd.Series(pd.to_datetime(
            ["2026-10-20", "2026-11-30", "2026-12-01", "2027-04-11"]
        ))

        flags = is_cold_start(dates)

        assert isinstance(flags, pd.Series)
        assert flags.tolist() == [True, True, False, False]

    def test_an_unreadable_date_is_not_flagged_either_way(self):
        # the flag ASSERTS "this game is inside the window"; a date that cannot
        # be read supports no such assertion
        flags = is_cold_start(pd.Series(["2026-10-20", None, "not a date"]))

        assert flags.tolist() == [True, False, False]

    def test_it_reads_the_frozen_constant_rather_than_a_literal(self):
        # if section 13.7's window were ever re-frozen, this helper must move
        # with it and not carry its own copy
        assert is_cold_start("2026-11-30", through="2026-10-31") is False


class TestColdStartDoesNotEnterTheStore:
    """13.7: the flag "must not collide with a served stat name" in the store.

    Migration 014's per-row table is long-format (run, player, game, stat,
    quantile, value) and has no flag column. The flag therefore rides the parquet
    and the RUN-LEVEL note, and 014 is not altered for it — which is safe only
    because the flag is a pure function of GAME_DATE and every stored row already
    carries one, so any consumer can recompute it exactly.
    """

    def test_the_flag_name_is_not_a_stored_stat_name(self):
        assert PROSPECTIVE_COLD_START_FLAG not in set(STAT_NAMES.values())
        assert PROSPECTIVE_COLD_START_FLAG not in set(STAT_NAMES)

    def test_a_frame_carrying_the_flag_emits_no_row_for_it(self):
        frame = pd.DataFrame({
            "PLAYER_ID": ["2544"],
            "GAME_ID": ["0022600001"],
            "GAME_DATE": [pd.Timestamp("2026-10-20")],
            P_PLAY: [0.91],
            "E_MIN_COND": [33.0],
            "E_MIN": [30.0],
            PROSPECTIVE_COLD_START_FLAG: [True],
        })

        rows = build_prediction_rows(frame, ("MIN",))

        assert rows, "the frame should still produce ordinary stat rows"
        assert PROSPECTIVE_COLD_START_FLAG not in {r["stat"] for r in rows}

    def test_the_flag_is_recomputable_from_a_stored_row_alone(self):
        # the reason no migration is needed: game_date is on every stored row
        stored_game_date = pd.Timestamp("2026-10-20")

        assert is_cold_start(stored_game_date) is True


# ---------------------------------------------------------------------------
# fixtures for the prospective universe
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def history(universe_status: pd.DataFrame) -> pd.DataFrame:
    return universe_status.copy()


@pytest.fixture(scope="module")
def rosters(history: pd.DataFrame) -> pd.DataFrame:
    """every fixture player, on the team he last played for."""
    last = (
        history[history["PLAYED"] == 1]
        .sort_values("GAME_DATE")
        .drop_duplicates("PLAYER_ID", keep="last")
    )
    return last[["PLAYER_ID", "TEAM_ID"]].reset_index(drop=True)


@pytest.fixture(scope="module")
def future_schedule(history: pd.DataFrame) -> pd.DataFrame:
    """a synthetic schedule for a season with no game logs at all.

    teams are paired off, so every team plays once per date and every fixture
    player has a game on every date - which is what makes the cross-date
    contamination test below able to see the leak it is looking for.
    """
    teams = sorted(history["TEAM_ID"].unique())
    pairs = list(zip(teams[0::2], teams[1::2]))
    rows = []
    for date_index, game_date in enumerate(FUTURE_DATES):
        for pair_index, (home, away) in enumerate(pairs):
            rows.append({
                "GAME_ID": f"9{date_index}{pair_index:04d}",
                "SEASON": FUTURE_SEASON,
                "SEASON_TYPE": "Regular Season",
                "GAME_DATE": game_date,
                "SCHEDULED_AT": f"{game_date}T23:30:00Z",
                "HOME_TEAM_ID": home,
                "AWAY_TEAM_ID": away,
                "GAME_STATUS": "scheduled",
            })
    return pd.DataFrame(rows)


@pytest.fixture(scope="module")
def future(future_schedule, rosters) -> pd.DataFrame:
    return prospective_universe(
        future_schedule, rosters, FUTURE_DATES[0], FUTURE_DATES[-1]
    )


@pytest.fixture(scope="module")
def built(history, future) -> pd.DataFrame:
    """the whole projected week, built one date at a time. one build per date,
    so it is shared across the tests that read it rather than recomputed."""
    return build_prospective_features(history, future)


# ---------------------------------------------------------------------------
class TestRosterAssignments:
    def test_it_accepts_the_database_column_names(self):
        frame = pd.DataFrame({
            "nba_player_id": ["1", "2"], "team_id": ["10", "20"], "extra": [1, 2],
        })

        out = roster_assignments(frame)

        assert list(out.columns) == ["PLAYER_ID", "TEAM_ID"]
        assert out["PLAYER_ID"].tolist() == ["1", "2"]

    def test_a_player_on_two_rosters_is_deduplicated_not_multiplied(self):
        # a duplicate would multiply his team-games, which is a silent row-count
        # bug rather than a visible error
        frame = pd.DataFrame({"PLAYER_ID": ["1", "1"], "TEAM_ID": ["10", "20"]})

        out = roster_assignments(frame)

        assert len(out) == 1
        assert out["TEAM_ID"].iloc[0] == "20"  # the last one wins

    def test_a_frame_without_the_columns_is_refused(self):
        with pytest.raises(ValueError, match="PLAYER_ID"):
            roster_assignments(pd.DataFrame({"player": ["1"]}))


class TestProspectiveUniverse:
    def test_it_produces_one_row_per_rostered_player_per_team_game(self, future, rosters):
        team_games = future.groupby(["GAME_ID", "TEAM_ID"]).ngroups

        assert len(future) == len(rosters) * len(FUTURE_DATES)
        assert team_games == future["TEAM_ID"].nunique() * len(FUTURE_DATES)

    def test_every_row_is_labelled_prospective(self, future):
        # a third UNIVERSE_SOURCE value, not a reuse: 'status' would claim these
        # came off an inactive list and 'approximation' would attract predict.py's
        # biased-universe refusal, which is about a different defect
        assert set(future["UNIVERSE_SOURCE"]) == {SOURCE_PROSPECTIVE}

    def test_it_carries_the_universe_schema(self, future):
        assert not [c for c in UNIVERSE_COLS if c not in future.columns]

    def test_outcomes_are_written_as_a_non_appearance(self, future):
        assert (future["PLAYED"] == 0).all()
        assert (future["MIN"] == 0).all()
        assert (future["PTS"] == 0).all()

    def test_listed_inactive_is_null_not_false(self, future):
        # nobody has been ruled out of a game that has not been scheduled to a
        # report yet, and False would assert they had been ruled IN
        assert future["LISTED_INACTIVE"].isna().all()

    def test_team_totals_are_null_because_no_box_score_exists(self, future):
        assert future["TEAM_PTS"].isna().all()
        assert future["TEAM_PTS_ALLOWED"].isna().all()

    def test_a_player_on_no_scheduled_team_contributes_no_rows(self, future_schedule):
        rosters = pd.DataFrame({"PLAYER_ID": ["999"], "TEAM_ID": ["not-a-team"]})

        with pytest.raises(ValueError, match="no roster assignment matched"):
            prospective_universe(
                future_schedule, rosters, FUTURE_DATES[0], FUTURE_DATES[-1]
            )

    def test_an_empty_window_is_an_error_not_an_empty_frame(self, future_schedule, rosters):
        with pytest.raises(ValueError, match="no scheduled games"):
            prospective_universe(future_schedule, rosters, "2030-01-01", "2030-01-02")


class TestHistoryFromDataset:
    def test_a_built_feature_frame_can_give_its_universe_back(self, features_status):
        recovered = history_from_dataset(features_status)

        assert len(recovered) == len(features_status)
        assert not [c for c in UNIVERSE_COLS if c not in recovered.columns]

    def test_a_frame_missing_universe_columns_is_refused(self, features_status):
        with pytest.raises(ValueError, match="missing"):
            history_from_dataset(features_status.drop(columns=["PLAYED"]))


# ---------------------------------------------------------------------------
# the thing P5 actually had to verify
# ---------------------------------------------------------------------------
class TestZeroCurrentSeasonHistory:
    """A season with NO games at all must still produce usable features.

    The spike-era feature code could plausibly have assumed at least one game in
    the current season - several of its windows are season-scoped - so this is
    the check that the prior-season fallback really carries a returning player
    into an opening-night projection.
    """

    def test_every_scheduled_row_survives_the_feature_build(self, built, future):
        # the failure this guards against is SILENCE: a player dropped by a join
        # produces no row, no warning and no prediction
        assert len(built) == len(future)

    def test_a_returning_player_keeps_his_prior_season_form(self, built, history):
        # established players only. A fixture player who debuted in the last week
        # of the previous season has fewer than MIN_APPEARANCES_FOR_HISTORY
        # appearances and is CORRECTLY still flagged insufficient - the flag is
        # about how much history exists, not about which season it is in.
        appearances = history[history["PLAYED"] == 1].groupby("PLAYER_ID").size()
        established = set(appearances[appearances >= MIN_APPEARANCES_FOR_HISTORY].index)
        rows = built[built["PLAYER_ID"].isin(established)]

        assert len(rows) > 0
        # the CAREER-scoped as-of joins may span the offseason, which is exactly
        # what a first-game-of-the-season row needs
        assert rows["roll5_MIN"].notna().all()
        assert (rows["has_history"] == 1).all()
        assert (rows["insufficient_history"] == 0).all()

    def test_a_thinly_established_player_is_flagged_rather_than_dropped(
        self, built, history
    ):
        appearances = history[history["PLAYED"] == 1].groupby("PLAYER_ID").size()
        thin = set(appearances[appearances < MIN_APPEARANCES_FOR_HISTORY].index)
        rows = built[built["PLAYER_ID"].isin(thin)]

        if rows.empty:
            pytest.skip("this fixture set has no player with 1-2 career appearances")
        assert (rows["insufficient_history"] == 1).all()

    def test_the_season_scoped_windows_are_null_and_that_is_correct(self, built):
        # season-to-date means reset at the season boundary, and this season has
        # no games. Null is the honest answer; LightGBM reads it as missing.
        assert built["std_PTS"].isna().all()
        assert built["season_appearances"].isna().all()

    def test_a_player_with_no_nba_history_gets_a_flagged_row_not_silence(
        self, history, future_schedule
    ):
        rookie = pd.DataFrame({
            "PLAYER_ID": ["rookie-1"],
            "TEAM_ID": [sorted(history["TEAM_ID"].unique())[0]],
        })
        future = prospective_universe(
            future_schedule, rookie, FUTURE_DATES[0], FUTURE_DATES[0]
        )

        built = build_prospective_features(history, future)

        assert len(built) == len(future) > 0
        assert (built["has_history"] == 0).all()
        assert (built["insufficient_history"] == 1).all()
        # the whole point: he is PRESENT and FLAGGED. A pipeline that dropped him
        # would look identical to one that had no rookies to project.
        assert built["PLAYER_ID"].tolist() == ["rookie-1"] * len(built)

    def test_every_projected_row_falls_inside_the_cold_start_window_when_it_should(
        self, built
    ):
        flags = is_cold_start(built["GAME_DATE"], through="2025-12-31")

        assert bool(flags.all())


class TestOneDateAtATime:
    """A future row must never enter a LATER future row's availability windows.

    ``features._availability_history`` computes shifted rolling means over the
    player's whole SCHEDULED series, and a future row carries ``PLAYED = 0``. Build
    a whole week at once and by Friday a healthy starter has three fabricated
    absences on his record. Building one date at a time makes that impossible.
    """

    def test_the_per_date_build_matches_scoring_that_date_alone(
        self, history, future, built
    ):
        last_date = pd.Timestamp(FUTURE_DATES[-1])

        alone = build_prospective_features(
            history, future[pd.to_datetime(future["GAME_DATE"]) == last_date]
        )
        key = ["PLAYER_ID", "GAME_ID", "TEAM_ID"]
        from_week = (
            built[pd.to_datetime(built["GAME_DATE"]) == last_date]
            .set_index(key).sort_index()
        )
        from_alone = alone.set_index(key).sort_index()

        assert from_week.index.equals(from_alone.index)
        for column in ("avail_rate_10", "avail_rate_20", "roll5_MIN", "ewma_MIN"):
            np.testing.assert_allclose(
                from_week[column].to_numpy(dtype=float),
                from_alone[column].to_numpy(dtype=float),
                equal_nan=True,
                err_msg=f"{column} depends on an earlier future date",
            )

    def test_the_naive_single_build_really_does_leak(self, history, future):
        """the leak the loop prevents, demonstrated rather than asserted.

        If this ever stops failing to match, either the availability windows have
        stopped reading scheduled rows or the fixture stopped scheduling the same
        player twice - and in both cases the guarantee above has become vacuous.
        """
        naive = build_features(
            pd.concat([history, future], ignore_index=True)
        )
        naive = naive[naive["UNIVERSE_SOURCE"] == SOURCE_PROSPECTIVE]
        last_date = pd.Timestamp(FUTURE_DATES[-1])
        naive_last = naive[pd.to_datetime(naive["GAME_DATE"]) == last_date]

        correct = build_prospective_features(
            history, future[pd.to_datetime(future["GAME_DATE"]) == last_date]
        )

        key = ["PLAYER_ID", "GAME_ID", "TEAM_ID"]
        left = naive_last.set_index(key).sort_index()["avail_rate_10"]
        right = correct.set_index(key).sort_index()["avail_rate_10"]

        # the naive build has folded two fabricated absences into the window, so
        # its availability rate is strictly LOWER for at least one player
        assert (left.to_numpy() < right.to_numpy()).any(), (
            "the naive whole-week build no longer differs from the per-date one; "
            "either the leak is gone or this test can no longer see it"
        )
