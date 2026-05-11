#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build"
CONFIG_FILE="${1:-${ROOT_DIR}/configs/case3_16core.json}"
NUM_SAMPLES="${2:-2}"
NUM_WORKERS="${3:--1}"
RUN_RANDOM_WALK="${RUN_RANDOM_WALK:-1}"
LAST_RUN_DIR=""
LAST_CONSTRAINTS=""
LAST_DIRECT_CSV=""

if [[ "${RUN_RANDOM_WALK}" == "1" ]]; then
  cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE=Release
  cmake --build "${BUILD_DIR}" --parallel

  cd "${ROOT_DIR}"
  RW_LOG="${BUILD_DIR}/last_random_walker.log"
  "${BUILD_DIR}/random_walker" "${CONFIG_FILE}" "${NUM_SAMPLES}" "${NUM_WORKERS}" | tee "${RW_LOG}"
  LAST_CONSTRAINTS="$(awk -F'Constraints saved to ' '/Constraints saved to /{print $2}' "${RW_LOG}" | tail -n 1)"
  LAST_DIRECT_CSV="$(awk -F'Results saved to ' '/Results saved to /{print $2}' "${RW_LOG}" | tail -n 1)"
  LAST_CONSTRAINTS="${LAST_CONSTRAINTS%\"}"
  LAST_CONSTRAINTS="${LAST_CONSTRAINTS#\"}"
  LAST_DIRECT_CSV="${LAST_DIRECT_CSV%\"}"
  LAST_DIRECT_CSV="${LAST_DIRECT_CSV#\"}"
  if [[ -n "${LAST_CONSTRAINTS}" ]]; then
    LAST_RUN_DIR="$(dirname "${LAST_CONSTRAINTS}")"
  fi
else
  LAST_RUN_DIR="${RUN_DIR:-${ROOT_DIR}/outputs}"
  LAST_CONSTRAINTS="${CONSTRAINTS_JSON:-${LAST_RUN_DIR}/constraints.json}"
  LAST_DIRECT_CSV="${DIRECT_CSV:-${LAST_RUN_DIR}/direct.csv}"
  echo "Skipping random-walk run; using ${LAST_CONSTRAINTS} and ${LAST_DIRECT_CSV} for Onestage fusion."
fi

# === Onestage post-processing ===
# Set RUN_ONESTAGE=0 to skip this section.
RUN_ONESTAGE="${RUN_ONESTAGE:-1}"
if [[ "${RUN_ONESTAGE}" == "1" ]]; then
  if [[ "${RUN_RANDOM_WALK}" == "1" ]] && (( NUM_SAMPLES < 2 )); then
    echo "Skipping Onestage fusion: sample variance estimates require NUM_SAMPLES >= 2."
    exit 0
  fi
  if [[ ! -f "${LAST_CONSTRAINTS}" ]]; then
    echo "Missing constraints JSON: ${LAST_CONSTRAINTS}" >&2
    exit 2
  fi
  if [[ ! -f "${LAST_DIRECT_CSV}" ]]; then
    echo "Missing direct CSV: ${LAST_DIRECT_CSV}" >&2
    exit 2
  fi
  node "${ROOT_DIR}/scripts/run_onestage_fusion.js" "${LAST_RUN_DIR}" "${LAST_CONSTRAINTS}" "${LAST_DIRECT_CSV}"
fi
