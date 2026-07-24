# Phase 0 Spike — Findings

**Question:** is the availability → minutes → production decomposition worth
building, and can it be trained without leakage?

**Answer:** yes to the decomposition, but the win is concentrated almost
entirely in the *availability* stage. Production models conditional on playing
barely beat a shifted rolling mean. The decomposition is worth building; the
production ML is not, yet.

Everything below is measured. All 12 leakage tests pass. Run date: 2026-08-16.
Environment: Windows 10, Python 3.14.5, pandas 3.0.5, scikit-learn 1.9.0,
LightGBM 4.7.0.

---

## 1. Data volumes

Source: `stats.nba.com` via `nba_api` 1.11.4. Four requests total, no
throttling encountered, no retries needed.

| artifact | rows | notes |
|---|---:|---|
| `player_logs_2023_24.parquet` | 26,401 | 70 cols |
| `player_logs_2024_25.parquet` | 26,306 | 70 cols |
| `team_logs_2023_24.parquet` | 2,460 | = 1,230 games × 2 |
| `team_logs_2024_25.parquet` | 2,460 | = 1,230 games × 2 |
| **player game logs, combined** | **52,707** | 694 distinct players |
| **team-games (the schedule)** | **4,920** | complete, both seasons |
| **`universe.parquet`** | **79,406** | scheduled player-games |
| **`features.parquet`** | 79,406 × 36 features | |

Sanity check: **100.00%** of the 52,707 real game logs appear in the universe
as `PLAYED = 1` rows. No appearance was lost by the roster reconstruction.

Mean eligible roster: **16.14** players per team-game. Mean players actually
appearing: **10.71**.

## 2. Availability base rates

| scope | rows | played rate |
|---|---:|---:|
| all | 79,406 | **0.6638** |
| 2023-24 | 39,748 | 0.6642 |
| 2024-25 | 39,658 | 0.6633 |
| validation 2024-12 | 6,009 | 0.6747 |
| validation 2025-01 | 7,393 | 0.6618 |
| validation 2025-02 | 5,953 | 0.6281 |

By minutes tier (tier assigned from `roll10_MIN`, a *prior* rolling mean):

| tier | rows | played rate |
|---|---:|---:|
| star (>=30 mpg) | 16,810 | 0.8247 |
| starter (20-30) | 21,542 | 0.8043 |
| bench (10-20) | 20,650 | 0.6836 |
| fringe (<10) | 18,141 | 0.3697 |
| unknown (no history) | 2,263 | 0.3067 |

The spread here is the whole argument for the decomposition: a fringe player is
scheduled just as often as a star but appears **less than half as often**. Any
model trained only on appearances is blind to this.

Target means, conditional vs. unconditional:

| target | mean given played | mean over all scheduled | ratio |
|---|---:|---:|---:|
| MIN | 22.53 | 14.95 | 0.66 |
| PTS | 10.64 | 7.07 | 0.66 |
| AST | 2.48 | 1.65 | 0.66 |

A conditional model applied naively to a schedule overstates production by
**~51%** (1/0.66).

---

## 3. Results

Rolling-origin, 3 forward-chaining origins, 2023-24 always in training. No
random splits. Best value per column in **bold**.

### 3a. Availability — all scheduled rows

**Brier score** (lower better)

| model | O1 2024-12 | O2 2025-01 | O3 2025-02 | mean |
|---|---:|---:|---:|---:|
| **LightGBM classifier** | **0.1332** | **0.1356** | **0.1407** | **0.1365** |
| logistic regression | 0.1531 | 0.1540 | 0.1622 | 0.1564 |
| baseline: shifted appearance rate (10) | 0.1769 | 0.1710 | 0.1829 | 0.1769 |
| baseline: global rate | 0.2195 | 0.2239 | 0.2353 | 0.2262 |

**Log loss** (lower better)

| model | O1 2024-12 | O2 2025-01 | O3 2025-02 | mean |
|---|---:|---:|---:|---:|
| **LightGBM classifier** | **0.4227** | **0.4266** | **0.4390** | **0.4294** |
| logistic regression | 0.4778 | 0.4807 | 0.5030 | 0.4872 |
| baseline: shifted appearance rate (10) | 0.6336 | 0.6139 | 0.6365 | 0.6280 |
| baseline: global rate | 0.6309 | 0.6400 | 0.6637 | 0.6448 |

> **LightGBM beats the shifted-appearance-rate baseline by 22.8% on Brier and
> 31.6% on log loss, consistently across all three origins.** This is the one
> unambiguous, large win in the spike.

Note the baseline's log loss (0.6280) is barely better than predicting the
global rate (0.6448) despite a much better Brier — the naive rate is confidently
wrong at the extremes (it emits hard 0.0 and 1.0 after 10 straight
misses/appearances).

### 3b. Minutes | played — MAE (appearance rows only)

| model | O1 | O2 | O3 | mean |
|---|---:|---:|---:|---:|
| **LightGBM** | **4.7493** | 4.6409 | **4.8678** | **4.7527** |
| ridge | 4.7901 | **4.6390** | 4.9101 | 4.7797 |
| baseline: EWMA (halflife 5) | 4.7994 | 4.7037 | 4.9607 | 4.8213 |
| baseline: expanding season mean | 4.9242 | 4.9823 | 5.3499 | 5.0855 |

LightGBM beats EWMA by **1.4%** (4.75 vs 4.82 minutes). Beats the expanding
season mean by 6.5% — i.e. most of the "model" value is just *recency*, which
the EWMA baseline already captures for free.

### 3c. PTS | played — MAE

| model | O1 | O2 | O3 | mean |
|---|---:|---:|---:|---:|
| **ridge** | **4.5413** | 4.4064 | **4.6129** | **4.5202** |
| LightGBM | 4.5584 | 4.4638 | 4.6703 | 4.5642 |
| baseline: EWMA (halflife 5) | 4.5713 | **4.4405** | 4.6876 | 4.5664 |
| baseline: expanding season mean | 4.5553 | 4.4872 | 4.7319 | 4.5914 |

Ridge beats EWMA by **1.0%**. LightGBM beats EWMA by **0.05%** — nothing.

### 3d. AST | played — MAE

| model | O1 | O2 | O3 | mean |
|---|---:|---:|---:|---:|
| **ridge** | **1.3169** | **1.3049** | **1.3225** | **1.3148** |
| baseline: EWMA (halflife 5) | 1.3275 | 1.3216 | 1.3412 | 1.3301 |
| baseline: expanding season mean | 1.3326 | 1.3214 | 1.3490 | 1.3343 |
| LightGBM | 1.3349 | 1.3341 | 1.3468 | 1.3386 |

Ridge beats EWMA by 1.2%. **LightGBM is worse than both baselines.**

### 3e. UNCONDITIONAL PTS — MAE over ALL scheduled rows

This is the target that actually matters for fantasy.

| model | O1 | O2 | O3 | mean |
|---|---:|---:|---:|---:|
| **decomposed: P(play) × E[PTS given played]** | 4.1913 | 4.1183 | **4.1998** | **4.1698** |
| decomposed: P(play) × E[MIN given played] × prior PTS/min | 4.2218 | **4.1032** | 4.1986 | 4.1745 |
| direct LightGBM on all scheduled rows | **4.1891** | 4.1535 | 4.2426 | 4.1950 |
| naive: unconditional season mean (0 for misses) | 4.5686 | 4.5457 | 4.7877 | 4.6340 |
| naive: conditional season mean (selection-biased) | 5.1160 | 5.2348 | 5.5276 | 5.2928 |

> **The selection-bias penalty is real and large.** Applying a
> conditional-on-playing season mean to every scheduled row scores 5.2928 MAE.
> Simply switching to an unconditional mean — same data, no model, just
> counting misses as zeros — scores 4.6340, a **12.4% improvement for free**.
> That gap is the cost of the mistake this spike was built to test for.

The decomposed estimator reaches 4.1698, **10.0% better than the honest naive
baseline** and **21.2% better than the selection-biased one**. It also edges
out a direct LightGBM trained on all scheduled rows (4.1950) by 0.6% — small,
but the decomposition additionally yields a calibrated P(play), which is
independently useful for start/sit decisions and cannot be recovered from the
direct model.

### 3f. Segment breakdown — MAE by minutes tier (mean over 3 origins)

**Minutes | played**

| model | star (>=30) | starter (20-30) | bench (10-20) | fringe (<10) | unknown |
|---|---:|---:|---:|---:|---:|
| LightGBM | 3.9148 | 4.7536 | **5.5347** | 4.8412 | **5.7094** |
| ridge | 3.9614 | 4.7735 | 5.5550 | 4.8212 | 7.8507 |
| baseline: EWMA | **3.8744** | 4.8830 | 5.6763 | **4.6745** | 14.8482 |
| baseline: expanding mean | 4.0729 | 5.2092 | 5.9432 | 4.9226 | 14.8482 |

**PTS | played**

| model | star (>=30) | starter (20-30) | bench (10-20) | fringe (<10) | unknown |
|---|---:|---:|---:|---:|---:|
| LightGBM | 5.9158 | 4.7475 | 3.8094 | 2.6784 | **3.6948** |
| ridge | **5.7981** | **4.7339** | **3.8092** | 2.5902 | 5.1441 |
| baseline: EWMA | 5.9100 | 4.7784 | 3.8172 | **2.5285** | 8.7633 |
| baseline: expanding mean | 5.8491 | 4.8230 | 3.8792 | 2.6142 | 8.7633 |

**AST | played**

| model | star (>=30) | starter (20-30) | bench (10-20) | fringe (<10) | unknown |
|---|---:|---:|---:|---:|---:|
| LightGBM | 1.8062 | 1.3809 | 1.0827 | 0.7452 | **0.7724** |
| ridge | **1.7440** | **1.3674** | **1.0810** | 0.7206 | 1.2295 |
| baseline: EWMA | 1.7626 | 1.3898 | 1.0920 | **0.7027** | 2.1381 |
| baseline: expanding mean | 1.7584 | 1.3958 | 1.1014 | 0.7115 | 2.1381 |

**Unconditional PTS**

| model | star (>=30) | starter (20-30) | bench (10-20) | fringe (<10) | unknown |
|---|---:|---:|---:|---:|---:|
| decomposed: P × E[PTS] | **7.0549** | **4.9367** | 3.3179 | 1.4728 | **0.7956** |
| decomposed: P × E[MIN] × PTS/min | 7.1275 | 4.9774 | **3.2861** | 1.4023 | 0.9106 |
| direct LightGBM | 7.1596 | 4.9664 | 3.3091 | 1.4542 | 0.8930 |
| naive: unconditional mean | 7.8617 | 5.6755 | 3.6280 | **1.4165** | 1.3922 |
| naive: conditional mean | 8.1916 | 6.1448 | 4.3656 | 2.2201 | 10.3597 |

Validation support: star 4,152 / starter 5,531 / bench 5,413 / fringe 4,085 /
unknown 174 rows (summed over origins).

**Three things stand out:**

1. **Models only win where baselines have no history.** In the `unknown` column
   the gap is enormous (EWMA 14.85 vs LightGBM 5.71 on minutes) because the
   baselines fall back to a global constant while the models use rest, opponent
   and team context. Everywhere else the margin is ~1%.
2. **On established players the baselines are competitive or better.** EWMA is
   the best minutes model for stars (3.87 vs 3.91) and the best PTS and AST
   model for fringe players. Gradient boosting buys nothing on the segments
   where most fantasy value sits.
3. **The unconditional gain is concentrated in high-minute players.** For stars,
   decomposition improves MAE from 7.86 to 7.05 (10.3%); for fringe players the
   naive unconditional mean is already essentially optimal (1.4165 vs 1.4728 —
   the naive *wins*). Predicting near-zero for a player who plays 37% of the
   time is hard to beat.

---

## 4. Leakage test results

`python -m pytest leakage_tests.py -v` gives **12 passed** in 1.65s.

| test | asserts |
|---|---|
| `test_first_ever_row_has_null_career_features` | All 13 career features null on all 694 first-ever player rows. |
| `test_first_row_of_each_season_has_null_season_to_date_features` | All 6 season-scoped features null on all 1,141 first-of-season rows. |
| `test_career_windows_do_carry_across_seasons` | Complement: returning players *do* carry prior-season form (design choice pinned so it cannot regress silently). |
| `test_rolling_features_match_manual_recomputation` | 40 sampled rows × {MIN, PTS} × {3,5,10} = 240 values recomputed by hand from raw logs; exact match to 1e-9. |
| `test_season_to_date_means_match_manual_recomputation` | 30 sampled rows × 2 stats, season-scoped, exact to 1e-9. |
| `test_rolling_would_differ_if_target_game_included` | **Negative control:** >90% of rows differ from the leaky variant. |
| `test_opponent_def_form_excludes_target_game` | 60 sampled rows exact vs. manual; plus negative control vs. the inclusive version. |
| `test_avail_rate_excludes_own_outcome` | Every row of one player's full sequence recomputed from the raw PLAYED vector. |
| `test_last_appearance_strictly_precedes_target` | 0 rows matched an appearance on/after the target date. |
| `test_days_since_last_app_positive` | All >= 1. |
| `test_no_target_columns_in_feature_list` | No target/outcome column in `FEATURE_COLS`. |
| `test_universe_covers_every_real_appearance` | All 52,707 logs present. |

**Two real bugs were found and fixed by these tests:**

1. The first version of the pipeline used a *single* as-of join keyed on
   `PLAYER_ID + SEASON` while rolling windows were computed grouped by
   `PLAYER_ID` alone. Not leakage, but incoherent: a returning player's first
   game of 2024-25 got `NaN` form despite a full prior season, yet his *second*
   game silently pulled 2023-24 games into the window. Split into two as-of
   joins with matching scopes. This cut career-feature null rate from 4.30% to
   2.85% and shrank the no-history tier from 3,415 to 2,263 rows.
2. The tests themselves initially used `groupby(...).first()`, which returns
   the first **non-null** value per column and therefore *cannot detect* the
   leak it was written to catch. Replaced with `drop_duplicates(keep="first")`.
   Worth flagging for the real implementation — this is a silent-failure trap.

Missingness: `insufficient_history = 1` on **5,678 rows (7.15%)**. Null rates:
`roll5_MIN` 2.85%, `std_MIN` 4.30%, `avail_rate_10` 0.87%, `OPP_DEF_FORM`
3.45%, `TEAM_REST_DAYS` 1.14%.

---

## 5. Does the ±15-day roster approximation distort availability modelling?

**Yes — materially, and in a direction that matters.**

### Interior gaps

For 1,311 player-team-season spells, count the team-games where a player is
eligible *before* and *after* but not *during*. He was certainly rostered
throughout; the window dropped him.

| measure | value |
|---|---:|
| spells with >=1 interior gap | 220 (16.78%) |
| interior-gap team-games dropped | 2,363 |
| universe rows built | 79,406 |
| **rows missing (lower bound)** | **2.98%** |
| observed availability base rate | 0.6638 |
| base rate with interior gaps restored | **0.6446** |
| **upward bias in availability** | **+0.0192** |

This is a *lower bound*. It cannot see players whose injury spans the start or
end of their spell, or who were waived and never returned.

### Truncated absence lengths

The longest absence streak the universe can represent is **16 consecutive
team-games**. Observed distribution: 3,504 one-game absences, 1,339 two-game,
falling to 20 streaks of 16 games — then a hard wall.

Real NBA season-ending injuries are 40-60+ games. **They are structurally
invisible to this universe.** The largest single interior gap found was 59
team-games, meaning that player was reconstructed as eligible for only 23 of
82 team-games.

### Calibration consequence (LightGBM availability, O3, validation 2025-02)

| predicted bin | n | mean predicted | actual rate | gap |
|---|---:|---:|---:|---:|
| 0.0-0.1 | 170 | 0.0543 | 0.0235 | -0.0308 |
| 0.1-0.2 | 318 | 0.1645 | 0.1352 | -0.0293 |
| 0.2-0.3 | 497 | 0.2491 | 0.1992 | -0.0499 |
| 0.3-0.4 | 438 | 0.3509 | 0.2740 | -0.0769 |
| 0.4-0.5 | 472 | 0.4489 | 0.3686 | -0.0802 |
| 0.5-0.6 | 393 | 0.5485 | 0.4682 | -0.0803 |
| 0.6-0.7 | 306 | 0.6488 | 0.5131 | **-0.1357** |
| 0.7-0.8 | 411 | 0.7518 | 0.7275 | -0.0243 |
| 0.8-0.9 | 922 | 0.8612 | 0.8265 | -0.0347 |
| 0.9-1.0 | 2,026 | 0.9407 | 0.9363 | -0.0044 |

**The gap is negative in every single bin — the model over-predicts
availability everywhere.** It is well calibrated where it is confident
(0.9-1.0: -0.004) and badly calibrated in the uncertain middle (0.6-0.7:
-0.136). That is exactly the signature of training on a universe where
long-term absences have been erased: the model has never seen the players who
disappear for a month.

For fantasy this bias compounds — an over-predicted P(play) multiplies directly
into over-predicted expected production, and it is worst precisely for the
rotation-uncertain players whose start/sit calls are the hard ones.

### Feature importance (LightGBM availability, gain)

| feature | gain |
|---|---:|
| `games_since_last_app` | 127,663 |
| `roll3_MIN` | 31,059 |
| `days_since_last_app` | 28,417 |
| `avail_rate_10` | 23,559 |
| `TEAM_REST_DAYS` | 10,415 |
| `roll5_MIN` | 10,026 |
| `OPP_DEF_FORM` | 7,168 |
| `avail_rate_std` | 6,491 |

`games_since_last_app` dominates by 4×. This is a warning, not a triumph: that
feature is *defined by* the roster reconstruction and is mechanically capped
near 16. A model leaning this hard on an artifact of the approximation will not
transfer unchanged to a universe built from real inactive lists.

---

## 6. Conclusions

### What works

- **The decomposition is validated.** Unconditional PTS MAE goes 5.2928
  (selection-biased naive) to 4.6340 (unconditional naive) to 4.1698
  (decomposed). The selection-bias penalty is a 12.4% error inflation that
  costs nothing to remove, and the decomposition adds another 10.0% on top.
- **Availability is the genuinely learnable target.** 22.8% Brier improvement
  over a shifted appearance rate, stable across all three origins. This is
  where the modelling effort belongs.
- **As-of correctness is achievable and testable.** The two-mechanism discipline
  (as-of join + explicit shift) held up under hand-recomputation, and the
  negative controls confirm the tests have teeth.

### What doesn't

- **Production ML conditional on playing is not worth it yet.** Best model beats
  EWMA(halflife 5) by 1.4% on minutes, 1.0% on points, 1.2% on assists. On
  stars and fringe players the EWMA baseline sometimes *wins*. LightGBM is worse
  than both baselines on assists.
- **LightGBM is not the right tool for the conditional targets.** Ridge beats it
  on both PTS and AST. With ~35k training rows and features that are mostly
  smoothed versions of the target, there is little non-linear structure to find.
- **The gains are not where the value is.** Models beat baselines mainly on
  players with no history (2,263 rows, 2.8% of the universe). For established
  high-minute players — the ones that decide fantasy weeks — a well-tuned EWMA
  is close to state of the art.

### Implications for the full system's schema

1. **Official inactive lists are a hard requirement, not a nice-to-have.** This
   is the single highest-priority finding. The ±15-day approximation inflates
   availability by at least 1.9pp, caps representable absences at 16 games, and
   yields a model that over-predicts availability in *every* probability bin.
   Schema needs a per-team-game roster/inactive table with a reason code
   (injury / rest / G-League / personal / DNP-CD), sourced as-of the game.
2. **Store the schedule as a first-class entity, separate from game logs.** The
   universe must be constructible from the schedule alone, before any box score
   exists — otherwise same-day predictions are impossible. Team logs already
   give this cleanly (4,920 rows, complete).
3. **Feature scope must be explicit in the schema.** The career-vs-season bug
   was invisible until tested. Any stored feature needs its window scope
   (career / season) and its as-of timestamp recorded alongside the value.
4. **Persist out-of-fold availability probabilities.** The decomposed estimator
   needs P(play) at prediction time and the pipeline must never let an in-fold
   probability leak into a downstream production model.
5. **Do not build a production-ML service yet.** Ship EWMA(halflife 5) as the
   conditional production estimate and put the engineering into availability
   plus roster data quality. Revisit conditional production once inactive lists
   are in and injury-reason features exist — the 1% margins here are plausibly
   limited by missing injury context, not by model capacity.
6. **`games_since_last_app` needs re-validation after the roster fix.** It
   carries 4× the gain of any other feature and is partly an artifact of the
   window. Expect the availability numbers in section 3a to move once the
   universe is built properly — most likely getting *harder*, since the easy
   long-absence cases are currently invisible.

### Honest caveats

- Two seasons, three origins, one month of validation each. Differences under
  ~2% are not distinguishable from noise at this sample size; no confidence
  intervals were computed.
- Models are near-default hyperparameters. A tuned LightGBM might close some of
  the gap on the conditional targets — but the fact that ridge beats it suggests
  a ceiling, not a tuning gap.
- `PLAYED` is defined as "a game log exists", which conflates a coach's-decision
  DNP with injury and with not being on the roster. Reason codes would let these
  be modelled separately, and they almost certainly behave differently.
- The 2024-25 validation months show a declining availability trend (0.6747,
  0.6618, 0.6281). All models degrade across origins in step with it, so some
  of the origin-to-origin variation is drift, not model instability.
