# October replay gate — 20260818

generated 2026-08-18 01:34 UTC · protocol `prospective_2026_27_v1` · acceptance criteria frozen in MODEL.md 13.7

## The known limitation

**October 2025 is inside artifact 20260818's training window (2022-10-18 -> 2026-04-12). These October numbers are IN-SAMPLE and their absolute level is optimistic.** The gate is survivable anyway because every criterion is a RATIO against non-October rows drawn from the same season, fitted by the same model, contaminated the same way -- a uniform in-sample optimism divides out of a ratio and does not divide out of a level. The residual risk it cannot rule out is a NON-uniform optimism, i.e. the model overfitting its October rows harder than its March rows, which would make the ratio too kind. A PASS therefore reads as "no October-shaped catastrophe is visible", not as "October 2026 will look like this". Refitting to a pre-October cutoff was rejected: MODEL.md 13.7 criterion 4 requires the pinned checksums, and a replay against a differently-trained artifact measures that artifact.

## Verdict

**GATE PASSED — all four criteria met**

| criterion | observed | | bar | verdict |
|---|---:|:-:|---:|:-:|
| 1. prediction coverage | 1.0000 | >= | 0.9900 | PASS |
| 2. October / non-October Brier | 1.0633 | <= | 1.4200 | PASS |
| 3. October / non-October minutes MAE | 1.0097 | <= | 1.1500 | PASS |
| 4. pinned checksums | all 6 files match | = | frozen set | PASS |

## Supporting numbers

| | October | non-October |
|---|---:|---:|
| window | 2025-10-01 .. 2025-10-31 | 2025-11-01 .. 2026-04-12 |
| scheduled rows | 2,429 | 35,212 |
| scored rows | 2,429 | 35,212 |
| appearance rows | 1,791 | 24,810 |
| played rate | 0.7373 | 0.7046 |
| availability Brier (IN-SAMPLE) | 0.0701 | 0.0659 |
| minutes MAE (IN-SAMPLE) | 4.5718 | 4.5277 |
| insufficient_history share | 0.1272 | 0.0383 |
| cross-fit fallback share | 0.0000 | 0.0000 |
| distinct players | 514 | 601 |

The two shares are the ones criterion 1 requires beside coverage: a replay that silently drops the rows it finds hard is measuring the wrong month, so the hard rows are counted rather than excluded.

## Cohort split (the frozen minutes tiers)

| cohort               |   oct_rows |   rest_rows |   oct_brier |   rest_brier |   brier_ratio |   oct_min_mae |   rest_min_mae |   min_mae_ratio |
|:---------------------|-----------:|------------:|------------:|-------------:|--------------:|--------------:|---------------:|----------------:|
| ALL                  |       2429 |       35212 |      0.0701 |       0.0659 |        1.0633 |        4.5718 |         4.5277 |          1.0097 |
| bench (10-20)        |        526 |        9067 |      0.0539 |       0.0590 |        0.9143 |        4.8880 |         5.1252 |          0.9537 |
| fringe (<10)         |        261 |        5399 |      0.0948 |       0.0919 |        1.0320 |        4.4748 |         4.8711 |          0.9187 |
| star (>=30)          |        556 |        7045 |      0.0461 |       0.0618 |        0.7452 |        4.0882 |         3.7874 |          1.0794 |
| starter (20-30)      |        891 |       12928 |      0.0744 |       0.0635 |        1.1724 |        4.5787 |         4.4264 |          1.0344 |
| unknown (no history) |        195 |         773 |      0.1290 |       0.0429 |        3.0036 |        6.1842 |         4.6739 |          1.3231 |
