"""train the availability model and snapshot the EWMA production state.

    python train.py --dataset data/dataset.parquet --version 2026-08-16

TWO models are trained, both at ONE cutoff: P(play) and E[minutes | plays]. the
production estimate is not learned - it is EWMA(halflife 5) of stat PER MINUTE,
snapshotted so a prediction run can reproduce it without replaying the whole
appearance history. that asymmetry is the spike's central finding, not an omission
(REPORT.md section 6).

WHY THE MINUTES ARTIFACT EXISTS AS OF 2026-08-17. minutes was promoted to
LightGBM in config.CHAMPIONS but nothing ever persisted it, so the serving path
was still using the demoted EWMA baseline while the config claimed otherwise -
and, worse, the composition was P(play) x EWMA(stat), in which the minutes number
could not reach the production number at all. both are fixed here: the minutes
champion is trained, checksummed and shipped, and the production estimate is a
multiple of it.

THE TWO MODELS SHARE A CUTOFF, and predict.py asserts it. training them at
different boundaries would produce a composed number whose two halves disagree
about what was knowable, which is a leak that neither model's own guard can see.

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
    BASE_FEATURE_COLS,
    CHAMPIONS,
    COHERENCE_CONSTRAINTS,
    CONTEXT_P_PRIOR,
    CROSS_FIT_FREQ,
    CROSS_FIT_MIN_TRAIN_ROWS,
    CUTOFF_POLICY,
    FEATURE_VERSION,
    LGBM_PARAMS,
    MAGNITUDE_PRIORS,
    MAGNITUDE_SHRINK_K,
    MAGNITUDE_WINDOW,
    MINUTES_TARGET,
    MODELS_DIR,
    RATE_ESTIMATORS,
    RATE_HALFLIVES,
    RATE_MINUTES_FLOOR,
    RATE_TARGETS,
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
    MinutesModel,
    PerMinuteRate,
    baseline_column,
    brier,
    conditional_estimate,
    logloss,
    mae,
    skill_score,
    snapshot_ewma_state,
)

log = logging.getLogger("train")

MODEL_FILE = "availability_model.joblib"
MINUTES_FILE = "minutes_model.joblib"
# STAGE 1 of the two-stage pipeline, persisted as of feature_version v3. the served
# teammate-context features are expectations over play probabilities, so a serving
# run needs a model that can produce those probabilities for games that have not been
# played. Without this artifact predict.py would have to reuse the dataset's stored
# P_CONTEXT, which exists only for historical rows - i.e. it could score a backtest
# and not a slate.
BASE_MODEL_FILE = "base_availability_model.joblib"
EWMA_FILE = "ewma_state.parquet"
META_FILE = "metadata.json"
DEFAULT_HOLDOUT_DAYS = 28


def appearances(frame: pd.DataFrame) -> pd.DataFrame:
    return frame[frame["PLAYED"] == 1] if "PLAYED" in frame.columns else frame


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
    metrics = {
        "holdout_start": str(split_at.date()),
        "holdout_rows": int(len(valid)),
        "holdout_played_rate": round(float(valid["PLAYED"].mean()), 6),
        "brier": round(brier(y, p), 6),
        "log_loss": round(logloss(y, p), 6),
        "brier_skill_vs_shifted_rate": round(skill_score(brier(y, p), brier(y, base)), 6),
    }

    # the composition's own honest numbers, on the same holdout. the conditional
    # MAE for points is the one to watch across a composition change: it is the
    # quantity that changed shape (E[min] x rate instead of EWMA(PTS)), and the
    # baseline it must not lose to is the estimator it replaced.
    train_app, valid_app = appearances(train), appearances(valid)
    if not train_app.empty and not valid_app.empty:
        minutes = MinutesModel(kind=CHAMPIONS["minutes"]).fit(train_app, feature_cols, split_at)
        minutes_pred = minutes.predict(valid_app)
        metrics["minutes_mae"] = round(mae(valid_app[MINUTES_TARGET], minutes_pred), 6)
        metrics["minutes_mae_ewma_baseline"] = round(
            mae(valid_app[MINUTES_TARGET], EwmaProduction(MINUTES_TARGET).fit(train_app)
                .predict(valid_app)), 6
        )
        # every 9-cat stat gets its composed conditional MAE next to the baseline
        # it had to beat, not just PTS and AST. A stat whose composition is worse
        # than the estimator it replaced should be visible in the registry entry
        # of the artifact that shipped it, not discovered later.
        #
        # TWO DIFFERENT BASELINES, and the split is a fact about the dataset rather
        # than a choice. ``EwmaProduction`` reads ``ewma_<stat>``, a whole-game
        # total EWMA that only ``config.ROLL_STATS`` carries, so it is available
        # for PTS/AST/FGA and not for the rest. Rather than invent a column here or
        # quietly fall back to a constant - which would put a number in the
        # registry under a key claiming to be an EWMA when it is not - the
        # whole-game key is emitted only where the column really exists, and every
        # stat additionally gets the baseline its champion was actually selected
        # against: the same composition driven by the expanding-mean rate.
        for target in RATE_TARGETS:
            if target not in valid_app.columns:
                continue
            rate = PerMinuteRate(target).fit(train_app)
            composed = conditional_estimate(minutes_pred, rate.predict(valid_app))
            metrics[f"{target.lower()}_cond_mae"] = round(mae(valid_app[target], composed), 6)

            expanding = PerMinuteRate(target, estimator="expanding").fit(train_app)
            metrics[f"{target.lower()}_cond_mae_rate_baseline"] = round(
                mae(valid_app[target],
                    conditional_estimate(minutes_pred, expanding.predict(valid_app))), 6
            )
            if f"ewma_{target}" in valid_app.columns:
                metrics[f"{target.lower()}_cond_mae_ewma_baseline"] = round(
                    mae(valid_app[target],
                        EwmaProduction(target).fit(train_app).predict(valid_app)), 6
                )
    return metrics


def holdout_quantiles(
    features: pd.DataFrame,
    feature_cols: list[str],
    cutoff: pd.Timestamp,
    holdout_days: int,
) -> dict[str, QuantileOffsets]:
    """P10/P50/P90 offsets for the conditional champion, per target.

    measured on APPEARANCES in the holdout window only. the estimate being
    quantified is "given he plays", so a row where he did not play carries no
    residual - folding those in as zeros would widen the interval with the
    availability question the P(play) column already answers.

    THE RESIDUALS MUST COME FROM THE ESTIMATOR THAT SHIPS. this is why the
    composition change reaches all the way down here: an offset set measured
    against EWMA(PTS) and then applied to E[min] x rate is a band around a
    different point estimate than the one it is drawn on, and its coverage claim is
    void. minutes offsets likewise now wrap the champion minutes model, not the
    EWMA baseline the serving path used to quietly fall back to.
    """
    split_at = cutoff - pd.Timedelta(days=holdout_days)
    train = appearances(features[features["GAME_DATE"] < split_at])
    valid = appearances(
        features[(features["GAME_DATE"] >= split_at) & (features["GAME_DATE"] < cutoff)]
    )
    if train.empty or valid.empty:
        log.warning("holdout window is empty; no quantile offsets will be written")
        return {}

    window = (str(split_at.date()), str(pd.Timestamp(cutoff).date()))
    minutes_model = MinutesModel(kind=CHAMPIONS["minutes"]).fit(train, feature_cols, split_at)
    minutes_pred = minutes_model.predict(valid)

    offsets: dict[str, QuantileOffsets] = {}
    for target in QUANTILE_TARGETS:
        if target not in valid.columns:
            log.warning("no %s in the dataset; skipping its quantiles", target)
            continue
        if target == MINUTES_TARGET:
            point = minutes_pred
        else:
            point = conditional_estimate(
                minutes_pred, PerMinuteRate(target).fit(train).predict(valid)
            )
        offsets[target] = fit_residual_quantiles(
            valid[target], point, target, window=window
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

    # ONE cutoff, both models. predict.assert_same_cutoff refuses any pair that
    # does not satisfy this, so it is enforced at load time and not only here.
    model = AvailabilityModel(kind=CHAMPIONS["availability"]).fit(train, feature_cols, cutoff)
    joblib.dump(model, out_dir / MODEL_FILE)

    train_app = appearances(train)
    if train_app.empty:
        raise SystemExit(f"no appearance rows before cutoff {cutoff.date()} to fit minutes on")
    minutes_model = MinutesModel(kind=CHAMPIONS["minutes"]).fit(train_app, feature_cols, cutoff)
    joblib.dump(minutes_model, out_dir / MINUTES_FILE)

    # STAGE 1, at the same cutoff as the other two. It is a THIRD model at the same
    # information boundary rather than a reuse of the availability champion, because
    # the champion sees the teammate-context features and a probability produced by a
    # model that already saw teammate context cannot be used to build teammate
    # context. Its feature list is config.BASE_FEATURE_COLS and models.py refuses to
    # fit it on anything wider.
    base_cols = [c for c in BASE_FEATURE_COLS if c in features.columns]
    base_model = AvailabilityModel(kind=CHAMPIONS["availability"]).fit(
        train, base_cols, cutoff
    )
    joblib.dump(base_model, out_dir / BASE_MODEL_FILE)

    ewma_state = snapshot_ewma_state(features, cutoff)
    fallbacks = dict(ewma_state.attrs.get("fallbacks", {}))
    rate_fallbacks = dict(ewma_state.attrs.get("rate_fallbacks", {}))
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
    quantiles = holdout_quantiles(features, feature_cols, cutoff, args.holdout_days)
    production = {
        "composition": CHAMPIONS["composition"],
        "estimator": PerMinuteRate("PTS").kind,
        # the PTS halflife, kept under its historical key so a metadata reader
        # written against a pre-9-cat artifact still finds the field it expects.
        # It is no longer the whole story and the two per-stat maps below are.
        "halflife": PerMinuteRate("PTS").halflife,
        # THE PER-STAT DECISION RECORD. which smoother and which memory each of
        # the eleven served rates uses, written into the artifact rather than
        # only into config, so a stored prediction can be traced to the estimator
        # that produced it even after config moves on. PTS and AST are frozen at
        # halflife 5 by the production tournament; the nine new stats carry
        # inner-fold selections (MODEL.md section 9.2).
        "rate_halflives": {t: RATE_HALFLIVES[t] for t in RATE_TARGETS},
        "rate_estimators": {t: RATE_ESTIMATORS[t] for t in RATE_TARGETS},
        "rate_targets": list(RATE_TARGETS),
        "coherence_constraints": [list(pair) for pair in COHERENCE_CONSTRAINTS],
        # league sum(stat)/sum(minutes) priors for players with no rate history.
        # these are what predict.py reads; the per-player rates come from the
        # dataset's ewma_<stat>_per_min columns.
        "rate_minutes_floor": RATE_MINUTES_FLOOR,
        "rate_fallbacks": {k: round(v, 6) for k, v in rate_fallbacks.items()},
        # kept for the demoted EWMA(stat) baseline, which is still a runnable
        # challenger in evaluate.py and would otherwise have no persisted fallback.
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
        # prediction_runs.artifact_checksum is one column, and the availability
        # model is the one it has always named; the minutes checksum rides alongside
        # so a stored prediction can still be traced to both sets of bytes.
        "artifact_checksum": registry.sha256_file(out_dir / MODEL_FILE),
        "minutes_artifact_checksum": registry.sha256_file(out_dir / MINUTES_FILE),
        "base_artifact_checksum": registry.sha256_file(out_dir / BASE_MODEL_FILE),
        # the v3 two-stage provenance. a served prediction's teammate-context features
        # are only as auditable as the probability that built them, so the base model's
        # bytes, its feature list and the cross-fit constants that produced the
        # TRAINING rows' context all land here.
        "context": {
            "stage1_feature_cols": base_cols,
            "stage2_cross_fit_freq": CROSS_FIT_FREQ,
            "stage2_min_train_rows": CROSS_FIT_MIN_TRAIN_ROWS,
            "context_p_prior": CONTEXT_P_PRIOR,
            "magnitude_window": MAGNITUDE_WINDOW,
            "magnitude_shrink_k": MAGNITUDE_SHRINK_K,
            "magnitude_priors": MAGNITUDE_PRIORS,
            "iterations": 1,
        },
        "champions": CHAMPIONS,
        "availability_hyperparams": LGBM_PARAMS,
        "minutes_hyperparams": LGBM_PARAMS if CHAMPIONS["minutes"] != "ewma" else {},
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
        hyperparams={
            "availability": LGBM_PARAMS,
            "minutes": LGBM_PARAMS if CHAMPIONS["minutes"] != "ewma" else {},
            "production": production,
            # the two-stage constants are hyperparameters of the FEATURES, not of an
            # estimator, and they belong in the audit record for the same reason
            # subsample_freq does: a future run that quietly changes the shrinkage
            # should be visible in a registry diff.
            "context": metadata["context"],
        },
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
    print(f"base availability: {CHAMPIONS['availability']} on {len(base_cols)} "
          f"teammate-free features (stage 1 of the two-stage pipeline)")
    print(f"minutes|plays    : {CHAMPIONS['minutes']} on {len(train_app):,} appearance rows")
    print(f"production       : EWMA(halflife {production['halflife']}) of stat per minute "
          f"(denominator floor {RATE_MINUTES_FLOOR:g}m) - snapshot only, "
          f"{len(ewma_state):,} players")
    print(f"composition      : {CHAMPIONS['composition']}")
    print(f"feature version  : {FEATURE_VERSION}")
    print(f"artifact sha256  : {metadata['artifact_checksum'][:16]}... (availability), "
          f"{metadata['minutes_artifact_checksum'][:16]}... (minutes)")
    for target, fallback in production["rate_fallbacks"].items():
        print(f"rate fallback {target:<4s}: {fallback:.4f} {target.lower()}/min")
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
