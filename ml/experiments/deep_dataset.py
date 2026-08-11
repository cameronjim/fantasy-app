"""appearance-only (conditional) datasets over configurable season ranges.

THE CAVEAT THAT GOVERNS THIS WHOLE EXPERIMENT, stated first because every number
downstream inherits it:

    THE SCHEDULED-UNIVERSE / AVAILABILITY TARGET CANNOT BE BUILT BEFORE 2022-23.

``P(plays)`` needs one row per (rostered player x team-game), including the games
the player missed. Constructing that requires official per-game inactive lists,
which this repo's sources do not reach before 2022-23. The phase-0 spike measured
what happens if you approximate roster membership from game-log presence instead
(the +/-15-day window in ``fnba_ml.universe.approximate_universe``): the
availability base rate is inflated by at least +0.0192, absence streaks longer
than ~16 team-games become structurally invisible, and the resulting model
over-predicts availability in every probability bin. Extending that approximation
over 26 more seasons would produce a depth curve for a biased target, and the
curve would be a measurement of the approximation rather than of depth.

So this ablation is **conditional only**: ``minutes | played``, ``PTS | played``,
``AST | played``. Nothing here says anything about ``P(plays)``, about
unconditional fantasy points, or about the composition. Those questions stay
pinned to the four-season truth layer.

WHAT AN APPEARANCE-ONLY UNIVERSE IS HERE. One row per recorded box-score line,
with ``PLAYED = 1`` on every row. It is fed through the real
:func:`fnba_ml.universe.universe_from_status` by synthesising a status frame in
which every appearance is rostered-and-played - so the frame that reaches
:func:`fnba_ml.features.build_features` has exactly the shape the production
pipeline produces, and the feature code runs unmodified.

THE FEATURE LIST IS THE SAME FOR EVERY CONFIGURATION, and that is load-bearing.
If deep seasons had fewer features than recent ones, "more seasons is worse"
would be indistinguishable from "older rows have missing columns". Two groups are
therefore dropped from ``config.FEATURE_COLS`` for every configuration alike:

  1. the eight status-dependent teammate features. They are computed from the
     target game's ABSENCE SET, which on an appearance-only universe is empty by
     construction - ``vacated_*`` would be a column of zeros and
     ``depth_rank_available`` would be a rank among "everyone who appeared",
     which is a different quantity from the one MODEL.md section 4.1 measures.
     ``usg_ewma`` is the exception and is KEPT: it is a career-scoped EWMA of the
     player's own box-score usage share, it needs no inactive list, and it is
     computable identically in 1996-97 and 2025-26.
  2. the availability features (``avail_rate_*``, ``games_since_last_app``) and
     the unconditional season-to-date means (``uncond_std_*``). On an
     appearance-only universe these are degenerate rather than merely
     approximate: every ``avail_rate`` is exactly 1.0, every
     ``games_since_last_app`` is exactly 0, and ``uncond_std_PTS`` becomes
     numerically identical to ``std_PTS``. Feeding a model four constant columns
     and three exact duplicates is noise, not conservatism.

That leaves 30 features, listed literally in :data:`DEEP_FEATURE_COLS`. They are
written out rather than derived from ``config.FEATURE_COLS`` - see that constant's
comment for the incident that made the difference matter.
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

# ---------------------------------------------------------------------------
# THE FEATURE CONTRACT IS PINNED HERE, LITERALLY, AND NOT DERIVED FROM
# config.FEATURE_COLS.
#
# It was derived from it, by subtraction, until ``config.FEATURE_COLS`` changed
# underneath a running sweep: a concurrent branch of work moved FEATURE_VERSION
# from v2 to v3 mid-experiment, swapping the eight realized-absence teammate
# columns for eight expected-absence ones and adding six reliability/cold-start
# columns (45 -> 51). A derived list would have made this ablation's feature set a
# function of whatever else was being edited that afternoon, which is the opposite
# of what a depth ablation needs: the whole design rests on every configuration
# using an IDENTICAL feature set, and that guarantee cannot be delegated to a file
# someone else is changing.
#
# So the 30 columns are written out. :func:`feature_contract_drift` reports what
# the live config has gained or lost relative to this pin, as information rather
# than as an error - the pin is deliberate and a drifting config is not a failure.
DEEP_FEATURE_COLS: list[str] = [
    # rolling means over appearances, career-scoped
    "roll3_MIN", "roll5_MIN", "roll10_MIN",
    "roll3_PTS", "roll5_PTS", "roll10_PTS",
    "roll3_AST", "roll5_AST", "roll10_AST",
    "roll3_FGA", "roll5_FGA", "roll10_FGA",
    # season-to-date expanding means over appearances, season-scoped
    "std_MIN", "std_PTS", "std_AST", "std_FGA",
    # EWMA of the same, career-scoped. THE HALFLIFE AXIS MOVES THESE.
    "ewma_MIN", "ewma_PTS", "ewma_AST", "ewma_FGA",
    # appearance history
    "n_appearances", "days_since_last_app",
    # schedule / opponent
    "TEAM_REST_DAYS", "IS_B2B", "IS_HOME", "OPP_DEF_FORM", "OPP_REST_DAYS",
    # missingness indicators
    "insufficient_history", "has_history",
    # the one v2 teammate-family column that needs no inactive list
    "usg_ewma",
]
assert len(DEEP_FEATURE_COLS) == len(set(DEEP_FEATURE_COLS)) == 30

# documentation of WHY each excluded column is excluded. these lists are not used
# to compute DEEP_FEATURE_COLS any more; they are what the tests assert against and
# what the report cites.
STATUS_DEPENDENT_TEAMMATE_COLS: tuple[str, ...] = (
    # v2, realized absence: needs the target game's official inactive list
    "vacated_minutes",
    "vacated_fga",
    "vacated_usg",
    "vacated_minutes_pos",
    "depth_rank_available",
    "depth_rank_available_pos",
    "star_out",
    "top3_usage_out_count",
    # v3, expected absence: needs per-teammate P(plays), which needs the scheduled
    # universe, which needs the inactive lists. Same blocker, one layer removed.
    "exp_vacated_minutes",
    "exp_vacated_fga",
    "exp_vacated_usg",
    "exp_vacated_minutes_pos",
    "exp_depth_rank",
    "exp_depth_rank_pos",
    "p_star_out",
    "exp_top3_usage_out",
    # v3 reliability/cold-start: computed on the scheduled universe (rostered
    # team-games, trade detection), not on appearances
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
    """how the live ``config.FEATURE_COLS`` differs from this module's pin.

    reported, never enforced. ``config_only`` is expected to be non-empty - it is
    every column the production feature set has that an appearance-only universe
    cannot supply. ``pinned_only`` being non-empty is the interesting case: it means
    production has DROPPED a column this ablation still uses, so the ablation's
    conclusions are about a feature set that no longer ships.
    """
    live = set(FEATURE_COLS)
    pinned = set(DEEP_FEATURE_COLS)
    return {
        "config_only": sorted(live - pinned),
        "pinned_only": sorted(pinned - live),
    }

# the era flag, for the probe in depth_sweep.py. 0 for the oldest season in the
# frame, incrementing by one per season. NOT in DEEP_FEATURE_COLS: it is added
# only by the configuration that is explicitly testing it.
SEASON_INDEX = "SEASON_INDEX"

# conditional targets. no availability target exists on this data - see the
# module docstring.
CONDITIONAL_TARGETS: tuple[str, ...] = ("MIN", "PTS", "AST")


def season_start_year(season: str) -> int:
    """'1996-97' -> 1996."""
    return int(season.split("-")[0])


def seasons_on_disk(data_dir: Path = DEEP_DATA_DIR) -> list[str]:
    """every season with BOTH sides present, oldest first.

    both sides, because a player-log season with no team logs has no schedule and
    no usage denominator, and half a season is worse than none - it would enter
    the training window looking like a real season while its rest-day, opponent
    and usage features were all null.
    """
    seasons = []
    for path in sorted(data_dir.glob("player_logs_*.parquet")):
        tag = path.stem.removeprefix("player_logs_")
        if (data_dir / f"team_logs_{tag}.parquet").exists():
            seasons.append(tag.replace("_", "-"))
    return sorted(seasons, key=season_start_year)


def trailing_window(seasons: list[str], end_season: str, depth: int) -> list[str]:
    """the ``depth`` seasons ending at (and including) ``end_season``.

    the training-depth axis. ``seasons`` must be sorted oldest-first. a window
    that would reach past the oldest available season is TRUNCATED rather than
    raising: a depth of 29 at an origin whose data only goes back 26 seasons is
    the same configuration as depth 26, and the sweep records the realised depth
    so the two are not silently conflated.
    """
    if end_season not in seasons:
        raise ValueError(f"{end_season!r} is not in the available seasons")
    if depth < 1:
        raise ValueError(f"depth must be >= 1, got {depth}")
    end = seasons.index(end_season)
    start = max(0, end - depth + 1)
    return seasons[start:end + 1]


def season_age(seasons: list[str], end_season: str) -> dict[str, int]:
    """seasons-before-``end_season``, per season. 0 for ``end_season`` itself.

    the input to the recency sample weight: ``weight = decay ** age``.
    """
    end = seasons.index(end_season)
    return {s: end - i for i, s in enumerate(seasons)}


# ---------------------------------------------------------------------------
@contextmanager
def ewma_halflife(halflife: float):
    """temporarily rebind the halflife the feature code reads.

    ``fnba_ml.features`` and ``fnba_ml.teammates`` both do
    ``from .config import EWMA_HALFLIFE``, so the constant lives in each module's
    own namespace and the only way to sweep it without editing their files is to
    rebind it there. This experiment is under instruction not to modify any
    existing ml file, and a halflife axis is not optional to the question asked -
    so the rebinding is done here, in one place, scoped to a ``with`` block, and
    restored in a ``finally``.

    it is NOT a way to change the production halflife. Nothing outside this
    module's feature builds ever enters the block.
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


# ---------------------------------------------------------------------------
def appearance_status_frame(player_logs: pd.DataFrame) -> pd.DataFrame:
    """a synthetic ``player_game_status`` in which every appearance is a row.

    this is how an appearance-only universe reaches the REAL
    :func:`fnba_ml.universe.universe_from_status` instead of the biased
    approximation fallback. Three flags and their meaning here:

      ROSTERED = True         every appearance implies roster membership
      PLAYED = True           it is an appearance
      LISTED_INACTIVE = False not "we checked the inactive list and he was
                              active" - there IS no inactive list before
                              2022-23. It states that this row is not an
                              absence, which is true by construction, and it
                              makes the absence set EMPTY. That is exactly why
                              the vacated-resource features are excluded from
                              DEEP_FEATURE_COLS rather than trusted.

    what is NOT synthesised: any row for a player who did not appear. Inventing
    those is the approximation this experiment exists to avoid.
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
    """``SEASON_INDEX``: 0 for the oldest season present, +1 per season.

    an integer era flag rather than a one-hot per season. A one-hot lets the
    model memorise which season a row came from, which is useless at prediction
    time (the target season is always the newest one and its dummy is always
    zero in training); a monotone index can at least express "the league has
    drifted in one direction", which is the hypothesis worth testing.
    """
    out = frame.copy()
    order = {s: i for i, s in enumerate(sorted(out["SEASON"].unique(),
                                               key=season_start_year))}
    out[SEASON_INDEX] = out["SEASON"].map(order).astype("float64")
    return out


def _require_pinned_columns(frame: pd.DataFrame, origin: str) -> pd.DataFrame:
    """every pinned feature must be present and not entirely null.

    checked on a CACHE HIT as well as on a fresh build. The reason is the same one
    that motivated pinning the list: ``fnba_ml.features`` is under active
    development, so a parquet written this morning and a parquet written this
    afternoon can disagree about what ``usg_ewma`` means. A missing column is fatal;
    an all-null column is fatal too, because it would enter every configuration
    identically and silently reduce the feature set to 29 without saying so.
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

    cached to parquet, keyed on (first season, last season, halflife). The
    halflife is part of the key because it changes the FEATURE VALUES - a cache
    that ignored it would silently serve halflife-5 columns for a
    halflife-12 configuration and the sweep would report a flat curve for the
    most interesting axis.
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


# ---------------------------------------------------------------------------
def feature_list_report(frame: pd.DataFrame) -> pd.DataFrame:
    """null rate and variance per feature, so a constant column cannot hide.

    the check that makes the "identical feature set" claim mean something: a
    feature present in the list but constant across the frame is not a feature,
    and one that is 100% null in the oldest seasons would confound the depth axis
    with column availability.
    """
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
    """the rolling/EWMA columns, for the report's feature-list table."""
    return (
        [f"roll{w}_{s}" for s in ROLL_STATS for w in ROLL_WINDOWS]
        + [f"std_{s}" for s in ROLL_STATS]
        + [f"ewma_{s}" for s in ROLL_STATS]
    )
