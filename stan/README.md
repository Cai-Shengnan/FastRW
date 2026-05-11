# Stan Reference Model

`onestage.stan` is the only retained fusion model. The active runner uses
`scripts/run_onestage_fusion.js` to generate deterministic Onestage-style
posterior fused outputs directly from `constraints.json` and `direct.csv`.

The active output files are:

- `onestage_with_self.csv`
- `onestage_no_self.csv`
- `summary.json`

No HBM model is part of the current paper rerun workflow.
