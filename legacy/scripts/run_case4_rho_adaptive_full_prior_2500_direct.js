#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const caseId = process.env.CASE_ID || "case4_4core_top1_bottom0p5";
const title = process.env.CASE_TITLE || "Case 4";
const samples = Number(process.env.SAMPLES || 2500);
const coarseStart = Number(process.env.COARSE_START || 1.535);
const coarseEnd = Number(process.env.COARSE_END || 1.585);
const coarseStep = Number(process.env.COARSE_STEP || 0.005);
const fineStep = Number(process.env.FINE_STEP || 0.001);
const fineHalfWidth = Number(process.env.FINE_HALF_WIDTH || 0.005);
const threadsPerThreadgroup = process.env.THREADS_PER_THREADGROUP || "-1";
const reuseExisting = process.env.REUSE_EXISTING === "1";
const maxFineExpansions = Number(process.env.MAX_FINE_EXPANSIONS || 4);

function assertFinite(name, value) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
}

for (const [name, value] of [
  ["SAMPLES", samples],
  ["COARSE_START", coarseStart],
  ["COARSE_END", coarseEnd],
  ["COARSE_STEP", coarseStep],
  ["FINE_STEP", fineStep],
  ["FINE_HALF_WIDTH", fineHalfWidth],
  ["MAX_FINE_EXPANSIONS", maxFineExpansions],
]) {
  assertFinite(name, value);
}
if (samples <= 0) throw new Error("SAMPLES must be positive");
if (coarseStep <= 0 || fineStep <= 0 || fineHalfWidth <= 0) {
  throw new Error("Sweep steps and widths must be positive");
}
if (coarseEnd < coarseStart) throw new Error("COARSE_END must be >= COARSE_START");

function valuesBetween(start, end, step) {
  const values = [];
  const scale = Math.round(1 / step);
  const startInt = Math.round(start * scale);
  const endInt = Math.round(end * scale);
  for (let v = startInt; v <= endInt; v += 1) values.push(Number((v / scale).toFixed(12)));
  return values;
}

function rhoText(rho) {
  return rho.toFixed(3);
}

function rhoLabel(rho) {
  return `rho_${rhoText(rho).replace(".", "p")}`;
}

const outputRoot = path.join(rootDir, "outputs", `case4_rho_adaptive_full_prior_n${samples}`);
const configRoot = path.join(outputRoot, "configs");
const summaryCsv = path.join(outputRoot, "summary.csv");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

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
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${code ?? signal}`));
    });
  });
}

function makeConfig(rho) {
  const basePath = path.join(rootDir, "configs", `${caseId}.json`);
  const baseDir = path.dirname(basePath);
  const config = readJson(basePath);
  const runDir = path.join(outputRoot, caseId, rhoLabel(rho));
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
  config.output.directory = runDir;
  config.output.csv = "direct.csv";
  config.output.constraints = "constraints.json";
  config.output.diagnostics = "diagnostics.json";

  const configPath = path.join(configRoot, `${caseId}_${rhoLabel(rho)}.json`);
  writeJson(configPath, config);
  return { configPath, runDir };
}

function removeRunDir(runDir) {
  const resolved = path.resolve(runDir);
  const prefix = path.resolve(outputRoot) + path.sep;
  if (!resolved.startsWith(prefix)) {
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

function summarizeDirectCsv(rho, runDir, stage) {
  const rows = parseCsv(path.join(runDir, "direct.csv"));
  const errors = rows.map((row) => row.Direct_Error);
  const absErrors = errors.map(Math.abs);
  const stdErrors = rows.map((row) => row.Direct_StdError);
  return {
    case_id: caseId,
    stage,
    rho,
    samples,
    points: rows.length,
    mean_abs_direct_error: mean(absErrors),
    mean_direct_std_error: mean(stdErrors),
    mean_direct_error: mean(errors),
    rmse_direct_error: Math.sqrt(mean(errors.map((error) => error * error))),
    run_dir: path.relative(rootDir, runDir),
  };
}

function csvEscape(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeSummary(rows) {
  const byRho = new Map();
  for (const row of rows) byRho.set(row.rho, row);
  const uniqueRows = [...byRho.values()].sort((a, b) => a.rho - b.rho);
  const columns = [
    "case_id",
    "stage",
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
    ...uniqueRows.map((row) => columns.map((column) => csvEscape(row[column])).join(",")),
  ].join("\n") + "\n";
  fs.writeFileSync(summaryCsv, text);
}

function bestRow(rows) {
  return [...rows].sort((a, b) => a.mean_abs_direct_error - b.mean_abs_direct_error)[0];
}

function svgLinePlot({ title: plotTitle, data, xKey, yKey, width, height, x, y }) {
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
  const xTicks = data.filter((_, i) => i % Math.max(1, Math.ceil(data.length / 10)) === 0).map((d) => d[xKey]);
  if (!xTicks.includes(xMax)) xTicks.push(xMax);
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
      <circle cx="${sx(d[xKey]).toFixed(2)}" cy="${sy(d[yKey]).toFixed(2)}" r="${d.stage === "coarse" ? 3 : 4}" fill="${d.stage === "coarse" ? "#64748b" : "#2563eb"}">
        <title>rho=${rhoText(d[xKey])}, value=${d[yKey].toFixed(6)}, stage=${d.stage}</title>
      </circle>`).join("");
  return `
    <g>
      <text x="${x + width / 2}" y="${y + 18}" text-anchor="middle" class="subtitle">${plotTitle}</text>
      <rect x="${x + margin.left}" y="${y + margin.top}" width="${plotW}" height="${plotH}" fill="#ffffff" stroke="#d1d5db"/>
      ${tickEls}
      <polyline points="${points}" fill="none" stroke="#2563eb" stroke-width="2"/>
      ${pointEls}
      <text x="${x + margin.left + plotW / 2}" y="${y + height - 8}" text-anchor="middle" class="axis">rho</text>
    </g>`;
}

function writePlot(rows) {
  const data = [...rows].sort((a, b) => a.rho - b.rho);
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
  <text x="${width / 2}" y="34" text-anchor="middle" class="title">${title}: adaptive rho search with full prior, N=${samples}</text>
  ${svgLinePlot({
    title: "mean(abs(Direct_Error))",
    data,
    xKey: "rho",
    yKey: "mean_abs_direct_error",
    width: panelW,
    height: panelH,
    x: 26,
    y: 58,
  })}
  ${svgLinePlot({
    title: "mean(Direct_StdError)",
    data,
    xKey: "rho",
    yKey: "mean_direct_std_error",
    width: panelW,
    height: panelH,
    x: width / 2 + 10,
    y: 58,
  })}
</svg>
`;
  const plotPath = path.join(outputRoot, `${caseId}_rho_adaptive.svg`);
  fs.writeFileSync(plotPath, body);
  return plotPath;
}

async function runRho(rho, stage, rows) {
  const already = rows.find((row) => row.rho === rho);
  if (already) return already;
  const { configPath, runDir } = makeConfig(rho);
  const directCsv = path.join(runDir, "direct.csv");
  if (reuseExisting && fs.existsSync(directCsv)) {
    console.log(`\nReusing ${path.relative(rootDir, directCsv)}`);
  } else {
    removeRunDir(runDir);
    fs.mkdirSync(runDir, { recursive: true });
    await runStreaming(path.join(rootDir, "build-metal", "random_walker_metal"), [
      configPath,
      String(samples),
      threadsPerThreadgroup,
    ], {
      logPath: path.join(runDir, "last_random_walker_metal.log"),
    });
  }
  const row = summarizeDirectCsv(rho, runDir, stage);
  rows.push(row);
  writeSummary(rows);
  return row;
}

function expansionValues(best, minDone, maxDone) {
  const atLeft = Math.abs(best.rho - minDone) < fineStep * 0.5;
  const atRight = Math.abs(best.rho - maxDone) < fineStep * 0.5;
  if (!atLeft && !atRight) return [];
  if (atLeft) return valuesBetween(minDone - fineHalfWidth, minDone - fineStep, fineStep);
  return valuesBetween(maxDone + fineStep, maxDone + fineHalfWidth, fineStep);
}

async function main() {
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });
  console.log(`case: ${caseId}`);
  console.log(`samples: ${samples}`);
  console.log(`output: ${outputRoot}`);
  console.log(`coarse: ${coarseStart}-${coarseEnd} step ${coarseStep}`);
  console.log(`fine: best +/- ${fineHalfWidth} step ${fineStep}, expand on boundary`);

  await runStreaming("cmake", ["-S", rootDir, "-B", path.join(rootDir, "build-metal"), "-DCMAKE_BUILD_TYPE=Release"]);
  await runStreaming("cmake", ["--build", path.join(rootDir, "build-metal"), "--target", "random_walker_metal", "--parallel"]);

  const rows = [];
  const coarseValues = valuesBetween(coarseStart, coarseEnd, coarseStep);
  for (const rho of coarseValues) await runRho(rho, "coarse", rows);

  const coarseBest = bestRow(rows);
  console.log(`\nCoarse best rho=${rhoText(coarseBest.rho)} mean_abs=${coarseBest.mean_abs_direct_error.toFixed(6)}`);

  let fineStart = Number((coarseBest.rho - fineHalfWidth).toFixed(12));
  let fineEnd = Number((coarseBest.rho + fineHalfWidth).toFixed(12));
  let fineValues = valuesBetween(fineStart, fineEnd, fineStep);
  for (const rho of fineValues) await runRho(rho, "fine", rows);

  for (let i = 0; i < maxFineExpansions; i++) {
    const fineRows = rows.filter((row) => row.stage === "fine");
    const currentBest = bestRow(fineRows);
    const minDone = Math.min(...fineRows.map((row) => row.rho));
    const maxDone = Math.max(...fineRows.map((row) => row.rho));
    const extra = expansionValues(currentBest, minDone, maxDone)
      .filter((rho) => !rows.some((row) => row.rho === rho));
    if (extra.length === 0) break;
    console.log(`\nFine best at boundary rho=${rhoText(currentBest.rho)}; expanding ${rhoText(extra[0])}-${rhoText(extra[extra.length - 1])}`);
    for (const rho of extra) await runRho(rho, "fine", rows);
  }

  writeSummary(rows);
  const plotPath = writePlot(rows);
  const finalBest = bestRow(rows);
  const signedBest = [...rows].sort((a, b) => Math.abs(a.mean_direct_error) - Math.abs(b.mean_direct_error))[0];
  console.log("\nSummary written to:");
  console.log(`  ${summaryCsv}`);
  console.log("Plot written to:");
  console.log(`  ${plotPath}`);
  console.log("Best by mean(abs(Direct_Error)):");
  console.log(`  rho=${rhoText(finalBest.rho)} mean_abs=${finalBest.mean_abs_direct_error.toFixed(6)} mean_se=${finalBest.mean_direct_std_error.toFixed(6)} signed=${finalBest.mean_direct_error.toFixed(6)} rmse=${finalBest.rmse_direct_error.toFixed(6)}`);
  console.log("Best by signed mean error closest to zero:");
  console.log(`  rho=${rhoText(signedBest.rho)} signed=${signedBest.mean_direct_error.toFixed(6)} mean_abs=${signedBest.mean_abs_direct_error.toFixed(6)}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  process.exit(1);
});
