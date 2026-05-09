#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const defaultBaseConfig = path.join(rootDir, "configs", "case3_16core.json");
const defaultOutputRoot = path.join(rootDir, "outputs", "system_bias", "discovery");

function usage() {
  console.error([
    "Usage: run_system_bias_scan.js [options]",
    "",
    "Options:",
    "  --suite=<name>       baseline, cutoff, robin, robin_refine, robin_confirm, robin_modes, power, geometry, or all. Default: all",
    "  --base-config=<path> Base JSON config. Default: configs/case3_16core.json",
    "  --output-root=<path> Output directory. Default: outputs/system_bias/discovery",
    "  --samples=<n>       Samples per point. Default: 800",
    "  --repeats=<n>       Repeats per variant. Default: 3",
    "  --base-seed=<n>     First deterministic seed. Default: 20260509",
    "  --threads=<n>       Metal threads per threadgroup. Default: -1",
    "  --skip-build        Reuse existing build-metal/random_walker_metal",
    "  --resume            Reuse completed run directories",
    "  --smoke             Shortcut for --suite=baseline --samples=100 --repeats=1",
  ].join("\n"));
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    suite: "all",
    baseConfig: defaultBaseConfig,
    outputRoot: defaultOutputRoot,
    samples: 800,
    repeats: 3,
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
      options.suite = "baseline";
      options.samples = 100;
      options.repeats = 1;
    } else if (arg.startsWith("--suite=")) {
      options.suite = arg.slice("--suite=".length);
    } else if (arg.startsWith("--base-config=")) {
      options.baseConfig = path.resolve(arg.slice("--base-config=".length));
    } else if (arg.startsWith("--output-root=")) {
      options.outputRoot = path.resolve(arg.slice("--output-root=".length));
    } else if (arg.startsWith("--samples=")) {
      options.samples = Number(arg.slice("--samples=".length));
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

  const suites = new Set(["baseline", "cutoff", "robin", "robin_refine", "robin_confirm", "robin_modes", "power", "geometry", "all"]);
  if (!suites.has(options.suite)) throw new Error(`Unknown suite: ${options.suite}`);
  if (!fs.existsSync(options.baseConfig)) throw new Error(`Base config does not exist: ${options.baseConfig}`);
  if (!Number.isInteger(options.samples) || options.samples <= 0) throw new Error("--samples must be a positive integer.");
  if (!Number.isInteger(options.repeats) || options.repeats <= 0) throw new Error("--repeats must be a positive integer.");
  if (!Number.isInteger(options.baseSeed) || options.baseSeed < 0) throw new Error("--base-seed must be a non-negative integer.");
  if (!Number.isInteger(options.threads)) throw new Error("--threads must be an integer.");
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

function tagNumber(value) {
  return String(value).replace("-", "m").replace(/\./g, "p");
}

function setPath(root, dottedPath, value) {
  const parts = dottedPath.split(".");
  let obj = root;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof obj[parts[i]] !== "object" || obj[parts[i]] === null) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;
}

function resolveConfigPath(baseConfigPath, rawPath) {
  if (!rawPath) return rawPath;
  if (path.isAbsolute(rawPath)) return rawPath;
  return path.resolve(path.dirname(baseConfigPath), rawPath);
}

function variant(name, group, changes, note = "") {
  return { name, group, changes, note };
}

function buildVariants(suite, baseConfig) {
  const variants = [variant("baseline", "baseline", {}, "Current case3_16core settings")];
  const add = (items) => variants.push(...items);

  if (suite === "cutoff" || suite === "all") {
    add([0.03, 0.01, 0.003, 0.001, 0.0003, 0.0001].map((cutoff) =>
      variant(`cutoff_gt_${tagNumber(cutoff)}`, "cutoff", {
        "walker.cutoff_weight": cutoff,
        "walker.tail_mode": "gt",
      }, `GT tail cutoff ${cutoff}`)));
    add([variant("cutoff_0p0001_tail_none", "cutoff", {
      "walker.cutoff_weight": 0.0001,
      "walker.tail_mode": "none",
    }, "Near-PIRW truncation diagnostic")]);
  }

  if (suite === "robin" || suite === "all") {
    add([5e-7, 6.8e-7, 7.5e-7, 1.0e-6].map((eps) =>
      variant(`robin_eps_${tagNumber(eps)}`, "robin", {
        "walker.cutoff_weight": 0.0001,
        "walker.tail_mode": "gt",
        "boundary.epsilon.robin": eps,
      }, `Robin epsilon ${eps}`)));

    const h = baseConfig.boundary?.top?.param ?? 4900;
    add([0.95, 1.0, 1.05].map((scale) =>
      variant(`robin_h_${tagNumber(scale)}`, "robin", {
        "walker.cutoff_weight": 0.0001,
        "walker.tail_mode": "gt",
        "boundary.top.param": h * scale,
        "boundary.bottom.param": h * scale,
      }, `Robin h scale ${scale}`)));
  }

  if (suite === "robin_refine") {
    const h = baseConfig.boundary?.top?.param ?? 4900;
    add([0.955, 0.96, 0.965, 0.97].map((scale) =>
      variant(`robin_h_${tagNumber(scale)}`, "robin_refine", {
        "walker.cutoff_weight": 0.0001,
        "walker.tail_mode": "gt",
        "boundary.top.param": h * scale,
        "boundary.bottom.param": h * scale,
      }, `Robin h scale ${scale}`)));
  }

  if (suite === "robin_confirm") {
    const h = baseConfig.boundary?.top?.param ?? 4900;
    add([variant("robin_h_0p96", "robin_confirm", {
      "walker.cutoff_weight": 0.0001,
      "walker.tail_mode": "gt",
      "boundary.top.param": h * 0.96,
      "boundary.bottom.param": h * 0.96,
    }, "Robin h scale 0.96 confirmation")]);
  }

  if (suite === "robin_modes") {
    add(["current", "event", "hit"].map((mode) =>
      variant(`robin_mode_${mode}`, "robin_modes", {
        "walker.robin_local_time_mode": mode,
      }, `Robin local-time mode ${mode}`)));
  }

  if (suite === "power" || suite === "all") {
    add([0.98, 1.0, 1.01, 1.02, 1.03].map((scale) =>
      variant(`power_scale_${tagNumber(scale)}`, "power", {
        "data.power_scale": scale,
      }, `Power density scale ${scale}`)));
    add([291.15, 293.15, 295.15].map((temperature) =>
      variant(`ambient_${tagNumber(temperature)}`, "power", {
        "geometry.ambient_temperature": temperature,
      }, `Ambient temperature ${temperature}`)));
  }

  if (suite === "geometry" || suite === "all") {
    const xy = baseConfig.geometry?.xy_resolution ?? 0.0002;
    const z = baseConfig.geometry?.z_resolution ?? 0.00002;
    add([
      variant("query_x_mhalf", "geometry", { "query_grid.x_offset": -0.5 * xy }, "x shift -0.5 dx"),
      variant("query_x_phalf", "geometry", { "query_grid.x_offset": 0.5 * xy }, "x shift +0.5 dx"),
      variant("query_y_mhalf", "geometry", { "query_grid.y_offset": -0.5 * xy }, "y shift -0.5 dy"),
      variant("query_y_phalf", "geometry", { "query_grid.y_offset": 0.5 * xy }, "y shift +0.5 dy"),
      variant("query_xy_phalf", "geometry", {
        "query_grid.x_offset": 0.5 * xy,
        "query_grid.y_offset": 0.5 * xy,
      }, "x/y shift +0.5 cell to COMSOL node centers"),
      variant("query_z_mhalf", "geometry", { "query_grid.z_offset": -0.5 * z }, "z shift -0.5 dz"),
      variant("query_z_phalf", "geometry", { "query_grid.z_offset": 0.5 * z }, "z shift +0.5 dz"),
      variant("layer_plus_one_z", "geometry", {
        "geometry.top_thickness": (baseConfig.geometry?.top_thickness ?? 0.0005) + z,
        "geometry.bottom_thickness": (baseConfig.geometry?.bottom_thickness ?? 0.001) + z,
      }, "Undo one z-resolution thickness subtraction diagnostic"),
    ]);
  }

  if (suite !== "all" && suite !== "baseline") {
    return variants.filter((v) => v.group === "baseline" || v.group === suite);
  }
  if (suite === "baseline") return variants.filter((v) => v.group === "baseline");
  return variants;
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
  return {
    points: pointStats.length,
    samples: data.N,
    avg_signed_error: mean(errors),
    avg_abs_error: mean(errors.map(Math.abs)),
    rmse_error: Math.sqrt(mean(errors.map((e) => e * e))),
    max_abs_error: Math.max(...errors.map(Math.abs)),
    avg_standard_error: mean(pointStats.map((p) => p.standard_error)),
    avg_steps: mean(pointStats.map((p) => p.avg_steps)),
    negative_error_count: errors.filter((e) => e < 0).length,
    point_stats: pointStats,
  };
}

function summarizeDiagnostics(runDir) {
  const diagnosticsPath = path.join(runDir, "diagnostics.json");
  if (!fs.existsSync(diagnosticsPath)) return {};
  const diagnostics = JSON.parse(fs.readFileSync(diagnosticsPath, "utf8"));
  const points = diagnostics.point_diagnostics || [];
  if (!points.length) return {};

  const component = (name) => mean(points.map((p) => p.components[name]));
  const cutoffFractions = points.map((p) => p.cutoff.fraction);
  const componentDiffs = points.map((p) => Math.abs(p.component_difference));
  return {
    component_T0_heat: component("T0_heat"),
    component_T1_tail_or_dirichlet: component("T1_tail_or_dirichlet"),
    component_T2_neumann: component("T2_neumann"),
    component_T3_robin: component("T3_robin"),
    cutoff_fraction: mean(cutoffFractions),
    cutoff_tail_e_hat_mean: mean(points.map((p) => p.cutoff.tail_e_hat_mean_when_cutoff)),
    cutoff_tail_temperature_mean: mean(points.map((p) => p.cutoff.tail_temperature_mean_when_cutoff)),
    robin_hit_mean: mean(points.map((p) => p.robin.hit_count_mean)),
    robin_near_mean: mean(points.map((p) => p.robin.near_count_mean)),
    robin_local_time_mean: mean(points.map((p) => p.robin.effective_local_time_mean ?? 0)),
    robin_decay_mean: mean(points.map((p) => p.robin.exp_minus_hL_over_k_mean ?? 0)),
    robin_top_hit_mean: mean(points.map((p) => p.robin.top_hit_count_mean ?? 0)),
    robin_top_near_mean: mean(points.map((p) => p.robin.top_near_count_mean ?? 0)),
    robin_top_local_time_mean: mean(points.map((p) => p.robin.top_effective_local_time_mean ?? 0)),
    robin_bottom_hit_mean: mean(points.map((p) => p.robin.bottom_hit_count_mean ?? 0)),
    robin_bottom_near_mean: mean(points.map((p) => p.robin.bottom_near_count_mean ?? 0)),
    robin_bottom_local_time_mean: mean(points.map((p) => p.robin.bottom_effective_local_time_mean ?? 0)),
    final_e_hat_mean: mean(points.map((p) => p.final_e_hat_mean)),
    max_component_difference: Math.max(...componentDiffs),
    gt_floor_mean: mean(points.map((p) => p.gt_lookup.floor)),
    gt_nearest_center_mean: mean(points.map((p) => p.gt_lookup.nearest_center)),
    gt_bilinear_xy_mean: mean(points.map((p) => p.gt_lookup.bilinear_xy)),
  };
}

function rowFromRun(variantSpec, repeat, seed, runDir, summary, diag) {
  return {
    variant: variantSpec.name,
    group: variantSpec.group,
    repeat,
    seed,
    run_dir: runDir,
    avg_signed_error: summary.avg_signed_error,
    avg_abs_error: summary.avg_abs_error,
    rmse_error: summary.rmse_error,
    max_abs_error: summary.max_abs_error,
    avg_standard_error: summary.avg_standard_error,
    negative_error_count: summary.negative_error_count,
    avg_steps: summary.avg_steps,
    component_T0_heat: diag.component_T0_heat ?? "",
    component_T1_tail_or_dirichlet: diag.component_T1_tail_or_dirichlet ?? "",
    component_T2_neumann: diag.component_T2_neumann ?? "",
    component_T3_robin: diag.component_T3_robin ?? "",
    cutoff_fraction: diag.cutoff_fraction ?? "",
    cutoff_tail_e_hat_mean: diag.cutoff_tail_e_hat_mean ?? "",
    cutoff_tail_temperature_mean: diag.cutoff_tail_temperature_mean ?? "",
    robin_hit_mean: diag.robin_hit_mean ?? "",
    robin_near_mean: diag.robin_near_mean ?? "",
    robin_local_time_mean: diag.robin_local_time_mean ?? "",
    robin_decay_mean: diag.robin_decay_mean ?? "",
    robin_top_hit_mean: diag.robin_top_hit_mean ?? "",
    robin_top_near_mean: diag.robin_top_near_mean ?? "",
    robin_top_local_time_mean: diag.robin_top_local_time_mean ?? "",
    robin_bottom_hit_mean: diag.robin_bottom_hit_mean ?? "",
    robin_bottom_near_mean: diag.robin_bottom_near_mean ?? "",
    robin_bottom_local_time_mean: diag.robin_bottom_local_time_mean ?? "",
    final_e_hat_mean: diag.final_e_hat_mean ?? "",
    max_component_difference: diag.max_component_difference ?? "",
    gt_floor_mean: diag.gt_floor_mean ?? "",
    gt_nearest_center_mean: diag.gt_nearest_center_mean ?? "",
    gt_bilinear_xy_mean: diag.gt_bilinear_xy_mean ?? "",
  };
}

function aggregateRows(rows) {
  const variants = [...new Set(rows.map((row) => row.variant))];
  const byVariant = variants.map((name) => {
    const group = rows.filter((row) => row.variant === name);
    const numericMean = (key) => {
      const values = group.map((row) => row[key]).filter((value) => typeof value === "number" && Number.isFinite(value));
      return values.length ? mean(values) : null;
    };
    const componentDiffValues = group
      .map((row) => row.max_component_difference)
      .filter((value) => typeof value === "number" && Number.isFinite(value));
    return {
      variant: name,
      group: group[0].group,
      repeats: group.length,
      avg_signed_error_mean: numericMean("avg_signed_error"),
      avg_abs_error_mean: numericMean("avg_abs_error"),
      rmse_error_mean: numericMean("rmse_error"),
      max_abs_error_mean: numericMean("max_abs_error"),
      avg_standard_error_mean: numericMean("avg_standard_error"),
      component_T0_heat_mean: numericMean("component_T0_heat"),
      component_T1_tail_or_dirichlet_mean: numericMean("component_T1_tail_or_dirichlet"),
      component_T2_neumann_mean: numericMean("component_T2_neumann"),
      component_T3_robin_mean: numericMean("component_T3_robin"),
      cutoff_fraction_mean: numericMean("cutoff_fraction"),
      cutoff_tail_e_hat_mean: numericMean("cutoff_tail_e_hat_mean"),
      cutoff_tail_temperature_mean: numericMean("cutoff_tail_temperature_mean"),
      robin_hit_mean: numericMean("robin_hit_mean"),
      robin_near_mean: numericMean("robin_near_mean"),
      robin_local_time_mean: numericMean("robin_local_time_mean"),
      robin_decay_mean: numericMean("robin_decay_mean"),
      robin_top_hit_mean: numericMean("robin_top_hit_mean"),
      robin_top_near_mean: numericMean("robin_top_near_mean"),
      robin_top_local_time_mean: numericMean("robin_top_local_time_mean"),
      robin_bottom_hit_mean: numericMean("robin_bottom_hit_mean"),
      robin_bottom_near_mean: numericMean("robin_bottom_near_mean"),
      robin_bottom_local_time_mean: numericMean("robin_bottom_local_time_mean"),
      max_component_difference_max: componentDiffValues.length ? Math.max(...componentDiffValues) : null,
    };
  });

  const baseline = byVariant.find((row) => row.variant === "baseline") || byVariant[0];
  for (const row of byVariant) {
    row.signed_error_shift_from_baseline = baseline ? row.avg_signed_error_mean - baseline.avg_signed_error_mean : null;
    row.rmse_shift_from_baseline = baseline ? row.rmse_error_mean - baseline.rmse_error_mean : null;
  }
  return byVariant;
}

function writeCsv(filePath, rows) {
  if (!rows.length) return;
  const header = Object.keys(rows[0]);
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => row[key]).join(","));
  }
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.skipBuild) buildMetal();
  const executable = path.join(rootDir, "build-metal", "random_walker_metal");
  if (!fs.existsSync(executable)) throw new Error(`Missing executable: ${executable}`);

  const baseConfig = JSON.parse(fs.readFileSync(options.baseConfig, "utf8"));
  const variants = buildVariants(options.suite, baseConfig);
  fs.mkdirSync(options.outputRoot, { recursive: true });

  const rows = [];
  for (let variantIndex = 0; variantIndex < variants.length; variantIndex++) {
    const variantSpec = variants[variantIndex];
    for (let repeat = 0; repeat < options.repeats; repeat++) {
      const seed = options.baseSeed + variantIndex * 1000 + repeat;
      const runDir = path.join(options.outputRoot, variantSpec.name, `rep_${repeat}`);
      const summaryPath = path.join(runDir, "summary.json");
      fs.mkdirSync(runDir, { recursive: true });

      if (options.resume && fs.existsSync(summaryPath) && fs.existsSync(path.join(runDir, "diagnostics.json"))) {
        const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
        const diag = summarizeDiagnostics(runDir);
        rows.push(rowFromRun(variantSpec, repeat, seed, runDir, summary, diag));
        console.log(`[system-bias] reuse ${variantSpec.name} repeat=${repeat}`);
        continue;
      }

      const config = JSON.parse(JSON.stringify(baseConfig));
      config.data = {
        ...(config.data || {}),
        power_density_path: resolveConfigPath(options.baseConfig, config.data && config.data.power_density_path),
        ground_truth_path: resolveConfigPath(options.baseConfig, config.data && config.data.ground_truth_path),
      };
      config.walker = {
        ...(config.walker || {}),
        diagnostics: { ...((config.walker && config.walker.diagnostics) || {}), enabled: true },
      };
      config.run = { ...(config.run || {}), num_samples: options.samples, num_workers: options.threads, seed };
      config.output = { ...(config.output || {}), directory: runDir, csv: "FastRw.csv", constraints: "data.json", diagnostics: "diagnostics.json" };
      for (const [key, value] of Object.entries(variantSpec.changes)) {
        setPath(config, key, value);
      }

      const configPath = path.join(runDir, "config.json");
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`[system-bias] ${variantSpec.name} repeat=${repeat} seed=${seed}`);
      runCommand(executable, [configPath, String(options.samples), String(options.threads)]);

      const summary = summarizeRun(runDir);
      const diag = summarizeDiagnostics(runDir);
      fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
      rows.push(rowFromRun(variantSpec, repeat, seed, runDir, summary, diag));
    }
  }

  const byVariant = aggregateRows(rows);
  writeCsv(path.join(options.outputRoot, "runs.csv"), rows);
  writeCsv(path.join(options.outputRoot, "variants.csv"), byVariant);
  fs.writeFileSync(path.join(options.outputRoot, "summary.json"), `${JSON.stringify({ variants, runs: rows, by_variant: byVariant }, null, 2)}\n`);
  console.log(JSON.stringify({ by_variant: byVariant }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exit(1);
}
