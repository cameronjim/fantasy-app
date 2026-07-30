"""the prediction-row builder and the quantile machinery behind it.

no database. AGENTS.md section 6 says there is no test database in this repo, so
:func:`fnba_ml.store.write_predictions` is never executed here - everything it
could get wrong that a test can catch has been pushed into
:func:`fnba_ml.store.build_prediction_rows`, which is a pure function over a
frame. what is left in the connecting half is one INSERT and a transaction
boundary, and those are read, not run.

the four properties these tests exist to pin:

  1. a prediction row means what its columns say. ``conditional`` true is "given
     he plays"; false is over the schedule. getting that backwards is invisible
     in the data and wrong by roughly a factor of two.
  2. quantiles never cross, even when handed a frame where they already have.
  3. prob_active is a probability, in [0, 1], always.
  4. a value that is not a number is not written at all, rather than written as
     a zero that reads like a real forecast of nothing.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.intervals import (
    QUANTILE_LEVELS,
    QuantileOffsets,
    apply_quantiles,
    attach_quantiles,
    fit_residual_quantiles,
    quantile_columns,
)
from fnba_ml.models import P_PLAY, P_PLAY_CUTOFF
from fnba_ml.store import (
    PROB_ACTIVE,
    UNCOND_SUFFIX,
    build_prediction_rows,
    build_run_record,
    write_predictions,
)

TARGETS = ("MIN", "PTS", "AST")


def prediction_frame(**overrides) -> pd.DataFrame:
    """two scheduled player-games, scored the way predict.py scores them."""
    frame = pd.DataFrame({
        "PLAYER_ID": ["2544", "201939"],
        "GAME_ID": ["0022500123", "0022500123"],
        "GAME_DATE": pd.to_datetime(["2026-03-01", "2026-03-01"]),
        P_PLAY: [0.82, 0.35],
        P_PLAY_CUTOFF: pd.to_datetime(["2026-02-28", "2026-02-28"]),
        "E_MIN_COND": [34.0, 22.0],
        "E_MIN": [27.88, 7.70],
        "E_PTS_COND": [25.0, 12.0],
        "E_PTS": [20.5, 4.2],
        "E_AST_COND": [8.0, 3.0],
        "E_AST": [6.56, 1.05],
        "Q10_MIN": [26.0, 14.0],
        "Q50_MIN": [34.5, 22.5],
        "Q90_MIN": [41.0, 30.0],
        "Q10_PTS": [14.0, 4.0],
        "Q50_PTS": [24.5, 11.5],
        "Q90_PTS": [37.0, 21.0],
    })
    for key, value in overrides.items():
        frame[key] = value
    return frame


def rows_for(rows: list[dict], stat: str, quantile: float | None = None) -> list[dict]:
    return [
        r for r in rows
        if r["stat"] == stat
        and (r["quantile"] is None if quantile is None else r["quantile"] == quantile)
    ]


# ---- row assembly ----
def test_every_player_game_gets_the_full_row_set():
    # arrange
    frame = prediction_frame()

    # act
    rows = build_prediction_rows(frame, TARGETS)

    # assert - 1 prob_active + 3 conditional + 3 unconditional + 6 quantiles
    assert len(rows) == 2 * 13
    assert {r["nba_player_id"] for r in rows} == {"2544", "201939"}
    assert {r["nba_game_id"] for r in rows} == {"0022500123"}
    assert {r["game_date"] for r in rows} == {pd.Timestamp("2026-03-01").date()}


def test_rows_carry_exactly_the_schema_columns():
    """the row dicts are handed straight to an INSERT; extra keys would break it."""
    # act
    rows = build_prediction_rows(prediction_frame(), TARGETS)

    # assert
    assert all(
        set(r) == {"nba_player_id", "nba_game_id", "game_date", "stat",
                   "quantile", "value", "conditional"}
        for r in rows
    )


def test_the_uniqueness_key_has_no_duplicates():
    """(run, player, game, stat, quantile) is UNIQUE in migration 014.

    a duplicate here would be a constraint violation at insert time - and with
    the append-only design, a run that half-committed is worse than one that
    never started.
    """
    # act
    rows = build_prediction_rows(prediction_frame(), TARGETS)

    # assert
    keys = [(r["nba_player_id"], r["nba_game_id"], r["stat"], r["quantile"]) for r in rows]
    assert len(set(keys)) == len(keys)


def test_an_empty_frame_produces_no_rows():
    # act + assert
    assert build_prediction_rows(prediction_frame().iloc[0:0], TARGETS) == []


def test_a_frame_without_probabilities_is_refused():
    # arrange
    frame = prediction_frame().drop(columns=[P_PLAY])

    # act + assert
    with pytest.raises(ValueError, match="P_PLAY"):
        build_prediction_rows(frame, TARGETS)


# ---- conditional vs unconditional ----
def test_conditional_and_unconditional_are_separate_stats_flagged_correctly():
    """the distinction the whole decomposition exists to preserve.

    'pts' is what he scores on a night he plays; 'pts_uncond' is what he scores
    averaged over the schedule, misses included. serving one where the other was
    meant is a ~2x error, and nothing downstream can detect it.
    """
    # act
    rows = build_prediction_rows(prediction_frame(), TARGETS)

    # assert
    conditional = rows_for(rows, "pts")
    unconditional = rows_for(rows, f"pts{UNCOND_SUFFIX}")
    assert [r["conditional"] for r in conditional] == [True, True]
    assert [r["conditional"] for r in unconditional] == [False, False]
    assert [r["value"] for r in conditional] == [25.0, 12.0]
    assert [r["value"] for r in unconditional] == [20.5, 4.2]


def test_the_unconditional_estimate_is_never_the_larger_one():
    """P(play) <= 1, so multiplying by it can only shrink the estimate."""
    # act
    rows = build_prediction_rows(prediction_frame(), TARGETS)

    # assert
    for stat in ("minutes", "pts", "ast"):
        conditional = [r["value"] for r in rows_for(rows, stat)]
        unconditional = [r["value"] for r in rows_for(rows, f"{stat}{UNCOND_SUFFIX}")]
        assert all(u <= c + 1e-9 for c, u in zip(conditional, unconditional))


def test_quantile_rows_are_conditional_and_expected_values_carry_no_quantile():
    # act
    rows = build_prediction_rows(prediction_frame(), TARGETS)

    # assert
    quantile_rows = [r for r in rows if r["quantile"] is not None]
    assert quantile_rows, "the fixture frame carries quantile columns"
    assert all(r["conditional"] for r in quantile_rows)
    assert {r["quantile"] for r in quantile_rows} == {0.1, 0.5, 0.9}
    assert {r["stat"] for r in quantile_rows} == {"minutes", "pts"}
    # an expected value is a mean, not a median: it never claims to be P50.
    assert all(r["quantile"] is None for r in rows_for(rows, "ast"))


def test_prob_active_is_unconditional_and_carries_no_quantile():
    # act
    rows = rows_for(build_prediction_rows(prediction_frame(), TARGETS), PROB_ACTIVE)

    # assert
    assert len(rows) == 2
    assert all(r["conditional"] is False for r in rows)
    assert all(r["quantile"] is None for r in rows)
    assert [r["value"] for r in rows] == [0.82, 0.35]


# ---- prob_active bounds ----
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ([1.0000000002, -1e-9], [1.0, 0.0]),
        ([2.0, -3.0], [1.0, 0.0]),
        ([1.0, 0.0], [1.0, 0.0]),
    ],
)
def test_prob_active_is_clamped_into_the_unit_interval(raw, expected):
    """a probability that leaks past 1 becomes '100.0000002% to play' on a page."""
    # arrange
    frame = prediction_frame(**{P_PLAY: raw})

    # act
    rows = rows_for(build_prediction_rows(frame, TARGETS), PROB_ACTIVE)

    # assert
    assert [r["value"] for r in rows] == expected
    assert all(0.0 <= r["value"] <= 1.0 for r in rows)


def test_a_null_probability_writes_no_probability_row():
    """``value`` is NOT NULL; an absent row is honest, a zero is a forecast."""
    # arrange
    frame = prediction_frame(**{P_PLAY: [0.5, np.nan]})

    # act
    rows = rows_for(build_prediction_rows(frame, TARGETS), PROB_ACTIVE)

    # assert
    assert [r["nba_player_id"] for r in rows] == ["2544"]


def test_a_null_estimate_writes_no_row_for_that_stat():
    # arrange
    frame = prediction_frame(E_PTS_COND=[np.nan, 12.0])

    # act
    rows = rows_for(build_prediction_rows(frame, TARGETS), "pts")

    # assert
    assert [r["nba_player_id"] for r in rows] == ["201939"]
    # the other stats for that player are unaffected
    assert len(rows_for(build_prediction_rows(frame, TARGETS), "minutes")) == 2


# ---- non-crossing ----
def test_quantiles_do_not_cross_in_the_emitted_rows():
    # act
    rows = build_prediction_rows(prediction_frame(), TARGETS)

    # assert
    for player in ("2544", "201939"):
        for stat in ("minutes", "pts"):
            by_level = {
                r["quantile"]: r["value"]
                for r in rows
                if r["nba_player_id"] == player and r["stat"] == stat and r["quantile"] is not None
            }
            assert by_level[0.1] <= by_level[0.5] <= by_level[0.9]


def test_a_crossed_input_frame_is_sorted_rather_than_written_crossed():
    """the deliberate failure case.

    a frame whose P90 sits below its P10 is exactly what a hand-edited or
    hand-built offset set produces, and a crossed interval on a page is not a
    small numerical annoyance - it makes the whole range unreadable.
    """
    # arrange - P10 above P90 for both players
    frame = prediction_frame(Q10_PTS=[40.0, 30.0], Q50_PTS=[24.5, 11.5], Q90_PTS=[9.0, 2.0])

    # act
    rows = [r for r in build_prediction_rows(frame, TARGETS)
            if r["stat"] == "pts" and r["quantile"] is not None]

    # assert
    first = {r["quantile"]: r["value"] for r in rows if r["nba_player_id"] == "2544"}
    assert first == {0.1: 9.0, 0.5: 24.5, 0.9: 40.0}
    assert first[0.1] <= first[0.5] <= first[0.9]


def test_a_frame_without_quantile_columns_still_writes_expected_values():
    """a model trained before intervals existed still produces a usable run."""
    # arrange
    frame = prediction_frame().drop(
        columns=["Q10_MIN", "Q50_MIN", "Q90_MIN", "Q10_PTS", "Q50_PTS", "Q90_PTS"]
    )

    # act
    rows = build_prediction_rows(frame, TARGETS)

    # assert
    assert all(r["quantile"] is None for r in rows)
    assert len(rows) == 2 * 7


# ---- the interval machinery itself ----
def test_residual_quantiles_recover_a_known_distribution():
    # arrange - residuals ~ N(0, 4), so P10/P90 sit near -+1.2816 * 4
    rng = np.random.default_rng(11)
    y_pred = np.full(50_000, 20.0)
    y_true = y_pred + rng.normal(0.0, 4.0, y_pred.size)

    # act
    offsets = fit_residual_quantiles(y_true, y_pred, "PTS")

    # assert
    assert offsets.levels == QUANTILE_LEVELS
    assert offsets.offsets[0] == pytest.approx(-5.126, abs=0.1)
    assert offsets.offsets[1] == pytest.approx(0.0, abs=0.05)
    assert offsets.offsets[2] == pytest.approx(5.126, abs=0.1)
    assert offsets.n == 50_000


def test_residual_quantile_offsets_come_out_sorted():
    """the first non-crossing guarantee: monotone offsets, monotone quantiles."""
    # act - levels handed over out of order on purpose
    offsets = fit_residual_quantiles(
        [10.0, 12.0, 30.0, 8.0], [10.0] * 4, "PTS", levels=(0.9, 0.1, 0.5)
    )

    # assert
    assert list(offsets.offsets) == sorted(offsets.offsets)


def test_residual_quantiles_ignore_rows_with_no_outcome():
    # act
    offsets = fit_residual_quantiles([10.0, np.nan, 30.0], [10.0, 10.0, 10.0], "PTS")

    # assert
    assert offsets.n == 2


def test_residual_quantiles_refuse_an_empty_window():
    # act + assert
    with pytest.raises(ValueError, match="no finite residuals"):
        fit_residual_quantiles([np.nan, np.nan], [1.0, 2.0], "MIN")


def test_applied_quantiles_are_floored_at_zero_and_stay_ordered():
    """a fringe player's P10 minutes would otherwise go negative."""
    # arrange
    offsets = QuantileOffsets("MIN", QUANTILE_LEVELS, (-8.0, 0.5, 9.0), n=100)

    # act
    result = apply_quantiles(np.array([2.0, 30.0]), offsets)

    # assert
    assert list(result[0.10]) == [0.0, 22.0]
    assert list(result[0.50]) == [2.5, 30.5]
    assert list(result[0.90]) == [11.0, 39.0]
    assert all(result[0.10][i] <= result[0.50][i] <= result[0.90][i] for i in range(2))


def test_hand_built_crossed_offsets_are_sorted_on_the_way_out():
    # arrange - offsets deliberately out of order
    offsets = QuantileOffsets("PTS", QUANTILE_LEVELS, (5.0, 0.0, -5.0), n=10)

    # act
    result = apply_quantiles(np.array([20.0]), offsets)

    # assert
    assert (result[0.10][0], result[0.50][0], result[0.90][0]) == (15.0, 20.0, 25.0)


def test_offsets_survive_a_json_round_trip():
    """they travel through metadata.json between train.py and predict.py."""
    # arrange
    offsets = fit_residual_quantiles([1.0, 5.0, 9.0], [4.0] * 3, "MIN", window=("a", "b"))

    # act
    restored = QuantileOffsets.from_dict(offsets.as_dict())

    # assert
    assert restored.target == "MIN"
    assert restored.levels == offsets.levels
    assert restored.offsets == pytest.approx(offsets.offsets)
    assert restored.window == ("a", "b")


def test_mismatched_levels_and_offsets_are_rejected():
    # act + assert
    with pytest.raises(ValueError, match="levels against"):
        QuantileOffsets("PTS", (0.1, 0.5, 0.9), (1.0, 2.0), n=5)


def test_attach_quantiles_writes_the_expected_columns():
    # arrange
    frame = pd.DataFrame({"PLAYER_ID": ["1", "2"]})
    offsets = QuantileOffsets("PTS", QUANTILE_LEVELS, (-3.0, 0.0, 4.0), n=10)

    # act
    out = attach_quantiles(frame, np.array([10.0, 20.0]), offsets)

    # assert
    assert set(quantile_columns("PTS").values()) == {"Q10_PTS", "Q50_PTS", "Q90_PTS"}
    assert list(out["Q10_PTS"]) == [7.0, 17.0]
    assert list(out["Q90_PTS"]) == [14.0, 24.0]
    assert "PLAYER_ID" in out.columns


# ---- the run record ----
def test_the_run_record_separates_when_it_ran_from_what_it_knew():
    """a backtest re-run today must not claim it knew today's games."""
    # arrange
    metadata = {
        "model_version": "2026-08-16",
        "feature_version": "v1",
        "git_commit": "abc123",
        "artifact_checksum": "deadbeef",
        "training_window": {"end": "2025-02-27", "cutoff": "2025-02-28"},
    }
    predicted_at = pd.Timestamp("2026-08-16T12:00:00Z").to_pydatetime()
    cutoff = pd.Timestamp("2025-02-28T00:00:00Z").to_pydatetime()

    # act
    record = build_run_record(metadata, predicted_at, cutoff, code_sha="feed01")

    # assert
    assert record["predicted_at"] == predicted_at
    assert record["forecast_cutoff_at"] == cutoff
    assert record["trained_through"] == "2025-02-27"
    assert record["feature_version"] == "v1"
    assert record["artifact_checksum"] == "deadbeef"
    # the commit that made the prediction, not the one that trained the model
    assert record["code_sha"] == "feed01"
    assert record["status"] == "complete"


def test_the_run_record_falls_back_to_the_training_commit():
    # act
    record = build_run_record(
        {"model_version": "v", "git_commit": "abc123"},
        pd.Timestamp("2026-08-16T12:00:00Z").to_pydatetime(),
        pd.Timestamp("2026-08-16T00:00:00Z").to_pydatetime(),
    )

    # assert
    assert record["code_sha"] == "abc123"
    assert record["feature_version"] == "unknown"
    assert record["trained_through"] is None


def test_writing_an_empty_run_is_refused_before_it_can_connect():
    """an empty 'complete' run looks complete to the serving query and is not."""
    # act + assert - raises before psycopg2 is imported, so no driver is needed
    with pytest.raises(ValueError, match="no prediction rows"):
        write_predictions([], {"model_version": "v"})
