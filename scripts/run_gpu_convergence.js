#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const defaultBaseConfig = path.join(rootDir, "configs", "case3_16core.json");
const defaultOutputRoot = path.join(rootDir, "outputs", "gpu_convergence", "case3");
const defaultSamples = [100, 200, 400, 800, 1600, 3200, 6400];

function usage() {
  console.error([
    "Usage: run_gpu_convergence.js [options]",
    "",
    "Options:",
    "  --base-config=<path>  Base JSON config. Default: configs/case3_16core.json",
    "  --output-root=<path>  Output directory. Default: outputs/gpu_convergence/case3",
    "  --samples=100,200    Sample ladder. Default: 100,200,400,800,1600,3200,6400",
    "  --repeats=<n>        Repeats per sample count. Default: 5",
    "  --base-seed=<n>      First deterministic seed. Default: 20260509",
    "  --threads=<n>        Metal threads per threadgroup. Default: -1",
    "  --skip-build         Reuse existing build-metal/random_walker_metal",
    "  --resume             Reuse run directories that already contain summary.json",
    "  --smoke              Shortcut for --samples=100 --repeats=2",
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    baseConfig: defaultBaseConfig,
    outputRoot: defaultOutputRoot,
    samples: defaultSamples,
    repeats: 5,
    baseSeed: 20260509,
    threads: -1,
    skipBuild: false,
    resume: false,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") usage();
    if (arg === "--skip-build") {
      options.skipBuild = true;
    } else if (arg === "--resume") {
      options.resume = true;
    } else if (arg === "--smoke") {
      options.samples = [100];
      options.repeats = 2;
    } else if (arg.startsWith("--base-config=")) {
      options.baseConfig = path.resolve(arg.slice("--base-config=".length));
    } else if (arg.startsWith("--output-root=")) {
      options.outputRoot = path.resolve(arg.slice("--output-root=".length));
    } else if (arg.startsWith("--samples=")) {
      options.samples = arg
        .slice("--samples=".length)
        .split(",")
        .filter(Boolean)
        .map((value) => Number(value));
    } else if (arg.startsWith("--repeats=")) {
      options.repeats = Number(arg.slice("--repeats=".length));
    } else if (arg.startsWith("--base-seed=")) {
      options.baseSeed = Number(arg.slice("--base-seed=".length));
    } else if (arg.startsWith("--threads=")) {
      options.threads = Number(arg.slice("--threads=".length));
    } else {
      usage();
    }
  }

  if (!fs.existsSync(options.baseConfig)) {
    throw new Error(`Base config does not exist: ${options.baseConfig}`);
  }
  if (!options.samples.length || options.samples.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error("All sample counts must be positive integers.");
  }
  if (!Number.isInteger(options.repeats) || options.repeats <= 0) {
    throw new Error("--repeats must be a positive integer.");
  }
  if (!Number.isInteger(options.baseSeed) || options.baseSeed < 0) {
    throw new Error("--base-seed must be a non-negative integer.");
  }
  if (!Number.isInteger(options.threads)) {
    throw new Error("--threads must be an integer.");
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
  const buildDir = path.join(rootDir, "build-metal");
  const runner = condaRunner();
  runCommand(runner[0] || "cmake", [
    ...runner.slice(1),
    ...(runner.length ? ["cmake"] : []),
    "-S",
    rootDir,
    "-B",
    buildDir,
    "-DCMAKE_BUILD_TYPE=Release",
  ]);
  runCommand(runner[0] || "cmake", [
    ...runner.slice(1),
    ...(runner.length ? ["cmake"] : []),
    "--build",
    buildDir,
    "--target",
    "random_walker_metal",
    "--parallel",
  ]);
}

function resolveConfigPath(baseConfigPath, rawPath) {
  if (!rawPath) return rawPath;
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(path.dirname(baseConfigPath), rawPath);
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

function std(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function summarizeRun(runDir, csvName = "FastRw.csv") {
  const rows = readCsv(path.join(runDir, csvName));
  const data = JSON.parse(fs.readFileSync(path.join(runDir, "data.json"), "utf8"));
  const pointStats = rows.map((row, i) => {
    const samples = data.obs_data.map((sampleRow) => sampleRow[i]);
    const sampleSd = std(samples);
    const standardError = sampleSd / Math.sqrt(samples.length);
    return {
      point: row.Point,
      gt: row.GT_Temperature,
      mean: row.Normal_Mean,
      error: row.Error,
      abs_error: Math.abs(row.Error),
      avg_steps: row.Avg_Steps,
      sample_sd: sampleSd,
      standard_error: standardError,
      z_score: standardError > 0 ? row.Error / standardError : null,
    };
  });
  const errors = pointStats.map((p) => p.error);
  const absErrors = pointStats.map((p) => p.abs_error);
  const zScores = pointStats.map((p) => p.z_score).filter((z) => z !== null);
  return {
    points: pointStats.length,
    samples: data.N,
    avg_signed_error: mean(errors),
    avg_abs_error: mean(absErrors),
    rmse_error: Math.sqrt(mean(errors.map((e) => e * e))),
    max_abs_error: Math.max(...absErrors),
    avg_steps: mean(pointStats.map((p) => p.avg_steps)),
    avg_standard_error: mean(pointStats.map((p) => p.standard_error)),
    rms_z_score: Math.sqrt(mean(zScores.map((z) => z * z))),
    negative_error_count: errors.filter((e) => e < 0).length,
    point_stats: pointStats,
  };
}

function linearRegression(xs, ys) {
  const xMean = mean(xs);
  const yMean = mean(ys);
  let ssxx = 0;
  let ssxy = 0;
  for (let i = 0; i < xs.length; i++) {
    ssxx += (xs[i] - xMean) ** 2;
    ssxy += (xs[i] - xMean) * (ys[i] - yMean);
  }
  const slope = ssxx > 0 ? ssxy / ssxx : 0;
  const intercept = yMean - slope * xMean;
  return { slope, intercept };
}

function fitResults(perN) {
  const ns = perN.map((row) => row.samples);
  const rmses = perN.map((row) => row.rmse_error_mean);
  const logFit = linearRegression(ns.map(Math.log), rmses.map(Math.log));

  const xsPure = ns.map((n) => 1 / Math.sqrt(n));
  const pureNumerator = xsPure.reduce((sum, x, i) => sum + x * rmses[i], 0);
  const pureDenominator = xsPure.reduce((sum, x) => sum + x * x, 0);
  const aPure = pureNumerator / pureDenominator;

  const xsFloor = ns.map((n) => 1 / n);
  const ysFloor = rmses.map((rmse) => rmse * rmse);
  const floorFit = linearRegression(xsFloor, ysFloor);
  const a2 = Math.max(0, floorFit.slope);
  const b2 = Math.max(0, floorFit.intercept);

  return {
    empirical_loglog: {
      slope: logFit.slope,
      intercept: logFit.intercept,
      expected_slope: -0.5,
    },
    pure_monte_carlo_fixed_slope: {
      a: aPure,
      model: "rmse = a / sqrt(N)",
    },
    bias_floor_model: {
      a: Math.sqrt(a2),
      b: Math.sqrt(b2),
      model: "rmse = sqrt(a^2 / N + b^2)",
    },
  };
}

function writeSummaryCsv(filePath, rows) {
  const header = [
    "samples",
    "repeat",
    "seed",
    "avg_signed_error",
    "avg_abs_error",
    "rmse_error",
    "max_abs_error",
    "avg_standard_error",
    "rms_z_score",
    "negative_error_count",
    "avg_steps",
    "run_dir",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => row[key]).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function groupByN(rows) {
  return [...new Set(rows.map((row) => row.samples))].sort((a, b) => a - b).map((samples) => {
    const group = rows.filter((row) => row.samples === samples);
    return {
      samples,
      repeats: group.length,
      avg_signed_error_mean: mean(group.map((row) => row.avg_signed_error)),
      avg_abs_error_mean: mean(group.map((row) => row.avg_abs_error)),
      rmse_error_mean: mean(group.map((row) => row.rmse_error)),
      max_abs_error_mean: mean(group.map((row) => row.max_abs_error)),
      avg_standard_error_mean: mean(group.map((row) => row.avg_standard_error)),
      rms_z_score_mean: mean(group.map((row) => row.rms_z_score)),
      avg_steps_mean: mean(group.map((row) => row.avg_steps)),
    };
  });
}

function rowFromSummary(samples, repeat, seed, runDir, summary) {
  return {
    samples,
    repeat,
    seed,
    run_dir: runDir,
    avg_signed_error: summary.avg_signed_error,
    avg_abs_error: summary.avg_abs_error,
    rmse_error: summary.rmse_error,
    max_abs_error: summary.max_abs_error,
    avg_standard_error: summary.avg_standard_error,
    rms_z_score: summary.rms_z_score,
    negative_error_count: summary.negative_error_count,
    avg_steps: summary.avg_steps,
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.skipBuild) buildMetal();

  const executable = path.join(rootDir, "build-metal", "random_walker_metal");
  if (!fs.existsSync(executable)) {
    throw new Error(`Missing executable: ${executable}`);
  }

  const baseConfig = JSON.parse(fs.readFileSync(options.baseConfig, "utf8"));
  fs.mkdirSync(options.outputRoot, { recursive: true });

  const rows = [];
  for (const samples of options.samples) {
    for (let repeat = 0; repeat < options.repeats; repeat++) {
      const seed = options.baseSeed + samples * 100 + repeat;
      const runDir = path.join(options.outputRoot, `N_${samples}`, `rep_${repeat}`);
      fs.mkdirSync(runDir, { recursive: true });
      const summaryPath = path.join(runDir, "summary.json");
      if (options.resume && fs.existsSync(summaryPath)) {
        const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
        rows.push(rowFromSummary(samples, repeat, seed, runDir, summary));
        console.log(`[gpu-convergence] reuse N=${samples} repeat=${repeat} seed=${seed}`);
        continue;
      }

      const config = JSON.parse(JSON.stringify(baseConfig));
      config.data = {
        ...(config.data || {}),
        power_density_path: resolveConfigPath(options.baseConfig, config.data && config.data.power_density_path),
        ground_truth_path: resolveConfigPath(options.baseConfig, config.data && config.data.ground_truth_path),
      };
      config.run = { ...(config.run || {}), num_samples: samples, num_workers: options.threads, seed };
      config.output = { ...(config.output || {}), directory: runDir, csv: "FastRw.csv", constraints: "data.json" };
      const configPath = path.join(runDir, "config.json");
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

      console.log(`[gpu-convergence] N=${samples} repeat=${repeat} seed=${seed}`);
      runCommand(executable, [configPath, String(samples), String(options.threads)]);

      const summary = summarizeRun(runDir);
      rows.push(rowFromSummary(samples, repeat, seed, runDir, summary));
      fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    }
  }

  const perN = groupByN(rows);
  const fit = fitResults(perN);
  writeSummaryCsv(path.join(options.outputRoot, "summary.csv"), rows);
  fs.writeFileSync(path.join(options.outputRoot, "summary.json"), `${JSON.stringify({ runs: rows, per_n: perN }, null, 2)}\n`);
  fs.writeFileSync(path.join(options.outputRoot, "fit.json"), `${JSON.stringify(fit, null, 2)}\n`);
  console.log(JSON.stringify({ per_n: perN, fit }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
