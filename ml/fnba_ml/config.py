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
}
SERVED_FEATURE_SET = "v3-honest"
ORACLE_FEATURE_SET = "v2-oracle"

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
TARGET_COLS: frozenset[str] = frozenset(
    {"PLAYED", "MIN", "PTS", "AST", "REB", "FGA", "FGM", "FTA", "STL", "BLK", "TOV",
     "FG3M", "FTM", "TEAM_PTS", "TEAM_PTS_ALLOWED", "LISTED_INACTIVE",
     "TEAM_MIN", "TEAM_FGA", "TEAM_FTA", "TEAM_TOV"}
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

# the frozen artifact, by content. sha256 of every file in ``models/20260818/``,
# copied from ``models/registry.json``. the test recomputes them from disk.
PROSPECTIVE_ARTIFACT_CHECKSUMS: dict[str, str] = {
    "availability_model.joblib":
        "aa62f880f6774537ab58ba52d0aa4e641c96964ca3d26691e9ab7dd52180f06c",
    "base_availability_model.joblib":
        "3d5fcdeb180f4e8c6650b9c3542d4ef1714401f4048a3d14605de7747262adba",
    "ewma_state.parquet":
        "bcc83dec9e55375645f80165df6f490c6056d9659215bde497d31ced99943328",
    "feature_gain.csv":
        "c72a76ed319ddd72fa8d752b3c0fe2b96eeff119ec851d32b90a1c590d017241",
    "metadata.json":
        "5f54e4c6a8ae176477390a51ba87a365eb2e2668e21be23f2ef3c7c1646936bb",
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
