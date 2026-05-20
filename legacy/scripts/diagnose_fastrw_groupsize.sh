#!/usr/bin/env bash
# =====================================================================
# diagnose_fastrw_groupsize.sh
#
# One-key entry for the controlled four-variant comparison that
# diagnoses why FastRW's per-query speedup N_hat/N stays at ~1.00x
# across G in {1,4,8,16} on Case 1 (TCAD tab:multi), despite a back-
# of-envelope ceiling of ~1.65x at G=16.
#
# Inputs (must exist):
#   outputs/tcad_table1/fastrw_case1/constraints.json
#   outputs/tcad_table1/fastrw_case1/direct.csv
#
# Output:
#   outputs/diagnose_fastrw_groupsize/case1_variants.json
#
# Settings match scripts/run_group_size_sweep.sh:
#   N=1000, B=500, seed=42, groups=1,4,8,16
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/diagnose_fastrw_groupsize.js"
RUN_DIR="${ROOT_DIR}/outputs/tcad_table1/fastrw_case1"
OUT_DIR="${ROOT_DIR}/outputs/diagnose_fastrw_groupsize"
OUT_FILE="${OUT_DIR}/case1_variants.json"

N=1000
B=500
SEED=42
GROUP_SIZES="1,4,8,16"

mkdir -p "${OUT_DIR}"

if [[ ! -d "${RUN_DIR}" ]]; then
  echo "[diagnose_fastrw_groupsize] ERROR: MC run dir not found: ${RUN_DIR}" >&2
  exit 1
fi

echo "[diagnose_fastrw_groupsize] Case 1 four-variant sweep: N=${N} B=${B} seed=${SEED} groups=${GROUP_SIZES}"
echo "[diagnose_fastrw_groupsize] Output -> ${OUT_FILE}"

node "${SCRIPT}" \
  --run_dir="${RUN_DIR}" \
  --N="${N}" --B="${B}" --seed="${SEED}" --groups="${GROUP_SIZES}" \
  --output="${OUT_FILE}"

echo "[diagnose_fastrw_groupsize] Done."
