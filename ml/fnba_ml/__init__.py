"""fnba_ml - availability-first NBA production forecasting.

the design this package implements, validated by the phase-0 spike
(``ml-spike/REPORT.md``):

    E[stat over the schedule] = P(play) x E[stat | played]

P(play) is a trained LightGBM classifier - the only genuinely learnable target
in the spike (-22.8% Brier vs a shifted appearance rate). E[stat | played] is
EWMA(halflife 5), because no trained conditional model beat it by more than
~1% and several lost outright on the segments that matter.

module map::

    config      every constant. seasons, windows, tiers, features, champions.
    data/       postgres and parquet sources -> canonical frames
    universe    scheduled-player-game rows (status-based, or BIASED fallback)
    features    leakage-safe as-of feature construction
    models      the ladder, the EWMA champion, the decomposed estimator
    evaluate    rolling-origin harness and markdown reporting
    registry    models/registry.json
"""

from __future__ import annotations

from . import config

__all__ = ["config", "__version__"]

__version__ = "0.1.0"
