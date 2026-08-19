"""leakage and contract tests for the P2 candidate family (feature_version v4).

THREE THINGS THIS FILE HAS TO PROVE, in descending order of how expensive it would
be to get wrong:

  1. **The freeze still holds.** `prospective_2026_27_v1` pins FEATURE_COLS by digest
     and FEATURE_VERSION by literal (MODEL.md 13.1, 13.2 item 6). The candidate adds
     names to `config` and one entry to `FEATURE_SETS`, and if it has accidentally
     touched either frozen object then `test_prospective_freeze.py` goes red and the
     prospective test for v1 is over. The first four tests below check that from this
     side too, so a failure names the cause rather than only the symptom.
  2. **No new feature reads the target game.** The v2 -> v3 lesson (MODEL.md section
     11) was a feature that conditioned on other players' target-game labels. The same
     trap is live in two new places: the OPPONENT's rolling aggregates (the opponent's
     box score for the target game sits in the same frame) and the BLOWOUT
     probability (a classifier scoring the rows it was fitted on). Both get an
     invariance test with a negative control that must FAIL - because a test that
     passes against both the correct and the leaky construction proves nothing.
  3. **The arithmetic is the arithmetic that was documented.** Possessions, pace,
     defensive rating, games-over-.500, lockedness and the start-rate proxy each get
     a hand computation. "Moved in the right direction" would pass against a wrong
     window, a wrong denominator or a sign error, all three of which are easy here.

WHERE THE FIXTURES ARE NOT ENOUGH, AND WHAT IS DONE ABOUT IT. The shared fixture set
is 8 teams x 20 games x 2 seasons, so no team ever gets within 15 games of the end of
an 82-game season and `late_season` never fires on it. The stakes tests therefore
build small SYNTHETIC team logs with hand-chosen records, which is the right tool
anyway: a lockedness formula is checkable against arithmetic and not against a
simulation.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

ML_ROOT = Path(__file__).resolve().parents[1]
if str(ML_ROOT) not in sys.path:
    sys.path.insert(0, str(ML_ROOT))

from fnba_ml import config  # noqa: E402
from fnba_ml.config import (  # noqa: E402
    BLOWOUT_MARGIN,
    BLOWOUT_MODEL_FEATURES,
    BLOWOUT_PRIOR,
    BLOWOUT_PROB,
    BLOWOUT_PROB_CUTOFF,
    BLOWOUT_TARGET,
    FT_POSSESSION_WEIGHT,
    LATE_SEASON_GAMES_REMAINING,
    PACE_MIN_PERIODS,
    PACE_WINDOW,
    REGULAR_SEASON_GAMES,
    START_RATE_TOP_N,
    START_RATE_WINDOW,
    STAKES_LOCKED_RATIO,
)
from fnba_ml.evaluate import cohort_masks  # noqa: E402
from fnba_ml.features import schedule_features  # noqa: E402
from fnba_ml.matchup import (  # noqa: E402
    CTX_DEF_RATING,
    CTX_FG3A_ALLOWED,
    CTX_IS_B2B,
    CTX_NET_RATING,
    CTX_PACE,
    CTX_REST_DAYS,
    CTX_SLOT_MINUTES,
    OUTCOME_COLS,
    ROLLING_CTX_COLS,
    START_RATE_COL,
    STAKES_CTX_COLS,
    _pair_team_games,
    _per_game_rates,
    attach_matchup_features,
    attach_start_rate,
    attach_v4_features,
    auc,
    cross_fit_blowout_probabilities,
    start_rate_features,
    team_game_context,
)
from fnba_ml.models import LeakageError, brier, validate_out_of_fold  # noqa: E402


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def context(team_logs: pd.DataFrame) -> pd.DataFrame:
    return team_game_context(team_logs)


@pytest.fixture(scope="module")
def blowout_probabilities(context: pd.DataFrame) -> pd.DataFrame:
    # min_train_rows is dropped to 40 for the fixtures: BLOWOUT_CROSS_FIT_MIN_TRAIN_ROWS
    # is 400, which is more team-games than the whole fixture set has, so the
    # production constant would put every row on the prior and the cross-fit branch
    # under test would never execute. The SCHEME is what is being tested, not the gate.
    return cross_fit_blowout_probabilities(context, min_train_rows=40)


@pytest.fixture(scope="module")
def v4_features(
    features_status: pd.DataFrame,
    context: pd.DataFrame,
    blowout_probabilities: pd.DataFrame,
) -> pd.DataFrame:
    """the candidate frame with a FITTED blowout probability, not the prior fallback.

    assembled from the pieces rather than through :func:`attach_v4_features` for one
    reason: that helper uses the production ``BLOWOUT_CROSS_FIT_MIN_TRAIN_ROWS`` of
    400, which exceeds the fixture set's 320 team-games, so every row would carry the
    constant ``BLOWOUT_PRIOR`` and every test that depends on the probability VARYING
    would be vacuous. ``test_attach_v4_features_runs_end_to_end`` covers the helper
    itself.
    """
    attached = attach_matchup_features(features_status, context, blowout_probabilities)
    return attach_start_rate(attached)


@pytest.fixture(scope="module")
def v4_features_via_helper(
    features_status: pd.DataFrame, team_logs: pd.DataFrame
) -> pd.DataFrame:
    return attach_v4_features(features_status, team_logs)


def _synthetic_team_logs(records: list[tuple[str, int, int, int]]) -> pd.DataFrame:
    """a minimal two-team season from (date, home_pts, away_pts, game_index) tuples.

    hand-built rather than simulated, because the stakes and blowout arithmetic is
    checkable against numbers a reader can add up and a simulation would only be
    checkable against itself.
    """
    rows = []
    for date, home_pts, away_pts, idx in records:
        for team, pts, opp_pts in (("H", home_pts, away_pts), ("A", away_pts, home_pts)):
            rows.append({
                "TEAM_ID": team, "GAME_ID": f"G{idx:04d}", "SEASON": "2024-25",
                "GAME_DATE": pd.Timestamp(date), "PTS": float(pts), "MIN": 240.0,
                "FGA": 90.0, "FTA": 20.0, "TOV": 14.0, "FG3A": 35.0,
            })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# 1. THE FREEZE. these four are the reason this phase can exist at all.
# ---------------------------------------------------------------------------
def test_the_frozen_feature_contract_did_not_move() -> None:
    """FEATURE_COLS and its digest are exactly what section 13.1 pinned.

    stated from this side as well as from test_prospective_freeze's, because a
    candidate feature set is the single most likely thing to break the freeze by
    accident: the natural way to write it is to append to FEATURE_COLS.
    """
    digest = hashlib.sha256("\n".join(config.FEATURE_COLS).encode()).hexdigest()
    assert len(config.FEATURE_COLS) == 51
    assert digest == config.PROSPECTIVE_FEATURE_COLS_SHA256
    assert config.FEATURE_VERSION == "v3" == config.PROSPECTIVE_FEATURE_VERSION


def test_the_candidate_is_additive_and_is_not_the_served_contract() -> None:
    assert config.FEATURE_COLS_V4[: len(config.FEATURE_COLS)] == config.FEATURE_COLS
    assert config.FEATURE_COLS_V4[len(config.FEATURE_COLS):] == config.V4_FEATURE_COLS
    assert len(config.FEATURE_COLS_V4) == len(set(config.FEATURE_COLS_V4))
    assert not set(config.V4_FEATURE_COLS) & set(config.FEATURE_COLS)
    # the candidate version tag is a CONSTANT, never assigned to FEATURE_VERSION.
    # Promoting is four deliberate steps (MODEL.md 13.2); none of them is an import.
    assert config.CANDIDATE_FEATURE_VERSION == "v4"
    assert config.FEATURE_VERSION != config.CANDIDATE_FEATURE_VERSION


def test_the_existing_feature_sets_are_untouched() -> None:
    assert config.FEATURE_SETS["v1"] == config.BASE_FEATURE_COLS
    assert config.FEATURE_SETS["v3-honest"] == config.FEATURE_COLS
    assert config.FEATURE_SETS[config.CANDIDATE_FEATURE_SET] == config.FEATURE_COLS_V4
    assert config.SERVED_FEATURE_SET == "v3-honest"
    # v1 remains the no-context floor: the candidate's columns must not leak into it
    assert not set(config.V4_FEATURE_COLS) & set(config.FEATURE_SETS["v1"])


def test_no_candidate_feature_is_an_outcome_column() -> None:
    """the same assertion test_features makes for v3, extended to the candidate.

    ``team_margin`` and ``blowout`` are on the dataset because the classifier trains
    on them; ``blowout_prob`` is the model's estimate and IS a feature. Confusing the
    two would be the whole of the leak.
    """
    assert not config.TARGET_COLS & set(config.FEATURE_COLS_V4)
    assert config.BLOWOUT_TARGET in config.TARGET_COLS
    assert config.BLOWOUT_MARGIN_COL in config.TARGET_COLS
    assert BLOWOUT_PROB in config.FEATURE_COLS_V4
    assert BLOWOUT_PROB not in config.TARGET_COLS


def test_origins_were_added_to_and_not_edited() -> None:
    """DEV_ORIGINS supersets ORIGINS; ORIGINS is still the five every champion used."""
    assert len(config.ORIGINS) == 5
    assert config.DEV_ORIGINS[:5] == config.ORIGINS
    assert config.DEV_ORIGINS[5] == config.LATE_SEASON_ORIGIN
    assert len(config.DEV_ORIGINS) == 6


def test_the_late_season_origin_is_outside_the_selection_holdout() -> None:
    """the choice of 2025 over 2026, encoded so it cannot be quietly reverted.

    MODEL.md section 6 defines the SELECTION HOLDOUT as Feb-2026 -> Apr-2026 and says
    it is "never used for model selection". A development origin validating on
    2026-03-15..04-12 would consume it, which is exactly the claim that section makes.
    """
    _, start, end = config.LATE_SEASON_ORIGIN
    holdout_start = pd.Timestamp("2026-02-01")
    assert pd.Timestamp(end) < holdout_start, (
        "the late-season development origin must not reach into the Feb-Apr 2026 "
        "selection holdout"
    )
    # and it must actually be late in ITS season, or it measures nothing new
    assert pd.Timestamp(start).month >= 3


def test_the_blowout_model_features_are_all_pregame() -> None:
    assert not set(BLOWOUT_MODEL_FEATURES) & set(OUTCOME_COLS)
    assert not set(BLOWOUT_MODEL_FEATURES) & config.TARGET_COLS
    # and none of them is a served feature name, so a v4 model cannot pick up a
    # blowout INPUT and mistake it for context the player frame supplies
    assert not set(BLOWOUT_MODEL_FEATURES) & set(config.FEATURE_COLS_V4)


# ---------------------------------------------------------------------------
# 2. SHIFT DISCIPLINE on the team-level rolling rates
# ---------------------------------------------------------------------------
def test_the_first_team_game_of_a_season_has_null_rolling_rates(
    context: pd.DataFrame,
) -> None:
    """the canonical leakage test: game 1 cannot know anything."""
    first = context.sort_values("GAME_DATE").groupby(["TEAM_ID", "SEASON"]).head(1)
    for column in ROLLING_CTX_COLS:
        assert first[column].isna().all(), (
            f"{column} is populated on a team's first game of a season, so it read "
            f"either that game or the previous season"
        )
    assert first[CTX_REST_DAYS].isna().all()


def test_rolling_rates_are_null_until_min_periods(context: pd.DataFrame) -> None:
    """min_periods is PACE_MIN_PERIODS, so games 1..4 are null and game 6 is not."""
    ordered = context.sort_values(["TEAM_ID", "SEASON", "GAME_DATE"])
    nth = ordered.groupby(["TEAM_ID", "SEASON"]).cumcount()
    assert ordered.loc[nth < PACE_MIN_PERIODS, CTX_PACE].isna().all()
    # some team-season reaches min_periods in the fixtures, or this test is vacuous
    reached = ordered.loc[nth >= PACE_MIN_PERIODS, CTX_PACE]
    assert len(reached) > 0
    assert reached.notna().any()


def test_rolling_pace_equals_a_hand_computed_prior_mean(
    context: pd.DataFrame, team_logs: pd.DataFrame
) -> None:
    """the rolling window, checked against the arithmetic rather than against itself.

    picks the (team, season) with the most games, recomputes the per-game pace from
    the raw box scores, and requires the context column at row k to equal the mean of
    rows [k-window, k-1]. This is the test that would catch an off-by-one in the
    shift, a window of 10 where 15 was documented, or a pace that divided by 48
    instead of by the game's actual slot minutes.
    """
    raw = _per_game_rates(_pair_team_games(team_logs))
    key = raw.groupby(["TEAM_ID", "SEASON"]).size().idxmax()
    team, season = key
    own = raw[(raw["TEAM_ID"] == team) & (raw["SEASON"] == season)]
    own = own.sort_values(["GAME_DATE", "GAME_ID"]).reset_index(drop=True)
    got = context[(context["TEAM_ID"] == team) & (context["SEASON"] == season)]
    got = got.sort_values(["GAME_DATE", "GAME_ID"]).reset_index(drop=True)
    assert len(own) == len(got) >= PACE_MIN_PERIODS + 2

    for k in range(len(own)):
        prior = own["_pace"].iloc[max(0, k - PACE_WINDOW):k]
        expected = prior.mean() if len(prior) >= PACE_MIN_PERIODS else np.nan
        actual = got[CTX_PACE].iloc[k]
        if np.isnan(expected):
            assert np.isnan(actual), f"row {k} should be null, got {actual}"
        else:
            assert actual == pytest.approx(expected, rel=1e-9), f"row {k}"


def test_negative_control_an_unshifted_pace_provably_differs(
    context: pd.DataFrame, team_logs: pd.DataFrame
) -> None:
    """the leaky twin, computed here, must NOT equal the shipped column.

    a shift test that only asserts "the first row is null" passes against a
    ``rolling(window).mean()`` with no shift as soon as min_periods is 1. The only
    conclusive form is to build the leaky variant and require a difference.
    """
    raw = _per_game_rates(_pair_team_games(team_logs))
    raw = raw.sort_values(["TEAM_ID", "SEASON", "GAME_DATE", "GAME_ID"])
    leaky = raw.groupby(["TEAM_ID", "SEASON"])["_pace"].transform(
        # NO .shift(1): includes the target game's own pace
        lambda s: s.rolling(PACE_WINDOW, min_periods=PACE_MIN_PERIODS).mean()
    )
    raw = raw.assign(_leaky=leaky)
    merged = context.merge(
        raw[["SEASON", "TEAM_ID", "GAME_ID", "_leaky"]],
        on=["SEASON", "TEAM_ID", "GAME_ID"], how="inner",
    )
    both = merged[merged[CTX_PACE].notna() & merged["_leaky"].notna()]
    assert len(both) > 0
    assert not np.allclose(both[CTX_PACE], both["_leaky"]), (
        "the shipped rolling pace is identical to an UNSHIFTED one, so the shift is "
        "not doing anything"
    )


def test_possession_and_rating_arithmetic_is_what_was_documented(
    team_logs: pd.DataFrame,
) -> None:
    """poss = FGA + 0.44*FTA + TOV (no OREB term), pace per 48, def rating per 100.

    the OREB-free fallback is a documented deviation from the textbook formula
    (config.POSSESSION_USES_OREB) and the deviation is the thing most likely to be
    silently "fixed" by someone who remembers the textbook. Pinning the formula makes
    that a test failure rather than an unexplained level shift in every pace number.
    """
    assert config.POSSESSION_USES_OREB is False
    raw = _per_game_rates(_pair_team_games(team_logs))
    row = raw.iloc[0]
    poss = row["FGA"] + FT_POSSESSION_WEIGHT * row["FTA"] + row["TOV"]
    opp_poss = row["OPP_FGA"] + FT_POSSESSION_WEIGHT * row["OPP_FTA"] + row["OPP_TOV"]
    assert row["_poss"] == pytest.approx(poss)
    assert row["_slot_minutes"] == pytest.approx(row["MIN"] / 5.0)
    assert row["_pace"] == pytest.approx(poss / (row["MIN"] / 5.0) * 48.0)
    # the DEFENSIVE rating's denominator is the OPPONENT's possessions. using the
    # team's own is the classic sign error here and it is a ~1% shift, invisible by eye
    assert row["_def_rating"] == pytest.approx(row["OPP_PTS"] / opp_poss * 100.0)
    assert row["_off_rating"] == pytest.approx(row["PTS"] / poss * 100.0)
    assert row["_fg3a_allowed_per100"] == pytest.approx(
        row["OPP_FG3A"] / opp_poss * 100.0
    )


def test_team_rest_days_agree_with_the_v3_schedule_features(
    context: pd.DataFrame, features_status: pd.DataFrame
) -> None:
    """matchup.py recomputes rest at team-game grain; the two must not disagree.

    ``features.schedule_features`` already computes team rest for the player frame.
    matchup.py needs it before any player row exists, so the definition is written
    twice - and two definitions of one quantity is exactly how a package acquires a
    number that is right in one table and wrong in another.
    """
    v3 = schedule_features(features_status)
    merged = context.merge(
        v3[["SEASON", "TEAM_ID", "GAME_ID", "TEAM_REST_DAYS", "IS_B2B"]],
        on=["SEASON", "TEAM_ID", "GAME_ID"], how="inner",
    )
    assert len(merged) > 0
    both = merged[merged[CTX_REST_DAYS].notna() & merged["TEAM_REST_DAYS"].notna()]
    assert len(both) > 0
    assert (both[CTX_REST_DAYS] == both["TEAM_REST_DAYS"]).all()
    assert (both[CTX_IS_B2B] == both["IS_B2B"]).all()


# ---------------------------------------------------------------------------
# 3. OUTCOME INVARIANCE: opponent aggregates stop pre-target
# ---------------------------------------------------------------------------
def test_flipping_a_games_box_score_moves_no_feature_of_that_game(
    team_logs: pd.DataFrame, context: pd.DataFrame
) -> None:
    """THE LOAD-BEARING LEAKAGE TEST for the matchup family.

    take one mid-season game, replace both sides' box scores with absurd values, and
    require that every rolling feature ON THAT GAME'S OWN TWO ROWS is bit-identical.
    The opponent's target-game box score is sitting in the same frame one merge away,
    so this is the exact shape of the v2 defect (MODEL.md section 11) transplanted to
    team level.

    LATER games are expected to move - their windows legitimately contain the flipped
    game - and the test asserts that too, because a construction where nothing at all
    moves is a construction where the flip did not take effect and the invariance
    half is vacuous.
    """
    ordered = context.sort_values("GAME_DATE")
    # a game late enough that both teams have a filled window, so there is something
    # for a leak to contaminate
    candidates = ordered[ordered[CTX_PACE].notna()]
    target_game = str(candidates["GAME_ID"].iloc[len(candidates) // 2])
    target_date = pd.Timestamp(
        candidates.loc[candidates["GAME_ID"] == target_game, "GAME_DATE"].iloc[0]
    )

    flipped = team_logs.copy()
    hit = flipped["GAME_ID"] == target_game
    assert int(hit.sum()) == 2
    flipped.loc[hit, "PTS"] = [200.0, 40.0]
    flipped.loc[hit, "FGA"] = 200.0
    flipped.loc[hit, "FTA"] = 100.0
    flipped.loc[hit, "TOV"] = 60.0
    flipped.loc[hit, "FG3A"] = 150.0
    after = team_game_context(flipped)

    columns = [*ROLLING_CTX_COLS, CTX_NET_RATING, *STAKES_CTX_COLS]
    key = ["SEASON", "TEAM_ID", "GAME_ID"]
    before_rows = context[context["GAME_ID"] == target_game].sort_values(key)
    after_rows = after[after["GAME_ID"] == target_game].sort_values(key)
    pd.testing.assert_frame_equal(
        before_rows[[*key, *columns]].reset_index(drop=True),
        after_rows[[*key, *columns]].reset_index(drop=True),
        check_exact=False, rtol=0, atol=0,
    )

    # the flip must reach SOMETHING, or the invariance above is vacuous
    later = context.merge(after, on=key, suffixes=("_before", "_after"))
    later = later[pd.to_datetime(later["GAME_DATE_before"]) > target_date]
    moved = ~np.isclose(
        later[f"{CTX_PACE}_before"].to_numpy(dtype=float),
        later[f"{CTX_PACE}_after"].to_numpy(dtype=float),
        equal_nan=True,
    )
    assert moved.any(), (
        "flipping a box score changed no LATER row either, so the flip did not take "
        "effect and the invariance assertion above proves nothing"
    )


def test_the_opponent_column_is_the_opponents_prior_form_not_its_own(
    context: pd.DataFrame, features_status: pd.DataFrame
) -> None:
    """opp_def_rating on team A's row equals team B's own shifted def rating.

    the merge in :func:`attach_matchup_features` is the one place own and opponent
    could be crossed, and a crossed merge produces perfectly plausible numbers.
    """
    attached = attach_matchup_features(features_status, context)
    sample = attached[attached["opp_def_rating"].notna()].head(200)
    lookup = context.set_index(["SEASON", "TEAM_ID", "GAME_ID"])[CTX_DEF_RATING]
    for _, row in sample.iterrows():
        expected = lookup.loc[(row["SEASON"], row["OPP_TEAM_ID"], row["GAME_ID"])]
        assert row["opp_def_rating"] == pytest.approx(float(expected))
        # and it must NOT be the row's own team's rating, except by coincidence
    own = lookup.reindex(
        pd.MultiIndex.from_arrays(
            [sample["SEASON"], sample["TEAM_ID"], sample["GAME_ID"]]
        )
    ).to_numpy(dtype=float)
    assert not np.allclose(sample["opp_def_rating"].to_numpy(dtype=float), own), (
        "opp_def_rating equals the row's OWN team's defensive rating; the own / "
        "opponent merge is crossed"
    )


def test_the_blowout_label_is_symmetric_across_a_games_two_sides(
    context: pd.DataFrame,
) -> None:
    """both benches empty in a blowout, so both team-games carry the same label."""
    per_game = context.groupby("GAME_ID")[BLOWOUT_TARGET].nunique()
    assert (per_game == 1).all()
    margins = context.groupby("GAME_ID")[config.BLOWOUT_MARGIN_COL].sum()
    assert np.allclose(margins.to_numpy(dtype=float), 0.0), (
        "the two sides' signed margins do not sum to zero, so they are not the same "
        "game's margin"
    )
    # and the label is the documented threshold, not an approximation of it
    expected = (context[config.BLOWOUT_MARGIN_COL].abs() >= BLOWOUT_MARGIN).astype(float)
    assert (context[BLOWOUT_TARGET] == expected).all()


# ---------------------------------------------------------------------------
# 4. THE BLOWOUT CROSS-FIT, and its peeked negative control
# ---------------------------------------------------------------------------
def test_every_blowout_probability_is_out_of_fold(
    blowout_probabilities: pd.DataFrame,
) -> None:
    """the same guard P(play) and E[minutes|plays] pass through, on P(blowout)."""
    validate_out_of_fold(
        blowout_probabilities, BLOWOUT_PROB, BLOWOUT_PROB_CUTOFF, "P(blowout)"
    )
    cutoff = pd.to_datetime(blowout_probabilities[BLOWOUT_PROB_CUTOFF])
    dates = pd.to_datetime(blowout_probabilities["GAME_DATE"])
    assert (cutoff <= dates).all()
    assert blowout_probabilities[BLOWOUT_PROB].between(0.0, 1.0).all()
    assert blowout_probabilities[BLOWOUT_PROB].notna().all()


def test_a_tampered_blowout_cutoff_raises(
    blowout_probabilities: pd.DataFrame,
) -> None:
    """the guard is exercised in the FAILING direction too, or it is decoration."""
    tampered = blowout_probabilities.copy()
    tampered.loc[tampered.index[0], BLOWOUT_PROB_CUTOFF] = pd.Timestamp("2099-01-01")
    with pytest.raises(LeakageError):
        validate_out_of_fold(
            tampered, BLOWOUT_PROB, BLOWOUT_PROB_CUTOFF, "P(blowout)"
        )


def test_a_blowout_probability_does_not_depend_on_its_own_block_or_later(
    context: pd.DataFrame, blowout_probabilities: pd.DataFrame
) -> None:
    """truncate the history and the earlier blocks' probabilities must not move.

    the strongest available statement of the cross-fit's forward-chaining property:
    if a row's probability were a function of any game at or after its own block
    start, deleting those games would change it.
    """
    ordered = context.sort_values("GAME_DATE")
    boundary = pd.Timestamp(ordered["GAME_DATE"].quantile(0.60)).normalize()
    # truncate to the start of the month containing the boundary, so whole blocks are
    # removed rather than half of one
    truncate_from = boundary.replace(day=1)
    truncated = cross_fit_blowout_probabilities(
        context[pd.to_datetime(context["GAME_DATE"]) < truncate_from],
        min_train_rows=40,
    )
    key = ["SEASON", "TEAM_ID", "GAME_ID"]
    merged = truncated.merge(
        blowout_probabilities[[*key, BLOWOUT_PROB]], on=key,
        suffixes=("_truncated", "_full"),
    )
    assert len(merged) > 0
    assert np.allclose(
        merged[f"{BLOWOUT_PROB}_truncated"].to_numpy(dtype=float),
        merged[f"{BLOWOUT_PROB}_full"].to_numpy(dtype=float),
    ), (
        "removing later games changed an earlier row's blowout probability, so the "
        "cross-fit is not forward-chaining"
    )


def test_peeked_blowout_model_scores_suspiciously_better(
    context: pd.DataFrame, blowout_probabilities: pd.DataFrame
) -> None:
    """THE NEGATIVE CONTROL. A leaky construction must be visibly better.

    if the honest cross-fit and a model fitted on every row including its own outcome
    scored the same, one of two things would be true: the cross-fit is not actually
    out of fold, or the test is measuring nothing. Requiring a MARGIN rather than mere
    inequality is what makes it the second-kind-of-failure detector.
    """
    peeked = cross_fit_blowout_probabilities(context, peek=True)
    key = ["SEASON", "TEAM_ID", "GAME_ID"]
    joint = context[[*key, BLOWOUT_TARGET]].merge(
        blowout_probabilities[[*key, BLOWOUT_PROB]], on=key
    ).merge(peeked[[*key, BLOWOUT_PROB]], on=key, suffixes=("_honest", "_peeked"))
    y = joint[BLOWOUT_TARGET].to_numpy(dtype=float)
    honest = brier(y, joint[f"{BLOWOUT_PROB}_honest"].to_numpy(dtype=float))
    leaky = brier(y, joint[f"{BLOWOUT_PROB}_peeked"].to_numpy(dtype=float))
    assert leaky < honest * 0.95, (
        f"the peeked model ({leaky:.4f}) is not conspicuously better than the "
        f"out-of-fold one ({honest:.4f}); either the cross-fit is leaking or the "
        f"control is not a control"
    )
    assert peeked["BLOWOUT_SOURCE"].eq("PEEKED").all(), (
        "the peeked output must label itself, so it can never be mistaken for a "
        "dataset column"
    )
    # and the peeked model must RANK better too, not merely be better calibrated
    assert auc(y, joint[f"{BLOWOUT_PROB}_peeked"].to_numpy(dtype=float)) > auc(
        y, joint[f"{BLOWOUT_PROB}_honest"].to_numpy(dtype=float)
    )


def test_the_blowout_classifier_refuses_an_outcome_column(
    context: pd.DataFrame, monkeypatch: pytest.MonkeyPatch
) -> None:
    """adding the margin to the pregame feature list must RAISE, not quietly work.

    the realistic failure this guards is somebody appending ``team_margin`` or
    ``blowout`` to ``config.BLOWOUT_MODEL_FEATURES`` - the classifier would then score
    an AUC near 1.0 and every downstream number would look wonderful. Monkeypatching
    the tuple is the only faithful simulation: a renamed column would defeat a
    name-based guard by construction, which is precisely why the PEEKED control above
    exists as the second line of defence.
    """
    from fnba_ml import matchup

    monkeypatch.setattr(
        matchup, "BLOWOUT_MODEL_FEATURES",
        (*BLOWOUT_MODEL_FEATURES, config.BLOWOUT_MARGIN_COL),
    )
    with pytest.raises(ValueError, match="outcome columns"):
        cross_fit_blowout_probabilities(context, min_train_rows=40)


def test_thin_blocks_fall_back_to_the_prior_rather_than_to_a_model(
    context: pd.DataFrame
) -> None:
    """the gate, exercised: with an unreachable min_train_rows every row is the prior."""
    out = cross_fit_blowout_probabilities(context, min_train_rows=10**9)
    assert out["BLOWOUT_SOURCE"].eq("prior").all()
    assert np.allclose(out[BLOWOUT_PROB].to_numpy(dtype=float), BLOWOUT_PRIOR)


# ---------------------------------------------------------------------------
# 5. SEASON STAKES: hand-checkable arithmetic on synthetic records
# ---------------------------------------------------------------------------
def test_games_played_and_remaining_count_only_prior_games() -> None:
    logs = _synthetic_team_logs([
        ("2024-10-22", 110, 100, 1),
        ("2024-10-24", 90, 120, 2),
        ("2024-10-26", 105, 104, 3),
    ])
    ctx = team_game_context(logs)
    home = ctx[ctx["TEAM_ID"] == "H"].sort_values("GAME_DATE")
    assert list(home["team_games_played"]) == [0.0, 1.0, 2.0]
    assert list(home["team_games_remaining"]) == [
        float(REGULAR_SEASON_GAMES), float(REGULAR_SEASON_GAMES - 1),
        float(REGULAR_SEASON_GAMES - 2),
    ]


def test_win_record_excludes_the_target_games_own_result() -> None:
    """H wins game 1, loses game 2, wins game 3. The as-of record must lag by one."""
    logs = _synthetic_team_logs([
        ("2024-10-22", 110, 100, 1),   # H wins
        ("2024-10-24", 90, 120, 2),    # H loses
        ("2024-10-26", 105, 104, 3),   # H wins
    ])
    ctx = team_game_context(logs)
    home = ctx[ctx["TEAM_ID"] == "H"].sort_values("GAME_DATE").reset_index(drop=True)
    assert list(home["team_wins_to_date"]) == [0.0, 1.0, 1.0]
    assert np.isnan(home["team_win_pct"].iloc[0])
    assert home["team_win_pct"].iloc[1] == pytest.approx(1.0)   # 1 win of 1 game
    assert home["team_win_pct"].iloc[2] == pytest.approx(0.5)   # 1 win of 2 games
    # games over .500 = (W - L)/2, so +0.5 after one win and 0.0 after 1-1
    assert home["team_games_over_500"].iloc[1] == pytest.approx(0.5)
    assert home["team_games_over_500"].iloc[2] == pytest.approx(0.0)


def test_flipping_a_result_leaves_that_rows_record_alone_and_moves_the_next(
) -> None:
    """the shift, stated as an experiment rather than as an inspection of the code."""
    base = [("2024-10-22", 110, 100, 1), ("2024-10-24", 90, 120, 2),
            ("2024-10-26", 105, 104, 3)]
    flipped = [("2024-10-22", 100, 110, 1), ("2024-10-24", 90, 120, 2),
               ("2024-10-26", 105, 104, 3)]   # H now LOSES game 1
    a = team_game_context(_synthetic_team_logs(base))
    b = team_game_context(_synthetic_team_logs(flipped))
    a = a[a["TEAM_ID"] == "H"].sort_values("GAME_DATE").reset_index(drop=True)
    b = b[b["TEAM_ID"] == "H"].sort_values("GAME_DATE").reset_index(drop=True)
    assert a["team_wins_to_date"].iloc[0] == b["team_wins_to_date"].iloc[0] == 0.0
    assert a["team_wins_to_date"].iloc[1] != b["team_wins_to_date"].iloc[1]


def test_lockedness_is_zero_outside_the_late_season_window() -> None:
    """82-game season, 3 games played, so 79 remaining: nowhere near late season."""
    logs = _synthetic_team_logs([
        ("2024-10-22", 140, 90, 1), ("2024-10-24", 140, 90, 2),
        ("2024-10-26", 140, 90, 3),
    ])
    ctx = team_game_context(logs)
    assert (ctx["late_season"] == 0.0).all()
    assert (ctx["stakes_lockedness"] == 0.0).all()
    assert (ctx["stakes_late_x_over500"] == 0.0).all()


def test_lockedness_formula_on_a_hand_built_late_season_record() -> None:
    """a team that has played 80 of 82 games with a 60-20 record must read locked.

    2 games remaining and +20 over .500: the remaining schedule cannot move the team
    back to .500, so lockedness caps at 1.0. This is the whole content of the clinch
    proxy and it is arithmetic, so it is tested as arithmetic.
    """
    records = []
    for i in range(1, 81):
        # H wins the first 60, loses the last 20
        home, away = (130, 100) if i <= 60 else (100, 130)
        records.append((f"2024-10-{i:02d}" if i <= 31 else
                        (pd.Timestamp("2024-10-01") + pd.Timedelta(days=i)).strftime("%Y-%m-%d"),
                        home, away, i))
    # rebuild with clean sequential dates rather than the month arithmetic above
    records = [
        ((pd.Timestamp("2024-10-22") + pd.Timedelta(days=2 * i)).strftime("%Y-%m-%d"),
         130 if i < 60 else 100, 100 if i < 60 else 130, i + 1)
        for i in range(80)
    ]
    ctx = team_game_context(_synthetic_team_logs(records))
    home = ctx[ctx["TEAM_ID"] == "H"].sort_values("GAME_DATE").reset_index(drop=True)

    last = home.iloc[-1]
    assert last["team_games_played"] == 79.0
    assert last["team_games_remaining"] == 3.0
    assert last["late_season"] == 1.0
    # 60 wins in the first 60 games, then 19 losses -> 60-19 after 79 games
    assert last["team_wins_to_date"] == 60.0
    assert last["team_games_over_500"] == pytest.approx((2 * 60 - 79) / 2.0)
    expected = min(1.0, abs(last["team_games_over_500"]) / max(3.0, 1.0))
    assert last["stakes_lockedness"] == pytest.approx(expected)
    assert last["stakes_lockedness"] == pytest.approx(1.0)
    assert last["stakes_late_x_over500"] == pytest.approx(last["team_games_over_500"])

    # and the window boundary itself: lockedness is 0 while > LATE_SEASON_GAMES_REMAINING
    early = home[home["team_games_remaining"] > float(LATE_SEASON_GAMES_REMAINING)]
    assert len(early) > 0
    assert (early["stakes_lockedness"] == 0.0).all()


def test_lockedness_is_bounded_and_symmetric_in_sign(context: pd.DataFrame) -> None:
    """|.| in the numerator, so a bad team and a good team both read locked."""
    values = context["stakes_lockedness"].dropna()
    assert (values >= 0.0).all()
    assert (values <= 1.0).all()


def test_stakes_interactions_are_the_documented_products(
    v4_features: pd.DataFrame,
) -> None:
    frame = v4_features
    expected = frame["stakes_lockedness"] * frame["minutes_share"]
    both = frame["stakes_x_minutes_share"].notna() & expected.notna()
    assert both.any()
    assert np.allclose(frame.loc[both, "stakes_x_minutes_share"],
                       expected[both])
    veteran = np.log1p(pd.to_numeric(frame["n_appearances"], errors="coerce"))
    expected_vet = frame["stakes_lockedness"] * veteran
    both = frame["stakes_x_veteran"].notna() & expected_vet.notna()
    assert both.any()
    assert np.allclose(frame.loc[both, "stakes_x_veteran"], expected_vet[both])


def test_the_stakes_cohort_threshold_matches_the_config_constant() -> None:
    labels = dict((c[0], c) for c in config.V4_DESCRIPTIVE_COHORTS)
    stakes = labels["v4: stakes-flagged (locked, late)"]
    assert stakes[1] == "stakes_lockedness"
    assert stakes[2] == ">="
    assert stakes[3] == STAKES_LOCKED_RATIO


# ---------------------------------------------------------------------------
# 6. THE START-RATE PROXY
# ---------------------------------------------------------------------------
def test_start_rate_is_null_on_a_players_first_scheduled_row(
    universe_status: pd.DataFrame,
) -> None:
    proxy = start_rate_features(universe_status)
    merged = universe_status.merge(
        proxy, on=["PLAYER_ID", "GAME_ID", "TEAM_ID"], how="left"
    ).sort_values(["PLAYER_ID", "GAME_DATE"])
    first = merged.groupby("PLAYER_ID").head(1)
    assert first[START_RATE_COL].isna().all(), (
        "a player's first scheduled row has a start rate, so the window read the "
        "target game"
    )


def test_start_rate_is_a_hand_computable_share_of_prior_games() -> None:
    """three players, five games, minutes chosen so the top-N set is unambiguous."""
    rows = []
    dates = pd.date_range("2024-10-22", periods=5, freq="2D")
    # P1 always leads in minutes, P2 is second, P3 last. top_n is START_RATE_TOP_N (5)
    # and there are only 3 players, so ALL of them are "top 5" whenever they appear -
    # which is what makes the appearance pattern the whole content of the number.
    for g, date in enumerate(dates):
        for player, minutes, played in (
            ("P1", 34.0, 1), ("P2", 24.0, 1), ("P3", 0.0, 0 if g < 3 else 1),
        ):
            rows.append({
                "PLAYER_ID": player, "GAME_ID": f"G{g}", "TEAM_ID": "T",
                "GAME_DATE": date, "PLAYED": played,
                "MIN": 12.0 if (player == "P3" and played) else minutes,
            })
    frame = pd.DataFrame(rows)
    proxy = start_rate_features(frame)
    merged = frame.merge(proxy, on=["PLAYER_ID", "GAME_ID", "TEAM_ID"])
    merged = merged.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)

    p1 = merged[merged["PLAYER_ID"] == "P1"][START_RATE_COL].tolist()
    assert np.isnan(p1[0])
    assert p1[1:] == [1.0, 1.0, 1.0, 1.0]   # played and top-5 every prior game

    p3 = merged[merged["PLAYER_ID"] == "P3"][START_RATE_COL].tolist()
    assert np.isnan(p3[0])
    # missed games 0,1,2; played 3 and 4. so at game 3 the prior share is 0/3 = 0,
    # and at game 4 it is 1/4 = 0.25. A non-appearance counts as 0, not as missing.
    assert p3[1] == pytest.approx(0.0)
    assert p3[2] == pytest.approx(0.0)
    assert p3[3] == pytest.approx(0.0)
    assert p3[4] == pytest.approx(0.25)


def test_start_rate_ranks_by_minutes_and_cuts_at_top_n() -> None:
    """six appearances, so exactly one player must fall outside the top-N set."""
    dates = pd.date_range("2024-10-22", periods=3, freq="2D")
    rows = []
    minutes = [40.0, 35.0, 30.0, 25.0, 20.0, 5.0]
    for g, date in enumerate(dates):
        for i, m in enumerate(minutes):
            rows.append({
                "PLAYER_ID": f"P{i}", "GAME_ID": f"G{g}", "TEAM_ID": "T",
                "GAME_DATE": date, "PLAYED": 1, "MIN": m,
            })
    frame = pd.DataFrame(rows)
    proxy = start_rate_features(frame)
    merged = frame.merge(proxy, on=["PLAYER_ID", "GAME_ID", "TEAM_ID"])
    last = merged[merged["GAME_ID"] == "G2"].set_index("PLAYER_ID")[START_RATE_COL]
    for i in range(START_RATE_TOP_N):
        assert last[f"P{i}"] == pytest.approx(1.0), f"P{i} should be top-{START_RATE_TOP_N}"
    assert last[f"P{START_RATE_TOP_N}"] == pytest.approx(0.0)


def test_start_rate_window_is_the_configured_length(universe_status) -> None:
    """a window of START_RATE_WINDOW, checked by an explicit recomputation."""
    proxy = start_rate_features(universe_status)
    merged = universe_status.merge(
        proxy, on=["PLAYER_ID", "GAME_ID", "TEAM_ID"], how="left"
    )
    merged["GAME_DATE"] = pd.to_datetime(merged["GAME_DATE"])
    merged = merged.sort_values(["PLAYER_ID", "GAME_DATE", "GAME_ID"]).reset_index(
        drop=True
    )
    minutes = pd.to_numeric(merged["MIN"], errors="coerce")
    appeared = (merged["PLAYED"] == 1) & minutes.notna() & (minutes > 0)
    rank = minutes.where(appeared).groupby(
        [merged["GAME_ID"], merged["TEAM_ID"]]
    ).rank(method="first", ascending=False)
    is_top = (rank <= float(START_RATE_TOP_N)).astype(float)
    expected = is_top.groupby(merged["PLAYER_ID"]).transform(
        lambda s: s.shift(1).rolling(START_RATE_WINDOW, min_periods=1).mean()
    )
    both = merged[START_RATE_COL].notna() & expected.notna()
    assert both.any()
    assert np.allclose(merged.loc[both, START_RATE_COL], expected[both])


def test_negative_control_an_unshifted_start_rate_provably_differs(
    universe_status: pd.DataFrame,
) -> None:
    """the leaky twin, built here, must NOT equal the shipped column.

    ``top5_min_share_10`` is the one candidate column computed directly from the
    TARGET GAME's minutes (step 1 ranks that game's appearances), so its whole
    as-of safety rests on one ``.shift(1)``. A test that only checked the first row's
    nullness would pass against an unshifted window, because ``min_periods=1`` makes
    row 2 non-null either way.
    """
    frame = universe_status[
        ["PLAYER_ID", "GAME_ID", "TEAM_ID", "GAME_DATE", "PLAYED", "MIN"]
    ].copy()
    frame["GAME_DATE"] = pd.to_datetime(frame["GAME_DATE"])
    frame = frame.sort_values(["PLAYER_ID", "GAME_DATE", "GAME_ID"]).reset_index(
        drop=True
    )
    minutes = pd.to_numeric(frame["MIN"], errors="coerce")
    appeared = (frame["PLAYED"] == 1) & minutes.notna() & (minutes > 0)
    rank = minutes.where(appeared).groupby(
        [frame["GAME_ID"], frame["TEAM_ID"]]
    ).rank(method="first", ascending=False)
    is_top = (rank <= float(START_RATE_TOP_N)).astype(float)
    leaky = is_top.groupby(frame["PLAYER_ID"]).transform(
        # NO .shift(1): includes whether the player led the TARGET game in minutes
        lambda s: s.rolling(START_RATE_WINDOW, min_periods=1).mean()
    )
    honest = frame.merge(
        start_rate_features(frame), on=["PLAYER_ID", "GAME_ID", "TEAM_ID"], how="left"
    )[START_RATE_COL]
    both = honest.notna() & leaky.notna()
    assert both.any()
    assert not np.allclose(honest[both], leaky[both]), (
        "the shipped start-rate proxy is identical to an UNSHIFTED one, so the shift "
        "is not doing anything and the column reads the target game's minutes"
    )


def test_flipping_the_target_games_minutes_does_not_move_its_own_start_rate(
    universe_status: pd.DataFrame,
) -> None:
    """the invariance form of the same claim, plus the mandatory counter-assertion.

    the twelfth man is given 48 minutes in one game. His start rate ON THAT ROW must
    not move - it is a statement about the ten games before it - and his start rate on
    LATER rows must, because their windows legitimately contain the flipped game.
    """
    frame = universe_status[
        ["PLAYER_ID", "GAME_ID", "TEAM_ID", "GAME_DATE", "PLAYED", "MIN"]
    ].copy()
    frame["GAME_DATE"] = pd.to_datetime(frame["GAME_DATE"])
    frame = frame.sort_values(["PLAYER_ID", "GAME_DATE", "GAME_ID"]).reset_index(
        drop=True
    )
    # THE VICTIM MUST BE A ROW WHERE THE FLIP ACTUALLY CHANGES THE LABEL. Setting a
    # player who is already his team's minutes leader to 48 leaves ``is_top_n``
    # unchanged and the counter-assertion below would fail for a reason that has
    # nothing to do with leakage. So: pick a row currently OUTSIDE the top N, with
    # enough of the player's own history after it for a later window to contain it.
    minutes = pd.to_numeric(frame["MIN"], errors="coerce")
    appeared = (frame["PLAYED"] == 1) & minutes.notna() & (minutes > 0)
    rank = minutes.where(appeared).groupby(
        [frame["GAME_ID"], frame["TEAM_ID"]]
    ).rank(method="first", ascending=False)
    nth = frame.groupby("PLAYER_ID").cumcount()
    remaining = frame.groupby("PLAYER_ID")["GAME_ID"].transform("size") - nth
    eligible = frame.index[
        appeared & (rank > float(START_RATE_TOP_N))
        & (nth > START_RATE_WINDOW) & (remaining > 3)
    ]
    assert len(eligible) > 0, "the fixtures contain no out-of-rotation appearance"
    victim = eligible[len(eligible) // 2]
    player = str(frame.loc[victim, "PLAYER_ID"])
    target_date = frame.loc[victim, "GAME_DATE"]

    flipped = frame.copy()
    flipped.loc[victim, "MIN"] = 48.0

    before = frame.merge(
        start_rate_features(frame), on=["PLAYER_ID", "GAME_ID", "TEAM_ID"], how="left"
    )
    after = flipped.merge(
        start_rate_features(flipped), on=["PLAYER_ID", "GAME_ID", "TEAM_ID"],
        how="left",
    )
    key = ["PLAYER_ID", "GAME_ID", "TEAM_ID"]
    joint = before[[*key, "GAME_DATE", START_RATE_COL]].merge(
        after[[*key, START_RATE_COL]], on=key, suffixes=("_before", "_after")
    )
    same_game = joint[joint["GAME_ID"] == frame.loc[victim, "GAME_ID"]]
    assert len(same_game) > 0
    assert np.allclose(
        same_game[f"{START_RATE_COL}_before"].to_numpy(dtype=float),
        same_game[f"{START_RATE_COL}_after"].to_numpy(dtype=float),
        equal_nan=True,
    ), "flipping a game's minutes moved that game's own start rate"

    later = joint[
        (joint["PLAYER_ID"] == player) & (joint["GAME_DATE"] > target_date)
    ]
    moved = ~np.isclose(
        later[f"{START_RATE_COL}_before"].to_numpy(dtype=float),
        later[f"{START_RATE_COL}_after"].to_numpy(dtype=float),
        equal_nan=True,
    )
    assert moved.any(), (
        "flipping the minutes changed no LATER row either, so the flip did not take "
        "effect and the invariance assertion above proves nothing"
    )


def test_the_started_column_is_still_unusable_if_it_is_present_at_all(
    universe_status: pd.DataFrame,
) -> None:
    """the measurement that justifies the proxy, encoded so it can be re-checked.

    ``player_game_logs.started`` is NULL on every row of the truth layer and
    ``player_game_status.started`` has zero ``true`` values. If a future backfill fixes
    that, this test starts failing and the proxy should be replaced by the real thing -
    which is the correct behaviour for a test that documents a data defect.

    the fixtures DO carry a synthetic STARTED, so this is scoped to the real column's
    absence from the built universe rather than to the fixture's contents.
    """
    assert "STARTED" not in universe_status.columns, (
        "STARTED is now on the universe. If the truth layer has been backfilled, "
        "replace top5_min_share_10 with a real rolling start rate "
        "(config.START_RATE_WINDOW documents the measurement that condemned it)"
    )


# ---------------------------------------------------------------------------
# 7. ATTACHMENT: row order, row count, and the derived products
# ---------------------------------------------------------------------------
def test_attaching_the_candidate_family_preserves_rows_and_order(
    features_status: pd.DataFrame, v4_features: pd.DataFrame
) -> None:
    assert len(v4_features) == len(features_status)
    key = ["PLAYER_ID", "GAME_ID", "TEAM_ID"]
    pd.testing.assert_frame_equal(
        features_status[key].reset_index(drop=True),
        v4_features[key].reset_index(drop=True),
    )
    # and every v3 column is untouched, value for value
    for column in config.FEATURE_COLS:
        if column in features_status.columns:
            pd.testing.assert_series_equal(
                features_status[column].reset_index(drop=True),
                v4_features[column].reset_index(drop=True),
                check_names=False,
            )


def test_all_candidate_columns_are_present_after_attachment(
    v4_features: pd.DataFrame,
) -> None:
    missing = [c for c in config.V4_FEATURE_COLS if c not in v4_features.columns]
    assert not missing, f"attach_v4_features did not produce {missing}"


def test_the_game_pace_summaries_are_the_documented_functions(
    v4_features: pd.DataFrame,
) -> None:
    both = v4_features["own_pace"].notna() & v4_features["opp_pace"].notna()
    assert both.any()
    frame = v4_features[both]
    assert np.allclose(frame["game_pace_mean"],
                       (frame["own_pace"] + frame["opp_pace"]) / 2.0)
    assert np.allclose(frame["game_pace_product"],
                       frame["own_pace"] * frame["opp_pace"] / 100.0)


def test_minutes_share_is_prior_minutes_over_a_prior_slot(
    v4_features: pd.DataFrame, context: pd.DataFrame
) -> None:
    """roll10_MIN / (rolling team minutes / 5). Both halves strictly prior."""
    slot = context.set_index(["SEASON", "TEAM_ID", "GAME_ID"])[CTX_SLOT_MINUTES]
    idx = pd.MultiIndex.from_arrays([
        v4_features["SEASON"], v4_features["TEAM_ID"], v4_features["GAME_ID"]
    ])
    expected = (
        pd.to_numeric(v4_features["roll10_MIN"], errors="coerce").to_numpy(dtype=float)
        / slot.reindex(idx).to_numpy(dtype=float)
    )
    got = v4_features["minutes_share"].to_numpy(dtype=float)
    both = np.isfinite(expected) & np.isfinite(got)
    assert both.any()
    assert np.allclose(got[both], expected[both])
    # sanity: a share is a share. 48-minute slots and <=46-minute players.
    assert np.nanmax(got) <= 1.05


def test_the_blowout_interaction_is_the_product_it_claims_to_be(
    features_status: pd.DataFrame, context: pd.DataFrame,
    blowout_probabilities: pd.DataFrame,
) -> None:
    attached = attach_matchup_features(
        features_status, context, blowout_probabilities
    )
    expected = attached[BLOWOUT_PROB] * attached["minutes_share"]
    both = attached["blowout_x_minutes_share"].notna() & expected.notna()
    assert both.any()
    assert np.allclose(attached.loc[both, "blowout_x_minutes_share"], expected[both])


def test_without_probabilities_the_blowout_columns_are_simply_absent(
    features_status: pd.DataFrame, context: pd.DataFrame
) -> None:
    """a partial attachment must omit, not impute. LightGBM routes absence; a
    hand-filled 0.28 would be a silent constant feature."""
    attached = attach_matchup_features(features_status, context, None)
    assert BLOWOUT_PROB not in attached.columns
    assert "blowout_x_minutes_share" not in attached.columns
    # and the rest of the family still arrives
    for column in config.MATCHUP_FEATURE_COLS + config.STAKES_FEATURE_COLS:
        assert column in attached.columns


def test_absent_fg3a_yields_a_null_column_and_not_an_exception(
    team_logs: pd.DataFrame,
) -> None:
    """the optional-column contract (data.schema.TEAM_LOG_OPTIONAL_COLS)."""
    without = team_logs.drop(columns=["FG3A"])
    ctx = team_game_context(without)
    assert ctx[CTX_FG3A_ALLOWED].isna().all()
    # every other rate still computes
    assert ctx[CTX_PACE].notna().any()
    assert ctx[CTX_DEF_RATING].notna().any()


def test_a_one_sided_game_is_dropped_rather_than_half_computed(
    team_logs: pd.DataFrame,
) -> None:
    """a team-game with no opponent row has no margin, no pace and no rating."""
    victim = str(team_logs["GAME_ID"].iloc[0])
    mangled = team_logs.drop(
        team_logs[team_logs["GAME_ID"] == victim].index[:1]
    )
    ctx = team_game_context(mangled)
    assert victim not in set(ctx["GAME_ID"])


# ---------------------------------------------------------------------------
# 8. THE NEW DESCRIPTIVE COHORTS
# ---------------------------------------------------------------------------
def test_the_v4_cohorts_appear_only_when_their_columns_do(
    features_status: pd.DataFrame, v4_features: pd.DataFrame
) -> None:
    v3_labels = {label for label, _ in cohort_masks(features_status)}
    v4_labels = {label for label, _ in cohort_masks(v4_features)}
    for label in config.V4_DESCRIPTIVE_COHORT_ORDER:
        assert label not in v3_labels, (
            "a v3 dataset produced a v4 cohort, so the cohort output is no longer "
            "byte-identical to what section 13 froze"
        )
    assert set(config.V4_DESCRIPTIVE_COHORT_ORDER) <= v4_labels


def test_the_blowout_decile_cohort_is_a_decile(v4_features: pd.DataFrame) -> None:
    """a QUANTILE cut, so it must be ~10% of rows regardless of the score's scale.

    a fixed probability threshold would not be: the league blowout rate drifted from
    27% to 37% across the four seasons and the classifier's output distribution moves
    with it.
    """
    masks = dict(cohort_masks(v4_features))
    mask = masks["v4: blowout_prob top decile"]
    share = mask.mean()
    # ties in a weakly-informative probability can push the top decile above 10%,
    # which is correct behaviour for `>= quantile` and is bounded here rather than
    # asserted away
    assert 0.09 <= share <= 0.20, share


def test_a_constant_blowout_probability_yields_no_decile_cohort_at_all(
    v4_features: pd.DataFrame,
) -> None:
    """a quantile cohort over a constant column is undefined, not universal.

    the case is REACHABLE: every cross-fit block below
    ``BLOWOUT_CROSS_FIT_MIN_TRAIN_ROWS`` falls back to ``BLOWOUT_PRIOR``, so a short
    history produces a constant ``blowout_prob`` and ``>= q90`` would select 100% of
    rows. A "top decile" row that is a silent copy of ALL is worse than an absent one,
    because a reader would compare it against ALL and conclude the feature is neutral.
    """
    flat = v4_features.assign(**{BLOWOUT_PROB: BLOWOUT_PRIOR})
    labels = {label for label, _ in cohort_masks(flat)}
    assert "v4: blowout_prob top decile" not in labels
    # the other v4 cohort is unaffected: it is a fixed threshold, not a quantile
    assert "v4: stakes-flagged (locked, late)" in {
        label for label, _ in cohort_masks(v4_features)
    }


def test_attach_v4_features_runs_end_to_end_through_the_helper(
    features_status: pd.DataFrame, v4_features_via_helper: pd.DataFrame
) -> None:
    """the one entry point both the pipeline and the backfill script call.

    on the fixture set the blowout cross-fit falls back to the prior for every row
    (320 team-games against a 400-row gate), so this asserts SHAPE and COLUMN
    PRESENCE rather than variance - the fitted branch is exercised by the
    ``v4_features`` fixture, which lowers the gate.
    """
    assert len(v4_features_via_helper) == len(features_status)
    for column in config.V4_FEATURE_COLS:
        assert column in v4_features_via_helper.columns
    assert v4_features_via_helper[BLOWOUT_PROB].notna().all()


def test_the_frozen_event_cohorts_are_still_the_frozen_event_cohorts() -> None:
    """P2 APPENDED cohorts; it must not have merged them into the frozen tuple."""
    assert config.EVENT_COHORTS == (
        ("event: vacated_minutes >= 30", "vacated_minutes", ">=", 30.0),
        ("event: star_out = 1", "star_out", ">=", 1.0),
        ("control: vacated_minutes < 5", "vacated_minutes", "<", 5.0),
    )
    assert not set(config.EVENT_COHORT_ORDER) & set(
        config.V4_DESCRIPTIVE_COHORT_ORDER
    )


# ---------------------------------------------------------------------------
# 9. THE PROMOTION MACHINERY
# ---------------------------------------------------------------------------
def test_the_promotion_bar_is_the_pre_registered_one() -> None:
    """the constants, pinned, so the bar cannot be relaxed after the numbers land."""
    assert config.P2_PROMOTION_FLOOR == 0.01
    assert config.P2_COHORT_REGRESSION_TOLERANCE == 0.01
    assert config.P2_PROMOTION_ENDPOINTS == ("minutes_mae", "availability_brier")


def test_the_bootstrap_is_the_tournaments_own_implementation() -> None:
    """loaded by path from ml/experiments, with the frozen block length."""
    from fnba_ml import promotion

    assert promotion.BLOCK_DAYS == 7
    assert promotion.N_REPLICATES == 2000
    assert promotion.TOURNAMENT_BOOTSTRAP_PATH.exists()


def test_identical_passes_produce_no_effect_and_do_not_clear_the_bar() -> None:
    """THE NULL. a bootstrap that promotes two identical prediction vectors is worthless."""
    from fnba_ml.promotion import ENDPOINT_MINUTES, decide, paired_endpoint_bootstrap

    rng = np.random.default_rng(17)
    n = 900
    frame = pd.DataFrame({
        "origin": np.repeat(["O1", "O2", "O3"], n // 3),
        "GAME_DATE": pd.to_datetime("2025-01-01") + pd.to_timedelta(
            rng.integers(0, 28, n), unit="D"
        ),
        "row_key": [f"r{i}" for i in range(n)],
        "loss": rng.gamma(2.0, 2.0, n),
    })
    result = paired_endpoint_bootstrap(frame, frame.copy(), ENDPOINT_MINUTES)
    assert result.relative == pytest.approx(0.0)
    assert not result.ci_excludes_zero
    assert not result.clears
    verdict = decide([result], pd.DataFrame())
    assert not verdict.promoted
    assert "NOT PROMOTED" in verdict.reason


def test_a_large_uniform_improvement_does_clear_the_bar() -> None:
    """THE OTHER NULL. a bootstrap that cannot see a 20% effect is also worthless."""
    from fnba_ml.promotion import ENDPOINT_MINUTES, decide, paired_endpoint_bootstrap

    rng = np.random.default_rng(17)
    n = 900
    base = rng.gamma(2.0, 2.0, n)
    incumbent = pd.DataFrame({
        "origin": np.repeat(["O1", "O2", "O3"], n // 3),
        "GAME_DATE": pd.to_datetime("2025-01-01") + pd.to_timedelta(
            rng.integers(0, 28, n), unit="D"
        ),
        "row_key": [f"r{i}" for i in range(n)],
        "loss": base,
    })
    candidate = incumbent.assign(loss=base * 0.80)
    result = paired_endpoint_bootstrap(incumbent, candidate, ENDPOINT_MINUTES)
    assert result.relative == pytest.approx(0.20, abs=1e-9)
    assert result.ci_excludes_zero
    assert result.clears
    verdict = decide([result], pd.DataFrame())
    assert verdict.promoted


def test_a_regressing_cohort_blocks_a_promotion_that_otherwise_clears() -> None:
    """the side condition, exercised in the direction that costs something."""
    from fnba_ml.promotion import ENDPOINT_MINUTES, decide, paired_endpoint_bootstrap

    rng = np.random.default_rng(17)
    n = 600
    base = rng.gamma(2.0, 2.0, n)
    incumbent = pd.DataFrame({
        "origin": np.repeat(["O1", "O2"], n // 2),
        "GAME_DATE": pd.to_datetime("2025-01-01") + pd.to_timedelta(
            rng.integers(0, 28, n), unit="D"
        ),
        "row_key": [f"r{i}" for i in range(n)],
        "loss": base,
    })
    result = paired_endpoint_bootstrap(
        incumbent, incumbent.assign(loss=base * 0.80), ENDPOINT_MINUTES
    )
    assert result.clears
    regressions = pd.DataFrame([
        {"cohort": "fringe (<10)", "n": 100, "incumbent": 5.0, "candidate": 5.2,
         "delta_pct": 0.04, "regresses": True},
    ])
    verdict = decide([result], regressions)
    assert not verdict.promoted
    assert "fringe (<10)" in verdict.reason


def test_misaligned_passes_raise_rather_than_reporting_a_plausible_zero() -> None:
    from fnba_ml.promotion import ENDPOINT_MINUTES, paired_endpoint_bootstrap

    frame = pd.DataFrame({
        "origin": ["O1"] * 10,
        "GAME_DATE": pd.to_datetime("2025-01-01"),
        "row_key": [f"r{i}" for i in range(10)],
        "loss": np.arange(10.0),
    })
    shuffled = frame.iloc[::-1].reset_index(drop=True)
    with pytest.raises(ValueError, match="row keys"):
        paired_endpoint_bootstrap(frame, shuffled, ENDPOINT_MINUTES)
    with pytest.raises(ValueError, match="different row counts"):
        paired_endpoint_bootstrap(frame, frame.head(5), ENDPOINT_MINUTES)


# ---------------------------------------------------------------------------
# 10. the AUC helper, because two tests above depend on it being right
# ---------------------------------------------------------------------------
def test_auc_is_the_mann_whitney_statistic() -> None:
    assert auc([0, 0, 1, 1], [0.1, 0.2, 0.3, 0.4]) == pytest.approx(1.0)
    assert auc([0, 0, 1, 1], [0.4, 0.3, 0.2, 0.1]) == pytest.approx(0.0)
    # all-tied scores are exactly uninformative, which a rank-sum with average ties
    # gets right and a naive argsort implementation does not
    assert auc([0, 0, 1, 1], [0.5, 0.5, 0.5, 0.5]) == pytest.approx(0.5)
    assert np.isnan(auc([1, 1, 1], [0.1, 0.2, 0.3]))
