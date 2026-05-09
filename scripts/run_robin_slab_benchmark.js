#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const options = {
    outputRoot: path.join(rootDir, "outputs", "robin_root_cause", "slab"),
    samples: 2000,
    seed: 20260509,
    modes: ["current", "event", "hit"],
    epsilons: [7.5e-7],
    deltas: [5e-7],
    skipBuild: false,
  };
  for (const arg of argv) {
    if (arg === "--skip-build") options.skipBuild = true;
    else if (arg.startsWith("--output-root=")) options.outputRoot = path.resolve(arg.slice("--output-root=".length));
    else if (arg.startsWith("--samples=")) options.samples = Number(arg.slice("--samples=".length));
    else if (arg.startsWith("--seed=")) options.seed = Number(arg.slice("--seed=".length));
    else if (arg.startsWith("--modes=")) options.modes = arg.slice("--modes=".length).split(",").filter(Boolean);
    else if (arg.startsWith("--epsilons=")) options.epsilons = arg.slice("--epsilons=".length).split(",").map(Number);
    else if (arg.startsWith("--deltas=")) options.deltas = arg.slice("--deltas=".length).split(",").map(Number);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd || rootDir,
    stdio: opts.stdio || "inherit",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${[command, ...args].join(" ")}`);
  }
  return result;
}

function build() {
  run("cmake", ["-S", rootDir, "-B", path.join(rootDir, "build-metal"), "-DCMAKE_BUILD_TYPE=Release"]);
  run("cmake", ["--build", path.join(rootDir, "build-metal"), "--target", "random_walker", "--parallel"]);
}

function tag(value) {
  return String(value).replace("-", "m").replace(/\./g, "p");
}

function analyticTemperature(z, L, k, h, ambient, bottomTemperature) {
  const slope = h * (ambient - bottomTemperature) / (k + h * L);
  return bottomTemperature + slope * z;
}

function writeDoubleBin(filename, values) {
  const buffer = Buffer.alloc(values.length * 8);
  values.forEach((value, i) => buffer.writeDoubleLE(value, i * 8));
  fs.writeFileSync(filename, buffer);
}

function parseCsv(filename) {
  const lines = fs.readFileSync(filename, "utf8").trim().split(/\n/);
  const header = lines.shift().split(",");
  return lines.map((line) => {
    const values = line.split(",");
    const row = {};
    header.forEach((key, i) => row[key] = Number(values[i]));
    return row;
  });
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.skipBuild) build();

  const executable = path.join(rootDir, "build-metal", "random_walker");
  if (!fs.existsSync(executable)) throw new Error(`Missing executable: ${executable}`);

  fs.mkdirSync(options.outputRoot, { recursive: true });

  const geom = {
    xSize: 0.001,
    ySize: 0.001,
    xyResolution: 0.0005,
    bottomThickness: 0.001,
    heatThickness: 0.0001,
    topThickness: 0.001,
    zResolution: 0.00002,
    k: 395.0,
    h: 4900.0,
    ambient: 293.15,
    bottomTemperature: 400.0,
  };
  const nx = Math.round(geom.xSize / geom.xyResolution);
  const ny = Math.round(geom.ySize / geom.xyResolution);
  const nzHeat = Math.round(geom.heatThickness / geom.zResolution);
  const nzBottom = Math.round((geom.bottomThickness - geom.zResolution) / geom.zResolution);
  const nzVirtual = 1;
  const zHeatStart = nzBottom + nzVirtual;
  const nzTop = Math.round((geom.topThickness - geom.zResolution) / geom.zResolution);
  const nzTotal = nzBottom + 2 * nzVirtual + nzHeat + nzTop;
  const L = nzTotal * geom.zResolution;
  const queryZ = geom.bottomThickness + 0.5 * geom.heatThickness;
  const analyticAtQuery = analyticTemperature(queryZ, L, geom.k, geom.h, geom.ambient, geom.bottomTemperature);

  const dataDir = path.join(options.outputRoot, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const powerPath = path.join(dataDir, "power_zero.bin");
  const tempPath = path.join(dataDir, "temp_analytic.bin");
  writeDoubleBin(powerPath, Array(nzHeat * ny * nx).fill(0.0));

  const tempValues = [];
  for (let iz = 0; iz < nzHeat; iz++) {
    const z = (zHeatStart + iz + 0.5) * geom.zResolution;
    const value = analyticTemperature(z, L, geom.k, geom.h, geom.ambient, geom.bottomTemperature) - 273.15;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) tempValues.push(value);
    }
  }
  writeDoubleBin(tempPath, tempValues);

  const rows = [];
  for (const eps of options.epsilons) {
    for (const delta of options.deltas) {
      for (const mode of options.modes) {
        const runDir = path.join(options.outputRoot, `mode_${mode}_eps_${tag(eps)}_dx_${tag(delta)}`);
        fs.mkdirSync(runDir, { recursive: true });
        const config = {
          case_name: "robin_slab_1d",
          power_map: "zero",
          geometry: {
            x_size: geom.xSize,
            y_size: geom.ySize,
            top_thickness: geom.topThickness,
            middle_thickness: geom.heatThickness,
            bottom_thickness: geom.bottomThickness,
            xy_resolution: geom.xyResolution,
            z_resolution: geom.zResolution,
            ambient_temperature: geom.ambient,
            source_conductivity: geom.k,
            medium_conductivity: geom.k,
          },
          boundary: {
            top: { type: "Robin", param: geom.h },
            bottom: { type: "Dirichlet", param: geom.bottomTemperature },
            lateral: { type: "Neumann", param: 0.0 },
            epsilon: { dirichlet: 1e-8, neumann: eps, robin: eps },
          },
          data: {
            power_density_path: powerPath,
            ground_truth_path: tempPath,
          },
          walker: {
            max_steps: 2e7,
            cutoff_weight: 1e-12,
            delta_x: delta,
            use_tail_correction: false,
            robin_local_time_mode: mode,
            diagnostics: { enabled: true },
          },
          query_grid: {
            x_indices: [1],
            y_indices: [1],
            z: queryZ,
          },
          run: {
            num_samples: options.samples,
            num_workers: 1,
            seed: options.seed,
          },
          output: {
            directory: runDir,
            csv: "FastRw.csv",
            constraints: "data.json",
            diagnostics: "diagnostics.json",
          },
        };
        const configPath = path.join(runDir, "config.json");
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
        run(executable, [configPath, String(options.samples), "1"]);
        const csvRows = parseCsv(path.join(runDir, "FastRw.csv"));
        const row = csvRows[0];
        const diagnostics = JSON.parse(fs.readFileSync(path.join(runDir, "diagnostics.json"), "utf8"));
        const robin = diagnostics.point_diagnostics[0].robin;
        rows.push({
          mode,
          eps,
          delta,
          samples: options.samples,
          estimate: row.Normal_Mean,
          gt: row.GT_Temperature,
          analytic: analyticAtQuery,
          error_vs_gt: row.Error,
          error_vs_analytic: row.Normal_Mean - analyticAtQuery,
          avg_steps: row.Avg_Steps,
          robin_local_time: robin.effective_local_time_mean,
          robin_decay: robin.exp_minus_hL_over_k_mean,
          top_hits: robin.top_hit_count_mean,
          top_near: robin.top_near_count_mean,
          bottom_hits: robin.bottom_hit_count_mean,
          bottom_near: robin.bottom_near_count_mean,
        });
      }
    }
  }

  const header = Object.keys(rows[0]);
  const csv = [
    header.join(","),
    ...rows.map((row) => header.map((key) => row[key]).join(",")),
  ].join("\n");
  fs.writeFileSync(path.join(options.outputRoot, "summary.csv"), `${csv}\n`);
  fs.writeFileSync(path.join(options.outputRoot, "summary.json"), `${JSON.stringify({
    analytic: { L, queryZ, value: analyticAtQuery },
    rows,
    by_mode_error: Object.fromEntries(options.modes.map((mode) => [
      mode,
      mean(rows.filter((row) => row.mode === mode).map((row) => Math.abs(row.error_vs_analytic))),
    ])),
  }, null, 2)}\n`);
  console.log(csv);
}

main();
