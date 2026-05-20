# legacy/

Files here are **not part of the open-source reproducibility flow** and are
**not maintained**. Paths inside these scripts and configs may not resolve;
output locations may be stale; some scripts depend on COMSOL or on data
that is no longer shipped.

They are kept for transparency: the diagnostics and earlier sweeps were
used during development of the FastRW / FasterRW algorithms and may help a
reader understand decisions documented in the paper.

## Contents

- `scripts/diagnose_*.{js,sh}` — diagnostics used while tuning fusion
  constraints, tail-reuse, residual smoothing, and group-size behavior.
- `scripts/run_case{1,2,4}_*_sweep.js`, `run_rho_sweep_*.js`,
  `run_tail_reuse_fusion.js` — earlier sweeps superseded by the
  `tcad_table*` configs and the `run_bootstrap_sweep` flow in
  `../scripts/`.
- `scripts/run_comsol_*.{sh,js}`, `comsol_case3_rebuild.java` — COMSOL
  prior generation. Requires a COMSOL Multiphysics license; the
  precomputed priors that the public flow needs ship with the artifact
  archive (see top-level README).
- `scripts/run_paper_experiments.js`, `summarize_rw_results.js`,
  `make_config_variant.js`, `backfill_direct_variance_columns.js`,
  `compare_comso4800_fusion_metrics.js` — earlier orchestration and
  reporting helpers.
- `configs/{pirw,fastrw_coarse_prior}_case*.json` — predecessor configs
  superseded by `../configs/tcad_table1/`.
- `docs/post.md` — internal lab notebook on multi-point fusion diagnostics
  (Chinese, 2026-05-18).
