"""empirical prediction quantiles for the champion point estimates.

the promoted conditional estimator is EWMA(halflife 5) - a point estimate with
no distribution attached. a start/sit decision needs more than a point: "18
points" and "18 points, but anywhere from 6 to 31" are different claims, and
only the second one is honest about a stat whose game-to-game spread is larger
than most of the differences anyone is choosing between.

the construction is deliberately the dumbest defensible one: take the residuals
(actual - predicted) the champion produced on a VALIDATION window it was not
fit on, read their empirical quantiles, and add those offsets to the point
estimate. no distributional assumption, no fitted quantile regressor.

what that buys and what it does not:

  buys   a calibrated-on-average interval. if 10% of validation residuals fell
         below -8.4 points, then subtracting 8.4 gives a P10 that was right 10%
         of the time over that window.
  does   NOT vary the width by player. a fringe player and a star get the same
         offsets, though the star's true spread is wider. a per-tier version is
         the obvious next step; a fitted quantile model is not, for the same
         reason the conditional mean is not a fitted model (README section
         "the one-sentence design").

NON-CROSSING is enforced twice, on purpose. offsets are sorted when they are
built, and the emitted quantiles are sorted again row-wise when they are
applied. a P90 below a P50 is not a small numerical annoyance - it is a number
that makes the whole interval unreadable, and it can arise from a hand-built
offset set or from clipping at a floor. sorting is cheap; auditing a crossed
interval after it reached a user is not.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# P10/P50/P90. the 80% central interval is what evaluate.py already reports
# coverage for (NOMINAL_COVERAGE), so the tails line up with the existing
# calibration table rather than introducing a second nominal level.
QUANTILE_LEVELS: tuple[float, ...] = (0.10, 0.50, 0.90)

# stats whose quantiles ship. minutes and points are the two the serving path
# renders; the rest stay expected values until there is a reason to widen it.
QUANTILE_TARGETS: tuple[str, ...] = ("MIN", "PTS")

# every stat here is a count or a duration, so a negative quantile is not a
# conservative estimate - it is an impossible one.
VALUE_FLOOR = 0.0


@dataclass(frozen=True)
class QuantileOffsets:
    """additive offsets that turn a point estimate into quantiles.

    ``offsets[i]`` is the empirical ``levels[i]`` quantile of the validation
    residuals, so ``point + offsets[i]`` is the corresponding predicted
    quantile. offsets are sorted ascending at construction, which is what makes
    the emitted quantiles non-crossing.
    """

    target: str
    levels: tuple[float, ...]
    offsets: tuple[float, ...]
    n: int
    window: tuple[str, str] | None = None

    def __post_init__(self) -> None:
        if len(self.levels) != len(self.offsets):
            raise ValueError(
                f"{self.target}: {len(self.levels)} levels against "
                f"{len(self.offsets)} offsets"
            )

    def as_dict(self) -> dict[str, object]:
        """json-serialisable form, for metadata.json and the registry."""
        return {
            "target": self.target,
            "levels": [round(float(x), 4) for x in self.levels],
            "offsets": [round(float(x), 6) for x in self.offsets],
            "n": int(self.n),
            "window": list(self.window) if self.window else None,
        }

    @classmethod
    def from_dict(cls, payload: dict[str, object]) -> "QuantileOffsets":
        window = payload.get("window")
        return cls(
            target=str(payload["target"]),
            levels=tuple(float(x) for x in payload["levels"]),  # type: ignore[union-attr]
            offsets=tuple(float(x) for x in payload["offsets"]),  # type: ignore[union-attr]
            n=int(payload.get("n", 0)),  # type: ignore[arg-type]
            window=(str(window[0]), str(window[1])) if window else None,  # type: ignore[index]
        )


def fit_residual_quantiles(
    y_true,
    y_pred,
    target: str,
    levels: tuple[float, ...] = QUANTILE_LEVELS,
    window: tuple[str, str] | None = None,
) -> QuantileOffsets:
    """empirical residual quantiles from a validation window.

    ``y_true``/``y_pred`` must come from rows the estimator did not see while
    fitting - residuals on training rows understate the spread and would produce
    intervals that are narrower than the model deserves. non-finite pairs are
    dropped rather than imputed: a missing outcome carries no information about
    the spread.
    """
    actual = np.asarray(y_true, dtype=float)
    predicted = np.asarray(y_pred, dtype=float)
    if actual.shape != predicted.shape:
        raise ValueError(
            f"{target}: {actual.shape} outcomes against {predicted.shape} predictions"
        )

    residuals = actual - predicted
    residuals = residuals[np.isfinite(residuals)]
    if residuals.size == 0:
        raise ValueError(
            f"{target}: no finite residuals in the validation window, so no "
            f"quantile offsets can be estimated"
        )

    # sorted() is the non-crossing guarantee at the offset level: monotone
    # offsets added to a common point estimate stay monotone.
    offsets = tuple(sorted(float(np.quantile(residuals, level)) for level in levels))
    return QuantileOffsets(
        target=target,
        levels=tuple(float(x) for x in levels),
        offsets=offsets,
        n=int(residuals.size),
        window=window,
    )


def apply_quantiles(
    point: np.ndarray | pd.Series,
    offsets: QuantileOffsets,
    floor: float | None = VALUE_FLOOR,
) -> dict[float, np.ndarray]:
    """point estimate + offsets -> one array per level, guaranteed non-crossing.

    the row-wise sort is the second enforcement. it is a no-op for offsets that
    came out of :func:`fit_residual_quantiles`, and it is the thing that saves a
    hand-built or hand-edited offset set from emitting a P90 under its P50.
    """
    base = np.asarray(point, dtype=float)
    stacked = np.stack([base + offset for offset in offsets.offsets], axis=0)
    if floor is not None:
        stacked = np.clip(stacked, floor, None)
    stacked = np.sort(stacked, axis=0)
    return {level: stacked[i] for i, level in enumerate(offsets.levels)}


def quantile_columns(target: str, levels: tuple[float, ...] = QUANTILE_LEVELS) -> dict[float, str]:
    """level -> frame column name, e.g. 0.1 -> 'Q10_PTS'."""
    return {level: f"Q{int(round(level * 100)):02d}_{target}" for level in levels}


def attach_quantiles(
    frame: pd.DataFrame,
    point: np.ndarray | pd.Series,
    offsets: QuantileOffsets,
    floor: float | None = VALUE_FLOOR,
) -> pd.DataFrame:
    """write ``Q10_<target>``/``Q50_<target>``/``Q90_<target>`` onto a copy."""
    out = frame.copy()
    columns = quantile_columns(offsets.target, offsets.levels)
    for level, values in apply_quantiles(point, offsets, floor).items():
        out[columns[level]] = values
    return out
