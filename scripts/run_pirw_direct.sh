#!/usr/bin/env bash
# =====================================================================
# run_pirw_direct.sh
#
# Purpose
#   Run the baseline PIRW Monte-Carlo simulation for all three cases
#   (or a single case). Uses the canonical configs in configs/tcad_table1/
#   with N_max=4096. Outputs go to:
#     outputs/tcad_table1/pirw_case{1,2,3}/
#
#   This script runs the GPU MC sweep only. Post-processing is done
#   separately by scripts/run_pirw_post.sh.
#
# Usage
#   ./scripts/run_pirw_direct.sh [<case>] [<threads>]
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
  local CONFIG="${ROOT_DIR}/configs/tcad_table1/pirw_case${CASE}.json"
  if [[ ! -f "${CONFIG}" ]]; then
    echo "[run_pirw_direct] ERROR: config not found: ${CONFIG}" >&2
    exit 1
  fi
  echo "[run_pirw_direct] case${CASE} N=4096 ..."
  "${ROOT_DIR}/scripts/build_and_run_metal.sh" \
    "${CONFIG}" 4096 "${THREADS}"
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
    sed -n '2,18p' "$0"
    exit 0
    ;;
  *)
    echo "Usage: $0 [1|2|3] [threads]  (omit case for all)" >&2
    exit 2
    ;;
esac

echo "[run_pirw_direct] Done."
