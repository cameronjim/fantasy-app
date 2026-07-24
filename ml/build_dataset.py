"""build the scheduled-player-game feature dataset.

    python build_dataset.py --source parquet --data-dir ../ml-spike/data
    python build_dataset.py --source postgres --out data/dataset.parquet

writes one parquet: every scheduled player-game with as-of-safe features and
the outcome columns. this is the only file train.py, evaluate.py and predict.py
read.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fnba_ml.cli import add_common_args, add_source_args, build_source, setup_logging  # noqa: E402
from fnba_ml.config import DATA_DIR, FEATURE_COLS  # noqa: E402
from fnba_ml.features import build_features  # noqa: E402
from fnba_ml.universe import build_universe, coverage_report  # noqa: E402

log = logging.getLogger("build_dataset")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_source_args(parser)
    add_common_args(parser)
    parser.add_argument("--out", type=Path, default=DATA_DIR / "dataset.parquet")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    setup_logging(args.verbose)

    source = build_source(args)
    universe = build_universe(source)
    coverage = coverage_report(universe, source.load_player_game_logs())
    features = build_features(universe)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    features.to_parquet(args.out, index=False)

    universe_source = str(universe["UNIVERSE_SOURCE"].iloc[0])
    print("--- DATASET ---")
    print(f"source           : {source.name}")
    print(f"universe         : {universe_source}"
          + ("   <-- BIASED, fixture/backtest only" if universe_source == "approximation" else ""))
    for key, value in coverage.items():
        print(f"{key:17s}: {value:,.4f}")
    print(f"feature columns  : {len(FEATURE_COLS)}")
    print(f"rows             : {len(features):,}")
    print(f"saved            -> {args.out}")

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
