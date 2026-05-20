#!/usr/bin/env bash
# =====================================================================
# reproduce.sh
#
# Top-level one-key reproduction driver.
#
# Runs Phase 1 (Metal MC) -> Phase 2 (paper-locked N post-processing)
# -> Phase 3 (sub-experiments: bootstrap sweep, group size, prior DoF,
# weak prior, wallclock breakdown) -> Phase 4 (HTML report). By default
# Phase 1 is auto-skipped if its outputs already exist (i.e. the
# artifact zip was extracted by scripts/fetch_artifacts.sh).
#
# Usage:
#   ./reproduce.sh                        # all 3 cases, auto-skip Phase 1 if shipped
#   ./reproduce.sh --cases=1              # restrict to case 1
#   ./reproduce.sh --force-phase1         # re-run Phase 1 even if outputs exist
#   ./reproduce.sh --skip-phase3          # only Phase 1 + 2 + report
#   ./reproduce.sh --skip-report          # skip HTML report build
#   ./reproduce.sh --help                 # show this header
#
# Output:
#   outputs/tcad_table1/paper_results/    paper-locked-N JSON cells
#   outputs/tcad_table1/bootstrap_case*.{png,pdf}   Fig. bootstrap
#   outputs/tcad_table_{multi,tradeoff,weakprior,time}/*.json
#   outputs/report.html                   self-contained HTML summary
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT_DIR}"

CASES="1,2,3"
FORCE_PHASE1=0
SKIP_PHASE3=0
SKIP_REPORT=0

for arg in "$@"; do
  case "${arg}" in
    --cases=*)        CASES="${arg#--cases=}" ;;
    --force-phase1)   FORCE_PHASE1=1 ;;
    --skip-phase3)    SKIP_PHASE3=1 ;;
    --skip-report)    SKIP_REPORT=1 ;;
    --help|-h)        sed -n '2,25p' "$0"; exit 0 ;;
    *)                echo "Unknown argument: ${arg}" >&2; exit 2 ;;
  esac
done

IFS=',' read -ra CASE_LIST <<< "${CASES}"

# ----- Auto-extract artifact zip on first run -------------------------
if [[ ! -d "${ROOT_DIR}/data/cases/case1_power6" ]] \
   && [[ -f "${ROOT_DIR}/resrw-artifacts-v1.zip" ]]; then
  echo "[reproduce] data/ is empty; extracting resrw-artifacts-v1.zip..."
  "${ROOT_DIR}/scripts/fetch_artifacts.sh"
fi

mc_outputs_exist() {
  local case_id="$1"
  [[ -f "${ROOT_DIR}/outputs/tcad_table1/fastrw_case${case_id}/direct.csv" ]] && \
  [[ -f "${ROOT_DIR}/outputs/tcad_table1/pirw_case${case_id}/direct.csv" ]]
}

# ----- Phase 1: Metal Monte Carlo --------------------------------------
phase1_needed=0
if [[ "${FORCE_PHASE1}" == "1" ]]; then
  phase1_needed=1
else
  for c in "${CASE_LIST[@]}"; do
    if ! mc_outputs_exist "${c}"; then
      phase1_needed=1
      break
    fi
  done
fi

if (( phase1_needed )); then
  echo ""
  echo "============================================================"
  echo "  Phase 1: Metal Monte Carlo (~10 min on Apple M-series)"
  echo "============================================================"
  for c in "${CASE_LIST[@]}"; do
    ./scripts/run_pirw_direct.sh   "${c}"
    ./scripts/run_fastrw_direct.sh "${c}"
  done
else
  echo "[reproduce] Phase 1: shipped MC outputs detected for case(s) ${CASES}; skipping."
  echo "[reproduce]          (pass --force-phase1 to re-run anyway)"
fi

# ----- Phase 2: Paper-locked-N post-processing -------------------------
echo ""
echo "============================================================"
echo "  Phase 2: Table 1 (paper-locked N, B=500 bootstrap)"
echo "============================================================"
for c in "${CASE_LIST[@]}"; do
  ./scripts/run_pirw_post.sh      "${c}"
  ./scripts/run_fastrw_post.sh    "${c}"
  ./scripts/run_fasterrw_post.sh  "${c}"
done

# ----- Phase 3: Sub-experiments ----------------------------------------
if (( SKIP_PHASE3 == 0 )); then
  echo ""
  echo "============================================================"
  echo "  Phase 3: bootstrap sweep + group / DoF / weak-prior / time"
  echo "============================================================"

  # Dense N-grid sweep + Fig. bootstrap (all selected cases).
  for c in "${CASE_LIST[@]}"; do
    ./scripts/run_bootstrap_sweep.sh "${c}"
  done

  # Single-case experiments (Case 1 only in the paper).
  if [[ " ${CASE_LIST[*]} " == *" 1 "* ]]; then
    ./scripts/run_group_size_sweep.sh

    # --skip-fem: COMSOL not available in OSS environment.
    # --skip-mc:  use Phase-3 MC outputs shipped at outputs/tcad_table_tradeoff/dof*/
    ./scripts/run_prior_dof_sweep.sh --skip-fem --skip-mc

    # --skip-mc: use shipped Lambda=1e-3 MC at outputs/tcad_table_weakprior/fastrw_case1_rot/
    ./scripts/run_weak_prior.sh --skip-mc

    ./scripts/run_wallclock_breakdown.sh
  else
    echo "[reproduce] Phase 3 single-case experiments require case 1; skipping (got --cases=${CASES})."
  fi
fi

# ----- Phase 4: HTML report --------------------------------------------
if (( SKIP_REPORT == 0 )); then
  echo ""
  echo "============================================================"
  echo "  Phase 4: HTML report"
  echo "============================================================"
  python3 "${ROOT_DIR}/scripts/build_html_report.py"
  echo "[reproduce] Report at outputs/report.html"
fi

echo ""
echo "[reproduce] All done."
