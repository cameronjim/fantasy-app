# Rolling-origin evaluation - spike-parity

- **generated_at**: 2026-08-16 23:59 UTC
- **dataset**: C:\Users\CJ\code\fantasy-app\ml\data\spike_dataset.parquet
- **universe_source**: approximation
- **rows**: 79,406
- **players**: 694
- **played_rate**: 0.6638
- **feature_version**: v1
- **git_commit**: 9e94dbdc1bac2c8fae2730588f811d2f8557daac

> **BIASED UNIVERSE.** built from the +/-15 day game-log-presence approximation, not from `player_game_status`. availability is over-stated and absence streaks are capped near 16 team-games (REPORT.md section 5). these numbers are a port-fidelity check, not a production estimate.

## Champion selection

| task             | family       | metric   | measured_best   |   measured_value | configured_champion   |   configured_value | matches_config   |
|:-----------------|:-------------|:---------|:----------------|-----------------:|:----------------------|-------------------:|:-----------------|
| A availability   | availability | Brier    | lightgbm        |           0.1373 | lightgbm              |             0.1373 | True             |
| B minutes|played | minutes      | MAE      | lightgbm        |           4.7616 | ewma                  |             4.8213 | False            |
| C1 pts|played    | production   | MAE      | ridge           |           4.5203 | ewma                  |             4.5664 | False            |
| C2 ast|played    | production   | MAE      | ridge           |           1.3148 | ewma                  |             1.3301 | False            |

Measured winner differs from the configured champion for: B minutes|played, C1 pts|played, C2 ast|played. Config is deliberate - see `config.CHAMPIONS` and REPORT.md section 6.

## A. Availability (all scheduled rows)


**Brier**

|                                        |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   mean |
|:---------------------------------------|-------------------:|-------------------:|-------------------:|-------:|
| LightGBM                               |             0.1342 |             0.1365 |             0.1412 | 0.1373 |
| logistic regression                    |             0.1531 |             0.1540 |             0.1621 | 0.1564 |
| baseline: shifted appearance rate (10) |             0.1769 |             0.1710 |             0.1829 | 0.1769 |
| baseline: global rate                  |             0.2195 |             0.2239 |             0.2353 | 0.2262 |

**LogLoss**

|                                        |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   mean |
|:---------------------------------------|-------------------:|-------------------:|-------------------:|-------:|
| LightGBM                               |             0.4247 |             0.4290 |             0.4404 | 0.4314 |
| logistic regression                    |             0.4778 |             0.4807 |             0.5030 | 0.4872 |
| baseline: shifted appearance rate (10) |             0.6336 |             0.6139 |             0.6365 | 0.6280 |
| baseline: global rate                  |             0.6309 |             0.6400 |             0.6637 | 0.6448 |

**BrierSkill**

|                                        |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |    mean |
|:---------------------------------------|-------------------:|-------------------:|-------------------:|--------:|
| baseline: global rate                  |            -0.2412 |            -0.3089 |            -0.2864 | -0.2788 |
| baseline: shifted appearance rate (10) |             0.0000 |             0.0000 |             0.0000 |  0.0000 |
| logistic regression                    |             0.1343 |             0.0996 |             0.1134 |  0.1158 |
| LightGBM                               |             0.2413 |             0.2019 |             0.2282 |  0.2238 |

## B minutes|played - MAE

|                                 |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   mean |
|:--------------------------------|-------------------:|-------------------:|-------------------:|-------:|
| LightGBM                        |             4.7585 |             4.6459 |             4.8803 | 4.7616 |
| ridge                           |             4.7901 |             4.6388 |             4.9100 | 4.7796 |
| baseline: EWMA (halflife 5)     |             4.7994 |             4.7037 |             4.9607 | 4.8213 |
| baseline: expanding season mean |             4.9242 |             4.9823 |             5.3499 | 5.0855 |

Skill vs `ewma` (positive = less error)

|                                 |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |    mean |
|:--------------------------------|-------------------:|-------------------:|-------------------:|--------:|
| baseline: expanding season mean |            -0.0260 |            -0.0592 |            -0.0785 | -0.0546 |
| baseline: EWMA (halflife 5)     |             0.0000 |             0.0000 |             0.0000 |  0.0000 |
| ridge                           |             0.0019 |             0.0138 |             0.0102 |  0.0087 |
| LightGBM                        |             0.0085 |             0.0123 |             0.0162 |  0.0123 |

## C1 pts|played - MAE

|                                 |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   mean |
|:--------------------------------|-------------------:|-------------------:|-------------------:|-------:|
| ridge                           |             4.5415 |             4.4066 |             4.6129 | 4.5203 |
| LightGBM                        |             4.5531 |             4.4563 |             4.6690 | 4.5595 |
| baseline: EWMA (halflife 5)     |             4.5713 |             4.4405 |             4.6876 | 4.5664 |
| baseline: expanding season mean |             4.5553 |             4.4872 |             4.7319 | 4.5914 |

Skill vs `ewma` (positive = less error)

|                                 |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |    mean |
|:--------------------------------|-------------------:|-------------------:|-------------------:|--------:|
| baseline: expanding season mean |             0.0035 |            -0.0105 |            -0.0095 | -0.0055 |
| baseline: EWMA (halflife 5)     |             0.0000 |             0.0000 |             0.0000 |  0.0000 |
| LightGBM                        |             0.0040 |            -0.0036 |             0.0040 |  0.0015 |
| ridge                           |             0.0065 |             0.0076 |             0.0159 |  0.0100 |

## C2 ast|played - MAE

|                                 |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   mean |
|:--------------------------------|-------------------:|-------------------:|-------------------:|-------:|
| ridge                           |             1.3171 |             1.3049 |             1.3224 | 1.3148 |
| baseline: EWMA (halflife 5)     |             1.3275 |             1.3216 |             1.3412 | 1.3301 |
| baseline: expanding season mean |             1.3326 |             1.3214 |             1.3490 | 1.3343 |
| LightGBM                        |             1.3335 |             1.3317 |             1.3460 | 1.3371 |

Skill vs `ewma` (positive = less error)

|                                 |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |    mean |
|:--------------------------------|-------------------:|-------------------:|-------------------:|--------:|
| LightGBM                        |            -0.0045 |            -0.0076 |            -0.0036 | -0.0053 |
| baseline: expanding season mean |            -0.0038 |             0.0002 |            -0.0058 | -0.0032 |
| baseline: EWMA (halflife 5)     |             0.0000 |             0.0000 |             0.0000 |  0.0000 |
| ridge                           |             0.0078 |             0.0126 |             0.0140 |  0.0115 |

## D pts UNCONDITIONAL - MAE

|                                                     |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   mean |
|:----------------------------------------------------|-------------------:|-------------------:|-------------------:|-------:|
| decomposed: P(play) x LightGBM[PTS|played]          |             4.1890 |             4.1249 |             4.1903 | 4.1681 |
| decomposed CHAMPION: P(play) x EWMA[PTS|played]     |             4.2131 |             4.1135 |             4.1889 | 4.1719 |
| decomposed: P(play) x E[MIN|played] x prior PTS/min |             4.2269 |             4.1116 |             4.1990 | 4.1792 |
| direct LightGBM on all scheduled rows               |             4.2027 |             4.1461 |             4.2377 | 4.1955 |
| naive: unconditional season mean (0 for misses)     |             4.5686 |             4.5457 |             4.7877 | 4.6340 |
| naive: conditional season mean (selection-biased)   |             5.1160 |             5.2348 |             5.5276 | 5.2928 |

Skill vs `naive_unconditional_mean` (positive = less error)

|                                                     |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |    mean |
|:----------------------------------------------------|-------------------:|-------------------:|-------------------:|--------:|
| naive: conditional season mean (selection-biased)   |            -0.1198 |            -0.1516 |            -0.1545 | -0.1420 |
| naive: unconditional season mean (0 for misses)     |             0.0000 |             0.0000 |             0.0000 |  0.0000 |
| direct LightGBM on all scheduled rows               |             0.0801 |             0.0879 |             0.1149 |  0.0943 |
| decomposed: P(play) x E[MIN|played] x prior PTS/min |             0.0748 |             0.0955 |             0.1230 |  0.0978 |
| decomposed CHAMPION: P(play) x EWMA[PTS|played]     |             0.0778 |             0.0951 |             0.1251 |  0.0993 |
| decomposed: P(play) x LightGBM[PTS|played]          |             0.0831 |             0.0926 |             0.1248 |  0.1001 |

## Segment breakdown - MAE by minutes tier (mean over origins)


**B minutes|played**

|                                 |   star (>=30) |   starter (20-30) |   bench (10-20) |   fringe (<10) |   unknown (no history) |
|:--------------------------------|--------------:|------------------:|----------------:|---------------:|-----------------------:|
| baseline: EWMA (halflife 5)     |        3.8744 |            4.8830 |          5.6763 |         4.6745 |                14.8482 |
| baseline: expanding season mean |        4.0729 |            5.2092 |          5.9432 |         4.9226 |                14.8482 |
| LightGBM                        |        3.9219 |            4.7659 |          5.5518 |         4.8214 |                 5.6720 |
| ridge                           |        3.9614 |            4.7734 |          5.5548 |         4.8211 |                 7.8501 |

**C1 pts|played**

|                                 |   star (>=30) |   starter (20-30) |   bench (10-20) |   fringe (<10) |   unknown (no history) |
|:--------------------------------|--------------:|------------------:|----------------:|---------------:|-----------------------:|
| baseline: EWMA (halflife 5)     |        5.9100 |            4.7784 |          3.8172 |         2.5285 |                 8.7633 |
| baseline: expanding season mean |        5.8491 |            4.8230 |          3.8792 |         2.6142 |                 8.7633 |
| LightGBM                        |        5.9129 |            4.7415 |          3.8054 |         2.6723 |                 3.6483 |
| ridge                           |        5.7983 |            4.7342 |          3.8091 |         2.5904 |                 5.1432 |

**C2 ast|played**

|                                 |   star (>=30) |   starter (20-30) |   bench (10-20) |   fringe (<10) |   unknown (no history) |
|:--------------------------------|--------------:|------------------:|----------------:|---------------:|-----------------------:|
| baseline: EWMA (halflife 5)     |        1.7626 |            1.3898 |          1.0920 |         0.7027 |                 2.1381 |
| baseline: expanding season mean |        1.7584 |            1.3958 |          1.1014 |         0.7115 |                 2.1381 |
| LightGBM                        |        1.8060 |            1.3768 |          1.0821 |         0.7462 |                 0.7746 |
| ridge                           |        1.7441 |            1.3675 |          1.0809 |         0.7207 |                 1.2295 |

**D pts UNCONDITIONAL**

|                                                     |   star (>=30) |   starter (20-30) |   bench (10-20) |   fringe (<10) |   unknown (no history) |
|:----------------------------------------------------|--------------:|------------------:|----------------:|---------------:|-----------------------:|
| decomposed CHAMPION: P(play) x EWMA[PTS|played]     |        7.0756 |            4.9726 |          3.3277 |         1.3543 |                 1.8470 |
| decomposed: P(play) x LightGBM[PTS|played]          |        7.0478 |            4.9359 |          3.3151 |         1.4765 |                 0.7983 |
| decomposed: P(play) x E[MIN|played] x prior PTS/min |        7.1330 |            4.9777 |          3.2914 |         1.4106 |                 0.9222 |
| direct LightGBM on all scheduled rows               |        7.1479 |            4.9762 |          3.3095 |         1.4536 |                 0.8946 |
| naive: conditional season mean (selection-biased)   |        8.1916 |            6.1448 |          4.3656 |         2.2201 |                10.3597 |
| naive: unconditional season mean (0 for misses)     |        7.8617 |            5.6755 |          3.6280 |         1.4165 |                 1.3922 |

## Interval coverage - nominal 80%

| task             |   O1 valid=2024-12 |   O2 valid=2025-01 |   O3 valid=2025-02 |   mean |
|:-----------------|-------------------:|-------------------:|-------------------:|-------:|
| B minutes|played |             0.8300 |             0.8312 |             0.8066 | 0.8226 |
| C1 pts|played    |             0.8113 |             0.8167 |             0.7941 | 0.8073 |
| C2 ast|played    |             0.8130 |             0.8118 |             0.8018 | 0.8089 |

Intervals are empirical residual quantiles of the champion estimate, fitted on the training window only.

## Segment support (validation rows per tier, summed over origins)

| segment              |    n |
|:---------------------|-----:|
| star (>=30)          | 4152 |
| starter (20-30)      | 5531 |
| bench (10-20)        | 5413 |
| fringe (<10)         | 4085 |
| unknown (no history) |  174 |
