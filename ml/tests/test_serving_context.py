"""the serving-time context rebuild, and the corrected horizon definition (P1b).

TWO THINGS THIS FILE PINS, both of them in ``predict.py`` rather than in the package,
because both are properties of the ORDER in which the serving script does things.

1. THE REPORT MUST REACH THE TEAMMATE SUMS. The served teammate-context features are
   expectations over play probabilities, so a star ruled OUT has to lower his own p_j
   BEFORE the sums are taken - otherwise the serving path knows he is out (his own
   probability is corrected downstream) and declines to act on it for anyone else. The
   backup would be projected for the minutes of a night the star suits up, and every
   number on the page would look individually defensible. That is the original
   override-layer defect displaced one column to the left, and it is exactly the kind of
   bug an aggregate metric cannot see.

2. A HORIZON IS A MEASUREMENT, NOT A LABEL. The previous definitions asserted what each
   horizon "typically knows" and the ``early`` row said "no injury report yet" - false,
   because the league requires an initial participation report by 5pm local the day
   before. Two runs both tagged ``early`` can differ by twenty hours of report freshness,
   so the run has to store the offset, the report's age, and whether the initial-report
   deadline had passed.

The base model here is a stand-in that returns fixed probabilities, deliberately. What is
being tested is the sequence score -> override -> rebuild; a fitted LightGBM would make
every assertion depend on a fit and would hide the property behind it.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.config import (
    HORIZON_RUN_METADATA,
    HORIZON_WINDOWS,
    P_CONTEXT,
    P_CONTEXT_CUTOFF,
    horizon_for_offset,
)
from fnba_ml.models import LeakageError, validate_out_of_fold
from predict import horizon_metadata, rebuild_context


# ---------------------------------------------------------------------------
# 1. the corrected horizon definition
# ---------------------------------------------------------------------------
def test_horizon_windows_partition_the_offsets_and_assign_by_measurement():
    # act + assert - every bucket is reachable, and the boundaries are (lo, hi]
    assert horizon_for_offset(1.0) == "lock"
    assert horizon_for_offset(2.0) == "lock"
    assert horizon_for_offset(2.5) == "gameday"
    assert horizon_for_offset(12.0) == "gameday"
    assert horizon_for_offset(24.0) == "early"
    assert horizon_for_offset(48.0) == "early"
    # outside every window returns '' rather than being clamped into the nearest one:
    # "this run is not any of our named horizons" is a fact worth keeping
    assert horizon_for_offset(0.0) == ""
    assert horizon_for_offset(-3.0) == ""
    assert horizon_for_offset(500.0) == ""
    # and the windows abut exactly, or an offset could land in two of them
    bounds = sorted(HORIZON_WINDOWS.values())
    for (_, hi), (lo, _) in zip(bounds, bounds[1:]):
        assert hi == lo


def test_the_run_metadata_list_names_every_fact_the_comparison_needs():
    """a label alone cannot answer "do our T-60m projections beat our T-24h ones".

    dropping one of these silently makes the comparison unanswerable a season later,
    when nobody remembers what was recorded. So the list itself is pinned.
    """
    # act + assert
    assert set(HORIZON_RUN_METADATA) == {
        "hours_to_tip_min", "hours_to_tip_median", "hours_to_tip_max",
        "latest_report_at", "report_age_hours", "report_count",
        "first_deadline_passed", "horizon_measured",
    }


def _slate(dates: list[str]) -> pd.DataFrame:
    return pd.DataFrame({
        "PLAYER_ID": [str(i) for i in range(len(dates))],
        "GAME_ID": [f"g{i}" for i in range(len(dates))],
        "GAME_DATE": pd.to_datetime(dates),
    })


def test_horizon_metadata_measures_the_offset_and_the_reports_staleness():
    # arrange - two games a day apart, one report captured six hours before the boundary
    features = _slate(["2026-03-02", "2026-03-03"])
    statuses = pd.DataFrame({
        "nba_player_id": ["0"],
        "status_normalized": ["out"],
        "captured_at": ["2026-03-01T18:00:00+00:00"],
    })

    # act
    facts = horizon_metadata(
        features, statuses, pd.Timestamp("2026-03-02T00:00:00"), "early"
    )

    # assert
    assert facts["hours_to_tip_min"] == pytest.approx(0.0)
    assert facts["hours_to_tip_max"] == pytest.approx(24.0)
    assert facts["report_count"] == 1
    assert facts["report_age_hours"] == pytest.approx(6.0)
    assert facts["latest_report_at"].startswith("2026-03-01T18:00")
    assert facts["horizon_requested"] == "early (T-24h)"
    # no tipoff timestamps on the frame, so the offsets are approximated and say so.
    # reporting a guessed tip time as measured would be worse than reporting nothing.
    assert "approximated" in facts["tip_source"]


def test_horizon_metadata_records_zero_reports_as_a_fact_not_a_blank():
    """"the model stood alone" and "nobody was hurt" are different facts."""
    # act
    facts = horizon_metadata(
        _slate(["2026-03-02"]), None, pd.Timestamp("2026-03-01T18:00:00"), "gameday"
    )

    # assert
    assert facts["report_count"] == 0
    assert facts["latest_report_at"] is None
    assert facts["report_age_hours"] is None


def test_horizon_metadata_flags_a_run_before_the_initial_report_deadline():
    """the flag that separates two ``early`` runs which are not comparable."""
    # arrange - a midnight-UTC nominal tipoff, so the 5pm deadline is 2026-03-01T17:00
    features = _slate(["2026-03-02"])

    # act
    before = horizon_metadata(features, None, pd.Timestamp("2026-03-01T15:00:00"), "early")
    after = horizon_metadata(features, None, pd.Timestamp("2026-03-01T19:00:00"), "early")

    # assert
    assert before["first_deadline_passed"] is False
    assert after["first_deadline_passed"] is True


def test_horizon_metadata_uses_real_tipoff_timestamps_when_the_frame_has_them():
    """the approximation is a fallback, not the design."""
    # arrange
    features = _slate(["2026-03-02"])
    features["SCHEDULED_AT"] = pd.to_datetime(["2026-03-02T23:30:00+00:00"])

    # act
    facts = horizon_metadata(features, None, pd.Timestamp("2026-03-02T00:00:00"), "early")

    # assert
    assert facts["tip_source"] == "nba_schedule.scheduled_at"
    assert facts["hours_to_tip_median"] == pytest.approx(23.5)
    assert facts["horizon_measured"] == "early"


# ---------------------------------------------------------------------------
# 2. the serving-time context rebuild
# ---------------------------------------------------------------------------
class _FakeBaseModel:
    """a base availability model that returns a fixed probability per player."""

    def __init__(self, probabilities: dict[str, float], cutoff: pd.Timestamp) -> None:
        self.probabilities = probabilities
        self.cutoff = cutoff

    def predict_proba(self, frame: pd.DataFrame) -> np.ndarray:
        return (
            frame["PLAYER_ID"].astype(str).map(self.probabilities).to_numpy(dtype=float)
        )


def _serving_frame() -> pd.DataFrame:
    return pd.DataFrame({
        "PLAYER_ID": ["star", "backup", "other"],
        "GAME_ID": ["g1"] * 3,
        "TEAM_ID": ["t1"] * 3,
        "GAME_DATE": pd.to_datetime(["2026-03-02"] * 3),
        "POS_GROUP": ["G", "G", "F"],
        "tm_MIN": [34.0, 12.0, 20.0],
        "tm_FGA": [20.0, 5.0, 9.0],
        "tm_USG": [32.0, 14.0, 20.0],
        "magnitude_ess": [20.0, 20.0, 20.0],
        "n_appearances": [500, 200, 300],
        "avail_rate_10": [0.9, 0.9, 0.9],
    })


def test_the_report_reaches_the_teammate_sums_not_only_the_players_own_number():
    """THE serving property the round-2 review made necessary."""
    # arrange
    frame = _serving_frame()
    base = _FakeBaseModel(
        {"star": 0.93, "backup": 0.88, "other": 0.9}, pd.Timestamp("2026-03-01")
    )
    statuses = pd.DataFrame({
        "nba_player_id": ["star"],
        "status_normalized": ["out"],
        "captured_at": ["2026-03-01T18:00:00+00:00"],
    })
    as_of = pd.Timestamp("2026-03-02T00:00:00")

    # act
    without, _ = rebuild_context(frame, base, None, as_of)
    with_report, audit = rebuild_context(frame, base, statuses, as_of)

    # assert - the backup's expected vacancy rises by EXACTLY the probability shift times
    # the star's magnitude: (1 - 0.02) - (1 - 0.93) = 0.91, times 34 minutes
    delta = (
        with_report.loc[1, "exp_vacated_minutes"]
        - without.loc[1, "exp_vacated_minutes"]
    )
    assert delta == pytest.approx((0.93 - 0.02) * 34.0)
    # his expected depth rank falls, because the man ahead of him is now unlikely to play
    assert with_report.loc[1, "exp_depth_rank"] < without.loc[1, "exp_depth_rank"]
    # p_star_out is near-certain for the teammates and still 0 for the star himself
    assert with_report.loc[1, "p_star_out"] == pytest.approx(0.98)
    assert with_report.loc[0, "p_star_out"] == pytest.approx(0.0)
    # both probabilities are on the audit frame, so the layer stays measurable against
    # the model it corrects
    assert audit.loc[0, "P_CONTEXT_BASE"] == pytest.approx(0.93)
    assert audit.loc[0, "P_CONTEXT"] == pytest.approx(0.02)
    assert audit["CONTEXT_OVERRIDDEN"].tolist() == [True, False, False]


def test_no_report_is_an_identity_on_the_context(monkeypatch):
    """an absent statuses frame must leave every expected column exactly as scored."""
    # arrange
    frame = _serving_frame()
    base = _FakeBaseModel(
        {"star": 0.93, "backup": 0.88, "other": 0.9}, pd.Timestamp("2026-03-01")
    )

    # act
    none_given, audit_none = rebuild_context(
        frame, base, None, pd.Timestamp("2026-03-02")
    )
    empty_given, audit_empty = rebuild_context(
        frame, base,
        pd.DataFrame(columns=["nba_player_id", "status_normalized", "captured_at"]),
        pd.Timestamp("2026-03-02"),
    )

    # assert
    assert none_given["exp_vacated_minutes"].to_numpy() == pytest.approx(
        empty_given["exp_vacated_minutes"].to_numpy()
    )
    assert not audit_none["CONTEXT_OVERRIDDEN"].any()
    assert not audit_empty["CONTEXT_OVERRIDDEN"].any()


def test_a_report_captured_after_the_boundary_is_dropped_at_the_context_stage_too():
    """as-of discipline applies to the FIRST override as well as the second.

    a backtest of the T-24h horizon that quietly read the T-60m report would look
    prescient, and it would look prescient in the teammate features rather than in a
    probability, which is harder to notice.
    """
    # arrange - the report is captured an hour AFTER the run's boundary
    frame = _serving_frame()
    base = _FakeBaseModel(
        {"star": 0.93, "backup": 0.88, "other": 0.9}, pd.Timestamp("2026-03-01")
    )
    statuses = pd.DataFrame({
        "nba_player_id": ["star"],
        "status_normalized": ["out"],
        "captured_at": ["2026-03-02T01:00:00+00:00"],
    })

    # act
    rebuilt, audit = rebuild_context(
        frame, base, statuses, pd.Timestamp("2026-03-02T00:00:00")
    )
    unrestricted, _ = rebuild_context(frame, base, None, pd.Timestamp("2026-03-02"))

    # assert
    assert not audit["CONTEXT_OVERRIDDEN"].any()
    assert rebuilt["exp_vacated_minutes"].to_numpy() == pytest.approx(
        unrestricted["exp_vacated_minutes"].to_numpy()
    )


def test_the_rebuilt_context_carries_the_base_models_cutoff_for_the_guard():
    """the features the served models see must be provably built from prior information."""
    # arrange
    frame = _serving_frame()
    cutoff = pd.Timestamp("2026-03-01")
    base = _FakeBaseModel({"star": 0.9, "backup": 0.9, "other": 0.9}, cutoff)

    # act
    rebuilt, _ = rebuild_context(frame, base, None, pd.Timestamp("2026-03-02"))

    # assert
    assert (rebuilt[P_CONTEXT] == 0.9).all()
    assert (rebuilt[P_CONTEXT_CUTOFF] == cutoff).all()
    validate_out_of_fold(rebuilt, P_CONTEXT, P_CONTEXT_CUTOFF, "p_context")


def test_a_base_model_trained_past_the_game_is_refused_at_the_context_stage():
    """the same out-of-fold guard, one layer earlier than the composition's."""
    # arrange - a cutoff AFTER the games being scored
    frame = _serving_frame()
    base = _FakeBaseModel(
        {"star": 0.9, "backup": 0.9, "other": 0.9}, pd.Timestamp("2026-04-01")
    )

    # act + assert
    with pytest.raises(LeakageError, match="IN-FOLD"):
        rebuild_context(frame, base, None, pd.Timestamp("2026-03-02"))
