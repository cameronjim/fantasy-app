"""decomposition math and out-of-fold discipline.

the load-bearing test in this file is
``test_in_fold_probabilities_are_rejected``: it builds a P(play) the honest way
and a P(play) the contaminated way and asserts the guard can tell them apart.
without that, every other number in the package is unfalsifiable.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.config import CHAMPIONS, ORIGINS
from fnba_ml.features import available_features
from fnba_ml.models import (
    P_PLAY,
    P_PLAY_CUTOFF,
    AvailabilityModel,
    DecomposedEstimator,
    EwmaProduction,
    LeakageError,
    brier,
    decomposed_estimate,
    out_of_fold_availability,
    quantile_coverage,
    residual_interval,
    skill_score,
    snapshot_ewma_state,
    validate_out_of_fold,
)

CUTOFF = pd.Timestamp("2024-12-01")


@pytest.fixture(scope="module")
def frame(features_status) -> pd.DataFrame:
    return features_status.sort_values("GAME_DATE").reset_index(drop=True)


@pytest.fixture(scope="module")
def feature_cols(frame) -> list[str]:
    return available_features(frame)


@pytest.fixture(scope="module")
def fitted(frame, feature_cols) -> AvailabilityModel:
    train = frame[frame["GAME_DATE"] < CUTOFF]
    return AvailabilityModel(kind=CHAMPIONS["availability"]).fit(train, feature_cols, CUTOFF)


# ---- decomposition math ----
def test_decomposition_is_the_product_of_its_parts():
    # arrange
    scored = pd.DataFrame({
        "GAME_DATE": pd.to_datetime(["2025-01-05", "2025-01-05", "2025-01-06"]),
        P_PLAY: [0.9, 0.5, 0.0],
        P_PLAY_CUTOFF: pd.to_datetime(["2025-01-01"] * 3),
    })
    conditional = np.array([20.0, 10.0, 30.0])

    # act
    result = decomposed_estimate(scored, conditional)

    # assert
    assert result == pytest.approx([18.0, 5.0, 0.0])


def test_decomposition_never_returns_a_negative_estimate():
    # arrange
    scored = pd.DataFrame({
        "GAME_DATE": pd.to_datetime(["2025-01-05"]),
        P_PLAY: [0.8],
        P_PLAY_CUTOFF: pd.to_datetime(["2025-01-01"]),
    })

    # act
    result = decomposed_estimate(scored, np.array([-4.0]))

    # assert
    assert result == pytest.approx([0.0])


def test_unconditional_estimate_is_below_the_conditional_one(frame, fitted):
    """the selection-bias correction, stated as an invariant.

    applying a conditional-on-playing estimate to every scheduled row is the
    mistake the spike measured at a 12.4% MAE penalty. multiplying by a
    probability strictly below 1 has to shrink it.
    """
    # arrange
    valid = frame[frame["GAME_DATE"] >= CUTOFF]
    ewma = EwmaProduction("PTS").fit(frame[frame["GAME_DATE"] < CUTOFF])
    scored = fitted.attach(valid)

    # act
    conditional = ewma.predict(valid)
    unconditional = decomposed_estimate(scored, conditional)

    # assert
    assert unconditional.mean() < conditional.mean()
    assert (unconditional <= conditional + 1e-9).all()


# ---- out-of-fold discipline ----
def test_out_of_fold_probabilities_validate(frame, feature_cols):
    # arrange
    origins = [(name, s, e) for name, s, e in ORIGINS
               if pd.Timestamp(s) <= frame["GAME_DATE"].max()]
    origins = origins or [("O1", "2024-12-01", "2024-12-31")]

    # act
    oof = out_of_fold_availability(frame, origins, feature_cols)

    # assert
    assert len(oof) > 0
    assert (oof[P_PLAY_CUTOFF] <= oof["GAME_DATE"]).all()
    assert validate_out_of_fold(oof) is oof


def test_in_fold_probabilities_are_rejected(frame, feature_cols):
    """the failing case, constructed deliberately.

    fit on the WHOLE frame, then score rows inside that training window. the
    stamped cutoff sits after the games being predicted, which is the signature
    of an in-fold probability, and the guard must refuse it.
    """
    # arrange
    late_cutoff = frame["GAME_DATE"].max() + pd.Timedelta(days=1)
    leaky = AvailabilityModel(kind="logistic").fit(frame, feature_cols, late_cutoff)
    contaminated = leaky.attach(frame)

    # act + assert
    with pytest.raises(LeakageError, match="IN-FOLD"):
        validate_out_of_fold(contaminated)

    with pytest.raises(LeakageError, match="IN-FOLD"):
        decomposed_estimate(contaminated, np.full(len(contaminated), 10.0))


def test_training_past_the_cutoff_is_rejected(frame, feature_cols):
    # act + assert
    with pytest.raises(LeakageError, match="on or after the cutoff"):
        AvailabilityModel(kind="logistic").fit(frame, feature_cols, CUTOFF)


def test_missing_cutoff_stamp_is_rejected():
    # arrange
    scored = pd.DataFrame({
        "GAME_DATE": pd.to_datetime(["2025-01-05"]),
        P_PLAY: [0.7],
    })

    # act + assert
    with pytest.raises(LeakageError, match="missing column"):
        validate_out_of_fold(scored)


def test_null_probability_is_rejected():
    # arrange
    scored = pd.DataFrame({
        "GAME_DATE": pd.to_datetime(["2025-01-05"]),
        P_PLAY: [np.nan],
        P_PLAY_CUTOFF: pd.to_datetime(["2025-01-01"]),
    })

    # act + assert
    with pytest.raises(LeakageError, match="null P\\(play\\)"):
        validate_out_of_fold(scored)


# ---- champion behaviour ----
def test_production_champion_is_not_a_trained_model():
    """pins REPORT.md section 6: no production ML in the promoted path."""
    # act + assert
    assert CHAMPIONS["production"] == "ewma"
    assert CHAMPIONS["minutes"] == "ewma"
    assert CHAMPIONS["availability"] == "lightgbm"


def test_ewma_champion_reads_the_precomputed_column(frame):
    # arrange
    train = frame[frame["GAME_DATE"] < CUTOFF]
    valid = frame[(frame["GAME_DATE"] >= CUTOFF) & frame["ewma_PTS"].notna()]
    ewma = EwmaProduction("PTS").fit(train)

    # act
    pred = ewma.predict(valid)

    # assert
    assert pred == pytest.approx(valid["ewma_PTS"].to_numpy(), abs=1e-9)
    assert ewma.fallback == pytest.approx(train[train["PLAYED"] == 1]["PTS"].mean())


def test_ewma_fallback_fills_players_without_history(frame):
    # arrange
    train = frame[frame["GAME_DATE"] < CUTOFF]
    no_history = frame[frame["ewma_PTS"].isna()]
    assert len(no_history) > 0
    ewma = EwmaProduction("PTS").fit(train)

    # act
    pred = ewma.predict(no_history)

    # assert
    assert np.allclose(pred, ewma.fallback)


def test_ewma_state_snapshot_is_as_of_the_cutoff(frame):
    # act
    state = snapshot_ewma_state(frame, CUTOFF)

    # assert
    assert (state["AS_OF"] < CUTOFF).all()
    assert state["PLAYER_ID"].is_unique
    assert "ewma_PTS" in state.columns
    assert set(state.attrs["fallbacks"]) >= {"MIN", "PTS", "AST"}


def test_decomposed_estimator_end_to_end(frame, feature_cols):
    # arrange
    train = frame[frame["GAME_DATE"] < CUTOFF]
    valid = frame[frame["GAME_DATE"] >= CUTOFF]
    estimator = DecomposedEstimator(target="PTS").fit(train, feature_cols, CUTOFF)

    # act
    pred = estimator.predict(valid)

    # assert
    assert len(pred) == len(valid)
    assert (pred >= 0).all()
    assert np.isfinite(pred).all()


def test_availability_model_learns_something(frame, fitted):
    """the availability model must beat a constant, on any data with signal.

    the spike's headline (-22.8% Brier vs the shifted appearance rate) is NOT
    asserted here: these fixtures draw availability i.i.d. per roster slot, so
    the shifted rate is close to the generating process and a boosted tree
    trained on ~2k rows cannot beat it. that comparison is a real-data claim and
    lives in the parquet-mode backtest, not in a synthetic unit test.
    """
    # arrange
    train = frame[frame["GAME_DATE"] < CUTOFF]
    valid = frame[frame["GAME_DATE"] >= CUTOFF]
    y = valid["PLAYED"].to_numpy(dtype=int)
    constant = np.full(len(valid), float(train["PLAYED"].mean()))

    # act
    p = fitted.predict_proba(valid)

    # assert
    assert brier(y, p) < brier(y, constant)


# ---- metric helpers ----
def test_skill_score_signs():
    # act + assert
    assert skill_score(0.5, 1.0) == pytest.approx(0.5)
    assert skill_score(1.0, 1.0) == pytest.approx(0.0)
    assert skill_score(2.0, 1.0) == pytest.approx(-1.0)


def test_quantile_coverage_matches_the_nominal_level():
    # arrange
    rng = np.random.default_rng(3)
    residuals = rng.normal(0, 2.0, 20_000)
    y_pred = np.zeros(20_000)

    # act
    lo, hi = residual_interval(residuals, 0.8)
    covered = quantile_coverage(residuals, y_pred, lo, hi)

    # assert
    assert covered == pytest.approx(0.8, abs=0.02)
