#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build-metal"
CONFIG_FILE="${1:-${ROOT_DIR}/configs/case3_16core.json}"
NUM_SAMPLES="${2:-2}"
THREADS_PER_THREADGROUP="${3:--1}"

RUNNER=()
if [[ "${USE_CONDA_RUN:-1}" == "1" ]] && command -v conda >/dev/null 2>&1; then
  if conda env list | awk '{print $1}' | grep -qx "FastRW"; then
    RUNNER=(conda run -n FastRW --no-capture-output)
  fi
fi

if [[ "${CONDA_DEFAULT_ENV:-}" != "FastRW" && ${#RUNNER[@]} -eq 0 ]]; then
  echo "FastRW conda environment is not active; using tools from PATH."
  echo "Create it with: conda env create -f ${ROOT_DIR}/environment.yml"
fi

"${RUNNER[@]}" cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE=Release
"${RUNNER[@]}" cmake --build "${BUILD_DIR}" --target random_walker_metal --parallel

cd "${ROOT_DIR}"
RW_LOG="${BUILD_DIR}/last_random_walker_metal.log"
"${BUILD_DIR}/random_walker_metal" "${CONFIG_FILE}" "${NUM_SAMPLES}" "${THREADS_PER_THREADGROUP}" | tee "${RW_LOG}"

RUN_ONESTAGE="${RUN_ONESTAGE:-1}"
if [[ "${RUN_ONESTAGE}" == "1" ]]; then
  if (( NUM_SAMPLES < 2 )); then
    echo "Skipping Onestage fusion: sample variance estimates require NUM_SAMPLES >= 2."
    exit 0
  fi
  CONSTRAINTS_JSON="$(awk -F'Constraints saved to ' '/Constraints saved to /{print $2}' "${RW_LOG}" | tail -n 1)"
  DIRECT_CSV="$(awk -F'Results saved to ' '/Results saved to /{print $2}' "${RW_LOG}" | tail -n 1)"
  CONSTRAINTS_JSON="${CONSTRAINTS_JSON%\"}"
  CONSTRAINTS_JSON="${CONSTRAINTS_JSON#\"}"
  DIRECT_CSV="${DIRECT_CSV%\"}"
  DIRECT_CSV="${DIRECT_CSV#\"}"
  RUN_DIR="$(dirname "${CONSTRAINTS_JSON}")"
  if [[ ! -f "${CONSTRAINTS_JSON}" ]]; then
    echo "Missing constraints JSON: ${CONSTRAINTS_JSON}" >&2
    exit 2
  fi
  if [[ ! -f "${DIRECT_CSV}" ]]; then
    echo "Missing direct CSV: ${DIRECT_CSV}" >&2
    exit 2
  fi
  node "${ROOT_DIR}/scripts/run_onestage_fusion.js" "${RUN_DIR}" "${CONSTRAINTS_JSON}" "${DIRECT_CSV}"
fi
