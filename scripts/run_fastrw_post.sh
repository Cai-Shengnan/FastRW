#!/usr/bin/env bash
# =====================================================================
# run_fastrw_post.sh
#
# Purpose
#   Bootstrap post-processor for FastRW (Alg. 1+2, inverse-variance
#   fusion with no-self tail reuse). Wraps run_fastrw_post.js with the
#   paper-locked N values and output paths for all three cases.
#   Each (case, eps) cell is computed with B=500 bootstrap trials.
#
# Usage
#   ./scripts/run_fastrw_post.sh [<case>]
#
#   <case>  optional: 1, 2, or 3.  Omit to run all three cases.
#
# Prerequisites
#   FastRW MC runs must exist (N_max=8192) at:
#     outputs/tcad_table1/fastrw_case{1,2,3}/
#   Run scripts/run_fastrw_direct.sh to produce them.
#
# Outputs (paper-locked N values, B=500):
#   outputs/tcad_table1/paper_results/case{1,2,3}_fastrw_eps{0.5,0.4}.json
#
# Paper-locked N per (case, eps):
#   Case 1: eps=0.5 → N=384,  eps=0.4 → N=640
#   Case 2: eps=0.5 → N=640,  eps=0.4 → N=1280
#   Case 3: eps=0.5 → N=640,  eps=0.4 → N=1280
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/run_fastrw_post.js"
OUT_DIR="${ROOT_DIR}/outputs/tcad_table1/paper_results"
mkdir -p "${OUT_DIR}"

B=500
SEED=42

run_case() {
  local CASE="$1"

  case "${CASE}" in
    1)
      RUN_DIR="${ROOT_DIR}/outputs/tcad_table1/fastrw_case1"
      CONFIG="${ROOT_DIR}/configs/tcad_table1/fastrw_case1.json"
      N_EPS05=384; N_EPS04=640
      ;;
    2)
      RUN_DIR="${ROOT_DIR}/outputs/tcad_table1/fastrw_case2"
      CONFIG="${ROOT_DIR}/configs/tcad_table1/fastrw_case2.json"
      N_EPS05=640; N_EPS04=1280
      ;;
    3)
      RUN_DIR="${ROOT_DIR}/outputs/tcad_table1/fastrw_case3"
      CONFIG="${ROOT_DIR}/configs/tcad_table1/fastrw_case3.json"
      N_EPS05=640; N_EPS04=1280
      ;;
    *) echo "Unknown case '${CASE}' (expected 1, 2, or 3)." >&2; exit 2 ;;
  esac

  if [[ ! -d "${RUN_DIR}" ]]; then
    echo "[run_fastrw_post] ERROR: MC run dir not found: ${RUN_DIR}" >&2
    echo "[run_fastrw_post] Run scripts/run_fastrw_direct.sh first." >&2
    exit 1
  fi

  echo "[run_fastrw_post] case${CASE} eps=0.5 N=${N_EPS05} B=${B} ..."
  node "${SCRIPT}" "${RUN_DIR}" "${CONFIG}" \
    --N="${N_EPS05}" --B="${B}" --seed="${SEED}" \
    --output="${OUT_DIR}/case${CASE}_fastrw_eps0.5.json"

  echo "[run_fastrw_post] case${CASE} eps=0.4 N=${N_EPS04} B=${B} ..."
  node "${SCRIPT}" "${RUN_DIR}" "${CONFIG}" \
    --N="${N_EPS04}" --B="${B}" --seed="${SEED}" \
    --output="${OUT_DIR}/case${CASE}_fastrw_eps0.4.json"
}

CASE_ARG="${1:-all}"

case "${CASE_ARG}" in
  1|2|3) run_case "${CASE_ARG}" ;;
  all)
    run_case 1
    run_case 2
    run_case 3
    ;;
  --help|-h)
    sed -n '2,38p' "$0"
    exit 0
    ;;
  *)
    echo "Usage: $0 [1|2|3]  (omit for all cases)" >&2
    exit 2
    ;;
esac

echo "[run_fastrw_post] Done. Results in ${OUT_DIR}/"
