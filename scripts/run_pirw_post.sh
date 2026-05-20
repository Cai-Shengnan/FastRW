#!/usr/bin/env bash
# =====================================================================
# run_pirw_post.sh
#
# Purpose
#   Bootstrap post-processor for PIRW (baseline). Wraps run_pirw_post.js
#   with the paper-locked N values and output paths for all three cases.
#   Each (case, eps) cell is computed with B=500 bootstrap trials.
#
# Usage
#   ./scripts/run_pirw_post.sh [<case>]
#
#   <case>  optional: 1, 2, or 3.  Omit to run all three cases.
#
# Prerequisites
#   PIRW MC runs must exist (N_max=4096) at:
#     outputs/tcad_table1/pirw_case{1,2,3}/
#   Run scripts/run_pirw_direct.sh to produce them.
#
# Outputs (paper-locked N values, B=500):
#   outputs/tcad_table1/paper_results/case{1,2,3}_pirw_eps{0.5,0.4}.json
#
# Paper-locked N per (case, eps):
#   Case 1: eps=0.5 → N=768,  eps=0.4 → N=1280
#   Case 2: eps=0.5 → N=1280, eps=0.4 → N=2560
#   Case 3: eps=0.5 → N=1024, eps=0.4 → N=1792
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/run_pirw_post.js"
OUT_DIR="${ROOT_DIR}/outputs/tcad_table1/paper_results"
mkdir -p "${OUT_DIR}"

B=500
SEED=42

run_case() {
  local CASE="$1"
  local RUN_DIR="${ROOT_DIR}/outputs/tcad_table1/pirw_case${CASE}"

  if [[ ! -d "${RUN_DIR}" ]]; then
    echo "[run_pirw_post] ERROR: MC run dir not found: ${RUN_DIR}" >&2
    echo "[run_pirw_post] Run scripts/run_pirw_direct.sh first." >&2
    exit 1
  fi

  case "${CASE}" in
    1) N_EPS05=768;  N_EPS04=1280 ;;
    2) N_EPS05=1280; N_EPS04=2560 ;;
    3) N_EPS05=1024; N_EPS04=1792 ;;
    *) echo "Unknown case '${CASE}' (expected 1, 2, or 3)." >&2; exit 2 ;;
  esac

  echo "[run_pirw_post] case${CASE} eps=0.5 N=${N_EPS05} B=${B} ..."
  node "${SCRIPT}" "${RUN_DIR}" \
    --N="${N_EPS05}" --B="${B}" --seed="${SEED}" \
    --output="${OUT_DIR}/case${CASE}_pirw_eps0.5.json"

  echo "[run_pirw_post] case${CASE} eps=0.4 N=${N_EPS04} B=${B} ..."
  node "${SCRIPT}" "${RUN_DIR}" \
    --N="${N_EPS04}" --B="${B}" --seed="${SEED}" \
    --output="${OUT_DIR}/case${CASE}_pirw_eps0.4.json"
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
    sed -n '2,35p' "$0"
    exit 0
    ;;
  *)
    echo "Usage: $0 [1|2|3]  (omit for all cases)" >&2
    exit 2
    ;;
esac

echo "[run_pirw_post] Done. Results in ${OUT_DIR}/"
