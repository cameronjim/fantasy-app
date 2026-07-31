"""single source of truth for seasons, windows, features, tiers and champions.

every other module in the package reads its constants from here. nothing else
is allowed to hard-code a window length, a halflife, a tier boundary or a
feature name.

canonical frame convention: both data sources normalise to the SCREAMING_SNAKE
NBA-style column names used by the phase-0 spike (PLAYER_ID, GAME_ID, MIN, ...)
rather than the database's snake_case. the leakage-critical feature code was
ported verbatim from the spike and renaming its columns would have meant
rewriting the exact logic the spike's tests were built to pin down.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

PACKAGE_ROOT = Path(__file__).resolve().parent
ML_ROOT = PACKAGE_ROOT.parent
MODELS_DIR = ML_ROOT / "models"
REPORTS_DIR = ML_ROOT / "reports"
DATA_DIR = ML_ROOT / "data"

# bumped whenever the feature construction changes in a way that invalidates
# previously trained artifacts. recorded in every registry entry.
FEATURE_VERSION = "v1"

# every season the truth layer holds. the spike shipped with two; the prod
# backfill (2026-08-17) covers four. extend this list when deeper history lands.
SEASONS: list[str] = ["2022-23", "2023-24", "2024-25", "2025-26"]
SEASON_TYPES: list[str] = ["Regular Season"]

# ---- feature windows ----
ROLL_WINDOWS: tuple[int, ...] = (3, 5, 10)
ROLL_STATS: tuple[str, ...] = ("MIN", "PTS", "AST", "FGA")
EWMA_HALFLIFE: float = 5.0
AVAIL_WINDOWS: tuple[int, ...] = (10, 20)
OPP_FORM_WINDOW: int = 10
OPP_FORM_MIN_PERIODS: int = 3
UNCOND_STATS: tuple[str, ...] = ("PTS", "MIN", "AST")

# fallback-universe only. never a model feature. see universe.approximate_universe
# for why any run that uses it is labeled BIASED.
FALLBACK_ROSTER_WINDOW_DAYS: int = 15

# ---- identifier handling ----
# the database stores nba ids as TEXT; the spike parquet stores them as int64.
# everything is normalised to str so that frames from either source merge.
ID_COLS: tuple[str, ...] = ("PLAYER_ID", "GAME_ID", "TEAM_ID", "OPP_TEAM_ID")

# ---- minutes tiers for segment reporting ----
# assigned from roll10_MIN, which is a strictly prior rolling mean, so the tier
# label is itself as-of safe.
TIER_BASIS = "roll10_MIN"
TIER_EDGES: tuple[float, ...] = (10.0, 20.0, 30.0)
TIER_LABELS: tuple[str, ...] = (
    "fringe (<10)",
    "bench (10-20)",
    "starter (20-30)",
    "star (>=30)",
)
UNKNOWN_TIER = "unknown (no history)"
TIER_ORDER: tuple[str, ...] = (
    "star (>=30)",
    "starter (20-30)",
    "bench (10-20)",
    "fringe (<10)",
    UNKNOWN_TIER,
)

FEATURE_COLS: list[str] = (
    [f"roll{w}_{s}" for s in ROLL_STATS for w in ROLL_WINDOWS]
    + [f"std_{s}" for s in ROLL_STATS]
    + [f"ewma_{s}" for s in ROLL_STATS]
    + [f"uncond_std_{s}" for s in UNCOND_STATS]
    + [
        "n_appearances",
        "days_since_last_app",
        "games_since_last_app",
        "avail_rate_10",
        "avail_rate_20",
        "avail_rate_std",
        "TEAM_REST_DAYS",
        "IS_B2B",
        "IS_HOME",
        "OPP_DEF_FORM",
        "OPP_REST_DAYS",
        "insufficient_history",
        "has_history",
    ]
)

# outcome columns that must never appear in FEATURE_COLS
TARGET_COLS: frozenset[str] = frozenset(
    {"PLAYED", "MIN", "PTS", "AST", "REB", "FGA", "STL", "BLK", "TOV",
     "FG3M", "FTM", "TEAM_PTS", "TEAM_PTS_ALLOWED"}
)

AVAILABILITY_TARGET = "PLAYED"
PRODUCTION_TARGETS: tuple[str, ...] = ("PTS", "AST")
MINUTES_TARGET = "MIN"

# ---- promoted path ----
# spike finding: availability is the only strongly learnable target. the
# conditional production estimate ships as EWMA(halflife 5); ridge and lightgbm
# stay implemented as challengers and are never promoted automatically.
# minutes promoted to lightgbm 2026-08-17: on the full four-season truth-layer
# dataset it beats EWMA by 2.1% MAE, consistent across all five rolling
# origins (reports/20260817.md) — past the ~2% noise line our own report set.
# production stays EWMA: ridge's ~0.8% edge is inside noise.
CHAMPIONS: dict[str, str] = {
    "availability": "lightgbm",
    "minutes": "lightgbm",
    "production": "ewma",
}
CHALLENGERS: dict[str, tuple[str, ...]] = {
    "availability": ("logistic",),
    "minutes": ("ewma", "ridge"),
    "production": ("ridge", "lightgbm"),
}

# ---- cutoff policy ----
# a prediction run may only use games that finished strictly before the run's
# own timestamp. training cutoffs follow the same rule so that a backtest and a
# live run see the same shape of history.
CUTOFF_POLICY = "prediction-run timestamp; features use games strictly before it"


def resolve_cutoff(run_at: pd.Timestamp | str | None = None) -> pd.Timestamp:
    """normalise a prediction-run timestamp into the training/feature cutoff."""
    ts = pd.Timestamp.now("UTC") if run_at is None else pd.Timestamp(run_at)
    if ts.tzinfo is not None:
        ts = ts.tz_convert("UTC").tz_localize(None)
    return ts.normalize()


# ---- rolling-origin evaluation schedule ----
# forward chaining, no random splits. train is everything strictly before the
# validation window; all of the first season is therefore always in training.
ORIGINS: list[tuple[str, str, str]] = [
    ("O1 valid=2024-12", "2024-12-01", "2024-12-31"),
    ("O2 valid=2025-01", "2025-01-01", "2025-01-31"),
    ("O3 valid=2025-02", "2025-02-01", "2025-02-28"),
    # 2025-26 origins, added once the four-season prod backfill landed. the
    # final months of 2025-26 stay untouched as the eventual test period.
    ("O4 valid=2025-12", "2025-12-01", "2025-12-31"),
    ("O5 valid=2026-01", "2026-01-01", "2026-01-31"),
]

RANDOM_STATE = 17

LGBM_PARAMS: dict[str, object] = {
    "n_estimators": 400,
    "learning_rate": 0.05,
    "num_leaves": 31,
    "min_child_samples": 50,
    "subsample": 0.8,
    "subsample_freq": 1,
    "colsample_bytree": 0.8,
    "random_state": RANDOM_STATE,
    "verbosity": -1,
    "n_jobs": -1,
}


def season_tag(season: str) -> str:
    """'2023-24' -> '2023_24', the suffix used by the parquet fixtures."""
    return season.replace("-", "_")
