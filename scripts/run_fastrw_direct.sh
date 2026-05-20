#!/usr/bin/env bash
# =====================================================================
# run_fastrw_direct.sh
#
# Purpose
#   Run the FastRW Monte-Carlo simulation for all three cases (or a
#   single case). Uses the canonical configs in configs/tcad_table1/
#   with N_max=8192. Outputs go to:
#     outputs/tcad_table1/fastrw_case{1,2,3}/
#
#   The same MC output is used by both run_fastrw_post.sh (Alg. 1+2)
#   and run_fasterrw_post.sh (Alg. 1+2+3).
#
#   This script runs the GPU MC sweep only. Post-processing is done
#   separately by scripts/run_fastrw_post.sh / run_fasterrw_post.sh.
#
# Usage
#   ./scripts/run_fastrw_direct.sh [<case>] [<threads>]
#
#   <case>     optional: 1, 2, or 3.  Omit to run all three cases.
#   <threads>  optional threads-per-threadgroup hint (default: auto).
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

THREADS="${2:--1}"

run_case() {
  local CASE="$1"
  local CONFIG="${ROOT_DIR}/configs/tcad_table1/fastrw_case${CASE}.json"
  if [[ ! -f "${CONFIG}" ]]; then
    echo "[run_fastrw_direct] ERROR: config not found: ${CONFIG}" >&2
    exit 1
  fi
  echo "[run_fastrw_direct] case${CASE} N=8192 ..."
  "${ROOT_DIR}/scripts/build_and_run_metal.sh" \
    "${CONFIG}" 8192 "${THREADS}"
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
    sed -n '2,20p' "$0"
    exit 0
    ;;
  *)
    echo "Usage: $0 [1|2|3] [threads]  (omit case for all)" >&2
    exit 2
    ;;
esac

echo "[run_fastrw_direct] Done."
