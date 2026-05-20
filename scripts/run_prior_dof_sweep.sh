#!/usr/bin/env bash
# =====================================================================
# run_prior_dof_sweep.sh
#
# Purpose
#   Sweep FEM-prior accuracy (DoF) against the FastRW truncation
#   threshold Lambda for TCAD Table `tab:tradeoff` (Case 1).
#   Three rows: DoF in {699, 1288, 10254}, Lambda chosen so that
#   Lambda * max_prior_error stays under ~0.05 K.
#
# Per row, this script does:
#   1) FastRW Monte-Carlo with N=1000 paths, seed=42 (Apple M5 Pro GPU).
#   2) Records mean_avg_steps (column average of `Avg_Steps` in
#      `direct.csv`) and per-query random-walk wallclock
#      (`runtime_seconds / M_queries`, with M=16).
#   3) FEM warm-mesh timing: run `comsol batch -study std1` twice on
#      the existing `case3_rebuild.mph`; reports run-2 wallclock as the
#      warm time, writes `comso_<DoF>/timing_warm.json`.
#
# Per task constraints:
#   - DoF=1288's existing timing_warm.json is NEVER re-run/overwritten;
#     it is read from disk.
#   - data/.../comsol/<DoF>/temp.bin and metadata.json are NEVER
#     touched.
#   - Canonical configs in configs/tcad_table1/ are NEVER modified.
#
# Usage
#   ./scripts/run_prior_dof_sweep.sh             # all 3 DoFs
#   ./scripts/run_prior_dof_sweep.sh --only=699  # one DoF only
#   ./scripts/run_prior_dof_sweep.sh --skip-mc   # parse existing MC
#   ./scripts/run_prior_dof_sweep.sh --skip-fem  # skip COMSOL re-time
#
# Outputs
#   - outputs/tcad_table_tradeoff/dof{699,1288,10254}/  (MC artifacts)
#   - outputs/tcad_table_tradeoff/case1_dof_sweep.json  (summary)
#   - data/cases/case1_power6/comsol/comso_{699,10254}/timing_warm.json
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RUNNER=()
if [[ "${USE_CONDA_RUN:-1}" == "1" ]] && command -v conda >/dev/null 2>&1; then
  if conda env list | awk '{print $1}' | grep -qx "fastrw"; then
    RUNNER=(conda run -n fastrw --no-capture-output)
  fi
fi

cd "${ROOT_DIR}"
"${RUNNER[@]+"${RUNNER[@]}"}" node "${ROOT_DIR}/scripts/run_prior_dof_sweep.js" "$@"
