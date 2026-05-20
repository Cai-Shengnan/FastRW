#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DIAG_DIR = path.join(ROOT, "outputs", "fusion_diagnostics");
const ALPHA_MIN_VALUES = [0.03, 0.1, 0.3, 0.5, 0.8];
const EFFECTIVE_SAMPLE_SCALES = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1];
const MODES = [
  "all",
  "max_alpha_per_path_target",
  "cross_max_alpha_per_path_target",
];
const EPS = 1e-12;

function usage() {
  console.error("Usage: diagnose_tail_reuse_fusion.js <run_dir> [run_dir ...]");
  process.exit(2);
}

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
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
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

function summarizeEstimate(directRows, theta) {
  const errors = theta.map((value, i) => value - directRows[i].GT_Temperature);
  const abs = errors.map(Math.abs);
  return {
    avg_signed_error: mean(errors),
    avg_abs_error: mean(abs),
    rmse_error: Math.sqrt(mean(errors.map((e) => e * e))),
    max_abs_error: Math.max(...abs),
  };
}

function directTheta(data) {
  return Array.from({ length: data.M }, (_, i) => mean(data.obs_data.map((row) => row[i])));
}

function buildTailSamples(data, alphaMin, mode) {
  const tailSamples = Array.from({ length: data.M }, () => []);
  const grouped = new Map();

  for (let k = 0; k < data.K; k++) {
    const source = data.i_k[k] - 1;
    const target = data.j_k[k] - 1;
    const sample = data.sample_k[k] - 1;
    const alpha = data.alpha_k[k];
    const b = data.b_k[k];
    if (alpha < alphaMin) continue;
    if (mode === "cross_max_alpha_per_path_target" && source === target) continue;

    const fullSample = data.obs_data[sample][source];
    const tail = (fullSample - b) / alpha;
    if (!Number.isFinite(tail)) continue;

    if (mode === "all") {
      tailSamples[target].push(tail);
      continue;
    }

    const key = `${source}:${sample}:${target}`;
    const previous = grouped.get(key);
    if (!previous || alpha > previous.alpha) {
      grouped.set(key, { target, tail, alpha });
    }
  }

  if (mode !== "all") {
    for (const value of grouped.values()) {
      tailSamples[value.target].push(value.tail);
    }
  }

  return tailSamples;
}

function pooledMeanTheta(data, tailSamples) {
  return Array.from({ length: data.M }, (_, i) => {
    const samples = data.obs_data.map((row) => row[i]).concat(tailSamples[i]);
    return mean(samples);
  });
}

function tailMeanTheta(data, direct, tailSamples) {
  return Array.from({ length: data.M }, (_, i) =>
    tailSamples[i].length ? mean(tailSamples[i]) : direct[i]
  );
}

function varianceShrinkTheta(data, direct, tailSamples, effectiveSampleScale) {
  return Array.from({ length: data.M }, (_, i) => {
    const directSamples = data.obs_data.map((row) => row[i]);
    const pseudo = tailSamples[i];
    if (pseudo.length < 2) return direct[i];

    const directWeight = data.N / Math.max(variance(directSamples), EPS);
    const tailWeight = (pseudo.length * effectiveSampleScale) / Math.max(variance(pseudo), EPS);
    return (directWeight * mean(directSamples) + tailWeight * mean(pseudo)) /
           (directWeight + tailWeight);
  });
}

function loadRun(runDirArg) {
  const runDir = path.resolve(runDirArg);
  const constraintsPath = path.join(runDir, "constraints.json");
  const directPath = path.join(runDir, "direct.csv");
  if (!fs.existsSync(constraintsPath) || !fs.existsSync(directPath)) {
    throw new Error(`Expected constraints.json and direct.csv in ${runDir}`);
  }
  const data = JSON.parse(fs.readFileSync(constraintsPath, "utf8"));
  if (!Array.isArray(data.sample_k) || data.sample_k.length !== data.K) {
    throw new Error(`${runDir} does not have schema-2 path metadata; rerun RW first.`);
  }
  return {
    runDir,
    case: path.basename(path.dirname(runDir)),
    method: path.basename(runDir),
    data,
    directRows: readCsv(directPath),
  };
}

function diagnoseRun(run) {
  const direct = directTheta(run.data);
  const rows = [{
    case: run.case,
    method: run.method,
    run_dir: run.runDir,
    estimator: "direct",
    mode: "",
    alpha_min: "",
    effective_sample_scale: "",
    tail_sample_count_mean: "",
    tail_sample_count_q95: "",
    tail_sample_count_max: "",
    ...summarizeEstimate(run.directRows, direct),
  }];

  for (const alphaMin of ALPHA_MIN_VALUES) {
    for (const mode of MODES) {
      const tailSamples = buildTailSamples(run.data, alphaMin, mode);
      const counts = tailSamples.map((samples) => samples.length);

      const tailTheta = tailMeanTheta(run.data, direct, tailSamples);
      rows.push({
        case: run.case,
        method: run.method,
        run_dir: run.runDir,
        estimator: "tail_mean",
        mode,
        alpha_min: alphaMin,
        effective_sample_scale: "",
        tail_sample_count_mean: mean(counts),
        tail_sample_count_q95: quantile(counts, 0.95),
        tail_sample_count_max: Math.max(...counts),
        ...summarizeEstimate(run.directRows, tailTheta),
      });

      const pooled = pooledMeanTheta(run.data, tailSamples);
      rows.push({
        case: run.case,
        method: run.method,
        run_dir: run.runDir,
        estimator: "pooled_mean",
        mode,
        alpha_min: alphaMin,
        effective_sample_scale: 1,
        tail_sample_count_mean: mean(counts),
        tail_sample_count_q95: quantile(counts, 0.95),
        tail_sample_count_max: Math.max(...counts),
        ...summarizeEstimate(run.directRows, pooled),
      });

      for (const scale of EFFECTIVE_SAMPLE_SCALES) {
        const shrunk = varianceShrinkTheta(run.data, direct, tailSamples, scale);
        rows.push({
          case: run.case,
          method: run.method,
          run_dir: run.runDir,
          estimator: "variance_shrink",
          mode,
          alpha_min: alphaMin,
          effective_sample_scale: scale,
          tail_sample_count_mean: mean(counts),
          tail_sample_count_q95: quantile(counts, 0.95),
          tail_sample_count_max: Math.max(...counts),
          ...summarizeEstimate(run.directRows, shrunk),
        });
      }
    }
  }

  return rows;
}

function bestRows(rows) {
  const byRun = new Map();
  for (const row of rows) {
    const key = `${row.case}/${row.method}`;
    if (!byRun.has(key)) byRun.set(key, []);
    byRun.get(key).push(row);
  }
  return Array.from(byRun.entries()).map(([key, runRows]) => {
    const direct = runRows.find((row) => row.estimator === "direct");
    const best = runRows
      .filter((row) => row.estimator !== "direct")
      .slice()
      .sort((a, b) => a.avg_abs_error - b.avg_abs_error)[0];
    return { key, direct, best };
  });
}

function main() {
  const runDirs = process.argv.slice(2);
  if (!runDirs.length) usage();

  const rows = [];
  for (const runDir of runDirs) {
    rows.push(...diagnoseRun(loadRun(runDir)));
  }

  const outPath = path.join(DIAG_DIR, "tail_reuse_summary.csv");
  writeCsv(outPath, rows, [
    "case", "method", "run_dir", "estimator", "mode", "alpha_min", "effective_sample_scale",
    "tail_sample_count_mean", "tail_sample_count_q95", "tail_sample_count_max",
    "avg_signed_error", "avg_abs_error", "rmse_error", "max_abs_error",
  ]);

  console.log(`Wrote tail-reuse diagnostics to ${path.relative(ROOT, outPath)}`);
  for (const { key, direct, best } of bestRows(rows)) {
    console.log([
      key,
      `direct_mae=${direct.avg_abs_error.toFixed(4)}`,
      `best_mae=${best.avg_abs_error.toFixed(4)}`,
      `estimator=${best.estimator}`,
      `mode=${best.mode}`,
      `alpha_min=${best.alpha_min}`,
      `scale=${best.effective_sample_scale}`,
    ].join(" "));
  }
}

main();
