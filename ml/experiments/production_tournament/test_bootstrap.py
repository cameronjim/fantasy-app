"""unit tests for the decision machinery: block sums, the bootstrap, Holm.

the important tests here are the two nulls. a bootstrap that reports a significant
improvement for two IDENTICAL prediction vectors is worthless, and a bootstrap that
cannot separate a real effect from noise is equally worthless; both directions are
asserted, because the whole promotion decision is one call into this module.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from .bootstrap import (
    BLOCK_DAYS,
    _block_sums,
    date_aggregate,
    holm_bonferroni,
    moving_block_bootstrap,
)


def synthetic(n_dates: int = 60, rows_per_date: int = 40, effect: float = 0.0,
              seed: int = 0, origins: int = 2) -> dict[str, object]:
    """paired errors with a controllable systematic edge for the challenger."""
    rng = np.random.default_rng(seed)
    dates, origin_labels = [], []
    per_origin = n_dates // origins
    for o in range(origins):
        start = pd.Timestamp("2025-01-01") + pd.Timedelta(days=400 * o)
        for d in range(per_origin):
            dates.extend([start + pd.Timedelta(days=d)] * rows_per_date)
            origin_labels.extend([f"O{o}"] * rows_per_date)
    n = len(dates)
    base = np.abs(rng.normal(4.0, 1.0, n))
    delta = effect * base + rng.normal(0.0, 0.5, n)
    return {"delta": delta, "base_abs": base,
            "dates": pd.Series(dates), "origins": pd.Series(origin_labels)}


# ---------------------------------------------------------------------------
# block sums
# ---------------------------------------------------------------------------
def test_block_sums_enumerates_every_overlapping_start():
    values = np.arange(1.0, 6.0)  # 1..5
    got = _block_sums(values, 3)
    assert np.allclose(got, [6.0, 9.0, 12.0])  # 1+2+3, 2+3+4, 3+4+5


def test_block_sums_short_series_is_one_block_of_everything():
    values = np.arange(1.0, 4.0)
    assert np.allclose(_block_sums(values, 7), [6.0])


def test_block_sums_empty():
    assert _block_sums(np.zeros(0), 7).size == 0


# ---------------------------------------------------------------------------
# date aggregation
# ---------------------------------------------------------------------------
def test_date_aggregate_collapses_rows_and_keeps_the_totals():
    data = synthetic(n_dates=10, rows_per_date=5, origins=1)
    agg = date_aggregate(data["delta"], data["base_abs"], data["dates"], data["origins"])
    assert len(agg) == 10
    assert agg["rows"].sum() == 50
    assert agg["delta"].sum() == pytest.approx(float(np.sum(data["delta"])))
    assert agg["base_abs"].sum() == pytest.approx(float(np.sum(data["base_abs"])))


def test_date_aggregate_keeps_origins_separate():
    data = synthetic(n_dates=20, rows_per_date=3, origins=2)
    agg = date_aggregate(data["delta"], data["base_abs"], data["dates"], data["origins"])
    assert set(agg["origin"]) == {"O0", "O1"}
    assert len(agg) == 20


# ---------------------------------------------------------------------------
# THE NULLS
# ---------------------------------------------------------------------------
def test_identical_predictions_give_exactly_zero_and_a_p_of_one():
    """NEGATIVE CONTROL. no delta anywhere: theta must be 0 and nothing may be claimed."""
    data = synthetic(n_dates=60, rows_per_date=40)
    data["delta"] = np.zeros_like(data["base_abs"])
    result = moving_block_bootstrap(**data)
    assert result.theta == pytest.approx(0.0)
    assert result.lo == pytest.approx(0.0)
    assert result.hi == pytest.approx(0.0)
    assert result.p_value == pytest.approx(1.0)
    assert not result.ci_excludes_zero
    assert not result.clears(0.02)


def test_pure_noise_does_not_clear_the_bar():
    """a zero-mean delta must not produce a significant interval."""
    data = synthetic(n_dates=60, rows_per_date=40, effect=0.0, seed=11)
    result = moving_block_bootstrap(**data)
    assert abs(result.theta) < 0.02
    assert not result.clears(0.02)


def test_a_real_five_percent_edge_is_detected():
    data = synthetic(n_dates=60, rows_per_date=40, effect=0.05, seed=5)
    result = moving_block_bootstrap(**data)
    assert result.theta == pytest.approx(0.05, abs=0.02)
    assert result.ci_excludes_zero
    assert result.clears(0.02)
    assert result.p_value < 0.05


def test_a_one_percent_edge_fails_the_practical_floor_even_if_significant():
    """the two halves of the rule are independent, and the floor is the binding one."""
    data = synthetic(n_dates=60, rows_per_date=200, effect=0.01, seed=7)
    result = moving_block_bootstrap(**data)
    assert result.theta < 0.02
    assert not result.clears(0.02)


def test_a_regression_is_reported_as_a_negative_theta():
    data = synthetic(n_dates=60, rows_per_date=40, effect=-0.06, seed=3)
    result = moving_block_bootstrap(**data)
    assert result.theta < 0
    assert result.ci_excludes_zero
    assert not result.clears(0.02)  # significantly WORSE is not a promotion


# ---------------------------------------------------------------------------
# the block structure has to matter
# ---------------------------------------------------------------------------
def test_block_bootstrap_is_wider_than_a_one_day_block_under_date_clustering():
    """the reason for blocks at all: serially correlated dates inflate a naive CI.

    the delta is given a slow drift so that neighbouring dates are correlated. a
    7-day-block resample must produce an interval at least as wide as a 1-day one,
    which is the whole point of preserving the dependence.
    """
    rng = np.random.default_rng(2)
    n_dates, rows = 84, 30
    drift = np.cumsum(rng.normal(0.0, 0.25, n_dates))
    dates, origins, delta, base = [], [], [], []
    for d in range(n_dates):
        day = pd.Timestamp("2025-01-01") + pd.Timedelta(days=d)
        dates.extend([day] * rows)
        origins.extend(["O0"] * rows)
        delta.extend(rng.normal(drift[d], 0.3, rows))
        base.extend(np.abs(rng.normal(4.0, 1.0, rows)))
    kwargs = {"delta": np.array(delta), "base_abs": np.array(base),
              "dates": pd.Series(dates), "origins": pd.Series(origins)}
    wide = moving_block_bootstrap(**kwargs, block=BLOCK_DAYS, seed=1)
    narrow = moving_block_bootstrap(**kwargs, block=1, seed=1)
    assert (wide.hi - wide.lo) > (narrow.hi - narrow.lo)


def test_seed_is_deterministic():
    data = synthetic(n_dates=40, rows_per_date=20, effect=0.03, seed=9)
    a = moving_block_bootstrap(**data, seed=17)
    b = moving_block_bootstrap(**data, seed=17)
    c = moving_block_bootstrap(**data, seed=18)
    assert (a.lo, a.hi) == (b.lo, b.hi)
    assert (a.lo, a.hi) != (c.lo, c.hi)


def test_reported_counts_match_the_input():
    data = synthetic(n_dates=40, rows_per_date=20, origins=2)
    result = moving_block_bootstrap(**data)
    assert result.n_rows == 40 * 20
    assert result.n_dates == 40


def test_empty_input_reports_nan_rather_than_a_pass():
    result = moving_block_bootstrap(
        np.zeros(0), np.zeros(0), pd.Series([], dtype="datetime64[ns]"),
        pd.Series([], dtype=object),
    )
    assert np.isnan(result.theta)
    assert not result.ci_excludes_zero
    assert not result.clears(0.02)


# ---------------------------------------------------------------------------
# Holm-Bonferroni
# ---------------------------------------------------------------------------
def test_holm_rejects_only_the_smallest_p_when_the_rest_are_large():
    got = holm_bonferroni({"a": 0.001, "b": 0.30, "c": 0.40, "d": 0.90})
    assert got == {"a": True, "b": False, "c": False, "d": False}


def test_holm_step_down_is_more_powerful_than_plain_bonferroni():
    """m = 3: 0.001 <= 0.05/3 rejects, then 0.02 <= 0.05/2 rejects too.

    plain Bonferroni would test both against 0.05/3 = 0.0167 and keep 0.02. that
    difference is the reason Holm is the correction this report uses.
    """
    got = holm_bonferroni({"a": 0.02, "b": 0.001, "c": 0.30})
    assert got == {"b": True, "a": True, "c": False}


def test_holm_step_down_stops_at_the_first_failure():
    """once a step fails, nothing with a LARGER p may be rejected however small alpha/k gets.

    m = 3, alpha = 0.05: 0.03 > 0.05/3 = 0.0167 fails at the first step, so 0.04 must
    not be rejected even though 0.04 <= 0.05/2 = 0.025 is false anyway - and neither
    may 0.006, which sorts first and DOES pass. the ordering is what makes the third
    entry's fate depend on the first.
    """
    got = holm_bonferroni({"a": 0.03, "b": 0.04, "c": 0.20})
    assert got == {"a": False, "b": False, "c": False}
    # the same family with one tiny p: the tiny one is rejected, the rest still are not
    got = holm_bonferroni({"a": 0.03, "b": 0.04, "c": 0.0001})
    assert got == {"c": True, "a": False, "b": False}


def test_holm_is_stricter_than_the_uncorrected_threshold():
    """an uncorrected 0.04 is 'significant'; with eight candidates it is not."""
    p = {f"m{i}": 0.04 for i in range(8)}
    assert not any(holm_bonferroni(p).values())


def test_holm_rejects_everything_when_every_p_is_tiny():
    p = {f"m{i}": 1e-6 for i in range(8)}
    assert all(holm_bonferroni(p).values())


def test_holm_on_an_empty_family():
    assert holm_bonferroni({}) == {}
