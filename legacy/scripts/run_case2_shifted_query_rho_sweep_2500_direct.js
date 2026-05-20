#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const caseId = "case2_4core_top1_bottom1";
const shiftedIndices = (process.env.QUERY_INDICES || "15,25,35,45")
  .split(",")
  .map((value) => Number(value.trim()));
const samples = Number(process.env.SAMPLES || 2500);
const rhoStart = Number(process.env.RHO_START || 1.562);
const rhoEnd = Number(process.env.RHO_END || 1.566);
const rhoStep = Number(process.env.RHO_STEP || 0.001);
const outputRoot = path.join(rootDir, "outputs", "case2_shifted_query_full_prior_n2500_rho_near_best");
const configRoot = path.join(outputRoot, "configs");
const summaryCsv = path.join(outputRoot, "summary.csv");
const metalBin = path.join(rootDir, "build-metal", "random_walker_metal");

function checkFinite(name, value) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

checkFinite("SAMPLES", samples);
checkFinite("RHO_START", rhoStart);
checkFinite("RHO_END", rhoEnd);
checkFinite("RHO_STEP", rhoStep);
if (samples <= 0 || rhoStep <= 0 || rhoEnd < rhoStart) {
  throw new Error("Invalid sweep range or sample count");
}
if (shiftedIndices.some((value) => !Number.isInteger(value))) {
  throw new Error("QUERY_INDICES must be comma-separated integers");
}

function rhoValues() {
  const values = [];
  for (let value = rhoStart; value <= rhoEnd + rhoStep * 1e-6; value += rhoStep) {
    values.push(Number(value.toFixed(12)));
  }
  return values;
}

function rhoText(rho) {
  return rho.toFixed(3);
}

function rhoLabel(rho) {
  return `rho_${rhoText(rho).replace(".", "p")}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveFromBase(baseDir, rawPath) {
  return path.resolve(baseDir, rawPath);
}

function makeConfig(rho) {
  const basePath = path.join(rootDir, "configs", `${caseId}.json`);
  const baseDir = path.dirname(basePath);
  const config = readJson(basePath);
  const eps = rho * config.walker.delta_x;
  const runDir = path.join(outputRoot, caseId, rhoLabel(rho));

  config.case_name = `${config.case_name}_${rhoLabel(rho)}_shifted_query_full_prior`;
  config.boundary.rho = rho;
  if (!config.boundary.epsilon) config.boundary.epsilon = {};
  config.boundary.epsilon.neumann = eps;
  config.boundary.epsilon.robin = eps;
  config.query_grid.x_indices = shiftedIndices;
  config.query_grid.y_indices = shiftedIndices;
  config.data.power_density_path = resolveFromBase(baseDir, config.data.power_density_path);
  config.data.reference_temperature_path = resolveFromBase(baseDir, config.data.reference_temperature_path);
  config.data.prior_temperature_path = config.data.reference_temperature_path;
  config.run.num_samples = samples;
  config.output.directory = runDir;
  config.output.csv = "direct.csv";
  config.output.constraints = "constraints.json";
  config.output.diagnostics = "diagnostics.json";

  const configPath = path.join(configRoot, `${caseId}_${rhoLabel(rho)}_shifted_query.json`);
  writeJson(configPath, config);
  return { configPath, runDir };
}

function parseCsv(csvPath) {
  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
  const header = lines.shift().split(",");
  return lines.map((line) => {
    const values = line.split(",");
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = Number(values[i]);
    return row;
  });
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(rho, runDir) {
  const rows = parseCsv(path.join(runDir, "direct.csv"));
  const errors = rows.map((row) => row.Direct_Error);
  const stdErrors = rows.map((row) => row.Direct_StdError);
  return {
    case_id: caseId,
    query_indices: shiftedIndices.join(" "),
    rho,
    samples,
    points: rows.length,
    mean_abs_direct_error: mean(errors.map(Math.abs)),
    mean_direct_std_error: mean(stdErrors),
    mean_direct_error: mean(errors),
    rmse_direct_error: Math.sqrt(mean(errors.map((error) => error * error))),
    run_dir: path.relative(rootDir, runDir),
  };
}

function writeSummary(rows) {
  const columns = [
    "case_id",
    "query_indices",
    "rho",
    "samples",
    "points",
    "mean_abs_direct_error",
    "mean_direct_std_error",
    "mean_direct_error",
    "rmse_direct_error",
    "run_dir",
  ];
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => row[column]).join(","));
  }
  fs.writeFileSync(summaryCsv, `${lines.join("\n")}\n`);
}

function runMetal(configPath) {
  console.log(`\n$ ${metalBin} ${configPath} ${samples} -1`);
  const result = spawnSync(metalBin, [configPath, String(samples), "-1"], {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`Metal run failed with status ${result.status}`);
  }
}

function main() {
  if (!fs.existsSync(metalBin)) {
    throw new Error(`Missing Metal binary: ${metalBin}`);
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  const rows = [];
  for (const rho of rhoValues()) {
    const { configPath, runDir } = makeConfig(rho);
    fs.rmSync(runDir, { recursive: true, force: true });
    runMetal(configPath);
    rows.push(summarize(rho, runDir));
    writeSummary(rows);
  }

  rows.sort((a, b) => a.mean_abs_direct_error - b.mean_abs_direct_error);
  console.log(`\nSummary written to: ${summaryCsv}`);
  console.log("Best by mean(abs(Direct_Error)):");
  const best = rows[0];
  console.log(
    `  rho=${rhoText(best.rho)} mean_abs=${best.mean_abs_direct_error.toFixed(6)} ` +
    `mean_se=${best.mean_direct_std_error.toFixed(6)} signed=${best.mean_direct_error.toFixed(6)} ` +
    `rmse=${best.rmse_direct_error.toFixed(6)}`
  );
}

main();
