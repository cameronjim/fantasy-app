"""put ``ml/`` on ``sys.path`` so ``fnba_ml`` imports under a bare pytest run.

``ml/tests/conftest.py`` does the same thing for the main suite. this file exists so
that ``pytest ml/experiments/production_tournament -q`` works from the repository root
without a package install, an editable wheel or a PYTHONPATH the caller has to
remember. it adds nothing else and defines no fixtures - the tests in this directory
are pure-function tests and want no shared state.
"""

from __future__ import annotations

import sys
from pathlib import Path

ML_ROOT = Path(__file__).resolve().parents[2]
if str(ML_ROOT) not in sys.path:
    sys.path.insert(0, str(ML_ROOT))
