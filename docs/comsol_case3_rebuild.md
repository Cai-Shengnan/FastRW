# COMSOL Case3 Rebuild Pipeline

This pipeline rebuilds a deterministic COMSOL 6.2 model for `configs/case3_16core.json` without empirical temperature calibration.

## Confirmed COMSOL CLI Path

COMSOL CLI:

```sh
/Applications/COMSOL62/Multiphysics/bin/comsol
```

COMSOL 6.2 supports the Java Model File workflow:

```sh
/Applications/COMSOL62/Multiphysics/bin/comsol compile file.java
/Applications/COMSOL62/Multiphysics/bin/comsol batch -inputfile file.class -outputfile result.mph
```

This was confirmed from local CLI help and the installed COMSOL Programming Reference Manual under:

```text
/Applications/COMSOL62/Multiphysics/doc/pdf/COMSOL_Multiphysics/COMSOL_ProgrammingReferenceManual.pdf
```

## Runner

Default full run:

```sh
scripts/run_comsol_case3_rebuild.sh
```

Compile only:

```sh
scripts/run_comsol_case3_rebuild.sh --compile-only
```

Build model and save a prepare-only MPH without solving:

```sh
scripts/run_comsol_case3_rebuild.sh --prepare-only
```

Fast smoke run with a coarse mesh:

```sh
scripts/run_comsol_case3_rebuild.sh --smoke
```

Optional overrides:

```sh
scripts/run_comsol_case3_rebuild.sh --np 8 --output-dir outputs/comsol_case3_rebuild
```

The runner is a zsh script and sources `~/.zshrc` before invoking COMSOL. It compiles a patched copy of the Java source under the output directory so the source file stays reusable for default, prepare-only, and smoke runs. It also uses an isolated COMSOL preferences directory to enable batch Java file access without changing the user's main COMSOL preferences.

## Model Definition

Source: `scripts/comsol_case3_rebuild.java`

Geometry is read from `configs/case3_16core.json`:

- domain: `20 mm x 20 mm`
- bottom medium: `1000 um`
- heat layer: `100 um`
- top medium: `500 um`
- heat cells: `100 x 100 x 5`
- `k_source = 125 W/(m*K)`
- `k_medium = 395 W/(m*K)`
- top and bottom Robin: `h = 4900 W/(m^2*K)`, `Tinf = 293.15 K`
- lateral boundaries: thermal insulation, equivalent to zero Neumann flux

Power input:

```text
data/16_cores_4900/5.28M/power.bin
```

The script treats each value as cell power in W and applies:

```text
Q_W_per_m3 = power_cell_W / (dx * dy * dz)
```

The interpolation function uses a 1D cell-index lookup over the `100 x 100 x 5` heat cells and is only applied on the heat-layer domain. This avoids relying on multi-column local interpolation tables, which COMSOL 6.2 rejects in batch Java mode.

## Smoke Mode

`--smoke` keeps the same geometry, materials, boundary conditions, power input, query points, and heat-cell output grid, but uses a deliberately coarse tetrahedral mesh:

```text
hmax = 4 mm
hmin = 500 um
hgrad = 2.0
```

Smoke output defaults to:

```text
outputs/comsol_case3_rebuild_smoke/
```

Use smoke mode only to verify the COMSOL Java API, solve path, interpolation, and file exports. It is not the reproducible COMSOL-new numerical reference for RW comparison.

## Outputs

Output directory:

```text
outputs/comsol_case3_rebuild/
```

Expected files:

- `comsol_version.txt`
- `comsol_batch.log`
- `power_density_cell_centers.csv`
- `query_points.csv`
- `query_temperatures.csv`
- `heat_layer_cell_center_temperatures.csv`
- `heat_layer_cell_center_temperatures.bin`
- `case3_rebuild.mph`
- `model_notes.txt`

`heat_layer_cell_center_temperatures.bin` is little-endian float64 in `iz`, `iy`, `ix` order.

The script also writes interpolation diagnostics:

- `interpolation_query_debug.txt`
- `interpolation_heat_layer_debug.txt`

These include COMSOL `getData`, `getReal`, and returned coordinate dimensions. The Java script fails instead of silently producing all-`NaN` temperatures if COMSOL interpolation returns no finite values.

## Verified Runs

Verified locally with COMSOL 6.2.0.290:

- `scripts/run_comsol_case3_rebuild.sh --compile-only`
- `scripts/run_comsol_case3_rebuild.sh --smoke`
- `scripts/run_comsol_case3_rebuild.sh`

The full run used about 2.0M tetrahedral elements and wrote finite query and heat-cell temperatures under `outputs/comsol_case3_rebuild/`. The smoke run used 36,814 tetrahedral elements and wrote finite outputs under `outputs/comsol_case3_rebuild_smoke/`.

If a local COMSOL installation rejects any API property name, run `--prepare-only` first and inspect `outputs/comsol_case3_rebuild/comsol_batch.log`; do not substitute calibrated temperatures.
