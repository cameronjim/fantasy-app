"""tests for the pure pieces of the depth/weighting ablation."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

EXPERIMENTS_DIR = Path(__file__).resolve().parent
ML_ROOT = EXPERIMENTS_DIR.parent
for path in (str(ML_ROOT), str(EXPERIMENTS_DIR)):
    if path not in sys.path:
        sys.path.insert(0, path)

from deep_dataset import (  # noqa: E402
    DEEP_FEATURE_COLS,
    EXCLUDED_FEATURE_COLS,
    add_season_index,
    appearance_status_frame,
    ewma_halflife,
    season_age,
    season_start_year,
    trailing_window,
)
from depth_sweep import (  # noqa: E402
    ValidationRowRegistry,
    assert_identical_validation_rows,
    ascii_curve,
    origin_season,
    recency_weights,
    split_origin,
    validation_key,
)

SEASONS = [f"{y}-{str(y + 1)[2:]}" for y in range(1996, 2026)]


def test_trailing_window_length_and_endpoint():
    window = trailing_window(SEASONS, "2024-25", 4)
    assert window == ["2021-22", "2022-23", "2023-24", "2024-25"]
    assert len(window) == 4


def test_trailing_window_depth_one_is_just_the_end_season():
    assert trailing_window(SEASONS, "2025-26", 1) == ["2025-26"]


def test_trailing_window_is_contiguous_and_sorted():
    window = trailing_window(SEASONS, "2025-26", 13)
    years = [season_start_year(s) for s in window]
    assert years == sorted(years)
    assert years == list(range(years[0], years[0] + 13))


def test_trailing_window_truncates_rather_than_overrunning_history():
    window = trailing_window(SEASONS, "1997-98", 29)
    assert window == ["1996-97", "1997-98"]
    assert len(window) == 2 < 29


def test_trailing_window_rejects_an_unknown_end_season():
    with pytest.raises(ValueError, match="not in the available seasons"):
        trailing_window(SEASONS, "1988-89", 4)


def test_trailing_window_rejects_a_nonpositive_depth():
    with pytest.raises(ValueError, match="depth must be"):
        trailing_window(SEASONS, "2024-25", 0)


def test_origin_season_maps_a_new_year_window_to_the_season_that_straddles_it():
    assert origin_season(SEASONS, "2025-01-01") == "2024-25"
    assert origin_season(SEASONS, "2025-02-01") == "2024-25"
    assert origin_season(SEASONS, "2024-12-01") == "2024-25"
    assert origin_season(SEASONS, "2025-12-01") == "2025-26"
    assert origin_season(SEASONS, "2026-01-01") == "2025-26"


def test_origin_season_negative_control_naive_year_would_be_wrong():
    naive = "2025-26"
    assert origin_season(SEASONS, "2025-01-15") != naive


def test_season_age_is_zero_at_the_end_season_and_counts_backwards():
    ages = season_age(SEASONS, "2024-25")
    assert ages["2024-25"] == 0
    assert ages["2023-24"] == 1
    assert ages["1996-97"] == 28


def test_recency_weights_no_decay_is_all_ones():
    rows = pd.Series(["2020-21", "2024-25", "1996-97"])
    weights = recency_weights(rows, SEASONS, "2024-25", 1.0)
    assert np.allclose(weights, 1.0)


def test_recency_weights_are_exactly_decay_to_the_age():
    rows = pd.Series(["2024-25", "2023-24", "2022-23", "2021-22"])
    weights = recency_weights(rows, SEASONS, "2024-25", 0.8)
    assert np.allclose(weights, [1.0, 0.8, 0.64, 0.512])


def test_recency_weights_are_monotone_decreasing_in_age():
    rows = pd.Series(SEASONS)
    weights = recency_weights(rows, SEASONS, "2025-26", 0.6)
    assert np.all(np.diff(weights) > 0)
    assert weights[-1] == pytest.approx(1.0)


def test_recency_weights_harsher_decay_downweights_old_rows_further():
    rows = pd.Series(["2015-16"])
    mild = recency_weights(rows, SEASONS, "2025-26", 0.8)[0]
    harsh = recency_weights(rows, SEASONS, "2025-26", 0.6)[0]
    assert harsh < mild < 1.0


def test_recency_weights_reject_a_future_season():
    rows = pd.Series(["2025-26"])
    with pytest.raises(ValueError, match="AFTER the origin season"):
        recency_weights(rows, SEASONS, "2024-25", 0.8)


def test_recency_weights_reject_an_unknown_season():
    with pytest.raises(ValueError, match="unknown seasons"):
        recency_weights(pd.Series(["1975-76"]), SEASONS, "2024-25", 1.0)


@pytest.mark.parametrize("decay", [0.0, -0.5, 1.5])
def test_recency_weights_reject_a_decay_outside_the_unit_interval(decay):
    with pytest.raises(ValueError, match="decay must be"):
        recency_weights(pd.Series(["2024-25"]), SEASONS, "2024-25", decay)


def _toy_frame() -> pd.DataFrame:
    """three seasons, four dated rows each, two players."""
    rows = []
    for season, year in (("2022-23", 2023), ("2023-24", 2024), ("2024-25", 2025)):
        for day, player in ((5, "A"), (6, "B"), (20, "A"), (21, "B")):
            rows.append({
                "SEASON": season,
                "GAME_DATE": pd.Timestamp(f"{year}-01-{day:02d}"),
                "PLAYER_ID": player,
                "GAME_ID": f"{season}-{day}",
                "MIN": 20.0,
            })
    return pd.DataFrame(rows)


def test_split_origin_train_is_strictly_before_the_validation_window():
    frame = _toy_frame()
    train, valid = split_origin(frame, "2025-01-10", "2025-01-31",
                               ["2023-24", "2024-25"])
    assert train["GAME_DATE"].max() < pd.Timestamp("2025-01-10")
    assert set(train["SEASON"]) == {"2023-24", "2024-25"}
    assert len(valid) == 2


def test_split_origin_excludes_seasons_outside_the_window():
    frame = _toy_frame()
    train, _ = split_origin(frame, "2025-01-10", "2025-01-31", ["2024-25"])
    assert set(train["SEASON"]) == {"2024-25"}


def test_split_origin_validation_slice_is_independent_of_the_training_window():
    frame = _toy_frame()
    _, shallow = split_origin(frame, "2025-01-10", "2025-01-31", ["2024-25"])
    _, deep = split_origin(frame, "2025-01-10", "2025-01-31",
                           ["2022-23", "2023-24", "2024-25"])
    assert validation_key(shallow) == validation_key(deep)


def test_assert_identical_validation_rows_accepts_equal_row_sets():
    frame = _toy_frame()
    _, a = split_origin(frame, "2025-01-10", "2025-01-31", ["2024-25"])
    _, b = split_origin(frame, "2025-01-10", "2025-01-31", ["2023-24", "2024-25"])
    assert assert_identical_validation_rows({"shallow": a, "deep": b}) == 2


def test_assert_identical_validation_rows_is_order_independent():
    frame = _toy_frame()
    _, a = split_origin(frame, "2025-01-10", "2025-01-31", ["2024-25"])
    shuffled = a.iloc[::-1].reset_index(drop=True)
    assert assert_identical_validation_rows({"a": a, "shuffled": shuffled}) == 2


def test_assert_identical_validation_rows_negative_control_dropped_row():
    frame = _toy_frame()
    _, a = split_origin(frame, "2025-01-10", "2025-01-31", ["2024-25"])
    with pytest.raises(AssertionError, match="validation rows differ"):
        assert_identical_validation_rows({"full": a, "short": a.iloc[:-1]})


def test_assert_identical_validation_rows_negative_control_swapped_row():
    frame = _toy_frame()
    _, a = split_origin(frame, "2025-01-10", "2025-01-31", ["2024-25"])
    swapped = a.copy()
    swapped.iloc[0, swapped.columns.get_loc("PLAYER_ID")] = "Z"
    with pytest.raises(AssertionError, match="validation rows differ"):
        assert_identical_validation_rows({"real": a, "swapped": swapped})


def test_assert_identical_validation_rows_rejects_an_empty_comparison():
    with pytest.raises(ValueError, match="nothing to compare"):
        assert_identical_validation_rows({})


def test_registry_accepts_repeated_identical_row_sets_and_counts_checks():
    frame = _toy_frame()
    _, valid = split_origin(frame, "2025-01-10", "2025-01-31", ["2024-25"])
    registry = ValidationRowRegistry()
    for depth in (2, 4, 8):
        registry.enforce("O-toy", valid, f"depth={depth}")
    assert registry.checks == 3


def test_registry_rejects_a_changed_row_set_for_the_same_origin():
    frame = _toy_frame()
    _, valid = split_origin(frame, "2025-01-10", "2025-01-31", ["2024-25"])
    registry = ValidationRowRegistry()
    registry.enforce("O-toy", valid, "depth=2")
    with pytest.raises(AssertionError, match="must be identical"):
        registry.enforce("O-toy", valid.iloc[:-1], "depth=4")


def test_registry_keeps_origins_independent():
    frame = _toy_frame()
    _, jan = split_origin(frame, "2025-01-01", "2025-01-10", ["2024-25"])
    _, late = split_origin(frame, "2025-01-15", "2025-01-31", ["2024-25"])
    registry = ValidationRowRegistry()
    registry.enforce("O-jan", jan, "depth=2")
    registry.enforce("O-late", late, "depth=2")
    assert registry.checks == 2


def test_deep_feature_list_excludes_every_status_dependent_column():
    for column in EXCLUDED_FEATURE_COLS:
        assert column not in DEEP_FEATURE_COLS


def test_deep_feature_list_keeps_usage_which_needs_no_inactive_list():
    assert "usg_ewma" in DEEP_FEATURE_COLS


def test_deep_feature_list_has_no_duplicates_and_is_nonempty():
    assert len(DEEP_FEATURE_COLS) == len(set(DEEP_FEATURE_COLS)) > 0


def test_deep_feature_list_is_pinned_at_exactly_thirty_columns():
    assert len(DEEP_FEATURE_COLS) == 30


def test_deep_feature_list_is_independent_of_the_live_config(monkeypatch):
    import fnba_ml.config as config_module

    import deep_dataset

    before = list(deep_dataset.DEEP_FEATURE_COLS)
    monkeypatch.setattr(config_module, "FEATURE_COLS", ["something_else"])
    assert deep_dataset.DEEP_FEATURE_COLS == before


def test_feature_contract_drift_reports_config_only_columns():
    from deep_dataset import feature_contract_drift

    drift = feature_contract_drift()
    assert set(drift) == {"config_only", "pinned_only"}
    assert all(isinstance(c, str) for c in drift["config_only"])
    assert "roll5_MIN" not in drift["pinned_only"] or "roll5_MIN" not in DEEP_FEATURE_COLS


def test_appearance_status_frame_marks_every_row_played_and_none_inactive():
    logs = pd.DataFrame({
        "PLAYER_ID": ["1", "2"], "GAME_ID": ["g", "g"],
        "TEAM_ID": ["t", "t"], "MIN": [30.0, 12.0],
    })
    status = appearance_status_frame(logs)
    assert status["PLAYED"].all()
    assert not status["LISTED_INACTIVE"].any()
    assert status["ROSTERED"].all()
    assert len(status) == len(logs)


def test_ewma_halflife_rebinds_both_modules_and_restores_them():
    import fnba_ml.features as features_module
    import fnba_ml.teammates as teammates_module

    before = (features_module.EWMA_HALFLIFE, teammates_module.EWMA_HALFLIFE)
    with ewma_halflife(12.0):
        assert features_module.EWMA_HALFLIFE == 12.0
        assert teammates_module.EWMA_HALFLIFE == 12.0
    assert (features_module.EWMA_HALFLIFE, teammates_module.EWMA_HALFLIFE) == before


def test_ewma_halflife_restores_even_when_the_body_raises():
    import fnba_ml.features as features_module

    before = features_module.EWMA_HALFLIFE
    with pytest.raises(RuntimeError):
        with ewma_halflife(3.0):
            raise RuntimeError("boom")
    assert features_module.EWMA_HALFLIFE == before


def test_add_season_index_is_zero_based_and_ordered_by_season():
    frame = pd.DataFrame({"SEASON": ["2024-25", "1996-97", "2000-01"]})
    out = add_season_index(frame)
    assert out.loc[out["SEASON"] == "1996-97", "SEASON_INDEX"].iloc[0] == 0.0
    assert out.loc[out["SEASON"] == "2000-01", "SEASON_INDEX"].iloc[0] == 1.0
    assert out.loc[out["SEASON"] == "2024-25", "SEASON_INDEX"].iloc[0] == 2.0


def test_ascii_curve_marks_the_minimum_as_best():
    series = pd.Series({2: 4.90, 4: 4.80, 8: 4.85})
    chart = ascii_curve(series)
    best_line = [line for line in chart.splitlines() if "<- best" in line]
    assert len(best_line) == 1
    assert "4.8000" in best_line[0]
