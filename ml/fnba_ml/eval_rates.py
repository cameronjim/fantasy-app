"""the 9-category rate ladder: per-stat halflife selection and the three-member bracket.

members per stat, over identical rows and one shared minutes model:
expanding_rate (the baseline), ewma_total (the pre-composition estimator) and
ewma_rate (the candidate champion). the halflife is selected by
:func:`select_rate_halflives` on inner folds inside each origin's training
window, never on the rows the ladder reports.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from .config import (
    CHAMPIONS,
    ORIGINS,
    RATE_HALFLIFE_DEFAULT,
    RATE_HALFLIFE_GRID,
    RATE_MINUTES_FLOOR,
    RATE_TARGETS,
    TOURNAMENT_RATE_TARGETS,
)
from .eval_core import _Recorder
from .features import available_features
from .models import (
    MIN_PRED,
    MinutesModel,
    PerMinuteRate,
    baseline_column,
    coherence_clip,
    conditional_estimate,
    decomposed_estimate,
    mae,
    minutes_propagated_estimate,
    skill_score,
)

log = logging.getLogger(__name__)

# lettered R/S so they sort after the A..E tasks.
RATE_TASK_PREFIX = "R"
RATE_UNCOND_TASK_PREFIX = "S"

# a count rather than a model comparison, with the constraint in the segment
# column and the share of rows the clip moved as the value.
TASK_COHERENCE = "H coherence"

RATE_MODEL_EXPANDING = "expanding_rate"
RATE_MODEL_TOTAL = "ewma_total"
RATE_MODEL_EWMA = "ewma_rate"

RATE_SKILL_BASELINE = RATE_MODEL_EXPANDING

# how much better than the default halflife a challenger must be before it may
# ship. every distinct halflife inside a constrained pair is a source of
# coherence violations the serving clip then has to correct.
RATE_SELECTION_MIN_GAIN: float = 0.005

# and it must win a majority of origins, not merely the pooled mean.
RATE_SELECTION_MIN_ORIGINS: int = 3

# two disjoint folds carved off the END of each origin's training window.
INNER_FOLD_DAYS: int = 28
INNER_FOLDS: int = 2


def whole_game_ewma_column(target: str, halflife: float) -> str:
    return f"_ladder_ewma_{target}_h{halflife:g}"


def grid_rate_column(target: str, halflife: float) -> str:
    return f"_grid_ewma_{target}_per_min_h{halflife:g}"


def rate_task(target: str, unconditional: bool = False) -> str:
    """the tidy-frame task name for one rate target."""
    if unconditional:
        return f"{RATE_UNCOND_TASK_PREFIX} {target.lower()} UNCONDITIONAL"
    return f"{RATE_TASK_PREFIX} {target.lower()}|played"


def build_rate_grid(
    features: pd.DataFrame,
    targets: tuple[str, ...] = RATE_TARGETS,
    halflives: tuple[float, ...] = RATE_HALFLIFE_GRID,
    floor: float = RATE_MINUTES_FLOOR,
) -> pd.DataFrame:
    """every (target x halflife) per-minute rate, plus the whole-game EWMA, as-of joined.

    one cross-fit-free pass is safe for every origin at once: the EWMA at row g
    reads only games at or before g and the as-of join then refuses the exact
    match. the columns are underscore-prefixed so ``available_features`` can never
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
        # the estimator the composition replaced, needed as a ladder member for
        # the stats that carry no ``ewma_<stat>`` dataset column.
        column = whole_game_ewma_column(target, RATE_HALFLIFE_DEFAULT)
        app[column] = app.groupby("PLAYER_ID")[target].transform(
            lambda s: s.ewm(halflife=float(RATE_HALFLIFE_DEFAULT), adjust=True).mean()
        )
        cols.append(column)

    return app[cols].sort_values("GAME_DATE").reset_index(drop=True)


def attach_rate_grid(features: pd.DataFrame, grid: pd.DataFrame) -> pd.DataFrame:
    """as-of join the grid on, preserving the caller's row order.

    ``allow_exact_matches=False`` is the leakage guard: the appearance on the
    target date can never be matched, which is what turns an inclusive EWMA into
    a strictly-prior quantity.
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

    forward chaining inside the training window: fold k's own training rows are
    everything strictly before fold k's start, so a selection made here has seen
    neither the origin's validation rows nor its own fold.
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

    the minutes prediction is a common factor across the grid, so any MAE
    difference is attributable to the memory length and to nothing else.
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

    the selection evidence and nothing else: this chooses nothing,
    :func:`rate_halflife_winners` applies the rule to it. out of fold on both
    sides, so no origin's validation rows are read here.
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

    the pooled best halflife ships only if it also wins ``min_origins`` origins
    and beats the default by more than ``min_gain``; the expanding baseline gets
    its own comparison rather than being thrown into the same argmin; and a stat
    in ``frozen`` keeps the default whatever the evidence says. ``ambiguous``
    marks a stat that fell through because nothing separated the grid, which is a
    different claim from one that chose the default outright.
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
    """the three-member bracket per rate target, conditional and unconditional.

    no extra model fits: the availability probability and the minutes prediction
    are already on ``scored``, so every stat is scored by the same two models as
    the main unconditional table.
    """
    # the appearance subset OF THE SCORED FRAME, taken by index: it is the only
    # one carrying MIN_PRED, and re-filtering could describe different rows.
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

    for label, values in (("uncond", champion_uncond), ("cond", champion_cond)):
        if not values:
            continue
        _, counts = coherence_clip(values)
        total_rows = len(valid_all)
        for constraint, bound_rows in counts.items():
            rec.record(TASK_COHERENCE, origin, label, "ClipRate",
                       bound_rows / total_rows if total_rows else float("nan"),
                       total_rows, segment=constraint)
