# FastRW Experiment Rerun Interview

Date: 2026-05-11

Goal: clean up the repository and paper experiment setup, then rerun the paper experiments with the new case set and Robin strip ratio.

## Confirmed Facts

- The Robin boundary-strip thickness ratio is represented in code as `boundary.epsilon.robin / walker.delta_x`.
- With fixed `walker.delta_x = 5e-7`, setting the ratio to `1.56` means `boundary.epsilon.robin = 7.8e-7`.
- The old paper Case 2 will be removed completely.
- The current `case4_4core_top1_bottom1` configuration becomes the new Case 2 and should be renamed accordingly.
- `outputs/` may be cleared directly.
- Old `configs/` entries and obsolete scripts may be deleted directly.
- Old `data/` files should be moved to an archive outside the repo first, rather than permanently deleted immediately.

## Q&A

### Q1. How should the paper handle case naming?

Recommendation: keep paper labels as Case 1, Case 2, Case 3, but redefine Case 2 to use the current `case4_4core_top1_bottom1` setup.

User decision: do not preserve the old Case 2 at all. Completely erase the old Case 2 traces. Rename `case4_4core_top1_bottom1` to the new Case 2 everywhere.

### Q2. Should cleanup physically delete old data or move it aside first?

Recommendation: clear `outputs/` directly; delete obsolete `configs/` and scripts directly; move old `data/` files to an external archive directory first, such as `/Users/zxwang/Projects/ResRW_data_archive_20260511/`, then delete later after the new rerun is validated.

User decision: accepted.

### Q5. What are the final Case 1/2/3 definitions and strip-ratio settings?

Recommendation: lock the experiment set to exactly three cases:

- Case 1: `case1_power6`, top/middle/bottom = `500/100/500 um`, power map = `power6`, `h = 8700`.
- Case 2: `case2_4core_top1_bottom1`, top/middle/bottom = `1000/100/1000 um`, power map = `4-core`, `h = 8700`. This is the renamed current `case4_4core_top1_bottom1`.
- Case 3: `case3_16core`, top/middle/bottom = `500/100/1000 um`, power map = `16-core`, `h = 4900`.

Use the same strip ratio for all three:

- `walker.delta_x = 5e-7`
- `boundary.epsilon.robin = 7.8e-7`
- `boundary.epsilon.neumann = 7.8e-7`

Rationale: the ratio `rho_b / delta_x = 1.56`; prior diagnostics treated Neumann and Robin strip thicknesses as coupled.

User decision: accepted.

### Q6. How many COMSOL temperature fields should be generated, and how should they be named?

Recommendation: generate three coarse prior fields and one fine reference field per case, matching the previous paper table.

User decision: generate five COMSOL fields per case to make prior selection easier. Do not name them `coarse` or `fine`; name directories by DoF as `comso_<dof>` for easy inspection.

### Q7. Are the five COMSOL fields five coarse priors plus one precise reference, or five total?

Recommendation: use five coarse prior fields plus one precise reference field per case, for six COMSOL temperature fields total. Initial target directories:

- `comso_1875`
- `comso_4800`
- `comso_12500`
- `comso_32000`
- `comso_86247`
- `comso_full`, then rename to `comso_<actual_dof>` after the solve if the real DoF can be extracted.

User decision: accepted.

### Q8. Which existing COMSOL/data results can be reused?

Recommendation: conservatively reuse only data whose metadata clearly matches the new case geometry, power map, Robin coefficient, and query grid. Recompute ambiguous prior fields.

User decision: use a more practical rule. For Case 1 and Case 3, reuse existing rough COMSOL solutions even if their exact DoF does not perfectly match the target list, as long as the setup is broadly correct. Case 4/new Case 2 currently only has a full solution, so its rough solutions need to be recomputed. Exact DoF is not critical; approximate matching is acceptable.

### Q9. Which COMSOL field should be the default FastRW prior?

Recommendation: use the `comso_12500`-level field as the default prior for main FastRW experiments. This keeps the paper narrative close to the existing `Lambda = 0.03` default and prior-accuracy tradeoff. Other COMSOL fields are used for prior-accuracy sweeps and screening.

User decision: accepted.

### Q10. Which remaining execution decisions are locked?

The user reviewed a batch of remaining questions and made the following decisions:

- Main random-walk experiments will use the Metal backend. CPU is retained only for validation and smoke tests.
- PIRW baseline also uses `rho_b / delta_x = 1.56`.
- PIRW baseline keeps `1000` paths per point.
- Main FastRW table should use Onestage posterior-fused results. The code should still emit both direct and Onestage-fused results for inspection.
- Single-point prior-acceleration experiments skip posterior fusion.
- Multi-point fusion keeps only Onestage. Remove/archive HBMmodel and stale HBMmodel references/outputs.
- Pass-through self constraints should be kept during measurement for now, so we can check whether multi-point fusion improves or degrades with them present.
- Metal pass-through overflow remains a warning rather than a hard failure.
- Add or preserve an explicit strip-ratio representation so `rho_b / delta_x = 1.56` is visible and less error-prone.
- After cleanup, `data/` should keep only the new three-case power inputs and COMSOL temperature fields.
- Paper Case 2 uses the `4-core` power map and the new `1000/100/1000 um` geometry. No `case4` naming should remain.
- Full COMSOL references should also use `comso_<dof>` naming when possible; if exact DoF cannot be parsed, preserve metadata and use a clear fallback.
- Use fixed seed `42` for rerun experiments.
- Rerun scope: main Case 1/2/3 PIRW vs FastRW table; residual identity figure; path convergence figure; group-size fusion table; stage runtime table; prior-accuracy tradeoff table; weak-prior table. Do not rerun obsolete HBMmodel, old rho sweeps, or root-cause diagnostics.
- Cleanup `outputs/` only after the plan is confirmed and reusable COMSOL/data artifacts have been migrated.

### Q4. Should the code explicitly separate prior temperature and fine reference temperature?

Current state: the code has only one `ground_truth_path`, and that same temperature field is used for both tail correction and error evaluation. This does not match the paper's coarse-FEM prior plus fine-FEM reference setup.

Recommendation: change the config schema to separate these roles, for example:

```json
"data": {
  "power_density_path": ".../power.bin",
  "prior_temperature_path": ".../comsol/coarse_12500/temp.bin",
  "reference_temperature_path": ".../comsol/fine/temp.bin",
  "temperature_offset": 0
}
```

Use `prior_temperature_path` for tail correction and `reference_temperature_path` only for CSV `GT_Temperature` and error reporting. PIRW/no-tail runs still need the reference but do not require a prior.

User decision: accepted.

### Q3. Where should COMSOL coarse and fine solutions live?

Recommendation: treat COMSOL coarse priors and fine references as experiment inputs, not disposable run outputs. Store them under `data/cases/<case>/comsol/...`, for example:

- `data/cases/case1_power6/comsol/coarse_<dof>/temp.bin`
- `data/cases/case1_power6/comsol/fine/temp.bin`
- `data/cases/case2_4core_top1_bottom1/comsol/...`
- `data/cases/case3_16core/comsol/...`

Existing usable COMSOL outputs under `outputs/comsol_case3_rebuild` and `outputs/comsol_case4_4core_top1_bottom1` should be migrated into `data/cases/...` instead of recomputed.

User decision: accepted.

### Q11. What temperature unit should the cleaned data and outputs use?

Current implementation had mixed historical inputs: older archived `temp.bin` files were in Celsius with an added offset, while fresh COMSOL exports were in Kelvin.

User decision: use Celsius uniformly. The cleaned `data/cases/**/temp.bin`, random-walk CSV outputs, reference errors, and prior tail correction fields should all use Celsius. The COMSOL helper may solve internally with Kelvin boundary temperatures, but exported temperature files must be converted back to Celsius.
