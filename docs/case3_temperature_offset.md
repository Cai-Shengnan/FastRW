# Case3 16-Core Temperature Offset Diagnostic

`data.temperature_offset` exists only as an explicit data-import convention.
The default remains `273.15`, and `configs/case3_16core.json` does not set
a special offset.

During bias triage, the supplied supplementary output should be interpreted
with the same Celsius-to-Kelvin conversion:

- `data/icml_supplement_16_cores/results/Rw.csv`
- `data/icml_supplement_16_cores/bin/random_walker`

For the same `temp.bin`, reference `GT_Temperature` values should equal
`raw_temp + 273.15`.

Do not set a special `temperature_offset` for case3 unless the original data
source is independently shown to use a different convention. The remaining
root-cause work should compare random walk against a deterministic
CTM/finite-volume oracle and, if available, the original COMSOL model settings.
