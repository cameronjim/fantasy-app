from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.config import CHAMPIONS, ORIGINS, RATE_MINUTES_FLOOR
from fnba_ml.features import available_features, rate_column
from fnba_ml.models import (
    MIN_PRED,
    MIN_PRED_CUTOFF,
    P_PLAY,
    P_PLAY_CUTOFF,
    AvailabilityModel,
    DecomposedEstimator,
    EwmaProduction,
    LeakageError,
    MinutesModel,
    PerMinuteRate,
    assert_same_cutoff,
    brier,
    conditional_estimate,
    decomposed_estimate,
    minutes_propagated_estimate,
    out_of_fold_availability,
    quantile_coverage,
    residual_interval,
    skill_score,
    snapshot_ewma_state,
    validate_minutes_out_of_fold,
    validate_out_of_fold,
)

CUTOFF = pd.Timestamp("2024-12-01")


def composed_frame(
    minutes: list[float],
    probability: list[float],
    game_date: str = "2025-01-05",
    p_cutoff: str = "2025-01-01",
    minutes_cutoff: str | None = None,
) -> pd.DataFrame:
    """a frame carrying both stamped quantities the composition multiplies."""
    n = len(minutes)
    return pd.DataFrame({
        "GAME_DATE": pd.to_datetime([game_date] * n),
        P_PLAY: probability,
        P_PLAY_CUTOFF: pd.to_datetime([p_cutoff] * n),
        MIN_PRED: minutes,
        MIN_PRED_CUTOFF: pd.to_datetime([minutes_cutoff or p_cutoff] * n),
    })


class FixedMinutes:
    def __init__(self, value: float, cutoff: pd.Timestamp) -> None:
        self.value = float(value)
        self.cutoff = pd.Timestamp(cutoff)

    def predict(self, frame: pd.DataFrame) -> np.ndarray:
        return np.full(len(frame), self.value)

    def attach(self, frame: pd.DataFrame) -> pd.DataFrame:
        out = frame.copy()
        out[MIN_PRED] = self.predict(frame)
        out[MIN_PRED_CUTOFF] = self.cutoff
        return out


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


def test_decomposition_is_the_product_of_its_parts():
    scored = pd.DataFrame({
        "GAME_DATE": pd.to_datetime(["2025-01-05", "2025-01-05", "2025-01-06"]),
        P_PLAY: [0.9, 0.5, 0.0],
        P_PLAY_CUTOFF: pd.to_datetime(["2025-01-01"] * 3),
    })
    conditional = np.array([20.0, 10.0, 30.0])

    result = decomposed_estimate(scored, conditional)

    assert result == pytest.approx([18.0, 5.0, 0.0])


def test_decomposition_never_returns_a_negative_estimate():
    scored = pd.DataFrame({
        "GAME_DATE": pd.to_datetime(["2025-01-05"]),
        P_PLAY: [0.8],
        P_PLAY_CUTOFF: pd.to_datetime(["2025-01-01"]),
    })

    result = decomposed_estimate(scored, np.array([-4.0]))

    assert result == pytest.approx([0.0])


def test_the_composition_is_the_product_of_its_three_parts():
    scored = composed_frame(minutes=[30.0, 14.0], probability=[0.9, 0.5])
    rate = np.array([0.6, 0.4])

    conditional, unconditional = minutes_propagated_estimate(scored, rate)

    assert conditional == pytest.approx([18.0, 5.6])
    assert unconditional == pytest.approx([16.2, 2.8])


def test_raising_predicted_minutes_raises_the_production_estimate():
    rate = np.array([0.55, 0.55])
    base = composed_frame(minutes=[14.0, 14.0], probability=[0.9, 0.35])
    lifted = composed_frame(minutes=[28.0, 28.0], probability=[0.9, 0.35])

    cond_base, unc_base = minutes_propagated_estimate(base, rate)
    cond_lifted, unc_lifted = minutes_propagated_estimate(lifted, rate)

    assert cond_lifted == pytest.approx(2.0 * cond_base)
    assert unc_lifted == pytest.approx(2.0 * unc_base)
    assert (cond_lifted > cond_base).all()
    assert (unc_lifted > unc_base).all()


def test_minutes_propagate_through_the_real_estimator(frame, feature_cols):
    train = frame[frame["GAME_DATE"] < CUTOFF]
    valid = frame[frame["GAME_DATE"] >= CUTOFF]
    estimator = DecomposedEstimator(target="PTS").fit(train, feature_cols, CUTOFF)

    estimator.minutes = FixedMinutes(12.0, CUTOFF)
    low_cond = estimator.predict_conditional(valid)
    low_unc = estimator.predict(valid)
    estimator.minutes = FixedMinutes(36.0, CUTOFF)
    high_cond = estimator.predict_conditional(valid)
    high_unc = estimator.predict(valid)

    assert high_cond == pytest.approx(3.0 * low_cond)
    assert high_unc == pytest.approx(3.0 * low_unc)
    assert high_cond.mean() > low_cond.mean() > 0


def test_the_conditional_estimate_is_minutes_times_rate():
    assert conditional_estimate([30.0, 0.0], [0.5, 0.9]) == pytest.approx([15.0, 0.0])
    assert conditional_estimate([30.0], [-0.5]) == pytest.approx([0.0])


def test_an_in_fold_minutes_prediction_is_rejected():
    scored = composed_frame(
        minutes=[30.0], probability=[0.9],
        game_date="2025-01-05", p_cutoff="2025-01-01", minutes_cutoff="2025-02-01",
    )

    validate_out_of_fold(scored)
    with pytest.raises(LeakageError, match="IN-FOLD E\\[minutes\\|plays\\]"):
        validate_minutes_out_of_fold(scored)
    with pytest.raises(LeakageError, match="IN-FOLD"):
        minutes_propagated_estimate(scored, np.array([0.5]))


def test_the_two_halves_must_share_one_training_cutoff():
    scored = composed_frame(
        minutes=[30.0], probability=[0.9],
        game_date="2025-04-05", p_cutoff="2025-01-01", minutes_cutoff="2025-03-01",
    )

    validate_out_of_fold(scored)
    validate_minutes_out_of_fold(scored)
    with pytest.raises(LeakageError, match="share one cutoff"):
        assert_same_cutoff(scored)


def test_minutes_model_refuses_to_train_past_its_cutoff(frame, feature_cols):
    appearances = frame[frame["PLAYED"] == 1]

    with pytest.raises(LeakageError, match="on or after the cutoff"):
        MinutesModel(kind="ridge").fit(appearances, feature_cols, CUTOFF)


def test_minutes_model_stamps_its_cutoff(frame, feature_cols):
    train = frame[(frame["GAME_DATE"] < CUTOFF) & (frame["PLAYED"] == 1)]
    valid = frame[frame["GAME_DATE"] >= CUTOFF]

    scored = MinutesModel(kind=CHAMPIONS["minutes"]).fit(
        train, feature_cols, CUTOFF
    ).attach(valid)

    assert (scored[MIN_PRED] >= 0).all()
    assert (scored[MIN_PRED_CUTOFF] == CUTOFF).all()
    assert validate_minutes_out_of_fold(scored) is scored


def test_per_minute_rate_reads_the_precomputed_column(frame):
    train = frame[frame["GAME_DATE"] < CUTOFF]
    column = rate_column("PTS")
    valid = frame[(frame["GAME_DATE"] >= CUTOFF) & frame[column].notna()]
    rate = PerMinuteRate("PTS").fit(train)

    pred = rate.predict(valid)

    assert pred == pytest.approx(valid[column].to_numpy(), abs=1e-9)


def test_per_minute_rate_fallback_is_a_minutes_weighted_league_rate(frame):
    train = frame[frame["GAME_DATE"] < CUTOFF]
    played = train[(train["PLAYED"] == 1) & (train["MIN"] > 0)]

    rate = PerMinuteRate("PTS").fit(train)

    # sum/sum, not the mean of per-game ratios
    assert rate.fallback == pytest.approx(played["PTS"].sum() / played["MIN"].sum())
    no_history = frame[frame[rate_column("PTS")].isna()]
    assert len(no_history) > 0
    assert np.allclose(rate.predict(no_history), rate.fallback)


def test_the_cameo_floor_caps_an_implausible_rate(frame):
    """the floor is on the DENOMINATOR, so the cameo still contributes."""
    train = frame[frame["GAME_DATE"] < CUTOFF]
    rate = PerMinuteRate("PTS").fit(train)

    implied = 3.0 / max(2.0, RATE_MINUTES_FLOOR)

    assert RATE_MINUTES_FLOOR >= 4.0
    assert implied == pytest.approx(0.75)
    assert implied < 3.0 / 2.0
    assert rate.predict(frame[frame["GAME_DATE"] >= CUTOFF]).max() <= 2.0


def test_unconditional_estimate_is_below_the_conditional_one(frame, fitted):
    valid = frame[frame["GAME_DATE"] >= CUTOFF]
    ewma = EwmaProduction("PTS").fit(frame[frame["GAME_DATE"] < CUTOFF])
    scored = fitted.attach(valid)

    conditional = ewma.predict(valid)
    unconditional = decomposed_estimate(scored, conditional)

    assert unconditional.mean() < conditional.mean()
    assert (unconditional <= conditional + 1e-9).all()


def test_out_of_fold_probabilities_validate(frame, feature_cols):
    origins = [(name, s, e) for name, s, e in ORIGINS
               if pd.Timestamp(s) <= frame["GAME_DATE"].max()]
    origins = origins or [("O1", "2024-12-01", "2024-12-31")]

    oof = out_of_fold_availability(frame, origins, feature_cols)

    assert len(oof) > 0
    assert (oof[P_PLAY_CUTOFF] <= oof["GAME_DATE"]).all()
    assert validate_out_of_fold(oof) is oof


def test_in_fold_probabilities_are_rejected(frame, feature_cols):
    late_cutoff = frame["GAME_DATE"].max() + pd.Timedelta(days=1)
    leaky = AvailabilityModel(kind="logistic").fit(frame, feature_cols, late_cutoff)
    contaminated = leaky.attach(frame)

    with pytest.raises(LeakageError, match="IN-FOLD"):
        validate_out_of_fold(contaminated)

    with pytest.raises(LeakageError, match="IN-FOLD"):
        decomposed_estimate(contaminated, np.full(len(contaminated), 10.0))


def test_training_past_the_cutoff_is_rejected(frame, feature_cols):
    with pytest.raises(LeakageError, match="on or after the cutoff"):
        AvailabilityModel(kind="logistic").fit(frame, feature_cols, CUTOFF)


def test_missing_cutoff_stamp_is_rejected():
    scored = pd.DataFrame({
        "GAME_DATE": pd.to_datetime(["2025-01-05"]),
        P_PLAY: [0.7],
    })

    with pytest.raises(LeakageError, match="missing column"):
        validate_out_of_fold(scored)


def test_null_probability_is_rejected():
    scored = pd.DataFrame({
        "GAME_DATE": pd.to_datetime(["2025-01-05"]),
        P_PLAY: [np.nan],
        P_PLAY_CUTOFF: pd.to_datetime(["2025-01-01"]),
    })

    with pytest.raises(LeakageError, match="null P\\(play\\)"):
        validate_out_of_fold(scored)


def test_production_champion_is_not_a_trained_model():
    assert CHAMPIONS["production"] == "ewma"
    assert CHAMPIONS["minutes"] == "lightgbm"
    assert CHAMPIONS["availability"] == "lightgbm"
    assert CHAMPIONS["composition"] == "decomposed_p_x_minutes_x_ppm"


def test_ewma_champion_reads_the_precomputed_column(frame):
    train = frame[frame["GAME_DATE"] < CUTOFF]
    valid = frame[(frame["GAME_DATE"] >= CUTOFF) & frame["ewma_PTS"].notna()]
    ewma = EwmaProduction("PTS").fit(train)

    pred = ewma.predict(valid)

    assert pred == pytest.approx(valid["ewma_PTS"].to_numpy(), abs=1e-9)
    assert ewma.fallback == pytest.approx(train[train["PLAYED"] == 1]["PTS"].mean())


def test_ewma_fallback_fills_players_without_history(frame):
    train = frame[frame["GAME_DATE"] < CUTOFF]
    no_history = frame[frame["ewma_PTS"].isna()]
    assert len(no_history) > 0
    ewma = EwmaProduction("PTS").fit(train)

    pred = ewma.predict(no_history)

    assert np.allclose(pred, ewma.fallback)


def test_ewma_state_snapshot_is_as_of_the_cutoff(frame):
    state = snapshot_ewma_state(frame, CUTOFF)

    assert (state["AS_OF"] < CUTOFF).all()
    assert state["PLAYER_ID"].is_unique
    assert "ewma_PTS" in state.columns
    assert set(state.attrs["fallbacks"]) >= {"MIN", "PTS", "AST"}


def test_decomposed_estimator_end_to_end(frame, feature_cols):
    train = frame[frame["GAME_DATE"] < CUTOFF]
    valid = frame[frame["GAME_DATE"] >= CUTOFF]
    estimator = DecomposedEstimator(target="PTS").fit(train, feature_cols, CUTOFF)

    pred = estimator.predict(valid)

    assert len(pred) == len(valid)
    assert (pred >= 0).all()
    assert np.isfinite(pred).all()


def test_availability_model_learns_something(frame, fitted):
    train = frame[frame["GAME_DATE"] < CUTOFF]
    valid = frame[frame["GAME_DATE"] >= CUTOFF]
    y = valid["PLAYED"].to_numpy(dtype=int)
    constant = np.full(len(valid), float(train["PLAYED"].mean()))

    p = fitted.predict_proba(valid)

    assert brier(y, p) < brier(y, constant)


def test_skill_score_signs():
    assert skill_score(0.5, 1.0) == pytest.approx(0.5)
    assert skill_score(1.0, 1.0) == pytest.approx(0.0)
    assert skill_score(2.0, 1.0) == pytest.approx(-1.0)


def test_quantile_coverage_matches_the_nominal_level():
    rng = np.random.default_rng(3)
    residuals = rng.normal(0, 2.0, 20_000)
    y_pred = np.zeros(20_000)

    lo, hi = residual_interval(residuals, 0.8)
    covered = quantile_coverage(residuals, y_pred, lo, hi)

    assert covered == pytest.approx(0.8, abs=0.02)
