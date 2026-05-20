#!/usr/bin/env node

const { spawnSync } = require("child_process");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

const cases = [
  "case1_power6",
  "case2_4core_top1_bottom1",
  "case3_16core",
];

function run(cmd, args, env = {}) {
  console.log(`\n$ ${[cmd, ...args].join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function config(name, prefix = "") {
  return path.join(rootDir, "configs", `${prefix}${name}.json`);
}

function main() {
  const mode = process.argv[2] || "smoke";
  const samples = Number(process.env.SAMPLES || (mode === "full" ? 400 : 2));
  const runPirw = process.env.RUN_PIRW !== "0";
  const runFast = process.env.RUN_FAST !== "0";

  for (const name of cases) {
    if (runPirw) {
      run("./scripts/build_and_run_metal.sh", [config(name, "pirw_"), String(mode === "full" ? 1000 : samples), "-1"]);
    }
    if (runFast) {
      run("./scripts/build_and_run_metal.sh", [config(name), String(samples), "-1"]);
    }
  }
}

main();
