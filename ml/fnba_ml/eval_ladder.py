"""the rolling-origin ladder: availability, conditional, unconditional, per origin.

no random splits. train is everything strictly before the validation window, so
every validation row is predicted by a model that could not have seen it.

tasks:
  A  availability     PLAYED over ALL scheduled rows      Brier, log loss
  B  minutes|played   MIN over appearance rows            MAE
  C1 pts|played       PTS over appearance rows            MAE
  C2 ast|played       AST over appearance rows            MAE
  D  UNCONDITIONAL pts  PTS over ALL scheduled rows       MAE
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import (
    CHAMPIONS,
    ORIGINS,
    RATE_TARGETS,
)
from .eval_core import (
    CONDITIONAL_TASKS,
    NOMINAL_COVERAGE,
    SKILL_BASELINE,
    TASK_AVAILABILITY,
    TASK_IMPORTANCE,
    TASK_UNCONDITIONAL,
    _Recorder,
    split,
)
from .eval_rates import _rate_ladder, attach_rate_grid, build_rate_grid
from .features import available_features, feature_set_columns
from .models import (
    AvailabilityModel,
    EwmaProduction,
    MinutesModel,
    P_PLAY,
    PerMinuteRate,
    baseline_column,
    brier,
    conditional_estimate,
    decomposed_estimate,
    fit_predict,
    logloss,
    mae,
    make_lgbm_regressor,
    make_logistic,
    make_ridge,
    minutes_propagated_estimate,
    quantile_coverage,
    residual_interval,
    skill_score,
)

log = logging.getLogger(__name__)


def _availability(rec, origin, feats, train_all, valid_all) -> np.ndarray:
    y = valid_all["PLAYED"].to_numpy(dtype=int)
    base_rate = float(train_all["PLAYED"].mean())
    cutoff = valid_all["GAME_DATE"].min()

    champion = AvailabilityModel(kind=CHAMPIONS["availability"]).fit(train_all, feats, cutoff)
    scored = champion.attach(valid_all)

    preds = {
        "global_rate": np.full(len(valid_all), base_rate),
        "shifted_appearance_rate": baseline_column(valid_all, "avail_rate_10", base_rate),
        "logistic": make_logistic().fit(
            train_all[feats], train_all["PLAYED"].astype(int)
        ).predict_proba(valid_all[feats])[:, 1],
        CHAMPIONS["availability"]: scored[P_PLAY].to_numpy(dtype=float),
    }
    for name, p in preds.items():
        rec.seg_brier(TASK_AVAILABILITY, origin, name, valid_all, y, p)
        rec.record(TASK_AVAILABILITY, origin, name, "LogLoss", logloss(y, p), len(y))

    ref = preds[SKILL_BASELINE[TASK_AVAILABILITY]]
    for name, p in preds.items():
        rec.record(TASK_AVAILABILITY, origin, name, "BrierSkill",
                   skill_score(brier(y, p), brier(y, ref)), len(y))

    rec.gain(TASK_IMPORTANCE, origin, "availability", champion.feature_gain(),
             len(train_all))
    return scored


def _conditional(rec, origin, feats, train_app, valid_app) -> dict[str, np.ndarray]:
    kept: dict[str, np.ndarray] = {}
    for task, target in CONDITIONAL_TASKS.items():
        y = valid_app[target].to_numpy(dtype=float)
        fallback = float(train_app[target].mean())
        ewma = EwmaProduction(target).fit(train_app)

        preds = {
            "expanding_mean": baseline_column(valid_app, f"std_{target}", fallback),
            "ewma": ewma.predict(valid_app),
            "ridge": fit_predict(make_ridge(), train_app, valid_app, feats, target),
            "lightgbm": fit_predict(make_lgbm_regressor(), train_app, valid_app, feats, target),
        }
        for name, pred in preds.items():
            rec.seg_mae(task, origin, name, valid_app, y, pred)

        ref = preds[SKILL_BASELINE[task]]
        for name, pred in preds.items():
            rec.record(task, origin, name, "MAESkill",
                       skill_score(mae(y, pred), mae(y, ref)), len(y))

        # intervals come from training residuals only
        train_resid = train_app[target].to_numpy(dtype=float) - ewma.predict(train_app)
        lo, hi = residual_interval(train_resid, NOMINAL_COVERAGE)
        rec.record(task, origin, CHAMPIONS["production"], "Coverage80",
                   quantile_coverage(y, preds["ewma"], lo, hi), len(y))

        kept[target] = preds["lightgbm"]
    return kept


def _unconditional(
    rec, origin, feats, train_all, train_app, valid_all, scored
) -> pd.DataFrame:
    """returns the scored frame with ``MIN_PRED`` attached.

    the rate ladder reuses that minutes prediction rather than fitting a second
    identically configured minutes model.
    """
    y = valid_all["PTS"].to_numpy(dtype=float)
    fb_cond = float(train_app["PTS"].mean())
    fb_unc = float(train_all["PTS"].mean())

    ewma_pts = EwmaProduction("PTS").fit(train_app)
    pts_cond_all = fit_predict(make_lgbm_regressor(), train_app, valid_all, feats, "PTS")

    # routed through MinutesModel so the minutes prediction arrives carrying its
    # training cutoff and an in-fold minutes model fails here instead of
    # reporting a flattering number.
    cutoff = pd.Timestamp(valid_all["GAME_DATE"].min())
    minutes_model = MinutesModel(kind=CHAMPIONS["minutes"]).fit(train_app, feats, cutoff)
    rec.gain(TASK_IMPORTANCE, origin, "minutes", minutes_model.feature_gain(),
             len(train_app))
    scored = minutes_model.attach(scored)
    ppm_rate = PerMinuteRate("PTS").fit(train_app)
    _, ppm_uncond = minutes_propagated_estimate(scored, ppm_rate.predict(valid_all))

    preds = {
        "naive_conditional_mean": baseline_column(valid_all, "std_PTS", fb_cond),
        "naive_unconditional_mean": baseline_column(valid_all, "uncond_std_PTS", fb_unc),
        "direct_lightgbm": fit_predict(make_lgbm_regressor(), train_all, valid_all, feats, "PTS"),
        "decomposed_p_x_ewma": decomposed_estimate(scored, ewma_pts.predict(valid_all)),
        "decomposed_p_x_lightgbm": decomposed_estimate(scored, pts_cond_all),
        CHAMPIONS["composition"]: ppm_uncond,
    }
    for name, pred in preds.items():
        rec.seg_mae(TASK_UNCONDITIONAL, origin, name, valid_all, y, pred)

    ref = preds[SKILL_BASELINE[TASK_UNCONDITIONAL]]
    for name, pred in preds.items():
        rec.record(TASK_UNCONDITIONAL, origin, name, "MAESkill",
                   skill_score(mae(y, pred), mae(y, ref)), len(y))
    return scored


def run_rolling_origin(
    features: pd.DataFrame,
    origins: list[tuple[str, str, str]] | None = None,
    drop_features: tuple[str, ...] | list[str] = (),
    feature_set: str | None = None,
    rate_targets: tuple[str, ...] = RATE_TARGETS,
) -> pd.DataFrame:
    """the whole ladder over every origin. returns tidy long results.

    ``drop_features`` and ``feature_set`` change the FEATURE LIST only, never the
    frame, so the cohort definitions still read the dataset's own columns and
    every pass partitions the validation rows identically. ``rate_targets`` names
    the stats the rate ladder runs over; pass ``()`` to skip it.
    """
    origins = origins or ORIGINS
    df = features.copy()
    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"])
    df = df.sort_values("GAME_DATE").reset_index(drop=True)
    rate_targets = tuple(t for t in rate_targets if t in df.columns)
    if rate_targets:
        # an EMPTY halflife tuple on purpose: the shipped per-minute rates are
        # already on the dataset, so only the whole-game EWMA member is missing.
        df = attach_rate_grid(df, build_rate_grid(df, rate_targets, ()))
    dropped = set(drop_features)
    chosen = (
        feature_set_columns(df, feature_set) if feature_set else available_features(df)
    )
    feats = [c for c in chosen if c not in dropped]
    if feature_set:
        log.info("running feature set %s with %d features", feature_set, len(feats))
    if dropped:
        log.info("running with %d features, %d dropped: %s",
                 len(feats), len(dropped), ", ".join(sorted(dropped)))

    rec = _Recorder()
    for origin, vstart, vend in origins:
        train_all, valid_all = split(df, vstart, vend)
        train_app = train_all[train_all["PLAYED"] == 1]
        valid_app = valid_all[valid_all["PLAYED"] == 1]
        if train_all.empty or valid_all.empty or train_app.empty or valid_app.empty:
            log.warning("origin %s has an empty side; skipped", origin)
            continue

        log.info("%s: train %d / valid %d rows (played rate %.4f)",
                 origin, len(train_all), len(valid_all), valid_all["PLAYED"].mean())

        scored = _availability(rec, origin, feats, train_all, valid_all)
        _conditional(rec, origin, feats, train_app, valid_app)
        scored = _unconditional(
            rec, origin, feats, train_all, train_app, valid_all, scored
        )
        if rate_targets:
            _rate_ladder(rec, origin, train_app, valid_all, valid_app, scored,
                         rate_targets)

    results = rec.frame()
    if results.empty:
        raise ValueError("no origin produced results; check the date ranges in config.ORIGINS")
    return results
