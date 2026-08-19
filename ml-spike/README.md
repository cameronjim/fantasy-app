# NBA Prediction Feasibility Spike (Phase 0)

A standalone, throwaway spike that validates one design principle before any of
it gets built for real:

> Predict **availability** first (does the player appear at all?), then
> **minutes** conditional on appearing, then **production**.

The alternative — training only on recorded appearances — answers *"what will
he record **given** he plays"*. That is selection-biased for fantasy, where the
question is what a roster slot returns over the games that are actually on the
schedule, misses included.

Nothing here talks to the main app. It reads from stats.nba.com, writes
parquet into `data/`, and prints numbers. It is not production code.

---

## Setup

Requires Python 3.12+ (developed and run on **3.14.5**; all dependencies had
cp314 wheels available).

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

`stats.nba.com` blocks AWS/CI egress IPs. **These scripts must be run from a
residential connection**, not from CI or a cloud box.

## Run order

```powershell
.\.venv\Scripts\python.exe pull_data.py        # ~15s, network
.\.venv\Scripts\python.exe build_universe.py   # ~20s
.\.venv\Scripts\python.exe features.py         # ~25s
.\.venv\Scripts\python.exe run_eval.py         # ~3min
.\.venv\Scripts\python.exe diagnostics.py      # ~30s
.\.venv\Scripts\python.exe -m pytest leakage_tests.py -v
```

`pull_data.py` is idempotent — it skips any season whose parquet already
exists, so re-running it does not re-hit the API.

## Files

| file | role |
|---|---|
| `pull_data.py` | League-wide player + team game logs, 2023-24 and 2024-25 Regular Season. One request per (season, mode); 3s sleeps; 60s timeout; bounded retries then hard stop. |
| `build_universe.py` | The scheduled-player-game universe (see caveat below). |
| `features.py` | Leakage-safe features. Owns `FEATURE_COLS`. |
| `models.py` | The model ladder + metrics. Does no splitting. |
| `run_eval.py` | Rolling-origin evaluation, segment reporting, writes `data/results_long.csv`. |
| `diagnostics.py` | Quantifies the roster approximation's distortion + model calibration. |
| `leakage_tests.py` | 12 pytest asserts that recompute features by hand from raw logs. |
| `REPORT.md` | **The findings.** Real numbers, all tables, honest conclusions. |

---

## The ±15-day roster approximation — read this

The universe needs, for every team-game, the set of players who *could* have
played. The correct source is the official inactive list, which lives in
per-game boxscores: ~2,460 extra requests per season. stats.nba.com will
throttle that hard, so this spike approximates instead.

**Approximation:** the eligible roster for a team-game on date `d` is every
player who recorded at least one game log **for that team** within
`[d-15, d+15]`.

Each `(eligible player, team-game)` pair is one row. `PLAYED` is whether a game
log exists for that exact `(player, game, team)`; `MIN` is actual, or 0.

The ±15-day window is used **only to reconstruct roster membership**. It is
never a model feature, and no feature ever reads forward of the target game.

### Known biases (measured in REPORT.md §5, not hand-waved)

1. **Long injuries are truncated.** A player out for more than ~15 days on both
   sides drops out of the universe entirely. The longest absence streak the
   universe can even represent is **16 consecutive team-games** — a
   season-ending injury (40-60 games) is structurally invisible.
2. **Availability is biased upward.** Restoring only the *provable* missing
   rows (players eligible before *and* after a gap, so certainly rostered
   throughout) moves the base rate from **0.6638 → 0.6446**, and 2.98% of rows
   are missing at minimum. The real gap is larger, since that correction cannot
   see players whose injury spans the start or end of their spell.
3. **Traded players stay eligible for their old team** for up to 15 days,
   inflating roster size (max observed: 24, vs. a real active roster of 13).
4. **10-day contracts and two-way call-ups** appear only around their stint.

Net effect: the availability model is trained on a world where players are
healthier than reality, and it **systematically over-predicts availability in
every probability bin** (REPORT.md §5). The real implementation must use
official inactive lists / injury reports; this is the single highest-priority
schema requirement coming out of the spike.

---

## As-of correctness

Features for game G may use information from strictly before G. Exactly two
mechanisms enforce this:

1. **`merge_asof(..., allow_exact_matches=False)`** for anything derived from
   the player's appearance history. Rolling stats are computed on the
   appearance frame *inclusive* of each appearance, then as-of joined onto the
   universe picking the last appearance **strictly before** the target date.
   The appearance on the target date can never be matched.
2. **Explicit `.shift(1)` before every `.rolling()`/`.expanding()`** for
   anything computed directly on the universe or schedule frames (availability
   rate, rest days, opponent defensive form).

Two separate as-of joins are used, because the features have two different
scopes and one join key cannot serve both:

- **career-scoped** (`roll{3,5,10}_*`, `ewma_*`, `n_appearances`) joined by
  `PLAYER_ID` — windows may span the offseason, so a returning player carries
  prior-season form into his first game of a new season, which is precisely
  when in-season history does not exist.
- **season-scoped** (`std_*`, `avail_rate_std`, `uncond_std_*`) joined by
  `PLAYER_ID + SEASON` — season-to-date means must reset at the boundary.

`leakage_tests.py` asserts both scopes independently, and includes negative
controls that confirm the leaky variant produces a *different* number (so the
tests would actually fail if a shift were dropped).

## Evaluation

Rolling-origin, forward-chaining, **no random splits**. All of 2023-24 is
always in training:

| origin | train | validate |
|---|---|---|
| O1 | ≤ 2024-11-30 | 2024-12 |
| O2 | ≤ 2024-12-31 | 2025-01 |
| O3 | ≤ 2025-01-31 | 2025-02 |

Minutes tiers for segment reporting are assigned from `roll10_MIN` — a *prior*
rolling mean — so the segment label is itself as-of safe.
