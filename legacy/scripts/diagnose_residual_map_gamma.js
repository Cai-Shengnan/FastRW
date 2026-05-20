#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SWEEP_DIR = path.join(ROOT, "outputs", "fusion_diagnostics", "comsol_prior_sweep");
const CONFIG_ROOT = path.join(SWEEP_DIR, "configs");
const OUT_DIR = path.join(ROOT, "outputs", "fusion_diagnostics", "residual_map_gamma");
const EPS = 1e-12;
const LENGTHSCALE_CELLS = 40;
const GAMMAS = [1, 5, 10, 50];

function readCsv(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines.shift());
  return lines.map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < header.length; i++) {
      const value = values[i] ?? "";
      row[header[i]] = value === "" ? "" : Number(value);
    }
    return row;
  });
}

function parseCsvLine(line) {
  const out = [];
  let value = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        value += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(value);
      value = "";
    } else {
      value += ch;
    }
  }
  out.push(value);
  return out;
}

function writeCsv(file, rows, header) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [header.join(",")];
  for (const row of rows) lines.push(header.map((key) => formatCsv(row[key])).join(","));
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
    if (Math.abs(a[pivot][col]) < EPS) {
      throw new Error("Singular matrix");
    }
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

function matVecMul(matrix, vector) {
  return matrix.map((row) => row.reduce((sum, value, j) => sum + value * vector[j], 0));
}

function addToPrecision(precision, rhs, i, j, alpha, value, weight) {
  precision[i][i] += weight;
  precision[i][j] -= weight * alpha;
  precision[j][i] -= weight * alpha;
  precision[j][j] += weight * alpha * alpha;
  rhs[i] += weight * value;
  rhs[j] -= weight * alpha * value;
}

function discoverConfigs() {
  const out = [];
  for (const caseId of fs.readdirSync(CONFIG_ROOT).sort()) {
    const caseDir = path.join(CONFIG_ROOT, caseId);
    if (!fs.statSync(caseDir).isDirectory()) continue;
    for (const name of fs.readdirSync(caseDir).sort()) {
      if (!name.endsWith("_fastrw.json")) continue;
      const priorName = name.replace(/_fastrw\.json$/, "");
      out.push({ caseId, priorName, configPath: path.join(caseDir, name) });
    }
  }
  return out;
}

function readRun(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const runDir = config.output.directory;
  const directRows = readCsv(path.join(runDir, "direct.csv"));
  const data = JSON.parse(fs.readFileSync(path.join(runDir, "constraints.json"), "utf8"));
  const sampleVar = Array.from({ length: data.M }, (_, i) =>
    variance(data.obs_data.map((row) => row[i]))
  );
  return {
    config,
    runDir,
    data,
    rows: directRows,
    gt: directRows.map((row) => row.GT_Temperature),
    direct: directRows.map((row) => row.Direct_Mean ?? row.Normal_Mean),
    sampleVar,
    meanVar: sampleVar.map((value) => value / data.N),
  };
}

function loadPriorAndPoints(config) {
  const g = config.geometry;
  const q = config.query_grid;
  const xy = g.xy_resolution;
  const zres = g.z_resolution;
  const nx = Math.round(g.x_size / xy);
  const ny = Math.round(g.y_size / xy);
  const nzBottom = Math.round((g.bottom_thickness - zres) / zres);
  const zHeatFirst = nzBottom + 1;
  const z = (q.z ?? (g.bottom_thickness + 0.5 * g.middle_thickness)) + (q.z_offset || 0);
  const buf = fs.readFileSync(config.data.prior_temperature_path);
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

function rbfKernel(points, amp2, lengthscale) {
  return points.map((pi, i) =>
    points.map((pj, j) => {
      const dx = pi.x - pj.x;
      const dy = pi.y - pj.y;
      const dz = pi.z - pj.z;
      const value = amp2 * Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * lengthscale * lengthscale));
      return i === j ? value + Math.max(amp2, 1) * 1e-9 : value;
    })
  );
}

function residualMap(run, prior, points, xy, gamma, includeSelf = false) {
  const M = run.data.M;
  const directResidual = run.direct.map((value, i) => value - prior[i]);
  const amp2 = Math.max(variance(directResidual), 1e-6);
  const K = rbfKernel(points, amp2, LENGTHSCALE_CELLS * xy);
  const KInv = invertMatrix(K);
  const precision = KInv.map((row) => row.slice());
  const rhs = Array(M).fill(0);

  for (let i = 0; i < M; i++) {
    const w = 1 / Math.max(run.meanVar[i], EPS);
    precision[i][i] += w;
    rhs[i] += w * directResidual[i];
  }

  let usedConstraints = 0;
  let selfConstraints = 0;
  for (let k = 0; k < run.data.K; k++) {
    const i = run.data.i_k[k] - 1;
    const j = run.data.j_k[k] - 1;
    if (i === j) selfConstraints++;
    if (!includeSelf && i === j) continue;
    const alpha = run.data.alpha_k[k];
    const observedResidual = run.data.b_k[k] - (prior[i] - alpha * prior[j]);
    const tau2 = Math.max(gamma * (run.sampleVar[i] + alpha * alpha * run.sampleVar[j]), EPS);
    addToPrecision(precision, rhs, i, j, alpha, observedResidual, 1 / tau2);
    usedConstraints++;
  }

  const cov = invertMatrix(precision);
  const rHat = matVecMul(cov, rhs);
  return {
    theta: prior.map((value, i) => value + rHat[i]),
    variances: cov.map((row, i) => Math.max(row[i], 0)),
    usedConstraints,
    selfConstraints,
    kernel_amp2: amp2,
  };
}

function metrics(caseId, priorName, method, theta, gt, variances, extras = {}) {
  const errors = theta.map((value, i) => value - gt[i]);
  return {
    case: caseId,
    prior_name: priorName,
    method,
    avg_abs_error: mean(errors.map(Math.abs)),
    avg_signed_error: mean(errors),
    avg_variance: variances ? mean(variances) : 0,
    ...extras,
  };
}

function main() {
  const rows = [];
  for (const spec of discoverConfigs()) {
    const run = readRun(spec.configPath);
    const { prior, points, xy } = loadPriorAndPoints(run.config);
    for (const gamma of GAMMAS) {
      const fit = residualMap(run, prior, points, xy, gamma, false);
      rows.push(metrics(
        spec.caseId,
        spec.priorName,
        "FastRW + residual MAP + path constraints",
        fit.theta,
        run.gt,
        fit.variances,
        {
          gamma,
          lengthscale_cells: LENGTHSCALE_CELLS,
          kernel_amp2: fit.kernel_amp2,
          used_constraints: fit.usedConstraints,
          self_constraints: fit.selfConstraints,
          run_dir: run.runDir,
          config_path: spec.configPath,
        }
      ));
    }
  }

  const header = [
    "case", "prior_name", "method", "gamma", "lengthscale_cells", "kernel_amp2",
    "avg_abs_error", "avg_signed_error", "avg_variance",
    "used_constraints", "self_constraints", "run_dir", "config_path",
  ];
  writeCsv(path.join(OUT_DIR, "residual_map_gamma.csv"), rows, header);

  const bestRows = [];
  for (const caseId of [...new Set(rows.map((row) => row.case))]) {
    const caseRows = rows.filter((row) => row.case === caseId);
    const bestOverall = caseRows.slice().sort((a, b) => a.avg_abs_error - b.avg_abs_error)[0];
    bestRows.push({ selection: "best_overall", ...bestOverall });
    for (const gamma of GAMMAS) {
      const bestGamma = caseRows
        .filter((row) => row.gamma === gamma)
        .sort((a, b) => a.avg_abs_error - b.avg_abs_error)[0];
      bestRows.push({ selection: `best_gamma_${gamma}`, ...bestGamma });
    }
  }
  writeCsv(path.join(OUT_DIR, "residual_map_gamma_best.csv"), bestRows, ["selection", ...header]);

  console.log("| Case | Selection | Prior | Gamma | MAE | Avg variance |");
  console.log("|---|---|---|---:|---:|---:|");
  for (const row of bestRows) {
    console.log(`| ${row.case} | ${row.selection} | ${row.prior_name} | ${row.gamma} | ${row.avg_abs_error.toFixed(4)} | ${row.avg_variance.toFixed(6)} |`);
  }
  console.log(`\nWrote ${path.relative(ROOT, path.join(OUT_DIR, "residual_map_gamma.csv"))}`);
  console.log(`Wrote ${path.relative(ROOT, path.join(OUT_DIR, "residual_map_gamma_best.csv"))}`);
}

main();
