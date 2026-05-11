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
