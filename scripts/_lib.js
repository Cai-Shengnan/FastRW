// _lib.js
// =====================================================================
// Shared helpers for the FastRW / FasterRW post-processors.
//
// Exports:
//   mulberry32(seed)                       -> deterministic RNG closure
//   readCsv(file)                          -> array of row objects (numeric)
//   mean(values), variance(values), std(values), quantile(values, q)
//   loadPriorAndPoints(configPath)         -> {prior, points, xy, priorPath}
//   cholesky(A), choleskySolve(L, b)
//   logDetFromCholesky(L), matVecMul(A, x)
//   rbfKernel(points, amp2, lengthscale)
//   addDiag(matrix, values)
//
// Notes:
//   * Node.js built-ins only (fs, path); no external deps.
//   * RNG: mulberry32 (32-bit deterministic). The same seed yields the
//     same draw stream on every machine and Node version.
//   * GP helpers (cholesky etc.) reproduce the implementation that
//     previously lived inside subsample_bootstrap_fusion.js, kept in a
//     shared module so PIRW / FastRW / FasterRW post-processors share
//     identical statistics.
// =====================================================================

"use strict";

const fs = require("fs");
const path = require("path");

// ---------- RNG ------------------------------------------------------
function mulberry32(seed) {
  let s = seed >>> 0;
  return function rand() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- CSV / stats ----------------------------------------------
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

function mean(values) {
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

function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// ---------- prior loader (matches the legacy schema) -----------------
function resolvePath(baseFile, maybeRelative) {
  return path.isAbsolute(maybeRelative)
    ? maybeRelative
    : path.normalize(path.join(path.dirname(baseFile), maybeRelative));
}

function loadPriorAndPoints(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const g = config.geometry;
  const q = config.query_grid;
  const xy = g.xy_resolution;
  const zres = g.z_resolution;
  const nx = Math.round(g.x_size / xy);
  const ny = Math.round(g.y_size / xy);
  const nzBottom = Math.round((g.bottom_thickness - zres) / zres);
  const zHeatFirst = nzBottom + 1;
  const z = (q.z ?? (g.bottom_thickness + 0.5 * g.middle_thickness)) + (q.z_offset || 0);
  const tempPath = resolvePath(configPath, config.data.prior_temperature_path);
  const buf = fs.readFileSync(tempPath);
  const points = [];
  const prior = [];

  function tempAt(point) {
    const iz = Math.floor(point.z / zres) - zHeatFirst;
    const iy = Math.floor(point.y / xy);
    const ix = Math.floor(point.x / xy);
    return buf.readDoubleLE(((iz * ny + iy) * nx + ix) * 8) + (config.data.temperature_offset || 0);
  }

  for (const iy of q.y_indices) {
    for (const ix of q.x_indices) {
      const point = {
        x: ix * xy + (q.x_offset || 0),
        y: iy * xy + (q.y_offset || 0),
        z,
      };
      points.push(point);
      prior.push(tempAt(point));
    }
  }

  return { prior, points, xy, priorPath: tempPath };
}

// ---------- linear algebra ------------------------------------------
function cholesky(matrix) {
  const n = matrix.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) sum += L[i][k] * L[j][k];
      if (i === j) {
        const val = matrix[i][i] - sum;
        if (!(val > 0)) throw new Error("Cholesky: matrix is not positive definite");
        L[i][i] = Math.sqrt(val);
      } else {
        L[i][j] = (matrix[i][j] - sum) / L[j][j];
      }
    }
  }
  return L;
}

function choleskySolve(L, b) {
  const n = L.length;
  const y = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < i; k++) sum += L[i][k] * y[k];
    y[i] = (b[i] - sum) / L[i][i];
  }
  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = 0;
    for (let k = i + 1; k < n; k++) sum += L[k][i] * x[k];
    x[i] = (y[i] - sum) / L[i][i];
  }
  return x;
}

function logDetFromCholesky(L) {
  let sum = 0;
  for (let i = 0; i < L.length; i++) sum += Math.log(L[i][i]);
  return 2 * sum;
}

function matVecMul(a, x) {
  return a.map((row) => row.reduce((sum, value, j) => sum + value * x[j], 0));
}

function rbfKernel(points, amp2, lengthscale) {
  return points.map((pi) =>
    points.map((pj) => {
      const dx = pi.x - pj.x;
      const dy = pi.y - pj.y;
      const dz = pi.z - pj.z;
      return amp2 * Math.exp(-(dx * dx + dy * dy + dz * dz) / (2 * lengthscale * lengthscale));
    })
  );
}

function addDiag(matrix, values) {
  return matrix.map((row, i) =>
    row.map((value, j) => value + (i === j ? values[i] : 0))
  );
}

module.exports = {
  mulberry32,
  readCsv,
  mean,
  variance,
  std,
  quantile,
  loadPriorAndPoints,
  cholesky,
  choleskySolve,
  logDetFromCholesky,
  matVecMul,
  rbfKernel,
  addDiag,
};
