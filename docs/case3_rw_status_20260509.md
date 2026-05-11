# Case3 RW Status, 2026-05-09

## Active Code State

- Robin FK local-time source is back to the original right-endpoint step rule:
  `e_hat <- e_hat * exp(c dL)`, then `T3 += e_hat * phi * dL`.
- No empirical Robin calibration is active.
- Metal still uses `float` for path state and compensated accumulation for `log_e_hat`.
- The production path is back to 3D only. The temporary 1D/2D `walker.dimension` branch and configurable local-time denominator branch have been removed from mainline code.
- Read-only component diagnostics remain available behind `walker.diagnostics.enabled`; they do not change the physical path.

## Ratio Convention

When scanning near-boundary resolution, `delta_x` and Robin/Neumann `epsilon` should be scaled together with the intended factor of `1.5`.
The `delta_x=1e-6` run with `epsilon=7.5e-7` is therefore not a clean convergence point and should not be used for conclusions.

## Ground Truth Checks

- The rebuilt COMSOL case3 output is in `outputs/comsol_case3_rebuild/`.
- COMSOL-new heat-layer lookup matches the old `temp.bin + 273.15` query temperatures to about `0.036 K` RMSE.
- The `raw_temp + 271.15` value in the supplement CSV is treated as a typo and is not used as an explanation.
- A powered 1D slab benchmark matched COMSOL to numerical precision, so the basic COMSOL Robin convention is not currently the leading suspect.

## Current Best 16-Point GPU Results

All rows below use COMSOL-new query temperatures and COMSOL-new heat-layer tail GT, `seed=20260620`, `N=1000`, no empirical calibration.

| `delta_x` | `epsilon` | avg signed error | RMSE | avg SE | avg steps | status |
|---:|---:|---:|---:|---:|---:|---|
| `5e-7` | `7.5e-7` | `-1.7366 K` | `1.8296 K` | `0.4761 K` | `3.93M` | valid |
| `2.5e-7` | `3.75e-7` | `-1.2167 K` | `1.3147 K` | `0.4827 K` | `7.75M` | valid |
| `1.25e-7` | `1.875e-7` | `-1.1835 K` | `1.2654 K` | `0.4719 K` | `15.38M` | valid but costly |

Source: `outputs/comsol_case3_compare/delta_ladder_large_n1000_20260509/summary_with_1p25_n1000.csv`.

Interpretation: reducing `delta_x` from `5e-7` to `2.5e-7` moved the bias upward by about `0.52 K`; reducing again to `1.25e-7` did not produce a clear additional improvement at current Monte Carlo error. This suggests finite near-boundary resolution explains part of the bias, but not all of it.

## Heat Occupation Diagnostics

Latest diagnostic run: `outputs/comsol_case3_compare/heat_occupation_diagnostics_20260509/summary.csv`.

The diagnostics add read-only heat-source counters to CPU and Metal. Metal diagnostic stride is now `28`; the corrected run has max component-sum mismatch below `7e-7 K`.

| `delta_x` | avg signed error | SE of 16-point avg error | `T0_heat` | unweighted heat reward | avg `e_hat` on heat | `T1_tail` | `T3_robin` |
|---:|---:|---:|---:|---:|---:|---:|---:|
| `5e-7` | `-1.7366 K` | `0.1207 K` | `86.0958 K` | `310.9762 K` | `0.2768` | `11.4062 K` | `284.5249 K` |
| `2.5e-7` | `-1.2167 K` | `0.1225 K` | `86.2690 K` | `311.8118 K` | `0.2766` | `11.4094 K` | `284.8683 K` |
| `1.25e-7` | `-1.1835 K` | `0.1199 K` | `86.6949 K` | `311.9904 K` | `0.2778` | `11.4044 K` | `284.4806 K` |

Findings:

- The residual `~ -1.18 K` bias is statistically significant at the 16-point average level.
- The `5e-7 -> 1.25e-7` improvement is almost entirely `T0_heat`: mean error moves by `+0.553 K`, while `T0_heat` moves by `+0.599 K`; `T1` is unchanged and `T3` moves by only about `-0.044 K`.
- `pending_robin_heat_count = 0` for all three runs, so stale delayed Robin state entering heat is not the source.
- `avg_e_hat_on_heat` is almost stable; the main signal is heat occupation/source reward, not Robin source integration.

Power lookup diagnostic: `outputs/comsol_case3_compare/power_lookup_diagnostics_20260509/node_avg_delta_2p5em7_n1000`.

- Replacing the x/y power lookup by a four-neighbor node-average projection moved avg signed error only from `-1.2167 K` to `-1.1385 K`.
- This excludes cell-center versus grid-line power lookup as a `1 K`-level explanation.

XY refinement diagnostic: `outputs/comsol_case3_compare/xy_refinement_diagnostics_20260509/xy2_delta_2p5em7_n1000`.

- Splitting each x/y power cell into `2x2` subcells and using a bilinear-interpolated tail GT moved avg signed error only from `-1.2167 K` to `-1.1749 K`.
- This excludes coarse x/y grid resolution as a `1 K`-level explanation at the current Monte Carlo precision.

## Lower-Dimensional Branch Status

Do not interpret a thin 3D run as a true 2D or 1D random walk benchmark. The lower-dimensional benchmark needs a dimension-correct RW algorithm:

- WOS sampling changes by dimension: interval endpoints in 1D, circle in 2D, sphere in 3D.
- WOG heat-layer transitions change by dimension: 2 neighbors in 1D, 4 neighbors in 2D, 6 neighbors in 3D.
- The Robin local-time increment must use the dimension-specific ball exit time convention. For the generator used by this code, the candidate estimator is `dL = delta_x^2 / (2 d epsilon)`: `delta_x^2/(2 epsilon)` in 1D, `delta_x^2/(4 epsilon)` in 2D, and the existing `delta_x^2/(6 epsilon)` in 3D.
- Robin source accumulation uses the same FK rule after `dL` is fixed, but the hit/near process that estimates `L` must be dimension-correct.

The partial `outputs/ehat_2d_benchmark/` thin-3D outputs should be treated only as COMSOL field-generation scaffolding, not as valid 2D RW evidence. The temporary script and runtime switch for this branch have been removed from the working tree.

## Single-Point Ladder

Single representative point output: `outputs/comsol_case3_compare/single_point_delta_ladder_20260509/summary.csv`.

- `2.5e-7`, `N=1000`: error `-0.693 K`, SE `0.478 K`.
- `1.25e-7`, `N=1000`: error `-0.935 K`, SE `0.458 K`.
- `6.25e-8`, `N=1000`: not reliable; path diagnostics showed a large mismatch between aggregate `T3` and top/bottom Robin `T3` diagnostics.
- `3.125e-8`, `N=500`: invalid; paths hit `max_steps=5e7`, cutoff fraction was `0`.

## Exact Source Integral Test

The exact local-time source integral was tested and rejected as a root cause.

- A naive Metal `1 - exp(decay)` implementation created a false `+2.95 K` T3 shift because `decay` is around `1e-6` and `float` cancellation is severe.
- A stable implementation produced essentially the same `5e-7` result as the original step rule:
  `-1.7356 K` versus previous `-1.7366 K`.
- Therefore the source integration quadrature is not the observed `1-2 K` bias source.

The exact-integral output directories are kept only as exclusion evidence:

- `outputs/comsol_case3_compare/robin_exact_integral_20260509/`
- `outputs/comsol_case3_compare/robin_exact_integral_stable_20260509/`

## Working Diagnosis

The strongest current diagnosis is a finite-strip discretization mismatch between Robin local-time estimation and heat/source occupation.

- Continuous Feynman-Kac is not `rho`-dependent. The `rho_b` sensitivity comes from approximating boundary local time with a finite near-boundary strip and a finite WOS/WOG step process.
- With the cutoff formulation, the accumulated Robin local time is almost fixed by `e_hat ~= cutoff`: `L* = (k/h) log(1/cutoff)`. This is why `T3_robin` and total local time barely move when `rho_b/delta_x` changes.
- The quantity that moves strongly is `T0_heat`: changing `rho_b` changes how many heat-layer occupation/source-reward visits occur before the path reaches the same Robin local-time cutoff.
- The direction is monotone in the tested range: larger `rho_b/delta_x` makes paths spend more effective time accumulating heat reward before cutoff and raises the estimate; smaller `rho_b/delta_x` lowers `T0_heat` and worsens negative bias.
- This is not explained by stale delayed Robin state, float `log_e_hat`, source integration quadrature, simple x/y power lookup, COMSOL temperature offset, or COMSOL Robin sign/unit convention.

This should not be turned into an empirical `rho` calibration. A valid fix needs a derivation tying the finite-strip estimator to the continuous local-time/occupation limit, or a boundary-layer kernel that removes the leading finite-`rho` bias.

## Possible Fix Directions

Theory-backed options to investigate next:

- Derive a planar Robin boundary-layer correction for top/bottom boundaries: replace many near-boundary WOS steps with an escape/local-time kernel that samples accumulated local time and elapsed occupation consistently.
- Use a matched 1D normal-direction model to compute the expected source-occupation clock conditional on reaching the Robin local-time cutoff, then apply it as a finite-strip correction only where the boundary is locally planar.
- Revisit the near-boundary estimator itself: current production uses `dL = delta_x^2 / (6 rho_b)` with delayed hit averaging. The evidence says this preserves final local time but biases the source occupation clock.
- Validate any candidate on manufactured COMSOL slab/stripe cases first, then on case1/2/3. A correction is acceptable only if it reduces the shared bias without case-specific `rho` tuning.

## Robin Strip Convention 2x2

Run directory: `outputs/robin_convention_2x2_3d_20260509/`.

All rows use 3D `case3_16core`, 16 points, GPU, COMSOL-new tail GT, COMSOL-new query-temperature error, `delta_x=5e-7`, `N=400`, `seed=20260624`.

The DATE/TCAD FastRW TeX at `/Users/zxwang/Documents/projects/2026DATE-RW/TCAD-FastRW-v1/docs/exp.tex` states the local-time allocation as
`L_exc ≈ n_eq (Delta x)^2 / (6 rho_b)`. The `rho3_den3` row is therefore an alternate Zhou-Cai-style convention test, not the formula written in that TeX.

| variant | `rho_b / delta_x` | local-time denominator | avg signed error | RMSE | avg steps | `T0_heat` | `T3_robin` | local time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| current | `1.5` | `6` | `-1.755 K` | `1.873 K` | `3.93M` | `86.08 K` | `284.52 K` | `0.28379` |
| geometry only | `3.0` | `6` | `+25.117 K` | `25.132 K` | `7.77M` | `113.07 K` | `284.39 K` | `0.28334` |
| weight only | `1.5` | `3` | `-45.006 K` | `45.011 K` | `1.97M` | `42.89 K` | `284.57 K` | `0.28426` |
| rho3 + denom3 | `3.0` | `3` | `-31.389 K` | `31.395 K` | `3.89M` | `56.51 K` | `284.51 K` | `0.28393` |

Findings:

- The current `rho_b=1.5 delta_x, denominator=6` convention is much closer to COMSOL than either `rho_b=3 delta_x` variant.
- `T3_robin` and accumulated local time are almost unchanged across the matrix because every run stops near the same `e_hat` cutoff.
- The huge movement is in heat occupation/source reward: `T0_heat` ranges from `42.89 K` to `113.07 K`.
- Therefore the strip convention primarily changes how much heat-source WOG occupation is accumulated before the same Robin cutoff local time, not the final Robin boundary contribution itself.

## Current-Formula Robin Strip Sweep

Run directory: `outputs/robin_rho_sweep_current_3d_20260509/`.

All rows use 3D `case3_16core`, 16 points, GPU, COMSOL-new tail GT, COMSOL-new query-temperature error, `delta_x=5e-7`, local-time denominator `6`, `N=400`, `seed=20260624`.

| `rho_b / delta_x` | avg signed error | RMSE | avg steps | `T0_heat` | `T3_robin` | local time |
|---:|---:|---:|---:|---:|---:|---:|
| `1.2` | `-13.850 K` | `13.861 K` | `3.30M` | `74.07 K` | `284.47 K` | `0.28369` |
| `1.3` | `-9.445 K` | `9.458 K` | `3.51M` | `78.41 K` | `284.52 K` | `0.28359` |
| `1.4` | `-5.646 K` | `5.677 K` | `3.72M` | `82.36 K` | `284.36 K` | `0.28339` |
| `1.5` | `-1.755 K` | `1.873 K` | `3.93M` | `86.08 K` | `284.52 K` | `0.28379` |

Findings:

- Decreasing `rho_b / delta_x` from `1.5` makes the negative bias substantially worse.
- The movement is again almost entirely `T0_heat`; `T3_robin` and total local time remain nearly fixed.
- If `rho_b` alone were used as an empirical knob, the zero crossing would lie slightly above `1.5`, but this is not a theory-backed fix.

## Rho 1.55 Cross-Case Check

Run directory: `outputs/rho1p55_other_cases_20260509/`.

All rows use GPU, 16 points, `delta_x=5e-7`, local-time denominator `6`, `N=400`, `seed=20260624`. Case1/Case2 use their existing fine-mesh GT files. Case3 uses COMSOL-new query-temperature error.

| case | `rho_b / delta_x` | avg signed error | RMSE | avg steps | `T0_heat` | `T3_robin` |
|---|---:|---:|---:|---:|---:|---:|
| case1 power6 | `1.50` | `-0.680 K` | `0.960 K` | `2.21M` | `23.52 K` | `284.47 K` |
| case1 power6 | `1.55` | `-0.267 K` | `0.756 K` | `2.27M` | `24.00 K` | `284.41 K` |
| case2 4-core | `1.50` | `-0.374 K` | `1.266 K` | `2.21M` | `53.22 K` | `284.50 K` |
| case2 4-core | `1.55` | `+0.767 K` | `1.389 K` | `2.27M` | `54.41 K` | `284.44 K` |
| case3 16-core | `1.50` | `-1.755 K` | `1.873 K` | `3.93M` | `86.08 K` | `284.52 K` |
| case3 16-core | `1.55` | `-0.360 K` | `0.845 K` | `4.03M` | `87.67 K` | `284.33 K` |

Findings:

- `rho_b/delta_x=1.55` improves case1 and case3, but over-corrects case2.
- Across cases, the shift again comes from `T0_heat`; `T3_robin` remains essentially unchanged.
- This is useful as a sensitivity signal, but it is not yet a valid global correction unless the `rho_b` convention can be tied back to the implementation/paper setup.

## Rho Bisection, Case1/2/3

Run directory: `outputs/rho_bisection_cases_20260509/`.

Script: `scripts/run_rho_bisection.js`.

All rows use GPU, 16 query points, `N=400`, `seed=20260624`, `delta_x=5e-7`, current production local-time formula `dL = delta_x^2 / (6 rho_b)`, and only `boundary.epsilon.robin = rho_b` is varied. Case3 uses the rebuilt COMSOL heat-layer tail GT from `outputs/comsol_case3_rebuild/heat_layer_cell_center_temperatures.bin`; case1/case2 use their existing fine-mesh GT files.

| case | final bracket for avg signed error | best tested `rho_b/delta_x` | best avg signed error | best RMSE | `T0_heat` at best | `T3_robin` at best |
|---|---:|---:|---:|---:|---:|---:|
| case1 power6 | `[1.56875, 1.57500]` | `1.57500` | `+0.0479 K` | `0.853 K` | `24.25 K` | `284.47 K` |
| case2 4-core | `[1.51875, 1.52500]` | `1.51875` | `-0.0604 K` | `1.286 K` | `53.55 K` | `284.47 K` |
| case3 16-core COMSOL-new | `[1.55000, 1.55625]` | `1.55625` | `+0.0032 K` | `0.772 K` | `87.96 K` | `284.41 K` |

Interpretation:

- The fitted `rho_b/delta_x` is case-dependent: roughly `1.52` to `1.58` at this `N=400` precision.
- Case2 is not contradictory; its baseline at `rho=1.5` was already close to zero and had mixed point-wise error signs, so the same upward `T0_heat` shift over-corrects it sooner.
- The monotone trend is still the same in all cases: increasing `rho_b/delta_x` raises the output mainly through `T0_heat`, while `T3_robin` remains near the same cutoff-controlled value.
- These values are diagnostic zero-crossings, not recommended physical defaults.
