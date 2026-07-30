"""next-games predictions from a trained model version.

    python predict.py --dataset data/dataset.parquet --version 2026-08-16 \
        --out data/predictions.parquet

emits, per scheduled player-game at or after the model's training cutoff:
P(play), the EWMA conditional estimate for each target, the P10/P50/P90
quantiles around the conditional minutes and points estimates, and the
decomposed unconditional estimate P(play) x E[stat | played].

the P(play) column travels with the training cutoff that produced it and is run
through ``validate_out_of_fold`` before it multiplies anything, so a model
loaded against a dataset it was partly trained on fails loudly instead of
silently emitting contaminated numbers.

``--write-db`` writes the run to the migration-014 tables in a single
transaction: one ``prediction_runs`` row for the provenance, one
``player_game_predictions`` row per (player, game, stat, quantile). append-only
- a re-run writes a new run, it never edits an old one, because a prediction
that can be revised after the fact cannot be backtested.

it refuses to write from the BIASED fallback universe. the approximation
over-predicts availability in every calibration bin and cannot represent an
absence longer than ~16 team-games (README, "the universe"), and a stored
prediction outlives the caveat that came with it. ``--allow-biased-universe``
forces it and stamps the reason into the run's notes.
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
from fnba_ml import registry  # noqa: E402
from fnba_ml.config import DATA_DIR, MINUTES_TARGET, MODELS_DIR, PRODUCTION_TARGETS  # noqa: E402
from fnba_ml.intervals import (  # noqa: E402
    QUANTILE_LEVELS,
    QuantileOffsets,
    attach_quantiles,
)
from fnba_ml.models import (  # noqa: E402
    P_PLAY,
    P_PLAY_CUTOFF,
    EwmaProduction,
    LeakageError,
    decomposed_estimate,
    validate_out_of_fold,
)
from fnba_ml.store import (  # noqa: E402
    build_prediction_rows,
    build_run_record,
    utc_now,
    write_predictions,
)

log = logging.getLogger("predict")

TARGETS = (MINUTES_TARGET, *PRODUCTION_TARGETS)

# the label universe.py stamps on every row when the roster had to be
# reconstructed from game-log presence. predictions from it are not shippable.
BIASED_UNIVERSE = "approximation"

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
                        help="also insert the run into prediction_runs / "
                             "player_game_predictions (migration 014). needs DATABASE_URL")
    parser.add_argument("--allow-biased-universe", action="store_true",
                        help="permit --write-db from the approximation universe. "
                             "it over-states availability; do not use for anything served")
    parser.add_argument("--notes", default=None, help="free text stored on the run row")
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


def load_quantile_offsets(metadata: dict) -> dict[str, QuantileOffsets]:
    """the P10/P50/P90 offsets train.py measured on its holdout window.

    absent for a model trained before intervals existed. that is a missing
    feature, not a failure: the run still emits expected values, and the serving
    path shows a point estimate instead of a range.
    """
    stored = metadata.get("production", {}).get("quantiles", {}) or {}
    offsets: dict[str, QuantileOffsets] = {}
    for target, payload in stored.items():
        try:
            offsets[target] = QuantileOffsets.from_dict(payload)
        except (KeyError, TypeError, ValueError) as exc:
            log.warning("ignoring unreadable quantile offsets for %s: %s", target, exc)
    if not offsets:
        log.warning(
            "model %s carries no quantile offsets; predictions will be point "
            "estimates only. retrain to populate them.", metadata.get("model_version"),
        )
    return offsets


def build_predictions(features: pd.DataFrame, model, metadata: dict) -> pd.DataFrame:
    scored = model.attach(features)
    validate_out_of_fold(scored)

    fallbacks = metadata.get("production", {}).get("fallbacks", {})
    quantiles = load_quantile_offsets(metadata)
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
        # quantiles wrap the CONDITIONAL estimate: the offsets were measured on
        # appearances, so they describe the spread of a night he actually plays.
        # the unconditional number is a schedule-level mean and has no such
        # interval - "he might score 6 or 31, or not play" is two questions.
        if target in quantiles:
            out = attach_quantiles(out, conditional, quantiles[target])

    out["MODEL_VERSION"] = metadata.get("model_version")
    out["FEATURE_VERSION"] = metadata.get("feature_version", "unknown")
    return out.reset_index(drop=True)


def universe_source(features: pd.DataFrame, metadata: dict) -> str:
    if "UNIVERSE_SOURCE" in features.columns and len(features) > 0:
        return str(features["UNIVERSE_SOURCE"].iloc[0])
    return str(metadata.get("universe_source", "unknown"))


def write_run(
    predictions: pd.DataFrame,
    metadata: dict,
    forecast_cutoff: pd.Timestamp,
    notes: str | None,
) -> tuple[int, int]:
    """build the rows, insert them in one transaction, link the run back."""
    rows = build_prediction_rows(predictions, TARGETS, QUANTILE_LEVELS)
    predicted_at = utc_now()
    run_record = build_run_record(
        metadata,
        predicted_at=predicted_at,
        # the information boundary: every game at or after it is what the run is
        # predicting, and nothing at or after it was visible to the model.
        forecast_cutoff_at=pd.Timestamp(forecast_cutoff).to_pydatetime(),
        # the commit that made the PREDICTION. the commit that trained the model
        # is a different fact and lives in the registry entry.
        code_sha=registry.git_commit(),
        status="complete",
        notes=notes,
    )
    run_id = write_predictions(rows, run_record)
    registry.record_prediction_run(
        str(metadata.get("model_version")),
        {
            "run_id": run_id,
            "predicted_at": predicted_at.isoformat(timespec="seconds"),
            "forecast_cutoff_at": str(pd.Timestamp(forecast_cutoff)),
            "rows": len(rows),
            "player_games": int(len(predictions)),
        },
    )
    return run_id, len(rows)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    setup_logging(args.verbose)

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

    source = universe_source(upcoming, metadata)
    notes = args.notes
    if args.write_db and source == BIASED_UNIVERSE:
        if not args.allow_biased_universe:
            print(
                "refusing --write-db: this dataset was built from the BIASED "
                "approximation universe, which over-predicts availability in every "
                "calibration bin and cannot represent an absence longer than ~16 "
                "team-games. rebuild from player_game_status, or pass "
                "--allow-biased-universe if you understand these numbers are not "
                "servable."
            )
            return 2
        notes = "; ".join(filter(None, [notes, "BIASED UNIVERSE: approximation, not servable"]))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    predictions.to_parquet(args.out, index=False)

    written: tuple[int, int] | None = None
    if args.write_db:
        written = write_run(predictions, metadata, run_at, notes)

    print("--- PREDICT ---")
    print(f"version   : {args.version}")
    print(f"run at    : {run_at.date()} (model cutoff {pd.Timestamp(model.cutoff).date()})")
    print(f"universe  : {source}")
    print(f"rows      : {len(predictions):,}")
    print(f"games     : {predictions['GAME_ID'].nunique():,}")
    print(f"mean P(play) : {predictions[P_PLAY].mean():.4f}")
    for target in TARGETS:
        col = f"E_{target}"
        if col in predictions.columns:
            print(f"mean E[{target}] : {predictions[col].mean():.4f}  "
                  f"(conditional {predictions[f'E_{target}_COND'].mean():.4f})")
    print(f"saved     -> {args.out}")
    if written is not None:
        print(f"database  -> prediction_runs id {written[0]}, {written[1]:,} prediction rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
