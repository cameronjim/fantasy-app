"""rolling-origin evaluation report.

    python evaluate.py --dataset data/dataset.parquet --version 2026-08-16

writes ml/reports/<version>.md plus the tidy long results as csv next to it, so
a later run can be diffed numerically rather than by eyeballing markdown.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fnba_ml.cli import add_common_args, default_dataset_path, load_dataset, setup_logging  # noqa: E402
from fnba_ml.config import FEATURE_VERSION, ORIGINS, REPORTS_DIR  # noqa: E402
from fnba_ml.evaluate import (  # noqa: E402
    TASK_AVAILABILITY,
    TASK_UNCONDITIONAL,
    mean_by_model,
    render_report,
    run_rolling_origin,
    select_champions,
)
from fnba_ml.registry import git_commit  # noqa: E402

log = logging.getLogger("evaluate")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_common_args(parser)
    parser.add_argument("--dataset", type=Path, default=default_dataset_path())
    parser.add_argument("--version", default="unversioned")
    parser.add_argument("--reports-dir", type=Path, default=REPORTS_DIR)
    parser.add_argument("--origins", type=Path, default=None,
                        help="optional csv of name,valid_start,valid_end overriding config")
    return parser.parse_args(argv)


def load_origins(path: Path | None) -> list[tuple[str, str, str]]:
    if path is None:
        return ORIGINS
    frame = pd.read_csv(path)
    return [tuple(row) for row in frame.itertuples(index=False, name=None)]


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    setup_logging(args.verbose)

    features = load_dataset(args.dataset)
    origins = load_origins(args.origins)

    results = run_rolling_origin(features, origins)
    champions = select_champions(results)

    meta = {
        "generated_at": pd.Timestamp.now("UTC").strftime("%Y-%m-%d %H:%M UTC"),
        "model_version": args.version,
        "dataset": str(args.dataset),
        "universe_source": (
            str(features["UNIVERSE_SOURCE"].iloc[0])
            if "UNIVERSE_SOURCE" in features.columns else "unknown"
        ),
        "rows": f"{len(features):,}",
        "players": f"{features['PLAYER_ID'].nunique():,}",
        "played_rate": f"{features['PLAYED'].mean():.4f}",
        "feature_version": FEATURE_VERSION,
        "git_commit": git_commit() or "unknown",
    }

    args.reports_dir.mkdir(parents=True, exist_ok=True)
    report_path = args.reports_dir / f"{args.version}.md"
    report_path.write_text(render_report(results, champions, meta), encoding="utf-8")
    results_path = args.reports_dir / f"{args.version}_results.csv"
    results.to_csv(results_path, index=False)

    print("--- EVALUATE ---")
    print(f"origins   : {len(origins)}")
    print(f"report    -> {report_path}")
    print(f"tidy csv  -> {results_path}\n")

    print("availability Brier (mean over origins):")
    print(mean_by_model(results, TASK_AVAILABILITY, "Brier").to_string())
    print("\nunconditional PTS MAE (mean over origins):")
    print(mean_by_model(results, TASK_UNCONDITIONAL, "MAE").to_string())
    if not champions.empty:
        print("\nchampion selection:")
        print(champions.to_string(index=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
