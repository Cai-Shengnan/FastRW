#!/usr/bin/env node
// =====================================================================
// run_fasterrw_post.js
//
// Purpose
//   Bootstrap post-processor for FasterRW (Algorithm 1+2+3). For each
//   of B trials we (i) draw N path indices with replacement from a
//   long MC run, (ii) form the FastRW inverse-variance fusion per
//   target, (iii) fit a Gaussian process to the prior-error residual
//   y_j = prior_j - T_fused_j with universal kriging and an RBF
//   kernel, selecting (lengthscale, amplitude) by maximum REML
//   marginal likelihood over a fixed grid, and (iv) report the
//   denoised query temperature T_eps_j = prior_j - epsHat_j.
//
//   Constants:
//     ALPHA_MIN          = 0.3
//     LENGTHSCALE_CELLS  = [1, 2, 4, 8, 12, 20, 40, 80]
//     AMP_FACTORS        = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3,
//                           1, 3, 10, 30, 100, 300, 1000]
//     JITTER             = 1e-8
//     EPS                = 1e-12
//
// Usage
//   node scripts/run_fasterrw_post.js <run_dir> <config_path> [options]
//   node scripts/run_fasterrw_post.js --help
//
// Options
//   --N=<int>          subsample size (required, <= N_max)
//   --B=<int>          bootstrap trials (default 5)
//   --seed=<int>       base RNG seed (default 42)
//   --output=<path>    output JSON path (required)
//
// Inputs
//   <run_dir>/constraints.json
//   <run_dir>/direct.csv
//   <run_dir>/summary.json   (optional, for runtime metadata)
//   <config_path>            (for query grid / prior temperature file)
//
// Output JSON shape: same as run_fastrw_post.js, with an additional
// 'mean_lengthscale_cells' (a histogram-like dump of which
// (lengthscale, amp) cells were selected across trials).
//
// Reproducibility
//   All randomness flows through --seed via the shared mulberry32
//   RNG in scripts/_lib.js. Same seed => byte-identical trials.
// =====================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const {
  mulberry32, readCsv, mean, std, variance,
  loadPriorAndPoints,
  cholesky, choleskySolve, logDetFromCholesky,
  matVecMul, rbfKernel, addDiag,
} = require("./_lib.js");

const ALPHA_MIN = 0.3;
const EPS = 1e-12;
const JITTER = 1e-8;
const SCALE = 1.0;
const LENGTHSCALE_CELLS = [1, 2, 4, 8, 12, 20, 40, 80];
const AMP_FACTORS = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100, 300, 1000];

function usage() {
  process.stderr.write(
    [
      "Usage: run_fasterrw_post.js <run_dir> <config_path> [options]",
      "",
      "Options:",
      "  --N=<int>          subsample size (required, <= N_max)",
      "  --B=<int>          bootstrap trials (default 5)",
      "  --seed=<int>       base RNG seed (default 42)",
      "  --output=<path>    output JSON path (required)",
      "  --help, -h         show this message",
      "",
    ].join("\n")
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    process.exit(0);
  }
  const positional = args.filter((a) => !a.startsWith("--"));
  const opts = args.filter((a) => a.startsWith("--"));
  if (positional.length !== 2) {
    usage();
    process.exit(2);
  }
  const out = {
    runDir: path.resolve(positional[0]),
    configPath: path.resolve(positional[1]),
    N: null,
    B: 5,
    seed: 42,
    outputPath: null,
  };
  for (const opt of opts) {
    let m;
    if ((m = opt.match(/^--N=(\d+)$/))) { out.N = Number(m[1]); continue; }
    if ((m = opt.match(/^--B=(\d+)$/))) { out.B = Number(m[1]); continue; }
    if ((m = opt.match(/^--seed=(-?\d+)$/))) { out.seed = Number(m[1]); continue; }
    if ((m = opt.match(/^--output=(.+)$/))) { out.outputPath = path.resolve(m[1]); continue; }
    process.stderr.write(`Error: unknown option '${opt}'.\n`);
    usage();
    process.exit(2);
  }
  if (out.N == null) {
    process.stderr.write("Error: --N=<int> is required.\n");
    process.exit(2);
  }
  if (out.outputPath == null) {
    process.stderr.write("Error: --output=<path> is required.\n");
    process.exit(2);
  }
  if (!(out.B >= 1)) {
    process.stderr.write("Error: --B must be >= 1.\n");
    process.exit(2);
  }
  return out;
}

function buildGroupedRecords(data, alphaMin) {
  const grouped = new Map();
  for (let k = 0; k < data.K; k++) {
    const source = data.i_k[k] - 1;
    const target = data.j_k[k] - 1;
    const sample = data.sample_k[k] - 1;
    const alpha = data.alpha_k[k];
    const b = data.b_k[k];
    if (!(alpha >= alphaMin)) continue;
    if (source === target) continue;
    const fullSample = data.obs_data[sample][source];
    const Sval = (fullSample - b) / alpha;
    if (!Number.isFinite(Sval)) continue;
    const key = `${source}:${sample}:${target}`;
    const prev = grouped.get(key);
    if (!prev || alpha > prev.alpha) {
      grouped.set(key, { source, sample, target, alpha, Sval });
    }
  }
  const sampleArr = [];
  const targetArr = [];
  const SvalArr = [];
  for (const v of grouped.values()) {
    sampleArr.push(v.sample);
    targetArr.push(v.target);
    SvalArr.push(v.Sval);
  }
  return { sampleArr, targetArr, SvalArr, total: sampleArr.length };
}

// One GP-REML evaluation given (lengthscale_cells, amp_factor).
// Returns null if Cholesky fails.
function evaluateGP(points, xy, y, yVar, lengthscaleCells, ampFactor, yVarScalarFloor) {
  const M = y.length;
  const lengthscale = lengthscaleCells * xy;
  const ampRef = Math.max(variance(y), yVarScalarFloor);
  const amp2 = ampRef * ampFactor;
  const K = rbfKernel(points, amp2, lengthscale);
  const noise = yVar.map((v) => Math.max(v, EPS) + JITTER * ampRef);
  const C = addDiag(K, noise);
  let L;
  try {
    L = cholesky(C);
  } catch (e) {
    return null;
  }
  const ones = new Array(M).fill(1);
  const Cinv_1 = choleskySolve(L, ones);
  const Cinv_y = choleskySolve(L, y);
  const A = Cinv_1.reduce((s, v) => s + v, 0);
  const Bsum = Cinv_y.reduce((s, v) => s + v, 0);
  if (!(A > 0)) return null;
  const c_hat = Bsum / A;
  const y_centered = y.map((v) => v - c_hat);
  const Cinv_yc = choleskySolve(L, y_centered);
  const quad = y_centered.reduce((s, yi, i) => s + yi * Cinv_yc[i], 0);
  const logDet = logDetFromCholesky(L);
  const logML = -0.5 * (M - 1) * Math.log(2 * Math.PI)
    - 0.5 * logDet - 0.5 * Math.log(A) - 0.5 * quad;
  const KCinv_yc = matVecMul(K, Cinv_yc);
  const epsHat = KCinv_yc.map((v) => v + c_hat);
  return {
    lengthscale_cells: lengthscaleCells,
    amp_factor: ampFactor,
    log_marginal_likelihood: logML,
    epsHat,
  };
}

function selectGP(points, xy, y, yVar) {
  const yVarMean = mean(yVar);
  let best = null;
  for (const ls of LENGTHSCALE_CELLS) {
    for (const amp of AMP_FACTORS) {
      const c = evaluateGP(points, xy, y, yVar, ls, amp, yVarMean);
      if (!c) continue;
      if (!best || c.log_marginal_likelihood > best.log_marginal_likelihood) best = c;
    }
  }
  if (!best) throw new Error("FasterRW: no GP candidate evaluated successfully");
  return best;
}

function fasterrwTrial({
  Nmax, M, N, obs, gt, grouped, rng, prior, points, xy,
}) {
  const idx = new Array(N);
  const multiplicity = new Int32Array(Nmax);
  for (let r = 0; r < N; r++) {
    const i = Math.floor(rng() * Nmax);
    idx[r] = i;
    multiplicity[i] += 1;
  }
  const directMean = new Array(M);
  const directVar = new Array(M);
  for (let j = 0; j < M; j++) {
    const samples = new Array(N);
    for (let r = 0; r < N; r++) samples[r] = obs[idx[r]][j];
    directMean[j] = mean(samples);
    directVar[j] = Math.max(variance(samples), EPS);
  }
  // multiplicity is indexed by PATH index (0..Nmax-1); each grouped
  // record carries the source path's path index in sampleArr.
  const tailSamples = Array.from({ length: M }, () => []);
  for (let g = 0; g < grouped.total; g++) {
    const m = multiplicity[grouped.sampleArr[g]];
    if (!m) continue;
    const t = grouped.targetArr[g];
    const v = grouped.SvalArr[g];
    for (let r = 0; r < m; r++) tailSamples[t].push(v);
  }
  const fused = new Array(M);
  const fusedVar = new Array(M);
  for (let j = 0; j < M; j++) {
    const tails = tailSamples[j];
    const wDir = N / directVar[j];
    if (tails.length < 2) {
      fused[j] = directMean[j];
      fusedVar[j] = 1 / wDir;
      continue;
    }
    const tm = mean(tails);
    const tv = Math.max(variance(tails), EPS);
    const wTail = (tails.length * SCALE) / tv;
    fused[j] = (wDir * directMean[j] + wTail * tm) / (wDir + wTail);
    fusedVar[j] = 1 / (wDir + wTail);
  }
  const y = prior.map((p, j) => p - fused[j]);
  const selected = selectGP(points, xy, y, fusedVar);
  const T_eps = prior.map((p, j) => p - selected.epsHat[j]);
  const absErrs = T_eps.map((m, j) => Math.abs(m - gt[j]));
  return {
    avg_abs: mean(absErrs),
    lengthscale_cells: selected.lengthscale_cells,
    amp_factor: selected.amp_factor,
  };
}

function main() {
  const args = parseArgs(process.argv);

  const constraintsPath = path.join(args.runDir, "constraints.json");
  const directPath = path.join(args.runDir, "direct.csv");
  const summaryPath = path.join(args.runDir, "summary.json");

  for (const [label, p] of [
    ["constraints.json", constraintsPath],
    ["direct.csv", directPath],
    ["config_path", args.configPath],
  ]) {
    if (!fs.existsSync(p)) {
      process.stderr.write(`Error: missing ${label} at ${p}.\n`);
      process.exit(2);
    }
  }

  const data = JSON.parse(fs.readFileSync(constraintsPath, "utf8"));
  const Nmax = data.N;
  const M = data.M;
  if (args.N > Nmax) {
    process.stderr.write(`Error: --N=${args.N} exceeds N_max=${Nmax}.\n`);
    process.exit(2);
  }
  if (!Array.isArray(data.obs_data) || !data.obs_data.length) {
    process.stderr.write("Error: constraints.json lacks obs_data.\n");
    process.exit(2);
  }

  const directRows = readCsv(directPath);
  if (directRows.length !== M) {
    process.stderr.write(`Error: direct.csv rows=${directRows.length} != M=${M}.\n`);
    process.exit(2);
  }
  const gt = directRows.map((row) => row.GT_Temperature);
  const meanAvgSteps = mean(directRows.map((row) => row.Avg_Steps));

  let summaryMeta = null;
  if (fs.existsSync(summaryPath)) {
    try { summaryMeta = JSON.parse(fs.readFileSync(summaryPath, "utf8")); } catch (e) { /* ignore */ }
  }

  const { prior, points, xy } = loadPriorAndPoints(args.configPath);
  if (prior.length !== M) {
    process.stderr.write(`Error: prior length ${prior.length} != M=${M}.\n`);
    process.exit(2);
  }

  const grouped = buildGroupedRecords(data, ALPHA_MIN);
  const obs = data.obs_data;

  const trials = [];
  for (let b = 1; b <= args.B; b++) {
    const seed = args.seed + b;
    const rng = mulberry32(seed);
    const t = fasterrwTrial({
      Nmax, M, N: args.N, obs, gt, grouped, rng, prior, points, xy,
    });
    trials.push({
      seed, avg_abs: t.avg_abs,
      lengthscale_cells: t.lengthscale_cells,
      amp_factor: t.amp_factor,
    });
  }

  const avgAbsValues = trials.map((t) => t.avg_abs);
  const out = {
    script: "run_fasterrw_post.js",
    run_dir: args.runDir,
    config: args.configPath,
    constraints: constraintsPath,
    direct_csv: directPath,
    Nmax,
    M,
    N: args.N,
    B: args.B,
    seed_base: args.seed,
    alpha_min: ALPHA_MIN,
    grouped_records: grouped.total,
    with_replacement: true,
    trials,
    mean_avg_abs: mean(avgAbsValues),
    std_avg_abs: std(avgAbsValues),
    mean_avg_steps: meanAvgSteps,
    path_step_at_N: args.N * meanAvgSteps,
    runtime_seconds: summaryMeta?.random_walk?.runtime_seconds ?? null,
  };

  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(out, null, 2)}\n`);
  process.stderr.write(
    `FasterRW post: N=${args.N} B=${args.B} mean=${out.mean_avg_abs.toFixed(4)} ` +
    `std=${out.std_avg_abs.toFixed(4)} -> ${args.outputPath}\n`
  );
}

main();
