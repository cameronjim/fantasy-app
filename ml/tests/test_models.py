"""composition math and out-of-fold discipline.

two load-bearing tests in this file.

``test_in_fold_probabilities_are_rejected`` builds a P(play) the honest way and a
P(play) the contaminated way and asserts the guard can tell them apart. without
that, every other number in the package is unfalsifiable.

``test_raising_predicted_minutes_raises_the_production_estimate`` encodes the
defect an external review found on 2026-08-17: under the old composition,
P(play) x EWMA(stat), the minutes model's output could not reach a production
projection at all. a backup whose minutes model said 30 kept the points EWMA of
his 14-minute nights. the test states the property that has to hold instead -
double the predicted minutes, double the projection - so the old formulation
cannot be reintroduced silently.
"""

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
    """a minutes model that always says the same number.

    substituted into a real fitted ``DecomposedEstimator`` so the propagation
    property can be checked through the actual serving code path rather than a
    reimplementation of it.
    """

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


# ---- the minutes-propagating composition ----
def test_the_composition_is_the_product_of_its_three_parts():
    # arrange - P(play), E[minutes|plays], per-minute rate
    scored = composed_frame(minutes=[30.0, 14.0], probability=[0.9, 0.5])
    rate = np.array([0.6, 0.4])

    # act
    conditional, unconditional = minutes_propagated_estimate(scored, rate)

    # assert
    assert conditional == pytest.approx([18.0, 5.6])
    assert unconditional == pytest.approx([16.2, 2.8])


def test_raising_predicted_minutes_raises_the_production_estimate():
    """THE REVIEWED DEFECT, encoded as a regression test.

    the old composition was P(play) x EWMA(stat). EWMA(stat) is an average of past
    whole-game TOTALS, so it already contains the minutes the player used to get
    and is a constant with respect to any minutes forecast: a backup whose minutes
    model said 30 still got the points EWMA of his 14-minute nights, and the
    projection did not move at all.

    with the rate held fixed, doubling the predicted minutes must double BOTH the
    conditional estimate (what he does if he plays) and the unconditional one (what
    he does over the schedule). the conditional half matters as much as the
    unconditional one: it is the number on the player card, and it has to be
    coherent with the minutes row printed beside it.
    """
    # arrange - same player, same rate, twice the minutes
    rate = np.array([0.55, 0.55])
    base = composed_frame(minutes=[14.0, 14.0], probability=[0.9, 0.35])
    lifted = composed_frame(minutes=[28.0, 28.0], probability=[0.9, 0.35])

    # act
    cond_base, unc_base = minutes_propagated_estimate(base, rate)
    cond_lifted, unc_lifted = minutes_propagated_estimate(lifted, rate)

    # assert - proportional, not merely monotone
    assert cond_lifted == pytest.approx(2.0 * cond_base)
    assert unc_lifted == pytest.approx(2.0 * unc_base)
    assert (cond_lifted > cond_base).all()
    assert (unc_lifted > unc_base).all()


def test_minutes_propagate_through_the_real_estimator(frame, feature_cols):
    """the same property, through the fitted serving path rather than by hand.

    only the minutes model is substituted; the availability model, the per-minute
    rate and every guard are the real ones. if the composition were ever rewired
    back to a minutes-independent form, this fails even though the arithmetic test
    above would still pass on its own hand-built frame.
    """
    # arrange
    train = frame[frame["GAME_DATE"] < CUTOFF]
    valid = frame[frame["GAME_DATE"] >= CUTOFF]
    estimator = DecomposedEstimator(target="PTS").fit(train, feature_cols, CUTOFF)

    # act
    estimator.minutes = FixedMinutes(12.0, CUTOFF)
    low_cond = estimator.predict_conditional(valid)
    low_unc = estimator.predict(valid)
    estimator.minutes = FixedMinutes(36.0, CUTOFF)
    high_cond = estimator.predict_conditional(valid)
    high_unc = estimator.predict(valid)

    # assert - 3x the minutes, 3x the projection, both columns
    assert high_cond == pytest.approx(3.0 * low_cond)
    assert high_unc == pytest.approx(3.0 * low_unc)
    assert high_cond.mean() > low_cond.mean() > 0


def test_the_conditional_estimate_is_minutes_times_rate():
    # act + assert
    assert conditional_estimate([30.0, 0.0], [0.5, 0.9]) == pytest.approx([15.0, 0.0])
    # a negative rate cannot produce a negative projection
    assert conditional_estimate([30.0], [-0.5]) == pytest.approx([0.0])


def test_an_in_fold_minutes_prediction_is_rejected():
    """the second half of the composition needs the same guard as the first.

    a P(play) stamped honestly with an in-fold minutes prediction beside it
    produces a contaminated product, and only the minutes guard can see it.
    """
    # arrange - minutes model trained past the game it is predicting
    scored = composed_frame(
        minutes=[30.0], probability=[0.9],
        game_date="2025-01-05", p_cutoff="2025-01-01", minutes_cutoff="2025-02-01",
    )

    # act + assert
    validate_out_of_fold(scored)  # P(play) is fine on its own
    with pytest.raises(LeakageError, match="IN-FOLD E\\[minutes\\|plays\\]"):
        validate_minutes_out_of_fold(scored)
    with pytest.raises(LeakageError, match="IN-FOLD"):
        minutes_propagated_estimate(scored, np.array([0.5]))


def test_the_two_halves_must_share_one_training_cutoff():
    """both individually out of fold is not enough.

    an availability model that stopped in January composed with a minutes model
    that stopped in March mixes two views of what was knowable. neither per-quantity
    guard fires - both cutoffs precede the game - so this is the only check that
    can catch it.
    """
    # arrange
    scored = composed_frame(
        minutes=[30.0], probability=[0.9],
        game_date="2025-04-05", p_cutoff="2025-01-01", minutes_cutoff="2025-03-01",
    )

    # act + assert
    validate_out_of_fold(scored)
    validate_minutes_out_of_fold(scored)
    with pytest.raises(LeakageError, match="share one cutoff"):
        assert_same_cutoff(scored)


def test_minutes_model_refuses_to_train_past_its_cutoff(frame, feature_cols):
    # arrange
    appearances = frame[frame["PLAYED"] == 1]

    # act + assert
    with pytest.raises(LeakageError, match="on or after the cutoff"):
        MinutesModel(kind="ridge").fit(appearances, feature_cols, CUTOFF)


def test_minutes_model_stamps_its_cutoff(frame, feature_cols):
    # arrange
    train = frame[(frame["GAME_DATE"] < CUTOFF) & (frame["PLAYED"] == 1)]
    valid = frame[frame["GAME_DATE"] >= CUTOFF]

    # act
    scored = MinutesModel(kind=CHAMPIONS["minutes"]).fit(
        train, feature_cols, CUTOFF
    ).attach(valid)

    # assert
    assert (scored[MIN_PRED] >= 0).all()
    assert (scored[MIN_PRED_CUTOFF] == CUTOFF).all()
    assert validate_minutes_out_of_fold(scored) is scored


# ---- per-minute rates ----
def test_per_minute_rate_reads_the_precomputed_column(frame):
    # arrange
    train = frame[frame["GAME_DATE"] < CUTOFF]
    column = rate_column("PTS")
    valid = frame[(frame["GAME_DATE"] >= CUTOFF) & frame[column].notna()]
    rate = PerMinuteRate("PTS").fit(train)

    # act
    pred = rate.predict(valid)

    # assert
    assert pred == pytest.approx(valid[column].to_numpy(), abs=1e-9)


def test_per_minute_rate_fallback_is_a_minutes_weighted_league_rate(frame):
    # arrange
    train = frame[frame["GAME_DATE"] < CUTOFF]
    played = train[(train["PLAYED"] == 1) & (train["MIN"] > 0)]

    # act
    rate = PerMinuteRate("PTS").fit(train)

    # assert - sum/sum, not the mean of per-game ratios
    assert rate.fallback == pytest.approx(played["PTS"].sum() / played["MIN"].sum())
    no_history = frame[frame[rate_column("PTS")].isna()]
    assert len(no_history) > 0
    assert np.allclose(rate.predict(no_history), rate.fallback)


def test_the_cameo_floor_caps_an_implausible_rate(frame):
    """a 2-minute night with one three is a real 1.5 pts/min and an absurd prior.

    the floor is on the DENOMINATOR, so the cameo still contributes - at the rate a
    four-minute stint would have implied - rather than being discarded. discarding
    it would be worse for exactly the players whose history is mostly cameos.
    """
    # arrange
    train = frame[frame["GAME_DATE"] < CUTOFF]
    rate = PerMinuteRate("PTS").fit(train)

    # act
    implied = 3.0 / max(2.0, RATE_MINUTES_FLOOR)

    # assert
    assert RATE_MINUTES_FLOOR >= 4.0
    assert implied == pytest.approx(0.75)
    assert implied < 3.0 / 2.0
    # every served rate stays inside a physically sane range
    assert rate.predict(frame[frame["GAME_DATE"] >= CUTOFF]).max() <= 2.0


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
    """pins REPORT.md section 6: no production ML in the promoted path.

    minutes was deliberately promoted to lightgbm on 2026-08-17: on the full
    four-season truth-layer dataset it beat EWMA by 2.1% MAE across all five
    rolling origins (reports/20260817.md), past the ~2% noise line. production
    remains EWMA — a future promotion must clear the same bar and update this
    pin with its evidence.

    THE PRODUCTION CALL WAS RE-EXAMINED ON THE v2 DATASET AND DELIBERATELY NOT
    CHANGED (reports/20260817c.md). The reviews predicted that trained conditional
    models would start beating EWMA once teammate-context features existed, and
    they moved in exactly that direction: ridge's edge on PTS|played went from
    0.80% to 1.83% and LightGBM's from 0.47% to 1.63%. The bar is >2% CONSISTENTLY
    ACROSS ORIGINS, and ridge clears 2% on two of five (-1.41 / -1.68 / -2.24 /
    -1.75 / -2.08%). AST is 1.08%. The bar was set before the measurement and was
    not moved to accommodate it; the next phase that closes the gap must update this
    docstring with per-origin numbers, not just a mean.

    minutes and availability kept their champions and got better under them: Brier
    0.0734 -> 0.0710 and minutes MAE 4.723 -> 4.537 on the same rows, purely from
    the v2 feature set.
    """
    # act + assert
    assert CHAMPIONS["production"] == "ewma"
    assert CHAMPIONS["minutes"] == "lightgbm"
    assert CHAMPIONS["availability"] == "lightgbm"
    # the composition family: promoted 2026-08-17 on a correctness argument, not a
    # metric one. reverting it to decomposed_p_x_ewma would restore a form in which
    # predicted minutes cannot reach a production projection.
    assert CHAMPIONS["composition"] == "decomposed_p_x_minutes_x_ppm"


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
