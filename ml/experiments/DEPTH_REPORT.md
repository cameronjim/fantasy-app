# Deep-history training-depth and weighting ablation

**Question asked (verbatim):** *"we could create the model with all different # of
seasons, with different weightings — this would improve the model right?"*

This is the measured curve, not an opinion. Everything below comes from
`ml/experiments/pull_deep_history.py` (30 seasons of stats.nba.com box scores),
`ml/experiments/deep_dataset.py` (appearance-only feature frames) and
`ml/experiments/depth_sweep.py` (the sweep). Nothing in `ml/` outside
`ml/experiments/` was modified, no database write was issued, and no git write
command was run.

`pytest ml/tests ml/experiments -q` → **355 passed** (315 pre-existing, untouched;
40 new, covering window construction, sample-weight arithmetic and the
identical-validation-rows assertion, each with a negative control). Note that
`ml/fnba_ml/` was being actively rewritten by a concurrent branch of work while this
ran — see §2.2 — so a suite run mid-edit at 14:11 showed 3 failures in
`ml/tests/test_teammates.py` and `ml/tests/test_evaluate.py` that were *their*
in-flight v2→v3 migration (`assert FEATURE_VERSION == "v2"` against a config already
reading `v3`) and were resolved by their own edit at 14:13. Nothing in this
experiment touches those files.

---

## 0. The caveat that governs every number here — read this first

**The scheduled-universe / availability target cannot be built before 2022-23, so
this ablation says nothing about `P(plays)`, nothing about unconditional fantasy
points, and nothing about the composition.**

`P(plays)` needs one row per (rostered player × team-game) *including the games the
player missed*. Building that requires official per-game inactive lists, which this
repo's sources do not reach before 2022-23. The phase-0 spike already measured what
happens if roster membership is approximated from game-log presence instead (the
±15-day window in `fnba_ml.universe.approximate_universe`): the availability base
rate is inflated by at least +0.0192, absence streaks longer than ~16 team-games
become structurally invisible, and the resulting model over-predicts availability
in *every* probability bin. Running that approximation across 26 extra seasons
would have produced a depth curve for a biased target — a measurement of the
approximation, not of depth.

So this is a **conditional** ablation: `minutes | played`, `PTS | played`,
`AST | played`. The four-season truth layer remains the only place `P(plays)`,
`E[stat]` and the composition can honestly be measured.

Two smaller caveats that belong next to it:

- **Minutes are integers here.** `LeagueGameLog` returns `MIN` as an integer for
  every season; `PlayerGameLogs` (the source behind `ml/data/dataset.parquet`)
  returns a float. Minutes MAE in this report is therefore **not comparable** to
  MODEL.md §5's 4.537. It is internally consistent — every configuration reads the
  same integer minutes — which is the only property a depth ablation needs.
- **The eight status-dependent teammate features are absent.** They cannot exist on
  an appearance-only universe (the absence set is empty by construction), so this
  ablation runs on a v1-plus-usage feature set, not v2. Depth conclusions here do
  not transfer automatically to the v2 feature set; §7 says what would.

---

## 1. Data pulled

One `LeagueGameLog` call per side per season, 60 calls, 3–5 s jittered pacing, the
`_fetch_with_retry` / `_is_retryable` idiom copied from `scraper/run_scraper.py`.
Zero failures, zero retries needed. Idempotent: a season already on disk costs no
call.

**Two deviations from the brief, both deliberate.**

1. **All 30 seasons were pulled, not just 1996-97 → 2021-22.** The brief expected
   `ml/data/dataset.parquet` to cover 2022-26, and it does — but as a *features*
   frame with float minutes from `PlayerGameLogs`, not as raw logs. Splicing it onto
   26 seasons of `LeagueGameLog` output would have put a source seam, a minutes-dtype
   seam and a feature-continuity break in the middle of the season axis this
   experiment measures. Eight extra calls buy one continuous single-source series and
   the cross-check in §1.2. Cost: minutes are integers everywhere (§0).
2. **`playergamelogs` was checked and rejected rather than used per-era.**
   `LeagueGameLog` returns an identical 32-column schema for 1996-97 and 2025-26,
   including the player and team `MIN`/`FGA`/`FTA`/`TOV` the usage denominator needs,
   so no per-era endpoint switch was necessary. Verified by inspecting the 1996-97
   response before writing the loop, not assumed.

| Era | Seasons | Player-game rows | Team-game rows | Games |
|---|---:|---:|---:|---:|
| 1996-97 → 1999-00 | 4 | 86,979 | 8,584 | 4,292 |
| 2000-01 → 2009-10 | 10 | 245,004 | 24,272 | 12,136 |
| 2010-11 → 2019-20 | 10 | 250,085 | 23,778 | 11,888 |
| 2020-21 → 2025-26 | 6 | 154,346 | 14,460 | 7,230 |
| **total** | **30** | **736,414** | **71,094** | **35,546** |

Per-season detail is in the gitignored `ml/data/deep/manifest.csv`. Integrity
checks, all clean across all 30 seasons: **0** duplicate (player, game) rows, **0**
null `MIN`, **0** games without exactly two team-log rows. Team minutes average
241.3–242.2 per game in every season (240 in regulation; the excess is overtime),
which is the cheapest available proof that the team-side denominator for `usg_ewma`
is sane in 1996 as well as 2026.

### 1.1 Data-quality surprises in old seasons

Flagged, not special-cased. None of these were given corrective treatment; the
sweep sees them exactly as they are.

| Season | Games | What happened |
|---|---:|---|
| 1996-97 … 2003-04 | 1,189 | **29 teams**, not 30 — the Charlotte Bobcats arrive in 2004-05. 1,189 = 29 × 82 / 2. Not a defect; a window reaching this far back is training on a structurally smaller league |
| 1998-99 | 725 | **lockout.** 50 games per team. A single season contributing 60% of a normal season's rows |
| 2011-12 | 990 | **lockout.** 66 games per team, and a compressed calendar — back-to-backs and 3-in-4s at rates no other season has, which distorts `TEAM_REST_DAYS`/`IS_B2B` |
| 2012-13 | 1,229 | one game short of 1,230: Boston–Indiana, cancelled after the Boston Marathon bombing and never replayed |
| 2019-20 | 1,059 | **COVID.** Season suspended in March, resumed in a Florida bubble; the last game is 2020-08-14. Every `TEAM_REST_DAYS` spanning the suspension is a ~140-day gap, and every `days_since_last_app` with it |
| 2020-21 | 1,080 | **COVID.** 72 games per team, opening 2020-12-22, heavy protocol absences |

The 2019-20 suspension is the one worth naming twice: it manufactures rest-day and
days-since-appearance values four months long. A window of depth 8 or more from
either 2024-25 or 2025-26 contains it, so it is present in most of the depth curve
and constant across those configurations — it cannot explain a *difference* between
depths ≥ 8, but it is a reason not to read tiny differences among them as signal.

### 1.2 Cross-check against the production truth layer, and a real gap it found

The four seasons this pull overlaps with `ml/data/dataset.parquet` are an accuracy
check on both sides. The deep pull has **105,253** appearance rows for 2022-23 →
2025-26; the truth layer has **105,141** rows with `PLAYED = 1`. Overlap is
105,141 — every truth-layer appearance is in the pull, and **112 appearances in the
pull are missing from the truth layer.**

They are not scattered. They are 11 team-games missing *one side's* box score
entirely, while the game itself is present in the universe:

| GAME_ID | Date | Team | Missing rows |
|---|---|---|---:|
| 0022200140 | 2022-11-06 | LAL | 1 |
| 0022400147 | 2024-11-02 | WAS | 13 |
| 0022400621 | 2025-01-23 | SAS | 14 |
| 0022400633 | 2025-01-25 | SAS | 15 |
| 0022401229 | 2024-12-14 | ATL | 9 |
| 0022401230 | 2024-12-14 | OKC | 10 |
| 0022500147 | 2025-11-01 | DAL | 10 |
| 0022500578 | 2026-01-15 | ORL | 10 |
| 0022500602 | 2026-01-18 | ORL | 12 |
| 0022501229 | 2025-12-13 | NYK | 9 |
| 0022501230 | 2025-12-13 | SAS | 9 |

The `…1229` / `…1230` ids recurring in both seasons are the NBA Cup semifinal and
final, which points at a season-type or game-id filter in the box-score ingest; the
others look like ordinary games, so there is likely a second cause. 0.11% of rows —
too small to move any number in MODEL.md, large enough that those players' rolling
windows silently skip a real game. Filed as a separate task; it is a finding about
the production scraper, not about this ablation.

---

## 2. Method

### 2.1 The dataset

Appearance-only (**conditional**) universe: one row per recorded box-score line,
`PLAYED = 1` on all 736,414 of them. It is fed through the *real*
`fnba_ml.universe.universe_from_status` by synthesising a status frame in which
every appearance is rostered-and-played, so the frame reaching
`fnba_ml.features.build_features` has exactly the shape the production pipeline
produces and the feature code runs **unmodified**. No row is invented for a player
who did not appear — inventing those is precisely the approximation §0 rules out.

### 2.2 The feature list — identical in every configuration

30 features. Stating it in full because "deeper is worse" and "older rows have
missing columns" are indistinguishable otherwise:

```
roll3_MIN  roll5_MIN  roll10_MIN      std_MIN   ewma_MIN
roll3_PTS  roll5_PTS  roll10_PTS      std_PTS   ewma_PTS
roll3_AST  roll5_AST  roll10_AST      std_AST   ewma_AST
roll3_FGA  roll5_FGA  roll10_FGA      std_FGA   ewma_FGA
n_appearances   days_since_last_app   usg_ewma
TEAM_REST_DAYS  IS_B2B  IS_HOME  OPP_DEF_FORM  OPP_REST_DAYS
insufficient_history  has_history
```

Dropped from `config.FEATURE_COLS`, for every configuration alike:

- **the 8 status-dependent teammate features** (`vacated_minutes`, `vacated_fga`,
  `vacated_usg`, `vacated_minutes_pos`, `depth_rank_available`,
  `depth_rank_available_pos`, `star_out`, `top3_usage_out_count`). The absence set
  is empty on an appearance-only universe, so `vacated_*` would be a column of
  zeros and `depth_rank_available` would silently become a rank among *everyone who
  appeared* — a different quantity from the one MODEL.md §4.1 measures.
- **`usg_ewma` is the exception and is kept.** It is a career-scoped EWMA of the
  player's own box-score usage share, needs no inactive list, and is computable
  identically in 1996-97 and 2025-26. Null rate 0.84%, std 6.05 — a live feature,
  not a passenger.
- **the degenerate availability columns** `avail_rate_10/20/std`,
  `games_since_last_app`, and the unconditional `uncond_std_{PTS,MIN,AST}`. On an
  appearance-only universe these are not merely approximate, they are constant or
  duplicated: every `avail_rate` is exactly 1.0, every `games_since_last_app`
  exactly 0, and `uncond_std_PTS` numerically identical to `std_PTS`.

Verified rather than assumed: no feature in the list is constant, and the highest
null rate is `OPP_DEF_FORM` at 3.8% (its 10-game window needs 3 periods to fill).

**The list is pinned literally in `deep_dataset.DEEP_FEATURE_COLS`, not derived from
`config.FEATURE_COLS`, and that changed mid-experiment for a reason worth
recording.** It *was* derived by subtraction until `ml/fnba_ml/config.py` was
rewritten underneath the running sweep at 13:51 — a concurrent branch of work moved
`FEATURE_VERSION` from **v2 to v3**, replacing the eight realized-absence teammate
columns with eight expected-absence ones (`exp_vacated_*`, `exp_depth_rank`,
`p_star_out`, …) and adding six reliability/cold-start columns, 45 → 51. A derived
list would have made this ablation's feature set a function of whatever else was
being edited that afternoon, which is precisely what a depth ablation cannot
tolerate.

Two consequences, both checked:

- **The sweep's own numbers are unaffected.** Python binds modules at import, and
  the sweep process imported `config` and `features` at 13:46, before the rewrite.
  Every cell in every table below ran against one consistent 30-feature contract.
- **All 30 pinned features still exist in the v3 config.**
  `deep_dataset.feature_contract_drift()` reports 21 `config_only` columns (what
  production has that an appearance-only universe cannot supply) and **0
  `pinned_only`** columns. So this ablation's feature set is a strict subset of the
  production contract both before and after the v3 change — the conclusions are
  about features that still ship.

`_require_pinned_columns` now re-checks presence and non-emptiness on every cache
hit as well as every fresh build, because a feature parquet written this morning and
one written this afternoon can disagree about what `usg_ewma` means while both
having the column.

### 2.3 The axes, and what is held fixed

| Axis | Values | Held fixed |
|---|---|---|
| **depth** — seasons the estimator is *fit* on | 2, 4, 8, 13, 20, 29 | halflife 5, decay none |
| **halflife** — EWMA memory in the features | 3, 5, 8, 12 | depth 4 (production depth), decay none |
| **decay** — `decay ** season_age` sample weight | 1.0 (none), 0.8, 0.6 | best depth (**29**, measured), halflife 5 |
| **era flag** — `+SEASON_INDEX` | on / off | best depth (29), halflife 5, decay none |

Depth windows are **trailing and relative to each origin's own season**: depth 4 at
an origin validating in Dec-2024 means 2021-22 … 2024-25, and at an origin
validating in Jan-2026 means 2022-23 … 2025-26. That is what "training depth"
means operationally — how far back you reach from the moment you fit — and it keeps
the shallow configurations from degenerating into "one month of data" at the older
origins.

The full grid (6 × 4 × 3 × 3 targets) was **not** run. Axes are swept one at a time
around a fixed point, which is ordinary coordinate descent and costs ~1/10th of the
cross-product. The cost of that choice is real and stated: a depth × decay
interaction would be invisible, which is exactly why the decay sweep is run **at
the best depth** rather than at depth 4 — that is the one interaction most likely to
exist (recency weighting should matter more when there is more old data to
downweight).

### 2.4 Evaluation — identical validation rows, asserted

The same five rolling origins as `fnba_ml.config.ORIGINS` (Dec-2024, Jan-2025,
Feb-2025, Dec-2025, Jan-2026), forward-chaining, train strictly before each
validation window. **Only the training data varies.** Features are built once over
the full 30 seasons for the depth, decay and era phases, so a validation row's
`ewma_PTS` and `n_appearances` are the *same number* in every one of those
configurations.

`ValidationRowRegistry.enforce` fingerprints the `(PLAYER_ID, GAME_ID)` set of
every validation slice and raises if any configuration scores a different set. It
runs on every cell, not once — the failure it guards against is a configuration
that quietly scores fewer or easier rows and posts a better MAE for it, which is
invisible in the output table. A second guard asserts no training row reaches the
validation window.

Estimators, and which axis each one can even respond to — this matters more than it
looks:

| Target | Estimator | Can depth move it? |
|---|---|---|
| `MIN \| played` | **LightGBM** (champion) | yes |
| | ridge | yes |
| | EWMA (`ewma_MIN`) | **only via the fallback constant** |
| `PTS/AST \| played` | EWMA total (`EwmaProduction`) | **only via the fallback constant** |
| | EWMA propagated: `E[min\|played] × EWMA(stat per min)` — the current champion path | only through the minutes model |
| | ridge (challenger) | yes |

The EWMA rows are in the table on purpose. **They read a precomputed column off the
row and have no training set**, so for the ~99% of validation rows belonging to
players with history, training depth cannot move them at all. That fact is half the
answer to the question and it is structural, not empirical.

### 2.5 Run summary

| | |
|---|---|
| Seasons available | 30 (1996-97 … 2025-26) |
| Appearance rows | 736,414 |
| Features | 30, identical in all 80 cells |
| Origins | 5 (`config.ORIGINS`) |
| Cells run | 80 (720 metric rows) |
| Validation-row identity checks passed | **80 / 80** |
| Distinct `n_valid` per origin across all 80 cells | **1** (4054 / 4893 / 3739 / 4265 / 4990) |
| Wall clock | 1,144 s (19 min) |

The "distinct `n_valid` per origin = 1" row is the empirical version of the design
claim: across every depth, halflife, decay, era-flag and truncation configuration,
each origin scored exactly one row count. Nothing was quietly skipped.

---

## 3. The depth curve

Mean MAE over the 5 origins, and % change against the shallowest window.
**Lower is better throughout this report; negative Δ is an improvement.**

### 3.1 `minutes | played`

| Depth (seasons) | Train rows | LightGBM (champion) | Δ vs d2 | ridge | EWMA baseline |
|---:|---:|---:|---:|---:|---:|
| 2 | 36,275 | 4.7350 | — | 4.7487 | 4.8244 |
| 4 *(production depth)* | 88,354 | 4.7237 | −0.24% | 4.7543 | 4.8247 |
| 8 | 185,982 | 4.7101 | −0.53% | 4.7610 | 4.8247 |
| 13 | 315,695 | 4.7054 | −0.62% | 4.7580 | 4.8248 |
| 20 | 486,273 | 4.7063 | −0.61% | 4.7554 | 4.8251 |
| **29** | **694,389** | **4.7049** | **−0.64%** | 4.7546 | 4.8253 |

```
depth   MIN|played MAE, LightGBM     (the bar floor sits just below the minimum,
                                      not at zero: the whole range is 0.6% wide)
    2   4.7350  ##########################################
    4   4.7237  ############################
    8   4.7101  ############
   13   4.7054  ######
   20   4.7063  #######
   29   4.7049  #####  <- best
```

**The curve flattens after 8–13 seasons.** 2→4 buys 0.24%, 4→8 another 0.29%, 8→13
another 0.10%, and **13→29 buys 0.01%** — sixteen extra seasons and 379,000 extra
training rows for one part in ten thousand.

### 3.2 `PTS | played` and `AST | played`

| Depth | PTS `ewma_propagated` (champion path) | Δ | PTS `ewma_total` | PTS ridge | Δ |
|---:|---:|---:|---:|---:|---:|
| 2 | 4.5240 | — | 4.5470 | **4.5008** | — |
| 4 | 4.5224 | −0.04% | 4.5471 | 4.5056 | +0.11% |
| 8 | 4.5188 | −0.12% | 4.5470 | 4.5171 | +0.36% |
| 13 | 4.5178 | −0.14% | 4.5466 | 4.5243 | +0.52% |
| 20 | 4.5174 | −0.15% | 4.5465 | 4.5331 | +0.72% |
| 29 | **4.5166** | −0.16% | 4.5463 | 4.5409 | **+0.89%** |

| Depth | AST `ewma_propagated` | Δ | AST `ewma_total` | AST ridge | Δ |
|---:|---:|---:|---:|---:|---:|
| 2 | 1.3180 | — | 1.3265 | **1.3150** | — |
| 4 | 1.3185 | +0.03% | 1.3264 | 1.3163 | +0.10% |
| 8 | 1.3175 | −0.04% | 1.3263 | 1.3185 | +0.27% |
| 13 | 1.3172 | −0.07% | 1.3262 | 1.3208 | +0.44% |
| 20 | 1.3173 | −0.05% | 1.3262 | 1.3242 | +0.70% |
| 29 | **1.3169** | −0.09% | 1.3262 | 1.3275 | **+0.95%** |

Three findings, in descending order of how much they matter:

1. **The EWMA champions are depth-invariant, by construction and in measurement.**
   `ewma_total` moves 0.02% across a 27-season range, and minutes' EWMA baseline
   moves 0.02%. They read a precomputed column off the row; depth reaches them only
   through the fallback constant used for the ~1% of rows with no history. **For the
   currently-promoted production estimate, adding seasons of training data cannot
   help, because that estimate has no training data.**
2. **Depth helps the tree and hurts the linear model, monotonically, in opposite
   directions.** LightGBM minutes −0.64% over the range; ridge PTS **+0.89%**; ridge
   AST **+0.95%**. Both ridge degradations are monotone in depth and consistent in
   **5/5 origins** (per-origin 4→29: PTS +0.72…+0.83%, AST +0.76…+0.99%). The
   mechanism is not mysterious: ridge has one global coefficient vector, so a
   2003-04 row from a league scoring 93.4 points per team-game literally pulls the
   intercept and slopes away from a 2026 row's 115.6 (§1.1). 400 boosted trees can
   partition the space and route stale regions away from recent rows.
3. **The champion path for production barely moves either way** (−0.16% PTS, −0.09%
   AST), because depth reaches it only through the minutes multiplier.

### 3.3 Per-origin consistency

`minutes | played`, LightGBM, MAE per origin:

| Depth | O1 2024-12 | O2 2025-01 | O3 2025-02 | O4 2025-12 | O5 2026-01 |
|---:|---:|---:|---:|---:|---:|
| 2 | 4.7313 | 4.6182 | 4.8548 | 4.8076 | 4.6628 |
| 4 | 4.7282 | 4.6123 | 4.8934 | 4.7614 | 4.6231 |
| 8 | 4.7047 | 4.5954 | 4.8743 | 4.7636 | 4.6124 |
| 13 | 4.7010 | 4.5941 | 4.8689 | 4.7580 | 4.6049 |
| 20 | 4.7037 | 4.5920 | 4.8652 | 4.7557 | 4.6148 |
| 29 | 4.7000 | 4.5964 | 4.8670 | 4.7502 | 4.6108 |

- **4 → 29 seasons is negative in 5/5 origins** (−0.60 / −0.34 / −0.54 / −0.24 /
  −0.27%). Direction consistent, magnitude never past 0.6%.
- **2 → 29 is negative in only 4/5.** O3 (validate Feb-2025) gets *worse* by
  +0.25%, and it is the only origin where the shallowest window is competitive. O3
  is also the hardest origin in absolute terms (4.85–4.89 vs 4.59–4.81 elsewhere).
  One origin in five disagreeing about a 0.6% effect is what a 0.6% effect looks
  like at this sample size.
- No origin has fewer than 3,739 or more than 4,990 validation rows, so no single
  origin dominates the mean.

---

## 4. The halflife axis — the largest effect in the experiment

Depth 4 (production depth), decay none. % change against **halflife 5, the shipped
value**.

### 4.1 `minutes | played` wants a *shorter* memory

| Halflife | LightGBM | Δ vs hl5 | ridge | Δ | EWMA baseline | Δ |
|---:|---:|---:|---:|---:|---:|---:|
| **3** | **4.7100** | **−0.29%** | **4.7328** | **−0.45%** | **4.7706** | **−1.12%** |
| 5 *(shipped)* | 4.7237 | — | 4.7543 | — | 4.8247 | — |
| 8 | 4.7147 | −0.19% | 4.7590 | +0.10% | 4.9211 | +2.00% |
| 12 | 4.7129 | −0.23% | 4.7598 | +0.12% | 5.0410 | +4.48% |

The EWMA baseline is the clean read on the feature itself, and it is emphatic:
**halflife 12 is 4.5% worse than halflife 5, and halflife 3 is 1.1% better**, the
latter consistent in **5/5 origins** (−0.65 / −1.63 / −1.03 / −1.21 / −1.09%).
Minutes are volatile and role-driven, and a long memory is actively harmful.
LightGBM absorbs most of that — it has twelve rolling windows to choose from — but
still prefers hl3.

### 4.2 `PTS | played` and `AST | played` want a *longer* memory

| Halflife | PTS `ewma_propagated` | Δ vs hl5 | AST `ewma_propagated` | Δ | PTS `ewma_total` | AST `ewma_total` |
|---:|---:|---:|---:|---:|---:|---:|
| 3 | 4.5803 | +1.28% | 1.3377 | +1.46% | 4.5948 | 1.3413 |
| 5 *(shipped)* | 4.5224 | — | 1.3185 | — | 4.5471 | 1.3264 |
| 8 | 4.4895 | −0.73% | 1.3095 | −0.68% | **4.5431** | **1.3228** |
| **12** | **4.4781** | **−0.98%** | **1.3059** | **−0.95%** | 4.5624 | 1.3259 |

**This is the actionable result of the whole ablation.** Moving the halflife from 5
to 12 improves the *currently promoted conditional production estimate* by **0.98%
on points and 0.95% on assists, negative in 5/5 origins each** (PTS −0.80 / −1.18 /
−1.26 / −0.60 / −1.06%; AST −1.08 / −1.18 / −0.98 / −0.48 / −1.05%). That is **six
times the entire 27-season depth effect on the same estimate** (−0.16%), for no
extra data, no extra training time, and a one-line config change.

Note the split between the two EWMA forms, which is the mechanism: `ewma_total`
(whole-game totals) is U-shaped with a minimum at hl8, while `ewma_propagated`
(per-minute rate × predicted minutes) keeps improving to hl12. Whole-game totals
*contain* minutes volatility, so they inherit minutes' preference for a short
window; a per-minute efficiency rate does not, and wants all the history it can get.
That is exactly the claim `features.py` already makes in prose — "per-minute
efficiency is far more stable across an offseason than minutes are, which is
precisely why the composition splits them" — now measured.

**One halflife is doing two incompatible jobs.** `config.EWMA_HALFLIFE = 5` sets the
memory for `ewma_MIN` (which wants ~3) and for `ewma_PTS_per_min` /
`ewma_AST_per_min` (which want ~12) with a single number. 5 is a compromise nobody
chose; it is roughly the midpoint of two opposite optima.

---

## 5. Season-recency sample weighting — essentially nothing

`weight = decay ** season_age`, at depth 29 (the depth-sweep winner, deliberately —
if recency weighting matters anywhere it is where there is most old data to
discount). % change vs `decay = 1.0`.

| Decay | MIN LightGBM | MIN ridge | PTS `ewma_prop.` | PTS ridge | AST ridge |
|---:|---:|---:|---:|---:|---:|
| 1.0 (none) | 4.7049 | 4.7546 | 4.5166 | 4.5409 | 1.3275 |
| 0.8 | **4.7022** (−0.06%) | 4.7561 (+0.03%) | 4.5175 (+0.02%) | 4.5166 (−0.53%) | 1.3192 (−0.63%) |
| 0.6 | 4.7048 (−0.00%) | 4.7533 (−0.03%) | 4.5174 (+0.02%) | **4.5085** (−0.71%) | **1.3171** (−0.79%) |

- **For the LightGBM champion: nothing.** 0.06% at best, and non-monotone (0.8 beats
  both 0.6 and 1.0), which is the signature of noise rather than signal.
- **For ridge: a real but redundant win.** −0.71% on PTS, −0.79% on AST. But compare
  §3.2: ridge at **depth 2 with no weighting at all** scores 4.5008 (PTS) and 1.3150
  (AST), beating ridge at depth 29 with the harshest decay (4.5085 / 1.3171).
  Recency weighting is a partial antidote to a problem you avoid completely by not
  training on 29 seasons in the first place.
- **For the EWMA champions: exactly nothing**, and it must be — they have no
  training set for a sample weight to apply to.

So the "different weightings" half of the question splits cleanly: **the EWMA
halflife (a feature definition) is worth ~1%; season-recency sample weighting (a
training weight) is worth ~0.06% where it matters, and where it helps it is dominated
by simply using less data.**

---

## 6. The era-flag probe

At depth 29, one extra feature (`SEASON_INDEX`: 0 = 1996-97, monotone integer),
everything else identical. 31 features vs 30.

| Target | Estimator | 30 features | 31 features | Δ |
|---|---|---:|---:|---:|
| MIN | **LightGBM (champion)** | 4.7049 | 4.6980 | **−0.15%** |
| MIN | ridge | 4.7546 | 4.7540 | −0.01% |
| MIN | EWMA | 4.8253 | 4.8253 | 0.00% |
| PTS | `ewma_propagated` | 4.5166 | 4.5145 | −0.05% |
| PTS | ridge | 4.5409 | 4.5228 | **−0.40%** |
| PTS | `ewma_total` | 4.5463 | 4.5463 | 0.00% |
| AST | `ewma_propagated` | 1.3169 | 1.3159 | −0.07% |
| AST | ridge | 1.3275 | 1.3194 | **−0.61%** |
| AST | `ewma_total` | 1.3262 | 1.3262 | 0.00% |

**Every delta is an improvement, every delta is small, and the pattern is
diagnostic.** The two largest wins (ridge PTS −0.40%, ridge AST −0.61%) land on
exactly the estimators §3.2 showed being *damaged* by depth — the era flag lets a
linear model recover part of what deep training cost it, which is the same job the
decay schedule did in §5 and roughly the same size (−0.40% vs −0.71%). The champion
gains 0.15%, inside noise. The EWMA rows are exactly 0.00% because a feature cannot
move an estimator that reads a column and ignores features.

Read plainly: **the era flag is a cheaper, better-behaved substitute for recency
weighting on linear models, and neither is needed by the champion.**

---

## 7. What a shallow shop would actually lose (the truncation probe)

§3's depth axis varies only the *training window* — features are built over all 30
seasons in every configuration, so a validation row's `ewma_PTS` and `n_appearances`
are the same number everywhere. That isolates training volume, which is what "only
training data varies" requires, but it is **not** what a team with two seasons of
data would face: they would also have two seasons of *feature* history. This phase
rebuilds the features over the truncated raw history too.

| Target / estimator | Depth | Full-history features | Truncated features | Δ | vs depth-29 full |
|---|---:|---:|---:|---:|---:|
| MIN LightGBM | 2 | 4.7350 | 4.7545 | +0.41% | **+1.06%** |
| MIN LightGBM | 4 | 4.7237 | 4.7266 | +0.06% | +0.46% |
| MIN ridge | 2 | 4.7487 | 4.7689 | +0.42% | +0.30% |
| PTS ridge | 2 | 4.5008 | 4.5187 | +0.40% | **−0.49%** |
| PTS ridge | 4 | 4.5056 | 4.5123 | +0.15% | −0.63% |
| PTS `ewma_propagated` | 2 | 4.5240 | 4.5287 | +0.10% | +0.27% |
| AST ridge | 2 | 1.3150 | 1.3166 | +0.12% | **−0.83%** |

- Truncating raw history costs an **extra 0.41%** at depth 2 but only **0.06%** at
  depth 4 — so beyond ~4 seasons feature history has converged, and the depth axis
  really is a training-volume axis.
- **The honest end-to-end number: a 2-season shop is 1.06% worse than a 29-season one
  on `minutes | played`, and *better* on `PTS | played` (−0.49%) and `AST | played`
  (−0.83%)** — because their ridge is not being dragged across three scoring eras.
- 4 seasons, which production already has, is **0.46%** off the 29-season best on
  minutes and ahead of it on production.

### 7.1 What does and does not transfer to the shipped model

Stated because these numbers are on a 30-feature appearance-only set, not the
shipped one:

- **Transfers.** The halflife result. `ewma_MIN` and `ewma_<stat>_per_min` are the
  same columns in production, computed by the same code, and the mechanism (minutes
  volatile, per-minute efficiency stable) is a property of basketball rather than of
  this feature set.
- **Transfers.** The structural point that EWMA champions cannot benefit from
  training depth. That is arithmetic.
- **Does not transfer directly.** The size of the depth effect on the minutes
  champion. Production's minutes model has `depth_rank_available` carrying 18.4% of
  its gain (MODEL.md §5.2), a feature absent here. A model whose single strongest
  feature is missing has more room for extra rows to help, so **−0.64% is plausibly
  an upper bound** on what depth would buy the v2/v3 minutes model.
- **Unmeasured, and unmeasurable from this data.** Everything about `P(plays)`,
  unconditional points, and the composition (§0).

---

## 8. The answer

> *"we could create the model with all different # of seasons, with different
> weightings — this would improve the model right?"*

**Partly, and much less than the effort implies — but the sweep found something
better than what was asked for.**

**Seasons: yes, but ~0.6%, and only for one target.** Going from 2 to 29 seasons
improves the LightGBM `minutes | played` champion by 0.64%, monotonically, and the
curve is essentially flat past 13 seasons (13→29 buys 0.01%). From production's
current 4 seasons the remaining headroom is 0.40%, consistent in 5/5 origins. For the
promoted *production* estimates the answer is closer to a flat no: the champion is an
EWMA that **has no training set**, so depth reaches it only through the minutes
multiplier and moves it 0.16%. And for ridge — the standing challenger MODEL.md
§10.2 Q1 is actively deliberating about promoting — depth makes it **0.9% worse**,
monotonically, in 5/5 origins. Every one of these numbers sits inside the project's
own stated ~2% noise line and none would clear the >2%-across-origins promotion bar.
Deep history is not a 60-call route to a better model; it is a 0.4% adjustment on one
of three targets.

**Weightings: the sample-weight kind, no. The halflife kind, yes — and it is the
biggest number in this report.** Exponential season-recency weighting moves the
LightGBM champion 0.06% (non-monotone, i.e. noise) and only helps ridge as a partial
antidote to damage that not using 29 seasons avoids entirely. But the EWMA halflife
is worth **≈1%**, and more importantly the single shipped value of 5 is serving two
targets whose optima point in opposite directions: `minutes` wants ~3 (its EWMA
baseline is 1.1% better at hl3 and 4.5% worse at hl12) while the per-minute
production rates want ~12 (0.98% better on PTS, 0.95% on AST, 5/5 origins each).

**The one concrete recommendation.** Split `config.EWMA_HALFLIFE` into two
constants — a short one for the minutes/form features, a long one for `RATE_TARGETS`'
per-minute rates — and re-run `evaluate.py` on the real dataset. It is a config
change, not a data project; it is worth ~1% on the conditional points and assists
numbers that appear on every player card; and it has 5/5 origin consistency, which is
more than the ridge promotion candidate currently has. The 27 extra seasons of
history, by contrast, are worth keeping on disk as a cheap sanity asset and are not
worth putting in the training window.

---

## 9. Reproducing

```powershell
# 60 nba_api calls, ~4 min, idempotent
ml-spike\.venv\Scripts\python ml\experiments\pull_deep_history.py

# the sweep; writes ml/data/deep/results/depth_sweep_results.csv (gitignored)
ml-spike\.venv\Scripts\python ml\experiments\depth_sweep.py

# unit tests for the pure pieces, plus the existing suite
ml-spike\.venv\Scripts\python -m pytest ml\tests ml\experiments -q
```

Bulk data lives in `ml/data/deep/` (`*.parquet` and `*.csv` are gitignored by
`ml/data/.gitignore`, verified with `git check-ignore` before anything was
written). Nothing in this experiment writes to the database, and no git write
command was run.
