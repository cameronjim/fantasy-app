from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.config import (
    CHAMPIONS,
    COMPOSITION_PARITY_TOLERANCE,
    EVENT_COHORT_ORDER,
    TEAMMATE_FEATURE_COLS,
    TIER_ORDER,
)
from fnba_ml.evaluate import (
    NEGATIVE_CONTROL_COLUMN,
    NEGATIVE_CONTROL_FEATURE,
    PREVIOUS_COMPOSITION,
    TASK_AVAILABILITY,
    TASK_IMPORTANCE,
    TASK_MINUTES,
    TASK_UNCONDITIONAL,
    add_negative_control,
    cohort_masks,
    cohort_outcome_lift,
    composition_parity,
    feature_set_comparison,
    importance_table,
    mean_by_model,
    select_champions,
    teammate_importance,
)

CHAMPION = CHAMPIONS["composition"]


def results(values: dict[str, list[float]]) -> pd.DataFrame:
    """tidy long results: {model: [MAE per origin]} for the unconditional task."""
    rows = []
    for model, per_origin in values.items():
        for i, value in enumerate(per_origin, start=1):
            rows.append({
                "task": TASK_UNCONDITIONAL, "origin": f"O{i}", "model": model,
                "segment": "ALL", "metric": "MAE", "value": value, "n": 1000,
            })
    return pd.DataFrame(rows)


def test_parity_is_reported_when_the_champion_matches_the_previous_composition():
    frame = results({CHAMPION: [4.005, 4.005], PREVIOUS_COMPOSITION: [4.007, 4.007]})

    parity = composition_parity(frame)

    assert parity["within_tolerance"] is True
    assert parity["relative_delta"] < 0
    assert parity["champion_mae"] == pytest.approx(4.005)
    assert parity["previous_mae"] == pytest.approx(4.007)


def test_a_champion_slightly_worse_than_the_previous_composition_still_passes():
    frame = results({CHAMPION: [4.027], PREVIOUS_COMPOSITION: [4.007]})

    parity = composition_parity(frame)

    assert 0 < parity["relative_delta"] < COMPOSITION_PARITY_TOLERANCE
    assert parity["within_tolerance"] is True


def test_a_real_regression_is_flagged():
    frame = results({CHAMPION: [4.207], PREVIOUS_COMPOSITION: [4.007]})

    parity = composition_parity(frame)

    assert parity["relative_delta"] > COMPOSITION_PARITY_TOLERANCE
    assert parity["within_tolerance"] is False


def test_a_missing_composition_reports_nothing_rather_than_a_pass():
    assert composition_parity(results({CHAMPION: [4.005]})) == {}
    assert composition_parity(results({PREVIOUS_COMPOSITION: [4.007]})) == {}
    assert composition_parity(results({})) == {}


def test_the_unconditional_task_selects_a_composition_champion():
    frame = results({
        CHAMPION: [4.005], PREVIOUS_COMPOSITION: [4.007], "direct_lightgbm": [3.982],
    })

    champions = select_champions(frame)

    row = champions[champions["task"] == TASK_UNCONDITIONAL].iloc[0]
    assert row["family"] == "composition"
    assert row["configured_champion"] == CHAMPION
    assert row["configured_value"] == pytest.approx(4.005)
    assert row["measured_best"] == "direct_lightgbm"
    assert not row["matches_config"]


def test_the_mean_is_taken_over_origins_not_over_rows():
    frame = results({CHAMPION: [4.0, 4.2, 4.4]})

    means = mean_by_model(frame, TASK_UNCONDITIONAL, "MAE")

    assert means[CHAMPION] == pytest.approx(4.2)


def test_cohort_masks_cover_tiers_and_events(feats):
    masks = dict(cohort_masks(feats))

    assert set(TIER_ORDER) <= set(masks)
    assert set(EVENT_COHORT_ORDER) <= set(masks)
    tier_total = sum(int(masks[t].sum()) for t in TIER_ORDER)
    assert tier_total == len(feats)
    high = masks["event: vacated_minutes >= 30"]
    low = masks["control: vacated_minutes < 5"]
    assert not (high & low).any()
    assert int(high.sum()) + int(low.sum()) < len(feats)


def test_a_row_with_no_cohort_value_joins_no_event_cohort():
    """a null must not be swept into the ``< 5`` control."""
    frame = pd.DataFrame({
        "MIN_TIER": [TIER_ORDER[0]] * 3,
        "vacated_minutes": [40.0, 2.0, np.nan],
        "star_out": [1.0, 0.0, np.nan],
    })

    masks = dict(cohort_masks(frame))

    assert masks["event: vacated_minutes >= 30"].tolist() == [True, False, False]
    assert masks["control: vacated_minutes < 5"].tolist() == [False, True, False]
    assert masks["event: star_out = 1"].tolist() == [True, False, False]


def test_cohorts_are_identical_with_and_without_the_teammate_features(feats):
    before = dict(cohort_masks(feats))
    after = dict(cohort_masks(feats.drop(columns=[])))

    assert set(before) == set(after)
    for label in before:
        assert (before[label] == after[label]).all()
    for _, column, _, _ in [(None, "vacated_minutes", None, None)]:
        assert column in feats.columns


def test_the_negative_control_is_a_permutation_not_fresh_noise(feats):
    with_control = add_negative_control(feats)

    assert NEGATIVE_CONTROL_COLUMN in with_control.columns
    real = with_control[NEGATIVE_CONTROL_FEATURE]
    fake = with_control[NEGATIVE_CONTROL_COLUMN]
    assert sorted(fake.to_numpy()) == pytest.approx(sorted(real.to_numpy()))
    assert fake.mean() == pytest.approx(real.mean())
    assert (fake.to_numpy() != real.to_numpy()).mean() > 0.9


def test_the_negative_control_is_never_a_configured_feature():
    from fnba_ml.config import FEATURE_COLS

    assert NEGATIVE_CONTROL_COLUMN not in FEATURE_COLS
    assert NEGATIVE_CONTROL_FEATURE in FEATURE_COLS


def test_the_permuted_column_shows_no_cohort_lift(feats):
    frame = add_negative_control(feats)

    lift = cohort_outcome_lift(frame)
    minutes = lift[lift["outcome"] == "MIN"].set_index("cohort")["lift"]
    real = abs(minutes["event: vacated_minutes >= 30"])
    permuted = abs(minutes["event: vacated_minutes >= 30 [PERMUTED CONTROL]"])

    assert permuted < 0.5, f"the permuted cohort shows {permuted:.3f} minutes of lift"
    assert real > permuted, (
        "the real vacated_minutes cohort is no more distinctive than a permutation "
        "of it - either the feature is noise or the cohort split is broken"
    )


def test_cohort_lift_reports_the_control_cohort_too(feats):
    lift = cohort_outcome_lift(add_negative_control(feats))

    assert "control: vacated_minutes < 5" in set(lift["cohort"])
    assert set(lift["outcome"]) == {"PLAYED", "MIN", "PTS"}
    assert (lift["rows"] > 0).all()


def gain_rows(model: str, gains: dict[str, list[float]], task: str = TASK_IMPORTANCE):
    rows = []
    for feature, per_origin in gains.items():
        for i, value in enumerate(per_origin, start=1):
            rows.append({
                "task": task, "origin": f"O{i}", "model": model, "segment": feature,
                "metric": "Gain", "value": value, "n": 1000,
            })
    return pd.DataFrame(rows)


def test_importance_is_ranked_within_each_model_not_pooled():
    frame = pd.concat([
        gain_rows("availability", {"a": [100.0], "b": [50.0]}),
        gain_rows("minutes", {"a": [900_000.0], "b": [100_000.0]}),
    ], ignore_index=True)

    table = importance_table(frame)

    for model in ("availability", "minutes"):
        sub = table[table["model"] == model].set_index("feature")
        assert sub.loc["a", "rank"] == 1
        assert sub.loc["b", "rank"] == 2
        assert sub["share"].sum() == pytest.approx(1.0)


def test_importance_means_over_origins():
    frame = gain_rows("minutes", {"a": [100.0, 300.0]})

    table = importance_table(frame)

    assert table.iloc[0]["gain"] == pytest.approx(200.0)


def test_teammate_importance_keeps_only_the_new_family_and_the_control():
    frame = pd.concat([
        gain_rows("minutes", {
            "roll5_MIN": [900.0], "vacated_minutes": [400.0], "star_out": [10.0],
        }),
        gain_rows("minutes", {NEGATIVE_CONTROL_COLUMN: [5.0]},
                  task="Z negative control"),
    ], ignore_index=True)

    table = teammate_importance(frame)

    features = set(table["feature"])
    assert "roll5_MIN" not in features
    assert {"vacated_minutes", "star_out", NEGATIVE_CONTROL_COLUMN} == features
    assert set(table["pass"]) == {"main", "negative-control fit"}


def cohort_results(task: str, metric: str, model: str, values: dict[str, float]):
    return pd.DataFrame([
        {
            "task": task, "origin": "O1", "model": model, "segment": segment,
            "metric": metric, "value": value, "n": 500,
        }
        for segment, value in values.items()
    ])


def test_the_comparison_delta_is_negative_when_the_new_features_help():
    segments = {"ALL": 4.72, "bench (10-20)": 5.53}
    before = cohort_results(TASK_MINUTES, "MAE", CHAMPIONS["minutes"], segments)
    after = cohort_results(
        TASK_MINUTES, "MAE", CHAMPIONS["minutes"], {"ALL": 4.60, "bench (10-20)": 5.20}
    )

    table = feature_set_comparison(before, after)

    row = table.loc[(TASK_MINUTES, "MAE", "ALL")]
    assert row["delta"] == pytest.approx(-0.12)
    assert row["delta_pct"] < 0
    bench = table.loc[(TASK_MINUTES, "MAE", "bench (10-20)")]
    assert bench["delta"] == pytest.approx(-0.33)
    assert bench["delta_pct"] < row["delta_pct"]


def test_the_comparison_flags_a_cohort_regression():
    before = cohort_results(
        TASK_MINUTES, "MAE", CHAMPIONS["minutes"],
        {"ALL": 4.72, "control: vacated_minutes < 5": 4.10},
    )
    after = cohort_results(
        TASK_MINUTES, "MAE", CHAMPIONS["minutes"],
        {"ALL": 4.60, "control: vacated_minutes < 5": 4.35},
    )

    table = feature_set_comparison(before, after)

    assert table.loc[(TASK_MINUTES, "MAE", "ALL")]["delta"] < 0
    assert table.loc[(TASK_MINUTES, "MAE", "control: vacated_minutes < 5")]["delta"] > 0


def test_the_comparison_uses_each_familys_configured_champion():
    before = pd.concat([
        cohort_results(TASK_AVAILABILITY, "Brier", CHAMPIONS["availability"],
                       {"ALL": 0.0734}),
        cohort_results(TASK_AVAILABILITY, "Brier", "logistic", {"ALL": 0.0959}),
    ], ignore_index=True)
    after = pd.concat([
        cohort_results(TASK_AVAILABILITY, "Brier", CHAMPIONS["availability"],
                       {"ALL": 0.0700}),
        cohort_results(TASK_AVAILABILITY, "Brier", "logistic", {"ALL": 0.0950}),
    ], ignore_index=True)

    table = feature_set_comparison(before, after)

    assert list(table.index.get_level_values("task")) == [TASK_AVAILABILITY]
    assert table.iloc[0]["before"] == pytest.approx(0.0734)
    assert table.iloc[0]["after"] == pytest.approx(0.0700)


def test_the_comparison_is_empty_rather_than_wrong_when_a_pass_is_missing():
    assert feature_set_comparison(pd.DataFrame(), pd.DataFrame()).empty
    only_after = cohort_results(TASK_MINUTES, "MAE", CHAMPIONS["minutes"], {"ALL": 4.6})
    assert feature_set_comparison(pd.DataFrame(columns=only_after.columns), only_after).empty


def test_dropping_features_changes_the_feature_list_not_the_frame(feats):
    from fnba_ml.evaluate import run_rolling_origin  # noqa: PLC0415

    origins = [("O1", "2024-12-01", "2024-12-15")]

    dropped = run_rolling_origin(feats, origins, drop_features=TEAMMATE_FEATURE_COLS)

    assert not dropped.empty
    assert set(TEAMMATE_FEATURE_COLS) <= set(feats.columns)
    segments = set(dropped["segment"])
    assert "event: vacated_minutes >= 30" in segments
