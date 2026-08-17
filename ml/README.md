# `ml/` — availability-first NBA production forecasting

Production port of the phase-0 feasibility spike (`ml-spike/`, findings in
`ml-spike/REPORT.md`). The spike's conclusions are binding on this package;
where the code looks conservative, that is deliberate.

## The one-sentence design

```
E[stat over the schedule] = P(play) × E[stat | played]
```

`P(play)` is a trained LightGBM classifier — the only genuinely learnable
target in the spike (**−22.8% Brier** vs a shifted appearance rate, stable
across all three validation origins). `E[stat | played]` is **EWMA(halflife 5)**,
not a model: no trained conditional estimator beat it by more than ~1%, and
several lost outright on stars and fringe players. Ridge and LightGBM remain
implemented as challengers and are never promoted automatically.

There is therefore **no production ML model in the promoted path.** That is the
finding, not an omission — see `fnba_ml/config.py::CHAMPIONS`.

Why bother with the decomposition at all: applying a conditional-on-playing
estimate to every scheduled row scores 5.29 MAE on unconditional points; simply
counting misses as zeros scores 4.63 (12.4% better, for free); the decomposition
reaches 4.17 (another 10%). It also yields a calibrated `P(play)`, which start/sit
decisions need and a direct model cannot recover.

---

## Runbook

Everything runs offline against parquet. Nothing here makes a network call.

```powershell
# once
py -3.14 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 1. dataset: source -> universe -> as-of-safe features
python build_dataset.py --source parquet --data-dir ..\ml-spike\data
python build_dataset.py --source postgres            # needs DATABASE_URL

# 2. train: availability model + EWMA snapshot -> models/<version>/ + registry
python train.py --version 2026-08-16

# 3. evaluate: rolling-origin report -> reports/<version>.md
python evaluate.py --version 2026-08-16

# 4. predict: next games -> parquet, and optionally to postgres
python predict.py --version 2026-08-16 --out data\predictions.parquet
python predict.py --version 2026-08-16 --write-db    # needs DATABASE_URL + migration 014

# tests
python -m pytest tests -v
```

`--write-db` inserts one `prediction_runs` row and one
`player_game_predictions` row per (player, game, stat, quantile), in a single
transaction, against the tables from `db/migrations/014_predictions.sql`. That
migration is applied by hand in the Neon SQL editor — run it against prod and
the dev branch before the first `--write-db`, then record it in
`schema_migrations` the way `scraper/check_migrations.py` expects.

The store is **append-only**. A re-run writes a new run and never edits an old
one, because a prediction that can be revised after the fact cannot be
backtested. Serving reads the newest run with `status = 'complete'`.

`--write-db` **refuses the approximation universe** unless
`--allow-biased-universe` is passed, and stamps the reason into the run's notes
when it is. A stored prediction outlives the caveat that shipped with it.

Per scheduled player-game the run writes 13 rows: `prob_active` (unconditional,
`[0,1]`), a conditional expected value and a `<stat>_uncond` schedule-level one
for minutes/pts/ast, and P10/P50/P90 for minutes and pts. Quantiles come from
the empirical residual quantiles of the training holdout window
(`fnba_ml/intervals.py`), measured on appearances only, and are non-crossing by
construction — offsets sorted when built, values sorted again when written.

### Artifacts

| Path | Committed? | Notes |
|---|---|---|
| `models/<version>/` | yes | `availability_model.joblib`, `ewma_state.parquet`, `metadata.json`, `feature_gain.csv` |
| `models/registry.json` | yes | one entry per version: training window, hyperparams, metrics, per-artifact sha256, git commit |
| `reports/<version>.md` | yes | the evaluation record for that version |
| `reports/*_results.csv` | no | tidy long results, for numeric diffing between runs |
| `data/*.parquet` | no | build artifacts, regenerate in ~1 minute |
| `tests/fixtures/*.parquet` | no | regenerated deterministically on every test session |

There is no artifact store in this project, so `models/` is committed to git.
The registry is what makes that traceable: re-hash with
`fnba_ml.registry.verify_artifacts(version)`.

---

## What each module owns

```
fnba_ml/
  config.py              every constant: seasons, windows, halflife, tiers,
                         feature list, champions, cutoff policy, origins
  data/schema.py         the four canonical frame shapes + id/date normalisation
  data/parquet_source.py spike-shaped parquet; schedule reconstructed from team logs
  data/postgres_source.py  SQL against the migration-013 tables (NOT executed in tests)
  universe.py            scheduled-player-game rows: status-based, or BIASED fallback
  features.py            leakage-safe as-of feature construction
  models.py              the ladder, EWMA champion, decomposed estimator, OOF guard
  evaluate.py            rolling-origin harness, segments, skill scores, champion picks
  intervals.py           empirical residual quantiles -> non-crossing P10/P50/P90
  store.py               the migration-014 row builder (pure) and its transaction
  registry.py            models/registry.json
```

Scripts at the top level (`build_dataset.py`, `train.py`, `evaluate.py`,
`predict.py`) are thin CLIs. All logic lives in the package.

---

## The three things that are easy to get wrong

### 1. As-of joins must be scoped like their windows

Exactly two mechanisms enforce "features for game G use only information from
strictly before G":

1. `merge_asof(..., allow_exact_matches=False)` for anything derived from the
   player's **appearance** history.
2. An explicit `.shift(1)` before every `.rolling()` / `.expanding()` for
   anything computed on the universe or schedule frames.

And there are **two** as-of joins, not one:

- **career-scoped** (`roll{3,5,10}_*`, `ewma_*`, `n_appearances`) joined by
  `PLAYER_ID` — windows may span the offseason, so a returning player carries
  prior-season form into his first game of a new season, which is precisely
  when in-season history does not exist.
- **season-scoped** (`std_*`, `avail_rate_std`, `uncond_std_*`) joined by
  `PLAYER_ID + SEASON` — season-to-date means must reset at the boundary.

The spike originally used a single join keyed on `PLAYER_ID + SEASON` while
rolling windows were grouped by `PLAYER_ID` alone. Not leakage, but incoherent,
and invisible until tested. `tests/test_features.py` asserts both scopes
independently, with negative controls confirming the leaky variant produces a
*different* number.

### 2. `groupby().first()` skips nulls

It returns the first **non-null** value per column, so a test written with it
**cannot detect** the leak it was written to catch. Use
`drop_duplicates(keep="first")`. Pinned by
`test_groupby_first_cannot_detect_the_leak`.

### 3. Out-of-fold `P(play)` must never leak in-fold

The decomposition multiplies an availability probability into a downstream
estimate. If that probability came from a model whose training window included
the row being predicted, nothing downstream can detect it.

So every `P(play)` travels with the cutoff of the model that produced it
(`P_PLAY_CUTOFF`), and `models.validate_out_of_fold` refuses any row whose
cutoff is not at or before its own game date. `decomposed_estimate` calls the
guard itself rather than trusting callers. `AvailabilityModel.fit` refuses a
training frame containing rows on or after its cutoff.

---

## The universe, and why it is the highest-priority data dependency

One row per **(player who could have played, team-game)** — not per game log. A
model trained only on recorded appearances answers "how much *given* he plays",
which is selection-biased for fantasy.

Two constructions, and they are not equivalent:

**Status-based (preferred).** One row per rostered player per team-game from
`player_game_status`. A player listed inactive for two months is present in
every one of those team-games with `PLAYED = 0` — exactly what the availability
model needs to see. Used automatically whenever the source returns status rows.

**Approximation (fallback, BIASED).** Eligibility inferred from game-log
presence within ±15 days. Only for parquet-fixture mode, where no roster table
exists. Measured distortions (REPORT.md §5):

- availability base rate inflated by **at least +0.0192** (0.6638 vs 0.6446)
- longest representable absence streak is **16 team-games**; real season-ending
  injuries (40–60 games) are structurally invisible
- the resulting model **over-predicts availability in every probability bin**,
  worst (−0.136) in the uncertain 0.6–0.7 middle where start/sit calls are hard
- `games_since_last_app` carries 4× the gain of any other feature and is partly
  an artifact of the window — expect the availability numbers to move, most
  likely getting *harder*, once the universe is built properly

Every code path that reaches the fallback logs a `BIASED UNIVERSE` warning and
stamps `UNIVERSE_SOURCE = 'approximation'` on every row; the evaluation report
carries a callout banner. Do not ship predictions from it.

---

## Portability notes

- **Python 3.14.5 on Windows**, pandas 3.0.5, scikit-learn 1.9.0, LightGBM
  4.7.0. `requirements.txt` pins the exact verified set; all had cp314 wheels.
- **`psycopg2` and `python-dotenv` are imported lazily**, inside the functions
  that need them. `data/postgres_source.py` — including its SQL — can be
  imported and inspected with neither package installed, and a parquet-only run
  needs no database driver.
- **No test opens a database connection.** There is no test database in this
  repo (AGENTS.md §6) and `postgres_source.py` is never executed by the suite.
  Its SQL is written against the migration-013 contract and is the first thing
  to re-read if that schema moves.
- **Identifiers are normalised to `str`** everywhere. Postgres stores NBA ids as
  `TEXT`, the spike parquet as `int64`; merging a str key against an int key
  silently produces zero matches.
- **Internal column names are SCREAMING_SNAKE NBA-style** (`PLAYER_ID`, `MIN`,
  `PTS`), not the database's snake_case. The leakage-critical feature code was
  ported verbatim; renaming its columns would have meant rewriting the exact
  logic the tests were built to pin down. Both sources translate at the
  boundary — see `data/schema.py`.
- **LightGBM is not bit-reproducible against the spike.** Rows are sorted by
  string ids rather than integer ids, which reorders ties within a game date and
  therefore changes bagging subsamples. Baselines match the spike to five
  decimals; LightGBM figures move by well under 1%. See the parity table below.

---

## Port fidelity vs the spike

`build_dataset.py --source parquet --data-dir ../ml-spike/data` followed by
`evaluate.py` reproduces the spike end to end. Universe: **79,406 rows, 4,920
team-games, played rate 0.6638, 100% appearance coverage** — identical.

| Metric (mean over 3 origins) | Spike | This package | Δ |
|---|---:|---:|---:|
| Availability Brier — LightGBM | 0.1365 | 0.1373 | +0.6% |
| Availability Brier — logistic | 0.1564 | 0.1564 | — |
| Availability Brier — shifted rate | 0.1769 | 0.1769 | — |
| Availability Brier — global rate | 0.2262 | 0.2262 | — |
| MIN\|played MAE — EWMA | 4.8213 | 4.8213 | — |
| MIN\|played MAE — LightGBM | 4.7527 | 4.7616 | +0.2% |
| PTS\|played MAE — EWMA | 4.5664 | 4.5665 | — |
| PTS\|played MAE — ridge | 4.5202 | 4.5203 | — |
| Unconditional PTS MAE — decomposed (P × LightGBM) | 4.1698 | 4.1681 | −0.04% |
| Unconditional PTS MAE — decomposed (P × EWMA, **champion**) | not run | 4.1719 | — |
| Unconditional PTS MAE — direct LightGBM | 4.1950 | 4.1955 | — |
| Unconditional PTS MAE — naive unconditional | 4.6340 | 4.6340 | — |
| Unconditional PTS MAE — naive conditional | 5.2928 | 5.2928 | — |

Every baseline matches exactly. The LightGBM deltas are the row-ordering effect
described above, not a logic change.

Note the champion decomposition (`P × EWMA`, 4.1719) is within 0.1% of the
spike's `P × LightGBM` variant (4.1681) — the trained conditional model buys
essentially nothing at the unconditional level either, which is the whole
argument for shipping the EWMA.

---

## Evaluation protocol

Rolling-origin, forward-chaining, **no random splits**. Training is everything
strictly before the validation window, so the first season is always fully in
training.

| Origin | Train | Validate |
|---|---|---|
| O1 | ≤ 2024-11-30 | 2024-12 |
| O2 | ≤ 2024-12-31 | 2025-01 |
| O3 | ≤ 2025-01-31 | 2025-02 |

Reported per task: the metric itself, a **skill score** against that task's
naive baseline, a **segment breakdown by minutes tier** (tiers assigned from
`roll10_MIN`, a prior rolling mean, so the label is itself as-of safe), and
empirical **80% interval coverage** for the champion production estimate.

`evaluate.select_champions` reports the measured winner per target next to the
configured champion and flags mismatches. A mismatch is a finding to look at,
**not** an instruction to promote — a 1% MAE edge does not justify a trained
model in the serving path.

Caveats inherited from the spike: two seasons, three origins, one month of
validation each. Differences under ~2% are not distinguishable from noise at
this sample size, and no confidence intervals are computed.

---

## Tests

```powershell
python -m pytest tests -v      # 87 tests
```

| File | Covers |
|---|---|
| `tests/test_features.py` | all 12 leakage tests ported from `ml-spike/leakage_tests.py`, plus the `groupby().first()` trap regression and missingness-flag checks |
| `tests/test_universe.py` | status-based preferred; fallback labeled and warns; approximation over-states availability and truncates long absences; schedule symmetry |
| `tests/test_models.py` | decomposition math; out-of-fold discipline including a deliberately constructed in-fold failure; EWMA champion behaviour; metric helpers |
| `tests/test_predictions.py` | the migration-014 row builder as a pure function: conditional vs unconditional flagging, quantile non-crossing (including a deliberately crossed input), `prob_active` clamped to [0,1], non-finite values dropped rather than zeroed. No database — `write_predictions` is read, never run |

Every leakage test runs **twice**, once per universe construction, so a dropped
shift fails on the production path and on the backtest path alike.

Fixtures are seeded synthetic parquet generated by
`tests/fixtures/generate.py` — the suite never depends on `ml-spike/data`
existing. The fixture deliberately contains a 13-game injury spell that the
±15-day approximation provably cannot represent, which is what makes the
universe-bias tests bite.

One real-data claim is **not** asserted in the unit tests: the −22.8% Brier
headline. The fixtures draw availability i.i.d. per roster slot, so the shifted
appearance rate is close to the generating process and a boosted tree on ~2k
rows cannot beat it. That comparison lives in the parquet-mode backtest above.
