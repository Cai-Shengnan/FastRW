#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

const cases = [
  { id: "case1_power6", title: "Case 1", refinedStart: 1.555, refinedEnd: 1.565 },
  { id: "case2_4core_top1_bottom1", title: "Case 2", refinedStart: 1.560, refinedEnd: 1.570 },
  { id: "case3_16core", title: "Case 3", refinedStart: 1.545, refinedEnd: 1.555 },
];

const samples = Number(process.env.SAMPLES || 2500);
const rhoStart = Number(process.env.RHO_START || 1.555);
const rhoEnd = Number(process.env.RHO_END || 1.575);
const rhoStep = Number(process.env.RHO_STEP || 0.005);
const sweepMode = process.env.SWEEP_MODE || "coarse";
const threadsPerThreadgroup = process.env.THREADS_PER_THREADGROUP || "-1";
const reuseExisting = process.env.REUSE_EXISTING === "1";
const hasExplicitRange = process.env.RHO_START !== undefined || process.env.RHO_END !== undefined;

function assertFinite(name, value) {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
}

assertFinite("SAMPLES", samples);
assertFinite("RHO_START", rhoStart);
assertFinite("RHO_END", rhoEnd);
assertFinite("RHO_STEP", rhoStep);
if (samples <= 0) throw new Error("SAMPLES must be positive");
if (rhoStep <= 0) throw new Error("RHO_STEP must be positive");
if (rhoEnd < rhoStart) throw new Error("RHO_END must be >= RHO_START");
if (!["coarse", "refined"].includes(sweepMode)) {
  throw new Error("SWEEP_MODE must be coarse or refined");
}

function rhoValues(start, end) {
  const values = [];
  for (let value = start; value <= end + rhoStep * 1e-6; value += rhoStep) {
    values.push(Number(value.toFixed(12)));
  }
  return values;
}

function caseRhoRange(caseMeta) {
  if (sweepMode === "refined" && !hasExplicitRange) {
    return { start: caseMeta.refinedStart, end: caseMeta.refinedEnd };
  }
  return { start: rhoStart, end: rhoEnd };
}

function rhoText(rho) {
  return rho.toFixed(3);
}

function rhoLabel(rho) {
  return `rho_${rhoText(rho).replace(".", "p")}`;
}

function stepLabel() {
  return rhoStep.toFixed(3).replace(".", "p");
}

const outputName = sweepMode === "refined"
  ? `rho_sweep_full_prior_refined_n${samples}_step${stepLabel()}`
  : `rho_sweep_full_prior_n${samples}_step${stepLabel()}`;
const outputRoot = path.join(rootDir, "outputs", outputName);
const configRoot = path.join(outputRoot, "configs");
const summaryCsv = path.join(outputRoot, "summary.csv");

function runStreaming(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`\n$ ${[cmd, ...args].join(" ")}`);
    const child = spawn(cmd, args, {
      cwd: options.cwd || rootDir,
      env: { ...process.env, ...(options.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const logStream = options.logPath
      ? fs.createWriteStream(options.logPath, { flags: "w" })
      : null;

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      if (logStream) logStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      if (logStream) logStream.write(chunk);
    });
    child.on("error", (err) => {
      if (logStream) logStream.end();
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (logStream) logStream.end();
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with ${code ?? signal}`));
      }
    });
  });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeConfig(caseId, rho) {
  const basePath = path.join(rootDir, "configs", `${caseId}.json`);
  const baseDir = path.dirname(basePath);
  const config = readJson(basePath);
  const caseOutDir = path.join(outputRoot, caseId, rhoLabel(rho));
  const eps = rho * config.walker.delta_x;
  const resolveFromBase = (rawPath) => path.resolve(baseDir, rawPath);

  config.case_name = `${config.case_name}_${rhoLabel(rho)}_full_prior`;
  config.boundary.rho = rho;
  if (!config.boundary.epsilon) config.boundary.epsilon = {};
  config.boundary.epsilon.neumann = eps;
  config.boundary.epsilon.robin = eps;
  config.data.power_density_path = resolveFromBase(config.data.power_density_path);
  config.data.reference_temperature_path = resolveFromBase(config.data.reference_temperature_path);
  config.data.prior_temperature_path = config.data.reference_temperature_path;
  config.run.num_samples = samples;
  config.output.directory = caseOutDir;
  config.output.csv = "direct.csv";
  config.output.constraints = "constraints.json";
  config.output.diagnostics = "diagnostics.json";

  const outPath = path.join(configRoot, `${caseId}_${rhoLabel(rho)}.json`);
  writeJson(outPath, config);
  return {
    configPath: outPath,
    runDir: caseOutDir,
  };
}

function removeRunDir(runDir) {
  const resolved = path.resolve(runDir);
  const outputPrefix = path.resolve(outputRoot) + path.sep;
  if (!resolved.startsWith(outputPrefix)) {
    throw new Error(`Refusing to remove output directory outside ${outputRoot}: ${runDir}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
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

function summarizeDirectCsv(caseId, rho, runDir) {
  const csvPath = path.join(runDir, "direct.csv");
  const rows = parseCsv(csvPath);
  const errors = rows.map((row) => row.Direct_Error);
  const absErrors = errors.map(Math.abs);
  const stdErrors = rows.map((row) => row.Direct_StdError);
  return {
    case_id: caseId,
    rho,
    samples,
    points: rows.length,
    run_dir: path.relative(rootDir, runDir),
    mean_abs_direct_error: mean(absErrors),
    mean_direct_std_error: mean(stdErrors),
    mean_direct_error: mean(errors),
    rmse_direct_error: Math.sqrt(mean(errors.map((error) => error * error))),
  };
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeSummary(rows) {
  const columns = [
    "case_id",
    "rho",
    "samples",
    "points",
    "mean_abs_direct_error",
    "mean_direct_std_error",
    "mean_direct_error",
    "rmse_direct_error",
    "run_dir",
  ];
  const text = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ].join("\n") + "\n";
  fs.writeFileSync(summaryCsv, text);
}

function svgLinePlot({ title, data, xKey, yKey, width, height, x, y }) {
  const margin = { top: 32, right: 18, bottom: 46, left: 64 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;
  const xs = data.map((d) => d[xKey]);
  const ys = data.map((d) => d[yKey]);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const yMinRaw = Math.min(...ys);
  const yMaxRaw = Math.max(...ys);
  const yPad = (yMaxRaw - yMinRaw || Math.max(1, Math.abs(yMaxRaw))) * 0.12;
  const yMin = Math.max(0, yMinRaw - yPad);
  const yMax = yMaxRaw + yPad;
  const sx = (value) => x + margin.left + ((value - xMin) / (xMax - xMin || 1)) * plotW;
  const sy = (value) => y + margin.top + (1 - (value - yMin) / (yMax - yMin || 1)) * plotH;
  const points = data.map((d) => `${sx(d[xKey]).toFixed(2)},${sy(d[yKey]).toFixed(2)}`).join(" ");
  const xTicks = data.map((d) => d[xKey]);
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);

  const tickEls = [
    ...xTicks.map((tick) => `
      <line x1="${sx(tick).toFixed(2)}" y1="${y + margin.top + plotH}" x2="${sx(tick).toFixed(2)}" y2="${y + margin.top + plotH + 5}" stroke="#6b7280"/>
      <text x="${sx(tick).toFixed(2)}" y="${y + margin.top + plotH + 22}" text-anchor="middle" class="tick">${rhoText(tick)}</text>`),
    ...yTicks.map((tick) => `
      <line x1="${x + margin.left - 5}" y1="${sy(tick).toFixed(2)}" x2="${x + margin.left}" y2="${sy(tick).toFixed(2)}" stroke="#6b7280"/>
      <line x1="${x + margin.left}" y1="${sy(tick).toFixed(2)}" x2="${x + margin.left + plotW}" y2="${sy(tick).toFixed(2)}" stroke="#e5e7eb"/>
      <text x="${x + margin.left - 10}" y="${sy(tick).toFixed(2) + 4}" text-anchor="end" class="tick">${tick.toFixed(3)}</text>`),
  ].join("");

  const pointEls = data.map((d) => `
      <circle cx="${sx(d[xKey]).toFixed(2)}" cy="${sy(d[yKey]).toFixed(2)}" r="4" fill="#2563eb">
        <title>rho=${rhoText(d[xKey])}, value=${d[yKey].toFixed(6)}</title>
      </circle>`).join("");

  return `
    <g>
      <text x="${x + width / 2}" y="${y + 18}" text-anchor="middle" class="subtitle">${title}</text>
      <rect x="${x + margin.left}" y="${y + margin.top}" width="${plotW}" height="${plotH}" fill="#ffffff" stroke="#d1d5db"/>
      ${tickEls}
      <polyline points="${points}" fill="none" stroke="#2563eb" stroke-width="2"/>
      ${pointEls}
      <text x="${x + margin.left + plotW / 2}" y="${y + height - 8}" text-anchor="middle" class="axis">rho</text>
    </g>`;
}

function writeCasePlot(caseMeta, rows) {
  const width = 1080;
  const height = 560;
  const panelW = width / 2 - 36;
  const panelH = height - 86;
  const body = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #111827; }
    .title { font-size: 22px; font-weight: 650; }
    .subtitle { font-size: 16px; font-weight: 600; }
    .axis { font-size: 13px; fill: #374151; }
    .tick { font-size: 12px; fill: #4b5563; }
  </style>
  <rect width="100%" height="100%" fill="#f9fafb"/>
  <text x="${width / 2}" y="34" text-anchor="middle" class="title">${caseMeta.title}: rho sweep with full prior, N=${samples}</text>
  ${svgLinePlot({
    title: "mean(abs(Direct_Error))",
    data: rows,
    xKey: "rho",
    yKey: "mean_abs_direct_error",
    width: panelW,
    height: panelH,
    x: 26,
    y: 58,
  })}
  ${svgLinePlot({
    title: "mean(Direct_StdError)",
    data: rows,
    xKey: "rho",
    yKey: "mean_direct_std_error",
    width: panelW,
    height: panelH,
    x: width / 2 + 10,
    y: 58,
  })}
</svg>
`;
  const plotPath = path.join(outputRoot, `${caseMeta.id}_rho_sweep.svg`);
  fs.writeFileSync(plotPath, body);
  return plotPath;
}

async function main() {
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });

  console.log(`sweep mode: ${sweepMode}`);
  console.log(`samples: ${samples}`);
  console.log(`output: ${outputRoot}`);
  for (const caseMeta of cases) {
    const { start, end } = caseRhoRange(caseMeta);
    if (end < start) throw new Error(`${caseMeta.id} rho range end must be >= start`);
    console.log(`${caseMeta.id} rho values: ${rhoValues(start, end).map(rhoText).join(", ")}`);
  }

  await runStreaming("cmake", ["-S", rootDir, "-B", path.join(rootDir, "build-metal"), "-DCMAKE_BUILD_TYPE=Release"]);
  await runStreaming("cmake", ["--build", path.join(rootDir, "build-metal"), "--target", "random_walker_metal", "--parallel"]);

  const rows = [];
  for (const caseMeta of cases) {
    const { start, end } = caseRhoRange(caseMeta);
    const rhos = rhoValues(start, end);
    for (const rho of rhos) {
      const { configPath, runDir } = makeConfig(caseMeta.id, rho);
      const directCsv = path.join(runDir, "direct.csv");
      if (reuseExisting && fs.existsSync(directCsv)) {
        console.log(`\nReusing ${path.relative(rootDir, directCsv)}`);
      } else {
        removeRunDir(runDir);
        fs.mkdirSync(runDir, { recursive: true });
        const logPath = path.join(runDir, "last_random_walker_metal.log");
        await runStreaming(
          path.join(rootDir, "build-metal", "random_walker_metal"),
          [configPath, String(samples), threadsPerThreadgroup],
          { logPath },
        );
      }
      rows.push(summarizeDirectCsv(caseMeta.id, rho, runDir));
      writeSummary(rows);
    }
  }

  const plotPaths = [];
  for (const caseMeta of cases) {
    const caseRows = rows.filter((row) => row.case_id === caseMeta.id);
    plotPaths.push(writeCasePlot(caseMeta, caseRows));
  }

  console.log("\nSummary written to:");
  console.log(`  ${summaryCsv}`);
  console.log("Plots written to:");
  for (const plotPath of plotPaths) console.log(`  ${plotPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
