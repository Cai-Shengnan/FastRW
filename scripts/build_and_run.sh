#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build"
CONFIG_FILE="${1:-${ROOT_DIR}/configs/case3_16core.json}"
NUM_SAMPLES="${2:-2}"
NUM_WORKERS="${3:--1}"
RUN_RANDOM_WALK="${RUN_RANDOM_WALK:-1}"
DEFAULT_STAN_DATA="${ROOT_DIR}/outputs/data.json"

if [[ "${RUN_RANDOM_WALK}" == "1" ]]; then
  cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE=Release
  cmake --build "${BUILD_DIR}" --parallel

  cd "${ROOT_DIR}"
  RW_LOG="${BUILD_DIR}/last_random_walker.log"
  "${BUILD_DIR}/random_walker" "${CONFIG_FILE}" "${NUM_SAMPLES}" "${NUM_WORKERS}" | tee "${RW_LOG}"
  LAST_STAN_DATA="$(awk -F'Stan data saved to ' '/Stan data saved to /{print $2}' "${RW_LOG}" | tail -n 1)"
  LAST_STAN_DATA="${LAST_STAN_DATA%\"}"
  LAST_STAN_DATA="${LAST_STAN_DATA#\"}"
  if [[ -n "${LAST_STAN_DATA}" ]]; then
    DEFAULT_STAN_DATA="${LAST_STAN_DATA}"
  fi
else
  echo "Skipping random-walk run; using ${STAN_DATA:-${DEFAULT_STAN_DATA}} for Stan data."
fi

# === Stan post-processing ===
# Set RUN_STAN=0 to skip this section.
RUN_STAN="${RUN_STAN:-1}"
if [[ "${RUN_STAN}" == "1" ]]; then
  if [[ "${RUN_RANDOM_WALK}" == "1" ]] && (( NUM_SAMPLES < 2 )); then
    echo "Skipping Stan post-processing: Stan variance estimates require NUM_SAMPLES >= 2."
    exit 0
  fi

  CMDSTAN_DIR="${ROOT_DIR}/third_party/cmdstan"
  STAN_MODEL_NAME="${STAN_MODEL_NAME:-onestage}"
  STAN_MODEL_SRC="${ROOT_DIR}/stan/${STAN_MODEL_NAME}.stan"
  STAN_CACHED_EXE="${ROOT_DIR}/stan/bin/${STAN_MODEL_NAME}"
  STAN_BUILD_DIR="${BUILD_DIR}/stan"
  STAN_MODEL_BUILD_SRC="${STAN_BUILD_DIR}/${STAN_MODEL_NAME}.stan"
  STAN_EXE="${STAN_BUILD_DIR}/${STAN_MODEL_NAME}"
  STAN_DATA="${STAN_DATA:-${DEFAULT_STAN_DATA}}"
  STAN_OUTPUT_DIR="${STAN_OUTPUT_DIR:-$(dirname "${STAN_DATA}")/stan}"
  STAN_CHAINS="${STAN_CHAINS:-1}"
  STAN_WARMUP="${STAN_WARMUP:-200}"
  STAN_SAMPLES="${STAN_SAMPLES:-200}"
  STAN_SEED="${STAN_SEED:-12345}"
  STAN_PRECOMPILED_HEADERS="${STAN_PRECOMPILED_HEADERS:-false}"
  STAN_OPT_LEVEL="${STAN_OPT_LEVEL:-0}"
  STAN_REBUILD="${STAN_REBUILD:-0}"
  export DYLD_LIBRARY_PATH="${CMDSTAN_DIR}/stan/lib/stan_math/lib/tbb${DYLD_LIBRARY_PATH:+:${DYLD_LIBRARY_PATH}}"

  if [[ ! -x "${CMDSTAN_DIR}/bin/stansummary" ]]; then
    echo "Missing CmdStan under ${CMDSTAN_DIR}."
    exit 2
  fi
  if [[ ! -f "${STAN_MODEL_SRC}" ]]; then
    echo "Missing Stan model: ${STAN_MODEL_SRC}"
    exit 2
  fi
  if [[ ! -f "${STAN_DATA}" ]]; then
    echo "Missing Stan data file: ${STAN_DATA}"
    exit 2
  fi

  mkdir -p "${STAN_BUILD_DIR}" "${STAN_OUTPUT_DIR}"

  if [[ "${STAN_REBUILD}" != "1" && -x "${STAN_CACHED_EXE}" ]]; then
    STAN_EXE="${STAN_CACHED_EXE}"
    echo "Using cached Stan executable: ${STAN_EXE}"
  else
    if [[ ! -f "${STAN_MODEL_BUILD_SRC}" ]] || ! cmp -s "${STAN_MODEL_SRC}" "${STAN_MODEL_BUILD_SRC}"; then
      cp "${STAN_MODEL_SRC}" "${STAN_MODEL_BUILD_SRC}"
    fi

    build_stan_model() {
      make -C "${CMDSTAN_DIR}" PRECOMPILED_HEADERS="${STAN_PRECOMPILED_HEADERS}" O="${STAN_OPT_LEVEL}" "${STAN_EXE}"
    }

    if ! build_stan_model; then
      echo "Stan build failed; removing stale CmdStan build files and retrying once."
      rm -rf "${CMDSTAN_DIR}/stan/src/stan/model/model_header.hpp.gch"
      rm -f "${STAN_EXE}" "${STAN_EXE}.d" "${STAN_BUILD_DIR}/${STAN_MODEL_NAME}.o" "${STAN_BUILD_DIR}/${STAN_MODEL_NAME}.hpp"
      build_stan_model
    fi
  fi

  STAN_OUTPUT_FILES=()
  for chain in $(seq 1 "${STAN_CHAINS}"); do
    output_file="${STAN_OUTPUT_DIR}/${STAN_MODEL_NAME}_chain${chain}.csv"
    "${STAN_EXE}" sample \
      num_warmup="${STAN_WARMUP}" \
      num_samples="${STAN_SAMPLES}" \
      data file="${STAN_DATA}" \
      random seed="$((STAN_SEED + chain - 1))" \
      output file="${output_file}"
    STAN_OUTPUT_FILES+=("${output_file}")
  done

  "${CMDSTAN_DIR}/bin/stansummary" "${STAN_OUTPUT_FILES[@]}" --sig_figs=4 \
    | tee "${STAN_OUTPUT_DIR}/${STAN_MODEL_NAME}_summary.txt"
fi
