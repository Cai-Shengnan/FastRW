#!/usr/bin/env bash
# =====================================================================
# run_group_size_sweep.sh
#
# Purpose
#   One-key reproducer for the Group-Size sweep used by Table
#   `tab:multi` in the TCAD paper. Calls run_group_size_sweep.js on
#   the Case 1 long MC run with the canonical settings:
#     - N      = 1000   (paths per query, matches the legacy table)
#     - B      = 500    (bootstrap trials per subgroup)
#     - seed   = 42     (base seed; trial seeds are derived
#                        deterministically from (G, subgroup, b))
#     - groups = 1,4,8,16
#
#   For each G we partition the M=16 query points into floor(M/G)
#   disjoint subgroups of G consecutive points and report TWO metrics:
#
#     (A) "avg_abs" speedup [LEGACY, diagnostics only]
#           N_hat(G) = N * Var_single(avg_abs) / Var_group(avg_abs)
#         This confounds the trivial 1/G averaging factor with the
#         per-query fusion benefit. Kept for backwards comparison.
#
#     (B) "per_query" speedup [CANONICAL tab:multi metric]
#           N_hat(x_i, G) = N * Var_single(T_hat(x_i))
#                             / Var_fused(T_hat(x_i); G)
#         Reported as mean +/- std of N_hat/N over the M query
#         points. T_hat(x_i) is the FastRW fused (or FasterRW
#         T_eps) per-point estimate. Matches the legacy paper's
#         hat{N}(x) = Z(x) / Var[hat{T}(x)] definition. At G=1 the
#         speedup is exactly 1x for both methods by construction
#         (FasterRW at G=1 is degenerate: GP w/ a single training
#         point reduces to the identity).
#
#   FastRW   = Alg. 1+2 (inverse-variance fusion, no-self tail reuse)
#   FasterRW = Alg. 1+2+3 (FastRW + universal-kriging GP residual)
#
# Usage
#   ./scripts/run_group_size_sweep.sh
#
# Prerequisites
#   The Case 1 FastRW MC run (N_max=8192, M=16) must exist at
#     outputs/tcad_table1/fastrw_case1/
#   (produced by scripts/run_fastrw_direct.sh).
#
# Outputs
#   outputs/tcad_table_multi/case1_group_sweep.json
#
# Reproducibility
#   Single seed (42) drives every RNG draw. The same machine + Node
#   version will produce byte-identical JSON output.
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/run_group_size_sweep.js"
RUN_DIR="${ROOT_DIR}/outputs/tcad_table1/fastrw_case1"
CONFIG="${ROOT_DIR}/configs/tcad_table1/fastrw_case1.json"
OUT_DIR="${ROOT_DIR}/outputs/tcad_table_multi"
OUT_FILE="${OUT_DIR}/case1_group_sweep.json"

N=1000
B=500
SEED=42
# Note: GROUPS is a bash-builtin read-only array (the current user's
# group IDs), so we use GROUP_SIZES here instead.
GROUP_SIZES="1,4,8,16"

mkdir -p "${OUT_DIR}"

if [[ ! -d "${RUN_DIR}" ]]; then
  echo "[run_group_size_sweep] ERROR: MC run dir not found: ${RUN_DIR}" >&2
  echo "[run_group_size_sweep] Run scripts/run_fastrw_direct.sh first." >&2
  exit 1
fi

echo "[run_group_size_sweep] Case 1 sweep: N=${N} B=${B} seed=${SEED} groups=${GROUP_SIZES}"
echo "[run_group_size_sweep] Output -> ${OUT_FILE}"

node "${SCRIPT}" "${RUN_DIR}" "${CONFIG}" \
  --N="${N}" --B="${B}" --seed="${SEED}" --groups="${GROUP_SIZES}" \
  --output="${OUT_FILE}"

echo "[run_group_size_sweep] Done."
