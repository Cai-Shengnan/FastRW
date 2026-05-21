#!/usr/bin/env node
// =====================================================================
// run_wallclock_breakdown.js
//
// Purpose
//   Produce a per-query wallclock breakdown for Case 1 at eps=0.4 K,
//   broken down by stage (FEM prior / Random walk / Tail-reuse fusion /
//   Kriging refinement), for PIRW / FastRW / FasterRW. Feeds Table
//   `tab:time` in the TCAD experiments chapter.
//
// Methodology
//   - FEM prior: strict upper bound on per-query COMSOL solve time.
//     The cold comsol_batch.log for the canonical DoF=1288 prior logs
//     "求解时间：0 s" (solve time: 0 s), and COMSOL's batch log only
//     resolves to integer seconds. Under the conservative truncation
//     interpretation, the actual solve is < 1 s total, i.e.,
//     < 1/M = 0.0625 s per query. PIRW has no prior (0).
//   - Random walk: scale the existing N_max MC wallclock linearly:
//         MC_time(N) = runtime_seconds(N_max) * N / N_max / M
//     PIRW: pirw_case1 (N_max=4096); FastRW/FasterRW: fastrw_case1 (N_max=8192).
//   - Tail-reuse fusion: time `run_fastrw_post.js` at the method's chosen
//     N (B=500), divide by M. PIRW has no fusion (0).
//   - Kriging refinement: time `run_fasterrw_post.js` at FasterRW's chosen
//     N (B=500), subtract the corresponding `run_fastrw_post.js` time at
//     the SAME N (since fasterrw_post does fusion + GP internally), divide
//     by M.
//
//   Post-processor timings are repeated 3x with the median reported.
//
// Output
//   outputs/tcad_table_time/case1_eps04_wallclock.json
// =====================================================================
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');
const os = require('os');

const ROOT_DIR = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT_DIR, 'outputs', 'tcad_table_time');
const OUT_JSON = path.join(OUT_DIR, 'case1_eps04_wallclock.json');

const M_QUERIES = 16;
const B = 500;
const SEED = 42;
const REPEATS = 3;

// Paper-locked N for case1 at eps=0.4 K (per outputs/tcad_table1/paper_results
// for PIRW; FastRW / FasterRW use the more conservative wallclock-breakdown N
// historically used in the TCAD tab:time table).
const N_PIRW = 1280;
const N_FASTRW = 896;
const N_FASTERRW = 512;

const PIRW_RUN_DIR = path.join(ROOT_DIR, 'outputs', 'tcad_table1', 'pirw_case1');
const FASTRW_RUN_DIR = path.join(ROOT_DIR, 'outputs', 'tcad_table1', 'fastrw_case1');
const FASTRW_CONFIG = path.join(ROOT_DIR, 'configs', 'tcad_table1', 'fastrw_case1.json');

const PIRW_POST = path.join(ROOT_DIR, 'scripts', 'run_pirw_post.js');
const FASTRW_POST = path.join(ROOT_DIR, 'scripts', 'run_fastrw_post.js');
const FASTERRW_POST = path.join(ROOT_DIR, 'scripts', 'run_fasterrw_post.js');

const COMSOL_DIR = path.join(ROOT_DIR, 'data', 'cases', 'case1_power6', 'comsol', 'comso_1288');

// ---------- helpers ----------

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return 0.5 * (sorted[mid - 1] + sorted[mid]);
  return sorted[mid];
}

function timeOnce(cmd, args, label) {
  const t0 = performance.now();
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const t1 = performance.now();
  if (r.status !== 0) {
    process.stderr.write(`[${label}] FAILED (status=${r.status})\n`);
    process.stderr.write(r.stderr ? r.stderr.toString() : '');
    process.exit(1);
  }
  return (t1 - t0) / 1000.0;
}

function timeMedian(cmd, args, label, repeats = REPEATS) {
  const samples = [];
  for (let i = 0; i < repeats; i++) {
    const t = timeOnce(cmd, args, `${label} run${i + 1}/${repeats}`);
    samples.push(t);
    process.stdout.write(`  [${label}] run ${i + 1}/${repeats}: ${t.toFixed(3)}s\n`);
  }
  return { median: median(samples), samples };
}

// Use a scratch output file so we don't clobber paper_results.
function scratchOut(name) {
  const dir = path.join(os.tmpdir(), 'wallclock_breakdown');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

// ---------- main ----------

function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  process.stdout.write(`[wallclock] case1 eps=0.4 K, M=${M_QUERIES}, B=${B}\n`);
  process.stdout.write(`[wallclock] N: PIRW=${N_PIRW}, FastRW=${N_FASTRW}, FasterRW=${N_FASTERRW}\n`);

  // ---- FEM prior (strict upper bound on linear-solve time, amortized) ----
  // The cold COMSOL batch log emits two "求解时间" lines per study: the first
  // is the dependent-variable setup, the second is the actual MUMPS linear
  // solve. Only the linear solve scales with DoF, so we report that one as
  // the "solve cost" charged to FEM prior. COMSOL's batch log resolves to
  // integer seconds, so a logged "0 s" is interpreted as a strict upper
  // bound of 1 s (truncation interpretation, conservative).
  const comsolLog = fs.readFileSync(path.join(COMSOL_DIR, 'comsol_batch.log'), 'utf-8');
  const solveLineRe = /求解时间[：:]\s*(\d+)\s*s/g;
  const solveValues = [];
  let m;
  while ((m = solveLineRe.exec(comsolLog)) !== null) {
    solveValues.push(Number(m[1]));
  }
  const femSolveLogS = solveValues.length > 0 ? solveValues[solveValues.length - 1] : 0;
  // Strict upper bound under truncation: logged "X s" means actual < X+1 s.
  const femSolveUpperBoundS = femSolveLogS + 1;
  const femTotalS = femSolveUpperBoundS;
  const femPerQueryS = femTotalS / M_QUERIES;
  const femSource =
    `comsol_batch.log: 求解时间 lines = [${solveValues.join(', ')}] s; ` +
    `linear solve (last line) = ${femSolveLogS} s under COMSOL's integer-` +
    `second log resolution. Strict upper bound: ${femSolveUpperBoundS} s ` +
    `(truncation interpretation).`;
  process.stdout.write(
    `[wallclock] FEM linear-solve: logged=${femSolveLogS}s, ` +
    `upper bound=${femSolveUpperBoundS}s, per-query upper bound=${femPerQueryS.toFixed(4)}s\n`
  );

  // ---- MC scaling from existing N_max runs ----
  const pirwSummary = readJson(path.join(PIRW_RUN_DIR, 'summary.json'));
  const fastrwSummary = readJson(path.join(FASTRW_RUN_DIR, 'summary.json'));

  const pirwMcFullS = Number(pirwSummary.random_walk.runtime_seconds);
  const pirwNmax = Number(pirwSummary.random_walk.num_samples);
  const fastrwMcFullS = Number(fastrwSummary.random_walk.runtime_seconds);
  const fastrwNmax = Number(fastrwSummary.random_walk.num_samples);

  const mcPirwS = (pirwMcFullS * N_PIRW) / pirwNmax / M_QUERIES;
  const mcFastrwS = (fastrwMcFullS * N_FASTRW) / fastrwNmax / M_QUERIES;
  const mcFasterrwS = (fastrwMcFullS * N_FASTERRW) / fastrwNmax / M_QUERIES;

  process.stdout.write(
    `[wallclock] MC scaling: PIRW Nmax=${pirwNmax} runtime=${pirwMcFullS}s, ` +
    `FastRW(shared) Nmax=${fastrwNmax} runtime=${fastrwMcFullS}s\n`
  );
  process.stdout.write(
    `[wallclock] MC per-query: PIRW=${mcPirwS.toFixed(3)}s, FastRW=${mcFastrwS.toFixed(3)}s, FasterRW=${mcFasterrwS.toFixed(3)}s\n`
  );

  // ---- Post-processing wallclocks (median of 3) ----

  // (1) PIRW post at N_PIRW — for reference only (PIRW has no fusion/GP stage)
  process.stdout.write(`\n[wallclock] timing PIRW post (N=${N_PIRW})...\n`);
  const pirwPostT = timeMedian(
    'node',
    [
      PIRW_POST,
      PIRW_RUN_DIR,
      `--N=${N_PIRW}`,
      `--B=${B}`,
      `--seed=${SEED}`,
      `--output=${scratchOut(`pirw_N${N_PIRW}.json`)}`,
    ],
    `pirw_post N=${N_PIRW}`
  );

  // (2) FastRW fusion at N_FASTRW (the FastRW stage time)
  process.stdout.write(`\n[wallclock] timing FastRW fusion post (N=${N_FASTRW})...\n`);
  const fusionFastrwT = timeMedian(
    'node',
    [
      FASTRW_POST,
      FASTRW_RUN_DIR,
      FASTRW_CONFIG,
      `--N=${N_FASTRW}`,
      `--B=${B}`,
      `--seed=${SEED}`,
      `--output=${scratchOut(`fastrw_N${N_FASTRW}.json`)}`,
    ],
    `fastrw_post N=${N_FASTRW}`
  );

  // (3) FastRW fusion at N_FASTERRW (subtraction baseline for FasterRW GP isolation)
  process.stdout.write(`\n[wallclock] timing FastRW fusion post (N=${N_FASTERRW}) for GP isolation...\n`);
  const fusionAtFasterrwNT = timeMedian(
    'node',
    [
      FASTRW_POST,
      FASTRW_RUN_DIR,
      FASTRW_CONFIG,
      `--N=${N_FASTERRW}`,
      `--B=${B}`,
      `--seed=${SEED}`,
      `--output=${scratchOut(`fastrw_N${N_FASTERRW}.json`)}`,
    ],
    `fastrw_post N=${N_FASTERRW}`
  );

  // (4) FasterRW post at N_FASTERRW (fusion + GP combined)
  process.stdout.write(`\n[wallclock] timing FasterRW post (N=${N_FASTERRW})...\n`);
  const fasterrwT = timeMedian(
    'node',
    [
      FASTERRW_POST,
      FASTRW_RUN_DIR,
      FASTRW_CONFIG,
      `--N=${N_FASTERRW}`,
      `--B=${B}`,
      `--seed=${SEED}`,
      `--output=${scratchOut(`fasterrw_N${N_FASTERRW}.json`)}`,
    ],
    'fasterrw_post N=512'
  );

  // Per-query amortized post-processing times
  const fusionFastrwPerQueryS = fusionFastrwT.median / M_QUERIES;
  const fusionFasterrwPerQueryS = fusionAtFasterrwNT.median / M_QUERIES;
  const gpPerQueryRawS = (fasterrwT.median - fusionAtFasterrwNT.median) / M_QUERIES;
  // Floor GP at 0 in case of measurement noise (post-proc is fast, ~seconds).
  const gpPerQueryS = Math.max(gpPerQueryRawS, 0);

  // ---- Assemble totals ----
  const pirwTotal = 0 + mcPirwS + 0 + 0;
  const fastrwTotal = femPerQueryS + mcFastrwS + fusionFastrwPerQueryS + 0;
  const fasterrwTotal = femPerQueryS + mcFasterrwS + fusionFasterrwPerQueryS + gpPerQueryS;

  const speedupFastrw = pirwTotal / fastrwTotal;
  const speedupFasterrw = pirwTotal / fasterrwTotal;

  const out = {
    case: 'case1',
    eps_target_K: 0.4,
    M: M_QUERIES,
    B: B,
    device: 'Apple M5 Pro',
    seed_base: SEED,
    repeats_per_stage: REPEATS,

    N: { PIRW: N_PIRW, FastRW: N_FASTRW, FasterRW: N_FASTERRW },

    fem_prior_total_s: femTotalS,
    fem_prior_per_query_s: femPerQueryS,
    fem_prior_is_upper_bound: true,
    fem_prior_log_seconds: femSolveLogS,
    fem_prior_log_solve_values: solveValues,
    fem_prior_source: femSource,
    fem_prior_source_path: path.relative(ROOT_DIR, path.join(COMSOL_DIR, 'comsol_batch.log')),

    mc_runtime_full_pirw_s: pirwMcFullS,
    mc_runtime_full_pirw_Nmax: pirwNmax,
    mc_runtime_full_fastrw_s: fastrwMcFullS,
    mc_runtime_full_fastrw_Nmax: fastrwNmax,
    mc_scaling: 'linear in N, divided by M queries',

    postproc_wallclock_s: {
      [`pirw_post_N${N_PIRW}`]: { median: pirwPostT.median, samples: pirwPostT.samples },
      [`fastrw_post_N${N_FASTRW}`]: { median: fusionFastrwT.median, samples: fusionFastrwT.samples },
      [`fastrw_post_N${N_FASTERRW}`]: { median: fusionAtFasterrwNT.median, samples: fusionAtFasterrwNT.samples },
      [`fasterrw_post_N${N_FASTERRW}`]: { median: fasterrwT.median, samples: fasterrwT.samples },
    },

    stages: {
      PIRW: {
        FEM: 0,
        MC: mcPirwS,
        Fusion: 0,
        GP: 0,
        Total_per_query_s: pirwTotal,
      },
      FastRW: {
        FEM: femPerQueryS,
        MC: mcFastrwS,
        Fusion: fusionFastrwPerQueryS,
        GP: 0,
        Total_per_query_s: fastrwTotal,
      },
      FasterRW: {
        FEM: femPerQueryS,
        MC: mcFasterrwS,
        Fusion: fusionFasterrwPerQueryS,
        GP: gpPerQueryS,
        Total_per_query_s: fasterrwTotal,
      },
    },

    wallclock_speedup_vs_PIRW: {
      FastRW: speedupFastrw,
      FasterRW: speedupFasterrw,
    },

    generated_at: new Date().toISOString(),
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(out, null, 2) + '\n');
  process.stdout.write(`\n[wallclock] wrote ${OUT_JSON}\n`);

  // ---- pretty summary ----
  const fmt = (v) => (v === 0 ? '—' : v.toFixed(2));
  process.stdout.write('\n');
  process.stdout.write('Stage              | PIRW   | FastRW | FasterRW\n');
  process.stdout.write('-------------------+--------+--------+---------\n');
  const femDisplay = `<${femPerQueryS.toFixed(2)}`;
  process.stdout.write(
    `FEM prior          | ${fmt(0).padStart(6)} | ${femDisplay.padStart(6)} | ${femDisplay.padStart(7)}\n`
  );
  process.stdout.write(
    `Random walk        | ${mcPirwS.toFixed(2).padStart(6)} | ${mcFastrwS.toFixed(2).padStart(6)} | ${mcFasterrwS.toFixed(2).padStart(7)}\n`
  );
  process.stdout.write(
    `Tail-reuse fusion  | ${fmt(0).padStart(6)} | ${fmt(fusionFastrwPerQueryS).padStart(6)} | ${fmt(fusionFasterrwPerQueryS).padStart(7)}\n`
  );
  process.stdout.write(
    `Kriging refinement | ${fmt(0).padStart(6)} | ${fmt(0).padStart(6)} | ${fmt(gpPerQueryS).padStart(7)}\n`
  );
  process.stdout.write(
    `Total per query    | ${pirwTotal.toFixed(2).padStart(6)} | ${fastrwTotal.toFixed(2).padStart(6)} | ${fasterrwTotal.toFixed(2).padStart(7)}\n`
  );
  process.stdout.write('\n');
  process.stdout.write(`Speedup vs PIRW:  FastRW=${speedupFastrw.toFixed(2)}x  FasterRW=${speedupFasterrw.toFixed(2)}x\n`);
}

main();
