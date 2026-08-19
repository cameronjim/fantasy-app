"""leakage tests for the v3 probabilistic teammate context.

WHAT THIS FILE EXISTS TO PROVE, and why ``test_teammates.py`` could not prove it.

The v2 tests pinned SELF-exclusion: flip player i's own ``PLAYED`` and player i's own
teammate-context features must not move. That property held, and it was the wrong
property. A v2 feature on player i is a function of player j's target-game ``PLAYED``
label for every teammate j, and no amount of self-exclusion closes a path whose
source is not the row's own label. The round-2 external review found exactly that, and
it was right: the v2 gains are a value-of-perfect-lineup-information result, not a
forecasting result.

So the property asserted here is strictly stronger:

    flip ANY player's realized outcome, holding every as-of input fixed,
    and NO served feature of ANY player may change.

and it is asserted in BOTH directions, which is the part that gives it teeth:

    it must PASS on the v3 served family (``exp_*``, ``p_star_out``, reliability),
    it must FAIL on the v2 oracle family (``vacated_*``, ``depth_rank_available*``).

A one-directional version would pass against an implementation that produced constant
columns. ``test_the_oracle_family_deliberately_fails_the_same_test`` is the pin that
makes the first direction mean something, and it is a test we WANT to keep failing the
invariance - if it ever starts passing, either the oracle columns stopped being an
oracle (so the bracket's upper bound is fiction) or someone quietly rewired them.

THE SECOND FAMILY OF TESTS is the closed form. Invariance says the features do not
read outcomes; sensitivity says they read the right thing in the right amount. Every
served column is a stated linear functional of p and m, so each one has an exact
expected delta under a change in p_j, and "changes in the right direction" is a much
weaker claim than "changes by exactly (1 - p) times the magnitude".

THE THIRD is the block permutation, and it is a harder null than the per-row
permutation ``evaluate.add_negative_control`` builds: every row still gets a real,
internally coherent team's context block, attached to the wrong game.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.config import (
    BASE_FEATURE_COLS,
    CONTEXT_P_PRIOR,
    FEATURE_COLS,
    MAGNITUDE_PRIORS,
    MAGNITUDE_SHRINK_K,
    MAGNITUDE_WINDOW,
    ORIGINS,
    P_CONTEXT,
    P_CONTEXT_CUTOFF,
    RELIABILITY_FEATURE_COLS,
    SERVED_FEATURE_SET,
    STAR_USAGE_MIN_APPEARANCES,
    TEAMMATE_EXPECTED_COLS,
    TEAMMATE_ORACLE_COLS,
    TOP_USAGE_N,
)
from fnba_ml.evaluate import (
    block_permute_context,
    degrade_absence_knowledge,
    single_feature_ablation,
)
from fnba_ml.features import attach_expected_context, stage0_context_probability
from fnba_ml.models import (
    LeakageError,
    MinutesModel,
    mae,
    cross_fit_base_probabilities,
    validate_out_of_fold,
)
from fnba_ml.teammates import (
    MAGNITUDE_ESS,
    TEAMMATE_ESS,
    expected_vacated_features,
    shrink,
    vacated_features,
)

RNG = np.random.default_rng(23)

SERVED_COLS = [*TEAMMATE_EXPECTED_COLS, TEAMMATE_ESS]
KEY = ["PLAYER_ID", "GAME_ID", "TEAM_ID"]


def _fixed_probability(frame: pd.DataFrame) -> np.ndarray:
    """a p vector that does not depend on any outcome, for the invariance tests.

    the stage-0 baseline reads ``avail_rate_10``, which is a SHIFTED function of
    PLAYED - so flipping an outcome would legitimately move it for later games and the
    invariance test would be asserting the wrong thing. Holding p fixed is what "all
    as-of inputs fixed" means: the test isolates the aggregation from the inputs, which
    is precisely where the v2 leak lived.
    """
    return stage0_context_probability(frame).to_numpy(dtype=float)


def _busy_team_game(frame: pd.DataFrame) -> tuple[str, str]:
    """a (GAME_ID, TEAM_ID) late enough to have history and with real absences."""
    absent = frame["PLAYED"] == 0
    counts = frame[absent].groupby(["GAME_ID", "TEAM_ID"]).size()
    late = frame[absent].groupby(["GAME_ID", "TEAM_ID"])["GAME_DATE"].max()
    both = pd.concat([counts.rename("n"), late.rename("date")], axis=1)
    both = both[both["n"] >= 2].sort_values("date")
    return both.index[-1]


# ---------------------------------------------------------------------------
# 1. teammate-outcome invariance, pinned in both directions
# ---------------------------------------------------------------------------
def test_flipping_a_teammates_realized_outcome_cannot_move_a_served_feature(
    features_status,
):
    """THE load-bearing test of the phase.

    take a real team-game, flip ONE player's ``PLAYED`` and ``LISTED_INACTIVE``, hold
    every as-of input (including p) fixed, and recompute the served family. Not one
    value on ANY row may move - not the flipped player's, not his teammates', not a
    stranger's on another team. The served columns are functions of p and m only, and
    neither of those is an outcome.
    """
    # arrange
    frame = features_status.reset_index(drop=True)
    p = _fixed_probability(frame)
    game_id, team_id = _busy_team_game(frame)
    team_game = (frame["GAME_ID"] == game_id) & (frame["TEAM_ID"] == team_id)
    candidates = frame[team_game & (frame["PLAYED"] == 1) & (frame["tm_MIN"] > 10)]
    assert len(candidates) > 0, "need an established teammate to flip"
    victim = candidates.sort_values("tm_MIN").iloc[-1]

    flipped = frame.copy()
    row = (
        (flipped["PLAYER_ID"] == victim["PLAYER_ID"])
        & (flipped["GAME_ID"] == game_id)
        & (flipped["TEAM_ID"] == team_id)
    )
    assert row.sum() == 1
    flipped.loc[row, "PLAYED"] = 0
    flipped.loc[row, "LISTED_INACTIVE"] = True
    flipped.loc[row, "MIN"] = 0.0
    flipped.loc[row, "PTS"] = 0.0

    # act
    before = expected_vacated_features(frame, p)
    after = expected_vacated_features(flipped, p)

    # assert - every served column, every row, bit-identical
    for column in SERVED_COLS:
        lhs = before[column].to_numpy(dtype=float)
        rhs = after[column].to_numpy(dtype=float)
        moved = ~(np.isclose(lhs, rhs, atol=1e-12, equal_nan=True))
        assert not moved.any(), (
            f"{column} moved on {int(moved.sum())} row(s) when a teammate's realized "
            f"outcome was flipped. the served family must be a function of as-of "
            f"probabilities and magnitudes only - a realized label reaching it is the "
            f"cross-player leak this phase exists to remove."
        )


def test_the_oracle_family_deliberately_fails_the_same_test(features_status):
    """the negative control, and it is a test we want to keep FAILING invariance.

    the same flip, the same held-fixed inputs, the v2 columns instead of the v3 ones.
    Their values MUST move, because they are sums over the realized absence set. Two
    things go wrong if this ever stops moving: the bracket's upper bound stops being an
    oracle and becomes fiction, and the test above stops proving anything - a pair of
    constant columns would pass it.
    """
    # arrange
    frame = features_status.reset_index(drop=True)
    game_id, team_id = _busy_team_game(frame)
    team_game = (frame["GAME_ID"] == game_id) & (frame["TEAM_ID"] == team_id)
    candidates = frame[team_game & (frame["PLAYED"] == 1) & (frame["std_MIN"] > 5)]
    victim = candidates.sort_values("std_MIN").iloc[-1]
    vacated_mpg = float(victim["std_MIN"])

    flipped = frame.copy()
    row = (
        (flipped["PLAYER_ID"] == victim["PLAYER_ID"])
        & (flipped["GAME_ID"] == game_id)
        & (flipped["TEAM_ID"] == team_id)
    )
    flipped.loc[row, "PLAYED"] = 0
    flipped.loc[row, "LISTED_INACTIVE"] = True

    # act
    before = vacated_features(frame).set_index(KEY)["vacated_minutes"]
    after = vacated_features(flipped).set_index(KEY)["vacated_minutes"]
    mates = [
        k for k in before.index
        if k[1] == game_id and k[2] == team_id and k[0] != victim["PLAYER_ID"]
    ]

    # assert - and by exactly the flipped player's as-of MPG, which is the sharp form
    delta = (after.loc[mates] - before.loc[mates]).to_numpy()
    assert len(delta) > 5
    assert delta == pytest.approx(vacated_mpg, abs=1e-9), (
        "the oracle column did NOT respond to a flipped realized outcome, so either "
        "it is no longer an oracle or the invariance test above is vacuous"
    )
    assert vacated_mpg > 5.0


def test_the_served_family_needs_no_outcome_column_at_all(features_status):
    """the structural version of the same claim: delete the outcomes and rebuild.

    invariance under a flip proves the function ignores the outcome's VALUE. Dropping
    the outcome columns entirely proves it never reads them - which is the property a
    reader can check by inspection and a test should not have to take on trust.
    """
    # arrange
    frame = features_status.reset_index(drop=True)
    p = _fixed_probability(frame)
    outcomes = ["PLAYED", "LISTED_INACTIVE", "MIN", "PTS", "AST", "FGA", "FTA", "TOV"]
    stripped = frame.drop(columns=[c for c in outcomes if c in frame.columns])

    # act
    full = expected_vacated_features(frame, p)
    blind = expected_vacated_features(stripped, p)

    # assert
    for column in SERVED_COLS:
        assert full[column].to_numpy(dtype=float) == pytest.approx(
            blind[column].to_numpy(dtype=float), abs=1e-12, nan_ok=True
        ), f"{column} differs once the outcome columns are removed"


def test_the_served_columns_are_the_ones_in_the_feature_contract():
    """the served family is in FEATURE_COLS; the oracle family is not."""
    # act + assert
    assert set(TEAMMATE_EXPECTED_COLS) <= set(FEATURE_COLS)
    assert set(RELIABILITY_FEATURE_COLS) <= set(FEATURE_COLS)
    assert not (set(TEAMMATE_ORACLE_COLS) & set(FEATURE_COLS))


# ---------------------------------------------------------------------------
# 2. pregame-status sensitivity: the closed form, to the last decimal
# ---------------------------------------------------------------------------
def test_changing_a_teammates_probability_moves_the_sums_by_the_closed_form():
    """E[vacated] = sum (1 - p_j) m_j, so d/dp_j = -m_j. Exactly.

    hand-built so the arithmetic is checkable by eye. A test that only asserted "the
    number went down" would pass against a construction that used the wrong magnitude,
    the wrong sign convention, or a teammate's magnitude for the wrong teammate.
    """
    # arrange - three players, one team-game, round magnitudes
    frame = pd.DataFrame({
        "GAME_ID": ["g1"] * 3,
        "TEAM_ID": ["t1"] * 3,
        "PLAYER_ID": ["p1", "p2", "p3"],
        "POS_GROUP": ["G", "G", "F"],
        "tm_MIN": [30.0, 20.0, 10.0],
        "tm_FGA": [15.0, 10.0, 5.0],
        "tm_USG": [28.0, 22.0, 15.0],
        MAGNITUDE_ESS: [20.0, 20.0, 20.0],
        "n_appearances": [40, 40, 40],
    })
    p_before = np.array([0.9, 0.9, 0.9])
    p_after = np.array([0.9, 0.5, 0.9])  # p2 becomes far less likely to play
    delta_p = -0.4  # p2's change

    # act
    before = expected_vacated_features(frame, p_before)
    after = expected_vacated_features(frame, p_after)

    # assert - p1 and p3 each gain exactly -delta_p * m_p2 of expected vacancy
    for row, magnitude_column, feature in (
        (0, "tm_MIN", "exp_vacated_minutes"),
        (2, "tm_MIN", "exp_vacated_minutes"),
        (0, "tm_FGA", "exp_vacated_fga"),
        (0, "tm_USG", "exp_vacated_usg"),
    ):
        expected = -delta_p * frame.loc[1, magnitude_column]
        assert after.loc[row, feature] - before.loc[row, feature] == pytest.approx(
            expected
        ), f"{feature} on row {row} did not move by -dp * m_j"

    # p2's own expected vacancy is untouched: self-exclusion is exact
    assert after.loc[1, "exp_vacated_minutes"] == pytest.approx(
        before.loc[1, "exp_vacated_minutes"]
    )
    # and the positional sum only moves for p2's own bucket-mate p1, not for p3
    assert after.loc[0, "exp_vacated_minutes_pos"] - before.loc[
        0, "exp_vacated_minutes_pos"
    ] == pytest.approx(-delta_p * 20.0)
    assert after.loc[2, "exp_vacated_minutes_pos"] == pytest.approx(
        before.loc[2, "exp_vacated_minutes_pos"]
    )


def test_expected_depth_rank_moves_by_the_probability_of_the_man_ahead():
    """E[depth_rank_i] = 1 + sum_{j != i} p_j 1(m_j > m_i), so d/dp_j = 1(m_j > m_i).

    the sign is the interesting half: raising a BETTER teammate's play probability
    pushes me DOWN the depth chart (rank up), and raising a worse teammate's does
    nothing at all. A construction that summed (1 - p) here, or that ranked on the
    expectation instead of expecting the rank, would get one of those two wrong.
    """
    # arrange
    frame = pd.DataFrame({
        "GAME_ID": ["g1"] * 3,
        "TEAM_ID": ["t1"] * 3,
        "PLAYER_ID": ["best", "middle", "worst"],
        "POS_GROUP": ["G", "G", "G"],
        "tm_MIN": [30.0, 20.0, 10.0],
        "tm_FGA": [15.0, 10.0, 5.0],
        "tm_USG": [28.0, 22.0, 15.0],
        MAGNITUDE_ESS: [20.0, 20.0, 20.0],
        "n_appearances": [40, 40, 40],
    })

    # act - the best player's availability drops from 1.0 to 0.25
    before = expected_vacated_features(frame, np.array([1.0, 1.0, 1.0]))
    after = expected_vacated_features(frame, np.array([0.25, 1.0, 1.0]))

    # assert
    assert before["exp_depth_rank"].tolist() == [1.0, 2.0, 3.0]
    # middle and worst each move up by 0.75, the probability mass the best player lost
    assert after.loc[1, "exp_depth_rank"] == pytest.approx(1.25)
    assert after.loc[2, "exp_depth_rank"] == pytest.approx(2.25)
    # the best player's own rank cannot move: nobody's magnitude exceeds his, and his
    # own probability is excluded from his own sum by construction
    assert after.loc[0, "exp_depth_rank"] == pytest.approx(1.0)

    # and lowering the WORST player's probability moves nobody's rank
    lowered = expected_vacated_features(frame, np.array([1.0, 1.0, 0.1]))
    assert lowered["exp_depth_rank"].tolist() == before["exp_depth_rank"].tolist()


def test_p_star_out_is_one_minus_the_usage_leaders_probability():
    """P(star_out_i) = 1 - p_star for every teammate, and 0 for the star himself."""
    # arrange
    frame = pd.DataFrame({
        "GAME_ID": ["g1"] * 4,
        "TEAM_ID": ["t1"] * 4,
        "PLAYER_ID": ["star", "b", "c", "d"],
        "POS_GROUP": ["G", "G", "F", "C"],
        "tm_MIN": [34.0, 24.0, 18.0, 8.0],
        "tm_FGA": [20.0, 12.0, 8.0, 3.0],
        "tm_USG": [32.0, 24.0, 18.0, 12.0],
        MAGNITUDE_ESS: [20.0, 20.0, 20.0, 20.0],
        "n_appearances": [60, 60, 60, 60],
    })

    # act
    out = expected_vacated_features(frame, np.array([0.3, 0.95, 0.95, 0.95]))

    # assert
    assert out.loc[0, "p_star_out"] == pytest.approx(0.0), (
        "the team's own usage leader was told a top-usage TEAMMATE might be out. that "
        "is a statement about himself and his own availability is the target."
    )
    for row in (1, 2, 3):
        assert out.loc[row, "p_star_out"] == pytest.approx(0.7)
    # top-3 expected count: the star at 0.7 plus b and c at 0.05 each
    assert out.loc[3, "exp_top3_usage_out"] == pytest.approx(0.7 + 0.05 + 0.05)
    assert out["exp_top3_usage_out"].max() <= TOP_USAGE_N


def test_the_usage_hierarchy_gate_still_rejects_thin_history():
    """a three-game 40%-usage rookie must not define his team's usage hierarchy.

    the gate carried over from v2 unchanged, and it is worth re-pinning because the
    hierarchy is now computed on ``tm_USG`` (shrunk, career-scoped) rather than
    ``usg_ewma`` - a different column with the same job, and a gate that silently
    stopped applying would put a call-up at the top of every depth chart.
    """
    # arrange - the highest usage on the roster belongs to a player with no history
    frame = pd.DataFrame({
        "GAME_ID": ["g1"] * 3,
        "TEAM_ID": ["t1"] * 3,
        "PLAYER_ID": ["rookie", "veteran", "other"],
        "POS_GROUP": ["G", "G", "G"],
        "tm_MIN": [8.0, 30.0, 20.0],
        "tm_FGA": [6.0, 18.0, 10.0],
        "tm_USG": [45.0, 30.0, 24.0],
        MAGNITUDE_ESS: [3.0, 20.0, 20.0],
        "n_appearances": [3, 80, 80],
    })
    assert 3 < STAR_USAGE_MIN_APPEARANCES

    # act - the rookie is very likely out
    out = expected_vacated_features(frame, np.array([0.1, 0.99, 0.99]))

    # assert - nobody's p_star_out reflects the ungated rookie
    assert out.loc[1, "p_star_out"] == pytest.approx(0.0)
    assert out.loc[2, "p_star_out"] == pytest.approx(0.01), (
        "the veteran, not the rookie, is the usage leader once the gate applies"
    )


def test_a_null_probability_becomes_the_prior_not_a_null_sum():
    """one unscoreable teammate must not null out a whole team-game."""
    # arrange
    frame = pd.DataFrame({
        "GAME_ID": ["g1"] * 3,
        "TEAM_ID": ["t1"] * 3,
        "PLAYER_ID": ["p1", "p2", "p3"],
        "POS_GROUP": ["G", "G", "G"],
        "tm_MIN": [30.0, 20.0, 10.0],
        "tm_FGA": [15.0, 10.0, 5.0],
        "tm_USG": [28.0, 22.0, 15.0],
        MAGNITUDE_ESS: [20.0, 20.0, 20.0],
        "n_appearances": [40, 40, 40],
    })

    # act
    out = expected_vacated_features(frame, np.array([1.0, np.nan, 1.0]))

    # assert
    assert out["exp_vacated_minutes"].notna().all()
    assert out.loc[0, "exp_vacated_minutes"] == pytest.approx(
        (1.0 - CONTEXT_P_PRIOR) * 20.0
    )


def test_the_served_family_is_computable_for_every_scheduled_row(feats):
    """no served column may be structurally null except the two positional ones."""
    # act + assert
    for column in TEAMMATE_EXPECTED_COLS:
        if column.endswith("_pos"):
            continue
        assert feats[column].notna().all(), f"{column} is null on some scheduled row"
    pos_null = feats["POS_GROUP"].isna()
    for column in ("exp_vacated_minutes_pos", "exp_depth_rank_pos"):
        assert feats[column].isna().equals(pos_null)
    # the reliability columns are never null either - "we do not know how much
    # evidence there is" is not a state the shrinkage can produce
    for column in ("magnitude_ess", "games_with_current_team", "is_rookie", "is_traded"):
        assert feats[column].notna().all(), f"{column} is null on some scheduled row"


def test_served_sums_exclude_self_on_the_real_dataset(feats):
    """the arithmetic identity, checked against a hand-built group total."""
    # arrange
    p = _fixed_probability(feats)
    contribution = (1.0 - p) * feats["tm_MIN"].astype(float).fillna(0.0).to_numpy()
    total = (
        pd.Series(contribution, index=feats.index)
        .groupby([feats["GAME_ID"], feats["TEAM_ID"]])
        .transform("sum")
        .to_numpy()
    )

    # act
    rebuilt = expected_vacated_features(feats, p)

    # assert
    assert rebuilt["exp_vacated_minutes"].to_numpy() == pytest.approx(
        total - contribution, abs=1e-9
    )
    # and the subtraction actually bites, or the test proves nothing
    assert (np.abs(contribution) > 1e-6).sum() > 100


# ---------------------------------------------------------------------------
# 3. the shrunk career-scoped magnitudes
# ---------------------------------------------------------------------------
def test_the_shrinkage_weight_is_n_over_n_plus_k():
    # arrange
    raw = pd.Series([30.0, 30.0, 30.0, 30.0])
    n = pd.Series([0.0, MAGNITUDE_SHRINK_K, 2 * MAGNITUDE_SHRINK_K, 1e9])
    prior = 10.0

    # act
    out = shrink(raw, n, prior)

    # assert
    assert out.iloc[0] == pytest.approx(prior), "n=0 must return the prior exactly"
    assert out.iloc[1] == pytest.approx(0.5 * 30.0 + 0.5 * prior), "w = 1/2 at n = k"
    assert out.iloc[2] == pytest.approx((2 / 3) * 30.0 + (1 / 3) * prior)
    assert out.iloc[3] == pytest.approx(30.0, rel=1e-6), "w -> 1 for large n"


def test_a_null_raw_magnitude_shrinks_to_the_prior_not_to_nan():
    # act
    out = shrink(pd.Series([np.nan]), pd.Series([20.0]), 12.0)

    # assert
    assert out.iloc[0] == pytest.approx(12.0)


def test_the_magnitude_window_is_career_scoped_and_bounded(feats):
    """crossing the season boundary is the cold-start fix; the cap is the window.

    ``magnitude_ess`` counts appearances in the window, so it must reach the window
    length for established players and must never exceed it. A season-scoped version
    would reset to 1 on every player's first game of a new season, which is exactly the
    October failure mode the review named.
    """
    # act + assert
    ess = feats[MAGNITUDE_ESS].dropna()
    assert ess.max() <= MAGNITUDE_WINDOW
    assert (ess >= 0).all()
    # the magnitudes themselves are never null: shrinkage guarantees a number
    for column, prior in (("tm_MIN", "MIN"), ("tm_FGA", "FGA"), ("tm_USG", "USG")):
        assert feats[column].notna().all(), f"{column} is null somewhere"
    # a player with no appearances at all sits exactly at the prior
    cold = feats[feats[MAGNITUDE_ESS] == 0]
    if len(cold):
        assert cold["tm_MIN"].to_numpy() == pytest.approx(MAGNITUDE_PRIORS["MIN"])


def test_the_magnitude_window_crosses_the_season_boundary(features_status):
    """a returning player's first game of a season carries last season's magnitude."""
    # arrange - players with appearances in both fixture seasons
    played = features_status[features_status["PLAYED"] == 1]
    seasons = sorted(played["SEASON"].unique())
    assert len(seasons) >= 2
    later = played[played["SEASON"] == seasons[-1]]
    first_games = later.sort_values("GAME_DATE").drop_duplicates("PLAYER_ID")
    veterans = first_games[
        first_games["PLAYER_ID"].isin(
            played[played["SEASON"] == seasons[0]]["PLAYER_ID"]
        )
    ]
    assert len(veterans) > 0

    # act + assert - the SEASON-scoped column is null on game 1 (nothing this season
    # yet) while the CAREER-scoped magnitude is not. that contrast is the whole point.
    assert veterans["season_appearances"].isna().all()
    assert veterans[MAGNITUDE_ESS].gt(0).all(), (
        "a returning player's magnitude window is empty at the season boundary, so the "
        "window is season-scoped and the cold-start fix is not applied"
    )


def test_reliability_features_look_only_backwards(features_status):
    """games_with_current_team counts PRIOR games; is_rookie ignores later seasons."""
    # arrange
    frame = features_status.sort_values(["PLAYER_ID", "GAME_DATE", "GAME_ID"])

    # act + assert - a player's first row with a team reads 0, and the count is
    # exactly the number of strictly earlier rows with that team
    first = frame.drop_duplicates(["PLAYER_ID", "TEAM_ID"])
    assert (first["games_with_current_team"] == 0).all()
    expected = frame.groupby(["PLAYER_ID", "TEAM_ID"]).cumcount().to_numpy()
    assert frame["games_with_current_team"].to_numpy() == pytest.approx(expected)

    # is_rookie: a player flagged rookie must have zero appearances in every earlier
    # season, and a player NOT flagged must have at least one
    apps = (
        features_status.assign(_p=features_status["PLAYED"])
        .groupby(["PLAYER_ID", "SEASON"])["_p"].sum()
    )
    sample = features_status.drop_duplicates(["PLAYER_ID", "SEASON"])
    for _, row in sample.iterrows():
        prior = apps.loc[row["PLAYER_ID"]]
        earlier = float(prior[prior.index < row["SEASON"]].sum())
        assert bool(row["is_rookie"]) == (earlier <= 0), (
            f"is_rookie is wrong for {row['PLAYER_ID']} in {row['SEASON']}: "
            f"{earlier} prior-season appearances"
        )


def test_teammate_ess_is_the_absence_weighted_mean_sample_size():
    # arrange - one absent-ish teammate with 20 games of evidence, one with 2
    frame = pd.DataFrame({
        "GAME_ID": ["g1"] * 3,
        "TEAM_ID": ["t1"] * 3,
        "PLAYER_ID": ["me", "solid", "flimsy"],
        "POS_GROUP": ["G", "G", "G"],
        "tm_MIN": [20.0, 30.0, 10.0],
        "tm_FGA": [10.0, 15.0, 5.0],
        "tm_USG": [20.0, 28.0, 15.0],
        MAGNITUDE_ESS: [20.0, 20.0, 2.0],
        "n_appearances": [40, 40, 2],
    })

    # act - solid is 50% likely out, flimsy 100% likely out
    out = expected_vacated_features(frame, np.array([1.0, 0.5, 0.0]))

    # assert
    expected = (0.5 * 20.0 + 1.0 * 2.0) / (0.5 + 1.0)
    assert out.loc[0, TEAMMATE_ESS] == pytest.approx(expected)


# ---------------------------------------------------------------------------
# 4. the two-stage pipeline's out-of-fold discipline
# ---------------------------------------------------------------------------
def test_the_base_model_refuses_teammate_context_features(features_status):
    """stage 1's whole job is to be free of teammate context.

    building expected context from a probability produced by a model that already saw
    teammate context is circular, and it is the kind of circularity that produces
    plausible numbers rather than an error. So it is an error.
    """
    # act + assert
    with pytest.raises(LeakageError, match="teammate-context"):
        cross_fit_base_probabilities(
            features_status, [*BASE_FEATURE_COLS, "exp_vacated_minutes"]
        )
    with pytest.raises(LeakageError, match="teammate-context"):
        cross_fit_base_probabilities(
            features_status, [*BASE_FEATURE_COLS, "vacated_minutes"]
        )


def test_every_row_gets_a_cross_fit_probability_stamped_before_its_own_game(
    features_status,
):
    """the OOF guard, on the real machinery, with the fitted path exercised.

    the fixture set is far smaller than a season, so the production
    ``CROSS_FIT_MIN_TRAIN_ROWS`` gate would send every block to the stage-0 baseline
    and the base model would never be fitted at all. The gate is lowered here on
    purpose: the point is to exercise the fitted branch, and the guard has to hold on
    both branches.
    """
    # act
    out = cross_fit_base_probabilities(features_status, min_train_rows=300)

    # assert
    assert len(out) == len(features_status)
    assert out[P_CONTEXT].notna().all()
    assert out[P_CONTEXT].between(0.0, 1.0).all()
    assert (out[P_CONTEXT_CUTOFF] <= out["GAME_DATE"]).all(), (
        "a probability carries a cutoff after its own game: the base model saw the "
        "game it is being used to describe"
    )
    # the fitted branch actually ran, or this test only covers the fallback
    assert (out["P_CONTEXT_SOURCE"] == "base-model").any()
    # and the guard itself passes on the returned frame
    validate_out_of_fold(out, P_CONTEXT, P_CONTEXT_CUTOFF, "p_context")


def test_a_cross_fit_probability_from_the_future_is_rejected(features_status):
    """the guard is a real check, not a formality: break it and it must fire."""
    # arrange
    out = cross_fit_base_probabilities(features_status, min_train_rows=300)
    tampered = out.copy()
    tampered.loc[tampered.index[0], P_CONTEXT_CUTOFF] = tampered.loc[
        tampered.index[0], "GAME_DATE"
    ] + pd.Timedelta(days=30)

    # act + assert
    with pytest.raises(LeakageError, match="IN-FOLD"):
        validate_out_of_fold(tampered, P_CONTEXT, P_CONTEXT_CUTOFF, "p_context")


def test_attaching_context_stamps_the_probability_and_its_cutoff(features_status):
    """the columns the guard reads have to be written by the thing that builds the
    features, or the guard is checking a stale stamp."""
    # arrange
    p = np.full(len(features_status), 0.5)
    cutoff = pd.Timestamp("2000-01-01")

    # act
    out = attach_expected_context(features_status, p, cutoff)

    # assert
    assert out[P_CONTEXT].to_numpy() == pytest.approx(p)
    assert (out[P_CONTEXT_CUTOFF] == cutoff).all()
    # a uniform p makes every expected sum a plain half-sum of the magnitudes, which
    # is the cheapest possible check that the p actually reached the arithmetic
    manual = (
        0.5 * features_status["tm_MIN"].astype(float)
    ).groupby(
        [features_status["GAME_ID"], features_status["TEAM_ID"]]
    ).transform("sum") - 0.5 * features_status["tm_MIN"].astype(float)
    assert out["exp_vacated_minutes"].to_numpy() == pytest.approx(
        manual.to_numpy(), abs=1e-9
    )


# ---------------------------------------------------------------------------
# 5. the team-game block permutation
# ---------------------------------------------------------------------------
def test_block_permutation_preserves_every_columns_marginal_distribution(feats):
    """the null has to differ from the real thing only in WHERE the block sits."""
    # act
    permuted = block_permute_context(feats)

    # assert
    for column in TEAMMATE_EXPECTED_COLS:
        real = np.sort(feats[column].to_numpy(dtype=float))
        fake = np.sort(permuted[column].to_numpy(dtype=float))
        assert real == pytest.approx(fake, nan_ok=True), (
            f"{column}'s marginal distribution changed under the block permutation, "
            f"so the null differs from the real column in more than one way"
        )
    # and it is not simply the identity
    moved = (
        feats["exp_vacated_minutes"].to_numpy()
        != permuted["exp_vacated_minutes"].to_numpy()
    )
    assert moved.mean() > 0.5, "the permutation barely moved anything"


def test_block_permutation_keeps_each_block_internally_coherent(feats):
    """every permuted block must BE some real team-game's block, intact.

    the property that makes this null harder than a per-row shuffle. A per-row shuffle
    hands a row a physically impossible context - a depth rank from one team and a
    vacated-minutes total from another - which a booster can in principle notice and
    discount for the wrong reason. Here each row receives a real, coherent block; only
    the game it is attached to is wrong.
    """
    # arrange
    permuted = block_permute_context(feats)
    key = ["GAME_ID", "TEAM_ID"]

    def blocks(frame):
        return {
            tuple(sorted(np.round(group["exp_vacated_minutes"].to_numpy(dtype=float), 9)))
            for _, group in frame.groupby(key)
        }

    # act
    real_blocks, fake_blocks = blocks(feats), blocks(permuted)

    # assert - every block after the permutation is one of the blocks from before it
    assert fake_blocks <= real_blocks, (
        "a permuted team-game's context block does not match any real team-game's, so "
        "the permutation is mixing rows across blocks rather than moving whole blocks"
    )
    # and the roster sizes are unchanged, which is what makes block-for-block swapping
    # possible at all
    assert (
        feats.groupby(key).size().sort_index().tolist()
        == permuted.groupby(key).size().sort_index().tolist()
    )


def _context_driven_frame(n_team_games: int = 420, roster: int = 15) -> pd.DataFrame:
    """a synthetic frame where minutes REALLY are a function of the context block.

    WHY A SYNTHETIC FRAME RATHER THAN THE FIXTURES. The importance-collapse claim is a
    claim about the MECHANISM: if the outcome depends on the context, does destroying
    the context's alignment destroy the model's ability to use it? The parquet fixtures
    are synthetic in a different way - their minutes are generated without any
    teammate-absence structure at all - so a collapse test on them would be asserting
    that noise stops being noise, which it cannot, and the test would be flaky rather
    than informative. Building the dependence explicitly makes the assertion sharp and
    the failure mode unambiguous: if this collapses, the permutation works; if it does
    not, the permutation is not actually breaking the alignment.

    the real ``expected_vacated_features`` computes the block, so the test exercises the
    shipped arithmetic and not a lookalike.
    """
    rng = np.random.default_rng(5)
    rows = []
    for game in range(n_team_games):
        # deliberately NOT sorted by slot. If magnitude were monotone in roster slot,
        # every block would carry the same rank pattern in the same positions, the
        # permutation would hand each row a rank it would have had anyway, and the test
        # would understate the collapse for a reason that has nothing to do with the
        # feature.
        magnitudes = rng.gamma(shape=4.0, scale=5.0, size=roster)
        for slot in range(roster):
            rows.append({
                "GAME_ID": f"g{game:05d}",
                "TEAM_ID": f"t{game % 30:02d}",
                "PLAYER_ID": f"p{game:05d}_{slot:02d}",
                "POS_GROUP": ("G", "F", "C")[slot % 3],
                "tm_MIN": float(magnitudes[slot]),
                "tm_FGA": float(magnitudes[slot]) / 2.0,
                "tm_USG": 12.0 + float(magnitudes[slot]) / 2.0,
                MAGNITUDE_ESS: 20.0,
                "n_appearances": 60,
            })
    frame = pd.DataFrame(rows)
    p = rng.beta(6.0, 2.0, size=len(frame))
    frame = expected_vacated_features(frame, p)
    # minutes depend on the player's own magnitude AND on the context block. the second
    # term is what the permutation is supposed to destroy.
    frame["MIN"] = np.clip(
        0.6 * frame["tm_MIN"]
        + 0.5 * frame["exp_vacated_minutes"] / frame["exp_depth_rank"]
        + rng.normal(0.0, 1.5, size=len(frame)),
        0.0, None,
    )
    frame["PLAYED"] = 1
    frame["GAME_DATE"] = pd.Timestamp("2025-01-01")
    return frame


def test_block_permutation_collapses_the_context_blocks_importance():
    """the harder null, on a frame where the context provably matters.

    each row still receives a real, internally coherent expected-vacancy block - same
    roster size, same within-block ordering - merely attached to the wrong team-game. If
    the minutes model's gain on that block does not fall sharply, the permutation is not
    breaking the alignment and the null is not a null.
    """
    # arrange - half the team-games train, half score, so the second assertion is out
    # of sample and a permuted model cannot recover by memorising
    frame = _context_driven_frame()
    train_games = set(sorted(frame["GAME_ID"].unique())[: 210])
    is_train = frame["GAME_ID"].isin(train_games).to_numpy()
    cols = ["tm_MIN", *TEAMMATE_EXPECTED_COLS]
    cutoff = pd.Timestamp("2025-06-01")
    permuted = block_permute_context(frame)

    # act
    real_model = MinutesModel(kind="lightgbm").fit(frame[is_train], cols, cutoff)
    fake_model = MinutesModel(kind="lightgbm").fit(permuted[is_train], cols, cutoff)
    real_gain, fake_gain = real_model.feature_gain(), fake_model.feature_gain()

    def share(gain: pd.Series) -> float:
        total = float(gain.sum())
        block = float(gain.reindex(TEAMMATE_EXPECTED_COLS).fillna(0.0).sum())
        return block / total if total else 0.0

    truth = frame.loc[~is_train, "MIN"].to_numpy(dtype=float)
    real_mae = mae(truth, real_model.predict(frame[~is_train]))
    fake_mae = mae(truth, fake_model.predict(permuted[~is_train]))

    # assert
    real_share, fake_share = share(real_gain), share(fake_gain)
    assert real_share > 0.20, (
        f"the context block carries only {real_share:.2%} of the gain even though the "
        f"outcome was built to depend on it, so this test cannot detect a collapse"
    )
    assert fake_share < 0.5 * real_share, (
        f"the block permutation did not collapse the context block's gain share "
        f"({real_share:.2%} -> {fake_share:.2%}): the permutation is not breaking the "
        f"alignment between the block and the game"
    )
    # the substantive claim: whatever the booster still spends splits on, it can no
    # longer PREDICT with. gain is an allocation of credit; this is the credit's value.
    assert fake_mae > 1.5 * real_mae, (
        f"the permuted model still predicts nearly as well ({fake_mae:.3f} vs "
        f"{real_mae:.3f} MAE), so the context it was given was not actually misaligned"
    )


# ---------------------------------------------------------------------------
# 6. the degraded-oracle probe and the ablation, structurally
# ---------------------------------------------------------------------------
def test_perfect_degraded_knowledge_reproduces_the_oracle_absence_set(features_status):
    """recall = 1, fp = 0 must flag exactly the realized absences and nobody else.

    the arithmetic check on the Level-C grid's claim that its top-left cell IS the
    oracle. If that cell were not the oracle, every relative number in the grid would
    be measured against the wrong reference.
    """
    # arrange
    absent = features_status["PLAYED"].to_numpy() == 0
    base = pd.to_numeric(features_status[P_CONTEXT], errors="coerce").fillna(0.7)

    # act
    p = degrade_absence_knowledge(features_status, recall=1.0, false_positive_rate=0.0)

    # assert - every realized absence is flagged, and nobody else is TOUCHED. the
    # comparison is against the base probability rather than against zero, because a
    # player with no appearance history legitimately has a base p of 0 and asserting
    # "> 0" would be testing the fixture's history depth instead of the degradation.
    assert (p[absent] == 0.0).all()
    assert p[~absent] == pytest.approx(base.to_numpy()[~absent]), (
        "a player who did play had his probability changed at fp = 0, so the "
        "false-positive arm is firing when it should not"
    )


def test_degraded_knowledge_flags_roughly_the_requested_share(features_status):
    """recall is a rate, so it has to land near the rate that was asked for."""
    # arrange
    absent = features_status["PLAYED"].to_numpy() == 0
    assert absent.sum() > 200

    # act
    p = degrade_absence_knowledge(features_status, recall=0.6, false_positive_rate=0.0)

    # assert
    flagged = float((p[absent] == 0.0).mean())
    assert 0.5 < flagged < 0.7, f"asked for 60% recall, flagged {flagged:.1%}"


def test_the_single_feature_ablation_reports_a_cost_table(features_status):
    """the ablation is REPORTED, not asserted - so the test is that it reports.

    there is no threshold the delta has to clear. What must hold is that the table
    exists, names both runs, and orients its sign so that "removing the column cost
    accuracy" reads positive; a sign flip here would turn a finding into its opposite
    in the report and nothing else would catch it.
    """
    # arrange - one short origin inside the fixture window
    origins = [("O1", "2024-12-01", "2024-12-15")]

    # act
    table = single_feature_ablation(features_status, origins)

    # assert
    assert not table.empty
    assert {"with", "without", "cost_of_removal", "cost_of_removal_pct"} <= set(
        table.columns
    )
    row = table.iloc[0]
    assert row["cost_of_removal"] == pytest.approx(
        float(row["without"]) - float(row["with"]), abs=1e-9
    )


def test_the_bracket_feature_sets_are_nested_where_they_claim_to_be():
    """v1 is inside both of the others, and the two teammate families are disjoint.

    the bracket's whole interpretation rests on this: if v1 were not a subset of
    v3-honest, "the delta from v1" would be measuring a feature swap rather than an
    addition, and the ``survived`` fraction would be a ratio of two incomparable
    things.
    """
    # act + assert
    from fnba_ml.config import FEATURE_SETS, ORACLE_FEATURE_SET

    v1 = set(FEATURE_SETS["v1"])
    honest = set(FEATURE_SETS[SERVED_FEATURE_SET])
    oracle = set(FEATURE_SETS[ORACLE_FEATURE_SET])
    assert v1 < honest and v1 < oracle
    assert not (set(TEAMMATE_ORACLE_COLS) & honest)
    assert not (set(TEAMMATE_EXPECTED_COLS) & oracle)
    # and the origins the bracket runs over are the configured development origins,
    # not a subset someone trimmed to make a number look better
    assert len(ORIGINS) == 5
