"""the serving-time injury-report override layer.

WHY THIS LAYER IS TESTED HARDER THAN ITS SIZE SUGGESTS. it is the only part of the
system that can make a projection wrong on purpose. the model is a measured
artifact with a Brier score; this is six hand-set constants and a join, and the
join is where the interesting failures live:

  1. the wrong player gets an override (an id-type mismatch between a TEXT
     nba_player_id and an int64 PLAYER_ID silently matches nothing, and a layer
     that matches nothing looks exactly like a layer that had nothing to do).
  2. a report from AFTER the run's information boundary is used, which makes a
     backtest of the T-24h horizon quietly read the T-60m report. that is leakage
     with a friendly face: the metrics improve.
  3. P(play) moves and the unconditional stats do not, so the page shows "2% to
     play" next to "28.4 points".
  4. the CONDITIONAL stat moves, which double-counts availability - "how good a
     night if he plays" does not change because he became less likely to play.

each of those four is a test below. the policy arithmetic is also pinned, not
because multiplication is hard but because these constants will be replaced by
learned ones and the diff should show exactly which number changed.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.models import P_PLAY, P_PLAY_CUTOFF
from fnba_ml.overrides import (
    DEFAULT_POLICY,
    DOUBTFUL_PROBABILITY,
    LEAGUE_QUESTIONABLE_PLAY_RATE,
    OUT_PROBABILITY,
    OVERRIDE_REASON,
    P_PLAY_MODEL,
    PROBABLE_MODEL_WEIGHT,
    PROBABLE_SHIFT,
    QUESTIONABLE_MODEL_WEIGHT,
    STATUS_CAPTURED_AT,
    STATUS_NORMALIZED,
    StatusPolicy,
    apply_status_overrides,
    latest_statuses,
    normalise_status,
    override_summary,
    reason_for,
)

AS_OF = pd.Timestamp("2026-03-01 18:00")
GAME_DATE = pd.Timestamp("2026-03-01")


def predictions(model_probabilities: list[float], player_ids: list[str] | None = None
                ) -> pd.DataFrame:
    """a scored frame shaped exactly as predict.build_predictions emits one."""
    ids = player_ids or [str(2544 + i) for i in range(len(model_probabilities))]
    n = len(ids)
    conditional_pts = [24.0, 12.0, 8.0, 30.0, 4.0][:n]
    conditional_min = [34.0, 22.0, 15.0, 36.0, 9.0][:n]
    return pd.DataFrame({
        "PLAYER_ID": ids,
        "GAME_ID": ["0022500123"] * n,
        "GAME_DATE": [GAME_DATE] * n,
        P_PLAY: model_probabilities,
        P_PLAY_CUTOFF: [pd.Timestamp("2026-02-28")] * n,
        "E_MIN_COND": conditional_min,
        "E_MIN": [p * m for p, m in zip(model_probabilities, conditional_min)],
        "E_PTS_COND": conditional_pts,
        "E_PTS": [p * c for p, c in zip(model_probabilities, conditional_pts)],
        "Q10_PTS": [c - 8 for c in conditional_pts],
        "Q50_PTS": conditional_pts,
        "Q90_PTS": [c + 9 for c in conditional_pts],
    })


def statuses(rows: list[tuple[str, str, str]]) -> pd.DataFrame:
    """(player id, status, captured_at) -> the frame the layer expects."""
    return pd.DataFrame(
        rows, columns=["nba_player_id", "status_normalized", "captured_at"]
    )


def applied(frame: pd.DataFrame, player_id: str) -> pd.Series:
    return frame[frame["PLAYER_ID"] == player_id].iloc[0]


# ---- one test per status rule ----
@pytest.mark.parametrize("status", ["out", "suspended", "g_league"])
def test_unavailable_statuses_floor_the_probability(status):
    """not 0.0: an official 'out' is occasionally reversed and a hard zero makes
    every calibration statistic on the bucket degenerate."""
    # arrange
    frame = predictions([0.93])
    report = statuses([("2544", status, "2026-03-01 12:00")])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    row = applied(out, "2544")
    assert row[P_PLAY] == pytest.approx(OUT_PROBABILITY)
    assert row[P_PLAY] == pytest.approx(0.02)
    assert row[OVERRIDE_REASON] == reason_for(status)


def test_doubtful_replaces_the_model_outright():
    # arrange
    frame = predictions([0.88])
    report = statuses([("2544", "doubtful", "2026-03-01 12:00")])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    assert applied(out, "2544")[P_PLAY] == pytest.approx(DOUBTFUL_PROBABILITY)
    assert applied(out, "2544")[P_PLAY] == pytest.approx(0.10)


def test_questionable_blends_the_model_with_the_league_prior():
    """the only bucket where the model keeps a say, because 'questionable' is where
    teams put everyone they have not decided about - stars and fringe alike."""
    # arrange - a star the model likes and a bench player it does not
    frame = predictions([0.90, 0.30])
    report = statuses([
        ("2544", "questionable", "2026-03-01 12:00"),
        ("2545", "questionable", "2026-03-01 12:00"),
    ])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert - 0.6 x model + 0.4 x 0.60, exactly
    assert applied(out, "2544")[P_PLAY] == pytest.approx(0.6 * 0.90 + 0.4 * 0.60)
    assert applied(out, "2544")[P_PLAY] == pytest.approx(0.78)
    assert applied(out, "2545")[P_PLAY] == pytest.approx(0.6 * 0.30 + 0.4 * 0.60)
    assert applied(out, "2545")[P_PLAY] == pytest.approx(0.42)
    # the blend pulls both toward the prior: down for the star, up for the bench
    assert applied(out, "2544")[P_PLAY] < 0.90
    assert applied(out, "2545")[P_PLAY] > 0.30


def test_the_questionable_blend_weights_sum_to_one():
    """a blend whose weights do not sum to 1 is not a blend, it is a bias."""
    # act + assert
    assert QUESTIONABLE_MODEL_WEIGHT + (1.0 - QUESTIONABLE_MODEL_WEIGHT) == 1.0
    assert QUESTIONABLE_MODEL_WEIGHT == pytest.approx(0.6)
    assert LEAGUE_QUESTIONABLE_PLAY_RATE == pytest.approx(0.60)
    # a model that already agrees with the prior is left where it is
    assert DEFAULT_POLICY.probability(
        "questionable", LEAGUE_QUESTIONABLE_PLAY_RATE
    ) == pytest.approx(LEAGUE_QUESTIONABLE_PLAY_RATE)


@pytest.mark.parametrize("model_probability", [0.05, 0.40, 0.75, 0.95, 0.999, 1.0])
def test_probable_is_a_floor_and_never_a_haircut(model_probability):
    """a team saying 'expected to play' must never be able to LOWER a projection.

    the max() is what guarantees it: for a model probability above ~0.99 the
    shifted form dips below the model's own number, and without the max a probable
    designation would quietly cost a star a point of availability.
    """
    # arrange
    frame = predictions([model_probability])
    report = statuses([("2544", "probable", "2026-03-01 12:00")])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    result = applied(out, "2544")[P_PLAY]
    assert result >= model_probability - 1e-12
    assert result == pytest.approx(
        min(max(model_probability,
                PROBABLE_MODEL_WEIGHT * model_probability + PROBABLE_SHIFT), 1.0)
    )
    assert 0.0 <= result <= 1.0


def test_probable_lifts_a_bench_player_by_the_documented_amount():
    # arrange
    frame = predictions([0.40])
    report = statuses([("2544", "probable", "2026-03-01 12:00")])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert - 0.85 x 0.40 + 0.15
    assert applied(out, "2544")[P_PLAY] == pytest.approx(0.49)


@pytest.mark.parametrize("status", ["available", "day_to_day", "unknown", "", "nonsense"])
def test_passthrough_statuses_leave_the_model_alone(status):
    """'available' adds nothing the model does not already know, and 'day_to_day'
    is a roster note rather than a statement about tonight."""
    # arrange
    frame = predictions([0.71])
    report = statuses([("2544", status, "2026-03-01 12:00")])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    row = applied(out, "2544")
    assert row[P_PLAY] == pytest.approx(0.71)
    assert row[OVERRIDE_REASON] is None
    assert row["E_PTS"] == pytest.approx(0.71 * 24.0)


def test_an_unlisted_player_is_untouched():
    # arrange - the report names a player who has no row in the slate
    frame = predictions([0.66, 0.44])
    report = statuses([("999999", "out", "2026-03-01 12:00")])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    assert out[P_PLAY].tolist() == pytest.approx([0.66, 0.44])
    assert out[OVERRIDE_REASON].isna().all()


def test_source_wording_is_normalised_onto_the_vocabulary():
    # arrange
    frame = predictions([0.80, 0.80, 0.80])
    report = statuses([
        ("2544", "Game Time Decision", "2026-03-01 12:00"),
        ("2545", "OUT FOR SEASON", "2026-03-01 12:00"),
        ("2546", "G-League", "2026-03-01 12:00"),
    ])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    assert normalise_status("Game Time Decision") == "questionable"
    assert applied(out, "2544")[P_PLAY] == pytest.approx(0.6 * 0.80 + 0.4 * 0.60)
    assert applied(out, "2545")[P_PLAY] == pytest.approx(OUT_PROBABILITY)
    assert applied(out, "2546")[P_PLAY] == pytest.approx(OUT_PROBABILITY)


# ---- the unconditional recomputation ----
def test_the_unconditional_stats_are_recomputed_from_the_overridden_probability():
    """the failure this prevents: '2% to play' printed next to '28.4 points'."""
    # arrange
    frame = predictions([0.93])
    report = statuses([("2544", "out", "2026-03-01 12:00")])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    row = applied(out, "2544")
    assert row["E_PTS"] == pytest.approx(OUT_PROBABILITY * 24.0)
    assert row["E_MIN"] == pytest.approx(OUT_PROBABILITY * 34.0)
    # and the identity E[stat] = P(play) x E[stat | plays] still holds exactly
    assert row["E_PTS"] == pytest.approx(row[P_PLAY] * row["E_PTS_COND"])
    assert row["E_MIN"] == pytest.approx(row[P_PLAY] * row["E_MIN_COND"])


def test_the_conditional_stats_and_quantiles_are_untouched():
    """being less likely to play does not change how good the night would be.

    moving the conditional estimate as well would double-count availability - it is
    already in P(play), and the quantiles wrap the conditional estimate.
    """
    # arrange
    frame = predictions([0.93])
    report = statuses([("2544", "doubtful", "2026-03-01 12:00")])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    row = applied(out, "2544")
    assert row["E_PTS_COND"] == pytest.approx(24.0)
    assert row["E_MIN_COND"] == pytest.approx(34.0)
    assert (row["Q10_PTS"], row["Q50_PTS"], row["Q90_PTS"]) == (16.0, 24.0, 33.0)


def test_the_model_probability_survives_on_every_row():
    """the layer has to remain measurable against the model it corrects."""
    # arrange
    frame = predictions([0.93, 0.55])
    report = statuses([("2544", "out", "2026-03-01 12:00")])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    assert out[P_PLAY_MODEL].tolist() == pytest.approx([0.93, 0.55])
    assert applied(out, "2544")[P_PLAY] == pytest.approx(OUT_PROBABILITY)
    assert applied(out, "2545")[P_PLAY] == pytest.approx(0.55)


def test_the_report_timestamp_is_carried_onto_the_overridden_row():
    """a 3-day-old 'out' and a 20-minute-old 'out' are different claims."""
    # arrange
    frame = predictions([0.93])
    report = statuses([("2544", "out", "2026-03-01 12:34")])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    row = applied(out, "2544")
    assert pd.Timestamp(row[STATUS_CAPTURED_AT]) == pd.Timestamp("2026-03-01 12:34")
    assert row[STATUS_NORMALIZED] == "out"


# ---- as-of discipline ----
def test_a_report_captured_after_the_boundary_does_not_apply():
    """THE LEAKAGE CASE. a T-24h backtest must not read the T-60m report.

    this is leakage with a friendly face - using it makes the metrics look better,
    which is exactly why it needs a test rather than a comment.
    """
    # arrange - the report lands an hour AFTER the run's boundary
    frame = predictions([0.93])
    report = statuses([("2544", "out", "2026-03-01 19:00")])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    row = applied(out, "2544")
    assert row[P_PLAY] == pytest.approx(0.93)
    assert row[OVERRIDE_REASON] is None
    assert row["E_PTS"] == pytest.approx(0.93 * 24.0)


def test_a_report_captured_exactly_at_the_boundary_does_not_apply():
    """the boundary is exclusive, matching the training cutoff's own convention."""
    # arrange
    frame = predictions([0.93])
    report = statuses([("2544", "out", str(AS_OF))])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    assert applied(out, "2544")[P_PLAY] == pytest.approx(0.93)


def test_the_newest_admissible_report_wins():
    """a player can be questionable, then out, then available in one morning."""
    # arrange
    report = statuses([
        ("2544", "questionable", "2026-03-01 09:00"),
        ("2544", "out", "2026-03-01 11:00"),
        ("2544", "available", "2026-03-01 13:00"),
        ("2544", "out", "2026-03-01 21:00"),  # after the boundary, ignored
    ])

    # act
    latest = latest_statuses(report, AS_OF)
    out = apply_status_overrides(predictions([0.93]), report, DEFAULT_POLICY, AS_OF)

    # assert - the 13:00 'available' is the last one known at 18:00
    assert len(latest) == 1
    assert latest.iloc[0]["captured_at"] == pd.Timestamp("2026-03-01 13:00")
    assert applied(out, "2544")[P_PLAY] == pytest.approx(0.93)


def test_without_a_boundary_every_report_is_admissible():
    """as_of=None means "no boundary", which is right for an ad-hoc scoring run and
    wrong for a backtest. it must not silently behave like a boundary of now."""
    # arrange
    report = statuses([("2544", "out", "2099-01-01 00:00")])

    # act
    out = apply_status_overrides(predictions([0.93]), report, DEFAULT_POLICY, None)

    # assert
    assert applied(out, "2544")[P_PLAY] == pytest.approx(OUT_PROBABILITY)


def test_timezone_aware_reports_compare_against_a_naive_boundary():
    """postgres hands back TIMESTAMPTZ; a csv has no zone. comparing them must not
    raise, and must not shift a report across the cutoff."""
    # arrange - 12:00 UTC, which is before an 18:00 boundary
    report = statuses([("2544", "out", "2026-03-01T12:00:00+00:00")])

    # act
    out = apply_status_overrides(predictions([0.93]), report, DEFAULT_POLICY, AS_OF)

    # assert
    assert applied(out, "2544")[P_PLAY] == pytest.approx(OUT_PROBABILITY)


def test_an_unparseable_timestamp_drops_the_report():
    # arrange
    report = statuses([("2544", "out", "not a date")])

    # act
    out = apply_status_overrides(predictions([0.93]), report, DEFAULT_POLICY, AS_OF)

    # assert - an unusable timestamp cannot be shown to precede the boundary
    assert applied(out, "2544")[P_PLAY] == pytest.approx(0.93)


# ---- degenerate inputs ----
def test_no_statuses_frame_is_an_identity_on_every_value():
    # arrange
    frame = predictions([0.93, 0.55])

    # act
    out = apply_status_overrides(frame, None, DEFAULT_POLICY, AS_OF)

    # assert
    for column in (P_PLAY, "E_PTS", "E_PTS_COND", "E_MIN", "E_MIN_COND"):
        assert out[column].tolist() == pytest.approx(frame[column].tolist())
    assert out[OVERRIDE_REASON].isna().all()
    # the provenance columns are still added, so the row builder sees one shape
    assert out[P_PLAY_MODEL].tolist() == pytest.approx(frame[P_PLAY].tolist())


def test_an_empty_statuses_frame_is_an_identity_on_every_value():
    # arrange
    frame = predictions([0.93])

    # act
    out = apply_status_overrides(frame, statuses([]), DEFAULT_POLICY, AS_OF)

    # assert
    assert out[P_PLAY].tolist() == pytest.approx([0.93])
    assert out[OVERRIDE_REASON].isna().all()


def test_the_input_frame_is_not_mutated():
    """predict.py keeps the pre-override frame around; a copy-in-place bug here
    would make the two indistinguishable."""
    # arrange
    frame = predictions([0.93])
    before = frame.copy()

    # act
    apply_status_overrides(frame, statuses([("2544", "out", "2026-03-01 12:00")]),
                           DEFAULT_POLICY, AS_OF)

    # assert
    pd.testing.assert_frame_equal(frame, before)


def test_a_statuses_frame_missing_a_column_is_refused():
    # arrange
    report = statuses([("2544", "out", "2026-03-01 12:00")]).drop(columns=["captured_at"])

    # act + assert
    with pytest.raises(ValueError, match="captured_at"):
        apply_status_overrides(predictions([0.9]), report, DEFAULT_POLICY, AS_OF)


def test_a_frame_without_probabilities_is_refused():
    # act + assert
    with pytest.raises(ValueError, match=P_PLAY):
        apply_status_overrides(predictions([0.9]).drop(columns=[P_PLAY]), None)


def test_integer_player_ids_still_match_text_report_ids():
    """the silent-no-match failure: TEXT nba_player_id against int64 PLAYER_ID.

    a layer that matches nothing is indistinguishable from a layer with nothing to
    do, so this is checked rather than assumed.
    """
    # arrange
    frame = predictions([0.93])
    frame["PLAYER_ID"] = np.array([2544], dtype="int64")
    report = statuses([("2544", "out", "2026-03-01 12:00")])

    # act
    out = apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF)

    # assert
    assert out.iloc[0][P_PLAY] == pytest.approx(OUT_PROBABILITY)


# ---- the policy object ----
def test_the_policy_is_substitutable_without_touching_the_module():
    """a backtest sweeping the questionable prior must not need a code change."""
    # arrange
    policy = StatusPolicy(questionable_prior=0.80, questionable_model_weight=0.5)

    # act
    out = apply_status_overrides(
        predictions([0.40]),
        statuses([("2544", "questionable", "2026-03-01 12:00")]),
        policy, AS_OF,
    )

    # assert
    assert applied(out, "2544")[P_PLAY] == pytest.approx(0.5 * 0.40 + 0.5 * 0.80)
    assert policy.as_dict()["questionable_prior"] == 0.80


def test_the_policy_returns_none_for_anything_it_does_not_govern():
    """None, not the model's own number: "no opinion" and "the same opinion" are
    different, and only the first one must leave OVERRIDE_REASON unset."""
    # act + assert
    assert DEFAULT_POLICY.probability("available", 0.5) is None
    assert DEFAULT_POLICY.probability("day_to_day", 0.5) is None
    assert DEFAULT_POLICY.probability("", 0.5) is None
    assert DEFAULT_POLICY.probability("out", 0.5) == pytest.approx(OUT_PROBABILITY)


def test_the_summary_reports_the_shift_per_reason():
    # arrange
    frame = predictions([0.93, 0.88, 0.30])
    report = statuses([
        ("2544", "out", "2026-03-01 12:00"),
        ("2545", "doubtful", "2026-03-01 12:00"),
        ("2546", "probable", "2026-03-01 12:00"),
    ])

    # act
    summary = override_summary(apply_status_overrides(frame, report, DEFAULT_POLICY, AS_OF))

    # assert
    by_reason = summary.set_index("reason")
    assert set(by_reason.index) == {"status_out", "status_doubtful", "status_probable"}
    assert by_reason.loc["status_out", "mean_model_p"] == pytest.approx(0.93)
    assert by_reason.loc["status_out", "mean_override_p"] == pytest.approx(OUT_PROBABILITY)
    assert int(by_reason["rows"].sum()) == 3


def test_the_summary_is_empty_when_nothing_was_overridden():
    # act
    summary = override_summary(apply_status_overrides(predictions([0.9]), None))

    # assert
    assert summary.empty
