#!/usr/bin/env bash
# =====================================================================
# fetch_artifacts.sh
#
# Extract resrw-artifacts-v1.zip (committed in the repo root) into
# data/ and outputs/, so the reproduction flow has the COMSOL priors
# and pre-computed Phase-1 long-MC outputs it needs.
#
# Usage:
#   ./scripts/fetch_artifacts.sh                       # use ./resrw-artifacts-v1.zip
#   ./scripts/fetch_artifacts.sh path/to/archive.zip   # explicit path
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZIP_PATH="${1:-${ROOT_DIR}/resrw-artifacts-v1.zip}"

if [[ ! -f "${ZIP_PATH}" ]]; then
  echo "[fetch_artifacts] ERROR: archive not found at: ${ZIP_PATH}" >&2
  exit 1
fi

if ! command -v unzip >/dev/null 2>&1; then
  echo "[fetch_artifacts] ERROR: 'unzip' not found on PATH." >&2
  exit 1
fi

echo "[fetch_artifacts] Extracting ${ZIP_PATH} into ${ROOT_DIR}"
cd "${ROOT_DIR}"
unzip -o -q "${ZIP_PATH}"

missing=0
for case_id in 1 2 3; do
  case_name=""
  case "${case_id}" in
    1) case_name="case1_power6" ;;
    2) case_name="case2_4core_top1_bottom1" ;;
    3) case_name="case3_16core" ;;
  esac
  for sub in "data/cases/${case_name}/power.bin" \
             "outputs/tcad_table1/fastrw_case${case_id}/direct.csv" \
             "outputs/tcad_table1/pirw_case${case_id}/direct.csv"; do
    if [[ ! -f "${ROOT_DIR}/${sub}" ]]; then
      echo "[fetch_artifacts] WARN: missing expected file ${sub}" >&2
      missing=$((missing + 1))
    fi
  done
done

if (( missing > 0 )); then
  echo "[fetch_artifacts] ${missing} expected files missing; archive may be incomplete." >&2
  exit 2
fi

echo "[fetch_artifacts] Done. Now run: ./reproduce.sh"
