#!/usr/bin/env bash
# =====================================================================
# comsol.sh
#
# Re-compute every shipped COMSOL FEM prior from scratch by iterating
# over the existing `data/cases/case{1,2,3}/comsol/comso_<dof>/`
# directories and replaying the recorded mesh parameters via
# `scripts/run_comsol_case3_rebuild.sh`.
#
# Each rebuild target writes `temp.bin`, `metadata.json`,
# `heat_layer_cell_center_temperatures.{bin,csv}`, and a fresh
# `comsol_batch.log` into the same `comso_<dof>/` directory.
# `temp.bin` is updated by aliasing
# `heat_layer_cell_center_temperatures.bin` after each solve.
#
# `comso_full/` is skipped: it is the externally-supplied ground-truth
# field (`legacy_fine` source), not produced by this pipeline.
#
# Requirements
#   - COMSOL Multiphysics 6.2 CLI at /Applications/COMSOL62/Multiphysics/bin/comsol
#     (override with COMSOL_BIN env var).
#   - All `data/cases/case{1,2,3}/` populated (run ./scripts/fetch_artifacts.sh
#     first if the data/ tree is empty).
#
# Usage
#   ./comsol.sh                # rebuild every (case, dof) we have mesh params for
#   ./comsol.sh --cases=1      # restrict to case 1
#   ./comsol.sh --dry-run      # print the planned invocations and exit
#   COMSOL_BIN=/path/to/comsol ./comsol.sh
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

CASES="1,2,3"
DRY_RUN=0
COMSOL_BIN="${COMSOL_BIN:-/Applications/COMSOL62/Multiphysics/bin/comsol}"

for arg in "$@"; do
  case "${arg}" in
    --cases=*)  CASES="${arg#--cases=}" ;;
    --dry-run)  DRY_RUN=1 ;;
    --help|-h)  sed -n '2,33p' "$0"; exit 0 ;;
    *)          echo "Unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done

IFS=',' read -ra CASE_LIST <<< "${CASES}"

case_dir_name_for() {
  case "$1" in
    1) echo "case1_power6" ;;
    2) echo "case2_4core_top1_bottom1" ;;
    3) echo "case3_16core" ;;
    *) echo "" ;;
  esac
}

case_config_for() {
  case "$1" in
    1) echo "configs/tcad_table1/fastrw_case1.json" ;;
    2) echo "configs/tcad_table1/fastrw_case2.json" ;;
    3) echo "configs/tcad_table1/fastrw_case3.json" ;;
    *) echo "" ;;
  esac
}

if (( DRY_RUN == 0 )) && [[ ! -x "${COMSOL_BIN}" ]]; then
  echo "[comsol] ERROR: COMSOL CLI not executable: ${COMSOL_BIN}" >&2
  echo "[comsol]        Install COMSOL 6.2 or override with COMSOL_BIN=..." >&2
  exit 1
fi

rebuild_one() {
  local case_id="$1" dof_dir="$2"
  local case_dir_name config
  case_dir_name="$(case_dir_name_for "${case_id}")"
  config="$(case_config_for "${case_id}")"
  local dof_name
  dof_name="$(basename "${dof_dir}")"
  local meta="${dof_dir}/metadata.json"

  if [[ ! -f "${meta}" ]]; then
    echo "[comsol]   skip ${case_dir_name}/${dof_name}: no metadata.json"
    return 0
  fi
  if [[ "${dof_name}" == "comso_full" ]]; then
    echo "[comsol]   skip ${case_dir_name}/${dof_name}: ground-truth (externally sourced)"
    return 0
  fi

  # Extract mesh params via python (newline-separated to survive spaces)
  local mesh_label hmax hmin hgrad hnarrow hcurve
  IFS=$'\n' read -r -d '' mesh_label hmax hmin hgrad hnarrow hcurve < <(python3 - "${meta}" <<'PY' && printf '\0'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
mesh = d.get("mesh") or {}
label = d.get("requested_mesh_label") or mesh.get("label") or "rebuilt"
print(label)
for k in ("hmax", "hmin", "hgrad", "hnarrow", "hcurve"):
    print(mesh.get(k, ""))
PY
) || true
  if [[ -z "${hmax:-}" ]]; then
    echo "[comsol]   skip ${case_dir_name}/${dof_name}: no mesh params in metadata"
    return 0
  fi

  echo "[comsol] ${case_dir_name}/${dof_name}  hmax=${hmax} hmin=${hmin} hgrad=${hgrad} hnarrow=${hnarrow} hcurve=${hcurve}"

  local cmd=(
    "${ROOT_DIR}/scripts/run_comsol_case3_rebuild.sh"
    --config       "${config}"
    --output-dir   "${dof_dir}"
    --mesh-label   "${mesh_label}"
    --hmax         "${hmax}"
    --hmin         "${hmin}"
    --hgrad        "${hgrad}"
    --hnarrow      "${hnarrow}"
    --hcurve       "${hcurve}"
    --comsol       "${COMSOL_BIN}"
  )

  if (( DRY_RUN )); then
    printf '          DRY: '
    printf '%q ' "${cmd[@]}"
    printf '\n'
    return 0
  fi

  "${cmd[@]}"

  # Alias the COMSOL output back to temp.bin (compatibility name).
  if [[ -f "${dof_dir}/heat_layer_cell_center_temperatures.bin" ]]; then
    cp "${dof_dir}/heat_layer_cell_center_temperatures.bin" "${dof_dir}/temp.bin"
  fi
}

for case_id in "${CASE_LIST[@]}"; do
  case_dir_name="$(case_dir_name_for "${case_id}")"
  if [[ -z "${case_dir_name}" ]]; then
    echo "[comsol] unknown case id '${case_id}'; expected 1, 2, or 3." >&2
    continue
  fi
  case_root="${ROOT_DIR}/data/cases/${case_dir_name}/comsol"
  if [[ ! -d "${case_root}" ]]; then
    echo "[comsol] skip case ${case_id}: ${case_root} missing (run scripts/fetch_artifacts.sh)"
    continue
  fi
  echo ""
  echo "=== case ${case_id} (${case_dir_name}) ==="
  for dof_dir in "${case_root}"/comso_*/; do
    [[ -d "${dof_dir}" ]] || continue
    rebuild_one "${case_id}" "${dof_dir%/}"
  done
done

echo ""
echo "[comsol] All done."
