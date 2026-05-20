#!/usr/bin/env bash
# =====================================================================
# run_wallclock_breakdown.sh
#
# Purpose
#   One-key entry point to produce a per-query wallclock breakdown for
#   Case 1 at eps=0.4 K (stages: FEM prior / Random walk / Tail-reuse
#   fusion / Kriging refinement) for all three methods (PIRW / FastRW /
#   FasterRW). Feeds Table `tab:time` in the TCAD experiments chapter.
#
# Usage
#   ./scripts/run_wallclock_breakdown.sh
#
# Prerequisites
#   - PIRW MC run at outputs/tcad_table1/pirw_case1/ (N_max=4096).
#   - FastRW MC run at outputs/tcad_table1/fastrw_case1/ (N_max=8192).
#     (FasterRW shares this MC.)
#   - COMSOL prior at data/cases/case1_power6/comsol/comso_1288/ with
#     metadata.json carrying `runtime_seconds`.
#
# Outputs
#   outputs/tcad_table_time/case1_eps04_wallclock.json
#   outputs/tcad_table_time/README.md
#
# Methodology
#   - FEM prior: total COMSOL solve time / M=16 (per-query amortized).
#   - Random walk: scale existing N_max MC runtime linearly: N/N_max/M.
#   - Tail-reuse fusion: time run_fastrw_post.js at the method's N, /M.
#   - Kriging refinement: time run_fasterrw_post.js at FasterRW's N,
#     subtract run_fastrw_post.js at the same N, /M.
#   - Post-proc timings: median of 3 runs (post-proc is fast, ~seconds,
#     so noise dominates a single run).
# =====================================================================
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${ROOT_DIR}/scripts/run_wallclock_breakdown.js"
OUT_DIR="${ROOT_DIR}/outputs/tcad_table_time"

mkdir -p "${OUT_DIR}"

echo "[run_wallclock_breakdown] case1 eps=0.4 K, M=16, B=500"
echo "[run_wallclock_breakdown] timing PIRW / FastRW / FasterRW post-procs (median of 3)..."

node "${SCRIPT}"

echo "[run_wallclock_breakdown] Done. Results in ${OUT_DIR}/"
