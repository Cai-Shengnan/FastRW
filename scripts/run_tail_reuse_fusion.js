#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const EPS = 1e-12;
const DEFAULTS = {
  mode: "cross_max_alpha_per_path_target",
  alphaMin: 0.8,
  estimator: "variance_shrink",
  effectiveSampleScale: 0.03,
  output: "tail_reuse.csv",
  summary: "tail_reuse_summary.json",
};

function usage() {
  console.error([
    "Usage: run_tail_reuse_fusion.js <run_dir> [options]",
    "",
    "Options:",
    "  --mode=all|max_alpha_per_path_target|cross_max_alpha_per_path_target",
    "  --alpha-min=<number>",
    "  --estimator=pooled_mean|tail_mean|variance_shrink",
    "  --scale=<number>                       effective tail sample scale for variance_shrink",
    "  --output=<csv_name>",
    "  --summary=<json_name>",
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv) {
  const [, , runDir, ...opts] = argv;
  if (!runDir) usage();
  const config = { ...DEFAULTS, runDir: path.resolve(runDir) };
  for (const opt of opts) {
    const match = opt.match(/^--([^=]+)=(.*)$/);
    if (!match) usage();
    const key = match[1];
    const value = match[2];
    if (key === "mode") config.mode = value;
    else if (key === "alpha-min") config.alphaMin = Number(value);
    else if (key === "estimator") config.estimator = value;
    else if (key === "scale") config.effectiveSampleScale = Number(value);
    else if (key === "output") config.output = value;
    else if (key === "summary") config.summary = value;
    else usage();
  }
  if (!["all", "max_alpha_per_path_target", "cross_max_alpha_per_path_target"].includes(config.mode)) usage();
  if (!["pooled_mean", "tail_mean", "variance_shrink"].includes(config.estimator)) usage();
  if (!Number.isFinite(config.alphaMin) || config.alphaMin <= 0) usage();
  if (!Number.isFinite(config.effectiveSampleScale) || config.effectiveSampleScale < 0) usage();
  return config;
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

function std(values) {
  return Math.sqrt(variance(values));
}

function summarizeErrors(rows, key) {
  const errors = rows.map((row) => row[key]).filter((value) => Number.isFinite(value));
  const abs = errors.map(Math.abs);
  return {
    avg_signed_error: mean(errors),
    avg_abs_error: mean(abs),
    rmse_error: Math.sqrt(mean(errors.map((e) => e * e))),
    max_abs_error: Math.max(...abs),
  };
}

function validateData(data, directRows) {
  if (directRows.length !== data.M) {
    throw new Error(`Direct CSV point count ${directRows.length} does not match constraints M=${data.M}`);
  }
  const required = ["sample_k", "step_k", "record_k"];
  for (const key of required) {
    if (!Array.isArray(data[key]) || data[key].length !== data.K) {
      throw new Error(`constraints.json is missing schema-2 field ${key}; rerun RW before tail-reuse fusion.`);
    }
  }
}

function directTheta(data) {
  return Array.from({ length: data.M }, (_, i) => mean(data.obs_data.map((row) => row[i])));
}

function buildTailSamples(data, config) {
  const tailSamples = Array.from({ length: data.M }, () => []);
  const grouped = new Map();

  for (let k = 0; k < data.K; k++) {
    const source = data.i_k[k] - 1;
    const target = data.j_k[k] - 1;
    const sample = data.sample_k[k] - 1;
    const alpha = data.alpha_k[k];
    const b = data.b_k[k];
    if (alpha < config.alphaMin) continue;
    if (config.mode === "cross_max_alpha_per_path_target" && source === target) continue;

    const fullSample = data.obs_data[sample][source];
    const tail = (fullSample - b) / alpha;
    if (!Number.isFinite(tail)) continue;

    if (config.mode === "all") {
      tailSamples[target].push(tail);
      continue;
    }

    const key = `${source}:${sample}:${target}`;
    const previous = grouped.get(key);
    if (!previous || alpha > previous.alpha) {
      grouped.set(key, { target, alpha, tail });
    }
  }

  if (config.mode !== "all") {
    for (const value of grouped.values()) {
      tailSamples[value.target].push(value.tail);
    }
  }

  return tailSamples;
}

function fuseTheta(data, direct, tailSamples, config) {
  if (config.estimator === "tail_mean") {
    return tailSamples.map((samples, i) => samples.length ? mean(samples) : direct[i]);
  }
  if (config.estimator === "pooled_mean") {
    return tailSamples.map((samples, i) => mean(data.obs_data.map((row) => row[i]).concat(samples)));
  }
  return tailSamples.map((samples, i) => {
    if (samples.length < 2 || config.effectiveSampleScale === 0) return direct[i];
    const directSamples = data.obs_data.map((row) => row[i]);
    const directWeight = data.N / Math.max(variance(directSamples), EPS);
    const tailWeight = (samples.length * config.effectiveSampleScale) / Math.max(variance(samples), EPS);
    return (directWeight * mean(directSamples) + tailWeight * mean(samples)) /
           (directWeight + tailWeight);
  });
}

function main() {
  const config = parseArgs(process.argv);
  const constraintsPath = path.join(config.runDir, "constraints.json");
  const directPath = path.join(config.runDir, "direct.csv");
  const data = JSON.parse(fs.readFileSync(constraintsPath, "utf8"));
  const directRows = readCsv(directPath);
  validateData(data, directRows);

  const direct = directTheta(data);
  const tailSamples = buildTailSamples(data, config);
  const fused = fuseTheta(data, direct, tailSamples, config);

  const rows = directRows.map((row, i) => {
    const tail = tailSamples[i];
    const fusedError = Number.isFinite(row.GT_Temperature) ? fused[i] - row.GT_Temperature : null;
    const directError = Number.isFinite(row.GT_Temperature) ? direct[i] - row.GT_Temperature : null;
    return {
      Point: row.Point,
      X: row.X,
      Y: row.Y,
      Z: row.Z,
      Direct_Mean: direct[i],
      Fused_Mean: fused[i],
      GT_Temperature: row.GT_Temperature,
      Direct_Error: directError,
      Fused_Error: fusedError,
      Tail_Sample_Count: tail.length,
      Tail_Sample_Mean: tail.length ? mean(tail) : null,
      Tail_SampleStd: tail.length > 1 ? std(tail) : null,
      Avg_Steps: row.Avg_Steps,
    };
  });

  const outputPath = path.join(config.runDir, config.output);
  writeCsv(outputPath, rows, [
    "Point", "X", "Y", "Z", "Direct_Mean", "Fused_Mean", "GT_Temperature",
    "Direct_Error", "Fused_Error", "Tail_Sample_Count", "Tail_Sample_Mean",
    "Tail_SampleStd", "Avg_Steps",
  ]);

  const summary = {
    run_dir: config.runDir,
    constraints: {
      path: constraintsPath,
      schema_version: data.constraint_schema_version ?? 1,
      M: data.M,
      N: data.N,
      K: data.K,
      self_constraints: data.self_constraints ?? null,
      pass_overflow_paths: data.pass_overflow_paths ?? 0,
    },
    tail_reuse: {
      mode: config.mode,
      alpha_min: config.alphaMin,
      estimator: config.estimator,
      effective_sample_scale: config.effectiveSampleScale,
      output: outputPath,
      tail_sample_count_total: tailSamples.reduce((sum, samples) => sum + samples.length, 0),
      tail_sample_count_mean: mean(tailSamples.map((samples) => samples.length)),
      tail_sample_count_max: Math.max(...tailSamples.map((samples) => samples.length)),
    },
    direct: summarizeErrors(rows, "Direct_Error"),
    tail_reuse_result: summarizeErrors(rows, "Fused_Error"),
  };

  const summaryPath = path.join(config.runDir, config.summary);
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
