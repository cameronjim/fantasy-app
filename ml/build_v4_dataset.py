"""backfill the P2 candidate columns onto an EXISTING dataset. Additive, never destructive."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fnba_ml.cli import (  # noqa: E402
    add_common_args,
    add_source_args,
    build_source,
    default_dataset_path,
    load_dataset,
    setup_logging,
)
from fnba_ml.config import (  # noqa: E402
    BLOWOUT_MARGIN,
    BLOWOUT_MODEL_KIND,
    BLOWOUT_PROB,
    BLOWOUT_SELECTION_CUTOFF,
    BLOWOUT_SELECTION_TRAIN_SHARE,
    DATA_DIR,
    FEATURE_COLS,
    FEATURE_COLS_V4,
    V4_FEATURE_COLS,
)
from fnba_ml.matchup import (  # noqa: E402
    BLOWOUT_TARGET,
    attach_v4_features,
    blowout_model_quality,
    cross_fit_blowout_probabilities,
    select_blowout_estimator,
    team_game_context,
)

log = logging.getLogger("build_v4_dataset")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_source_args(parser)
    add_common_args(parser)
    parser.add_argument("--dataset", type=Path, default=default_dataset_path(),
                        help="the existing v3 dataset to decorate")
    parser.add_argument("--out", type=Path, default=DATA_DIR / "dataset_v4.parquet")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    setup_logging(args.verbose)

    features = load_dataset(args.dataset)
    if args.out.resolve() == args.dataset.resolve():
        raise SystemExit(
            "--out must differ from --dataset: the v3 dataset is the file every "
            "published v3 number was computed from and it is not overwritten"
        )

    source = build_source(args)
    team_logs = source.load_team_game_logs()

    home = features[["GAME_ID", "TEAM_ID", "IS_HOME"]].drop_duplicates(
        ["GAME_ID", "TEAM_ID"]
    )
    context = team_game_context(team_logs, home_flags=home)
    # reported, never acted on: config.BLOWOUT_MODEL_KIND stays pre-registered.
    selection = select_blowout_estimator(context)
    probabilities = cross_fit_blowout_probabilities(context)
    quality = blowout_model_quality(context, probabilities)

    out = attach_v4_features(features, team_logs)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    out.to_parquet(args.out, index=False)

    added = [c for c in V4_FEATURE_COLS if c in out.columns]
    absent = [c for c in V4_FEATURE_COLS if c not in out.columns]

    print("--- V4 CANDIDATE BACKFILL ---")
    print(f"source           : {source.name}")
    print(f"input dataset    : {args.dataset}  ({len(features):,} rows, "
          f"{len(features.columns)} columns)")
    print(f"team-game context: {len(context):,} team-games, "
          f"{context['SEASON'].nunique()} seasons")
    print(f"output           -> {args.out}  ({len(out):,} rows, "
          f"{len(out.columns)} columns)")
    print(f"served contract  : FEATURE_COLS still {len(FEATURE_COLS)} columns "
          f"(unchanged)")
    print(f"candidate        : FEATURE_COLS_V4 {len(FEATURE_COLS_V4)} columns, "
          f"{len(added)}/{len(V4_FEATURE_COLS)} new columns present")
    if absent:
        print(f"  MISSING        : {', '.join(absent)}")
    if len(out) != len(features):
        raise SystemExit(
            f"the backfill changed the row count ({len(features)} -> {len(out)}); "
            f"every merge in matchup.py is validated, so this should be unreachable"
        )

    if not selection.empty:
        print(f"\nblowout estimator selection on INNER folds (< "
              f"{BLOWOUT_SELECTION_CUTOFF}, time-ordered "
              f"{BLOWOUT_SELECTION_TRAIN_SHARE:.0%}/"
              f"{1 - BLOWOUT_SELECTION_TRAIN_SHARE:.0%} split; lower Brier wins). "
              f"shipped: {BLOWOUT_MODEL_KIND}")
        print(selection.to_string(index=False,
                                  float_format=lambda v: f"{v:9.4f}"))

    print(f"\nblowout label    : |margin| >= {BLOWOUT_MARGIN:g}, base rate "
          f"{quality.get('base_rate', float('nan')):.4f} over "
          f"{int(quality.get('n', 0)):,} team-games")
    print("blowout model (out-of-fold, cross-fitted over calendar-month blocks):")
    for key in ("auc", "brier", "brier_base", "brier_skill",
                "calibration_slope", "calibration_intercept"):
        if key in quality:
            print(f"  {key:22s} {quality[key]:+.4f}")
    shares = probabilities["BLOWOUT_SOURCE"].value_counts(normalize=True)
    for label, share in shares.items():
        print(f"  source {str(label):15s} {share:7.2%}")

    print("\nnull rate per candidate column:")
    nulls = out[added].isna().mean().sort_values(ascending=False)
    for name, rate in nulls.items():
        print(f"  {name:28s} {rate:7.4f}")

    print("\ncandidate column summary (mean / sd / p05 / p95):")
    summary = out[added].describe(percentiles=[0.05, 0.95]).T
    print(summary[["mean", "std", "5%", "95%"]].to_string(
        float_format=lambda v: f"{v:9.3f}"
    ))

    if BLOWOUT_PROB in out.columns and BLOWOUT_TARGET in out.columns:
        decile = out[BLOWOUT_PROB] >= out[BLOWOUT_PROB].quantile(0.90)
        print("\nblowout_prob top decile vs the rest (player-game rows):")
        print(out.groupby(decile)[[BLOWOUT_TARGET, "MIN"]].agg(
            ["mean", "size"]
        ).to_string())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
