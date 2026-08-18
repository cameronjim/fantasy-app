"""unit tests for the tournament's estimator math. PURE FUNCTIONS, NEGATIVE CONTROLS.

every test that asserts a property also asserts, where it is cheap, that the property
is not vacuous - the "negative control" pattern the rest of the package uses. a test
that says "the minutes-weighted rate equals the ratio of decayed sums" is worth little
without a companion showing that the ratio of decayed sums is NOT the plain EWMA
whenever minutes vary, because otherwise the two estimators are the same estimator and
the bracket has one fewer member than it claims.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.config import RATE_MINUTES_FLOOR
from fnba_ml.features import per_minute_rate_features

from .rates import (
    HALFLIVES,
    INCUMBENT_HALFLIFE,
    RATE_N,
    SCHEME_MINUTES_WEIGHTED,
    SCHEME_PLAIN,
    attach_rate_columns,
    build_rate_columns,
    ewma_rate,
    minutes_weighted_ewma_rate,
    per_game_rate,
    position_priors,
    prior_vector,
    rate_column,
    rate_row_set,
    shrink_toward_prior,
)


# ---------------------------------------------------------------------------
# fixtures: a tiny hand-checkable appearance history
# ---------------------------------------------------------------------------
def toy_frame() -> pd.DataFrame:
    """two players, one of whom has a garbage-time cameo and a starter's night."""
    return pd.DataFrame({
        "PLAYER_ID": ["a", "a", "a", "b", "b", "b"],
        "GAME_ID": ["1", "2", "3", "1", "2", "3"],
        "GAME_DATE": pd.to_datetime(
            ["2024-01-01", "2024-01-03", "2024-01-05"] * 2
        ),
        "PLAYED": [1, 1, 1, 1, 1, 1],
        "MIN": [2.0, 36.0, 30.0, 20.0, 20.0, 20.0],
        "PTS": [3.0, 18.0, 20.0, 10.0, 10.0, 10.0],
        "AST": [0.0, 6.0, 4.0, 2.0, 2.0, 2.0],
        "POS_GROUP": ["G", "G", "G", "C", "C", "C"],
    })


def decayed_ratio(stat, weight, halflife: float) -> np.ndarray:
    """the definition, by an explicit loop. the reference the identity is tested against."""
    lam = 0.5 ** (1.0 / halflife)
    out = np.empty(len(stat))
    for n in range(len(stat)):
        k = np.arange(n, -1, -1)
        decay = lam ** k
        out[n] = float(np.sum(decay * np.asarray(stat[: n + 1]))
                       / np.sum(decay * np.asarray(weight[: n + 1])))
    return out


# ---------------------------------------------------------------------------
# the per-game observation
# ---------------------------------------------------------------------------
def test_per_game_rate_floors_the_denominator_not_the_rows():
    stat = np.array([3.0, 18.0])
    minutes = np.array([2.0, 36.0])
    got = per_game_rate(stat, minutes)
    # the cameo is KEPT (it is not filtered out) but its implied rate is capped by the
    # floor at 3/4 rather than 3/2
    assert got[0] == pytest.approx(3.0 / RATE_MINUTES_FLOOR)
    assert got[1] == pytest.approx(0.5)


def test_per_game_rate_negative_control_unfloored_would_be_absurd():
    """the floor is doing work: without it the cameo's rate is off the scale."""
    unfloored = 3.0 / 2.0
    floored = per_game_rate([3.0], [2.0])[0]
    assert floored < unfloored
    # 0.75 pts/min is around the 99th percentile of real per-minute scoring; 1.5 is not
    # a rate any NBA player sustains
    assert floored <= 0.75


# ---------------------------------------------------------------------------
# the plain EWMA
# ---------------------------------------------------------------------------
def test_ewma_rate_is_per_player_and_never_crosses_players():
    values = np.array([1.0, 1.0, 1.0, 100.0, 100.0, 100.0])
    groups = np.array(["a", "a", "a", "b", "b", "b"])
    got = ewma_rate(values, groups, 5.0)
    assert np.allclose(got[:3], 1.0)
    assert np.allclose(got[3:], 100.0)


def test_ewma_rate_first_row_is_the_first_observation():
    """an inclusive EWMA starts AT the observation; the as-of join supplies the shift."""
    got = ewma_rate([0.4, 0.9], ["a", "a"], 5.0)
    assert got[0] == pytest.approx(0.4)
    assert 0.4 < got[1] < 0.9


@pytest.mark.parametrize("halflife", HALFLIVES)
def test_ewma_rate_matches_pandas_definition(halflife):
    values = np.array([0.1, 0.9, 0.4, 0.7, 0.2])
    expected = pd.Series(values).ewm(halflife=halflife, adjust=True).mean().to_numpy()
    assert np.allclose(ewma_rate(values, np.array(["a"] * 5), halflife), expected)


def test_shorter_halflife_tracks_a_step_change_faster():
    """the axis being swept has to actually do something, monotonically."""
    values = np.array([0.2] * 10 + [0.8] * 3)
    groups = np.array(["a"] * 13)
    tail = [ewma_rate(values, groups, h)[-1] for h in (3.0, 5.0, 8.0, 12.0, 20.0)]
    assert tail == sorted(tail, reverse=True)
    assert tail[0] > tail[-1] + 0.05


# ---------------------------------------------------------------------------
# the minutes-weighted EWMA: the identity and its negative control
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("halflife", HALFLIVES)
def test_minutes_weighted_equals_ratio_of_decayed_sums(halflife):
    """the identity the two-line implementation rests on, against an explicit loop."""
    frame = toy_frame()
    a = frame[frame["PLAYER_ID"] == "a"]
    weight = np.clip(a["MIN"].to_numpy(dtype=float), RATE_MINUTES_FLOOR, None)
    expected = decayed_ratio(a["PTS"].to_numpy(dtype=float), weight, halflife)
    got = minutes_weighted_ewma_rate(
        a["PTS"], a["MIN"], a["PLAYER_ID"], halflife
    )
    assert np.allclose(got, expected)


def test_minutes_weighted_differs_from_plain_when_minutes_vary():
    """NEGATIVE CONTROL: if these agreed, the bracket would have a duplicate member."""
    frame = toy_frame()
    a = frame[frame["PLAYER_ID"] == "a"]
    r = per_game_rate(a["PTS"], a["MIN"])
    plain = ewma_rate(r, a["PLAYER_ID"], 5.0)
    weighted = minutes_weighted_ewma_rate(a["PTS"], a["MIN"], a["PLAYER_ID"], 5.0)
    assert not np.allclose(plain, weighted)
    # and the direction is the one the method is FOR: the 2-minute cameo's inflated
    # 0.75 pts/min drags the unweighted average up, so weighting pulls the estimate down
    assert weighted[-1] < plain[-1]


def test_minutes_weighted_equals_plain_when_all_minutes_are_equal():
    """the other half of the control: with constant weights the two must coincide."""
    frame = toy_frame()
    b = frame[frame["PLAYER_ID"] == "b"]
    r = per_game_rate(b["PTS"], b["MIN"])
    plain = ewma_rate(r, b["PLAYER_ID"], 8.0)
    weighted = minutes_weighted_ewma_rate(b["PTS"], b["MIN"], b["PLAYER_ID"], 8.0)
    assert np.allclose(plain, weighted)


def test_minutes_weighted_never_crosses_players():
    frame = toy_frame()
    got = minutes_weighted_ewma_rate(
        frame["PTS"], frame["MIN"], frame["PLAYER_ID"], 5.0
    )
    b_only = minutes_weighted_ewma_rate(
        frame[frame["PLAYER_ID"] == "b"]["PTS"],
        frame[frame["PLAYER_ID"] == "b"]["MIN"],
        frame[frame["PLAYER_ID"] == "b"]["PLAYER_ID"], 5.0,
    )
    assert np.allclose(got[3:], b_only)


# ---------------------------------------------------------------------------
# empirical-Bayes shrinkage
# ---------------------------------------------------------------------------
def test_shrinkage_k_zero_is_the_identity():
    rate = np.array([0.2, 0.9])
    got = shrink_toward_prior(rate, np.array([1.0, 40.0]), np.array([0.5, 0.5]), 0.0)
    assert np.allclose(got, rate)


def test_shrinkage_with_no_history_returns_the_prior():
    got = shrink_toward_prior(np.array([0.9]), np.array([0.0]), np.array([0.45]), 10.0)
    assert got[0] == pytest.approx(0.45)


def test_shrinkage_of_a_null_rate_returns_the_prior():
    got = shrink_toward_prior(np.array([np.nan]), np.array([25.0]), np.array([0.45]), 10.0)
    assert got[0] == pytest.approx(0.45)


def test_shrinkage_half_weight_is_exactly_at_n_equals_k():
    got = shrink_toward_prior(np.array([1.0]), np.array([10.0]), np.array([0.0]), 10.0)
    assert got[0] == pytest.approx(0.5)


def test_shrinkage_is_monotone_in_k_and_in_n():
    rate, prior = np.array([1.0]), np.array([0.0])
    by_k = [shrink_toward_prior(rate, np.array([20.0]), prior, k)[0]
            for k in (0.0, 2.0, 5.0, 10.0, 20.0, 50.0)]
    assert by_k == sorted(by_k, reverse=True)
    by_n = [shrink_toward_prior(rate, np.array([n]), prior, 10.0)[0]
            for n in (0.0, 5.0, 20.0, 100.0)]
    assert by_n == sorted(by_n)


def test_shrinkage_rejects_a_negative_k():
    with pytest.raises(ValueError, match="non-negative"):
        shrink_toward_prior(np.array([1.0]), np.array([1.0]), np.array([0.0]), -1.0)


# ---------------------------------------------------------------------------
# the position prior
# ---------------------------------------------------------------------------
def test_position_prior_is_a_weighted_rate_not_a_mean_of_ratios():
    """NEGATIVE CONTROL against the mistake models.PerMinuteRate's docstring warns about."""
    rows = pd.DataFrame({
        "MIN": [2.0, 38.0],
        "PTS": [3.0, 19.0],
        "POS_GROUP": ["G", "G"],
    })
    _, league = position_priors(rows, "PTS", min_rows=1)
    weighted = (3.0 + 19.0) / (RATE_MINUTES_FLOOR + 38.0)
    mean_of_ratios = np.mean([3.0 / RATE_MINUTES_FLOOR, 19.0 / 38.0])
    assert league == pytest.approx(weighted)
    assert league < mean_of_ratios


def test_position_prior_gate_sends_thin_groups_to_the_league_rate():
    rows = toy_frame()
    priors, league = position_priors(rows, "PTS", min_rows=500)
    assert priors == {}
    frame = pd.DataFrame({"POS_GROUP": ["G", "C", None]})
    assert np.allclose(prior_vector(frame, priors, league), league)


def test_position_prior_uses_its_own_group_when_the_gate_passes():
    rows = toy_frame()
    priors, league = position_priors(rows, "PTS", min_rows=1)
    assert set(priors) == {"G", "C"}
    got = prior_vector(pd.DataFrame({"POS_GROUP": ["G", "C", None]}), priors, league)
    assert got[0] == pytest.approx(priors["G"])
    assert got[1] == pytest.approx(priors["C"])
    assert got[2] == pytest.approx(league)  # unknown position -> league, not a group


# ---------------------------------------------------------------------------
# the row set and the as-of join: the leakage guard
# ---------------------------------------------------------------------------
def test_rate_row_set_drops_non_appearances_and_zero_minute_lines():
    frame = toy_frame()
    frame.loc[6] = {**frame.iloc[0].to_dict(), "PLAYED": 0, "MIN": 0.0, "GAME_ID": "4"}
    frame.loc[7] = {**frame.iloc[0].to_dict(), "PLAYED": 1, "MIN": 0.0, "GAME_ID": "5"}
    rows = rate_row_set(frame)
    assert len(rows) == 6
    assert (rows["MIN"] > 0).all()
    assert (rows["PLAYED"] == 1).all()


def test_asof_join_excludes_the_rows_own_game():
    """THE LEAKAGE GUARD. a row's rate must not contain the row's own outcome.

    player b scores exactly 0.5 pts/min every night, so his second game's as-of rate
    must be his FIRST game's value and his first game's must be null. if the join
    allowed exact matches, game 1 would carry a rate.
    """
    frame = toy_frame()
    joined = attach_rate_columns(frame, build_rate_columns(frame))
    col = rate_column(SCHEME_PLAIN, "PTS", INCUMBENT_HALFLIFE)
    b = joined[joined["PLAYER_ID"] == "b"].sort_values("GAME_DATE")
    assert pd.isna(b[col].iloc[0])
    assert b[col].iloc[1] == pytest.approx(0.5)
    assert pd.isna(b[RATE_N].iloc[0])
    assert b[RATE_N].iloc[1] == 1
    assert b[RATE_N].iloc[2] == 2


def test_asof_join_negative_control_a_spike_cannot_reach_its_own_row():
    """give player b a 40-point night and check the same row's rate does not move."""
    frame = toy_frame()
    baseline = attach_rate_columns(frame, build_rate_columns(frame))
    spiked = frame.copy()
    spiked.loc[spiked.index[-1], "PTS"] = 400.0
    after = attach_rate_columns(spiked, build_rate_columns(spiked))
    col = rate_column(SCHEME_PLAIN, "PTS", INCUMBENT_HALFLIFE)
    assert np.allclose(
        baseline[col].fillna(-1).to_numpy(), after[col].fillna(-1).to_numpy()
    )


def test_join_preserves_the_callers_row_order():
    frame = toy_frame().sample(frac=1.0, random_state=3).reset_index(drop=True)
    joined = attach_rate_columns(frame, build_rate_columns(frame))
    assert list(joined["GAME_ID"]) == list(frame["GAME_ID"])
    assert list(joined["PLAYER_ID"]) == list(frame["PLAYER_ID"])


def test_build_rate_columns_covers_every_scheme_target_and_halflife():
    frame = toy_frame()
    built = build_rate_columns(frame)
    for scheme in (SCHEME_PLAIN, SCHEME_MINUTES_WEIGHTED):
        for target in ("PTS", "AST"):
            for h in HALFLIVES:
                assert rate_column(scheme, target, h) in built.columns
    assert RATE_N in built.columns


# ---------------------------------------------------------------------------
# the reproduction claim the whole halflife sweep rests on
# ---------------------------------------------------------------------------
def test_halflife_5_reproduces_the_shipped_estimator_exactly():
    """the sweep must be a sweep of the INCUMBENT'S estimator, not of a lookalike.

    ``features.per_minute_rate_features`` is the shipped construction. at halflife 5
    this module must reproduce it to floating-point equality, or every halflife number
    in the report is measuring the reimplementation instead of the halflife.
    """
    frame = toy_frame()
    shipped = per_minute_rate_features(frame)
    mine = build_rate_columns(frame)
    for target in ("PTS", "AST"):
        assert np.allclose(
            shipped[f"ewma_{target}_per_min"].to_numpy(dtype=float),
            mine[rate_column(SCHEME_PLAIN, target, INCUMBENT_HALFLIFE)].to_numpy(dtype=float),
        )
