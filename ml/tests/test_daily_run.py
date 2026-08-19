"""the four decisions ``daily_run.py`` makes that nothing downstream would catch.

WHAT IS AND IS NOT TESTED HERE, because the boundary is the point of the file.

``daily_run.py`` is a pipeline: it queries the schedule, drives ``build_dataset.py``,
``fnba_ml.prospective`` and ``predict.py``, and prints a summary. Almost none of that
is new behaviour and all of it is already covered - ``test_prospective.py`` for the
future-row construction, ``test_predictions.py`` for the serving path,
``test_prospective_freeze.py`` for the artifact. Re-testing it through a driver would
need a database and would prove nothing that is not already proven.

Four things ARE new, and each of them can be wrong in a way that produces a
plausible-looking run rather than an error:

  1. **The window.** Off by one timezone and the 5pm ET cron asks for tomorrow's
     slate every single evening, publishes it, and the store fills with runs whose
     horizon is 27 hours.
  2. **The staleness rule.** Too strict and the run refuses to serve on an ordinary
     overnight; too loose and it serves week-old form without saying so.
  3. **The prospective label.** MODEL.md 13.8.4 makes the label the definition of
     what counts, so a run that carries it wrongly contaminates the first genuinely
     untouched evaluation this system will get - silently, and only visibly in April.
  4. **The post-tipoff filter.** 13.8.2 is the one rule in section 13 with no
     judgement in it. A single post-tipoff row makes every season aggregate
     unauditable, and ``predict.py`` has no notion of a tip time, so this is the only
     place the rule can be enforced.

All four are pure functions taking their inputs as arguments, which is why they are
pure functions: a rule that can only be exercised by running the pipeline is a rule
nobody will exercise.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

import pandas as pd
import pytest

import daily_run
from fnba_ml import config
from fnba_ml.prospective import SOURCE_PROSPECTIVE

# ---------------------------------------------------------------------------
# 1. the window
# ---------------------------------------------------------------------------


class TestEasternToday:
    """the Eastern calendar date, which is the date a schedule row carries."""

    @pytest.mark.parametrize(
        ("utc", "expected"),
        [
            # EDT (UTC-4). 03:30Z on the 19th is 23:30 on the 18th in New York, and
            # the 18th is the date whose slate a manager is still setting a lineup for.
            ("2026-08-19T03:30:00Z", date(2026, 8, 18)),
            ("2026-08-19T04:30:00Z", date(2026, 8, 19)),
            # EST (UTC-5). the offset changes and the rule must not.
            ("2026-12-15T04:30:00Z", date(2026, 12, 14)),
            ("2026-12-15T05:30:00Z", date(2026, 12, 15)),
            # the cron's own instant, 21:00Z, is mid-afternoon Eastern in both halves
            # of the year, which is the whole reason 21:00 was chosen.
            ("2026-10-20T21:00:00Z", date(2026, 10, 20)),
            ("2027-01-20T21:00:00Z", date(2027, 1, 20)),
        ],
    )
    def test_utc_instant_maps_to_the_eastern_date(self, utc: str, expected: date) -> None:
        assert daily_run.eastern_today(pd.Timestamp(utc).to_pydatetime()) == expected

    def test_a_naive_now_is_read_as_utc(self) -> None:
        """no ambient local timezone. a runner in any region must agree with prod."""
        naive = datetime(2026, 8, 19, 3, 30)
        aware = datetime(2026, 8, 19, 3, 30, tzinfo=timezone.utc)
        assert daily_run.eastern_today(naive) == daily_run.eastern_today(aware)

    def test_the_utc_date_and_the_eastern_date_genuinely_differ(self) -> None:
        """the guard against 'it passes because the timezone never mattered'."""
        instant = datetime(2026, 10, 21, 2, 0, tzinfo=timezone.utc)
        assert instant.date() == date(2026, 10, 21)
        assert daily_run.eastern_today(instant) == date(2026, 10, 20)


class TestPredictionWindow:
    def test_default_is_today_and_tomorrow(self) -> None:
        now = datetime(2026, 10, 20, 21, 0, tzinfo=timezone.utc)
        assert daily_run.prediction_window(2, now=now) == (
            date(2026, 10, 20), date(2026, 10, 21),
        )

    def test_one_day_window_is_today_only(self) -> None:
        now = datetime(2026, 10, 20, 21, 0, tzinfo=timezone.utc)
        start, end = daily_run.prediction_window(1, now=now)
        assert start == end == date(2026, 10, 20)

    def test_window_extends_forward_never_backward(self) -> None:
        """13.8.2 forbids backfilling a missed slate; the arithmetic cannot express it."""
        for days in (1, 2, 3, 7):
            start, end = daily_run.prediction_window(
                days, now=datetime(2026, 12, 1, 21, 0, tzinfo=timezone.utc)
            )
            assert start == date(2026, 12, 1)
            assert end >= start
            assert (end - start).days == days - 1

    @pytest.mark.parametrize("days", [0, -1, -7])
    def test_a_non_positive_window_is_refused(self, days: int) -> None:
        with pytest.raises(ValueError, match="at least 1"):
            daily_run.prediction_window(days)

    def test_window_start_accepts_a_string_or_a_date(self) -> None:
        expected = (date(2026, 10, 20), date(2026, 10, 21))
        assert daily_run.prediction_window(2, "2026-10-20") == expected
        assert daily_run.prediction_window(2, date(2026, 10, 20)) == expected

    def test_window_start_ignores_today(self) -> None:
        """the escape hatch overrides the clock and nothing else."""
        start, _ = daily_run.prediction_window(
            2, "2026-10-20", now=datetime(2027, 3, 1, tzinfo=timezone.utc)
        )
        assert start == date(2026, 10, 20)

    def test_a_month_boundary_does_not_wrap(self) -> None:
        assert daily_run.prediction_window(3, "2026-10-30") == (
            date(2026, 10, 30), date(2026, 11, 1),
        )


# ---------------------------------------------------------------------------
# 2. the staleness rule
# ---------------------------------------------------------------------------


class TestStalenessWarning:
    def test_no_lag_is_not_stale(self) -> None:
        assert daily_run.staleness_warning(
            date(2026, 12, 1), date(2026, 12, 1)
        ) is None

    @pytest.mark.parametrize("lag", [1, 2, 3])
    def test_a_lag_within_tolerance_is_not_stale(self, lag: int) -> None:
        """the scraper runs every six hours, so an overnight gap is ordinary."""
        logs = date(2026, 12, 1)
        schedule = date(2026, 12, 1) + pd.Timedelta(days=lag).to_pytimedelta()
        assert daily_run.staleness_warning(logs, schedule) is None

    @pytest.mark.parametrize("lag", [4, 10, 90])
    def test_a_lag_past_tolerance_returns_a_message(self, lag: int) -> None:
        logs = date(2026, 12, 1)
        schedule = logs + pd.Timedelta(days=lag).to_pytimedelta()
        message = daily_run.staleness_warning(logs, schedule)
        assert message is not None
        # the message is what lands in prediction_runs.notes, so it has to carry
        # both dates and the size of the gap - a bare "STALE" is unauditable later.
        assert "STALE" in message
        assert str(logs) in message
        assert str(schedule) in message
        assert f"{lag} days behind" in message

    def test_the_boundary_is_inclusive(self) -> None:
        """exactly at the tolerance is not stale; one day past it is."""
        logs = date(2026, 12, 1)
        edge = logs + pd.Timedelta(days=daily_run.STALE_AFTER_DAYS).to_pytimedelta()
        assert daily_run.staleness_warning(logs, edge) is None
        over = edge + pd.Timedelta(days=1).to_pytimedelta()
        assert daily_run.staleness_warning(logs, over) is not None

    def test_nothing_behind_the_window_is_not_stale(self) -> None:
        """opening night: no game has been played, so nothing is missing."""
        assert daily_run.staleness_warning(None, None) is None
        assert daily_run.staleness_warning(date(2026, 4, 12), None) is None

    def test_an_empty_truth_layer_with_games_behind_us_is_stale(self) -> None:
        """the case the check exists for must not be the case it is silent on."""
        message = daily_run.staleness_warning(None, date(2026, 12, 1))
        assert message is not None
        assert "empty" in message

    def test_tolerance_is_configurable_for_the_caller(self) -> None:
        logs, schedule = date(2026, 12, 1), date(2026, 12, 3)
        assert daily_run.staleness_warning(logs, schedule, max_lag_days=1) is not None
        assert daily_run.staleness_warning(logs, schedule, max_lag_days=5) is None


# ---------------------------------------------------------------------------
# 3. the prospective label
# ---------------------------------------------------------------------------


def _qualifying(**overrides: object) -> dict[str, object]:
    """the argument set a real 2026-27 gameday run makes. every value from the freeze."""
    kwargs: dict[str, object] = {
        "seasons": [str(config.PROSPECTIVE_2026_27["season"])],
        "season_types": ["Regular Season"],
        "horizon": config.PROSPECTIVE_SERVING_HORIZON,
        "model_version": config.PROSPECTIVE_MODEL_VERSION,
        "feature_version": config.PROSPECTIVE_FEATURE_VERSION,
        "universe_source": SOURCE_PROSPECTIVE,
        "artifact_verified": True,
    }
    kwargs.update(overrides)
    return kwargs


class TestProspectiveConditions:
    def test_a_real_gameday_run_qualifies(self) -> None:
        assert daily_run.prospective_conditions(**_qualifying()) == []

    @pytest.mark.parametrize(
        ("override", "fragment"),
        [
            ({"seasons": ["2025-26"]}, "season 2025-26"),
            ({"seasons": []}, "no season"),
            ({"season_types": ["Pre Season"]}, "season_type Pre Season"),
            ({"horizon": "early"}, "horizon early"),
            ({"horizon": "lock"}, "horizon lock"),
            ({"model_version": "20260817d"}, "model 20260817d"),
            ({"feature_version": "v4"}, "feature_version v4"),
            ({"universe_source": "approximation"}, "universe approximation"),
            ({"universe_source": "status"}, "universe status"),
            ({"artifact_verified": False}, "checksums not verified"),
        ],
    )
    def test_each_condition_disqualifies_on_its_own(
        self, override: dict[str, object], fragment: str
    ) -> None:
        reasons = daily_run.prospective_conditions(**_qualifying(**override))
        assert reasons, f"{override} should have disqualified the run"
        assert any(fragment in r for r in reasons), reasons

    def test_a_mixed_season_window_disqualifies(self) -> None:
        """a window straddling the rollover is not a 2026-27 run for all of its rows."""
        reasons = daily_run.prospective_conditions(
            **_qualifying(seasons=["2026-27", "2027-28"])
        )
        assert reasons and "2027-28" in reasons[0]

    def test_the_frozen_season_is_read_from_the_freeze(self) -> None:
        """no second copy of '2026-27' in the driver (section 13's own preamble)."""
        source = (daily_run.__file__ or "")
        text = open(source, encoding="utf-8").read()
        assert '"2026-27"' not in text and "'2026-27'" not in text

    def test_every_failure_is_reported_not_just_the_first(self) -> None:
        reasons = daily_run.prospective_conditions(
            **_qualifying(seasons=["2025-26"], horizon="lock", artifact_verified=False)
        )
        assert len(reasons) == 3


class TestRunNotes:
    def test_a_qualifying_run_carries_the_frozen_note(self) -> None:
        """13.4 fixes the served run's note verbatim."""
        note = daily_run.run_notes([])
        assert note == (
            f"{config.PROSPECTIVE_RUN_NOTE_LABEL}; "
            f"feature_set={config.SERVED_FEATURE_SET}; shadow=false"
        )

    def test_a_disqualified_run_never_carries_the_label(self) -> None:
        """the load-bearing assertion: a look report selects the season by substring."""
        note = daily_run.run_notes(["horizon lock is not gameday"])
        assert config.PROSPECTIVE_RUN_NOTE_LABEL not in note
        assert "NOT PROSPECTIVE" in note
        assert "horizon lock is not gameday" in note

    def test_the_reason_text_cannot_smuggle_the_label_in(self) -> None:
        """a reworded reason must fail loudly rather than contaminate the season."""
        with pytest.raises(AssertionError, match=config.PROSPECTIVE_RUN_NOTE_LABEL):
            daily_run.run_notes([f"not {config.PROSPECTIVE_RUN_NOTE_LABEL}"])

    def test_the_feature_set_and_shadow_flags_are_always_present(self) -> None:
        for reasons in ([], ["something"]):
            note = daily_run.run_notes(reasons)
            assert f"feature_set={config.SERVED_FEATURE_SET}" in note
            assert "shadow=false" in note

    def test_staleness_is_appended_to_either_form(self) -> None:
        stale = "STALE truth layer: game logs end 2026-11-20"
        assert stale in daily_run.run_notes([], stale)
        assert stale in daily_run.run_notes(["horizon lock is not gameday"], stale)

    def test_a_stale_qualifying_run_still_carries_the_label(self) -> None:
        """staleness is a warning, not a disqualification: 13.8.1 is best effort."""
        note = daily_run.run_notes([], "STALE truth layer: 9 days behind")
        assert note.startswith(config.PROSPECTIVE_RUN_NOTE_LABEL)


# ---------------------------------------------------------------------------
# 4. the post-tipoff filter
# ---------------------------------------------------------------------------


def _slate() -> pd.DataFrame:
    """three real 2026-10-20 tips: 3pm, 7pm and 9:30pm ET, in UTC."""
    return pd.DataFrame(
        {
            "GAME_ID": ["0022600001", "0022600002", "0022600003"],
            "GAME_DATE": pd.to_datetime(["2026-10-20"] * 3),
            "SCHEDULED_AT": pd.to_datetime(
                [
                    "2026-10-20T19:00:00Z",
                    "2026-10-20T23:00:00Z",
                    "2026-10-21T01:30:00Z",
                ]
            ),
        }
    )


class TestDropTippedOff:
    def test_before_every_tip_nothing_is_dropped(self) -> None:
        upcoming, tipped = daily_run.drop_tipped_off(
            _slate(), pd.Timestamp("2026-10-20T17:00:00Z")
        )
        assert len(upcoming) == 3
        assert tipped.empty

    def test_the_cron_instant_drops_only_the_afternoon_game(self) -> None:
        """21:00Z is 5pm ET: the 3pm game has started, the two evening games have not."""
        upcoming, tipped = daily_run.drop_tipped_off(
            _slate(), pd.Timestamp("2026-10-20T21:00:00Z")
        )
        assert list(tipped["GAME_ID"]) == ["0022600001"]
        assert list(upcoming["GAME_ID"]) == ["0022600002", "0022600003"]

    def test_after_every_tip_nothing_survives(self) -> None:
        upcoming, tipped = daily_run.drop_tipped_off(
            _slate(), pd.Timestamp("2026-10-21T03:00:00Z")
        )
        assert upcoming.empty
        assert len(tipped) == 3

    def test_a_prediction_at_the_tip_is_not_before_it(self) -> None:
        """13.8.2 has no grace period, so neither does the comparison."""
        exact = pd.Timestamp("2026-10-20T19:00:00Z")
        upcoming, tipped = daily_run.drop_tipped_off(_slate(), exact)
        assert "0022600001" in set(tipped["GAME_ID"])
        assert "0022600001" not in set(upcoming["GAME_ID"])

    def test_a_naive_boundary_is_read_as_utc(self) -> None:
        aware = daily_run.drop_tipped_off(
            _slate(), pd.Timestamp("2026-10-20T21:00:00Z")
        )[0]
        naive = daily_run.drop_tipped_off(
            _slate(), pd.Timestamp("2026-10-20T21:00:00")
        )[0]
        assert list(aware["GAME_ID"]) == list(naive["GAME_ID"])

    def test_a_datetime_boundary_works_as_well_as_a_timestamp(self) -> None:
        upcoming, _ = daily_run.drop_tipped_off(
            _slate(), datetime(2026, 10, 20, 21, 0, tzinfo=timezone.utc)
        )
        assert len(upcoming) == 2

    def test_an_unknown_tip_falls_back_to_the_nominal_hour(self) -> None:
        """no scheduled_at: the approximation predict.py already uses, not a new one."""
        frame = _slate()
        frame["SCHEDULED_AT"] = pd.NaT
        # nominal tip is GAME_DATE + NOMINAL_TIP_HOUR_UTC, i.e. 2026-10-20T00:00Z,
        # which is EARLIER than every real tip - so an unknown tip is dropped rather
        # than published on an optimistic guess.
        upcoming, tipped = daily_run.drop_tipped_off(
            frame, pd.Timestamp("2026-10-20T12:00:00Z")
        )
        assert upcoming.empty and len(tipped) == 3
        upcoming, tipped = daily_run.drop_tipped_off(
            frame, pd.Timestamp("2026-10-19T12:00:00Z")
        )
        assert len(upcoming) == 3 and tipped.empty

    def test_a_missing_scheduled_at_column_falls_back_too(self) -> None:
        frame = _slate().drop(columns=["SCHEDULED_AT"])
        upcoming, tipped = daily_run.drop_tipped_off(
            frame, pd.Timestamp("2026-10-20T12:00:00Z")
        )
        assert upcoming.empty and len(tipped) == 3

    def test_a_partial_scheduled_at_uses_the_real_one_where_it_has_it(self) -> None:
        frame = _slate()
        frame.loc[1, "SCHEDULED_AT"] = pd.NaT
        upcoming, tipped = daily_run.drop_tipped_off(
            frame, pd.Timestamp("2026-10-20T18:00:00Z")
        )
        # row 0 tips at 19:00Z (upcoming), row 1 is approximated to 00:00Z (dropped),
        # row 2 tips at 01:30Z the next day (upcoming).
        assert list(upcoming["GAME_ID"]) == ["0022600001", "0022600003"]
        assert list(tipped["GAME_ID"]) == ["0022600002"]

    def test_a_naive_scheduled_at_is_read_as_utc(self) -> None:
        frame = _slate()
        frame["SCHEDULED_AT"] = pd.to_datetime(
            ["2026-10-20T19:00:00", "2026-10-20T23:00:00", "2026-10-21T01:30:00"]
        )
        upcoming, _ = daily_run.drop_tipped_off(
            frame, pd.Timestamp("2026-10-20T21:00:00Z")
        )
        assert list(upcoming["GAME_ID"]) == ["0022600002", "0022600003"]

    def test_the_two_halves_partition_the_frame(self) -> None:
        """no row may be lost and none may be counted twice."""
        for hour in range(0, 30, 3):
            now = pd.Timestamp("2026-10-20T00:00:00Z") + pd.Timedelta(hours=hour)
            upcoming, tipped = daily_run.drop_tipped_off(_slate(), now)
            assert len(upcoming) + len(tipped) == 3
            assert set(upcoming["GAME_ID"]).isdisjoint(set(tipped["GAME_ID"]))

    def test_an_empty_frame_survives(self) -> None:
        empty = _slate().iloc[:0]
        upcoming, tipped = daily_run.drop_tipped_off(
            empty, pd.Timestamp("2026-10-20T21:00:00Z")
        )
        assert upcoming.empty and tipped.empty

    def test_it_does_not_mutate_its_input(self) -> None:
        frame = _slate()
        before = frame.copy()
        daily_run.drop_tipped_off(frame, pd.Timestamp("2026-10-20T21:00:00Z"))
        pd.testing.assert_frame_equal(frame, before)

    def test_the_nominal_hour_is_predicts_own(self) -> None:
        """one nominal tip in the package, not two that can drift apart."""
        import predict

        frame = _slate().drop(columns=["SCHEDULED_AT"])
        tip = daily_run.nominal_tip(frame)
        expected = pd.Timestamp("2026-10-20T00:00:00Z") + pd.Timedelta(
            hours=predict.NOMINAL_TIP_HOUR_UTC
        )
        assert (tip == expected).all()


# ---------------------------------------------------------------------------
# 5. the preflight, and the phase contract
# ---------------------------------------------------------------------------


class TestVerifyPinnedArtifact:
    def test_the_checked_in_artifact_verifies(self) -> None:
        """the same claim test_prospective_freeze makes, through the run-time path."""
        assert daily_run.verify_pinned_artifact() == []

    def test_a_missing_directory_is_reported_not_silently_passed(self, tmp_path) -> None:
        bad = daily_run.verify_pinned_artifact(tmp_path)
        assert bad and "missing" in bad[0]

    def test_a_corrupted_file_is_caught(self, tmp_path) -> None:
        target = tmp_path / config.PROSPECTIVE_MODEL_VERSION
        target.mkdir()
        for name in config.PROSPECTIVE_ARTIFACT_CHECKSUMS:
            (target / name).write_bytes(b"not the frozen bytes")
        assert sorted(daily_run.verify_pinned_artifact(tmp_path)) == sorted(
            config.PROSPECTIVE_ARTIFACT_CHECKSUMS
        )

    def test_an_extra_file_in_the_served_directory_is_caught(self, tmp_path) -> None:
        """set equality: an added file changes what 'the artifact' means."""
        real = config.MODELS_DIR / config.PROSPECTIVE_MODEL_VERSION
        target = tmp_path / config.PROSPECTIVE_MODEL_VERSION
        target.mkdir()
        for name in config.PROSPECTIVE_ARTIFACT_CHECKSUMS:
            (target / name).write_bytes((real / name).read_bytes())
        assert daily_run.verify_pinned_artifact(tmp_path) == []
        (target / "second_model.joblib").write_bytes(b"surprise")
        assert daily_run.verify_pinned_artifact(tmp_path) == ["second_model.joblib"]


class TestPhaseContract:
    def test_a_failure_names_its_phase(self) -> None:
        with pytest.raises(daily_run.PhaseFailure) as caught:
            with daily_run.phase("dataset"):
                raise RuntimeError("postgres said no")
        assert caught.value.phase == "dataset"
        assert "postgres said no" in str(caught.value)

    def test_a_driven_scripts_systemexit_is_relabelled(self) -> None:
        """predict.py signals failure with SystemExit(str); the phase name is added."""
        with pytest.raises(daily_run.PhaseFailure) as caught:
            with daily_run.phase("predict"):
                raise SystemExit("no trained model at models/20260818")
        assert caught.value.phase == "predict"
        assert "no trained model" in str(caught.value)

    def test_a_clean_no_op_passes_through_unrelabelled(self) -> None:
        """the offseason exit is not a failure and must not be dressed as one."""
        with pytest.raises(daily_run.NothingToDo):
            with daily_run.phase("schedule"):
                raise daily_run.NothingToDo("no games in window")

    def test_a_nested_phase_failure_keeps_the_inner_phase(self) -> None:
        with pytest.raises(daily_run.PhaseFailure) as caught:
            with daily_run.phase("predict"):
                raise daily_run.PhaseFailure("dataset", "already labelled")
        assert caught.value.phase == "dataset"

    def test_every_phase_the_driver_enters_is_declared(self) -> None:
        """phase() indexes into PHASES, so an undeclared phase name is a ValueError."""
        text = open(daily_run.__file__, encoding="utf-8").read()
        used = {
            line.split('phase("')[1].split('"')[0]
            for line in text.splitlines()
            if 'with phase("' in line
        }
        assert used == set(daily_run.PHASES), (
            f"declared {set(daily_run.PHASES)}, entered {used}"
        )

    def test_the_phases_are_in_pipeline_order(self) -> None:
        assert daily_run.PHASES[0] == "preflight"
        assert daily_run.PHASES[-1] == "predict"
        assert daily_run.PHASES.index("dataset") < daily_run.PHASES.index("prospective")
        assert daily_run.PHASES.index("prospective") < daily_run.PHASES.index("predict")


# ---------------------------------------------------------------------------
# 6. the command line, since the workflow is the only caller
# ---------------------------------------------------------------------------


class TestArgs:
    def test_the_scheduled_invocation_needs_no_arguments(self) -> None:
        args = daily_run.parse_args([])
        assert args.window_days == 2
        assert args.window_start is None
        assert args.dry_run is False

    def test_dry_run_is_the_only_flag_the_workflow_passes(self) -> None:
        assert daily_run.parse_args(["--dry-run"]).dry_run is True

    def test_the_out_dir_is_not_the_hand_built_dataset(self) -> None:
        """a daily run must not clobber data/dataset.parquet."""
        args = daily_run.parse_args([])
        assert args.out_dir != config.DATA_DIR
        assert args.out_dir.parent == config.DATA_DIR
