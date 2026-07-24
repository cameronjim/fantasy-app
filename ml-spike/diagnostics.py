"""
Phase 0 spike: diagnostics on the +/-15-day roster approximation.

The central question this spike has to answer honestly: does approximating the
eligible roster with a +/-15-day appearance window distort AVAILABILITY
modelling badly enough to invalidate the design?

Measures:
  1. eligible roster size distribution vs. the real NBA active roster
  2. INTERIOR GAPS - team-games where a player is eligible before AND after but
     not during. He was almost certainly rostered the whole time; the window
     dropped him. This is a lower bound on the rows we are missing, and they
     are exactly the long-injury absences, i.e. the ones availability modelling
     cares about most.
  3. observed consecutive-absence run lengths (truncated by construction)
  4. calibration of the LightGBM availability model

Run: python diagnostics.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent / "data"


def main() -> int:
    u = pd.read_parquet(DATA_DIR / "universe.parquet")
    u["GAME_DATE"] = pd.to_datetime(u["GAME_DATE"])

    print("=" * 72)
    print("1. ELIGIBLE ROSTER SIZE PER TEAM-GAME")
    print("=" * 72)
    sizes = u.groupby(["SEASON", "GAME_ID", "TEAM_ID"]).size()
    print(sizes.describe().to_string())
    print("\ndistribution:")
    print(sizes.value_counts().sort_index().to_string())
    played_per = u.groupby(["SEASON", "GAME_ID", "TEAM_ID"])["PLAYED"].sum()
    print(f"\nmean players ACTUALLY appearing per team-game: {played_per.mean():.2f}")
    print(f"mean eligible per team-game                  : {sizes.mean():.2f}")
    print("NBA reality: 15 standard contracts + up to 3 two-way; "
          "13 must be active/dressed each game.")

    print()
    print("=" * 72)
    print("2. INTERIOR GAPS (rows the window silently drops)")
    print("=" * 72)

    # full team schedule, indexed per team-season
    sched = (
        u[["SEASON", "TEAM_ID", "GAME_ID", "GAME_DATE"]]
        .drop_duplicates(["SEASON", "TEAM_ID", "GAME_ID"])
        .sort_values(["SEASON", "TEAM_ID", "GAME_DATE"])
        .reset_index(drop=True)
    )
    sched["game_idx"] = sched.groupby(["SEASON", "TEAM_ID"]).cumcount()

    team_game_count = sched.groupby(["SEASON", "TEAM_ID"]).size().rename("n_team_games")

    elig = u[["SEASON", "TEAM_ID", "PLAYER_ID", "GAME_ID"]].merge(
        sched[["SEASON", "TEAM_ID", "GAME_ID", "game_idx"]],
        on=["SEASON", "TEAM_ID", "GAME_ID"],
    )

    spell = elig.groupby(["SEASON", "TEAM_ID", "PLAYER_ID"])["game_idx"].agg(
        first="min", last="max", n_eligible="size"
    )
    spell["span"] = spell["last"] - spell["first"] + 1
    spell["interior_gap"] = spell["span"] - spell["n_eligible"]

    total_rows = len(u)
    total_gap = int(spell["interior_gap"].sum())
    n_with_gap = int((spell["interior_gap"] > 0).sum())

    print(f"player-team-season spells                 : {len(spell):,}")
    print(f"spells containing >=1 interior gap        : {n_with_gap:,} "
          f"({n_with_gap/len(spell):.2%})")
    print(f"total interior-gap team-games dropped     : {total_gap:,}")
    print(f"universe rows built                       : {total_rows:,}")
    print(f"=> universe is missing at least           : {total_gap/total_rows:.2%} "
          f"of the rows it should contain")
    print(f"   (those rows would ALL have PLAYED = 0)")

    implied_rows = total_rows + total_gap
    implied_played = int(u["PLAYED"].sum())
    print(f"\nobserved availability base rate           : {u['PLAYED'].mean():.4f}")
    print(f"base rate if interior gaps were restored  : "
          f"{implied_played/implied_rows:.4f}")
    print(f"   => the +/-15d window biases availability UPWARD by "
          f"{u['PLAYED'].mean() - implied_played/implied_rows:+.4f}")

    print("\nlargest interior gaps (long injuries partially truncated):")
    print(spell.nlargest(8, "interior_gap")[
        ["first", "last", "n_eligible", "span", "interior_gap"]
    ].to_string())

    print()
    print("=" * 72)
    print("3. OBSERVED CONSECUTIVE-ABSENCE RUN LENGTHS")
    print("=" * 72)
    v = u.sort_values(["SEASON", "PLAYER_ID", "TEAM_ID", "GAME_DATE"]).copy()
    key = ["SEASON", "PLAYER_ID", "TEAM_ID"]
    v["_miss"] = 1 - v["PLAYED"]
    v["_grp"] = (v["PLAYED"] != v.groupby(key)["PLAYED"].shift(1)).cumsum()
    runs = (
        v[v["_miss"] == 1]
        .groupby(["_grp"])
        .size()
        .value_counts()
        .sort_index()
    )
    print("run length -> count of absence streaks")
    print(runs.head(20).to_string())
    print(f"\nlongest observed absence streak: {runs.index.max()} consecutive team-games")
    print("A genuine season-ending injury would be 40-60+ games; the window "
          "truncates these, which is exactly the bias measured in section 2.")

    print()
    print("=" * 72)
    print("4. AVAILABILITY MODEL CALIBRATION (origin 3, valid = 2025-02)")
    print("=" * 72)
    from features import FEATURE_COLS
    from models import make_lgbm_classifier

    f = pd.read_parquet(DATA_DIR / "features.parquet")
    f["GAME_DATE"] = pd.to_datetime(f["GAME_DATE"])
    feats = [c for c in FEATURE_COLS if c in f.columns]
    tr = f[f["GAME_DATE"] < pd.Timestamp("2025-02-01")]
    va = f[(f["GAME_DATE"] >= pd.Timestamp("2025-02-01"))
           & (f["GAME_DATE"] <= pd.Timestamp("2025-02-28"))]

    m = make_lgbm_classifier()
    m.fit(tr[feats], tr["PLAYED"].astype(int))
    p = m.predict_proba(va[feats])[:, 1]

    bins = np.linspace(0, 1, 11)
    idx = np.digitize(p, bins) - 1
    idx = np.clip(idx, 0, 9)
    cal = pd.DataFrame({
        "bin": [f"{bins[i]:.1f}-{bins[i+1]:.1f}" for i in range(10)],
        "n": [int((idx == i).sum()) for i in range(10)],
        "mean_pred": [p[idx == i].mean() if (idx == i).any() else np.nan
                      for i in range(10)],
        "actual_rate": [va["PLAYED"].to_numpy()[idx == i].mean()
                        if (idx == i).any() else np.nan for i in range(10)],
    })
    cal["gap"] = cal["actual_rate"] - cal["mean_pred"]
    print(cal.to_string(index=False))

    print("\ntop 15 features by LightGBM gain:")
    imp = pd.Series(m.booster_.feature_importance("gain"), index=feats)
    print(imp.sort_values(ascending=False).head(15).to_string())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
