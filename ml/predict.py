"""next-games predictions from a trained model version.

    python predict.py --dataset data/dataset.parquet --version 2026-08-16 \
        --out data/predictions.parquet

emits, per scheduled player-game at or after the model's training cutoff:
P(play), E[minutes | plays] from the champion minutes model, the conditional
production estimate E[minutes | plays] x EWMA(stat per minute), the P10/P50/P90
quantiles around the conditional minutes and points estimates, and the
unconditional estimate P(play) x that conditional.

MINUTES PROPAGATE. the conditional production estimate is a FUNCTION of the
predicted minutes on the same row, so a player whose minutes forecast rises gets a
proportionally higher points projection - both conditional and unconditional. the
previous formulation, P(play) x EWMA(stat), could not do that: EWMA(stat) is an
average of past whole-game totals and already contains the minutes he used to get.

BOTH multiplied model outputs travel with the training cutoff that produced them
and are run through ``validate_out_of_fold`` before anything is multiplied, plus
``assert_same_cutoff`` to prove the two halves share one information boundary. a
model loaded against a dataset it was partly trained on, or a minutes artifact
paired with an availability artifact from a different day, fails loudly instead of
silently emitting contaminated numbers.

INJURY-REPORT OVERRIDES, APPLIED TWICE, and the first application is new in
feature_version v3. ``--statuses`` supplies the latest official designation per
player and :mod:`fnba_ml.overrides` applies it:

  1. to the BASE availability probabilities p_j, BEFORE the served teammate-context
     features are rebuilt from them (:func:`rebuild_context`). This is the one the
     round-2 review made necessary. The context features are expectations over p_j,
     so a star ruled OUT has to lower his own p_j or his TEAMMATES' expected vacated
     minutes never move - the serving path would know he is out, correct his own
     projection to ~0, and still project his backup for the minutes of a night the
     star plays. Every number on the page would look individually defensible.
  2. to the FINAL P(play), AFTER scoring and BEFORE rows are built, with the
     unconditional stats recomputed from the overridden probability. This is what the
     layer has always done. Without it a player who is officially OUT is still
     projected for 28 points, because the injury report is not in the feature set
     (and cannot be yet - the history only starts in 2026-08).

the model's own probability is preserved alongside the overridden one at both
stages, so the layer stays measurable against the model it corrects.

``--horizon`` records WHEN the run was made relative to tipoff (early / gameday /
lock, see config.HORIZONS). The same model scoring the same game at T-24h and T-60m
makes two different claims and the store has to be able to tell them apart - but a
LABEL cannot, because two runs both tagged ``early`` can differ by twenty hours of
report freshness. :func:`horizon_metadata` therefore records the measured offset,
the newest admissible report and its age, how many reports existed, and whether the
league's initial-report deadline had passed, next to the label the operator asked
for. config.HORIZON_RUN_METADATA is the list and section 7.2 of MODEL.md is the
argument.

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

COLD START (MODEL.md 13.7, added by P5). every emitted row carries a
``cold_start`` boolean - true when its GAME_DATE is on or before
``config.PROSPECTIVE_COLD_START_THROUGH`` (2026-11-30) - and every run's notes
carry the flagged-row count. It is a MANDATORY REPORTING SPLIT and never a
filter: cold-start rows stay in every headline number, because excluding them
would be a post-hoc filter on precisely the hardest games. It is not a feature
either; nothing reads it back.

THERE IS NO ``--early-season`` FLAG, and that is a finding rather than an
omission. A preseason or October run needs exactly two things this script already
has: a dataset containing the future scheduled rows
(:mod:`fnba_ml.prospective` builds one) and ``--run-at`` set to the first game
date. Everything else falls out of machinery that was already here - a player
with no games in the new season keeps his prior-season form through the
CAREER-scoped as-of joins, a player with no NBA history at all is caught by
``features.insufficient_history`` and served the artifact's league-rate
fallbacks, and the leakage guards pass trivially because every future game date
is after the training cutoff. ``project_preseason.py`` is the thin wrapper that
builds the dataset; adding a mode flag here would have been a second name for
"pass a different --dataset".
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
from fnba_ml.config import (  # noqa: E402
    DATA_DIR,
    DEFAULT_HORIZON,
    HORIZONS,
    INITIAL_REPORT_DEADLINE_HOUR,
    MINUTES_TARGET,
    MODELS_DIR,
    P_CONTEXT,
    P_CONTEXT_CUTOFF,
    PRODUCTION_TARGETS,
    PROSPECTIVE_COLD_START_FLAG,
    PROSPECTIVE_COLD_START_THROUGH,
    horizon_for_offset,
    horizon_label,
    is_cold_start,
)
from fnba_ml.features import attach_expected_context  # noqa: E402
from fnba_ml.intervals import (  # noqa: E402
    QUANTILE_LEVELS,
    QuantileOffsets,
    attach_quantiles,
)
from fnba_ml.models import (  # noqa: E402
    MIN_PRED,
    MIN_PRED_CUTOFF,
    P_PLAY,
    P_PLAY_CUTOFF,
    LeakageError,
    PerMinuteRate,
    assert_same_cutoff,
    coherence_clip_frame,
    minutes_propagated_estimate,
    validate_minutes_out_of_fold,
    validate_out_of_fold,
)
from fnba_ml.overrides import (  # noqa: E402
    DEFAULT_POLICY,
    OVERRIDE_REASON,
    P_PLAY_MODEL,
    apply_status_overrides,
    latest_statuses,
    override_summary,
    resolve_overrides,
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
    parser.add_argument("--statuses", type=Path, default=None,
                        help="parquet or csv of latest injury designations with columns "
                             "nba_player_id, status_normalized, captured_at. omit to "
                             "score with the model's raw P(play)")
    parser.add_argument("--statuses-as-of", default=None,
                        help="information boundary for the injury reports; reports "
                             "captured at or after it are ignored. defaults to now, "
                             "which is correct for a live run and WRONG for a backtest")
    parser.add_argument("--horizon", choices=tuple(HORIZONS), default=DEFAULT_HORIZON,
                        help="when this run is being made relative to tipoff; recorded "
                             f"on the run row. {', '.join(f'{k}={v}' for k, v in HORIZONS.items())}")
    return parser.parse_args(argv)


def load_version(version: str, models_dir: Path):
    """the three models and their shared metadata.

    the minutes artifact is REQUIRED, not optional. the composition multiplies it
    into every production stat, so a version directory without it cannot be scored
    with the promoted composition at all - and falling back to the EWMA minutes
    baseline would silently serve the pre-2026-08-17 behaviour under a version
    string that claims otherwise.

    the BASE availability artifact is required for the same class of reason, as of
    feature_version v3. The served teammate-context features are expectations over
    play probabilities, and a slate that has not been played has no stored
    probabilities - only a model can supply them. A version directory without it
    predates the two-stage pipeline, and scoring it against a v3 dataset would mean
    serving whatever ``P_CONTEXT`` the dataset happened to carry for historical rows,
    which for future rows is nothing at all.
    """
    dir_ = version_dir(version, models_dir)
    model_path = dir_ / "availability_model.joblib"
    minutes_path = dir_ / "minutes_model.joblib"
    base_path = dir_ / "base_availability_model.joblib"
    meta_path = dir_ / "metadata.json"
    if not model_path.exists():
        raise SystemExit(f"no trained model at {model_path}. run train.py first.")
    if not minutes_path.exists():
        raise SystemExit(
            f"no minutes model at {minutes_path}. this version predates the "
            f"minutes-propagating composition; retrain with train.py to score it."
        )
    if not base_path.exists():
        raise SystemExit(
            f"no base availability model at {base_path}. this version predates the "
            f"two-stage probabilistic teammate context (feature_version v3); the "
            f"served context features cannot be built for an unplayed slate without "
            f"it. retrain with train.py."
        )
    with open(meta_path, encoding="utf-8") as fh:
        metadata = json.load(fh)
    return (
        joblib.load(model_path),
        joblib.load(minutes_path),
        joblib.load(base_path),
        metadata,
    )


def load_statuses(path: Path | None) -> pd.DataFrame | None:
    """the injury-report frame from parquet or csv.

    a file input rather than a live query, for now. the postgres form of the same
    read is ``PostgresSource.load_latest_injury_statuses`` in
    fnba_ml/data/postgres_source.py - written, documented, and not executed
    anywhere in this repo.
    """
    if path is None:
        return None
    if not path.exists():
        raise SystemExit(f"statuses file not found: {path}")
    frame = pd.read_csv(path) if path.suffix.lower() == ".csv" else pd.read_parquet(path)
    log.info("loaded %d injury status rows from %s", len(frame), path)
    return frame


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


def rebuild_context(
    features: pd.DataFrame,
    base_model,
    statuses: pd.DataFrame | None,
    as_of: pd.Timestamp,
    policy=DEFAULT_POLICY,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """stages 1-3 at serving time: base p, report override, expected context.

    THE CODE PATH THE P1b REVIEW MADE NECESSARY, and the order of the three steps is
    the whole content of it.

    1. the BASE availability model scores every upcoming row. It reads
       ``config.BASE_FEATURE_COLS`` only - no teammate context - which is what makes
       its output usable as an input to teammate context.
    2. the injury report overrides those probabilities, with the same policy and the
       same as-of discipline the final layer uses. THIS IS THE STEP THAT WAS MISSING
       IN CONCEPT BEFORE v3: a star ruled OUT has to lower his own p_j so that his
       TEAMMATES' expected vacated minutes RISE. Without it the serving path would
       know he is out (his own P(play) would be corrected downstream) and decline to
       act on it for anyone else - the original defect, displaced one column to the
       left and considerably harder to notice, because every number on the page would
       look individually reasonable.
    3. the expected-context features are rebuilt from the overridden probabilities,
       and only then are the final availability and minutes models allowed to score.

    the probability carries the base model's cutoff, so ``validate_out_of_fold`` can
    still prove that the features the served models saw were built from information
    available before the game.

    returns (features with the context rebuilt, a per-row audit frame).
    """
    base_p = base_model.predict_proba(features)
    resolved = resolve_overrides(
        features["PLAYER_ID"], base_p, statuses, policy, as_of=as_of
    )
    rebuilt = attach_expected_context(
        features, resolved.probability, pd.Timestamp(base_model.cutoff)
    )
    validate_out_of_fold(rebuilt, P_CONTEXT, P_CONTEXT_CUTOFF, "p_context")

    audit = pd.DataFrame({
        "PLAYER_ID": features["PLAYER_ID"].to_numpy(),
        "GAME_ID": features["GAME_ID"].to_numpy(),
        "P_CONTEXT_BASE": base_p,
        "P_CONTEXT": resolved.probability,
        "CONTEXT_OVERRIDDEN": resolved.applies,
    })
    log.info(
        "context rebuilt from base p on %d rows; %d of them corrected by the injury "
        "report before the teammate sums were taken",
        len(features), resolved.n_applied,
    )
    return rebuilt, audit


def build_predictions(
    features: pd.DataFrame, model, minutes_model, metadata: dict
) -> pd.DataFrame:
    """score every row: P(play), E[minutes|plays], and the composed production.

    the order of the three guards matters. both stamped quantities are checked
    individually, then checked against each other, and only then is anything
    multiplied - the whole point of stamping them is that the check happens before
    the contamination becomes an unrecoverable product.
    """
    scored = minutes_model.attach(model.attach(features))
    validate_out_of_fold(scored)
    validate_minutes_out_of_fold(scored)
    assert_same_cutoff(scored)

    rate_fallbacks = metadata.get("production", {}).get("rate_fallbacks", {})
    quantiles = load_quantile_offsets(metadata)
    out = scored[
        [c for c in KEY_COLS if c in scored.columns]
        + [P_PLAY, P_PLAY_CUTOFF, MIN_PRED, MIN_PRED_CUTOFF]
    ].copy()

    # minutes first, and served straight from the champion minutes model rather
    # than re-derived: this is the E[minutes | plays] that every production stat
    # below is a multiple of, so the card's minutes row and its points row are two
    # views of one number.
    minutes = scored[MIN_PRED].to_numpy(dtype=float)
    out[f"E_{MINUTES_TARGET}_COND"] = minutes
    out[f"E_{MINUTES_TARGET}"] = (
        scored[P_PLAY].to_numpy(dtype=float) * minutes
    ).clip(0.0)
    if MINUTES_TARGET in quantiles:
        out = attach_quantiles(out, minutes, quantiles[MINUTES_TARGET])

    # the per-stat estimator record the artifact carries. reading it from metadata
    # rather than from config is what makes an old artifact still scoreable: a
    # version trained when BLK used halflife 12 must keep scoring with halflife 12
    # even after config moves on, or the stored prediction and the model that made
    # it stop being the same object.
    halflives = metadata.get("production", {}).get("rate_halflives", {}) or {}
    estimators = metadata.get("production", {}).get("rate_estimators", {}) or {}

    emitted: list[str] = []
    for target in PRODUCTION_TARGETS:
        estimator = estimators.get(target)
        rate = PerMinuteRate.from_fallback(
            target,
            float(rate_fallbacks.get(target, 0.0)),
            halflife=halflives.get(target),
            estimator=estimator,
        )
        has_column = rate.column in features.columns
        if target not in rate_fallbacks and not has_column:
            log.warning("no per-minute rate available for %s; skipping it", target)
            continue
        if target not in rate_fallbacks:
            log.warning(
                "model %s carries no league rate fallback for %s; players with no "
                "per-minute history will get 0. retrain to populate it.",
                metadata.get("model_version"), target,
            )
        rate_values = rate.predict(features)
        conditional, unconditional = minutes_propagated_estimate(scored, rate_values)
        out[f"E_{target}_COND"] = conditional
        out[f"E_{target}"] = unconditional
        # the rate itself is emitted so the identity conditional = minutes x rate is
        # checkable on the saved parquet without refitting anything
        out[f"RATE_{target}"] = rate_values
        # quantiles wrap the CONDITIONAL estimate: the offsets were measured on
        # appearances, so they describe the spread of a night he actually plays.
        # the unconditional number is a schedule-level mean and has no such
        # interval - "he might score 6 or 31, or not play" is two questions.
        if target in quantiles:
            out = attach_quantiles(out, conditional, quantiles[target])
        emitted.append(target)

    # ---- COHERENCE, applied to every emitted number before anything leaves ----
    # a made shot is an attempted shot and a made three is a made shot. That holds
    # in every game ever played and does NOT hold automatically for the
    # expectations, because each stat's rate is smoothed independently and two
    # EWMAs at different halflives are different weighted averages of the same
    # history. See models.coherence_clip for the full argument and
    # config.COHERENCE_CONSTRAINTS for the chain.
    #
    # EVERY TEMPLATE, not just the headline one. A card that shows a coherent
    # expected FGM next to a P90 FGM above its own P90 FGA has moved the
    # incoherence rather than removed it, so the conditional estimate, the
    # unconditional estimate and each quantile level are each clipped against
    # their own kind.
    templates = ["E_{target}_COND", "E_{target}"]
    templates += [
        f"Q{int(round(level * 100)):02d}_{{target}}" for level in QUANTILE_LEVELS
    ]
    clip_counts: dict[str, int] = {}
    for template in templates:
        out, counts = coherence_clip_frame(out, template)
        for constraint, n in counts.items():
            clip_counts[f"{template.format(target='*')} {constraint}"] = n

    out["MODEL_VERSION"] = metadata.get("model_version")
    out["FEATURE_VERSION"] = metadata.get("feature_version", "unknown")

    # ---- THE COLD-START FLAG (MODEL.md 13.7, implemented by P5) ----
    # a MANDATORY REPORTING SPLIT, not a filter and not a feature. Every row whose
    # GAME_DATE is on or before config.PROSPECTIVE_COLD_START_THROUGH carries it,
    # cold-start rows stay in every headline number, and nothing downstream reads
    # this column as an input to anything.
    #
    # IT IS A COLUMN ON THE PARQUET AND A COUNT IN THE RUN NOTE, and that split is
    # deliberate. The per-row store schema (migration 014) is long-format
    # (run, player, game, stat, quantile, value) with no flag column, and 13.7
    # requires the flag "must not collide with a served stat name in the
    # long-format store" - so it is NOT emitted as a pseudo-stat. It does not need
    # to be: the flag is a pure function of GAME_DATE, which every stored row
    # already carries, so any consumer can recompute it exactly with
    # config.is_cold_start and no migration is required. The run-level note records
    # what the run itself observed, which is the fact that cannot be recomputed
    # from the rows alone.
    out[PROSPECTIVE_COLD_START_FLAG] = is_cold_start(out["GAME_DATE"]).to_numpy()

    log.info("emitted %d production stats: %s", len(emitted), ", ".join(emitted))
    out = out.reset_index(drop=True)
    # attached AFTER the reset: ``DataFrame.attrs`` propagation through pandas
    # operations is version-dependent, and a clip count that silently disappears
    # would turn "the clip never bound" and "nobody recorded whether it bound" into
    # the same output, which is the one confusion this number exists to prevent.
    out.attrs["coherence_clips"] = clip_counts
    return out


# the nominal tipoff hour, UTC, used only when the frame carries no real tipoff
# timestamp. HAND-SET at 00:00 UTC, i.e. ~7-8pm US Eastern, which is where the bulk
# of the schedule sits. It is an APPROXIMATION and every number derived from it is
# labelled as one - see ``horizon_metadata``'s ``tip_source``. It is not a substitute
# for ingesting nba_schedule.scheduled_at, which is NULL for a meaningful share of
# rows today and is the real fix.
NOMINAL_TIP_HOUR_UTC: int = 0


def horizon_metadata(
    features: pd.DataFrame,
    statuses: pd.DataFrame | None,
    as_of: pd.Timestamp,
    requested: str,
) -> dict[str, object]:
    """the per-run horizon facts config.HORIZON_RUN_METADATA names.

    WHY A LABEL IS NOT ENOUGH, which is the P1b correction to section 7.2. Two runs
    both tagged ``early`` can differ by twenty hours of report freshness, and the one
    that beats the other may simply have been made later. A horizon is a MEASURED
    offset between the run's information boundary and tipoff, plus the state of the
    report at that boundary; the label is the bucket that offset falls into.

    ``first_deadline_passed`` is the flag that makes ``early`` interpretable at all.
    The league requires an initial participation report by 5pm local the day before a
    game, so a T-24h run against a 7pm tipoff has usually had a report available for
    two hours - the old docstring's "no injury report yet" was simply wrong. An
    ``early`` run before that deadline and an ``early`` run after it are different
    experiments and must not be pooled.

    every offset here is approximate when the frame carries no tipoff timestamp, and
    ``tip_source`` says which case a given run was. Guessing a tip time and reporting
    the result as measured would be worse than reporting nothing.
    """
    boundary = pd.Timestamp(as_of)
    if boundary.tzinfo is not None:
        boundary = boundary.tz_convert("UTC").tz_localize(None)

    if "SCHEDULED_AT" in features.columns and features["SCHEDULED_AT"].notna().any():
        tip = pd.to_datetime(features["SCHEDULED_AT"], errors="coerce", utc=True)
        tip = tip.dt.tz_localize(None)
        tip_source = "nba_schedule.scheduled_at"
    else:
        tip = pd.to_datetime(features["GAME_DATE"]).dt.normalize() + pd.Timedelta(
            hours=NOMINAL_TIP_HOUR_UTC
        )
        tip_source = f"approximated: GAME_DATE + {NOMINAL_TIP_HOUR_UTC:02d}:00 UTC"

    hours = (tip - boundary).dt.total_seconds() / 3600.0
    hours = hours.replace([float("inf"), float("-inf")], pd.NA).dropna()
    median = float(hours.median()) if len(hours) else float("nan")

    latest_report_at = None
    report_age = None
    report_count = 0
    if statuses is not None and len(statuses) > 0:
        admissible = latest_statuses(statuses, boundary)
        report_count = int(len(admissible))
        if report_count:
            newest = pd.Timestamp(admissible["captured_at"].max())
            latest_report_at = newest.isoformat(timespec="seconds")
            report_age = round((boundary - newest).total_seconds() / 3600.0, 3)

    # the league's initial-report deadline for the EARLIEST game on the slate: 5pm
    # local the day before. local time is not on the frame, so the deadline is
    # evaluated in UTC against the nominal tip hour - which is the same
    # approximation ``tip_source`` already declares, not a second one.
    first_deadline_passed = None
    if len(hours):
        earliest_tip = pd.Timestamp(tip.min())
        deadline = (earliest_tip.normalize() - pd.Timedelta(days=1)) + pd.Timedelta(
            hours=INITIAL_REPORT_DEADLINE_HOUR
        )
        first_deadline_passed = bool(boundary >= deadline)

    return {
        "horizon_requested": horizon_label(requested),
        "horizon_measured": horizon_for_offset(median) or "outside every window",
        "hours_to_tip_min": round(float(hours.min()), 3) if len(hours) else None,
        "hours_to_tip_median": round(median, 3) if len(hours) else None,
        "hours_to_tip_max": round(float(hours.max()), 3) if len(hours) else None,
        "tip_source": tip_source,
        "latest_report_at": latest_report_at,
        "report_age_hours": report_age,
        "report_count": report_count,
        "first_deadline_passed": first_deadline_passed,
    }


def universe_source(features: pd.DataFrame, metadata: dict) -> str:
    if "UNIVERSE_SOURCE" in features.columns and len(features) > 0:
        return str(features["UNIVERSE_SOURCE"].iloc[0])
    return str(metadata.get("universe_source", "unknown"))


def write_run(
    predictions: pd.DataFrame,
    metadata: dict,
    forecast_cutoff: pd.Timestamp,
    notes: str | None,
    horizon: str,
    horizon_facts: dict[str, object] | None = None,
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
        horizon=horizon,
    )
    run_id = write_predictions(rows, run_record)
    overridden = (
        int(predictions[OVERRIDE_REASON].notna().sum())
        if OVERRIDE_REASON in predictions.columns else 0
    )
    registry.record_prediction_run(
        str(metadata.get("model_version")),
        {
            "run_id": run_id,
            "predicted_at": predicted_at.isoformat(timespec="seconds"),
            "forecast_cutoff_at": str(pd.Timestamp(forecast_cutoff)),
            # the horizon lands in both places on purpose: prediction_runs.notes is
            # what a database consumer reads, the registry entry is what an audit of
            # the artifact reads, and neither should have to join to the other to
            # answer "how far before tipoff was this claim made".
            "horizon": horizon_label(horizon),
            # the measured facts behind the label. a horizon comparison that has only
            # labels to work with cannot separate "the later run had better
            # information" from "the later run was made three hours later"; these are
            # what make the separation possible, and they are recorded whether or not
            # anyone is looking at them yet.
            "horizon_facts": horizon_facts,
            "rows": len(rows),
            "player_games": int(len(predictions)),
            "status_overrides": overridden,
            "override_policy": DEFAULT_POLICY.as_dict() if overridden else None,
        },
    )
    return run_id, len(rows)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    setup_logging(args.verbose)

    model, minutes_model, base_model, metadata = load_version(
        args.version, args.models_dir
    )
    features = load_dataset(args.dataset)

    run_at = pd.Timestamp(args.run_at) if args.run_at else pd.Timestamp(model.cutoff)
    upcoming = features[features["GAME_DATE"] >= run_at]
    if upcoming.empty:
        raise SystemExit(
            f"no scheduled rows on or after {run_at.date()} in {args.dataset}. "
            f"the model's cutoff is {pd.Timestamp(model.cutoff).date()}."
        )

    statuses = load_statuses(args.statuses)
    statuses_as_of = (
        pd.Timestamp(args.statuses_as_of) if args.statuses_as_of
        else pd.Timestamp(utc_now())
    )

    # STAGES 1-3 BEFORE ANY FINAL SCORING. the report has to reach the teammate
    # context, not only the row's own probability, or the projections page would
    # correctly show a ruled-out star at ~0 and still show his backup the minutes of
    # a night the star plays.
    try:
        upcoming, context_audit = rebuild_context(
            upcoming, base_model, statuses, statuses_as_of, DEFAULT_POLICY
        )
    except LeakageError as exc:
        raise SystemExit(
            f"refusing to build context features: {exc}. the base availability "
            f"model was trained past the games it is being asked about."
        ) from exc

    try:
        predictions = build_predictions(upcoming, model, minutes_model, metadata)
    except LeakageError as exc:
        raise SystemExit(
            f"refusing to emit predictions: {exc}. the model was trained past "
            f"{run_at.date()}; score only games at or after its cutoff "
            f"{pd.Timestamp(model.cutoff).date()}, or retrain."
        ) from exc

    # AFTER scoring, BEFORE rows are built. the layer needs the model's number to
    # blend with, and the row builder needs the final one. This is the SECOND
    # application of the same policy in one run: the first corrected the
    # probabilities the context features were built from, this one corrects the
    # player's own served P(play).
    predictions = apply_status_overrides(
        predictions, statuses, DEFAULT_POLICY, as_of=statuses_as_of
    )

    source = universe_source(upcoming, metadata)
    notes = args.notes

    # the run-level half of the cold-start flag. Prepended to notes on the same
    # pattern ``store.build_run_record`` uses for the horizon, and for the same
    # reason: prediction_runs.notes is free text on an APPEND-ONLY row, so a label
    # written there is as immutable as a column would be and needs no migration.
    # Recorded whether or not any row is flagged, because "this run was made
    # entirely outside the cold-start window" is a fact a look report needs to be
    # able to read, and an absent note cannot say it.
    cold_rows = int(predictions[PROSPECTIVE_COLD_START_FLAG].sum())
    notes = "; ".join(filter(None, [
        f"{PROSPECTIVE_COLD_START_FLAG}={cold_rows}/{len(predictions)} rows "
        f"(GAME_DATE <= {PROSPECTIVE_COLD_START_THROUGH})",
        notes,
    ]))

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

    horizon_facts = horizon_metadata(upcoming, statuses, statuses_as_of, args.horizon)
    if horizon_facts["horizon_measured"] != args.horizon:
        log.warning(
            "this run was labelled %r but its measured median offset (%s h) puts it "
            "in %r. the label is what gets stored; the measurement is what should be "
            "believed.",
            args.horizon, horizon_facts["hours_to_tip_median"],
            horizon_facts["horizon_measured"],
        )

    written: tuple[int, int] | None = None
    if args.write_db:
        written = write_run(
            predictions, metadata, run_at, notes, args.horizon, horizon_facts
        )

    summary = override_summary(predictions)

    print("--- PREDICT ---")
    print(f"version   : {args.version}")
    print(f"run at    : {run_at.date()} (model cutoff {pd.Timestamp(model.cutoff).date()})")
    print(f"horizon   : {horizon_label(args.horizon)}")
    for key, value in horizon_facts.items():
        if key != "horizon_requested":
            print(f"  {key:22s} {value}")
    print(f"universe  : {source}")
    print(f"context p : mean {upcoming[P_CONTEXT].mean():.4f} "
          f"(base {context_audit['P_CONTEXT_BASE'].mean():.4f}, "
          f"{int(context_audit['CONTEXT_OVERRIDDEN'].sum()):,} rows corrected by the "
          f"report before the teammate sums)")
    print(f"rows      : {len(predictions):,}")
    print(f"games     : {predictions['GAME_ID'].nunique():,}")
    print(f"cold start: {cold_rows:,} of {len(predictions):,} rows "
          f"({cold_rows / max(len(predictions), 1):.1%}) have GAME_DATE <= "
          f"{PROSPECTIVE_COLD_START_THROUGH}")
    print(f"mean P(play) : {predictions[P_PLAY].mean():.4f}  "
          f"(model {predictions[P_PLAY_MODEL].mean():.4f})")
    for target in TARGETS:
        col = f"E_{target}"
        if col in predictions.columns:
            print(f"mean E[{target}] : {predictions[col].mean():.4f}  "
                  f"(conditional {predictions[f'E_{target}_COND'].mean():.4f})")
    if summary.empty:
        print("overrides : none applied "
              f"({'no --statuses supplied' if args.statuses is None else 'no reportable status'})")
    else:
        print(f"overrides : {int(summary['rows'].sum()):,} rows, as of {statuses_as_of}")
        print(summary.to_string(index=False))
    print(f"saved     -> {args.out}")
    if written is not None:
        print(f"database  -> prediction_runs id {written[0]}, {written[1]:,} prediction rows")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
