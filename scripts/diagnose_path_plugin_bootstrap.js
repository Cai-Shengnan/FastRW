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

const SOURCES = [
  { name: "prior", directWeight: 0 },
  { name: "direct", directWeight: 1 },
  { name: "hybrid25", directWeight: 0.25 },
  { name: "hybrid50", directWeight: 0.5 },
  { name: "hybrid75", directWeight: 0.75 },
];
const AGGREGATORS = ["max_alpha", "alpha2_weighted"];
const ALPHA_MIN_VALUES = [0.1, 0.3, 0.5, 0.8];
const LAMBDA_VALUES = [0.1, 0.25, 0.5, 0.75, 1.0];
const INCLUDE_SELF_VALUES = [true, false];
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

function loadPriorAtQueryPoints(configPath) {
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
    const byteOffset = ((iz * ny + iy) * nx + ix) * 8;
    return buf.readDoubleLE(byteOffset) + temperatureOffset;
  }

  const q = config.query_grid;
  const z = (q.z ?? (g.bottom_thickness + 0.5 * g.middle_thickness)) + (q.z_offset || 0);
  const yOffset = q.y_offset || 0;
  const xOffset = q.x_offset || 0;
  const values = [];
  for (const iy of q.y_indices) {
    for (const ix of q.x_indices) {
      values.push(tempAt(z, iy * xy + yOffset, ix * xy + xOffset));
    }
  }
  return values;
}

function loadRun(label, runDir, configPath) {
  const absRunDir = path.resolve(ROOT, runDir);
  const absConfig = path.resolve(ROOT, configPath);
  const data = JSON.parse(fs.readFileSync(path.join(absRunDir, "constraints.json"), "utf8"));
  const rows = readCsv(path.join(absRunDir, "direct.csv"));
  if (!Array.isArray(data.sample_k) || data.sample_k.length !== data.K) {
    throw new Error(`${runDir} does not have schema-2 path metadata`);
  }
  const directMeans = Array.from({ length: data.M }, (_, i) => mean(data.obs_data.map((row) => row[i])));
  const prior = loadPriorAtQueryPoints(absConfig);
  const recordsByPath = Array.from({ length: data.M }, () =>
    Array.from({ length: data.N }, () => [])
  );
  for (let k = 0; k < data.K; k++) {
    const source = data.i_k[k] - 1;
    const sample = data.sample_k[k] - 1;
    recordsByPath[source][sample].push({
      target: data.j_k[k] - 1,
      alpha: data.alpha_k[k],
      b: data.b_k[k],
    });
  }
  return { label, runDir: absRunDir, data, rows, directMeans, prior, recordsByPath };
}

function directMetrics(run) {
  const sampleValues = Array.from({ length: run.data.M }, (_, i) =>
    run.data.obs_data.map((row) => row[i])
  );
  return metricsForPathValues(run.rows, sampleValues);
}

function targetValue(run, sourceSpec, sourcePoint, sample, targetPoint) {
  if (sourceSpec.name === "prior") return run.prior[targetPoint];
  let directTarget = run.directMeans[targetPoint];
  if (sourcePoint === targetPoint && run.data.N > 1) {
    directTarget = (
      run.directMeans[targetPoint] * run.data.N -
      run.data.obs_data[sample][targetPoint]
    ) / (run.data.N - 1);
  }
  return (1 - sourceSpec.directWeight) * run.prior[targetPoint] +
         sourceSpec.directWeight * directTarget;
}

function pseudoForPath(run, sourceSpec, variant, sourcePoint, sample) {
  const records = run.recordsByPath[sourcePoint][sample].filter((record) =>
    record.alpha >= variant.alphaMin &&
    (variant.includeSelf || record.target !== sourcePoint)
  );
  if (!records.length) return null;

  if (variant.aggregator === "max_alpha") {
    let best = records[0];
    for (const record of records) {
      if (record.alpha > best.alpha) best = record;
    }
    return best.b + best.alpha * targetValue(run, sourceSpec, sourcePoint, sample, best.target);
  }

  let weightSum = 0;
  let valueSum = 0;
  for (const record of records) {
    const w = Math.max(record.alpha * record.alpha, EPS);
    valueSum += w * (record.b + record.alpha * targetValue(run, sourceSpec, sourcePoint, sample, record.target));
    weightSum += w;
  }
  return valueSum / weightSum;
}

function pathValuesForVariant(run, sourceSpec, variant) {
  return Array.from({ length: run.data.M }, (_, i) => {
    const values = [];
    for (let n = 0; n < run.data.N; n++) {
      const direct = run.data.obs_data[n][i];
      const pseudo = pseudoForPath(run, sourceSpec, variant, i, n);
      values.push(pseudo === null ? direct : (1 - variant.lambda) * direct + variant.lambda * pseudo);
    }
    return values;
  });
}

function metricsForPathValues(rows, pointSamples) {
  const theta = pointSamples.map(mean);
  const errors = theta.map((value, i) => value - rows[i].GT_Temperature);
  const estVars = pointSamples.map((samples) => variance(samples) / samples.length);
  return {
    mae: mean(errors.map(Math.abs)),
    signed_error: mean(errors),
    avg_variance: mean(estVars),
    avg_se: mean(estVars.map(Math.sqrt)),
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

function bootstrapMetrics(rows, pointSamples, reps, seed) {
  const rand = mulberry32(seed);
  const M = pointSamples.length;
  const estimates = Array.from({ length: M }, () => []);
  for (let b = 0; b < reps; b++) {
    for (let i = 0; i < M; i++) {
      const samples = pointSamples[i];
      let sum = 0;
      for (let n = 0; n < samples.length; n++) {
        sum += samples[Math.floor(rand() * samples.length)];
      }
      estimates[i].push(sum / samples.length);
    }
  }
  const bootVars = estimates.map(variance);
  const theta = pointSamples.map(mean);
  const errors = theta.map((value, i) => value - rows[i].GT_Temperature);
  return {
    bootstrap_avg_variance: mean(bootVars),
    bootstrap_avg_se: mean(bootVars.map(Math.sqrt)),
    mae: mean(errors.map(Math.abs)),
  };
}

function evaluateRun(run) {
  const rows = [];
  const direct = directMetrics(run);
  rows.push({
    case: run.label,
    source: "direct_baseline",
    aggregator: "",
    include_self: "",
    alpha_min: "",
    lambda: "",
    count_paths_with_pseudo_mean: "",
    ...direct,
  });

  for (const source of SOURCES) {
    for (const aggregator of AGGREGATORS) {
      for (const includeSelf of INCLUDE_SELF_VALUES) {
        for (const alphaMin of ALPHA_MIN_VALUES) {
          for (const lambda of LAMBDA_VALUES) {
            const variant = { aggregator, includeSelf, alphaMin, lambda };
            const values = pathValuesForVariant(run, source, variant);
            const m = metricsForPathValues(run.rows, values);
            const countPaths = values.map((samples, i) => {
              let count = 0;
              for (let n = 0; n < run.data.N; n++) {
                if (pseudoForPath(run, source, variant, i, n) !== null) count++;
              }
              return count;
            });
            rows.push({
              case: run.label,
              source: source.name,
              aggregator,
              include_self: includeSelf,
              alpha_min: alphaMin,
              lambda,
              count_paths_with_pseudo_mean: mean(countPaths),
              ...m,
            });
          }
        }
      }
    }
  }

  return rows;
}

function variantKey(row) {
  return `${row.source}/${row.aggregator}/self=${row.include_self}/alpha>=${row.alpha_min}/lambda=${row.lambda}`;
}

function main() {
  const args = process.argv.slice(2);
  const runs = args.length
    ? args.map((arg) => {
        const [label, runDir, configPath] = arg.split("=");
        if (!label || !runDir || !configPath) {
          throw new Error("Args must be label=run_dir=config_path");
        }
        return [label, runDir, configPath];
      })
    : DEFAULT_RUNS;

  const allRows = [];
  const summaryRows = [];
  for (const spec of runs) {
    const run = loadRun(...spec);
    const rows = evaluateRun(run);
    allRows.push(...rows);

    const directRow = rows.find((row) => row.source === "direct_baseline");
    const bestByMae = rows
      .filter((row) => row.source !== "direct_baseline")
      .slice()
      .sort((a, b) => a.mae - b.mae)[0];
    const bestPrior = rows
      .filter((row) => row.source === "prior")
      .slice()
      .sort((a, b) => a.mae - b.mae)[0];

    const selected = [directRow, bestByMae];
    if (variantKey(bestByMae) !== variantKey(bestPrior)) {
      selected.push(bestPrior);
    }
    for (const row of selected) {
      let values;
      if (row.source === "direct_baseline") {
        values = Array.from({ length: run.data.M }, (_, i) => run.data.obs_data.map((sample) => sample[i]));
      } else {
        const source = SOURCES.find((item) => item.name === row.source);
        values = pathValuesForVariant(run, source, {
          aggregator: row.aggregator,
          includeSelf: row.include_self === true || row.include_self === "true",
          alphaMin: Number(row.alpha_min),
          lambda: Number(row.lambda),
        });
      }
      const boot = bootstrapMetrics(run.rows, values, BOOTSTRAP_REPS, 42);
      summaryRows.push({
        case: run.label,
        method: row.source === "direct_baseline"
          ? "FastRW direct baseline"
          : (row === bestPrior ? "Best prior path plug-in" : "Best path plug-in"),
        variant: row.source === "direct_baseline" ? "direct" : variantKey(row),
        mae: row.mae,
        avg_variance: row.avg_variance,
        avg_se: row.avg_se,
        bootstrap_avg_variance: boot.bootstrap_avg_variance,
        bootstrap_avg_se: boot.bootstrap_avg_se,
        signed_error: row.signed_error,
      });
    }
  }

  writeCsv(path.join(OUT_DIR, "path_plugin_sweep.csv"), allRows, [
    "case", "source", "aggregator", "include_self", "alpha_min", "lambda",
    "count_paths_with_pseudo_mean", "mae", "signed_error", "avg_variance",
    "avg_se", "max_abs_error",
  ]);
  writeCsv(path.join(OUT_DIR, "path_plugin_bootstrap_summary.csv"), summaryRows, [
    "case", "method", "variant", "mae", "avg_variance", "avg_se",
    "bootstrap_avg_variance", "bootstrap_avg_se", "signed_error",
  ]);

  console.log("| Case | Method | MAE | Avg variance | Avg SE | Bootstrap Avg variance | Bootstrap Avg SE |");
  console.log("|---|---|---:|---:|---:|---:|---:|");
  for (const row of summaryRows) {
    console.log(`| ${row.case} | ${row.method} | ${row.mae.toFixed(4)} | ${row.avg_variance.toFixed(6)} | ${row.avg_se.toFixed(4)} | ${row.bootstrap_avg_variance.toFixed(6)} | ${row.bootstrap_avg_se.toFixed(4)} |`);
  }
  console.log(`\nWrote ${path.relative(ROOT, path.join(OUT_DIR, "path_plugin_sweep.csv"))}`);
  console.log(`Wrote ${path.relative(ROOT, path.join(OUT_DIR, "path_plugin_bootstrap_summary.csv"))}`);
}

main();
