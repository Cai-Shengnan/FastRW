#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const EXE = fs.existsSync(path.join(ROOT, "build-metal", "random_walker_metal"))
  ? path.join(ROOT, "build-metal", "random_walker_metal")
  : path.join(ROOT, "build", "random_walker_metal");
const OUT_DIR = path.join(ROOT, "outputs", "fusion_diagnostics", "comsol_prior_sweep");
const RUN_ROOT = path.join(OUT_DIR, "runs");
const CONFIG_ROOT = path.join(OUT_DIR, "configs");
const EPS = 1e-12;
const QUERY_INDICES = [10, 20, 30, 40];
const LENGTHSCALE_CELLS = [1, 2, 4, 8, 12, 20, 40];
const AMP_FACTORS = [0.001, 0.003, 0.01, 0.03, 0.1, 0.3, 1, 3, 10];
const METHODS = [
  "prior only",
  "PIRW direct",
  "FastRW direct",
  "FastRW + paper fusion, no-self constraints",
  "FastRW + paper fusion + prior anchor, no-self constraints",
  "FastRW + smoothing residual, LOO selected",
  "FastRW + smoothing residual, best-MAE oracle",
];

const CASES = [
  {
    id: "case1_power6",
    label: "case1_power6",
    comsolDir: "data/cases/case1_power6/comsol",
    fastrwConfig: "configs/case1_power6.json",
    pirwConfig: "configs/pirw_case1_power6.json",
    legacyFastRw: {
      comso_10254: "outputs/fusion_diagnostics/case1_fastrw_schema2_full",
    },
    legacyPirw: "outputs/fusion_diagnostics/case1_spacing_sweep/s10_current/pirw_direct",
  },
  {
    id: "case2_4core_top1_bottom1",
    label: "case2_4core_top1_bottom1",
    comsolDir: "data/cases/case2_4core_top1_bottom1/comsol",
    fastrwConfig: "configs/case2_4core_top1_bottom1.json",
    pirwConfig: "configs/pirw_case2_4core_top1_bottom1.json",
    legacyFastRw: {
      comso_10433: "outputs/fusion_diagnostics/case2_fastrw_schema2_full",
    },
    legacyPirw: "outputs/fusion_diagnostics/comso4800_compare/case2/pirw",
  },
  {
    id: "case3_16core",
    label: "case3_16core",
    comsolDir: "data/cases/case3_16core/comsol",
    fastrwConfig: "configs/case3_16core.json",
    pirwConfig: "configs/pirw_case3_16core.json",
    legacyFastRw: {
      comso_10316: "outputs/fusion_diagnostics/case3_fastrw_schema2_full",
    },
    legacyPirw: "outputs/case3_16core/pirw",
  },
];

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const SKIP_RUN = args.has("--skip-run");

function readCsv(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines.shift());
  return lines.map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    for (let i = 0; i < header.length; i++) {
      const value = values[i] ?? "";
      row[header[i]] = value === "" ? "" : Number(value);
    }
    return row;
  });
}

function parseCsvLine(line) {
  const out = [];
  let value = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        value += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        value += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(value);
      value = "";
    } else {
      value += ch;
    }
  }
  out.push(value);
  return out;
}

function writeCsv(file, rows, header) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [header.join(",")];
  for (const row of rows) lines.push(header.map((key) => formatCsv(row[key])).join(","));
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

function formatCsv(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

function relativeToRoot(file) {
  return path.relative(ROOT, file);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function discoverPriors(caseSpec) {
  const comsolDir = path.join(ROOT, caseSpec.comsolDir);
  return fs.readdirSync(comsolDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("comso_") && name !== "comso_full")
    .map((name) => ({
      name,
      tempPath: path.join(comsolDir, name, "temp.bin"),
    }))
    .filter((prior) => fs.existsSync(prior.tempPath))
    .sort((a, b) => {
      const an = Number(a.name.replace(/^comso_/, ""));
      const bn = Number(b.name.replace(/^comso_/, ""));
      return (Number.isFinite(an) ? an : Infinity) - (Number.isFinite(bn) ? bn : Infinity) ||
        a.name.localeCompare(b.name);
    });
}

function prepareConfig(baseConfigPath, outConfigPath, outDir, priorPath, samples) {
  const baseAbs = path.join(ROOT, baseConfigPath);
  const config = readJson(baseAbs);
  config.data.power_density_path = resolvePath(baseAbs, config.data.power_density_path);
  config.data.prior_temperature_path = priorPath;
  config.data.reference_temperature_path = resolvePath(baseAbs, config.data.reference_temperature_path);
  config.query_grid.x_indices = QUERY_INDICES;
  config.query_grid.y_indices = QUERY_INDICES;
  config.run.num_samples = samples;
  config.run.seed = 42;
  config.output.directory = outDir;
  config.output.csv = "direct.csv";
  config.output.constraints = "constraints.json";
  config.output.diagnostics = "diagnostics.json";
  fs.mkdirSync(path.dirname(outConfigPath), { recursive: true });
  fs.writeFileSync(outConfigPath, `${JSON.stringify(config, null, 2)}\n`);
}

function isCompleteRun(runDir, expectedN) {
  const directPath = path.join(runDir, "direct.csv");
  const constraintsPath = path.join(runDir, "constraints.json");
  if (!fs.existsSync(directPath) || !fs.existsSync(constraintsPath)) return false;
  try {
    const rows = readCsv(directPath);
    const data = readJson(constraintsPath);
    return rows.length === 16 &&
      data.M === 16 &&
      data.N === expectedN &&
      Array.isArray(data.obs_data) &&
      data.obs_data.length === expectedN &&
      Array.isArray(data.i_k) &&
      Array.isArray(data.j_k) &&
      Array.isArray(data.alpha_k) &&
      Array.isArray(data.b_k);
  } catch {
    return false;
  }
}

function runIfNeeded(runDir, configPath, expectedN, reuseLog) {
  if (isCompleteRun(runDir, expectedN)) {
    reuseLog.push({ runDir, action: "reused" });
    console.log(`Reusing ${relativeToRoot(runDir)}`);
    return;
  }
  if (SKIP_RUN) {
    throw new Error(`Missing incomplete run with --skip-run: ${relativeToRoot(runDir)}`);
  }
  console.log(`Running ${relativeToRoot(configPath)} N=${expectedN}`);
  const result = spawnSync(EXE, [configPath, String(expectedN), "-1"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) throw new Error(`Run failed for ${configPath}`);
  if (!isCompleteRun(runDir, expectedN)) {
    throw new Error(`Run completed but output is incomplete: ${relativeToRoot(runDir)}`);
  }
  reuseLog.push({ runDir, action: "new" });
}

function readRun(runDir) {
  const rows = readCsv(path.join(runDir, "direct.csv"));
  const data = readJson(path.join(runDir, "constraints.json"));
  return {
    dir: runDir,
    rows,
    data,
    gt: rows.map((row) => row.GT_Temperature),
    direct: rows.map((row) => row.Direct_Mean ?? row.Normal_Mean),
    sampleVar: Array.from({ length: data.M }, (_, i) => variance(data.obs_data.map((row) => row[i]))),
  };
}

function meanVariances(run) {
  return run.sampleVar.map((value) => value / run.data.N);
}

function loadPriorAndPoints(configPath) {
  const config = readJson(configPath);
  const g = config.geometry;
  const q = config.query_grid;
  const xy = g.xy_resolution;
  const zres = g.z_resolution;
  const nx = Math.round(g.x_size / xy);
  const ny = Math.round(g.y_size / xy);
  const nzBottom = Math.round((g.bottom_thickness - zres) / zres);
  const zHeatFirst = nzBottom + 1;
  const z = (q.z ?? (g.bottom_thickness + 0.5 * g.middle_thickness)) + (q.z_offset || 0);
  const buf = fs.readFileSync(config.data.prior_temperature_path);
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
  return { prior, points, xy };
}

function metrics(caseSpec, prior, method, theta, gt, variances, extras = {}) {
  const errors = theta.map((value, i) => value - gt[i]);
  return {
    case: caseSpec.label,
    prior_name: prior.name,
    prior_path: prior.tempPath,
    method,
    avg_abs_error: mean(errors.map(Math.abs)),
    avg_signed_error: mean(errors),
    avg_variance: variances ? mean(variances) : 0,
    ...extras,
  };
}

function solveLinearSystem(matrix, rhs) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < EPS) throw new Error("Singular matrix");
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

function invertMatrix(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [
    ...row,
    ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  ]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    if (Math.abs(a[pivot][col]) < EPS) throw new Error("Singular matrix");
    if (pivot !== col) [a[pivot], a[col]] = [a[col], a[pivot]];
    const div = a[col][col];
    for (let c = 0; c < 2 * n; c++) a[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = a[r][col];
      if (factor === 0) continue;
      for (let c = col; c < 2 * n; c++) a[r][c] -= factor * a[col][c];
    }
  }
  return a.map((row) => row.slice(n));
}

function matMul(a, b) {
  const rows = a.length;
  const cols = b[0].length;
  const inner = b.length;
  const out = Array.from({ length: rows }, () => Array(cols).fill(0));
  for (let i = 0; i < rows; i++) {
    for (let k = 0; k < inner; k++) {
      if (a[i][k] === 0) continue;
      for (let j = 0; j < cols; j++) out[i][j] += a[i][k] * b[k][j];
    }
  }
  return out;
}

function matVecMul(a, x) {
  return a.map((row) => row.reduce((sum, value, j) => sum + value * x[j], 0));
}

function transpose(a) {
  return Array.from({ length: a[0].length }, (_, j) => a.map((row) => row[j]));
}

function addDiag(matrix, values) {
  return matrix.map((row, i) => row.map((value, j) => value + (i === j ? values[i] : 0)));
}

function diagMatrix(values) {
  return values.map((value, i) => values.map((_, j) => (i === j ? value : 0)));
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

function paperFusion(run, anchorCenter, includeSelf = false) {
  const M = run.data.M;
  const precision = Array.from({ length: M }, () => Array(M).fill(0));
  const rhs = Array(M).fill(0);
  const meanVar = meanVariances(run);

  for (let i = 0; i < M; i++) {
    const v = Math.max(meanVar[i], EPS);
    const w = 1 / v;
    precision[i][i] += w;
    rhs[i] += w * anchorCenter[i];
    const weakPriorW = 1 / (400 * 400);
    precision[i][i] += weakPriorW;
    rhs[i] += weakPriorW * 70;
  }

  let usedConstraints = 0;
  let selfConstraints = 0;
  for (let k = 0; k < run.data.K; k++) {
    const i = run.data.i_k[k] - 1;
    const j = run.data.j_k[k] - 1;
    if (i === j) selfConstraints++;
    if (!includeSelf && i === j) continue;
    const alpha = run.data.alpha_k[k];
    const tau2 = Math.max(run.sampleVar[i] + alpha * alpha * run.sampleVar[j], EPS);
    const w = 1 / tau2;
    const b = run.data.b_k[k];
    precision[i][i] += w;
    precision[i][j] -= w * alpha;
    precision[j][i] -= w * alpha;
    precision[j][j] += w * alpha * alpha;
    rhs[i] += w * b;
    rhs[j] -= w * alpha * b;
    usedConstraints++;
  }

  const theta = solveLinearSystem(precision, rhs);
  const cov = invertMatrix(precision);
  return {
    theta,
    variances: cov.map((row, i) => Math.max(row[i], 0)),
    usedConstraints,
    selfConstraints,
  };
}

function residualSmoothing(run, prior, points, xy, lengthscaleCells, ampFactor) {
  const meanVar = meanVariances(run);
  const residual = run.direct.map((value, i) => value - prior[i]);
  const amp2 = Math.max(variance(residual), 1e-6) * ampFactor;
  const lengthscale = lengthscaleCells * xy;
  const K = rbfKernel(points, amp2, lengthscale);
  const A = addDiag(K, meanVar.map((value) => Math.max(value, EPS)));
  const AInv = invertMatrix(A);
  const S = matMul(K, AInv);
  const smoothedResidual = matVecMul(S, residual);
  const theta = prior.map((value, i) => value + smoothedResidual[i]);
  const noiseDiag = diagMatrix(meanVar);
  const estimatorCov = matMul(matMul(S, noiseDiag), transpose(S));
  const variances = estimatorCov.map((row, i) => Math.max(row[i], 0));
  const looResiduals = residual.map((value, i) => {
    const fitted = smoothedResidual[i];
    const denom = Math.max(1 - S[i][i], EPS);
    return (value - fitted) / denom;
  });
  return {
    theta,
    variances,
    lengthscale_cells: lengthscaleCells,
    amp_factor: ampFactor,
    effective_df: S.reduce((sum, row, i) => sum + row[i], 0),
    loo_weighted_mse: mean(looResiduals.map((value, i) => value * value / Math.max(meanVar[i], EPS))),
  };
}

function makeRunPlan(caseSpec, prior) {
  const caseConfigDir = path.join(CONFIG_ROOT, caseSpec.id);
  const caseRunDir = path.join(RUN_ROOT, caseSpec.id);
  const legacyFast = caseSpec.legacyFastRw[prior.name]
    ? path.join(ROOT, caseSpec.legacyFastRw[prior.name])
    : null;
  const fastrwRunDir = legacyFast && isCompleteRun(legacyFast, 400)
    ? legacyFast
    : path.join(caseRunDir, prior.name, "fastrw");
  const fastrwConfig = path.join(caseConfigDir, `${prior.name}_fastrw.json`);
  const pirwRunDir = caseSpec.legacyPirw && isCompleteRun(path.join(ROOT, caseSpec.legacyPirw), 1000)
    ? path.join(ROOT, caseSpec.legacyPirw)
    : path.join(caseRunDir, "pirw");
  const pirwConfig = path.join(caseConfigDir, "pirw.json");
  return { fastrwRunDir, fastrwConfig, pirwRunDir, pirwConfig };
}

function writeCaseChart(caseSpec, rows) {
  const priors = [...new Set(rows.map((row) => row.prior_name))];
  const width = Math.max(1100, 170 + priors.length * 95);
  const left = 70;
  const top = 55;
  const plotW = width - left - 30;
  const panelH = 270;
  const gap = 105;
  const firstPanelY = top + 20;
  const secondPanelY = top + panelH + gap;
  const legendTop = secondPanelY + panelH + 105;
  const legendRowH = 22;
  const height = legendTop + METHODS.length * legendRowH + 28;
  const colors = {
    "prior only": "#1f77b4",
    "PIRW direct": "#ff7f0e",
    "FastRW direct": "#2ca02c",
    "FastRW + paper fusion, no-self constraints": "#d62728",
    "FastRW + paper fusion + prior anchor, no-self constraints": "#9467bd",
    "FastRW + smoothing residual, LOO selected": "#8c564b",
    "FastRW + smoothing residual, best-MAE oracle": "#17becf",
  };

  function panel(y, key, title) {
    const maxVal = Math.max(...rows.map((row) => row[key]), EPS);
    const groupW = plotW / priors.length;
    const barW = Math.max(2, (groupW - 14) / METHODS.length);
    const items = [];
    items.push(`<text x="${left}" y="${y - 22}" font-size="18" font-weight="700">${escapeXml(title)}</text>`);
    for (let i = 0; i <= 5; i++) {
      const yy = y + panelH - (i / 5) * panelH;
      const val = maxVal * i / 5;
      items.push(`<line x1="${left}" y1="${yy}" x2="${width - 30}" y2="${yy}" stroke="#ddd"/>`);
      items.push(`<text x="${left - 8}" y="${yy + 4}" text-anchor="end" font-size="11">${val.toExponential(2)}</text>`);
    }
    priors.forEach((priorName, p) => {
      const groupX = left + p * groupW + 7;
      METHODS.forEach((method, m) => {
        const row = rows.find((r) => r.prior_name === priorName && r.method === method);
        const value = row ? row[key] : 0;
        const h = (value / maxVal) * panelH;
        const x = groupX + m * barW;
        items.push(`<rect x="${x}" y="${y + panelH - h}" width="${Math.max(1, barW - 1)}" height="${h}" fill="${colors[method]}"><title>${escapeXml(`${priorName} / ${method}: ${value}`)}</title></rect>`);
      });
      items.push(`<text transform="translate(${left + p * groupW + groupW / 2},${y + panelH + 16}) rotate(45)" text-anchor="start" font-size="11">${escapeXml(priorName.replace("comso_", ""))}</text>`);
    });
    items.push(`<line x1="${left}" y1="${y + panelH}" x2="${width - 30}" y2="${y + panelH}" stroke="#333"/>`);
    items.push(`<line x1="${left}" y1="${y}" x2="${left}" y2="${y + panelH}" stroke="#333"/>`);
    return items.join("\n");
  }

  const legend = METHODS.map((method, i) => {
    const x = left;
    const y = legendTop + i * legendRowH;
    return `<rect x="${x}" y="${y - 11}" width="12" height="12" fill="${colors[method]}"/><text x="${x + 18}" y="${y}" font-size="12">${escapeXml(method)}</text>`;
  }).join("\n");
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="white"/>`,
    `<text x="${left}" y="28" font-size="22" font-weight="700">${escapeXml(caseSpec.label)} COMSOL prior sweep</text>`,
    panel(firstPanelY, "avg_abs_error", "Average absolute error"),
    panel(secondPanelY, "avg_variance", "Average estimator variance"),
    `<text x="${left}" y="${legendTop - 24}" font-size="14" font-weight="700">Legend</text>`,
    legend,
    "</svg>",
  ].join("\n");
  fs.writeFileSync(path.join(OUT_DIR, `${caseSpec.id}.svg`), svg);
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function main() {
  if (!fs.existsSync(EXE)) throw new Error(`Missing executable: ${EXE}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const summaryRows = [];
  const sweepRows = [];
  const runLog = [];

  for (const caseSpec of CASES) {
    const priors = discoverPriors(caseSpec);
    console.log(`${caseSpec.label}: discovered ${priors.length} priors`);
    if (DRY_RUN) {
      for (const prior of priors) console.log(`  ${prior.name} ${relativeToRoot(prior.tempPath)}`);
      continue;
    }

    const firstPlan = makeRunPlan(caseSpec, priors[0]);
    prepareConfig(caseSpec.pirwConfig, firstPlan.pirwConfig, firstPlan.pirwRunDir, path.join(ROOT, caseSpec.comsolDir, "comso_full", "temp.bin"), 1000);
    runIfNeeded(firstPlan.pirwRunDir, firstPlan.pirwConfig, 1000, runLog);
    const pirw = readRun(firstPlan.pirwRunDir);

    for (const prior of priors) {
      const plan = makeRunPlan(caseSpec, prior);
      prepareConfig(caseSpec.fastrwConfig, plan.fastrwConfig, plan.fastrwRunDir, prior.tempPath, 400);
      runIfNeeded(plan.fastrwRunDir, plan.fastrwConfig, 400, runLog);
      const fastrw = readRun(plan.fastrwRunDir);
      const { prior: priorValues, points, xy } = loadPriorAndPoints(plan.fastrwConfig);

      summaryRows.push(metrics(caseSpec, prior, "prior only", priorValues, fastrw.gt, Array(priorValues.length).fill(0), {
        variance_note: "deterministic",
      }));
      summaryRows.push(metrics(caseSpec, prior, "PIRW direct", pirw.direct, pirw.gt, meanVariances(pirw)));
      summaryRows.push(metrics(caseSpec, prior, "FastRW direct", fastrw.direct, fastrw.gt, meanVariances(fastrw)));

      const paper = paperFusion(fastrw, fastrw.direct, false);
      summaryRows.push(metrics(caseSpec, prior, "FastRW + paper fusion, no-self constraints", paper.theta, fastrw.gt, paper.variances, {
        used_constraints: paper.usedConstraints,
        self_constraints: paper.selfConstraints,
      }));

      const priorAnchor = paperFusion(fastrw, priorValues, false);
      summaryRows.push(metrics(caseSpec, prior, "FastRW + paper fusion + prior anchor, no-self constraints", priorAnchor.theta, fastrw.gt, priorAnchor.variances, {
        used_constraints: priorAnchor.usedConstraints,
        self_constraints: priorAnchor.selfConstraints,
      }));

      const currentSweep = [];
      for (const lengthscaleCells of LENGTHSCALE_CELLS) {
        for (const ampFactor of AMP_FACTORS) {
          const smooth = residualSmoothing(fastrw, priorValues, points, xy, lengthscaleCells, ampFactor);
          const row = metrics(caseSpec, prior, "FastRW + smoothing residual", smooth.theta, fastrw.gt, smooth.variances, {
            lengthscale_cells: smooth.lengthscale_cells,
            amp_factor: smooth.amp_factor,
            effective_df: smooth.effective_df,
            loo_weighted_mse: smooth.loo_weighted_mse,
          });
          currentSweep.push(row);
          sweepRows.push(row);
        }
      }

      const looSelected = currentSweep.slice().sort((a, b) => a.loo_weighted_mse - b.loo_weighted_mse)[0];
      summaryRows.push({ ...looSelected, method: "FastRW + smoothing residual, LOO selected" });
      const bestMae = currentSweep.slice().sort((a, b) => a.avg_abs_error - b.avg_abs_error)[0];
      summaryRows.push({ ...bestMae, method: "FastRW + smoothing residual, best-MAE oracle" });
    }
    writeCaseChart(caseSpec, summaryRows.filter((row) => row.case === caseSpec.label));
  }

  if (DRY_RUN) return;
  const summaryHeader = [
    "case", "prior_name", "prior_path", "method", "avg_abs_error", "avg_signed_error", "avg_variance",
    "variance_note", "used_constraints", "self_constraints", "lengthscale_cells", "amp_factor",
    "effective_df", "loo_weighted_mse",
  ];
  const sweepHeader = [
    "case", "prior_name", "prior_path", "method", "lengthscale_cells", "amp_factor", "effective_df",
    "loo_weighted_mse", "avg_abs_error", "avg_signed_error", "avg_variance",
  ];
  writeCsv(path.join(OUT_DIR, "summary.csv"), summaryRows, summaryHeader);
  writeCsv(path.join(OUT_DIR, "k_space_ablation.csv"), sweepRows, sweepHeader);
  writeCsv(path.join(OUT_DIR, "run_log.csv"), runLog.map((row) => ({
    action: row.action,
    run_dir: row.runDir,
  })), ["action", "run_dir"]);
  console.log(`Wrote ${relativeToRoot(path.join(OUT_DIR, "summary.csv"))}`);
  console.log(`Wrote ${relativeToRoot(path.join(OUT_DIR, "k_space_ablation.csv"))}`);
  console.log(`Wrote ${relativeToRoot(path.join(OUT_DIR, "run_log.csv"))}`);
}

main();
