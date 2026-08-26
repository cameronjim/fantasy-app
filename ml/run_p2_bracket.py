"""the P2 decision run: v3-honest vs v4 over identical rows, with the pre-registered bar."""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fnba_ml.cli import add_common_args, load_dataset, setup_logging  # noqa: E402
from fnba_ml.config import (  # noqa: E402
    BLOWOUT_MODEL_KIND,
    CANDIDATE_FEATURE_SET,
    CANDIDATE_FEATURE_VERSION,
    CHAMPIONS,
    DATA_DIR,
    DEV_ORIGINS,
    FEATURE_COLS,
    FEATURE_COLS_V4,
    FEATURE_VERSION,
    LATE_SEASON_ORIGIN,
    P2_COHORT_REGRESSION_TOLERANCE,
    P2_PROMOTION_ENDPOINTS,
    P2_PROMOTION_FLOOR,
    REPORTS_DIR,
    SERVED_FEATURE_SET,
)
from fnba_ml.evaluate import cohort_masks, split  # noqa: E402
from fnba_ml.features import feature_set_columns  # noqa: E402
from fnba_ml.models import (  # noqa: E402
    AvailabilityModel,
    MinutesModel,
    P_PLAY,
    PerMinuteRate,
    minutes_propagated_estimate,
)
from fnba_ml.promotion import (  # noqa: E402
    BLOCK_DAYS,
    ENDPOINT_AVAILABILITY,
    ENDPOINT_MINUTES,
    ENDPOINT_UNCOND_PTS,
    N_REPLICATES,
    cohort_regressions,
    decide,
    decision_table,
    paired_endpoint_bootstrap,
)
from fnba_ml.registry import git_commit  # noqa: E402

log = logging.getLogger("run_p2_bracket")

ENDPOINT_ROWS = {
    ENDPOINT_AVAILABILITY: "scheduled",
    ENDPOINT_MINUTES: "appearances",
    ENDPOINT_UNCOND_PTS: "scheduled",
}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_common_args(parser)
    parser.add_argument("--dataset", type=Path,
                        default=DATA_DIR / "dataset_v4.parquet")
    parser.add_argument("--version", default="p2")
    parser.add_argument("--reports-dir", type=Path, default=REPORTS_DIR)
    return parser.parse_args(argv)


def score_one_pass(
    frame: pd.DataFrame,
    feature_set: str,
    origins: list[tuple[str, str, str]],
) -> pd.DataFrame:
    """per-row losses for all three endpoints, one feature set, every origin."""
    feats = feature_set_columns(frame, feature_set)
    log.info("pass %s: %d features", feature_set, len(feats))
    out: list[pd.DataFrame] = []

    for origin, vstart, vend in origins:
        train_all, valid_all = split(frame, vstart, vend)
        train_app = train_all[train_all["PLAYED"] == 1]
        valid_app_mask = (valid_all["PLAYED"] == 1).to_numpy()
        if train_all.empty or valid_all.empty or train_app.empty:
            log.warning("origin %s has an empty side; skipped", origin)
            continue
        cutoff = pd.Timestamp(valid_all["GAME_DATE"].min())

        availability = AvailabilityModel(kind=CHAMPIONS["availability"]).fit(
            train_all, feats, cutoff
        )
        scored = availability.attach(valid_all)
        minutes = MinutesModel(kind=CHAMPIONS["minutes"]).fit(train_app, feats, cutoff)
        scored = minutes.attach(scored)
        rate = PerMinuteRate("PTS").fit(train_app)
        _, uncond = minutes_propagated_estimate(scored, rate.predict(valid_all))

        masks = cohort_masks(valid_all)

        key = (
            valid_all["PLAYER_ID"].astype(str) + "|"
            + valid_all["GAME_ID"].astype(str) + "|"
            + valid_all["TEAM_ID"].astype(str)
        ).to_numpy()
        dates = valid_all["GAME_DATE"].to_numpy()
        p = scored[P_PLAY].to_numpy(dtype=float)
        y_play = valid_all["PLAYED"].to_numpy(dtype=float)
        min_pred = scored["MIN_PRED"].to_numpy(dtype=float)
        y_min = valid_all["MIN"].to_numpy(dtype=float)
        y_pts = valid_all["PTS"].to_numpy(dtype=float)

        every_row = np.ones(len(valid_all), dtype=bool)
        losses = {
            # each per-row loss must be the one whose MEAN IS the reported metric,
            # because the bootstrap's theta is a ratio of sums.
            ENDPOINT_AVAILABILITY: ((p - y_play) ** 2, every_row),
            ENDPOINT_MINUTES: (np.abs(min_pred - y_min), valid_app_mask),
            ENDPOINT_UNCOND_PTS: (np.abs(uncond - y_pts), every_row),
        }
        # cohorts are emitted as extra rows, not a column: a row belongs to several
        # cohorts at once.
        for label, mask in (("ALL", every_row), *masks):
            if not mask.any():
                continue
            for endpoint, (loss, selector) in losses.items():
                sel = mask & selector
                if not sel.any():
                    continue
                out.append(pd.DataFrame({
                    "origin": origin,
                    "endpoint": endpoint,
                    "row_key": key[sel],
                    "GAME_DATE": dates[sel],
                    "cohort": label,
                    "loss": loss[sel],
                }))

    if not out:
        raise SystemExit("no origin produced results; check the dataset's date range")
    return pd.concat(out, ignore_index=True)


def pooled(frame: pd.DataFrame, endpoint: str) -> pd.DataFrame:
    """the ALL-cohort rows for one endpoint, in a canonical order for pairing."""
    sub = frame[(frame["endpoint"] == endpoint) & (frame["cohort"] == "ALL")]
    return sub.sort_values(["origin", "GAME_DATE", "row_key"]).reset_index(drop=True)


def per_origin_table(
    incumbent: pd.DataFrame, candidate: pd.DataFrame, endpoint: str
) -> pd.DataFrame:
    """one row per origin: the two means and the relative change."""
    a, b = pooled(incumbent, endpoint), pooled(candidate, endpoint)
    joint = pd.DataFrame({
        "origin": a["origin"].to_numpy(),
        "base": a["loss"].to_numpy(dtype=float),
        "cand": b["loss"].to_numpy(dtype=float),
    })
    rows = []
    for origin, group in joint.groupby("origin", sort=True):
        base, cand = float(group["base"].mean()), float(group["cand"].mean())
        rows.append({
            "origin": origin, "n": int(len(group)),
            "v3-honest": base, "v4": cand,
            "delta_pct": (cand - base) / base if base > 0 else float("nan"),
            "late_season": origin == LATE_SEASON_ORIGIN[0],
        })
    return pd.DataFrame(rows)


def cohort_table(
    incumbent: pd.DataFrame, candidate: pd.DataFrame, endpoint: str
) -> pd.DataFrame:
    """the cohort breakdown for one endpoint, pooled over origins."""
    a = incumbent[incumbent["endpoint"] == endpoint].sort_values(
        ["cohort", "origin", "GAME_DATE", "row_key"]
    ).reset_index(drop=True)
    b = candidate[candidate["endpoint"] == endpoint].sort_values(
        ["cohort", "origin", "GAME_DATE", "row_key"]
    ).reset_index(drop=True)
    if not a["row_key"].equals(b["row_key"]):
        raise SystemExit(
            f"the two passes' cohort rows for {endpoint} are not aligned; a cohort "
            f"comparison over different rows is not a comparison"
        )
    return cohort_regressions(a, b)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    setup_logging(args.verbose)

    frame = load_dataset(args.dataset)
    missing = [c for c in FEATURE_COLS_V4 if c not in frame.columns]
    if missing:
        raise SystemExit(
            f"the dataset is missing {len(missing)} candidate column(s): "
            f"{', '.join(missing[:8])}. run build_v4_dataset.py first."
        )

    log.info("scoring the incumbent pass (%s)", SERVED_FEATURE_SET)
    incumbent = score_one_pass(frame, SERVED_FEATURE_SET, DEV_ORIGINS)
    log.info("scoring the candidate pass (%s)", CANDIDATE_FEATURE_SET)
    candidate = score_one_pass(frame, CANDIDATE_FEATURE_SET, DEV_ORIGINS)

    decisions = [
        paired_endpoint_bootstrap(
            pooled(incumbent, endpoint), pooled(candidate, endpoint), endpoint
        )
        for endpoint in ENDPOINT_ROWS
    ]
    gated_cohorts = pd.concat(
        [
            cohort_table(incumbent, candidate, endpoint).assign(endpoint=endpoint)
            for endpoint in P2_PROMOTION_ENDPOINTS
        ],
        ignore_index=True,
    )
    verdict = decide(decisions, gated_cohorts)

    args.reports_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{args.version}_p2"
    table = decision_table(verdict)
    table.to_csv(args.reports_dir / f"{stem}_decision.csv", index=False)
    gated_cohorts.to_csv(args.reports_dir / f"{stem}_cohorts.csv", index=False)
    origin_frames = pd.concat(
        [
            per_origin_table(incumbent, candidate, endpoint).assign(endpoint=endpoint)
            for endpoint in ENDPOINT_ROWS
        ],
        ignore_index=True,
    )
    origin_frames.to_csv(args.reports_dir / f"{stem}_per_origin.csv", index=False)
    all_cohorts = pd.concat(
        [
            cohort_table(incumbent, candidate, endpoint).assign(endpoint=endpoint)
            for endpoint in ENDPOINT_ROWS
        ],
        ignore_index=True,
    )
    all_cohorts.to_csv(args.reports_dir / f"{stem}_cohorts_all_endpoints.csv",
                       index=False)

    print("=" * 78)
    print("P2 DECISION RUN - v3-honest (incumbent, FROZEN CONTRACT) vs v4 (candidate)")
    print("=" * 78)
    print(f"git commit        : {git_commit() or 'unknown'}")
    print(f"dataset           : {args.dataset} ({len(frame):,} rows)")
    print(f"served contract   : feature_version {FEATURE_VERSION}, "
          f"{len(FEATURE_COLS)} columns  [UNCHANGED BY THIS RUN]")
    print(f"candidate contract: feature_version {CANDIDATE_FEATURE_VERSION}, "
          f"{len(FEATURE_COLS_V4)} columns")
    print(f"origins           : {len(DEV_ORIGINS)} (config.DEV_ORIGINS = the five "
          f"config.ORIGINS + {LATE_SEASON_ORIGIN[0]})")
    print(f"blowout estimator : {BLOWOUT_MODEL_KIND} (selected on inner folds)")
    print()
    print("THE PRE-REGISTERED BAR (config P2 block, written before this ran):")
    print(f"  * paired {BLOCK_DAYS}-day moving-block bootstrap over game dates, "
          f"{N_REPLICATES} replicates,")
    print("    95% percentile CI EXCLUDING ZERO;")
    print(f"  * AND >= {P2_PROMOTION_FLOOR:.0%} pooled relative improvement on "
          f"{' or '.join(P2_PROMOTION_ENDPOINTS)};")
    print(f"  * AND no cohort regressing by more than "
          f"{P2_COHORT_REGRESSION_TOLERANCE:.0%}.")
    print(f"  1% and not the package's usual 2% because this is a FEATURE-SET change "
          f"to an existing")
    print("  champion, matching the section 11 v3 adoption precedent (-1.98% / "
          "-0.81%), not an")
    print("  estimator promotion. positive relative_improvement = the candidate is "
          "better.")
    print()

    print("-- endpoints (pooled over all six origins) --")
    print(table.to_string(index=False, float_format=lambda v: f"{v:+.4f}"))
    print()

    for endpoint in ENDPOINT_ROWS:
        print(f"-- {endpoint} by origin (positive delta_pct = v4 is WORSE) --")
        sub = origin_frames[origin_frames["endpoint"] == endpoint].drop(
            columns=["endpoint"]
        )
        print(sub.to_string(index=False, float_format=lambda v: f"{v:9.4f}"))
        print()

    print("-- cohorts, gated endpoints (positive delta_pct = v4 is WORSE) --")
    print(gated_cohorts.to_string(index=False, float_format=lambda v: f"{v:9.4f}"))
    print()
    print("-- cohorts, report-only endpoint --")
    other = all_cohorts[all_cohorts["endpoint"] == ENDPOINT_UNCOND_PTS]
    print(other.to_string(index=False, float_format=lambda v: f"{v:9.4f}"))
    print()

    print("=" * 78)
    print(verdict.reason)
    print("=" * 78)
    print(f"csvs -> {args.reports_dir / f'{stem}_decision.csv'} and three more")

    # exit 0 either way: a null result is a valid outcome of a pre-registered test.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
