#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TARGET_DIRS = [
  "outputs/pirw_case1",
  "outputs/pirw_case2",
  "outputs/pirw_case3",
  "outputs/fastrw_case1_dof2856_n2500",
  "outputs/fastrw_case2_dof2779_n2500",
  "outputs/fastrw_case3_dof2841_n2500",
];

const VAR_COLUMNS = ["Direct_SampleVar", "Direct_MeanVar", "Direct_StdError"];

function parseCsv(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) throw new Error(`Empty CSV: ${file}`);
  const lines = text.split(/\r?\n/);
  const header = lines.shift().split(",");
  const rows = lines.filter(Boolean).map((line) => line.split(","));
  return { header, rows };
}

function formatNumber(value) {
  if (!Number.isFinite(value)) return "";
  return Number(value.toPrecision(15)).toString();
}

function varianceColumns(samples) {
  const n = samples.length;
  const mean = samples.reduce((sum, value) => sum + value, 0) / n;
  let sampleVar = 0;
  if (n > 1) {
    let squaredDiffSum = 0;
    for (const value of samples) {
      const diff = value - mean;
      squaredDiffSum += diff * diff;
    }
    sampleVar = squaredDiffSum / (n - 1);
  }
  const meanVar = sampleVar / n;
  return {
    Direct_SampleVar: sampleVar,
    Direct_MeanVar: meanVar,
    Direct_StdError: Math.sqrt(meanVar),
  };
}

function buildHeader(header) {
  const filtered = header.filter((name) => !VAR_COLUMNS.includes(name));
  const directErrorIndex = filtered.indexOf("Direct_Error");
  if (directErrorIndex < 0) {
    throw new Error(`direct.csv is missing Direct_Error column`);
  }
  filtered.splice(directErrorIndex + 1, 0, ...VAR_COLUMNS);
  return filtered;
}

function backfillRun(runDirRel) {
  const runDir = path.join(ROOT, runDirRel);
  const directPath = path.join(runDir, "direct.csv");
  const constraintsPath = path.join(runDir, "constraints.json");
  if (!fs.existsSync(directPath)) throw new Error(`Missing ${directPath}`);
  if (!fs.existsSync(constraintsPath)) throw new Error(`Missing ${constraintsPath}`);

  const { header, rows } = parseCsv(directPath);
  const data = JSON.parse(fs.readFileSync(constraintsPath, "utf8"));
  if (!Array.isArray(data.obs_data)) throw new Error(`${constraintsPath} is missing obs_data`);
  if (rows.length !== data.M) {
    throw new Error(`${directPath} row count ${rows.length} does not match M=${data.M}`);
  }
  if (data.obs_data.length !== data.N) {
    throw new Error(`${constraintsPath} obs_data length ${data.obs_data.length} does not match N=${data.N}`);
  }

  const oldIndex = Object.fromEntries(header.map((name, i) => [name, i]));
  const newHeader = buildHeader(header);
  const outLines = [newHeader.join(",")];

  for (let i = 0; i < rows.length; i++) {
    const samples = data.obs_data.map((sampleRow, n) => {
      if (!Array.isArray(sampleRow) || sampleRow.length !== data.M) {
        throw new Error(`${constraintsPath} obs_data[${n}] has invalid width`);
      }
      const value = Number(sampleRow[i]);
      if (!Number.isFinite(value)) {
        throw new Error(`${constraintsPath} obs_data[${n}][${i}] is not finite`);
      }
      return value;
    });
    const stats = varianceColumns(samples);
    const outRow = newHeader.map((name) => {
      if (Object.prototype.hasOwnProperty.call(stats, name)) return formatNumber(stats[name]);
      const idx = oldIndex[name];
      return idx === undefined ? "" : rows[i][idx];
    });
    outLines.push(outRow.join(","));
  }

  fs.writeFileSync(directPath, `${outLines.join("\n")}\n`);
  console.log(`Backfilled ${path.relative(ROOT, directPath)} with N=${data.N}, M=${data.M}`);
}

function main() {
  for (const runDir of TARGET_DIRS) backfillRun(runDir);
}

main();
