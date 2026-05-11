# FastRW Experiment Notes

Date: 2026-05-11

These notes are the working record for the rerun setup. The paper text is intentionally left for a later editing pass.

## Current Case Set

- Case 1: `case1_power6`, geometry `500/100/500 um`, power map `power6`, `h=8700`.
- Case 2: `case2_4core_top1_bottom1`, geometry `1000/100/1000 um`, power map `4-core`, `h=8700`.
- Case 3: `case3_16core`, geometry `500/100/1000 um`, power map `16-core`, `h=4900`.

Case 2 is the renamed previous 4-core top/bottom 1 mm setup. The old paper Case 2 is removed from the active repo setup.

## Locked Numerical Settings

- Temperature storage unit: Celsius for all cleaned `data/cases/**/temp.bin` files and random-walk CSV outputs.
- `walker.delta_x = 5e-7`.
- `boundary.strip_ratio = 1.56`.
- `boundary.epsilon.neumann = boundary.epsilon.robin = 7.8e-7`.
- Seed: `42`.
- Main backend: Metal.
- CPU backend: build/smoke validation only.
- PIRW: no tail correction, `Lambda=1e-4`, `1000` paths for full rerun.
- FastRW: default prior `comso_12500`, `Lambda=0.03`, `400` paths for full rerun.
- Weak-prior experiment: uniform average-temperature prior, `Lambda=0.001`.

## Active Data Layout

Canonical inputs now live under `data/cases/<case>/`.

- `power.bin`: power per heat-layer cell.
- `comsol/comso_<dof>/temp.bin`: COMSOL prior/reference temperature field in Celsius.
- `comsol/comso_<dof>/metadata.json`: source and mesh metadata where available.

Current power totals:

- Case 1: `174 W`.
- Case 2: `356 W`.
- Case 3: `352 W`.

Current COMSOL fields:

- Case 1: `comso_1875`, `comso_4800`, `comso_12500`, `comso_32000`, `comso_86247`, `comso_full`.
- Case 2: `comso_1875`, `comso_4800`, `comso_12500`, `comso_32000`, `comso_86247`, `comso_full`.
- Case 3: `comso_1875`, `comso_4800`, `comso_12500`, `comso_full`.

Case 3 still lacks `comso_32000` and `comso_86247` unless we decide to generate or map additional approximate priors.

## Config And Output Contract

Active configs are:

- `configs/case1_power6.json`
- `configs/case2_4core_top1_bottom1.json`
- `configs/case3_16core.json`
- `configs/pirw_case1_power6.json`
- `configs/pirw_case2_4core_top1_bottom1.json`
- `configs/pirw_case3_16core.json`

Each FastRW/PIRW run writes:

- `direct.csv`
- `FastRw.csv` compatibility alias
- `constraints.json`
- `onestage_with_self.csv`
- `onestage_no_self.csv`
- `summary.json`

`constraints.json` records `self_constraints` and `pass_overflow_paths`. Metal pass overflow remains a warning, not a hard failure.

## Work Completed

- Split temperature inputs into `prior_temperature_path` and `reference_temperature_path`.
- Tail correction now uses the prior field; CSV/error reporting uses the reference field.
- Added explicit `boundary.strip_ratio`; Neumann and Robin epsilons are derived from `strip_ratio * delta_x`.
- Added Onestage post-processing script and integrated it into CPU/Metal runners.
- Removed active HBMmodel workflow and obsolete rho/root-cause/validation scripts from the repo.
- Migrated reusable data to `data/cases`.
- Moved old top-level data to `/Users/zxwang/Projects/ResRW_data_archive_20260511/`.
- Cleared old `outputs/`, generated smoke outputs for validation, recorded the summary below, then cleared `outputs/` again.

## COMSOL Notes

Case 2 rough prior fields were generated locally with `/Applications/COMSOL62/Multiphysics/bin/comsol`.

Observed solution DoFs from logs:

- `comso_1875`: `48666`.
- `comso_4800`: `144851`.
- `comso_12500`: `480945`.
- `comso_32000`: `2164400`.
- `comso_86247`: `2139473`.
- `comso_full`: `3315624`.

The directory labels remain the intended prior levels for experiment bookkeeping; metadata records the actual COMSOL solve DoFs.

## Smoke Results

Build checks passed:

- CPU target: `random_walker`.
- Metal target: `random_walker_metal`.

Metal `N=2` FastRW smoke passed for all three cases and produced `direct.csv`, `constraints.json`, both Onestage CSVs, and `summary.json`.

Smoke summary:

| Case | K constraints | Self constraints | Pass overflow | Direct avg abs error | With-self avg abs error | No-self avg abs error |
|---|---:|---:|---:|---:|---:|---:|
| Case 1 | 61 | 5 | 0 | 7.1315 | 8.1786 | 8.2717 |
| Case 2 | 34 | 0 | 0 | 7.2491 | 7.8699 | 7.8699 |
| Case 3 | 88 | 9 | 0 | 8.5611 | 7.1483 | 7.2396 |

These are only smoke checks with `N=2`; they are not paper results.

## Remaining Rerun Work

- Investigate Onestage fusion before using fused values in the paper; first full main-table run shows fusion worse than direct.
- Run residual identity figure.
- Run path convergence figure.
- Run Case 1 group-size fusion table for group sizes `1, 4, 16`.
- Run runtime breakdown table.
- Run prior-accuracy tradeoff with all available `comso_<dof>` priors.
- Generate weak-prior fields and run weak-prior table.
- Decide whether to generate missing Case 3 `comso_32000` and `comso_86247`.
- Update the paper after results are stable.

## Full Main-Table Run 1

Command:

```bash
./scripts/run_paper_experiments.js full
```

Outputs:

- `outputs/main_table_summary.csv`
- `outputs/<case>/pirw/*`
- `outputs/<case>/fastrw/*`

Summary:

| Case | Method | Runtime (s) | Avg steps | Direct avg abs error | With-self avg abs error | No-self avg abs error | Pass overflow |
|---|---|---:|---:|---:|---:|---:|---:|
| Case 1 | PIRW | 194.086 | 5.985e6 | 0.4242 | 1.0016 | 1.0498 | 0 |
| Case 1 | FastRW | 30.291 | 2.284e6 | 0.6503 | 1.5237 | 1.5637 | 0 |
| Case 2 | PIRW | 198.420 | 5.997e6 | 0.6049 | 1.0575 | 1.0453 | 0 |
| Case 2 | FastRW | 30.429 | 2.293e6 | 0.6209 | 1.2989 | 1.3093 | 0 |
| Case 3 | PIRW | 350.635 | 1.063e7 | 0.3637 | 0.7595 | 0.7892 | 0 |
| Case 3 | FastRW | 53.137 | 4.055e6 | 0.5714 | 1.1144 | 1.1580 | 0 |

Immediate observations:

- FastRW direct path length is consistently about `38%` of PIRW.
- FastRW direct runtime is about `6.4x`, `6.5x`, and `6.6x` faster than PIRW for Cases 1/2/3 in this run.
- Direct errors are sub-kelvin for all rows.
- Current Onestage post-processing worsens the average absolute error for every row. Do not use fused values in paper tables until this is diagnosed.

## Direct FastRW vs PIRW Error Check

Question: why is direct FastRW slightly worse than PIRW in the first full main-table run?

Evidence from `constraints.json` sample data:

| Case | Method | N | Avg sample std | Avg standard error | Predicted avg abs error if unbiased | Observed avg abs error | RMS z-score | Points with \|z\| > 2 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Case 1 | PIRW | 1000 | 14.671 | 0.464 | 0.370 | 0.424 | 1.089 | 1 |
| Case 1 | FastRW | 400 | 14.796 | 0.740 | 0.590 | 0.650 | 1.022 | 1 |
| Case 2 | PIRW | 1000 | 16.946 | 0.536 | 0.428 | 0.605 | 1.391 | 2 |
| Case 2 | FastRW | 400 | 16.729 | 0.836 | 0.667 | 0.621 | 0.999 | 1 |
| Case 3 | PIRW | 1000 | 15.332 | 0.485 | 0.387 | 0.364 | 0.993 | 1 |
| Case 3 | FastRW | 400 | 15.224 | 0.761 | 0.607 | 0.571 | 0.929 | 0 |

Interpretation:

- FastRW and PIRW have almost the same per-path sample standard deviation in all three cases.
- FastRW uses `400` paths and PIRW uses `1000`, so FastRW standard error should be about `sqrt(1000/400)=1.58x` larger. The measured standard-error ratios are `1.59`, `1.56`, and `1.57`.
- Observed direct errors are close to the predicted Monte Carlo error scale. RMS z-scores are near `1`, so the direct FastRW error does not look like a solver bug.

Prior-vs-reference check for the default `comso_12500` prior:

| Case | Prior avg abs error | Prior max abs error | `0.03 * max_abs` tail-bias bound |
|---|---:|---:|---:|
| Case 1 | 0.0202 | 0.0886 | 0.0027 |
| Case 2 | 0.1327 | 0.3779 | 0.0113 |
| Case 3 | 0.1441 | 0.4387 | 0.0132 |

The prior-induced threshold bias bound is much smaller than the current Monte Carlo standard errors (`0.74`, `0.84`, `0.76` for FastRW), so the direct FastRW deficit is dominated by path count, not by prior error.

Rough path counts needed for FastRW direct to match the observed PIRW average absolute error, using current sample standard deviations:

| Case | FastRW paths needed | Estimated FastRW runtime | Speedup vs PIRW |
|---|---:|---:|---:|
| Case 1 | 774 | 58.6 s | 3.31x |
| Case 2 | 487 | 37.0 s | 5.36x |
| Case 3 | 1115 | 148.1 s | 2.37x |

Conclusion: direct FastRW is currently less accurate mainly because it uses fewer paths. The direct solver looks statistically consistent. The separate problem is Onestage fusion, which should have compensated for the smaller path count but currently worsens the estimate.

## Coarse Prior Runtime And Error

Errors are computed against each case's `comso_full/temp.bin`. Temperature fields are stored in Celsius, so temperature-difference magnitudes are numerically the same in K.

Runtime source:

- Case 1: archived `power_6_meshes/mesh_information.txt`.
- Case 2: generated COMSOL `comsol_batch.log` class runtime.
- Case 3: archived runtime for the reused approximate 16-core priors.

| Case | Prior | Runtime (s) | Max abs error | Avg abs error | RMSE |
|---|---|---:|---:|---:|---:|
| Case 1 | `comso_1875` | 2 | 1.9319 | 0.5749 | 0.6223 |
| Case 1 | `comso_4800` | 2 | 0.8850 | 0.2261 | 0.2646 |
| Case 1 | `comso_12500` | 4 | 0.0886 | 0.0202 | 0.0245 |
| Case 1 | `comso_32000` | 9 | 0.2268 | 0.0413 | 0.0529 |
| Case 1 | `comso_86247` | 17 | 0.3566 | 0.1101 | 0.1338 |
| Case 2 | `comso_1875` | 16 | 1.7292 | 0.8943 | 0.9112 |
| Case 2 | `comso_4800` | 17 | 0.5760 | 0.2556 | 0.2642 |
| Case 2 | `comso_12500` | 24 | 0.3779 | 0.1327 | 0.1470 |
| Case 2 | `comso_32000` | 54 | 0.1386 | 0.0342 | 0.0405 |
| Case 2 | `comso_86247` | 70 | 0.0812 | 0.0260 | 0.0283 |
| Case 3 | `comso_1875` | 1 | 0.3741 | 0.0948 | 0.1125 |
| Case 3 | `comso_4800` | 2 | 0.0714 | 0.0109 | 0.0141 |
| Case 3 | `comso_12500` | 3 | 0.4387 | 0.1441 | 0.1780 |

Case 3 currently only has three reused approximate priors. Case 1 and Case 3 errors are not perfectly monotone in the directory labels because several fields are reused or mapped from approximate existing meshes rather than generated from a single monotone COMSOL sweep.

## Fusion Diagnostics 1

Command:

```bash
node scripts/diagnose_fusion_constraints.js
```

Outputs:

- `outputs/fusion_diagnostics/summary.csv`
- `outputs/fusion_diagnostics/residual_bins.csv`
- `outputs/fusion_diagnostics/pair_stats.csv`
- `outputs/fusion_diagnostics/weight_sweep.csv`
- `outputs/fusion_diagnostics/diagnostics.md`

The diagnostic checks each pass-through constraint against the reference temperature:

```text
residual = b_k - (T_ref[i_k] - alpha_k * T_ref[j_k])
```

Summary:

| Case | Method | K | Self | Direct avg abs error | Current with-self | Current no-self | Constraint residual MAE | Residual abs95 |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| Case 1 | FastRW | 13097 | 1102 | 0.6503 | 1.5237 | 1.5637 | 10.7257 | 25.6287 |
| Case 1 | PIRW | 64698 | 4734 | 0.4242 | 1.0016 | 1.0498 | 11.3051 | 26.8198 |
| Case 2 | FastRW | 10143 | 757 | 0.6209 | 1.2989 | 1.3093 | 12.4520 | 31.6196 |
| Case 2 | PIRW | 55369 | 3779 | 0.6049 | 1.0575 | 1.0453 | 13.0942 | 32.4397 |
| Case 3 | FastRW | 16629 | 1163 | 0.5714 | 1.1144 | 1.1580 | 10.0816 | 25.4843 |
| Case 3 | PIRW | 94814 | 6197 | 0.3637 | 0.7595 | 0.7892 | 11.3044 | 28.3353 |

Best nonzero WLS weight sweeps use `constraint_scale = 0.0001` and produce essentially the direct result. Full current weight `constraint_scale = 1` is consistently worse. Removing self constraints does not fix the problem.

Current interpretation: the pass-through equations are not usable as many independent Gaussian constraints. Individual residuals have roughly the expected large single-sample scale, but their count is huge and the implementation treats same-run, same-path-derived constraints as independent from each other and from the direct estimates. The next diagnostic should record path/sample IDs and step counts for constraints so we can estimate effective sample size and covariance.

A quick pair-mean check, where each `(i,j)` pair is collapsed to one average constraint and then fused at full weight, still did not beat direct. It reduced the damage but did not create a useful gain, so the issue is not only duplicate counting of identical pairs.

## Fusion Diagnostics 2: Path Metadata

Change:

- `constraints.json` now records `constraint_schema_version = 2`.
- Existing fields are preserved: `i_k`, `j_k`, `alpha_k`, `b_k`, `obs_data`.
- New fields:
  - `sample_k`: 1-based source sample/path index.
  - `step_k`: path step count at pass-through recording.
  - `record_k`: 1-based record order within that source path.

Validation:

- CPU and Metal targets both build.
- Metal `N=2` smoke writes non-empty path metadata and old Onestage still runs.
- CPU single-run smoke writes schema-2 metadata arrays; a 16-point shortened CPU smoke produced nonzero constraints.

Schema-2 FastRW diagnostic reruns:

| Case | K | Active source paths | Constraints per active path | Direct MAE | Old Onestage with-self MAE | Old Onestage no-self MAE |
|---|---:|---:|---:|---:|---:|---:|
| Case 1 | 13097 | 4675 / 6400 | 2.80 | 0.6503 | 1.5237 | 1.5637 |
| Case 2 | 10143 | 4314 / 6400 | 2.35 | 0.6209 | 1.2989 | 1.3093 |
| Case 3 | 16629 | 5107 / 6400 | 3.26 | 0.5714 | 1.1144 | 1.1580 |

The path metadata confirms that many constraints come from the same finite set of source paths. This supports the correlation concern, but the larger issue appears theoretical: the old equation treats a conditional pass-through partial sum as an unconditional expectation constraint.

## Fusion Theory Note: Tail-Reuse Alternative

Old Onestage uses:

```text
theta_i - alpha_k theta_j = b_k + noise
```

This is probably not the right estimating equation. A pass-through record exists only after conditioning on a path from `i` hitting a target cell near `j`. The partial sum `b_k` is path-specific, so it is not generally an unbiased observation of `theta_i - alpha_k theta_j`.

A more defensible identity uses the full source-path sample `X_{i,n}` from `obs_data`:

```text
X_{i,n} = b_k + alpha_k Z_{j,k}
Z_{j,k} = (X_{i,n} - b_k) / alpha_k
```

Here `Z_{j,k}` is an approximate pseudo-sample for `theta_j`, subject to target-cell approximation, alpha filtering, and path correlation. This turns pass-through reuse into sample augmentation for the target point instead of a graph constraint between unconditional means.

Command:

```bash
node scripts/diagnose_tail_reuse_fusion.js \
  outputs/fusion_diagnostics/case1_fastrw_schema2_full \
  outputs/fusion_diagnostics/case2_fastrw_schema2_full \
  outputs/fusion_diagnostics/case3_fastrw_schema2_full
```

Output:

- `outputs/fusion_diagnostics/tail_reuse_summary.csv`

Best diagnostic result per FastRW case:

| Case | Direct MAE | Old Onestage with-self MAE | Best tail-reuse MAE | Best diagnostic variant |
|---|---:|---:|---:|---|
| Case 1 | 0.6503 | 1.5237 | 0.2794 | variance shrink, all records, `alpha >= 0.3`, scale `1` |
| Case 2 | 0.6209 | 1.2989 | 0.6027 | pooled mean, cross max-alpha per path-target, `alpha >= 0.8` |
| Case 3 | 0.5714 | 1.1144 | 0.5699 | variance shrink, cross max-alpha per path-target, `alpha >= 0.8`, scale `0.03` |

Interpretation:

- The pass-through information is not useless: Case 1 improves strongly under the tail-reuse identity.
- The improvement is not yet robust across cases; Case 2 and Case 3 only improve marginally in this first diagnostic sweep.
- Parameters were selected using reference errors in this diagnostic. Production use needs a reference-free rule, likely based on alpha thresholding, empirical tail variance, and conservative effective sample size.

Next fusion work:

- Add a production tail-reuse postprocessor that writes direct, tail-reuse, and diagnostic summaries without using reference to choose parameters.
- Re-run schema-2 diagnostics for PIRW if needed, but prioritize FastRW because it is the intended main method.
- Investigate why Case 1 benefits much more than Cases 2/3: alpha distribution, tail pseudo-sample variance, target-cell mismatch, and spatial smoothness.
- Decide whether to remove or reframe old Onestage in the paper; current evidence says the old constraint equation should not be presented as valid without substantial correction.

## Tail-Reuse Postprocessor

Added:

- `scripts/run_tail_reuse_fusion.js`

Default conservative parameters:

```text
mode = cross_max_alpha_per_path_target
alpha_min = 0.8
estimator = variance_shrink
effective_sample_scale = 0.03
```

These defaults are reference-free during computation. The script still reports reference errors when `direct.csv` contains `GT_Temperature`.

Command:

```bash
node scripts/run_tail_reuse_fusion.js <run_dir>
```

For the three FastRW schema-2 diagnostic runs, the conservative default gives:

| Case | Direct MAE | Conservative tail-reuse MAE | Tail pseudo-samples |
|---|---:|---:|---:|
| Case 1 | 0.6503 | 0.6437 | 743 |
| Case 2 | 0.6209 | 0.6202 | 640 |
| Case 3 | 0.5713 | 0.5699 | 1033 |

This is intentionally conservative. The reference-selected Case 1 result can be much better, but that should not become the paper/default rule until we have a reference-free parameter choice.

## Case 1 Spacing Sweep

Command:

```bash
node scripts/run_case1_spacing_sweep.js
```

Fixed prior path plug-in parameters:

```text
source = prior
aggregator = max_alpha
include_self = false
alpha_min = 0.3
lambda = 1.0
```

Output:

- `outputs/fusion_diagnostics/case1_spacing_sweep/summary.csv`

Summary:

| Spacing | Query indices | Method | K | MAE | Avg variance | Avg SE |
|---:|---|---|---:|---:|---:|---:|
| 10 | `10 20 30 40` | PIRW direct | 64698 | 0.4242 | 0.217535 | 0.4639 |
| 10 | `10 20 30 40` | FastRW direct | 13097 | 0.6503 | 0.554657 | 0.7398 |
| 10 | `10 20 30 40` | FastRW prior path plug-in | 13097 | 0.5805 | 0.439001 | 0.6550 |
| 4 | `19 23 27 31` | PIRW direct | 65965 | 0.3949 | 0.237476 | 0.4867 |
| 4 | `19 23 27 31` | FastRW direct | 14356 | 0.5835 | 0.604117 | 0.7758 |
| 4 | `19 23 27 31` | FastRW prior path plug-in | 14356 | 0.5615 | 0.462253 | 0.6771 |
| 2 | `22 24 26 28` | PIRW direct | 56865 | 0.4059 | 0.241251 | 0.4910 |
| 2 | `22 24 26 28` | FastRW direct | 12895 | 0.5792 | 0.613404 | 0.7827 |
| 2 | `22 24 26 28` | FastRW prior path plug-in | 12895 | 0.5929 | 0.484376 | 0.6950 |
| 1 | `24 25 26 27` | PIRW direct | 40677 | 0.4003 | 0.245239 | 0.4951 |
| 1 | `24 25 26 27` | FastRW direct | 9060 | 0.5512 | 0.622352 | 0.7886 |
| 1 | `24 25 26 27` | FastRW prior path plug-in | 9060 | 0.5698 | 0.523548 | 0.7231 |

Interpretation:

- Prior path plug-in consistently reduces FastRW variance and Avg SE.
- Smaller spacing did not increase the benefit. The adjacent 4x4 grid had fewer pass-through constraints and weaker fusion gains.
- The current pass-through rule alone is not enough to close the variance gap to PIRW direct.

## Prior Residual Smoothing Diagnostic

Method:

```text
T_hat(x) = T_prior(x) + smooth(T_direct(x) - T_prior(x))
```

The smoother is an RBF kernel ridge / GP-style residual smoother over query point locations. This diagnostic reports both reference-selected best MAE and a leave-one-out selected row where applicable. It also reports `prior only` separately because the default `comso_12500` prior is already very accurate at the query points.

Commands:

```bash
node scripts/diagnose_prior_residual_smoothing.js
node scripts/diagnose_prior_residual_smoothing.js \
  s10=outputs/fusion_diagnostics/case1_spacing_sweep/s10_current/fastrw_direct=outputs/fusion_diagnostics/case1_spacing_sweep/configs/s10_current_fastrw_direct.json \
  s4=outputs/fusion_diagnostics/case1_spacing_sweep/s4_medium/fastrw_direct=outputs/fusion_diagnostics/case1_spacing_sweep/configs/s4_medium_fastrw_direct.json \
  s2=outputs/fusion_diagnostics/case1_spacing_sweep/s2_dense/fastrw_direct=outputs/fusion_diagnostics/case1_spacing_sweep/configs/s2_dense_fastrw_direct.json \
  s1=outputs/fusion_diagnostics/case1_spacing_sweep/s1_adjacent/fastrw_direct=outputs/fusion_diagnostics/case1_spacing_sweep/configs/s1_adjacent_fastrw_direct.json
```

Outputs:

- `outputs/fusion_diagnostics/prior_residual_smoothing_main_summary.csv`
- `outputs/fusion_diagnostics/prior_residual_smoothing_main_sweep.csv`
- `outputs/fusion_diagnostics/prior_residual_smoothing_summary.csv`
- `outputs/fusion_diagnostics/prior_residual_smoothing_sweep.csv`

Main three-case FastRW summary:

| Case | Method | MAE | Avg variance | Avg SE | Bootstrap Avg variance | Bootstrap Avg SE |
|---|---|---:|---:|---:|---:|---:|
| Case 1 | FastRW direct baseline | 0.6503 | 0.554657 | 0.7398 | 0.554657 | 0.7398 |
| Case 1 | prior only | 0.0207 | 0.000000 | 0.0000 | 0.000000 | 0.0000 |
| Case 1 | best MAE residual smoothing | 0.0174 | 0.000365 | 0.0190 | 0.001546 | 0.0391 |
| Case 1 | LOO residual smoothing | 0.1739 | 0.036136 | 0.1900 | 0.093513 | 0.3053 |
| Case 2 | FastRW direct baseline | 0.6209 | 0.700810 | 0.8364 | 0.700810 | 0.8364 |
| Case 2 | prior only | 0.1890 | 0.000000 | 0.0000 | 0.000000 | 0.0000 |
| Case 2 | best MAE residual smoothing | 0.0662 | 0.015744 | 0.1254 | 0.023686 | 0.1539 |
| Case 3 | FastRW direct baseline | 0.5713 | 0.582570 | 0.7612 | 0.582570 | 0.7612 |
| Case 3 | prior only | 0.0340 | 0.000000 | 0.0000 | 0.000000 | 0.0000 |
| Case 3 | best MAE residual smoothing | 0.0343 | 0.000000 | 0.0004 | 0.000002 | 0.0014 |
| Case 3 | LOO residual smoothing | 0.4230 | 0.094634 | 0.3060 | 0.141688 | 0.3731 |

Case 1 spacing summary:

| Spacing | Method | MAE | Avg variance | Avg SE | Bootstrap Avg variance | Bootstrap Avg SE |
|---:|---|---:|---:|---:|---:|---:|
| 10 | FastRW direct baseline | 0.6503 | 0.554657 | 0.7398 | 0.554657 | 0.7398 |
| 10 | prior only | 0.0207 | 0.000000 | 0.0000 | 0.000000 | 0.0000 |
| 10 | best MAE residual smoothing | 0.0174 | 0.000365 | 0.0190 | 0.001546 | 0.0391 |
| 10 | LOO residual smoothing | 0.1739 | 0.036136 | 0.1900 | 0.093513 | 0.3053 |
| 4 | FastRW direct baseline | 0.5835 | 0.604117 | 0.7758 | 0.604117 | 0.7758 |
| 4 | prior only | 0.0216 | 0.000000 | 0.0000 | 0.000000 | 0.0000 |
| 4 | best MAE residual smoothing | 0.0158 | 0.001262 | 0.0354 | 0.006019 | 0.0774 |
| 4 | LOO residual smoothing | 0.0215 | 0.000000 | 0.0005 | 0.000003 | 0.0017 |
| 2 | FastRW direct baseline | 0.5792 | 0.613404 | 0.7827 | 0.613404 | 0.7827 |
| 2 | prior only | 0.0142 | 0.000000 | 0.0000 | 0.000000 | 0.0000 |
| 2 | best MAE residual smoothing | 0.0042 | 0.001378 | 0.0370 | 0.006154 | 0.0783 |
| 2 | LOO residual smoothing | 0.5050 | 0.467798 | 0.6837 | 0.557925 | 0.7461 |
| 1 | FastRW direct baseline | 0.5512 | 0.622352 | 0.7886 | 0.622352 | 0.7886 |
| 1 | prior only | 0.0115 | 0.000000 | 0.0000 | 0.000000 | 0.0000 |
| 1 | best MAE residual smoothing | 0.0050 | 0.000374 | 0.0193 | 0.001926 | 0.0439 |
| 1 | LOO residual smoothing | 0.0112 | 0.000001 | 0.0008 | 0.000006 | 0.0025 |

Interpretation:

- With the default `comso_12500` prior, prior residual smoothing is dominated by prior quality. The prior alone is already far more accurate than the RW estimates at these query points.
- Reference-selected residual smoothing can improve slightly over prior only, but that is not a production rule.
- Leave-one-out selection is unstable on small 4x4 grids; it works for some spacing groups and fails for spacing 2.
- This suggests a new paper direction may be possible, but it must be framed as prior-assisted correction/uncertainty quantification, not as pure random-walk multi-point fusion.
