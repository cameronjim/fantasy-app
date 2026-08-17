"""
Phase 0 spike: rolling-origin evaluation of the model ladder.

NO RANDOM SPLITS. Three forward-chaining origins inside 2024-25, with the whole
of 2023-24 always in the training set:

    origin 1: train <= 2024-11-30  ->  validate 2024-12
    origin 2: train <= 2024-12-31  ->  validate 2025-01
    origin 3: train <= 2025-01-31  ->  validate 2025-02

Tasks:
  A  availability   : PLAYED on ALL scheduled rows        (Brier, log loss)
  B  minutes|played : MIN   on appearance rows            (MAE)
  C1 pts|played     : PTS   on appearance rows            (MAE)
  C2 ast|played     : AST   on appearance rows            (MAE)
  D  UNCONDITIONAL pts : PTS on ALL scheduled rows        (MAE)
       decomposed  = P(play) x E[PTS|played], both from models fit on
       pre-origin data only, so the availability probability used is
       out-of-sample for every validation row.

Outputs: data/results_long.csv  (tidy)  + markdown tables on stdout.
Run:     python run_eval.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from features import FEATURE_COLS
from models import (
    baseline_column,
    brier,
    fit_predict,
    fit_predict_proba,
    logloss,
    mae,
    make_lgbm_classifier,
    make_lgbm_regressor,
    make_logistic,
    make_ridge,
)

DATA_DIR = Path(__file__).resolve().parent / "data"

ORIGINS = [
    ("O1 valid=2024-12", "2024-12-01", "2024-12-31"),
    ("O2 valid=2025-01", "2025-01-01", "2025-01-31"),
    ("O3 valid=2025-02", "2025-02-01", "2025-02-28"),
]

TIER_ORDER = ["star (>=30)", "starter (20-30)", "bench (10-20)",
              "fringe (<10)", "unknown (no history)"]

results: list[dict] = []


def record(task, origin, model, metric, value, n, segment="ALL"):
    results.append({
        "task": task, "origin": origin, "model": model, "segment": segment,
        "metric": metric, "value": value, "n": n,
    })


def seg_mae(task, origin, model, valid, y_true, y_pred):
    """Record overall MAE plus per-minutes-tier MAE."""
    record(task, origin, model, "MAE", mae(y_true, y_pred), len(y_true))
    tiers = valid["MIN_TIER"].to_numpy()
    for tier in TIER_ORDER:
        m = tiers == tier
        if m.sum() == 0:
            continue
        record(task, origin, model, "MAE", mae(y_true[m], y_pred[m]),
               int(m.sum()), segment=tier)


def split(df, cutoff, vstart, vend):
    cutoff, vstart, vend = map(pd.Timestamp, (cutoff, vstart, vend))
    train = df[df["GAME_DATE"] < cutoff]
    valid = df[(df["GAME_DATE"] >= vstart) & (df["GAME_DATE"] <= vend)]
    return train.copy(), valid.copy()


def main() -> int:
    df = pd.read_parquet(DATA_DIR / "features.parquet")
    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"])
    df = df.sort_values("GAME_DATE").reset_index(drop=True)

    print(f"loaded {len(df):,} scheduled rows, "
          f"{df['GAME_DATE'].min().date()} .. {df['GAME_DATE'].max().date()}")
    print(f"overall availability base rate: {df['PLAYED'].mean():.4f}\n")

    feats = [c for c in FEATURE_COLS if c in df.columns]

    for origin_name, vstart, vend in ORIGINS:
        cutoff = vstart
        train_all, valid_all = split(df, cutoff, vstart, vend)
        train_app = train_all[train_all["PLAYED"] == 1]
        valid_app = valid_all[valid_all["PLAYED"] == 1]

        print(f"=== {origin_name} ===")
        print(f"  train all rows {len(train_all):>7,} | valid all rows {len(valid_all):>6,}"
              f" | valid played rate {valid_all['PLAYED'].mean():.4f}")
        print(f"  train appear.  {len(train_app):>7,} | valid appear.  {len(valid_app):>6,}")

        # ------------------------------------------------------------------
        # TASK A - availability
        # ------------------------------------------------------------------
        y_av = valid_all["PLAYED"].to_numpy(dtype=int)
        base_rate = float(train_all["PLAYED"].mean())

        p_base = baseline_column(valid_all, "avail_rate_10", base_rate)
        p_logit = fit_predict_proba(make_logistic(), train_all, valid_all, feats, "PLAYED")
        p_lgbm = fit_predict_proba(make_lgbm_classifier(), train_all, valid_all, feats, "PLAYED")
        p_const = np.full(len(valid_all), base_rate)

        for name, p in [("baseline: global rate", p_const),
                        ("baseline: shifted appearance rate(10)", p_base),
                        ("logistic regression", p_logit),
                        ("LightGBM classifier", p_lgbm)]:
            record("A availability", origin_name, name, "Brier", brier(y_av, p), len(y_av))
            record("A availability", origin_name, name, "LogLoss", logloss(y_av, p), len(y_av))

        # ------------------------------------------------------------------
        # TASKS B / C - conditional on playing
        # ------------------------------------------------------------------
        cond_specs = [
            ("B minutes|played", "MIN", "std_MIN", "ewma_MIN"),
            ("C1 pts|played", "PTS", "std_PTS", "ewma_PTS"),
            ("C2 ast|played", "AST", "std_AST", "ewma_AST"),
        ]
        cond_preds: dict[str, np.ndarray] = {}

        for task, target, std_col, ewma_col in cond_specs:
            y = valid_app[target].to_numpy(dtype=float)
            fb = float(train_app[target].mean())

            preds = {
                "baseline: expanding season mean": baseline_column(valid_app, std_col, fb),
                "baseline: EWMA (halflife 5)": baseline_column(valid_app, ewma_col, fb),
                "ridge": fit_predict(make_ridge(), train_app, valid_app, feats, target),
                "LightGBM": fit_predict(make_lgbm_regressor(), train_app, valid_app,
                                        feats, target),
            }
            for name, pred in preds.items():
                seg_mae(task, origin_name, name, valid_app, y, pred)
            cond_preds[target] = preds["LightGBM"]

        # ------------------------------------------------------------------
        # TASK D - UNCONDITIONAL points over ALL scheduled rows
        # ------------------------------------------------------------------
        y_unc = valid_all["PTS"].to_numpy(dtype=float)
        fb_cond = float(train_app["PTS"].mean())
        fb_unc = float(train_all["PTS"].mean())

        # conditional PTS model applied to EVERY scheduled row
        pts_cond_all = fit_predict(make_lgbm_regressor(), train_app, valid_all,
                                   feats, "PTS")
        # availability model predictions for every scheduled row (already p_lgbm)
        decomposed = p_lgbm * pts_cond_all

        # a minutes-routed variant: P(play) x (pred minutes x prior pts-per-min)
        min_cond_all = fit_predict(make_lgbm_regressor(), train_app, valid_all,
                                   feats, "MIN")
        ppm = (valid_all["roll10_PTS"] / valid_all["roll10_MIN"].replace(0, np.nan))
        ppm = ppm.replace([np.inf, -np.inf], np.nan).fillna(
            train_app["PTS"].sum() / max(train_app["MIN"].sum(), 1)
        ).to_numpy()
        decomposed_min = p_lgbm * min_cond_all * ppm

        unc_preds = {
            "naive: conditional season mean (selection-biased)":
                baseline_column(valid_all, "std_PTS", fb_cond),
            "naive: unconditional season mean (0 for misses)":
                baseline_column(valid_all, "uncond_std_PTS", fb_unc),
            "direct LightGBM on all scheduled rows":
                fit_predict(make_lgbm_regressor(), train_all, valid_all, feats, "PTS"),
            "decomposed: P(play) x E[PTS|played]": decomposed,
            "decomposed: P(play) x E[MIN|played] x prior PTS/min": decomposed_min,
        }
        for name, pred in unc_preds.items():
            seg_mae("D pts UNCONDITIONAL", origin_name, name, valid_all, y_unc, pred)

        print()

    res = pd.DataFrame(results)
    out = DATA_DIR / "results_long.csv"
    res.to_csv(out, index=False)
    print(f"saved tidy results -> {out}  ({len(res):,} rows)\n")

    # ----------------------------------------------------------------------
    # markdown report tables
    # ----------------------------------------------------------------------
    def md(frame: pd.DataFrame) -> str:
        return frame.to_markdown(floatfmt=".4f")

    overall = res[res["segment"] == "ALL"]

    print("\n### TASK A - availability (all scheduled rows)\n")
    for metric in ["Brier", "LogLoss"]:
        t = overall[(overall["task"] == "A availability") & (overall["metric"] == metric)]
        piv = t.pivot_table(index="model", columns="origin", values="value")
        piv["mean"] = piv.mean(axis=1)
        print(f"\n{metric}:\n")
        print(md(piv.sort_values("mean")))

    for task in ["B minutes|played", "C1 pts|played", "C2 ast|played",
                 "D pts UNCONDITIONAL"]:
        t = overall[overall["task"] == task]
        piv = t.pivot_table(index="model", columns="origin", values="value")
        piv["mean"] = piv.mean(axis=1)
        print(f"\n\n### TASK {task} - MAE\n")
        print(md(piv.sort_values("mean")))

    print("\n\n### SEGMENT BREAKDOWN - MAE by minutes tier (mean over 3 origins)\n")
    for task in ["B minutes|played", "C1 pts|played", "C2 ast|played",
                 "D pts UNCONDITIONAL"]:
        t = res[(res["task"] == task) & (res["segment"] != "ALL")]
        piv = t.pivot_table(index="model", columns="segment", values="value")
        cols = [c for c in TIER_ORDER if c in piv.columns]
        print(f"\n{task}:\n")
        print(md(piv[cols]))

    print("\n\n### SEGMENT SUPPORT (validation rows per tier, summed over origins)\n")
    supp = (res[(res["task"] == "D pts UNCONDITIONAL") & (res["segment"] != "ALL")]
            .drop_duplicates(["origin", "segment"])
            .groupby("segment")["n"].sum())
    print(supp.reindex([c for c in TIER_ORDER if c in supp.index]).to_markdown())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
