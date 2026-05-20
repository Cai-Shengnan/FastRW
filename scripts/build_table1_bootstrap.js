#!/usr/bin/env node
// Build Table 1 markdown from bootstrap subsample JSONs.
// Usage: build_table1_bootstrap.js <case_label> <prior_dof> <prior_path> <prior_avg_abs> <fastrw_run_dir> <pirw_run_dir> <fastrw_runtime_seconds> <out_md_path>
// e.g. node scripts/build_table1_bootstrap.js "Case 2" 2779 data/cases/case2_4core_top1_bottom1/comsol/comso_2779/temp.bin 0.94 \
//   outputs/tcad_table1_sweep/case2/fastrw_dof2779_N8192 outputs/tcad_table1_sweep/case2/pirw_N4096 228.76 \
//   outputs/tcad_table1_sweep/case2/table1_case2_bootstrap.md

const fs = require('fs');
const path = require('path');

const [, , caseLabel, priorDof, priorPath, priorAvgAbs, fastrwDir, pirwDir, fastrwRuntime, outPath] = process.argv;

if (!outPath) {
  console.error('Usage: build_table1_bootstrap.js <case_label> <prior_dof> <prior_path> <prior_avg_abs> <fastrw_run_dir> <pirw_run_dir> <fastrw_runtime_seconds> <out_md_path>');
  process.exit(2);
}

const EPS_LIST = [0.5, 0.4, 0.3];

const fastrwJson = JSON.parse(fs.readFileSync(path.join(fastrwDir, 'bootstrap_sweep_fastrw.json'), 'utf8'));
const pirwJson = JSON.parse(fs.readFileSync(path.join(pirwDir, 'bootstrap_sweep_pirw.json'), 'utf8'));

// Pick smallest N where method's mean <= eps
function pickN(rows, methodPrefix, eps) {
  const meanKey = `${methodPrefix}_avg_abs_mean`;
  const stdKey = `${methodPrefix}_avg_abs_std`;
  const sorted = [...rows].sort((a, b) => a.N - b.N);
  for (const r of sorted) {
    if (r[meanKey] != null && r[meanKey] <= eps) {
      return { N: r.N, mean: r[meanKey], std: r[stdKey] };
    }
  }
  return null;
}

const meanStepsFastrw = fastrwJson.mean_avg_steps;
const meanStepsPirw = pirwJson.mean_avg_steps;

const rows = [];
for (const eps of EPS_LIST) {
  const pirw = pickN(pirwJson.results, 'direct', eps);
  const fastrw = pickN(fastrwJson.results, 'fastrw', eps);
  const fasterrw = pickN(fastrwJson.results, 'fasterrw', eps);

  const pirwPS = pirw ? pirw.N * meanStepsPirw : null;
  const fastrwPS = fastrw ? fastrw.N * meanStepsFastrw : null;
  const fasterrwPS = fasterrw ? fasterrw.N * meanStepsFastrw : null;

  const fastrwSpd = (pirwPS && fastrwPS) ? pirwPS / fastrwPS : null;
  const fasterrwSpd = (pirwPS && fasterrwPS) ? pirwPS / fasterrwPS : null;

  rows.push({ eps, pirw, fastrw, fasterrw, pirwPS, fastrwPS, fasterrwPS, fastrwSpd, fasterrwSpd });
}

const fmtPick = (p) => p ? `${p.N} -> ${p.mean.toFixed(4)}±${p.std.toFixed(4)}` : 'n/a';
const fmtPS = (v) => v == null ? 'n/a' : v.toExponential(3);
const fmtSpd = (v) => v == null ? 'n/a' : v.toFixed(2);

const lines = [];
lines.push(`# ${caseLabel} — Table 1 (bootstrap subsample)`);
lines.push('');
lines.push(`Prior: dof=${priorDof}, path=${priorPath} (prior avg_abs ≈ ${priorAvgAbs} K).`);
lines.push(`alpha_min=${fastrwJson.alpha_min}, seed=${fastrwJson.seed}, M=${fastrwJson.M}.`);
lines.push('');
lines.push(`Nmax: FastRW=${fastrwJson.Nmax} (one MC, runtime ${Number(fastrwRuntime).toFixed(2)} s on Apple M5 Pro), PIRW=${pirwJson.Nmax} (existing MC); Bootstrap B=${fastrwJson.B}.`);
lines.push('Convention: smallest dense-grid N per method/ε satisfying <method>_avg_abs_mean ≤ ε.');
lines.push('');
lines.push('| ε (K) | pirw N → avg_abs±std | pirw p×s | fastrw N → avg_abs±std | fastrw p×s | fastrw spd | fasterrw N → avg_abs±std | fasterrw p×s | fasterrw spd |');
lines.push('|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  lines.push(`| ${r.eps} | ${fmtPick(r.pirw)} | ${fmtPS(r.pirwPS)} | ${fmtPick(r.fastrw)} | ${fmtPS(r.fastrwPS)} | ${fmtSpd(r.fastrwSpd)} | ${fmtPick(r.fasterrw)} | ${fmtPS(r.fasterrwPS)} | ${fmtSpd(r.fasterrwSpd)} |`);
}
lines.push('');
lines.push(`Per-method mean_avg_steps: PIRW=${Math.round(meanStepsPirw)}, FastRW=${Math.round(meanStepsFastrw)}.`);
lines.push('');
lines.push('## Bootstrap sweep — direct/fastrw/fasterrw avg_abs by N (mean ± std)');
lines.push('');
lines.push(`FastRW run (one MC at Nmax=${fastrwJson.Nmax}, bootstrapped):`);
lines.push('');
lines.push('| N | direct mean±std | fastrw mean±std | fasterrw mean±std |');
lines.push('|---|---|---|---|');
for (const r of [...fastrwJson.results].sort((a, b) => a.N - b.N)) {
  const d = `${r.direct_avg_abs_mean.toFixed(4)}±${r.direct_avg_abs_std.toFixed(4)}`;
  const f = `${r.fastrw_avg_abs_mean.toFixed(4)}±${r.fastrw_avg_abs_std.toFixed(4)}`;
  const fe = `${r.fasterrw_avg_abs_mean.toFixed(4)}±${r.fasterrw_avg_abs_std.toFixed(4)}`;
  lines.push(`| ${r.N} | ${d} | ${f} | ${fe} |`);
}
lines.push('');
lines.push(`PIRW run (existing N=${pirwJson.Nmax} MC, bootstrapped, direct only):`);
lines.push('');
lines.push('| N | direct mean±std |');
lines.push('|---|---|');
for (const r of [...pirwJson.results].sort((a, b) => a.N - b.N)) {
  const d = `${r.direct_avg_abs_mean.toFixed(4)}±${r.direct_avg_abs_std.toFixed(4)}`;
  lines.push(`| ${r.N} | ${d} |`);
}
lines.push('');
lines.push('## Monotonicity notes');
lines.push('');

// monotonicity check on FastRW/FasterRW sweep
function monoCheck(rowsArr, key) {
  const sorted = [...rowsArr].sort((a, b) => a.N - b.N);
  const bumps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1][key];
    const cur = sorted[i][key];
    if (cur > prev + 1e-6) {
      bumps.push({ from: sorted[i - 1].N, fromVal: prev, to: sorted[i].N, toVal: cur, delta: cur - prev });
    }
  }
  return bumps;
}

function reportMono(label, key) {
  const bumps = monoCheck(fastrwJson.results, key);
  if (bumps.length === 0) {
    lines.push(`Bootstrap-smoothed \`${label}(N)\` is strictly decreasing on the dense grid.`);
  } else {
    const items = bumps.map(b => `N=${b.from}->${b.to}: ${b.fromVal.toFixed(4)}->${b.toVal.toFixed(4)} (Δ=+${b.delta.toFixed(4)})`).join('; ');
    lines.push(`\`${label}(N)\` is monotonic except: ${items}.`);
  }
}

reportMono('fastrw_avg_abs_mean', 'fastrw_avg_abs_mean');
reportMono('fasterrw_avg_abs_mean', 'fasterrw_avg_abs_mean');

// PIRW monotonicity
const pBumps = monoCheck(pirwJson.results, 'direct_avg_abs_mean');
if (pBumps.length === 0) {
  lines.push(`Bootstrap-smoothed \`direct_avg_abs_mean(N)\` (PIRW) is strictly decreasing on the dense grid.`);
} else {
  const items = pBumps.map(b => `N=${b.from}->${b.to}: ${b.fromVal.toFixed(4)}->${b.toVal.toFixed(4)} (Δ=+${b.delta.toFixed(4)})`).join('; ');
  lines.push(`\`direct_avg_abs_mean(N)\` (PIRW) is monotonic except: ${items}.`);
}

fs.writeFileSync(outPath, lines.join('\n') + '\n');
console.log(`Wrote ${outPath}`);
