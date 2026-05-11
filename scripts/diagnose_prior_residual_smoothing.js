#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.join(ROOT, "outputs", "fusion_diagnostics");

const DEFAULT_RUNS = [
  ["Case 1", "outputs/fusion_diagnostics/case1_fastrw_schema2_full", "configs/case1_power6.json"],
  ["Case 2", "outputs/fusion_diagnostics/case2_fastrw_schema2_full", "configs/case2_4core_top1_bottom1.json"],
  ["Case 3", "outputs/fusion_diagnostics/case3_fastrw_schema2_full", "configs/case3_16core.json"],
];

const LENGTHSCALE_CELLS = [1, 2, 4, 8, 12, 20, 40];
const AMP_FACTORS = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10];
const BOOTSTRAP_REPS = 500;
const EPS = 1e-12;

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
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => formatCsvValue(row[key])).join(","));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function formatCsvValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
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

function loadPriorAndPoints(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const g = config.geometry;
  const xy = g.xy_resolution;
  const zres = g.z_resolution;
  const nx = Math.round(g.x_size / xy);
  const ny = Math.round(g.y_size / xy);
  const nzBottom = Math.round((g.bottom_thickness - zres) / zres);
  const zHeatFirst = nzBottom + 1;
  const temperatureOffset = config.data.temperature_offset || 0;
  const tempPath = resolvePath(configPath, config.data.prior_temperature_path);
  const buf = fs.readFileSync(tempPath);

  function tempAt(z, y, x) {
    const iz = Math.floor(z / zres) - zHeatFirst;
    const iy = Math.floor(y / xy);
    const ix = Math.floor(x / xy);
    return buf.readDoubleLE(((iz * ny + iy) * nx + ix) * 8) + temperatureOffset;
  }

  const q = config.query_grid;
  const z = (q.z ?? (g.bottom_thickness + 0.5 * g.middle_thickness)) + (q.z_offset || 0);
  const points = [];
  const prior = [];
  for (const iy of q.y_indices) {
    for (const ix of q.x_indices) {
      const y = iy * xy + (q.y_offset || 0);
      const x = ix * xy + (q.x_offset || 0);
      points.push({ z, y, x });
      prior.push(tempAt(z, y, x));
    }
  }
  return { prior, points, xy };
}

function loadRun(label, runDir, configPath) {
  const absRunDir = path.resolve(ROOT, runDir);
  const absConfig = path.resolve(ROOT, configPath);
  const rows = readCsv(path.join(absRunDir, "direct.csv"));
  const data = JSON.parse(fs.readFileSync(path.join(absRunDir, "constraints.json"), "utf8"));
  const { prior, points, xy } = loadPriorAndPoints(absConfig);
  const direct = Array.from({ length: data.M }, (_, i) => mean(data.obs_data.map((sample) => sample[i])));
  const noiseVar = Array.from({ length: data.M }, (_, i) =>
    variance(data.obs_data.map((sample) => sample[i])) / data.N
  );
  return { label, runDir: absRunDir, rows, data, prior, points, xy, direct, noiseVar };
}

function identity(n) {
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))
  );
}

function invertMatrix(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => row.concat(identity(n)[i]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-14) {
      throw new Error(`Singular matrix at column ${col}`);
    }
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];
    const div = a[col][col];
    for (let c = 0; c < 2 * n; c++) a[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let c = 0; c < 2 * n; c++) a[r][c] -= factor * a[col][c];
    }
  }
  return a.map((row) => row.slice(n));
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

function rbfKernel(points, amp2, lengthscale) {
  const n = points.length;
  return Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => {
      const dx = points[i].x - points[j].x;
      const dy = points[i].y - points[j].y;
      const dz = points[i].z - points[j].z;
      return amp2 * Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * lengthscale * lengthscale));
    })
  );
}

function diagMatrix(values) {
  return values.map((value, i) =>
    values.map((_, j) => (i === j ? value : 0))
  );
}

function addDiag(matrix, values) {
  return matrix.map((row, i) => row.map((value, j) => value + (i === j ? values[i] : 0)));
}

function evaluateSmoother(run, lengthscaleCells, ampFactor, directOverride = null) {
  const direct = directOverride || run.direct;
  const residual = direct.map((value, i) => value - run.prior[i]);
  const residualVar = Math.max(variance(residual), 1e-6);
  const amp2 = residualVar * ampFactor;
  const lengthscale = lengthscaleCells * run.xy;
  const K = rbfKernel(run.points, amp2, lengthscale);
  const A = addDiag(K, run.noiseVar.map((value) => Math.max(value, EPS)));
  const AInv = invertMatrix(A);
  const S = matMul(K, AInv);
  const smoothedResidual = matVecMul(S, residual);
  const theta = smoothedResidual.map((value, i) => run.prior[i] + value);
  const noiseDiag = diagMatrix(run.noiseVar);
  const estimatorCov = matMul(matMul(S, noiseDiag), transpose(S));
  const estVar = estimatorCov.map((row, i) => Math.max(row[i], 0));
  const looResiduals = residual.map((value, i) => {
    const fitted = smoothedResidual[i];
    const denom = Math.max(1 - S[i][i], EPS);
    return (value - fitted) / denom;
  });
  return {
    theta,
    estVar,
    effective_df: S.reduce((sum, row, i) => sum + row[i], 0),
    loo_mse: mean(looResiduals.map((value) => value * value)),
    loo_weighted_mse: mean(looResiduals.map((value, i) => value * value / Math.max(run.noiseVar[i], EPS))),
    lengthscale_cells: lengthscaleCells,
    amp_factor: ampFactor,
  };
}

function metrics(run, theta, estVar) {
  const errors = theta.map((value, i) => value - run.rows[i].GT_Temperature);
  return {
    mae: mean(errors.map(Math.abs)),
    signed_error: mean(errors),
    avg_variance: mean(estVar),
    avg_se: mean(estVar.map(Math.sqrt)),
    max_abs_error: Math.max(...errors.map(Math.abs)),
  };
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapSelected(run, selected, reps = BOOTSTRAP_REPS) {
  const rand = mulberry32(42);
  const M = run.data.M;
  const estimates = Array.from({ length: M }, () => []);
  for (let b = 0; b < reps; b++) {
    const direct = [];
    for (let i = 0; i < M; i++) {
      let sum = 0;
      for (let n = 0; n < run.data.N; n++) {
        const sample = Math.floor(rand() * run.data.N);
        sum += run.data.obs_data[sample][i];
      }
      direct[i] = sum / run.data.N;
    }
    const smooth = evaluateSmoother(run, selected.lengthscale_cells, selected.amp_factor, direct);
    for (let i = 0; i < M; i++) estimates[i].push(smooth.theta[i]);
  }
  const bootVars = estimates.map(variance);
  return {
    bootstrap_avg_variance: mean(bootVars),
    bootstrap_avg_se: mean(bootVars.map(Math.sqrt)),
  };
}

function evaluateRun(run) {
  const rows = [];
  const directMetrics = metrics(run, run.direct, run.noiseVar);
  rows.push({
    case: run.label,
    method: "FastRW direct baseline",
    lengthscale_cells: "",
    amp_factor: "",
    effective_df: "",
    loo_mse: "",
    loo_weighted_mse: "",
    ...directMetrics,
  });

  const priorMetrics = metrics(run, run.prior, Array(run.data.M).fill(0));
  rows.push({
    case: run.label,
    method: "prior only",
    lengthscale_cells: "",
    amp_factor: "",
    effective_df: 0,
    loo_mse: mean(run.direct.map((value, i) => (value - run.prior[i]) ** 2)),
    loo_weighted_mse: mean(run.direct.map((value, i) => (value - run.prior[i]) ** 2 / Math.max(run.noiseVar[i], EPS))),
    ...priorMetrics,
  });

  const sweep = [];
  for (const lengthscaleCells of LENGTHSCALE_CELLS) {
    for (const ampFactor of AMP_FACTORS) {
      const result = evaluateSmoother(run, lengthscaleCells, ampFactor);
      sweep.push({
        case: run.label,
        method: "prior residual smoothing",
        ...result,
        ...metrics(run, result.theta, result.estVar),
      });
    }
  }
  rows.push(...sweep);

  const bestMae = sweep.slice().sort((a, b) => a.mae - b.mae)[0];
  const bestLoo = sweep.slice().sort((a, b) => a.loo_weighted_mse - b.loo_weighted_mse)[0];
  const selected = [];
  for (const row of [rows[0], rows[1], bestMae, bestLoo]) {
    const key = `${row.method}/${row.lengthscale_cells}/${row.amp_factor}`;
    if (!selected.some((item) => `${item.method}/${item.lengthscale_cells}/${item.amp_factor}` === key)) {
      selected.push(row);
    }
  }

  return { rows, selected };
}

function parseRuns(args) {
  if (!args.length) return DEFAULT_RUNS;
  return args.map((arg) => {
    const [label, runDir, configPath] = arg.split("=");
    if (!label || !runDir || !configPath) {
      throw new Error("Arguments must be label=run_dir=config_path");
    }
    return [label, runDir, configPath];
  });
}

function main() {
  const runs = parseRuns(process.argv.slice(2)).map((spec) => loadRun(...spec));
  const sweepRows = [];
  const summaryRows = [];
  for (const run of runs) {
    const { rows, selected } = evaluateRun(run);
    sweepRows.push(...rows);
    for (const row of selected) {
      const boot = row.method === "prior residual smoothing"
        ? bootstrapSelected(run, row)
        : { bootstrap_avg_variance: row.avg_variance, bootstrap_avg_se: row.avg_se };
      summaryRows.push({
        case: run.label,
        method: row.method === "prior residual smoothing" && row === selected[2]
          ? "best MAE residual smoothing"
          : (row.method === "prior residual smoothing" ? "LOO residual smoothing" : row.method),
        lengthscale_cells: row.lengthscale_cells,
        amp_factor: row.amp_factor,
        effective_df: row.effective_df,
        mae: row.mae,
        signed_error: row.signed_error,
        avg_variance: row.avg_variance,
        avg_se: row.avg_se,
        bootstrap_avg_variance: boot.bootstrap_avg_variance,
        bootstrap_avg_se: boot.bootstrap_avg_se,
        loo_weighted_mse: row.loo_weighted_mse,
      });
    }
  }

  writeCsv(path.join(OUT_DIR, "prior_residual_smoothing_sweep.csv"), sweepRows, [
    "case", "method", "lengthscale_cells", "amp_factor", "effective_df",
    "loo_mse", "loo_weighted_mse", "mae", "signed_error",
    "avg_variance", "avg_se", "max_abs_error",
  ]);
  writeCsv(path.join(OUT_DIR, "prior_residual_smoothing_summary.csv"), summaryRows, [
    "case", "method", "lengthscale_cells", "amp_factor", "effective_df",
    "mae", "signed_error", "avg_variance", "avg_se",
    "bootstrap_avg_variance", "bootstrap_avg_se", "loo_weighted_mse",
  ]);

  console.log("| Case | Method | MAE | Avg variance | Avg SE | Bootstrap Avg variance | Bootstrap Avg SE |");
  console.log("|---|---|---:|---:|---:|---:|---:|");
  for (const row of summaryRows) {
    console.log(`| ${row.case} | ${row.method} | ${row.mae.toFixed(4)} | ${row.avg_variance.toFixed(6)} | ${row.avg_se.toFixed(4)} | ${row.bootstrap_avg_variance.toFixed(6)} | ${row.bootstrap_avg_se.toFixed(4)} |`);
  }
  console.log(`\nWrote ${path.relative(ROOT, path.join(OUT_DIR, "prior_residual_smoothing_summary.csv"))}`);
  console.log(`Wrote ${path.relative(ROOT, path.join(OUT_DIR, "prior_residual_smoothing_sweep.csv"))}`);
}

main();
