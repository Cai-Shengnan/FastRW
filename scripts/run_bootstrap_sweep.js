#!/usr/bin/env node
// =====================================================================
// run_bootstrap_sweep.js
//
// Purpose
//   Dense N-grid bootstrap sweep for the fig:bootstrap panels. For
//   each N on the canonical log-N grid we run B bootstrap trials,
//   sharing the path-index draw across the three estimators
//   (direct / FastRW / FasterRW) so that direct, FastRW and FasterRW
//   are evaluated on the *same* resampled path set per trial. This is
//   strictly faster and statistically tighter than three independent
//   B-trial runs.
//
//   The fusion / GP code below is intentionally a stand-alone copy of
//   the canonical logic in run_fastrw_post.js / run_fasterrw_post.js
//   so that this sweep cannot accidentally change those post-
//   processors. ALPHA_MIN, JITTER, the lengthscale grid and the
//   amplitude grid are byte-identical to those scripts.
//
//   The path-multiplicity array used by tail reuse is indexed by the
//   PATH index (0..Nmax-1), NOT by the source query index (0..M-1) --
//   matches the canonical post-processors after the fusion bug fix.
//
// Usage
//   node scripts/run_bootstrap_sweep.js <run_dir> <config_path> [options]
//   node scripts/run_bootstrap_sweep.js --help
//
// Options
//   --B=<int>            bootstrap trials per N (default 50)
//   --seed=<int>         base RNG seed (default 42)
//   --grid=<csv>         comma-separated list of N values (defaults
//                        to the canonical fig:bootstrap log-N grid:
//                        32,48,64,96,128,192,256,384,512,640,768,896,
//                        1024,1280,1536,1792,2048,2560,3072,4096,6144,
//                        8192). Values larger than Nmax are dropped.
//   --methods=<csv>      subset of {direct,fastrw,fasterrw} to compute
//                        (default direct,fastrw,fasterrw). `direct`
//                        alone is the PIRW baseline sweep mode and
//                        skips grouped/prior/GP loading. fasterrw
//                        implies fastrw.
//   --output=<path>      output JSON path (required)
//
// Inputs
//   <run_dir>/constraints.json
//   <run_dir>/direct.csv
//   <run_dir>/summary.json   (optional, for runtime metadata)
//   <config_path>            (for prior temperature file / query grid)
//
// Output JSON shape (per N entry, length = grid intersect [<=Nmax]):
//   {
//     N,
//     direct_avg_abs_mean, direct_avg_abs_std,
//     direct_avg_abs_p05,  direct_avg_abs_p95,
//     fastrw_avg_abs_mean, fastrw_avg_abs_std,
//     fastrw_avg_abs_p05,  fastrw_avg_abs_p95,
//     tail_count_total_mean,
//     fasterrw_avg_abs_mean, fasterrw_avg_abs_std,
//     fasterrw_avg_abs_p05,  fasterrw_avg_abs_p95,
//     mean_avg_steps,
//   }
//
// Reproducibility
//   All randomness flows through --seed via the shared mulberry32 RNG
//   in scripts/_lib.js. The same machine + Node version produces
//   byte-identical JSON output. For each N, trial b uses seed
//   (seedBase + b); the path-index draws are re-used across direct /
//   FastRW / FasterRW within that trial.
// =====================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const {
  mulberry32, readCsv, mean, std, variance, quantile,
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

const DEFAULT_GRID = [
  32, 48, 64, 96, 128, 192, 256, 384, 512, 640, 768, 896, 1024,
  1280, 1536, 1792, 2048, 2560, 3072, 4096, 6144, 8192,
];

function usage() {
  process.stderr.write(
    [
      "Usage: run_bootstrap_sweep.js <run_dir> <config_path> [options]",
      "",
      "Options:",
      "  --B=<int>         bootstrap trials per N (default 50)",
      "  --seed=<int>      base RNG seed (default 42)",
      "  --grid=<csv>      comma-separated list of N values (default: canonical log-N grid)",
      "  --methods=<csv>   subset of direct,fastrw,fasterrw (default all three)",
      "  --output=<path>   output JSON path (required)",
      "  --help, -h        show this message",
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
    B: 50,
    seed: 42,
    grid: DEFAULT_GRID.slice(),
    methods: ["direct", "fastrw", "fasterrw"],
    outputPath: null,
  };
  for (const opt of opts) {
    let m;
    if ((m = opt.match(/^--B=(\d+)$/))) { out.B = Number(m[1]); continue; }
    if ((m = opt.match(/^--seed=(-?\d+)$/))) { out.seed = Number(m[1]); continue; }
    if ((m = opt.match(/^--grid=(.+)$/))) {
      out.grid = m[1].split(",").map((s) => Number(s.trim())).filter((n) => n >= 1);
      continue;
    }
    if ((m = opt.match(/^--methods=(.+)$/))) {
      out.methods = m[1].split(",").map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if ((m = opt.match(/^--output=(.+)$/))) { out.outputPath = path.resolve(m[1]); continue; }
    process.stderr.write(`Error: unknown option '${opt}'.\n`);
    usage();
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
  const allowedMethods = new Set(["direct", "fastrw", "fasterrw"]);
  for (const meth of out.methods) {
    if (!allowedMethods.has(meth)) {
      process.stderr.write(`Error: unknown method '${meth}' (allowed: direct, fastrw, fasterrw).\n`);
      process.exit(2);
    }
  }
  // direct is always emitted; fasterrw implies fastrw (needs the fused estimate).
  const methodSet = new Set(out.methods);
  methodSet.add("direct");
  if (methodSet.has("fasterrw")) methodSet.add("fastrw");
  out.methods = ["direct", "fastrw", "fasterrw"].filter((m) => methodSet.has(m));
  return out;
}

// ---- canonical fusion / GP helpers (byte-identical to the post-processors) -
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

function evaluateGP(points, xy, y, yVar, lengthscaleCells, ampFactor, yVarScalarFloor) {
  const M = y.length;
  const lengthscale = lengthscaleCells * xy;
  const ampRef = Math.max(variance(y), yVarScalarFloor);
  const amp2 = ampRef * ampFactor;
  const K = rbfKernel(points, amp2, lengthscale);
  const noise = yVar.map((v) => Math.max(v, EPS) + JITTER * ampRef);
  const C = addDiag(K, noise);
  let L;
  try { L = cholesky(C); } catch (e) { return null; }
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
  return { lengthscale_cells: lengthscaleCells, amp_factor: ampFactor,
           log_marginal_likelihood: logML, epsHat };
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
  if (!best) throw new Error("bootstrap_sweep: no GP candidate evaluated successfully");
  return best;
}

// One bootstrap trial at fixed N -- emits direct / FastRW / FasterRW
// estimates from a single shared path-index draw. Methods absent from
// `methods` are skipped (fastrw -> grouped null, fasterrw -> prior null
// allowed); fasterrw is assumed to imply fastrw at this point.
function sharedTrial({
  Nmax, M, N, obs, gt, grouped, rng, prior, points, xy, methods,
}) {
  // 1. shared bootstrap path-index draw
  const idx = new Array(N);
  const multiplicity = new Int32Array(Nmax);
  for (let r = 0; r < N; r++) {
    const i = Math.floor(rng() * Nmax);
    idx[r] = i;
    multiplicity[i] += 1;
  }
  // 2. direct per-target mean / variance
  const directMean = new Array(M);
  const directVar = new Array(M);
  for (let j = 0; j < M; j++) {
    const samples = new Array(N);
    for (let r = 0; r < N; r++) samples[r] = obs[idx[r]][j];
    directMean[j] = mean(samples);
    directVar[j] = Math.max(variance(samples), EPS);
  }
  const directErrs = directMean.map((m, j) => Math.abs(m - gt[j]));
  const result = {
    direct_avg_abs: mean(directErrs),
    fastrw_avg_abs: null,
    fasterrw_avg_abs: null,
    tail_count_total: 0,
  };
  if (!methods.has("fastrw")) return result;

  // 3. tail reuse with PATH-index multiplicity (no-self, max-alpha
  //    pre-grouped). tail bucket sizes summed across all targets is
  //    the legacy `tail_count_total` metric.
  const tailSamples = Array.from({ length: M }, () => []);
  let tailCountTotal = 0;
  for (let g = 0; g < grouped.total; g++) {
    const m = multiplicity[grouped.sampleArr[g]];
    if (!m) continue;
    const t = grouped.targetArr[g];
    const v = grouped.SvalArr[g];
    for (let r = 0; r < m; r++) tailSamples[t].push(v);
    tailCountTotal += m;
  }
  // 4. FastRW fused per target
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
  const fastErrs = fused.map((m, j) => Math.abs(m - gt[j]));
  result.fastrw_avg_abs = mean(fastErrs);
  result.tail_count_total = tailCountTotal;
  if (!methods.has("fasterrw")) return result;

  // 5. FasterRW GP correction
  const y = prior.map((p, j) => p - fused[j]);
  const selected = selectGP(points, xy, y, fusedVar);
  const T_eps = prior.map((p, j) => p - selected.epsHat[j]);
  const fasterErrs = T_eps.map((m, j) => Math.abs(m - gt[j]));
  result.fasterrw_avg_abs = mean(fasterErrs);
  return result;
}

function summarise(values) {
  return {
    mean: mean(values),
    std:  std(values),
    p05:  quantile(values, 0.05),
    p95:  quantile(values, 0.95),
  };
}

function main() {
  const args = parseArgs(process.argv);
  const methodsSet = new Set(args.methods);
  const needFastrw = methodsSet.has("fastrw");
  const needFasterrw = methodsSet.has("fasterrw");

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

  let prior = null, points = null, xy = null;
  if (needFasterrw) {
    const loaded = loadPriorAndPoints(args.configPath);
    prior = loaded.prior; points = loaded.points; xy = loaded.xy;
    if (prior.length !== M) {
      process.stderr.write(`Error: prior length ${prior.length} != M=${M}.\n`);
      process.exit(2);
    }
  }

  const grouped = needFastrw ? buildGroupedRecords(data, ALPHA_MIN) : null;
  const obs = data.obs_data;

  // Clip grid to [1..Nmax] and deduplicate
  const grid = Array.from(new Set(args.grid.filter((n) => n >= 1 && n <= Nmax))).sort((a, b) => a - b);

  process.stderr.write(
    `[bootstrap_sweep] Nmax=${Nmax} M=${M} B=${args.B} seed=${args.seed} ` +
    `methods=[${args.methods.join(",")}] ` +
    `grid=[${grid.join(",")}] grouped_records=${grouped ? grouped.total : "null"}\n`
  );

  const results = [];
  for (const N of grid) {
    const directVals = new Array(args.B);
    const fastVals = needFastrw ? new Array(args.B) : null;
    const fasterVals = needFasterrw ? new Array(args.B) : null;
    const tailTotals = needFastrw ? new Array(args.B) : null;
    for (let b = 1; b <= args.B; b++) {
      const seed = args.seed + b;
      const rng = mulberry32(seed);
      const t = sharedTrial({
        Nmax, M, N, obs, gt, grouped, rng, prior, points, xy, methods: methodsSet,
      });
      directVals[b - 1] = t.direct_avg_abs;
      if (needFastrw) {
        fastVals[b - 1] = t.fastrw_avg_abs;
        tailTotals[b - 1] = t.tail_count_total;
      }
      if (needFasterrw) fasterVals[b - 1] = t.fasterrw_avg_abs;
    }
    const d = summarise(directVals);
    const entry = {
      N,
      direct_avg_abs_mean: d.mean, direct_avg_abs_std: d.std,
      direct_avg_abs_p05:  d.p05,  direct_avg_abs_p95: d.p95,
    };
    let logLine = `  N=${String(N).padStart(5)}  direct=${d.mean.toFixed(4)}±${d.std.toFixed(4)}`;
    if (needFastrw) {
      const f = summarise(fastVals);
      entry.fastrw_avg_abs_mean = f.mean;
      entry.fastrw_avg_abs_std  = f.std;
      entry.fastrw_avg_abs_p05  = f.p05;
      entry.fastrw_avg_abs_p95  = f.p95;
      entry.tail_count_total_mean = mean(tailTotals);
      logLine += `  fastrw=${f.mean.toFixed(4)}±${f.std.toFixed(4)}`;
    }
    if (needFasterrw) {
      const x = summarise(fasterVals);
      entry.fasterrw_avg_abs_mean = x.mean;
      entry.fasterrw_avg_abs_std  = x.std;
      entry.fasterrw_avg_abs_p05  = x.p05;
      entry.fasterrw_avg_abs_p95  = x.p95;
      logLine += `  fasterrw=${x.mean.toFixed(4)}±${x.std.toFixed(4)}`;
    }
    entry.mean_avg_steps = meanAvgSteps;
    results.push(entry);
    process.stderr.write(logLine + "\n");
  }

  const out = {
    script: "run_bootstrap_sweep.js",
    run_dir: args.runDir,
    config: args.configPath,
    constraints: constraintsPath,
    direct_csv: directPath,
    Nmax,
    M,
    K_total_pass: data.K,
    grouped_records: grouped ? grouped.total : null,
    B: args.B,
    seed: args.seed,
    alpha_min: ALPHA_MIN,
    methods: args.methods,
    mean_avg_steps: meanAvgSteps,
    runtime_seconds: summaryMeta?.random_walk?.runtime_seconds ?? null,
    results,
  };

  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(out, null, 2)}\n`);
  process.stderr.write(`[bootstrap_sweep] Wrote ${args.outputPath}\n`);
}

main();
