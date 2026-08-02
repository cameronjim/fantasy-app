"""leakage-safe feature construction, ported from the phase-0 spike.

AS-OF RULE: every feature on the row for game G may use information from
strictly before G. exactly two mechanisms enforce this, and only these two:

  1. ``merge_asof(..., allow_exact_matches=False)`` for anything derived from
     the player's APPEARANCE history. rolling stats are computed on the
     appearance frame inclusive of the current appearance, then as-of joined
     onto the universe picking the last appearance STRICTLY BEFORE the target
     date. the appearance on the target date itself can never be matched.

  2. explicit ``.shift(1)`` before every ``.rolling()``/``.expanding()`` for
     anything computed directly on the universe/schedule frames (availability
     rate, rest days, opponent defensive form).

TWO AS-OF JOINS, NOT ONE. this is the trap the spike hit and fixed: rolling
windows are grouped by PLAYER_ID alone (career scope, may span the offseason)
while season-to-date means are grouped by PLAYER_ID + SEASON. a single join
keyed on PLAYER_ID + SEASON gave returning players NaN form in their first game
of a new season while their second game silently pulled the prior season into
the window. the scope of the join must match the scope of the window.

THREE AS-OF JOINS as of 2026-08-17: the per-minute production rates
(``ewma_<stat>_per_min``) are career-scoped like the rolling windows but are
computed over a narrower row set - appearances with minutes > 0 - so they cannot
ride along on the career frame and need a join of their own.

FOUR AS-OF JOINS with feature_version v2: ``usg_ewma`` rides the same row set as
the per-minute rates and still gets its own join, because those columns are
documented and tested as NOT model features and this one is. See
:mod:`fnba_ml.teammates`.

FIVE AS-OF JOINS with feature_version v3: the shrunk career-scoped teammate
magnitudes (``tm_MIN`` / ``tm_FGA`` / ``tm_USG``) plus their effective sample size.
That join REPLACES a dependency rather than adding one - v2 read its minutes
magnitude off the season-scoped join and its usage magnitude off the career one,
which made "recently" mean two different things in one sum.

TEAMMATE CONTEXT RUNS LAST, after every as-of join, and as of v3 there are two
families of it:

  the SERVED family (``exp_*``, ``p_star_out``) is built from as-of play
  PROBABILITIES and as-of magnitudes. Every input is strictly prior; no
  target-game outcome of any player reaches it. This is what FEATURE_COLS names.

  the ORACLE family (``vacated_*``, ``depth_rank_available*``, ``star_out``,
  ``top3_usage_out_count``) is the v2 construction, kept because it is the
  comparator the evaluation bracket needs and because config.EVENT_COHORTS
  partitions on it. Its absent-teammate SET comes from the target game, so it is a
  function of other players' labels. It is NOT in FEATURE_COLS and is never served.

:mod:`fnba_ml.teammates` explains both contracts; ``tests/test_teammates.py`` pins
the oracle one and ``tests/test_teammates_v3.py`` pins that the served one is
invariant to every teammate outcome while the oracle one is not.

rolling windows over the player's stat history are taken over APPEARANCES only
(a 0-minute non-appearance should not drag the scoring average down), while
availability rate is taken over SCHEDULED games - that is the whole point.

NOT MODEL FEATURES: the per-minute rate columns are deliberately absent from
``config.FEATURE_COLS``. they are inputs to the COMPOSITION (P(play) x E[minutes]
x rate), not predictors handed to an estimator, and keeping them out means adding
them did not change the feature contract the trained artifacts were fit against.
The teammate MAGNITUDES are the same case for a different reason: they are
per-teammate inputs to a sum, not per-row predictors. The expected-context columns
are the opposite case - they ARE predictors, they ARE in FEATURE_COLS, and
replacing the realized family with them is exactly why FEATURE_VERSION moved to v3.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import (
    AVAIL_WINDOWS,
    CONTEXT_P_PRIOR,
    EWMA_HALFLIFE,
    FEATURE_COLS,
    FEATURE_SETS,
    MAGNITUDE_PRIORS,
    OPP_FORM_MIN_PERIODS,
    OPP_FORM_WINDOW,
    P_CONTEXT,
    P_CONTEXT_CUTOFF,
    RATE_MINUTES_FLOOR,
    RATE_TARGETS,
    ROLL_STATS,
    ROLL_WINDOWS,
    TIER_BASIS,
    TIER_EDGES,
    TIER_LABELS,
    UNCOND_STATS,
    UNKNOWN_TIER,
    rate_halflife,
)
from .teammates import (
    MAGNITUDE_ESS,
    MAGNITUDE_SOURCES,
    expected_vacated_features,
    magnitude_features,
    roster_context_features,
    usage_rate_features,
    vacated_features,
)

log = logging.getLogger(__name__)

MIN_APPEARANCES_FOR_HISTORY = 3


def rate_column(target: str) -> str:
    return f"ewma_{target}_per_min"


def expanding_rate_column(target: str) -> str:
    """the BASELINE rate column: a career expanding mean of the per-minute ratio.

    the dumbest defensible per-minute estimator, and the one each of the nine new
    9-cat stats had to beat before its EWMA was allowed to ship. It is computed on
    exactly the same row set, with exactly the same floored denominator and the
    same ``allow_exact_matches=False`` join as ``rate_column``; the ONLY difference
    between the two is the weighting of the history, which is what makes the
    comparison a comparison rather than two loosely related numbers.
    """
    return f"exp_{target}_per_min"


def rate_columns(target: str) -> tuple[str, str]:
    """(ewma column, expanding column) for one production rate."""
    return rate_column(target), expanding_rate_column(target)


def per_minute_rate_features(universe: pd.DataFrame) -> pd.DataFrame:
    """career-scoped EWMA of per-minute production, ready to be as-of joined.

    the composition input. one row per APPEARANCE WITH MINUTES > 0 - a
    non-appearance has no rate, and a recorded appearance of exactly zero minutes
    (a check-in that never happened, or a scrubbed line) carries no information
    about how fast a player scores. those rows are DROPPED rather than imputed:
    imputing them would let a zero-minute night pull a real rate toward zero.

    the ratio is ``stat / max(minutes, RATE_MINUTES_FLOOR)``. the floor is on the
    denominator, not a filter on the rows - see config.RATE_MINUTES_FLOOR for why
    a cameo's raw ratio is unusable and why discarding cameos outright would be
    worse (for a fringe player the cameos are most of the history there is).

    career scope, like ``ewma_<stat>``: joined by PLAYER_ID only, so a player's
    first game of a season still carries last season's rate. that is deliberate -
    per-minute efficiency is far more stable across an offseason than minutes are,
    which is precisely why the decomposition splits them.

    as-of safety: the EWMA here is INCLUSIVE of the current appearance, exactly as
    ``player_appearance_features`` computes its windows. the shift is supplied by
    the ``allow_exact_matches=False`` as-of join in :func:`build_features`. this
    frame on its own is not shifted and must never be joined on equality.
    """
    app = universe[(universe["PLAYED"] == 1) & (universe["MIN"] > 0)].copy()
    app = app.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)

    cols = ["PLAYER_ID", "GAME_DATE"]
    denominator = app["MIN"].clip(lower=RATE_MINUTES_FLOOR)
    for target in RATE_TARGETS:
        if target not in app.columns:
            log.warning("no %s column; skipping its per-minute rate", target)
            continue
        ratio = (app[target] / denominator).groupby(app["PLAYER_ID"])
        # PER-STAT HALFLIFE as of the 9-cat extension. it used to be the single
        # EWMA_HALFLIFE constant for every stat, which was fine when every stat
        # was PTS or AST and both had been selected at 5. A block, a steal and a
        # field-goal attempt are not observed with remotely the same
        # signal-to-noise, and forcing one memory length on all three is a choice
        # nobody made on purpose. config.rate_halflife is the single place the
        # value comes from and MODEL.md section 9.2 is the evidence.
        ewma_col = rate_column(target)
        halflife = rate_halflife(target)
        app[ewma_col] = ratio.transform(
            lambda s, h=halflife: s.ewm(halflife=h, adjust=True).mean()
        )
        cols.append(ewma_col)

        # the expanding-mean twin. it is NOT dead weight and it is NOT a model
        # feature: it is the baseline each new stat's EWMA had to beat, kept on
        # the dataset so the comparison is reproducible from the shipped parquet
        # a year from now without replaying the appearance history, and so that a
        # stat whose champion is ``expanding`` can actually be served.
        exp_col = expanding_rate_column(target)
        app[exp_col] = ratio.transform(lambda s: s.expanding(min_periods=1).mean())
        cols.append(exp_col)

    return app[cols].sort_values("GAME_DATE").reset_index(drop=True)


def attach_per_minute_rates(frame: pd.DataFrame) -> pd.DataFrame:
    """as-of join the per-minute rate columns onto a feature frame.

    :func:`build_features` already does this, so this is a no-op on a frame built
    by the current pipeline. it exists for datasets written BEFORE the rate
    columns did - the composition needs them and rebuilding a four-season dataset
    requires the database. the recomputation runs the identical code path
    (:func:`per_minute_rate_features` plus an ``allow_exact_matches=False`` join),
    so a backfilled column and a freshly built one are the same number.

    the frame's own row order is preserved: callers hold onto positional
    alignment with arrays they computed from it.
    """
    wanted = [c for t in RATE_TARGETS for c in rate_columns(t)]
    if all(col in frame.columns for col in wanted):
        return frame
    if not {"PLAYED", "MIN", "PLAYER_ID", "GAME_DATE"} <= set(frame.columns):
        log.warning(
            "cannot backfill per-minute rates: the frame carries no appearance "
            "history (PLAYED/MIN/PLAYER_ID/GAME_DATE)"
        )
        return frame

    log.info("backfilling per-minute rate columns %s", ", ".join(wanted))
    out = frame.copy()
    out["_row_order"] = np.arange(len(out))
    # both sides of a merge_asof must carry real datetimes; a parquet round-trip can
    # hand back GAME_DATE as object dtype and the join would fail on the right side
    # only, which reads as a mysterious dtype error rather than a missing conversion
    out["GAME_DATE"] = pd.to_datetime(out["GAME_DATE"])
    out = out.sort_values("GAME_DATE").reset_index(drop=True)
    out = pd.merge_asof(
        out,
        per_minute_rate_features(out),
        on="GAME_DATE",
        by="PLAYER_ID",
        direction="backward",
        allow_exact_matches=False,  # the leakage guard
    )
    return (
        out.sort_values("_row_order")
        .drop(columns=["_row_order"])
        .reset_index(drop=True)
    )


def player_appearance_features(
    universe: pd.DataFrame,
) -> tuple[pd.DataFrame, pd.DataFrame]:
    """rolling/expanding stats on the appearance frame, ready to be as-of joined.

    returns two frames because they have different scopes and therefore need
    different as-of join keys:

      career : rolling-N and EWMA windows over the player's whole chronological
               appearance history. joined by PLAYER_ID only, so a player's
               first game of a new season still carries prior-season form -
               which is exactly when in-season history is unavailable.

      season : season-to-date expanding means. joined by PLAYER_ID + SEASON so
               they reset correctly at the season boundary.
    """
    app = universe[universe["PLAYED"] == 1].copy()
    app = app.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)

    career_cols = ["PLAYER_ID", "GAME_DATE"]
    season_cols = ["PLAYER_ID", "SEASON", "GAME_DATE"]

    for stat in ROLL_STATS:
        grp = app.groupby("PLAYER_ID")[stat]
        for w in ROLL_WINDOWS:
            col = f"roll{w}_{stat}"
            # inclusive of this appearance; the as-of join supplies the shift
            app[col] = grp.transform(lambda s, w=w: s.rolling(w, min_periods=1).mean())
            career_cols.append(col)

        col = f"std_{stat}"
        app[col] = app.groupby(["PLAYER_ID", "SEASON"])[stat].transform(
            lambda s: s.expanding(min_periods=1).mean()
        )
        season_cols.append(col)

        # the promoted conditional-production estimate. spike finding: this
        # beats or matches every trained model on established players.
        col = f"ewma_{stat}"
        app[col] = grp.transform(lambda s: s.ewm(halflife=EWMA_HALFLIFE, adjust=True).mean())
        career_cols.append(col)

    app["n_appearances"] = app.groupby("PLAYER_ID").cumcount() + 1
    career_cols.append("n_appearances")

    # the SEASON-scoped twin of n_appearances, and the reliability feature the
    # career one cannot supply: n_appearances cannot tell a veteran in October from
    # a veteran in April, which is exactly the distinction a cold-start guardrail
    # needs. it rides the season-scoped join so it resets at the boundary.
    app["season_appearances"] = (
        app.groupby(["PLAYER_ID", "SEASON"]).cumcount() + 1
    )
    season_cols.append("season_appearances")

    app["LAST_APP_DATE"] = app["GAME_DATE"]
    career_cols.append("LAST_APP_DATE")

    career = app[career_cols].sort_values("GAME_DATE").reset_index(drop=True)
    season = app[season_cols].sort_values("GAME_DATE").reset_index(drop=True)
    return career, season


def schedule_features(universe: pd.DataFrame) -> pd.DataFrame:
    """one row per (season, team, game): rest days, b2b, shifted defensive form."""
    sched = (
        universe[["SEASON", "TEAM_ID", "GAME_ID", "GAME_DATE", "TEAM_PTS_ALLOWED"]]
        .drop_duplicates(["SEASON", "TEAM_ID", "GAME_ID"])
        .sort_values(["TEAM_ID", "GAME_DATE"])
        .reset_index(drop=True)
    )

    grp = sched.groupby(["TEAM_ID", "SEASON"])

    prev_date = grp["GAME_DATE"].shift(1)
    sched["TEAM_REST_DAYS"] = (sched["GAME_DATE"] - prev_date).dt.days
    sched["IS_B2B"] = (sched["TEAM_REST_DAYS"] == 1).astype(float)
    sched.loc[sched["TEAM_REST_DAYS"].isna(), "IS_B2B"] = np.nan

    # shift(1) FIRST so the target game's own points allowed is excluded
    sched["DEF_FORM"] = grp["TEAM_PTS_ALLOWED"].transform(
        lambda s: s.shift(1).rolling(OPP_FORM_WINDOW, min_periods=OPP_FORM_MIN_PERIODS).mean()
    )

    return sched[["SEASON", "TEAM_ID", "GAME_ID", "TEAM_REST_DAYS", "IS_B2B", "DEF_FORM"]]


def _availability_history(universe: pd.DataFrame) -> pd.DataFrame:
    """availability rates over SCHEDULED rows, every window explicitly shifted."""
    g = universe.groupby("PLAYER_ID")["PLAYED"]
    for w in AVAIL_WINDOWS:
        universe[f"avail_rate_{w}"] = g.transform(
            lambda s, w=w: s.shift(1).rolling(w, min_periods=1).mean()
        )
    universe["avail_rate_std"] = universe.groupby(["PLAYER_ID", "SEASON"])["PLAYED"].transform(
        lambda s: s.shift(1).expanding(min_periods=1).mean()
    )

    # unconditional season-to-date means over ALL scheduled rows (misses count
    # as 0). the honest naive baseline for the unconditional target - contrast
    # with std_PTS, which is conditional on appearing.
    for stat in UNCOND_STATS:
        universe[f"uncond_std_{stat}"] = universe.groupby(["PLAYER_ID", "SEASON"])[
            stat
        ].transform(lambda s: s.shift(1).expanding(min_periods=1).mean())

    # scheduled team-games missed since the last appearance. the block id
    # increments immediately AFTER each appearance.
    prior = universe.groupby("PLAYER_ID")["PLAYED"].shift(1).fillna(0)
    universe["_block"] = prior.groupby(universe["PLAYER_ID"]).cumsum()
    universe["games_since_last_app"] = universe.groupby(["PLAYER_ID", "_block"]).cumcount()
    ever_played = (
        universe.groupby("PLAYER_ID")["PLAYED"]
        .shift(1)
        .groupby(universe["PLAYER_ID"])
        .cummax()
    )
    universe.loc[ever_played.fillna(0) == 0, "games_since_last_app"] = np.nan
    return universe.drop(columns=["_block"])


def assign_minutes_tier(frame: pd.DataFrame) -> pd.Series:
    """segment label from a strictly prior rolling mean, so it is as-of safe."""
    tier = pd.cut(
        frame[TIER_BASIS],
        bins=[-np.inf, *TIER_EDGES, np.inf],
        labels=list(TIER_LABELS),
    ).astype(object)
    return tier.fillna(UNKNOWN_TIER)


def stage0_context_probability(frame: pd.DataFrame) -> pd.Series:
    """the fallback p_j: the shifted appearance rate, with a constant prior.

    STAGE 0, not stage 2. This is what the expected-context features are built from
    when no base-model probability has been supplied - during ``build_features``
    itself, and for the earliest cross-fit blocks whose training window is too small
    to fit anything. It is a genuinely weaker p than the base model's, and it is
    also genuinely as-of safe: ``avail_rate_10`` is explicitly shifted in
    ``_availability_history`` and reads only games strictly before the target.

    ``CONTEXT_P_PRIOR`` fills the rows with no availability history at all. It is a
    hand-set constant precisely so that it cannot quietly become a mean over the
    evaluation window, which would put a little of every row into every other row.
    """
    if "avail_rate_10" in frame.columns:
        return (
            pd.to_numeric(frame["avail_rate_10"], errors="coerce")
            .fillna(CONTEXT_P_PRIOR)
            .clip(0.0, 1.0)
        )
    return pd.Series(CONTEXT_P_PRIOR, index=frame.index, dtype=float)


def attach_expected_context(
    features: pd.DataFrame,
    probability: pd.Series | np.ndarray | None = None,
    cutoff: pd.Series | pd.Timestamp | None = None,
) -> pd.DataFrame:
    """(re)build the served teammate-context columns from a given p_j.

    THE FUNCTION THE WHOLE P1b PHASE TURNS ON, and it is called from three places
    for three different reasons:

      build_features        with ``probability=None``, so the columns exist on a
                            freshly built frame using the stage-0 baseline p.
      build_dataset.py      with the cross-fit base-model probabilities, replacing
                            the stage-0 values. This is the dataset that ships.
      predict.py            with the base probabilities AFTER the injury-report
                            override layer has corrected them, before minutes and
                            final availability are scored. An override that changed
                            a star's p from 0.93 to 0.02 and left his teammates'
                            expected vacated minutes untouched would be a serving
                            path that knows he is out and does not act on it.

    ``cutoff`` is stamped onto every row so ``models.validate_out_of_fold`` can
    prove the probability that built the features was itself out of fold. A scalar
    applies to every row; a Series must be positionally aligned.
    """
    out = features.copy()
    p = stage0_context_probability(out) if probability is None else pd.Series(
        np.asarray(probability, dtype=float), index=out.index
    )
    out[P_CONTEXT] = p.to_numpy(dtype=float)
    if cutoff is None:
        # the stage-0 baseline reads only strictly-prior games, so its information
        # boundary is the row's own game date: honest, and it makes the guard
        # meaningful rather than vacuous.
        out[P_CONTEXT_CUTOFF] = pd.to_datetime(out["GAME_DATE"])
    elif isinstance(cutoff, pd.Series):
        out[P_CONTEXT_CUTOFF] = pd.to_datetime(cutoff.to_numpy())
    else:
        out[P_CONTEXT_CUTOFF] = pd.Timestamp(cutoff)
    return expected_vacated_features(out, out[P_CONTEXT])


def build_features(
    universe: pd.DataFrame,
    availability_probability: pd.Series | np.ndarray | None = None,
) -> pd.DataFrame:
    """the full feature frame for a universe. pure: no io, no globals.

    ``availability_probability`` is the stage-2 out-of-fold p_j the expected
    teammate-context features are built from. ``None`` uses the stage-0 baseline
    (:func:`stage0_context_probability`), which is what every test and every
    fixture-mode build wants; ``build_dataset.py`` supplies the cross-fit
    probabilities and rebuilds the block via :func:`attach_expected_context`.
    """
    universe = universe.copy()
    universe["GAME_DATE"] = pd.to_datetime(universe["GAME_DATE"])
    universe = universe.sort_values(["PLAYER_ID", "GAME_DATE", "GAME_ID"]).reset_index(drop=True)

    universe = _availability_history(universe)
    # roster context wants the same (player, date) sort the availability windows
    # want, so it runs here rather than after the joins re-sort the frame
    universe = roster_context_features(universe)

    career_feats, season_feats = player_appearance_features(universe)
    rate_feats = per_minute_rate_features(universe)
    usage_feats = usage_rate_features(universe)
    magnitude_feats = magnitude_features(universe)
    universe = universe.sort_values("GAME_DATE").reset_index(drop=True)

    # career-scoped: rolling-N / EWMA windows may span the offseason
    universe = pd.merge_asof(
        universe,
        career_feats,
        on="GAME_DATE",
        by="PLAYER_ID",
        direction="backward",
        allow_exact_matches=False,  # the leakage guard
    )
    # season-scoped: season-to-date means reset at the season boundary
    universe = pd.merge_asof(
        universe,
        season_feats,
        on="GAME_DATE",
        by=["PLAYER_ID", "SEASON"],
        direction="backward",
        allow_exact_matches=False,  # the leakage guard
    )
    # career-scoped, but over a different row set (appearances with minutes > 0),
    # which is why it cannot ride along on career_feats
    universe = pd.merge_asof(
        universe,
        rate_feats,
        on="GAME_DATE",
        by="PLAYER_ID",
        direction="backward",
        allow_exact_matches=False,  # the leakage guard
    )
    # career-scoped over the same narrower row set as the rates, and kept on its
    # own join because this one IS a model feature (fnba_ml.teammates)
    universe = pd.merge_asof(
        universe,
        usage_feats,
        on="GAME_DATE",
        by="PLAYER_ID",
        direction="backward",
        allow_exact_matches=False,  # the leakage guard
    )
    # career-scoped over APPEARANCES: the shrunk rolling-20 teammate magnitudes and
    # their effective sample size. a fifth join, and it REPLACES a dependency rather
    # than adding one - the v2 magnitudes were split across the season-scoped and
    # career-scoped joins, which made a minutes magnitude and a usage magnitude two
    # different notions of "recently"
    universe = pd.merge_asof(
        universe,
        magnitude_feats,
        on="GAME_DATE",
        by="PLAYER_ID",
        direction="backward",
        allow_exact_matches=False,  # the leakage guard
    )

    universe["days_since_last_app"] = (
        universe["GAME_DATE"] - universe["LAST_APP_DATE"]
    ).dt.days

    sf = schedule_features(universe)
    universe = universe.merge(
        sf[["SEASON", "TEAM_ID", "GAME_ID", "TEAM_REST_DAYS", "IS_B2B"]],
        on=["SEASON", "TEAM_ID", "GAME_ID"],
        how="left",
    )
    opp = sf[["SEASON", "TEAM_ID", "GAME_ID", "DEF_FORM", "TEAM_REST_DAYS"]].rename(
        columns={
            "TEAM_ID": "OPP_TEAM_ID",
            "DEF_FORM": "OPP_DEF_FORM",
            "TEAM_REST_DAYS": "OPP_REST_DAYS",
        }
    )
    universe = universe.merge(opp, on=["SEASON", "OPP_TEAM_ID", "GAME_ID"], how="left")

    universe["has_history"] = universe["roll5_MIN"].notna().astype(int)
    universe["insufficient_history"] = (
        universe["roll5_MIN"].isna()
        | universe["n_appearances"].isna()
        | (universe["n_appearances"].fillna(0) < MIN_APPEARANCES_FOR_HISTORY)
    ).astype(int)

    universe["MIN_TIER"] = assign_minutes_tier(universe)

    # the magnitudes are shrunk toward a prior, so they are never null once a player
    # has one appearance - but a player's FIRST scheduled row has no appearance at
    # all and the as-of join leaves him unmatched. He gets the prior and an effective
    # sample size of 0, which is the honest description and keeps every teammate sum
    # finite. Filling here rather than inside magnitude_features is deliberate: that
    # function only knows about appearance rows.
    for stat, column in MAGNITUDE_SOURCES.items():
        if column in universe.columns:
            universe[column] = universe[column].fillna(float(MAGNITUDE_PRIORS[stat]))
    if MAGNITUDE_ESS in universe.columns:
        universe[MAGNITUDE_ESS] = universe[MAGNITUDE_ESS].fillna(0.0)

    # THE TWO TEAMMATE-CONTEXT FAMILIES, and they must both come last: every
    # magnitude they aggregate has to be as-of joined already.
    #
    # the ORACLE family first, because it is cheap and because config.EVENT_COHORTS
    # partitions on it. It is the one feature family whose inputs are not all as-of -
    # the absent-teammate SET is the target game's - which is why it is not in
    # FEATURE_COLS any more and is documented at length in fnba_ml.teammates.
    universe = vacated_features(universe)
    universe = universe.sort_values(
        ["GAME_DATE", "GAME_ID", "TEAM_ID", "PLAYER_ID"]
    ).reset_index(drop=True)

    # then the SERVED family, built from probabilities rather than outcomes. this is
    # what FEATURE_COLS names and what every model in the promoted path sees.
    return attach_expected_context(universe, availability_probability)


def attach_cross_fit_context(features: pd.DataFrame) -> pd.DataFrame:
    """stage 2 + 3: replace the stage-0 baseline p with cross-fit base-model p.

    the step that turns a frame built by :func:`build_features` into the frame that
    ships. ``build_features`` produces the expected-context columns from the shifted
    appearance rate so that the columns always exist and the pure feature path stays
    model-free; this runs the base availability model's forward-chaining cross-fit
    and rebuilds them from a materially better probability.

    ONE ITERATION, deliberately. The final availability model's own probabilities are
    never fed back in. Iterating would be a fixed-point search whose out-of-fold
    story gets harder to state with every pass, for a second-order gain nobody has
    measured; the honest version is one pass and a note saying so.

    joined on the row key rather than positionally: the cross-fit sorts by date and
    pandas' default sort is not stable, so a positional zip would silently misalign
    rows that share a game date. Every scheduled row must come back with a
    probability - a missing one is a join bug, not a modelling choice - so the merge
    is validated rather than left to fill NaN.
    """
    from .models import cross_fit_base_probabilities  # local import avoids a cycle

    key = ["PLAYER_ID", "GAME_ID", "TEAM_ID"]
    probabilities = cross_fit_base_probabilities(features)
    merged = features.merge(
        probabilities[[*key, P_CONTEXT, P_CONTEXT_CUTOFF, "P_CONTEXT_SOURCE"]],
        on=key, how="left", suffixes=("_stage0", ""),
    )
    if len(merged) != len(features):
        raise ValueError(
            f"the cross-fit join changed the row count ({len(features)} -> "
            f"{len(merged)}); the row key is not unique"
        )
    unscored = int(merged[P_CONTEXT].isna().sum())
    if unscored:
        raise ValueError(
            f"{unscored} scheduled rows came back from the cross-fit with no "
            f"probability; every row must be scored by some block"
        )
    merged = merged.drop(columns=[c for c in merged.columns if c.endswith("_stage0")])
    return attach_expected_context(
        merged, merged[P_CONTEXT], merged[P_CONTEXT_CUTOFF]
    )


def build_dataset(source) -> pd.DataFrame:
    """source -> universe -> features -> cross-fit context, the offline pipeline."""
    from .universe import build_universe  # local import avoids a cycle

    universe = build_universe(source)
    feats = build_features(universe)
    feats = attach_cross_fit_context(feats)
    log.info("features: %d rows, %d feature columns", len(feats), len(FEATURE_COLS))
    return feats


def available_features(frame: pd.DataFrame) -> list[str]:
    """the configured feature list, restricted to what this frame actually has."""
    return [c for c in FEATURE_COLS if c in frame.columns]


def feature_set_columns(frame: pd.DataFrame, name: str) -> list[str]:
    """one of ``config.FEATURE_SETS``, restricted to what this frame actually has.

    the evaluation bracket runs the identical ladder over the identical rows three
    times and changes only this list. Returning a list rather than a filtered frame
    is the whole trick: the cohort definitions still read the oracle columns off the
    dataset, so all three passes partition the validation rows identically and their
    per-cohort numbers describe the same games.
    """
    if name not in FEATURE_SETS:
        raise ValueError(
            f"unknown feature set {name!r}; expected one of {', '.join(FEATURE_SETS)}"
        )
    columns = [c for c in FEATURE_SETS[name] if c in frame.columns]
    absent = [c for c in FEATURE_SETS[name] if c not in frame.columns]
    if absent:
        log.warning(
            "feature set %s is missing %d column(s) from this frame: %s",
            name, len(absent), ", ".join(absent),
        )
    return columns
