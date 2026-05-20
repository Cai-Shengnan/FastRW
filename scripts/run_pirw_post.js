#!/usr/bin/env node
// =====================================================================
// run_pirw_post.js
//
// Purpose
//   Bootstrap post-processor for a baseline PIRW Monte-Carlo run.
//   Computes the average absolute query error (avg|error|) for B
//   independent random subsamples of size N drawn (with replacement)
//   from the N_max-path MC output. There is no tail-reuse, no fusion,
//   and no GP smoothing -- the estimator is the plain per-target
//   sample mean.
//
// Usage
//   node scripts/run_pirw_post.js <run_dir> [options]
//   node scripts/run_pirw_post.js --help
//
// Options
//   --N=<int>            subsample size N (required, must be <= N_max)
//   --B=<int>            number of bootstrap trials (default 5)
//   --seed=<int>         base RNG seed (default 42); trial b uses
//                        seed_base + b for b in {1..B}
//   --output=<path>      output JSON path (required)
//
// Inputs (under <run_dir>)
//   constraints.json     for obs_data (N_max x M matrix of per-path
//                        per-target temperatures) and N_max
//   direct.csv           for GT_Temperature and Avg_Steps per target
//   summary.json         (optional) for runtime metadata
//
// Output
//   The output JSON has the shape
//     {
//       script, run_dir, Nmax, N, B, seed_base, alpha_with_replacement,
//       trials: [{seed, avg_abs}, ...],
//       mean_avg_abs, std_avg_abs,
//       mean_avg_steps, path_step_at_N
//     }
//
// Errors
//   * If constraints.json lacks obs_data the script aborts with a
//     clear message telling the user to rerun PIRW with constraint
//     recording enabled.
//   * If N > N_max the script aborts.
//
// Reproducibility
//   All randomness flows through --seed and a deterministic
//   mulberry32 RNG (see scripts/_lib.js). Re-running with the same
//   seed reproduces identical trials byte-for-byte.
// =====================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const {
  mulberry32, readCsv, mean, std,
} = require("./_lib.js");

function usage() {
  process.stderr.write(
    [
      "Usage: run_pirw_post.js <run_dir> [options]",
      "",
      "Options:",
      "  --N=<int>          subsample size (required, <= N_max)",
      "  --B=<int>          number of bootstrap trials (default 5)",
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
  if (positional.length !== 1) {
    usage();
    process.exit(2);
  }
  const out = {
    runDir: path.resolve(positional[0]),
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

function main() {
  const args = parseArgs(process.argv);

  const constraintsPath = path.join(args.runDir, "constraints.json");
  const directPath = path.join(args.runDir, "direct.csv");
  const summaryPath = path.join(args.runDir, "summary.json");

  for (const [label, p] of [
    ["constraints.json", constraintsPath],
    ["direct.csv", directPath],
  ]) {
    if (!fs.existsSync(p)) {
      process.stderr.write(`Error: missing ${label} at ${p}.\n`);
      process.exit(2);
    }
  }

  const data = JSON.parse(fs.readFileSync(constraintsPath, "utf8"));
  if (!Array.isArray(data.obs_data) || !data.obs_data.length) {
    process.stderr.write(
      "Error: constraints.json does not contain per-path obs_data. " +
      "Bootstrap requires per-path samples. Rerun the PIRW MC with " +
      "constraint recording enabled (the random_walker_metal binary " +
      "writes obs_data by default; check that the run did not crash).\n"
    );
    process.exit(2);
  }

  const Nmax = data.N;
  const M = data.M;
  if (args.N > Nmax) {
    process.stderr.write(`Error: --N=${args.N} exceeds N_max=${Nmax} in ${constraintsPath}.\n`);
    process.exit(2);
  }

  const directRows = readCsv(directPath);
  if (directRows.length !== M) {
    process.stderr.write(
      `Error: direct.csv has ${directRows.length} rows but constraints.json reports M=${M}.\n`
    );
    process.exit(2);
  }
  const gt = directRows.map((row) => row.GT_Temperature);
  const meanAvgSteps = mean(directRows.map((row) => row.Avg_Steps));

  let summaryMeta = null;
  if (fs.existsSync(summaryPath)) {
    try {
      summaryMeta = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    } catch (e) {
      summaryMeta = null;
    }
  }

  const obs = data.obs_data;
  const N = args.N;
  const trials = [];
  for (let b = 1; b <= args.B; b++) {
    const seed = args.seed + b;
    const rng = mulberry32(seed);
    const idx = new Array(N);
    for (let r = 0; r < N; r++) idx[r] = Math.floor(rng() * Nmax);
    const errs = new Array(M);
    for (let j = 0; j < M; j++) {
      let acc = 0;
      for (let r = 0; r < N; r++) acc += obs[idx[r]][j];
      errs[j] = Math.abs(acc / N - gt[j]);
    }
    trials.push({ seed, avg_abs: mean(errs) });
  }

  const avgAbsValues = trials.map((t) => t.avg_abs);
  const out = {
    script: "run_pirw_post.js",
    run_dir: args.runDir,
    constraints: constraintsPath,
    direct_csv: directPath,
    Nmax,
    M,
    N,
    B: args.B,
    seed_base: args.seed,
    with_replacement: true,
    trials,
    mean_avg_abs: mean(avgAbsValues),
    std_avg_abs: std(avgAbsValues),
    mean_avg_steps: meanAvgSteps,
    path_step_at_N: N * meanAvgSteps,
    runtime_seconds: summaryMeta?.random_walk?.runtime_seconds ?? null,
  };

  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(out, null, 2)}\n`);
  process.stderr.write(
    `PIRW post: N=${N} B=${args.B} mean=${out.mean_avg_abs.toFixed(4)} ` +
    `std=${out.std_avg_abs.toFixed(4)} -> ${args.outputPath}\n`
  );
}

main();
