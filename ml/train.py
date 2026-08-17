"""train the availability model and snapshot the EWMA production state.

    python train.py --dataset data/dataset.parquet --version 2026-08-16

ONE model is trained: P(play). the conditional production estimate is
EWMA(halflife 5) and is not learned - it is snapshotted so a prediction run can
reproduce it without replaying the whole appearance history. that asymmetry is
the spike's central finding, not an omission (REPORT.md section 6).

metrics written to the registry come from a holdout window immediately before
the training cutoff, never from the training rows themselves. the shipped
artifact is then refit on the full window. the prediction-quantile offsets
(fnba_ml/intervals.py) come from that same holdout window, for the same reason:
residuals measured on training rows understate the spread.

metadata.json carries feature_version, the git commit and the availability
artifact's sha256 as well as the metrics, because those three are what a stored
prediction needs to be traced back to the code and bytes that produced it
(prediction_runs, migration 014). the registry keeps its own copy - it is the
audit record - but predict.py should not have to read two files to write one
provenance row.
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

from fnba_ml import registry  # noqa: E402
from fnba_ml.cli import (  # noqa: E402
    add_common_args,
    default_dataset_path,
    load_dataset,
    setup_logging,
    version_dir,
)
from fnba_ml.config import (  # noqa: E402
    CHAMPIONS,
    CUTOFF_POLICY,
    FEATURE_VERSION,
    LGBM_PARAMS,
    MODELS_DIR,
    resolve_cutoff,
)
from fnba_ml.features import available_features  # noqa: E402
from fnba_ml.intervals import (  # noqa: E402
    QUANTILE_TARGETS,
    QuantileOffsets,
    fit_residual_quantiles,
)
from fnba_ml.models import (  # noqa: E402
    AvailabilityModel,
    EwmaProduction,
    baseline_column,
    brier,
    logloss,
    skill_score,
    snapshot_ewma_state,
)

log = logging.getLogger("train")

MODEL_FILE = "availability_model.joblib"
EWMA_FILE = "ewma_state.parquet"
META_FILE = "metadata.json"
DEFAULT_HOLDOUT_DAYS = 28


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_common_args(parser)
    parser.add_argument("--dataset", type=Path, default=default_dataset_path())
    parser.add_argument("--version", default=None, help="model version, default today's date")
    parser.add_argument("--cutoff", default=None,
                        help=f"training cutoff. policy: {CUTOFF_POLICY}")
    parser.add_argument("--holdout-days", type=int, default=DEFAULT_HOLDOUT_DAYS)
    parser.add_argument("--models-dir", type=Path, default=MODELS_DIR)
    return parser.parse_args(argv)


def holdout_metrics(
    features: pd.DataFrame, feature_cols: list[str], cutoff: pd.Timestamp, holdout_days: int
) -> dict[str, float]:
    """honest metrics from the last window before the cutoff."""
    split_at = cutoff - pd.Timedelta(days=holdout_days)
    train = features[features["GAME_DATE"] < split_at]
    valid = features[(features["GAME_DATE"] >= split_at) & (features["GAME_DATE"] < cutoff)]
    if train.empty or valid.empty:
        log.warning("holdout window is empty; registry metrics will be omitted")
        return {}

    model = AvailabilityModel(kind=CHAMPIONS["availability"]).fit(train, feature_cols, split_at)
    p = model.predict_proba(valid)
    y = valid["PLAYED"].to_numpy(dtype=int)
    base = baseline_column(valid, "avail_rate_10", float(train["PLAYED"].mean()))
    return {
        "holdout_start": str(split_at.date()),
        "holdout_rows": int(len(valid)),
        "holdout_played_rate": round(float(valid["PLAYED"].mean()), 6),
        "brier": round(brier(y, p), 6),
        "log_loss": round(logloss(y, p), 6),
        "brier_skill_vs_shifted_rate": round(skill_score(brier(y, p), brier(y, base)), 6),
    }


def holdout_quantiles(
    features: pd.DataFrame, cutoff: pd.Timestamp, holdout_days: int
) -> dict[str, QuantileOffsets]:
    """P10/P50/P90 offsets for the conditional champion, per target.

    measured on APPEARANCES in the holdout window only. the estimate being
    quantified is "given he plays", so a row where he did not play carries no
    residual - folding those in as zeros would widen the interval with the
    availability question the P(play) column already answers.
    """
    split_at = cutoff - pd.Timedelta(days=holdout_days)
    train = features[features["GAME_DATE"] < split_at]
    valid = features[(features["GAME_DATE"] >= split_at) & (features["GAME_DATE"] < cutoff)]
    if "PLAYED" in valid.columns:
        valid = valid[valid["PLAYED"] == 1]
    if train.empty or valid.empty:
        log.warning("holdout window is empty; no quantile offsets will be written")
        return {}

    window = (str(split_at.date()), str(pd.Timestamp(cutoff).date()))
    offsets: dict[str, QuantileOffsets] = {}
    for target in QUANTILE_TARGETS:
        if target not in valid.columns or f"ewma_{target}" not in valid.columns:
            log.warning("no ewma_%s / %s in the dataset; skipping its quantiles", target, target)
            continue
        estimator = EwmaProduction(target).fit(train)
        offsets[target] = fit_residual_quantiles(
            valid[target], estimator.predict(valid), target, window=window
        )
    return offsets


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    setup_logging(args.verbose)

    features = load_dataset(args.dataset)
    feature_cols = available_features(features)

    cutoff = (
        resolve_cutoff(args.cutoff) if args.cutoff
        else features["GAME_DATE"].max() + pd.Timedelta(days=1)
    )
    train = features[features["GAME_DATE"] < cutoff]
    if train.empty:
        raise SystemExit(f"no training rows before cutoff {cutoff.date()}")

    version = args.version or pd.Timestamp.now("UTC").strftime("%Y%m%d")
    out_dir = version_dir(version, args.models_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    metrics = holdout_metrics(features, feature_cols, cutoff, args.holdout_days)

    model = AvailabilityModel(kind=CHAMPIONS["availability"]).fit(train, feature_cols, cutoff)
    joblib.dump(model, out_dir / MODEL_FILE)

    ewma_state = snapshot_ewma_state(features, cutoff)
    fallbacks = dict(ewma_state.attrs.get("fallbacks", {}))
    ewma_state.to_parquet(out_dir / EWMA_FILE, index=False)

    universe_source = (
        str(features["UNIVERSE_SOURCE"].iloc[0]) if "UNIVERSE_SOURCE" in features.columns
        else "unknown"
    )
    training_window = {
        "start": str(train["GAME_DATE"].min().date()),
        "end": str(train["GAME_DATE"].max().date()),
        "cutoff": str(pd.Timestamp(cutoff).date()),
        "cutoff_policy": CUTOFF_POLICY,
        "rows": int(len(train)),
        "players": int(train["PLAYER_ID"].nunique()),
        "played_rate": round(float(train["PLAYED"].mean()), 6),
    }
    quantiles = holdout_quantiles(features, cutoff, args.holdout_days)
    production = {
        "estimator": EwmaProduction("PTS").kind,
        "halflife": EwmaProduction("PTS").halflife,
        "fallbacks": {k: round(v, 6) for k, v in fallbacks.items()},
        "quantiles": {target: q.as_dict() for target, q in quantiles.items()},
    }

    # provenance a stored prediction needs: which feature contract, which
    # commit, and the exact bytes of the model that produced it. these land in
    # prediction_runs.{feature_version,code_sha,artifact_checksum}.
    metadata = {
        "model_version": version,
        "feature_version": FEATURE_VERSION,
        "git_commit": registry.git_commit(),
        "artifact_checksum": registry.sha256_file(out_dir / MODEL_FILE),
        "champions": CHAMPIONS,
        "availability_hyperparams": LGBM_PARAMS,
        "production": production,
        "training_window": training_window,
        "universe_source": universe_source,
        "feature_cols": feature_cols,
        "metrics": metrics,
    }
    with open(out_dir / META_FILE, "w", encoding="utf-8") as fh:
        json.dump(metadata, fh, indent=2)
        fh.write("\n")

    gain = model.feature_gain()
    if not gain.empty:
        gain.rename("gain").to_csv(out_dir / "feature_gain.csv", header=True)

    entry = registry.build_entry(
        model_version=version,
        version_dir=out_dir,
        training_window=training_window,
        hyperparams={"availability": LGBM_PARAMS, "production": production},
        metrics=metrics,
        champions=CHAMPIONS,
        universe_source=universe_source,
        feature_cols=feature_cols,
    )
    registry.upsert(entry, args.models_dir / "registry.json")

    print("--- TRAIN ---")
    print(f"version          : {version}")
    print(f"training window  : {training_window['start']} .. {training_window['end']} "
          f"(cutoff {training_window['cutoff']})")
    print(f"universe         : {universe_source}")
    print(f"availability     : {CHAMPIONS['availability']} on {len(feature_cols)} features")
    print(f"production        : EWMA(halflife {production['halflife']}) - snapshot only, "
          f"{len(ewma_state):,} players")
    print(f"feature version  : {FEATURE_VERSION}")
    print(f"artifact sha256  : {metadata['artifact_checksum'][:16]}...")
    for target, offsets in quantiles.items():
        levels = ", ".join(
            f"P{int(round(lv * 100)):02d} {off:+.2f}"
            for lv, off in zip(offsets.levels, offsets.offsets)
        )
        print(f"quantiles {target:<6s} : {levels}  (n={offsets.n:,})")
    for key, value in metrics.items():
        print(f"  {key:28s} {value}")
    if not gain.empty:
        print("\ntop 8 availability features by gain:")
        print(gain.head(8).to_string())
    print(f"\nartifacts -> {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
