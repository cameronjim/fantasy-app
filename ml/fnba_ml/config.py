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
#
# v2 (2026-08-17): the teammate-absence "vacated resource" family plus the
# player's own usage rate. UNLIKE the per-minute composition rates - which were
# added without a bump precisely because they are not predictors - these ARE
# model features: they enter FEATURE_COLS, every trained artifact fitted against
# v1 is invalid for them, and a v1 artifact loaded against a v2 dataset would be
# scoring a different feature contract than it was fit on.
#
# v3 (2026-08-17, phase P1b): the teammate-context family is rebuilt as
# EXPECTATIONS over as-of play probabilities instead of sums over REALIZED
# absences. The round-2 external review found the real defect the v2 numbers were
# hiding: a v2 feature on player i is a function of player j's target-game PLAYED
# label. Self-exclusion closes the path from i's own label to i's own features and
# does nothing about the cross-player path, so the v2 gains are honest only as a
# value-of-perfect-lineup-information (ORACLE) result. v3 replaces every realized
# indicator 1(j absent) with (1 - p_j), where p_j is a strictly out-of-fold
# probability from a base availability model that has no teammate-context features
# of its own. The v2 columns are still computed and still on the dataset - they are
# the Level-D oracle comparator in the evaluation bracket - but they are NOT in
# FEATURE_COLS and are never served.
FEATURE_VERSION = "v3"

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

# ---------------------------------------------------------------------------
# P2: the v4 CANDIDATE family - matchup, blowout, season stakes
# ---------------------------------------------------------------------------
# NOTHING BELOW IS SERVED. The frozen configuration is `prospective_2026_27_v1`
# (FEATURE_VERSION v3, 51 columns, artifact 20260818), and MODEL.md 13.2 item 6
# makes any FEATURE_COLS change a re-freeze trigger. So this block defines a
# CANDIDATE feature contract that lives alongside the frozen one: it adds names,
# it adds one entry to FEATURE_SETS, and it does not touch FEATURE_COLS,
# FEATURE_VERSION or any PROSPECTIVE_* constant. `tests/test_prospective_freeze.py`
# stays green by construction, which is the property that lets the candidate be
# developed and measured without ending the v1 prospective test.
#
# THE ONE-LINE SUMMARY OF WHAT THESE FEATURES ARE FOR. v3 describes the PLAYER and
# (through the teammate family) his ROSTER. It says almost nothing about the GAME:
# how fast it will be played, whether it will be competitive, and whether either
# team still has anything to win. Those three are exactly the situations where the
# minutes model is most wrong - a starter's 34 minutes become 24 in a 25-point
# blowout, and a high-minute veteran on a team that is 14 games under .500 in April
# is a rest candidate whose availability the model rates at 0.9.

# ---- A. matchup / possession environment ----
# the rolling window for every team-level rate. 15 team-games is roughly six
# weeks: long enough that a single overtime game or one 140-point night does not
# define a team's pace, short enough to move when a rotation or a coach changes.
# HAND-SET on the same reasoning as OPP_FORM_WINDOW (10) rather than tuned - the
# hyperparameter budget in this phase went to the blowout model, and a pace window
# selected on validation rows would be selecting on the thing being reported.
PACE_WINDOW: int = 15

# a team-level rate needs a few games behind it before it is a measurement rather
# than a rounding of one box score. 5 rather than OPP_FORM_MIN_PERIODS' 3 because a
# rating is a RATIO of two noisy totals and its variance at n = 3 is worse than a
# points-allowed mean's.
PACE_MIN_PERIODS: int = 5

# THE POSSESSION ESTIMATE, and the documented deviation from the textbook formula.
# The standard box-score approximation is
#
#     poss ~= FGA + 0.44 * FTA - OREB + TOV
#
# and `team_game_logs` HAS NO `oreb` COLUMN (verified against the dev schema
# 2026-08-19: the table carries `reb` only, with no offensive/defensive split, and
# no other table in the truth layer carries team OREB either). So this package uses
# the standard OREB-free fallback
#
#     poss ~= FGA + 0.44 * FTA + TOV
#
# which is the same formula the v2 usage feature already uses
# (FT_POSSESSION_WEIGHT's comment states it), so the two are consistent rather than
# two different notions of a possession. WHAT IT COSTS, stated rather than waved
# past: offensive rebounds extend a possession, so the fallback OVERCOUNTS
# possessions by roughly the team's OREB count - about 10 per game, ~10% of the
# total. That is a level shift, and a level shift is almost harmless here because
# every consumer of the number is a RELATIVE comparison between teams (pace
# percentiles, a defensive rating denominator shared by both sides). It becomes a
# real error only where teams differ a lot in OREB rate, which is a second-order
# spread on top of a first-order one. Flagged as a **[GAP]**: an upstream OREB/DREB
# split would let this use the textbook form, and the fix belongs in the scraper.
POSSESSION_USES_OREB: bool = False

# ---- B. the pregame blowout model ----
# a blowout is a game whose final margin is at least this many points. 15 is the
# conventional line and the data says it is also the useful one. MEASURED over all
# 9,840 team-games of the four-season truth layer (mean |margin| 12.45, median 10):
#
#     |margin| >=  5   80.1%      >= 15   32.6%
#     |margin| >= 10   53.0%      >= 20   19.7%
#     |margin| >= 12   44.0%      >= 25   11.2%
#
# 10 is a coin flip and therefore names nothing; 20 leaves 1,900 positives to fit a
# classifier on and stops describing the games where a starter loses six minutes
# rather than sixteen. 15 keeps a third of the rows positive and is far enough out
# that the minutes truncation the label stands in for has actually happened. The
# other rates are recorded here and in MODEL.md section 15 so the choice can be
# argued with rather than taken on faith.
#
# NOTE the trend across seasons - 26.8% / 32.4% / 34.2% / 37.2% - which is a real
# league-level drift and one more reason the classifier is cross-fitted forward in
# time rather than fitted once on the pooled four seasons.
BLOWOUT_MARGIN: float = 15.0

# a blowout is SYMMETRIC. Both team-games of a game carry the same label, because
# both benches empty: the losing starters sit because it is lost and the winning
# starters sit because it is won. Modelling "will my team win by 15" instead would
# be modelling a different quantity and would need a signed target.
BLOWOUT_TARGET = "blowout"
BLOWOUT_MARGIN_COL = "team_margin"

# the cross-fit that keeps the blowout probability out of fold. SAME SCHEME as
# models.cross_fit_base_probabilities - consecutive calendar-month blocks, each
# fitted strictly before its own start - and deliberately the same, because a
# second cross-fit convention in one package is a second thing to get wrong.
# The row count is what differs: 9,840 team-games against 147,413 player-games, so
# CROSS_FIT_MIN_TRAIN_ROWS' 5,000 would leave the first ~2.5 seasons on the
# fallback. One month of team-games is ~430 rows; 400 gates out the genuinely
# unfittable opening block and nothing else.
BLOWOUT_CROSS_FIT_MIN_TRAIN_ROWS: int = 400

# the fallback probability for blocks too thin to fit. HAND-SET at roughly the
# league-wide blowout rate (measured 0.3264 over four seasons, rounded to two
# figures), and a CONSTANT for exactly the reason CONTEXT_P_PRIOR is one: a mean
# over the evaluation window would put a little of every future game into every past
# row. It applies to the opening month only - ~430 of 9,840 team-games.
BLOWOUT_PRIOR: float = 0.33

# the blowout model's own feature list. pregame-knowable only: the two rolling net
# ratings and their absolute gap, the two season-to-date win percentages summarised
# the same way, the pace environment, rest on both sides, home/away. No box-score
# quantity from the target game appears, which is the property
# tests/test_matchup_v4.py pins with a peeked negative control.
#
# WHY BOTH A GAP AND A SUM of every strength measure. The target is SYMMETRIC
# (|margin| >= 15 is the same label for both team-games of a game), so a raw own /
# opponent pair is close to useless on its own: pooled over the dataset every game
# appears twice with the roles swapped, which forces corr(own, y) == corr(opp, y)
# exactly. The GAP is the mismatch - the thing that makes a blowout likely - and the
# SUM is the quality level, which is a different question (two 55-win teams and two
# 25-win teams have the same gap and do not play the same kind of game). The raw pair
# is kept anyway because dropping it would be a modelling assumption where the two
# summaries are a modelling convenience.
BLOWOUT_MODEL_FEATURES: tuple[str, ...] = (
    "bo_own_net_rating",
    "bo_opp_net_rating",
    "bo_net_rating_gap",
    "bo_win_pct_gap",
    "bo_win_pct_sum",
    "bo_pace_mean",
    "bo_own_rest_days",
    "bo_own_is_b2b",
    "bo_opp_rest_days",
    "bo_opp_is_b2b",
    "bo_is_home",
)
BLOWOUT_PROB = "blowout_prob"
BLOWOUT_PROB_CUTOFF = "BLOWOUT_PROB_CUTOFF"

# WHICH ESTIMATOR PRODUCES P(blowout), and this is the one hyperparameter decision
# in P2 that was actually made on evidence rather than hand-set.
#
# SELECTED ON INNER FOLDS ONLY: a time-ordered 70/30 split of every team-game
# STRICTLY BEFORE 2024-12-01 - the first development origin's validation start - so
# the selection never touched any origin's validation rows. 3,854 inner-train
# team-games, 1,652 inner-validation, base rate 0.328. Scored on BRIER, because the
# column is consumed as a probability and multiplied by minutes_share; a
# well-ranked but badly calibrated probability would poison the interaction.
#
# THE INNER-FOLD TABLE, and it is not a flattering one (Brier skill vs the constant
# base rate; positive is better):
#
#     constant base rate                        0.2223    0.0000
#     logistic, 11 features                    0.2224   -0.0005
#     LightGBM 150/7/150                        0.2268   -0.0205
#     LightGBM 200/15/100                       0.2331   -0.0490
#     LightGBM 400/31/50 (LGBM_PARAMS default)  0.2707   -0.2180
#
# TWO THINGS THIS SAYS AND ONE IT DOES NOT.
#
#  1. **The package's default LightGBM configuration is catastrophically wrong for
#     this problem**, and by a factor nobody would guess: 400 estimators and 31
#     leaves over 3,854 rows scores 22% WORSE than a constant. LGBM_PARAMS was tuned
#     for a 147,413-row player-game frame; a team-game frame is fifteen times
#     smaller and the same settings memorise it. Reusing a package default across a
#     fifteen-fold change in sample size is the error, and it is recorded because it
#     would have shipped silently - the first backfill run produced a blowout_prob
#     with Brier skill -0.122 and AUC 0.515 and nothing would have failed.
#  2. **The winner is the regularised logistic**, at parity with a constant
#     (-0.0005). So the honest statement is that this feature set predicts blowouts
#     essentially not at all in Brier terms, with a small but real ranking signal:
#     AUC 0.52 on the inner folds and 0.54 on a four-season in-time split, and the
#     top decile of |as-of margin gap| contains 41.5% blowouts against 27.1% in the
#     bottom decile.
#  3. It does NOT say the feature is worthless in the bracket, and pre-registering
#     that it is would be deciding the question before measuring it. A weakly
#     informative probability multiplied by minutes_share can still separate a
#     starter's downside from a bench player's upside. What it DOES say is that the
#     ceiling is low, and MODEL.md section 15 records that expectation before the
#     bracket ran.
BLOWOUT_MODEL_KIND = "logistic"
BLOWOUT_MODEL_CHALLENGERS: tuple[str, ...] = ("lightgbm_classifier",)

# the inner-fold selection window and split, as constants so
# ``matchup.select_blowout_estimator`` reruns exactly the pass that chose the
# champion above rather than approximately it.
BLOWOUT_SELECTION_CUTOFF = "2024-12-01"
BLOWOUT_SELECTION_TRAIN_SHARE: float = 0.70

# ---- C. season stakes ----
# every team plays 82 regular-season games. A CONSTANT rather than a count off
# `nba_schedule`, and the reason is a data fact rather than laziness: the dev
# schedule table holds 2024-25 onward only, while `team_game_logs` holds all four
# seasons, so a games-remaining feature derived from the schedule would be null on
# half the dataset. 82 is also exactly right - 2,460 team-game rows per season /
# 30 teams = 82.0 in every one of the four seasons - and a season that ever ships a
# different number (a lockout) is a change this constant makes visible.
REGULAR_SEASON_GAMES: int = 82

# "late season" for the load-management interaction. 15 games remaining is roughly
# the last five weeks, which is when the reporting on rest decisions starts and when
# a team's playoff position stops being reachable. HAND-SET; the alternative was a
# calendar date, which breaks across the four seasons' different start dates.
LATE_SEASON_GAMES_REMAINING: int = 15

# the CLINCH PROXY, and it is a proxy rather than seed math. True seed math needs
# the full standings of a team's own conference on every date, which is derivable
# from team logs but costs a per-date 30-team sort and buys a number that is still
# not "clinched" without tiebreak rules. Instead:
#
#     lockedness = 1(late season) * min(1, |games over .500| / games remaining)
#
# reads as "how far from .500 this team is, in units of the games it has left to
# change it". At 1.0 the remaining schedule cannot move the team back to .500 -
# which is the honest, tiebreak-free version of "this team's season is decided".
# It is continuous on purpose: a hard clinched/eliminated flag would throw away the
# ordering inside the band where the effect is strongest.
STAKES_LOCKED_RATIO: float = 0.5

# ---- D. start rate, and why it is a proxy ----
# `player_game_status.started` and `player_game_logs.started` are BOTH unusable, and
# it is worth writing down which kind of unusable: measured on the dev truth layer
# 2026-08-19, `player_game_logs.started` is NULL on all 105,253 rows across all four
# seasons, and `player_game_status.started` is NULL on 52,957 of 74,870 rows and
# FALSE on the other 21,913 - with ZERO `true` values league-wide. So it is not
# sparse, it is structurally absent: the league-log source writes None and the
# box-score path only ever writes the negative case. A rolling mean of that column
# would be a rolling mean of zero.
#
# The proxy: the share of the player's last START_RATE_WINDOW SCHEDULED team-games
# in which he was among his team's top START_RATE_TOP_N by minutes played. Five is
# the number of players on the floor at tip, so "top 5 in minutes" is the
# outcome a start usually produces; it is not the same thing (a sixth man can
# out-minute a starter) and the column is named for what it measures rather than
# for what it stands in for. Non-appearances count as 0, exactly as avail_rate_10
# counts them, because "did not play" is not "started".
START_RATE_WINDOW: int = 10
START_RATE_TOP_N: int = 5

# ---- the v4 candidate feature columns, by family ----
MATCHUP_FEATURE_COLS: list[str] = [
    # possession environment. own and opponent pace, then the two summaries of the
    # GAME's total possession count that the task of predicting minutes actually
    # wants: a fast team hosting a fast team is a different night from either team's
    # own pace.
    "own_pace",
    "opp_pace",
    "game_pace_mean",
    "game_pace_product",
    # strength. the net ratings are here as features in their own right as well as
    # being the blowout model's inputs - a booster given P(blowout) and nothing else
    # cannot express "this is a mismatch but a fast one".
    "own_net_rating",
    "opp_net_rating",
    # the REFINEMENT of OPP_DEF_FORM. the v3 column is raw points allowed per game,
    # which conflates "good defence" with "slow pace". This is per 100 possessions,
    # which is the thing the phrase means. The old column STAYS in the contract:
    # removing it would make this a two-variable change and there would be no way to
    # tell a refinement from a removal.
    "opp_def_rating",
    # style. "weak against threes" and "fouls a lot" as two separate rates, both
    # normalised per 100 possessions so they are not pace in disguise.
    "opp_fg3a_allowed_per100",
    "opp_fta_allowed_per100",
]

# the player's share of a lineup slot's minutes, and the reason it is its own
# column rather than only an interaction term: it is the quantity BOTH new
# interactions multiply, and a booster handed only the products cannot recover it.
# roll10_MIN / (rolling team minutes / 5), so the denominator is ~48 in regulation
# and larger after overtimes, and the ratio is ~0.7 for a heavy-minutes starter.
SHARE_FEATURE_COLS: list[str] = ["minutes_share"]

BLOWOUT_FEATURE_COLS: list[str] = [
    BLOWOUT_PROB,
    # THE INTERACTION THE OBSERVATION DEMANDS, and the reason it is handed over
    # rather than left to be discovered. A blowout does not shift minutes in one
    # direction: starters lose minutes and deep bench players gain them, so the
    # marginal effect of blowout_prob changes SIGN with minutes_share. A tree can
    # represent that with a deep enough interaction, and with 400 estimators over 72
    # features it very often does not. Supplying the product means the model can
    # learn one coefficient per segment instead of rediscovering the crossing point.
    "blowout_x_minutes_share",
]

STAKES_FEATURE_COLS: list[str] = [
    "team_games_remaining",
    "team_win_pct",
    "team_games_over_500",
    "late_season",
    # signed: "locked GOOD" (a 1-seed resting stars) and "locked BAD" (a lottery
    # team shutting a veteran down) are both load management and the model should be
    # able to tell them apart, because they hit different players.
    "stakes_late_x_over500",
    "stakes_lockedness",
    # the two player-level interactions. a rest candidate is not "a player on a
    # locked team", it is a HIGH-MINUTE VETERAN on a locked team, and neither factor
    # alone identifies him.
    "stakes_x_minutes_share",
    "stakes_x_veteran",
]

START_RATE_FEATURE_COLS: list[str] = ["top5_min_share_10"]

V4_FEATURE_COLS: list[str] = (
    MATCHUP_FEATURE_COLS
    + SHARE_FEATURE_COLS
    + BLOWOUT_FEATURE_COLS
    + STAKES_FEATURE_COLS
    + START_RATE_FEATURE_COLS
)

# ---- the candidate contract ----
# FEATURE_COLS (v3, 51 columns) is UNTOUCHED and remains what the frozen artifact
# was fitted against. FEATURE_COLS_V4 is defined next to FEATURE_COLS further down
# this file, because it is `FEATURE_COLS + V4_FEATURE_COLS` and a forward reference
# would be a second place for the v3 contract to be spelled out.
#
# the v4 feature version tag, held as a constant rather than assigned to
# FEATURE_VERSION. Promoting the candidate means setting FEATURE_VERSION to this
# value, which is a MODEL.md 13.2 re-freeze trigger and must not happen as a side
# effect of building the candidate.
CANDIDATE_FEATURE_VERSION = "v4"

# ---- P2's pre-registered promotion rule ----
# WRITTEN DOWN BEFORE THE BRACKET RAN. The numbers this block names are the bar; the
# report states them in its header and then reports whether they were met.
#
# THE BAR: a paired 7-day moving-block bootstrap over game dates (the frozen
# convention from ml/experiments/production_tournament/bootstrap.py, reused rather
# than reimplemented), 95% CI excluding zero, AND at least P2_PROMOTION_FLOOR pooled
# relative improvement on EITHER minutes MAE or availability Brier, AND no reported
# cohort regressing by more than P2_COHORT_REGRESSION_TOLERANCE.
#
# WHY 1% AND NOT 2%. The package's standing noise line is ~2% and it is the right
# bar for promoting a new ESTIMATOR (models.CHAMPIONS) - a different model class in
# the serving path is a large change and should have to pay for itself largely.
# This is a FEATURE-SET change to an existing champion: same estimator, same
# composition, same artifact shape, more columns. The precedent is section 11's v3
# adoption, which shipped on -1.98% availability Brier and -0.81% minutes MAE and
# was accepted because it was a construction correctness change measured on
# identical rows with the same estimator. 1% is that precedent's bar made explicit,
# and it is stated here rather than chosen after the numbers were seen.
P2_PROMOTION_FLOOR: float = 0.01

# the endpoints the floor may be cleared on. Exactly two, and they are the two the
# new features AIM at: minutes (pace, blowout truncation, rest) and availability
# (load management). Unconditional PTS is REPORTED and is not a promotion gate,
# because it is downstream of both and would let a minutes win be laundered into a
# third significant result.
P2_PROMOTION_ENDPOINTS: tuple[str, ...] = ("minutes_mae", "availability_brier")

# a candidate that wins on average by hurting a segment has not won. the tolerance
# is one-sided and applies to every cohort in the report, the two new descriptive
# ones included.
P2_COHORT_REGRESSION_TOLERANCE: float = 0.01

# ---- the two NEW descriptive cohorts ----
# EVENT_COHORTS is frozen (MODEL.md 13.3, pinned by test_prospective_freeze) and is
# not touched. These are additional REPORTING cohorts for the P2 bracket, and they
# are where the new features have to earn their keep: the games the blowout model
# says are most likely to be decided early, and the games where a team has nothing
# left to play for.
#
# `blowout_prob` is an as-of, out-of-fold model output, so the top-decile cut is
# computable at the forecast cutoff - unlike EVENT_COHORTS, which cut on an oracle
# column deliberately. The threshold is a QUANTILE over the validation frame rather
# than a constant, so "top decile" means the same share of rows in every origin.
V4_DESCRIPTIVE_COHORTS: tuple[tuple[str, str, str, float], ...] = (
    ("v4: blowout_prob top decile", BLOWOUT_PROB, "quantile>=", 0.90),
    ("v4: stakes-flagged (locked, late)", "stakes_lockedness", ">=", STAKES_LOCKED_RATIO),
)
V4_DESCRIPTIVE_COHORT_ORDER: tuple[str, ...] = tuple(
    label for label, *_ in V4_DESCRIPTIVE_COHORTS
)

# ---- the DEVELOPMENT origin set for P2 ----
# ORIGINS is left at five entries, untouched, because `tests/test_teammates_v3.py`
# pins `len(ORIGINS) == 5` and because every champion in this package was chosen on
# exactly those five. The sixth origin lives here instead, and the P2 bracket runs
# on DEV_ORIGINS.
#
# THE SIXTH ORIGIN EXISTS TO MEASURE ONE THING: the load-management effect. Every
# one of the five development origins validates on December, January or February,
# and the season-stakes features are null-by-construction useful only in the last
# five weeks. A feature family aimed at March that is evaluated only on January
# would be evaluated where it cannot help, and its pooled number would be a
# dilution rather than a measurement - which is why the late-season origin is
# reported SEPARATELY as well as pooled.
#
# WHY 2025 AND NOT 2026, which is the choice that matters. Mar 15 - Apr 12 **2026**
# is inside the SELECTION HOLDOUT (MODEL.md section 6: Feb-2026 -> Apr-2026, "never
# used for model selection"). Using it as a development origin would consume the
# holdout for selection, which is precisely the thing that section says has not
# happened. Mar 15 - Apr 12 **2025** is in 2024-25, is not the holdout, and carries
# comparable volume (~3,900 scheduled rows against ~3,800). The 2026 window would
# have been the more recent data and it is not available for this purpose.
LATE_SEASON_ORIGIN: tuple[str, str, str] = (
    "O6 valid=2025-03-15..04-12", "2025-03-15", "2025-04-12",
)
# DEV_ORIGINS itself is assembled next to ORIGINS further down, so the two lists sit
# together and nobody has to grep to find out whether the sixth origin was ADDED or
# whether one of the five was edited.

# ---- per-minute production rates (the minutes-propagating composition) ----
# stats served as P(play) x E[minutes | play] x rate. the rate is an EWMA of the
# per-game ratio stat/minutes over APPEARANCE games with minutes > 0, so a
# player's rate is a property of how he plays and his minutes forecast supplies
# how much he plays. before this existed the composition was P(play) x EWMA(stat)
# and a predicted minutes change could not move the stat at all.
# EXTENDED 2026-08-18 to the full 9-category vocabulary. the pair (PTS, AST) was
# never a modelling decision - it was the pair the phase-0 spike happened to
# carry - and a 9-cat league is scored on nine numbers, six of which the package
# could not produce. the order here is the order MODEL.md and every report table
# uses: the two incumbents first, then the counting stats, then the shooting
# primitives.
#
# PERCENTAGES ARE NOT IN THIS LIST AND NEVER WILL BE. FG% and FT% are ratios of
# two random variables, and E[FGM/FGA] != E[FGM]/E[FGA]; more practically, a
# fantasy league scores a manager's WEEKLY aggregate percentage, which is
# sum(FGM)/sum(FGA) over every player-game he rostered. That number is a function
# of the makes and attempts EXPECTATIONS, so shipping the primitives lets a
# consumer aggregate correctly and shipping a per-game percentage would force it
# to aggregate wrongly. The package's job ends at the primitives.
#
# TOV IS NOT SIGN-FLIPPED. turnovers are a category a manager wants to LOSE, and
# that is a scoring fact the backend's zScoreRank already owns. An honest
# expectation of 2.4 turnovers is the same object as an honest expectation of 2.4
# rebounds; inverting it here would mean every consumer had to know which of the
# nine columns had been pre-negated.
RATE_TARGETS: tuple[str, ...] = (
    "PTS", "AST", "REB", "STL", "BLK", "TOV", "FG3M", "FGM", "FGA", "FTM", "FTA",
)

# the pre-9-cat pair, kept under its own name. the production tournament
# (ml/experiments/production_tournament) pre-registered its bracket over exactly
# these two stats and its verdict binds only them; a reader of that report needs
# to be able to see which list it was scoped to without diffing git history.
# NOT used by the serving path - it is a label on a closed decision.
TOURNAMENT_RATE_TARGETS: tuple[str, ...] = ("PTS", "AST")

# ---- per-stat EWMA halflife for the production rates ----
# THE ONE PLACE A HALFLIFE MAY BE NAMED, and the reason it is a dict rather than
# the single EWMA_HALFLIFE constant it used to be.
#
# PTS and AST are FROZEN at 5 by the production tournament's verdict
# (ml/experiments/production_tournament/TOURNAMENT.md): every challenger,
# including halflife 12, failed the pre-registered 2% improvement floor, so the
# incumbent stays and the decision is one-look and closed for feature version v3.
# Re-tuning them here would be re-rolling a pre-registered test until it passed.
#
# The NINE NEW STATS have no incumbent and therefore no such constraint. Each
# one's halflife was selected on INNER folds strictly inside each origin's own
# training window - never on the origin's validation rows - over the grid
# {3, 5, 8, 12, 20}, and one winner per stat was fixed for the shipped artifact.
# See MODEL.md section 9.2 for the per-stat inner-fold evidence.
#
# THE EXPECTED SHAPE OF THE ANSWER, stated before the numbers so it can be wrong:
# a halflife is a bet about how fast the quantity being smoothed actually moves
# relative to how noisily it is observed. A rare event observed a handful of
# times a game (STL, BLK, FG3M) has enormous per-game sampling noise around a
# fairly stable underlying rate, so it should want a LONG memory. A
# volume-driven stat tied to role (FGA, MIN-like) moves when the role moves and
# should want a shorter one. Where the inner folds could not separate two
# halflives, the default is 5 - the incumbent's value - and MODEL.md says which
# stats those were rather than presenting a coin flip as a finding.
# THE SELECTED VALUES (20260818). the right-hand comment on each new stat is how
# many of the five origins' inner folds picked it, which is the number the
# consistency half of the rule turns on.
RATE_HALFLIVES: dict[str, float] = {
    # FROZEN by the production tournament. its inner folds agree with the
    # tournament's own finding - 12 is the best grid value for both, by 0.69% and
    # 0.55% respectively - and both are far short of the pre-registered 2% floor,
    # so the incumbent stands and this file does not get to relitigate it.
    "PTS": 5.0,
    "AST": 5.0,
    # LONG MEMORY, unanimously. rebounds, turnovers and made threes are all
    # event counts whose per-game sampling noise is large relative to how fast the
    # underlying rate actually moves, and 20 was the best value in 5 of 5 origins
    # for each of them. This is the predicted shape of the answer and it held.
    "REB": 20.0,   # 5/5 origins, +1.02% vs halflife 5
    "TOV": 20.0,   # 5/5 origins, +1.84% vs halflife 5
    "FG3M": 20.0,  # 5/5 origins, +1.13% vs halflife 5
    # the same prediction taken to its limit: for steals, the best member of the
    # grid was 20 in 5 of 5 origins AND the memoryless career expanding mean beat
    # even that. See RATE_ESTIMATORS - STL is the one stat that ships without an
    # EWMA at all, and this 20 is recorded for the audit trail rather than used.
    "STL": 20.0,   # 5/5 origins, +1.78% vs halflife 5, then beaten by expanding
    # a moderate memory, 4 of 5 origins each. free-throw volume is a role
    # property that moves more slowly than shot volume but faster than a
    # rebounding rate, which is where 12 sits.
    "FTM": 12.0,   # 4/5 origins, +0.59% vs halflife 5
    "FTA": 12.0,   # 4/5 origins, +0.61% vs halflife 5
    # AMBIGUOUS. all three had a nominal grid winner longer than 5 and none of
    # them cleared both bars: BLK's best (12) won 1 origin of 5 and bought 0.30%;
    # FGM's best (20) won 2 of 5 and bought 0.92%; FGA's best (8) won 3 of 5 but
    # bought only 0.26%. Each falls through to the package default and the report
    # says so rather than presenting the smallest of six numbers within noise of
    # each other as a finding.
    #
    # BLK is the one honest surprise: it is the rarest event in the vocabulary and
    # the argument above predicts a long memory for it, which is not what the
    # inner folds show. The prediction is recorded as made and as not confirmed.
    "BLK": 5.0,    # ambiguous -> default
    "FGM": 5.0,    # ambiguous -> default
    "FGA": 5.0,    # ambiguous -> default
}

# which smoother produces each stat's per-minute rate. the FIRST champion per new
# stat, chosen the same way every other champion in this package was: the dumbest
# defensible baseline (a career expanding mean of the per-minute ratio) against
# the incumbent family (an EWMA at the selected halflife), over identical rows,
# identical origins, identical minutes model. "ewma" and "expanding" are the only
# two members - no trained rate model is in this bracket at all, because the
# production tournament just spent a full pre-registered pass establishing that
# trained rate models do not pay for PTS and AST and there is no reason to expect
# a scarcer stat to behave better.
#
# ONE STAT SHIPS THE BASELINE. Steals is the only member of the vocabulary where
# the career expanding mean of the per-minute rate beat the best EWMA on the grid
# (0.7026 vs 0.7067 pooled inner-fold MAE, and it was the per-origin winner in all
# five origins). That is not an embarrassment for the EWMA family, it is the
# limiting case of the same story the halflife-20 stats tell: a steal rate is
# close to constant over a career and almost all of a single game's steal count is
# noise, so the estimator that throws away the least history wins. It is recorded
# here rather than being quietly rounded to "halflife 20, near enough".
RATE_ESTIMATORS: dict[str, str] = {
    **dict.fromkeys(RATE_TARGETS, "ewma"),
    "STL": "expanding",
}

# ---- coherence constraints on the emitted expectations ----
# (bounded, bound): the emitted value of ``bounded`` is clipped to at most the
# emitted value of ``bound``, IN THIS ORDER, so the chain FG3M <= FGM <= FGA
# settles in one pass.
#
# WHY THIS IS NEEDED AT ALL, given that the constraint holds in every single game
# ever played. Each stat's rate is smoothed independently, and once two stats
# carry DIFFERENT halflives their EWMAs are different weighted averages of the
# same history - so the pointwise inequality FGM_g <= FGA_g does not survive
# averaging. (At a common halflife it does: same weights, same rows, and a
# weighted mean is monotone. That is worth stating because it means the clip
# frequency is a direct measurement of what per-stat halflife selection costs in
# coherence, and evaluate.py reports it as one.) The league-rate fallbacks are a
# second, smaller source: a player with no FGA history and some FGM history takes
# two numbers from two different places.
#
# The clip is applied at SERVING time, to every emitted row, on the conditional
# expectation, the unconditional expectation and each quantile level
# independently. Clipping quantile levels pairwise is a per-level coherence
# statement and NOT a claim about the joint distribution: it says the P90 of FGM
# does not exceed the P90 of FGA, which is the property a rendered player card
# needs, and says nothing about P(FGM > FGA) on any single night.
COHERENCE_CONSTRAINTS: tuple[tuple[str, str], ...] = (
    ("FGM", "FGA"),
    ("FG3M", "FGM"),
    ("FTM", "FTA"),
)

# the denominator floor, in minutes. the ratio is stat / max(minutes, floor), NOT
# stat / minutes. rationale: a 2-minute cameo in which a player hits one three is
# a real 1.5 pts/min observation and an absurd rate to carry forward - EWMA'd
# over a handful of such nights it projects 45 points in 30 minutes. flooring the
# denominator at 4 caps a single-possession cameo's implied rate at
# (3 / 4) = 0.75 pts/min, roughly the 99th percentile of real per-minute scoring,
# while leaving every genuine rotation night (minutes >= 4) untouched. 4 is
# hand-set from that reasoning, not tuned; it is a bound on nonsense, not a
# parameter with an optimum.
RATE_MINUTES_FLOOR: float = 4.0

# ---- teammate context: the vacated-resource family (feature_version v2) ----
# the largest gap the first external review named, and the first one where the
# features describe the GAME rather than the player: "a 30-minute creator is out
# tonight" is true of every one of his teammates' rows and false of nobody's.
#
# the possession-cost weight on a free-throw trip, from the standard box-score
# possession approximation FGA + 0.44 x FTA + TOV. 0.44 rather than 0.5 because
# not every pair of free throws ends a possession (and-ones, technicals,
# three-shot fouls); it is the league-standard constant, not a fitted one.
FT_POSSESSION_WEIGHT: float = 0.44

# a player needs this many as-of appearances before his usage rate is allowed to
# define the team's usage hierarchy (star_out / top3_usage_out_count). without a
# gate, a rookie's three-game 40% usage EWMA makes him the team's "star" and
# every teammate's star_out flag becomes noise. 15 is hand-set: enough games that
# an EWMA with halflife 5 has forgotten its own initialisation, and few enough
# that the hierarchy is identified by December.
#
# the gate counts CAREER appearances (``n_appearances``), matching the scope of
# ``usg_ewma`` itself - the usage EWMA is career-scoped like every other EWMA in
# the package, so gating it on season-to-date appearances would reject a
# ten-year veteran in October whose usage estimate is the most reliable on the
# roster.
STAR_USAGE_MIN_APPEARANCES: int = 15

# how many of the team's highest-usage players top3_usage_out_count watches. the
# reviews warned explicitly against per-teammate one-hots and lineup
# combinatorics; a count over a fixed small set is the cheap summary that keeps
# the signal without the dimensionality.
TOP_USAGE_N: int = 3

# players.position holds comma-joined strings ("PG,SG", "SF,PF", "C"). the FIRST
# listed position is the primary one, and the three buckets below are what the
# feature family aggregates over. finer granularity than G/F/C would split the
# absent-teammate set into groups too small to carry a signal - a team-game has
# ~4 absences in total.
POSITION_GROUPS: dict[str, str] = {
    "PG": "G", "SG": "G", "G": "G",
    "SF": "F", "PF": "F", "F": "F",
    "C": "C",
}
POS_GROUP_ORDER: tuple[str, ...] = ("G", "F", "C")

# ---- teammate magnitudes: the shrunk career-scoped rolling window (v3) ----
# WHAT CHANGED AND WHY. v2 attached each absent teammate's SEASON-TO-DATE mean
# minutes (``std_MIN``) as his vacated magnitude. Two problems the round-2 review
# named, and one it did not:
#
#   1. COLD START. On 20 October a season-to-date mean is one game long. A player
#      whose opener was a 6-minute blowout cameo contributes 6 vacated minutes on
#      21 October, and a ten-year starter who sat the opener contributes 0. The
#      season boundary throws away the only history that could fix either.
#   2. TRADES AND RETURNS. A season-to-date mean resets at the boundary but not at
#      a trade, so it silently mixes two roles; and a player returning from a long
#      absence carries a mean from a role he no longer has.
#   3. NOISE. An unshrunk mean over n games has variance ~ sigma^2/n, and the sum
#      over ~4 absent teammates compounds it.
#
# v3 uses a CAREER-SCOPED rolling window over the last MAGNITUDE_WINDOW appearance
# games - crossing season boundaries, exactly as ``roll10_MIN`` and every EWMA in
# the package already do, on the two-scope as-of join machinery features.py
# already has - and then SHRINKS it toward a fixed prior:
#
#       m = w * rolling_mean + (1 - w) * prior,     w = n / (n + MAGNITUDE_SHRINK_K)
#
# where n is the number of appearances actually in the window. That is the standard
# empirical-Bayes shrinkage weight; it is 0 for a player with no history (so he
# contributes the prior, not a NaN and not a 0) and ->1 for an established one.
MAGNITUDE_WINDOW: int = 20

# the shrinkage constant, in games. HAND-SET, not tuned, and the reasoning is the
# same shape as RATE_MINUTES_FLOOR's: k is the number of games at which the
# rolling mean and the prior get equal weight (w = 1/2 at n = k). 10 puts the
# half-way point at roughly a fifth of a season - late enough that a three-game
# fluke cannot define a player's magnitude, early enough that a rotation player is
# ~2/3 his own numbers by American Thanksgiving. It is a bound on cold-start
# nonsense, not a parameter with an optimum, and it is recorded in every
# registry entry so a future tuned value shows up as a diff.
MAGNITUDE_SHRINK_K: float = 10.0

# the priors each magnitude shrinks toward. HAND-SET league-shape constants, NOT
# means computed from the dataset: a prior fitted on the whole four seasons would
# put a small amount of every future game into every past row's features, which is
# precisely the kind of quiet leakage this phase exists to remove. The values are
# deliberately replacement-level rather than league-average, because the players
# whose magnitude is mostly prior are by construction the ones with almost no
# history - two-way call-ups and rookies - not median NBA players.
#   MIN 10.0  a fringe rotation night
#   FGA  6.0  ~0.6 shots per minute at 10 minutes, a low-usage bench line
#   USG 15.0  five men on the floor share 100%, so 20 is average FOR A STARTER;
#             15 is the shape of a bench player's usage
MAGNITUDE_PRIORS: dict[str, float] = {"MIN": 10.0, "FGA": 6.0, "USG": 15.0}

# the as-of magnitude columns the expected-context sums multiply. not model
# features themselves - they are per-teammate inputs, summed over a set - except
# for the reliability columns derived from them.
MAGNITUDE_COLS: tuple[str, ...] = ("tm_MIN", "tm_FGA", "tm_USG")

# ---- the served teammate context: EXPECTATIONS over as-of probabilities (v3) ----
# every column here is a linear functional of the teammates' play probabilities
# p_j and their as-of magnitudes m_j, and nothing else. No target-game outcome of
# any player enters any of them. The two rank columns use linearity of expectation
# over indicator variables, so no independence assumption is needed:
#
#   E[vacated_minutes_i] = sum_{j != i} (1 - p_j) * m_j
#   E[depth_rank_i]      = 1 + sum_{j != i} p_j * 1(m_j > m_i)
#   P(star_out_i)        = sum_{j != i} 1(j is the usage leader) * (1 - p_j)
#   E[top3_out_i]        = sum_{j != i} 1(j in top 3 by usage) * (1 - p_j)
#
# E[depth_rank] is an expectation, not the rank of an expectation: the summand is
# p_j (the probability teammate j is AVAILABLE and ahead of me), and E of a sum of
# indicators is the sum of their probabilities whatever their joint distribution.
# It is therefore no longer an integer, which is a feature and not a defect - "1.4"
# says the player is usually the leading available option and occasionally second.
TEAMMATE_EXPECTED_COLS: list[str] = [
    "exp_vacated_minutes",
    "exp_vacated_fga",
    "exp_vacated_usg",
    "exp_vacated_minutes_pos",
    "exp_depth_rank",
    "exp_depth_rank_pos",
    "p_star_out",
    "exp_top3_usage_out",
]

# ---- the ORACLE comparator: the v2 realized-absence family ----
# STILL COMPUTED, NEVER SERVED. These are the columns whose value depends on other
# players' target-game labels. They stay on the dataset for exactly one purpose:
# they are the Level-D comparator in the evaluation bracket, the upper bound on
# what perfect pre-tipoff lineup information would be worth. They are also what
# ``config.EVENT_COHORTS`` partitions on, so a v1 / v3 / v2-oracle comparison
# splits the validation rows identically in all three passes.
#
# They are NOT in FEATURE_COLS. ``tests/test_teammates.py`` pins their oracle
# semantics and ``tests/test_teammates_v3.py`` pins that they FAIL the
# teammate-outcome invariance test the served columns pass.
TEAMMATE_ORACLE_COLS: list[str] = [
    "vacated_minutes",
    "vacated_fga",
    "vacated_usg",
    "vacated_minutes_pos",
    "depth_rank_available",
    "depth_rank_available_pos",
    "star_out",
    "top3_usage_out_count",
]

# ---- reliability / cold-start features (v3) ----
# the review's cold-start item, made visible to the model rather than only handled
# by shrinkage. Shrinkage decides WHAT number to use when history is thin; these
# columns tell the estimator THAT history is thin, so it can discount the whole
# expected-context block for a team of call-ups in week 1 instead of trusting a
# sum of priors as if it were a sum of measurements.
RELIABILITY_FEATURE_COLS: list[str] = [
    # effective sample size behind the row's OWN magnitude: appearances in the
    # rolling window, 0..MAGNITUDE_WINDOW.
    "magnitude_ess",
    # the absence-weighted mean effective sample size behind this row's expected
    # vacated aggregate. "the 30 vacated minutes I am being told about rest on 18
    # games of evidence" and "...on 2" are different claims.
    "teammate_magnitude_ess",
    # as-of appearances in the CURRENT season. n_appearances is career-scoped and
    # cannot distinguish a veteran in October from a veteran in April.
    "season_appearances",
    # prior scheduled team-games with this team, career-scoped. the trade-context
    # feature MODEL.md listed as a [GAP]; derived from the universe itself rather
    # than from player_team_stints, which needs no new source and cannot disagree
    # with the rows being modelled.
    "games_with_current_team",
    # no appearance in ANY strictly-earlier season. computed backward-only, so a
    # player who is rostered in season S and does not debut until S+1 still reads
    # rookie for his season-S rows.
    "is_rookie",
    # this row's team differs from the first team he was rostered with this season.
    "is_traded",
]

# the model features this family contributes, in the SERVED contract. listed
# separately from FEATURE_COLS so evaluate.py can run the ladder with and without
# them and report the delta, which is the only way a "did the new features help"
# claim is checkable.
TEAMMATE_FEATURE_COLS: list[str] = [
    "usg_ewma",
    *TEAMMATE_EXPECTED_COLS,
    *RELIABILITY_FEATURE_COLS,
]

# ---- event cohorts for evaluation ----
# the minutes tiers answer "where in the league does the model do well". these
# answer the question a teammate-absence feature actually has to face: does it
# help on the nights it is about, and does it leave the quiet nights alone. the
# third one is a CONTROL, not a target - a feature family that improves
# high-absence games by hurting ordinary ones has not helped.
EVENT_COHORTS: tuple[tuple[str, str, str, float], ...] = (
    ("event: vacated_minutes >= 30", "vacated_minutes", ">=", 30.0),
    ("event: star_out = 1", "star_out", ">=", 1.0),
    ("control: vacated_minutes < 5", "vacated_minutes", "<", 5.0),
)
EVENT_COHORT_ORDER: tuple[str, ...] = tuple(label for label, *_ in EVENT_COHORTS)

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

# the pre-v2 feature list, verbatim. it is named rather than derived by subtraction
# because it is the BASE model's feature contract as well as the v1 comparator, and
# the base model's whole job is to be provably free of teammate context. A list
# defined as "FEATURE_COLS minus some things" would acquire a teammate feature the
# moment someone added one to FEATURE_COLS and forgot to add it to the subtraction.
BASE_FEATURE_COLS: list[str] = (
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

FEATURE_COLS: list[str] = BASE_FEATURE_COLS + TEAMMATE_FEATURE_COLS

# ---- the P2 CANDIDATE contract (feature_version v4), not served ----
# v3 plus the matchup / blowout / stakes / start-rate families, in that order, with
# the v3 columns kept in their existing positions. Appending rather than
# interleaving is deliberate: `sha256("\n".join(FEATURE_COLS))` is the frozen
# contract digest, and a candidate built by reordering the v3 list would make the
# diff between the two contracts unreadable.
#
# THIS LIST IS NOT `FEATURE_COLS`. Nothing in the serving path reads it, no artifact
# is fitted against it, and `FEATURE_VERSION` is still "v3". Promoting it means
# assigning it to FEATURE_COLS, bumping FEATURE_VERSION to
# CANDIDATE_FEATURE_VERSION, retraining, and executing the MODEL.md 13.2 re-freeze -
# four steps, none of which happen by importing this module.
FEATURE_COLS_V4: list[str] = FEATURE_COLS + V4_FEATURE_COLS

# ---- the evaluation bracket: three feature sets over identical rows ----
# the round-2 review's finding, made measurable. v1 is the no-teammate-context
# floor; v2-oracle is what perfect pre-tipoff lineup information buys (and is a
# function of other players' target-game labels, so it is an upper bound and not a
# forecast); v3-honest is what survives honest construction and is the only one
# that ships. The interval [v3-honest, v2-oracle] relative to v1 is the answer to
# "how much of the v2 gain was real".
#
# v2-oracle is EXACTLY the historical v2 list, so its numbers are directly
# comparable to the ones MODEL.md section 5.1 published. v3-honest additionally
# carries the reliability columns, because the served set is the thing worth
# bracketing and the cold-start fix ships with the probabilistic one; the report
# says so rather than pretending the contrast is one-variable.
FEATURE_SETS: dict[str, list[str]] = {
    "v1": list(BASE_FEATURE_COLS),
    "v3-honest": list(FEATURE_COLS),
    "v2-oracle": BASE_FEATURE_COLS + ["usg_ewma"] + TEAMMATE_ORACLE_COLS,
    # P2's candidate. ADDED, so `FEATURE_SETS["v1"]` and `FEATURE_SETS["v3-honest"]`
    # are byte-identical to what the freeze test checks, and the P2 bracket is
    # `v3-honest` vs `v4` over identical rows with one difference.
    "v4": list(FEATURE_COLS_V4),
}
SERVED_FEATURE_SET = "v3-honest"
ORACLE_FEATURE_SET = "v2-oracle"
CANDIDATE_FEATURE_SET = "v4"

# ---- stage 1/2 of the two-stage pipeline: the base availability model ----
# THE LEAKAGE-SAFE CONSTRUCTION, and the reason it needs two stages at all.
# The expected-context features are functions of p_j. If p_j came from a model
# whose training window contained row j, then row i's feature encodes a fitted
# view of j's own label, and the leak is back - one indirection further away and
# correspondingly harder to see. So:
#
#   stage 1  fit an availability model on BASE_FEATURE_COLS only. No teammate
#            context of any kind, expected or realized.
#   stage 2  produce STRICTLY out-of-fold p_j for EVERY scheduled row by a
#            TIME-SAFE CROSS-FIT: partition the history into consecutive calendar
#            blocks, and for each block fit the base model on rows strictly before
#            the block and score the block. A row's p therefore never depends on
#            any game at or after its own block start, which is at or before its
#            own game date. Every p carries that block start as its cutoff and
#            models.validate_out_of_fold enforces it, exactly as it does for
#            P(play) and E[minutes|plays].
#   stage 3  build the expected-context columns from those p.
#   stage 4  fit the final availability and minutes models on them. ONE iteration:
#            the final availability model's own probabilities are never fed back
#            into the context features.
#
# Why blocks rather than a per-origin refit: a per-origin base model trained
# strictly before the validation window is out of fold for the VALIDATION rows and
# hopelessly in-fold for the TRAINING rows, whose context features the final model
# is fitted on. The cross-fit is the only scheme that is out of fold on both sides
# at once, and it is a forward-chaining scheme rather than a random K-fold
# precisely so that no p ever reads the future.
CROSS_FIT_FREQ = "MS"  # calendar-month starts

# a block whose training window is smaller than this is not modelled - the base
# model would be fitted on a few hundred rows and its probabilities would be worse
# than the shifted appearance rate. Those rows fall back to the STAGE-0 BASELINE
# probability (avail_rate_10, itself shifted and as-of safe, with
# CONTEXT_P_PRIOR where even that is null), which is a weaker p and not a leaky
# one. The fallback share is reported by the dataset build.
CROSS_FIT_MIN_TRAIN_ROWS: int = 5_000

# the stage-0 fallback probability for rows with no appearance history at all.
# HAND-SET at roughly the league-wide share of scheduled player-games that end in
# an appearance; it is a prior, not an estimate, and it is a constant so that it
# cannot silently become a mean over the evaluation window.
CONTEXT_P_PRIOR: float = 0.70

# the column the expected-context features are built from, and its cutoff stamp.
P_CONTEXT = "P_CONTEXT"
P_CONTEXT_CUTOFF = "P_CONTEXT_CUTOFF"

# outcome columns that must never appear in FEATURE_COLS.
#
# LISTED_INACTIVE is in here and it is the most important entry: on this truth
# layer it is the exact complement of PLAYED (see teammates.py), so handing it to
# the availability model would be handing it the answer. it is carried on the
# universe row anyway because the ABSENCE SET of the target game is what the
# vacated-resource features aggregate over - for the player's TEAMMATES, never
# for himself.
#
# the TEAM_* game totals are outcomes too: they are the target game's team
# box score, used only as the historical denominator of a shifted usage EWMA.
#
# P2 adds two: the target game's final margin and the blowout label derived from
# it. They are on the dataset because the blowout classifier has to be TRAINED on
# them and because the descriptive cohorts want to be checkable against realized
# blowouts - and they are declared outcomes here so that the same test that pins
# "no target column is a feature" covers the candidate contract too.
TARGET_COLS: frozenset[str] = frozenset(
    {"PLAYED", "MIN", "PTS", "AST", "REB", "FGA", "FGM", "FTA", "STL", "BLK", "TOV",
     "FG3M", "FTM", "TEAM_PTS", "TEAM_PTS_ALLOWED", "LISTED_INACTIVE",
     "TEAM_MIN", "TEAM_FGA", "TEAM_FTA", "TEAM_TOV",
     BLOWOUT_TARGET, BLOWOUT_MARGIN_COL}
)

AVAILABILITY_TARGET = "PLAYED"
# the stats predict.py composes and emits. identical to RATE_TARGETS by
# construction rather than by coincidence: a stat that has a per-minute rate is a
# stat the composition can serve, and a second hand-maintained list is a second
# place for the two to drift apart.
PRODUCTION_TARGETS: tuple[str, ...] = RATE_TARGETS
MINUTES_TARGET = "MIN"

# ---- promoted path ----
# spike finding: availability is the only strongly learnable target. the
# conditional production estimate ships as EWMA(halflife 5); ridge and lightgbm
# stay implemented as challengers and are never promoted automatically.
# minutes promoted to lightgbm 2026-08-17: on the full four-season truth-layer
# dataset it beats EWMA by 2.1% MAE, consistent across all five rolling
# origins (reports/20260817.md) — past the ~2% noise line our own report set.
# production stays EWMA: ridge's ~0.8% edge is inside noise.
#
# "composition" is a fourth family and a different kind of decision from the
# other three. it does not name an estimator; it names how the promoted
# estimators are combined into an unconditional number. it was promoted from
# ``decomposed_p_x_ewma`` to ``decomposed_p_x_minutes_x_ppm`` on 2026-08-17 on a
# CORRECTNESS argument, not a metric one: the two score the same to within noise
# (4.005 vs 4.007 MAE over five origins) but only the second one is a function of
# predicted minutes. under P(play) x EWMA(stat), a backup whose minutes model
# says 30 kept the points EWMA of his 14-minute nights, and no amount of minutes
# signal could reach the stat. parity on the aggregate metric is the expected
# result and is not the reason for the change.
CHAMPIONS: dict[str, str] = {
    "availability": "lightgbm",
    "minutes": "lightgbm",
    "production": "ewma",
    "composition": "decomposed_p_x_minutes_x_ppm",
}
CHALLENGERS: dict[str, tuple[str, ...]] = {
    "availability": ("logistic",),
    "minutes": ("ewma", "ridge"),
    "production": ("ridge", "lightgbm"),
    "composition": ("decomposed_p_x_ewma", "decomposed_p_x_lightgbm", "direct_lightgbm"),
}

# how much worse than the previous composition the promoted one is allowed to be
# before the report calls it a regression rather than parity. the package's own
# noise line is ~2%; 1% is deliberately tighter, because a composition change
# should not cost accuracy at all.
COMPOSITION_PARITY_TOLERANCE: float = 0.01

# ---- cutoff policy ----
# a prediction run may only use games that finished strictly before the run's
# own timestamp. training cutoffs follow the same rule so that a backtest and a
# live run see the same shape of history.
CUTOFF_POLICY = "prediction-run timestamp; features use games strictly before it"

# ---- forecast horizons ----
# a projection is not one number, it is a number AND how long before tipoff it
# was made. the same model scoring the same game at T-24h and at T-60m is making
# two different claims, because the second one has seen the injury report and the
# first one has not. naming the horizons makes that difference recordable, and
# recordable is the precondition for ever measuring it: "our T-60m projections
# beat our T-24h projections by X" is a question the store can answer only if
# every run says which one it was.
#
# the label is stamped into prediction_runs.notes (migration 014 has no horizon
# column and does not need one - notes is free text and the run row is
# append-only, so the label cannot drift after the fact) and into the registry's
# prediction_runs list. the values are the nominal offsets from tipoff; they are
# labels, not schedulers - nothing here enforces when a run actually executes.
# CORRECTED 2026-08-17 (P1b). the previous definitions asserted what each horizon
# "typically knows", and the ``early`` row was simply wrong: it said "no injury
# report yet". The NBA's own participation-report policy requires an INITIAL report
# by 5pm local the day before the game, so a run made 24 hours before a 7pm tipoff
# has usually had a report available for two hours. What separates the horizons is
# not report / no report; it is WHICH report and HOW STALE.
#
# So a horizon is defined by the ACTUAL OFFSET WINDOW between the run's
# information boundary and tipoff, and a run's horizon eligibility is a fact about
# that measured offset rather than a label someone typed:
#
#     every report captured STRICTLY BEFORE the actual cutoff is admissible;
#     the horizon is the bucket the measured hours-to-tip falls into.
#
# (lo, hi] in hours before tipoff. ``lock`` is closed at 0 and open above; the
# buckets partition (0, inf) so every run lands in exactly one.
HORIZON_WINDOWS: dict[str, tuple[float, float]] = {
    "lock": (0.0, 2.0),        # after final status changes; the last report wins
    "gameday": (2.0, 12.0),    # morning of; the initial report exists and has been updated
    "early": (12.0, 48.0),     # night before; the INITIAL report usually exists already
}

# the nominal centre of each window, kept because it is what the run row has always
# recorded and what a human reads. it is a label on the bucket, not the definition.
HORIZONS: dict[str, str] = {
    "early": "T-24h",
    "gameday": "T-6h",
    "lock": "T-60m",
}
DEFAULT_HORIZON = "gameday"

# WHAT A RUN MUST STORE for the horizon question ("do our T-60m projections beat
# our T-24h ones?") to be answerable later. A label alone cannot answer it: two
# runs both tagged ``early`` can differ by 20 hours of report freshness, and the
# one that beats the other may simply have been made later.
#
# every key is written into the registry's per-run entry (and, for the scalar ones,
# into prediction_runs.notes) by predict.py:
#
#   hours_to_tip_min/median/max  measured offset from the run's information
#                                boundary to each game's tipoff. a range, not a
#                                point: one run scores a whole slate and a 4pm game
#                                and a 10:30pm game are different horizons.
#   latest_report_at             captured_at of the newest report the run used.
#   report_age_hours             boundary minus latest_report_at. the staleness
#                                number; a 3-day-old "out" and a 20-minute-old
#                                "out" are different claims.
#   report_count                 how many admissible reports existed at all. zero
#                                is the honest record of "the model stood alone",
#                                and it is not the same fact as "nobody was hurt".
#   first_deadline_passed        whether the boundary is after 5pm local on the day
#                                BEFORE the earliest game on the slate, i.e.
#                                whether the league's initial-report deadline had
#                                passed. this is the flag that makes ``early``
#                                interpretable: an ``early`` run before the
#                                deadline genuinely has no report, one after it
#                                does, and the two are not comparable.
#   horizon_measured             the bucket HORIZON_WINDOWS assigns from the
#                                median hours-to-tip, next to the requested label,
#                                so a mislabelled run is visible in a diff.
HORIZON_RUN_METADATA: tuple[str, ...] = (
    "hours_to_tip_min",
    "hours_to_tip_median",
    "hours_to_tip_max",
    "latest_report_at",
    "report_age_hours",
    "report_count",
    "first_deadline_passed",
    "horizon_measured",
)

# the league's initial participation-report deadline, as a local-time hour on the
# day before the game. used only to compute ``first_deadline_passed``.
INITIAL_REPORT_DEADLINE_HOUR: int = 17


def horizon_label(horizon: str) -> str:
    """'gameday' -> 'gameday (T-6h)'. raises on an unknown horizon name."""
    if horizon not in HORIZONS:
        raise ValueError(
            f"unknown forecast horizon {horizon!r}; expected one of "
            f"{', '.join(sorted(HORIZONS))}"
        )
    return f"{horizon} ({HORIZONS[horizon]})"


def horizon_for_offset(hours_to_tip: float) -> str:
    """the horizon bucket a MEASURED offset falls into, or '' if it falls outside.

    the operational half of the corrected definition: a run does not get to assert
    its horizon, it gets to record its offset and be assigned one. an offset at or
    below zero (the run boundary is after tipoff) and an offset beyond the widest
    window both return '' rather than being clamped into the nearest bucket - "this
    run is not any of our named horizons" is a fact worth keeping.
    """
    if not (hours_to_tip > 0):
        return ""
    for name, (lo, hi) in HORIZON_WINDOWS.items():
        if lo < hours_to_tip <= hi:
            return name
    return ""


def resolve_cutoff(run_at: pd.Timestamp | str | None = None) -> pd.Timestamp:
    """normalise a prediction-run timestamp into the training/feature cutoff."""
    ts = pd.Timestamp.now("UTC") if run_at is None else pd.Timestamp(run_at)
    if ts.tzinfo is not None:
        ts = ts.tz_convert("UTC").tz_localize(None)
    return ts.normalize()


# ---- rolling-origin evaluation schedule: the DEVELOPMENT ORIGINS ----
# forward chaining, no random splits. train is everything strictly before the
# validation window; all of the first season is therefore always in training.
#
# these five windows are where every champion decision was made. the months after
# them (Feb-2026 .. Apr-2026) are the SELECTION HOLDOUT: never used to choose a
# model, but present in the deployment fit, because the shipped artifact is refit
# through 2026-04-14. that makes them selection-untouched, NOT untouched - the only
# genuinely untouched evaluation this system will have is the PROSPECTIVE TEST, the
# 2026-27 season. see MODEL.md section 6, which states the four windows explicitly
# after an earlier version of that document claimed both things at once.
ORIGINS: list[tuple[str, str, str]] = [
    ("O1 valid=2024-12", "2024-12-01", "2024-12-31"),
    ("O2 valid=2025-01", "2025-01-01", "2025-01-31"),
    ("O3 valid=2025-02", "2025-02-01", "2025-02-28"),
    # 2025-26 origins, added once the four-season prod backfill landed
    ("O4 valid=2025-12", "2025-12-01", "2025-12-31"),
    ("O5 valid=2026-01", "2026-01-01", "2026-01-31"),
]

# ---- the P2 DEVELOPMENT origin set: the five above PLUS a late-season sixth ----
# ORIGINS IS NOT MODIFIED. `tests/test_teammates_v3.py` pins `len(ORIGINS) == 5` and
# every champion decision in sections 5, 11 and 12 was made on exactly those five,
# so a sixth entry in that list would silently redefine what "the five origins" in
# every published table means. DEV_ORIGINS is the superset the P2 bracket runs on;
# see LATE_SEASON_ORIGIN above for why the sixth window is March-April **2025** and
# not 2026.
DEV_ORIGINS: list[tuple[str, str, str]] = [*ORIGINS, LATE_SEASON_ORIGIN]

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


# the halflife grid the nine new rate targets were selected over, on inner folds
# strictly inside each origin's training window. the same five values the
# production tournament pre-registered for PTS/AST, so a per-stat number here and
# a tournament number there are directly comparable rather than merely similar.
RATE_HALFLIFE_GRID: tuple[float, ...] = (3.0, 5.0, 8.0, 12.0, 20.0)

# what a stat falls back to when the inner folds cannot separate two halflives.
# the incumbent's value, on purpose: "the evidence did not distinguish these, so
# the stat keeps the package's existing constant" is a defensible default, and
# picking the numerically-smallest MAE out of five noise-separated numbers is not.
RATE_HALFLIFE_DEFAULT: float = EWMA_HALFLIFE


def rate_halflife(target: str) -> float:
    """the selected EWMA halflife for one production rate.

    a function rather than a bare dict read so that every consumer - features,
    models, train, evaluate and the tournament's compatibility path - resolves an
    unlisted stat the same way instead of each inventing its own fallback.
    """
    return float(RATE_HALFLIVES.get(target, RATE_HALFLIFE_DEFAULT))


def rate_estimator(target: str) -> str:
    """'ewma' or 'expanding': which smoother produces this stat's rate."""
    kind = RATE_ESTIMATORS.get(target, "ewma")
    if kind not in ("ewma", "expanding"):
        raise ValueError(
            f"unknown rate estimator {kind!r} for {target}; expected 'ewma' or "
            f"'expanding'"
        )
    return kind


# ---------------------------------------------------------------------------
# THE FROZEN PROSPECTIVE PROTOCOL — 2026-27
# ---------------------------------------------------------------------------
# WHAT THIS BLOCK IS. Everything this package has measured is RETROSPECTIVE: the
# out-of-fold discipline is real, but WE chose the questions after seeing the era.
# The 2026-27 season is the first genuinely prospective test, and it is only a
# prospective test if the protocol was written down BEFORE opening night and never
# edited afterwards. MODEL.md section 13 is that pre-registration; this block is its
# MACHINE-CHECKABLE half, and ``tests/test_prospective_freeze.py`` is the enforcement
# mechanism.
#
# THE RULE, and it is the only rule that matters here: this dict is a snapshot of the
# served configuration taken on 2026-08-17, NOT a second definition of it. Every
# mirrored value (champions, halflives, estimators, override constants, horizon
# windows, the feature-list digest) is duplicated from the live constants ON PURPOSE
# so that a change to a live constant makes the test suite red. A red suite is the
# signal to bump ``protocol_version`` to ``prospective_2026_27_v2`` and re-freeze
# section 13 — never to edit these values back into agreement.
#
# THIS BLOCK IS NOT READ BY THE SERVING PATH. predict.py reads halflives and
# estimators out of the ARTIFACT, exactly as section 12.6 requires. Wiring serving
# through here would turn a pre-registration into a configuration source, and the two
# must not be the same object.
PROSPECTIVE_PROTOCOL_VERSION = "prospective_2026_27_v1"

# the frozen artifact, by content. sha256 of every file in ``models/20260818/``.
# the test recomputes them from disk.
#
# CORRECTED 2026-08-24, and this is a record fix, not a re-freeze. the original
# feature_gain.csv / metadata.json values were copied from a registry snapshot
# taken before those two files reached the bytes the freeze commit (6450c32)
# actually pinned, so they never described anything in git and the daily
# predictions preflight refused every run. the four model/state files matched
# all along, metadata.json's own artifact checksums name exactly the pinned
# joblib bytes, and every content assertion in test_prospective_freeze.py
# passes against the protocol - the served configuration never moved, so no
# emitted number changes and MODEL.md 13.2 does not require a version bump.
PROSPECTIVE_ARTIFACT_CHECKSUMS: dict[str, str] = {
    "availability_model.joblib":
        "aa62f880f6774537ab58ba52d0aa4e641c96964ca3d26691e9ab7dd52180f06c",
    "base_availability_model.joblib":
        "3d5fcdeb180f4e8c6650b9c3542d4ef1714401f4048a3d14605de7747262adba",
    "ewma_state.parquet":
        "bcc83dec9e55375645f80165df6f490c6056d9659215bde497d31ced99943328",
    "feature_gain.csv":
        "f2765c542b452e1ff8726be27e556c0a1a4a7b323b503ca2cdd01dc191728b94",
    "metadata.json":
        "24978b3261261ad52d28cae7e7fceee6378655d20e515c26882391545adae3fe",
    "minutes_model.joblib":
        "2fd13615d64ba1d62e33bc903cfa4851ff63b602f2a2dec4e96af9343f28115a",
}

# EXACTLY THREE SCHEDULED LOOKS. (name, look date, minimum scheduled rows for the
# look to be BINDING). The date is the cutoff: a look scores every game with
# GAME_DATE strictly before it. The row minimum is ~80% of the expected count at
# that point in the season (9,457 / 25,219 / 38,159 at 30.02 modelled rows per
# game); a look that falls short is REPORTED and NON-BINDING, and its binding
# decision moves to the next look rather than being taken on thin data.
#
# The All-Star date is a FIXED CALENDAR DATE rather than "the break", because the
# break is not a labelled event in ``nba_schedule`` and a look date that depends on a
# lookup is a look date that can be argued about after the fact.
PROSPECTIVE_LOOKS: tuple[tuple[str, str, int], ...] = (
    ("dec1", "2026-12-01", 7_500),
    ("all_star", "2027-02-15", 20_000),
    ("season_end", "2027-04-20", 32_000),
)
PROSPECTIVE_LOOK_DATES: tuple[str, ...] = tuple(d for _, d, _ in PROSPECTIVE_LOOKS)

# the label stamped into ``prediction_runs.notes``. A run without it is not part of
# the prospective test, whatever else it did.
PROSPECTIVE_RUN_NOTE_LABEL = "prospective_2026_27_v1"

# the per-prediction flag P5 implements. Rows inside the window are NOT excluded from
# any endpoint - excluding them would be a post-hoc filter on the hardest games - they
# are a mandatory secondary reporting axis.
PROSPECTIVE_COLD_START_FLAG = "cold_start"

# the flag window runs past October on purpose. MAGNITUDE_SHRINK_K = 10 means a
# player is only ~2/3 his own numbers at ten appearances, which teams reach in late
# November; the window is tied to that constant rather than to a calendar month.
PROSPECTIVE_COLD_START_THROUGH = "2026-11-30"

# what P5's October replay gate replays: October 2025, with the FROZEN artifact and a
# per-date cutoff, no refit. Its acceptance criteria are frozen in MODEL.md 13.7.
PROSPECTIVE_OCTOBER_REPLAY_WINDOW: tuple[str, str] = ("2025-10-01", "2025-10-31")

# the shadow comparators. Same cutoffs, same slates, same store, different
# ``feature_set`` label on the run.
PROSPECTIVE_SHADOW_FEATURE_SETS: tuple[str, ...] = ("v1",)

# the ops horizon every slate must be served at (best effort; see MODEL.md 13.8).
# a literal, not ``DEFAULT_HORIZON``, for the reason the frozen block below states.
PROSPECTIVE_SERVING_HORIZON = "gameday"

# the frozen feature contract's version tag. Literal, so bumping FEATURE_VERSION
# fails the suite instead of silently redefining what was frozen.
PROSPECTIVE_FEATURE_VERSION = "v3"
PROSPECTIVE_MODEL_VERSION = "20260818"

# sha256 of "\n".join(FEATURE_COLS). A digest rather than a copy of the list: the
# thing being frozen is "the feature contract did not move", and a 51-element literal
# in this file would be a second place for the contract to live.
PROSPECTIVE_FEATURE_COLS_SHA256 = (
    "914cdc17c25ee9cb32b072f254691a625472b43ecb37b3da0c23483f165e1b6e"
)
PROSPECTIVE_N_FEATURES = 51

# THE FROZEN SERVING CONFIGURATION, as LITERALS. It matters that these are typed out
# rather than written ``dict(CHAMPIONS)``: a mirror that reads the live constant
# agrees with it by construction and can never fail, which is the exact opposite of
# what a freeze is for. Every entry below is a hand-copied snapshot, and
# ``tests/test_prospective_freeze.py`` compares each one against the live module.
PROSPECTIVE_CHAMPIONS: dict[str, str] = {
    "availability": "lightgbm",
    "minutes": "lightgbm",
    "production": "ewma",
    "composition": "decomposed_p_x_minutes_x_ppm",
}
PROSPECTIVE_RATE_TARGETS: tuple[str, ...] = (
    "PTS", "AST", "REB", "STL", "BLK", "TOV", "FG3M", "FGM", "FGA", "FTM", "FTA",
)
PROSPECTIVE_RATE_HALFLIVES: dict[str, float] = {
    "PTS": 5.0, "AST": 5.0, "REB": 20.0, "TOV": 20.0, "FG3M": 20.0, "STL": 20.0,
    "FTM": 12.0, "FTA": 12.0, "BLK": 5.0, "FGM": 5.0, "FGA": 5.0,
}
PROSPECTIVE_RATE_ESTIMATORS: dict[str, str] = {
    "PTS": "ewma", "AST": "ewma", "REB": "ewma", "STL": "expanding", "BLK": "ewma",
    "TOV": "ewma", "FG3M": "ewma", "FGM": "ewma", "FGA": "ewma", "FTM": "ewma",
    "FTA": "ewma",
}
PROSPECTIVE_HORIZON_WINDOWS: dict[str, tuple[float, float]] = {
    "lock": (0.0, 2.0),
    "gameday": (2.0, 12.0),
    "early": (12.0, 48.0),
}
PROSPECTIVE_COHERENCE_CONSTRAINTS: tuple[tuple[str, str], ...] = (
    ("FGM", "FGA"), ("FG3M", "FGM"), ("FTM", "FTA"),
)

# the override policy constants, as literals. NOT imported from ``overrides`` -
# ``overrides`` imports ``models`` which imports this module, so a real import would
# be circular, and a frozen copy is what we want anyway: the test compares this
# literal against the live ``overrides.DEFAULT_POLICY`` and fails on any drift.
PROSPECTIVE_OVERRIDE_CONSTANTS: dict[str, float] = {
    "out_probability": 0.02,
    "doubtful_probability": 0.10,
    "questionable_model_weight": 0.6,
    "questionable_prior": 0.60,
    "probable_model_weight": 0.85,
    "probable_shift": 0.15,
}

# the falsification thresholds of MODEL.md 13.5, in machine-readable form.
# ``direction`` says which way a FAILURE lies:
#   "lower_is_better" - the endpoint is a relative delta where more negative is
#                       better; the look FAILS if the observed value is ABOVE the
#                       threshold.
#   "higher_is_better" - the look FAILS if the observed value is BELOW it.
# ``None`` means the look is report-only for that endpoint: at that sample size the
# test has no power and pretending otherwise would be the opposite of the point.
# Every number here is derived in MODEL.md 13.5 from the five-origin block standard
# deviation of the same quantity; none is invented.
PROSPECTIVE_FALSIFICATION: dict[str, dict[str, object]] = {
    "availability_brier_v3_vs_v1": {
        "direction": "lower_is_better",
        "retrospective": -1.892,
        "block_sd": 1.724,
        "thresholds": {"dec1": 1.00, "all_star": -0.40, "season_end": -0.75},
    },
    "minutes_mae_v3_vs_v1": {
        "direction": "lower_is_better",
        "retrospective": -0.807,
        "block_sd": 0.580,
        "thresholds": {"dec1": 0.50, "all_star": -0.30, "season_end": -0.40},
    },
    "pts_uncond_mae_v3_vs_v1": {
        "direction": "lower_is_better",
        "retrospective": -0.319,
        "block_sd": 0.282,
        "thresholds": {"dec1": 0.30, "all_star": 0.00, "season_end": -0.10},
    },
    "ninecat_aggregate_vs_ewma_total": {
        "direction": "higher_is_better",
        "retrospective": 1.295,
        "block_sd": 0.202,
        "thresholds": {"dec1": 0.50, "all_star": 0.50, "season_end": 0.50},
    },
    "minutes_mae_vs_ewma_baseline": {
        "direction": "higher_is_better",
        "retrospective": 2.986,
        "block_sd": 0.518,
        "thresholds": {"dec1": 2.00, "all_star": 2.00, "season_end": 2.00},
    },
    "availability_brier_skill_vs_shifted_rate": {
        "direction": "higher_is_better",
        "retrospective": 0.3516,
        "block_sd": 0.0151,
        "thresholds": {"dec1": 0.25, "all_star": 0.25, "season_end": 0.25},
    },
    "stl_expanding_vs_h20_ewma": {
        "direction": "higher_is_better",
        "retrospective": 2.082,
        "block_sd": 0.855,
        "thresholds": {"dec1": None, "all_star": 1.00, "season_end": 1.00},
    },
    "rare_event_h20_vs_expanding": {
        "direction": "higher_is_better",
        "retrospective": -0.797,
        "block_sd": 0.500,
        "thresholds": {"dec1": None, "all_star": None, "season_end": 0.00},
    },
    # calibration is TWO-SIDED, so it takes three entries rather than one: a slope
    # of 0.6 and a slope of 1.6 are both miscalibrated and a single bound would
    # catch only one of them. `_ceiling` and `_abs_intercept` are declared
    # "lower_is_better" because a FAILURE lies above their thresholds.
    "availability_calibration_slope_floor": {
        "direction": "higher_is_better",
        "retrospective": None,
        "block_sd": None,
        "thresholds": {"dec1": None, "all_star": None, "season_end": 0.85},
    },
    "availability_calibration_slope_ceiling": {
        "direction": "lower_is_better",
        "retrospective": None,
        "block_sd": None,
        "thresholds": {"dec1": None, "all_star": None, "season_end": 1.20},
    },
    "availability_calibration_abs_intercept": {
        "direction": "lower_is_better",
        "retrospective": None,
        "block_sd": None,
        "thresholds": {"dec1": None, "all_star": None, "season_end": 0.25},
    },
    "override_layer_brier_increment": {
        "direction": "higher_is_better",
        "retrospective": None,
        "block_sd": None,
        "thresholds": {"dec1": None, "all_star": 0.00, "season_end": 0.00},
    },
}

# the October replay gate's acceptance criteria (MODEL.md 13.7). Ratios of the
# October window's metric to the same replay's non-October metric. Derived from the
# measured fringe-tier ratios in the section-5.1 bracket (Brier 0.1022/0.0720 =
# 1.42x, minutes 4.991/4.679 = 1.07x): October may be as bad as our worst-served
# minutes tier and no worse.
PROSPECTIVE_OCTOBER_GATE: dict[str, float] = {
    "max_brier_ratio": 1.42,
    "max_minutes_mae_ratio": 1.15,
    "min_prediction_coverage": 0.99,
}

# ONE DICT, so a consumer (a look script, a report header, a run's provenance block)
# can serialise the whole pre-registration without knowing the names above.
PROSPECTIVE_2026_27: dict[str, object] = {
    "protocol_version": PROSPECTIVE_PROTOCOL_VERSION,
    "frozen_at": "2026-08-17",
    "season": "2026-27",
    "model_version": PROSPECTIVE_MODEL_VERSION,
    "feature_version": PROSPECTIVE_FEATURE_VERSION,
    "artifact_dir": "models/20260818",
    "artifact_checksums": PROSPECTIVE_ARTIFACT_CHECKSUMS,
    "looks": PROSPECTIVE_LOOKS,
    "look_dates": PROSPECTIVE_LOOK_DATES,
    "run_note_label": PROSPECTIVE_RUN_NOTE_LABEL,
    "cold_start_flag": PROSPECTIVE_COLD_START_FLAG,
    "cold_start_through": PROSPECTIVE_COLD_START_THROUGH,
    "october_replay_window": PROSPECTIVE_OCTOBER_REPLAY_WINDOW,
    "october_gate": PROSPECTIVE_OCTOBER_GATE,
    "shadow_feature_sets": PROSPECTIVE_SHADOW_FEATURE_SETS,
    "serving_horizon": PROSPECTIVE_SERVING_HORIZON,
    "champions": PROSPECTIVE_CHAMPIONS,
    "rate_targets": PROSPECTIVE_RATE_TARGETS,
    "rate_halflives": PROSPECTIVE_RATE_HALFLIVES,
    "rate_estimators": PROSPECTIVE_RATE_ESTIMATORS,
    "coherence_constraints": PROSPECTIVE_COHERENCE_CONSTRAINTS,
    "override_constants": PROSPECTIVE_OVERRIDE_CONSTANTS,
    "horizon_windows": PROSPECTIVE_HORIZON_WINDOWS,
    "feature_cols_sha256": PROSPECTIVE_FEATURE_COLS_SHA256,
    "n_features": PROSPECTIVE_N_FEATURES,
    "falsification": PROSPECTIVE_FALSIFICATION,
}


# ---------------------------------------------------------------------------
# derived from the freeze, and deliberately BELOW it (P5)
# ---------------------------------------------------------------------------
# THIS IS NOT A FROZEN CONSTANT. It is a function OF one, and the distinction is
# the whole reason it sits under the bundle rather than inside it: nothing here
# introduces a number, so nothing here can drift from MODEL.md section 13. The
# freeze owns ``PROSPECTIVE_COLD_START_THROUGH``; this owns only the arithmetic of
# comparing a game date to it, which every consumer would otherwise reimplement.


def is_cold_start(
    game_date: object, through: str = PROSPECTIVE_COLD_START_THROUGH
) -> "pd.Series | bool":
    """MODEL.md 13.7's flag: is this game inside the cold-start window.

    Accepts a scalar date or anything ``pd.to_datetime`` understands elementwise,
    and returns a bool or a boolean Series to match. Comparison is on the
    NORMALISED date, so a row carrying a tipoff timestamp of 2026-11-30 19:30 is
    still inside a window that ends "on or before 2026-11-30" - an hour of the
    evening must not decide which side of a reporting split a game falls on.

    DERIVABLE FROM THE SCHEDULE ALONE. No target, no outcome, no model: the flag
    is knowable the moment the schedule is published, which is what makes it a
    legitimate reporting axis rather than a post-hoc filter. It does not gate any
    feature and it excludes no row from any headline number (13.7).
    """
    boundary = pd.Timestamp(through).normalize()
    if isinstance(game_date, (pd.Series, pd.Index)) or (
        hasattr(game_date, "__len__") and not isinstance(game_date, str)
    ):
        dates = pd.to_datetime(pd.Series(game_date), errors="coerce").dt.normalize()
        # a row with no readable game date is NOT flagged: the flag asserts
        # "this game is inside the window", and an unreadable date supports no
        # such assertion in either direction.
        return dates.notna() & (dates <= boundary)
    stamp = pd.Timestamp(game_date)
    return bool(pd.notna(stamp)) and pd.Timestamp(stamp).normalize() <= boundary
