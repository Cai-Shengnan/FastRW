#!/usr/bin/env node
// =====================================================================
// run_group_size_sweep.js
//
// Purpose
//   Group-size sweep for Table `tab:multi` (Group Size effect). For
//   each group size G in {1, 4, 8, 16} we partition the M=16 query
//   points into K_G = floor(M/G) disjoint subgroups of G consecutive
//   points (so every query point is used exactly once per G). For
//   each subgroup we run B bootstrap trials at fixed N path-budget,
//   reusing the long MC run produced by run_fastrw_direct.sh, and
//   compute the per-subgroup avg_abs error AND the per-query-point
//   bootstrap variance of the fused / GP-corrected estimate under
//   both
//     * FastRW   (Alg. 1+2: inverse-variance fusion, no-self tail
//                 reuse, ALPHA_MIN = 0.3); and
//     * FasterRW (Alg. 1+2+3: FastRW + universal-kriging GP on the
//                 prior-error residual, evaluated only on the G
//                 points in the subgroup so the GP truly operates
//                 at the group's size).
//
//   The fusion / GP code below is intentionally a stand-alone copy
//   of the logic in run_fastrw_post.js / run_fasterrw_post.js so
//   that this sweep cannot accidentally change those canonical
//   post-processors. ALPHA_MIN, JITTER, the lengthscale grid and the
//   amplitude grid are byte-identical to those scripts.
//
// =====================================================================
//                  TWO METRICS REPORTED IN THIS SCRIPT
// =====================================================================
//
//   (A) "avg_abs" speedup  (LEGACY, retained for diagnostics only)
//       --------------------------------------------------------
//       Var_single(N) = mean over K_1 singleton subgroups of the
//                       per-subgroup bootstrap variance of avg_abs.
//       Var_group(N)  = mean over the K_G subgroups of size G of the
//                       per-subgroup bootstrap variance of avg_abs.
//       N_hat_avg(G)  = N * Var_single(N) / Var_group(N).
//       speedup_avg   = N_hat_avg / N.
//
//       This conflates two effects: (i) a trivial 1/G variance
//       reduction from averaging G independent query-point estimates
//       and (ii) the actual per-query fusion / GP benefit. It is
//       NOT the canonical `tab:multi` value.
//
//   (B) "per_query" speedup  (CANONICAL, matches the legacy paper)
//       ---------------------------------------------------------
//       For each query point x_i:
//         Var_single(x_i) = bootstrap variance, across the B trials
//                           at G=1, of the per-point estimate
//                           T_hat(x_i) when x_i is its own singleton
//                           subgroup.
//         Var_fused(x_i, G) = bootstrap variance, across the B trials
//                           at group size G, of T_hat(x_i) when x_i
//                           is one of the G points in its subgroup.
//         N_hat(x_i, G)   = N * Var_single(x_i) / Var_fused(x_i, G).
//
//       Reported as:
//         speedup_per_query(G) = mean over query points of (N_hat / N)
//         std_per_query(G)     = std over query points of (N_hat / N)
//
//       This matches the legacy paper's definition
//         hat{N}(x) = Z(x) / Var[ hat{T}(x) ]
//       and isolates the *per-query* fusion / cross-target tail-reuse
//       benefit from the trivial 1/G averaging factor that metric (A)
//       picks up. At G=1 this is exactly 1.0 by construction.
//
//   The point estimate used for metric (B) is the FastRW fused
//   T_hat(x_i) (the inverse-variance combination of the direct
//   bootstrap mean at x_i and the tail-reused samples landing at
//   x_i) and, for FasterRW, the GP-corrected T_eps(x_i) =
//   prior(x_i) - epsHat(x_i). Both are *per-query* scalars, NOT
//   averages over the subgroup.
//
//   Note on FasterRW at G=1: the universal-kriging GP with a single
//   training point reduces to the identity (epsHat[0] = y[0]), so
//   the FasterRW T_eps(x_i) at G=1 equals the FastRW fused value at
//   G=1. The G=1 speedup is therefore 1x for both methods by
//   construction; we still print the FasterRW row but note that the
//   GP is degenerate at G=1.
//
// =====================================================================
//
// Usage
//   node scripts/run_group_size_sweep.js <run_dir> <config_path> [options]
//   node scripts/run_group_size_sweep.js --help
//
// Options
//   --N=<int>          subsample size per query (default 1000)
//   --B=<int>          bootstrap trials per subgroup (default 500)
//   --seed=<int>       base RNG seed (default 42)
//   --groups=<csv>     comma-separated list of G values
//                      (default 1,4,8,16)
//   --output=<path>    output JSON path (required)
//
// Inputs
//   <run_dir>/constraints.json
//   <run_dir>/direct.csv
//   <run_dir>/summary.json   (optional, for runtime metadata)
//   <config_path>            (for prior temperature file / query grid)
//
// Reproducibility
//   All randomness flows through --seed via the shared mulberry32 RNG
//   in scripts/_lib.js. The same (G, subgroup_index, trial_index) maps
//   to a fixed seed, so trials across G are *not* shared (this matches
//   the existing post-processors, which reseed per trial b).
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
      "Usage: run_group_size_sweep.js <run_dir> <config_path> [options]",
      "",
      "Options:",
      "  --N=<int>          subsample size per query (default 1000)",
      "  --B=<int>          bootstrap trials per subgroup (default 500)",
      "  --seed=<int>       base RNG seed (default 42)",
      "  --groups=<csv>     group sizes (default 1,4,8,16)",
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
    N: 1000,
    B: 500,
    seed: 42,
    groups: [1, 4, 8, 16],
    outputPath: null,
  };
  for (const opt of opts) {
    let m;
    if ((m = opt.match(/^--N=(\d+)$/))) { out.N = Number(m[1]); continue; }
    if ((m = opt.match(/^--B=(\d+)$/))) { out.B = Number(m[1]); continue; }
    if ((m = opt.match(/^--seed=(-?\d+)$/))) { out.seed = Number(m[1]); continue; }
    if ((m = opt.match(/^--groups=(.+)$/))) {
      out.groups = m[1].split(",").map((s) => Number(s.trim())).filter((n) => n >= 1);
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
  const sourceArr = [];
  const sampleArr = [];
  const targetArr = [];
  const SvalArr = [];
  for (const v of grouped.values()) {
    sourceArr.push(v.source);
    sampleArr.push(v.sample);
    targetArr.push(v.target);
    SvalArr.push(v.Sval);
  }
  return { sourceArr, sampleArr, targetArr, SvalArr, total: sampleArr.length };
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
  if (!best) throw new Error("FasterRW (sweep): no GP candidate evaluated successfully");
  return best;
}

// ---- subgroup trial -------------------------------------------------
// Runs one bootstrap trial restricted to `idxSubset` query indices.
// Returns:
//   fastrw_avg_abs       scalar (mean |fused - GT| over the G points)
//   fasterrw_avg_abs     scalar (mean |T_eps - GT| over the G points)
//   fastrw_per_query     length-G array of fused per-point T_hat(x_i)
//   fasterrw_per_query   length-G array of GP-corrected T_eps(x_i)
function subgroupTrial({
  Nmax, N, obs, gt, grouped, rng,
  prior, allPoints, xy, idxSubset,
}) {
  const G = idxSubset.length;
  // bootstrap index set (over MC paths)
  const idx = new Array(N);
  const multiplicity = new Int32Array(Nmax);
  for (let r = 0; r < N; r++) {
    const i = Math.floor(rng() * Nmax);
    idx[r] = i;
    multiplicity[i] += 1;
  }
  // direct mean / variance only for the G targets in this subgroup
  const directMean = new Array(G);
  const directVar = new Array(G);
  for (let gi = 0; gi < G; gi++) {
    const j = idxSubset[gi];
    const samples = new Array(N);
    for (let r = 0; r < N; r++) samples[r] = obs[idx[r]][j];
    directMean[gi] = mean(samples);
    directVar[gi] = Math.max(variance(samples), EPS);
  }
  // membership flag for fast filtering of tail records into the G targets.
  // A pseudo-sample is admitted iff BOTH its source query AND its target
  // query are in the current subgroup (mimics the user-facing scenario
  // "we only co-query these G points"). The path-index multiplicity is
  // indexed by sampleArr (path index), NOT sourceArr (query index 0..M-1).
  const inSubgroup = new Uint8Array(allPoints.length);
  const targetSlot = new Int32Array(allPoints.length).fill(-1);
  for (let gi = 0; gi < G; gi++) {
    inSubgroup[idxSubset[gi]] = 1;
    targetSlot[idxSubset[gi]] = gi;
  }
  const tailSamples = Array.from({ length: G }, () => []);
  for (let g = 0; g < grouped.total; g++) {
    if (!inSubgroup[grouped.sourceArr[g]]) continue;
    const m = multiplicity[grouped.sampleArr[g]];
    if (!m) continue;
    const slot = targetSlot[grouped.targetArr[g]];
    if (slot < 0) continue;
    const v = grouped.SvalArr[g];
    for (let r = 0; r < m; r++) tailSamples[slot].push(v);
  }
  // FastRW fused per target
  const fused = new Array(G);
  const fusedVar = new Array(G);
  for (let gi = 0; gi < G; gi++) {
    const tails = tailSamples[gi];
    const wDir = N / directVar[gi];
    if (tails.length < 2) {
      fused[gi] = directMean[gi];
      fusedVar[gi] = 1 / wDir;
      continue;
    }
    const tm = mean(tails);
    const tv = Math.max(variance(tails), EPS);
    const wTail = (tails.length * SCALE) / tv;
    fused[gi] = (wDir * directMean[gi] + wTail * tm) / (wDir + wTail);
    fusedVar[gi] = 1 / (wDir + wTail);
  }
  const fastErrs = new Array(G);
  for (let gi = 0; gi < G; gi++) {
    fastErrs[gi] = Math.abs(fused[gi] - gt[idxSubset[gi]]);
  }
  const fastrw_avg_abs = mean(fastErrs);

  // FasterRW: GP only over the G subgroup points
  const subPoints = idxSubset.map((j) => allPoints[j]);
  const subPrior = idxSubset.map((j) => prior[j]);
  const y = subPrior.map((p, gi) => p - fused[gi]);
  const selected = selectGP(subPoints, xy, y, fusedVar);
  const T_eps = subPrior.map((p, gi) => p - selected.epsHat[gi]);
  const fasterErrs = T_eps.map((t, gi) => Math.abs(t - gt[idxSubset[gi]]));
  const fasterrw_avg_abs = mean(fasterErrs);

  return {
    fastrw_avg_abs,
    fasterrw_avg_abs,
    fastrw_per_query: fused.slice(),
    fasterrw_per_query: T_eps.slice(),
  };
}

// ---- partitioning ---------------------------------------------------
// Disjoint subgroups of consecutive indices: floor(M/G) groups of size G.
// Leftover points (when M is not divisible by G) are dropped, matching
// the description in the task (which uses G that divide M=16).
function partitionDisjoint(M, G) {
  const K = Math.floor(M / G);
  const groups = [];
  for (let k = 0; k < K; k++) {
    const subset = [];
    for (let i = 0; i < G; i++) subset.push(k * G + i);
    groups.push(subset);
  }
  return groups;
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

  const { prior, points: allPoints, xy } = loadPriorAndPoints(args.configPath);
  if (prior.length !== M) {
    process.stderr.write(`Error: prior length ${prior.length} != M=${M}.\n`);
    process.exit(2);
  }

  const grouped = buildGroupedRecords(data, ALPHA_MIN);
  const obs = data.obs_data;

  // Per-G summary
  const groupSummaries = [];
  // Per-G average within-subgroup bootstrap variance (legacy avg_abs metric)
  const meanWithinVarByG = { fastrw: {}, fasterrw: {} };
  // Per-G per-query bootstrap variance of the point estimate (canonical metric)
  //   perQueryVarByG[method][G] = length-M array indexed by global query idx,
  //   or null where the query was not covered at this G.
  const perQueryVarByG = { fastrw: {}, fasterrw: {} };

  for (const G of args.groups) {
    if (M % G !== 0) {
      process.stderr.write(`Warning: G=${G} does not divide M=${M}; dropping leftovers.\n`);
    }
    const subsets = partitionDisjoint(M, G);
    const K = subsets.length;
    process.stderr.write(`[group_size_sweep] G=${G} K=${K} N=${args.N} B=${args.B}\n`);
    if (K === 0) {
      process.stderr.write(`  (skipping G=${G}: no full subgroup of that size fits in M=${M})\n`);
      continue;
    }

    const perSubgroup = [];
    // pointSamples[method][global_query_idx] = array of B point estimates
    // (we only fill the queries that actually appear in some subgroup at this G)
    const pointSamplesFast = new Array(M).fill(null);
    const pointSamplesFaster = new Array(M).fill(null);

    for (let k = 0; k < K; k++) {
      const idxSubset = subsets[k];
      const fastVals = new Array(args.B);
      const fasterVals = new Array(args.B);
      // per-query series across the B trials, length-G arrays of length-B arrays
      const perQueryFast = idxSubset.map(() => new Array(args.B));
      const perQueryFaster = idxSubset.map(() => new Array(args.B));

      for (let b = 1; b <= args.B; b++) {
        // Distinct seed per (G, k, b) so trials are independent across G
        // and across subgroups, but byte-reproducible for any given --seed.
        const seed = args.seed + (G * 1000003) + (k * 10007) + b;
        const rng = mulberry32(seed);
        const t = subgroupTrial({
          Nmax, N: args.N, obs, gt, grouped, rng,
          prior, allPoints, xy, idxSubset,
        });
        fastVals[b - 1] = t.fastrw_avg_abs;
        fasterVals[b - 1] = t.fasterrw_avg_abs;
        for (let gi = 0; gi < idxSubset.length; gi++) {
          perQueryFast[gi][b - 1] = t.fastrw_per_query[gi];
          perQueryFaster[gi][b - 1] = t.fasterrw_per_query[gi];
        }
      }

      // Stash per-query point estimates by global query index
      for (let gi = 0; gi < idxSubset.length; gi++) {
        const qIdx = idxSubset[gi];
        pointSamplesFast[qIdx] = perQueryFast[gi];
        pointSamplesFaster[qIdx] = perQueryFaster[gi];
      }

      // Per-subgroup per-query bootstrap variances (point estimates)
      const fastPerQueryVar = perQueryFast.map((arr) => variance(arr));
      const fasterPerQueryVar = perQueryFaster.map((arr) => variance(arr));

      perSubgroup.push({
        k, indices: idxSubset,
        fastrw:   { mean_avg_abs: mean(fastVals),   std_avg_abs: std(fastVals),
                    within_var: variance(fastVals),
                    per_query_var: fastPerQueryVar },
        fasterrw: { mean_avg_abs: mean(fasterVals), std_avg_abs: std(fasterVals),
                    within_var: variance(fasterVals),
                    per_query_var: fasterPerQueryVar },
      });
    }

    // Aggregate across subgroups
    const fastrwMeans = perSubgroup.map((s) => s.fastrw.mean_avg_abs);
    const fasterrwMeans = perSubgroup.map((s) => s.fasterrw.mean_avg_abs);
    const fastrwWithinVar = mean(perSubgroup.map((s) => s.fastrw.within_var));
    const fasterrwWithinVar = mean(perSubgroup.map((s) => s.fasterrw.within_var));

    meanWithinVarByG.fastrw[G] = fastrwWithinVar;
    meanWithinVarByG.fasterrw[G] = fasterrwWithinVar;

    // Per-query bootstrap variance, indexed by global query idx
    const perQueryVarFast = pointSamplesFast.map((arr) => arr == null ? null : variance(arr));
    const perQueryVarFaster = pointSamplesFaster.map((arr) => arr == null ? null : variance(arr));
    perQueryVarByG.fastrw[G] = perQueryVarFast;
    perQueryVarByG.fasterrw[G] = perQueryVarFaster;

    groupSummaries.push({
      G, K, N: args.N, B: args.B, seed_base: args.seed,
      subgroup_indices: subsets,
      fastrw: {
        per_subgroup: perSubgroup.map((s) => s.fastrw),
        mean_avg_abs: mean(fastrwMeans),
        std_avg_abs: K > 1 ? std(fastrwMeans) : perSubgroup[0].fastrw.std_avg_abs,
        mean_within_var: fastrwWithinVar,
        // Legacy avg_abs-based fields (filled below)
        N_hat: null,
        speedup: null,
        // Per-query (canonical tab:multi) fields (filled below)
        per_query_var: perQueryVarFast,
        per_query_N_hat: null,
        per_query_speedup: null,
        per_query_speedup_mean: null,
        per_query_speedup_std: null,
      },
      fasterrw: {
        per_subgroup: perSubgroup.map((s) => s.fasterrw),
        mean_avg_abs: mean(fasterrwMeans),
        std_avg_abs: K > 1 ? std(fasterrwMeans) : perSubgroup[0].fasterrw.std_avg_abs,
        mean_within_var: fasterrwWithinVar,
        N_hat: null,
        speedup: null,
        per_query_var: perQueryVarFaster,
        per_query_N_hat: null,
        per_query_speedup: null,
        per_query_speedup_mean: null,
        per_query_speedup_std: null,
      },
    });
  }

  // ----- Fill in metric (A): legacy avg_abs speedup ---------------------
  // Uses the G=1 within-subgroup avg_abs variance as the single-query
  // baseline. If 1 is not in --groups, the speedup is reported as null.
  const haveBaseline = (1 in meanWithinVarByG.fastrw) && (1 in meanWithinVarByG.fasterrw);
  if (haveBaseline) {
    const v1Fast = meanWithinVarByG.fastrw[1];
    const v1Faster = meanWithinVarByG.fasterrw[1];
    for (const g of groupSummaries) {
      const vG_fast = meanWithinVarByG.fastrw[g.G];
      const vG_faster = meanWithinVarByG.fasterrw[g.G];
      const speedup_fast = vG_fast > 0 ? v1Fast / vG_fast : null;
      const speedup_faster = vG_faster > 0 ? v1Faster / vG_faster : null;
      g.fastrw.N_hat = speedup_fast == null ? null : args.N * speedup_fast;
      g.fastrw.speedup = speedup_fast;
      g.fasterrw.N_hat = speedup_faster == null ? null : args.N * speedup_faster;
      g.fasterrw.speedup = speedup_faster;
    }
  }

  // ----- Fill in metric (B): canonical per-query speedup ----------------
  // For each query point i and each G, compute
  //   N_hat(i, G) = N * Var_single(i) / Var_fused(i, G).
  // Aggregate by reporting mean +/- std of N_hat/N across query points.
  // At G=1 this is exactly 1 by construction.
  const havePerQueryBase = (1 in perQueryVarByG.fastrw) && (1 in perQueryVarByG.fasterrw);
  if (havePerQueryBase) {
    const baseFast = perQueryVarByG.fastrw[1];
    const baseFaster = perQueryVarByG.fasterrw[1];
    for (const g of groupSummaries) {
      for (const method of ["fastrw", "fasterrw"]) {
        const base = method === "fastrw" ? baseFast : baseFaster;
        const varAtG = perQueryVarByG[method][g.G];
        const N_hat = new Array(M).fill(null);
        const sp = new Array(M).fill(null);
        for (let i = 0; i < M; i++) {
          if (varAtG[i] == null) continue;     // query not covered at this G
          if (base[i] == null) continue;       // no G=1 baseline for this query
          if (!(varAtG[i] > 0)) continue;
          const ratio = base[i] / varAtG[i];
          sp[i] = ratio;
          N_hat[i] = args.N * ratio;
        }
        const valid = sp.filter((v) => v != null);
        const spMean = valid.length ? mean(valid) : null;
        const spStd = valid.length > 1 ? std(valid) : 0;
        g[method].per_query_N_hat = N_hat;
        g[method].per_query_speedup = sp;
        g[method].per_query_speedup_mean = spMean;
        g[method].per_query_speedup_std = spStd;
      }
    }
  }

  const out = {
    script: "run_group_size_sweep.js",
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
    // Documentation of the two metrics, embedded in the output for traceability.
    metrics: {
      legacy_avg_abs: {
        description: "Speedup = Var_single(avg_abs) / Var_group(avg_abs), where Var is the bootstrap variance of the per-subgroup mean-of-|err|. Confounds the trivial 1/G averaging factor with the per-query fusion benefit. NOT canonical.",
        fields: ["mean_within_var", "N_hat", "speedup"],
      },
      per_query: {
        description: "Speedup = Var_single(T_hat(x_i)) / Var_fused(T_hat(x_i); G), per query point, then averaged across queries. T_hat(x_i) is the FastRW fused estimate (or FasterRW T_eps) at x_i, NOT the avg_abs error. Matches the legacy paper's hat{N}(x) = Z(x)/Var[hat{T}(x)] definition. CANONICAL tab:multi value.",
        fields: ["per_query_var", "per_query_N_hat", "per_query_speedup", "per_query_speedup_mean", "per_query_speedup_std"],
        notes: "At G=1 the speedup is exactly 1 for both methods by construction. FasterRW with G=1 is degenerate (universal-kriging GP with one training point reduces to the identity, so T_eps = FastRW fused), so the G=1 row for FasterRW also reads 1x; the FastRW G=1 row is the canonical baseline.",
      },
    },
    groups: groupSummaries,
    mean_avg_steps: meanAvgSteps,
    path_step_at_N: args.N * meanAvgSteps,
    runtime_seconds: summaryMeta?.random_walk?.runtime_seconds ?? null,
  };

  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(out, null, 2)}\n`);

  process.stderr.write("\n[group_size_sweep] Summary (CANONICAL = per-query metric):\n");
  process.stderr.write("  G    K    FastRW per-q speedup (mean +/- std)   FasterRW per-q speedup (mean +/- std)\n");
  for (const g of groupSummaries) {
    const f = g.fastrw.per_query_speedup_mean;
    const fs_ = g.fastrw.per_query_speedup_std;
    const x = g.fasterrw.per_query_speedup_mean;
    const xs = g.fasterrw.per_query_speedup_std;
    const fmt = (m, s) => m == null ? "n/a" : `${m.toFixed(2)}x +/- ${s.toFixed(2)}`;
    process.stderr.write(
      `  ${String(g.G).padStart(2)}   ${String(g.K).padStart(2)}   ` +
      `${fmt(f, fs_).padStart(28)}     ${fmt(x, xs).padStart(28)}\n`
    );
  }
  process.stderr.write("\n[group_size_sweep] (LEGACY avg_abs metric, for reference only):\n");
  process.stderr.write("  G    K    FastRW avg_abs speedup        FasterRW avg_abs speedup\n");
  for (const g of groupSummaries) {
    const fSp = g.fastrw.speedup == null ? "n/a" : g.fastrw.speedup.toFixed(2) + "x";
    const xSp = g.fasterrw.speedup == null ? "n/a" : g.fasterrw.speedup.toFixed(2) + "x";
    process.stderr.write(
      `  ${String(g.G).padStart(2)}   ${String(g.K).padStart(2)}   ` +
      `${fSp.padStart(7)}                       ${xSp.padStart(7)}\n`
    );
  }
  process.stderr.write(`\n[group_size_sweep] Wrote ${args.outputPath}\n`);
}

main();
