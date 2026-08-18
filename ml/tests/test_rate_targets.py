"""the 9-category extension: the vocabulary, the per-stat rates, and coherence.

WHAT THESE TESTS ARE FOR. Widening the package from two production stats to eleven
introduced three things that could be wrong in ways nothing downstream would
notice, and each of them has its own section below:

  1. THE VOCABULARY. The store's stat names are constrained by a comment in
     migration 014 rather than by a database constraint, so a typo'd stat name
     produces rows that insert successfully and are invisible to every consumer.
     There is no test database in this repo (AGENTS.md section 6), so the
     migration's own comment is parsed and checked against.

  2. THE PER-STAT HALFLIFE. The halflife stopped being one constant and became a
     lookup, which means every rate column now depends on a dict entry. Two
     failure modes: the lookup is ignored (every stat silently back at 5) and the
     lookup is applied to the wrong stat. Both are checked by construction rather
     than by asserting a stored number.

  3. COHERENCE. FG3M <= FGM <= FGA and FTM <= FTA hold in every game ever played
     and do NOT hold automatically for the expectations, precisely BECAUSE of (2).
     The clip is the correction, and a clip test that only ever ran on already-
     coherent input would pass forever while doing nothing - so every clip test
     here is paired with a case where the clip has real work to do.

NEGATIVE CONTROLS THROUGHOUT, the same pattern the rest of the suite uses: a test
that asserts the shipped halflife for REB is 20 is worth little without one
showing that halflife 20 and halflife 5 produce different numbers, because
otherwise the selection machinery could be inert and every test would still pass.
"""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from fnba_ml.config import (
    COHERENCE_CONSTRAINTS,
    EWMA_HALFLIFE,
    PRODUCTION_TARGETS,
    RATE_ESTIMATORS,
    RATE_HALFLIFE_DEFAULT,
    RATE_HALFLIFE_GRID,
    RATE_HALFLIVES,
    RATE_MINUTES_FLOOR,
    RATE_TARGETS,
    TOURNAMENT_RATE_TARGETS,
    rate_estimator,
    rate_halflife,
)
from fnba_ml.evaluate import (
    RATE_MODEL_EWMA,
    RATE_MODEL_EXPANDING,
    RATE_MODEL_TOTAL,
    RATE_SELECTION_MIN_GAIN,
    RATE_SELECTION_MIN_ORIGINS,
    build_rate_grid,
    coherence_table,
    grid_rate_column,
    inner_folds,
    rate_composition_parity,
    rate_halflife_winners,
    rate_ladder_table,
    rate_task,
    rate_uncond_table,
)
from fnba_ml.features import (
    attach_per_minute_rates,
    expanding_rate_column,
    per_minute_rate_features,
    rate_column,
)
from fnba_ml.intervals import QUANTILE_LEVELS, QUANTILE_TARGETS
from fnba_ml.models import (
    P_PLAY,
    P_PLAY_CUTOFF,
    PerMinuteRate,
    coherence_clip,
    coherence_clip_frame,
    snapshot_ewma_state,
)
from fnba_ml.store import STAT_NAMES, UNCOND_SUFFIX, build_prediction_rows

MIGRATION_014 = (
    Path(__file__).resolve().parents[2] / "db" / "migrations" / "014_predictions.sql"
)

NINE_CAT = ("PTS", "REB", "AST", "STL", "BLK", "TOV", "FG3M", "FGM", "FGA", "FTM", "FTA")


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------
def appearance_history(n: int = 40) -> pd.DataFrame:
    """one player, a deliberate STEP CHANGE, and every 9-cat column.

    the step is what makes a halflife test meaningful: on a flat history every
    halflife returns the same number and a test that swept them would be asserting
    nothing. after the step, a short memory has moved further than a long one, and
    that ordering is the property the sweep is for.
    """
    early, late = n // 2, n - n // 2
    minutes = np.full(n, 24.0)
    step = np.concatenate([np.full(early, 1.0), np.full(late, 3.0)])
    frame = pd.DataFrame({
        "PLAYER_ID": ["p1"] * n,
        "GAME_ID": [f"g{i:03d}" for i in range(n)],
        "TEAM_ID": ["t1"] * n,
        "GAME_DATE": pd.date_range("2024-11-01", periods=n, freq="2D"),
        "PLAYED": np.ones(n, dtype=int),
        "MIN": minutes,
    })
    for i, stat in enumerate(NINE_CAT):
        frame[stat] = step * (i + 1)
    # keep the truth coherent so a coherence test on real-shaped input is not
    # measuring a fixture bug
    frame["FGA"] = step * 12.0
    frame["FGM"] = step * 6.0
    frame["FG3M"] = step * 2.0
    frame["FTA"] = step * 4.0
    frame["FTM"] = step * 3.0
    return frame


# ---------------------------------------------------------------------------
# 1. the vocabulary
# ---------------------------------------------------------------------------
def test_rate_targets_cover_the_whole_nine_category_vocabulary():
    assert set(NINE_CAT) <= set(RATE_TARGETS)


def test_no_percentage_is_ever_a_rate_target():
    """FG% and FT% are derived by consumers; E[A/B] != E[A]/E[B] and the package
    ships the primitives precisely so a weekly aggregate can be computed right."""
    assert not [t for t in RATE_TARGETS if "PCT" in t or "%" in t]


def test_production_targets_are_the_rate_targets():
    """one list, so predict.py cannot serve a stat that has no rate and vice versa."""
    assert tuple(PRODUCTION_TARGETS) == tuple(RATE_TARGETS)


def test_every_rate_target_has_a_store_name():
    assert not [t for t in RATE_TARGETS if t not in STAT_NAMES]


def test_store_names_match_migration_014s_reserved_vocabulary():
    """the schema has no CHECK constraint on ``stat``, so this comment IS the contract.

    a stat name outside it inserts fine and is invisible to every consumer, which
    is the failure this test exists to make loud.
    """
    text = MIGRATION_014.read_text(encoding="utf-8")
    line = next(
        raw for raw in text.splitlines()
        if "'minutes'" in raw and "'fgm'" in raw
    )
    reserved = set(re.findall(r"'([a-z0-9_]+)'", line))
    served = {STAT_NAMES[t] for t in RATE_TARGETS} | {"minutes"}
    assert served <= reserved, f"not reserved by migration 014: {served - reserved}"


def test_quantile_targets_cover_minutes_and_every_rate_target():
    assert set(QUANTILE_TARGETS) == {"MIN", *RATE_TARGETS}


# ---------------------------------------------------------------------------
# 2. the per-stat halflife
# ---------------------------------------------------------------------------
def test_every_rate_target_has_a_halflife_and_an_estimator():
    for target in RATE_TARGETS:
        assert target in RATE_HALFLIVES
        assert target in RATE_ESTIMATORS


def test_pts_and_ast_stay_frozen_at_the_tournament_verdict():
    """the production tournament pre-registered a 2% floor and no challenger cleared
    it. re-tuning these two here would be re-rolling a pre-registered test."""
    for target in TOURNAMENT_RATE_TARGETS:
        assert rate_halflife(target) == EWMA_HALFLIFE
        assert rate_estimator(target) == "ewma"


def test_every_selected_halflife_is_on_the_pre_registered_grid():
    for target in RATE_TARGETS:
        assert rate_halflife(target) in RATE_HALFLIFE_GRID


def test_rate_estimator_rejects_an_unknown_family():
    original = RATE_ESTIMATORS.get("PTS")
    RATE_ESTIMATORS["PTS"] = "kalman"
    try:
        with pytest.raises(ValueError, match="unknown rate estimator"):
            rate_estimator("PTS")
    finally:
        RATE_ESTIMATORS["PTS"] = original


def test_rate_halflife_falls_back_to_the_default_for_an_unlisted_stat():
    assert rate_halflife("NOT_A_STAT") == RATE_HALFLIFE_DEFAULT


def test_per_minute_rate_features_emits_both_families_for_every_target():
    built = per_minute_rate_features(appearance_history())
    for target in NINE_CAT:
        assert rate_column(target) in built.columns
        assert expanding_rate_column(target) in built.columns


def test_the_configured_halflife_is_actually_applied_per_stat():
    """the lookup must reach the ewm call, and reach it with the RIGHT stat's value.

    checked by reconstruction rather than against a stored number: each column is
    recomputed from the raw ratio at that stat's own configured halflife and must
    match exactly.
    """
    frame = appearance_history()
    built = per_minute_rate_features(frame)
    denominator = frame["MIN"].clip(lower=RATE_MINUTES_FLOOR)
    for target in NINE_CAT:
        expected = (
            (frame[target] / denominator)
            .ewm(halflife=rate_halflife(target), adjust=True)
            .mean()
            .to_numpy(dtype=float)
        )
        assert np.allclose(built[rate_column(target)].to_numpy(dtype=float), expected)


def test_negative_control_two_halflives_on_this_history_disagree():
    """without this, the test above could pass with the halflife lookup inert."""
    frame = appearance_history()
    denominator = frame["MIN"].clip(lower=RATE_MINUTES_FLOOR)
    ratio = frame["REB"] / denominator
    short = ratio.ewm(halflife=3.0, adjust=True).mean().to_numpy()
    long = ratio.ewm(halflife=20.0, adjust=True).mean().to_numpy()
    assert not np.allclose(short, long)
    # and in the direction a halflife is FOR: after a step up, the shorter memory
    # has travelled further toward the new level
    assert short[-1] > long[-1]


def test_a_long_halflife_stat_and_a_short_one_get_different_columns():
    """REB ships at 20 and FGM at 5, so their rate columns must not coincide."""
    assert rate_halflife("REB") != rate_halflife("FGM")
    built = per_minute_rate_features(appearance_history())
    reb = built[rate_column("REB")].to_numpy(dtype=float) / 3.0
    fgm = built[rate_column("FGM")].to_numpy(dtype=float) / 6.0
    # both are the same underlying step, rescaled; only the memory differs
    assert not np.allclose(reb, fgm)


def test_expanding_rate_is_the_running_mean_of_the_ratio():
    frame = appearance_history()
    built = per_minute_rate_features(frame)
    denominator = frame["MIN"].clip(lower=RATE_MINUTES_FLOOR)
    expected = (frame["BLK"] / denominator).expanding(min_periods=1).mean()
    assert np.allclose(
        built[expanding_rate_column("BLK")].to_numpy(dtype=float),
        expected.to_numpy(dtype=float),
    )


def test_expanding_rate_differs_from_every_ewma_on_the_grid():
    """NEGATIVE CONTROL: if it did not, 'expanding' would be a duplicate member and
    the STL selection would be meaningless."""
    frame = appearance_history()
    denominator = frame["MIN"].clip(lower=RATE_MINUTES_FLOOR)
    ratio = frame["STL"] / denominator
    expanding = ratio.expanding(min_periods=1).mean().to_numpy()
    for halflife in RATE_HALFLIFE_GRID:
        assert not np.allclose(expanding, ratio.ewm(halflife=halflife).mean().to_numpy())


def test_per_minute_rate_reads_the_column_its_estimator_names():
    assert PerMinuteRate("BLK", estimator="ewma").column == rate_column("BLK")
    assert (
        PerMinuteRate("BLK", estimator="expanding").column
        == expanding_rate_column("BLK")
    )


def test_steals_ship_the_expanding_baseline_and_carry_no_halflife():
    """the one stat whose FIRST champion is the baseline rather than the EWMA. an
    expanding mean has no memory parameter, so reporting one would be a claim about
    an estimator that does not have it."""
    rate = PerMinuteRate("STL")
    assert rate.estimator == "expanding"
    assert np.isnan(rate.halflife)
    assert rate.column == expanding_rate_column("STL")


def test_snapshot_carries_both_rate_families_for_every_target():
    """an artifact that persisted only the promoted column would make re-reading the
    losing estimator impossible without replaying four seasons of history."""
    frame = attach_per_minute_rates(appearance_history())
    snapshot = snapshot_ewma_state(frame, frame["GAME_DATE"].max() + pd.Timedelta(days=1))
    for target in NINE_CAT:
        assert rate_column(target) in snapshot.columns
        assert expanding_rate_column(target) in snapshot.columns
    assert set(snapshot.attrs["rate_fallbacks"]) >= set(NINE_CAT)


# ---------------------------------------------------------------------------
# 3. coherence
# ---------------------------------------------------------------------------
def test_coherence_clips_the_bounded_stat_down_not_the_bound_up():
    """attempts are the higher-volume, better-estimated member of each pair, so when
    the two disagree the MAKES estimate is the one that is wrong."""
    values, counts = coherence_clip({
        "FGM": np.array([9.0]), "FGA": np.array([8.0]),
    })
    assert values["FGM"][0] == pytest.approx(8.0)
    assert values["FGA"][0] == pytest.approx(8.0)  # the bound never moves
    assert counts["FGM<=FGA"] == 1


def test_coherence_chain_settles_in_one_pass():
    """FG3M is pulled under the ALREADY-CORRECTED FGM, not under the original one."""
    values, _ = coherence_clip({
        "FG3M": np.array([9.0]), "FGM": np.array([9.0]), "FGA": np.array([4.0]),
    })
    assert values["FGM"][0] == pytest.approx(4.0)
    assert values["FG3M"][0] == pytest.approx(4.0)


def test_coherence_is_a_no_op_on_coherent_input():
    values, counts = coherence_clip({
        "FG3M": np.array([2.0]), "FGM": np.array([6.0]), "FGA": np.array([12.0]),
        "FTM": np.array([3.0]), "FTA": np.array([4.0]),
    })
    assert values["FGM"][0] == pytest.approx(6.0)
    assert values["FG3M"][0] == pytest.approx(2.0)
    assert values["FTM"][0] == pytest.approx(3.0)
    assert sum(counts.values()) == 0


def test_coherence_skips_a_constraint_whose_bound_is_absent():
    """'we did not project attempts' is not a licence to clip makes to nothing."""
    values, counts = coherence_clip({"FGM": np.array([9.0])})
    assert values["FGM"][0] == pytest.approx(9.0)
    assert "FGM<=FGA" not in counts


def test_coherence_ignores_non_finite_values_rather_than_clipping_to_nan():
    values, counts = coherence_clip({
        "FTM": np.array([3.0, 5.0]), "FTA": np.array([np.nan, 4.0]),
    })
    assert values["FTM"][0] == pytest.approx(3.0)
    assert values["FTM"][1] == pytest.approx(4.0)
    assert counts["FTM<=FTA"] == 1


def test_coherence_clip_frame_applies_one_template_at_a_time():
    frame = pd.DataFrame({
        "E_FGM": [9.0], "E_FGA": [8.0],
        "Q90_FGM": [14.0], "Q90_FGA": [11.0],
    })
    out, counts = coherence_clip_frame(frame, "E_{target}")
    assert out["E_FGM"][0] == pytest.approx(8.0)
    # the quantile columns are a DIFFERENT template and are untouched by this call;
    # predict.py runs one pass per template so each level is clipped against its own
    assert out["Q90_FGM"][0] == pytest.approx(14.0)
    assert counts["FGM<=FGA"] == 1

    out, _ = coherence_clip_frame(out, "Q90_{target}")
    assert out["Q90_FGM"][0] == pytest.approx(11.0)


def test_coherence_clip_frame_is_inert_when_no_column_matches():
    frame = pd.DataFrame({"E_PTS": [20.0]})
    out, counts = coherence_clip_frame(frame, "E_{target}")
    assert counts == {}
    assert out.equals(frame)


def test_the_constraint_chain_is_ordered_so_fgm_settles_before_fg3m():
    """the chain's correctness depends on the ORDER of config.COHERENCE_CONSTRAINTS,
    which no other test would notice if it were reversed."""
    pairs = list(COHERENCE_CONSTRAINTS)
    assert pairs.index(("FGM", "FGA")) < pairs.index(("FG3M", "FGM"))


def test_equal_halflives_cannot_produce_an_incoherent_expectation():
    """THE REASON THE CLIP EXISTS, stated as a test: two EWMAs at the SAME halflife
    are the same weighted average of the same rows, so monotonicity survives. It is
    only per-stat halflives that can break it, which is what makes the clip's
    observed frequency a measurement of what selection costs."""
    frame = appearance_history()
    denominator = frame["MIN"].clip(lower=RATE_MINUTES_FLOOR)
    makes = (frame["FGM"] / denominator).ewm(halflife=5.0, adjust=True).mean()
    attempts = (frame["FGA"] / denominator).ewm(halflife=5.0, adjust=True).mean()
    assert (makes <= attempts + 1e-12).all()

    # and the NEGATIVE CONTROL, which is the whole justification for the clip: at
    # DIFFERENT halflives the inequality is no longer guaranteed. A player who
    # never scored on one attempt a night and has lately been taking and making
    # ten has a short-memory MAKES estimate above his long-memory ATTEMPTS
    # estimate, even though he has never in his life made more shots than he took.
    late = np.arange(len(frame)) >= len(frame) - 8
    spiky = frame.copy()
    spiky["FGA"] = np.where(late, 10.0, 1.0)
    spiky["FGM"] = np.where(late, 10.0, 0.0)
    assert (spiky["FGM"] <= spiky["FGA"]).all()  # the TRUTH is coherent
    short = (spiky["FGM"] / denominator).ewm(halflife=3.0, adjust=True).mean()
    long = (spiky["FGA"] / denominator).ewm(halflife=20.0, adjust=True).mean()
    assert (short > long).any()                  # the ESTIMATES are not


# ---------------------------------------------------------------------------
# 4. the emitted rows
# ---------------------------------------------------------------------------
def scored_frame() -> pd.DataFrame:
    frame = pd.DataFrame({
        "PLAYER_ID": ["2544"],
        "GAME_ID": ["0022500123"],
        "GAME_DATE": pd.to_datetime(["2026-03-01"]),
        P_PLAY: [0.82],
        P_PLAY_CUTOFF: pd.to_datetime(["2026-02-28"]),
    })
    for target in ("MIN", *RATE_TARGETS):
        frame[f"E_{target}_COND"] = 5.0
        frame[f"E_{target}"] = 4.1
        for level in QUANTILE_LEVELS:
            frame[f"Q{int(round(level * 100)):02d}_{target}"] = 5.0 + level
    return frame


def test_every_served_stat_reaches_the_store_conditional_and_unconditional():
    rows = build_prediction_rows(scored_frame(), ("MIN", *RATE_TARGETS))
    stats = {r["stat"] for r in rows}
    for target in RATE_TARGETS:
        name = STAT_NAMES[target]
        assert name in stats
        assert f"{name}{UNCOND_SUFFIX}" in stats


def test_conditional_and_unconditional_rows_carry_the_right_flag():
    rows = build_prediction_rows(scored_frame(), ("MIN", *RATE_TARGETS))
    for row in rows:
        if row["stat"].endswith(UNCOND_SUFFIX):
            assert row["conditional"] is False


def test_every_new_stat_gets_its_quantiles():
    rows = build_prediction_rows(scored_frame(), ("MIN", *RATE_TARGETS))
    for target in RATE_TARGETS:
        levels = {
            r["quantile"] for r in rows
            if r["stat"] == STAT_NAMES[target] and r["quantile"] is not None
        }
        assert levels == {round(float(v), 2) for v in QUANTILE_LEVELS}


def test_no_row_uses_a_stat_name_outside_the_reserved_vocabulary():
    text = MIGRATION_014.read_text(encoding="utf-8")
    line = next(
        raw for raw in text.splitlines() if "'minutes'" in raw and "'fgm'" in raw
    )
    reserved = set(re.findall(r"'([a-z0-9_]+)'", line))
    rows = build_prediction_rows(scored_frame(), ("MIN", *RATE_TARGETS))
    emitted = {
        r["stat"].removesuffix(UNCOND_SUFFIX) for r in rows
        if not r["stat"].startswith(("prob_", "status_"))
    }
    assert emitted <= reserved


# ---------------------------------------------------------------------------
# 4b. the report tables. both of these are regressions on real bugs.
# ---------------------------------------------------------------------------
def ladder_results() -> pd.DataFrame:
    """a tidy results frame shaped exactly as ``_rate_ladder`` records one."""
    rows = []
    for target in ("STL", "REB"):
        for unconditional in (False, True):
            for model, value in (
                (RATE_MODEL_EWMA, 1.0),
                (RATE_MODEL_EXPANDING, 0.8),
                (RATE_MODEL_TOTAL, 1.2),
            ):
                rows.append({
                    "task": rate_task(target, unconditional), "origin": "O1",
                    "model": model, "segment": "ALL", "metric": "MAE",
                    "value": value, "n": 100,
                })
    return pd.DataFrame(rows)


def test_the_unconditional_table_is_not_silently_empty():
    """REGRESSION. the conditional and unconditional task names differ in BOTH the
    prefix and the suffix. an earlier version parameterised only the prefix, which
    produced a name matching no row and an empty table rather than an error - the
    failure mode a report notices least."""
    table = rate_uncond_table(ladder_results(), targets=("STL", "REB"))
    assert len(table) == 2
    assert not table["champion_mae"].isna().any()


def test_the_champion_column_follows_the_configured_estimator():
    """REGRESSION. STL ships the expanding baseline. A table that hardcoded the
    EWMA as the champion reported STL losing to an estimator it does not use."""
    table = rate_ladder_table(ladder_results(), targets=("STL", "REB")).set_index("target")
    assert RATE_ESTIMATORS["STL"] == "expanding"
    assert table.loc["STL", "champion_mae"] == pytest.approx(0.8)
    assert table.loc["STL", "vs_expanding"] == pytest.approx(0.0)
    # and the control: a stat that does ship the EWMA reads the EWMA
    assert RATE_ESTIMATORS["REB"] == "ewma"
    assert table.loc["REB", "champion_mae"] == pytest.approx(1.0)


def test_per_stat_parity_compares_the_shipped_estimator():
    parity = rate_composition_parity(
        ladder_results(), targets=("STL", "REB")
    ).set_index("target")
    assert parity.loc["STL", "champion"] == RATE_MODEL_EXPANDING
    assert parity.loc["REB", "champion"] == RATE_MODEL_EWMA


def test_per_stat_parity_flags_a_regression_with_a_positive_delta():
    """the sign convention: positive means the champion is WORSE, and that is the
    direction that must fail."""
    results = ladder_results()
    worse = results.copy()
    worse.loc[worse["model"] == RATE_MODEL_EWMA, "value"] = 2.0
    parity = rate_composition_parity(worse, targets=("REB",)).iloc[0]
    assert parity["relative_delta"] > 0
    assert not parity["within_tolerance"]


def test_the_coherence_table_is_empty_rather_than_fabricated_when_nothing_ran():
    assert coherence_table(pd.DataFrame(columns=["task", "metric"])).empty


# ---------------------------------------------------------------------------
# 5. the halflife selection rule
# ---------------------------------------------------------------------------
SPOILER = "h3"  # the method that steals individual origins without winning pooled


def selection_frame(target: str, best: str, wins: int, gain: float) -> pd.DataFrame:
    """synthetic inner-fold MAEs: ``best`` is the POOLED winner by ``gain``, and is
    the per-origin winner in exactly ``wins`` of five origins.

    the two axes have to be independent for the rule's two clauses to be testable
    separately, which they are not if the pooled winner is simply whichever method
    won most origins. So ``best`` carries a uniform advantage everywhere, and in the
    origins it is not supposed to win a SPOILER edges past it locally by a margin
    small enough that the spoiler still loses the pooled average.
    """
    rows = []
    for i in range(5):
        for method in [f"h{h:g}" for h in RATE_HALFLIFE_GRID] + ["expanding"]:
            mae = 1.0
            if method == best:
                mae = 1.0 - gain
            elif method == SPOILER and i >= wins:
                mae = 1.0 - gain - 1e-4
            rows.append({
                "origin": f"O{i}", "fold": "inner1", "target": target,
                "method": method, "MAE": mae, "n": 100,
            })
    return pd.DataFrame(rows)


def test_the_selection_fixture_separates_pooled_from_per_origin():
    """NEGATIVE CONTROL ON THE FIXTURE ITSELF. if the spoiler also won pooled, the
    'material but inconsistent' test below would be testing clause 1, not clause 2."""
    frame = selection_frame("REB", "h20", wins=1, gain=0.05)
    pooled = frame.groupby("method")["MAE"].mean()
    assert pooled.idxmin() == "h20"
    per_origin = frame.groupby(["origin", "method"])["MAE"].mean().unstack()
    assert (per_origin.idxmin(axis=1) == SPOILER).sum() == 4


def test_a_consistent_and_material_winner_is_selected():
    winners = rate_halflife_winners(
        selection_frame("REB", "h20", wins=5, gain=0.05), frozen=()
    )
    row = winners.iloc[0]
    assert row["halflife"] == 20.0
    assert not row["ambiguous"]


def test_a_material_but_inconsistent_winner_falls_back_to_the_default():
    """a pooled mean can be moved by one unusual month; three of five rankings cannot."""
    winners = rate_halflife_winners(
        selection_frame("BLK", "h20", wins=1, gain=0.05), frozen=()
    )
    row = winners.iloc[0]
    assert row["halflife"] == RATE_HALFLIFE_DEFAULT
    assert row["ambiguous"]


def test_a_consistent_but_immaterial_winner_falls_back_to_the_default():
    winners = rate_halflife_winners(
        selection_frame("FGA", "h8", wins=5, gain=RATE_SELECTION_MIN_GAIN / 4),
        frozen=(),
    )
    row = winners.iloc[0]
    assert row["halflife"] == RATE_HALFLIFE_DEFAULT
    assert row["ambiguous"]


def test_a_frozen_target_cannot_be_moved_by_any_evidence():
    """the whole point of a pre-registered verdict: strong new evidence is exactly
    the case where re-running until it moves would be illegitimate."""
    winners = rate_halflife_winners(
        selection_frame("PTS", "h20", wins=5, gain=0.5), frozen=("PTS",)
    )
    row = winners.iloc[0]
    assert row["halflife"] == RATE_HALFLIFE_DEFAULT
    assert row["estimator"] == "ewma"
    assert not row["ambiguous"]  # not ambiguous - overruled, and the rule says so
    assert "FROZEN" in row["rule"]
    # the evidence is still reported rather than suppressed
    assert row["best_grid_halflife"] == 20.0


def test_the_consistency_threshold_is_a_majority_of_origins():
    assert RATE_SELECTION_MIN_ORIGINS * 2 > 5


# ---------------------------------------------------------------------------
# 6. the inner folds: the selection must never see a validation row
# ---------------------------------------------------------------------------
def test_inner_folds_are_disjoint_adjacent_and_inside_the_training_window():
    train = pd.DataFrame({
        "GAME_DATE": pd.date_range("2024-01-01", "2024-11-30", freq="D")
    })
    folds = inner_folds(train, n_folds=2, days=28)
    assert len(folds) == 2
    end = train["GAME_DATE"].max() + pd.Timedelta(days=1)
    (_, start1, stop1), (_, start2, stop2) = folds
    assert stop1 == end                       # the latest fold ends at the window edge
    assert stop2 == start1                    # adjacent, no gap and no overlap
    assert start2 > train["GAME_DATE"].min()  # strictly inside


def test_inner_folds_refuse_to_run_off_the_front_of_a_short_window():
    train = pd.DataFrame({
        "GAME_DATE": pd.date_range("2024-01-01", "2024-02-05", freq="D")
    })
    assert len(inner_folds(train, n_folds=4, days=28)) < 4


def test_inner_folds_of_an_empty_frame_are_empty():
    assert inner_folds(pd.DataFrame({"GAME_DATE": pd.Series(dtype="datetime64[ns]")})) == []


# ---------------------------------------------------------------------------
# 7. the selection grid is as-of safe, exactly like the shipped rate columns
# ---------------------------------------------------------------------------
def test_the_halflife_grid_covers_every_target_and_every_halflife():
    grid = build_rate_grid(appearance_history(), ("REB", "BLK"), RATE_HALFLIFE_GRID)
    for target in ("REB", "BLK"):
        for halflife in RATE_HALFLIFE_GRID:
            assert grid_rate_column(target, halflife) in grid.columns


def test_grid_columns_are_prefixed_so_no_booster_can_pick_one_up():
    """``available_features`` selects by name from FEATURE_COLS; the underscore
    prefix is the second line of defence, and it is cheap to pin."""
    grid = build_rate_grid(appearance_history(), ("REB",), RATE_HALFLIFE_GRID)
    for column in grid.columns:
        if column in ("PLAYER_ID", "GAME_DATE"):
            continue
        assert column.startswith("_")


def test_grid_rates_are_inclusive_and_the_join_supplies_the_shift():
    """the same contract ``per_minute_rate_features`` has: this frame is INCLUSIVE
    of the current appearance and must never be joined on equality."""
    frame = appearance_history(6)
    grid = build_rate_grid(frame, ("REB",), (5.0,))
    denominator = frame["MIN"].clip(lower=RATE_MINUTES_FLOOR)
    expected = (
        (frame["REB"] / denominator).ewm(halflife=5.0, adjust=True).mean().to_numpy()
    )
    assert np.allclose(grid[grid_rate_column("REB", 5.0)].to_numpy(dtype=float), expected)
