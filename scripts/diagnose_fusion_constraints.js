#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUTPUTS_DIR = path.join(ROOT, "outputs");
const DIAG_DIR = path.join(OUTPUTS_DIR, "fusion_diagnostics");
const EPS = 1e-12;

const CONSTRAINT_SCALES = [0, 1e-4, 3e-4, 1e-3, 3e-3, 1e-2, 3e-2, 0.1, 0.3, 1];
const ALPHA_MAX_VALUES = [1, 0.8, 0.5, 0.3, 0.1, 0.03];
const ALPHA_BINS = [0, 0.03, 0.1, 0.3, 0.5, 0.8, 1, Infinity];

function readCsv(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(",");
  return lines.map((line) => {
    const values = line.split(",");
    const row = {};
    for (let i = 0; i < header.length; i++) {
      const value = values[i];
      row[header[i]] = value === undefined || value === "" ? value : Number(value);
    }
    return row;
  });
}

function writeCsv(file, rows, header) {
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => formatCsvValue(row[key])).join(","));
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function formatCsvValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

function std(values) {
  return Math.sqrt(variance(values));
}

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  const weight = pos - lo;
  return sorted[lo] * (1 - weight) + sorted[hi] * weight;
}

function summarizeValues(values) {
  if (!values.length) {
    return {
      count: 0,
      mean: null,
      sd: null,
      mae: null,
      rmse: null,
      q05: null,
      q50: null,
      q95: null,
      abs95: null,
      min: null,
      max: null,
    };
  }
  const abs = values.map(Math.abs);
  return {
    count: values.length,
    mean: mean(values),
    sd: std(values),
    mae: mean(abs),
    rmse: Math.sqrt(mean(values.map((v) => v * v))),
    q05: quantile(values, 0.05),
    q50: quantile(values, 0.5),
    q95: quantile(values, 0.95),
    abs95: quantile(abs, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function normalizeDirectRow(row) {
  return {
    Point: row.Point,
    X: row.X,
    Y: row.Y,
    Z: row.Z,
    Direct_Mean: row.Direct_Mean ?? row.Normal_Mean,
    GT_Temperature: row.GT_Temperature,
    Direct_Error: row.Direct_Error ?? row.Error,
    Avg_Steps: row.Avg_Steps,
  };
}

function summarizeEstimate(rows, theta) {
  const errors = rows.map((raw, i) => theta[i] - normalizeDirectRow(raw).GT_Temperature);
  const abs = errors.map(Math.abs);
  return {
    avg_signed_error: mean(errors),
    avg_abs_error: mean(abs),
    rmse_error: Math.sqrt(mean(errors.map((e) => e * e))),
    max_abs_error: Math.max(...abs),
  };
}

function solveLinearSystem(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((row, i) => row.concat(rhs[i]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < 1e-14) {
      throw new Error(`Singular fusion system at column ${col}`);
    }
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

function computeSigma(data) {
  return Array.from({ length: data.M }, (_, i) => {
    const samples = data.obs_data.map((row) => row[i]);
    return Math.sqrt(Math.max(variance(samples), EPS));
  });
}

function computeFusion(data, options = {}) {
  const {
    includeSelf = true,
    alphaMin = 0,
    alphaMax = Infinity,
    constraintScale = 1,
  } = options;
  const M = data.M;
  const N = data.N;
  const sigma = computeSigma(data);
  const precision = Array.from({ length: M }, () => Array(M).fill(0));
  const rhs = Array(M).fill(0);

  for (let i = 0; i < M; i++) {
    const w = 1 / Math.max(sigma[i] * sigma[i], EPS);
    for (let n = 0; n < N; n++) {
      precision[i][i] += w;
      rhs[i] += w * data.obs_data[n][i];
    }
    const priorW = 1 / (400 * 400);
    precision[i][i] += priorW;
    rhs[i] += priorW * 70;
  }

  let usedConstraints = 0;
  let selfConstraints = 0;
  for (let k = 0; k < data.K; k++) {
    const i = data.i_k[k] - 1;
    const j = data.j_k[k] - 1;
    const alpha = data.alpha_k[k];
    if (i === j) selfConstraints++;
    if (!includeSelf && i === j) continue;
    if (alpha < alphaMin || alpha > alphaMax) continue;
    if (constraintScale === 0) continue;

    const tau2 = Math.max(sigma[i] * sigma[i] + alpha * alpha * sigma[j] * sigma[j], EPS);
    const w = constraintScale / tau2;
    const b = data.b_k[k];
    precision[i][i] += w;
    precision[i][j] -= w * alpha;
    precision[j][i] -= w * alpha;
    precision[j][j] += w * alpha * alpha;
    rhs[i] += w * b;
    rhs[j] -= w * alpha * b;
    usedConstraints++;
  }

  return {
    theta: solveLinearSystem(precision, rhs),
    sigma,
    usedConstraints,
    selfConstraints,
  };
}

function discoverRuns() {
  const runs = [];
  if (!fs.existsSync(OUTPUTS_DIR)) return runs;
  for (const caseName of fs.readdirSync(OUTPUTS_DIR)) {
    if (caseName === "fusion_diagnostics") continue;
    const caseDir = path.join(OUTPUTS_DIR, caseName);
    if (!fs.statSync(caseDir).isDirectory()) continue;
    for (const method of fs.readdirSync(caseDir)) {
      const runDir = path.join(caseDir, method);
      if (!fs.statSync(runDir).isDirectory()) continue;
      const constraintsPath = path.join(runDir, "constraints.json");
      const directPath = path.join(runDir, "direct.csv");
      if (fs.existsSync(constraintsPath) && fs.existsSync(directPath)) {
        runs.push({ caseName, method, runDir, constraintsPath, directPath });
      }
    }
  }
  return runs.sort((a, b) => `${a.caseName}/${a.method}`.localeCompare(`${b.caseName}/${b.method}`));
}

function alphaBinLabel(alpha) {
  for (let i = 0; i < ALPHA_BINS.length - 1; i++) {
    const lo = ALPHA_BINS[i];
    const hi = ALPHA_BINS[i + 1];
    if (alpha >= lo && alpha < hi) {
      return hi === Infinity ? `[${lo},inf)` : `[${lo},${hi})`;
    }
  }
  return "out_of_range";
}

function addToBucket(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function computeResidualRows(run, data, directRows) {
  const allResiduals = [];
  const byBucket = new Map();
  const pairMap = new Map();
  const alphaValues = [];
  const bValues = [];
  const tauValues = [];
  const sigma = computeSigma(data);

  for (let k = 0; k < data.K; k++) {
    const i = data.i_k[k] - 1;
    const j = data.j_k[k] - 1;
    const alpha = data.alpha_k[k];
    const b = data.b_k[k];
    const gtI = normalizeDirectRow(directRows[i]).GT_Temperature;
    const gtJ = normalizeDirectRow(directRows[j]).GT_Temperature;
    const residual = b - (gtI - alpha * gtJ);
    const tau = Math.sqrt(Math.max(sigma[i] * sigma[i] + alpha * alpha * sigma[j] * sigma[j], EPS));

    allResiduals.push(residual);
    alphaValues.push(alpha);
    bValues.push(b);
    tauValues.push(tau);
    addToBucket(byBucket, "all", residual);
    addToBucket(byBucket, i === j ? "self" : "cross", residual);
    addToBucket(byBucket, `alpha${alphaBinLabel(alpha)}`, residual);

    const pairKey = `${i + 1}:${j + 1}`;
    if (!pairMap.has(pairKey)) {
      pairMap.set(pairKey, { i: i + 1, j: j + 1, residuals: [], alpha: [], b: [], tau: [] });
    }
    const pair = pairMap.get(pairKey);
    pair.residuals.push(residual);
    pair.alpha.push(alpha);
    pair.b.push(b);
    pair.tau.push(tau);
  }

  const residualRows = [];
  for (const [bucket, values] of byBucket.entries()) {
    const s = summarizeValues(values);
    residualRows.push({
      case: run.caseName,
      method: run.method,
      bucket,
      count: s.count,
      residual_mean: s.mean,
      residual_sd: s.sd,
      residual_mae: s.mae,
      residual_rmse: s.rmse,
      residual_q05: s.q05,
      residual_q50: s.q50,
      residual_q95: s.q95,
      residual_abs95: s.abs95,
      alpha_mean: bucket === "all" ? mean(alphaValues) : null,
      alpha_q50: bucket === "all" ? quantile(alphaValues, 0.5) : null,
      alpha_q95: bucket === "all" ? quantile(alphaValues, 0.95) : null,
      b_mean: bucket === "all" ? mean(bValues) : null,
      tau_mean: bucket === "all" ? mean(tauValues) : null,
    });
  }

  const pairRows = Array.from(pairMap.values()).map((pair) => {
    const s = summarizeValues(pair.residuals);
    return {
      case: run.caseName,
      method: run.method,
      i: pair.i,
      j: pair.j,
      count: s.count,
      residual_mean: s.mean,
      residual_sd: s.sd,
      residual_mae: s.mae,
      residual_rmse: s.rmse,
      residual_abs95: s.abs95,
      alpha_mean: mean(pair.alpha),
      alpha_q50: quantile(pair.alpha, 0.5),
      b_mean: mean(pair.b),
      tau_mean: mean(pair.tau),
    };
  }).sort((a, b) => {
    const byCount = b.count - a.count;
    if (byCount !== 0) return byCount;
    return Math.abs(b.residual_mean) - Math.abs(a.residual_mean);
  });

  return { residualRows, pairRows, allResiduals, alphaValues, tauValues };
}

function sweepFusion(run, data, directRows) {
  const directTheta = directRows.map((row) => normalizeDirectRow(row).Direct_Mean);
  const directSummary = summarizeEstimate(directRows, directTheta);
  const rows = [{
    case: run.caseName,
    method: run.method,
    include_self: "",
    alpha_min: 0,
    alpha_max: 0,
    constraint_scale: 0,
    used_constraints: 0,
    avg_abs_error: directSummary.avg_abs_error,
    rmse_error: directSummary.rmse_error,
    max_abs_error: directSummary.max_abs_error,
    avg_signed_error: directSummary.avg_signed_error,
    label: "direct",
  }];

  for (const includeSelf of [true, false]) {
    for (const alphaMax of ALPHA_MAX_VALUES) {
      for (const constraintScale of CONSTRAINT_SCALES) {
        if (constraintScale === 0 && (includeSelf === false || alphaMax !== 1)) continue;
        const fusion = computeFusion(data, { includeSelf, alphaMax, constraintScale });
        const s = summarizeEstimate(directRows, fusion.theta);
        rows.push({
          case: run.caseName,
          method: run.method,
          include_self: includeSelf,
          alpha_min: 0,
          alpha_max: alphaMax,
          constraint_scale: constraintScale,
          used_constraints: fusion.usedConstraints,
          avg_abs_error: s.avg_abs_error,
          rmse_error: s.rmse_error,
          max_abs_error: s.max_abs_error,
          avg_signed_error: s.avg_signed_error,
          label: includeSelf ? "with_self" : "no_self",
        });
      }
    }
  }
  return rows;
}

function readRun(run) {
  const data = JSON.parse(fs.readFileSync(run.constraintsPath, "utf8"));
  const directRows = readCsv(run.directPath);
  if (directRows.length !== data.M) {
    throw new Error(`${run.runDir}: direct rows ${directRows.length} != M ${data.M}`);
  }
  return { data, directRows };
}

function bestRowsForRun(rows) {
  const byRun = new Map();
  for (const row of rows) {
    const key = `${row.case}/${row.method}`;
    if (!byRun.has(key)) byRun.set(key, []);
    byRun.get(key).push(row);
  }
  return Array.from(byRun.entries()).map(([key, runRows]) => {
    const nonZero = runRows.filter((row) =>
      row.label !== "direct" &&
      Number(row.constraint_scale) > 0 &&
      Number(row.used_constraints) > 0
    );
    const best = nonZero.slice().sort((a, b) => a.avg_abs_error - b.avg_abs_error)[0];
    const direct = runRows.find((row) => row.label === "direct");
    return { key, direct, best };
  });
}

function writeMarkdown(summaryRows, residualRows, sweepRows) {
  const lines = [];
  lines.push("# Fusion Diagnostics");
  lines.push("");
  lines.push("This report checks the pass-through constraints against the reference temperatures and sweeps conservative WLS weights.");
  lines.push("");
  lines.push("## Run Summary");
  lines.push("");
  lines.push("| Case | Method | K | Self | Direct MAE | Current With-Self MAE | Current No-Self MAE | Residual MAE | Residual Mean | Residual Abs95 |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const row of summaryRows) {
    lines.push(`| ${row.case} | ${row.method} | ${row.K} | ${row.self_constraints} | ${fmt(row.direct_avg_abs_error)} | ${fmt(row.current_with_self_avg_abs_error)} | ${fmt(row.current_no_self_avg_abs_error)} | ${fmt(row.residual_mae)} | ${fmt(row.residual_mean)} | ${fmt(row.residual_abs95)} |`);
  }
  lines.push("");
  lines.push("## Best Nonzero Weight Sweep Per Run");
  lines.push("");
  lines.push("| Run | Direct MAE | Best Fused MAE | Include Self | Alpha Max | Constraint Scale | Used Constraints |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const { key, direct, best } of bestRowsForRun(sweepRows)) {
    lines.push(`| ${key} | ${fmt(direct.avg_abs_error)} | ${fmt(best.avg_abs_error)} | ${best.include_self} | ${best.alpha_max} | ${best.constraint_scale} | ${best.used_constraints} |`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("- `residual = b_k - (T_ref[i_k] - alpha_k * T_ref[j_k])`.");
  lines.push("- `constraint_scale = 1` matches the current Onestage WLS implementation.");
  lines.push("- This diagnostic uses reference temperatures only to evaluate variants; production fusion cannot use these labels.");
  fs.writeFileSync(path.join(DIAG_DIR, "diagnostics.md"), `${lines.join("\n")}\n`);
}

function fmt(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "";
  return Number(value).toFixed(4);
}

function main() {
  fs.mkdirSync(DIAG_DIR, { recursive: true });
  const runs = discoverRuns();
  if (!runs.length) {
    throw new Error(`No runs found under ${OUTPUTS_DIR}`);
  }

  const summaryRows = [];
  const residualRows = [];
  const pairRows = [];
  const sweepRows = [];

  for (const run of runs) {
    const { data, directRows } = readRun(run);
    const residual = computeResidualRows(run, data, directRows);
    residualRows.push(...residual.residualRows);
    pairRows.push(...residual.pairRows);
    sweepRows.push(...sweepFusion(run, data, directRows));

    const all = residual.residualRows.find((row) => row.bucket === "all");
    const summaryPath = path.join(run.runDir, "summary.json");
    const current = fs.existsSync(summaryPath) ? JSON.parse(fs.readFileSync(summaryPath, "utf8")) : null;
    const directTheta = directRows.map((row) => normalizeDirectRow(row).Direct_Mean);
    const directSummary = summarizeEstimate(directRows, directTheta);
    summaryRows.push({
      case: run.caseName,
      method: run.method,
      M: data.M,
      N: data.N,
      K: data.K,
      self_constraints: data.self_constraints ?? data.i_k.filter((v, i) => v === data.j_k[i]).length,
      pass_overflow_paths: data.pass_overflow_paths ?? 0,
      direct_avg_abs_error: directSummary.avg_abs_error,
      current_with_self_avg_abs_error: current?.onestage_with_self?.avg_abs_error ?? null,
      current_no_self_avg_abs_error: current?.onestage_no_self?.avg_abs_error ?? null,
      residual_mean: all.residual_mean,
      residual_sd: all.residual_sd,
      residual_mae: all.residual_mae,
      residual_rmse: all.residual_rmse,
      residual_abs95: all.residual_abs95,
      alpha_mean: all.alpha_mean,
      alpha_q50: all.alpha_q50,
      alpha_q95: all.alpha_q95,
      tau_mean: all.tau_mean,
    });
  }

  writeCsv(path.join(DIAG_DIR, "summary.csv"), summaryRows, [
    "case", "method", "M", "N", "K", "self_constraints", "pass_overflow_paths",
    "direct_avg_abs_error", "current_with_self_avg_abs_error", "current_no_self_avg_abs_error",
    "residual_mean", "residual_sd", "residual_mae", "residual_rmse", "residual_abs95",
    "alpha_mean", "alpha_q50", "alpha_q95", "tau_mean",
  ]);
  writeCsv(path.join(DIAG_DIR, "residual_bins.csv"), residualRows, [
    "case", "method", "bucket", "count", "residual_mean", "residual_sd", "residual_mae",
    "residual_rmse", "residual_q05", "residual_q50", "residual_q95", "residual_abs95",
    "alpha_mean", "alpha_q50", "alpha_q95", "b_mean", "tau_mean",
  ]);
  writeCsv(path.join(DIAG_DIR, "pair_stats.csv"), pairRows, [
    "case", "method", "i", "j", "count", "residual_mean", "residual_sd", "residual_mae",
    "residual_rmse", "residual_abs95", "alpha_mean", "alpha_q50", "b_mean", "tau_mean",
  ]);
  writeCsv(path.join(DIAG_DIR, "weight_sweep.csv"), sweepRows, [
    "case", "method", "label", "include_self", "alpha_min", "alpha_max", "constraint_scale",
    "used_constraints", "avg_abs_error", "rmse_error", "max_abs_error", "avg_signed_error",
  ]);
  writeMarkdown(summaryRows, residualRows, sweepRows);

  console.log(`Wrote diagnostics to ${path.relative(ROOT, DIAG_DIR)}`);
  for (const row of summaryRows) {
    console.log([
      `${row.case}/${row.method}`,
      `direct_mae=${fmt(row.direct_avg_abs_error)}`,
      `with_self=${fmt(row.current_with_self_avg_abs_error)}`,
      `no_self=${fmt(row.current_no_self_avg_abs_error)}`,
      `constraint_residual_mae=${fmt(row.residual_mae)}`,
      `residual_abs95=${fmt(row.residual_abs95)}`,
    ].join(" "));
  }
}

main();
