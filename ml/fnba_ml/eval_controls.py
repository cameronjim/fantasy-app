"""the nulls and the information-value probes: permutation controls, cohort lift,
block permutation and the Level-C degraded-oracle grid.

nothing here may reach a served artifact: the degraded-oracle functions read
target-game labels by construction, which is what makes them a measure of
information value.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import (
    CHAMPIONS,
    EVENT_COHORTS,
    ORIGINS,
    P_CONTEXT,
    RANDOM_STATE,
    SERVED_FEATURE_SET,
    TEAMMATE_EXPECTED_COLS,
)
from .eval_core import (
    COHORT_ORACLE_COLUMN,
    NEGATIVE_CONTROL_COLUMN,
    NEGATIVE_CONTROL_FEATURE,
    TASK_NEGATIVE_CONTROL,
    _Recorder,
    split,
)
from .features import feature_set_columns
from .models import (
    AvailabilityModel,
    MinutesModel,
    brier,
    mae,
)
from .teammates import absence_mask

log = logging.getLogger(__name__)

# two nulls, two columns: the importance null permutes the SERVED column because
# only a served column can appear in a fitted model's split gain, and the cohort
# null permutes the cohort-defining column because that is the split being tested.
PERMUTATION_CONTROLS: tuple[tuple[str, str], ...] = (
    (NEGATIVE_CONTROL_FEATURE, NEGATIVE_CONTROL_COLUMN),
    (COHORT_ORACLE_COLUMN, f"{COHORT_ORACLE_COLUMN}_permuted"),
)
COHORT_CONTROL_COLUMN = f"{COHORT_ORACLE_COLUMN}_permuted"

DEGRADED_RECALLS: tuple[float, ...] = (0.4, 0.6, 0.8, 1.0)
DEGRADED_FALSE_POSITIVES: tuple[float, ...] = (0.0, 0.05, 0.10)


def add_negative_control(
    features: pd.DataFrame,
    source: str | None = None,
    column: str | None = None,
    seed: int = RANDOM_STATE,
) -> pd.DataFrame:
    """randomly permuted copies of the control columns, for the two nulls.

    a permutation rather than fresh noise, so the control has the real column's
    exact marginal distribution and differs only in being unrelated to its row.
    permuted once over the whole frame: permuting per fold would let the control
    inherit the fold's row ordering, which is correlated with date.
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

    its own pass, so adding a noise column cannot move the report's headline
    numbers.
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

    computed over appearance rows for MIN/PTS and over all scheduled rows for
    PLAYED. the permuted column must show essentially nothing, or the cohort
    machinery is generating the finding by itself.
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


def degrade_absence_knowledge(
    features: pd.DataFrame,
    recall: float,
    false_positive_rate: float,
    seed: int = RANDOM_STATE,
) -> np.ndarray:
    """a synthetic p_j standing for "the report gets absences this right".

    a genuinely absent player is flagged with probability ``recall`` and a
    genuinely present one with ``false_positive_rate``; flagged means p = 0.
    ``recall = 1, fp = 0`` reproduces the oracle exactly.
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
    # an unflagged player keeps his base-model probability rather than being
    # forced to 1: a report that misses an absence is silent about him.
    return p


def degraded_oracle_grid(
    features: pd.DataFrame,
    origins: list[tuple[str, str, str]] | None = None,
    recalls: tuple[float, ...] = DEGRADED_RECALLS,
    false_positives: tuple[float, ...] = DEGRADED_FALSE_POSITIVES,
) -> pd.DataFrame:
    """availability Brier and minutes MAE across the recall x false-positive grid.

    only the two targets the teammate features are supposed to move, so a cell
    costs two fits per origin rather than the whole ladder.
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


def block_permute_context(
    features: pd.DataFrame,
    columns: list[str] | None = None,
    seed: int = RANDOM_STATE,
) -> pd.DataFrame:
    """permute the served context block across TEAM-GAMES, keeping rows together.

    a strictly harder null than the per-row permutation: every row gets a context
    block that is internally consistent and merely attached to the wrong game.
    blocks are swapped between team-games of equal roster size and a row's
    position inside its block is preserved, so every column's marginal
    distribution stays intact.
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
