"""backfill the P2 candidate columns onto an EXISTING dataset. Additive, never destructive.

    python build_v4_dataset.py --source postgres
    python build_v4_dataset.py --source parquet --data-dir ../ml-spike/data \
        --dataset data/dataset.parquet --out data/dataset_v4.parquet

WHY THIS EXISTS RATHER THAN `build_dataset.py --source postgres`. Rebuilding the
four-season dataset from scratch needs `player_game_status` for all four seasons, and
the dev database holds 2024-25 onward only (74,870 status rows against the truth
layer's 147,565). A full rebuild there would silently produce a two-season dataset
and every number computed on it would be incomparable with every number in MODEL.md.
So this script does the one thing that IS safe against a partially-backfilled
database: it reads the existing 147,413-row `data/dataset.parquet`, reads
`team_game_logs` (which the dev database DOES hold complete - 2,460 rows per season
in all four), computes the candidate columns, and writes a new file.

THE CODE PATH IS IDENTICAL to the pipeline's. Both call
`fnba_ml.matchup.attach_v4_features`, so a backfilled column and a freshly built one
are the same number by construction and not by inspection - exactly the guarantee
`features.attach_per_minute_rates` makes for the rate columns, and for the same
reason.

READ-ONLY AGAINST THE DATABASE. One SELECT against `team_game_logs`, no writes of any
kind. The output is a new parquet beside the input; the input is never modified, so a
v3 number can always be recomputed from the file it was computed from.
"""

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
                        help="the existing v3 dataset to decorate. NEVER modified")
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

    # the blowout model's quality is reported here rather than only inside the
    # bracket, because it is a claim about the FEATURE and not about the feature
    # set: a blowout_prob with no skill would make every downstream number a
    # statement about noise, and that is worth knowing before three hours of
    # rolling-origin fits rather than after.
    home = features[["GAME_ID", "TEAM_ID", "IS_HOME"]].drop_duplicates(
        ["GAME_ID", "TEAM_ID"]
    )
    context = team_game_context(team_logs, home_flags=home)
    # the inner-fold selection that chose config.BLOWOUT_MODEL_KIND. Reported, never
    # acted on: rerunning it is how the choice is CHECKED, and re-selecting whenever
    # the number moves would turn a pre-registered constant into a rolling refit.
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

    # the sanity block. every one of these is a number a reader can check against
    # a published league figure, and a feature family whose means are absurd is a
    # feature family with a units bug.
    print("\ncandidate column summary (mean / sd / p05 / p95):")
    summary = out[added].describe(percentiles=[0.05, 0.95]).T
    print(summary[["mean", "std", "5%", "95%"]].to_string(
        float_format=lambda v: f"{v:9.3f}"
    ))

    if BLOWOUT_PROB in out.columns and BLOWOUT_TARGET in out.columns:
        # the descriptive check the cohort tables will lean on: does the top decile
        # of predicted blowout probability actually contain more blowouts?
        decile = out[BLOWOUT_PROB] >= out[BLOWOUT_PROB].quantile(0.90)
        print("\nblowout_prob top decile vs the rest (player-game rows):")
        print(out.groupby(decile)[[BLOWOUT_TARGET, "MIN"]].agg(
            ["mean", "size"]
        ).to_string())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
