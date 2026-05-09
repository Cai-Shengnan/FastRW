#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function std(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function readCsv(csvPath) {
  const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\n/).filter(Boolean);
  const header = lines.shift().split(",");
  return lines.map((line) => {
    const values = line.split(",");
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = Number(values[i]);
    return row;
  });
}

function summarize(runDir, csvName) {
  const csvPath = path.join(runDir, csvName);
  const dataPath = path.join(runDir, "data.json");
  const rows = readCsv(csvPath);
  const data = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, "utf8")) : null;

  const pointStats = rows.map((row, i) => {
    let sampleSd = null;
    let standardError = null;
    let zScore = null;
    if (data && Array.isArray(data.obs_data)) {
      const samples = data.obs_data.map((sampleRow) => sampleRow[i]);
      sampleSd = std(samples);
      standardError = sampleSd / Math.sqrt(samples.length);
      zScore = standardError > 0 ? row.Error / standardError : null;
    }
    return {
      point: row.Point,
      gt: row.GT_Temperature,
      mean: row.Normal_Mean,
      error: row.Error,
      abs_error: Math.abs(row.Error),
      avg_steps: row.Avg_Steps,
      sample_sd: sampleSd,
      standard_error: standardError,
      z_score: zScore,
    };
  });

  const errors = pointStats.map((p) => p.error);
  const absErrors = pointStats.map((p) => p.abs_error);
  const squaredErrors = errors.map((e) => e * e);
  const steps = pointStats.map((p) => p.avg_steps);
  const standardErrors = pointStats.map((p) => p.standard_error).filter((v) => v !== null);
  const zScores = pointStats.map((p) => p.z_score).filter((v) => v !== null);

  return {
    run_dir: runDir,
    csv: csvName,
    points: pointStats.length,
    samples: data ? data.N : null,
    avg_signed_error: mean(errors),
    avg_abs_error: mean(absErrors),
    rmse_error: Math.sqrt(mean(squaredErrors)),
    max_abs_error: Math.max(...absErrors),
    std_abs_error_across_points: std(absErrors),
    avg_steps: mean(steps),
    avg_standard_error: standardErrors.length ? mean(standardErrors) : null,
    rms_z_score: zScores.length ? Math.sqrt(mean(zScores.map((z) => z * z))) : null,
    max_abs_z_score: zScores.length ? Math.max(...zScores.map(Math.abs)) : null,
    negative_error_count: errors.filter((e) => e < 0).length,
    point_stats: pointStats,
  };
}

const [, , runDir, csvName = "FastRw.csv"] = process.argv;
if (!runDir) {
  console.error("Usage: summarize_rw_results.js <run_dir> [csv_name]");
  process.exit(2);
}

console.log(JSON.stringify(summarize(runDir, csvName), null, 2));
