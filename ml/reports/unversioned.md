# Rolling-origin evaluation - unversioned

- **generated_at**: 2026-08-17 19:09 UTC
- **dataset**: ml\data\dataset.parquet
- **universe_source**: status
- **rows**: 147,413
- **players**: 895
- **played_rate**: 0.7132
- **feature_version**: v2
- **git_commit**: 404966fc83cfc5cdebf8b410d2214321682e2502

## Champion selection

| task                | family       | metric   | measured_best                |   measured_value | configured_champion          |   configured_value | matches_config   |
|:--------------------|:-------------|:---------|:-----------------------------|-----------------:|:-----------------------------|-------------------:|:-----------------|
| A availability      | availability | Brier    | lightgbm                     |           0.0710 | lightgbm                     |             0.0710 | True             |
| B minutes|played    | minutes      | MAE      | lightgbm                     |           4.5365 | lightgbm                     |             4.5365 | True             |
| C1 pts|played       | production   | MAE      | ridge                        |           4.4649 | ewma                         |             4.5483 | False            |
| C2 ast|played       | production   | MAE      | ridge                        |           1.3125 | ewma                         |             1.3269 | False            |
| D pts UNCONDITIONAL | composition  | MAE      | decomposed_p_x_minutes_x_ppm |           3.9112 | decomposed_p_x_minutes_x_ppm |             3.9112 | True             |

Measured winner differs from the configured champion for: C1 pts|played, C2 ast|played. Config is deliberate - see `config.CHAMPIONS` and REPORT.md section 6.

### Composition parity check

- champion `decomposed_p_x_minutes_x_ppm`: **3.9112** MAE
- previous `decomposed_p_x_ewma`: 3.9963 MAE
- relative delta: -2.13% (tolerance 1.00%) — **PARITY**

The minutes-propagating composition was promoted for correctness, not for accuracy: `P(play) x EWMA(stat)` is not a function of predicted minutes at all, so a minutes forecast could not reach a production projection. Parity on aggregate MAE is the expected outcome — most players' predicted minutes are close to their recent minutes — and the check above exists to catch the case where the change costs accuracy rather than to claim it gains any.

## Event cohorts: do they contain what they claim to

Model-free. Mean outcome inside each cohort against the population mean, plus the same split on a randomly PERMUTED copy of `vacated_minutes`. The permuted rows are the null: if they showed comparable lift, the cohort machinery would be manufacturing the finding.

| cohort                                          | outcome   |   rows |   cohort_mean |   population_mean |    lift |
|:------------------------------------------------|:----------|-------:|--------------:|------------------:|--------:|
| event: vacated_minutes >= 30                    | PLAYED    | 103641 |        0.7210 |            0.7132 | +0.0078 |
| event: vacated_minutes >= 30                    | MIN       |  74725 |       22.7920 |           22.5725 | +0.2194 |
| event: vacated_minutes >= 30                    | PTS       |  74725 |       10.7659 |           10.7129 | +0.0530 |
| event: star_out = 1                             | PLAYED    |  31112 |        0.7224 |            0.7132 | +0.0092 |
| event: star_out = 1                             | MIN       |  22476 |       23.1140 |           22.5725 | +0.5414 |
| event: star_out = 1                             | PTS       |  22476 |       10.7086 |           10.7129 | -0.0043 |
| control: vacated_minutes < 5                    | PLAYED    |  12968 |        0.6875 |            0.7132 | -0.0258 |
| control: vacated_minutes < 5                    | MIN       |   8915 |       22.0252 |           22.5725 | -0.5473 |
| control: vacated_minutes < 5                    | PTS       |   8915 |       10.4726 |           10.7129 | -0.2403 |
| event: vacated_minutes >= 30 [PERMUTED CONTROL] | PLAYED    | 103641 |        0.7134 |            0.7132 | +0.0001 |
| event: vacated_minutes >= 30 [PERMUTED CONTROL] | MIN       |  73933 |       22.5663 |           22.5725 | -0.0063 |
| event: vacated_minutes >= 30 [PERMUTED CONTROL] | PTS       |  73933 |       10.6942 |           10.7129 | -0.0187 |
| control: vacated_minutes < 5 [PERMUTED CONTROL] | PLAYED    |  12968 |        0.7175 |            0.7132 | +0.0043 |
| control: vacated_minutes < 5 [PERMUTED CONTROL] | MIN       |   9305 |       22.7083 |           22.5725 | +0.1358 |
| control: vacated_minutes < 5 [PERMUTED CONTROL] | PTS       |   9305 |       10.7755 |           10.7129 | +0.0626 |

## Where the new features rank (split gain, mean over origins)

Gain is ranked WITHIN each model - availability gain and minutes gain are not the same unit. `share` is the feature's fraction of that model's total gain. The `negative-control fit` rows come from a separate pair of fits with a permuted `vacated_minutes` column added, so the real column's gain has something guaranteed-signal-free to be compared against.

| pass                 | model        | feature                  |      gain | share   |   rank |
|:---------------------|:-------------|:-------------------------|----------:|:--------|-------:|
| main                 | availability | vacated_usg              |    12,359 | 1.84%   |      4 |
| main                 | availability | vacated_minutes          |    10,179 | 1.52%   |      6 |
| main                 | availability | vacated_fga              |     9,585 | 1.43%   |      8 |
| main                 | availability | depth_rank_available     |     8,256 | 1.23%   |      9 |
| main                 | availability | vacated_minutes_pos      |     4,538 | 0.68%   |     15 |
| main                 | availability | usg_ewma                 |     3,224 | 0.48%   |     19 |
| main                 | availability | depth_rank_available_pos |     1,653 | 0.25%   |     28 |
| main                 | availability | top3_usage_out_count     |     1,155 | 0.17%   |     39 |
| main                 | availability | star_out                 |       275 | 0.04%   |     43 |
| main                 | minutes      | depth_rank_available     | 9,751,285 | 18.42%  |      2 |
| main                 | minutes      | vacated_fga              |   608,555 | 1.15%   |      6 |
| main                 | minutes      | vacated_minutes          |   383,475 | 0.72%   |      9 |
| main                 | minutes      | vacated_minutes_pos      |   350,969 | 0.66%   |     10 |
| main                 | minutes      | vacated_usg              |   249,820 | 0.47%   |     11 |
| main                 | minutes      | depth_rank_available_pos |   143,315 | 0.27%   |     18 |
| main                 | minutes      | usg_ewma                 |   116,014 | 0.22%   |     20 |
| main                 | minutes      | top3_usage_out_count     |    92,384 | 0.17%   |     28 |
| main                 | minutes      | star_out                 |    13,129 | 0.02%   |     42 |
| negative-control fit | availability | vacated_usg              |    11,509 | 1.72%   |      5 |
| negative-control fit | availability | vacated_minutes          |    10,465 | 1.56%   |      6 |
| negative-control fit | availability | vacated_fga              |     9,108 | 1.36%   |      8 |
| negative-control fit | availability | depth_rank_available     |     8,462 | 1.26%   |      9 |
| negative-control fit | availability | vacated_minutes_pos      |     4,167 | 0.62%   |     15 |
| negative-control fit | availability | usg_ewma                 |     3,156 | 0.47%   |     19 |
| negative-control fit | availability | vacated_minutes_permuted |     2,747 | 0.41%   |     21 |
| negative-control fit | availability | depth_rank_available_pos |     1,635 | 0.24%   |     29 |
| negative-control fit | availability | top3_usage_out_count     |     1,186 | 0.18%   |     39 |
| negative-control fit | availability | star_out                 |       299 | 0.04%   |     44 |
| negative-control fit | minutes      | depth_rank_available     | 8,074,388 | 15.24%  |      2 |
| negative-control fit | minutes      | vacated_fga              |   553,320 | 1.04%   |      7 |
| negative-control fit | minutes      | vacated_minutes          |   371,749 | 0.70%   |      9 |
| negative-control fit | minutes      | vacated_minutes_pos      |   346,088 | 0.65%   |     10 |
| negative-control fit | minutes      | vacated_usg              |   234,843 | 0.44%   |     11 |
| negative-control fit | minutes      | depth_rank_available_pos |   145,210 | 0.27%   |     17 |
| negative-control fit | minutes      | vacated_minutes_permuted |   119,223 | 0.23%   |     20 |
| negative-control fit | minutes      | usg_ewma                 |   116,441 | 0.22%   |     21 |
| negative-control fit | minutes      | top3_usage_out_count     |   106,914 | 0.20%   |     24 |
| negative-control fit | minutes      | star_out                 |    11,163 | 0.02%   |     43 |

**Negative control verdict** (same fit, both columns present):

- `availability`: real `vacated_minutes` gain 10,465 (rank 6) vs permuted twin 2,747 (rank 21) — **3.8x**
- `minutes`: real `vacated_minutes` gain 371,749 (rank 9) vs permuted twin 119,223 (rank 20) — **3.1x**

### Top 12 features per model, for context

| model        | feature              |       gain | share   |   rank |
|:-------------|:---------------------|-----------:|:--------|-------:|
| availability | games_since_last_app |    466,771 | 69.62%  |      1 |
| availability | days_since_last_app  |     29,188 | 4.35%   |      2 |
| availability | avail_rate_10        |     23,774 | 3.55%   |      3 |
| availability | vacated_usg          |     12,359 | 1.84%   |      4 |
| availability | uncond_std_MIN       |     11,870 | 1.77%   |      5 |
| availability | vacated_minutes      |     10,179 | 1.52%   |      6 |
| availability | avail_rate_std       |      9,742 | 1.45%   |      7 |
| availability | vacated_fga          |      9,585 | 1.43%   |      8 |
| availability | depth_rank_available |      8,256 | 1.23%   |      9 |
| availability | uncond_std_PTS       |      6,612 | 0.99%   |     10 |
| availability | n_appearances        |      6,507 | 0.97%   |     11 |
| availability | OPP_DEF_FORM         |      6,401 | 0.95%   |     12 |
| minutes      | ewma_MIN             | 24,014,692 | 45.36%  |      1 |
| minutes      | depth_rank_available |  9,751,285 | 18.42%  |      2 |
| minutes      | roll3_MIN            |  6,606,315 | 12.48%  |      3 |
| minutes      | roll5_MIN            |  5,802,034 | 10.96%  |      4 |
| minutes      | roll10_MIN           |  1,120,741 | 2.12%   |      5 |
| minutes      | vacated_fga          |    608,555 | 1.15%   |      6 |
| minutes      | std_MIN              |    539,802 | 1.02%   |      7 |
| minutes      | days_since_last_app  |    441,575 | 0.83%   |      8 |
| minutes      | vacated_minutes      |    383,475 | 0.72%   |      9 |
| minutes      | vacated_minutes_pos  |    350,969 | 0.66%   |     10 |
| minutes      | vacated_usg          |    249,820 | 0.47%   |     11 |
| minutes      | roll3_PTS            |    210,262 | 0.40%   |     12 |

## A. Availability (all scheduled rows)


**Brier**

|                                        |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   O4 valid=2025-12 |   O5 valid=2026-01 |   mean |
|:---------------------------------------|-------------------:|-------------------:|-------------------:|-------------------:|-------------------:|-------:|
| LightGBM                               |             0.0741 |             0.0688 |             0.0794 |             0.0701 |             0.0626 | 0.0710 |
| logistic regression                    |             0.0983 |             0.0939 |             0.1038 |             0.0954 |             0.0828 | 0.0948 |
| baseline: shifted appearance rate (10) |             0.1163 |             0.1086 |             0.1202 |             0.1146 |             0.0963 | 0.1112 |
| baseline: global rate                  |             0.2067 |             0.2065 |             0.2041 |             0.2098 |             0.2088 | 0.2072 |

**LogLoss**

|                                        |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   O4 valid=2025-12 |   O5 valid=2026-01 |   mean |
|:---------------------------------------|-------------------:|-------------------:|-------------------:|-------------------:|-------------------:|-------:|
| LightGBM                               |             0.2640 |             0.2477 |             0.2798 |             0.2492 |             0.2290 | 0.2539 |
| logistic regression                    |             0.3372 |             0.3213 |             0.3529 |             0.3231 |             0.2917 | 0.3252 |
| baseline: shifted appearance rate (10) |             0.4589 |             0.4193 |             0.4635 |             0.4328 |             0.3832 | 0.4315 |
| baseline: global rate                  |             0.6040 |             0.6035 |             0.5984 |             0.6105 |             0.6084 | 0.6049 |

**BrierSkill**

|                                        |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   O4 valid=2025-12 |   O5 valid=2026-01 |    mean |
|:---------------------------------------|-------------------:|-------------------:|-------------------:|-------------------:|-------------------:|--------:|
| baseline: global rate                  |            -0.7782 |            -0.9019 |            -0.6986 |            -0.8303 |            -1.1684 | -0.8755 |
| baseline: shifted appearance rate (10) |             0.0000 |             0.0000 |             0.0000 |             0.0000 |             0.0000 |  0.0000 |
| logistic regression                    |             0.1549 |             0.1355 |             0.1364 |             0.1677 |             0.1405 |  0.1470 |
| LightGBM                               |             0.3627 |             0.3663 |             0.3391 |             0.3883 |             0.3495 |  0.3612 |

## B minutes|played - MAE

|                                 |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   O4 valid=2025-12 |   O5 valid=2026-01 |   mean |
|:--------------------------------|-------------------:|-------------------:|-------------------:|-------------------:|-------------------:|-------:|
| LightGBM                        |             4.5828 |             4.4131 |             4.6628 |             4.6169 |             4.4069 | 4.5365 |
| ridge                           |             4.6925 |             4.5199 |             4.7645 |             4.6999 |             4.5266 | 4.6407 |
| baseline: EWMA (halflife 5)     |             4.8104 |             4.7173 |             4.9629 |             4.9082 |             4.7197 | 4.8237 |
| baseline: expanding season mean |             4.9289 |             4.9791 |             5.3503 |             5.0999 |             4.9728 | 5.0662 |

Skill vs `ewma` (positive = less error)

|                                 |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   O4 valid=2025-12 |   O5 valid=2026-01 |    mean |
|:--------------------------------|-------------------:|-------------------:|-------------------:|-------------------:|-------------------:|--------:|
| baseline: expanding season mean |            -0.0246 |            -0.0555 |            -0.0781 |            -0.0391 |            -0.0536 | -0.0502 |
| baseline: EWMA (halflife 5)     |             0.0000 |             0.0000 |             0.0000 |             0.0000 |             0.0000 |  0.0000 |
| ridge                           |             0.0245 |             0.0419 |             0.0400 |             0.0424 |             0.0409 |  0.0379 |
| LightGBM                        |             0.0473 |             0.0645 |             0.0605 |             0.0593 |             0.0663 |  0.0596 |

## C1 pts|played - MAE

|                                 |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   O4 valid=2025-12 |   O5 valid=2026-01 |   mean |
|:--------------------------------|-------------------:|-------------------:|-------------------:|-------------------:|-------------------:|-------:|
| ridge                           |             4.5084 |             4.3741 |             4.5818 |             4.5467 |             4.3136 | 4.4649 |
| LightGBM                        |             4.5330 |             4.4117 |             4.5874 |             4.5274 |             4.3117 | 4.4742 |
| baseline: EWMA (halflife 5)     |             4.5727 |             4.4487 |             4.6870 |             4.6278 |             4.4054 | 4.5483 |
| baseline: expanding season mean |             4.5548 |             4.4841 |             4.7323 |             4.6488 |             4.4151 | 4.5670 |

Skill vs `ewma` (positive = less error)

|                                 |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   O4 valid=2025-12 |   O5 valid=2026-01 |    mean |
|:--------------------------------|-------------------:|-------------------:|-------------------:|-------------------:|-------------------:|--------:|
| baseline: expanding season mean |             0.0039 |            -0.0080 |            -0.0097 |            -0.0045 |            -0.0022 | -0.0041 |
| baseline: EWMA (halflife 5)     |             0.0000 |             0.0000 |             0.0000 |             0.0000 |             0.0000 |  0.0000 |
| LightGBM                        |             0.0087 |             0.0083 |             0.0212 |             0.0217 |             0.0213 |  0.0162 |
| ridge                           |             0.0141 |             0.0168 |             0.0224 |             0.0175 |             0.0208 |  0.0183 |

## C2 ast|played - MAE

|                                 |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   O4 valid=2025-12 |   O5 valid=2026-01 |   mean |
|:--------------------------------|-------------------:|-------------------:|-------------------:|-------------------:|-------------------:|-------:|
| ridge                           |             1.3180 |             1.3020 |             1.3242 |             1.3145 |             1.3039 | 1.3125 |
| LightGBM                        |             1.3290 |             1.3112 |             1.3312 |             1.3156 |             1.3019 | 1.3178 |
| baseline: EWMA (halflife 5)     |             1.3281 |             1.3225 |             1.3410 |             1.3233 |             1.3195 | 1.3269 |
| baseline: expanding season mean |             1.3331 |             1.3214 |             1.3489 |             1.3223 |             1.3221 | 1.3295 |

Skill vs `ewma` (positive = less error)

|                                 |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   O4 valid=2025-12 |   O5 valid=2026-01 |    mean |
|:--------------------------------|-------------------:|-------------------:|-------------------:|-------------------:|-------------------:|--------:|
| baseline: expanding season mean |            -0.0038 |             0.0009 |            -0.0059 |             0.0007 |            -0.0019 | -0.0020 |
| baseline: EWMA (halflife 5)     |             0.0000 |             0.0000 |             0.0000 |             0.0000 |             0.0000 |  0.0000 |
| LightGBM                        |            -0.0007 |             0.0086 |             0.0073 |             0.0058 |             0.0133 |  0.0069 |
| ridge                           |             0.0076 |             0.0155 |             0.0125 |             0.0066 |             0.0118 |  0.0108 |

## D pts UNCONDITIONAL - MAE

|                                                              |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   O4 valid=2025-12 |   O5 valid=2026-01 |   mean |
|:-------------------------------------------------------------|-------------------:|-------------------:|-------------------:|-------------------:|-------------------:|-------:|
| decomposed CHAMPION: P(play) x E[MIN|played] x EWMA[PTS/min] |             3.9863 |             3.8158 |             4.0751 |             3.9267 |             3.7521 | 3.9112 |
| decomposed: P(play) x LightGBM[PTS|played]                   |             4.0173 |             3.8622 |             4.0827 |             3.9501 |             3.7659 | 3.9356 |
| direct LightGBM on all scheduled rows                        |             4.0326 |             3.8900 |             4.1396 |             3.9635 |             3.7849 | 3.9621 |
| decomposed (demoted): P(play) x EWMA[PTS|played]             |             4.0581 |             3.8942 |             4.1576 |             4.0318 |             3.8397 | 3.9963 |
| naive: unconditional season mean (0 for misses)              |             4.4726 |             4.5073 |             4.9214 |             4.5741 |             4.3836 | 4.5718 |
| naive: conditional season mean (selection-biased)            |             5.5510 |             5.5196 |             5.7389 |             5.8379 |             5.6953 | 5.6686 |

Skill vs `naive_unconditional_mean` (positive = less error)

|                                                              |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   O4 valid=2025-12 |   O5 valid=2026-01 |    mean |
|:-------------------------------------------------------------|-------------------:|-------------------:|-------------------:|-------------------:|-------------------:|--------:|
| naive: conditional season mean (selection-biased)            |            -0.2411 |            -0.2246 |            -0.1661 |            -0.2763 |            -0.2992 | -0.2415 |
| naive: unconditional season mean (0 for misses)              |             0.0000 |             0.0000 |             0.0000 |             0.0000 |             0.0000 |  0.0000 |
| decomposed (demoted): P(play) x EWMA[PTS|played]             |             0.0927 |             0.1360 |             0.1552 |             0.1186 |             0.1241 |  0.1253 |
| direct LightGBM on all scheduled rows                        |             0.0984 |             0.1370 |             0.1589 |             0.1335 |             0.1366 |  0.1329 |
| decomposed: P(play) x LightGBM[PTS|played]                   |             0.1018 |             0.1431 |             0.1704 |             0.1364 |             0.1409 |  0.1385 |
| decomposed CHAMPION: P(play) x E[MIN|played] x EWMA[PTS/min] |             0.1087 |             0.1534 |             0.1720 |             0.1415 |             0.1441 |  0.1439 |

## Segment breakdown - MAE by minutes tier (mean over origins)


**B minutes|played**

|                                 |   star (>=30) |   starter (20-30) |   bench (10-20) |   fringe (<10) |   unknown (no history) |
|:--------------------------------|--------------:|------------------:|----------------:|---------------:|-----------------------:|
| baseline: EWMA (halflife 5)     |        3.8552 |            4.7916 |          5.7050 |         4.8990 |                16.7313 |
| baseline: expanding season mean |        4.0169 |            5.0955 |          5.9657 |         5.0951 |                16.7313 |
| LightGBM                        |        3.8140 |            4.5539 |          5.2080 |         4.5308 |                 4.1288 |
| ridge                           |        3.9789 |            4.6105 |          5.2845 |         4.7045 |                 5.0848 |

**C1 pts|played**

|                                 |   star (>=30) |   starter (20-30) |   bench (10-20) |   fringe (<10) |   unknown (no history) |
|:--------------------------------|--------------:|------------------:|----------------:|---------------:|-----------------------:|
| baseline: EWMA (halflife 5)     |        5.8900 |            4.7387 |          3.8107 |         2.5994 |                 8.7579 |
| baseline: expanding season mean |        5.8487 |            4.7637 |          3.8590 |         2.6763 |                 8.7579 |
| LightGBM                        |        5.7665 |            4.6685 |          3.7499 |         2.6561 |                 2.5376 |
| ridge                           |        5.7481 |            4.6699 |          3.7531 |         2.6059 |                 2.6095 |

**C2 ast|played**

|                                 |   star (>=30) |   starter (20-30) |   bench (10-20) |   fringe (<10) |   unknown (no history) |
|:--------------------------------|--------------:|------------------:|----------------:|---------------:|-----------------------:|
| baseline: EWMA (halflife 5)     |        1.7485 |            1.3957 |          1.0783 |         0.7305 |                 2.1660 |
| baseline: expanding season mean |        1.7421 |            1.3993 |          1.0873 |         0.7379 |                 2.1660 |
| LightGBM                        |        1.7507 |            1.3794 |          1.0613 |         0.7528 |                 0.7454 |
| ridge                           |        1.7370 |            1.3761 |          1.0673 |         0.7338 |                 0.7951 |

**D pts UNCONDITIONAL**

|                                                              |   star (>=30) |   starter (20-30) |   bench (10-20) |   fringe (<10) |   unknown (no history) |
|:-------------------------------------------------------------|--------------:|------------------:|----------------:|---------------:|-----------------------:|
| decomposed (demoted): P(play) x EWMA[PTS|played]             |        6.3255 |            4.6021 |          3.1722 |         1.4303 |                 0.7351 |
| decomposed: P(play) x LightGBM[PTS|played]                   |        6.2240 |            4.5449 |          3.1128 |         1.4844 |                 0.2483 |
| decomposed CHAMPION: P(play) x E[MIN|played] x EWMA[PTS/min] |        6.2868 |            4.5325 |          3.0455 |         1.3723 |                 0.2998 |
| direct LightGBM on all scheduled rows                        |        6.2876 |            4.5653 |          3.1139 |         1.5029 |                 0.3198 |
| naive: conditional season mean (selection-biased)            |        8.1677 |            6.1534 |          4.3912 |         2.5545 |                10.6560 |
| naive: unconditional season mean (0 for misses)              |        7.2976 |            5.3909 |          3.5209 |         1.5676 |                 0.2875 |

**A availability - Brier**

|                                        |   star (>=30) |   starter (20-30) |   bench (10-20) |   fringe (<10) |   unknown (no history) |
|:---------------------------------------|--------------:|------------------:|----------------:|---------------:|-----------------------:|
| baseline: global rate                  |        0.1650 |            0.1721 |          0.1960 |         0.3073 |                 0.4997 |
| LightGBM                               |        0.0665 |            0.0671 |          0.0658 |         0.0993 |                 0.0327 |
| logistic regression                    |        0.0837 |            0.0925 |          0.0912 |         0.1293 |                 0.0396 |
| baseline: shifted appearance rate (10) |        0.0938 |            0.1122 |          0.1098 |         0.1469 |                 0.0400 |

## Event-cohort breakdown (mean over origins)

Two events and one control, defined in `config.EVENT_COHORTS`. The teammate features are supposed to help on the first two and change nothing on the third; a family that improves high-absence games at the cost of quiet ones has not helped.


**A availability - Brier**

|                                        |   event: vacated_minutes >= 30 |   event: star_out = 1 |   control: vacated_minutes < 5 |
|:---------------------------------------|-------------------------------:|----------------------:|-------------------------------:|
| baseline: global rate                  |                         0.2034 |                0.2013 |                         0.2880 |
| LightGBM                               |                         0.0748 |                0.0750 |                         0.0515 |
| logistic regression                    |                         0.0986 |                0.1022 |                         0.0802 |
| baseline: shifted appearance rate (10) |                         0.1167 |                0.1232 |                         0.0939 |

**B minutes|played - MAE**

|                                 |   event: vacated_minutes >= 30 |   event: star_out = 1 |   control: vacated_minutes < 5 |
|:--------------------------------|-------------------------------:|----------------------:|-------------------------------:|
| baseline: EWMA (halflife 5)     |                         4.8747 |                5.3123 |                         4.4641 |
| baseline: expanding season mean |                         5.1354 |                5.7144 |                         4.5724 |
| LightGBM                        |                         4.5839 |                4.9234 |                         4.2081 |
| ridge                           |                         4.6651 |                4.9912 |                         4.5691 |

**C1 pts|played - MAE**

|                                 |   event: vacated_minutes >= 30 |   event: star_out = 1 |   control: vacated_minutes < 5 |
|:--------------------------------|-------------------------------:|----------------------:|-------------------------------:|
| baseline: EWMA (halflife 5)     |                         4.5410 |                4.6733 |                         4.4558 |
| baseline: expanding season mean |                         4.5675 |                4.7268 |                         4.3899 |
| LightGBM                        |                         4.4956 |                4.6676 |                         4.2528 |
| ridge                           |                         4.4850 |                4.6410 |                         4.2357 |

**C2 ast|played - MAE**

|                                 |   event: vacated_minutes >= 30 |   event: star_out = 1 |   control: vacated_minutes < 5 |
|:--------------------------------|-------------------------------:|----------------------:|-------------------------------:|
| baseline: EWMA (halflife 5)     |                         1.3300 |                1.3683 |                         1.3556 |
| baseline: expanding season mean |                         1.3348 |                1.3898 |                         1.3861 |
| LightGBM                        |                         1.3289 |                1.3882 |                         1.3349 |
| ridge                           |                         1.3231 |                1.3880 |                         1.3541 |

**D pts UNCONDITIONAL - MAE**

|                                                              |   event: vacated_minutes >= 30 |   event: star_out = 1 |   control: vacated_minutes < 5 |
|:-------------------------------------------------------------|-------------------------------:|----------------------:|-------------------------------:|
| decomposed (demoted): P(play) x EWMA[PTS|played]             |                         4.1010 |                4.2197 |                         3.0474 |
| decomposed: P(play) x LightGBM[PTS|played]                   |                         4.0579 |                4.2054 |                         2.9661 |
| decomposed CHAMPION: P(play) x E[MIN|played] x EWMA[PTS/min] |                         4.0249 |                4.1526 |                         2.9696 |
| direct LightGBM on all scheduled rows                        |                         4.0873 |                4.2283 |                         2.9996 |
| naive: conditional season mean (selection-biased)            |                         5.7271 |                5.6570 |                         5.6872 |
| naive: unconditional season mean (0 for misses)              |                         4.7036 |                4.8641 |                         3.8002 |

## Interval coverage - nominal 80%

| task             |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   O4 valid=2025-12 |   O5 valid=2026-01 |   mean |
|:-----------------|-------------------:|-------------------:|-------------------:|-------------------:|-------------------:|-------:|
| B minutes|played |             0.8292 |             0.8335 |             0.8098 |             0.8215 |             0.8337 | 0.8256 |
| C1 pts|played    |             0.8116 |             0.8164 |             0.7946 |             0.8029 |             0.8188 | 0.8089 |
| C2 ast|played    |             0.8012 |             0.8043 |             0.7935 |             0.8095 |             0.8140 | 0.8045 |

Intervals are empirical residual quantiles of the champion estimate, fitted on the training window only.

## Segment support (validation rows per cohort, summed over origins)

| segment                      |     n |
|:-----------------------------|------:|
| star (>=30)                  |  6958 |
| starter (20-30)              |  9940 |
| bench (10-20)                |  8177 |
| fringe (<10)                 |  5058 |
| unknown (no history)         |   784 |
| event: vacated_minutes >= 30 | 23231 |
| event: star_out = 1          |  7219 |
| control: vacated_minutes < 5 |   955 |

The tiers partition the rows; the event cohorts do not (a bench player on a high-absence night is in two of them, and the two `vacated_minutes` cohorts are disjoint but do not cover the 5-30 middle).
