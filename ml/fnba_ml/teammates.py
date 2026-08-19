"""teammate context: usage rate, expected vacated resources (v3), and the v2
realized family kept as the oracle comparator.

THE GAP THIS CLOSES. every feature in v1 describes the player: his own recent
minutes, his own scoring rate, his own availability history. None of them knows
that the 34-minute creator beside him is out tonight. Both external reviews put
this first, and for the same reason: fantasy value swings hardest exactly where
the model was blindest, on bench and fringe players whose minutes are a function
of who else is unavailable rather than of anything in their own history.

WHAT THE ROUND-2 REVIEW FOUND, and it was right. The v2 family summed magnitudes
over the set of teammates who DID NOT PLAY in the target game. Self-exclusion
stopped player i's own label reaching player i's own features. It did nothing
about the other direction: player i's ``vacated_minutes`` is an exact function of
player j's target-game PLAYED label, for every teammate j. That is cross-player
leakage, and no amount of self-exclusion closes it, because the label being read
is not the row's own. Consequences, stated without hedging:

  * every v2 number in MODEL.md section 5.1 is a VALUE-OF-PERFECT-LINEUP-
    INFORMATION result. It is what the final inactive list is worth, not what a
    forecast is worth, and it cannot be earned at any horizon before the list
    exists - not even at ``lock``, because at lock the list is known but the
    training rows' lists were used to build the training features too.
  * the fix is not a tighter as-of rule. There is no time at which "who did not
    play tonight" is knowable in advance. The realized indicator has to be
    replaced by its expectation.

THE v3 CONTRACT. every served column is a linear functional of teammates'
AS-OF play probabilities and AS-OF magnitudes:

    E[vacated_minutes_i] = sum_{j != i} (1 - p_j) * m_j
    E[depth_rank_i]      = 1 + sum_{j != i} p_j * 1(m_j > m_i)
    P(star_out_i)        = sum_{j != i} 1(j leads the team in usage) * (1 - p_j)

no target-game outcome of any player - the row's own or anyone else's - appears
anywhere in that arithmetic. The rank identity is linearity of expectation over
indicator variables, so it needs NO independence assumption between teammates'
availabilities: E[sum of indicators] = sum of their probabilities whatever the
joint distribution. (A rank is not a linear function of the indicators, but its
EXPECTATION is a linear function of their expectations, which is the only thing
being claimed.)

WHERE p_j COMES FROM, and why it is two stages. p_j must itself be free of
teammate context, or the fix is circular, and it must be out of fold for row j, or
the leak returns one indirection removed. :mod:`fnba_ml.models`
``cross_fit_base_probabilities`` fits a base availability model on
``config.BASE_FEATURE_COLS`` - no teammate features, expected or realized - over
forward-chaining calendar blocks, so every row's p is produced by a model trained
strictly before that row's block. Each p carries its block start as a cutoff and
``validate_out_of_fold`` enforces it, exactly as it does for P(play).

MAGNITUDES ARE SHRUNK AND CAREER-SCOPED (v3). v2 used season-to-date MPG, which is
one game long in late October and resets at a season boundary but not at a trade.
v3 uses a rolling window over the last ``MAGNITUDE_WINDOW`` appearances across
season boundaries, shrunk toward a hand-set replacement-level prior with weight
n/(n+k). See ``config.MAGNITUDE_*`` for the constants and the reasoning.

THE v2 FAMILY IS STILL HERE, and that is deliberate. :func:`vacated_features`
computes it, the dataset carries it, and ``config.EVENT_COHORTS`` partitions on
it - so a v1 / v3-honest / v2-oracle comparison splits the validation rows
identically. It is NOT in ``config.FEATURE_COLS`` and it is never served. Its role
is to be the upper bound in the bracket: the distance from v1 to v2-oracle is what
perfect lineup information would buy, and the distance from v1 to v3-honest is what
we actually get.

THE ORIGINAL v2 CONTRACT, kept because the oracle columns still obey it:

    the absent-teammate SET comes from the TARGET game.
    the MAGNITUDES attached to each absent teammate are AS-OF (strictly prior).

So ``vacated_minutes`` for a row is "sum, over the teammates who did not play in
THIS game, of the minutes-per-game each of them had established BEFORE this
game". Getting the second half backwards would let a teammate's tonight-
performance into the row on top of his tonight-availability, which is a second
leak layered on the first.

SELF-EXCLUSION IS STILL A BOUNDARY, in both families. A player's own absence is
the availability TARGET; it must never reach his own features. Every aggregate
here is built as ``group_total - own_contribution``, which is exact rather than
approximately right. In v3 the quantity subtracted is ``(1 - p_i) * m_i`` rather
than a realized indicator, so the property holds for the same arithmetic reason
and ``tests/test_teammates_v3.py`` pins it with a closed-form sensitivity check.

WHY NO ONE-HOTS. The reviews warned specifically against per-teammate indicators
and lineup combinatorics. Nine columns, all of them sums or ranks over a set,
is the whole family. A 500-column "is teammate X out" matrix has more parameters
than a season has games.

VECTORISATION. 147k rows x ~35 teammates each. Everything below is a groupby
transform or a single sort; there is no per-row Python and no per-team-game loop.
The whole family costs a couple of seconds on the four-season dataset.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import (
    CONTEXT_P_PRIOR,
    EWMA_HALFLIFE,
    FT_POSSESSION_WEIGHT,
    MAGNITUDE_PRIORS,
    MAGNITUDE_SHRINK_K,
    MAGNITUDE_WINDOW,
    POS_GROUP_ORDER,
    RATE_MINUTES_FLOOR,
    STAR_USAGE_MIN_APPEARANCES,
    TEAMMATE_EXPECTED_COLS,
    TEAMMATE_FEATURE_COLS,
    TEAMMATE_ORACLE_COLS,
    TOP_USAGE_N,
)

log = logging.getLogger(__name__)

USAGE_COLUMN = "usg_ewma"

# the shrunk career-scoped magnitude columns and the per-game quantity each one
# averages. USG has no raw column - it is computed by :func:`usage_share` - so it is
# keyed by the name of the intermediate this module creates.
MAGNITUDE_SOURCES: dict[str, str] = {"MIN": "tm_MIN", "FGA": "tm_FGA", "USG": "tm_USG"}
MAGNITUDE_ESS = "magnitude_ess"

# the expected-context sums and the magnitude each one is weighted by. mirrors
# VACATED_SOURCES, one level of indirection removed: v2 multiplied a magnitude by a
# realized 0/1, v3 multiplies the same magnitude by (1 - p).
EXPECTED_SOURCES: dict[str, str] = {
    "tm_MIN": "exp_vacated_minutes",
    "tm_FGA": "exp_vacated_fga",
    "tm_USG": "exp_vacated_usg",
}

# the reliability column derived from the teammates' own sample sizes.
TEAMMATE_ESS = "teammate_magnitude_ess"

# the season-to-date magnitudes each absent teammate contributes, and the column
# each sum lands in. std_MIN / std_FGA are the existing season-scoped expanding
# means over APPEARANCES - i.e. minutes and shots PER GAME PLAYED, the standard
# reading of "MPG" - and they are already as-of joined by the time this module
# runs. usg_ewma is career-scoped, like every other EWMA here.
VACATED_SOURCES: dict[str, str] = {
    "std_MIN": "vacated_minutes",
    "std_FGA": "vacated_fga",
    USAGE_COLUMN: "vacated_usg",
}

# a usage percentage above this is arithmetically possible and physically absurd
# (a 4-minute stint in which a player takes six shots and turns it over twice).
# the minutes floor already caps most of it; this is the backstop.
USAGE_CEILING = 100.0


# ---------------------------------------------------------------------------
# 1. the player's own usage rate
# ---------------------------------------------------------------------------
def usage_share(frame: pd.DataFrame) -> pd.Series:
    """the standard box-score usage approximation, per game, as a percentage.

        USG% = 100 x (FGA + 0.44 x FTA + TOV) x (TeamMIN / 5)
                     ---------------------------------------
                     MIN x (TeamFGA + 0.44 x TeamFTA + TeamTOV)

    ``(TeamMIN / 5)`` rather than 48 because overtime exists: a team's total
    minutes are 240 in regulation and 265 in a single overtime, and dividing by
    five recovers the length of the game in minutes whatever it was.

    THE DENOMINATOR MINUTES ARE FLOORED at ``RATE_MINUTES_FLOOR``, for exactly the
    reason the per-minute production rates floor theirs: a two-minute cameo in
    which a player takes two shots is a real 60% usage observation and a useless
    number to carry forward. The floor is on the denominator, so the cameo still
    contributes at the rate a four-minute stint would have implied rather than
    being dropped - which matters most for the fringe players whose history is
    mostly cameos.

    returns NaN where the team totals are missing (a source with no team
    possession columns) or where the team recorded no possessions at all, rather
    than a zero that would read as "took no shots".
    """
    needed = ("FGA", "FTA", "TOV", "MIN", "TEAM_MIN", "TEAM_FGA", "TEAM_FTA", "TEAM_TOV")
    missing = [c for c in needed if c not in frame.columns]
    if missing:
        log.warning("cannot compute usage: frame is missing %s", ", ".join(missing))
        return pd.Series(np.nan, index=frame.index, dtype=float)

    player_poss = (
        frame["FGA"].astype(float)
        + FT_POSSESSION_WEIGHT * frame["FTA"].astype(float)
        + frame["TOV"].astype(float)
    )
    team_poss = (
        frame["TEAM_FGA"].astype(float)
        + FT_POSSESSION_WEIGHT * frame["TEAM_FTA"].astype(float)
        + frame["TEAM_TOV"].astype(float)
    )
    minutes = frame["MIN"].astype(float).clip(lower=RATE_MINUTES_FLOOR)
    team_minutes = frame["TEAM_MIN"].astype(float)

    denominator = minutes * team_poss
    usage = 100.0 * player_poss * (team_minutes / 5.0) / denominator
    usage = usage.where(denominator > 0)
    usage = usage.where(team_minutes > 0)
    return usage.replace([np.inf, -np.inf], np.nan).clip(lower=0.0, upper=USAGE_CEILING)


def usage_rate_features(universe: pd.DataFrame) -> pd.DataFrame:
    """career-scoped EWMA of per-game usage, ready to be as-of joined.

    A FOURTH AS-OF JOIN. The row set is appearances with minutes > 0 - the same
    set the per-minute production rates ride - and it would be cheaper to bolt
    this column onto that frame. It is deliberately separate: those columns are
    documented and tested as NOT model features (composition inputs only), and
    ``usg_ewma`` is a model feature. Sharing a frame would make the distinction a
    comment rather than a structure.

    as-of safety: the EWMA is INCLUSIVE of the current appearance, exactly like
    every other rolling window in :mod:`fnba_ml.features`. The shift is supplied
    by the ``allow_exact_matches=False`` as-of join in ``build_features``. This
    frame on its own is not shifted and must never be joined on equality.
    """
    app = universe[(universe["PLAYED"] == 1) & (universe["MIN"] > 0)].copy()
    app = app.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)

    app["_usg_game"] = usage_share(app)
    app[USAGE_COLUMN] = (
        app.groupby("PLAYER_ID")["_usg_game"]
        .transform(lambda s: s.ewm(halflife=EWMA_HALFLIFE, adjust=True).mean())
    )
    return (
        app[["PLAYER_ID", "GAME_DATE", USAGE_COLUMN]]
        .sort_values("GAME_DATE")
        .reset_index(drop=True)
    )


# ---------------------------------------------------------------------------
# 1b. the shrunk career-scoped teammate magnitudes (v3)
# ---------------------------------------------------------------------------
def shrink(raw: pd.Series, n: pd.Series, prior: float, k: float = MAGNITUDE_SHRINK_K):
    """``w * raw + (1 - w) * prior`` with ``w = n / (n + k)``.

    the empirical-Bayes weight, and the only piece of the cold-start fix that is a
    formula rather than a window length. Two boundary behaviours are load-bearing:

      * ``n = 0`` gives ``w = 0`` and returns the prior exactly. A player with no
        appearance history contributes a replacement-level magnitude, not a NaN
        that would poison his whole team-game's sum and not a 0 that would read as
        "vacates nothing".
      * a NULL ``raw`` also returns the prior. That is the same case arriving by a
        different route - a player whose window contains appearances but no usable
        usage observation, say - and it must not become NaN either.

    the prior is a CONSTANT from config, never a mean over the frame: a prior
    fitted on the data being featurised puts a little of every future game into
    every past row.
    """
    weight = n.astype(float) / (n.astype(float) + float(k))
    weight = weight.where(np.isfinite(weight), 0.0)
    shrunk = weight * raw.astype(float) + (1.0 - weight) * float(prior)
    return shrunk.where(raw.notna(), float(prior))


def magnitude_features(universe: pd.DataFrame) -> pd.DataFrame:
    """career-scoped shrunk rolling magnitudes, ready to be as-of joined.

    A FIFTH AS-OF JOIN, and it replaces a dependency rather than adding one: the v2
    expected magnitudes were ``std_MIN`` / ``std_FGA`` off the SEASON-scoped join
    plus ``usg_ewma`` off the career one. All three now come from one career-scoped
    frame over the last ``MAGNITUDE_WINDOW`` appearances, which is what makes the
    three magnitudes commensurable - a season-scoped minutes magnitude next to a
    career-scoped usage magnitude was two different notions of "recently".

    the row set is APPEARANCES (``PLAYED == 1``). The usage magnitude additionally
    needs minutes > 0 to be meaningful, so a 0-minute appearance contributes NaN to
    the usage window and is skipped by the rolling mean, while still counting as an
    appearance for minutes and shots. That asymmetry is why ``magnitude_ess`` is
    defined on the appearance count and not per column: one sample-size number that
    is right for minutes and slightly optimistic for usage beats three columns
    nobody reads.

    as-of safety: every window here is INCLUSIVE of the current appearance, exactly
    like ``player_appearance_features``. The shift is supplied by the
    ``allow_exact_matches=False`` as-of join in ``build_features``. This frame on
    its own is not shifted and must never be joined on equality.
    """
    app = universe[universe["PLAYED"] == 1].copy()
    app = app.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)

    # usage needs the team possession denominator; a 0-minute appearance has no
    # meaningful share of it
    app["_usg_game"] = usage_share(app).where(app["MIN"].astype(float) > 0)

    # the effective sample size behind the window: appearances so far, capped at the
    # window length. inclusive of the current one, like the windows themselves.
    app[MAGNITUDE_ESS] = np.minimum(
        app.groupby("PLAYER_ID").cumcount() + 1, MAGNITUDE_WINDOW
    ).astype(float)

    cols = ["PLAYER_ID", "GAME_DATE", MAGNITUDE_ESS]
    for stat, column in MAGNITUDE_SOURCES.items():
        source = "_usg_game" if stat == "USG" else stat
        if source not in app.columns:
            log.warning("no %s column; magnitude %s will be the prior", source, column)
            app[column] = float(MAGNITUDE_PRIORS[stat])
            cols.append(column)
            continue
        raw = app.groupby("PLAYER_ID")[source].transform(
            lambda s: s.rolling(MAGNITUDE_WINDOW, min_periods=1).mean()
        )
        app[column] = shrink(raw, app[MAGNITUDE_ESS], MAGNITUDE_PRIORS[stat])
        cols.append(column)

    return app[cols].sort_values("GAME_DATE").reset_index(drop=True)


# ---------------------------------------------------------------------------
# 1c. reliability / cold-start context (v3)
# ---------------------------------------------------------------------------
def roster_context_features(universe: pd.DataFrame) -> pd.DataFrame:
    """``games_with_current_team``, ``is_traded``, ``is_rookie``: added in place.

    all three are computed directly on the SCHEDULED universe rather than as an
    as-of join, because all three are facts about roster membership rather than
    about performance, and roster membership is known for the target game itself.
    Each one is still strictly backward-looking:

      games_with_current_team  a cumcount over (player, team) in date order, so the
                               first game with a team reads 0 - the count is of
                               PRIOR games, never including this one. career-scoped
                               rather than season-scoped: a player back with a
                               former team genuinely knows the system, and the
                               season reset would call him new.
      is_traded                this row's team differs from the FIRST team he was
                               rostered with this season. the first team is drawn
                               from the earliest row of the player-season, which is
                               at or before every row it labels.
      is_rookie                no APPEARANCE in any strictly-earlier season.
                               computed from a per-(player, season) appearance count
                               shifted one season back, not from "the first season in
                               which he ever appeared" - that version reads the
                               future for a player who is rostered in season S and
                               does not debut until S+1.

    the caller must pass a frame sorted by (PLAYER_ID, GAME_DATE, GAME_ID); the
    returned frame preserves its row order so positional alignment holds.
    """
    out = universe
    out["games_with_current_team"] = (
        out.groupby(["PLAYER_ID", "TEAM_ID"]).cumcount().astype(float)
    )

    first_team = out.groupby(["PLAYER_ID", "SEASON"])["TEAM_ID"].transform("first")
    out["is_traded"] = (out["TEAM_ID"].astype(str) != first_team.astype(str)).astype(float)

    # appearances per (player, season), then the cumulative total over STRICTLY
    # EARLIER seasons. groupby().first() would silently skip nulls here, which is the
    # meta-lesson test_features.py already encodes; a sum over a 0/1 column cannot.
    played = pd.to_numeric(out["PLAYED"], errors="coerce").fillna(0.0)
    per_season = played.groupby([out["PLAYER_ID"], out["SEASON"]]).sum()
    prior_seasons = (
        per_season.groupby(level=0).cumsum() - per_season
    ).rename("prior_season_apps")
    keys = pd.MultiIndex.from_arrays([out["PLAYER_ID"], out["SEASON"]])
    out["is_rookie"] = (
        prior_seasons.reindex(keys).to_numpy() <= 0
    ).astype(float)
    return out


# ---------------------------------------------------------------------------
# 2. the vacated-resource aggregates
# ---------------------------------------------------------------------------
def absence_mask(frame: pd.DataFrame) -> np.ndarray:
    """who is unavailable for this team-game: the union the reviews specified.

    ``LISTED_INACTIVE`` (the official list) OR rostered-with-no-appearance. On the
    status universe these are the same rows - the roster is reconstructed from the
    inactive list plus appearances, so there is no "active but did not play"
    category and the union is a no-op. It is still written as a union because the
    approximation universe has no inactive list at all (the flag is null there),
    and because a future truth layer that ingests active-but-DNP rows should widen
    the set rather than silently keep the narrower one.
    """
    played = pd.to_numeric(frame["PLAYED"], errors="coerce").fillna(0.0).to_numpy() == 0
    if "LISTED_INACTIVE" in frame.columns:
        inactive = (
            frame["LISTED_INACTIVE"].astype("boolean").fillna(False).to_numpy(dtype=bool)
        )
        return played | inactive
    return played


def _group_codes(*keys: pd.Series) -> np.ndarray:
    """dense integer codes for a composite group key, nulls propagating to -1.

    -1 marks "no group" (a null position bucket). Callers must not aggregate over
    it: rows without a bucket get a null positional feature rather than being
    pooled into one giant pseudo-group, which is what a naive fillna would do.
    """
    columns = [k.astype("string").reset_index(drop=True) for k in keys]
    null = np.zeros(len(columns[0]), dtype=bool)
    joined = None
    for column in columns:
        null |= column.isna().to_numpy()
        filled = column.fillna("\x00")
        # vectorised concatenation rather than a row-wise join: the row-wise form
        # is a 147k-iteration python loop and this is called three times per build
        joined = filled if joined is None else joined + "\x1f" + filled
    codes = pd.factorize(joined)[0]
    codes[null] = -1
    return codes


def _sum_excluding_self(
    group: np.ndarray, value: pd.Series, include: np.ndarray
) -> np.ndarray:
    """sum of ``value`` over the group's ``include`` rows, minus this row's own.

    THE SELF-EXCLUSION MECHANISM, and it is exact rather than approximate: the
    row's own contribution is subtracted arithmetically, so no row can influence
    its own feature even when it is itself in the included set. That is what makes
    a player's own absence unable to inflate his own vacated_* values.

    a null magnitude contributes 0. A teammate with no season history has no
    established minutes to vacate, and 0 states that; NaN would poison the whole
    team-game's sum on the strength of one rookie's first night.
    """
    contribution = pd.to_numeric(value, errors="coerce").fillna(0.0).to_numpy()
    contribution = np.where(include, contribution, 0.0)
    total = pd.Series(contribution).groupby(group).transform("sum").to_numpy()
    out = total - contribution
    return np.where(group < 0, np.nan, out)


def _weighted_count_greater(
    group: np.ndarray, value: pd.Series, weight: np.ndarray
) -> np.ndarray:
    """``sum_{j in group, value_j > value_i} weight_j`` for every row i.

    the shared primitive behind both rank families. With ``weight`` a 0/1 eligible
    mask it is a count (the v2 realized rank); with ``weight = p_j`` it is the
    EXPECTED count of available teammates ahead of the row, which is exactly
    E[depth_rank] - 1 by linearity of expectation.

    THE TWO PROPERTIES THAT MAKE IT THE RIGHT SHAPE, and the reason neither family
    is written as ``groupby().rank()``:

      * self-exclusion is automatic - ``value_i > value_i`` is false - so a row's
        own magnitude and a row's own probability cannot change its own rank.
      * it is defined for EVERY row, including rows with zero weight. An absent
        player still gets a depth rank: the rank he WOULD have held among the
        teammates expected to be available. ``rank()`` over a masked column returns
        NaN for those rows, and a feature that is null exactly when a player is out
        is a feature that tells the availability model he is out.

    ties share a value (the "min" convention). Rows with a null value sort below
    every real one rather than being dropped - a player with no history is
    genuinely at the back of the depth chart, and NaN would again be informative
    about the wrong thing. A null weight contributes 0.

    implementation: one stable sort by (group, value descending). Within a group,
    the weight accumulated STRICTLY EARLIER in that order is the weight of rows
    with a strictly greater value, except inside a block of ties. Because weights
    are non-negative that running total is non-decreasing with position, so the
    minimum over a tie block equals its value at the block's first row - a
    groupby-min over (group, value) resolves ties without a second pass.
    """
    n = len(value)
    order = pd.DataFrame({
        "g": group,
        "v": pd.to_numeric(value, errors="coerce").fillna(-np.inf).to_numpy(),
        "w": pd.to_numeric(pd.Series(weight), errors="coerce").fillna(0.0).to_numpy(),
    })
    if (order["w"].to_numpy() < 0).any():
        raise ValueError(
            "negative weights break the tie-block minimum trick: the running total "
            "must be non-decreasing with sort position"
        )
    order = order.sort_values(["g", "v"], ascending=[True, False], kind="stable")
    cumulative = order.groupby("g", sort=False)["w"].cumsum()
    before = cumulative - order["w"]
    order["cnt"] = before.groupby([order["g"], order["v"]]).transform("min")
    counts = order["cnt"].sort_index().to_numpy()
    if len(counts) != n:
        raise ValueError(
            f"rank restore lost rows: {len(counts)} of {n}. the sort round-trip "
            f"relies on a clean positional index"
        )
    return np.where(group < 0, np.nan, counts)


def _count_greater(
    group: np.ndarray, value: pd.Series, eligible: np.ndarray
) -> np.ndarray:
    """``#{j in group : eligible_j and value_j > value_i}``, the v2 realized rank.

    a 0/1-weighted :func:`_weighted_count_greater`. Kept as its own name because
    the oracle family and the usage hierarchy both read as counts, and "count of
    eligible teammates ahead of me" is the sentence the tests assert.
    """
    return _weighted_count_greater(group, value, eligible.astype(float))


def vacated_features(frame: pd.DataFrame) -> pd.DataFrame:
    """the nine teammate-context columns, added to a frame that already has its
    as-of joins done.

    REQUIRED INPUTS, all of which must already be as-of safe on the frame:
    ``std_MIN`` / ``std_FGA`` (season-to-date per-appearance means, season-scoped
    as-of join), ``usg_ewma`` (career-scoped as-of join), ``n_appearances``, plus
    the target-game facts ``PLAYED`` / ``LISTED_INACTIVE`` / ``POS_GROUP`` and the
    team-game key.

    row order is preserved: callers hold arrays positionally aligned to the frame.
    """
    out = frame.copy()
    original_index = out.index
    out = out.reset_index(drop=True)

    for column in ("GAME_ID", "TEAM_ID", "PLAYED"):
        if column not in out.columns:
            raise ValueError(f"vacated_features needs {column!r} on the frame")

    team_game = _group_codes(out["GAME_ID"], out["TEAM_ID"])
    absent = absence_mask(out)
    available = ~absent

    if "POS_GROUP" in out.columns:
        pos_group = _group_codes(out["GAME_ID"], out["TEAM_ID"], out["POS_GROUP"])
    else:
        pos_group = np.full(len(out), -1)

    # --- the three resource sums over absent teammates ---
    for source, target in VACATED_SOURCES.items():
        if source not in out.columns:
            log.warning("no %s on the frame; %s will be null", source, target)
            out[target] = np.nan
            continue
        out[target] = _sum_excluding_self(team_game, out[source], absent)

    # --- the same minutes sum, restricted to the player's own position bucket ---
    # a wing's minutes do not open up because the backup centre is out. null where
    # the player (or the source) has no position.
    if "std_MIN" in out.columns:
        out["vacated_minutes_pos"] = _sum_excluding_self(
            pos_group, out["std_MIN"], absent
        )
    else:
        out["vacated_minutes_pos"] = np.nan

    # --- depth rank among AVAILABLE teammates ---
    if "std_MIN" in out.columns:
        out["depth_rank_available"] = 1.0 + _count_greater(
            team_game, out["std_MIN"], available
        )
        out["depth_rank_available_pos"] = 1.0 + _count_greater(
            pos_group, out["std_MIN"], available
        )
    else:
        out["depth_rank_available"] = np.nan
        out["depth_rank_available_pos"] = np.nan

    # --- the usage hierarchy: is a top creator out ---
    # THE SIGNAL THE REVIEWS EMPHASISED, and the one no minutes-based feature can
    # see: when a team's primary ball-handler sits, the beneficiary is often an
    # already-starting player whose MINUTES barely move while his usage jumps.
    # vacated_usg carries the magnitude; these two carry the shape.
    if USAGE_COLUMN in out.columns and "n_appearances" in out.columns:
        established = (
            out[USAGE_COLUMN].notna()
            & (
                pd.to_numeric(out["n_appearances"], errors="coerce").fillna(0.0)
                >= STAR_USAGE_MIN_APPEARANCES
            )
        ).to_numpy()
        usage_rank = 1.0 + _count_greater(team_game, out[USAGE_COLUMN], established)
        # ties at the top are astronomically unlikely on floats, but "any top-1
        # teammate is out" degrades gracefully where "the top-1 teammate" would
        # have to pick one arbitrarily.
        is_top1 = established & (usage_rank <= 1)
        is_topn = established & (usage_rank <= TOP_USAGE_N)
        out["star_out"] = (
            _sum_excluding_self(team_game, pd.Series(is_top1.astype(float)), absent) > 0
        ).astype(float)
        out["top3_usage_out_count"] = np.clip(
            _sum_excluding_self(team_game, pd.Series(is_topn.astype(float)), absent),
            0.0,
            float(TOP_USAGE_N),
        )
    else:
        log.warning("no %s / n_appearances on the frame; star_out will be null",
                    USAGE_COLUMN)
        out["star_out"] = np.nan
        out["top3_usage_out_count"] = np.nan

    out.index = original_index
    return out


# ---------------------------------------------------------------------------
# 3. the EXPECTED-context aggregates: the served family (v3)
# ---------------------------------------------------------------------------
def expected_vacated_features(
    frame: pd.DataFrame, probability: pd.Series | np.ndarray
) -> pd.DataFrame:
    """the eight served teammate-context columns plus the teammate reliability one.

    ``probability`` is p_j, the as-of probability that the row's own player appears,
    positionally aligned to ``frame``. It must be out of fold for its own row - see
    ``models.cross_fit_base_probabilities`` - and it must come from a model with no
    teammate-context features, or this whole construction is circular.

    REQUIRED INPUTS, all already as-of safe on the frame: the three magnitude
    columns ``tm_MIN`` / ``tm_FGA`` / ``tm_USG``, ``magnitude_ess``,
    ``n_appearances`` (the usage-hierarchy gate), ``POS_GROUP``, and the team-game
    key. NOTE what is NOT required: ``PLAYED``, ``LISTED_INACTIVE``, ``MIN``, or any
    other target-game outcome column. That absence is the point of the module, and
    ``tests/test_teammates_v3.py`` asserts it by flipping outcomes and requiring
    every output to be bit-identical.

    row order is preserved: callers hold arrays positionally aligned to the frame.
    """
    out = frame.copy()
    original_index = out.index
    out = out.reset_index(drop=True)

    for column in ("GAME_ID", "TEAM_ID"):
        if column not in out.columns:
            raise ValueError(f"expected_vacated_features needs {column!r} on the frame")

    p = pd.to_numeric(pd.Series(np.asarray(probability, dtype=float)), errors="coerce")
    if len(p) != len(out):
        raise ValueError(
            f"probability has {len(p)} values for {len(out)} rows; it must be "
            f"positionally aligned to the frame"
        )
    # a null probability is a row the base model could not score. it becomes the
    # prior rather than being dropped: an unscoreable teammate still occupies a
    # roster spot, and NaN would poison the whole team-game's sum.
    p = p.fillna(float(CONTEXT_P_PRIOR)).clip(0.0, 1.0)
    absent_probability = 1.0 - p
    everyone = np.ones(len(out), dtype=bool)

    team_game = _group_codes(out["GAME_ID"], out["TEAM_ID"])
    if "POS_GROUP" in out.columns:
        pos_group = _group_codes(out["GAME_ID"], out["TEAM_ID"], out["POS_GROUP"])
    else:
        pos_group = np.full(len(out), -1)

    # --- the three expected resource sums: E[sum] = sum (1 - p_j) m_j ---
    # the same _sum_excluding_self machinery the realized family uses, with the
    # realized 0/1 replaced by (1 - p). Self-exclusion is exact for the same reason:
    # the row's own (1 - p_i) m_i term is subtracted arithmetically.
    for source, target in EXPECTED_SOURCES.items():
        if source not in out.columns:
            log.warning("no %s on the frame; %s will be null", source, target)
            out[target] = np.nan
            continue
        out[target] = _sum_excluding_self(
            team_game, absent_probability * out[source].astype(float), everyone
        )

    # --- the same minutes sum restricted to the player's own position bucket ---
    if "tm_MIN" in out.columns:
        out["exp_vacated_minutes_pos"] = _sum_excluding_self(
            pos_group, absent_probability * out["tm_MIN"].astype(float), everyone
        )
    else:
        out["exp_vacated_minutes_pos"] = np.nan

    # --- E[depth rank] = 1 + sum_{j != i} p_j 1(m_j > m_i) ---
    # linearity of expectation over indicators; no independence assumption. the
    # result is a real number, not an integer, and that is the informative part:
    # 1.4 means "usually the leading available option, sometimes second".
    if "tm_MIN" in out.columns:
        out["exp_depth_rank"] = 1.0 + _weighted_count_greater(
            team_game, out["tm_MIN"], p.to_numpy()
        )
        out["exp_depth_rank_pos"] = 1.0 + _weighted_count_greater(
            pos_group, out["tm_MIN"], p.to_numpy()
        )
    else:
        out["exp_depth_rank"] = np.nan
        out["exp_depth_rank_pos"] = np.nan

    # --- the usage hierarchy: P(a top creator is out) ---
    # the hierarchy itself is AS-OF and outcome-free in both families - it ranks
    # teammates by their established usage, not by who played. Only the weight
    # changed: 1(j absent) became (1 - p_j).
    if "tm_USG" in out.columns and "n_appearances" in out.columns:
        established = (
            out["tm_USG"].notna()
            & (
                pd.to_numeric(out["n_appearances"], errors="coerce").fillna(0.0)
                >= STAR_USAGE_MIN_APPEARANCES
            )
        ).to_numpy()
        usage_rank = 1.0 + _count_greater(team_game, out["tm_USG"], established)
        is_top1 = established & (usage_rank <= 1)
        is_topn = established & (usage_rank <= TOP_USAGE_N)
        # P(star_out) = 1 - p_star. Written as a self-excluding sum over the top-1
        # indicator rather than a lookup, so the team's own usage leader gets 0 (the
        # honest answer: "a top-usage TEAMMATE is out" is false when that is you) and
        # a tie at the top degrades to a sum rather than an arbitrary pick.
        out["p_star_out"] = np.clip(
            _sum_excluding_self(
                team_game,
                pd.Series(is_top1.astype(float)) * absent_probability,
                everyone,
            ),
            0.0, 1.0,
        )
        out["exp_top3_usage_out"] = np.clip(
            _sum_excluding_self(
                team_game,
                pd.Series(is_topn.astype(float)) * absent_probability,
                everyone,
            ),
            0.0, float(TOP_USAGE_N),
        )
    else:
        log.warning("no tm_USG / n_appearances on the frame; p_star_out will be null")
        out["p_star_out"] = np.nan
        out["exp_top3_usage_out"] = np.nan

    # --- the reliability column: how much evidence is behind the sum above ---
    # absence-weighted mean sample size. "the 30 expected vacated minutes rest on 18
    # games of evidence" and "...on 2" are different claims and the model should be
    # allowed to treat them differently. NaN when nobody is meaningfully expected out,
    # because a mean over an empty set is not 0.
    if MAGNITUDE_ESS in out.columns:
        weighted = _sum_excluding_self(
            team_game,
            absent_probability * out[MAGNITUDE_ESS].astype(float).fillna(0.0),
            everyone,
        )
        mass = _sum_excluding_self(team_game, absent_probability, everyone)
        with np.errstate(invalid="ignore", divide="ignore"):
            out[TEAMMATE_ESS] = np.where(mass > 1e-9, weighted / mass, np.nan)
    else:
        out[TEAMMATE_ESS] = np.nan

    # a rename here and a stale name in config.TEAMMATE_EXPECTED_COLS would produce
    # a dataset whose served feature list silently loses a column and whose models
    # quietly retrain on fewer features. cheap to check, invisible otherwise.
    absent_columns = [c for c in TEAMMATE_EXPECTED_COLS if c not in out.columns]
    if absent_columns:
        raise ValueError(
            f"expected_vacated_features did not produce {', '.join(absent_columns)}; "
            f"config.TEAMMATE_EXPECTED_COLS and this function have drifted apart"
        )

    out.index = original_index
    return out


def teammate_feature_summary(frame: pd.DataFrame) -> pd.DataFrame:
    """null rate and distribution of both families, for the dataset build's stdout.

    the oracle columns are summarised alongside the served ones deliberately: they
    are still on the dataset, and a build in which the served columns are all null
    while the oracle ones look healthy is exactly the failure this block should make
    obvious.
    """
    wanted = [
        *TEAMMATE_FEATURE_COLS,
        *(c for c in TEAMMATE_ORACLE_COLS if c not in TEAMMATE_FEATURE_COLS),
        *(c for c in MAGNITUDE_SOURCES.values()),
    ]
    present = [c for c in wanted if c in frame.columns]
    if not present:
        return pd.DataFrame()
    described = frame[present].describe().T
    described["null_rate"] = frame[present].isna().mean()
    return described[["null_rate", "mean", "std", "min", "50%", "max"]]


def position_group_counts(frame: pd.DataFrame) -> pd.Series:
    """rows per position bucket, including the unmatched ones. build-time sanity."""
    if "POS_GROUP" not in frame.columns:
        return pd.Series(dtype=int)
    counts = frame["POS_GROUP"].fillna("(unknown)").value_counts()
    order = [g for g in POS_GROUP_ORDER if g in counts.index]
    return counts.reindex(order + [i for i in counts.index if i not in order])
