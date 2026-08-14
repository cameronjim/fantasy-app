"""the multi-pass experiments over the ladder: the feature-set bracket and the ablation."""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import (
    CANDIDATE_FEATURE_SET,
    CHAMPIONS,
    EVENT_COHORT_ORDER,
    FEATURE_SETS,
    ORACLE_FEATURE_SET,
    ORIGINS,
    RATE_TARGETS,
    SERVED_FEATURE_SET,
    TIER_ORDER,
    V4_DESCRIPTIVE_COHORT_ORDER,
)
from .eval_core import ABLATION_FEATURE
from .eval_ladder import run_rolling_origin
from .eval_report import COMPARISON_TARGETS, feature_set_comparison

log = logging.getLogger(__name__)


def run_feature_set_bracket(
    features: pd.DataFrame,
    origins: list[tuple[str, str, str]] | None = None,
    names: tuple[str, ...] = tuple(FEATURE_SETS),
    rate_targets: tuple[str, ...] = RATE_TARGETS,
) -> dict[str, pd.DataFrame]:
    """the same ladder, the same rows, the same origins, one pass per feature list.

    the rate ladder runs in every pass, so a feature set that changes the minutes
    model changes every production stat downstream of it.
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

    ``honest_pct`` and ``oracle_pct`` are relative changes against ``reference``,
    negative meaning better. ``survived`` is honest_delta / oracle_delta, NaN when
    the oracle delta is ~0; values above 1 or below 0 are real findings and are
    not clipped.
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
        # the candidate is reported relative to the SERVED set, not to v1: a
        # v4-vs-v1 number would credit it with the v3 gain it inherits for free.
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


def single_feature_ablation(
    features: pd.DataFrame,
    origins: list[tuple[str, str, str]] | None = None,
    feature: str = ABLATION_FEATURE,
    feature_set: str = SERVED_FEATURE_SET,
    full: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """refit the served set with exactly one column removed; report the delta.

    reported, not asserted: there is no threshold it has to clear. ``full`` is the
    unablated pass, passed in by a caller that already computed it so the ablation
    costs one extra pass rather than two.
    """
    origins = origins or ORIGINS
    if feature not in features.columns:
        log.warning("no %s on the frame; ablation skipped", feature)
        return pd.DataFrame()
    if full is None:
        full = run_rolling_origin(features, origins, feature_set=feature_set)
    without = run_rolling_origin(
        features, origins, feature_set=feature_set, drop_features=(feature,)
    )
    table = feature_set_comparison(full, without)
    if table.empty:
        return table
    # `after` is the ABLATED run, so a positive delta means removing the column
    # cost accuracy. renamed so nobody has to remember the slot order.
    return table.rename(
        columns={"before": "with", "after": "without",
                 "delta": "cost_of_removal", "delta_pct": "cost_of_removal_pct"}
    )
