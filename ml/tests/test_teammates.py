"""leakage and correctness tests for the v2 teammate-absence family.

SCOPE, and it changed with feature_version v3. Everything in this file is about the
ORACLE family - ``vacated_*``, ``depth_rank_available*``, ``star_out``,
``top3_usage_out_count`` - which is no longer served. Those columns are still
computed, still on the dataset, and still the comparator the evaluation bracket needs
as its upper bound, so their semantics still have to be exactly right: an oracle whose
arithmetic is wrong is a useless upper bound. The tests below are therefore kept
verbatim in intent and merely re-scoped to the family they were written for.

The SERVED family (``exp_*``, ``p_star_out``, the reliability columns) is tested in
``test_teammates_v3.py``, against a strictly stronger property: invariance to EVERY
player's target-game outcome, not merely to the row's own. That is the property the
round-2 external review found v2 lacked, and the reason the served family exists.

THREE THINGS HAVE TO BE PINNED HERE, and the first one is not like the others.

1. SELF-EXCLUSION. The absent-teammate set is the complement of ``PLAYED``, so a
   vacated-resource sum that forgot to exclude the row's own player would be an
   exact function of that row's own availability outcome. The availability model
   would read it straight off, score a Brier near zero, and every table in the
   report would look like a triumph. ``test_a_players_own_absence_cannot_reach_his
   _own_vacated_values`` rebuilds the whole feature frame from a universe with one
   player's ``PLAYED`` flipped and asserts his own numbers do not move - and its
   negative control asserts his TEAMMATES' numbers move by exactly his MPG, so the
   test cannot pass by measuring nothing.

2. THE SPLIT AS-OF CONTRACT. The absent SET is the target game's; every MAGNITUDE
   summed over it is strictly prior. Both halves get a test, and the as-of half
   gets a negative control proving the leaky variant (summing the teammates'
   minutes in the target game) is a different number.

3. THE ARITHMETIC. Usage, ranks and counts are hand-recomputed from the raw logs
   the same way ``test_features.py`` hand-recomputes the rolling windows.

Every test that can run against both universe constructions does, via the ``feats``
fixture. The ones that flip an outcome and rebuild use ``features_status``
directly, because the approximation universe has no inactive list to flip.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.config import (
    EWMA_HALFLIFE,
    FEATURE_COLS,
    FEATURE_SETS,
    FEATURE_VERSION,
    FT_POSSESSION_WEIGHT,
    ORACLE_FEATURE_SET,
    RATE_MINUTES_FLOOR,
    STAR_USAGE_MIN_APPEARANCES,
    TARGET_COLS,
    TEAMMATE_EXPECTED_COLS,
    TEAMMATE_FEATURE_COLS,
    TEAMMATE_ORACLE_COLS,
    TOP_USAGE_N,
)
from fnba_ml.features import build_features
from fnba_ml.teammates import (
    USAGE_COLUMN,
    VACATED_SOURCES,
    absence_mask,
    usage_share,
    vacated_features,
)
from fnba_ml.universe import position_group

RNG = np.random.default_rng(11)

VACATED_COLS = list(VACATED_SOURCES.values())
RANK_COLS = ["depth_rank_available", "depth_rank_available_pos"]


def _busy_team_game(frame: pd.DataFrame) -> tuple[str, str]:
    """a (GAME_ID, TEAM_ID) with at least one absence and one established player."""
    absent = frame["PLAYED"] == 0
    counts = frame[absent].groupby(["GAME_ID", "TEAM_ID"]).size()
    # take a late one so season-to-date history is filled
    late = frame[absent].groupby(["GAME_ID", "TEAM_ID"])["GAME_DATE"].max()
    both = pd.concat([counts.rename("n"), late.rename("date")], axis=1)
    both = both[both["n"] >= 2].sort_values("date")
    return both.index[-1]


# ---------------------------------------------------------------------------
# 1. self-exclusion: the leakage boundary
# ---------------------------------------------------------------------------
def test_a_players_own_absence_cannot_reach_his_own_vacated_values(
    universe_status, features_status
):
    """THE load-bearing test of this module.

    flip one player's ``PLAYED`` (and his inactive flag) for one game, rebuild the
    ENTIRE feature frame, and require that his own vacated_*/rank/star columns for
    that game are bit-identical. Every as-of feature on that row is computed from
    games strictly before it, so nothing about that row legitimately changes - only
    a self-inclusion bug could move these numbers.

    the negative control below is what gives the test teeth.
    """
    # arrange
    game_id, team_id = _busy_team_game(features_status)
    team_game = (
        (features_status["GAME_ID"] == game_id) & (features_status["TEAM_ID"] == team_id)
    )
    candidates = features_status[team_game & (features_status["PLAYED"] == 1)]
    candidates = candidates[candidates["std_MIN"].notna() & (candidates["std_MIN"] > 5)]
    assert len(candidates) > 0, "need a teammate with established minutes to flip"
    player_id = str(candidates.sort_values("std_MIN").iloc[-1]["PLAYER_ID"])

    flipped_universe = universe_status.copy()
    row = (
        (flipped_universe["PLAYER_ID"] == player_id)
        & (flipped_universe["GAME_ID"] == game_id)
        & (flipped_universe["TEAM_ID"] == team_id)
    )
    assert row.sum() == 1
    flipped_universe.loc[row, "PLAYED"] = 0
    flipped_universe.loc[row, "LISTED_INACTIVE"] = True

    # act
    rebuilt = build_features(flipped_universe)

    def own(frame):
        return frame[
            (frame["PLAYER_ID"] == player_id)
            & (frame["GAME_ID"] == game_id)
            & (frame["TEAM_ID"] == team_id)
        ].iloc[0]

    before, after = own(features_status), own(rebuilt)

    # assert - his own outcome moved, his own teammate-context features did not.
    # SCOPED TO THE ORACLE FAMILY: these are the columns whose self-exclusion is a
    # subtraction of a realized indicator, and this test is what pins it. The served
    # family's invariance is a strictly stronger property (it must not move for ANY
    # player's flipped outcome, not only its own) and lives in test_teammates_v3.py.
    assert before["PLAYED"] == 1 and after["PLAYED"] == 0
    for column in [*TEAMMATE_ORACLE_COLS, "usg_ewma"]:
        assert (
            pd.isna(before[column]) and pd.isna(after[column])
        ) or before[column] == pytest.approx(after[column], abs=1e-9, nan_ok=True), (
            f"{column} moved for the player whose own PLAYED was flipped: "
            f"{before[column]} -> {after[column]}. his own absence is the "
            f"availability TARGET and must never enter his own features."
        )


def test_flipping_a_players_availability_does_move_his_teammates(
    universe_status, features_status
):
    """the negative control for the test above, and a sharp one.

    a teammate's ``vacated_minutes`` must increase by EXACTLY the flipped player's
    season-to-date MPG - not merely change, not merely increase. That pins the
    aggregation, the as-of magnitude and the self-exclusion in one number.
    """
    # arrange
    game_id, team_id = _busy_team_game(features_status)
    team_game = (
        (features_status["GAME_ID"] == game_id) & (features_status["TEAM_ID"] == team_id)
    )
    candidates = features_status[team_game & (features_status["PLAYED"] == 1)]
    candidates = candidates[candidates["std_MIN"].notna() & (candidates["std_MIN"] > 5)]
    flipped_player = candidates.sort_values("std_MIN").iloc[-1]
    player_id = str(flipped_player["PLAYER_ID"])
    vacated_mpg = float(flipped_player["std_MIN"])

    flipped_universe = universe_status.copy()
    row = (
        (flipped_universe["PLAYER_ID"] == player_id)
        & (flipped_universe["GAME_ID"] == game_id)
        & (flipped_universe["TEAM_ID"] == team_id)
    )
    flipped_universe.loc[row, "PLAYED"] = 0
    flipped_universe.loc[row, "LISTED_INACTIVE"] = True

    # act
    rebuilt = build_features(flipped_universe)
    key = ["PLAYER_ID", "GAME_ID", "TEAM_ID"]
    before = features_status[team_game].set_index(key)["vacated_minutes"]
    after = rebuilt[
        (rebuilt["GAME_ID"] == game_id) & (rebuilt["TEAM_ID"] == team_id)
    ].set_index(key)["vacated_minutes"]
    delta = (after - before).drop(index=(player_id, game_id, team_id))

    # assert
    assert len(delta) > 5
    assert delta.to_numpy() == pytest.approx(vacated_mpg, abs=1e-9), (
        "every teammate's vacated_minutes must rise by exactly the flipped "
        "player's season-to-date MPG"
    )
    assert vacated_mpg > 5.0, "the control has to move a non-trivial amount"


def test_sums_exclude_self_even_when_the_player_himself_is_out(feats):
    """the self-exclusion arithmetic, checked directly against the group total.

    for an ABSENT player the naive group sum includes his own magnitude, so this is
    the case where forgetting the subtraction is invisible on played rows and
    catastrophic on missed ones.
    """
    # arrange
    absent = feats[feats["PLAYED"] == 0]
    assert len(absent) > 100
    group_total = (
        feats.assign(
            _contrib=np.where(
                absence_mask(feats),
                pd.to_numeric(feats["std_MIN"], errors="coerce").fillna(0.0),
                0.0,
            )
        )
        .groupby(["GAME_ID", "TEAM_ID"])["_contrib"]
        .transform("sum")
    )
    own = np.where(
        absence_mask(feats),
        pd.to_numeric(feats["std_MIN"], errors="coerce").fillna(0.0),
        0.0,
    )

    # act + assert
    expected = (group_total - own).to_numpy()
    assert feats["vacated_minutes"].to_numpy() == pytest.approx(expected, abs=1e-9)
    # the naive group sum and the self-excluded one must actually differ on a large
    # number of rows, or this test would pass against an implementation that forgot
    # the subtraction entirely
    assert (np.abs(group_total.to_numpy() - expected) > 1e-9).sum() > 100, (
        "self-exclusion never bites on this data, so this test proves nothing"
    )


# ---------------------------------------------------------------------------
# 2. the split as-of contract
# ---------------------------------------------------------------------------
def test_vacated_minutes_matches_a_manual_recomputation(feats):
    """hand-recompute the sum for a sample of rows, from the frame's own columns.

    the set is "who did not play in THIS game"; the magnitude is each of those
    players' season-to-date MPG as of BEFORE this game.
    """
    # arrange
    rows = feats[feats["vacated_minutes"] > 0]
    sample = rows.iloc[RNG.choice(len(rows), size=30, replace=False)]

    # act + assert
    for _, row in sample.iterrows():
        mates = feats[
            (feats["GAME_ID"] == row["GAME_ID"])
            & (feats["TEAM_ID"] == row["TEAM_ID"])
            & (feats["PLAYER_ID"] != row["PLAYER_ID"])
        ]
        out = mates[absence_mask(mates)]
        expected = pd.to_numeric(out["std_MIN"], errors="coerce").fillna(0.0).sum()
        assert row["vacated_minutes"] == pytest.approx(expected, abs=1e-9), (
            f"vacated_minutes mismatch for player {row['PLAYER_ID']} in game "
            f"{row['GAME_ID']}: pipeline={row['vacated_minutes']} manual={expected}"
        )


def test_the_magnitudes_are_as_of_not_the_target_games_minutes(feats):
    """negative control for the as-of half of the contract.

    the leaky variant sums the absent teammates' minutes IN the target game. Those
    are all zero for a player who did not play, so the leaky sum is 0 and differs
    from the as-of sum on essentially every row - which is only interesting because
    it proves the pipeline is not accidentally computing the trivial version.
    """
    # arrange
    rows = feats[feats["vacated_minutes"] > 1]
    sample = rows.iloc[RNG.choice(len(rows), size=30, replace=False)]

    # act
    n_differ = 0
    for _, row in sample.iterrows():
        mates = feats[
            (feats["GAME_ID"] == row["GAME_ID"])
            & (feats["TEAM_ID"] == row["TEAM_ID"])
            & (feats["PLAYER_ID"] != row["PLAYER_ID"])
        ]
        leaky = mates[absence_mask(mates)]["MIN"].sum()
        if not np.isclose(leaky, row["vacated_minutes"], atol=1e-9):
            n_differ += 1

    # assert
    assert n_differ == len(sample), (
        "the as-of magnitudes coincide with the target game's minutes, which means "
        "the summed column is not the shifted one"
    )


def test_the_absence_set_is_the_official_list_unioned_with_no_appearance(feats):
    """the game-day/oracle semantics, stated as an assertion.

    the set is the target game's inactive list PLUS rostered players with no
    appearance. On the production truth layer those are the same rows (the roster is
    reconstructed from the list plus appearances); the fixtures deliberately include
    absences that are NOT on their synthetic inactive list, so the union is strictly
    wider here and the ``or`` is actually exercised.
    """
    # act
    absent = absence_mask(feats)
    played = feats["PLAYED"].to_numpy() == 0

    # assert - never narrower than "did not play"
    assert (absent >= played).all()
    if feats["LISTED_INACTIVE"].notna().any():
        listed = feats["LISTED_INACTIVE"].astype("boolean").fillna(False).to_numpy()
        assert (absent >= listed).all()
        assert absent.sum() >= listed.sum()


# ---------------------------------------------------------------------------
# 3. usage rate
# ---------------------------------------------------------------------------
def test_usage_share_matches_the_box_score_formula():
    """the arithmetic, on a hand-built row with round numbers."""
    # arrange - 30 minutes, 20 FGA, 10 FTA, 4 TOV; team 240 min, 90 FGA, 20 FTA, 15 TOV
    frame = pd.DataFrame({
        "MIN": [30.0], "FGA": [20.0], "FTA": [10.0], "TOV": [4.0],
        "TEAM_MIN": [240.0], "TEAM_FGA": [90.0], "TEAM_FTA": [20.0], "TEAM_TOV": [15.0],
    })
    player_poss = 20.0 + FT_POSSESSION_WEIGHT * 10.0 + 4.0
    team_poss = 90.0 + FT_POSSESSION_WEIGHT * 20.0 + 15.0

    # act
    usage = usage_share(frame).iloc[0]

    # assert
    assert usage == pytest.approx(100.0 * player_poss * (240.0 / 5.0) / (30.0 * team_poss))


def test_usage_uses_team_minutes_over_five_not_a_hard_coded_48():
    """overtime: a 265-minute team game is 53 minutes long, not 48."""
    # arrange
    base = {
        "MIN": [30.0], "FGA": [20.0], "FTA": [0.0], "TOV": [0.0],
        "TEAM_FGA": [90.0], "TEAM_FTA": [0.0], "TEAM_TOV": [0.0],
    }
    regulation = usage_share(pd.DataFrame({**base, "TEAM_MIN": [240.0]})).iloc[0]
    overtime = usage_share(pd.DataFrame({**base, "TEAM_MIN": [265.0]})).iloc[0]

    # act + assert
    assert overtime == pytest.approx(regulation * 265.0 / 240.0)


def test_the_minutes_floor_caps_a_cameos_usage(feats):
    """the same floor the per-minute production rates use, for the same reason.

    a two-minute stint with two shots is a real 60%-usage observation and a useless
    number to EWMA forward. the floor is on the DENOMINATOR, so the cameo still
    contributes at the rate a four-minute stint would have implied.
    """
    # arrange
    cameo = pd.DataFrame({
        "MIN": [2.0], "FGA": [2.0], "FTA": [0.0], "TOV": [0.0],
        "TEAM_MIN": [240.0], "TEAM_FGA": [90.0], "TEAM_FTA": [0.0], "TEAM_TOV": [0.0],
    })

    # act
    floored = usage_share(cameo).iloc[0]
    unfloored = 100.0 * 2.0 * 48.0 / (2.0 * 90.0)

    # assert
    assert floored == pytest.approx(100.0 * 2.0 * 48.0 / (RATE_MINUTES_FLOOR * 90.0))
    assert floored < unfloored
    # and no served usage is physically absurd
    assert feats[USAGE_COLUMN].max() <= 100.0


def test_usage_is_null_rather_than_zero_without_team_totals():
    """a missing denominator must not read as "took no shots"."""
    # arrange
    frame = pd.DataFrame({
        "MIN": [30.0], "FGA": [20.0], "FTA": [2.0], "TOV": [3.0],
        "TEAM_MIN": [np.nan], "TEAM_FGA": [np.nan],
        "TEAM_FTA": [np.nan], "TEAM_TOV": [np.nan],
    })

    # act + assert
    assert usage_share(frame).isna().all()
    assert usage_share(pd.DataFrame({"MIN": [30.0]})).isna().all()


def test_usg_ewma_is_the_ewma_of_strictly_prior_usage_shares(feats):
    """spot-check the as-of EWMA against a hand computation, plus its own control."""
    # arrange - a player with plenty of appearances
    played = feats[(feats["PLAYED"] == 1) & (feats["MIN"] > 0)]
    player_id = str(played["PLAYER_ID"].value_counts().index[0])
    rows = feats[(feats["PLAYER_ID"] == player_id) & feats[USAGE_COLUMN].notna()]
    target = rows.sort_values("GAME_DATE").iloc[-1]

    history = played[
        (played["PLAYER_ID"] == player_id) & (played["GAME_DATE"] < target["GAME_DATE"])
    ].sort_values("GAME_DATE")
    assert len(history) > 10

    # act
    expected = (
        usage_share(history).ewm(halflife=EWMA_HALFLIFE, adjust=True).mean().iloc[-1]
    )
    leaky = (
        usage_share(
            played[
                (played["PLAYER_ID"] == player_id)
                & (played["GAME_DATE"] <= target["GAME_DATE"])
            ].sort_values("GAME_DATE")
        )
        .ewm(halflife=EWMA_HALFLIFE, adjust=True)
        .mean()
        .iloc[-1]
    )

    # assert
    assert target[USAGE_COLUMN] == pytest.approx(expected, rel=1e-9)
    assert not np.isclose(leaky, target[USAGE_COLUMN], atol=1e-9), (
        "the inclusive variant matches, so the as-of join is not excluding the "
        "target game"
    )


# ---------------------------------------------------------------------------
# 4. depth ranks
# ---------------------------------------------------------------------------
def test_depth_rank_counts_only_available_teammates(feats):
    # arrange
    sample = feats.iloc[RNG.choice(len(feats), size=40, replace=False)]

    # act + assert
    for _, row in sample.iterrows():
        mates = feats[
            (feats["GAME_ID"] == row["GAME_ID"]) & (feats["TEAM_ID"] == row["TEAM_ID"])
        ]
        available = mates[~absence_mask(mates)]
        own = row["std_MIN"] if pd.notna(row["std_MIN"]) else -np.inf
        theirs = pd.to_numeric(available["std_MIN"], errors="coerce").fillna(-np.inf)
        expected = 1 + int((theirs > own).sum())
        assert row["depth_rank_available"] == expected, (
            f"depth_rank_available mismatch for player {row['PLAYER_ID']} in "
            f"{row['GAME_ID']}: pipeline={row['depth_rank_available']} "
            f"manual={expected}"
        )


def test_an_absent_player_still_gets_a_depth_rank(feats):
    """a feature that is null exactly when a player is out tells the model he is out.

    the rank of an absent player is the rank he WOULD have held among tonight's
    available teammates - defined, finite, and independent of his own status.
    """
    # act
    absent = feats[feats["PLAYED"] == 0]

    # assert
    assert len(absent) > 100
    assert absent["depth_rank_available"].notna().all()
    assert (absent["depth_rank_available"] >= 1).all()
    # a strict positive rate of nulls in the rank column, correlated with absence,
    # would be the failure mode; assert the null rate is identical on both sides
    played_null = float(feats[feats["PLAYED"] == 1]["depth_rank_available"].isna().mean())
    absent_null = float(absent["depth_rank_available"].isna().mean())
    assert played_null == absent_null == 0.0


def test_a_rank_does_not_move_when_only_its_own_row_flips(feats):
    """flip ONE row's availability; that row's own rank must be identical.

    the precise statement of self-independence for the rank columns, and the reason
    ``_count_greater`` counts strictly-greater rather than using ``rank()`` over a
    masked column: with a mask, an available player's rank changes when he becomes
    absent, which is exactly the leak.
    """
    # arrange - a player who played, with teammates on both sides of him
    played = feats[(feats["PLAYED"] == 1) & feats["std_MIN"].notna()]
    target = played.sort_values("GAME_DATE").iloc[-40]
    row = (
        (feats["PLAYER_ID"] == target["PLAYER_ID"])
        & (feats["GAME_ID"] == target["GAME_ID"])
        & (feats["TEAM_ID"] == target["TEAM_ID"])
    )
    flipped = feats.copy()
    flipped.loc[row, "PLAYED"] = 0
    flipped.loc[row, "LISTED_INACTIVE"] = True

    # act - the aggregation only; the as-of columns are untouched by construction
    recomputed = vacated_features(flipped)

    # assert
    for column in [*RANK_COLS, *VACATED_COLS, "vacated_minutes_pos", "star_out",
                   "top3_usage_out_count"]:
        before, after = feats.loc[row, column].iloc[0], recomputed.loc[row, column].iloc[0]
        assert (pd.isna(before) and pd.isna(after)) or before == pytest.approx(after), (
            f"{column} moved for the only row whose availability changed"
        )
    # negative control: a teammate's rank or sum DID move
    mates = (
        (feats["GAME_ID"] == target["GAME_ID"])
        & (feats["TEAM_ID"] == target["TEAM_ID"])
        & (feats["PLAYER_ID"] != target["PLAYER_ID"])
    )
    moved = (
        feats.loc[mates, "vacated_minutes"].to_numpy()
        != recomputed.loc[mates, "vacated_minutes"].to_numpy()
    )
    assert moved.all(), "no teammate noticed the flip, so the test measures nothing"


def test_ranks_are_bounded_by_the_roster(feats):
    # act
    roster = feats.groupby(["GAME_ID", "TEAM_ID"])["PLAYER_ID"].transform("size")

    # assert
    assert (feats["depth_rank_available"] >= 1).all()
    assert (feats["depth_rank_available"] <= roster).all()
    have_pos = feats["depth_rank_available_pos"].notna()
    assert (feats.loc[have_pos, "depth_rank_available_pos"] >= 1).all()
    assert (feats.loc[have_pos, "depth_rank_available_pos"] <= roster[have_pos]).all()


def test_ties_share_a_rank(feats):
    """two available teammates with the same season-to-date MPG rank equally.

    exercised by the many rows whose std_MIN is null (no season history yet): they
    all tie at the back of the depth chart rather than being ordered arbitrarily.
    """
    # arrange
    no_history = feats[feats["std_MIN"].isna()]
    assert len(no_history) > 0

    # act + assert
    for (game_id, team_id), group in no_history.groupby(["GAME_ID", "TEAM_ID"]):
        if len(group) < 2:
            continue
        assert group["depth_rank_available"].nunique() == 1, (
            f"tied (null-MPG) players in {game_id}/{team_id} were given different "
            f"depth ranks"
        )
        break
    else:
        pytest.skip("no team-game has two players without season history")


# ---------------------------------------------------------------------------
# 5. the usage hierarchy
# ---------------------------------------------------------------------------
def test_star_out_is_binary_and_top3_count_is_bounded(feats):
    # act + assert
    assert set(feats["star_out"].dropna().unique()) <= {0.0, 1.0}
    counts = feats["top3_usage_out_count"].dropna()
    assert counts.min() >= 0
    assert counts.max() <= TOP_USAGE_N
    # both events actually occur in the data, or the cohorts are empty
    assert (feats["star_out"] == 1).sum() > 0
    assert (feats["top3_usage_out_count"] >= 1).sum() > 0


def test_star_out_is_never_the_players_own_absence(feats):
    """the team's own top-usage player can never have star_out = 1.

    for him the flag would be about himself, and a player's own absence is the
    availability target. It reads 0 for him always, which is the honest answer:
    "a top-usage TEAMMATE is out" is false when the top-usage player is you.
    """
    # arrange - reconstruct the eligible usage hierarchy the same way the feature does
    eligible = feats[
        feats[USAGE_COLUMN].notna()
        & (feats["n_appearances"].fillna(0) >= STAR_USAGE_MIN_APPEARANCES)
    ]
    top = eligible.loc[
        eligible.groupby(["GAME_ID", "TEAM_ID"])[USAGE_COLUMN].idxmax()
    ]
    assert len(top) > 50

    # act
    absent_leaders = top[top["PLAYED"] == 0]

    # assert
    assert (top["star_out"] == 0).all(), (
        "a team's own usage leader was flagged star_out - his own absence leaked "
        "into his own feature"
    )
    assert len(absent_leaders) > 0, "no usage leader is ever absent, so this is vacuous"


def test_star_out_fires_for_the_teammates_of_an_absent_leader(feats):
    """the positive case, so the flag is not simply always zero."""
    # arrange
    eligible = feats[
        feats[USAGE_COLUMN].notna()
        & (feats["n_appearances"].fillna(0) >= STAR_USAGE_MIN_APPEARANCES)
    ]
    top = eligible.loc[eligible.groupby(["GAME_ID", "TEAM_ID"])[USAGE_COLUMN].idxmax()]
    absent_leader = top[top["PLAYED"] == 0].iloc[0]

    # act
    mates = feats[
        (feats["GAME_ID"] == absent_leader["GAME_ID"])
        & (feats["TEAM_ID"] == absent_leader["TEAM_ID"])
        & (feats["PLAYER_ID"] != absent_leader["PLAYER_ID"])
    ]

    # assert
    assert (mates["star_out"] == 1).all()
    assert absent_leader["star_out"] == 0


def test_the_usage_hierarchy_gate_rejects_thin_history(feats):
    """a three-game 40%-usage rookie must not define his team's usage hierarchy."""
    # arrange + act
    thin = feats[feats["n_appearances"].fillna(0) < STAR_USAGE_MIN_APPEARANCES]
    assert len(thin) > 0

    # assert - the gate is on the CANDIDATE, so a thin-history player's own absence
    # never sets his teammates' star_out. reconstruct and compare.
    for (game_id, team_id), group in thin.groupby(["GAME_ID", "TEAM_ID"]):
        others = feats[(feats["GAME_ID"] == game_id) & (feats["TEAM_ID"] == team_id)]
        established = others[
            others[USAGE_COLUMN].notna()
            & (others["n_appearances"].fillna(0) >= STAR_USAGE_MIN_APPEARANCES)
        ]
        if established.empty and (group["PLAYED"] == 0).any():
            assert (others["star_out"] == 0).all(), (
                "with no established player on the roster, star_out must be 0 "
                "regardless of who is out"
            )
            return
    assert STAR_USAGE_MIN_APPEARANCES >= 15


# ---------------------------------------------------------------------------
# 6. positions
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("position", "expected"),
    [
        ("PG,SG", "G"), ("SG,SF", "G"), ("SF,PF", "F"), ("PF,C", "F"), ("C", "C"),
        ("pg", "G"), (" SF , PF ", "F"), ("G", "G"),
        (None, None), ("", None), ("XX", None), ("C,PF", "C"),
    ],
)
def test_position_group_takes_the_first_listed_position(position, expected):
    # act
    result = position_group(pd.Series([position], dtype="object")).iloc[0]

    # assert
    if expected is None:
        assert pd.isna(result)
    else:
        assert result == expected


def test_positional_features_are_null_without_a_position(feats):
    """emit null, never a guess. LightGBM handles missing; a wrong bucket it cannot."""
    # arrange
    unknown = feats[feats["POS_GROUP"].isna()]
    known = feats[feats["POS_GROUP"].notna()]
    assert len(unknown) > 0, "the fixtures must leave some players without a position"
    assert len(known) > 0

    # act + assert
    assert unknown["vacated_minutes_pos"].isna().all()
    assert unknown["depth_rank_available_pos"].isna().all()
    # the non-positional half is unaffected
    assert unknown["vacated_minutes"].notna().all()
    assert unknown["depth_rank_available"].notna().all()
    assert known["depth_rank_available_pos"].notna().all()


def test_positional_vacated_minutes_never_exceeds_the_total(feats):
    """a subset sum cannot beat the whole sum."""
    # act
    have = feats[feats["vacated_minutes_pos"].notna()]

    # assert
    assert (have["vacated_minutes_pos"] <= have["vacated_minutes"] + 1e-9).all()
    assert (have["depth_rank_available_pos"] <= have["depth_rank_available"]).all()
    # and the positional filter actually bites on a decent share of rows
    assert (have["vacated_minutes_pos"] < have["vacated_minutes"] - 1e-9).mean() > 0.5


# ---------------------------------------------------------------------------
# 7. structural / contract
# ---------------------------------------------------------------------------
def test_the_served_teammate_columns_are_features_and_the_oracle_ones_are_not():
    """the contract that replaced the v2 one, and it needs stating twice over.

    the per-minute rate columns were added without a FEATURE_VERSION bump precisely
    because they are not predictors. The teammate-context columns ARE predictors, so
    the version has to move whenever the family changes - and in v3 it changed in the
    strongest possible way: the whole realized family was REMOVED from FEATURE_COLS
    and replaced by expectations.

    the oracle columns still exist, are still computed and are still on the dataset,
    because config.EVENT_COHORTS partitions on them and the evaluation bracket needs
    them as its upper bound. Being on the dataset and being a feature are different
    facts, and this test is where the difference is pinned.
    """
    # act + assert
    assert FEATURE_VERSION == "v3"
    assert set(TEAMMATE_FEATURE_COLS) <= set(FEATURE_COLS)
    # the realized family is available to the evaluator and invisible to every model
    # in the promoted path
    assert not (set(TEAMMATE_ORACLE_COLS) & set(FEATURE_COLS)), (
        "a realized-absence column is in FEATURE_COLS: the served models can read "
        "other players' target-game labels"
    )
    assert set(TEAMMATE_ORACLE_COLS) == set(FEATURE_SETS[ORACLE_FEATURE_SET]) - set(
        FEATURE_SETS["v1"]
    ) - {"usg_ewma"}
    assert len(TEAMMATE_ORACLE_COLS) == 8
    assert len(TEAMMATE_EXPECTED_COLS) == 8


def test_the_absence_flag_is_never_a_feature():
    """LISTED_INACTIVE is the complement of PLAYED on this truth layer.

    handing it to the availability model would be handing it the answer.
    """
    # act + assert
    assert "LISTED_INACTIVE" in TARGET_COLS
    assert "LISTED_INACTIVE" not in FEATURE_COLS
    assert not TARGET_COLS & set(FEATURE_COLS)


def test_a_quiet_game_vacates_nothing():
    """the zero case, on a hand-built team-game where everyone plays."""
    # arrange
    frame = pd.DataFrame({
        "GAME_ID": ["g1"] * 3,
        "TEAM_ID": ["t1"] * 3,
        "PLAYER_ID": ["p1", "p2", "p3"],
        "PLAYED": [1, 1, 1],
        "LISTED_INACTIVE": [False, False, False],
        "POS_GROUP": ["G", "G", "F"],
        "std_MIN": [30.0, 20.0, 10.0],
        "std_FGA": [15.0, 10.0, 5.0],
        USAGE_COLUMN: [28.0, 22.0, 15.0],
        "n_appearances": [40, 40, 40],
    })

    # act
    out = vacated_features(frame)

    # assert
    for column in [*VACATED_COLS, "vacated_minutes_pos"]:
        assert (out[column] == 0).all(), f"{column} is non-zero with nobody out"
    assert (out["star_out"] == 0).all()
    assert (out["top3_usage_out_count"] == 0).all()
    assert out["depth_rank_available"].tolist() == [1.0, 2.0, 3.0]
    # within the guard bucket p1 leads p2; the lone forward leads his own
    assert out["depth_rank_available_pos"].tolist() == [1.0, 2.0, 1.0]


def test_a_teammate_without_season_history_contributes_zero_not_nan():
    """one rookie's first night must not null out a whole team-game's sum."""
    # arrange
    frame = pd.DataFrame({
        "GAME_ID": ["g1"] * 3,
        "TEAM_ID": ["t1"] * 3,
        "PLAYER_ID": ["p1", "p2", "rookie"],
        "PLAYED": [1, 0, 0],
        "LISTED_INACTIVE": [False, True, True],
        "POS_GROUP": ["G", "G", "G"],
        "std_MIN": [30.0, 24.0, np.nan],
        "std_FGA": [15.0, 12.0, np.nan],
        USAGE_COLUMN: [28.0, 22.0, np.nan],
        "n_appearances": [40, 40, 1],
    })

    # act
    out = vacated_features(frame)

    # assert
    assert out.loc[0, "vacated_minutes"] == pytest.approx(24.0)
    assert out.loc[0, "vacated_usg"] == pytest.approx(22.0)
    # the rookie's own row sums only the OTHER absent player
    assert out.loc[2, "vacated_minutes"] == pytest.approx(24.0)
    # and p2's own row excludes himself, leaving the rookie's zero
    assert out.loc[1, "vacated_minutes"] == pytest.approx(0.0)


def test_the_family_is_computable_for_every_scheduled_row(feats):
    """these describe the GAME, not the outcome, so no row may be structurally null.

    the two positional columns are the documented exception - null when the player
    has no listed position - and their null rate must be exactly the POS_GROUP null
    rate, not one row more.
    """
    # act + assert
    for column in [*VACATED_COLS, "depth_rank_available", "star_out",
                   "top3_usage_out_count"]:
        assert feats[column].notna().all(), f"{column} is null on some scheduled row"
    pos_null = feats["POS_GROUP"].isna()
    for column in ("vacated_minutes_pos", "depth_rank_available_pos"):
        assert feats[column].isna().equals(pos_null), (
            f"{column} is null on rows that DO have a position bucket"
        )


# ---------------------------------------------------------------------------
# 8. the negative control the report leans on
# ---------------------------------------------------------------------------
def test_a_permuted_vacated_minutes_column_shows_no_cohort_lift(feats):
    """the report claims the real column carries signal. this is the null.

    a randomly permuted copy of ``vacated_minutes`` must define cohorts whose mean
    minutes is indistinguishable from the population's, while the real column's
    high-vacancy cohort must plainly differ. If the permuted column showed lift
    too, the cohort machinery itself would be the thing generating the finding.
    """
    # arrange
    played = feats[feats["PLAYED"] == 1].reset_index(drop=True)
    rng = np.random.default_rng(17)
    permuted = played["vacated_minutes"].to_numpy()[
        rng.permutation(len(played))
    ]
    overall = float(played["MIN"].mean())

    # act
    real_high = played[played["vacated_minutes"] >= 30]["MIN"].mean()
    fake_high = played[permuted >= 30]["MIN"].mean()

    # assert
    assert len(played[played["vacated_minutes"] >= 30]) > 100
    assert abs(fake_high - overall) < 0.5, (
        f"the permuted column's cohort mean minutes ({fake_high:.2f}) differs from "
        f"the population mean ({overall:.2f}) - the cohort split is not a null"
    )
    assert abs(real_high - overall) > abs(fake_high - overall), (
        "the real vacated_minutes cohort is no more distinctive than a permutation"
    )
