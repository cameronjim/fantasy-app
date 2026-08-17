"""rolling-origin evaluation harness.

NO RANDOM SPLITS, ever. forward chaining only: train is everything strictly
before the validation window, so the first season is always fully in training
and every validation row is predicted by a model that could not have seen it.

tasks:
  A  availability     PLAYED over ALL scheduled rows      Brier, log loss
  B  minutes|played   MIN over appearance rows            MAE
  C1 pts|played       PTS over appearance rows            MAE
  C2 ast|played       AST over appearance rows            MAE
  D  UNCONDITIONAL pts  PTS over ALL scheduled rows       MAE

task D is the one that matters for fantasy. it carries both the promoted
decomposition (P(play) x EWMA conditional) and the spike's variants, so a
regression in either is visible in the same table.

every reported number is accompanied by a skill score against the task's naive
baseline, because "beats the baseline by 1%" and "beats the baseline by 23%"
are different findings and only one of them justifies shipping a model.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import CHAMPIONS, ORIGINS, TIER_ORDER
from .features import available_features
from .models import (
    AvailabilityModel,
    EwmaProduction,
    P_PLAY,
    baseline_column,
    brier,
    decomposed_estimate,
    fit_predict,
    logloss,
    mae,
    make_lgbm_regressor,
    make_logistic,
    make_ridge,
    quantile_coverage,
    residual_interval,
    skill_score,
)

log = logging.getLogger(__name__)

TASK_AVAILABILITY = "A availability"
TASK_MINUTES = "B minutes|played"
TASK_PTS = "C1 pts|played"
TASK_AST = "C2 ast|played"
TASK_UNCONDITIONAL = "D pts UNCONDITIONAL"

CONDITIONAL_TASKS = {TASK_MINUTES: "MIN", TASK_PTS: "PTS", TASK_AST: "AST"}

# which task family each task's champion selection belongs to
TASK_FAMILY = {
    TASK_AVAILABILITY: "availability",
    TASK_MINUTES: "minutes",
    TASK_PTS: "production",
    TASK_AST: "production",
}

# the model each task's skill score is measured against
SKILL_BASELINE = {
    TASK_AVAILABILITY: "shifted_appearance_rate",
    TASK_MINUTES: "ewma",
    TASK_PTS: "ewma",
    TASK_AST: "ewma",
    TASK_UNCONDITIONAL: "naive_unconditional_mean",
}

MODEL_LABELS = {
    "global_rate": "baseline: global rate",
    "shifted_appearance_rate": "baseline: shifted appearance rate (10)",
    "logistic": "logistic regression",
    "lightgbm": "LightGBM",
    "ridge": "ridge",
    "ewma": "baseline: EWMA (halflife 5)",
    "expanding_mean": "baseline: expanding season mean",
    "naive_conditional_mean": "naive: conditional season mean (selection-biased)",
    "naive_unconditional_mean": "naive: unconditional season mean (0 for misses)",
    "direct_lightgbm": "direct LightGBM on all scheduled rows",
    "decomposed_p_x_ewma": "decomposed CHAMPION: P(play) x EWMA[PTS|played]",
    "decomposed_p_x_lightgbm": "decomposed: P(play) x LightGBM[PTS|played]",
    "decomposed_p_x_minutes_x_ppm": "decomposed: P(play) x E[MIN|played] x prior PTS/min",
}

NOMINAL_COVERAGE = 0.80


class _Recorder:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def record(self, task, origin, model, metric, value, n, segment="ALL") -> None:
        self.rows.append({
            "task": task, "origin": origin, "model": model, "segment": segment,
            "metric": metric, "value": float(value), "n": int(n),
        })

    def seg_mae(self, task, origin, model, valid, y_true, y_pred) -> None:
        self.record(task, origin, model, "MAE", mae(y_true, y_pred), len(y_true))
        tiers = valid["MIN_TIER"].to_numpy()
        for tier in TIER_ORDER:
            m = tiers == tier
            if m.sum() == 0:
                continue
            self.record(task, origin, model, "MAE", mae(y_true[m], y_pred[m]),
                        int(m.sum()), segment=tier)

    def frame(self) -> pd.DataFrame:
        return pd.DataFrame(self.rows)


def split(df: pd.DataFrame, vstart, vend) -> tuple[pd.DataFrame, pd.DataFrame]:
    vstart, vend = pd.Timestamp(vstart), pd.Timestamp(vend)
    train = df[df["GAME_DATE"] < vstart]
    valid = df[(df["GAME_DATE"] >= vstart) & (df["GAME_DATE"] <= vend)]
    return train.copy(), valid.copy()


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
        rec.record(TASK_AVAILABILITY, origin, name, "Brier", brier(y, p), len(y))
        rec.record(TASK_AVAILABILITY, origin, name, "LogLoss", logloss(y, p), len(y))

    ref = preds[SKILL_BASELINE[TASK_AVAILABILITY]]
    for name, p in preds.items():
        rec.record(TASK_AVAILABILITY, origin, name, "BrierSkill",
                   skill_score(brier(y, p), brier(y, ref)), len(y))
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

        # interval calibration for the champion, from training residuals only
        train_resid = train_app[target].to_numpy(dtype=float) - ewma.predict(train_app)
        lo, hi = residual_interval(train_resid, NOMINAL_COVERAGE)
        rec.record(task, origin, CHAMPIONS["production"], "Coverage80",
                   quantile_coverage(y, preds["ewma"], lo, hi), len(y))

        kept[target] = preds["lightgbm"]
    return kept


def _unconditional(rec, origin, feats, train_all, train_app, valid_all, scored) -> None:
    y = valid_all["PTS"].to_numpy(dtype=float)
    fb_cond = float(train_app["PTS"].mean())
    fb_unc = float(train_all["PTS"].mean())

    ewma_pts = EwmaProduction("PTS").fit(train_app)
    pts_cond_all = fit_predict(make_lgbm_regressor(), train_app, valid_all, feats, "PTS")
    min_cond_all = fit_predict(make_lgbm_regressor(), train_app, valid_all, feats, "MIN")

    ppm = valid_all["roll10_PTS"] / valid_all["roll10_MIN"].replace(0, np.nan)
    ppm = ppm.replace([np.inf, -np.inf], np.nan).fillna(
        train_app["PTS"].sum() / max(train_app["MIN"].sum(), 1)
    ).to_numpy()

    preds = {
        "naive_conditional_mean": baseline_column(valid_all, "std_PTS", fb_cond),
        "naive_unconditional_mean": baseline_column(valid_all, "uncond_std_PTS", fb_unc),
        "direct_lightgbm": fit_predict(make_lgbm_regressor(), train_all, valid_all, feats, "PTS"),
        # every decomposition below runs through decomposed_estimate, which
        # re-validates the out-of-fold stamp on P(play) before multiplying
        "decomposed_p_x_ewma": decomposed_estimate(scored, ewma_pts.predict(valid_all)),
        "decomposed_p_x_lightgbm": decomposed_estimate(scored, pts_cond_all),
        "decomposed_p_x_minutes_x_ppm": decomposed_estimate(scored, min_cond_all * ppm),
    }
    for name, pred in preds.items():
        rec.seg_mae(TASK_UNCONDITIONAL, origin, name, valid_all, y, pred)

    ref = preds[SKILL_BASELINE[TASK_UNCONDITIONAL]]
    for name, pred in preds.items():
        rec.record(TASK_UNCONDITIONAL, origin, name, "MAESkill",
                   skill_score(mae(y, pred), mae(y, ref)), len(y))


def run_rolling_origin(
    features: pd.DataFrame,
    origins: list[tuple[str, str, str]] | None = None,
) -> pd.DataFrame:
    """the whole ladder over every origin. returns tidy long results."""
    origins = origins or ORIGINS
    df = features.copy()
    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"])
    df = df.sort_values("GAME_DATE").reset_index(drop=True)
    feats = available_features(df)

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
        _unconditional(rec, origin, feats, train_all, train_app, valid_all, scored)

    results = rec.frame()
    if results.empty:
        raise ValueError("no origin produced results; check the date ranges in config.ORIGINS")
    return results


def mean_by_model(results: pd.DataFrame, task: str, metric: str) -> pd.Series:
    """mean metric per model over origins, overall segment only."""
    sub = results[
        (results["task"] == task) & (results["metric"] == metric) & (results["segment"] == "ALL")
    ]
    return sub.groupby("model")["value"].mean().sort_values()


def select_champions(results: pd.DataFrame) -> pd.DataFrame:
    """per-target measured winner vs the champion config actually ships.

    a mismatch is a finding to look at, not an instruction to promote: the
    spike's whole point is that a 1% MAE edge does not justify a trained model
    in the serving path.
    """
    rows = []
    for task, family in TASK_FAMILY.items():
        metric = "Brier" if task == TASK_AVAILABILITY else "MAE"
        means = mean_by_model(results, task, metric)
        if means.empty:
            continue
        measured = str(means.index[0])
        configured = CHAMPIONS[family]
        rows.append({
            "task": task,
            "family": family,
            "metric": metric,
            "measured_best": measured,
            "measured_value": float(means.iloc[0]),
            "configured_champion": configured,
            "configured_value": float(means.get(configured, np.nan)),
            "matches_config": measured == configured,
        })
    return pd.DataFrame(rows)


def _pivot(results: pd.DataFrame, task: str, metric: str, segment: str = "ALL") -> pd.DataFrame:
    sub = results[
        (results["task"] == task) & (results["metric"] == metric)
        & (results["segment"] == segment)
    ]
    piv = sub.pivot_table(index="model", columns="origin", values="value")
    piv["mean"] = piv.mean(axis=1)
    piv = piv.sort_values("mean")
    piv.index = [MODEL_LABELS.get(m, m) for m in piv.index]
    return piv


def _segment_pivot(results: pd.DataFrame, task: str) -> pd.DataFrame:
    sub = results[
        (results["task"] == task) & (results["metric"] == "MAE") & (results["segment"] != "ALL")
    ]
    piv = sub.pivot_table(index="model", columns="segment", values="value")
    cols = [c for c in TIER_ORDER if c in piv.columns]
    piv = piv[cols]
    piv.index = [MODEL_LABELS.get(m, m) for m in piv.index]
    return piv


def render_report(
    results: pd.DataFrame,
    champions: pd.DataFrame,
    meta: dict[str, object],
) -> str:
    """markdown report, shaped to be diffable against the spike's REPORT.md."""
    parts: list[str] = []
    w = parts.append

    w(f"# Rolling-origin evaluation - {meta.get('model_version', 'unversioned')}\n")
    for key in ("generated_at", "dataset", "universe_source", "rows", "players",
                "played_rate", "feature_version", "git_commit"):
        if key in meta:
            w(f"- **{key}**: {meta[key]}")
    if meta.get("universe_source") == "approximation":
        w("\n> **BIASED UNIVERSE.** built from the +/-15 day game-log-presence "
          "approximation, not from `player_game_status`. availability is "
          "over-stated and absence streaks are capped near 16 team-games "
          "(REPORT.md section 5). these numbers are a port-fidelity check, not "
          "a production estimate.")

    w("\n## Champion selection\n")
    if not champions.empty:
        w(champions.to_markdown(index=False, floatfmt=".4f"))
        drift = champions[~champions["matches_config"]]
        if len(drift):
            w("\nMeasured winner differs from the configured champion for: "
              + ", ".join(drift["task"]) + ". Config is deliberate - see "
              "`config.CHAMPIONS` and REPORT.md section 6.")

    w("\n## A. Availability (all scheduled rows)\n")
    for metric in ("Brier", "LogLoss", "BrierSkill"):
        piv = _pivot(results, TASK_AVAILABILITY, metric)
        if piv.empty:
            continue
        w(f"\n**{metric}**\n")
        w(piv.to_markdown(floatfmt=".4f"))

    for task in (TASK_MINUTES, TASK_PTS, TASK_AST, TASK_UNCONDITIONAL):
        piv = _pivot(results, task, "MAE")
        if piv.empty:
            continue
        w(f"\n## {task} - MAE\n")
        w(piv.to_markdown(floatfmt=".4f"))
        skill = _pivot(results, task, "MAESkill")
        if not skill.empty:
            w(f"\nSkill vs `{SKILL_BASELINE[task]}` (positive = less error)\n")
            w(skill.to_markdown(floatfmt=".4f"))

    w("\n## Segment breakdown - MAE by minutes tier (mean over origins)\n")
    for task in (TASK_MINUTES, TASK_PTS, TASK_AST, TASK_UNCONDITIONAL):
        piv = _segment_pivot(results, task)
        if piv.empty:
            continue
        w(f"\n**{task}**\n")
        w(piv.to_markdown(floatfmt=".4f"))

    cov = results[results["metric"] == "Coverage80"]
    if not cov.empty:
        w(f"\n## Interval coverage - nominal {NOMINAL_COVERAGE:.0%}\n")
        piv = cov.pivot_table(index="task", columns="origin", values="value")
        piv["mean"] = piv.mean(axis=1)
        w(piv.to_markdown(floatfmt=".4f"))
        w("\nIntervals are empirical residual quantiles of the champion "
          "estimate, fitted on the training window only.")

    support = (
        results[(results["task"] == TASK_UNCONDITIONAL) & (results["segment"] != "ALL")]
        .drop_duplicates(["origin", "segment"])
        .groupby("segment")["n"].sum()
    )
    if not support.empty:
        w("\n## Segment support (validation rows per tier, summed over origins)\n")
        w(support.reindex([c for c in TIER_ORDER if c in support.index]).to_markdown())

    return "\n".join(parts) + "\n"
