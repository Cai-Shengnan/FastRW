# ResRW

FastRW random-walk thermal solver and experiment harness.

## Active Experiment Layout

- `src/`, `include/`: CPU and Metal random-walk implementations.
- `configs/`: current three-case FastRW and PIRW configs.
- `data/cases/`: canonical paper inputs. Temperature fields in `temp.bin` are stored in Celsius.
- `outputs/`: generated run outputs; safe to clear and regenerate.
- `stan/onestage.stan`: retained reference model for the Onestage fusion contract.
- `scripts/`: build/run, COMSOL generation, Onestage fusion, and summary helpers.

The active cases are:

- `case1_power6`: `500/100/500 um`, `power6`, `h=8700`.
- `case2_4core_top1_bottom1`: `1000/100/1000 um`, `4-core`, `h=8700`.
- `case3_16core`: `500/100/1000 um`, `16-core`, `h=4900`.

All current configs use `walker.delta_x = 5e-7`, `boundary.strip_ratio = 1.56`,
and therefore `boundary.epsilon.neumann = boundary.epsilon.robin = 7.8e-7`.
The fixed experiment seed is `42`.

## Config Schema

Temperature inputs are split by role:

```json
"data": {
  "power_density_path": "../data/cases/<case>/power.bin",
  "prior_temperature_path": "../data/cases/<case>/comsol/comso_<actual_dof>/temp.bin",
  "reference_temperature_path": "../data/cases/<case>/comsol/comso_full/temp.bin",
  "temperature_offset": 0
}
```

`prior_temperature_path` is used only for FastRW tail correction.
`reference_temperature_path` is used for `GT_Temperature` and error reporting.
PIRW disables tail correction, but still points at a reference field for metrics.

## Run

CPU smoke:

```bash
./scripts/build_and_run.sh configs/case1_power6.json 2 -1
```

Metal smoke or full runs:

```bash
./scripts/build_and_run_metal.sh configs/case1_power6.json 2 -1
./scripts/build_and_run_metal.sh configs/case1_power6.json 400 -1
```

Each run writes:

- `direct.csv`
- `FastRw.csv` compatibility alias
- `constraints.json`
- `onestage_with_self.csv`
- `onestage_no_self.csv`
- `summary.json`

Disable Onestage post-processing with `RUN_ONESTAGE=0`.

Run the paper smoke loop over all three cases:

```bash
./scripts/run_paper_experiments.js smoke
```

For full paper reruns, use:

```bash
./scripts/run_paper_experiments.js full
```

## COMSOL Priors

COMSOL inputs and generated temperature fields live under:

```text
data/cases/<case>/comsol/comso_<dof>/
```

For generated priors, `<dof>` is the actual COMSOL solution DoF parsed from
`comsol_batch.log`, not a target mesh label. If the DoF is not known yet, write
to a temporary `_pending_*` directory and rename after the solve.

The COMSOL helper is case-config driven:

```bash
./scripts/run_comsol_case3_rebuild.sh \
  --config configs/case2_4core_top1_bottom1.json \
  --output-dir data/cases/case2_4core_top1_bottom1/comsol/_pending_prior \
  --mesh-label pending_prior \
  --hmax '2[mm]' --hmin '200[um]' --hgrad 1.5
```

The helper exports `heat_layer_cell_center_temperatures.bin` and temperature CSV
files in Celsius. Finalized prior directories also contain a compatibility
`temp.bin` copy and `metadata.json`.
