#!/usr/bin/env node
// =====================================================================
// run_fastrw_post.js
//
// Purpose
//   Bootstrap post-processor for FastRW (Algorithm 1+2, no-self tail
//   reuse + inverse-variance fusion). For each of B trials we draw N
//   path indices with replacement from the N_max paths of a long MC
//   run, then form the per-target fused estimator:
//       T_j = (wDir * direct_mean_j + wTail * tail_mean_j)
//             / (wDir + wTail)
//   with wDir = N / Var_direct[j] and wTail = nq_j / Var_tail[j].
//   Constants: ALPHA_MIN = 0.3, EPS = 1e-12.
//
//   The pass-through tail records are grouped once (outside the
//   bootstrap loop) by (source, sample, target) using the max-alpha
//   policy. During a bootstrap replicate the number of times a given
//   source path was drawn multiplies that source's contribution to
//   the tail bucket of each (sample, target) -- this replicates the
//   exact behaviour of the legacy subsample_bootstrap_fusion.js
//   no-self path.
//
// Usage
//   node scripts/run_fastrw_post.js <run_dir> <config_path> [options]
//   node scripts/run_fastrw_post.js --help
//
// Options
//   --N=<int>          subsample size (required, <= N_max)
//   --B=<int>          number of bootstrap trials (default 5)
//   --seed=<int>       base RNG seed (default 42); trial b uses
//                      seed_base + b
//   --output=<path>    output JSON path (required)
//
// Inputs
//   <run_dir>/constraints.json  : per-path / pass-through tables
//   <run_dir>/direct.csv        : GT_Temperature and Avg_Steps
//   <run_dir>/summary.json      : (optional) runtime metadata
//   <config_path>               : config used to launch the MC run
//                                 (geometry / query grid only -- the
//                                 prior file is not loaded by FastRW)
//
// Output JSON shape
//   {
//     script, run_dir, config, Nmax, M, N, B, seed_base,
//     trials: [{seed, avg_abs}, ...],
//     mean_avg_abs, std_avg_abs,
//     mean_avg_steps, path_step_at_N,
//     ...
//   }
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
} = require("./_lib.js");

const ALPHA_MIN = 0.3;
const EPS = 1e-12;
const SCALE = 1.0;

function usage() {
  process.stderr.write(
    [
      "Usage: run_fastrw_post.js <run_dir> <config_path> [options]",
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

// Build grouped pass-through records once (no_self, max-alpha policy)
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

function fastrwTrial({ Nmax, M, N, obs, gt, grouped, rng }) {
  // 1. bootstrap index set
  const idx = new Array(N);
  const multiplicity = new Int32Array(Nmax);
  for (let r = 0; r < N; r++) {
    const i = Math.floor(rng() * Nmax);
    idx[r] = i;
    multiplicity[i] += 1;
  }
  // 2. direct mean / variance per target
  const directMean = new Array(M);
  const directVar = new Array(M);
  for (let j = 0; j < M; j++) {
    const samples = new Array(N);
    for (let r = 0; r < N; r++) samples[r] = obs[idx[r]][j];
    directMean[j] = mean(samples);
    directVar[j] = Math.max(variance(samples), EPS);
  }
  // 3. tail-reuse with multiplicity (Alg 2, no_self)
  // NOTE: multiplicity is indexed by PATH index (0..Nmax-1); each
  // grouped record carries the path index of its source path in
  // sampleArr (NOT the source query index in sourceArr -- using the
  // latter would only ever read multiplicity[0..M-1]).
  const tailSamples = Array.from({ length: M }, () => []);
  for (let g = 0; g < grouped.total; g++) {
    const m = multiplicity[grouped.sampleArr[g]];
    if (!m) continue;
    const t = grouped.targetArr[g];
    const v = grouped.SvalArr[g];
    for (let r = 0; r < m; r++) tailSamples[t].push(v);
  }
  // 4. inverse-variance fusion per target
  const fused = new Array(M);
  for (let j = 0; j < M; j++) {
    const tails = tailSamples[j];
    const wDir = N / directVar[j];
    if (tails.length < 2) {
      fused[j] = directMean[j];
      continue;
    }
    const tm = mean(tails);
    const tv = Math.max(variance(tails), EPS);
    const wTail = (tails.length * SCALE) / tv;
    fused[j] = (wDir * directMean[j] + wTail * tm) / (wDir + wTail);
  }
  const absErrs = fused.map((m, j) => Math.abs(m - gt[j]));
  return { avg_abs: mean(absErrs) };
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

  const grouped = buildGroupedRecords(data, ALPHA_MIN);
  const obs = data.obs_data;

  const trials = [];
  for (let b = 1; b <= args.B; b++) {
    const seed = args.seed + b;
    const rng = mulberry32(seed);
    const t = fastrwTrial({ Nmax, M, N: args.N, obs, gt, grouped, rng });
    trials.push({ seed, avg_abs: t.avg_abs });
  }

  const avgAbsValues = trials.map((t) => t.avg_abs);
  const out = {
    script: "run_fastrw_post.js",
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
    `FastRW post: N=${args.N} B=${args.B} mean=${out.mean_avg_abs.toFixed(4)} ` +
    `std=${out.std_avg_abs.toFixed(4)} -> ${args.outputPath}\n`
  );
}

main();
