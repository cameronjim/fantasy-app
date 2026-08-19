"""the runner. ONE LOOK: it is executed once and its output is the report.

    python -m experiments.production_tournament.run_tournament        (from ml/)

WHAT IT GUARANTEES, and where.

  IDENTICAL ROWS. the composition (P(play), E[min|plays]) is fitted once per origin
  and the SAME arrays are reused by all nine bracket members and both targets. a
  method contributes only a rate vector, and :func:`_score_origin` asserts every rate
  vector has the origin's row count before it is multiplied by anything. so "same
  rows" is structural rather than checked-afterwards.

  AS-OF DISCIPLINE. every rate column arrives through ONE
  ``merge_asof(allow_exact_matches=False)`` (``rates.attach_rate_columns``), and the
  out-of-fold minutes used by the Poisson candidate arrive through
  ``models.validate_out_of_fold``. the composition itself re-runs all three shipped
  guards on every score.

  NO SELECTION ON THE REPORTED ROWS. hyperparameters are chosen inside
  ``methods.RateMethod.prepare``, which is only ever handed ``ctx.train_*``.

CACHING. the two expensive as-of/cross-fit passes are cached under ``cache/`` (which
the directory's own .gitignore excludes). they are pure functions of the dataset, so a
cache hit and a cold run produce the same numbers; ``--rebuild`` forces the recompute.
"""

from __future__ import annotations

import argparse
import logging
import time
from pathlib import Path

import numpy as np
import pandas as pd

from fnba_ml.config import (
    CHAMPIONS,
    DATA_DIR,
    EVENT_COHORTS,
    FEATURE_COLS,
    ORIGINS,
    RANDOM_STATE,
    RATE_TARGETS,
    TIER_ORDER,
)
from fnba_ml.models import (
    AvailabilityModel,
    MinutesModel,
    PerMinuteRate,
    mae,
    minutes_propagated_estimate,
)

from .bootstrap import BLOCK_DAYS, N_REPLICATES, holm_bonferroni, moving_block_bootstrap
from .crossfit import OOF_MIN, OOF_MIN_CUTOFF, OOF_MIN_SOURCE, cross_fit_minutes
from .methods import INCUMBENT, OriginContext, build_bracket, decision_methods
from .rates import (
    INCUMBENT_HALFLIFE,
    RATE_N,
    SCHEME_PLAIN,
    attach_rate_columns,
    build_rate_columns,
    rate_column,
)

log = logging.getLogger(__name__)

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"

# the pre-registered practical floor: 2% relative improvement on the primary endpoint.
PRACTICAL_FLOOR = 0.02
ALPHA = 0.05


# ---------------------------------------------------------------------------
# stage 1: the frame, the rate cache and the out-of-fold minutes
# ---------------------------------------------------------------------------
def load_frame(rebuild: bool = False) -> pd.DataFrame:
    """the v3 dataset with every candidate rate column and OOF minutes attached."""
    CACHE.mkdir(exist_ok=True)
    frame = pd.read_parquet(DATA_DIR / "dataset.parquet")
    frame["GAME_DATE"] = pd.to_datetime(frame["GAME_DATE"])
    frame = frame.sort_values(["GAME_DATE", "GAME_ID", "PLAYER_ID"]).reset_index(drop=True)
    log.info("dataset: %d scheduled rows, %d columns", len(frame), frame.shape[1])

    rate_cache = CACHE / "rate_columns.parquet"
    if rebuild or not rate_cache.exists():
        t0 = time.time()
        build_rate_columns(frame).to_parquet(rate_cache, index=False)
        log.info("built the rate cache in %.1fs", time.time() - t0)
    frame = attach_rate_columns(frame, pd.read_parquet(rate_cache))

    minutes_cache = CACHE / "oof_minutes.parquet"
    if rebuild or not minutes_cache.exists():
        t0 = time.time()
        cross_fit_minutes(frame).to_parquet(minutes_cache, index=False)
        log.info("cross-fit minutes in %.1fs", time.time() - t0)
    oof = pd.read_parquet(minutes_cache)[["PLAYER_ID", "GAME_ID", OOF_MIN, OOF_MIN_SOURCE]]
    frame = frame.merge(oof, on=["PLAYER_ID", "GAME_ID"], how="left", validate="one_to_one")
    if frame[OOF_MIN].isna().any():
        raise RuntimeError(f"{int(frame[OOF_MIN].isna().sum())} rows have no OOF minutes")
    return frame


def reproduction_check(frame: pd.DataFrame) -> pd.DataFrame:
    """does the recomputed halflife-5 rate reproduce the SHIPPED column exactly?

    the cheapest possible proof that the sweep is a sweep of the incumbent's own
    estimator rather than of a lookalike. if this does not match, every halflife
    number in the report is measuring the reimplementation instead of the halflife.
    """
    rows = []
    for target in RATE_TARGETS:
        shipped = frame[f"ewma_{target}_per_min"].to_numpy(dtype=float)
        mine = frame[rate_column(SCHEME_PLAIN, target, INCUMBENT_HALFLIFE)].to_numpy(dtype=float)
        both = np.isfinite(shipped) & np.isfinite(mine)
        rows.append({
            "target": target,
            "rows_compared": int(both.sum()),
            "null_agreement": bool(
                (np.isfinite(shipped) == np.isfinite(mine)).all()
            ),
            "max_abs_diff": float(np.max(np.abs(shipped[both] - mine[both]))) if both.any() else np.nan,
        })
    return pd.DataFrame(rows)


# ---------------------------------------------------------------------------
# stage 2: score every method on every origin
# ---------------------------------------------------------------------------
def _score_origin(frame: pd.DataFrame, origin: tuple[str, str, str]) -> tuple[pd.DataFrame, list[dict]]:
    """one origin: fit the shared composition once, then every method x target."""
    name, vstart, vend = origin
    vstart_ts, vend_ts = pd.Timestamp(vstart), pd.Timestamp(vend)
    train_all = frame[frame["GAME_DATE"] < vstart_ts]
    valid_all = frame[
        (frame["GAME_DATE"] >= vstart_ts) & (frame["GAME_DATE"] <= vend_ts)
    ].copy()
    train_app = train_all[train_all["PLAYED"] == 1]
    if train_all.empty or valid_all.empty:
        raise ValueError(f"origin {name} has an empty side")

    feats = [c for c in FEATURE_COLS if c in frame.columns]
    t0 = time.time()
    availability = AvailabilityModel(kind=CHAMPIONS["availability"]).fit(
        train_all, feats, vstart_ts
    )
    minutes = MinutesModel(kind=CHAMPIONS["minutes"]).fit(train_app, feats, vstart_ts)
    scored = minutes.attach(availability.attach(valid_all))
    log.info("%s: composition fitted in %.1fs (train %d / valid %d)",
             name, time.time() - t0, len(train_all), len(valid_all))

    ctx = OriginContext(name=name, vstart=vstart_ts, train_all=train_all, valid_all=valid_all)
    log.info("%s: inner fold cuts at %s (%d inner-valid rows, %d inner-train rate rows)",
             name, ctx.inner_cut.date(), len(ctx.inner_valid), len(ctx.inner_train_rate))

    frames: list[pd.DataFrame] = []
    selections: list[dict] = []
    # dict.fromkeys rather than a list comprehension: two EVENT_COHORTS definitions read
    # the SAME column (vacated_minutes >= 30 and vacated_minutes < 5), and selecting it
    # twice makes the frame unwritable and every later groupby ambiguous
    cohort_cols = list(dict.fromkeys(
        c for _, c, _, _ in EVENT_COHORTS if c in valid_all.columns
    ))
    base = valid_all[["GAME_DATE", "PLAYER_ID", "GAME_ID", "PLAYED", "MIN", "MIN_TIER",
                      *cohort_cols]].copy()
    base["origin"] = name

    for target in RATE_TARGETS:
        fallback = PerMinuteRate(target).fit(train_all).fallback
        y = valid_all[target].to_numpy(dtype=float)
        for method in build_bracket():
            t1 = time.time()
            method.prepare(ctx, target, fallback)
            rate = method.predict_rate(valid_all)
            if len(rate) != len(valid_all):
                raise RuntimeError(
                    f"{method.name} emitted {len(rate)} rates for {len(valid_all)} rows"
                )
            if not np.isfinite(rate).all():
                raise RuntimeError(f"{method.name} emitted a non-finite rate")
            conditional, unconditional = minutes_propagated_estimate(scored, rate)
            piece = base.copy()
            piece["target"] = target
            piece["method"] = method.name
            piece["y"] = y
            piece["rate"] = rate
            piece["cond"] = conditional
            piece["uncond"] = unconditional
            frames.append(piece)
            selections.append({
                "origin": name, "target": target, "method": method.name,
                "label": method.label, "descriptive": method.descriptive,
                "fallback": fallback,
                "seconds": round(time.time() - t1, 1), **method.chosen(),
            })
            log.info("  %s / %s: %s -> uncond MAE %.4f (%.1fs)",
                     name, target, method.name, mae(y, unconditional), time.time() - t1)
    return pd.concat(frames, ignore_index=True), selections


def run(frame: pd.DataFrame,
        origins: list[tuple[str, str, str]] | None = None) -> tuple[pd.DataFrame, pd.DataFrame]:
    origins = origins or ORIGINS
    pieces, selections = [], []
    for origin in origins:
        piece, chosen = _score_origin(frame, origin)
        pieces.append(piece)
        selections.extend(chosen)
    return pd.concat(pieces, ignore_index=True), pd.DataFrame(selections)


# ---------------------------------------------------------------------------
# stage 3: the endpoints, the bootstrap and the cohorts
# ---------------------------------------------------------------------------
def headline(predictions: pd.DataFrame) -> pd.DataFrame:
    """primary (unconditional, all rows) and secondary (conditional, appearances)."""
    rows = []
    for (target, method), group in predictions.groupby(["target", "method"]):
        played = group["PLAYED"] == 1
        rows.append({
            "target": target, "method": method,
            "uncond_mae": mae(group["y"], group["uncond"]),
            "cond_mae": mae(group.loc[played, "y"], group.loc[played, "cond"]),
            "n_uncond": int(len(group)), "n_cond": int(played.sum()),
            "mean_rate": float(group["rate"].mean()),
        })
    out = pd.DataFrame(rows)
    base = out[out["method"] == INCUMBENT].set_index("target")
    out["uncond_rel"] = out.apply(
        lambda r: 1.0 - r["uncond_mae"] / base.loc[r["target"], "uncond_mae"], axis=1
    )
    out["cond_rel"] = out.apply(
        lambda r: 1.0 - r["cond_mae"] / base.loc[r["target"], "cond_mae"], axis=1
    )
    return out.sort_values(["target", "uncond_mae"]).reset_index(drop=True)


def per_origin(predictions: pd.DataFrame) -> pd.DataFrame:
    """unconditional MAE per origin - the '5/5 origins' consistency read."""
    grid = (
        predictions.groupby(["target", "method", "origin"])
        .apply(lambda g: mae(g["y"], g["uncond"]), include_groups=False)
        .rename("uncond_mae").reset_index()
    )
    base = grid[grid["method"] == INCUMBENT].set_index(["target", "origin"])["uncond_mae"]
    grid["rel"] = grid.apply(
        lambda r: 1.0 - r["uncond_mae"] / base.loc[(r["target"], r["origin"])], axis=1
    )
    return grid


def bootstrap_table(predictions: pd.DataFrame, seed: int = RANDOM_STATE) -> pd.DataFrame:
    """the decision input: paired 7-day moving-block bootstrap against the incumbent."""
    keys = ["origin", "GAME_ID", "PLAYER_ID"]
    rows = []
    for target, block in predictions.groupby("target"):
        incumbent = block[block["method"] == INCUMBENT].set_index(keys)
        base_err = (incumbent["y"] - incumbent["uncond"]).abs()
        # the origin label lives on the index after set_index, and the PAIRING is the
        # whole point of this table - reading it off the incumbent's own index is what
        # guarantees the challenger was aligned to the same rows, in the same order
        origin_labels = pd.Series(incumbent.index.get_level_values("origin"))
        for method, group in block.groupby("method"):
            if method == INCUMBENT:
                continue
            g = group.set_index(keys).reindex(incumbent.index)
            if g["uncond"].isna().any():
                raise RuntimeError(f"{method}/{target} does not cover the incumbent's rows")
            challenger_err = (g["y"] - g["uncond"]).abs()
            result = moving_block_bootstrap(
                delta=(base_err - challenger_err).to_numpy(dtype=float),
                base_abs=base_err.to_numpy(dtype=float),
                dates=pd.Series(g["GAME_DATE"].to_numpy()),
                origins=origin_labels,
                block=BLOCK_DAYS, n_replicates=N_REPLICATES, seed=seed,
            )
            rows.append({
                "target": target, "method": method,
                "theta": result.theta, "ci_lo": result.lo, "ci_hi": result.hi,
                "p_value": result.p_value, "n_rows": result.n_rows,
                "n_dates": result.n_dates,
                "ci_excludes_zero": result.ci_excludes_zero,
                "clears_2pct": result.clears(PRACTICAL_FLOOR),
            })
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    # THE HOLM FAMILY IS THE DECISION FAMILY ONLY. the descriptive sweep members are
    # bootstrapped and reported for completeness, but including them in the correction
    # would penalise the eight candidates for tests that can promote nothing.
    family = decision_methods()
    out["decision_candidate"] = out["method"].isin(family)
    holm = []
    for target, group in out.groupby("target"):
        candidates = group[group["decision_candidate"]]
        rejected = holm_bonferroni(
            dict(zip(candidates["method"], candidates["p_value"])), alpha=ALPHA
        )
        holm.append(group.assign(
            holm_rejected=group["method"].map(rejected).fillna(False).astype(bool)
        ))
    out = pd.concat(holm, ignore_index=True)
    out["PROMOTE"] = out["clears_2pct"] & out["holm_rejected"] & out["decision_candidate"]
    return out.sort_values(["target", "theta"], ascending=[True, False]).reset_index(drop=True)


def cohort_table(predictions: pd.DataFrame) -> pd.DataFrame:
    """DESCRIPTIVE ONLY. unconditional MAE by minutes tier and by event cohort."""
    rows = []
    definitions: list[tuple[str, np.ndarray]] = []
    for tier in TIER_ORDER:
        definitions.append((tier, (predictions["MIN_TIER"] == tier).to_numpy()))
    for label, column, comparison, threshold in EVENT_COHORTS:
        if column not in predictions.columns:
            continue
        values = pd.to_numeric(predictions[column], errors="coerce")
        mask = (values >= threshold) if comparison == ">=" else (values < threshold)
        definitions.append((label, (mask & values.notna()).to_numpy()))

    for label, mask in definitions:
        if not mask.any():
            continue
        sub = predictions[mask]
        for (target, method), group in sub.groupby(["target", "method"]):
            rows.append({
                "cohort": label, "target": target, "method": method,
                "uncond_mae": mae(group["y"], group["uncond"]), "n": int(len(group)),
            })
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    base = out[out["method"] == INCUMBENT].set_index(["cohort", "target"])["uncond_mae"]
    out["rel"] = out.apply(
        lambda r: 1.0 - r["uncond_mae"] / base.loc[(r["cohort"], r["target"])], axis=1
    )
    return out


def halflife_sweep(predictions: pd.DataFrame) -> pd.DataFrame:
    """the DESCRIPTIVE halflife curve, both schemes, primary endpoint.

    NOT part of the decision family: only its two pre-registered representatives (the
    inner-selected M1 and the fixed-halflife-12 M2) are. This table exists because
    "halflife 12 helps" is a claim about a curve, and a curve is the honest way to show
    it - including the case where the curve is flat.

    the (scheme, halflife) label of each fixed-halflife member is read off the bracket
    objects rather than parsed out of their names, so a renamed method cannot silently
    land in the wrong row of the sweep.
    """
    fixed = {
        m.name: (m.scheme, m.halflife)
        for m in build_bracket()
        if isinstance(getattr(m, "halflife", None), float) and hasattr(m, "scheme")
        and type(m).__name__ == "EwmaRate"
    }
    sub = predictions[predictions["method"].isin(fixed)]
    if sub.empty:
        return pd.DataFrame()
    rows = []
    for (target, method), group in sub.groupby(["target", "method"]):
        scheme, halflife = fixed[method]
        played = group["PLAYED"] == 1
        rows.append({
            "target": target, "scheme": scheme, "halflife": halflife,
            "method": method,
            "uncond_mae": mae(group["y"], group["uncond"]),
            "cond_mae": mae(group.loc[played, "y"], group.loc[played, "cond"]),
        })
    out = pd.DataFrame(rows)
    base = out[(out["scheme"] == SCHEME_PLAIN)
               & (out["halflife"] == INCUMBENT_HALFLIFE)].set_index("target")
    out["uncond_rel_vs_h5"] = out.apply(
        lambda r: 1.0 - r["uncond_mae"] / base.loc[r["target"], "uncond_mae"], axis=1
    )
    out["cond_rel_vs_h5"] = out.apply(
        lambda r: 1.0 - r["cond_mae"] / base.loc[r["target"], "cond_mae"], axis=1
    )
    return out.sort_values(["target", "scheme", "halflife"]).reset_index(drop=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rebuild", action="store_true",
                        help="recompute the rate cache and the cross-fit minutes")
    parser.add_argument("--from-cache", action="store_true",
                        help="re-render the tables from the cached per-row predictions "
                             "instead of re-scoring. the scoring is deterministic, so "
                             "this changes no number - it exists so that a reporting fix "
                             "does not require another pass over the bracket")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    t0 = time.time()
    frame = load_frame(rebuild=args.rebuild)
    check = reproduction_check(frame)
    print("\n== reproduction check: recomputed halflife-5 vs the shipped column ==")
    print(check.to_string(index=False))
    print(f"\nOOF minutes source shares: "
          f"{frame[OOF_MIN_SOURCE].value_counts(normalize=True).to_dict()}")
    print(f"rows with no prior rate history: {frame[RATE_N].isna().mean():.4%}")

    CACHE.mkdir(exist_ok=True)
    if args.from_cache and (CACHE / "predictions.parquet").exists():
        log.info("re-rendering from the cached predictions; no model is refitted")
        predictions = pd.read_parquet(CACHE / "predictions.parquet")
        selections = pd.read_csv(HERE / "selections.csv")
    else:
        predictions, selections = run(frame)
        predictions.to_parquet(CACHE / "predictions.parquet", index=False)
        selections.to_csv(HERE / "selections.csv", index=False)

    head = headline(predictions)
    origins_table = per_origin(predictions)
    boots = bootstrap_table(predictions)
    cohorts = cohort_table(predictions)
    sweep = halflife_sweep(predictions)

    head.to_csv(HERE / "headline.csv", index=False)
    origins_table.to_csv(HERE / "per_origin.csv", index=False)
    boots.to_csv(HERE / "bootstrap.csv", index=False)
    cohorts.to_csv(HERE / "cohorts.csv", index=False)
    check.to_csv(HERE / "reproduction_check.csv", index=False)
    sweep.to_csv(HERE / "halflife_sweep.csv", index=False)

    print("\n== headline: primary endpoint (unconditional MAE, 5 origins pooled) ==")
    print(head.to_string(index=False, float_format=lambda v: f"{v:.4f}"))
    print("\n== bootstrap vs the incumbent ==")
    print(boots.to_string(index=False, float_format=lambda v: f"{v:.4f}"))
    print("\n== DESCRIPTIVE halflife sweep ==")
    print(sweep.to_string(index=False, float_format=lambda v: f"{v:.4f}"))
    print("\n== selected hyperparameters per origin ==")
    if "halflife" in selections.columns:
        print(
            selections[~selections["descriptive"]]
            .pivot_table(index=["target", "method"], columns="origin",
                         values="halflife", aggfunc="first")
            .to_string()
        )
    print("\n== per-origin relative improvement ==")
    print(
        origins_table.pivot_table(index=["target", "method"], columns="origin", values="rel")
        .to_string(float_format=lambda v: f"{v:+.2%}")
    )
    promoted = boots[boots["PROMOTE"]] if not boots.empty else boots
    print(f"\n== DECISION: {len(promoted)} (method, target) pairs clear the "
          f"pre-registered bar ==")
    if len(promoted):
        print(promoted.to_string(index=False, float_format=lambda v: f"{v:.4f}"))
    else:
        print("none. the incumbent EWMA(halflife 5) stays for every rate target.")
    print(f"\ntotal wall clock {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
