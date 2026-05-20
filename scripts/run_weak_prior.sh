#!/usr/bin/env bash
# =====================================================================
# run_weak_prior.sh
#
# Purpose
#   One-key entry point for the weak-prior robustness experiment that
#   populates tab:weakprior (Case 1, M=16, eps=0.4 K).
#
#   Pipeline:
#     1. Build/verify the rule-of-thumb prior (uniform = ambient T).
#     2. Run Metal MC with Lambda=1e-3 at N_max=4096 paths.
#     3. Bootstrap FastRW / FasterRW post-processors at a sweep of N
#        values and pick the smallest N reaching eps=0.4 K (B=500).
#     4. Cross-reference the canonical PIRW / FEM-prior FastRW /
#        FEM-prior FasterRW rows from outputs/tcad_table1/paper_results/.
#     5. Write a structured summary of all five rows.
#
# Usage
#   ./scripts/run_weak_prior.sh [--skip-mc]
#
# Outputs
#   outputs/tcad_table_weakprior/fastrw_case1_rot/        MC run + log
#   outputs/tcad_table_weakprior/fastrw_case1_rot_eps0.4.json
#   outputs/tcad_table_weakprior/fasterrw_case1_rot_eps0.4.json
#   outputs/tcad_table_weakprior/case1_weakprior_summary.json
#   outputs/tcad_table_weakprior/README.md  (manual notes)
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG="${ROOT_DIR}/configs/tcad_table_weakprior/fastrw_case1_rot.json"
RUN_DIR="${ROOT_DIR}/outputs/tcad_table_weakprior/fastrw_case1_rot"
N_MAX=4096

SKIP_MC=0
for arg in "$@"; do
  case "${arg}" in
    --skip-mc) SKIP_MC=1 ;;
    --help|-h) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done

echo "[run_weak_prior] ==============================================="
echo "[run_weak_prior] tab:weakprior  (Case 1, power6, M=16, eps=0.4)"
echo "[run_weak_prior] Lambda=1e-3, rule-of-thumb uniform prior @20C"
echo "[run_weak_prior] ==============================================="

node "${ROOT_DIR}/scripts/run_weak_prior.js" \
  --config="${CONFIG}" \
  --run-dir="${RUN_DIR}" \
  --nmax="${N_MAX}" \
  --skip-mc="${SKIP_MC}"

echo "[run_weak_prior] Done."
