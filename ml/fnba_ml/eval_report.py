"""the report side of the harness: aggregation, comparison tables, markdown rendering."""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import (
    CANDIDATE_FEATURE_SET,
    CHAMPIONS,
    COMPOSITION_PARITY_TOLERANCE,
    EVENT_COHORT_ORDER,
    ORACLE_FEATURE_SET,
    RATE_ESTIMATORS,
    RATE_HALFLIFE_DEFAULT,
    RATE_HALFLIFE_GRID,
    RATE_HALFLIVES,
    RATE_TARGETS,
    SERVED_FEATURE_SET,
    TEAMMATE_FEATURE_COLS,
    TEAMMATE_ORACLE_COLS,
    TIER_ORDER,
    V4_DESCRIPTIVE_COHORT_ORDER,
)
from .eval_core import (
    ABLATION_FEATURE,
    COHORT_TASKS,
    MODEL_LABELS,
    NEGATIVE_CONTROL_COLUMN,
    NEGATIVE_CONTROL_FEATURE,
    NOMINAL_COVERAGE,
    PREVIOUS_COMPOSITION,
    SKILL_BASELINE,
    TASK_AST,
    TASK_AVAILABILITY,
    TASK_FAMILY,
    TASK_IMPORTANCE,
    TASK_MINUTES,
    TASK_NEGATIVE_CONTROL,
    TASK_PTS,
    TASK_UNCONDITIONAL,
)
from .eval_rates import (
    RATE_MODEL_EWMA,
    RATE_MODEL_EXPANDING,
    RATE_MODEL_TOTAL,
    RATE_SELECTION_MIN_GAIN,
    RATE_SELECTION_MIN_ORIGINS,
    TASK_COHERENCE,
    rate_task,
)

log = logging.getLogger(__name__)


def mean_by_model(results: pd.DataFrame, task: str, metric: str) -> pd.Series:
    """mean metric per model over origins, overall segment only."""
    sub = results[
        (results["task"] == task) & (results["metric"] == metric) & (results["segment"] == "ALL")
    ]
    return sub.groupby("model")["value"].mean().sort_values()


def select_champions(results: pd.DataFrame) -> pd.DataFrame:
    """per-target measured winner vs the champion config actually ships.

    a mismatch is a finding to look at, not an instruction to promote.
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

    the bar is parity, not improvement. ``relative_delta`` is positive when the
    champion is WORSE. an empty dict when either composition is missing, because
    "the check could not run" must not read as a pass.
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

    same sign convention: ``relative_delta`` is positive when the champion is
    worse. a stat missing either member is omitted rather than passed.
    """
    rows: list[dict] = []
    for target in targets:
        means = mean_by_model(results, rate_task(target, unconditional=True), "MAE")
        # the SHIPPED estimator, not the EWMA by assumption: STL ships the
        # expanding baseline.
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
    """mean split gain per feature per model, with a rank.

    ranked within each model: availability gain and minutes gain are not on the
    same scale.
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

    the oracle names stay in the filter so an oracle-set pass reports its ranks in
    the same table.
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

    ``to_markdown(floatfmt=...)`` positions its formats by column and a
    MultiIndex shifts every position by the number of index levels, so the
    numbers are formatted here instead.
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
    out = importance.copy()
    out["gain"] = out["gain"].map("{:,.0f}".format)
    out["share"] = out["share"].map("{:.2%}".format)
    out["rank"] = out["rank"].astype(int)
    return out


def _format_bracket(bracket: pd.DataFrame) -> pd.DataFrame:
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


COMPARISON_TARGETS: tuple[tuple[str, str, str], ...] = (
    (TASK_AVAILABILITY, "availability", "Brier"),
    (TASK_MINUTES, "minutes", "MAE"),
    (TASK_UNCONDITIONAL, "composition", "MAE"),
)


def feature_set_comparison(
    baseline: pd.DataFrame, candidate: pd.DataFrame
) -> pd.DataFrame:
    """before/after per cohort for the three headline metrics.

    ``delta`` is candidate minus baseline, so negative is better for both Brier
    and MAE.
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


def rate_ladder_table(
    results: pd.DataFrame,
    targets: tuple[str, ...] = RATE_TARGETS,
    unconditional: bool = False,
) -> pd.DataFrame:
    """one row per rate target: each ladder member's MAE and the champion's edge.

    ``vs_expanding`` and ``vs_ewma_total`` are relative improvements of the
    champion, so positive is better. ``champion_mae`` is read from
    ``config.RATE_ESTIMATORS`` rather than assumed to be the EWMA, so STL's
    ``vs_expanding`` is identically zero. a negative value is a disagreement
    between the inner folds and the validation rows, not a licence to reselect.
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

    two EWMAs at the same halflife cannot cross, so a constraint whose stats
    share a halflife should read ~0.
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
