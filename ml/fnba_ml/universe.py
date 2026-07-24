"""the scheduled-player-game universe.

one row per (player who could have played, team-game). this is the unit of
analysis for everything downstream: a model trained only on recorded
appearances answers "how much given he plays", which is selection-biased for
fantasy (REPORT.md section 3e measures the penalty at 12.4% MAE).

two constructions, and they are not equivalent:

  1. STATUS-BASED (preferred, unbiased). one row per rostered player per
     team-game, straight out of ``player_game_status``. a player listed
     inactive for two months is present in every one of those team-games with
     PLAYED = 0, which is exactly what the availability model needs to see.

  2. APPROXIMATION (fallback, BIASED). eligibility inferred from game-log
     presence within a +/-15 day window. only for parquet-fixture mode, where
     no roster table exists. quantified in REPORT.md section 5: availability
     base rate inflated by at least +0.0192, absence streaks capped at 16
     consecutive team-games, and a model that over-predicts availability in
     every probability bin. every code path that reaches it logs a warning and
     stamps ``UNIVERSE_SOURCE = 'approximation'`` on the output.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import FALLBACK_ROSTER_WINDOW_DAYS
from .data.schema import STAT_COLS, normalise_dates, normalise_ids

log = logging.getLogger(__name__)

SOURCE_STATUS = "status"
SOURCE_APPROXIMATION = "approximation"

UNIVERSE_COLS: tuple[str, ...] = (
    "SEASON", "GAME_ID", "GAME_DATE", "TEAM_ID", "TEAM_ABBREVIATION",
    "OPP_TEAM_ID", "IS_HOME", "TEAM_PTS", "TEAM_PTS_ALLOWED",
    "PLAYER_ID", "PLAYER_NAME", "PLAYED", "UNIVERSE_SOURCE",
) + STAT_COLS


def team_game_frame(schedule: pd.DataFrame, team_logs: pd.DataFrame) -> pd.DataFrame:
    """one row per (team, game) with opponent, home flag and points allowed.

    built from the schedule rather than from game logs so that a team-game
    exists before any box score does - the precondition for same-day
    predictions (REPORT.md section 6, implication 2).
    """
    sched = normalise_dates(normalise_ids(schedule))

    home = sched.rename(columns={"HOME_TEAM_ID": "TEAM_ID", "AWAY_TEAM_ID": "OPP_TEAM_ID"})
    home["IS_HOME"] = 1
    away = sched.rename(columns={"AWAY_TEAM_ID": "TEAM_ID", "HOME_TEAM_ID": "OPP_TEAM_ID"})
    away["IS_HOME"] = 0

    cols = ["SEASON", "GAME_ID", "GAME_DATE", "TEAM_ID", "OPP_TEAM_ID", "IS_HOME"]
    tg = pd.concat([home[cols], away[cols]], ignore_index=True)

    tl = normalise_dates(normalise_ids(team_logs))
    pts = tl[["GAME_ID", "TEAM_ID", "PTS"]].drop_duplicates(["GAME_ID", "TEAM_ID"])
    tg = tg.merge(pts.rename(columns={"PTS": "TEAM_PTS"}), on=["GAME_ID", "TEAM_ID"], how="left")
    tg = tg.merge(
        pts.rename(columns={"TEAM_ID": "OPP_TEAM_ID", "PTS": "TEAM_PTS_ALLOWED"}),
        on=["GAME_ID", "OPP_TEAM_ID"],
        how="left",
    )

    if "TEAM_ABBREVIATION" in tl.columns:
        abbr = tl[["TEAM_ID", "TEAM_ABBREVIATION"]].drop_duplicates("TEAM_ID")
        tg = tg.merge(abbr, on="TEAM_ID", how="left")
    else:
        tg["TEAM_ABBREVIATION"] = pd.NA

    return tg.sort_values(["GAME_DATE", "GAME_ID", "TEAM_ID"]).reset_index(drop=True)


def _attach_outcomes(
    eligibility: pd.DataFrame,
    team_games: pd.DataFrame,
    player_logs: pd.DataFrame,
    source: str,
) -> pd.DataFrame:
    """join schedule context and the observed box score onto eligible rows."""
    universe = eligibility.merge(
        team_games,
        on=["GAME_ID", "TEAM_ID"],
        how="left",
        suffixes=("", "_sched"),
    )

    stats = [c for c in STAT_COLS if c in player_logs.columns]
    actual = player_logs[["PLAYER_ID", "GAME_ID", "TEAM_ID", "PLAYER_NAME"] + stats].copy()
    actual = actual.drop_duplicates(["PLAYER_ID", "GAME_ID", "TEAM_ID"])
    actual["_APPEARED"] = 1

    universe = universe.merge(actual, on=["PLAYER_ID", "GAME_ID", "TEAM_ID"], how="left")

    if "PLAYED" in universe.columns:
        # status supplied a played flag; only fill the gaps from log presence
        universe["PLAYED"] = (
            universe["PLAYED"].astype("Float64").fillna(universe["_APPEARED"].astype("Float64"))
        )
    else:
        universe["PLAYED"] = universe["_APPEARED"]
    universe["PLAYED"] = universe["PLAYED"].fillna(0).astype(int)
    universe = universe.drop(columns=["_APPEARED"])

    for col in STAT_COLS:
        universe[col] = pd.to_numeric(universe.get(col), errors="coerce").fillna(0.0)

    names = player_logs.dropna(subset=["PLAYER_NAME"]).drop_duplicates("PLAYER_ID")
    universe["PLAYER_NAME"] = universe["PLAYER_NAME"].fillna(
        universe["PLAYER_ID"].map(names.set_index("PLAYER_ID")["PLAYER_NAME"])
    )

    universe["UNIVERSE_SOURCE"] = source
    universe = universe[[c for c in UNIVERSE_COLS if c in universe.columns]]
    return universe.sort_values(
        ["GAME_DATE", "GAME_ID", "TEAM_ID", "PLAYER_ID"]
    ).reset_index(drop=True)


def universe_from_status(
    schedule: pd.DataFrame,
    team_logs: pd.DataFrame,
    player_logs: pd.DataFrame,
    status: pd.DataFrame,
) -> pd.DataFrame:
    """preferred construction: rostered players per team-game, unapproximated."""
    tg = team_game_frame(schedule, team_logs)
    st = normalise_ids(status)

    rostered = st["ROSTERED"].astype("boolean").fillna(True)
    elig = st.loc[rostered, ["PLAYER_ID", "GAME_ID", "TEAM_ID", "PLAYED"]].copy()
    elig["PLAYED"] = elig["PLAYED"].astype("boolean").astype("Float64")

    # a status row for a game that is not on the schedule is a data-truth bug,
    # not something to silently model around
    known = set(zip(tg["GAME_ID"], tg["TEAM_ID"]))
    unknown = [k for k in zip(elig["GAME_ID"], elig["TEAM_ID"]) if k not in known]
    if unknown:
        log.warning("%d status rows reference team-games absent from the schedule", len(unknown))
        elig = elig[[k in known for k in zip(elig["GAME_ID"], elig["TEAM_ID"])]]

    log.info("status-based universe: %d rostered player-game rows", len(elig))
    return _attach_outcomes(elig, tg, player_logs, SOURCE_STATUS)


def approximate_universe(
    schedule: pd.DataFrame,
    team_logs: pd.DataFrame,
    player_logs: pd.DataFrame,
    window_days: int = FALLBACK_ROSTER_WINDOW_DAYS,
) -> pd.DataFrame:
    """BIASED fallback for parquet-fixture mode. do not ship predictions from it.

    a player is treated as eligible for a team-game on date ``d`` if he
    recorded at least one game log for that team within ``[d-w, d+w]``. the
    forward half of the window reconstructs roster membership only and never
    reaches a model feature.

    known distortions, measured in REPORT.md section 5:
      - long injuries vanish entirely; the longest representable absence streak
        is ``2*w/interval`` team-games (16 at w=15)
      - availability base rate biased upward by at least +0.0192
      - traded players stay eligible for their old team for up to ``w`` days
    """
    log.warning(
        "BIASED UNIVERSE: no player_game_status available, falling back to the "
        "+/-%d day game-log-presence approximation. availability is over-stated "
        "and absences longer than ~16 team-games are structurally invisible "
        "(REPORT.md section 5). fixture/backtest use only.",
        window_days,
    )

    tg = team_game_frame(schedule, team_logs)
    pl = normalise_dates(normalise_ids(player_logs))
    window = np.timedelta64(window_days, "D")

    appearances = (
        pl.groupby(["SEASON", "TEAM_ID", "PLAYER_ID"])["GAME_DATE"]
        .apply(lambda s: np.sort(s.to_numpy()))
        .reset_index(name="APP_DATES")
    )

    rows: list[pd.DataFrame] = []
    for (season, team_id), team_games in tg.groupby(["SEASON", "TEAM_ID"], sort=False):
        game_dates = team_games["GAME_DATE"].to_numpy()
        game_ids = team_games["GAME_ID"].to_numpy()
        lo = game_dates - window
        hi = game_dates + window

        roster = appearances[
            (appearances["SEASON"] == season) & (appearances["TEAM_ID"] == team_id)
        ]
        for player_id, app_dates in zip(roster["PLAYER_ID"], roster["APP_DATES"]):
            left = np.searchsorted(app_dates, lo, side="left")
            right = np.searchsorted(app_dates, hi, side="right")
            eligible = right > left
            if not eligible.any():
                continue
            rows.append(
                pd.DataFrame({
                    "TEAM_ID": team_id,
                    "PLAYER_ID": player_id,
                    "GAME_ID": game_ids[eligible],
                })
            )

    if not rows:
        raise ValueError("approximation produced no eligible player-games")
    elig = pd.concat(rows, ignore_index=True)
    log.info("approximated universe: %d eligible player-game rows", len(elig))
    return _attach_outcomes(elig, tg, player_logs, SOURCE_APPROXIMATION)


def build_universe(source) -> pd.DataFrame:
    """status-based when the source has a roster table, approximation otherwise."""
    schedule = source.load_schedule()
    team_logs = source.load_team_game_logs()
    player_logs = source.load_player_game_logs()
    status = source.load_player_game_status()

    if status is not None and len(status) > 0:
        return universe_from_status(schedule, team_logs, player_logs, status)
    return approximate_universe(schedule, team_logs, player_logs)


def coverage_report(universe: pd.DataFrame, player_logs: pd.DataFrame) -> dict[str, float]:
    """sanity numbers a caller can print or assert on."""
    played = universe[universe["PLAYED"] == 1]
    universe_keys = set(zip(played["PLAYER_ID"], played["GAME_ID"]))
    log_keys = set(zip(player_logs["PLAYER_ID"], player_logs["GAME_ID"]))
    team_games = universe.groupby(["GAME_ID", "TEAM_ID"]).ngroups
    return {
        "rows": float(len(universe)),
        "players": float(universe["PLAYER_ID"].nunique()),
        "team_games": float(team_games),
        "mean_roster": len(universe) / max(team_games, 1),
        "played_rate": float(universe["PLAYED"].mean()),
        "appearance_coverage": len(log_keys & universe_keys) / max(len(log_keys), 1),
    }
