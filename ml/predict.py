"""next-games predictions from a trained model version.

    python predict.py --dataset data/dataset.parquet --version 2026-08-16 \
        --out data/predictions.parquet

emits, per scheduled player-game at or after the model's training cutoff:
P(play), the EWMA conditional estimate for each target, and the decomposed
unconditional estimate P(play) x E[stat | played].

the P(play) column travels with the training cutoff that produced it and is run
through ``validate_out_of_fold`` before it multiplies anything, so a model
loaded against a dataset it was partly trained on fails loudly instead of
silently emitting contaminated numbers.

``--write-db`` is wired but inert: the predictions table arrives with migration
014, which is not in the repo yet.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

import joblib  # noqa: E402

from fnba_ml.cli import (  # noqa: E402
    add_common_args,
    default_dataset_path,
    load_dataset,
    setup_logging,
    version_dir,
)
from fnba_ml.config import DATA_DIR, MINUTES_TARGET, MODELS_DIR, PRODUCTION_TARGETS  # noqa: E402
from fnba_ml.models import (  # noqa: E402
    P_PLAY,
    P_PLAY_CUTOFF,
    EwmaProduction,
    LeakageError,
    decomposed_estimate,
    validate_out_of_fold,
)

log = logging.getLogger("predict")

TARGETS = (MINUTES_TARGET, *PRODUCTION_TARGETS)
MIGRATION_PENDING = "migration 014 pending"

KEY_COLS = ["PLAYER_ID", "PLAYER_NAME", "GAME_ID", "TEAM_ID", "OPP_TEAM_ID",
            "GAME_DATE", "SEASON", "IS_HOME", "MIN_TIER"]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_common_args(parser)
    parser.add_argument("--dataset", type=Path, default=default_dataset_path())
    parser.add_argument("--version", required=True)
    parser.add_argument("--models-dir", type=Path, default=MODELS_DIR)
    parser.add_argument("--out", type=Path, default=DATA_DIR / "predictions.parquet")
    parser.add_argument("--run-at", default=None,
                        help="only score games on or after this date; defaults to the "
                             "model's training cutoff")
    parser.add_argument("--write-db", action="store_true",
                        help=f"not available yet ({MIGRATION_PENDING})")
    return parser.parse_args(argv)


def load_version(version: str, models_dir: Path):
    dir_ = version_dir(version, models_dir)
    model_path = dir_ / "availability_model.joblib"
    meta_path = dir_ / "metadata.json"
    if not model_path.exists():
        raise SystemExit(f"no trained model at {model_path}. run train.py first.")
    with open(meta_path, encoding="utf-8") as fh:
        metadata = json.load(fh)
    return joblib.load(model_path), metadata


def build_predictions(features: pd.DataFrame, model, metadata: dict) -> pd.DataFrame:
    scored = model.attach(features)
    validate_out_of_fold(scored)

    fallbacks = metadata.get("production", {}).get("fallbacks", {})
    out = scored[[c for c in KEY_COLS if c in scored.columns] + [P_PLAY, P_PLAY_CUTOFF]].copy()

    for target in TARGETS:
        column = f"ewma_{target}"
        if column not in features.columns:
            log.warning("dataset has no %s; skipping target %s", column, target)
            continue
        estimator = EwmaProduction.from_fallback(target, float(fallbacks.get(target, 0.0)))
        conditional = estimator.predict(features)
        out[f"E_{target}_COND"] = conditional
        out[f"E_{target}"] = decomposed_estimate(scored, conditional)

    out["MODEL_VERSION"] = metadata.get("model_version")
    out["FEATURE_VERSION"] = metadata.get("feature_version", "unknown")
    return out.reset_index(drop=True)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    setup_logging(args.verbose)

    if args.write_db:
        print(f"--write-db is not available: {MIGRATION_PENDING}. "
              f"predictions were not written. re-run without the flag to emit parquet.")
        return 2

    model, metadata = load_version(args.version, args.models_dir)
    features = load_dataset(args.dataset)

    run_at = pd.Timestamp(args.run_at) if args.run_at else pd.Timestamp(model.cutoff)
    upcoming = features[features["GAME_DATE"] >= run_at]
    if upcoming.empty:
        raise SystemExit(
            f"no scheduled rows on or after {run_at.date()} in {args.dataset}. "
            f"the model's cutoff is {pd.Timestamp(model.cutoff).date()}."
        )

    try:
        predictions = build_predictions(upcoming, model, metadata)
    except LeakageError as exc:
        raise SystemExit(
            f"refusing to emit predictions: {exc}. the model was trained past "
            f"{run_at.date()}; score only games at or after its cutoff "
            f"{pd.Timestamp(model.cutoff).date()}, or retrain."
        ) from exc

    args.out.parent.mkdir(parents=True, exist_ok=True)
    predictions.to_parquet(args.out, index=False)

    print("--- PREDICT ---")
    print(f"version   : {args.version}")
    print(f"run at    : {run_at.date()} (model cutoff {pd.Timestamp(model.cutoff).date()})")
    print(f"rows      : {len(predictions):,}")
    print(f"games     : {predictions['GAME_ID'].nunique():,}")
    print(f"mean P(play) : {predictions[P_PLAY].mean():.4f}")
    for target in TARGETS:
        col = f"E_{target}"
        if col in predictions.columns:
            print(f"mean E[{target}] : {predictions[col].mean():.4f}  "
                  f"(conditional {predictions[f'E_{target}_COND'].mean():.4f})")
    print(f"saved     -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
