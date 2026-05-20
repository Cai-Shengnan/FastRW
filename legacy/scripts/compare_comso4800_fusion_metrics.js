#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "outputs", "fusion_diagnostics", "comso4800_compare");
const EPS = 1e-12;
const LENGTHSCALE_CELLS = [1, 2, 4, 8, 12, 20, 40];
const AMP_FACTORS = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10];

const CASES = [
  {
    label: "Case 1",
    fastrwDir: "outputs/fusion_diagnostics/comso4800_prior/case1/fastrw",
    fastrwConfig: "outputs/fusion_diagnostics/comso4800_prior/configs/case1_fastrw_comso4800.json",
    pirwDir: "outputs/fusion_diagnostics/case1_spacing_sweep/s10_current/pirw_direct",
  },
  {
    label: "Case 2",
    fastrwDir: "outputs/fusion_diagnostics/comso4800_prior/case2/fastrw",
    fastrwConfig: "outputs/fusion_diagnostics/comso4800_prior/configs/case2_fastrw_comso4800.json",
    pirwDir: "outputs/fusion_diagnostics/comso4800_compare/case2/pirw",
  },
];

function readCsv(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(",");
  return lines.map((line) => {
    const values = line.split(",");
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = Number(values[i]);
    return row;
  });
}

function writeCsv(file, rows, header) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => formatCsv(row[key])).join(","));
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function formatCsv(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

function resolvePath(baseFile, maybeRelative) {
  return path.isAbsolute(maybeRelative)
    ? maybeRelative
    : path.normalize(path.join(path.dirname(baseFile), maybeRelative));
}

function directMeans(data) {
  return Array.from({ length: data.M }, (_, i) => mean(data.obs_data.map((row) => row[i])));
}

function sampleVariances(data) {
  return Array.from({ length: data.M }, (_, i) => variance(data.obs_data.map((row) => row[i])));
}

function meanVariances(data) {
  return sampleVariances(data).map((value) => value / data.N);
}

function readRun(runDir) {
  const absDir = path.resolve(ROOT, runDir);
  const rows = readCsv(path.join(absDir, "direct.csv"));
  const data = JSON.parse(fs.readFileSync(path.join(absDir, "constraints.json"), "utf8"));
  return {
    dir: absDir,
    rows,
    data,
    gt: rows.map((row) => row.GT_Temperature),
    direct: rows.map((row) => row.Direct_Mean ?? row.Normal_Mean),
    meanVar: meanVariances(data),
    sampleVar: sampleVariances(data),
  };
}

function loadPriorAndPoints(configPath) {
  const absConfig = path.resolve(ROOT, configPath);
  const config = JSON.parse(fs.readFileSync(absConfig, "utf8"));
  const g = config.geometry;
  const q = config.query_grid;
  const xy = g.xy_resolution;
  const zres = g.z_resolution;
  const nx = Math.round(g.x_size / xy);
  const ny = Math.round(g.y_size / xy);
  const nzBottom = Math.round((g.bottom_thickness - zres) / zres);
  const zHeatFirst = nzBottom + 1;
  const z = (q.z ?? (g.bottom_thickness + 0.5 * g.middle_thickness)) + (q.z_offset || 0);
  const tempPath = resolvePath(absConfig, config.data.prior_temperature_path);
  const buf = fs.readFileSync(tempPath);
  const points = [];
  const prior = [];

  function tempAt(point) {
    const iz = Math.floor(point.z / zres) - zHeatFirst;
    const iy = Math.floor(point.y / xy);
    const ix = Math.floor(point.x / xy);
    return buf.readDoubleLE(((iz * ny + iy) * nx + ix) * 8) + (config.data.temperature_offset || 0);
  }

  for (const iy of q.y_indices) {
    for (const ix of q.x_indices) {
      const point = {
        x: ix * xy + (q.x_offset || 0),
        y: iy * xy + (q.y_offset || 0),
        z,
      };
      points.push(point);
      prior.push(tempAt(point));
    }
  }
  return { prior, points, xy };
}

function metrics(caseName, method, theta, gt, variances, extras = {}) {
  const errors = theta.map((value, i) => value - gt[i]);
  return {
    case: caseName,
    method,
    avg_abs_error: mean(errors.map(Math.abs)),
    avg_signed_error: mean(errors),
    avg_variance: variances ? mean(variances) : 0,
    ...extras,
  };
}

function invertMatrix(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < EPS) throw new Error("Singular matrix");
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];
    const div = a[col][col];
    for (let c = 0; c < 2 * n; c++) a[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let c = col; c < 2 * n; c++) a[r][c] -= factor * a[col][c];
    }
  }
  return a.map((row) => row.slice(n));
}

function solveLinearSystem(matrix, rhs) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < EPS) throw new Error("Singular matrix");
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];
    const div = a[col][col];
    for (let c = col; c <= n; c++) a[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
    }
  }
  return a.map((row) => row[n]);
}

function matMul(a, b) {
  const rows = a.length;
  const cols = b[0].length;
  const inner = b.length;
  const out = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let k = 0; k < inner; k++) {
      if (a[i][k] === 0) continue;
      for (let j = 0; j < cols; j++) out[i][j] += a[i][k] * b[k][j];
    }
  }
  return out;
}

function matVecMul(a, x) {
  return a.map((row) => row.reduce((sum, value, j) => sum + value * x[j], 0));
}

function transpose(a) {
  return Array.from({ length: a[0].length }, (_, j) => a.map((row) => row[j]));
}

function addDiag(matrix, values) {
  return matrix.map((row, i) => row.map((value, j) => value + (i === j ? values[i] : 0)));
}

function diagMatrix(values) {
  return values.map((value, i) => values.map((_, j) => (i === j ? value : 0)));
}

function rbfKernel(points, amp2, lengthscale) {
  return points.map((pi) =>
    points.map((pj) => {
      const dx = pi.x - pj.x;
      const dy = pi.y - pj.y;
      const dz = pi.z - pj.z;
      return amp2 * Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * lengthscale * lengthscale));
    })
  );
}

function paperFusion(run, anchorCenter, includeSelf = false) {
  const M = run.data.M;
  const precision = Array.from({ length: M }, () => Array(M).fill(0));
  const rhs = Array(M).fill(0);

  for (let i = 0; i < M; i++) {
    const v = Math.max(run.meanVar[i], EPS);
    const w = 1 / v;
    precision[i][i] += w;
    rhs[i] += w * anchorCenter[i];
    const weakPriorW = 1 / (400 * 400);
    precision[i][i] += weakPriorW;
    rhs[i] += weakPriorW * 70;
  }

  let usedConstraints = 0;
  let selfConstraints = 0;
  for (let k = 0; k < run.data.K; k++) {
    const i = run.data.i_k[k] - 1;
    const j = run.data.j_k[k] - 1;
    if (i === j) selfConstraints++;
    if (!includeSelf && i === j) continue;
    const alpha = run.data.alpha_k[k];
    const tau2 = Math.max(run.sampleVar[i] + alpha * alpha * run.sampleVar[j], EPS);
    const w = 1 / tau2;
    const b = run.data.b_k[k];
    precision[i][i] += w;
    precision[i][j] -= w * alpha;
    precision[j][i] -= w * alpha;
    precision[j][j] += w * alpha * alpha;
    rhs[i] += w * b;
    rhs[j] -= w * alpha * b;
    usedConstraints++;
  }

  const theta = solveLinearSystem(precision, rhs);
  const cov = invertMatrix(precision);
  return {
    theta,
    variances: cov.map((row, i) => Math.max(row[i], 0)),
    usedConstraints,
    selfConstraints,
  };
}

function residualSmoothing(run, prior, points, xy, lengthscaleCells, ampFactor) {
  const residual = run.direct.map((value, i) => value - prior[i]);
  const amp2 = Math.max(variance(residual), 1e-6) * ampFactor;
  const lengthscale = lengthscaleCells * xy;
  const K = rbfKernel(points, amp2, lengthscale);
  const A = addDiag(K, run.meanVar.map((value) => Math.max(value, EPS)));
  const AInv = invertMatrix(A);
  const S = matMul(K, AInv);
  const smoothedResidual = matVecMul(S, residual);
  const theta = prior.map((value, i) => value + smoothedResidual[i]);
  const noiseDiag = diagMatrix(run.meanVar);
  const estimatorCov = matMul(matMul(S, noiseDiag), transpose(S));
  const variances = estimatorCov.map((row, i) => Math.max(row[i], 0));
  const looResiduals = residual.map((value, i) => {
    const fitted = smoothedResidual[i];
    const denom = Math.max(1 - S[i][i], EPS);
    return (value - fitted) / denom;
  });
  return {
    theta,
    variances,
    lengthscale_cells: lengthscaleCells,
    amp_factor: ampFactor,
    effective_df: S.reduce((sum, row, i) => sum + row[i], 0),
    loo_weighted_mse: mean(looResiduals.map((value, i) => value * value / Math.max(run.meanVar[i], EPS))),
  };
}

function printMarkdown(rows) {
  console.log("| Case | Method | Avg abs error | Avg variance | Extra |");
  console.log("|---|---|---:|---:|---|");
  for (const row of rows) {
    const extra = row.lengthscale_cells
      ? `l=${row.lengthscale_cells}, amp=${row.amp_factor}`
      : (row.used_constraints !== undefined ? `K=${row.used_constraints}` : "");
    console.log(`| ${row.case} | ${row.method} | ${row.avg_abs_error.toFixed(4)} | ${row.avg_variance.toFixed(6)} | ${extra} |`);
  }
}

function main() {
  const summaryRows = [];
  const sweepRows = [];

  for (const spec of CASES) {
    const fastrw = readRun(spec.fastrwDir);
    const pirw = readRun(spec.pirwDir);
    const { prior, points, xy } = loadPriorAndPoints(spec.fastrwConfig);

    summaryRows.push(metrics(spec.label, "prior only", prior, fastrw.gt, Array(prior.length).fill(0)));
    summaryRows.push(metrics(spec.label, "PIRW direct", pirw.direct, pirw.gt, pirw.meanVar));
    summaryRows.push(metrics(spec.label, "FastRW direct", fastrw.direct, fastrw.gt, fastrw.meanVar));

    const paper = paperFusion(fastrw, fastrw.direct, false);
    summaryRows.push(metrics(spec.label, "FastRW + paper fusion", paper.theta, fastrw.gt, paper.variances, {
      used_constraints: paper.usedConstraints,
      self_constraints: paper.selfConstraints,
    }));

    const priorAnchor = paperFusion(fastrw, prior, false);
    summaryRows.push(metrics(spec.label, "FastRW + paper fusion + prior anchor", priorAnchor.theta, fastrw.gt, priorAnchor.variances, {
      used_constraints: priorAnchor.usedConstraints,
      self_constraints: priorAnchor.selfConstraints,
    }));

    for (const lengthscaleCells of LENGTHSCALE_CELLS) {
      for (const ampFactor of AMP_FACTORS) {
        const smooth = residualSmoothing(fastrw, prior, points, xy, lengthscaleCells, ampFactor);
        const row = metrics(spec.label, "FastRW + smoothing residual", smooth.theta, fastrw.gt, smooth.variances, {
          lengthscale_cells: smooth.lengthscale_cells,
          amp_factor: smooth.amp_factor,
          effective_df: smooth.effective_df,
          loo_weighted_mse: smooth.loo_weighted_mse,
        });
        sweepRows.push(row);
      }
    }

    const caseSweep = sweepRows.filter((row) => row.case === spec.label);
    const looSelected = caseSweep.slice().sort((a, b) => a.loo_weighted_mse - b.loo_weighted_mse)[0];
    summaryRows.push({ ...looSelected, method: "FastRW + smoothing residual (LOO selected)" });
    const bestMae = caseSweep.slice().sort((a, b) => a.avg_abs_error - b.avg_abs_error)[0];
    summaryRows.push({ ...bestMae, method: "FastRW + smoothing residual (best MAE oracle)" });
  }

  const summaryHeader = [
    "case", "method", "avg_abs_error", "avg_signed_error", "avg_variance",
    "used_constraints", "self_constraints", "lengthscale_cells", "amp_factor",
    "effective_df", "loo_weighted_mse",
  ];
  const sweepHeader = [
    "case", "method", "lengthscale_cells", "amp_factor", "effective_df",
    "loo_weighted_mse", "avg_abs_error", "avg_signed_error", "avg_variance",
  ];
  writeCsv(path.join(OUT_DIR, "summary.csv"), summaryRows, summaryHeader);
  writeCsv(path.join(OUT_DIR, "k_space_ablation.csv"), sweepRows, sweepHeader);
  printMarkdown(summaryRows);
  console.log(`\nWrote ${path.relative(ROOT, path.join(OUT_DIR, "summary.csv"))}`);
  console.log(`Wrote ${path.relative(ROOT, path.join(OUT_DIR, "k_space_ablation.csv"))}`);
}

main();
