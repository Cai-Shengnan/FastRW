#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

function usage() {
  console.error("Usage: run_onestage_fusion.js <run_dir> [constraints_json] [direct_csv]");
}

function readCsv(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const header = lines.shift().split(",");
  return lines.filter(Boolean).map((line) => {
    const values = line.split(",");
    const row = {};
    header.forEach((key, i) => {
      const value = values[i];
      row[key] = value === undefined || value === "" ? value : Number(value);
    });
    return row;
  });
}

function writeCsv(file, rows, header) {
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => row[key]).join(","));
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1);
}

function summarizeErrors(rows, errorKey) {
  const errors = rows.map((row) => row[errorKey]);
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
      throw new Error(`Singular Onestage system at column ${col}`);
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

function computeFusion(data, includeSelf) {
  const M = data.M;
  const N = data.N;
  const obs = data.obs_data;
  const eps = 1e-12;
  const sigma = [];
  for (let i = 0; i < M; i++) {
    sigma[i] = Math.sqrt(Math.max(variance(obs.map((row) => row[i])), eps));
  }

  const precision = Array.from({ length: M }, () => Array(M).fill(0));
  const rhs = Array(M).fill(0);

  for (let i = 0; i < M; i++) {
    const w = 1 / Math.max(sigma[i] * sigma[i], eps);
    for (let n = 0; n < N; n++) {
      precision[i][i] += w;
      rhs[i] += w * obs[n][i];
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
    if (i === j) selfConstraints++;
    if (!includeSelf && i === j) continue;
    const alpha = data.alpha_k[k];
    const tau2 = Math.max(sigma[i] * sigma[i] + alpha * alpha * sigma[j] * sigma[j], eps);
    const w = 1 / tau2;
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

function buildRows(directRows, data, fusion) {
  return directRows.map((raw, i) => {
    const row = normalizeDirectRow(raw);
    const fused = fusion.theta[i];
    const ref = row.GT_Temperature;
    const sampleStd = fusion.sigma[i];
    return {
      Point: row.Point,
      X: row.X,
      Y: row.Y,
      Z: row.Z,
      Direct_Mean: row.Direct_Mean,
      Fused_Mean: fused,
      GT_Temperature: ref,
      Direct_Error: row.Direct_Mean - ref,
      Fused_Error: fused - ref,
      Direct_SampleStd: sampleStd,
      Direct_StdError: sampleStd / Math.sqrt(data.N),
      Avg_Steps: row.Avg_Steps,
    };
  });
}

function main() {
  const [, , runDirArg, constraintsArg, directArg] = process.argv;
  if (!runDirArg) {
    usage();
    process.exit(2);
  }
  const runDir = path.resolve(runDirArg);
  const constraintsPath = constraintsArg
    ? path.resolve(constraintsArg)
    : path.join(runDir, "constraints.json");
  const directPath = directArg
    ? path.resolve(directArg)
    : path.join(runDir, "direct.csv");
  const data = JSON.parse(fs.readFileSync(constraintsPath, "utf8"));
  const directRows = readCsv(directPath);
  if (directRows.length !== data.M) {
    throw new Error(`Direct CSV point count ${directRows.length} does not match constraints M=${data.M}`);
  }

  const withSelf = computeFusion(data, true);
  const noSelf = computeFusion(data, false);
  const header = [
    "Point", "X", "Y", "Z", "Direct_Mean", "Fused_Mean", "GT_Temperature",
    "Direct_Error", "Fused_Error", "Direct_SampleStd", "Direct_StdError", "Avg_Steps",
  ];
  const withRows = buildRows(directRows, data, withSelf);
  const noRows = buildRows(directRows, data, noSelf);
  writeCsv(path.join(runDir, "onestage_with_self.csv"), withRows, header);
  writeCsv(path.join(runDir, "onestage_no_self.csv"), noRows, header);

  const summary = {
    run_dir: runDir,
    constraints: {
      path: constraintsPath,
      M: data.M,
      N: data.N,
      K: data.K,
      self_constraints: data.self_constraints ?? withSelf.selfConstraints,
      pass_overflow_paths: data.pass_overflow_paths ?? 0,
    },
    direct: summarizeErrors(buildRows(directRows, data, { ...withSelf, theta: directRows.map((r) => normalizeDirectRow(r).Direct_Mean) }), "Direct_Error"),
    onestage_with_self: {
      used_constraints: withSelf.usedConstraints,
      ...summarizeErrors(withRows, "Fused_Error"),
    },
    onestage_no_self: {
      used_constraints: noSelf.usedConstraints,
      ...summarizeErrors(noRows, "Fused_Error"),
    },
  };
  fs.writeFileSync(path.join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
