#!/usr/bin/env bash
# =====================================================================
# run_bootstrap_sweep.sh
#
# Purpose
#   One-key entry point to regenerate the dense N-grid bootstrap
#   sweep data + fig:bootstrap plots (Case 1/2/3). For each case
#   it calls scripts/run_bootstrap_sweep.js twice:
#
#     1. FastRW MC run (N_max=8192, M=16) with all three methods
#        (direct, fastrw, fasterrw) ->
#          outputs/tcad_table1/fastrw_case{1,2,3}/bootstrap_sweep_fastrw.json
#
#     2. PIRW MC run (N_max=4096, M=16) with the direct-only baseline ->
#          outputs/tcad_table1/pirw_case{1,2,3}/bootstrap_sweep_pirw.json
#
#   Then invokes scripts/plot_bootstrap_curves.py on the swept cases,
#   producing:
#     outputs/tcad_table1/case{1,2,3}_bootstrap_curve.{png,pdf}
#
#   (The same sweep JSONs are also consumed by
#   scripts/build_table1_bootstrap.js to rebuild Table 1.)
#
# Usage
#   ./scripts/run_bootstrap_sweep.sh [<case>]
#
#   <case>  optional: 1, 2, or 3.  Omit to run all three cases.
#
# Env vars
#   SKIP_PLOTS=1   skip the plot_bootstrap_curves.py step (data only).
#
# Prerequisites
#   FastRW MC runs (N_max=8192) at:
#     outputs/tcad_table1/fastrw_case{1,2,3}/
#   PIRW    MC runs (N_max=4096) at:
#     outputs/tcad_table1/pirw_case{1,2,3}/
#   Run scripts/run_fastrw_direct.sh and scripts/run_pirw_direct.sh
#   to produce them.
#
# Settings:
#   B    = 500   (bootstrap trials per N)
#   seed = 42
#   grid = 32,48,64,96,128,192,256,384,512,640,768,896,1024,1280,
#          1536,1792,2048,2560,3072,4096,6144,8192
#          (clipped to Nmax of the underlying MC run; PIRW caps at 4096)
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/run_bootstrap_sweep.js"

B=500
SEED=42

run_fastrw_case() {
  local CASE="$1"
  local RUN_DIR="${ROOT_DIR}/outputs/tcad_table1/fastrw_case${CASE}"
  local CONFIG="${ROOT_DIR}/configs/tcad_table1/fastrw_case${CASE}.json"
  local OUT_FILE="${RUN_DIR}/bootstrap_sweep_fastrw.json"

  if [[ ! -d "${RUN_DIR}" ]]; then
    echo "[run_bootstrap_sweep] ERROR: FastRW MC run dir not found: ${RUN_DIR}" >&2
    echo "[run_bootstrap_sweep] Run scripts/run_fastrw_direct.sh first." >&2
    exit 1
  fi

  echo "[run_bootstrap_sweep] fastrw_case${CASE}: methods=direct,fastrw,fasterrw B=${B} seed=${SEED} -> ${OUT_FILE}"
  node "${SCRIPT}" "${RUN_DIR}" "${CONFIG}" \
    --methods=direct,fastrw,fasterrw \
    --B="${B}" --seed="${SEED}" \
    --output="${OUT_FILE}"
}

run_pirw_case() {
  local CASE="$1"
  local RUN_DIR="${ROOT_DIR}/outputs/tcad_table1/pirw_case${CASE}"
  local CONFIG="${ROOT_DIR}/configs/tcad_table1/pirw_case${CASE}.json"
  local OUT_FILE="${RUN_DIR}/bootstrap_sweep_pirw.json"

  if [[ ! -d "${RUN_DIR}" ]]; then
    echo "[run_bootstrap_sweep] ERROR: PIRW MC run dir not found: ${RUN_DIR}" >&2
    echo "[run_bootstrap_sweep] Run scripts/run_pirw_direct.sh first." >&2
    exit 1
  fi

  echo "[run_bootstrap_sweep] pirw_case${CASE}:   methods=direct B=${B} seed=${SEED} -> ${OUT_FILE}"
  node "${SCRIPT}" "${RUN_DIR}" "${CONFIG}" \
    --methods=direct \
    --B="${B}" --seed="${SEED}" \
    --output="${OUT_FILE}"
}

run_case() {
  local CASE="$1"
  run_fastrw_case "${CASE}"
  run_pirw_case   "${CASE}"
}

CASE_ARG="${1:-all}"
PLOT_ARGS=()

case "${CASE_ARG}" in
  1|2|3)
    run_case "${CASE_ARG}"
    PLOT_ARGS=("${CASE_ARG}")
    ;;
  all)
    run_case 1
    run_case 2
    run_case 3
    PLOT_ARGS=(1 2 3)
    ;;
  --help|-h)
    sed -n '2,46p' "$0"
    exit 0
    ;;
  *)
    echo "Usage: $0 [1|2|3]  (omit for all cases)" >&2
    exit 2
    ;;
esac

if [[ "${SKIP_PLOTS:-0}" != "1" ]]; then
  echo "[run_bootstrap_sweep] Plotting cases: ${PLOT_ARGS[*]}"
  python3 "${ROOT_DIR}/scripts/plot_bootstrap_curves.py" "${PLOT_ARGS[@]}"
fi

echo "[run_bootstrap_sweep] Done."
