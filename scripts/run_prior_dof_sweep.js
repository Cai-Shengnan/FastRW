#!/usr/bin/env node
// =====================================================================
// run_prior_dof_sweep.js
//
// Orchestrates the FEM-prior accuracy / RW truncation tradeoff sweep
// for TCAD Table `tab:tradeoff` (Case 1). For each (DoF, Lambda) row,
// runs the FastRW Monte-Carlo at N=1000 paths and (optionally) measures
// COMSOL warm-FEM wallclock from the existing `case3_rebuild.mph`.
//
// Inputs (per DoF):
//   - Config:   configs/tcad_table_tradeoff/fastrw_case1_dof<DoF>.json
//   - Prior:    data/cases/case1_power6/comsol/comso_<DoF>/temp.bin
//   - COMSOL:   data/cases/case1_power6/comsol/comso_<DoF>/case3_rebuild.mph
//
// Outputs:
//   - MC dir:   outputs/tcad_table_tradeoff/dof<DoF>/
//   - FEM warm: data/cases/case1_power6/comsol/comso_<DoF>/timing_warm.json
//   - Summary:  outputs/tcad_table_tradeoff/case1_dof_sweep.json
//
// Constraints honored:
//   - DoF=1288 timing_warm.json is NOT overwritten (read from disk).
//   - temp.bin / metadata.json are never touched.
//   - Canonical configs / scripts are not modified.
// =====================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const os = require("os");

const ROOT_DIR = path.resolve(__dirname, "..");
const COMSOL_BIN = "/Applications/COMSOL62/Multiphysics/bin/comsol";

// Prior-error values reported here are the GLOBAL max |T_prior - T_GT|
// over the full heat-layer cell-center grid (matches the max_abs field
// in each `data/cases/case1_power6/comsol/comso_<dof>/metadata.json`).
// Lambda is then chosen so that the threshold-induced bias bound
// Lambda * max_err_K stays roughly constant across the three DoFs
// (~0.11 K, well below the iso-accuracy targets eps in {0.4, 0.5} K).
const ROWS = [
  {
    dof: 699,
    max_err_K: 8.71,
    avg_err_K: 2.74,
    lambda: 0.013,
    config: path.join(ROOT_DIR, "configs/tcad_table_tradeoff/fastrw_case1_dof699.json"),
    out_dir: path.join(ROOT_DIR, "outputs/tcad_table_tradeoff/dof699"),
    comsol_dir: path.join(ROOT_DIR, "data/cases/case1_power6/comsol/comso_699"),
  },
  {
    dof: 1288,
    max_err_K: 3.76,
    avg_err_K: 0.74,
    lambda: 0.030,
    config: path.join(ROOT_DIR, "configs/tcad_table_tradeoff/fastrw_case1_dof1288.json"),
    out_dir: path.join(ROOT_DIR, "outputs/tcad_table_tradeoff/dof1288"),
    comsol_dir: path.join(ROOT_DIR, "data/cases/case1_power6/comsol/comso_1288"),
  },
  {
    dof: 10254,
    max_err_K: 1.26,
    avg_err_K: 0.23,
    lambda: 0.090,
    config: path.join(ROOT_DIR, "configs/tcad_table_tradeoff/fastrw_case1_dof10254.json"),
    out_dir: path.join(ROOT_DIR, "outputs/tcad_table_tradeoff/dof10254"),
    comsol_dir: path.join(ROOT_DIR, "data/cases/case1_power6/comsol/comso_10254"),
  },
];

const NUM_SAMPLES = 1000;
const M_QUERIES = 16;
const SUMMARY_OUT = path.join(ROOT_DIR, "outputs/tcad_table_tradeoff/case1_dof_sweep.json");

const args = process.argv.slice(2);
const ONLY_DOF = args.find((a) => a.startsWith("--only="));
const SKIP_MC = args.includes("--skip-mc");
const SKIP_FEM = args.includes("--skip-fem");

function log(msg) {
  process.stdout.write(`[run_prior_dof_sweep] ${msg}\n`);
}

function err(msg) {
  process.stderr.write(`[run_prior_dof_sweep] ERROR: ${msg}\n`);
}

function runMC(row) {
  log(`MC: DoF=${row.dof} Lambda=${row.lambda} N=${NUM_SAMPLES} ...`);
  fs.mkdirSync(row.out_dir, { recursive: true });
  const env = { ...process.env, RUN_ONESTAGE: "0" };
  const r = spawnSync(
    path.join(ROOT_DIR, "scripts/build_and_run_metal.sh"),
    [row.config, String(NUM_SAMPLES)],
    { stdio: "inherit", env, cwd: ROOT_DIR },
  );
  if (r.status !== 0) {
    throw new Error(`MC failed for DoF=${row.dof} (exit=${r.status})`);
  }
}

function parseMCResults(row) {
  const csvPath = path.join(row.out_dir, "direct.csv");
  const sumPath = path.join(row.out_dir, "summary.json");
  if (!fs.existsSync(csvPath)) throw new Error(`Missing ${csvPath}`);
  if (!fs.existsSync(sumPath)) throw new Error(`Missing ${sumPath}`);

  const lines = fs.readFileSync(csvPath, "utf8").trim().split("\n");
  const header = lines[0].split(",");
  const stepsCol = header.indexOf("Avg_Steps");
  if (stepsCol < 0) throw new Error(`Avg_Steps column not found in ${csvPath}`);

  const steps = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(",");
    const v = Number(cells[stepsCol]);
    if (Number.isFinite(v)) steps.push(v);
  }
  if (steps.length !== M_QUERIES) {
    log(`WARN: expected ${M_QUERIES} rows in direct.csv, got ${steps.length}`);
  }
  const mean_steps = steps.reduce((a, b) => a + b, 0) / steps.length;

  const summary = JSON.parse(fs.readFileSync(sumPath, "utf8"));
  const runtime_seconds = summary.random_walk && summary.random_walk.runtime_seconds;
  if (!Number.isFinite(runtime_seconds)) {
    throw new Error(`runtime_seconds missing from ${sumPath}`);
  }
  return {
    mean_steps,
    mean_steps_M: mean_steps / 1e6,
    runtime_seconds,
    rw_per_query_s: runtime_seconds / M_QUERIES,
    num_queries: steps.length,
    per_query_steps: steps,
  };
}

function runFEMTimingForDof(row) {
  const out = path.join(row.comsol_dir, "timing_warm.json");
  if (row.dof === 1288) {
    log(`FEM: DoF=1288 — reading existing ${out} (per task: do NOT re-run).`);
    if (!fs.existsSync(out)) {
      throw new Error(`Missing existing timing_warm.json for DoF=1288: ${out}`);
    }
    return JSON.parse(fs.readFileSync(out, "utf8"));
  }
  if (fs.existsSync(out)) {
    log(`FEM: DoF=${row.dof} — ${out} exists, reusing.`);
    return JSON.parse(fs.readFileSync(out, "utf8"));
  }
  log(`FEM: DoF=${row.dof} — running 2 warm-timing COMSOL solves ...`);
  return runComsolWarmTiming(row);
}

function runComsolWarmTiming(row) {
  const inputMph = path.join(row.comsol_dir, "case3_rebuild.mph");
  if (!fs.existsSync(inputMph)) {
    throw new Error(`Missing input .mph for DoF=${row.dof}: ${inputMph}`);
  }
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `comsol_warm_dof${row.dof}_`));
  const inCopy = path.join(tmpRoot, "input.mph");
  fs.copyFileSync(inputMph, inCopy);

  const results = [];
  for (let i = 1; i <= 2; i++) {
    const outMph = path.join(tmpRoot, `run${i}_out.mph`);
    const logFile = path.join(tmpRoot, `run${i}.log`);
    const argv = [
      "batch",
      "-np", "4",
      "-inputfile", inCopy,
      "-outputfile", outMph,
      "-batchlog", logFile,
      "-study", "std1",
    ];
    log(`  run${i}: ${COMSOL_BIN} ${argv.join(" ")}`);
    const t0 = Date.now();
    const r = spawnSync(COMSOL_BIN, argv, { stdio: "inherit" });
    const wall = (Date.now() - t0) / 1000;
    if (r.status !== 0) {
      // Retry once.
      log(`  run${i}: failed (exit=${r.status}), retrying once ...`);
      const t1 = Date.now();
      const r2 = spawnSync(COMSOL_BIN, argv, { stdio: "inherit" });
      const wall2 = (Date.now() - t1) / 1000;
      if (r2.status !== 0) {
        throw new Error(`COMSOL run${i} failed twice for DoF=${row.dof}`);
      }
      results.push({ wall_s: wall2, log: logFile, out: outMph });
    } else {
      results.push({ wall_s: wall, log: logFile, out: outMph });
    }
  }

  // Parse internal "Total time" if present in batch log (Chinese localized).
  function parseInternalTotal(p) {
    if (!fs.existsSync(p)) return null;
    const txt = fs.readFileSync(p, "utf8");
    // Look for "总时间" or "Total time" patterns; fall back to null.
    const cn = txt.match(/总时间[^\d]*([\d.]+)\s*s/);
    if (cn) return Number(cn[1]);
    const en = txt.match(/Total time[^\d]*([\d.]+)\s*s/i);
    if (en) return Number(en[1]);
    return null;
  }

  const warm_s = results[1].wall_s;
  const timing = {
    purpose: `Warm-mesh wallclock re-measurement of COMSOL FEM solve for case1, DoF=${row.dof}. Separates one-time mesh build from per-query solve cost.`,
    host: `${os.hostname()} (${os.cpus()[0].model}, ${os.cpus().length} cores)`,
    comsol_version: "COMSOL Multiphysics 6.2.0.290",
    command: `${COMSOL_BIN} batch -np 4 -inputfile <tmp>/input.mph -outputfile <tmp>/runN_out.mph -batchlog <tmp>/runN.log -study std1`,
    input_mph_source: inputMph,
    notes: "Both runs reload the saved .mph which already contains the meshed model, so neither rebuilds geometry/mesh. Run 1 is cold-process (JVM startup, license check, fresh disk cache); run 2 is warm. Solve itself is the same in both. Generated by scripts/run_prior_dof_sweep.js.",
    run1_wallclock_seconds: results[0].wall_s,
    run1_comsol_internal_total_seconds: parseInternalTotal(results[0].log),
    run2_wallclock_seconds: results[1].wall_s,
    run2_comsol_internal_total_seconds: parseInternalTotal(results[1].log),
    warm_solve_seconds: warm_s,
    num_query_points: M_QUERIES,
    per_query_amortized_warm_seconds: warm_s / M_QUERIES,
    verification: {
      compared_against: path.join(row.comsol_dir, "temp.bin"),
      method: "skipped (byte-level extraction would require a bespoke COMSOL .class to export at heat-layer cell centers; the input .mph is the same one that originally produced temp.bin, so the solve is reproducible by construction)",
      byte_identical: null,
    },
    tmp_dir: tmpRoot,
    generated_at_local: new Date().toISOString(),
  };

  const outFile = path.join(row.comsol_dir, "timing_warm.json");
  fs.writeFileSync(outFile, JSON.stringify(timing, null, 2) + "\n");
  log(`  wrote ${outFile} (warm=${warm_s.toFixed(3)}s, per-query=${(warm_s / M_QUERIES).toFixed(4)}s)`);
  return timing;
}

function main() {
  fs.mkdirSync(path.dirname(SUMMARY_OUT), { recursive: true });

  const onlyDof = ONLY_DOF ? Number(ONLY_DOF.split("=")[1]) : null;
  const rowsToRun = onlyDof ? ROWS.filter((r) => r.dof === onlyDof) : ROWS;
  if (onlyDof && rowsToRun.length === 0) {
    err(`--only=${onlyDof} did not match any of {${ROWS.map((r) => r.dof).join(",")}}`);
    process.exit(2);
  }

  const summary = {
    case: "case1",
    description: "FEM-prior accuracy vs. RW truncation tradeoff (TCAD tab:tradeoff)",
    M_queries: M_QUERIES,
    num_samples_per_query: NUM_SAMPLES,
    seed: 42,
    hardware: "Apple M5 Pro",
    generated_at: new Date().toISOString(),
    rows: [],
  };

  for (const row of rowsToRun) {
    log(`=== DoF=${row.dof}, max_err=${row.max_err_K} K, Lambda=${row.lambda} ===`);
    if (!SKIP_MC) {
      runMC(row);
    } else {
      log("  (skipping MC per --skip-mc)");
    }
    const mc = parseMCResults(row);

    let fem;
    if (!SKIP_FEM) {
      fem = runFEMTimingForDof(row);
    } else {
      log("  (skipping FEM per --skip-fem; reading existing timing_warm.json if present)");
      const p = path.join(row.comsol_dir, "timing_warm.json");
      fem = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null;
    }

    summary.rows.push({
      dof: row.dof,
      max_err_K: row.max_err_K,
      avg_err_K: row.avg_err_K,
      lambda: row.lambda,
      bias_bound_K: row.lambda * row.max_err_K,
      mean_steps: mc.mean_steps,
      mean_steps_M: mc.mean_steps_M,
      mc_runtime_seconds: mc.runtime_seconds,
      rw_per_query_seconds: mc.rw_per_query_s,
      fem_warm_seconds: fem ? fem.warm_solve_seconds : null,
      fem_per_query_seconds: fem ? fem.per_query_amortized_warm_seconds : null,
      fem_timing_path: path.join(row.comsol_dir, "timing_warm.json"),
      mc_output_dir: row.out_dir,
      config: row.config,
    });
  }

  fs.writeFileSync(SUMMARY_OUT, JSON.stringify(summary, null, 2) + "\n");
  log(`Wrote summary: ${SUMMARY_OUT}`);

  // Pretty print final table to stdout.
  const fmt = (v, w, d) => (v == null ? "n/a".padStart(w) : v.toFixed(d).padStart(w));
  process.stdout.write("\n");
  process.stdout.write("DoF    | Max-Err(K) | Lambda | Steps(1e6) | RW/q(s) | FEM warm/q(s)\n");
  process.stdout.write("-------+------------+--------+------------+---------+--------------\n");
  for (const r of summary.rows) {
    process.stdout.write(
      `${String(r.dof).padStart(6)} | ${fmt(r.max_err_K, 10, 2)} | ${fmt(r.lambda, 6, 3)} | ${fmt(r.mean_steps_M, 10, 3)} | ${fmt(r.rw_per_query_seconds, 7, 3)} | ${fmt(r.fem_per_query_seconds, 12, 4)}\n`,
    );
  }
}

try {
  main();
} catch (e) {
  err(e.message);
  process.exit(1);
}
