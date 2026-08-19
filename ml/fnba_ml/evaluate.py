"""rolling-origin evaluation harness.

NO RANDOM SPLITS, ever. forward chaining only: train is everything strictly
before the validation window, so the first season is always fully in training
and every validation row is predicted by a model that could not have seen it.

tasks:
  A  availability     PLAYED over ALL scheduled rows      Brier, log loss
  B  minutes|played   MIN over appearance rows            MAE
  C1 pts|played       PTS over appearance rows            MAE
  C2 ast|played       AST over appearance rows            MAE
  D  UNCONDITIONAL pts  PTS over ALL scheduled rows       MAE

task D is the one that matters for fantasy. it carries the promoted composition
(P(play) x E[minutes|plays] x EWMA[PTS per minute]) alongside every variant it was
promoted over, so a regression in any of them is visible in the same table.

THE COMPOSITION CHAMPION CHANGED ON 2026-08-17, and this file is where the claim
that it cost nothing has to be checkable. it is a fourth champion family
(config.CHAMPIONS['composition']) and the only one promoted on a correctness
argument rather than a metric one: P(play) x EWMA(stat) cannot respond to a
predicted minutes change at all, which is a defect no aggregate MAE can show,
because most players' predicted minutes are close to their recent minutes.
:func:`composition_parity` therefore asserts the WEAKER property that actually
needs asserting - that the new form does not LOSE more than
COMPOSITION_PARITY_TOLERANCE to the one it replaced. improvement is not expected
and is not claimed.

every reported number is accompanied by a skill score against the task's naive
baseline, because "beats the baseline by 1%" and "beats the baseline by 23%"
are different findings and only one of them justifies shipping a model.

FEATURE_VERSION v2 ADDS THREE THINGS HERE, all of them because the teammate
features make a claim that an aggregate MAE cannot check.

  EVENT COHORTS. The minutes tiers answer "where in the league is the model
  good". They cannot answer the question a vacated-resource feature has to face:
  does it help on the nights it is about, and does it leave the quiet nights
  alone? ``config.EVENT_COHORTS`` names three - two events and one CONTROL - and
  every MAE/Brier table is broken out by them alongside the tiers. A family that
  wins on high-absence games by losing on ordinary ones has not helped.

  FEATURE IMPORTANCE. Recorded as tidy rows (metric ``Gain``, segment = feature
  name) rather than printed and forgotten, so "where did the new features rank"
  is answerable from the csv a year later.

  A NEGATIVE CONTROL. A randomly permuted copy of ``vacated_minutes`` is fitted
  alongside the real one, in its own pass so the headline numbers are untouched. A
  gradient booster will assign SOME gain to any column with variance; the control
  is what turns "vacated_minutes has gain 4,200" from a number into a comparison.

  A FEATURE-SET COMPARISON. ``run_rolling_origin`` takes ``drop_features``, so the
  same dataset can be run with and without the family and the delta reported per
  cohort. That is the only honest form of a "the new features helped" claim: same
  rows, same origins, same estimators, one difference.

FEATURE_VERSION v3 (phase P1b) ADDS FOUR MORE, all of them because the round-2
review found that the v2 gains were a value-of-perfect-lineup-information result
rather than a forecasting result.

  THE BRACKET. ``run_feature_set_bracket`` + ``feature_set_bracket`` run the ladder
  three times over identical rows - v1 (no teammate context), v3-honest (the served
  probabilistic construction), v2-oracle (the realized construction, which reads
  other players' target-game labels) - and report the interval. The ``survived``
  column is honest_delta / oracle_delta: the share of the oracle result that
  survives honest construction. That single number is what the phase is for.

  A SINGLE-FEATURE ABLATION. ``single_feature_ablation`` refits the served set with
  ``exp_depth_rank`` removed. Split gain says how a booster allocated credit among
  correlated columns; an ablation says what the column is worth. Reported, not
  asserted - there is no bar it has to clear.

  THE LEVEL-C DEGRADED-ORACLE GRID. ``degraded_oracle_grid`` sweeps absence recall
  x false-positive rate, mapping the space between "our own base model" and "perfect
  information". It reads target-game labels by construction, which is what makes it
  a measure of information value and what disqualifies it from ever being a feature.

  A TEAM-GAME BLOCK PERMUTATION. ``block_permute_context`` permutes the whole
  context block across team-games of equal roster size, keeping each block
  internally coherent and merely attaching it to the wrong game. A strictly harder
  null than the per-row permutation, and the one the leakage tests use.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import (
    CANDIDATE_FEATURE_SET,
    CHAMPIONS,
    COHERENCE_CONSTRAINTS,
    COMPOSITION_PARITY_TOLERANCE,
    EVENT_COHORTS,
    EVENT_COHORT_ORDER,
    FEATURE_SETS,
    ORACLE_FEATURE_SET,
    ORIGINS,
    P_CONTEXT,
    RANDOM_STATE,
    RATE_ESTIMATORS,
    RATE_HALFLIFE_DEFAULT,
    RATE_HALFLIFE_GRID,
    RATE_HALFLIVES,
    RATE_MINUTES_FLOOR,
    RATE_TARGETS,
    TOURNAMENT_RATE_TARGETS,
    SERVED_FEATURE_SET,
    TEAMMATE_EXPECTED_COLS,
    TEAMMATE_FEATURE_COLS,
    TEAMMATE_ORACLE_COLS,
    TIER_ORDER,
    V4_DESCRIPTIVE_COHORTS,
    V4_DESCRIPTIVE_COHORT_ORDER,
)
from .features import available_features, feature_set_columns
from .models import (
    AvailabilityModel,
    EwmaProduction,
    MIN_PRED,
    MinutesModel,
    P_PLAY,
    PerMinuteRate,
    baseline_column,
    brier,
    coherence_clip,
    conditional_estimate,
    decomposed_estimate,
    fit_predict,
    logloss,
    mae,
    make_lgbm_regressor,
    make_logistic,
    make_ridge,
    minutes_propagated_estimate,
    quantile_coverage,
    residual_interval,
    skill_score,
)
from .teammates import absence_mask

log = logging.getLogger(__name__)

TASK_AVAILABILITY = "A availability"
TASK_MINUTES = "B minutes|played"
TASK_PTS = "C1 pts|played"
TASK_AST = "C2 ast|played"
TASK_UNCONDITIONAL = "D pts UNCONDITIONAL"
# not model comparisons: diagnostics recorded into the same tidy frame so they end
# up in the same versioned csv as the numbers they explain. both carry metric
# "Gain" with the FEATURE NAME in the segment column.
TASK_IMPORTANCE = "E feature importance"
TASK_NEGATIVE_CONTROL = "Z negative control"

CONDITIONAL_TASKS = {TASK_MINUTES: "MIN", TASK_PTS: "PTS", TASK_AST: "AST"}

# every task whose tables are broken out by cohort
COHORT_TASKS = (TASK_MINUTES, TASK_PTS, TASK_AST, TASK_UNCONDITIONAL)

# the permuted twin of a real feature. it exists to be beaten: LightGBM assigns
# non-zero gain to any column with variance, so a raw gain number means nothing
# without a column that is guaranteed to carry no signal sitting next to it.
#
# it tracks the SERVED column as of v3. permuting the oracle column would produce a
# control for a feature no model in the promoted path can see.
NEGATIVE_CONTROL_FEATURE = "exp_vacated_minutes"
NEGATIVE_CONTROL_COLUMN = "exp_vacated_minutes_permuted"

# the cohort-defining oracle column. it is the same column EVENT_COHORTS reads, and
# it is deliberately the REALIZED one: "on the nights when a lot really was vacated,
# how did each feature set do" is a question about the games, and answering it with
# hindsight is legitimate for a report in a way it is not for a feature.
COHORT_ORACLE_COLUMN = "vacated_minutes"

# which task family each task's champion selection belongs to
TASK_FAMILY = {
    TASK_AVAILABILITY: "availability",
    TASK_MINUTES: "minutes",
    TASK_PTS: "production",
    TASK_AST: "production",
    # the unconditional task's "model" names are compositions, not estimators, so
    # its configured champion lives under its own family key.
    TASK_UNCONDITIONAL: "composition",
}

# the composition that was promoted away from, kept as the parity reference. it is
# not merely the runner-up - it is the previous champion, and the specific number
# the correctness change had to not cost anything against.
PREVIOUS_COMPOSITION = "decomposed_p_x_ewma"

# the model each task's skill score is measured against
SKILL_BASELINE = {
    TASK_AVAILABILITY: "shifted_appearance_rate",
    TASK_MINUTES: "ewma",
    TASK_PTS: "ewma",
    TASK_AST: "ewma",
    TASK_UNCONDITIONAL: "naive_unconditional_mean",
}

MODEL_LABELS = {
    "global_rate": "baseline: global rate",
    "shifted_appearance_rate": "baseline: shifted appearance rate (10)",
    "logistic": "logistic regression",
    "lightgbm": "LightGBM",
    "ridge": "ridge",
    "ewma": "baseline: EWMA (halflife 5)",
    "expanding_mean": "baseline: expanding season mean",
    "naive_conditional_mean": "naive: conditional season mean (selection-biased)",
    "naive_unconditional_mean": "naive: unconditional season mean (0 for misses)",
    "direct_lightgbm": "direct LightGBM on all scheduled rows",
    "decomposed_p_x_ewma": "decomposed (demoted): P(play) x EWMA[PTS|played]",
    "decomposed_p_x_lightgbm": "decomposed: P(play) x LightGBM[PTS|played]",
    "decomposed_p_x_minutes_x_ppm":
        "decomposed CHAMPION: P(play) x E[MIN|played] x EWMA[PTS/min]",
}

NOMINAL_COVERAGE = 0.80


def cohort_masks(valid: pd.DataFrame) -> list[tuple[str, np.ndarray]]:
    """(label, mask) for every reporting cohort: minutes tiers, then event cohorts.

    the event cohorts are defined on the DATASET's own feature columns, not on
    anything a model produced, so the same cohort contains the same rows in a run
    with the teammate features and a run without them. That is what makes a
    before/after cohort comparison a comparison rather than two different
    partitions of the data.

    a row whose cohort column is null belongs to no event cohort. It is not
    silently swept into the control - "we do not know whether anyone was out" and
    "nobody was out" are different facts.

    P2 ADDS TWO DESCRIPTIVE COHORTS (``config.V4_DESCRIPTIVE_COHORTS``) and they are
    APPENDED, not merged into ``EVENT_COHORTS``, which is frozen by
    ``tests/test_prospective_freeze.py::test_cohort_definitions_have_not_drifted``.
    They appear only when their column is on the frame, so a v3 dataset produces
    byte-identical cohort output to before P2 existed.

    ONE OF THEM IS A QUANTILE CUT, which is a different kind of threshold from the
    other seven and worth stating. "blowout_prob top decile" has to mean the same
    SHARE of rows in every origin, and a fixed probability threshold would not - the
    classifier's output distribution shifts with the league's own blowout rate, which
    drifted from 27% to 37% across the four seasons. The quantile is taken WITHIN the
    validation frame it is describing, so the cohort is 10% of every origin's rows by
    construction.
    """
    out: list[tuple[str, np.ndarray]] = []
    if "MIN_TIER" in valid.columns:
        tiers = valid["MIN_TIER"].to_numpy()
        out.extend((tier, tiers == tier) for tier in TIER_ORDER)
    for label, column, comparison, threshold in (
        *EVENT_COHORTS, *V4_DESCRIPTIVE_COHORTS
    ):
        if column not in valid.columns:
            continue
        values = pd.to_numeric(valid[column], errors="coerce").to_numpy(dtype=float)
        known = np.isfinite(values)
        if comparison == "quantile>=":
            if not known.any():
                continue
            cut = float(np.quantile(values[known], threshold))
            mask = values >= cut
            # A DEGENERATE QUANTILE IS NOT A COHORT. If the column is constant -
            # which ``blowout_prob`` is whenever every cross-fit block fell back to
            # ``BLOWOUT_PRIOR``, as happens on a small fixture set - then ``>= q90``
            # selects every row and the "top decile" table would silently be a second
            # copy of the ALL row. Skipping with a warning is the honest outcome: the
            # cohort is UNDEFINED on this frame, which is a different fact from empty.
            share = float((mask & known).sum()) / float(known.sum())
            if share > 0.5:
                log.warning(
                    "cohort %r would cover %.0f%% of rows because %s is (near-)"
                    "constant on this frame; SKIPPED rather than reported as a "
                    "duplicate of ALL", label, 100.0 * share, column,
                )
                continue
        elif comparison == ">=":
            mask = values >= threshold
        else:
            mask = values < threshold
        out.append((label, mask & known))
    return out


class _Recorder:
    def __init__(self) -> None:
        self.rows: list[dict] = []

    def record(self, task, origin, model, metric, value, n, segment="ALL") -> None:
        self.rows.append({
            "task": task, "origin": origin, "model": model, "segment": segment,
            "metric": metric, "value": float(value), "n": int(n),
        })

    def _segments(self, task, origin, model, valid, metric, fn, y_true, y_pred) -> None:
        self.record(task, origin, model, metric, fn(y_true, y_pred), len(y_true))
        for label, mask in cohort_masks(valid):
            if mask.sum() == 0:
                continue
            self.record(task, origin, model, metric, fn(y_true[mask], y_pred[mask]),
                        int(mask.sum()), segment=label)

    def seg_mae(self, task, origin, model, valid, y_true, y_pred) -> None:
        self._segments(task, origin, model, valid, "MAE", mae, y_true, y_pred)

    def seg_brier(self, task, origin, model, valid, y_true, y_pred) -> None:
        """availability's cohort breakdown. Brier, not MAE, and it was missing.

        before v2 the availability table had no segment breakdown at all, so
        "does knowing a teammate is out improve the availability model on
        high-absence games" was unanswerable from the report.
        """
        self._segments(task, origin, model, valid, "Brier", brier, y_true, y_pred)

    def gain(self, task, origin, model, gains: pd.Series, n: int) -> None:
        """one row per feature. metric 'Gain', feature name in the segment column."""
        for feature, value in gains.items():
            self.record(task, origin, model, "Gain", value, n, segment=str(feature))

    def frame(self) -> pd.DataFrame:
        return pd.DataFrame(self.rows)


def split(df: pd.DataFrame, vstart, vend) -> tuple[pd.DataFrame, pd.DataFrame]:
    vstart, vend = pd.Timestamp(vstart), pd.Timestamp(vend)
    train = df[df["GAME_DATE"] < vstart]
    valid = df[(df["GAME_DATE"] >= vstart) & (df["GAME_DATE"] <= vend)]
    return train.copy(), valid.copy()


def _availability(rec, origin, feats, train_all, valid_all) -> np.ndarray:
    y = valid_all["PLAYED"].to_numpy(dtype=int)
    base_rate = float(train_all["PLAYED"].mean())
    cutoff = valid_all["GAME_DATE"].min()

    champion = AvailabilityModel(kind=CHAMPIONS["availability"]).fit(train_all, feats, cutoff)
    scored = champion.attach(valid_all)

    preds = {
        "global_rate": np.full(len(valid_all), base_rate),
        "shifted_appearance_rate": baseline_column(valid_all, "avail_rate_10", base_rate),
        "logistic": make_logistic().fit(
            train_all[feats], train_all["PLAYED"].astype(int)
        ).predict_proba(valid_all[feats])[:, 1],
        CHAMPIONS["availability"]: scored[P_PLAY].to_numpy(dtype=float),
    }
    for name, p in preds.items():
        rec.seg_brier(TASK_AVAILABILITY, origin, name, valid_all, y, p)
        rec.record(TASK_AVAILABILITY, origin, name, "LogLoss", logloss(y, p), len(y))

    ref = preds[SKILL_BASELINE[TASK_AVAILABILITY]]
    for name, p in preds.items():
        rec.record(TASK_AVAILABILITY, origin, name, "BrierSkill",
                   skill_score(brier(y, p), brier(y, ref)), len(y))

    rec.gain(TASK_IMPORTANCE, origin, "availability", champion.feature_gain(),
             len(train_all))
    return scored


def _conditional(rec, origin, feats, train_app, valid_app) -> dict[str, np.ndarray]:
    kept: dict[str, np.ndarray] = {}
    for task, target in CONDITIONAL_TASKS.items():
        y = valid_app[target].to_numpy(dtype=float)
        fallback = float(train_app[target].mean())
        ewma = EwmaProduction(target).fit(train_app)

        preds = {
            "expanding_mean": baseline_column(valid_app, f"std_{target}", fallback),
            "ewma": ewma.predict(valid_app),
            "ridge": fit_predict(make_ridge(), train_app, valid_app, feats, target),
            "lightgbm": fit_predict(make_lgbm_regressor(), train_app, valid_app, feats, target),
        }
        for name, pred in preds.items():
            rec.seg_mae(task, origin, name, valid_app, y, pred)

        ref = preds[SKILL_BASELINE[task]]
        for name, pred in preds.items():
            rec.record(task, origin, name, "MAESkill",
                       skill_score(mae(y, pred), mae(y, ref)), len(y))

        # interval calibration for the champion, from training residuals only
        train_resid = train_app[target].to_numpy(dtype=float) - ewma.predict(train_app)
        lo, hi = residual_interval(train_resid, NOMINAL_COVERAGE)
        rec.record(task, origin, CHAMPIONS["production"], "Coverage80",
                   quantile_coverage(y, preds["ewma"], lo, hi), len(y))

        kept[target] = preds["lightgbm"]
    return kept


def _unconditional(
    rec, origin, feats, train_all, train_app, valid_all, scored
) -> pd.DataFrame:
    """returns the SCORED frame with ``MIN_PRED`` attached.

    it returns it as of the 9-cat extension so the rate ladder can reuse the same
    minutes prediction rather than fitting a second minutes model that is
    configured identically and is therefore only ALMOST the same number. Eleven
    stats through one composition is one claim; eleven stats through eleven
    lookalike compositions is eleven claims that happen to agree.
    """
    y = valid_all["PTS"].to_numpy(dtype=float)
    fb_cond = float(train_app["PTS"].mean())
    fb_unc = float(train_all["PTS"].mean())

    ewma_pts = EwmaProduction("PTS").fit(train_app)
    pts_cond_all = fit_predict(make_lgbm_regressor(), train_app, valid_all, feats, "PTS")

    # THE PROMOTED COMPOSITION, built from the same classes the serving path uses
    # rather than a lookalike assembled here. that is the point of routing it
    # through MinutesModel: the minutes prediction arrives carrying its training
    # cutoff, minutes_propagated_estimate re-validates it AND checks it against the
    # availability model's cutoff, and an evaluation that quietly used an in-fold
    # minutes model would fail here instead of reporting a flattering number.
    cutoff = pd.Timestamp(valid_all["GAME_DATE"].min())
    minutes_model = MinutesModel(kind=CHAMPIONS["minutes"]).fit(train_app, feats, cutoff)
    rec.gain(TASK_IMPORTANCE, origin, "minutes", minutes_model.feature_gain(),
             len(train_app))
    scored = minutes_model.attach(scored)
    ppm_rate = PerMinuteRate("PTS").fit(train_app)
    _, ppm_uncond = minutes_propagated_estimate(scored, ppm_rate.predict(valid_all))

    preds = {
        "naive_conditional_mean": baseline_column(valid_all, "std_PTS", fb_cond),
        "naive_unconditional_mean": baseline_column(valid_all, "uncond_std_PTS", fb_unc),
        "direct_lightgbm": fit_predict(make_lgbm_regressor(), train_all, valid_all, feats, "PTS"),
        # every decomposition below runs through decomposed_estimate, which
        # re-validates the out-of-fold stamp on P(play) before multiplying
        "decomposed_p_x_ewma": decomposed_estimate(scored, ewma_pts.predict(valid_all)),
        "decomposed_p_x_lightgbm": decomposed_estimate(scored, pts_cond_all),
        CHAMPIONS["composition"]: ppm_uncond,
    }
    for name, pred in preds.items():
        rec.seg_mae(TASK_UNCONDITIONAL, origin, name, valid_all, y, pred)

    ref = preds[SKILL_BASELINE[TASK_UNCONDITIONAL]]
    for name, pred in preds.items():
        rec.record(TASK_UNCONDITIONAL, origin, name, "MAESkill",
                   skill_score(mae(y, pred), mae(y, ref)), len(y))
    return scored


# TWO permutation controls as of v3, because the report leans on two different nulls
# and they need two different columns:
#
#   the IMPORTANCE null permutes the SERVED column, because only a served column can
#   appear in a fitted model's split gain. Permuting the oracle column would produce a
#   control for a feature no model in the promoted path can see.
#   the COHORT null permutes the COHORT-DEFINING column, because that is the split
#   whose distinctiveness is being tested. config.EVENT_COHORTS reads the oracle
#   `vacated_minutes`, so its null has to be a permutation of the same column.
PERMUTATION_CONTROLS: tuple[tuple[str, str], ...] = (
    (NEGATIVE_CONTROL_FEATURE, NEGATIVE_CONTROL_COLUMN),
    (COHORT_ORACLE_COLUMN, f"{COHORT_ORACLE_COLUMN}_permuted"),
)
COHORT_CONTROL_COLUMN = f"{COHORT_ORACLE_COLUMN}_permuted"


def add_negative_control(
    features: pd.DataFrame,
    source: str | None = None,
    column: str | None = None,
    seed: int = RANDOM_STATE,
) -> pd.DataFrame:
    """randomly permuted copies of the control columns, for the two nulls.

    a PERMUTATION rather than fresh noise, deliberately: the control has the exact
    marginal distribution of the real column - same skew, same zero mass, same
    scale - and differs only in being unrelated to the row it sits on. Gaussian
    noise would be a weaker control, because a booster's split-gain also responds
    to a column's shape.

    permuted once over the whole frame rather than within each fold. Permuting per
    fold would let the control inherit the fold's own row ordering, which is
    correlated with date, which is correlated with everything.

    with no arguments it adds every pair in ``PERMUTATION_CONTROLS`` - the served
    column for the importance null and the cohort-defining column for the cohort
    null. ``source``/``column`` add exactly one named pair instead, which is what a
    test wanting a specific control asks for. Each pair gets its own generator draw
    off one seeded stream, so the two controls are independent permutations and not
    the same permutation applied twice.
    """
    if (source is None) != (column is None):
        raise ValueError("pass both source and column, or neither")
    pairs = PERMUTATION_CONTROLS if source is None else ((source, column),)
    out = features.copy()
    rng = np.random.default_rng(seed)
    for src, dst in pairs:
        if src not in out.columns:
            continue
        out[dst] = out[src].to_numpy()[rng.permutation(len(out))]
    return out


def negative_control_pass(
    features: pd.DataFrame,
    origins: list[tuple[str, str, str]],
    feature_cols: list[str],
) -> pd.DataFrame:
    """fit availability + minutes with the permuted twin added, record gains only.

    ITS OWN PASS, not the main one. Adding a noise column to the models whose Brier
    and MAE are the report's headline numbers would move those numbers in the fourth
    decimal for no reason, and would make this run's figures incomparable with the
    previous report's. The cost is two extra LightGBM fits per origin.
    """
    if NEGATIVE_CONTROL_COLUMN not in features.columns:
        return pd.DataFrame()

    cols = [*feature_cols, NEGATIVE_CONTROL_COLUMN]
    rec = _Recorder()
    for origin, vstart, vend in origins:
        train_all, valid_all = split(features, vstart, vend)
        train_app = train_all[train_all["PLAYED"] == 1]
        if train_all.empty or valid_all.empty or train_app.empty:
            continue
        cutoff = pd.Timestamp(vstart)
        availability = AvailabilityModel(kind="lightgbm").fit(train_all, cols, cutoff)
        rec.gain(TASK_NEGATIVE_CONTROL, origin, "availability",
                 availability.feature_gain(), len(train_all))
        minutes = MinutesModel(kind="lightgbm").fit(train_app, cols, cutoff)
        rec.gain(TASK_NEGATIVE_CONTROL, origin, "minutes",
                 minutes.feature_gain(), len(train_app))
    return rec.frame()


def cohort_outcome_lift(
    features: pd.DataFrame, control_column: str | None = COHORT_CONTROL_COLUMN
) -> pd.DataFrame:
    """mean outcome inside each event cohort vs the population. no models involved.

    the model-free half of the negative control, and the one that cannot be
    explained away by a booster's behaviour: if a cohort's rows really are the
    nights when minutes get redistributed, the cohort's mean minutes must differ
    from the population's. For the PERMUTED column the same split must show
    essentially nothing, or the cohort machinery is generating the finding by
    itself.

    computed over APPEARANCE rows for MIN/PTS (the conditional outcomes) and over
    all scheduled rows for PLAYED.
    """
    scheduled = features
    played = features[features["PLAYED"] == 1]
    rows: list[dict] = []

    definitions = list(EVENT_COHORTS)
    if control_column and control_column in features.columns:
        definitions += [
            (f"{label} [PERMUTED CONTROL]", control_column, comparison, threshold)
            for label, column, comparison, threshold in EVENT_COHORTS
            if column == COHORT_ORACLE_COLUMN
        ]

    for label, column, comparison, threshold in definitions:
        if column not in features.columns:
            continue
        for frame, outcome in ((scheduled, "PLAYED"), (played, "MIN"), (played, "PTS")):
            if outcome not in frame.columns:
                continue
            values = pd.to_numeric(frame[column], errors="coerce")
            mask = (values >= threshold) if comparison == ">=" else (values < threshold)
            mask = mask & values.notna()
            if mask.sum() == 0:
                continue
            overall = float(frame[outcome].mean())
            inside = float(frame.loc[mask, outcome].mean())
            rows.append({
                "cohort": label,
                "outcome": outcome,
                "rows": int(mask.sum()),
                "cohort_mean": inside,
                "population_mean": overall,
                "lift": inside - overall,
            })
    return pd.DataFrame(rows)


# ===========================================================================
# THE 9-CATEGORY RATE LADDER (2026-08-18)
# ===========================================================================
# WHAT THIS SECTION IS FOR. Extending the package from two production stats to
# eleven is not "the same code with a longer loop": it introduces a decision that
# PTS and AST never had to make, because they arrived with a halflife already
# chosen and, as of the production tournament, frozen. Each of the nine new stats
# has NO incumbent, so for each of them this section establishes the FIRST
# champion from scratch, and does it the way every other champion in this package
# was established - the dumbest defensible baseline first, the incumbent family
# second, and a bar the winner has to clear rather than an argmin over five noisy
# numbers.
#
# THE THREE-MEMBER BRACKET per new stat, over identical rows and one shared
# minutes model, so the ONLY thing that differs between members is the production
# estimate:
#
#   expanding_rate   E[MIN|play] x career expanding mean of stat/minute.
#                    the baseline. no memory parameter, nothing to tune, and it
#                    is what the EWMA has to be worth more than.
#   ewma_total       EWMA(halflife 5) of the whole-game total, NO minutes term.
#                    the pre-composition estimator - what this package served for
#                    PTS before 2026-08-17. It is here so the claim "the
#                    minutes-propagating composition earns its place for REB too"
#                    is measured for REB rather than inherited from PTS.
#   ewma_rate        E[MIN|play] x EWMA(selected halflife) of stat/minute.
#                    the candidate champion.
#
# THE HALFLIFE IS NOT SELECTED HERE. It is selected by
# :func:`select_rate_halflives` on INNER folds carved strictly out of each
# origin's own TRAINING window, so the number that appears in this ladder was
# chosen without any origin's validation rows ever being scored. Selecting on the
# same rows the ladder reports would make every MAE below an in-sample number
# wearing an out-of-sample label, which is the exact failure the rolling-origin
# scheme exists to prevent.

# the conditional task per rate target, and its unconditional twin. lettered R/S
# so they sort after the existing A..E tasks and the report's section order is
# stable rather than alphabetical-by-accident.
RATE_TASK_PREFIX = "R"
RATE_UNCOND_TASK_PREFIX = "S"

# the coherence audit. not a model comparison - a count, recorded into the same
# tidy frame as the numbers it qualifies, with the constraint in the segment
# column and the share of rows the clip moved as the value.
TASK_COHERENCE = "H coherence"

# the rate-ladder model names. kept out of MODEL_LABELS' composition entries
# because these are conditional PRODUCTION estimators, not compositions.
RATE_MODEL_EXPANDING = "expanding_rate"
RATE_MODEL_TOTAL = "ewma_total"
RATE_MODEL_EWMA = "ewma_rate"

# the skill reference for the rate ladder: the baseline, so a positive MAESkill
# means "the EWMA bought something over the dumbest rate estimator".
RATE_SKILL_BASELINE = RATE_MODEL_EXPANDING

# how much better than halflife 5 a challenger halflife must be, in relative MAE,
# before it is allowed to ship. PRE-REGISTERED, and deliberately much smaller than
# the production tournament's 2% floor, because the two thresholds are answering
# different questions. The tournament's 2% protected an INCUMBENT from being
# displaced by noise; these stats have no incumbent, so there is no incumbent to
# protect and the bar is only "is this difference material at all".
#
# 0.5% is where "material" is set, and the reason is coherence rather than
# statistics: every distinct halflife introduced into a constrained pair
# (FG3M/FGM/FGA, FTM/FTA) is a source of coherence violations that the serving
# clip then has to correct, because two EWMAs at the same halflife are the same
# weighted average of the same rows and two at different halflives are not. A
# halflife that buys under half a percent of MAE has not paid for the clipping it
# causes, so the stat keeps the package's existing constant.
RATE_SELECTION_MIN_GAIN: float = 0.005

# a challenger must also win on a MAJORITY of origins, not merely on the pooled
# mean. one origin with an unusual month can move a pooled average; it cannot move
# three of five independent rankings.
RATE_SELECTION_MIN_ORIGINS: int = 3

# the inner folds, in days, carved off the END of each origin's training window.
# TWO folds rather than one so a stat's selection has to be stable across two
# disjoint months rather than being an artifact of whichever month happened to sit
# immediately before the origin; 28 days each because that is the same holdout
# length train.py uses and there is no reason for the two to disagree.
INNER_FOLD_DAYS: int = 28
INNER_FOLDS: int = 2


def whole_game_ewma_column(target: str, halflife: float) -> str:
    return f"_ladder_ewma_{target}_h{halflife:g}"


def grid_rate_column(target: str, halflife: float) -> str:
    return f"_grid_ewma_{target}_per_min_h{halflife:g}"


def build_rate_grid(
    features: pd.DataFrame,
    targets: tuple[str, ...] = RATE_TARGETS,
    halflives: tuple[float, ...] = RATE_HALFLIFE_GRID,
    floor: float = RATE_MINUTES_FLOOR,
) -> pd.DataFrame:
    """every (target x halflife) per-minute rate, plus the whole-game EWMA, as-of joined.

    ONE frame for the whole selection and the whole ladder, so no member of the
    bracket can accidentally receive a differently-constructed rate. The
    construction is ``features.per_minute_rate_features`` with the halflife
    exposed: the same appearance row set (``PLAYED == 1 and MIN > 0``), the same
    floored denominator, the same INCLUSIVE EWMA, and the same
    ``allow_exact_matches=False`` as-of join supplying the shift.

    WHY ONE CROSS-FIT-FREE PASS IS SAFE FOR EVERY ORIGIN AT ONCE. The EWMA at row
    g reads only games at or before g, and the as-of join then refuses the exact
    match, so a row's rate is a function of strictly-prior games and nothing else.
    That is true independently of which origin or inner fold the row later lands
    in, so recomputing the grid per fold would produce identical numbers at ten
    times the cost - the same argument ``models.cross_fit_base_probabilities``
    makes for not redoing its blocks per origin.

    the columns are prefixed with an underscore so that ``available_features`` -
    which selects from ``config.FEATURE_COLS`` by name - can never pick one up and
    hand a per-minute rate to a booster as a predictor.
    """
    frame = features.copy()
    frame["GAME_DATE"] = pd.to_datetime(frame["GAME_DATE"])
    app = frame[(frame["PLAYED"] == 1) & (frame["MIN"] > 0)].copy()
    app = app.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)
    denominator = app["MIN"].clip(lower=floor)

    cols = ["PLAYER_ID", "GAME_DATE"]
    for target in targets:
        if target not in app.columns:
            log.warning("no %s column; it is excluded from the rate grid", target)
            continue
        ratio = (app[target] / denominator).groupby(app["PLAYER_ID"])
        for halflife in halflives:
            column = grid_rate_column(target, halflife)
            app[column] = ratio.transform(
                lambda s, h=halflife: s.ewm(halflife=float(h), adjust=True).mean()
            )
            cols.append(column)
        # the whole-game EWMA at the package's default halflife: the estimator the
        # composition replaced, needed as a ladder member for stats that have no
        # ``ewma_<stat>`` column on the dataset (only ROLL_STATS do).
        column = whole_game_ewma_column(target, RATE_HALFLIFE_DEFAULT)
        app[column] = app.groupby("PLAYER_ID")[target].transform(
            lambda s: s.ewm(halflife=float(RATE_HALFLIFE_DEFAULT), adjust=True).mean()
        )
        cols.append(column)

    return app[cols].sort_values("GAME_DATE").reset_index(drop=True)


def attach_rate_grid(features: pd.DataFrame, grid: pd.DataFrame) -> pd.DataFrame:
    """as-of join the grid on, preserving the caller's row order.

    ``allow_exact_matches=False`` IS the leakage guard, exactly as in
    ``features.build_features``: the appearance on the target date can never be
    matched, which is what turns an inclusive EWMA into a strictly-prior quantity.
    """
    out = features.copy()
    out["_row_order"] = np.arange(len(out))
    out["GAME_DATE"] = pd.to_datetime(out["GAME_DATE"])
    out = out.sort_values("GAME_DATE").reset_index(drop=True)
    right = grid.copy()
    right["GAME_DATE"] = pd.to_datetime(right["GAME_DATE"])
    joined = pd.merge_asof(
        out, right, on="GAME_DATE", by="PLAYER_ID",
        direction="backward", allow_exact_matches=False,
    )
    return (
        joined.sort_values("_row_order")
        .drop(columns=["_row_order"])
        .reset_index(drop=True)
    )


def inner_folds(
    train: pd.DataFrame, n_folds: int = INNER_FOLDS, days: int = INNER_FOLD_DAYS
) -> list[tuple[str, pd.Timestamp, pd.Timestamp]]:
    """(name, start, end) windows carved off the END of a training frame.

    FORWARD CHAINING INSIDE THE TRAINING WINDOW, which is the whole point: fold k's
    own training rows are everything strictly before fold k's start, so a selection
    made on these folds has never seen the ORIGIN's validation rows and has never
    seen its own fold either. The folds are disjoint and adjacent, latest first, so
    "the model was picked on the two months immediately before the origin" is
    literally what happened.
    """
    if train.empty:
        return []
    end = pd.Timestamp(train["GAME_DATE"].max()) + pd.Timedelta(days=1)
    out: list[tuple[str, pd.Timestamp, pd.Timestamp]] = []
    for k in range(n_folds):
        stop = end - pd.Timedelta(days=days * k)
        start = end - pd.Timedelta(days=days * (k + 1))
        if start <= pd.Timestamp(train["GAME_DATE"].min()):
            break
        out.append((f"inner{k + 1}", start, stop))
    return out


def _rate_candidates(
    valid_app: pd.DataFrame,
    minutes_pred: np.ndarray,
    target: str,
    fallback: float,
    halflives: tuple[float, ...],
) -> dict[str, np.ndarray]:
    """conditional estimates for every halflife on the grid, one shared minutes model.

    the minutes prediction is a COMMON FACTOR across the whole grid, which is what
    makes this a clean sweep of one axis: two halflives' conditional estimates
    differ by exactly the ratio of their rates, so any MAE difference is
    attributable to the memory length and to nothing else.
    """
    out: dict[str, np.ndarray] = {}
    for halflife in halflives:
        column = grid_rate_column(target, halflife)
        if column not in valid_app.columns:
            continue
        rate = (
            valid_app[column]
            .replace([np.inf, -np.inf], np.nan)
            .fillna(fallback)
            .to_numpy(dtype=float)
        )
        out[f"h{halflife:g}"] = conditional_estimate(minutes_pred, np.clip(rate, 0.0, None))
    return out


def select_rate_halflives(
    features: pd.DataFrame,
    origins: list[tuple[str, str, str]] | None = None,
    targets: tuple[str, ...] = RATE_TARGETS,
    halflives: tuple[float, ...] = RATE_HALFLIFE_GRID,
    grid: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """per-(origin, inner fold, target, halflife) conditional MAE. tidy long.

    THE SELECTION EVIDENCE, and nothing else - this function chooses nothing. It
    reports MAEs and :func:`rate_halflife_winners` applies the pre-registered rule
    to them, because "here is the evidence" and "here is the decision the evidence
    licenses" are two claims and mixing them into one function makes the second one
    unauditable.

    OUT-OF-FOLD ON BOTH SIDES. for each origin, every fold lives strictly inside
    that origin's TRAINING window; the minutes model that supplies the common
    factor is fitted on appearances strictly before the fold and carries the fold
    start as its cutoff; and the rates come from an as-of join that refuses exact
    matches. No origin's validation rows are read by anything here.
    """
    origins = origins or ORIGINS
    df = features.copy()
    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"])
    df = df.sort_values("GAME_DATE").reset_index(drop=True)
    if grid is None:
        grid = build_rate_grid(df, targets, halflives)
    df = attach_rate_grid(df, grid)
    feats = available_features(df)

    rows: list[dict] = []
    for origin, vstart, _vend in origins:
        train = df[df["GAME_DATE"] < pd.Timestamp(vstart)]
        for fold, start, stop in inner_folds(train):
            inner_train = train[train["GAME_DATE"] < start]
            inner_valid = train[(train["GAME_DATE"] >= start) & (train["GAME_DATE"] < stop)]
            inner_train_app = inner_train[inner_train["PLAYED"] == 1]
            inner_valid_app = inner_valid[inner_valid["PLAYED"] == 1]
            if inner_train_app.empty or inner_valid_app.empty:
                log.warning("%s/%s has an empty side; skipped", origin, fold)
                continue

            minutes_model = MinutesModel(kind=CHAMPIONS["minutes"]).fit(
                inner_train_app, feats, start
            )
            minutes_pred = minutes_model.predict(inner_valid_app)

            for target in targets:
                if target not in inner_valid_app.columns:
                    continue
                y = inner_valid_app[target].to_numpy(dtype=float)
                fallback = float(
                    PerMinuteRate(target).fit(inner_train_app).fallback or 0.0
                )
                candidates = _rate_candidates(
                    inner_valid_app, minutes_pred, target, fallback, halflives
                )
                expanding_column = f"exp_{target}_per_min"
                if expanding_column in inner_valid_app.columns:
                    rate = (
                        inner_valid_app[expanding_column]
                        .replace([np.inf, -np.inf], np.nan)
                        .fillna(fallback)
                        .to_numpy(dtype=float)
                    )
                    candidates["expanding"] = conditional_estimate(
                        minutes_pred, np.clip(rate, 0.0, None)
                    )
                for name, pred in candidates.items():
                    rows.append({
                        "origin": origin,
                        "fold": fold,
                        "target": target,
                        "method": name,
                        "MAE": mae(y, pred),
                        "n": int(len(y)),
                    })
    return pd.DataFrame(rows)


def rate_halflife_winners(
    selection: pd.DataFrame,
    halflives: tuple[float, ...] = RATE_HALFLIFE_GRID,
    default: float = RATE_HALFLIFE_DEFAULT,
    min_gain: float = RATE_SELECTION_MIN_GAIN,
    min_origins: int = RATE_SELECTION_MIN_ORIGINS,
    frozen: tuple[str, ...] = TOURNAMENT_RATE_TARGETS,
) -> pd.DataFrame:
    """apply the pre-registered rule to the inner-fold evidence. one row per stat.

    THE RULE, stated in full so it can be checked against the code:

      1. pool each method's MAE over every (origin, fold) and rank them. The best
         pooled halflife is the CANDIDATE.
      2. the candidate must also be the per-origin winner (best mean MAE within
         that origin) on at least ``min_origins`` of the origins. A pooled mean can
         be moved by one unusual month; three of five independent rankings cannot.
      3. the candidate must beat the default halflife by more than ``min_gain`` in
         relative MAE. Otherwise the stat keeps the default and the report says the
         evidence was ambiguous, rather than shipping the smallest of five numbers
         that are all within noise of each other.
      4. separately, the expanding-mean baseline replaces the selected EWMA only if
         it clears the same two bars against it. It is a different estimator family,
         not a sixth halflife, so it gets its own comparison rather than being
         thrown into the same argmin.
      5. a stat in ``frozen`` keeps the default WHATEVER rules 1-3 say. PTS and AST
         were settled by the production tournament under a pre-registered
         protocol; re-running a selection on new folds until one of them moves is
         exactly the practice pre-registration exists to prevent. Their evidence is
         still computed and still reported - it is informative that these folds
         reproduce the tournament's own "12 looks better, not by enough" - but it
         cannot change anything.

    ``ambiguous`` is a reported column, not a footnote: a stat that fell through to
    the default because nothing separated the grid is a materially different claim
    from a stat that chose 20 on the evidence, and the two must not read the same
    in a table.
    """
    if selection.empty:
        return pd.DataFrame()

    grid_names = [f"h{h:g}" for h in halflives]
    default_name = f"h{default:g}"
    pooled = selection.groupby(["target", "method"])["MAE"].mean()
    per_origin = selection.groupby(["target", "origin", "method"])["MAE"].mean()

    rows: list[dict] = []
    for target in selection["target"].unique():
        available = [n for n in grid_names if (target, n) in pooled.index]
        if not available or (target, default_name) not in pooled.index:
            continue
        default_mae = float(pooled[(target, default_name)])
        ranked = sorted(available, key=lambda n: float(pooled[(target, n)]))
        candidate = ranked[0]
        candidate_mae = float(pooled[(target, candidate)])

        origins_won = 0
        for origin in selection.loc[selection["target"] == target, "origin"].unique():
            local = {
                n: float(per_origin[(target, origin, n)])
                for n in available if (target, origin, n) in per_origin.index
            }
            if local and min(local, key=local.get) == candidate:
                origins_won += 1
        n_origins = int(selection.loc[selection["target"] == target, "origin"].nunique())

        gain = 1.0 - candidate_mae / default_mae if default_mae else 0.0
        consistent = origins_won >= min(min_origins, n_origins)
        is_frozen = target in frozen
        chosen = (
            default_name if is_frozen
            else candidate if (gain > min_gain and consistent)
            else default_name
        )
        ambiguous = (
            not is_frozen and chosen == default_name and candidate != default_name
        )

        chosen_mae = float(pooled[(target, chosen)])
        expanding_mae = (
            float(pooled[(target, "expanding")])
            if (target, "expanding") in pooled.index else float("nan")
        )
        expanding_gain = (
            1.0 - expanding_mae / chosen_mae if chosen_mae and np.isfinite(expanding_mae)
            else float("nan")
        )
        estimator = (
            "expanding"
            if not is_frozen
            and np.isfinite(expanding_gain)
            and expanding_gain > min_gain
            else "ewma"
        )

        rows.append({
            "target": target,
            "halflife": float(chosen.lstrip("h")),
            "estimator": estimator,
            "best_grid_halflife": float(candidate.lstrip("h")),
            "best_grid_mae": candidate_mae,
            "default_mae": default_mae,
            "gain_vs_default": gain,
            "origins_won": origins_won,
            "origins": n_origins,
            "expanding_mae": expanding_mae,
            "expanding_gain_vs_chosen": expanding_gain,
            "ambiguous": ambiguous,
            "rule": (
                "FROZEN by the production tournament" if is_frozen
                else "default (evidence ambiguous)" if ambiguous
                else "default (already best)" if chosen == default_name
                else "selected on inner folds"
            ),
        })
    order = {t: i for i, t in enumerate(RATE_TARGETS)}
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    return out.sort_values("target", key=lambda s: s.map(order)).reset_index(drop=True)


def _rate_ladder(
    rec: "_Recorder",
    origin: str,
    train_app: pd.DataFrame,
    valid_all: pd.DataFrame,
    valid_app: pd.DataFrame,
    scored: pd.DataFrame,
    targets: tuple[str, ...],
) -> None:
    """the three-member bracket per rate target, conditional AND unconditional.

    NO EXTRA MODEL FITS. The availability probability and the minutes prediction
    are already on ``scored`` from the main pass, so eleven stats cost eleven
    arithmetic passes rather than twenty-two LightGBM fits. That is also what makes
    the numbers comparable to the PTS row of the main unconditional table: it is
    the same P(play) and the same E[MIN|plays], not a re-fit that happens to be
    configured the same way.

    the coherence clip is applied to the CHAMPION composition's unconditional
    estimates and the share of rows it moved is recorded, so "how often does the
    clip bind" is answered by the evaluation rather than asserted by the docstring.
    """
    # the appearance subset OF THE SCORED FRAME, not of the raw validation frame:
    # it is the only one carrying MIN_PRED, and taking it by index rather than
    # re-filtering guarantees the conditional and unconditional numbers describe
    # the same rows scored by the same two models.
    scored_app = scored.loc[valid_app.index]
    champion_uncond: dict[str, np.ndarray] = {}
    champion_cond: dict[str, np.ndarray] = {}

    for target in targets:
        if target not in valid_app.columns:
            continue
        y_cond = valid_app[target].to_numpy(dtype=float)
        y_unc = valid_all[target].to_numpy(dtype=float)
        task = rate_task(target)
        uncond_task = rate_task(target, unconditional=True)

        ewma_rate = PerMinuteRate(target, estimator="ewma").fit(train_app)
        exp_rate = PerMinuteRate(target, estimator="expanding").fit(train_app)
        total = whole_game_ewma_column(target, RATE_HALFLIFE_DEFAULT)

        # --- conditional: appearances only ---
        minutes_app = scored_app[MIN_PRED].to_numpy(dtype=float)
        cond = {
            RATE_MODEL_EXPANDING: conditional_estimate(
                minutes_app, exp_rate.predict(scored_app)
            ),
            RATE_MODEL_EWMA: conditional_estimate(
                minutes_app, ewma_rate.predict(scored_app)
            ),
        }
        if total in scored_app.columns:
            fallback = float(train_app[target].mean())
            cond[RATE_MODEL_TOTAL] = np.clip(
                baseline_column(scored_app, total, fallback), 0.0, None
            )
        for name, pred in cond.items():
            rec.seg_mae(task, origin, name, scored_app, y_cond, pred)
        ref = cond[RATE_SKILL_BASELINE]
        for name, pred in cond.items():
            rec.record(task, origin, name, "MAESkill",
                       skill_score(mae(y_cond, pred), mae(y_cond, ref)), len(y_cond))

        # --- unconditional: every scheduled row, through the guarded composition ---
        ppm_cond, ppm_uncond = minutes_propagated_estimate(
            scored, ewma_rate.predict(scored)
        )
        _, exp_uncond = minutes_propagated_estimate(scored, exp_rate.predict(scored))
        unc = {
            RATE_MODEL_EXPANDING: exp_uncond,
            RATE_MODEL_EWMA: ppm_uncond,
        }
        if total in scored.columns:
            fallback = float(train_app[target].mean())
            unc[RATE_MODEL_TOTAL] = decomposed_estimate(
                scored, np.clip(baseline_column(scored, total, fallback), 0.0, None)
            )
        for name, pred in unc.items():
            rec.seg_mae(uncond_task, origin, name, valid_all, y_unc, pred)
        ref = unc[RATE_SKILL_BASELINE]
        for name, pred in unc.items():
            rec.record(uncond_task, origin, name, "MAESkill",
                       skill_score(mae(y_unc, pred), mae(y_unc, ref)), len(y_unc))

        champion_uncond[target] = ppm_uncond
        champion_cond[target] = ppm_cond

    # --- the coherence audit, on the champion composition ---
    for label, values in (("uncond", champion_uncond), ("cond", champion_cond)):
        if not values:
            continue
        _, counts = coherence_clip(values)
        total_rows = len(valid_all)
        for constraint, bound_rows in counts.items():
            rec.record(TASK_COHERENCE, origin, label, "ClipRate",
                       bound_rows / total_rows if total_rows else float("nan"),
                       total_rows, segment=constraint)


def run_rolling_origin(
    features: pd.DataFrame,
    origins: list[tuple[str, str, str]] | None = None,
    drop_features: tuple[str, ...] | list[str] = (),
    feature_set: str | None = None,
    rate_targets: tuple[str, ...] = RATE_TARGETS,
) -> pd.DataFrame:
    """the whole ladder over every origin. returns tidy long results.

    ``drop_features`` removes columns from the FEATURE LIST only, never from the
    frame. ``feature_set`` names one of ``config.FEATURE_SETS`` and replaces the
    default list entirely. Both mechanisms share the same distinction, and it is the
    point: the cohort definitions still read ``vacated_minutes`` off the dataset, so
    every pass partitions the validation rows identically and their cohort numbers
    describe the same games.

    ``rate_targets`` names the stats the 9-cat rate ladder runs over. It costs NO
    extra model fits - the ladder reuses the availability probability and the
    minutes prediction the unconditional pass already produced - so it is on by
    default rather than behind a flag. Pass ``()`` to skip it.
    """
    origins = origins or ORIGINS
    df = features.copy()
    df["GAME_DATE"] = pd.to_datetime(df["GAME_DATE"])
    df = df.sort_values("GAME_DATE").reset_index(drop=True)
    rate_targets = tuple(t for t in rate_targets if t in df.columns)
    if rate_targets:
        # the whole-game EWMA ladder member needs a column no dataset carries for
        # the stats outside ROLL_STATS, so the grid supplies it. an EMPTY halflife
        # tuple is passed deliberately: the per-minute rate columns are already on
        # the dataset at the SHIPPED halflife, and recomputing the five-value sweep
        # here would be five times the work for numbers only the selection needs.
        df = attach_rate_grid(df, build_rate_grid(df, rate_targets, ()))
    dropped = set(drop_features)
    chosen = (
        feature_set_columns(df, feature_set) if feature_set else available_features(df)
    )
    feats = [c for c in chosen if c not in dropped]
    if feature_set:
        log.info("running feature set %s with %d features", feature_set, len(feats))
    if dropped:
        log.info("running with %d features, %d dropped: %s",
                 len(feats), len(dropped), ", ".join(sorted(dropped)))

    rec = _Recorder()
    for origin, vstart, vend in origins:
        train_all, valid_all = split(df, vstart, vend)
        train_app = train_all[train_all["PLAYED"] == 1]
        valid_app = valid_all[valid_all["PLAYED"] == 1]
        if train_all.empty or valid_all.empty or train_app.empty or valid_app.empty:
            log.warning("origin %s has an empty side; skipped", origin)
            continue

        log.info("%s: train %d / valid %d rows (played rate %.4f)",
                 origin, len(train_all), len(valid_all), valid_all["PLAYED"].mean())

        scored = _availability(rec, origin, feats, train_all, valid_all)
        _conditional(rec, origin, feats, train_app, valid_app)
        scored = _unconditional(
            rec, origin, feats, train_all, train_app, valid_all, scored
        )
        if rate_targets:
            _rate_ladder(rec, origin, train_app, valid_all, valid_app, scored,
                         rate_targets)

    results = rec.frame()
    if results.empty:
        raise ValueError("no origin produced results; check the date ranges in config.ORIGINS")
    return results


def mean_by_model(results: pd.DataFrame, task: str, metric: str) -> pd.Series:
    """mean metric per model over origins, overall segment only."""
    sub = results[
        (results["task"] == task) & (results["metric"] == metric) & (results["segment"] == "ALL")
    ]
    return sub.groupby("model")["value"].mean().sort_values()


def select_champions(results: pd.DataFrame) -> pd.DataFrame:
    """per-target measured winner vs the champion config actually ships.

    a mismatch is a finding to look at, not an instruction to promote: the
    spike's whole point is that a 1% MAE edge does not justify a trained model
    in the serving path.
    """
    rows = []
    for task, family in TASK_FAMILY.items():
        metric = "Brier" if task == TASK_AVAILABILITY else "MAE"
        means = mean_by_model(results, task, metric)
        if means.empty:
            continue
        measured = str(means.index[0])
        configured = CHAMPIONS[family]
        rows.append({
            "task": task,
            "family": family,
            "metric": metric,
            "measured_best": measured,
            "measured_value": float(means.iloc[0]),
            "configured_champion": configured,
            "configured_value": float(means.get(configured, np.nan)),
            "matches_config": measured == configured,
        })
    return pd.DataFrame(rows)


def composition_parity(
    results: pd.DataFrame,
    tolerance: float = COMPOSITION_PARITY_TOLERANCE,
    previous: str = PREVIOUS_COMPOSITION,
) -> dict[str, object]:
    """did promoting the minutes-propagating composition cost accuracy?

    the promotion was made on a correctness argument, so the bar is PARITY, not
    improvement: the champion must not lose more than ``tolerance`` relative MAE to
    the composition it replaced. ``relative_delta`` is positive when the champion is
    WORSE, which is the direction that matters.

    an empty dict when either composition is missing from the results, because
    "the check could not run" and "the check passed" are different facts and only
    one of them should ever be reported as a pass.
    """
    if results.empty or not {"task", "metric", "segment", "model"} <= set(results.columns):
        return {}
    means = mean_by_model(results, TASK_UNCONDITIONAL, "MAE")
    champion = CHAMPIONS["composition"]
    if champion not in means.index or previous not in means.index:
        return {}
    champion_mae = float(means[champion])
    previous_mae = float(means[previous])
    delta = champion_mae / previous_mae - 1.0 if previous_mae else float("nan")
    return {
        "champion": champion,
        "champion_mae": champion_mae,
        "previous": previous,
        "previous_mae": previous_mae,
        "relative_delta": delta,
        "tolerance": float(tolerance),
        "within_tolerance": bool(delta <= tolerance),
    }


def rate_composition_parity(
    results: pd.DataFrame,
    targets: tuple[str, ...] = RATE_TARGETS,
    tolerance: float = COMPOSITION_PARITY_TOLERANCE,
) -> pd.DataFrame:
    """:func:`composition_parity`, asked once per served stat instead of once for PTS.

    THE SAME QUESTION, WIDENED. ``composition_parity`` asks whether promoting
    ``P(play) x E[MIN|play] x rate`` over ``P(play) x EWMA(stat)`` cost accuracy,
    and it asks it about points only, because points was the only stat the
    composition served when that check was written. Extending the vocabulary to
    eleven stats extends the obligation: the correctness argument for minutes
    propagation is stat-agnostic, so the accuracy bar has to be cleared
    stat-by-stat rather than cleared once for PTS and assumed for blocks.

    ``relative_delta`` is positive when the CHAMPION IS WORSE - the same sign
    convention the original check uses, chosen so that the number that fails is the
    number that is bad.

    a stat missing either member is omitted rather than passed. The whole reason
    the original returns an empty dict instead of a pass is that "the check could
    not run" and "the check passed" must never render the same.
    """
    rows: list[dict] = []
    for target in targets:
        means = mean_by_model(results, rate_task(target, unconditional=True), "MAE")
        # the SHIPPED estimator, not the EWMA by assumption. STL ships the
        # expanding baseline, and checking parity on an estimator it does not use
        # would be checking a number nobody will ever serve.
        champion_model = (
            RATE_MODEL_EXPANDING if RATE_ESTIMATORS.get(target) == "expanding"
            else RATE_MODEL_EWMA
        )
        if champion_model not in means.index or RATE_MODEL_TOTAL not in means.index:
            continue
        champion = float(means[champion_model])
        previous = float(means[RATE_MODEL_TOTAL])
        delta = champion / previous - 1.0 if previous else float("nan")
        rows.append({
            "target": target,
            "champion": champion_model,
            "champion_mae": champion,
            "previous_mae": previous,
            "relative_delta": delta,
            "tolerance": float(tolerance),
            "within_tolerance": bool(delta <= tolerance),
        })
    return pd.DataFrame(rows)


def _pivot(results: pd.DataFrame, task: str, metric: str, segment: str = "ALL") -> pd.DataFrame:
    sub = results[
        (results["task"] == task) & (results["metric"] == metric)
        & (results["segment"] == segment)
    ]
    piv = sub.pivot_table(index="model", columns="origin", values="value")
    piv["mean"] = piv.mean(axis=1)
    piv = piv.sort_values("mean")
    piv.index = [MODEL_LABELS.get(m, m) for m in piv.index]
    return piv


def _segment_pivot(
    results: pd.DataFrame,
    task: str,
    order: tuple[str, ...] = TIER_ORDER,
    metric: str = "MAE",
) -> pd.DataFrame:
    sub = results[
        (results["task"] == task) & (results["metric"] == metric)
        & (results["segment"] != "ALL")
    ]
    if sub.empty:
        return pd.DataFrame()
    piv = sub.pivot_table(index="model", columns="segment", values="value")
    cols = [c for c in order if c in piv.columns]
    if not cols:
        return pd.DataFrame()
    piv = piv[cols]
    piv.index = [MODEL_LABELS.get(m, m) for m in piv.index]
    return piv


def importance_table(
    results: pd.DataFrame, task: str = TASK_IMPORTANCE, top: int | None = None
) -> pd.DataFrame:
    """mean split gain per feature per model, with a rank. tidy -> readable.

    ranked WITHIN each model rather than pooled: availability gain and minutes gain
    are not on the same scale and a pooled ranking would be arithmetic on
    incomparable units.
    """
    sub = results[(results["task"] == task) & (results["metric"] == "Gain")]
    if sub.empty:
        return pd.DataFrame()
    means = sub.groupby(["model", "segment"])["value"].mean().rename("gain").reset_index()
    means["rank"] = means.groupby("model")["gain"].rank(ascending=False, method="min")
    means["share"] = means["gain"] / means.groupby("model")["gain"].transform("sum")
    means = means.rename(columns={"segment": "feature"})
    means = means.sort_values(["model", "rank"])
    if top is not None:
        means = means[means["rank"] <= top]
    return means[["model", "feature", "gain", "share", "rank"]]


def teammate_importance(results: pd.DataFrame) -> pd.DataFrame:
    """the importance table restricted to the teammate families, plus the control.

    the whole question the P1/P1b phases have to answer with a number: of the ~51
    columns the served models see, where did the expected-context and reliability
    columns land, and did the permuted twin land below them? The ORACLE names are
    kept in the filter too, so an oracle-set pass reports its own ranks in the same
    table and the two constructions' importance profiles can be read side by side.
    """
    wanted = (
        set(TEAMMATE_FEATURE_COLS)
        | set(TEAMMATE_ORACLE_COLS)
        | {NEGATIVE_CONTROL_COLUMN}
    )
    frames = []
    for task in (TASK_IMPORTANCE, TASK_NEGATIVE_CONTROL):
        table = importance_table(results, task)
        if table.empty:
            continue
        table = table[table["feature"].isin(wanted)].copy()
        table["pass"] = "main" if task == TASK_IMPORTANCE else "negative-control fit"
        frames.append(table)
    if not frames:
        return pd.DataFrame()
    out = pd.concat(frames, ignore_index=True)
    return out[["pass", "model", "feature", "gain", "share", "rank"]]


def _format_comparison(comparison: pd.DataFrame) -> pd.DataFrame:
    """flatten the MultiIndex and pre-format the numbers for markdown.

    ``to_markdown(floatfmt=...)`` positions its formats by COLUMN, and a MultiIndex
    shifts every position by the number of index levels - which silently rendered
    the ``after`` column with the ``delta`` format and printed absolute MAEs as
    percentages. Formatting here removes the coupling entirely.
    """
    out = comparison.reset_index()
    if "n" in out.columns:
        out["n"] = out["n"].fillna(0).astype(int).map("{:,}".format)
    for column in ("before", "after"):
        if column in out.columns:
            out[column] = out[column].map("{:.4f}".format)
    if "delta" in out.columns:
        out["delta"] = out["delta"].map("{:+.4f}".format)
    if "delta_pct" in out.columns:
        out["delta_pct"] = out["delta_pct"].map("{:+.2%}".format)
    return out


def _format_importance(importance: pd.DataFrame) -> pd.DataFrame:
    """same reason: gain spans six orders of magnitude and share reads as a %."""
    out = importance.copy()
    out["gain"] = out["gain"].map("{:,.0f}".format)
    out["share"] = out["share"].map("{:.2%}".format)
    out["rank"] = out["rank"].astype(int)
    return out


COMPARISON_TARGETS: tuple[tuple[str, str, str], ...] = (
    (TASK_AVAILABILITY, "availability", "Brier"),
    (TASK_MINUTES, "minutes", "MAE"),
    (TASK_UNCONDITIONAL, "composition", "MAE"),
)


def feature_set_comparison(
    baseline: pd.DataFrame, candidate: pd.DataFrame
) -> pd.DataFrame:
    """before/after per cohort for the three headline metrics.

    ``baseline`` and ``candidate`` are two ``run_rolling_origin`` results frames
    over the SAME dataset and the SAME origins, differing only in which columns the
    estimators were allowed to see. ``delta`` is candidate minus baseline, so
    NEGATIVE IS BETTER for both Brier and MAE - the same sign convention
    ``composition_parity`` uses, for the same reason: the direction that matters is
    the one where the change costs something.
    """
    required = {"task", "metric", "model", "segment", "origin", "value", "n"}
    for frame in (baseline, candidate):
        if frame is None or frame.empty or not required <= set(frame.columns):
            return pd.DataFrame()

    rows: list[dict] = []
    for task, family, metric in COMPARISON_TARGETS:
        model = CHAMPIONS[family]
        for frame, tag in ((baseline, "before"), (candidate, "after")):
            sub = frame[
                (frame["task"] == task) & (frame["metric"] == metric)
                & (frame["model"] == model)
            ]
            if sub.empty:
                break
            for segment, group in sub.groupby("segment"):
                rows.append({
                    "task": task, "metric": metric, "segment": segment,
                    "which": tag, "value": float(group["value"].mean()),
                    "n": int(group.drop_duplicates("origin")["n"].sum()),
                })
    if not rows:
        return pd.DataFrame()

    tidy = pd.DataFrame(rows)
    wide = tidy.pivot_table(
        index=["task", "metric", "segment"], columns="which", values="value"
    )
    support = (
        tidy[tidy["which"] == "after"]
        .set_index(["task", "metric", "segment"])["n"]
    )
    wide["n"] = support
    if {"before", "after"} <= set(wide.columns):
        wide["delta"] = wide["after"] - wide["before"]
        wide["delta_pct"] = wide["delta"] / wide["before"]
        wide = wide[["n", "before", "after", "delta", "delta_pct"]]

    order = ["ALL", *TIER_ORDER, *EVENT_COHORT_ORDER,
             *V4_DESCRIPTIVE_COHORT_ORDER]
    rank = {label: i for i, label in enumerate(order)}
    wide = wide.reset_index()
    wide["_order"] = wide["segment"].map(rank).fillna(len(order))
    wide = wide.sort_values(["task", "_order"]).drop(columns="_order")
    return wide.set_index(["task", "metric", "segment"])


# ---------------------------------------------------------------------------
# the P1b bracket: v1 / v3-honest / v2-oracle over identical rows
# ---------------------------------------------------------------------------
def run_feature_set_bracket(
    features: pd.DataFrame,
    origins: list[tuple[str, str, str]] | None = None,
    names: tuple[str, ...] = tuple(FEATURE_SETS),
    rate_targets: tuple[str, ...] = RATE_TARGETS,
) -> dict[str, pd.DataFrame]:
    """the same ladder, the same rows, the same origins, three feature lists.

    the honest form of the claim the round-2 review demanded. Returns one results
    frame per feature set, keyed by name, so every downstream table is built from
    comparable numbers rather than from two reports written a day apart.

    the rate ladder runs in every pass, not only the served one. It reads the
    minutes prediction each pass produced, so a feature set that changes the
    minutes model changes every production stat downstream of it - and the bracket
    is the only place that effect is visible for the nine new stats.
    """
    origins = origins or ORIGINS
    out: dict[str, pd.DataFrame] = {}
    for name in names:
        log.info("bracket pass: feature set %s", name)
        out[name] = run_rolling_origin(
            features, origins, feature_set=name, rate_targets=rate_targets
        )
    return out


def feature_set_bracket(
    passes: dict[str, pd.DataFrame],
    reference: str = "v1",
    honest: str = SERVED_FEATURE_SET,
    oracle: str = ORACLE_FEATURE_SET,
) -> pd.DataFrame:
    """the bracket table: each set's metric per cohort, plus deltas against v1.

    THE NUMBER THE PHASE EXISTS TO PRODUCE. ``honest_pct`` and ``oracle_pct`` are
    relative changes against ``reference``, negative meaning better. ``survived`` is
    the share of the oracle's improvement that honest construction keeps:

        survived = honest_delta / oracle_delta

    read it as a fraction of a value-of-perfect-lineup-information result. 1.0 would
    mean the probabilistic construction recovers everything the final inactive list
    was worth; 0.0 means the entire v2 gain was hindsight. It is NaN when the oracle
    delta is ~0 (nothing to survive), and it can exceed 1 or go negative - both are
    real findings and neither is clipped away: >1 means the honest set beat the
    oracle set, which happens when the reliability columns add something the oracle
    set does not have, and <0 means the honest set moved the wrong way.
    """
    required = {"task", "metric", "model", "segment", "origin", "value", "n"}
    for name, frame in passes.items():
        if frame is None or frame.empty or not required <= set(frame.columns):
            log.warning("bracket pass %s is empty or malformed; no bracket table", name)
            return pd.DataFrame()

    rows: list[dict] = []
    for task, family, metric in COMPARISON_TARGETS:
        model = CHAMPIONS[family]
        for name, frame in passes.items():
            sub = frame[
                (frame["task"] == task) & (frame["metric"] == metric)
                & (frame["model"] == model)
            ]
            for segment, group in sub.groupby("segment"):
                rows.append({
                    "task": task, "metric": metric, "segment": segment,
                    "set": name, "value": float(group["value"].mean()),
                    "n": int(group.drop_duplicates("origin")["n"].sum()),
                })
    if not rows:
        return pd.DataFrame()

    tidy = pd.DataFrame(rows)
    wide = tidy.pivot_table(
        index=["task", "metric", "segment"], columns="set", values="value"
    )
    support = tidy.drop_duplicates(["task", "metric", "segment", "set"])
    support = (
        support[support["set"] == honest]
        .set_index(["task", "metric", "segment"])["n"]
    )
    wide["n"] = support
    if {reference, honest, oracle} <= set(wide.columns):
        wide["honest_pct"] = wide[honest] / wide[reference] - 1.0
        wide["oracle_pct"] = wide[oracle] / wide[reference] - 1.0
        honest_delta = wide[honest] - wide[reference]
        oracle_delta = wide[oracle] - wide[reference]
        wide["survived"] = np.where(
            oracle_delta.abs() > 1e-9, honest_delta / oracle_delta, np.nan
        )
        columns = ["n", reference, honest, oracle,
                   "honest_pct", "oracle_pct", "survived"]
        # P2's candidate, if this bracket ran it. Reported RELATIVE TO THE SERVED SET
        # rather than to v1, and that is the whole point of the extra column: v4's
        # question is not "is teammate context worth anything" - v1 is the reference
        # for that - but "does the game-context family buy anything ON TOP OF the
        # contract that ships". A v4-vs-v1 number would flatter the candidate by
        # crediting it with the v3 gain it inherits for free.
        if CANDIDATE_FEATURE_SET in wide.columns:
            wide["candidate_pct_vs_served"] = (
                wide[CANDIDATE_FEATURE_SET] / wide[honest] - 1.0
            )
            columns.extend([CANDIDATE_FEATURE_SET, "candidate_pct_vs_served"])
        wide = wide[columns]

    order = ["ALL", *TIER_ORDER, *EVENT_COHORT_ORDER,
             *V4_DESCRIPTIVE_COHORT_ORDER]
    rank = {label: i for i, label in enumerate(order)}
    wide = wide.reset_index()
    wide["_order"] = wide["segment"].map(rank).fillna(len(order))
    wide = wide.sort_values(["task", "_order"]).drop(columns="_order")
    return wide.set_index(["task", "metric", "segment"])


# ---------------------------------------------------------------------------
# the single-feature ablation (reported, not asserted)
# ---------------------------------------------------------------------------
ABLATION_FEATURE = "exp_depth_rank"


def single_feature_ablation(
    features: pd.DataFrame,
    origins: list[tuple[str, str, str]] | None = None,
    feature: str = ABLATION_FEATURE,
    feature_set: str = SERVED_FEATURE_SET,
    full: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """refit the served set with exactly one column removed; report the delta.

    REPORTED, NOT ASSERTED, and the distinction is deliberate. The v2 finding was
    that ``depth_rank_available`` carried 18% of the minutes model's split gain,
    which is a statement about how a booster allocated credit among correlated
    columns and not a statement about how much the column is worth. An ablation
    answers the second question directly: refit without it and see what the metric
    does. There is no threshold it has to clear - a small delta next to a large gain
    share means the other columns substitute for it, which is information rather than
    a failure.
    """
    origins = origins or ORIGINS
    if feature not in features.columns:
        log.warning("no %s on the frame; ablation skipped", feature)
        return pd.DataFrame()
    # ``full`` is the unablated pass. The bracket already computes exactly that frame
    # for the served set, so the caller passes it in and the ablation costs ONE extra
    # pass rather than two. Recomputing it would burn a fifth of the run's budget to
    # produce a table byte-identical to one already in memory.
    if full is None:
        full = run_rolling_origin(features, origins, feature_set=feature_set)
    without = run_rolling_origin(
        features, origins, feature_set=feature_set, drop_features=(feature,)
    )
    table = feature_set_comparison(full, without)
    if table.empty:
        return table
    # feature_set_comparison's sign convention is "after minus before", and here
    # `after` is the ABLATED run - so a positive delta means removing the column cost
    # accuracy, i.e. the column was worth something. Renamed so nobody has to
    # remember which frame went in which slot.
    return table.rename(
        columns={"before": "with", "after": "without",
                 "delta": "cost_of_removal", "delta_pct": "cost_of_removal_pct"}
    )


# ---------------------------------------------------------------------------
# the Level-C degraded-oracle grid
# ---------------------------------------------------------------------------
def degrade_absence_knowledge(
    features: pd.DataFrame,
    recall: float,
    false_positive_rate: float,
    seed: int = RANDOM_STATE,
) -> np.ndarray:
    """a synthetic p_j standing for "the report gets absences this right".

    THE REVIEW'S LEVEL-C PROBE. The bracket's two ends are perfect information
    (v2-oracle) and our own base model (v3-honest). Between them sits the question a
    product actually faces: if a pre-tipoff report identified ``recall`` of tonight's
    absences and falsely flagged ``false_positive_rate`` of the players who did in
    fact play, how much of the oracle gain would that be worth?

    the construction is a labelled corruption of the realized absence set, turned
    into probabilities:

      * a genuinely absent player is flagged with probability ``recall``; flagged
        means p = 0, unflagged means p = his base-model probability.
      * a genuinely present player is falsely flagged with probability
        ``false_positive_rate``; flagged means p = 0.

    ``recall = 1, fp = 0`` reproduces the oracle exactly and is included in the grid
    as the arithmetic check on that claim. This is a DIAGNOSTIC, not a feature: it
    reads target-game labels by construction, which is the whole point, and nothing
    it produces may ever reach a served artifact.
    """
    rng = np.random.default_rng(seed)
    absent = absence_mask(features)
    base = pd.to_numeric(features.get(P_CONTEXT), errors="coerce")
    if base is None or base.isna().all():
        base = pd.Series(np.full(len(features), 0.7), index=features.index)
    p = base.fillna(0.7).to_numpy(dtype=float).copy()

    draws = rng.random(len(features))
    known_out = absent & (draws < recall)
    false_out = (~absent) & (draws < false_positive_rate)
    p[known_out | false_out] = 0.0
    # a player the degraded report did NOT flag as out is left at his base-model
    # probability rather than being forced to 1: a report that misses an absence is
    # silent about him, not confident about him.
    return p


DEGRADED_RECALLS: tuple[float, ...] = (0.4, 0.6, 0.8, 1.0)
DEGRADED_FALSE_POSITIVES: tuple[float, ...] = (0.0, 0.05, 0.10)


def degraded_oracle_grid(
    features: pd.DataFrame,
    origins: list[tuple[str, str, str]] | None = None,
    recalls: tuple[float, ...] = DEGRADED_RECALLS,
    false_positives: tuple[float, ...] = DEGRADED_FALSE_POSITIVES,
) -> pd.DataFrame:
    """availability Brier and minutes MAE across the recall x false-positive grid.

    DELIBERATELY NOT THE FULL LADDER. Twelve cells times five origins times the whole
    ladder is an hour of LightGBM for a diagnostic; this fits only the two targets the
    teammate features are supposed to move - availability and minutes|played - which
    is 2 fits per cell per origin, and reports those. The unconditional points number
    is a product of the two and adds nothing the pair does not already show.
    """
    from .features import attach_expected_context  # noqa: PLC0415 - avoids a cycle

    origins = origins or ORIGINS
    feats_list = feature_set_columns(features, SERVED_FEATURE_SET)
    rows: list[dict] = []
    for recall in recalls:
        for fp in false_positives:
            p = degrade_absence_knowledge(features, recall, fp)
            frame = attach_expected_context(features, p, features["GAME_DATE"])
            frame = frame.sort_values("GAME_DATE").reset_index(drop=True)
            for origin, vstart, vend in origins:
                train_all, valid_all = split(frame, vstart, vend)
                train_app = train_all[train_all["PLAYED"] == 1]
                valid_app = valid_all[valid_all["PLAYED"] == 1]
                if train_all.empty or valid_all.empty or train_app.empty or valid_app.empty:
                    continue
                cutoff = pd.Timestamp(vstart)
                availability = AvailabilityModel(
                    kind=CHAMPIONS["availability"]
                ).fit(train_all, feats_list, cutoff)
                minutes = MinutesModel(kind=CHAMPIONS["minutes"]).fit(
                    train_app, feats_list, cutoff
                )
                rows.append({
                    "recall": recall, "false_positive_rate": fp, "origin": origin,
                    "availability_brier": brier(
                        valid_all["PLAYED"].to_numpy(dtype=int),
                        availability.predict_proba(valid_all),
                    ),
                    "minutes_mae": mae(
                        valid_app["MIN"].to_numpy(dtype=float),
                        minutes.predict(valid_app),
                    ),
                    "n_valid": int(len(valid_all)),
                })
    if not rows:
        return pd.DataFrame()
    tidy = pd.DataFrame(rows)
    return (
        tidy.groupby(["recall", "false_positive_rate"])[
            ["availability_brier", "minutes_mae"]
        ]
        .mean()
        .reset_index()
    )


# ---------------------------------------------------------------------------
# the team-game block permutation
# ---------------------------------------------------------------------------
def block_permute_context(
    features: pd.DataFrame,
    columns: list[str] | None = None,
    seed: int = RANDOM_STATE,
) -> pd.DataFrame:
    """permute the served context block across TEAM-GAMES, keeping rows together.

    THE RIGHT NULL FOR THIS FAMILY, and a strictly harder one than the per-row
    permutation ``add_negative_control`` builds. A per-row permutation destroys the
    within-team-game structure as well as the relationship to the outcome, so a
    booster can in principle notice that the block no longer coheres and discount it
    for the wrong reason. Permuting at the TEAM-GAME level hands every row a context
    block that is internally consistent - a real team's real expected vacancies - and
    merely attaches it to the wrong game. If importance does not collapse under that,
    the model is reading something other than the context.

    the permutation is a derangement over team-games with the same roster size
    where possible: blocks are grouped by size so that a 17-man roster's context is
    swapped with another 17-man roster's, and a row's own position within the block is
    preserved. That keeps the marginal distribution of every column exactly intact.
    """
    columns = list(columns or TEAMMATE_EXPECTED_COLS)
    present = [c for c in columns if c in features.columns]
    if not present:
        return features
    out = features.copy().reset_index(drop=True)
    rng = np.random.default_rng(seed)

    keys = list(zip(out["GAME_ID"].astype(str), out["TEAM_ID"].astype(str)))
    order = pd.Series(range(len(out)))
    groups = order.groupby(pd.Series(keys)).apply(list)

    by_size: dict[int, list[list[int]]] = {}
    for indices in groups:
        by_size.setdefault(len(indices), []).append(indices)

    source_rows = np.arange(len(out))
    for size, blocks in by_size.items():
        if len(blocks) < 2:
            continue
        shuffled = rng.permutation(len(blocks))
        for target, donor in enumerate(shuffled):
            if target == donor:
                continue
            for position in range(size):
                source_rows[blocks[target][position]] = blocks[donor][position]

    for column in present:
        out[column] = out[column].to_numpy()[source_rows]
    return out


def _format_bracket(bracket: pd.DataFrame) -> pd.DataFrame:
    """same MultiIndex/floatfmt hazard as _format_comparison, same fix."""
    out = bracket.reset_index()
    if "n" in out.columns:
        out["n"] = out["n"].fillna(0).astype(int).map("{:,}".format)
    for column in ("v1", SERVED_FEATURE_SET, ORACLE_FEATURE_SET):
        if column in out.columns:
            out[column] = out[column].map("{:.4f}".format)
    for column in ("honest_pct", "oracle_pct"):
        if column in out.columns:
            out[column] = out[column].map("{:+.2%}".format)
    if "survived" in out.columns:
        out["survived"] = out["survived"].map(
            lambda v: "n/a" if pd.isna(v) else f"{v:.0%}"
        )
    return out


def rate_task(target: str, unconditional: bool = False) -> str:
    """the tidy-frame task name for one rate target.

    ONE function rather than two format strings at each call site: the
    conditional and unconditional names differ in BOTH the prefix and the suffix,
    and an earlier version of ``rate_ladder_table`` parameterised only the prefix -
    which silently produced a task name matching nothing and an empty
    unconditional table rather than an error.
    """
    if unconditional:
        return f"{RATE_UNCOND_TASK_PREFIX} {target.lower()} UNCONDITIONAL"
    return f"{RATE_TASK_PREFIX} {target.lower()}|played"


def rate_ladder_table(
    results: pd.DataFrame,
    targets: tuple[str, ...] = RATE_TARGETS,
    unconditional: bool = False,
) -> pd.DataFrame:
    """one row per rate target: each ladder member's MAE and the champion's edge.

    the 9-cat headline. It is a table over STATS rather than over origins because
    the question it answers is "did each of the eleven stats' estimator earn its
    place", and eleven per-origin pivots is not a table anyone reads.

    ``vs_expanding`` and ``vs_ewma_total`` are relative improvements of the
    CHAMPION over each of the two things it had to beat, so POSITIVE IS BETTER -
    the opposite sign convention from ``feature_set_comparison``'s ``delta``, and
    it is opposite on purpose: that one reports the cost of a change and this one
    reports the gain of an estimator.

    ``champion_mae`` is the SHIPPED estimator's number, read from
    ``config.RATE_ESTIMATORS`` rather than assumed to be the EWMA. For STL the
    shipped estimator IS the expanding baseline, so its ``vs_expanding`` is
    identically zero - and a table that hardcoded the EWMA as the champion would
    have reported STL as losing to a baseline it does not use.

    A NEGATIVE ``vs_expanding`` IS NOT A BUG AND IS NOT A LICENCE TO RESELECT. The
    halflife was chosen on inner folds inside the training window; these are the
    validation rows. When the two disagree, the honest reading is that the
    difference was inside noise in both directions, and switching the champion to
    whatever wins the column being reported would make this table a selection
    surface rather than a report of one.
    """
    rows: list[dict] = []
    for target in targets:
        means = mean_by_model(results, rate_task(target, unconditional), "MAE")
        if means.empty or RATE_MODEL_EWMA not in means.index:
            continue
        estimator = RATE_ESTIMATORS.get(target, "ewma")
        ewma = float(means[RATE_MODEL_EWMA])
        expanding = float(means.get(RATE_MODEL_EXPANDING, np.nan))
        total = float(means.get(RATE_MODEL_TOTAL, np.nan))
        champion = expanding if estimator == "expanding" else ewma
        rows.append({
            "target": target,
            "halflife": RATE_HALFLIVES.get(target, RATE_HALFLIFE_DEFAULT),
            "estimator": estimator,
            "champion_mae": champion,
            "ewma_mae": ewma,
            "expanding_mae": expanding,
            "ewma_total_mae": total,
            "vs_expanding": 1.0 - champion / expanding if expanding else np.nan,
            "vs_ewma_total": 1.0 - champion / total if total else np.nan,
        })
    return pd.DataFrame(rows)


def rate_uncond_table(results: pd.DataFrame, targets: tuple[str, ...] = RATE_TARGETS):
    """the unconditional twin of :func:`rate_ladder_table`, same shape."""
    return rate_ladder_table(results, targets, unconditional=True)


def coherence_table(results: pd.DataFrame) -> pd.DataFrame:
    """how often each coherence constraint bound, per estimate kind.

    THE NUMBER THAT PRICES PER-STAT HALFLIFE SELECTION. Two EWMAs at the same
    halflife are the same weighted average of the same rows, so they cannot cross;
    two at different halflives can. A constraint whose two stats share a halflife
    should therefore report ~0 and a constraint whose two stats do not should
    report something, and the table is readable as a check on that reasoning
    rather than only as an operational statistic.
    """
    sub = results[
        (results["task"] == TASK_COHERENCE) & (results["metric"] == "ClipRate")
    ]
    if sub.empty:
        return pd.DataFrame()
    piv = sub.pivot_table(index="segment", columns="model", values="value")
    piv["rows"] = sub.groupby("segment")["n"].mean()
    return piv


def render_report(
    results: pd.DataFrame,
    champions: pd.DataFrame,
    meta: dict[str, object],
    baseline: pd.DataFrame | None = None,
    lift: pd.DataFrame | None = None,
    bracket: pd.DataFrame | None = None,
    ablation: pd.DataFrame | None = None,
    degraded: pd.DataFrame | None = None,
    rate_winners: pd.DataFrame | None = None,
    rate_selection: pd.DataFrame | None = None,
) -> str:
    """markdown report, shaped to be diffable against the spike's REPORT.md."""
    parts: list[str] = []
    w = parts.append

    w(f"# Rolling-origin evaluation - {meta.get('model_version', 'unversioned')}\n")
    for key in ("generated_at", "dataset", "universe_source", "rows", "players",
                "played_rate", "feature_version", "git_commit"):
        if key in meta:
            w(f"- **{key}**: {meta[key]}")
    if meta.get("universe_source") == "approximation":
        w("\n> **BIASED UNIVERSE.** built from the +/-15 day game-log-presence "
          "approximation, not from `player_game_status`. availability is "
          "over-stated and absence streaks are capped near 16 team-games "
          "(REPORT.md section 5). these numbers are a port-fidelity check, not "
          "a production estimate.")

    w("\n## Champion selection\n")
    if not champions.empty:
        w(champions.to_markdown(index=False, floatfmt=".4f"))
        drift = champions[~champions["matches_config"]]
        if len(drift):
            w("\nMeasured winner differs from the configured champion for: "
              + ", ".join(drift["task"]) + ". Config is deliberate - see "
              "`config.CHAMPIONS` and REPORT.md section 6.")

    parity = composition_parity(results)
    if parity:
        verdict = "PARITY" if parity["within_tolerance"] else "REGRESSION"
        w("\n### Composition parity check\n")
        w(f"- champion `{parity['champion']}`: **{parity['champion_mae']:.4f}** MAE")
        w(f"- previous `{parity['previous']}`: {parity['previous_mae']:.4f} MAE")
        w(f"- relative delta: {parity['relative_delta']:+.2%} "
          f"(tolerance {parity['tolerance']:.2%}) — **{verdict}**")
        w("\nThe minutes-propagating composition was promoted for correctness, not "
          "for accuracy: `P(play) x EWMA(stat)` is not a function of predicted "
          "minutes at all, so a minutes forecast could not reach a production "
          "projection. Parity on aggregate MAE is the expected outcome — most "
          "players' predicted minutes are close to their recent minutes — and the "
          "check above exists to catch the case where the change costs accuracy "
          "rather than to claim it gains any.")

    ladder = rate_ladder_table(results)
    if not ladder.empty:
        w("\n## The 9-category rate ladder\n")
        w("One row per served production stat. Same rows, same origins, one shared "
          "availability model and one shared minutes model — the ONLY thing that "
          "differs between the three members is the per-minute production estimate, "
          "so a difference in MAE is attributable to the estimator and to nothing "
          "else.\n")
        w("- `expanding_mae` — `E[MIN|play] x` career expanding mean of stat/minute. "
          "The baseline with no memory parameter to tune.\n"
          "- `ewma_total_mae` — `EWMA(halflife 5)` of the whole-game total, with no "
          "minutes term at all. This is what the package served for PTS before the "
          "composition change, so it measures whether minutes propagation earns its "
          "place for each stat rather than inheriting the PTS result.\n"
          "- `champion_mae` — `E[MIN|play] x` the selected estimator at the selected "
          "halflife. What ships.\n")
        w("`vs_expanding` and `vs_ewma_total` are relative improvements of the "
          "champion, so **positive is better**.\n")
        w("A **negative** `vs_expanding` is a real disagreement between the inner "
          "folds that chose the halflife and the validation rows reported here, not "
          "an instruction to reselect. Switching the champion to whatever wins this "
          "column would turn the report into a selection surface; the differences "
          "involved are also inside the package's ~2% noise line in both "
          "directions.\n")
        w(ladder.to_markdown(index=False, floatfmt=(".0f", ".0f", "", ".4f", ".4f",
                                                    ".4f", ".4f", "+.2%", "+.2%")))
        uncond = rate_uncond_table(results)
        if not uncond.empty:
            w("\n**Unconditional (`P(play) x` the conditional estimate, over every "
              "scheduled row)**\n")
            w(uncond.to_markdown(index=False, floatfmt=(".0f", ".0f", "", ".4f",
                                                        ".4f", ".4f", ".4f",
                                                        "+.2%", "+.2%")))

    if rate_winners is not None and not rate_winners.empty:
        w("\n### Halflife selection, on inner folds only\n")
        w("Each stat's halflife was chosen on two 28-day folds carved off the END of "
          "each origin's own TRAINING window — never on the origin's validation rows, "
          "which are what the ladder above reports. Selecting on the reported rows "
          "would make every MAE in this document an in-sample number wearing an "
          "out-of-sample label.\n")
        w(f"The rule, pre-registered: the pooled best halflife ships only if it beats "
          f"halflife {RATE_HALFLIFE_DEFAULT:g} by more than "
          f"{RATE_SELECTION_MIN_GAIN:.1%} relative MAE **and** is the per-origin "
          f"winner in at least {RATE_SELECTION_MIN_ORIGINS} origins. Otherwise the "
          f"stat keeps the default and is marked `ambiguous`. PTS and AST are FROZEN "
          f"by the production tournament and cannot move whatever the folds say.\n")
        w(rate_winners.to_markdown(index=False, floatfmt=".4f"))
        if rate_selection is not None and not rate_selection.empty:
            per = (
                rate_selection.groupby(["target", "origin", "method"])["MAE"]
                .mean().unstack()
            )
            order = [f"h{h:g}" for h in RATE_HALFLIFE_GRID] + ["expanding"]
            per = per[[c for c in order if c in per.columns]]
            w("\n**Per-origin inner-fold winner** — the consistency half of the rule.\n")
            w(per.idxmin(axis=1).rename("winner").unstack("origin").to_markdown())

    per_stat_parity = rate_composition_parity(results)
    if not per_stat_parity.empty:
        w("\n### Per-stat composition parity\n")
        w("`composition_parity` above asks whether promoting `P x E[MIN] x rate` over "
          "`P x EWMA(stat)` cost accuracy, and asks it about points only — because "
          "points was the only stat the composition served when that check was "
          "written. The correctness argument for minutes propagation is "
          "stat-agnostic, so the accuracy bar is cleared stat-by-stat here rather "
          "than cleared once for PTS and assumed for blocks. **Positive "
          "`relative_delta` means the champion is worse**; any row failing its "
          "tolerance makes `evaluate.py` exit non-zero.\n")
        w(per_stat_parity.to_markdown(index=False, floatfmt=".4f"))

    coherence = coherence_table(results)
    if not coherence.empty:
        w("\n### Coherence: how often the serving clip binds\n")
        w("A made shot is an attempted shot and a made three is a made shot. That "
          "holds in every game ever played; it does NOT hold automatically for the "
          "EXPECTATIONS, because two EWMAs at the same halflife are the same weighted "
          "average of the same rows and two at DIFFERENT halflives are not. The share "
          "below is therefore a direct measurement of what per-stat halflife selection "
          "costs in coherence, and the prediction it can be checked against is: a "
          "constraint whose two stats share a halflife should read ~0.\n")
        w(coherence.to_markdown(floatfmt=(".0f", ".4%", ".4%", ",.0f")))
        w("\n`predict.py` clips the bounded stat DOWN to the bound on every emitted "
          "row — conditional, unconditional and each quantile level independently. "
          "Clipping down rather than raising the bound is deliberate: attempts are the "
          "higher-volume, lower-variance member of each pair and therefore the better "
          "estimated, so when the two disagree the makes estimate is the one that is "
          "wrong.")

    if bracket is not None and not bracket.empty:
        w("\n## The honest-vs-oracle bracket (v1 / v3-honest / v2-oracle)\n")
        w("Same dataset, same rows, same five origins, same estimators. Three feature "
          "lists. `v1` has no teammate context at all; `v3-honest` is the SERVED set, "
          "whose teammate columns are expectations over as-of play probabilities; "
          "`v2-oracle` is the feature_version-v2 construction, whose teammate columns "
          "are sums over REALIZED absences and are therefore functions of other "
          "players' target-game labels.\n")
        w("`honest_pct` and `oracle_pct` are relative changes against `v1`, so "
          "**negative is better**. `survived` is `honest_delta / oracle_delta`: the "
          "share of the value-of-perfect-lineup-information result that survives "
          "honest construction. It is the number this whole phase exists to produce.\n")
        w(_format_bracket(bracket).to_markdown(index=False))
        w("\nThe cohorts are defined on the dataset's own `vacated_minutes` column — "
          "the ORACLE one, deliberately, because \"on the nights when a lot really was "
          "vacated\" is a question about the games and answering it with hindsight is "
          "legitimate for a report in a way it is not for a feature. All three passes "
          "therefore partition the validation rows identically.\n")
        w("`v2-oracle` is an UPPER BOUND, not a forecast. It cannot be earned at any "
          "horizon, including `lock`: even when tonight's inactive list is known, the "
          "training rows' lists were used to build the training features, so the "
          "estimator was fitted on information no live run has.")

    if ablation is not None and not ablation.empty:
        w(f"\n## Single-feature ablation: `{ABLATION_FEATURE}`\n")
        w("The served set refit with exactly one column removed. `cost_of_removal` is "
          "without minus with, so **positive means the column was worth something**. "
          "Reported, not asserted: there is no threshold it has to clear. A small cost "
          "beside a large split-gain share means the other columns substitute for it, "
          "which is information about the feature set rather than a defect.\n")
        w(_format_comparison(ablation).to_markdown(index=False))

    if degraded is not None and not degraded.empty:
        w("\n## Level-C: the degraded-oracle grid\n")
        w("The review's probe of the space between the bracket's two ends. A synthetic "
          "pre-tipoff report identifies `recall` of tonight's real absences and falsely "
          "flags `false_positive_rate` of the players who did play; flagged players get "
          "p = 0 and everyone else keeps his base-model probability. "
          "`recall = 1.00, fp = 0.00` reproduces the oracle and is the arithmetic check "
          "on that claim.\n")
        w("This is a DIAGNOSTIC. It reads target-game labels by construction — that is "
          "what makes it a measure of information value — and nothing it produces may "
          "reach a served artifact.\n")
        w(degraded.to_markdown(index=False, floatfmt=(".2f", ".2f", ".4f", ".4f")))

    if baseline is not None and not baseline.empty:
        comparison = feature_set_comparison(baseline, results)
        if not comparison.empty:
            w("\n## Feature-set comparison: v1 features vs the served set\n")
            w("Same dataset, same rows, same origins, same estimators. The only "
              "difference is whether the estimators were allowed to see the served "
              "teammate-context and reliability columns. `delta` is after minus before, "
              "so **negative is better** for both Brier and MAE. When `--bracket` ran, "
              "this is the same v1 -> v3-honest pair the bracket's first two columns "
              "show, restated as a before/after.\n")
            w(_format_comparison(comparison).to_markdown(index=False))
            w("\nThe cohorts are defined on the dataset's own columns, not on any "
              "model output, so both runs partition the validation rows identically "
              "and the two columns above describe the same games.")
            w("\nThe rows to read first are `bench (10-20)` / `fringe (<10)` and the "
              "two event cohorts. `control: vacated_minutes < 5` is where a "
              "regression would show up if the family were buying its wins by "
              "adding noise to ordinary games.")

    if lift is not None and not lift.empty:
        w("\n## Event cohorts: do they contain what they claim to\n")
        w("Model-free. Mean outcome inside each cohort against the population mean, "
          "plus the same split on a randomly PERMUTED copy of `vacated_minutes`. The "
          "permuted rows are the null: if they showed comparable lift, the cohort "
          "machinery would be manufacturing the finding.\n")
        w(lift.to_markdown(index=False, floatfmt=(".0f", ".0f", ".0f", ".4f", ".4f", "+.4f")))

    importance = teammate_importance(results)
    if not importance.empty:
        w("\n## Where the new features rank (split gain, mean over origins)\n")
        w("Gain is ranked WITHIN each model - availability gain and minutes gain are "
          "not the same unit. `share` is the feature's fraction of that model's total "
          "gain. The `negative-control fit` rows come from a separate pair of fits "
          "with a permuted `vacated_minutes` column added, so the real column's gain "
          "has something guaranteed-signal-free to be compared against.\n")
        w(_format_importance(importance).to_markdown(index=False))
        control = importance[importance["feature"] == NEGATIVE_CONTROL_COLUMN]
        real = importance[
            (importance["feature"] == NEGATIVE_CONTROL_FEATURE)
            & (importance["pass"] == "negative-control fit")
        ]
        if not control.empty and not real.empty:
            w("\n**Negative control verdict** (same fit, both columns present):\n")
            for model in sorted(set(control["model"]) & set(real["model"])):
                c = float(control[control["model"] == model]["gain"].iloc[0])
                r = float(real[real["model"] == model]["gain"].iloc[0])
                c_rank = int(control[control["model"] == model]["rank"].iloc[0])
                r_rank = int(real[real["model"] == model]["rank"].iloc[0])
                ratio = r / c if c else float("inf")
                # the feature name is read from the constant rather than written out:
                # it moved from vacated_minutes to exp_vacated_minutes in v3, and a
                # hardcoded label made the report claim a control it had not run
                w(f"- `{model}`: real `{NEGATIVE_CONTROL_FEATURE}` gain {r:,.0f} "
                  f"(rank {r_rank}) vs permuted twin {c:,.0f} (rank {c_rank}) — "
                  f"**{ratio:.1f}x**")
            w("\nA ratio at or below 1 is a finding, not a bug: it says the real column "
              "is not distinguishable from a permutation of itself in that model. See "
              "MODEL.md section 5.2.")

        full = importance_table(results, TASK_IMPORTANCE, top=12)
        if not full.empty:
            w("\n### Top 12 features per model, for context\n")
            w(_format_importance(full).to_markdown(index=False))

    w("\n## A. Availability (all scheduled rows)\n")
    for metric in ("Brier", "LogLoss", "BrierSkill"):
        piv = _pivot(results, TASK_AVAILABILITY, metric)
        if piv.empty:
            continue
        w(f"\n**{metric}**\n")
        w(piv.to_markdown(floatfmt=".4f"))

    for task in (TASK_MINUTES, TASK_PTS, TASK_AST, TASK_UNCONDITIONAL):
        piv = _pivot(results, task, "MAE")
        if piv.empty:
            continue
        w(f"\n## {task} - MAE\n")
        w(piv.to_markdown(floatfmt=".4f"))
        skill = _pivot(results, task, "MAESkill")
        if not skill.empty:
            w(f"\nSkill vs `{SKILL_BASELINE[task]}` (positive = less error)\n")
            w(skill.to_markdown(floatfmt=".4f"))

    w("\n## Segment breakdown - MAE by minutes tier (mean over origins)\n")
    for task in COHORT_TASKS:
        piv = _segment_pivot(results, task)
        if piv.empty:
            continue
        w(f"\n**{task}**\n")
        w(piv.to_markdown(floatfmt=".4f"))

    avail_tiers = _segment_pivot(results, TASK_AVAILABILITY, metric="Brier")
    if not avail_tiers.empty:
        w(f"\n**{TASK_AVAILABILITY} - Brier**\n")
        w(avail_tiers.to_markdown(floatfmt=".4f"))

    w("\n## Event-cohort breakdown (mean over origins)\n")
    w("Two events and one control, defined in `config.EVENT_COHORTS`. The teammate "
      "features are supposed to help on the first two and change nothing on the "
      "third; a family that improves high-absence games at the cost of quiet ones "
      "has not helped.\n")
    for task, metric in [(TASK_AVAILABILITY, "Brier"), *((t, "MAE") for t in COHORT_TASKS)]:
        piv = _segment_pivot(results, task, order=EVENT_COHORT_ORDER, metric=metric)
        if piv.empty:
            continue
        w(f"\n**{task} - {metric}**\n")
        w(piv.to_markdown(floatfmt=".4f"))

    cov = results[results["metric"] == "Coverage80"]
    if not cov.empty:
        w(f"\n## Interval coverage - nominal {NOMINAL_COVERAGE:.0%}\n")
        piv = cov.pivot_table(index="task", columns="origin", values="value")
        piv["mean"] = piv.mean(axis=1)
        w(piv.to_markdown(floatfmt=".4f"))
        w("\nIntervals are empirical residual quantiles of the champion "
          "estimate, fitted on the training window only.")

    support = (
        results[
            (results["task"] == TASK_UNCONDITIONAL) & (results["metric"] == "MAE")
            & (results["segment"] != "ALL")
        ]
        .drop_duplicates(["origin", "segment"])
        .groupby("segment")["n"].sum()
    )
    if not support.empty:
        w("\n## Segment support (validation rows per cohort, summed over origins)\n")
        order = [c for c in (*TIER_ORDER, *EVENT_COHORT_ORDER) if c in support.index]
        w(support.reindex(order).to_markdown())
        w("\nThe tiers partition the rows; the event cohorts do not (a bench player "
          "on a high-absence night is in two of them, and the two `vacated_minutes` "
          "cohorts are disjoint but do not cover the 5-30 middle).")

    return "\n".join(parts) + "\n"
