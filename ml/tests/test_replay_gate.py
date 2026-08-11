"""the October replay gate — MODEL.md 13.7's acceptance criteria, mechanised.

WHAT THESE TESTS ARE FOR. The gate's job is to turn three frozen numbers into a
verdict, and the two ways it could fail silently are both about where the numbers
come from:

  1. a threshold defined in the gate rather than READ from the freeze. Then the
     gate has its own opinion, and section 13.7 becomes decoration.
  2. a metric computed over the wrong rows. Minutes MAE over scheduled rows
     instead of appearances would fold availability error into the minutes ratio
     and quietly change what criterion 3 means.

Both are pinned below. The gate's actual verdict on real data is not a test - it
is a measurement, it lives in reports/october_replay_20260818.md, and a test that
asserted its value would turn a finding into a fixture.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.config import (
    MODELS_DIR,
    PROSPECTIVE_MODEL_VERSION,
    PROSPECTIVE_OCTOBER_GATE,
    PROSPECTIVE_OCTOBER_REPLAY_WINDOW,
)
from fnba_ml.models import MIN_PRED, P_PLAY

from replay_gate import (
    brier,
    cohort_table,
    coverage,
    evaluate_gate,
    minutes_mae,
    verify_pinned_artifact,
)


def scored(played, p_play, minutes_actual, minutes_pred, tier="starter (20-30)"):
    return pd.DataFrame({
        "PLAYED": played,
        P_PLAY: p_play,
        "MIN": minutes_actual,
        MIN_PRED: minutes_pred,
        "MIN_TIER": [tier] * len(played),
    })


# ---------------------------------------------------------------------------
class TestMetrics:
    def test_brier_is_the_mean_squared_probability_error(self):
        frame = scored([1, 0], [0.8, 0.3], [30.0, 0.0], [28.0, 20.0])

        # (0.8-1)^2 = 0.04, (0.3-0)^2 = 0.09
        assert brier(frame) == pytest.approx(0.065)

    def test_a_perfect_forecast_scores_zero(self):
        assert brier(scored([1, 0], [1.0, 0.0], [30.0, 0.0], [30.0, 0.0])) == 0.0

    def test_minutes_mae_reads_appearance_rows_only(self):
        # THE ONE THAT MATTERS. The non-appearance's MIN is 0 and its MIN_PRED is
        # a conditional estimate of 24; including it would add 24 minutes of
        # "error" that is really the availability model's business, and criterion
        # 3 would stop measuring minutes.
        frame = scored([1, 0], [0.9, 0.2], [30.0, 0.0], [26.0, 24.0])

        assert minutes_mae(frame) == pytest.approx(4.0)

    def test_minutes_mae_is_nan_when_nobody_appeared(self):
        frame = scored([0, 0], [0.2, 0.1], [0.0, 0.0], [10.0, 12.0])

        assert np.isnan(minutes_mae(frame))

    def test_coverage_counts_a_row_only_when_both_numbers_are_finite(self):
        # a P(play) with no minutes beside it cannot be composed into any served
        # stat, so counting it would count a prediction nothing can display
        frame = scored([1, 1, 1], [0.9, 0.8, 0.7], [30.0] * 3, [26.0, np.nan, 22.0])

        assert coverage(frame, scheduled=3) == pytest.approx(2 / 3)

    def test_coverage_is_measured_against_the_scheduled_count_not_the_scored_one(self):
        # a replay that silently drops the rows it finds hard is measuring the
        # wrong month (13.7 criterion 1), so the denominator is what was SCHEDULED
        frame = scored([1, 1], [0.9, 0.8], [30.0, 28.0], [26.0, 25.0])

        assert coverage(frame, scheduled=4) == pytest.approx(0.5)


class TestVerdict:
    """the three criteria, and where their bars come from."""

    @staticmethod
    def _sides(brier_error_scale=1.0, mae_error_scale=1.0):
        """two windows whose ratios are exactly what the scales say.

        the non-October side carries REAL error on both metrics — a zero-error
        baseline would make every ratio a division by zero and the tests would
        pass on NaN rather than on arithmetic. Scaling October's errors by ``k``
        multiplies its Brier by ``k**2`` (a squared error) and its minutes MAE by
        ``k`` (an absolute one), which is what the assertions below rely on.
        """
        rest = scored([1, 0, 1, 0], [0.9, 0.2, 0.85, 0.25],
                      [30.0, 0.0, 28.0, 0.0], [32.0, 20.0, 26.0, 18.0])
        err = 2.0 * mae_error_scale
        k = brier_error_scale
        october = scored(
            [1, 0, 1, 0],
            [1 - 0.10 * k, 0.20 * k, 1 - 0.15 * k, 0.25 * k],
            [30.0, 0.0, 28.0, 0.0],
            [30.0 + err, 20.0, 28.0 - err, 18.0],
        )
        return october, rest

    def test_the_bars_are_read_from_the_frozen_block_not_defined_here(self):
        october, rest = self._sides()

        verdict = evaluate_gate(october, rest, scheduled_october=len(october))

        bars = dict(zip(verdict["criterion"], verdict["bar"]))
        assert bars["1. prediction coverage"] == PROSPECTIVE_OCTOBER_GATE[
            "min_prediction_coverage"]
        assert bars["2. October / non-October Brier"] == PROSPECTIVE_OCTOBER_GATE[
            "max_brier_ratio"]
        assert bars["3. October / non-October minutes MAE"] == PROSPECTIVE_OCTOBER_GATE[
            "max_minutes_mae_ratio"]

    def test_an_identical_october_passes_every_criterion(self):
        october, rest = self._sides()

        verdict = evaluate_gate(october, rest, scheduled_october=len(october))

        assert bool(verdict["pass"].all())

    def test_a_brier_ratio_past_the_bar_fails_criterion_two(self):
        # the bar is 1.42x, the measured fringe/ALL ratio from the 5.1 bracket
        october, rest = self._sides(brier_error_scale=3.0)

        verdict = evaluate_gate(october, rest, scheduled_october=len(october))
        row = verdict[verdict["criterion"].str.startswith("2.")].iloc[0]

        assert row["observed"] > PROSPECTIVE_OCTOBER_GATE["max_brier_ratio"]
        assert not row["pass"]

    def test_a_minutes_ratio_past_the_bar_fails_criterion_three(self):
        october, rest = self._sides(mae_error_scale=3.0)

        verdict = evaluate_gate(october, rest, scheduled_october=len(october))
        row = verdict[verdict["criterion"].str.startswith("3.")].iloc[0]

        assert row["observed"] > PROSPECTIVE_OCTOBER_GATE["max_minutes_mae_ratio"]
        assert not row["pass"]

    def test_dropped_rows_fail_criterion_one(self):
        october, rest = self._sides()

        # four rows scored against ten scheduled: 40% coverage
        verdict = evaluate_gate(october, rest, scheduled_october=10)
        row = verdict[verdict["criterion"].str.startswith("1.")].iloc[0]

        assert not row["pass"]

    def test_the_direction_column_says_which_way_a_failure_lies(self):
        october, rest = self._sides()

        verdict = evaluate_gate(october, rest, scheduled_october=len(october))

        assert verdict["direction"].tolist() == [">=", "<=", "<="]


class TestCohortTable:
    def test_it_reports_all_plus_every_tier_present(self):
        october = pd.concat([
            scored([1, 0], [0.9, 0.2], [30.0, 0.0], [30.0, 20.0], tier="star (>=30)"),
            scored([1, 0], [0.5, 0.5], [8.0, 0.0], [10.0, 9.0], tier="fringe (<10)"),
        ], ignore_index=True)
        rest = october.copy()

        table = cohort_table(october, rest)

        assert table["cohort"].tolist() == ["ALL", "fringe (<10)", "star (>=30)"]
        assert table["oct_rows"].iloc[0] == 4

    def test_identical_sides_give_ratios_of_one(self):
        october = scored([1, 0], [0.9, 0.2], [30.0, 0.0], [26.0, 20.0])

        table = cohort_table(october, october.copy())

        assert table["brier_ratio"].iloc[0] == pytest.approx(1.0)
        assert table["min_mae_ratio"].iloc[0] == pytest.approx(1.0)


class TestPinnedArtifact:
    """criterion 4: the replay uses the pinned checksums."""

    def test_the_frozen_artifact_on_disk_still_matches(self):
        ok, problems = verify_pinned_artifact(PROSPECTIVE_MODEL_VERSION, MODELS_DIR)

        assert ok, f"the frozen artifact has drifted: {problems}"

    def test_any_other_version_fails_by_definition(self):
        # a replay against a differently-trained artifact tells us about that
        # artifact, so "is it pinned" is not a question a flag can answer
        ok, problems = verify_pinned_artifact("not-the-frozen-one", MODELS_DIR)

        assert ok is False
        assert PROSPECTIVE_MODEL_VERSION in problems[0]

    def test_an_extra_file_in_the_directory_would_fail(self, tmp_path):
        # six per-file assertions would all pass while a seventh, unwatched, file
        # sat in the directory being loaded
        version = tmp_path / PROSPECTIVE_MODEL_VERSION
        version.mkdir()
        (version / "stowaway.joblib").write_bytes(b"")

        ok, problems = verify_pinned_artifact(PROSPECTIVE_MODEL_VERSION, tmp_path)

        assert ok is False
        assert any("stowaway.joblib" in p for p in problems)


def test_the_replay_window_is_the_frozen_one():
    # the gate replays what 13.7 says it replays; a window argument exists for
    # exploration and its DEFAULT is the freeze
    assert PROSPECTIVE_OCTOBER_REPLAY_WINDOW == ("2025-10-01", "2025-10-31")
