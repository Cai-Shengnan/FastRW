# Stan Post-Processing

`HBMmodel.stan` is the default post-processing model because this repository
keeps a cached executable at `stan/bin/HBMmodel`. `onestage.stan` is also kept
for experiments. Both consume `outputs/data.json`, which is produced by the C++
random-walk run.

The one-command path is:

```bash
./scripts/build_and_run.sh
```

Useful overrides:

```bash
RUN_STAN=0 ./scripts/build_and_run.sh
RUN_RANDOM_WALK=0 ./scripts/build_and_run.sh
STAN_WARMUP=1000 STAN_SAMPLES=1000 STAN_CHAINS=4 ./scripts/build_and_run.sh configs/case3_16core.json 400 -1
STAN_MODEL_NAME=onestage STAN_REBUILD=1 RUN_RANDOM_WALK=0 ./scripts/build_and_run.sh
```

If `STAN_REBUILD=1`, `build_and_run.sh` passes `PRECOMPILED_HEADERS=false` to
CmdStan by default. It also uses `O=0` for faster rebuilds. Set
`STAN_PRECOMPILED_HEADERS=true` or `STAN_OPT_LEVEL=3` to opt back into heavier
optimized builds.
