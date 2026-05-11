#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

const cases = {
  case1: {
    label: "case1_power6",
    baseConfig: path.join(rootDir, "configs", "case1_power6.json"),
    initialRhos: [1.5, 1.55, 1.6],
  },
  case2: {
    label: "case2_4core",
    baseConfig: path.join(rootDir, "configs", "case2_4core.json"),
    initialRhos: [1.5, 1.55],
  },
  case3: {
    label: "case3_16core_comsol_new",
    baseConfig: path.join(rootDir, "configs", "case3_16core.json"),
    initialRhos: [1.5, 1.55, 1.5625],
    dataOverride: {
      ground_truth_path: path.join(rootDir, "outputs", "comsol_case3_rebuild", "heat_layer_cell_center_temperatures.bin"),
      temperature_offset: 0,
    },
  },
};

function usage() {
  console.error([
    "Usage: run_rho_bisection.js [options]",
    "",
    "Options:",
    "  --case=<name>        case1, case2, case3, or all. Default: all",
    "  --samples=<n>        Samples per point. Default: 400",
    "  --seed=<n>           Deterministic seed. Default: 20260624",
    "  --threads=<n>        Metal threads per threadgroup. Default: -1",
    "  --tolerance=<rho>    Stop when bracket width <= tolerance. Default: 0.01",
    "  --output-root=<dir>  Default: outputs/rho_bisection_cases_20260509",
    "  --skip-build         Reuse build-metal/random_walker_metal",
    "  --resume             Reuse completed run directories under output-root",
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    caseName: "all",
    samples: 400,
    seed: 20260624,
    threads: -1,
    tolerance: 0.01,
    outputRoot: path.join(rootDir, "outputs", "rho_bisection_cases_20260509"),
    skipBuild: false,
    resume: false,
  };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") usage();
    if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--resume") {
      options.resume = true;
    } else if (arg.startsWith("--case=")) {
      options.caseName = arg.slice("--case=".length);
    } else if (arg.startsWith("--samples=")) {
      options.samples = Number(arg.slice("--samples=".length));
    } else if (arg.startsWith("--seed=")) {
      options.seed = Number(arg.slice("--seed=".length));
    } else if (arg.startsWith("--threads=")) {
      options.threads = Number(arg.slice("--threads=".length));
    } else if (arg.startsWith("--tolerance=")) {
      options.tolerance = Number(arg.slice("--tolerance=".length));
    } else if (arg.startsWith("--output-root=")) {
      options.outputRoot = path.resolve(arg.slice("--output-root=".length));
    } else {
      usage();
    }
  }

  if (options.caseName !== "all" && !(options.caseName in cases)) {
    throw new Error(`Unknown case: ${options.caseName}`);
  }
  if (!Number.isInteger(options.samples) || options.samples <= 0) {
    throw new Error("--samples must be a positive integer.");
  }
  if (!Number.isInteger(options.seed) || options.seed < 0) {
    throw new Error("--seed must be a non-negative integer.");
  }
  if (!Number.isFinite(options.tolerance) || options.tolerance <= 0) {
    throw new Error("--tolerance must be positive.");
  }
  return options;
}

function condaRunner() {
  if (process.env.CONDA_DEFAULT_ENV === "FastRW") return [];
  const conda = spawnSync("conda", ["env", "list"], { encoding: "utf8" });
  if (conda.status === 0 && /^\s*FastRW\s/m.test(conda.stdout)) {
    return ["conda", "run", "-n", "FastRW", "--no-capture-output"];
  }
  return [];
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    stdio: options.stdio || "inherit",
    encoding: options.encoding,
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
  }
  return result;
}

function buildMetal() {
  const runner = condaRunner();
  runCommand(runner[0] || "cmake", [
    ...runner.slice(1),
    ...(runner.length ? ["cmake"] : []),
    "-S",
    rootDir,
    "-B",
    path.join(rootDir, "build-metal"),
    "-DCMAKE_BUILD_TYPE=Release",
  ]);
  runCommand(runner[0] || "cmake", [
    ...runner.slice(1),
    ...(runner.length ? ["cmake"] : []),
    "--build",
    path.join(rootDir, "build-metal"),
    "--target",
    "random_walker_metal",
    "--parallel",
  ]);
}

function tag(value) {
  return Number(value).toFixed(8).replace(/0+$/, "").replace(/\.$/, "").replace(".", "p");
}

function resolveConfigPath(configPath, rawPath) {
  if (!rawPath || path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(path.dirname(configPath), rawPath);
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

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(runDir) {
  const rows = readCsv(path.join(runDir, "FastRw.csv"));
  const errors = rows.map((row) => row.Error);
  const absErrors = errors.map(Math.abs);
  const steps = rows.map((row) => row.Avg_Steps);
  const summary = {
    avg_signed_error: mean(errors),
    avg_abs_error: mean(absErrors),
    rmse: Math.sqrt(mean(errors.map((value) => value * value))),
    negative_error_count: errors.filter((value) => value < 0).length,
    avg_steps: mean(steps),
  };

  const diagnosticsPath = path.join(runDir, "diagnostics.json");
  if (fs.existsSync(diagnosticsPath)) {
    const diagnostics = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8"));
    const points = diagnostics.point_diagnostics || [];
    if (points.length) {
      const component = (name) => mean(points.map((point) => point.components[name]));
      summary.T0_heat = component("T0_heat");
      summary.T1_tail = component("T1_tail_or_dirichlet");
      summary.T3_robin = component("T3_robin");
      summary.heat_unweighted = mean(points.map((point) => point.heat.T0_unweighted_mean));
      summary.avg_e_hat_on_heat = mean(points.map((point) => point.heat.avg_e_hat_on_heat));
      summary.local_time = mean(points.map((point) => point.robin.effective_local_time_mean));
      summary.final_e_hat = mean(points.map((point) => point.final_e_hat_mean));
    }
  }
  return summary;
}

function makeConfig(caseSpec, rho, options, runDir) {
  const config = JSON.parse(fs.readFileSync(caseSpec.baseConfig, "utf8"));
  const deltaX = config.walker?.delta_x ?? 5e-7;
  config.case_name = `${caseSpec.label}_rho${tag(rho)}`;
  config.data = {
    ...(config.data || {}),
    power_density_path: resolveConfigPath(caseSpec.baseConfig, config.data && config.data.power_density_path),
    ground_truth_path: resolveConfigPath(caseSpec.baseConfig, config.data && config.data.ground_truth_path),
    ...(caseSpec.dataOverride || {}),
  };
  config.boundary = {
    ...(config.boundary || {}),
    epsilon: {
      ...((config.boundary && config.boundary.epsilon) || {}),
      robin: rho * deltaX,
    },
  };
  config.walker = {
    ...(config.walker || {}),
    tail_mode: "gt",
    diagnostics: { ...((config.walker && config.walker.diagnostics) || {}), enabled: true },
  };
  config.run = {
    ...(config.run || {}),
    num_samples: options.samples,
    num_workers: options.threads,
    seed: options.seed,
  };
  config.output = {
    ...(config.output || {}),
    directory: runDir,
    csv: "FastRw.csv",
    constraints: "data.json",
    diagnostics: "diagnostics.json",
  };
  return config;
}

function evaluate(caseKey, caseSpec, rho, options, executable) {
  const runDir = path.join(options.outputRoot, caseSpec.label, `rho${tag(rho)}`);
  const summaryPath = path.join(runDir, "summary.json");
  if (options.resume && fs.existsSync(summaryPath)) {
    const cached = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
    console.log(`[rho-bisect] reuse ${caseSpec.label} rho=${rho}`);
    return cached;
  }

  fs.mkdirSync(runDir, { recursive: true });
  const config = makeConfig(caseSpec, rho, options, runDir);
  const configPath = path.join(runDir, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  console.log(`[rho-bisect] run ${caseSpec.label} rho=${rho} samples=${options.samples}`);
  const command = [executable, configPath, String(options.samples), String(options.threads)];
  const result = spawnSync(command[0], command.slice(1), {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 128,
  });
  fs.writeFileSync(path.join(runDir, "command.log"), [
    `$ ${command.join(" ")}`,
    result.stdout || "",
    result.stderr || "",
  ].join("\n"));
  if (result.status !== 0) {
    throw new Error(`RW failed for ${caseSpec.label} rho=${rho}; see ${path.join(runDir, "command.log")}`);
  }

  const summary = {
    case: caseKey,
    case_label: caseSpec.label,
    rho_over_delta: rho,
    epsilon_robin: rho * (config.walker?.delta_x ?? 5e-7),
    samples: options.samples,
    seed: options.seed,
    run_dir: runDir,
    ...summarize(runDir),
  };
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function sign(value) {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

function findBracket(values) {
  const ordered = [...values].sort((a, b) => a.rho_over_delta - b.rho_over_delta);
  for (let i = 0; i + 1 < ordered.length; i++) {
    if (sign(ordered[i].avg_signed_error) === 0) return [ordered[i], ordered[i]];
    if (sign(ordered[i].avg_signed_error) !== sign(ordered[i + 1].avg_signed_error)) {
      return [ordered[i], ordered[i + 1]];
    }
  }
  return null;
}

function runCase(caseKey, options, executable) {
  const caseSpec = cases[caseKey];
  const seen = new Map();
  const values = [];

  const add = (rho) => {
    const key = tag(rho);
    if (!seen.has(key)) {
      const result = evaluate(caseKey, caseSpec, rho, options, executable);
      seen.set(key, result);
      values.push(result);
    }
    return seen.get(key);
  };

  for (const rho of caseSpec.initialRhos) add(rho);

  let bracket = findBracket(values);
  const expansion = [1.45, 1.65, 1.7, 1.8, 2.0, 1.3, 1.2];
  for (const rho of expansion) {
    if (bracket) break;
    add(rho);
    bracket = findBracket(values);
  }
  if (!bracket) {
    throw new Error(`Could not bracket zero signed error for ${caseSpec.label}`);
  }

  let [lo, hi] = bracket[0].rho_over_delta < bracket[1].rho_over_delta ? bracket : [bracket[1], bracket[0]];
  while ((hi.rho_over_delta - lo.rho_over_delta) > options.tolerance) {
    const midRho = 0.5 * (lo.rho_over_delta + hi.rho_over_delta);
    const mid = add(midRho);
    if (sign(mid.avg_signed_error) === 0) {
      lo = mid;
      hi = mid;
      break;
    }
    if (sign(mid.avg_signed_error) === sign(lo.avg_signed_error)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  const ordered = [...values].sort((a, b) => a.rho_over_delta - b.rho_over_delta);
  const best = ordered.reduce((current, candidate) =>
    Math.abs(candidate.avg_signed_error) < Math.abs(current.avg_signed_error) ? candidate : current,
    ordered[0]);
  return {
    case: caseKey,
    case_label: caseSpec.label,
    bracket_low: lo.rho_over_delta,
    bracket_low_error: lo.avg_signed_error,
    bracket_high: hi.rho_over_delta,
    bracket_high_error: hi.avg_signed_error,
    bracket_width: hi.rho_over_delta - lo.rho_over_delta,
    best_rho_over_delta: best.rho_over_delta,
    best_error: best.avg_signed_error,
    best_rmse: best.rmse,
    best_run_dir: best.run_dir,
    evaluations: ordered,
  };
}

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((key) => row[key] ?? "").join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.skipBuild) buildMetal();

  const executable = path.join(rootDir, "build-metal", "random_walker_metal");
  if (!fs.existsSync(executable)) throw new Error(`Missing executable: ${executable}`);

  fs.mkdirSync(options.outputRoot, { recursive: true });
  const caseKeys = options.caseName === "all" ? Object.keys(cases) : [options.caseName];
  const results = caseKeys.map((caseKey) => runCase(caseKey, options, executable));
  const evaluations = results.flatMap((result) => result.evaluations);
  const bestRows = results.map(({ evaluations: _evaluations, ...result }) => result);

  writeCsv(path.join(options.outputRoot, "evaluations.csv"), evaluations, [
    "case_label", "rho_over_delta", "epsilon_robin", "samples", "seed",
    "avg_signed_error", "avg_abs_error", "rmse", "negative_error_count", "avg_steps",
    "T0_heat", "T1_tail", "T3_robin", "heat_unweighted", "avg_e_hat_on_heat",
    "local_time", "final_e_hat", "run_dir",
  ]);
  writeCsv(path.join(options.outputRoot, "best_rho.csv"), bestRows, [
    "case_label", "bracket_low", "bracket_low_error", "bracket_high", "bracket_high_error",
    "bracket_width", "best_rho_over_delta", "best_error", "best_rmse", "best_run_dir",
  ]);
  fs.writeFileSync(path.join(options.outputRoot, "summary.json"), `${JSON.stringify({ options, results }, null, 2)}\n`);
  console.log(JSON.stringify({ best: bestRows }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
