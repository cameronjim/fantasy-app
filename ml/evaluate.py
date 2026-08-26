"""rolling-origin evaluation report."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fnba_ml.cli import add_common_args, default_dataset_path, load_dataset, setup_logging  # noqa: E402
from fnba_ml.config import (  # noqa: E402
    FEATURE_SETS,
    FEATURE_VERSION,
    ORIGINS,
    RATE_HALFLIFE_GRID,
    RATE_TARGETS,
    REPORTS_DIR,
    SERVED_FEATURE_SET,
    TEAMMATE_FEATURE_COLS,
)
from fnba_ml.evaluate import (  # noqa: E402
    ABLATION_FEATURE,
    TASK_AVAILABILITY,
    TASK_MINUTES,
    TASK_UNCONDITIONAL,
    add_negative_control,
    coherence_table,
    cohort_outcome_lift,
    composition_parity,
    degraded_oracle_grid,
    feature_set_bracket,
    feature_set_comparison,
    mean_by_model,
    negative_control_pass,
    rate_composition_parity,
    rate_halflife_winners,
    rate_ladder_table,
    rate_uncond_table,
    render_report,
    run_feature_set_bracket,
    run_rolling_origin,
    select_champions,
    select_rate_halflives,
    single_feature_ablation,
    teammate_importance,
)
from fnba_ml.features import available_features  # noqa: E402
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
    parser.add_argument(
        "--compare-without-teammates", action="store_true",
        help="also run the ladder with the v2 teammate features dropped",
    )
    parser.add_argument(
        "--no-negative-control", action="store_true",
        help="skip the permuted-context importance null",
    )
    parser.add_argument(
        "--bracket", action="store_true",
        help=f"run the ladder once per feature set ({', '.join(FEATURE_SETS)})",
    )
    parser.add_argument(
        "--ablation", action="store_true",
        help=f"refit the served set with {ABLATION_FEATURE} removed",
    )
    parser.add_argument(
        "--degraded-oracle-grid", action="store_true",
        help="sweep the Level-C absence-recall x false-positive grid",
    )
    parser.add_argument(
        "--rate-halflife-selection", action="store_true",
        help=f"sweep the halflife grid {RATE_HALFLIFE_GRID} on INNER folds",
    )
    parser.add_argument(
        "--no-rate-ladder", action="store_true",
        help="skip the 9-category rate ladder",
    )
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

    if not args.no_negative_control:
        features = add_negative_control(features)

    rate_targets = () if args.no_rate_ladder else RATE_TARGETS

    bracket_passes: dict[str, pd.DataFrame] = {}
    if args.bracket:
        bracket_passes = run_feature_set_bracket(
            features, origins, rate_targets=rate_targets
        )
        results = bracket_passes[SERVED_FEATURE_SET]
    else:
        results = run_rolling_origin(features, origins, rate_targets=rate_targets)

    if not args.no_negative_control:
        control = negative_control_pass(features, origins, available_features(features))
        if not control.empty:
            results = pd.concat([results, control], ignore_index=True)
    champions = select_champions(results)

    bracket = feature_set_bracket(bracket_passes) if bracket_passes else None

    baseline = None
    if args.compare_without_teammates:
        log.info("second pass: the same ladder with the teammate features dropped")
        baseline = run_rolling_origin(
            features, origins, drop_features=TEAMMATE_FEATURE_COLS
        )
    elif bracket_passes:
        baseline = bracket_passes.get("v1")

    ablation = None
    if args.ablation:
        log.info("ablation pass: the served set without %s", ABLATION_FEATURE)
        ablation = single_feature_ablation(
            features, origins,
            full=bracket_passes.get(SERVED_FEATURE_SET),
        )

    degraded = None
    if args.degraded_oracle_grid:
        log.info("Level-C degraded-oracle grid: this is the expensive one")
        degraded = degraded_oracle_grid(features, origins)

    rate_selection = None
    rate_winners = None
    if args.rate_halflife_selection:
        log.info("inner-fold halflife selection over %s", ", ".join(RATE_TARGETS))
        rate_selection = select_rate_halflives(features, origins)
        rate_winners = rate_halflife_winners(rate_selection)

    lift = cohort_outcome_lift(features)

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
    report_path.write_text(
        render_report(results, champions, meta, baseline=baseline, lift=lift,
                     bracket=bracket, ablation=ablation, degraded=degraded,
                     rate_winners=rate_winners, rate_selection=rate_selection),
        encoding="utf-8",
    )
    results_path = args.reports_dir / f"{args.version}_results.csv"
    results.to_csv(results_path, index=False)
    if baseline is not None:
        baseline.to_csv(args.reports_dir / f"{args.version}_baseline_results.csv",
                        index=False)
    if bracket_passes:
        tagged = pd.concat(
            [frame.assign(feature_set=name) for name, frame in bracket_passes.items()],
            ignore_index=True,
        )
        tagged.to_csv(args.reports_dir / f"{args.version}_bracket_results.csv",
                      index=False)
    if degraded is not None and not degraded.empty:
        degraded.to_csv(args.reports_dir / f"{args.version}_degraded_oracle.csv",
                        index=False)
    if rate_selection is not None and not rate_selection.empty:
        rate_selection.to_csv(
            args.reports_dir / f"{args.version}_rate_halflife_selection.csv", index=False
        )
        rate_winners.to_csv(
            args.reports_dir / f"{args.version}_rate_halflife_winners.csv", index=False
        )

    print("--- EVALUATE ---")
    print(f"origins   : {len(origins)}")
    print(f"features  : {FEATURE_VERSION}")
    print(f"report    -> {report_path}")
    print(f"tidy csv  -> {results_path}\n")

    print("availability Brier (mean over origins):")
    print(mean_by_model(results, TASK_AVAILABILITY, "Brier").to_string())
    print("\nminutes|played MAE (mean over origins):")
    print(mean_by_model(results, TASK_MINUTES, "MAE").to_string())
    print("\nunconditional PTS MAE (mean over origins):")
    print(mean_by_model(results, TASK_UNCONDITIONAL, "MAE").to_string())

    ladder = rate_ladder_table(results)
    if not ladder.empty:
        print("\n9-category rate ladder, conditional MAE (positive vs_* = the "
              "champion is better):")
        print(ladder.to_string(index=False))
        uncond = rate_uncond_table(results)
        if not uncond.empty:
            print("\n9-category rate ladder, UNCONDITIONAL MAE:")
            print(uncond.to_string(index=False))

    coherence = coherence_table(results)
    if not coherence.empty:
        print("\ncoherence: share of emitted rows where the clip binds")
        print(coherence.to_string())

    if rate_winners is not None and not rate_winners.empty:
        print("\nhalflife selection on inner training folds:")
        print(rate_winners.to_string(index=False))
    if not champions.empty:
        print("\nchampion selection:")
        print(champions.to_string(index=False))

    importance = teammate_importance(results)
    if not importance.empty:
        print("\nteammate-context feature importance (mean split gain over origins):")
        print(importance.to_string(index=False))

    if bracket is not None and not bracket.empty:
        print("\nthe honest-vs-oracle bracket (negative pct = better; survived = "
              "share of the oracle gain that honest construction keeps):")
        print(bracket.to_string())

    if ablation is not None and not ablation.empty:
        print(f"\nsingle-feature ablation, {ABLATION_FEATURE} removed "
              f"(positive cost = the column was worth something):")
        print(ablation.to_string())

    if degraded is not None and not degraded.empty:
        print("\nLevel-C degraded-oracle grid:")
        print(degraded.to_string(index=False))

    if baseline is not None:
        comparison = feature_set_comparison(baseline, results)
        if not comparison.empty:
            print("\nv1 features vs the served set (negative delta = better):")
            print(comparison.to_string())

    if lift is not None and not lift.empty:
        print("\nevent-cohort outcome lift (model-free):")
        print(lift.to_string(index=False))

    parity = composition_parity(results)
    per_stat = rate_composition_parity(results)
    if not per_stat.empty:
        failed = per_stat[~per_stat["within_tolerance"]]
        print(f"\nper-stat composition parity ({len(per_stat)} stats, tolerance "
              f"{per_stat['tolerance'].iloc[0]:.2%}; positive delta = the champion "
              f"is worse):")
        print(per_stat.to_string(index=False))
        if len(failed):
            print(f"  REGRESSION on {', '.join(failed['target'])}: the "
                  f"minutes-propagating composition costs more accuracy than the "
                  f"correctness argument buys for those stats. do not ship them.")
            return 1

    if not parity:
        print("\ncomposition parity: NOT CHECKED (a composition is missing from the results)")
        return 0
    verdict = "PARITY" if parity["within_tolerance"] else "REGRESSION"
    print(f"\ncomposition parity: {verdict}")
    print(f"  champion {parity['champion']}: {parity['champion_mae']:.4f} MAE")
    print(f"  previous {parity['previous']}: {parity['previous_mae']:.4f} MAE")
    print(f"  relative delta {parity['relative_delta']:+.2%} "
          f"(tolerance {parity['tolerance']:.2%})")
    if not parity["within_tolerance"]:
        print("  the promoted composition costs more accuracy than the correctness "
              "argument buys. do not ship it.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
