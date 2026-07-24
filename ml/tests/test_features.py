"""leakage tests, ported from ml-spike/leakage_tests.py.

these decide whether any headline number means anything. each one independently
recomputes a feature from the RAW game logs and asserts the pipeline's value
matches - and, where it matters, asserts the leaky variant would have produced
a DIFFERENT value, so the test would actually fail if a shift were dropped.

every test here runs twice, once per universe construction (see conftest).
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from fnba_ml.config import FEATURE_COLS, TARGET_COLS
from fnba_ml.features import MIN_APPEARANCES_FOR_HISTORY

RNG = np.random.default_rng(7)

# NOTE: use drop_duplicates, NOT groupby(...).first(). GroupBy.first() returns
# the first NON-NULL value per column, which would silently paper over exactly
# the leak these tests look for. test_groupby_first_cannot_detect_the_leak below
# pins that trap so it cannot be reintroduced.
CAREER_COLS = [
    "roll3_MIN", "roll5_MIN", "roll10_MIN", "roll3_PTS", "roll5_PTS", "roll10_PTS",
    "ewma_MIN", "ewma_PTS", "n_appearances", "days_since_last_app",
    "avail_rate_10", "avail_rate_20", "games_since_last_app",
]

SEASON_SCOPED_COLS = [
    "std_MIN", "std_PTS", "std_AST", "std_FGA", "avail_rate_std", "uncond_std_PTS",
]


def _first_rows(feats: pd.DataFrame, keys: list[str]) -> pd.DataFrame:
    return feats.sort_values(["GAME_DATE", "GAME_ID"]).drop_duplicates(subset=keys, keep="first")


def _busiest_player(raw_logs: pd.DataFrame, season: str = "2024-25") -> str:
    return str(raw_logs[raw_logs["SEASON"] == season]["PLAYER_ID"].value_counts().index[0])


def _manual_rolling(logs, player_id, target_date, stat, window, season=None):
    """mean of `stat` over the last `window` appearances STRICTLY BEFORE target_date.

    season=None gives career scope (roll*/ewma*); a season string gives
    season-to-date scope (std_*). the two scopes are deliberately separate -
    mixing them is the bug the spike found and fixed.
    """
    m = (logs["PLAYER_ID"] == player_id) & (logs["GAME_DATE"] < target_date)
    if season is not None:
        m &= logs["SEASON"] == season
    prior = logs[m].sort_values("GAME_DATE")
    if prior.empty:
        return np.nan
    return prior[stat].tail(window).mean()


# ---- 1. no history on the first row ----
def test_first_ever_row_has_null_career_features(feats):
    # arrange
    first = _first_rows(feats, ["PLAYER_ID"])
    assert len(first) > 0

    # act + assert
    for col in CAREER_COLS:
        n_bad = int(first[col].notna().sum())
        assert n_bad == 0, (
            f"{col}: {n_bad} of {len(first)} first-ever rows have a non-null value "
            f"- history leaked into a player's first game"
        )


def test_first_row_of_each_season_has_null_season_to_date_features(feats):
    # arrange
    first = _first_rows(feats, ["PLAYER_ID", "SEASON"])

    # act + assert
    for col in SEASON_SCOPED_COLS:
        n_bad = int(first[col].notna().sum())
        assert n_bad == 0, (
            f"{col}: {n_bad} of {len(first)} first-of-season rows are non-null "
            f"- season-to-date state carried across the season boundary"
        )


def test_career_windows_do_carry_across_seasons(feats):
    """complement: rolling-N windows are career-scoped BY DESIGN.

    a returning player's first game of the new season SHOULD have prior form.
    asserted explicitly so the design choice cannot regress silently into the
    single-as-of-join bug.
    """
    # arrange
    first_second_season = _first_rows(feats[feats["SEASON"] == "2024-25"], ["PLAYER_ID"])

    # act
    returning = first_second_season[first_second_season["n_appearances"].notna()]

    # assert
    assert len(returning) >= 20, (
        f"only {len(returning)} players carried form into 2024-25 - the "
        f"career-scoped as-of join appears to have been restricted by season"
    )


# ---- 2. hand-recomputation ----
def test_rolling_features_match_manual_recomputation(feats, raw_logs):
    # arrange
    player_id = _busiest_player(raw_logs)
    rows = feats[
        (feats["PLAYER_ID"] == player_id)
        & (feats["SEASON"] == "2024-25")
        & (feats["n_appearances"].notna())
    ].sort_values("GAME_DATE")
    assert len(rows) >= 10, "need a decent sample to spot-check"
    sample = rows.iloc[RNG.choice(len(rows), size=min(15, len(rows)), replace=False)]

    # act + assert
    checked = 0
    for _, row in sample.iterrows():
        for stat in ("MIN", "PTS"):
            for w in (3, 5, 10):
                expected = _manual_rolling(raw_logs, player_id, row["GAME_DATE"], stat, w)
                actual = row[f"roll{w}_{stat}"]
                assert np.isclose(actual, expected, rtol=1e-9, atol=1e-9), (
                    f"player {player_id} on {row['GAME_DATE'].date()}: "
                    f"roll{w}_{stat} pipeline={actual} manual={expected}"
                )
                checked += 1
    assert checked > 0


def test_season_to_date_means_match_manual_recomputation(feats, raw_logs):
    # arrange
    player_id = _busiest_player(raw_logs)
    rows = feats[
        (feats["PLAYER_ID"] == player_id)
        & (feats["SEASON"] == "2024-25")
        & (feats["std_MIN"].notna())
    ].sort_values("GAME_DATE")
    sample = rows.iloc[RNG.choice(len(rows), size=min(12, len(rows)), replace=False)]

    # act + assert
    for _, row in sample.iterrows():
        for stat in ("MIN", "PTS"):
            expected = _manual_rolling(
                raw_logs, player_id, row["GAME_DATE"], stat, window=10_000, season="2024-25"
            )
            actual = row[f"std_{stat}"]
            assert np.isclose(actual, expected, rtol=1e-9, atol=1e-9), (
                f"player {player_id} on {row['GAME_DATE'].date()}: "
                f"std_{stat} pipeline={actual} manual={expected}"
            )


def test_rolling_would_differ_if_target_game_included(feats, raw_logs):
    """negative control - confirms the recomputation tests have teeth."""
    # arrange
    player_id = _busiest_player(raw_logs)
    rows = feats[
        (feats["PLAYER_ID"] == player_id)
        & (feats["SEASON"] == "2024-25")
        & (feats["PLAYED"] == 1)
        & (feats["n_appearances"] >= 5)
    ].sort_values("GAME_DATE")
    assert len(rows) > 0

    # act
    n_differ = 0
    for _, row in rows.iterrows():
        leaky = raw_logs[
            (raw_logs["PLAYER_ID"] == player_id)
            & (raw_logs["SEASON"] == "2024-25")
            & (raw_logs["GAME_DATE"] <= row["GAME_DATE"])  # <= leaks the target
        ].sort_values("GAME_DATE")["PTS"].tail(5).mean()
        if not np.isclose(leaky, row["roll5_PTS"], atol=1e-9):
            n_differ += 1

    # assert
    assert n_differ / len(rows) > 0.9, (
        f"only {n_differ}/{len(rows)} rows differ from the leaky version - the "
        f"as-of join may not actually be excluding the target game"
    )


# ---- 3. opponent form ----
def test_opponent_def_form_excludes_target_game(feats):
    # arrange
    sched = (
        feats[["SEASON", "TEAM_ID", "GAME_ID", "GAME_DATE", "TEAM_PTS_ALLOWED"]]
        .drop_duplicates(["SEASON", "TEAM_ID", "GAME_ID"])
        .sort_values(["TEAM_ID", "GAME_DATE"])
        .reset_index(drop=True)
    )
    candidates = feats[feats["OPP_DEF_FORM"].notna()]
    sample = candidates.iloc[RNG.choice(len(candidates), size=40, replace=False)]

    # act + assert
    n_differ_from_leaky = 0
    for _, row in sample.iterrows():
        opp_games = sched[
            (sched["SEASON"] == row["SEASON"]) & (sched["TEAM_ID"] == row["OPP_TEAM_ID"])
        ].sort_values("GAME_DATE")

        prior = opp_games[opp_games["GAME_DATE"] < row["GAME_DATE"]]
        expected = prior["TEAM_PTS_ALLOWED"].tail(10).mean()
        assert np.isclose(row["OPP_DEF_FORM"], expected, rtol=1e-9, atol=1e-9), (
            f"OPP_DEF_FORM mismatch for game {row['GAME_ID']} vs team "
            f"{row['OPP_TEAM_ID']}: pipeline={row['OPP_DEF_FORM']} manual={expected}"
        )

        inclusive = opp_games[
            opp_games["GAME_DATE"] <= row["GAME_DATE"]
        ]["TEAM_PTS_ALLOWED"].tail(10).mean()
        if not np.isclose(inclusive, row["OPP_DEF_FORM"], atol=1e-9):
            n_differ_from_leaky += 1

    assert n_differ_from_leaky / len(sample) > 0.9, (
        "opponent form is suspiciously close to the leaky version"
    )


# ---- 4. availability rate ----
def test_avail_rate_excludes_own_outcome(feats):
    """avail_rate_10 = mean(PLAYED) over the player's previous 10 SCHEDULED rows."""
    # arrange
    player_id = str(feats["PLAYER_ID"].value_counts().index[3])
    rows = (
        feats[feats["PLAYER_ID"] == player_id]
        .sort_values(["GAME_DATE", "GAME_ID"])
        .reset_index(drop=True)
    )
    played = rows["PLAYED"].to_numpy()

    # act + assert
    for i in range(1, len(rows)):
        expected = played[max(0, i - 10):i].mean()
        actual = rows.loc[i, "avail_rate_10"]
        assert np.isclose(actual, expected, atol=1e-9), (
            f"avail_rate_10 mismatch at row {i} for player {player_id}: "
            f"pipeline={actual} manual={expected}"
        )


# ---- 5. structural invariants ----
def test_last_appearance_strictly_precedes_target(feats):
    # act
    have = feats[feats["LAST_APP_DATE"].notna()]

    # assert
    bad = int((have["LAST_APP_DATE"] >= have["GAME_DATE"]).sum())
    assert bad == 0, f"{bad} rows matched an appearance on/after the target date"


def test_days_since_last_app_positive(feats):
    # act + assert
    have = feats[feats["days_since_last_app"].notna()]
    assert (have["days_since_last_app"] >= 1).all(), \
        "days_since_last_app must be >= 1 (strictly prior appearance)"


def test_no_target_columns_in_feature_list():
    # act + assert
    overlap = TARGET_COLS & set(FEATURE_COLS)
    assert not overlap, f"target/outcome columns leaked into FEATURE_COLS: {overlap}"


def test_universe_covers_every_real_appearance(feats, raw_logs):
    # arrange
    played = feats[feats["PLAYED"] == 1]

    # act
    universe_keys = set(zip(played["PLAYER_ID"], played["GAME_ID"]))
    log_keys = set(zip(raw_logs["PLAYER_ID"], raw_logs["GAME_ID"]))

    # assert
    missing = log_keys - universe_keys
    assert not missing, f"{len(missing)} real appearances missing from the universe"


# ---- 6. the groupby().first() trap ----
def test_groupby_first_cannot_detect_the_leak():
    """regression test for the trap that made the spike's own tests useless.

    ``GroupBy.first()`` skips nulls, so it reports a later row's value for a
    first row that should be null - exactly hiding the leak. the tests above
    must use ``drop_duplicates(keep='first')``, which does not.
    """
    # arrange - a player whose FIRST row is correctly null and whose second is not
    frame = pd.DataFrame({
        "PLAYER_ID": ["p1", "p1", "p1"],
        "GAME_DATE": pd.to_datetime(["2024-01-01", "2024-01-03", "2024-01-05"]),
        "GAME_ID": ["g1", "g2", "g3"],
        "roll5_PTS": [np.nan, 10.0, 12.0],
    })

    # act
    via_groupby = frame.sort_values(["GAME_DATE", "GAME_ID"]).groupby("PLAYER_ID").first()
    via_drop_dup = _first_rows(frame, ["PLAYER_ID"])

    # assert
    assert via_groupby["roll5_PTS"].notna().all(), (
        "groupby().first() is expected to skip the null - if this ever changes, "
        "the warning in this module can be relaxed"
    )
    assert via_drop_dup["roll5_PTS"].isna().all(), (
        "drop_duplicates(keep='first') must preserve the null so a leak is visible"
    )


# ---- 7. missingness indicator ----
def test_insufficient_history_flag_matches_appearance_count(feats):
    # act
    flagged = feats["insufficient_history"] == 1
    enough = feats["n_appearances"] >= MIN_APPEARANCES_FOR_HISTORY

    # assert
    assert not (flagged & enough & feats["roll5_MIN"].notna()).any(), (
        "rows with enough appearances and a rolling mean must not be flagged as "
        "insufficient history"
    )
    assert flagged[feats["n_appearances"].isna()].all(), (
        "every row with no appearance history must be flagged"
    )


@pytest.mark.parametrize("column", ["IS_HOME", "TEAM_REST_DAYS", "OPP_DEF_FORM"])
def test_schedule_features_present(feats, column):
    # act + assert
    assert column in feats.columns
    assert feats[column].notna().mean() > 0.5, f"{column} is mostly null"
