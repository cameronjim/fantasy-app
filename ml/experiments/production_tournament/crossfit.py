"""out-of-fold predicted minutes for EVERY scheduled row, by forward chaining.

WHY THIS EXISTS. two of the eight candidates need predicted minutes at TRAINING
time - the Poisson candidate uses ``log(minutes)`` as its offset, which is the whole
point of a count-native framing. if that offset came from a minutes model whose
training window contained the row, the fitted rate would encode a view of the row's
own minutes, and the leak would sit one indirection away from the metric where
nothing downstream could detect it. actual target-game minutes are of course out of
the question.

this is the same construction ``models.cross_fit_base_probabilities`` uses for the
teammate-context probabilities, applied to minutes instead of availability, and for
the same reason its docstring gives: a per-origin refit is out of fold for the
VALIDATION rows and hopelessly in-fold for the TRAINING rows whose offsets the model
is fitted on. only a forward-chaining block cross-fit is out of fold on both sides
at once.

  * the history is cut into consecutive calendar blocks (``config.CROSS_FIT_FREQ``);
  * each block is scored by a model fitted on APPEARANCE rows strictly before the
    block start;
  * every prediction carries the block start as its cutoff and the whole frame is
    pushed through ``models.validate_out_of_fold``, the same guard P(play) and
    E[min|plays] already pass.

COLD BLOCKS. a block with fewer than ``config.CROSS_FIT_MIN_TRAIN_ROWS`` prior
appearance rows is not modelled; those rows fall back to the frame's own
``ewma_MIN`` (itself as-of safe), floored at ``RATE_MINUTES_FLOOR`` so the Poisson
offset's logarithm is finite. That is a weaker minutes estimate, not a leaky one,
and it is flagged in ``OOF_MIN_SOURCE`` so the share is reportable. It touches only
the opening weeks of 2022-23, which no origin validates on.
"""

from __future__ import annotations

import logging

import numpy as np
import pandas as pd

from fnba_ml.config import (
    CHAMPIONS,
    CROSS_FIT_FREQ,
    CROSS_FIT_MIN_TRAIN_ROWS,
    FEATURE_COLS,
    RATE_MINUTES_FLOOR,
)
from fnba_ml.models import MinutesModel, validate_out_of_fold

log = logging.getLogger(__name__)

OOF_MIN = "OOF_MIN_PRED"
OOF_MIN_CUTOFF = "OOF_MIN_PRED_CUTOFF"
OOF_MIN_SOURCE = "OOF_MIN_SOURCE"


def minutes_fallback(frame: pd.DataFrame,
                     floor: float = RATE_MINUTES_FLOOR) -> np.ndarray:
    """the stage-0 minutes estimate: the as-of minutes EWMA, floored."""
    if "ewma_MIN" not in frame.columns:
        return np.full(len(frame), float(floor))
    return (
        pd.to_numeric(frame["ewma_MIN"], errors="coerce")
        .fillna(float(floor))
        .clip(lower=float(floor))
        .to_numpy(dtype=float)
    )


def cross_fit_minutes(
    features: pd.DataFrame,
    feature_cols: list[str] | None = None,
    freq: str = CROSS_FIT_FREQ,
    min_train_rows: int = CROSS_FIT_MIN_TRAIN_ROWS,
    kind: str = CHAMPIONS["minutes"],
) -> pd.DataFrame:
    """one out-of-fold E[minutes|plays] per scheduled row, with its cutoff stamp."""
    cols = list(feature_cols or FEATURE_COLS)
    present = [c for c in cols if c in features.columns]

    frame = features.copy()
    frame["GAME_DATE"] = pd.to_datetime(frame["GAME_DATE"])
    frame = frame.sort_values("GAME_DATE").reset_index(drop=True)

    fallback = minutes_fallback(frame)
    pred = np.full(len(frame), np.nan)
    cutoff = np.full(len(frame), np.datetime64("NaT", "ns"), dtype="datetime64[ns]")
    source = np.array(["baseline"] * len(frame), dtype=object)

    dates = frame["GAME_DATE"].to_numpy()
    played = frame["PLAYED"].to_numpy() == 1
    first, last = frame["GAME_DATE"].min().normalize(), frame["GAME_DATE"].max().normalize()
    edges = pd.date_range(first, last + pd.Timedelta(days=1), freq=freq)
    edges = pd.DatetimeIndex(sorted(set([first, *edges, last + pd.Timedelta(days=1)])))

    fitted = 0
    for start, end in zip(edges[:-1], edges[1:]):
        block = (dates >= np.datetime64(start)) & (dates < np.datetime64(end))
        if not block.any():
            continue
        train_mask = (dates < np.datetime64(start)) & played
        cutoff[block] = np.datetime64(start)
        if int(train_mask.sum()) < min_train_rows:
            pred[block] = fallback[block]
            continue
        model = MinutesModel(kind=kind).fit(frame.loc[train_mask], present, start)
        pred[block] = np.clip(model.predict(frame.loc[block]), 0.0, None)
        source[block] = "cross-fit"
        fitted += 1

    out = pd.DataFrame({
        "PLAYER_ID": frame["PLAYER_ID"].to_numpy(),
        "GAME_ID": frame["GAME_ID"].to_numpy(),
        "GAME_DATE": frame["GAME_DATE"].to_numpy(),
        OOF_MIN: pred,
        OOF_MIN_CUTOFF: cutoff,
        OOF_MIN_SOURCE: source,
    })
    log.info(
        "cross-fit minutes: %d blocks fitted, %d/%d rows from a model (%.1f%%)",
        fitted, int((source == "cross-fit").sum()), len(out),
        100.0 * float((source == "cross-fit").mean()),
    )
    return validate_out_of_fold(out, OOF_MIN, OOF_MIN_CUTOFF, "oof E[minutes|plays]")
