# ResRW

Clean C++ layout for the Robin-boundary random-walk solver.

## Layout

- `src/`, `include/`: active C++ implementation. The default build uses `RandomWalker` from `walker.cpp`.
- `configs/`: paper-aligned case configs for geometry, boundary conditions, data paths, query grid, and run settings.
- `data/`: input data sets. Config files point to the power and ground-truth temperature binaries.
- `outputs/`: generated CSV/JSON results.
- `stan/`: active Stan post-processing models and cached Stan executables.
- `legacy/walker2_cuda/`: parked legacy `walker2` CPU implementation.
- `third_party/`: header-only/vendor dependencies and CmdStan.

## Build And Run

From the repository root:

```bash
./scripts/build_and_run.sh
```

Optional arguments:

```bash
./scripts/build_and_run.sh <config_file> <num_samples> <num_workers>
```

Example:

```bash
./scripts/build_and_run.sh configs/case3_16core.json 400 -1
```

The script configures `build/`, compiles `random_walker`, then runs it. The
CSV and constraint JSON locations come from the selected config. For example,
`configs/case3_16core.json` writes:

- `outputs/FastRw.csv`
- `outputs/data.json`
- `outputs/stan/HBMmodel_chain1.csv`
- `outputs/stan/HBMmodel_summary.txt`

By default, the script runs two random-walk samples so the Stan model can
estimate per-point variance. Pass `400` or another sample count for a full
experiment.

Skip Stan post-processing with:

```bash
RUN_STAN=0 ./scripts/build_and_run.sh
```

Run only Stan post-processing, reusing the existing `outputs/data.json`, with:

```bash
RUN_RANDOM_WALK=0 ./scripts/build_and_run.sh
```

If the random-walk config writes constraints somewhere else, the script passes
that same `data.json` to Stan automatically. For a Stan-only rerun from a
specific output directory, set `STAN_DATA`:

```bash
RUN_RANDOM_WALK=0 STAN_DATA=outputs/reproduce/case1_power6_multi/data.json ./scripts/build_and_run.sh
```

Adjust the default Stan run with environment variables:

```bash
STAN_WARMUP=1000 STAN_SAMPLES=1000 STAN_CHAINS=4 ./scripts/build_and_run.sh configs/case3_16core.json 400 -1
```

By default, the Stan section uses `stan/bin/HBMmodel`, which is the cached
executable corresponding to `stan/HBMmodel.stan`. Force a rebuild from source
with `STAN_REBUILD=1`. Rebuilds disable CmdStan precompiled headers by default
to avoid stale macOS SDK target-version cache issues and use `O=0` so rebuilds
finish sooner. Re-enable precompiled headers with `STAN_PRECOMPILED_HEADERS=true`,
or use `STAN_OPT_LEVEL=3` for a more optimized executable.

## Manual Build

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --parallel
./build/random_walker configs/case3_16core.json 400 -1
```

## Metal GPU Build On Apple Silicon

This repository also includes a Metal compute backend for Apple Silicon Macs.
The GPU executable runs direct random-walk estimates and writes the same CSV
shape as the CPU executable. It also writes CPU-compatible `data.json`
observations and pass-through constraints for downstream Stan workflows.

Create the Anaconda environment:

```bash
conda env create -f environment.yml
conda activate FastRW
```

Build and run the Metal executable:

```bash
./scripts/build_and_run_metal.sh configs/case3_16core.json 400 -1
```

The third argument is the Metal threads-per-threadgroup override. Use `-1` for
the default. The script builds `build-metal/random_walker_metal` and runs it
with the same config format as the CPU path.
