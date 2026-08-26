"""training-depth and weighting ablation on appearance-only (conditional) targets.

axes are swept one at a time around a fixed point rather than as a full grid.
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

EXPERIMENTS_DIR = Path(__file__).resolve().parent
ML_ROOT = EXPERIMENTS_DIR.parent
if str(ML_ROOT) not in sys.path:
    sys.path.insert(0, str(ML_ROOT))
if str(EXPERIMENTS_DIR) not in sys.path:
    sys.path.insert(0, str(EXPERIMENTS_DIR))

from fnba_ml.config import EWMA_HALFLIFE, ORIGINS  # noqa: E402
from fnba_ml.models import (  # noqa: E402
    EwmaProduction,
    PerMinuteRate,
    conditional_estimate,
    mae,
    make_lgbm_regressor,
    make_ridge,
)

from deep_dataset import (  # noqa: E402
    DEEP_DATA_DIR,
    DEEP_FEATURE_COLS,
    SEASON_INDEX,
    build_deep_features,
    season_age,
    season_start_year,
    seasons_on_disk,
    trailing_window,
)

log = logging.getLogger("depth_sweep")

RESULTS_DIR = DEEP_DATA_DIR / "results"

DEPTHS: tuple[int, ...] = (2, 4, 8, 13, 20, 29)
HALFLIVES: tuple[float, ...] = (3.0, 5.0, 8.0, 12.0)
DECAYS: tuple[float, ...] = (1.0, 0.8, 0.6)

BASE_HALFLIFE: float = float(EWMA_HALFLIFE)
BASE_DECAY: float = 1.0
HALFLIFE_SWEEP_DEPTH: int = 4

TRUNCATION_DEPTHS: tuple[int, ...] = (2, 4)

TARGETS: tuple[str, ...] = ("MIN", "PTS", "AST")


def origin_season(seasons: list[str], vstart: str) -> str:
    """which season a validation window belongs to.

    the month >= 8 cutoff is deliberately August, since COVID displaced the
    2019-20 and 2020-21 openers.
    """
    ts = pd.Timestamp(vstart)
    start_year = ts.year if ts.month >= 8 else ts.year - 1
    season = f"{start_year}-{str(start_year + 1)[2:]}"
    if season not in seasons:
        raise ValueError(
            f"validation window {vstart} maps to season {season}, which is not "
            f"in the available seasons {seasons[0]}..{seasons[-1]}"
        )
    return season


def recency_weights(
    row_seasons: pd.Series,
    seasons: list[str],
    end_season: str,
    decay: float,
) -> np.ndarray:
    """``decay ** (seasons before end_season)``, per training row.

    weights are not renormalised, since rescaling would shift regularisation
    strength differently for LightGBM and Ridge.
    """
    if not 0.0 < decay <= 1.0:
        raise ValueError(f"decay must be in (0, 1], got {decay}")
    ages = season_age(seasons, end_season)
    unknown = set(row_seasons.unique()) - set(ages)
    if unknown:
        raise ValueError(f"training rows carry unknown seasons: {sorted(unknown)}")
    age_array = row_seasons.map(ages).to_numpy(dtype=float)
    if (age_array < 0).any():
        raise ValueError(
            "training rows come from a season AFTER the origin season; the "
            "trailing window was built wrong"
        )
    return np.power(float(decay), age_array)


def split_origin(
    frame: pd.DataFrame,
    vstart: str,
    vend: str,
    train_seasons: list[str],
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """(train, valid) for one origin and one training window.

    train is strictly before ``vstart``; the valid slice ignores ``train_seasons``.
    """
    vstart_ts, vend_ts = pd.Timestamp(vstart), pd.Timestamp(vend)
    dates = pd.to_datetime(frame["GAME_DATE"])
    train = frame[frame["SEASON"].isin(train_seasons) & (dates < vstart_ts)]
    valid = frame[(dates >= vstart_ts) & (dates <= vend_ts)]
    return train, valid


def validation_key(valid: pd.DataFrame) -> tuple:
    """an order-independent fingerprint of a validation row set."""
    keys = list(zip(valid["PLAYER_ID"].astype(str), valid["GAME_ID"].astype(str)))
    return tuple(sorted(keys))


class ValidationRowRegistry:
    """remembers the first validation row set seen per origin and enforces it."""

    def __init__(self) -> None:
        self._seen: dict[str, tuple] = {}
        self.checks = 0

    def enforce(self, origin: str, valid: pd.DataFrame, label: str) -> None:
        key = validation_key(valid)
        self.checks += 1
        first = self._seen.setdefault(origin, key)
        if key != first:
            raise AssertionError(
                f"{label}: origin {origin} scored {len(key)} validation rows but "
                f"the first configuration scored {len(first)}; the validation set "
                f"must be identical across every configuration"
            )


def assert_identical_validation_rows(valid_frames: dict[str, pd.DataFrame]) -> int:
    """returns the row count every frame agreed on, raising if any two differ."""
    if not valid_frames:
        raise ValueError("nothing to compare")
    keys = {label: validation_key(v) for label, v in valid_frames.items()}
    reference_label, reference = next(iter(keys.items()))
    for label, key in keys.items():
        if key != reference:
            raise AssertionError(
                f"validation rows differ: {label} has {len(key)} rows, "
                f"{reference_label} has {len(reference)}"
            )
    return len(reference)


def _feature_matrix(frame: pd.DataFrame, feature_cols: list[str]) -> pd.DataFrame:
    return frame[feature_cols].astype("float64")


def evaluate_cell(
    frame: pd.DataFrame,
    seasons: list[str],
    origin: tuple[str, str, str],
    depth: int,
    decay: float,
    feature_cols: list[str],
    registry: ValidationRowRegistry | None,
    label: str,
) -> list[dict]:
    """fit every estimator for one (origin, depth, decay) and score them."""
    name, vstart, vend = origin
    end_season = origin_season(seasons, vstart)
    window = trailing_window(seasons, end_season, depth)
    train, valid = split_origin(frame, vstart, vend, window)
    if train.empty or valid.empty:
        log.warning("%s / %s depth=%d: empty side, skipped", label, name, depth)
        return []

    if registry is not None:
        registry.enforce(name, valid, label)

    max_train = pd.to_datetime(train["GAME_DATE"]).max()
    if max_train >= pd.Timestamp(vstart):
        raise AssertionError(
            f"{label} / {name}: training data reaches {max_train.date()}, on or "
            f"after the validation start {vstart}"
        )

    weights = recency_weights(train["SEASON"], seasons, end_season, decay)
    x_train = _feature_matrix(train, feature_cols)
    x_valid = _feature_matrix(valid, feature_cols)

    common = {
        "origin": name,
        "depth": depth,
        "realised_depth": len(window),
        "train_seasons": f"{window[0]}..{window[-1]}",
        "decay": decay,
        "n_train": int(len(train)),
        "n_valid": int(len(valid)),
        "n_features": len(feature_cols),
    }
    rows: list[dict] = []

    def record(target: str, estimator: str, pred: np.ndarray) -> None:
        rows.append({**common, "target": target, "estimator": estimator,
                     "mae": mae(valid[target], pred)})

    minutes_lgbm = make_lgbm_regressor()
    minutes_lgbm.fit(x_train, train["MIN"], sample_weight=weights)
    minutes_pred = np.clip(minutes_lgbm.predict(x_valid).astype(float), 0.0, None)
    record("MIN", "lightgbm", minutes_pred)

    minutes_ridge = make_ridge()
    minutes_ridge.fit(x_train, train["MIN"], reg__sample_weight=weights)
    record("MIN", "ridge",
           np.clip(minutes_ridge.predict(x_valid).astype(float), 0.0, None))

    record("MIN", "ewma", EwmaProduction("MIN").fit(train).predict(valid))

    for target in ("PTS", "AST"):
        record(target, "ewma_total", EwmaProduction(target).fit(train).predict(valid))

        rate = PerMinuteRate(target).fit(train).predict(valid)
        record(target, "ewma_propagated", conditional_estimate(minutes_pred, rate))

        ridge = make_ridge()
        ridge.fit(x_train, train[target], reg__sample_weight=weights)
        record(target, "ridge",
               np.clip(ridge.predict(x_valid).astype(float), 0.0, None))

    return rows


def run_depth_sweep(frame: pd.DataFrame, seasons: list[str],
                    registry: ValidationRowRegistry) -> pd.DataFrame:
    """axis 1: training depth, at the production halflife and no decay."""
    rows: list[dict] = []
    for depth in DEPTHS:
        started = time.time()
        for origin in ORIGINS:
            rows.extend([
                {**r, "phase": "depth", "halflife": BASE_HALFLIFE,
                 "features": "full-history", "era_flag": False}
                for r in evaluate_cell(frame, seasons, origin, depth, BASE_DECAY,
                                       DEEP_FEATURE_COLS, registry,
                                       f"depth={depth}")
            ])
        log.info("depth=%d done in %.0fs", depth, time.time() - started)
    return pd.DataFrame(rows)


def run_halflife_sweep(seasons: list[str],
                       registry: ValidationRowRegistry) -> pd.DataFrame:
    """axis 2a: the EWMA halflife the features carry.

    a feature-definition axis, so the frame is rebuilt per halflife and depth is
    pinned so the two axes are not confounded.
    """
    rows: list[dict] = []
    for halflife in HALFLIVES:
        started = time.time()
        frame = build_deep_features(seasons, halflife=halflife)
        for origin in ORIGINS:
            rows.extend([
                {**r, "phase": "halflife", "halflife": halflife,
                 "features": "full-history", "era_flag": False}
                for r in evaluate_cell(frame, seasons, origin,
                                       HALFLIFE_SWEEP_DEPTH, BASE_DECAY,
                                       DEEP_FEATURE_COLS, registry,
                                       f"halflife={halflife:g}")
            ])
        del frame
        log.info("halflife=%g done in %.0fs", halflife, time.time() - started)
    return pd.DataFrame(rows)


def run_decay_sweep(frame: pd.DataFrame, seasons: list[str], best_depth: int,
                    registry: ValidationRowRegistry) -> pd.DataFrame:
    """axis 2b: exponential sample weighting by season age, at the best depth."""
    rows: list[dict] = []
    for decay in DECAYS:
        started = time.time()
        for origin in ORIGINS:
            rows.extend([
                {**r, "phase": "decay", "halflife": BASE_HALFLIFE,
                 "features": "full-history", "era_flag": False}
                for r in evaluate_cell(frame, seasons, origin, best_depth, decay,
                                       DEEP_FEATURE_COLS, registry,
                                       f"decay={decay:g}")
            ])
        log.info("decay=%g done in %.0fs", decay, time.time() - started)
    return pd.DataFrame(rows)


def run_era_probe(frame: pd.DataFrame, seasons: list[str], best_depth: int,
                  registry: ValidationRowRegistry) -> pd.DataFrame:
    """the depth-sweep cell plus ``SEASON_INDEX`` as an era flag."""
    rows: list[dict] = []
    feature_cols = [*DEEP_FEATURE_COLS, SEASON_INDEX]
    for origin in ORIGINS:
        rows.extend([
            {**r, "phase": "era_flag", "halflife": BASE_HALFLIFE,
             "features": "full-history", "era_flag": True}
            for r in evaluate_cell(frame, seasons, origin, best_depth, BASE_DECAY,
                                   feature_cols, registry, "era_flag")
        ])
    return pd.DataFrame(rows)


def run_truncation_probe(seasons: list[str],
                         registry: ValidationRowRegistry) -> pd.DataFrame:
    """rebuilds features over the truncated raw history, not just the window.

    separates the training-volume effect from the feature-history effect.
    """
    rows: list[dict] = []
    for depth in TRUNCATION_DEPTHS:
        for origin in ORIGINS:
            end_season = origin_season(seasons, origin[1])
            window = trailing_window(seasons, end_season, depth)
            frame = build_deep_features(window, halflife=BASE_HALFLIFE)
            rows.extend([
                {**r, "phase": "truncated", "halflife": BASE_HALFLIFE,
                 "features": "truncated", "era_flag": False}
                for r in evaluate_cell(frame, window, origin, depth, BASE_DECAY,
                                       DEEP_FEATURE_COLS, registry,
                                       f"truncated depth={depth}")
            ])
            del frame
        log.info("truncated depth=%d done", depth)
    return pd.DataFrame(rows)


def mean_by(results: pd.DataFrame, index: str | list[str],
            columns: str | list[str] = "estimator") -> pd.DataFrame:
    """mean MAE over origins."""
    return results.pivot_table(index=index, columns=columns, values="mae",
                               aggfunc="mean")


def best_depth_for(results: pd.DataFrame, target: str, estimator: str) -> int:
    table = results[(results["target"] == target) & (results["estimator"] == estimator)]
    means = table.groupby("depth")["mae"].mean()
    return int(means.idxmin())


def ascii_curve(series: pd.Series, width: int = 44) -> str:
    """a monospace bar chart of MAE against depth, lower being better.

    bars start from a floor just below the minimum, not zero, since the spread
    across depths is about 1% of the level.
    """
    values = series.astype(float)
    lo, hi = values.min(), values.max()
    span = (hi - lo) or 1.0
    floor = lo - 0.15 * span
    ceiling = hi + 0.05 * span
    lines = []
    for label, value in values.items():
        filled = int(round(width * (value - floor) / (ceiling - floor)))
        marker = "  <- best" if value == lo else ""
        lines.append(f"  {str(label):>10}  {value:7.4f}  {'#' * filled}{marker}")
    return "\n".join(lines)


def print_table(title: str, table: pd.DataFrame) -> None:
    print(f"\n### {title}")
    print(table.round(4).to_string())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phases", nargs="*",
                        default=["depth", "halflife", "decay", "era", "truncated"])
    parser.add_argument("--out", default=str(RESULTS_DIR / "depth_sweep_results.csv"))
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s",
                        datefmt="%H:%M:%S")
    logging.getLogger("fnba_ml").setLevel(logging.WARNING)

    seasons = seasons_on_disk()
    if not seasons:
        log.error("no pulled seasons in %s - run pull_deep_history.py first",
                  DEEP_DATA_DIR)
        return 1
    log.info("%d seasons on disk: %s .. %s", len(seasons), seasons[0], seasons[-1])

    registry = ValidationRowRegistry()
    started = time.time()
    frame = build_deep_features(seasons, halflife=BASE_HALFLIFE)
    log.info("base feature frame: %d rows x %d cols (%.0fs)",
             len(frame), frame.shape[1], time.time() - started)

    parts: list[pd.DataFrame] = []
    depth_results = pd.DataFrame()

    if "depth" in args.phases:
        depth_results = run_depth_sweep(frame, seasons, registry)
        parts.append(depth_results)

    best_depth = (
        best_depth_for(depth_results, "MIN", "lightgbm")
        if not depth_results.empty else max(DEPTHS)
    )
    log.info("best depth for MIN|lightgbm: %d seasons", best_depth)

    if "decay" in args.phases:
        parts.append(run_decay_sweep(frame, seasons, best_depth, registry))
    if "era" in args.phases:
        parts.append(run_era_probe(frame, seasons, best_depth, registry))

    del frame

    if "halflife" in args.phases:
        parts.append(run_halflife_sweep(seasons, registry))
    if "truncated" in args.phases:
        parts.append(run_truncation_probe(seasons, registry))

    results = pd.concat([p for p in parts if not p.empty], ignore_index=True)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    results.to_csv(out_path, index=False)

    print(f"\n{'=' * 78}\nDEEP-HISTORY DEPTH / WEIGHTING ABLATION\n{'=' * 78}")
    print(f"seasons available : {len(seasons)} ({seasons[0]} .. {seasons[-1]})")
    print(f"features          : {len(DEEP_FEATURE_COLS)} (appearance-only, "
          f"status-dependent teammate features excluded)")
    print(f"origins           : {len(ORIGINS)} -> "
          f"{', '.join(o[0] for o in ORIGINS)}")
    print(f"validation-row identity checks passed: {registry.checks}")
    print(f"wall clock        : {time.time() - started:.0f}s")

    depth = results[results["phase"] == "depth"]
    if not depth.empty:
        for target in TARGETS:
            print_table(f"depth curve - {target} | played (mean MAE over 5 origins)",
                        mean_by(depth[depth["target"] == target], "depth"))
        print("\n### depth curve chart - MIN | played, LightGBM champion")
        curve = (depth[(depth["target"] == "MIN") & (depth["estimator"] == "lightgbm")]
                 .groupby("depth")["mae"].mean())
        print(ascii_curve(curve))
        print_table("per-origin consistency - MIN | played, LightGBM",
                    depth[(depth["target"] == "MIN")
                          & (depth["estimator"] == "lightgbm")]
                    .pivot_table(index="depth", columns="origin", values="mae"))
        print_table("training rows per depth (mean over origins)",
                    depth.pivot_table(index="depth", values="n_train",
                                      aggfunc="mean"))

    halflife = results[results["phase"] == "halflife"]
    if not halflife.empty:
        for target in TARGETS:
            print_table(f"halflife sweep (depth={HALFLIFE_SWEEP_DEPTH}) - {target}",
                        mean_by(halflife[halflife["target"] == target], "halflife"))

    decay = results[results["phase"] == "decay"]
    if not decay.empty:
        for target in TARGETS:
            print_table(f"decay sweep (depth={best_depth}) - {target}",
                        mean_by(decay[decay["target"] == target], "decay"))

    era = results[results["phase"] == "era_flag"]
    if not era.empty and not depth.empty:
        base = depth[depth["depth"] == best_depth].assign(variant="30 features")
        probe = era.assign(variant=f"31 features (+{SEASON_INDEX})")
        comparison = pd.concat([base, probe], ignore_index=True).pivot_table(
            index=["target", "estimator"], columns="variant", values="mae"
        )
        comparison["delta_%"] = 100.0 * (
            comparison.iloc[:, 1] / comparison.iloc[:, 0] - 1.0
        )
        print_table(f"era-flag probe (depth={best_depth}): "
                    f"+{SEASON_INDEX} vs the same cell without it", comparison)

    truncated = results[results["phase"] == "truncated"]
    if not truncated.empty and not depth.empty:
        for target in TARGETS:
            merged = pd.concat([
                mean_by(depth[(depth["target"] == target)
                              & depth["depth"].isin(TRUNCATION_DEPTHS)],
                        "depth").add_suffix(" [full-history features]"),
                mean_by(truncated[truncated["target"] == target], "depth")
                .add_suffix(" [truncated features]"),
            ], axis=1)
            print_table(f"raw-history truncation probe - {target}", merged)

    print(f"\ntidy results -> {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
