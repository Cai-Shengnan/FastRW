#!/usr/bin/env node
// =====================================================================
// diagnose_fastrw_groupsize.js
//
// Purpose
//   Controlled comparison to isolate which of three suspected mechanisms
//   accounts for the gap between FastRW's measured per-query speedup
//   N_hat/N (~1.00..1.02x across G=1,4,8,16 on Case 1) and the
//   back-of-envelope ceiling 1 + (G-1)*p*rho ~= 1.65x at G=16.
//
//   We replicate the canonical fusion / per-query-bootstrap-variance
//   pipeline from scripts/run_group_size_sweep.js (FastRW path only,
//   no GP) and run four variants of the inverse-variance fusion step:
//
//     A — original (suspected-bug):
//           m = multiplicity[grouped.sourceArr[g]]
//         (multiplicity is indexed by source-QUERY index 0..M-1, which
//          means we only ever read multiplicity[0..15] out of 8192 slots
//          -- a path is "in the bootstrap" iff path index == source
//          query index happens to be drawn.)
//
//     B — bug fix:
//           store sample (path index) in grouped records,
//           m = multiplicity[grouped.sampleArr[g]]
//         (the apparently-intended semantics: a pseudo-sample fires iff
//          its source PATH was drawn in the bootstrap.)
//
//     C — bug fix + use direct sample variance as tail-variance proxy:
//           wTail = n_q / directVar[t]
//         (removes the empirical-tail-variance noise as a confounder.)
//
//     D — bug fix + count-only fusion:
//           wDir = N,  wTail = n_q
//         (drops variance from both weights; equivalent to assuming
//          sigma_dir = sigma_tail. Strongest assumption-free baseline.)
//
//   For each (variant, G in {1,4,8,16}) cell we report per-query
//   speedup N_hat/N = Var_1(t) / Var_G(t) as mean +/- std across the
//   M=16 query points. G=1 should give exactly 1.00x for each variant
//   (no tail records survive the G=1 within-subgroup filter).
//
//   This script is a SELF-CONTAINED COPY of the fusion logic from
//   run_group_size_sweep.js. It does NOT touch any canonical script.
//
// Usage
//   node scripts/diagnose_fastrw_groupsize.js [options]
//
// Options
//   --run_dir=<path>   default outputs/tcad_table1/fastrw_case1
//   --N=<int>          default 1000
//   --B=<int>          default 500
//   --seed=<int>       default 42
//   --groups=<csv>     default 1,4,8,16
//   --output=<path>    default outputs/diagnose_fastrw_groupsize/case1_variants.json
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

const ROOT_DIR = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    runDir: path.join(ROOT_DIR, "outputs/tcad_table1/fastrw_case1"),
    N: 1000,
    B: 500,
    seed: 42,
    groups: [1, 4, 8, 16],
    outputPath: path.join(
      ROOT_DIR, "outputs/diagnose_fastrw_groupsize/case1_variants.json"
    ),
  };
  for (const a of args) {
    let m;
    if ((m = a.match(/^--run_dir=(.+)$/))) { opts.runDir = path.resolve(m[1]); continue; }
    if ((m = a.match(/^--N=(\d+)$/))) { opts.N = Number(m[1]); continue; }
    if ((m = a.match(/^--B=(\d+)$/))) { opts.B = Number(m[1]); continue; }
    if ((m = a.match(/^--seed=(-?\d+)$/))) { opts.seed = Number(m[1]); continue; }
    if ((m = a.match(/^--groups=(.+)$/))) {
      opts.groups = m[1].split(",").map((s) => Number(s.trim())).filter((n) => n >= 1);
      continue;
    }
    if ((m = a.match(/^--output=(.+)$/))) { opts.outputPath = path.resolve(m[1]); continue; }
    if (a === "--help" || a === "-h") {
      process.stderr.write(
        "Usage: diagnose_fastrw_groupsize.js [--run_dir=PATH] [--N=INT] " +
        "[--B=INT] [--seed=INT] [--groups=CSV] [--output=PATH]\n"
      );
      process.exit(0);
    }
    process.stderr.write(`Error: unknown arg '${a}'.\n`);
    process.exit(2);
  }
  return opts;
}

// ---------------------------------------------------------------------
// Build grouped records. Mirrors run_group_size_sweep.js/buildGroupedRecords
// EXCEPT we additionally retain the SAMPLE (path index) field so variants
// B/C/D can index multiplicity by path index instead of source-query index.
// Variant A still uses sourceArr[g] for its lookup, matching the canonical
// (suspected-bug) behaviour byte-for-byte on the same constraints.json.
// ---------------------------------------------------------------------
function buildGroupedRecords(data, alphaMin) {
  const grouped = new Map();
  for (let k = 0; k < data.K; k++) {
    const source = data.i_k[k] - 1;
    const target = data.j_k[k] - 1;
    const sample = data.sample_k[k] - 1;  // PATH index 0..Nmax-1
    const alpha = data.alpha_k[k];
    const b = data.b_k[k];
    if (!(alpha >= alphaMin)) continue;
    if (source === target) continue;
    const fullSample = data.obs_data[sample][source];
    const Sval = (fullSample - b) / alpha;
    if (!Number.isFinite(Sval)) continue;
    // Canonical key (source, sample, target) with max-alpha policy.
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
  return { sourceArr, sampleArr, targetArr, SvalArr, total: sourceArr.length };
}

// ---------------------------------------------------------------------
// One bootstrap trial for a single subgroup, evaluated under all four
// variants in parallel from the SAME bootstrap path-index draw. This
// keeps trial-to-trial RNG aligned across variants so the only thing
// that differs across A/B/C/D is the fusion rule.
//
// Returns:
//   { A: per_query[G], B: per_query[G], C: per_query[G], D: per_query[G] }
// each entry is the fused T_hat for one of the G queries in idxSubset.
// ---------------------------------------------------------------------
function subgroupTrialAllVariants({
  Nmax, M, N, obs, grouped, idxSubset, rng,
}) {
  const G = idxSubset.length;

  // shared bootstrap draw
  const idx = new Array(N);
  const multiplicity = new Int32Array(Nmax);
  for (let r = 0; r < N; r++) {
    const i = Math.floor(rng() * Nmax);
    idx[r] = i;
    multiplicity[i] += 1;
  }

  // direct mean / variance per target (shared)
  const directMean = new Array(G);
  const directVar = new Array(G);
  for (let gi = 0; gi < G; gi++) {
    const j = idxSubset[gi];
    const samples = new Array(N);
    for (let r = 0; r < N; r++) samples[r] = obs[idx[r]][j];
    directMean[gi] = mean(samples);
    directVar[gi] = Math.max(variance(samples), EPS);
  }

  // Per-variant tail buckets. Variant A uses sourceArr lookup (the
  // suspected bug); B/C/D use sampleArr lookup (the bug fix).
  const targetSlot = new Int32Array(M).fill(-1);
  for (let gi = 0; gi < G; gi++) targetSlot[idxSubset[gi]] = gi;

  const tailsA = Array.from({ length: G }, () => []);
  const tailsBCD = Array.from({ length: G }, () => []);

  for (let g = 0; g < grouped.total; g++) {
    const slot = targetSlot[grouped.targetArr[g]];
    if (slot < 0) continue;
    const v = grouped.SvalArr[g];
    // A: index by source-QUERY index (canonical bug)
    const mA = multiplicity[grouped.sourceArr[g]];
    if (mA) for (let r = 0; r < mA; r++) tailsA[slot].push(v);
    // B/C/D: index by source-PATH index (the fix; same bucket reused)
    const mF = multiplicity[grouped.sampleArr[g]];
    if (mF) for (let r = 0; r < mF; r++) tailsBCD[slot].push(v);
  }

  // Fuse under each variant.
  const fusedA = new Array(G);
  const fusedB = new Array(G);
  const fusedC = new Array(G);
  const fusedD = new Array(G);

  for (let gi = 0; gi < G; gi++) {
    // Variant A: original fusion rule, original (bug) tail bucket.
    {
      const tails = tailsA[gi];
      const wDir = N / directVar[gi];
      if (tails.length < 2) {
        fusedA[gi] = directMean[gi];
      } else {
        const tm = mean(tails);
        const tv = Math.max(variance(tails), EPS);
        const wTail = (tails.length * SCALE) / tv;
        fusedA[gi] = (wDir * directMean[gi] + wTail * tm) / (wDir + wTail);
      }
    }
    // Variant B: same fusion rule, fixed tail bucket.
    {
      const tails = tailsBCD[gi];
      const wDir = N / directVar[gi];
      if (tails.length < 2) {
        fusedB[gi] = directMean[gi];
      } else {
        const tm = mean(tails);
        const tv = Math.max(variance(tails), EPS);
        const wTail = (tails.length * SCALE) / tv;
        fusedB[gi] = (wDir * directMean[gi] + wTail * tm) / (wDir + wTail);
      }
    }
    // Variant C: bug fix + tail variance := direct variance.
    {
      const tails = tailsBCD[gi];
      const wDir = N / directVar[gi];
      if (tails.length < 2) {
        fusedC[gi] = directMean[gi];
      } else {
        const tm = mean(tails);
        const wTail = (tails.length * SCALE) / directVar[gi];
        fusedC[gi] = (wDir * directMean[gi] + wTail * tm) / (wDir + wTail);
      }
    }
    // Variant D: bug fix + count-only.
    {
      const tails = tailsBCD[gi];
      const wDir = N;
      if (tails.length < 2) {
        fusedD[gi] = directMean[gi];
      } else {
        const tm = mean(tails);
        const wTail = tails.length * SCALE;
        fusedD[gi] = (wDir * directMean[gi] + wTail * tm) / (wDir + wTail);
      }
    }
  }

  return { A: fusedA, B: fusedB, C: fusedC, D: fusedD };
}

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
  for (const p of [constraintsPath, directPath]) {
    if (!fs.existsSync(p)) {
      process.stderr.write(`Error: missing ${p}\n`);
      process.exit(2);
    }
  }

  process.stderr.write(`[diagnose] Loading ${constraintsPath}...\n`);
  const data = JSON.parse(fs.readFileSync(constraintsPath, "utf8"));
  const Nmax = data.N;
  const M = data.M;
  if (args.N > Nmax) {
    process.stderr.write(`Error: --N=${args.N} > Nmax=${Nmax}\n`);
    process.exit(2);
  }

  const directRows = readCsv(directPath);
  if (directRows.length !== M) {
    process.stderr.write(`Error: direct.csv rows=${directRows.length} != M=${M}\n`);
    process.exit(2);
  }
  // gt only used for reference / not needed for variance-based speedup
  const gt = directRows.map((row) => row.GT_Temperature);

  const grouped = buildGroupedRecords(data, ALPHA_MIN);
  const obs = data.obs_data;
  process.stderr.write(`[diagnose] grouped records (no_self, alpha>=${ALPHA_MIN}): ${grouped.total}\n`);
  process.stderr.write(`[diagnose] Nmax=${Nmax} M=${M} N=${args.N} B=${args.B} seed=${args.seed}\n`);
  process.stderr.write(`[diagnose] groups=${args.groups.join(",")}\n`);

  // Per-variant per-G per-query bootstrap variance, indexed by global query
  // index 0..M-1. Filled at every G covered by the sweep.
  const variants = ["A", "B", "C", "D"];
  const perQueryVar = {};
  for (const v of variants) perQueryVar[v] = {};

  for (const G of args.groups) {
    if (M % G !== 0) {
      process.stderr.write(`[diagnose] Warning: G=${G} does not divide M=${M}; dropping leftovers.\n`);
    }
    const subsets = partitionDisjoint(M, G);
    process.stderr.write(`[diagnose] G=${G} K=${subsets.length}\n`);

    // pointSamples[variant][global query idx] = length-B array (or null)
    const pointSamples = {};
    for (const v of variants) pointSamples[v] = new Array(M).fill(null);

    for (let k = 0; k < subsets.length; k++) {
      const idxSubset = subsets[k];
      // per-query series across B trials, length-G x length-B
      const series = {};
      for (const v of variants) {
        series[v] = idxSubset.map(() => new Array(args.B));
      }
      for (let b = 1; b <= args.B; b++) {
        // Match run_group_size_sweep.js seed scheme so anyone comparing
        // can re-derive trial-level numbers if needed.
        const seed = args.seed + (G * 1000003) + (k * 10007) + b;
        const rng = mulberry32(seed);
        const t = subgroupTrialAllVariants({
          Nmax, M, N: args.N, obs, grouped, idxSubset, rng,
        });
        for (const v of variants) {
          for (let gi = 0; gi < idxSubset.length; gi++) {
            series[v][gi][b - 1] = t[v][gi];
          }
        }
      }
      for (const v of variants) {
        for (let gi = 0; gi < idxSubset.length; gi++) {
          pointSamples[v][idxSubset[gi]] = series[v][gi];
        }
      }
    }

    for (const v of variants) {
      perQueryVar[v][G] = pointSamples[v].map((arr) => arr == null ? null : variance(arr));
    }
  }

  // -------------------------------------------------------------------
  // Compute per-query speedup N_hat/N for each (variant, G).
  // Baseline = same variant's per-query variance at G=1 (must be in args.groups).
  // -------------------------------------------------------------------
  if (!args.groups.includes(1)) {
    process.stderr.write("Error: G=1 must be in --groups for the baseline.\n");
    process.exit(2);
  }
  const cell = {};   // cell[variant][G] = { speedup_per_query[M], mean, std }
  for (const v of variants) {
    cell[v] = {};
    const base = perQueryVar[v][1];
    for (const G of args.groups) {
      const varAtG = perQueryVar[v][G];
      const sp = new Array(M).fill(null);
      for (let i = 0; i < M; i++) {
        if (varAtG[i] == null || base[i] == null) continue;
        if (!(varAtG[i] > 0)) continue;
        sp[i] = base[i] / varAtG[i];
      }
      const valid = sp.filter((x) => x != null);
      cell[v][G] = {
        per_query: sp,
        mean: valid.length ? mean(valid) : null,
        std: valid.length > 1 ? std(valid) : 0,
      };
    }
  }

  // -------------------------------------------------------------------
  // Pretty-printed table to stderr.
  // -------------------------------------------------------------------
  const labels = {
    A: "A (orig)    ",
    B: "B (fix)     ",
    C: "C (fix+var) ",
    D: "D (fix+cnt) ",
  };
  process.stderr.write("\n[diagnose] Per-query speedup N_hat/N (mean +/- std across 16 queries):\n");
  let header = "             ";
  for (const G of args.groups) header += `   G=${String(G).padStart(2)}        `;
  process.stderr.write(header + "\n");
  for (const v of variants) {
    let row = labels[v];
    for (const G of args.groups) {
      const c = cell[v][G];
      const s = c.mean == null
        ? "    n/a    "
        : `${c.mean.toFixed(2)}+/-${c.std.toFixed(2)}`;
      row += "  " + s.padEnd(11);
    }
    process.stderr.write(row + "\n");
  }

  // -------------------------------------------------------------------
  // Write JSON output.
  // -------------------------------------------------------------------
  const out = {
    script: "diagnose_fastrw_groupsize.js",
    run_dir: args.runDir,
    Nmax, M, N: args.N, B: args.B,
    seed_base: args.seed,
    alpha_min: ALPHA_MIN,
    grouped_records: grouped.total,
    groups: args.groups,
    variants: {
      A: "original: m = multiplicity[sourceArr[g]] (suspected bug, canonical code)",
      B: "fix:      m = multiplicity[sampleArr[g]]",
      C: "fix+var:  B + wTail = n_q / directVar[t]",
      D: "fix+cnt:  B + wDir = N, wTail = n_q (count-only)",
    },
    per_query_variance: perQueryVar,         // [variant][G] -> length-M
    per_query_speedup:                       // [variant][G] -> length-M
      Object.fromEntries(variants.map((v) => [v,
        Object.fromEntries(args.groups.map((G) => [G, cell[v][G].per_query]))])),
    speedup_summary:                          // [variant][G] -> {mean, std}
      Object.fromEntries(variants.map((v) => [v,
        Object.fromEntries(args.groups.map((G) => [G, {
          mean: cell[v][G].mean, std: cell[v][G].std,
        }]))])),
    gt_reference: gt,
  };

  fs.mkdirSync(path.dirname(args.outputPath), { recursive: true });
  fs.writeFileSync(args.outputPath, `${JSON.stringify(out, null, 2)}\n`);
  process.stderr.write(`\n[diagnose] Wrote ${args.outputPath}\n`);
}

main();
