"""P2: matchup, blowout and season-stakes features (the v4 CANDIDATE family).

WHAT THIS MODULE IS FOR. feature_version v3 describes the PLAYER (rolling form,
availability history, per-minute rates) and, through :mod:`fnba_ml.teammates`, his
ROSTER (who is likely to be out and what they were worth). It says almost nothing
about the GAME. Three facts about a game move minutes hard and none of them are in
the v3 contract:

  * **how many possessions there will be.** A 118-pace team hosting a 118-pace team
    plays ~8% more possessions than the slowest pairing in the league, and minutes
    are the denominator every production rate is multiplied by.
  * **whether it will still be a contest in the fourth quarter.** A 25-point margin
    costs a starter ten minutes and hands them to the twelfth man. The sign of that
    effect flips with the player's role, which is why this module ships an
    interaction and not only a probability.
  * **whether either team still has anything to win.** A high-minute veteran on a
    team fourteen games under .500 in April is a rest candidate, and the v3
    availability model rates him at 0.9 because his last twenty games say so.

NONE OF THIS IS SERVED. ``config.FEATURE_COLS`` is unchanged, ``FEATURE_VERSION``
is still ``v3``, and the frozen artifact ``models/20260818`` is untouched. The
columns below populate ``config.FEATURE_SETS["v4"]``, which exists to be measured
against ``v3-honest`` over identical rows. See ``config``'s P2 block for the
promotion rule and MODEL.md section 15 for the result.

THE AS-OF CONTRACT, which is the whole of the difficulty. Every column this module
produces is a function of games strictly before the target game, enforced by
exactly one mechanism: an explicit ``.shift(1)`` before every ``.rolling()`` /
``.expanding()`` / ``.cumsum()``, on a frame sorted by date within its group. There
is no ``merge_asof`` here, because every quantity is computed on a frame whose row
grain (team-game, or scheduled player-game) already matches the target - so the
shift is available directly and is easier to verify than a join direction.

THE THREE OUTCOME COLUMNS this module puts on the frame, named so they cannot be
mistaken for features and declared in ``config.TARGET_COLS``:

  ``team_margin``   the target game's final margin, signed. The blowout label's
                    source and nothing else.
  ``blowout``       ``1(|team_margin| >= config.BLOWOUT_MARGIN)``. The classifier's
                    TRAINING TARGET. Both team-games of a game carry the same value.
  ``team_won``      used only to build the as-of win/loss record; the record itself
                    is shifted, this column is not.

``blowout_prob`` is the model's out-of-fold estimate of ``blowout`` and IS a
feature. Distinguishing the two is the point of the negative control in
``tests/test_matchup_v4.py``: a "peeked" classifier fitted on rows including their
own outcome scores conspicuously better, and a test that could not tell the two
apart would pass against a leak.

THE V2 -> V3 LESSON, APPLIED (MODEL.md section 11). The v2 defect was a feature that
conditioned on other players' target-game labels. The same trap is live here in two
places and both are closed the same way:

  1. **The opponent aggregates.** ``opp_pace`` is the OPPONENT's rolling pace, and
     the opponent's box score for the target game is sitting right there in the same
     frame. Every team-level rate is shifted within ``(TEAM_ID, SEASON)`` BEFORE the
     own/opponent merge, so the merged column is a function of the opponent's prior
     games only. ``tests/test_matchup_v4.py`` pins this by flipping a target game's
     box score and requiring no feature to move.
  2. **The blowout probability.** A classifier fitted on the whole history and used
     to score that same history would encode each row's own label. It is cross-fitted
     over consecutive calendar-month blocks, the identical scheme
     :func:`fnba_ml.models.cross_fit_base_probabilities` uses for ``p_j``, and every
     probability carries its block start as a cutoff that
     :func:`fnba_ml.models.validate_out_of_fold` checks.

WHAT IS DELIBERATELY NOT HERE. Team-level lineup or injury information beyond what
the player frame already carries; true playoff-seed math (see
``config.STAKES_LOCKED_RATIO`` for why the lockedness proxy is used instead); and
any use of ``started``, which the truth layer does not populate (see
``config.START_RATE_WINDOW``).
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import (
    BLOWOUT_CROSS_FIT_MIN_TRAIN_ROWS,
    BLOWOUT_MODEL_KIND,
    BLOWOUT_MODEL_CHALLENGERS,
    BLOWOUT_SELECTION_CUTOFF,
    BLOWOUT_SELECTION_TRAIN_SHARE,
    BLOWOUT_MARGIN,
    BLOWOUT_MARGIN_COL,
    BLOWOUT_MODEL_FEATURES,
    BLOWOUT_PRIOR,
    BLOWOUT_PROB,
    BLOWOUT_PROB_CUTOFF,
    BLOWOUT_TARGET,
    CROSS_FIT_FREQ,
    FT_POSSESSION_WEIGHT,
    LATE_SEASON_GAMES_REMAINING,
    PACE_MIN_PERIODS,
    PACE_WINDOW,
    REGULAR_SEASON_GAMES,
    START_RATE_TOP_N,
    START_RATE_WINDOW,
    STAKES_LOCKED_RATIO,
)

log = logging.getLogger(__name__)

# the key every team-level frame in this module is grained on. SEASON is in the key
# and not merely along for the ride: a (GAME_ID, TEAM_ID) pair is unique on its own,
# but carrying SEASON makes the merges in :func:`attach_matchup_features` fail loudly
# if a caller hands over a frame whose SEASON disagrees with the schedule's.
TEAM_GAME_KEY: tuple[str, ...] = ("SEASON", "TEAM_ID", "GAME_ID")

# the rolling team rates, under an internal prefix. They are computed ONCE per
# team-game and then attached twice - as the row's own team and as its opponent -
# so a single definition serves both sides and "own pace" and "opponent pace" can
# never end up being two different formulas.
CTX_PREFIX = "tmctx_"
CTX_PACE = f"{CTX_PREFIX}pace"
CTX_OFF_RATING = f"{CTX_PREFIX}off_rating"
CTX_DEF_RATING = f"{CTX_PREFIX}def_rating"
CTX_NET_RATING = f"{CTX_PREFIX}net_rating"
CTX_FG3A_ALLOWED = f"{CTX_PREFIX}fg3a_allowed_per100"
CTX_FTA_ALLOWED = f"{CTX_PREFIX}fta_allowed_per100"
CTX_SLOT_MINUTES = f"{CTX_PREFIX}slot_minutes"
CTX_REST_DAYS = f"{CTX_PREFIX}rest_days"
CTX_IS_B2B = f"{CTX_PREFIX}is_b2b"

ROLLING_CTX_COLS: tuple[str, ...] = (
    CTX_PACE,
    CTX_OFF_RATING,
    CTX_DEF_RATING,
    CTX_FG3A_ALLOWED,
    CTX_FTA_ALLOWED,
    CTX_SLOT_MINUTES,
)

# the season-to-date stakes columns, own team only. An opponent's standing position
# does not decide whether MY coach rests MY starters.
STAKES_CTX_COLS: tuple[str, ...] = (
    "team_games_played",
    "team_games_remaining",
    "team_win_pct",
    "team_games_over_500",
    "late_season",
    "stakes_late_x_over500",
    "stakes_lockedness",
)

# the outcome columns. see the module docstring.
OUTCOME_COLS: tuple[str, ...] = (BLOWOUT_MARGIN_COL, BLOWOUT_TARGET, "team_won")

START_RATE_COL = "top5_min_share_10"


# ---------------------------------------------------------------------------
# 1. the team-game frame: pair each team with its opponent
# ---------------------------------------------------------------------------
def _pair_team_games(team_logs: pd.DataFrame) -> pd.DataFrame:
    """one row per (team, game) carrying BOTH sides' box-score totals.

    a self-join on ``GAME_ID`` rather than a read of ``opponent_team_id``, because
    the canonical team-log contract (``data.schema.TEAM_LOG_COLS``) does not carry an
    opponent column and the parquet source only has ``MATCHUP``. Pairing within the
    game is exact for both sources and needs no new column on either.

    games without exactly two team-log rows are DROPPED with a warning. A one-sided
    game cannot produce a margin, a points-allowed figure or an opponent pace, and
    imputing any of the three would be inventing the opponent.
    """
    required = {"TEAM_ID", "GAME_ID", "SEASON", "GAME_DATE", "PTS", "MIN", "FGA",
                "FTA", "TOV"}
    missing = sorted(required - set(team_logs.columns))
    if missing:
        raise ValueError(
            f"the team log frame is missing columns the matchup features need: "
            f"{missing}"
        )

    optional = [c for c in ("FG3A",) if c in team_logs.columns]
    if not optional:
        log.warning(
            "team logs carry no FG3A; %s will be null on every row. the column is "
            "optional on purpose - the spike's parquet exports predate it - and a "
            "null column is routed as missing by LightGBM rather than being wrong",
            CTX_FG3A_ALLOWED,
        )

    cols = ["SEASON", "GAME_ID", "GAME_DATE", "TEAM_ID", "PTS", "MIN", "FGA", "FTA",
            "TOV", *optional]
    own = team_logs[cols].drop_duplicates(["GAME_ID", "TEAM_ID"]).copy()
    own["GAME_DATE"] = pd.to_datetime(own["GAME_DATE"])
    for col in ("PTS", "MIN", "FGA", "FTA", "TOV", *optional):
        own[col] = pd.to_numeric(own[col], errors="coerce").astype(float)

    sides = own.groupby("GAME_ID")["TEAM_ID"].transform("size")
    incomplete = int((sides != 2).sum())
    if incomplete:
        log.warning(
            "%d team-log rows belong to games without exactly two sides and are "
            "DROPPED from the matchup context; a one-sided game has no opponent to "
            "compute a pace or a margin against",
            incomplete,
        )
        own = own[sides == 2].copy()

    opponent = own[["GAME_ID", "TEAM_ID", "PTS", "FGA", "FTA", "TOV", *optional]].rename(
        columns={
            "TEAM_ID": "OPP_TEAM_ID",
            "PTS": "OPP_PTS",
            "FGA": "OPP_FGA",
            "FTA": "OPP_FTA",
            "TOV": "OPP_TOV",
            **{c: f"OPP_{c}" for c in optional},
        }
    )
    paired = own.merge(opponent, on="GAME_ID", how="inner")
    paired = paired[paired["TEAM_ID"] != paired["OPP_TEAM_ID"]].reset_index(drop=True)
    if len(paired) != len(own):
        raise ValueError(
            f"pairing team-games changed the row count ({len(own)} -> {len(paired)}); "
            f"a GAME_ID with two identical TEAM_IDs is a truth-layer bug"
        )
    return paired


def _per_game_rates(paired: pd.DataFrame) -> pd.DataFrame:
    """the target game's own possession arithmetic. ALL OF IT IS AN OUTCOME.

    nothing this function computes may be used as a feature: every quantity reads
    the target game's box score. They exist to be SHIFTED and rolled by
    :func:`team_game_context`, which is where the as-of discipline lives.

    the possession estimate is the OREB-free fallback ``FGA + 0.44*FTA + TOV``; see
    ``config.POSSESSION_USES_OREB`` for what that costs and why the truth layer
    leaves no choice.
    """
    out = paired.copy()
    w = FT_POSSESSION_WEIGHT

    out["_poss"] = out["FGA"] + w * out["FTA"] + out["TOV"]
    out["_opp_poss"] = out["OPP_FGA"] + w * out["OPP_FTA"] + out["OPP_TOV"]

    # tgl.minutes is the team's TOTAL minutes for the game - 240 in regulation, more
    # after overtime - so a lineup SLOT's minutes are minutes/5. Using it rather
    # than a hard-coded 48 is what makes pace and minutes_share correct in overtime
    # games, which are ~6% of the schedule and are exactly the games where a
    # rotation player's minutes are unusual.
    out["_slot_minutes"] = out["MIN"] / 5.0

    with np.errstate(invalid="ignore", divide="ignore"):
        # possessions per 48 minutes of game clock: the standard pace unit, so the
        # number is comparable to a published pace figure up to the OREB offset.
        out["_pace"] = out["_poss"] / out["_slot_minutes"] * 48.0
        # points per 100 possessions. The DEFENSIVE rating's denominator is the
        # OPPONENT's possessions, not the team's - they differ by a possession or
        # two and using the wrong one is the classic sign error here.
        out["_off_rating"] = out["_poss"].rdiv(out["PTS"]) * 100.0
        out["_def_rating"] = out["OPP_PTS"] / out["_opp_poss"] * 100.0
        # STYLE: what the opponents of this team do, per 100 of their possessions.
        # "weak against threes" is a statement about how many threes get taken
        # against you, normalised so it is not just "you play fast".
        if "OPP_FG3A" in out.columns:
            out["_fg3a_allowed_per100"] = out["OPP_FG3A"] / out["_opp_poss"] * 100.0
        else:
            out["_fg3a_allowed_per100"] = np.nan
        out["_fta_allowed_per100"] = out["OPP_FTA"] / out["_opp_poss"] * 100.0

    out[BLOWOUT_MARGIN_COL] = out["PTS"] - out["OPP_PTS"]
    out["team_won"] = (out[BLOWOUT_MARGIN_COL] > 0).astype(float)
    out[BLOWOUT_TARGET] = (
        out[BLOWOUT_MARGIN_COL].abs() >= BLOWOUT_MARGIN
    ).astype(float)
    return out


_RAW_TO_CTX: dict[str, str] = {
    "_pace": CTX_PACE,
    "_off_rating": CTX_OFF_RATING,
    "_def_rating": CTX_DEF_RATING,
    "_fg3a_allowed_per100": CTX_FG3A_ALLOWED,
    "_fta_allowed_per100": CTX_FTA_ALLOWED,
    "_slot_minutes": CTX_SLOT_MINUTES,
}


def team_game_context(
    team_logs: pd.DataFrame,
    home_flags: pd.DataFrame | None = None,
    window: int = PACE_WINDOW,
    min_periods: int = PACE_MIN_PERIODS,
) -> pd.DataFrame:
    """one row per (season, team, game): as-of pace, ratings, style and stakes.

    THE ONE FUNCTION THE AS-OF CLAIM RESTS ON. Every rolling column is produced by

        group.shift(1).rolling(window, min_periods).mean()

    within ``(TEAM_ID, SEASON)``, sorted by date. The ``shift(1)`` is what stops the
    target game's own box score reaching the row, and it happens BEFORE the own /
    opponent merge in :func:`attach_matchup_features`, so an opponent column is a
    function of the opponent's PRIOR games and never of the game being predicted.

    SEASON-SCOPED, not career-scoped, and unlike the player rolling windows that is
    the right scope here: a team is a different object across an offseason in a way a
    player's per-minute scoring rate is not. Rosters turn over, coaches change, and
    a 2024-25 pace tells you very little about the same franchise in 2025-26. The
    consequence is stated rather than hidden: the first ``min_periods`` team-games of
    every season carry null rates, ~5.5% of team-games, and LightGBM routes them as
    missing.

    ``home_flags`` is an optional ``(GAME_ID, TEAM_ID, IS_HOME)`` frame. The
    canonical team-log contract carries no home flag, and the blowout model wants
    one; passing it separately keeps this function's input contract equal to
    ``data.schema.TEAM_LOG_COLS`` plus the optional FG3A. Absent, ``bo_is_home`` is
    null.

    the returned frame carries the outcome columns of :data:`OUTCOME_COLS` as well
    as the features. They are the blowout classifier's training target and the
    descriptive cohorts' ground truth; they are named unambiguously and listed in
    ``config.TARGET_COLS``.
    """
    paired = _per_game_rates(_pair_team_games(team_logs))
    paired = paired.sort_values(["TEAM_ID", "SEASON", "GAME_DATE", "GAME_ID"])
    paired = paired.reset_index(drop=True)

    grp = paired.groupby(["TEAM_ID", "SEASON"], sort=False)

    # ---- the rolling team rates. shift(1) FIRST, every time. ----
    for raw, column in _RAW_TO_CTX.items():
        paired[column] = grp[raw].transform(
            lambda s, w=window, m=min_periods: (
                s.shift(1).rolling(w, min_periods=m).mean()
            )
        )
    paired[CTX_NET_RATING] = paired[CTX_OFF_RATING] - paired[CTX_DEF_RATING]

    # ---- rest, at team-game grain ----
    # duplicated from features.schedule_features on purpose, and the duplication is
    # the lesser evil: that function computes rest for the PLAYER frame from the
    # universe, and the blowout classifier runs on the team-game frame before any
    # player row exists. The definition is identical (days since the team's previous
    # game, within season) and tests/test_matchup_v4.py pins that the two agree.
    prev = grp["GAME_DATE"].shift(1)
    paired[CTX_REST_DAYS] = (paired["GAME_DATE"] - prev).dt.days
    paired[CTX_IS_B2B] = (paired[CTX_REST_DAYS] == 1).astype(float)
    paired.loc[paired[CTX_REST_DAYS].isna(), CTX_IS_B2B] = np.nan

    # ---- season stakes, as-of ----
    # cumcount is 0-based, so it counts games STRICTLY BEFORE this one with no shift
    # needed. Spelled as a cumcount rather than as `shift(1).expanding().count()`
    # because the latter is null on the first row and the honest value there is 0
    # games played, not "unknown".
    paired["team_games_played"] = grp.cumcount().astype(float)
    paired["team_wins_to_date"] = grp["team_won"].transform(
        lambda s: s.shift(1).expanding(min_periods=1).sum()
    ).fillna(0.0)

    played = paired["team_games_played"]
    wins = paired["team_wins_to_date"]
    with np.errstate(invalid="ignore", divide="ignore"):
        paired["team_win_pct"] = np.where(played > 0, wins / played, np.nan)
    # games over .500 = (W - L)/2 = (2W - G)/2. Signed, so "locked good" and
    # "locked bad" are distinguishable; see config.STAKES_FEATURE_COLS.
    paired["team_games_over_500"] = (2.0 * wins - played) / 2.0
    paired["team_games_remaining"] = (
        float(REGULAR_SEASON_GAMES) - played
    ).clip(lower=0.0)
    paired["late_season"] = (
        paired["team_games_remaining"] <= float(LATE_SEASON_GAMES_REMAINING)
    ).astype(float)
    paired["stakes_late_x_over500"] = (
        paired["late_season"] * paired["team_games_over_500"]
    )
    # the clinch proxy. |games over .500| measured in units of the games left to
    # change it, capped at 1: at 1.0 the remaining schedule cannot return the team
    # to .500, which is the tiebreak-free version of "decided". Zero outside the
    # late-season window, so the column IS the interaction rather than needing a
    # second one.
    remaining = paired["team_games_remaining"].clip(lower=1.0)
    paired["stakes_lockedness"] = (
        paired["late_season"]
        * (paired["team_games_over_500"].abs() / remaining).clip(upper=1.0)
    )

    # ---- the blowout model's own inputs, assembled under their own prefix ----
    paired["bo_own_net_rating"] = paired[CTX_NET_RATING]
    paired["bo_own_rest_days"] = paired[CTX_REST_DAYS]
    paired["bo_own_is_b2b"] = paired[CTX_IS_B2B]
    if home_flags is not None and len(home_flags):
        flags = home_flags[["GAME_ID", "TEAM_ID", "IS_HOME"]].drop_duplicates(
            ["GAME_ID", "TEAM_ID"]
        )
        paired = paired.merge(flags, on=["GAME_ID", "TEAM_ID"], how="left")
        paired["bo_is_home"] = pd.to_numeric(paired["IS_HOME"], errors="coerce")
        paired = paired.drop(columns=["IS_HOME"])
    else:
        log.info("no home flags supplied; bo_is_home will be null")
        paired["bo_is_home"] = np.nan

    # the opponent half of the blowout inputs, by a self-join on the SAME shifted
    # columns. This is the merge that would leak if the shift above were missing,
    # and it is the merge tests/test_matchup_v4.py flips a box score against.
    opp_side = paired[["GAME_ID", "TEAM_ID", CTX_NET_RATING, CTX_PACE, CTX_REST_DAYS,
                       CTX_IS_B2B]].rename(
        columns={
            "TEAM_ID": "OPP_TEAM_ID",
            CTX_NET_RATING: "bo_opp_net_rating",
            CTX_PACE: "_opp_pace",
            CTX_REST_DAYS: "bo_opp_rest_days",
            CTX_IS_B2B: "bo_opp_is_b2b",
        }
    )
    opp_side = opp_side.merge(
        paired[["GAME_ID", "TEAM_ID", "team_win_pct"]].rename(
            columns={"TEAM_ID": "OPP_TEAM_ID", "team_win_pct": "_opp_win_pct"}
        ),
        on=["GAME_ID", "OPP_TEAM_ID"], how="left",
    )
    paired = paired.merge(opp_side, on=["GAME_ID", "OPP_TEAM_ID"], how="left")
    # GAP and SUM of each strength measure; see config.BLOWOUT_MODEL_FEATURES for
    # why a symmetric target needs both and why the raw pair is nearly useless alone.
    paired["bo_net_rating_gap"] = (
        paired["bo_own_net_rating"] - paired["bo_opp_net_rating"]
    ).abs()
    paired["bo_win_pct_gap"] = (
        paired["team_win_pct"] - paired["_opp_win_pct"]
    ).abs()
    paired["bo_win_pct_sum"] = paired["team_win_pct"] + paired["_opp_win_pct"]
    paired["bo_pace_mean"] = (paired[CTX_PACE] + paired["_opp_pace"]) / 2.0

    keep = [
        *TEAM_GAME_KEY, "GAME_DATE", "OPP_TEAM_ID",
        *ROLLING_CTX_COLS, CTX_NET_RATING, CTX_REST_DAYS, CTX_IS_B2B,
        *STAKES_CTX_COLS, "team_wins_to_date",
        *BLOWOUT_MODEL_FEATURES,
        *OUTCOME_COLS,
    ]
    out = paired[keep].sort_values(["GAME_DATE", "GAME_ID", "TEAM_ID"])
    return out.reset_index(drop=True)


# ---------------------------------------------------------------------------
# 2. the pregame blowout classifier, cross-fitted
# ---------------------------------------------------------------------------
def cross_fit_blowout_probabilities(
    context: pd.DataFrame,
    freq: str = CROSS_FIT_FREQ,
    min_train_rows: int = BLOWOUT_CROSS_FIT_MIN_TRAIN_ROWS,
    kind: str = BLOWOUT_MODEL_KIND,
    peek: bool = False,
) -> pd.DataFrame:
    """strictly out-of-fold ``P(blowout)`` for every team-game, by forward chaining.

    THE SAME SCHEME AS :func:`fnba_ml.models.cross_fit_base_probabilities`, and
    deliberately the same rather than merely similar: consecutive calendar-month
    blocks, one model per block fitted on every row STRICTLY BEFORE the block start,
    every probability stamped with its block start so
    :func:`fnba_ml.models.validate_out_of_fold` can prove it. A second cross-fit
    convention in one package would be a second thing to get wrong, and the reason
    the frozen ``p_j`` pipeline uses blocks rather than a per-origin refit applies
    here verbatim: the TRAINING rows' blowout probabilities are features of the final
    minutes model, so a scheme that is out of fold only for the validation rows moves
    the leak from the metric into the fit.

    ``peek=True`` IS THE NEGATIVE CONTROL, and it is in this module rather than in
    the test file so that the honest path and the leaky path differ by one argument
    and share every other line. It fits ONE model on the whole frame - including each
    row's own outcome - and scores that same frame. Its Brier score must be
    conspicuously better than the honest one; a construction where it is not is a
    construction whose cross-fit is not doing anything. See
    ``tests/test_matchup_v4.py::test_peeked_blowout_model_scores_suspiciously_better``.

    ``kind`` names an entry in ``models.ESTIMATORS``, defaulting to
    ``config.BLOWOUT_MODEL_KIND``. It is a REGULARISED LOGISTIC and not the package's
    LightGBM, and that is the one evidence-based hyperparameter decision in this
    phase - see ``config.BLOWOUT_MODEL_KIND`` for the inner-fold table and for the
    finding that the package's default LightGBM configuration scores 22% worse than a
    constant on a frame fifteen times smaller than the one it was tuned for.

    the fallback for blocks too thin to fit is ``config.BLOWOUT_PRIOR``, a hand-set
    constant, for exactly the reason ``CONTEXT_P_PRIOR`` is one. It is a weaker
    probability, not a leaky one, and ``BLOWOUT_SOURCE`` reports the share.
    """
    from .models import ESTIMATORS, validate_out_of_fold  # noqa: PLC0415

    if kind not in ESTIMATORS:
        raise ValueError(
            f"unknown blowout estimator {kind!r}; expected one of "
            f"{sorted(ESTIMATORS)}"
        )
    make_model = ESTIMATORS[kind]

    frame = context.copy()
    frame["GAME_DATE"] = pd.to_datetime(frame["GAME_DATE"])
    frame = frame.sort_values(["GAME_DATE", "GAME_ID", "TEAM_ID"]).reset_index(drop=True)

    feats = [c for c in BLOWOUT_MODEL_FEATURES if c in frame.columns]
    if not feats:
        raise ValueError(
            "the blowout classifier has none of its features on the frame; "
            f"expected some of {list(BLOWOUT_MODEL_FEATURES)}"
        )
    if BLOWOUT_TARGET not in frame.columns:
        raise ValueError(f"the blowout classifier needs its target {BLOWOUT_TARGET!r}")

    # THE GUARD THAT MATTERS: the classifier must never see a box-score quantity
    # from the game it is predicting. The feature names are a fixed tuple in config,
    # so this is checkable rather than a comment.
    forbidden = sorted(set(feats) & set(OUTCOME_COLS))
    if forbidden:
        raise ValueError(
            f"the blowout classifier was handed outcome columns ({forbidden}); its "
            f"whole claim is that it is PREGAME"
        )

    y = frame[BLOWOUT_TARGET].to_numpy(dtype=float)
    p = np.full(len(frame), np.nan)
    cutoff = np.full(len(frame), np.datetime64("NaT", "ns"), dtype="datetime64[ns]")
    source = np.array(["prior"] * len(frame), dtype=object)

    if peek:
        model = make_model().fit(frame[feats], y.astype(int))
        p[:] = model.predict_proba(frame[feats])[:, 1]
        cutoff[:] = frame["GAME_DATE"].to_numpy()
        source[:] = "PEEKED"
        log.warning(
            "PEEKED blowout probabilities: one model fitted on every row including "
            "its own outcome. This is a negative control and must never reach a "
            "dataset"
        )
    else:
        dates = frame["GAME_DATE"].to_numpy()
        first = frame["GAME_DATE"].min().normalize()
        last = frame["GAME_DATE"].max().normalize() + pd.Timedelta(days=1)
        edges = pd.DatetimeIndex(
            sorted(set([first, *pd.date_range(first, last, freq=freq), last]))
        )
        fitted = 0
        for start, end in zip(edges[:-1], edges[1:]):
            block = (dates >= np.datetime64(start)) & (dates < np.datetime64(end))
            if not block.any():
                continue
            train_mask = dates < np.datetime64(start)
            cutoff[block] = np.datetime64(start)
            if int(train_mask.sum()) < min_train_rows:
                p[block] = BLOWOUT_PRIOR
                continue
            train = frame.loc[train_mask]
            if train[BLOWOUT_TARGET].nunique() < 2:
                # a training window with one class cannot produce a probability; the
                # prior is the honest answer and this is not reachable on real data
                p[block] = BLOWOUT_PRIOR
                continue
            model = make_model().fit(
                train[feats], train[BLOWOUT_TARGET].astype(int)
            )
            p[block] = model.predict_proba(frame.loc[block, feats])[:, 1]
            source[block] = "model"
            fitted += 1
        log.info(
            "cross-fit blowout probabilities (%s): %d blocks fitted, %d/%d "
            "team-games from the model (%.1f%%), the rest from BLOWOUT_PRIOR",
            kind, fitted, int((source == "model").sum()), len(frame),
            100.0 * float((source == "model").mean()),
        )

    out = pd.DataFrame({
        "SEASON": frame["SEASON"].to_numpy(),
        "TEAM_ID": frame["TEAM_ID"].to_numpy(),
        "GAME_ID": frame["GAME_ID"].to_numpy(),
        "GAME_DATE": frame["GAME_DATE"].to_numpy(),
        BLOWOUT_PROB: p,
        BLOWOUT_PROB_CUTOFF: cutoff,
        "BLOWOUT_SOURCE": source,
    })
    return validate_out_of_fold(
        out, BLOWOUT_PROB, BLOWOUT_PROB_CUTOFF, "P(blowout)"
    )


def auc(y_true, p) -> float:
    """ROC AUC by the Mann-Whitney identity. No sklearn import, ties handled.

    written out rather than imported because ``sklearn.metrics`` is not otherwise a
    dependency of this package's metric vocabulary (``models.brier`` /
    ``models.mae`` / ``models.skill_score`` are all four-line functions for the same
    reason) and because the rank form makes the tie behaviour visible: average ranks
    for tied scores, which is the standard definition and the one a logistic on a
    weak signal actually needs - it produces long runs of near-identical
    probabilities.
    """
    y = np.asarray(y_true, dtype=float)
    p = np.asarray(p, dtype=float)
    keep = np.isfinite(y) & np.isfinite(p)
    y, p = y[keep], p[keep]
    n_pos, n_neg = float(y.sum()), float(len(y) - y.sum())
    if n_pos == 0 or n_neg == 0:
        return float("nan")
    ranks = pd.Series(p).rank(method="average").to_numpy()
    return float((ranks[y == 1].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg))


def select_blowout_estimator(
    context: pd.DataFrame,
    cutoff: str = BLOWOUT_SELECTION_CUTOFF,
    train_share: float = BLOWOUT_SELECTION_TRAIN_SHARE,
    kinds: tuple[str, ...] = (BLOWOUT_MODEL_KIND, *BLOWOUT_MODEL_CHALLENGERS),
) -> pd.DataFrame:
    """the inner-fold pass that CHOSE ``config.BLOWOUT_MODEL_KIND``.

    RERUNNING THIS IS HOW YOU CHECK THE CHOICE, NOT HOW YOU CHANGE IT - the same rule
    ``evaluate.select_rate_halflives`` operates under. The champion is a constant in
    ``config`` with its evidence written next to it; re-selecting whenever the number
    moves would turn the constant into a rolling re-fit of a decision.

    INNER FOLDS, and what makes them inner. ``cutoff`` is the first development
    origin's validation start, so every row this function looks at is in the TRAINING
    window of every origin the bracket reports on. Within that window the split is
    time-ordered (first ``train_share``, then the rest) rather than random, for the
    reason every split in this package is time-ordered: a random fold reads the
    future.

    scored on BRIER against the constant base rate, plus AUC for the ranking story.
    Brier is the decision metric because the column is consumed as a probability and
    multiplied by ``minutes_share``; a well-ranked but badly calibrated probability
    would put a systematic scale error into the interaction.
    """
    from .models import ESTIMATORS, brier, skill_score  # noqa: PLC0415

    frame = context.copy()
    frame["GAME_DATE"] = pd.to_datetime(frame["GAME_DATE"])
    inner = frame[frame["GAME_DATE"] < pd.Timestamp(cutoff)]
    inner = inner.sort_values(["GAME_DATE", "GAME_ID", "TEAM_ID"]).reset_index(drop=True)
    if len(inner) < 100:
        log.warning("only %d rows before %s; the selection is not meaningful",
                    len(inner), cutoff)
        return pd.DataFrame()

    split = int(len(inner) * train_share)
    train, valid = inner.iloc[:split], inner.iloc[split:]
    feats = [c for c in BLOWOUT_MODEL_FEATURES if c in inner.columns]
    y_train = train[BLOWOUT_TARGET].astype(int).to_numpy()
    y_valid = valid[BLOWOUT_TARGET].astype(float).to_numpy()
    base_rate = float(y_train.mean())
    reference = brier(y_valid, np.full(len(y_valid), base_rate))

    rows = [{
        "kind": "constant base rate", "n_train": len(train), "n_valid": len(valid),
        "auc": 0.5, "brier": reference, "brier_skill": 0.0,
    }]
    for kind in kinds:
        if kind not in ESTIMATORS:
            log.warning("unknown blowout estimator %r; skipped", kind)
            continue
        model = ESTIMATORS[kind]().fit(train[feats], y_train)
        p = model.predict_proba(valid[feats])[:, 1]
        score = brier(y_valid, p)
        rows.append({
            "kind": kind, "n_train": len(train), "n_valid": len(valid),
            "auc": auc(y_valid, p), "brier": score,
            "brier_skill": skill_score(score, reference),
        })
    return pd.DataFrame(rows).sort_values("brier").reset_index(drop=True)


def blowout_model_quality(
    context: pd.DataFrame, probabilities: pd.DataFrame
) -> dict[str, float]:
    """AUC, Brier, Brier skill and a calibration fit for the blowout classifier.

    a feature whose quality is unmeasured is a feature nobody can argue about. The
    skill baseline is the league base rate over the SAME rows, which is the dumbest
    thing that could have been used instead of a model - the same convention
    ``evaluate.SKILL_BASELINE`` uses for availability.

    the calibration fit is ``logit(y) ~ a + b*logit(p)`` by ordinary least squares on
    decile bins, matching MODEL.md 13.3's E2 definition, so a prospective calibration
    number and this one are the same quantity.
    """
    from .models import brier, skill_score  # noqa: PLC0415

    merged = context.merge(
        probabilities[["SEASON", "TEAM_ID", "GAME_ID", BLOWOUT_PROB]],
        on=["SEASON", "TEAM_ID", "GAME_ID"], how="inner",
    )
    y = merged[BLOWOUT_TARGET].to_numpy(dtype=float)
    p = merged[BLOWOUT_PROB].to_numpy(dtype=float)
    keep = np.isfinite(y) & np.isfinite(p)
    y, p = y[keep], p[keep]
    if len(y) == 0 or len(np.unique(y)) < 2:
        return {"n": float(len(y))}

    base = float(y.mean())
    out = {
        "n": float(len(y)),
        "base_rate": base,
        "auc": auc(y, p),
        "brier": brier(y, p),
        "brier_base": brier(y, np.full(len(y), base)),
    }
    out["brier_skill"] = skill_score(out["brier"], out["brier_base"])

    # decile calibration. binned rather than per-row because logit(y) is undefined
    # at y in {0, 1}, which every single row is.
    bins = pd.qcut(pd.Series(p), 10, duplicates="drop")
    grouped = pd.DataFrame({"p": p, "y": y}).groupby(bins, observed=True).mean()
    eps = 1e-6
    px = np.log(grouped["p"].clip(eps, 1 - eps) / (1 - grouped["p"].clip(eps, 1 - eps)))
    py = np.log(grouped["y"].clip(eps, 1 - eps) / (1 - grouped["y"].clip(eps, 1 - eps)))
    if len(px) >= 2:
        slope, intercept = np.polyfit(px.to_numpy(), py.to_numpy(), 1)
        out["calibration_slope"] = float(slope)
        out["calibration_intercept"] = float(intercept)
    return out


# ---------------------------------------------------------------------------
# 3. the start-rate proxy
# ---------------------------------------------------------------------------
def start_rate_features(
    universe: pd.DataFrame,
    window: int = START_RATE_WINDOW,
    top_n: int = START_RATE_TOP_N,
) -> pd.DataFrame:
    """``top5_min_share_10``: the share of recent games the player led his team in minutes.

    THE PROXY THE MISSING ``started`` COLUMN FORCES. See
    ``config.START_RATE_WINDOW`` for the measurement that condemns the real column:
    ``player_game_logs.started`` is NULL on all 105,253 rows and
    ``player_game_status.started`` has ZERO ``true`` values league-wide, so a rolling
    start rate would be a rolling mean of nothing.

    the construction, and where the shift is:

      1. within each team-game, rank APPEARANCES by minutes played, descending.
         ``rank(method="first")`` rather than ``"min"``, so a two-way tie at the
         fifth spot yields one top-5 player and not two - the number of players on
         the floor at tip is exactly five and the label should say so.
      2. ``is_top_n`` is 1 for a rank <= ``top_n`` and 0 for everyone else, including
         every non-appearance. "did not play" is not "started", and treating a
         non-appearance as missing would let a long injury inflate the proxy of the
         games around it.
      3. per player, ``shift(1).rolling(window).mean()`` over SCHEDULED rows in date
         order. The shift is the as-of guard and it is the only one - step 1 reads
         the target game's minutes, which is exactly why step 3 must remove it.

    grouped by ``PLAYER_ID`` alone, career-scoped, like every other rolling window in
    :mod:`fnba_ml.features`: a player's role at the end of last season is the best
    available guess at his role in game 1, and a season-scoped window would hand
    every player a null in October.
    """
    for col in ("PLAYER_ID", "GAME_ID", "TEAM_ID", "GAME_DATE", "PLAYED", "MIN"):
        if col not in universe.columns:
            raise ValueError(f"start_rate_features needs {col!r} on the universe")

    frame = universe[
        ["PLAYER_ID", "GAME_ID", "TEAM_ID", "GAME_DATE", "PLAYED", "MIN"]
    ].copy()
    frame["GAME_DATE"] = pd.to_datetime(frame["GAME_DATE"])

    minutes = pd.to_numeric(frame["MIN"], errors="coerce")
    # rank only among appearances; a non-appearance gets no rank and therefore a 0
    appeared = (frame["PLAYED"] == 1) & minutes.notna() & (minutes > 0)
    ranked = minutes.where(appeared)
    frame["_rank"] = ranked.groupby(
        [frame["GAME_ID"], frame["TEAM_ID"]]
    ).rank(method="first", ascending=False)
    frame["_is_top_n"] = (frame["_rank"] <= float(top_n)).astype(float)

    frame = frame.sort_values(["PLAYER_ID", "GAME_DATE", "GAME_ID"])
    frame[START_RATE_COL] = frame.groupby("PLAYER_ID")["_is_top_n"].transform(
        lambda s, w=window: s.shift(1).rolling(w, min_periods=1).mean()
    )
    return frame[["PLAYER_ID", "GAME_ID", "TEAM_ID", START_RATE_COL]].reset_index(
        drop=True
    )


# ---------------------------------------------------------------------------
# 4. attach everything to the player frame
# ---------------------------------------------------------------------------
def attach_matchup_features(
    features: pd.DataFrame,
    context: pd.DataFrame,
    probabilities: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """merge own-team and opponent-team context onto a scheduled-player-game frame.

    the row's ORDER IS PRESERVED. callers (the evaluation ladder, the backfill
    script) hold positional alignment with arrays computed from the frame, and a
    merge that silently re-sorts is the kind of bug that shows up three functions
    later as an inexplicable metric.

    ``probabilities`` is the cross-fit output of
    :func:`cross_fit_blowout_probabilities`. Passing ``None`` attaches every column
    except ``blowout_prob`` and its interaction, which is what a caller wanting the
    pace and stakes families alone would ask for; the two blowout columns are then
    absent and ``features.feature_set_columns`` drops them from the list with a
    warning rather than handing the model a NaN column.
    """
    out = features.copy()
    out["_row_order"] = np.arange(len(out))
    out["GAME_DATE"] = pd.to_datetime(out["GAME_DATE"])

    ctx = context.copy()

    # ---- the row's OWN team ----
    own_cols = {
        CTX_PACE: "own_pace",
        CTX_NET_RATING: "own_net_rating",
        CTX_SLOT_MINUTES: "own_slot_minutes",
    }
    own = ctx[[*TEAM_GAME_KEY, *own_cols, *STAKES_CTX_COLS, *OUTCOME_COLS]].rename(
        columns=own_cols
    )
    before = len(out)
    out = out.merge(own, on=list(TEAM_GAME_KEY), how="left")
    if len(out) != before:
        raise ValueError(
            f"attaching own-team context changed the row count ({before} -> "
            f"{len(out)}); (SEASON, TEAM_ID, GAME_ID) is not unique in the context"
        )

    # ---- the OPPONENT ----
    # NOTE what is and is not taken from the opponent. Pace, net rating, defensive
    # rating and the two style rates: yes. The stakes columns: NO - see
    # STAKES_CTX_COLS. The outcome columns: NO, they are the same game's and would be
    # a second copy of the label.
    opp_cols = {
        CTX_PACE: "opp_pace",
        CTX_NET_RATING: "opp_net_rating",
        CTX_DEF_RATING: "opp_def_rating",
        CTX_FG3A_ALLOWED: "opp_fg3a_allowed_per100",
        CTX_FTA_ALLOWED: "opp_fta_allowed_per100",
    }
    opp = ctx[["SEASON", "TEAM_ID", "GAME_ID", *opp_cols]].rename(
        columns={"TEAM_ID": "OPP_TEAM_ID", **opp_cols}
    )
    before = len(out)
    out = out.merge(opp, on=["SEASON", "OPP_TEAM_ID", "GAME_ID"], how="left")
    if len(out) != before:
        raise ValueError(
            f"attaching opponent context changed the row count ({before} -> "
            f"{len(out)})"
        )

    # ---- the game's possession environment ----
    out["game_pace_mean"] = (out["own_pace"] + out["opp_pace"]) / 2.0
    # the PRODUCT, scaled by 100 so it lands in the same order of magnitude as the
    # mean rather than at ~12,600. A booster does not care about scale; a human
    # reading a feature-importance table does, and a column nobody can sanity-check
    # is a column nobody notices is broken.
    out["game_pace_product"] = out["own_pace"] * out["opp_pace"] / 100.0

    # ---- minutes share: the quantity both interactions multiply ----
    # roll10_MIN is the player's strictly-prior rolling mean minutes and
    # own_slot_minutes is his team's strictly-prior rolling mean minutes per lineup
    # slot (~48). The ratio is "what fraction of one slot's minutes does this player
    # usually take", ~0.7 for a heavy-minutes starter and ~0.1 for the twelfth man.
    if "roll10_MIN" in out.columns:
        slot = pd.to_numeric(out["own_slot_minutes"], errors="coerce")
        out["minutes_share"] = pd.to_numeric(out["roll10_MIN"], errors="coerce") / slot
    else:
        log.warning("no roll10_MIN on the frame; minutes_share will be null")
        out["minutes_share"] = np.nan

    # ---- the stakes interactions ----
    out["stakes_x_minutes_share"] = out["stakes_lockedness"] * out["minutes_share"]
    # "veteran" as log1p(career appearances): the difference between a rookie and a
    # 200-game player matters far more than the difference between 800 and 1,000, and
    # a raw count would let one Hall of Famer dominate the split.
    veteran = np.log1p(pd.to_numeric(out.get("n_appearances"), errors="coerce"))
    out["stakes_x_veteran"] = out["stakes_lockedness"] * veteran

    # ---- the blowout probability and its interaction ----
    if probabilities is not None and len(probabilities):
        prob = probabilities[
            ["SEASON", "TEAM_ID", "GAME_ID", BLOWOUT_PROB, BLOWOUT_PROB_CUTOFF]
        ].drop_duplicates(["SEASON", "TEAM_ID", "GAME_ID"])
        before = len(out)
        out = out.merge(prob, on=list(TEAM_GAME_KEY), how="left")
        if len(out) != before:
            raise ValueError(
                f"attaching blowout probabilities changed the row count ({before} -> "
                f"{len(out)})"
            )
        out["blowout_x_minutes_share"] = out[BLOWOUT_PROB] * out["minutes_share"]
    else:
        log.info(
            "no blowout probabilities supplied; %s and its interaction will be "
            "absent from the frame", BLOWOUT_PROB,
        )

    out = out.drop(columns=["own_slot_minutes"])
    return (
        out.sort_values("_row_order")
        .drop(columns=["_row_order"])
        .reset_index(drop=True)
    )


def attach_start_rate(features: pd.DataFrame) -> pd.DataFrame:
    """merge :func:`start_rate_features` onto a frame, preserving row order."""
    out = features.copy()
    out["_row_order"] = np.arange(len(out))
    proxy = start_rate_features(out)
    before = len(out)
    out = out.merge(proxy, on=["PLAYER_ID", "GAME_ID", "TEAM_ID"], how="left")
    if len(out) != before:
        raise ValueError(
            f"attaching the start-rate proxy changed the row count ({before} -> "
            f"{len(out)}); (PLAYER_ID, GAME_ID, TEAM_ID) is not unique"
        )
    return (
        out.sort_values("_row_order")
        .drop(columns=["_row_order"])
        .reset_index(drop=True)
    )


def attach_v4_features(
    features: pd.DataFrame,
    team_logs: pd.DataFrame,
    with_blowout: bool = True,
) -> pd.DataFrame:
    """the whole v4 candidate family, in one call, from a feature frame + team logs.

    THE ONE ENTRY POINT, so that the pipeline path (``features.build_dataset``) and
    the backfill path (``ml/build_v4_dataset.py``) run identical code and a
    backfilled column and a freshly built one are the same number - the same
    guarantee :func:`fnba_ml.features.attach_per_minute_rates` makes for the rate
    columns, and for the same reason.

    the home flags come off the feature frame itself rather than from the schedule:
    ``IS_HOME`` is already a v3 feature column, so it is available with no new
    source, and taking it from the frame being decorated means the blowout model's
    home flag cannot disagree with the row's own.
    """
    home = (
        features[["GAME_ID", "TEAM_ID", "IS_HOME"]].drop_duplicates(
            ["GAME_ID", "TEAM_ID"]
        )
        if "IS_HOME" in features.columns else None
    )
    context = team_game_context(team_logs, home_flags=home)
    probabilities = (
        cross_fit_blowout_probabilities(context) if with_blowout else None
    )
    out = attach_matchup_features(features, context, probabilities)
    return attach_start_rate(out)
