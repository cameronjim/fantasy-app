"""shared fixtures. the parquet files are regenerated on every session.

the feature frame is parametrised over BOTH universe constructions. the leakage
tests therefore run twice - once against the status-based universe (the
production path) and once against the biased approximation (the path the
parquet-mode backtest uses). a shift dropped in either would fail.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd
import pytest

ML_ROOT = Path(__file__).resolve().parents[1]
TESTS_DIR = Path(__file__).resolve().parent
for path in (str(ML_ROOT), str(TESTS_DIR)):
    if path not in sys.path:
        sys.path.insert(0, path)

from fixtures.generate import generate  # noqa: E402

from fnba_ml.data import ParquetSource  # noqa: E402
from fnba_ml.features import build_features  # noqa: E402
from fnba_ml.universe import approximate_universe, universe_from_status  # noqa: E402


@pytest.fixture(scope="session")
def fixture_dir() -> Path:
    return generate()


@pytest.fixture(scope="session")
def source(fixture_dir: Path) -> ParquetSource:
    return ParquetSource(fixture_dir, seasons=["2023-24", "2024-25"])


@pytest.fixture(scope="session")
def raw_logs(source: ParquetSource) -> pd.DataFrame:
    logs = source.load_player_game_logs()
    return logs.sort_values(["PLAYER_ID", "GAME_DATE"]).reset_index(drop=True)


@pytest.fixture(scope="session")
def schedule(source: ParquetSource) -> pd.DataFrame:
    return source.load_schedule()


@pytest.fixture(scope="session")
def team_logs(source: ParquetSource) -> pd.DataFrame:
    return source.load_team_game_logs()


@pytest.fixture(scope="session")
def status(source: ParquetSource) -> pd.DataFrame:
    frame = source.load_player_game_status()
    assert frame is not None, "the fixture set must carry a player_game_status file"
    return frame


@pytest.fixture(scope="session")
def positions(source: ParquetSource) -> pd.DataFrame:
    """the SYNTHETIC fixture positions. no real parquet export has any.

    they exist so the positional half of the v2 teammate features
    (``vacated_minutes_pos``, ``depth_rank_available_pos``) is exercised rather
    than being null in every test. two roster slots are deliberately unassigned so
    the no-bucket path is covered too - see fixtures/generate.SLOT_POSITIONS.
    """
    frame = source.load_player_positions()
    assert frame is not None, "the fixture set must carry a player_positions file"
    return frame


@pytest.fixture(scope="session")
def universe_status(schedule, team_logs, raw_logs, status, positions) -> pd.DataFrame:
    return universe_from_status(schedule, team_logs, raw_logs, status, positions)


@pytest.fixture(scope="session")
def universe_approx(schedule, team_logs, raw_logs, positions) -> pd.DataFrame:
    return approximate_universe(schedule, team_logs, raw_logs, positions=positions)


@pytest.fixture(scope="session")
def features_status(universe_status) -> pd.DataFrame:
    return build_features(universe_status)


@pytest.fixture(scope="session")
def features_approx(universe_approx) -> pd.DataFrame:
    return build_features(universe_approx)


@pytest.fixture(scope="session", params=["status", "approximation"])
def feats(request, features_status, features_approx) -> pd.DataFrame:
    return features_status if request.param == "status" else features_approx
