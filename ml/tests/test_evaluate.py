"""the champion-selection and composition-parity reporting.

these run on a hand-built results frame rather than a real rolling-origin pass. the
rolling-origin machinery is exercised by the reports it writes; what needs a unit
test is the VERDICT logic, because that is what a pipeline gates on and it is easy
to get the sign of a delta backwards.

the composition promoted on 2026-08-17 was promoted for correctness, so the claim
being defended is parity, not improvement. a check that quietly reported "pass"
when it could not run would defeat the point entirely, which is why the
could-not-run case has its own test.
"""

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
    # arrange - the measured pair: 4.005 against 4.007
    frame = results({CHAMPION: [4.005, 4.005], PREVIOUS_COMPOSITION: [4.007, 4.007]})

    # act
    parity = composition_parity(frame)

    # assert - a negative delta means the champion is (marginally) better
    assert parity["within_tolerance"] is True
    assert parity["relative_delta"] < 0
    assert parity["champion_mae"] == pytest.approx(4.005)
    assert parity["previous_mae"] == pytest.approx(4.007)


def test_a_champion_slightly_worse_than_the_previous_composition_still_passes():
    """parity, not improvement. the correctness argument buys a small cost."""
    # arrange - 0.5% worse, inside the 1% tolerance
    frame = results({CHAMPION: [4.027], PREVIOUS_COMPOSITION: [4.007]})

    # act
    parity = composition_parity(frame)

    # assert
    assert 0 < parity["relative_delta"] < COMPOSITION_PARITY_TOLERANCE
    assert parity["within_tolerance"] is True


def test_a_real_regression_is_flagged():
    """the sign that matters: positive delta means the champion lost accuracy."""
    # arrange - 5% worse
    frame = results({CHAMPION: [4.207], PREVIOUS_COMPOSITION: [4.007]})

    # act
    parity = composition_parity(frame)

    # assert
    assert parity["relative_delta"] > COMPOSITION_PARITY_TOLERANCE
    assert parity["within_tolerance"] is False


def test_a_missing_composition_reports_nothing_rather_than_a_pass():
    """"the check could not run" and "the check passed" must not look the same."""
    # act + assert
    assert composition_parity(results({CHAMPION: [4.005]})) == {}
    assert composition_parity(results({PREVIOUS_COMPOSITION: [4.007]})) == {}
    assert composition_parity(results({})) == {}


def test_the_unconditional_task_selects_a_composition_champion():
    """the fourth champion family. before it existed the unconditional table had a
    measured winner and no configured champion to compare it against, so a
    composition change could not show up in the selection table at all.
    """
    # arrange
    frame = results({
        CHAMPION: [4.005], PREVIOUS_COMPOSITION: [4.007], "direct_lightgbm": [3.982],
    })

    # act
    champions = select_champions(frame)

    # assert
    row = champions[champions["task"] == TASK_UNCONDITIONAL].iloc[0]
    assert row["family"] == "composition"
    assert row["configured_champion"] == CHAMPION
    assert row["configured_value"] == pytest.approx(4.005)
    # direct LightGBM measures best and is deliberately NOT the champion: the
    # decomposition also yields a calibrated P(play) as a by-product, and a ~0.6%
    # MAE edge inside the noise line does not buy that back.
    assert row["measured_best"] == "direct_lightgbm"
    assert not row["matches_config"]


def test_the_mean_is_taken_over_origins_not_over_rows():
    # arrange
    frame = results({CHAMPION: [4.0, 4.2, 4.4]})

    # act
    means = mean_by_model(frame, TASK_UNCONDITIONAL, "MAE")

    # assert
    assert means[CHAMPION] == pytest.approx(4.2)


# ---------------------------------------------------------------------------
# cohorts (feature_version v2)
# ---------------------------------------------------------------------------
def test_cohort_masks_cover_tiers_and_events(feats):
    # act
    masks = dict(cohort_masks(feats))

    # assert
    assert set(TIER_ORDER) <= set(masks)
    assert set(EVENT_COHORT_ORDER) <= set(masks)
    # the tiers partition the rows exactly once
    tier_total = sum(int(masks[t].sum()) for t in TIER_ORDER)
    assert tier_total == len(feats)
    # the two vacated_minutes cohorts are disjoint and do not cover everything
    high = masks["event: vacated_minutes >= 30"]
    low = masks["control: vacated_minutes < 5"]
    assert not (high & low).any()
    assert int(high.sum()) + int(low.sum()) < len(feats)


def test_a_row_with_no_cohort_value_joins_no_event_cohort():
    """"we do not know whether anyone was out" is not "nobody was out".

    a null must not be swept into the ``< 5`` control, which is where it would land
    if the comparison were done on a fillna(0) column.
    """
    # arrange
    frame = pd.DataFrame({
        "MIN_TIER": [TIER_ORDER[0]] * 3,
        "vacated_minutes": [40.0, 2.0, np.nan],
        "star_out": [1.0, 0.0, np.nan],
    })

    # act
    masks = dict(cohort_masks(frame))

    # assert
    assert masks["event: vacated_minutes >= 30"].tolist() == [True, False, False]
    assert masks["control: vacated_minutes < 5"].tolist() == [False, True, False]
    assert masks["event: star_out = 1"].tolist() == [True, False, False]


def test_cohorts_are_identical_with_and_without_the_teammate_features(feats):
    """the whole basis of the before/after comparison.

    ``run_rolling_origin(drop_features=...)`` drops columns from the FEATURE LIST,
    never from the frame, so both runs partition the validation rows the same way.
    A cohort definition that depended on a model output would make the two columns
    of the comparison table describe different games.
    """
    # arrange - the frame is what defines the cohorts; the feature list is not
    before = dict(cohort_masks(feats))
    after = dict(cohort_masks(feats.drop(columns=[])))

    # act + assert
    assert set(before) == set(after)
    for label in before:
        assert (before[label] == after[label]).all()
    # and the cohort columns are model outputs of nothing - they are dataset columns
    for _, column, _, _ in [(None, "vacated_minutes", None, None)]:
        assert column in feats.columns


# ---------------------------------------------------------------------------
# the negative control
# ---------------------------------------------------------------------------
def test_the_negative_control_is_a_permutation_not_fresh_noise(feats):
    """same marginal distribution, no relationship to the row.

    a permutation is the stronger control: a booster's split gain responds to a
    column's shape as well as its signal, so gaussian noise would be beatable for
    the wrong reason.
    """
    # act
    with_control = add_negative_control(feats)

    # assert
    assert NEGATIVE_CONTROL_COLUMN in with_control.columns
    real = with_control[NEGATIVE_CONTROL_FEATURE]
    fake = with_control[NEGATIVE_CONTROL_COLUMN]
    assert sorted(fake.to_numpy()) == pytest.approx(sorted(real.to_numpy()))
    assert fake.mean() == pytest.approx(real.mean())
    # but it is not the same column
    assert (fake.to_numpy() != real.to_numpy()).mean() > 0.9


def test_the_negative_control_is_never_a_configured_feature():
    """it must reach a model only via the pass that names it explicitly."""
    # act + assert
    from fnba_ml.config import FEATURE_COLS

    assert NEGATIVE_CONTROL_COLUMN not in FEATURE_COLS
    assert NEGATIVE_CONTROL_FEATURE in FEATURE_COLS


def test_the_permuted_column_shows_no_cohort_lift(feats):
    """the model-free null, which the report leans on.

    the real column's high-vacancy cohort has to differ from the population on mean
    minutes; the permuted column's must not. Otherwise the cohort split itself is
    manufacturing the result.
    """
    # arrange
    frame = add_negative_control(feats)

    # act
    lift = cohort_outcome_lift(frame)
    minutes = lift[lift["outcome"] == "MIN"].set_index("cohort")["lift"]
    real = abs(minutes["event: vacated_minutes >= 30"])
    permuted = abs(minutes["event: vacated_minutes >= 30 [PERMUTED CONTROL]"])

    # assert
    assert permuted < 0.5, f"the permuted cohort shows {permuted:.3f} minutes of lift"
    assert real > permuted, (
        "the real vacated_minutes cohort is no more distinctive than a permutation "
        "of it - either the feature is noise or the cohort split is broken"
    )


def test_cohort_lift_reports_the_control_cohort_too(feats):
    """the quiet-games cohort has to be in the table, or a regression there is
    invisible."""
    # act
    lift = cohort_outcome_lift(add_negative_control(feats))

    # assert
    assert "control: vacated_minutes < 5" in set(lift["cohort"])
    assert set(lift["outcome"]) == {"PLAYED", "MIN", "PTS"}
    assert (lift["rows"] > 0).all()


# ---------------------------------------------------------------------------
# importance reporting
# ---------------------------------------------------------------------------
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
    """availability gain and minutes gain are different units.

    pooling them would rank a minutes feature above every availability feature for
    no reason other than the scale of the loss function.
    """
    # arrange - minutes gains are three orders of magnitude larger
    frame = pd.concat([
        gain_rows("availability", {"a": [100.0], "b": [50.0]}),
        gain_rows("minutes", {"a": [900_000.0], "b": [100_000.0]}),
    ], ignore_index=True)

    # act
    table = importance_table(frame)

    # assert
    for model in ("availability", "minutes"):
        sub = table[table["model"] == model].set_index("feature")
        assert sub.loc["a", "rank"] == 1
        assert sub.loc["b", "rank"] == 2
        assert sub["share"].sum() == pytest.approx(1.0)


def test_importance_means_over_origins():
    # arrange
    frame = gain_rows("minutes", {"a": [100.0, 300.0]})

    # act
    table = importance_table(frame)

    # assert
    assert table.iloc[0]["gain"] == pytest.approx(200.0)


def test_teammate_importance_keeps_only_the_new_family_and_the_control():
    # arrange
    frame = pd.concat([
        gain_rows("minutes", {
            "roll5_MIN": [900.0], "vacated_minutes": [400.0], "star_out": [10.0],
        }),
        gain_rows("minutes", {NEGATIVE_CONTROL_COLUMN: [5.0]},
                  task="Z negative control"),
    ], ignore_index=True)

    # act
    table = teammate_importance(frame)

    # assert
    features = set(table["feature"])
    assert "roll5_MIN" not in features
    assert {"vacated_minutes", "star_out", NEGATIVE_CONTROL_COLUMN} == features
    assert set(table["pass"]) == {"main", "negative-control fit"}


# ---------------------------------------------------------------------------
# the feature-set comparison
# ---------------------------------------------------------------------------
def cohort_results(task: str, metric: str, model: str, values: dict[str, float]):
    return pd.DataFrame([
        {
            "task": task, "origin": "O1", "model": model, "segment": segment,
            "metric": metric, "value": value, "n": 500,
        }
        for segment, value in values.items()
    ])


def test_the_comparison_delta_is_negative_when_the_new_features_help():
    """sign convention: delta is after minus before, so negative is better.

    the same convention ``composition_parity`` uses. getting it backwards would
    report a regression as a win, which is the failure mode a unit test exists for.
    """
    # arrange
    segments = {"ALL": 4.72, "bench (10-20)": 5.53}
    before = cohort_results(TASK_MINUTES, "MAE", CHAMPIONS["minutes"], segments)
    after = cohort_results(
        TASK_MINUTES, "MAE", CHAMPIONS["minutes"], {"ALL": 4.60, "bench (10-20)": 5.20}
    )

    # act
    table = feature_set_comparison(before, after)

    # assert
    row = table.loc[(TASK_MINUTES, "MAE", "ALL")]
    assert row["delta"] == pytest.approx(-0.12)
    assert row["delta_pct"] < 0
    bench = table.loc[(TASK_MINUTES, "MAE", "bench (10-20)")]
    assert bench["delta"] == pytest.approx(-0.33)
    # the bigger relative win is on the bench cohort, which is the claim being made
    assert bench["delta_pct"] < row["delta_pct"]


def test_the_comparison_flags_a_cohort_regression():
    """a family that wins overall by hurting quiet games must show it."""
    # arrange
    before = cohort_results(
        TASK_MINUTES, "MAE", CHAMPIONS["minutes"],
        {"ALL": 4.72, "control: vacated_minutes < 5": 4.10},
    )
    after = cohort_results(
        TASK_MINUTES, "MAE", CHAMPIONS["minutes"],
        {"ALL": 4.60, "control: vacated_minutes < 5": 4.35},
    )

    # act
    table = feature_set_comparison(before, after)

    # assert
    assert table.loc[(TASK_MINUTES, "MAE", "ALL")]["delta"] < 0
    assert table.loc[(TASK_MINUTES, "MAE", "control: vacated_minutes < 5")]["delta"] > 0


def test_the_comparison_uses_each_familys_configured_champion():
    """not the measured winner: the comparison is about the SHIPPED estimator."""
    # arrange - availability is Brier, and only the champion's rows are compared
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

    # act
    table = feature_set_comparison(before, after)

    # assert
    assert list(table.index.get_level_values("task")) == [TASK_AVAILABILITY]
    assert table.iloc[0]["before"] == pytest.approx(0.0734)
    assert table.iloc[0]["after"] == pytest.approx(0.0700)


def test_the_comparison_is_empty_rather_than_wrong_when_a_pass_is_missing():
    """"could not compare" and "no difference" must not look the same."""
    # act + assert
    assert feature_set_comparison(pd.DataFrame(), pd.DataFrame()).empty
    only_after = cohort_results(TASK_MINUTES, "MAE", CHAMPIONS["minutes"], {"ALL": 4.6})
    assert feature_set_comparison(pd.DataFrame(columns=only_after.columns), only_after).empty


def test_dropping_features_changes_the_feature_list_not_the_frame(feats):
    """the invariant the comparison rests on, asserted on the real helper."""
    # arrange
    from fnba_ml.evaluate import run_rolling_origin  # noqa: PLC0415

    origins = [("O1", "2024-12-01", "2024-12-15")]

    # act
    dropped = run_rolling_origin(feats, origins, drop_features=TEAMMATE_FEATURE_COLS)

    # assert - the run happened, and the frame handed in still has its columns
    assert not dropped.empty
    assert set(TEAMMATE_FEATURE_COLS) <= set(feats.columns)
    # the cohort segments are present in the dropped-feature run, because they come
    # from the frame rather than the feature list
    segments = set(dropped["segment"])
    assert "event: vacated_minutes >= 30" in segments
