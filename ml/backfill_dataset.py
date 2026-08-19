"""widen an existing dataset parquet with box columns the build predates.

    python backfill_dataset.py --dataset data/dataset.parquet \
        --out data/dataset_9cat.parquet --source postgres

WHY THIS EXISTS RATHER THAN "JUST REBUILD IT". The 9-category extension needs one
box column the four-season dataset does not carry (FGM) and twenty-two per-minute
rate columns derived from columns it already has. The obvious move is to rerun
``build_dataset.py --source postgres``, and on the database that produced the
shipped parquet it would be the right one. It is not available here:
``player_game_logs`` carries all four seasons, but ``player_game_status`` - the
table the UNIVERSE is built from - covers only the last two. A full rebuild
against it returns 74,718 rows where the shipped dataset has 147,413, and the
72,695 rows it drops are two entire seasons of training history. Losing half the
history to gain one column is not a trade worth making, and doing it silently
would be worse.

WHAT THIS DOES INSTEAD, and why it is not a shortcut that costs anything:

  1. every existing column is passed through UNTOUCHED. Not recomputed and
     compared - never recomputed at all, so parity is a property of the code path
     rather than a result that has to be checked. (It is checked anyway, by
     ``--verify``, because a claim that cheap to test should be tested.)
  2. FGM is read from ``player_game_logs`` and joined on (PLAYER_ID, GAME_ID,
     TEAM_ID) with 0.0 for scheduled rows with no log line - byte-for-byte the
     rule ``universe._attach_outcomes`` applies to every other stat column, called
     out here because "the player did not appear" and "the player appeared and
     made no shots" produce the same 0.0 in this dataset's outcome columns and
     always have. Rows where he did not appear are excluded from every rate window
     by the ``PLAYED == 1`` filter, so the shared 0.0 is never read as a made shot.
  3. the per-minute rate columns are recomputed by ``features.per_minute_rate_features``
     plus the same ``allow_exact_matches=False`` as-of join ``build_features`` uses.
     Not a reimplementation - the same two functions, called in the same order.

WHAT IS NOT RECOMPUTED, and why that is correct rather than merely convenient.
FGM enters no feature. It is not in ``ROLL_STATS``, not in ``UNCOND_STATS``, not
in any teammate magnitude, and not in ``FEATURE_COLS``; it is an OUTCOME column
and the target of a rate. Adding it therefore cannot change one existing feature
value, which is why ``FEATURE_VERSION`` stays at v3 - the feature frame is
unchanged and every artifact fitted against it remains valid.

READ-ONLY. this script issues one SELECT and writes one parquet. It opens no
transaction and executes no statement that could modify anything.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fnba_ml.cli import add_common_args, add_source_args, build_source, setup_logging  # noqa: E402
from fnba_ml.config import DATA_DIR, FEATURE_VERSION, RATE_TARGETS  # noqa: E402
from fnba_ml.data.schema import STAT_COLS, normalise_ids  # noqa: E402
from fnba_ml.features import (  # noqa: E402
    expanding_rate_column,
    per_minute_rate_features,
    rate_column,
)

log = logging.getLogger("backfill_dataset")

ROW_KEY = ["PLAYER_ID", "GAME_ID", "TEAM_ID"]


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    add_source_args(parser)
    add_common_args(parser)
    parser.add_argument("--dataset", type=Path, default=DATA_DIR / "dataset.parquet")
    parser.add_argument("--out", type=Path, default=DATA_DIR / "dataset_9cat.parquet")
    parser.add_argument(
        "--stats", default="FGM",
        help="comma-separated outcome columns to pull from the game logs",
    )
    parser.add_argument(
        "--verify", action="store_true",
        help="assert that every pre-existing column round-trips unchanged and that "
             "the recomputed PTS/AST rate columns reproduce the shipped ones",
    )
    return parser.parse_args(argv)


def attach_missing_stats(
    features: pd.DataFrame, player_logs: pd.DataFrame, stats: list[str]
) -> tuple[pd.DataFrame, dict[str, float]]:
    """join outcome columns off the game log onto the universe rows.

    the same join ``universe._attach_outcomes`` performs, restricted to the columns
    that are missing. A scheduled row with no log line gets 0.0, which is what every
    other stat column on this frame already does for a non-appearance.

    returns (widened frame, per-stat appearance coverage) - the coverage is the
    share of APPEARANCE rows that actually matched a log line, and it is the number
    that says whether the join worked. Overall coverage would be diluted by the ~22%
    of scheduled rows that are absences and are supposed to miss.
    """
    wanted = [s for s in stats if s not in features.columns]
    if not wanted:
        log.info("nothing to attach: %s already present", ", ".join(stats))
        return features, {}

    logs = normalise_ids(player_logs)
    have = [s for s in wanted if s in logs.columns]
    absent = [s for s in wanted if s not in logs.columns]
    if absent:
        raise SystemExit(
            f"the game log carries no {', '.join(absent)}; the source cannot supply "
            f"the requested column(s)"
        )

    actual = (
        logs[[*ROW_KEY, *have]]
        .drop_duplicates(ROW_KEY)
        .assign(_MATCHED=1.0)
    )
    out = normalise_ids(features).merge(actual, on=ROW_KEY, how="left")
    if len(out) != len(features):
        raise SystemExit(
            f"the game-log join changed the row count ({len(features)} -> {len(out)}); "
            f"{ROW_KEY} is not unique on one side"
        )

    appeared = out["PLAYED"].to_numpy(dtype=float) == 1
    matched = out["_MATCHED"].fillna(0.0).to_numpy(dtype=float) == 1
    coverage = {
        stat: float(np.mean(matched[appeared])) if appeared.any() else float("nan")
        for stat in have
    }
    for stat in have:
        out[stat] = pd.to_numeric(out[stat], errors="coerce").fillna(0.0).astype(float)
    return out.drop(columns=["_MATCHED"]), coverage


def rebuild_rate_columns(features: pd.DataFrame) -> pd.DataFrame:
    """drop and recompute every per-minute rate column, preserving row order.

    the existing ``ewma_PTS_per_min`` / ``ewma_AST_per_min`` are dropped rather than
    kept and merged around, for one reason: ``merge_asof`` would suffix a collision
    into ``_x``/``_y`` and the frame would quietly carry two versions of the same
    rate. Recomputing them is also the parity check ``--verify`` runs - the same
    function at the same halflife must reproduce the shipped column exactly, and if
    it does not, something about the rate construction changed that nobody meant to
    change.
    """
    existing = [
        c for t in RATE_TARGETS
        for c in (rate_column(t), expanding_rate_column(t))
        if c in features.columns
    ]
    out = features.drop(columns=existing).copy()
    out["_row_order"] = np.arange(len(out))
    out["GAME_DATE"] = pd.to_datetime(out["GAME_DATE"])
    out = out.sort_values("GAME_DATE").reset_index(drop=True)
    out = pd.merge_asof(
        out,
        per_minute_rate_features(out),
        on="GAME_DATE",
        by="PLAYER_ID",
        direction="backward",
        allow_exact_matches=False,  # THE LEAKAGE GUARD, same as build_features
    )
    return (
        out.sort_values("_row_order")
        .drop(columns=["_row_order"])
        .reset_index(drop=True)
    )


def verify_parity(before: pd.DataFrame, after: pd.DataFrame) -> list[str]:
    """columns that exist in both and disagree. empty is the only passing result."""
    a = before.sort_values(ROW_KEY).reset_index(drop=True)
    b = after.sort_values(ROW_KEY).reset_index(drop=True)
    if len(a) != len(b):
        return [f"ROW COUNT {len(a)} -> {len(b)}"]
    differing: list[str] = []
    for column in before.columns:
        if column not in after.columns:
            differing.append(f"{column} (dropped)")
            continue
        left, right = a[column], b[column]
        if left.dtype.kind in "fiu" and right.dtype.kind in "fiu":
            same = np.array_equal(
                left.to_numpy(dtype=float), right.to_numpy(dtype=float), equal_nan=True
            )
        else:
            same = left.astype(str).equals(right.astype(str))
        if not same:
            differing.append(column)
    return differing


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    setup_logging(args.verbose)

    if not args.dataset.exists():
        raise SystemExit(f"no dataset at {args.dataset}")
    features = pd.read_parquet(args.dataset)
    original = features.copy()
    stats = [s.strip().upper() for s in args.stats.split(",") if s.strip()]
    unknown = [s for s in stats if s not in STAT_COLS]
    if unknown:
        raise SystemExit(
            f"{', '.join(unknown)} is not in data.schema.STAT_COLS; this script only "
            f"backfills columns the canonical frame declares"
        )

    source = build_source(args)
    features, coverage = attach_missing_stats(
        features, source.load_player_game_logs(), stats
    )
    features = rebuild_rate_columns(features)

    differing = verify_parity(original, features) if args.verify else []

    args.out.parent.mkdir(parents=True, exist_ok=True)
    if differing:
        # written nowhere. a parquet that fails parity is not a dataset, it is a
        # bug with a filename, and the whole argument for backfilling rather than
        # rebuilding is that the existing columns do not move.
        print("--- BACKFILL: PARITY FAILED ---")
        for name in differing:
            print(f"  {name}")
        return 1
    features.to_parquet(args.out, index=False)

    print("--- BACKFILL ---")
    print(f"source           : {source.name}")
    print(f"in               : {args.dataset}")
    print(f"rows             : {len(features):,} (was {len(original):,})")
    print(f"columns          : {len(features.columns)} (was {len(original.columns)})")
    print(f"feature version  : {FEATURE_VERSION} (unchanged: FGM is an outcome, not a feature)")
    for stat, share in coverage.items():
        print(f"{stat} coverage      : {share:.4%} of appearance rows matched a log line")
        print(f"{stat} mean|appeared : {features.loc[features['PLAYED'] == 1, stat].mean():.4f}")
    if args.verify:
        print("parity           : every pre-existing column unchanged")
    new = [c for c in features.columns if c not in original.columns]
    print(f"added            : {len(new)} columns")
    for name in new:
        print(f"  {name}")
    print(f"saved            -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
