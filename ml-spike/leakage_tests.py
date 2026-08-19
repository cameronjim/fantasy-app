"""
Phase 0 spike: leakage tests.

These are the tests that decide whether any of the headline numbers mean
anything. Each one independently recomputes a feature from the RAW game logs
and asserts the pipeline's value matches - and, where it matters, asserts that
the leaky version would have produced a DIFFERENT value (so the test would
actually fail if the shift were dropped).

Run:  python -m pytest leakage_tests.py -v
 or:  python leakage_tests.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

DATA_DIR = Path(__file__).resolve().parent / "data"
SEASONS = ["2023-24", "2024-25"]
RNG = np.random.default_rng(7)


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------
@pytest.fixture(scope="module")
def feats() -> pd.DataFrame:
    df = pd.read_parquet(DATA_DIR / "features.parquet")
    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"])
    return df


@pytest.fixture(scope="module")
def raw_logs() -> pd.DataFrame:
    frames = []
    for season in SEASONS:
        tag = season.replace("-", "_")
        p = pd.read_parquet(DATA_DIR / f"player_logs_{tag}.parquet")
        p = p[["PLAYER_ID", "TEAM_ID", "GAME_ID", "GAME_DATE",
               "MIN", "PTS", "AST", "FGA"]].copy()
        p["SEASON"] = season
        frames.append(p)
    logs = pd.concat(frames, ignore_index=True)
    logs["GAME_DATE"] = pd.to_datetime(logs["GAME_DATE"]).dt.normalize()
    logs["PLAYER_ID"] = logs["PLAYER_ID"].astype("int64")
    return logs.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)


# --------------------------------------------------------------------------
# TEST 1 - first row of a player-season has no history
# --------------------------------------------------------------------------
# NOTE: use drop_duplicates, NOT groupby(...).first(). GroupBy.first() returns
# the first NON-NULL value per column, which would silently paper over exactly
# the leak these tests are looking for.
CAREER_COLS = ["roll3_MIN", "roll5_MIN", "roll10_MIN", "roll3_PTS",
               "roll5_PTS", "roll10_PTS", "ewma_MIN", "ewma_PTS",
               "n_appearances", "days_since_last_app", "avail_rate_10",
               "avail_rate_20", "games_since_last_app"]

SEASON_SCOPED_COLS = ["std_MIN", "std_PTS", "std_AST", "std_FGA",
                      "avail_rate_std", "uncond_std_PTS"]


def _first_rows(feats: pd.DataFrame, keys: list[str]) -> pd.DataFrame:
    return (
        feats.sort_values(["GAME_DATE", "GAME_ID"])
        .drop_duplicates(subset=keys, keep="first")
    )


def test_first_ever_row_has_null_career_features(feats):
    """A player's first EVER scheduled row cannot have any history."""
    first = _first_rows(feats, ["PLAYER_ID"])
    assert len(first) > 0

    for col in CAREER_COLS:
        n_bad = first[col].notna().sum()
        assert n_bad == 0, (
            f"{col}: {n_bad} of {len(first)} first-ever rows have a non-null "
            f"value - history leaked into a player's first game"
        )


def test_first_row_of_each_season_has_null_season_to_date_features(feats):
    """Season-to-date means must reset at the season boundary."""
    first = _first_rows(feats, ["PLAYER_ID", "SEASON"])
    for col in SEASON_SCOPED_COLS:
        n_bad = first[col].notna().sum()
        assert n_bad == 0, (
            f"{col}: {n_bad} of {len(first)} first-of-season rows are non-null "
            f"- season-to-date state carried across the season boundary"
        )


def test_career_windows_do_carry_across_seasons(feats):
    """
    Complement of the previous test: rolling-N windows are career-scoped BY
    DESIGN, so a returning player's first game of 2024-25 SHOULD have prior
    form. Asserted explicitly so the design choice cannot regress silently.
    """
    first_2425 = _first_rows(feats[feats["SEASON"] == "2024-25"], ["PLAYER_ID"])
    returning = first_2425[first_2425["n_appearances"].notna()]
    assert len(returning) > 100, (
        f"only {len(returning)} players carried form into 2024-25 - the "
        f"career-scoped as-of join appears to have been restricted by season"
    )


# --------------------------------------------------------------------------
# TEST 2 - spot-check: recompute rolling means by hand from raw logs
# --------------------------------------------------------------------------
def _manual_rolling(logs, player_id, target_date, stat, window, season=None):
    """
    Mean of `stat` over the player's last `window` appearances STRICTLY BEFORE
    target_date. Pass season=None for career scope (roll*/ewma*), or a season
    string for season-to-date scope (std_*).
    """
    m = (logs["PLAYER_ID"] == player_id) & (logs["GAME_DATE"] < target_date)
    if season is not None:
        m &= logs["SEASON"] == season
    prior = logs[m].sort_values("GAME_DATE")
    if prior.empty:
        return np.nan
    return prior[stat].tail(window).mean()


def test_rolling_features_match_manual_recomputation(feats, raw_logs):
    """
    Spot-check a heavy-minutes player: recompute roll3/roll5/roll10 for MIN and
    PTS by hand from the raw logs, using ONLY games strictly before the target.
    Rolling-N windows are career-scoped, so the manual version is too.
    """
    counts = raw_logs[raw_logs["SEASON"] == "2024-25"]["PLAYER_ID"].value_counts()
    player_id = int(counts.index[0])

    rows = feats[
        (feats["PLAYER_ID"] == player_id)
        & (feats["SEASON"] == "2024-25")
        & (feats["n_appearances"].notna())
    ].sort_values("GAME_DATE")
    assert len(rows) >= 20, "need a decent sample to spot-check"

    sample = rows.iloc[RNG.choice(len(rows), size=min(40, len(rows)), replace=False)]

    checked = 0
    for _, row in sample.iterrows():
        for stat in ["MIN", "PTS"]:
            for w in [3, 5, 10]:
                expected = _manual_rolling(
                    raw_logs, player_id, row["GAME_DATE"], stat, w
                )
                actual = row[f"roll{w}_{stat}"]
                assert np.isclose(actual, expected, rtol=1e-9, atol=1e-9), (
                    f"player {player_id} on {row['GAME_DATE'].date()}: "
                    f"roll{w}_{stat} pipeline={actual} manual={expected}"
                )
                checked += 1
    assert checked > 0


def test_season_to_date_means_match_manual_recomputation(feats, raw_logs):
    """
    std_* must be the mean over ALL of the player's prior appearances IN THAT
    SEASON only - the complementary scope to the rolling windows above.
    """
    counts = raw_logs[raw_logs["SEASON"] == "2024-25"]["PLAYER_ID"].value_counts()
    player_id = int(counts.index[0])

    rows = feats[
        (feats["PLAYER_ID"] == player_id)
        & (feats["SEASON"] == "2024-25")
        & (feats["std_MIN"].notna())
    ].sort_values("GAME_DATE")
    sample = rows.iloc[RNG.choice(len(rows), size=min(30, len(rows)), replace=False)]

    for _, row in sample.iterrows():
        for stat in ["MIN", "PTS"]:
            expected = _manual_rolling(
                raw_logs, player_id, row["GAME_DATE"], stat,
                window=10_000, season="2024-25",
            )
            actual = row[f"std_{stat}"]
            assert np.isclose(actual, expected, rtol=1e-9, atol=1e-9), (
                f"player {player_id} on {row['GAME_DATE'].date()}: "
                f"std_{stat} pipeline={actual} manual={expected}"
            )


def test_rolling_would_differ_if_target_game_included(feats, raw_logs):
    """
    Negative control. If the target game's own log were included in the rolling
    window, the value would change for most rows. Confirms test 2 has teeth.
    """
    counts = raw_logs[raw_logs["SEASON"] == "2024-25"]["PLAYER_ID"].value_counts()
    player_id = int(counts.index[0])

    rows = feats[
        (feats["PLAYER_ID"] == player_id)
        & (feats["SEASON"] == "2024-25")
        & (feats["PLAYED"] == 1)
        & (feats["n_appearances"] >= 5)
    ].sort_values("GAME_DATE")

    n_differ = 0
    n_total = 0
    for _, row in rows.iterrows():
        leaky = raw_logs[
            (raw_logs["PLAYER_ID"] == player_id)
            & (raw_logs["SEASON"] == "2024-25")
            & (raw_logs["GAME_DATE"] <= row["GAME_DATE"])   # <= leaks the target
        ].sort_values("GAME_DATE")["PTS"].tail(5).mean()
        n_total += 1
        if not np.isclose(leaky, row["roll5_PTS"], atol=1e-9):
            n_differ += 1

    assert n_total > 0
    assert n_differ / n_total > 0.9, (
        f"only {n_differ}/{n_total} rows differ from the leaky version - the "
        f"as-of join may not actually be excluding the target game"
    )


# --------------------------------------------------------------------------
# TEST 3 - opponent defensive form excludes the target game
# --------------------------------------------------------------------------
def test_opponent_def_form_excludes_target_game(feats):
    """
    OPP_DEF_FORM must be the opponent's mean points allowed over its previous
    10 games, NOT including the game being predicted.
    """
    sched = (
        feats[["SEASON", "TEAM_ID", "GAME_ID", "GAME_DATE", "TEAM_PTS_ALLOWED"]]
        .drop_duplicates(["SEASON", "TEAM_ID", "GAME_ID"])
        .sort_values(["TEAM_ID", "GAME_DATE"])
        .reset_index(drop=True)
    )

    candidates = feats[feats["OPP_DEF_FORM"].notna()]
    sample = candidates.iloc[
        RNG.choice(len(candidates), size=60, replace=False)
    ]

    n_differ_from_leaky = 0
    for _, row in sample.iterrows():
        opp_games = sched[
            (sched["SEASON"] == row["SEASON"])
            & (sched["TEAM_ID"] == row["OPP_TEAM_ID"])
        ].sort_values("GAME_DATE")

        prior = opp_games[opp_games["GAME_DATE"] < row["GAME_DATE"]]
        expected = prior["TEAM_PTS_ALLOWED"].tail(10).mean()

        assert np.isclose(row["OPP_DEF_FORM"], expected, rtol=1e-9, atol=1e-9), (
            f"OPP_DEF_FORM mismatch for game {row['GAME_ID']} vs team "
            f"{row['OPP_TEAM_ID']}: pipeline={row['OPP_DEF_FORM']} "
            f"manual={expected}"
        )

        inclusive = opp_games[
            opp_games["GAME_DATE"] <= row["GAME_DATE"]
        ]["TEAM_PTS_ALLOWED"].tail(10).mean()
        if not np.isclose(inclusive, row["OPP_DEF_FORM"], atol=1e-9):
            n_differ_from_leaky += 1

    assert n_differ_from_leaky / len(sample) > 0.9, (
        "opponent form is suspiciously close to the leaky version"
    )


# --------------------------------------------------------------------------
# TEST 4 - availability rate excludes the row's own outcome
# --------------------------------------------------------------------------
def test_avail_rate_excludes_own_outcome(feats):
    """avail_rate_10 = mean(PLAYED) over the player's previous 10 SCHEDULED rows."""
    counts = feats["PLAYER_ID"].value_counts()
    player_id = int(counts.index[3])

    rows = feats[feats["PLAYER_ID"] == player_id].sort_values(
        ["GAME_DATE", "GAME_ID"]
    ).reset_index(drop=True)

    played = rows["PLAYED"].to_numpy()
    for i in range(1, len(rows)):
        expected = played[max(0, i - 10):i].mean()
        actual = rows.loc[i, "avail_rate_10"]
        assert np.isclose(actual, expected, atol=1e-9), (
            f"avail_rate_10 mismatch at row {i} for player {player_id}: "
            f"pipeline={actual} manual={expected}"
        )


# --------------------------------------------------------------------------
# TEST 5 - structural invariants
# --------------------------------------------------------------------------
def test_last_appearance_strictly_precedes_target(feats):
    """The as-of join must never match an appearance on or after the target."""
    have = feats[feats["LAST_APP_DATE"].notna()]
    bad = (have["LAST_APP_DATE"] >= have["GAME_DATE"]).sum()
    assert bad == 0, f"{bad} rows matched an appearance on/after the target date"


def test_days_since_last_app_positive(feats):
    have = feats[feats["days_since_last_app"].notna()]
    assert (have["days_since_last_app"] >= 1).all(), \
        "days_since_last_app must be >= 1 (strictly prior appearance)"


def test_no_target_columns_in_feature_list():
    """The feature list must not contain the targets themselves."""
    from features import FEATURE_COLS
    forbidden = {"PLAYED", "MIN", "PTS", "AST", "FGA", "TEAM_PTS",
                 "TEAM_PTS_ALLOWED"}
    overlap = forbidden & set(FEATURE_COLS)
    assert not overlap, f"target/outcome columns leaked into FEATURE_COLS: {overlap}"


def test_universe_covers_every_real_appearance(feats, raw_logs):
    """Sanity: every actual game log must appear as a PLAYED=1 universe row."""
    universe_keys = set(
        zip(feats.loc[feats["PLAYED"] == 1, "PLAYER_ID"],
            feats.loc[feats["PLAYED"] == 1, "GAME_ID"])
    )
    log_keys = set(zip(raw_logs["PLAYER_ID"], raw_logs["GAME_ID"]))
    missing = log_keys - universe_keys
    assert not missing, f"{len(missing)} real appearances missing from the universe"


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))
