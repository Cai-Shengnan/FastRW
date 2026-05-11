#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const EXE = path.join(ROOT, "build", "random_walker_metal");
const OUT_ROOT = path.join(ROOT, "outputs", "fusion_diagnostics", "case1_spacing_sweep");

const SPACING_GROUPS = [
  { name: "s10_current", spacing: 10, indices: [10, 20, 30, 40] },
  { name: "s4_medium", spacing: 4, indices: [19, 23, 27, 31] },
  { name: "s2_dense", spacing: 2, indices: [22, 24, 26, 28] },
  { name: "s1_adjacent", spacing: 1, indices: [24, 25, 26, 27] },
];

const RUNS = [
  {
    method: "pirw_direct",
    baseConfig: path.join(ROOT, "configs", "pirw_case1_power6.json"),
    samples: 1000,
  },
  {
    method: "fastrw_direct",
    baseConfig: path.join(ROOT, "configs", "case1_power6.json"),
    samples: 400,
  },
];

const FUSION = {
  source: "prior",
  aggregator: "max_alpha",
  includeSelf: false,
  alphaMin: 0.3,
  lambda: 1.0,
};

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

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

function resolveConfigPath(configPath, maybeRelative) {
  return path.isAbsolute(maybeRelative)
    ? maybeRelative
    : path.normalize(path.join(path.dirname(configPath), maybeRelative));
}

function prepareConfig(baseConfig, outConfig, outDir, indices) {
  const config = JSON.parse(fs.readFileSync(baseConfig, "utf8"));
  config.data.power_density_path = resolveConfigPath(baseConfig, config.data.power_density_path);
  config.data.prior_temperature_path = resolveConfigPath(baseConfig, config.data.prior_temperature_path);
  config.data.reference_temperature_path = resolveConfigPath(baseConfig, config.data.reference_temperature_path);
  config.query_grid.x_indices = indices;
  config.query_grid.y_indices = indices;
  config.output.directory = outDir;
  config.output.csv = "direct.csv";
  config.output.constraints = "constraints.json";
  fs.mkdirSync(path.dirname(outConfig), { recursive: true });
  fs.writeFileSync(outConfig, `${JSON.stringify(config, null, 2)}\n`);
}

function runIfNeeded(configPath, samples, outDir) {
  const constraints = path.join(outDir, "constraints.json");
  const direct = path.join(outDir, "direct.csv");
  if (fs.existsSync(constraints) && fs.existsSync(direct)) {
    console.log(`Reusing ${path.relative(ROOT, outDir)}`);
    return;
  }
  console.log(`Running ${path.relative(ROOT, configPath)} N=${samples}`);
  const result = spawnSync(EXE, [configPath, String(samples), "-1"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`Run failed for ${configPath}`);
  }
}

function directMetrics(runDir) {
  const rows = readCsv(path.join(runDir, "direct.csv"));
  const data = JSON.parse(fs.readFileSync(path.join(runDir, "constraints.json"), "utf8"));
  const estVars = [];
  for (let i = 0; i < data.M; i++) {
    estVars.push(variance(data.obs_data.map((row) => row[i])) / data.N);
  }
  return {
    mae: mean(rows.map((row) => Math.abs(row.Direct_Error))),
    avg_variance: mean(estVars),
    avg_se: mean(estVars.map(Math.sqrt)),
    K: data.K,
    N: data.N,
  };
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
  const tempPath = config.data.prior_temperature_path;
  const buf = fs.readFileSync(tempPath);

  function tempAt(z, y, x) {
    const iz = Math.floor(z / zres) - zHeatFirst;
    const iy = Math.floor(y / xy);
    const ix = Math.floor(x / xy);
    return buf.readDoubleLE(((iz * ny + iy) * nx + ix) * 8) + (config.data.temperature_offset || 0);
  }

  const q = config.query_grid;
  const z = (q.z ?? (g.bottom_thickness + 0.5 * g.middle_thickness)) + (q.z_offset || 0);
  const values = [];
  for (const iy of q.y_indices) {
    for (const ix of q.x_indices) {
      values.push(tempAt(
        z,
        iy * xy + (q.y_offset || 0),
        ix * xy + (q.x_offset || 0)
      ));
    }
  }
  return values;
}

function priorPathPluginMetrics(runDir, configPath) {
  const rows = readCsv(path.join(runDir, "direct.csv"));
  const data = JSON.parse(fs.readFileSync(path.join(runDir, "constraints.json"), "utf8"));
  if (!Array.isArray(data.sample_k) || data.sample_k.length !== data.K) {
    throw new Error(`Expected schema-2 constraints for ${runDir}`);
  }
  const prior = loadPriorAtQueryPoints(configPath);
  const pathRecords = Array.from({ length: data.M }, () =>
    Array.from({ length: data.N }, () => [])
  );
  for (let k = 0; k < data.K; k++) {
    const source = data.i_k[k] - 1;
    const target = data.j_k[k] - 1;
    const sample = data.sample_k[k] - 1;
    const alpha = data.alpha_k[k];
    if (alpha < FUSION.alphaMin) continue;
    if (!FUSION.includeSelf && source === target) continue;
    pathRecords[source][sample].push({ target, alpha, b: data.b_k[k] });
  }

  const pointSamples = Array.from({ length: data.M }, (_, i) => {
    const values = [];
    for (let n = 0; n < data.N; n++) {
      const direct = data.obs_data[n][i];
      const records = pathRecords[i][n];
      if (!records.length) {
        values.push(direct);
        continue;
      }
      let best = records[0];
      for (const record of records) {
        if (record.alpha > best.alpha) best = record;
      }
      const pseudo = best.b + best.alpha * prior[best.target];
      values.push((1 - FUSION.lambda) * direct + FUSION.lambda * pseudo);
    }
    return values;
  });

  const theta = pointSamples.map(mean);
  const estVars = pointSamples.map((samples) => variance(samples) / samples.length);
  return {
    mae: mean(theta.map((value, i) => Math.abs(value - rows[i].GT_Temperature))),
    avg_variance: mean(estVars),
    avg_se: mean(estVars.map(Math.sqrt)),
    K: data.K,
    N: data.N,
  };
}

function main() {
  if (!fs.existsSync(EXE)) {
    throw new Error(`Missing executable: ${EXE}. Build random_walker_metal first.`);
  }
  fs.mkdirSync(OUT_ROOT, { recursive: true });

  const summary = [];
  for (const group of SPACING_GROUPS) {
    for (const run of RUNS) {
      const outDir = path.join(OUT_ROOT, group.name, run.method);
      const configPath = path.join(OUT_ROOT, "configs", `${group.name}_${run.method}.json`);
      prepareConfig(run.baseConfig, configPath, outDir, group.indices);
      runIfNeeded(configPath, run.samples, outDir);
      const m = directMetrics(outDir);
      summary.push({
        spacing_group: group.name,
        spacing_cells: group.spacing,
        query_indices: group.indices.join(" "),
        method: run.method === "pirw_direct" ? "PIRW direct" : "FastRW direct",
        N: m.N,
        K: m.K,
        mae: m.mae,
        avg_variance: m.avg_variance,
        avg_se: m.avg_se,
      });
      if (run.method === "fastrw_direct") {
        const fm = priorPathPluginMetrics(outDir, configPath);
        summary.push({
          spacing_group: group.name,
          spacing_cells: group.spacing,
          query_indices: group.indices.join(" "),
          method: "FastRW prior path plug-in",
          N: fm.N,
          K: fm.K,
          mae: fm.mae,
          avg_variance: fm.avg_variance,
          avg_se: fm.avg_se,
        });
      }
    }
  }

  const outCsv = path.join(OUT_ROOT, "summary.csv");
  writeCsv(outCsv, summary, [
    "spacing_group", "spacing_cells", "query_indices", "method",
    "N", "K", "mae", "avg_variance", "avg_se",
  ]);

  console.log("| Spacing | Query indices | Method | N | K | MAE | Avg variance | Avg SE |");
  console.log("|---|---|---|---:|---:|---:|---:|---:|");
  for (const row of summary) {
    console.log(`| ${row.spacing_cells} | ${row.query_indices} | ${row.method} | ${row.N} | ${row.K} | ${row.mae.toFixed(4)} | ${row.avg_variance.toFixed(6)} | ${row.avg_se.toFixed(4)} |`);
  }
  console.log(`\nWrote ${path.relative(ROOT, outCsv)}`);
}

main();
