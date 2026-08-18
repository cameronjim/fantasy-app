# The production-rate tournament

**Question asked (verbatim):** *"attempt to train the production-per-minute
component many different ways, compare, and choose the best."*

The incumbent is `models.PerMinuteRate` — an EWMA with halflife 5 of
`stat / max(MIN, 4)` over career appearances with minutes > 0, as-of joined onto
the scheduled frame. It has never been beaten: ridge and LightGBM on whole-game
conditional totals both failed the package's 2% practical bar, and phase P1b
showed ridge's apparent 1.83% edge collapse to 0.81% (0/5 origins clear) once the
oracle teammate columns were replaced by honest ones.

`experiments/DEPTH_REPORT.md` §4.2 produced the one live hypothesis: per-minute
production rates preferred **halflife ~12** (−0.98% conditional PTS, −0.95% AST,
negative in 5/5 origins) while minutes preferred ~3, making the shipped 5 "a
compromise nobody chose". That was measured on an **appearance-only universe with
integer minutes and no teammate-context features** — a different frame from the
production one. This tournament tests it as a hypothesis, under the protocol
below, on the honest v3 production frame.

---

## 0. PRE-REGISTRATION

**This section was written and saved to disk before a single tournament number was
computed.** Nothing below §0 was edited after results existed. The only
computations that preceded it were structural inspections of the frame (row
counts, column dtypes, null shares, the confirmation that `PTS`/`AST` are exactly
0 on non-appearance rows, and a baseline `pytest ml/tests -q` → 359 passed).

### 0.1 Row universe and the identical-rows guarantee

- Frame: `ml/data/dataset.parquet` (`FEATURE_VERSION = v3`, 147,413 scheduled
  rows, 99 columns, 2022-10-18 → 2026-04-12). Byte-identical to
  `dataset_v3.parquet`. No new feature is built from the truth layer; every
  as-of column a method reads is either already on this frame or is recomputed by
  the **identical** `groupby(...).ewm(...)` + `merge_asof(allow_exact_matches=False)`
  code path `features.per_minute_rate_features` uses, parameterised only by the
  weighting scheme and the halflife.
- Origins: the five `config.ORIGINS`, unchanged. Train = every row strictly
  before the validation window's first day; validation = the calendar month.
  Validation support: 5,697 / 6,863 / 5,235 / 6,058 / 7,064 = **30,917 scheduled
  rows**, 21,853 of them appearances, over 142 distinct game dates.
- **Every method is evaluated on exactly these rows.** This is guaranteed
  structurally rather than checked after the fact: a method contributes only a
  `rate` vector, and every rate vector is defined on all 30,917 rows (nulls fall
  back to the *same* league rate for every method, see §0.3). No method may
  filter, and the runner asserts equal length and identical `(PLAYER_ID, GAME_ID)`
  ordering for every rate vector before scoring.

### 0.2 The composition, and what varies

Per origin, fitted **once** and shared by every method and both targets:

- `AvailabilityModel(kind='lightgbm').fit(train_all, FEATURE_COLS, cutoff=vstart)`
  → `P_PLAY`
- `MinutesModel(kind='lightgbm').fit(train_app, FEATURE_COLS, cutoff=vstart)`
  → `MIN_PRED`
- `models.minutes_propagated_estimate(scored, rate)` → `(conditional, unconditional)`

These are the shipped classes, not lookalikes, so all three leakage guards
(`validate_out_of_fold` on P(play), on E[min|plays], and `assert_same_cutoff`)
run on every single method's score. The **rate is the only thing that varies**
across the bracket; P(play) and E[min|plays] are literally the same arrays.

### 0.3 Common rules every method obeys

1. **As-of discipline.** A rate on the row for game G is a function of
   appearances strictly before G, enforced by `allow_exact_matches=False`. Rate
   rows are appearances with `MIN > 0`, career-scoped by `PLAYER_ID`, exactly as
   the incumbent's.
2. **Common fallback.** A null rate (3.83% of rows — players with no prior
   appearance) is filled with `Σ stat / Σ MIN` over that origin's **training**
   appearance rows: byte-for-byte the rule `models.PerMinuteRate.fit` uses. The
   same number for every method, so no method can win on its fallback.
3. **Honest features only.** Any method that reads features reads
   `config.FEATURE_COLS` (51 columns, the v3 served set). The v2 oracle columns
   are never touched. No method conditions on any teammate's realized
   target-game outcome.
4. **Out-of-fold predicted minutes.** Where a method needs predicted minutes as a
   *training-time* input, it uses a **cross-fit** minutes model: monthly forward
   -chaining calendar blocks (`config.CROSS_FIT_FREQ`, `CROSS_FIT_MIN_TRAIN_ROWS`),
   each block fitted on appearance rows strictly before the block start and used
   to score every scheduled row in the block, every prediction stamped with its
   block start and pushed through `validate_out_of_fold`. Actual target-game
   minutes are never an input to any method. Cold blocks fall back to
   `ewma_MIN`, floored — weaker, not leaky.
5. **No trained method sees non-appearance rows.** Rate models fit on
   `PLAYED == 1 & MIN > 0` rows only. A non-appearance's zero is an availability
   fact `P_PLAY` already owns.

### 0.4 Endpoints

- **PRIMARY: unconditional MAE**, per rate target (`PTS`, `AST`), of
  `P(play) × E[min|plays] × rate` against the realized stat over **all** 30,917
  scheduled validation rows (0 for non-appearances), pooled row-weighted across
  the five origins.
- **SECONDARY (reported, not decisive): conditional MAE** of
  `E[min|plays] × rate` over the 21,853 appearance rows.
- **Quantile / pinball loss: not computed.** No method in this bracket natively
  produces quantiles, and the brief scopes pinball to those that do.
- Cohort tables (`star / starter / bench / fringe`, `vacated_minutes ≥ 30`,
  `star_out = 1`, and the `vacated_minutes < 5` control) are **DESCRIPTIVE**.
  They cannot promote or block anything.

### 0.5 The decision rule

For each (method, target), with `ŷ⁰` the incumbent EWMA(5) and `ŷ¹` the challenger
over the same rows:

```
dᵢ  = |yᵢ − ŷ⁰ᵢ| − |yᵢ − ŷ¹ᵢ|          (positive ⇒ challenger better)
θ   = Σᵢ dᵢ / Σᵢ |yᵢ − ŷ⁰ᵢ|            (relative improvement, the reported effect)
```

**Uncertainty.** Paired per-row deltas are aggregated by **game date** — a date is
the resampling unit, because rows on one night share a slate, a schedule and an
injury report. **7-day moving-block bootstrap over dates, within origin** (blocks
never span the multi-month gaps between origins). Every overlapping 7-consecutive
-date start position is an admissible block; per origin `⌈n_dates / 7⌉` blocks are
drawn with replacement, rows are pooled across origins, and θ is recomputed as a
ratio of sums (so the resample re-weights numerator and denominator coherently).
**B = 2000 replicates, seed = `config.RANDOM_STATE` = 17.** 95% percentile CI.

**PROMOTE a method for a target if and only if BOTH hold:**

1. the 95% CI for θ **excludes zero**, and
2. **θ ≥ 0.02** — the package's own 2% practical floor, the same bar ridge and
   LightGBM failed.

**Multiplicity.** Seven decision candidates × two targets = 14 tests. A
bootstrap two-sided p-value `p = 2 · min(P(θ* ≤ 0), P(θ* ≥ 0))` is computed for
each, and **Holm–Bonferroni across the seven candidates within a target** is
reported and **required** for promotion alongside (1) and (2). The descriptive
halflife sweep is not part of the family — it has one pre-registered decision
representative (§0.6, M1) plus one pre-registered fixed hypothesis (M2).

**ONE LOOK.** The runner is executed once. No method is re-tuned, no grid is
re-opened and no origin is dropped after seeing a number. If nothing clears the
bar, the incumbent stays and this document says so; a null result is the
deliverable.

### 0.6 The seven decision candidates

Every hyperparameter is selected **inside each origin's training window** and
never on the validation rows that produce the reported number. The inner fold is
the **last 30 days of the training window** (inner-valid); inner-train is
everything before it. The inner selection criterion is the unconditional-MAE
**proxy** `P_CONTEXT × oof_min × rate` on inner-valid rows, where `P_CONTEXT` is
the frame's cross-fit out-of-fold base availability probability and `oof_min` is
the cross-fit out-of-fold minutes prediction of §0.3(4). Both are strictly
out-of-fold for every row by construction, so the criterion involves no extra
fits and no peeking. Ties break to the smaller halflife / larger shrinkage
(the more conservative estimator).

| id | method | what varies | hyperparameter, and how chosen |
|---|---|---|---|
| **M0** | **incumbent** `PerMinuteRate`, EWMA halflife 5 | — | fixed at `config.EWMA_HALFLIFE` |
| **M1** | EWMA rate, halflife selected | memory | `h ∈ {3, 5, 8, 12, 20}`, inner-selected per origin |
| **M2** | EWMA rate, **halflife 12 fixed** | memory | none — the DEPTH_REPORT hypothesis pre-registered as a fixed candidate, so it costs no selection |
| **M3** | minutes-weighted EWMA | weighting | `h ∈ {3, 5, 8, 12, 20}`, inner-selected |
| **M4** | empirical-Bayes shrinkage on the incumbent (h = 5) toward a position prior | shrinkage | `k ∈ {2, 5, 10, 20, 50}` games, inner-selected |
| **M5** | ridge on the **residual** `r − ewma₅(r)` over `FEATURE_COLS` | features explain deviations from form | `α ∈ {0.1, 1, 10, 100, 1000}`, inner-selected |
| **M6** | LightGBM **Poisson** on raw counts, `log(oof_min)` offset | count-native | none — `config.LGBM_PARAMS`, `objective='poisson'`, fixed |
| **M7** | LightGBM **Tweedie** on rates, minutes as sample weight | rate-native, minutes-weighted loss | none — `config.LGBM_PARAMS`, `objective='tweedie'`, `variance_power=1.5`, fixed |
| **M8** | **hybrid**: EB shrinkage on top of a selected halflife | both | `(h, k)` jointly inner-selected over the 5 × 5 grid |

That is M1–M8 = eight rows, of which **seven are decision candidates** (M2 is the
pre-registered hypothesis and is counted in the family; the full five-point
halflife sweep is reported alongside as a descriptive table and is *not* seven
extra tests). The Holm family per target is therefore {M1, M3, M4, M5, M6, M7, M8}
∪ {M2} = 8 members; the correction is applied over all 8.

Exact estimator definitions:

- **EWMA (M0/M1/M2).** `r = stat / max(MIN, 4)`;
  `r.groupby(PLAYER_ID).ewm(halflife=h, adjust=True).mean()`.
- **Minutes-weighted EWMA (M3).** decay `λ = 2^(−1/h)`, weights `wᵢ = max(MINᵢ, 4)`:
  `rateₙ = Σ λ^(n−i) wᵢ rᵢ / Σ λ^(n−i) wᵢ`. Since `wᵢ rᵢ = statᵢ`, this is
  algebraically `ewm(stat) / ewm(max(MIN,4))` — a ratio of EWMAs rather than an
  EWMA of ratios, which is the whole point: a 2-minute garbage-time rate gets
  1/9th the weight of a 36-minute night instead of equal weight. The identity is a
  unit test.
- **EB shrinkage (M4/M8).** `rate = w · ewma_h(r) + (1 − w) · prior(pos_group)`,
  `w = n / (n + k)`, `n` = as-of career count of rate rows. `prior` =
  `Σ stat / Σ max(MIN, 4)` over that origin's **training** rate rows within the
  player's `POS_GROUP`, with the league-wide train rate as fallback when
  `POS_GROUP` is null (18.1% of rows) or the group has fewer than 500 train rows.
  The prior is fitted on train only, never on the full frame.
- **Ridge residual (M5).** target `rᵢ − ewma₅(r)ᵢ` on train rate rows; features
  `FEATURE_COLS`; median-impute → standardise → `Ridge(α)`;
  `rate = clip(ewma₅(r) + resid̂, 0, ∞)`.
- **Poisson offset (M6).** target = raw `stat` count on train rate rows;
  `init_score = log(max(oof_min, 10⁻³))`; the emitted **rate** is
  `exp(raw_score(x))`, which is a per-minute intensity by construction and is what
  the composition then multiplies by `E[min|plays]`.
- **Tweedie rate (M7).** target `r`, `sample_weight = max(MIN, 4)`,
  `rate = clip(pred, 0, ∞)`.

### 0.7 What would count as a deviation

Wall-clock guard: if the grid would exceed ~4 hours, the **hyperparameter grid
density** is reduced (never the origin count, never the row universe), and the
reduction is named in §5. Any other departure from §0 is recorded in §5 with its
justification.

---

## 1. Results

**The headline: nothing clears the pre-registered bar. The incumbent
EWMA(halflife 5) stays for both rate targets.**

Runner: `python -m experiments.production_tournament.run_tournament` from `ml/`.
Wall clock **93 s** for the bracket plus **43 s** to build the two caches, so the
grid was never reduced (§0.7 unused). Seventeen rate estimators × 2 targets × 5
origins × 30,917 identical rows.

### 1.0 The reproduction check the whole halflife sweep rests on

Before any comparison: does the reimplemented halflife-5 rate reproduce the
**shipped** `ewma_<stat>_per_min` column, or merely resemble it?

| target | rows compared | null pattern identical | max abs diff |
|---|---:|---|---:|
| PTS | 141,761 | yes | **0.0** |
| AST | 141,761 | yes | **0.0** |

Exact, to the last bit, on all 141,761 rows where both are defined, with identical
null masks. The halflife axis is therefore a sweep of the incumbent's own
estimator, not of a lookalike. `test_rates.py` pins the same claim on a toy frame
against `features.per_minute_rate_features` directly.

Supporting shares: cross-fit minutes came from a fitted model for **93.6%** of
rows (6.4% cold-block fallback, all of it in the opening weeks of 2022-23, none of
it in any validation month); **3.83%** of rows have no prior appearance-with-minutes
and take the common terminal fallback under every method.

### 1.1 PRIMARY ENDPOINT — unconditional MAE, 30,917 rows, 5 origins pooled

`θ` is relative improvement over the incumbent; `95% CI` is the 7-day
moving-block bootstrap of §0.5; `p` is the two-sided bootstrap p-value, floored at
1/2000 = 0.0005.

**PTS** — incumbent M0 = **3.9294**

| id | method | h / k / α chosen | MAE | θ | 95% CI | p | Holm | ≥2%? | PROMOTE |
|---|---|---|---:|---:|---|---:|---|---|---|
| M2 | EWMA h=12 (fixed) | 12 | 3.9073 | **+0.56%** | [+0.47%, +0.77%] | .0005 | ✓ | ✗ | **no** |
| M1 | EWMA, h inner-selected | 12,12,20,8,8 | 3.9078 | +0.55% | [+0.43%, +0.74%] | .0005 | ✓ | ✗ | no |
| M5 | ridge on the residual | α = 1000,1000,100,1000,1000 | 3.9129 | +0.42% | [+0.27%, +0.60%] | .0005 | ✓ | ✗ | no |
| M8 | hybrid: shrinkage on selected h | h 12,12,20,8,8; k = 2 | 3.9159 | +0.34% | [+0.23%, +0.54%] | .0005 | ✓ | ✗ | no |
| M3 | minutes-weighted EWMA | h 8,12,20,5,8 | 3.9291 | +0.01% | [−0.14%, +0.16%] | .894 | ✗ | ✗ | no |
| M7 | LightGBM Tweedie on rates | fixed | 3.9362 | −0.17% | [−0.32%, −0.01%] | .043 | ✗ | ✗ | no |
| M4 | EB shrinkage of EWMA5 | k = 2 | 3.9369 | −0.19% | [−0.21%, −0.16%] | .0005 | ✓ | ✗ | no |
| M6 | LightGBM Poisson + log-min offset | fixed | 3.9440 | −0.37% | [−0.54%, −0.19%] | .0005 | ✓ | ✗ | no |

**AST** — incumbent M0 = **1.0943**

| id | method | h / k / α chosen | MAE | θ | 95% CI | p | Holm | ≥2%? | PROMOTE |
|---|---|---|---:|---:|---|---:|---|---|---|
| M2 | EWMA h=12 (fixed) | 12 | 1.0881 | **+0.57%** | [+0.39%, +0.72%] | .0005 | ✓ | ✗ | **no** |
| M1 | EWMA, h inner-selected | 5,12,20,12,8 | 1.0897 | +0.42% | [+0.24%, +0.55%] | .0005 | ✓ | ✗ | no |
| M8 | hybrid: shrinkage on selected h | h 5,12,20,12,8; k = 2 | 1.0915 | +0.26% | [+0.04%, +0.38%] | .008 | ✓ | ✗ | no |
| M3 | minutes-weighted EWMA | h 5,12,20,12,8 | 1.0933 | +0.10% | [−0.15%, +0.23%] | .645 | ✗ | ✗ | no |
| M5 | ridge on the residual | α = 10,0.1,100,100,1000 | 1.0937 | +0.06% | [−0.16%, +0.21%] | .828 | ✗ | ✗ | no |
| M7 | LightGBM Tweedie on rates | fixed | 1.0949 | −0.06% | [−0.33%, +0.21%] | .584 | ✗ | ✗ | no |
| M4 | EB shrinkage of EWMA5 | k = 2 | 1.0958 | −0.14% | [−0.18%, −0.12%] | .0005 | ✓ | ✗ | no |
| M6 | LightGBM Poisson + log-min offset | fixed | 1.0989 | −0.42% | [−0.74%, −0.15%] | .0020 | ✓ | ✗ | no |

**The bar has two halves and only one of them fails.** Four PTS candidates and
three AST candidates are *statistically* real — CIs excluding zero, Holm-surviving
at family-wise 5%, and in the case of M2 consistent in 5/5 origins for both
targets. Every single one of them is **three to four times too small** to clear the
2% practical floor. This is not "we could not detect an effect": the **upper** CI
bound of the best candidate is **+0.77%** (PTS) and **+0.72%** (AST), so the data
positively **excludes** a 2% effect for every method in the bracket.

### 1.2 SECONDARY ENDPOINT — conditional MAE, 21,853 appearance rows

Reported, not decisive. The ordering is the same but every effect is larger,
because the conditional endpoint does not have `P(play)` multiplying the rate error
down toward zero on the 29% of rows that are non-appearances.

| id | PTS MAE | vs M0 | AST MAE | vs M0 |
|---|---:|---:|---:|---:|
| M0 (incumbent) | 4.4977 | — | 1.3157 | — |
| M2 EWMA h=12 | **4.4597** | **+0.84%** | **1.3039** | **+0.90%** |
| M1 EWMA h selected | 4.4609 | +0.82% | 1.3064 | +0.71% |
| M8 hybrid | 4.4653 | +0.72% | 1.3072 | +0.65% |
| M5 ridge residual | 4.4689 | +0.64% | 1.3114 | +0.33% |
| M3 minutes-weighted | 4.4856 | +0.27% | 1.3095 | +0.47% |
| M7 Tweedie | 4.4865 | +0.25% | 1.3132 | +0.19% |
| M6 Poisson offset | 4.4957 | +0.04% | 1.3162 | −0.03% |
| M4 EB shrinkage | 4.5009 | −0.07% | 1.3161 | −0.03% |

### 1.3 Per-origin consistency of the two best candidates

Relative improvement on the primary endpoint, per origin. Consistency is
descriptive here — the pre-registered rule is the pooled bootstrap, not an origin
count — but it is the thing DEPTH_REPORT §4.2 reported, so it is reported back.

| target | method | O1 12/24 | O2 01/25 | O3 02/25 | O4 12/25 | O5 01/26 | origins positive |
|---|---|---:|---:|---:|---:|---:|---|
| PTS | M2 h=12 | +0.45% | +0.74% | +0.80% | +0.13% | +0.69% | **5/5** |
| PTS | M1 h selected | +0.45% | +0.74% | +0.85% | +0.24% | +0.50% | 5/5 |
| AST | M2 h=12 | +0.55% | +0.81% | +0.64% | +0.02% | +0.75% | **5/5** |
| AST | M1 h selected | +0.00% | +0.81% | +0.68% | +0.02% | +0.55% | 4/5, one exact tie |

O4 (December 2025) is the weak origin for every method in the bracket, on both
targets. Whatever it is, it is not specific to a rate estimator.

### 1.4 The DESCRIPTIVE halflife sweep, both weighting schemes

Pre-registered as descriptive in §0.6 and excluded from the Holm family. Positive
= better than plain halflife 5.

| halflife | PTS plain | PTS minutes-wtd | AST plain | AST minutes-wtd |
|---:|---:|---:|---:|---:|
| 3 | −0.96% | −1.33% | −1.02% | −1.28% |
| **5** *(shipped)* | — | −0.45% | — | −0.30% |
| 8 | +0.44% | −0.05% | +0.43% | +0.12% |
| **12** | **+0.56%** | +0.04% | **+0.57%** | +0.23% |
| 20 | +0.47% | −0.04% | +0.50% | +0.13% |

Two clean readings, both monotone-then-flat rather than noisy:

1. **The curve has an interior optimum at h ≈ 12** for both targets and both
   schemes, and it is shallow between 8 and 20. Halflife 3 is decisively worse
   (−1%), which matters because 3 is what DEPTH_REPORT measured `minutes` wanting.
2. **Minutes-weighting is worse than not weighting, at every single halflife.**
   That is the opposite of what the method was proposed for, and §3 says what the
   mechanism appears to be.

## 2. Cohort descriptives

**DESCRIPTIVE ONLY — these tables promoted and blocked nothing.** Relative
improvement over the incumbent on the primary endpoint. Support: star 6,958 /
starter 9,940 / bench 8,177 / fringe 5,058 / unknown 784; `vacated ≥ 30` 23,231;
`star_out = 1` 7,219; `vacated < 5` 955.

**PTS**

| cohort | M1 | M2 | M3 | M4 | M5 | M6 | M7 | M8 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| star (≥30) | +0.54% | +0.54% | +0.54% | +0.03% | +0.82% | **+1.08%** | +0.93% | +0.56% |
| starter (20-30) | +0.59% | +0.63% | +0.22% | −0.02% | +0.33% | +0.09% | −0.03% | +0.56% |
| bench (10-20) | +0.54% | +0.52% | −0.74% | −0.19% | +0.29% | −1.09% | −0.79% | +0.33% |
| fringe (<10) | +0.41% | +0.46% | −1.91% | −2.60% | −0.98% | **−9.48%** | −5.54% | −2.22% |
| unknown (no history) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| event: vacated ≥ 30 | +0.50% | +0.51% | +0.10% | −0.16% | +0.43% | −0.33% | −0.12% | +0.32% |
| event: star_out = 1 | +0.46% | +0.42% | +0.33% | −0.17% | +0.46% | −0.22% | +0.04% | +0.28% |
| control: vacated < 5 | +1.34% | +1.43% | −0.36% | −0.48% | +0.98% | −0.69% | +0.21% | +0.83% |

**AST**

| cohort | M1 | M2 | M3 | M4 | M5 | M6 | M7 | M8 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| star (≥30) | +0.26% | +0.51% | +0.32% | +0.06% | +0.06% | +0.06% | −0.13% | +0.29% |
| starter (20-30) | +0.53% | +0.65% | +0.47% | −0.01% | +0.18% | +0.32% | +0.45% | +0.49% |
| bench (10-20) | +0.58% | +0.66% | −0.18% | −0.16% | +0.00% | −0.39% | −0.05% | +0.39% |
| fringe (<10) | +0.18% | +0.05% | −2.74% | −2.09% | −0.62% | **−8.41%** | −3.02% | −1.94% |
| unknown (no history) | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| event: vacated ≥ 30 | +0.49% | +0.59% | +0.17% | −0.13% | +0.00% | −0.58% | −0.25% | +0.33% |
| event: star_out = 1 | +0.47% | +0.52% | +0.42% | −0.19% | −0.32% | −0.89% | −0.53% | +0.26% |
| control: vacated < 5 | +0.06% | +0.71% | −0.04% | +0.81% | +0.57% | +0.99% | +0.10% | +0.10% |

Three things worth naming, all descriptive:

- **The `unknown (no history)` column is exactly 0.00% for every method, on both
  targets.** That is the common terminal fallback of §0.3(2) working as designed:
  on the rows where nobody has a rate, every method emits the same number, so
  nothing in this bracket can be won or lost there.
- **The two boosters trade the fringe for the stars.** M6 is the single best method
  in the bracket on `star (≥30)` PTS (+1.08%) and the single worst on
  `fringe (<10)` (−9.48%, and −8.41% on AST). A gradient booster pulls a
  thin-history fringe player's rate toward a population mean; the incumbent leaves
  him at his own EWMA. Since fringe rows are 16% of the universe and their absolute
  errors are small (MAE ≈ 1.42 PTS vs 6.27 for stars), the pooled endpoint mostly
  hides this — which is exactly the reason to print it.
- **The halflife-12 gain is broad, not concentrated.** M2 is positive in every
  cohort on both targets, including the `vacated < 5` control. It is not buying
  high-absence nights at the cost of quiet ones; it is a slightly better estimate
  of everybody's rate.

## 3. Decision per target

| rate target | decision | champion after this tournament |
|---|---|---|
| **PTS** | **incumbent stays** | `PerMinuteRate`, EWMA halflife 5 |
| **AST** | **incumbent stays** | `PerMinuteRate`, EWMA halflife 5 |

`config.CHAMPIONS["production"]` is unchanged, `config.EWMA_HALFLIFE` is unchanged,
and **no file outside `ml/experiments/production_tournament/` was modified.** The
promotion exception in the brief was not exercised because its condition was not
met.

**Why the bar was not lowered for the best candidate.** M2 (halflife 12) is the
most defensible near-miss this package has produced: +0.56% / +0.57% on the primary
endpoint, positive in 5/5 origins on both targets, Holm-surviving, positive in
every descriptive cohort, and it costs literally nothing at serve time — it is a
one-line change to `config.EWMA_HALFLIFE`. It is still four times smaller than the
2% floor the same package used to reject ridge and LightGBM on this exact target.
Lowering the floor for a candidate *after* seeing that it lands under it is the
specific move the pre-registration exists to prevent. **What did move is the
evidence base**, and §4 states the case a future decision could be made on.

**Findings that are not promotions but are worth carrying forward:**

1. **Minutes-weighting the rate makes it worse, consistently.** Every
   minutes-weighted halflife is worse than the plain EWMA at the same halflife
   (§1.4), and M3 lands at +0.01% / +0.10% with a CI straddling zero. The
   mechanism is visible in the cohort table: M3's losses are entirely in
   `bench` (−0.74% PTS) and `fringe` (−1.91% PTS), the two tiers whose history is
   *made of* short nights. Weighting by minutes does not just discount a
   garbage-time rate, it discounts a fringe player's **entire evidence base** and
   pulls his estimate toward the handful of longer nights he happens to have had.
   `RATE_MINUTES_FLOOR = 4` already caps the cameo pathology it was proposed to
   fix, and it does so without throwing the cameo's information away.
2. **Empirical-Bayes shrinkage hurts, and the inner fold said so before the
   validation rows did.** M4 is −0.19% / −0.14% with a tight CI excluding zero — a
   real, small regression. The inner fold selected **k = 2, the smallest value in
   the grid, in all 5 origins for both targets**: it was pushing against the grid
   boundary trying to turn the shrinkage off. The reason is that the incumbent is
   already shrunk: `stat / max(MIN, 4)` floors the denominator, which bounds a
   thin-history player's rate far more cheaply than pulling him toward a position
   mean, and `n / (n + k)` then double-counts the correction.
3. **Both count-native framings lose.** Poisson-with-offset (−0.37% / −0.42%) and
   Tweedie-on-rates (−0.17% / −0.06%) are the two most theoretically motivated
   members of the bracket and two of the three worst performers. The distributional
   argument for them is sound; what defeats it is the same thing that defeats every
   trained challenger on this target — a booster cannot learn a per-player
   efficiency level from 51 columns that do not include player identity, and the
   EWMA *is* player identity.
4. **Ridge on the residual is the best trained challenger this package has
   produced on production**, at +0.42% PTS (5/5 origins positive, CI
   [+0.27%, +0.60%]) — but the inner fold picked α = 1000 (the top of the grid) in
   4 of 5 PTS origins, i.e. it chose to be as close to the incumbent as the grid
   allowed. A model whose selected hyperparameter is "shrink me to almost nothing"
   is telling you the residual is nearly unpredictable, and its +0.42% is the size
   of what "nearly" is worth. On AST it is +0.06% and not distinguishable from zero.

## 4. Did the halflife-12 hypothesis hold?

**Yes, directionally and at close to the predicted magnitude — and it still does
not clear the bar.** This is the clearest result in the tournament.

DEPTH_REPORT §4.2 measured halflife 12 against halflife 5 on an **appearance-only
universe with integer minutes and no teammate-context features**, on the
*conditional* propagated estimate. This tournament measures it on the **honest v3
production frame with float minutes, the served 51-column feature set, and the
shipped composition**. Those are different datasets and different endpoints, so
agreement is a replication and not an arithmetic identity:

| claim | DEPTH_REPORT §4.2 (appearance-only, integer MIN) | here (v3 production frame) |
|---|---|---|
| conditional PTS, h12 vs h5 | −0.98% (better) | **−0.84%** (better) |
| conditional AST, h12 vs h5 | −0.95% (better) | **−0.90%** (better) |
| origins in the same direction | 5/5 both targets | **5/5 both targets** |
| unconditional PTS / AST | not measurable there (§0 of that report) | +0.56% / +0.57% better |
| shape of the curve | improving through h12 | interior optimum at h ≈ 12, flat 8-20 |

The conditional numbers replicate to within 0.14 percentage points on PTS and 0.05
on AST — a strikingly close agreement given that one frame has integer minutes and
a different row universe. **The depth report's mechanism claim survives too:** it
argued that whole-game totals inherit minutes' volatility and want a short window
while per-minute efficiency is stable and wants a long one. Here the plain
per-minute rate improves monotonically from h3 to h12 and then flattens, exactly as
predicted, and halflife 3 — the value the same report found `minutes` preferring —
is ~1% *worse* for rates. `config.EWMA_HALFLIFE = 5` really is one number doing two
incompatible jobs.

**What kept it from promoting is arithmetic, not doubt.** The hypothesis was about
the conditional estimate, where the effect is ~0.85-0.90%. The pre-registered
primary endpoint is the unconditional one, where `P(play)` scales the same rate
error down to ~0.56%. Neither number is within a factor of two of the 2% floor.

**The honest recommendation this leaves.** The halflife question is now the
best-evidenced open item on this target: replicated across two independent frames,
consistent across ten origin-target pairs, monotone in the swept parameter, harmful
to no cohort, and free at serve time. It is also entangled — `EWMA_HALFLIFE` is
shared by `ewma_MIN` (which DEPTH_REPORT measured wanting h≈3), by `ewma_<stat>`,
and by `usg_ewma`, so changing it changes the minutes champion's features and the
teammate-context hierarchy at the same time. **The next experiment worth running is
not another rate estimator; it is decoupling the halflife into per-family constants
and re-running the full ladder** — which is a config-and-features change with a
blast radius well outside a rate tournament, and therefore outside this brief.

## 5. Deviations and limitations

### 5.1 Deviations from the brief

1. **The brief's method list has 7 entries; the decision family has 8.** The extra
   member is M2 (halflife 12 fixed), pre-registered in §0.6 so the DEPTH_REPORT
   hypothesis could be tested as the *specific fixed value* the report named rather
   than only through an inner-fold selection that might not pick it. It is included
   in the Holm correction, so it cost the other candidates power rather than being
   a free extra shot.
2. **The runner was smoke-tested on origin O1 before the full run, and O1's numbers
   were visible.** This is a partial look and it is recorded here rather than
   omitted. What changed as a result: nothing in any method definition, grid,
   endpoint, or decision rule. The only change made after the smoke test was adding
   the eight **descriptive** sweep members, which §0.6 had already pre-registered
   as "reported alongside" and which the smoke-test harness had simply not
   implemented yet. Descriptive members cannot promote anything (§0.6, enforced in
   `bootstrap_table` and tested in `test_methods.py`).
3. **Two bugs were fixed between the first and second execution of the full
   runner**, both in output assembly rather than in any estimator: a duplicate
   `vacated_minutes` column (two `EVENT_COHORTS` definitions read the same column)
   made the predictions frame unwritable, and `bootstrap_table` read `origin` from
   the columns after it had been moved to the index. Both crashed the run; neither
   could have changed a number, and the per-origin MAEs logged before each crash
   are identical to the final ones.
4. **No wall-clock reduction was needed.** 93 s of scoring against a ~4 h budget,
   so the grid density in §0.6 is exactly as pre-registered.
5. **Quantile/pinball loss was not computed**, as §0.4 pre-registered: no member of
   this bracket natively produces quantiles.

### 5.2 Limitations

1. **The primary endpoint dilutes rate quality by construction, and that is a
   choice with consequences.** `P(play) × E[min|plays] × rate` means a rate error is
   multiplied by ~0.71 on average and by ~0 on a likely absence, so the
   unconditional endpoint systematically shrinks every rate effect relative to the
   conditional one — here by roughly a third. It is the right endpoint (it is what
   ships and what fantasy scoring consumes), but a 2% floor set on it is a stricter
   test of a rate estimator than the same floor on the conditional endpoint would
   be. A future brief that wants to decide *rate* questions should say which
   endpoint the floor applies to.
2. **Two grids were selected at their boundary.** Shrinkage chose k = 2 (grid
   minimum) in 10/10 origin-target pairs, and ridge chose α = 1000 (grid maximum)
   in 4/5 PTS origins. In both cases the inner fold wanted to go further than the
   grid allowed, toward *less* shrinkage and *more* regularisation respectively —
   i.e. both toward the incumbent. Widening the grids could only move those methods
   closer to +0.00%, so the conclusion is safe, but their reported numbers are not
   the best those families could do.
3. **The common terminal fallback is conservative and it costs the fancier methods
   something real.** On the 3.83% of rows with no rate history, every method is
   overridden with the incumbent's league fallback (§0.3(2)). Shrinkage and the two
   boosters would each have produced a genuinely more informed number there, and
   that is a real property of those methods that this design deliberately does not
   measure. The `unknown (no history)` cohort row of §2 is exactly 0.00% wide for
   everyone as a result.
4. **`P(play)` and `E[min|plays]` are held fixed at the lightgbm champions.** A rate
   estimator that is worse in isolation could in principle be better in combination
   with a differently-fitted minutes model; nothing here tests interactions between
   the three factors of the composition.
5. **Poisson and Tweedie ran on `config.LGBM_PARAMS` with no tuning at all.** That
   was pre-registered to spend no selection budget, and it is the correct choice for
   a fair one-look bracket, but it means their −0.37% / −0.17% are the numbers for
   *untuned* count-native models. A tuned Poisson might be less bad. Given the
   direction and the fringe-cohort mechanism (§2), it is very unlikely to be 2%
   better.
6. **The selection holdout is untouched by this tournament but not untouched
   overall.** The five origins are the same development origins every other champion
   decision in this package was made on (Dec 2024 - Feb 2025, Dec 2025 - Jan 2026).
   Feb-Apr 2026 was not used here. The only genuinely untouched evaluation remains
   the prospective 2026-27 season, per MODEL.md §6.
7. **142 dates is not a lot of blocks.** The moving-block bootstrap draws
   ⌈n/7⌉ blocks per origin from 23-31 dates each, so the effective number of
   independent units behind each CI is on the order of 20, not 30,917. The CIs are
   correspondingly honest about that and are much wider than an i.i.d. row bootstrap
   would give (`test_bootstrap.py` pins that the block structure widens them). They
   are still bootstrap percentile intervals on a ratio statistic, with the usual
   caveats near zero.
8. **Both targets, one mechanism.** PTS and AST agree on every qualitative finding,
   which is reassuring but is not two independent replications: they are computed
   from the same 51 features, the same minutes model, the same probabilities and the
   same appearance history, and are strongly correlated per row.

### 5.3 Reproducing this

```
cd ml
python -m experiments.production_tournament.run_tournament            # 93 s + 43 s of caching
python -m pytest experiments/production_tournament -q                 # 70 passed
python -m pytest tests -q                                             # 359 passed, unchanged
```

The two caches under `cache/` are pure functions of `data/dataset.parquet`;
`--rebuild` forces them to be recomputed and `--from-cache` re-renders the tables
from the stored per-row predictions without refitting anything. Everything under
`cache/`, plus the emitted `*.csv`, is gitignored by this directory's own
`.gitignore` — the report is the artifact, the intermediates are not.
