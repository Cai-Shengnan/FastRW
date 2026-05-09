# Case3 RW Status, 2026-05-09

## Active Code State

- Robin FK local-time source is back to the original right-endpoint step rule:
  `e_hat <- e_hat * exp(c dL)`, then `T3 += e_hat * phi * dL`.
- No empirical Robin calibration is active.
- Metal still uses `float` for path state and compensated accumulation for `log_e_hat`.
- Diagnostic config knobs remain available, but the default physical path is unchanged unless explicitly enabled in a temporary experiment config.

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

## Open Suspects

- Near-boundary heat occupation and Robin local-time estimator interaction at finite `delta_x`/`epsilon`.
- Possible GPU float accumulation sensitivity for very small `delta_x`, especially aggregate `T3`.
- A remaining shared-model discrepancy, because COMSOL/GT temperature offset, COMSOL Robin convention, and source integration quadrature have not explained the full bias.
