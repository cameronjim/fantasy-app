"""build the scheduled-player-game feature dataset.

    python build_dataset.py --source parquet --data-dir ../ml-spike/data
    python build_dataset.py --source postgres --out data/dataset.parquet

writes one parquet: every scheduled player-game with as-of-safe features and
the outcome columns. this is the only file train.py, evaluate.py and predict.py
read.

THIS SCRIPT NOW FITS MODELS (feature_version v3). The served teammate-context
features are expectations over as-of play probabilities, and those probabilities
come from a base availability model cross-fitted over forward-chaining calendar
blocks (``models.cross_fit_base_probabilities``). The alternative was for
evaluate.py, train.py and predict.py each to run the cross-fit independently and
hope they agreed on it; one dataset that carries ``P_CONTEXT`` and its cutoff is
cheaper and auditable. The cost is roughly a minute of LightGBM per season on the
four-season build, and the share of rows whose probability came from the base model
rather than the stage-0 baseline is printed below.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fnba_ml.cli import add_common_args, add_source_args, build_source, setup_logging  # noqa: E402
from fnba_ml.config import (  # noqa: E402
    DATA_DIR,
    FEATURE_COLS,
    FEATURE_SETS,
    FEATURE_VERSION,
    MAGNITUDE_SHRINK_K,
    MAGNITUDE_WINDOW,
    P_CONTEXT,
    V4_FEATURE_COLS,
)
from fnba_ml.features import attach_cross_fit_context, build_features  # noqa: E402
from fnba_ml.matchup import attach_v4_features  # noqa: E402
from fnba_ml.teammates import (  # noqa: E402
    position_group_counts,
    teammate_feature_summary,
)
from fnba_ml.universe import build_universe, coverage_report  # noqa: E402

log = logging.getLogger("build_dataset")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_source_args(parser)
    add_common_args(parser)
    parser.add_argument("--out", type=Path, default=DATA_DIR / "dataset.parquet")
    parser.add_argument(
        "--no-v4-candidate", action="store_true",
        help="skip the P2 matchup / blowout / stakes / start-rate columns "
             f"({len(V4_FEATURE_COLS)} of them, fnba_ml.matchup). they are PURELY "
             f"ADDITIVE - FEATURE_COLS names none of them and the served contract is "
             f"unchanged - and they cost one extra LightGBM cross-fit over 9,840 "
             f"team-games. This flag exists so a dataset can be rebuilt to the exact "
             f"pre-P2 column set if a v3 number ever has to be reproduced",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    setup_logging(args.verbose)

    source = build_source(args)
    universe = build_universe(source)
    coverage = coverage_report(universe, source.load_player_game_logs())
    features = build_features(universe)
    # STAGE 2 + 3 of the two-stage pipeline. The dataset build now fits models -
    # one base availability model per calendar block - which is a change in the
    # character of this script and is stated in its docstring. The alternative was
    # for every consumer (evaluate, train, predict) to run the same cross-fit
    # independently and hope they agreed.
    features = attach_cross_fit_context(features)
    # P2's candidate family. Additive: FEATURE_COLS names none of these columns, so
    # the served 51-column contract and the frozen artifact are unaffected, and
    # FEATURE_SETS["v4"] becomes evaluable over the same rows as v3-honest.
    if not args.no_v4_candidate:
        features = attach_v4_features(features, source.load_team_game_logs())

    args.out.parent.mkdir(parents=True, exist_ok=True)
    features.to_parquet(args.out, index=False)

    universe_source = str(universe["UNIVERSE_SOURCE"].iloc[0])
    print("--- DATASET ---")
    print(f"source           : {source.name}")
    print(f"universe         : {universe_source}"
          + ("   <-- BIASED, fixture/backtest only" if universe_source == "approximation" else ""))
    for key, value in coverage.items():
        print(f"{key:17s}: {value:,.4f}")
    print(f"feature version  : {FEATURE_VERSION}")
    print(f"feature columns  : {len(FEATURE_COLS)}")
    print(f"rows             : {len(features):,}")
    print(f"saved            -> {args.out}")

    # the v3 provenance block: which probability built the context features, and how
    # much of it came from a model rather than from the baseline fallback.
    if "P_CONTEXT_SOURCE" in features.columns:
        shares = features["P_CONTEXT_SOURCE"].value_counts(normalize=True)
        print("\ncontext probability p_j (stage 2):")
        for label, share in shares.items():
            print(f"  {str(label):14s} {share:7.2%}")
        print(f"  mean p          {features[P_CONTEXT].mean():7.4f}")
    print(f"\nmagnitude window : last {MAGNITUDE_WINDOW} appearances, career-scoped, "
          f"shrunk with k={MAGNITUDE_SHRINK_K:g}")
    print("feature sets     : "
          + ", ".join(f"{name}={len([c for c in cols if c in features.columns])}"
                      for name, cols in FEATURE_SETS.items()))

    # the v2 family gets its own block because its null pattern is the thing most
    # likely to be silently wrong: a source with no positions, or team logs with no
    # possession totals, produce a fully-null column rather than an error.
    positions = position_group_counts(features)
    if not positions.empty:
        print("\nrows per position bucket:")
        for bucket, count in positions.items():
            print(f"  {str(bucket):12s} {count:>8,}")
    summary = teammate_feature_summary(features)
    if not summary.empty:
        print("\nteammate-context features:")
        print(summary.to_string(float_format=lambda v: f"{v:8.3f}"))

    present = [c for c in FEATURE_COLS if c in features.columns]
    nulls = features[present].isna().mean().sort_values(ascending=False)
    print("\nnull rate per feature (top 10):")
    for name, rate in nulls.head(10).items():
        print(f"  {name:26s} {rate:7.4f}")

    print("\nplayed rate by minutes tier:")
    print(features.groupby("MIN_TIER")["PLAYED"].agg(["mean", "size"]).to_string())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
