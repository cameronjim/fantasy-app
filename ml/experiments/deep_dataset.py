"""appearance-only (conditional) datasets over configurable season ranges.

conditional targets only; no availability target exists before 2022-23 because
the sources carry no official inactive lists that far back.
"""

from __future__ import annotations

import logging
import sys
from contextlib import contextmanager
from pathlib import Path

import pandas as pd

EXPERIMENTS_DIR = Path(__file__).resolve().parent
ML_ROOT = EXPERIMENTS_DIR.parent
if str(ML_ROOT) not in sys.path:
    sys.path.insert(0, str(ML_ROOT))

from fnba_ml.config import (  # noqa: E402
    EWMA_HALFLIFE,
    FEATURE_COLS,
    ROLL_STATS,
    ROLL_WINDOWS,
    UNCOND_STATS,
    season_tag,
)
from fnba_ml.data.parquet_source import ParquetSource  # noqa: E402
from fnba_ml.features import build_features  # noqa: E402
from fnba_ml.universe import universe_from_status  # noqa: E402

log = logging.getLogger(__name__)

DEEP_DATA_DIR = ML_ROOT / "data" / "deep"
FEATURE_CACHE_DIR = DEEP_DATA_DIR / "features"

# pinned literally, not derived from config.FEATURE_COLS, so the feature set is
# identical across configurations even if the live config changes.
DEEP_FEATURE_COLS: list[str] = [
    "roll3_MIN", "roll5_MIN", "roll10_MIN",
    "roll3_PTS", "roll5_PTS", "roll10_PTS",
    "roll3_AST", "roll5_AST", "roll10_AST",
    "roll3_FGA", "roll5_FGA", "roll10_FGA",
    "std_MIN", "std_PTS", "std_AST", "std_FGA",
    "ewma_MIN", "ewma_PTS", "ewma_AST", "ewma_FGA",
    "n_appearances", "days_since_last_app",
    "TEAM_REST_DAYS", "IS_B2B", "IS_HOME", "OPP_DEF_FORM", "OPP_REST_DAYS",
    "insufficient_history", "has_history",
    "usg_ewma",
]
assert len(DEEP_FEATURE_COLS) == len(set(DEEP_FEATURE_COLS)) == 30

STATUS_DEPENDENT_TEAMMATE_COLS: tuple[str, ...] = (
    "vacated_minutes",
    "vacated_fga",
    "vacated_usg",
    "vacated_minutes_pos",
    "depth_rank_available",
    "depth_rank_available_pos",
    "star_out",
    "top3_usage_out_count",
    "exp_vacated_minutes",
    "exp_vacated_fga",
    "exp_vacated_usg",
    "exp_vacated_minutes_pos",
    "exp_depth_rank",
    "exp_depth_rank_pos",
    "p_star_out",
    "exp_top3_usage_out",
    "magnitude_ess",
    "teammate_magnitude_ess",
    "season_appearances",
    "games_with_current_team",
    "is_rookie",
    "is_traded",
)
DEGENERATE_ON_APPEARANCE_ONLY: tuple[str, ...] = (
    "avail_rate_10",
    "avail_rate_20",
    "avail_rate_std",
    "games_since_last_app",
) + tuple(f"uncond_std_{s}" for s in UNCOND_STATS)

EXCLUDED_FEATURE_COLS: tuple[str, ...] = (
    STATUS_DEPENDENT_TEAMMATE_COLS + DEGENERATE_ON_APPEARANCE_ONLY
)


def feature_contract_drift() -> dict[str, list[str]]:
    """how the live ``config.FEATURE_COLS`` differs from this module's pin."""
    live = set(FEATURE_COLS)
    pinned = set(DEEP_FEATURE_COLS)
    return {
        "config_only": sorted(live - pinned),
        "pinned_only": sorted(pinned - live),
    }

# not in DEEP_FEATURE_COLS: added only by the configuration testing it.
SEASON_INDEX = "SEASON_INDEX"

CONDITIONAL_TARGETS: tuple[str, ...] = ("MIN", "PTS", "AST")


def season_start_year(season: str) -> int:
    """'1996-97' -> 1996."""
    return int(season.split("-")[0])


def seasons_on_disk(data_dir: Path = DEEP_DATA_DIR) -> list[str]:
    """every season with both player and team logs present, oldest first."""
    seasons = []
    for path in sorted(data_dir.glob("player_logs_*.parquet")):
        tag = path.stem.removeprefix("player_logs_")
        if (data_dir / f"team_logs_{tag}.parquet").exists():
            seasons.append(tag.replace("_", "-"))
    return sorted(seasons, key=season_start_year)


def trailing_window(seasons: list[str], end_season: str, depth: int) -> list[str]:
    """the ``depth`` seasons ending at (and including) ``end_season``.

    a window reaching past the oldest available season is truncated, not an error.
    """
    if end_season not in seasons:
        raise ValueError(f"{end_season!r} is not in the available seasons")
    if depth < 1:
        raise ValueError(f"depth must be >= 1, got {depth}")
    end = seasons.index(end_season)
    start = max(0, end - depth + 1)
    return seasons[start:end + 1]


def season_age(seasons: list[str], end_season: str) -> dict[str, int]:
    """seasons-before-``end_season``, per season. 0 for ``end_season`` itself."""
    end = seasons.index(end_season)
    return {s: end - i for i, s in enumerate(seasons)}


@contextmanager
def ewma_halflife(halflife: float):
    """temporarily rebind the halflife the feature code reads.

    features and teammates import EWMA_HALFLIFE by value, so both namespaces must
    be rebound and restored.
    """
    import fnba_ml.features as features_module
    import fnba_ml.teammates as teammates_module

    previous = (features_module.EWMA_HALFLIFE, teammates_module.EWMA_HALFLIFE)
    features_module.EWMA_HALFLIFE = float(halflife)
    teammates_module.EWMA_HALFLIFE = float(halflife)
    try:
        yield float(halflife)
    finally:
        features_module.EWMA_HALFLIFE = previous[0]
        teammates_module.EWMA_HALFLIFE = previous[1]


def appearance_status_frame(player_logs: pd.DataFrame) -> pd.DataFrame:
    """a synthetic ``player_game_status`` in which every appearance is a row.

    LISTED_INACTIVE=False only means the row is not an absence, so the absence set
    is empty and the vacated-resource features are excluded rather than trusted.
    """
    return pd.DataFrame({
        "PLAYER_ID": player_logs["PLAYER_ID"].to_numpy(),
        "GAME_ID": player_logs["GAME_ID"].to_numpy(),
        "TEAM_ID": player_logs["TEAM_ID"].to_numpy(),
        "ROSTERED": True,
        "LISTED_INACTIVE": False,
        "STARTED": pd.NA,
        "PLAYED": True,
        "DNP_REASON": pd.NA,
        "MIN": player_logs["MIN"].to_numpy(),
    })


def build_appearance_universe(seasons: list[str],
                              data_dir: Path = DEEP_DATA_DIR) -> pd.DataFrame:
    """load the pulled parquet for ``seasons`` and assemble the universe."""
    source = ParquetSource(data_dir, seasons=seasons)
    player_logs = source.load_player_game_logs()
    team_logs = source.load_team_game_logs()
    schedule = source.load_schedule()
    status = appearance_status_frame(player_logs)
    universe = universe_from_status(schedule, team_logs, player_logs, status,
                                   positions=None)
    log.info(
        "appearance universe: %d rows, %d seasons, %d players, played rate %.4f",
        len(universe), universe["SEASON"].nunique(),
        universe["PLAYER_ID"].nunique(), float(universe["PLAYED"].mean()),
    )
    return universe


def add_season_index(frame: pd.DataFrame) -> pd.DataFrame:
    """``SEASON_INDEX``: 0 for the oldest season present, +1 per season."""
    out = frame.copy()
    order = {s: i for i, s in enumerate(sorted(out["SEASON"].unique(),
                                               key=season_start_year))}
    out[SEASON_INDEX] = out["SEASON"].map(order).astype("float64")
    return out


def _require_pinned_columns(frame: pd.DataFrame, origin: str) -> pd.DataFrame:
    """every pinned feature must be present and not entirely null.

    checked on cache hits too, since a stale parquet can disagree with the pin.
    """
    missing = [c for c in DEEP_FEATURE_COLS if c not in frame.columns]
    if missing:
        raise ValueError(f"{origin}: pinned feature columns absent: {missing}")
    empty = [c for c in DEEP_FEATURE_COLS if frame[c].isna().all()]
    if empty:
        raise ValueError(f"{origin}: pinned feature columns entirely null: {empty}")
    return frame


def cache_path(seasons: list[str], halflife: float,
               cache_dir: Path = FEATURE_CACHE_DIR) -> Path:
    return cache_dir / (
        f"deep_features_{season_tag(seasons[0])}_{season_tag(seasons[-1])}"
        f"_hl{halflife:g}.parquet"
    )


def build_deep_features(
    seasons: list[str],
    halflife: float = EWMA_HALFLIFE,
    data_dir: Path = DEEP_DATA_DIR,
    cache_dir: Path = FEATURE_CACHE_DIR,
    use_cache: bool = True,
) -> pd.DataFrame:
    """appearance-only feature frame for ``seasons`` at a given EWMA halflife.

    the cache key includes the halflife because it changes the feature values.
    """
    seasons = sorted(seasons, key=season_start_year)
    path = cache_path(seasons, halflife, cache_dir)
    if use_cache and path.exists():
        log.info("features: cache hit %s", path.name)
        return _require_pinned_columns(pd.read_parquet(path), path.name)

    universe = build_appearance_universe(seasons, data_dir)
    with ewma_halflife(halflife):
        feats = build_features(universe)
    feats = add_season_index(feats)
    feats = _require_pinned_columns(feats, "fresh build")

    path.parent.mkdir(parents=True, exist_ok=True)
    feats.to_parquet(path, index=False)
    log.info("features: %d rows x %d cols -> %s", len(feats), feats.shape[1], path.name)
    return feats


def feature_list_report(frame: pd.DataFrame) -> pd.DataFrame:
    """null rate and variance per pinned feature."""
    rows = []
    for col in DEEP_FEATURE_COLS:
        series = pd.to_numeric(frame[col], errors="coerce")
        rows.append({
            "feature": col,
            "null_rate": round(float(series.isna().mean()), 5),
            "std": round(float(series.std()), 5),
            "mean": round(float(series.mean()), 4),
        })
    return pd.DataFrame(rows)


def rolling_feature_names() -> list[str]:
    """the rolling, season-to-date and EWMA column names."""
    return (
        [f"roll{w}_{s}" for s in ROLL_STATS for w in ROLL_WINDOWS]
        + [f"std_{s}" for s in ROLL_STATS]
        + [f"ewma_{s}" for s in ROLL_STATS]
    )
