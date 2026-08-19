"""unit tests for the tournament's shared plumbing: the inner fold and the fallback.

these are the two places where a bug would not crash the run but WOULD invalidate
every number in it:

  * an inner fold that overlaps the reported validation window means every
    hyperparameter was chosen on the rows it is then scored on, and the report's
    "one look" claim is false while the table still looks sensible;
  * a fallback that differs between methods lets a method win on the 3.8% of rows
    where nobody has any history, which has nothing to do with rate estimation.

both get a negative control. no test here fits a booster - that is the runner's job
and it needs the real frame.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.config import P_CONTEXT

from .crossfit import OOF_MIN, minutes_fallback
from .methods import (
    INCUMBENT,
    INNER_DAYS,
    OriginContext,
    RateMethod,
    build_bracket,
    build_descriptive_methods,
    build_methods,
    decision_methods,
    has_rate_history,
    proxy_mae,
)
from .rates import HALFLIVES, RATE_N, SCHEME_PLAIN


def scheduled(n_days: int = 90, players: int = 4) -> pd.DataFrame:
    """a minimal scheduled frame: dates, players, outcomes, the columns the proxy needs."""
    rng = np.random.default_rng(0)
    rows = []
    for d in range(n_days):
        day = pd.Timestamp("2024-09-01") + pd.Timedelta(days=d)
        for p in range(players):
            rows.append({
                "GAME_DATE": day, "PLAYER_ID": f"p{p}", "GAME_ID": f"g{d}",
                "PLAYED": 1, "MIN": 20.0, "PTS": 10.0, "AST": 2.0,
                RATE_N: float(d + 1), P_CONTEXT: 0.8, OOF_MIN: 20.0,
            })
    frame = pd.DataFrame(rows)
    frame["PTS"] = frame["PTS"] + rng.normal(0, 1, len(frame))
    return frame


def context(frame: pd.DataFrame, vstart: str = "2024-12-01") -> OriginContext:
    vstart_ts = pd.Timestamp(vstart)
    return OriginContext(
        name="T", vstart=vstart_ts,
        train_all=frame[frame["GAME_DATE"] < vstart_ts],
        valid_all=frame[frame["GAME_DATE"] >= vstart_ts].copy(),
    )


# ---------------------------------------------------------------------------
# the inner fold
# ---------------------------------------------------------------------------
def test_inner_fold_lies_entirely_inside_the_training_window():
    """THE ONE-LOOK GUARANTEE. no inner-fold row may be a reported validation row."""
    frame = scheduled()
    ctx = context(frame)
    assert not ctx.inner_valid.empty
    assert ctx.inner_valid["GAME_DATE"].max() < ctx.vstart
    assert ctx.inner_train_rate["GAME_DATE"].max() < ctx.inner_cut
    overlap = set(map(tuple, ctx.inner_valid[["PLAYER_ID", "GAME_ID"]].to_numpy())) & set(
        map(tuple, ctx.valid_all[["PLAYER_ID", "GAME_ID"]].to_numpy())
    )
    assert overlap == set()


def test_inner_fold_is_the_last_thirty_days_of_training():
    ctx = context(scheduled())
    assert ctx.inner_cut == ctx.vstart - pd.Timedelta(days=INNER_DAYS)
    assert ctx.inner_valid["GAME_DATE"].min() >= ctx.inner_cut


def test_inner_train_and_inner_valid_are_disjoint():
    """NEGATIVE CONTROL on the split itself: a shared row would leak the selection."""
    ctx = context(scheduled())
    train_dates = set(ctx.inner_train_rate["GAME_DATE"])
    valid_dates = set(ctx.inner_valid["GAME_DATE"])
    assert train_dates & valid_dates == set()


def test_train_rate_rows_exclude_non_appearances_and_zero_minutes():
    frame = scheduled()
    frame.loc[0, "PLAYED"] = 0
    frame.loc[0, "MIN"] = 0.0
    frame.loc[1, "MIN"] = 0.0
    ctx = context(frame)
    assert len(ctx.train_rate) == len(ctx.train_all) - 2


# ---------------------------------------------------------------------------
# the selection criterion
# ---------------------------------------------------------------------------
def test_proxy_mae_is_minimised_by_the_rate_that_reproduces_the_outcome():
    """the criterion has to point at the right answer, or selection is a coin flip."""
    frame = scheduled(n_days=10)
    truth = frame["PTS"].to_numpy(dtype=float) / (0.8 * 20.0)
    scores = {
        "truth": proxy_mae(frame, "PTS", truth),
        "half": proxy_mae(frame, "PTS", truth * 0.5),
        "double": proxy_mae(frame, "PTS", truth * 2.0),
        "zero": proxy_mae(frame, "PTS", np.zeros(len(frame))),
    }
    assert scores["truth"] == pytest.approx(0.0, abs=1e-9)
    assert scores["truth"] < scores["half"] < scores["zero"]
    assert scores["truth"] < scores["double"]


def test_proxy_mae_never_reads_realized_minutes():
    """NEGATIVE CONTROL: perturbing actual MIN must not move the criterion at all."""
    frame = scheduled(n_days=10)
    rate = np.full(len(frame), 0.5)
    before = proxy_mae(frame, "PTS", rate)
    tampered = frame.copy()
    tampered["MIN"] = 48.0
    assert proxy_mae(tampered, "PTS", rate) == pytest.approx(before)


# ---------------------------------------------------------------------------
# the common terminal fallback
# ---------------------------------------------------------------------------
class _Wild(RateMethod):
    """a method that returns nonsense, to prove the fallback override is terminal."""

    name = "wild"
    label = "wild"

    def _raw_rate(self, rows: pd.DataFrame) -> np.ndarray:
        return np.full(len(rows), 999.0)


class _Null(RateMethod):
    name = "null"
    label = "null"

    def _raw_rate(self, rows: pd.DataFrame) -> np.ndarray:
        return np.full(len(rows), np.nan)


def test_rows_with_no_history_get_the_common_fallback_whatever_the_method_says():
    frame = scheduled(n_days=3)
    frame.loc[[0, 1], RATE_N] = np.nan
    for method in (_Wild(), _Null()):
        method.prepare(context(frame, "2024-09-03"), "PTS", 0.42)
        got = method.predict_rate(frame)
        assert got[0] == pytest.approx(0.42)
        assert got[1] == pytest.approx(0.42)
    assert has_rate_history(frame).tolist()[:3] == [False, False, True]


def test_a_non_finite_rate_falls_back_rather_than_propagating():
    frame = scheduled(n_days=3)
    method = _Null()
    method.prepare(context(frame, "2024-09-03"), "PTS", 0.42)
    got = method.predict_rate(frame)
    assert np.isfinite(got).all()
    assert np.allclose(got, 0.42)


def test_rates_are_clipped_at_zero():
    class _Negative(RateMethod):
        name = label = "negative"

        def _raw_rate(self, rows):
            return np.full(len(rows), -5.0)

    frame = scheduled(n_days=3)
    method = _Negative()
    method.prepare(context(frame, "2024-09-03"), "PTS", 0.42)
    assert (method.predict_rate(frame) >= 0).all()


# ---------------------------------------------------------------------------
# the bracket's shape
# ---------------------------------------------------------------------------
def test_the_bracket_has_the_pre_registered_members_and_no_duplicates():
    names = [m.name for m in build_methods()]
    assert names[0] == "M0_ewma_h5"
    assert len(names) == len(set(names)) == 9
    for expected in ("M1_ewma_hl_selected", "M2_ewma_h12", "M3_mwewma_hl_selected",
                     "M4_eb_shrunk_h5", "M5_ridge_residual", "M6_lgbm_poisson_offset",
                     "M7_lgbm_tweedie_rate", "M8_hybrid_shrunk_hl"):
        assert expected in names


def test_every_method_carries_a_human_label():
    assert all(m.label and m.label != "abstract" for m in build_bracket())


def test_no_decision_member_is_flagged_descriptive_and_vice_versa():
    """the flag is what keeps the sweep out of the Holm family; it has to be right."""
    assert all(not m.descriptive for m in build_methods())
    assert all(m.descriptive for m in build_descriptive_methods())


def test_the_descriptive_sweep_completes_the_grid_without_duplicating_the_family():
    """2 schemes x 5 halflives, minus plain h5 (M0) and plain h12 (M2) = 8 members."""
    sweep = build_descriptive_methods()
    assert len(sweep) == 8
    grid = {(m.scheme, m.halflife) for m in sweep}
    assert (SCHEME_PLAIN, 5.0) not in grid  # that is M0
    assert (SCHEME_PLAIN, 12.0) not in grid  # that is M2
    assert len(grid | {(SCHEME_PLAIN, 5.0), (SCHEME_PLAIN, 12.0)}) == 2 * len(HALFLIVES)


def test_the_bracket_names_are_unique_across_both_halves():
    names = [m.name for m in build_bracket()]
    assert len(names) == len(set(names)) == 17


def test_the_holm_family_excludes_the_incumbent_and_the_sweep():
    family = decision_methods()
    assert INCUMBENT not in family
    assert len(family) == 8
    assert not any(name.startswith("D_") for name in family)


# ---------------------------------------------------------------------------
# the cross-fit minutes fallback
# ---------------------------------------------------------------------------
def test_minutes_fallback_is_the_floored_minutes_ewma():
    frame = pd.DataFrame({"ewma_MIN": [0.0, 2.0, 25.0, np.nan]})
    got = minutes_fallback(frame, floor=4.0)
    assert np.allclose(got, [4.0, 4.0, 25.0, 4.0])


def test_minutes_fallback_is_strictly_positive_so_a_log_offset_is_finite():
    frame = pd.DataFrame({"ewma_MIN": [0.0, np.nan]})
    assert (minutes_fallback(frame) > 0).all()
    assert np.isfinite(np.log(minutes_fallback(frame))).all()
