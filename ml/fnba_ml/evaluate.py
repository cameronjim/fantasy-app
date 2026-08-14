"""rolling-origin evaluation harness.

the pieces live in the modules this re-exports, and every name a caller used
before the split is still importable from here:

  eval_core      task vocabulary, cohort masks, the recorder, the train/valid split
  eval_ladder    the availability / conditional / unconditional ladder per origin
  eval_rates     the 9-category rate ladder and its halflife selection
  eval_controls  permutation nulls, cohort lift, the degraded-oracle grid
  eval_brackets  the feature-set bracket and the single-feature ablation
  eval_report    aggregation, comparison tables and the markdown report
"""

from __future__ import annotations

from .eval_brackets import (  # noqa: F401
    feature_set_bracket,
    run_feature_set_bracket,
    single_feature_ablation,
)
from .eval_controls import (  # noqa: F401
    COHORT_CONTROL_COLUMN,
    DEGRADED_FALSE_POSITIVES,
    DEGRADED_RECALLS,
    PERMUTATION_CONTROLS,
    add_negative_control,
    block_permute_context,
    cohort_outcome_lift,
    degrade_absence_knowledge,
    degraded_oracle_grid,
    negative_control_pass,
)
from .eval_core import (  # noqa: F401
    ABLATION_FEATURE,
    COHORT_ORACLE_COLUMN,
    COHORT_TASKS,
    CONDITIONAL_TASKS,
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
    _Recorder,
    cohort_masks,
    split,
)
from .eval_ladder import run_rolling_origin  # noqa: F401
from .eval_rates import (  # noqa: F401
    INNER_FOLD_DAYS,
    INNER_FOLDS,
    RATE_MODEL_EWMA,
    RATE_MODEL_EXPANDING,
    RATE_MODEL_TOTAL,
    RATE_SELECTION_MIN_GAIN,
    RATE_SELECTION_MIN_ORIGINS,
    RATE_SKILL_BASELINE,
    RATE_TASK_PREFIX,
    RATE_UNCOND_TASK_PREFIX,
    TASK_COHERENCE,
    attach_rate_grid,
    build_rate_grid,
    grid_rate_column,
    inner_folds,
    rate_halflife_winners,
    rate_task,
    select_rate_halflives,
    whole_game_ewma_column,
)
from .eval_report import (  # noqa: F401
    COMPARISON_TARGETS,
    coherence_table,
    composition_parity,
    feature_set_comparison,
    importance_table,
    mean_by_model,
    rate_composition_parity,
    rate_ladder_table,
    rate_uncond_table,
    render_report,
    select_champions,
    teammate_importance,
)
