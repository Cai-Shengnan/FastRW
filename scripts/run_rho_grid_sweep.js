#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

const cases = {
  case1: {
    label: "case1_power6",
    baseConfig: path.join(rootDir, "configs", "case1_power6.json"),
  },
  case2: {
    label: "case2_4core",
    baseConfig: path.join(rootDir, "configs", "case2_4core.json"),
  },
  case3: {
    label: "case3_16core_comsol_new",
    baseConfig: path.join(rootDir, "configs", "case3_16core.json"),
    dataOverride: {
      ground_truth_path: path.join(rootDir, "outputs", "comsol_case3_rebuild", "heat_layer_cell_center_temperatures.bin"),
      temperature_offset: 0,
    },
  },
  case4: {
    label: "case4_4core_top1_bottom1",
    baseConfig: path.join(rootDir, "configs", "case4_4core_top1_bottom1.json"),
    dataOverride: {
      ground_truth_path: path.join(rootDir, "outputs", "comsol_case4_4core_top1_bottom1", "heat_layer_cell_center_temperatures.bin"),
      temperature_offset: 0,
    },
  },
  case5: {
    label: "case5_4core_top1_bottom0p5",
    baseConfig: path.join(rootDir, "configs", "case5_4core_top1_bottom0p5.json"),
    dataOverride: {
      ground_truth_path: path.join(rootDir, "outputs", "comsol_case5_4core_top1_bottom0p5", "heat_layer_cell_center_temperatures.bin"),
      temperature_offset: 0,
    },
  },
};
const defaultCaseKeys = ["case1", "case2", "case3"];

function usage() {
  console.error([
    "Usage: run_rho_grid_sweep.js [options]",
    "",
    "Options:",
    "  --samples=<n>        Samples per point. Default: 400",
    "  --seed=<n>           Deterministic seed. Default: 20260624",
    "  --threads=<n>        Metal threads per threadgroup. Default: -1",
    "  --ratios=<list>      Comma list, default: 1.52,1.53,...,1.58",
    "  --cases=<list>       Case keys. Default: case1,case2,case3",
    "  --output-root=<dir>  Default: outputs/rho_grid_sweep_cases_20260511",
    "  --skip-build         Reuse build-metal/random_walker_metal",
    "  --resume             Reuse completed run directories",
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    samples: 400,
    seed: 20260624,
    threads: -1,
    ratios: [1.52, 1.53, 1.54, 1.55, 1.56, 1.57, 1.58],
    caseKeys: defaultCaseKeys,
    outputRoot: path.join(rootDir, "outputs", "rho_grid_sweep_cases_20260511"),
    skipBuild: false,
    resume: false,
  };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") usage();
    if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--resume") {
      options.resume = true;
    } else if (arg.startsWith("--samples=")) {
      options.samples = Number(arg.slice("--samples=".length));
    } else if (arg.startsWith("--seed=")) {
      options.seed = Number(arg.slice("--seed=".length));
    } else if (arg.startsWith("--threads=")) {
      options.threads = Number(arg.slice("--threads=".length));
    } else if (arg.startsWith("--ratios=")) {
      options.ratios = arg.slice("--ratios=".length).split(",").map(Number);
    } else if (arg.startsWith("--cases=")) {
      options.caseKeys = arg.slice("--cases=".length).split(",").map((value) => value.trim()).filter(Boolean);
    } else if (arg.startsWith("--output-root=")) {
      options.outputRoot = path.resolve(arg.slice("--output-root=".length));
    } else {
      usage();
    }
  }

  if (!Number.isInteger(options.samples) || options.samples <= 0) throw new Error("--samples must be a positive integer.");
  if (!Number.isInteger(options.seed) || options.seed < 0) throw new Error("--seed must be a non-negative integer.");
  if (!Array.isArray(options.ratios) || options.ratios.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new Error("--ratios must contain positive numeric values.");
  }
  if (!Array.isArray(options.caseKeys) || options.caseKeys.length === 0) {
    throw new Error("--cases must contain at least one case key.");
  }
  for (const caseKey of options.caseKeys) {
    if (!cases[caseKey]) throw new Error(`Unknown case key: ${caseKey}. Available: ${Object.keys(cases).join(",")}`);
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
  if (result.status !== 0) throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
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
  return Number(value).toFixed(6).replace(/0+$/, "").replace(/\.$/, "").replace(".", "p");
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
  const summary = {
    avg_signed_error: mean(errors),
    avg_abs_error: mean(errors.map(Math.abs)),
    rmse: Math.sqrt(mean(errors.map((value) => value * value))),
    max_abs_error: Math.max(...errors.map(Math.abs)),
    negative_error_count: errors.filter((value) => value < 0).length,
    avg_steps: mean(rows.map((row) => row.Avg_Steps)),
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
    console.log(`[rho-grid] reuse ${caseSpec.label} rho=${rho}`);
    return JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  }

  fs.mkdirSync(runDir, { recursive: true });
  const config = makeConfig(caseSpec, rho, options, runDir);
  const configPath = path.join(runDir, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  console.log(`[rho-grid] run ${caseSpec.label} rho=${rho} samples=${options.samples}`);
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

function writeCsv(filePath, rows, columns) {
  const lines = [columns.join(",")];
  for (const row of rows) lines.push(columns.map((key) => row[key] ?? "").join(","));
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.skipBuild) buildMetal();

  const executable = path.join(rootDir, "build-metal", "random_walker_metal");
  if (!fs.existsSync(executable)) throw new Error(`Missing executable: ${executable}`);

  fs.mkdirSync(options.outputRoot, { recursive: true });
  const rows = [];
  const selectedCases = options.caseKeys.map((caseKey) => [caseKey, cases[caseKey]]);
  for (const [caseKey, caseSpec] of selectedCases) {
    for (const rho of options.ratios) {
      rows.push(evaluate(caseKey, caseSpec, rho, options, executable));
    }
  }

  const byRho = options.ratios.map((rho) => {
    const group = rows.filter((row) => Math.abs(row.rho_over_delta - rho) < 1e-12);
    return {
      rho_over_delta: rho,
      mean_signed_error: mean(group.map((row) => row.avg_signed_error)),
      mean_abs_signed_error: mean(group.map((row) => Math.abs(row.avg_signed_error))),
      mean_avg_abs_error: mean(group.map((row) => row.avg_abs_error)),
      mean_rmse: mean(group.map((row) => row.rmse)),
      max_abs_signed_error: Math.max(...group.map((row) => Math.abs(row.avg_signed_error))),
      max_rmse: Math.max(...group.map((row) => row.rmse)),
    };
  });

  const bestByCase = selectedCases.map(([caseKey]) => {
    const group = rows.filter((row) => row.case === caseKey);
    return group.reduce((best, row) => Math.abs(row.avg_signed_error) < Math.abs(best.avg_signed_error) ? row : best, group[0]);
  });
  const bestOverallAbsSigned = byRho.reduce((best, row) =>
    row.mean_abs_signed_error < best.mean_abs_signed_error ? row : best, byRho[0]);
  const bestOverallMeanRmse = byRho.reduce((best, row) =>
    row.mean_rmse < best.mean_rmse ? row : best, byRho[0]);

  const columns = [
    "case_label", "rho_over_delta", "epsilon_robin", "samples", "seed",
    "avg_signed_error", "avg_abs_error", "rmse", "max_abs_error", "negative_error_count", "avg_steps",
    "T0_heat", "T1_tail", "T3_robin", "heat_unweighted", "avg_e_hat_on_heat",
    "local_time", "final_e_hat", "run_dir",
  ];
  writeCsv(path.join(options.outputRoot, "evaluations.csv"), rows, columns);
  writeCsv(path.join(options.outputRoot, "by_rho.csv"), byRho, [
    "rho_over_delta", "mean_signed_error", "mean_abs_signed_error", "mean_avg_abs_error",
    "mean_rmse", "max_abs_signed_error", "max_rmse",
  ]);
  writeCsv(path.join(options.outputRoot, "best_by_case.csv"), bestByCase, columns);
  fs.writeFileSync(path.join(options.outputRoot, "summary.json"), `${JSON.stringify({
    options,
    rows,
    by_rho: byRho,
    best_by_case: bestByCase,
    best_overall_abs_signed: bestOverallAbsSigned,
    best_overall_mean_rmse: bestOverallMeanRmse,
  }, null, 2)}\n`);

  console.log(JSON.stringify({
    best_by_case: bestByCase.map((row) => ({
      case: row.case_label,
      rho: row.rho_over_delta,
      avg_signed_error: row.avg_signed_error,
      rmse: row.rmse,
    })),
    best_overall_abs_signed: bestOverallAbsSigned,
    best_overall_mean_rmse: bestOverallMeanRmse,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
