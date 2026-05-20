#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${ROOT_DIR}/build"
CONFIG_FILE="${1:-${ROOT_DIR}/configs/tcad_table1/fastrw_case1.json}"
NUM_SAMPLES="${2:-2}"
NUM_WORKERS="${3:--1}"
RW_LOG=""

config_output_dir() {
  local config_file="$1"
  node -e '
const fs = require("fs");
const path = require("path");
const configPath = path.resolve(process.argv[1]);
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const outputDir = config.output && config.output.directory ? config.output.directory : "../outputs";
console.log(path.resolve(path.dirname(configPath), outputDir));
' "${config_file}"
}

detect_cpu_device() {
  if command -v sysctl >/dev/null 2>&1; then
    local brand
    brand="$(sysctl -n machdep.cpu.brand_string 2>/dev/null || true)"
    if [[ -n "${brand}" ]]; then
      echo "${brand}"
      return
    fi
  fi
  if command -v lscpu >/dev/null 2>&1; then
    local model
    model="$(lscpu 2>/dev/null | awk -F: '/Model name/{sub(/^[ \t]+/, "", $2); print $2; exit}')"
    if [[ -n "${model}" ]]; then
      echo "${model}"
      return
    fi
  fi
  if [[ -r /proc/cpuinfo ]]; then
    local proc_model
    proc_model="$(awk -F: '/model name/{sub(/^[ \t]+/, "", $2); print $2; exit}' /proc/cpuinfo)"
    if [[ -n "${proc_model}" ]]; then
      echo "${proc_model}"
      return
    fi
  fi
  echo "CPU"
}

write_random_walk_summary() {
  local run_dir="$1"
  local log_file="$2"
  local backend="$3"
  local device="$4"
  node -e '
const fs = require("fs");
const path = require("path");
const [runDir, logFile, backend, device, configFile, numSamples] = process.argv.slice(1);
const text = fs.readFileSync(logFile, "utf8");
const matches = [...text.matchAll(/\b(?:Metal\s+)?simulation complete in\s+([0-9eE+.-]+)\s+seconds\.?/gi)];
if (!matches.length) {
  console.error(`Failed to parse random-walk runtime from ${logFile}`);
  process.exit(2);
}
const runtimeSeconds = Number(matches[matches.length - 1][1]);
if (!Number.isFinite(runtimeSeconds)) {
  console.error(`Invalid random-walk runtime parsed from ${logFile}: ${matches[matches.length - 1][1]}`);
  process.exit(2);
}
const summaryPath = path.join(runDir, "summary.json");
let summary = {};
if (fs.existsSync(summaryPath)) {
  summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
}
summary.random_walk = {
  backend,
  device,
  runtime_seconds: runtimeSeconds,
  runtime_source: "simulate_temperature_multi log line",
  config: path.relative(process.cwd(), path.resolve(configFile)),
  num_samples: Number(numSamples),
  log: path.relative(runDir, path.resolve(logFile)),
};
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
' "${run_dir}" "${log_file}" "${backend}" "${device}" "${CONFIG_FILE}" "${NUM_SAMPLES}"
}

cmake -S "${ROOT_DIR}" -B "${BUILD_DIR}" -DCMAKE_BUILD_TYPE=Release
cmake --build "${BUILD_DIR}" --parallel

cd "${ROOT_DIR}"
RUN_DIR="$(config_output_dir "${CONFIG_FILE}")"
mkdir -p "${RUN_DIR}"
RW_LOG="${RUN_DIR}/last_random_walker.log"
"${BUILD_DIR}/random_walker" "${CONFIG_FILE}" "${NUM_SAMPLES}" "${NUM_WORKERS}" | tee "${RW_LOG}"
CONSTRAINTS_JSON="$(awk -F'Constraints saved to ' '/Constraints saved to /{print $2}' "${RW_LOG}" | tail -n 1)"
CONSTRAINTS_JSON="${CONSTRAINTS_JSON%\"}"
CONSTRAINTS_JSON="${CONSTRAINTS_JSON#\"}"
if [[ -n "${CONSTRAINTS_JSON}" ]]; then
  RUN_DIR="$(dirname "${CONSTRAINTS_JSON}")"
fi
if [[ -n "${RUN_DIR}" ]]; then
  write_random_walk_summary "${RUN_DIR}" "${RW_LOG}" "cpp" "$(detect_cpu_device)"
fi

# Post-processing (FastRW / FasterRW) is handled by the dedicated
# run_*_post.sh scripts; this builder only produces the MC artifacts.
