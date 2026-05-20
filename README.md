# FastRW

GPU random-walk thermal solver and experiment harness for the
**FastRW / FasterRW** algorithms (Apple Metal + C++17).

[![bootstrap case 1](docs/figures/bootstrap_case1.png)](docs/figures/bootstrap_case1.png)

`FastRW` (Alg. 1 + 2) couples an FEM prior with a residual random walk
that reuses correlated path tails for inverse-variance fusion. `FasterRW`
(Alg. 1 + 2 + 3) adds a universal-kriging Gaussian-process refinement in
prior-error coordinates. This repository reproduces every table and
figure in the accompanying TCAD paper from precomputed COMSOL priors and
a single one-key driver.

---

## Contents

- [Quick start](#quick-start)
- [Layout](#layout)
- [Reproduction flow](#reproduction-flow)
- [Manual per-phase invocation](#manual-per-phase-invocation)
- [Configuration](#configuration)
- [Algorithm summary](#algorithm-summary)
- [Hardware and platform notes](#hardware-and-platform-notes)
- [Citation](#citation)
- [License](#license)

---

## Quick start

The full reproduction (Table 1 + Tables tab:{multi,tradeoff,weakprior,time} +
Fig. bootstrap + HTML summary) runs in **about 1 minute on Apple M-series**
when the shipped Phase-1 long-MC artifacts are used, or **~12 minutes**
if you re-run Phase 1 from scratch.

```bash
# 1. Clone and set up the conda env (env name: fastrw)
git clone https://github.com/<your-org>/ResRW.git
cd ResRW
conda env create -f environment.yml
conda activate fastrw

# 2. Download the artifact archive (193 MB uncompressed, 58 MB zip).
#    Public Google Drive link (replace with the upload URL):
#
#        https://drive.google.com/<TODO_REPLACE_WITH_REAL_LINK>
#
#    Save it as ./resrw-artifacts-v1.zip at the repo root.

# 3. Extract it in place (data/ and outputs/tcad_table1/ are populated)
./scripts/fetch_artifacts.sh

# 4. Reproduce everything
./reproduce.sh
```

Open `outputs/report.html` in any browser — it is a single self-contained
HTML file with every table rendered and every bootstrap figure embedded.

> The artifact archive is **not** stored in git (it is too large). If you
> do not download it, `./reproduce.sh` will fall through to Phase 1
> (Metal MC, ~10 min on an M-series GPU) and produce the same outputs
> from scratch.

---

## Layout

```
ResRW/
├── README.md, LICENSE, CMakeLists.txt, environment.yml, .gitignore
├── reproduce.sh                  one-key Phase 1 -> 2 -> 3 -> 4 driver
│
├── src/                          C++17 random-walk core
│   ├── main.cpp, main_metal.cpp  CPU and Metal entrypoints
│   ├── walker.cpp, walker_metal.mm
│   ├── geometry.cpp, simulation_config.cpp
├── include/                      headers
├── third_party/nlohmann/         vendored JSON
│
├── scripts/                      curated one-key flow + helpers
│   ├── build_and_run_metal.sh    GPU MC executor (called by run_*_direct.sh)
│   ├── build_and_run.sh          CPU fallback (portable; Linux-compatible)
│   ├── run_pirw_direct.sh        Phase 1: PIRW Monte Carlo (N_max=4096)
│   ├── run_fastrw_direct.sh      Phase 1: FastRW Monte Carlo (N_max=8192)
│   ├── run_pirw_post.{sh,js}     Phase 2: PIRW bootstrap at paper-locked N
│   ├── run_fastrw_post.{sh,js}   Phase 2: FastRW bootstrap (Alg. 1+2)
│   ├── run_fasterrw_post.{sh,js} Phase 2: FasterRW bootstrap (Alg. 1+2+3)
│   ├── run_bootstrap_sweep.{sh,js}  Phase 3: dense N-grid sweep + Fig. bootstrap
│   ├── plot_bootstrap_curves.py     Phase 3: bootstrap_case{1,2,3}.{png,pdf}
│   ├── run_group_size_sweep.{sh,js} Phase 3: tab:multi
│   ├── run_prior_dof_sweep.{sh,js}  Phase 3: tab:tradeoff
│   ├── run_weak_prior.{sh,js}       Phase 3: tab:weakprior
│   ├── run_wallclock_breakdown.{sh,js} Phase 3: tab:time
│   ├── build_table1_bootstrap.js    Phase 3: markdown Table 1 from sweep
│   ├── build_html_report.py         Phase 4: self-contained outputs/report.html
│   ├── fetch_artifacts.sh           extract artifact zip in place
│   └── _lib.js                      shared JS helpers
│
├── configs/
│   ├── tcad_table1/                 canonical 3-case configs (Phase 1, 2)
│   │   ├── pirw_case{1,2,3}.json    PIRW (no tail correction)
│   │   └── fastrw_case{1,2,3}.json  FastRW (tail correction on)
│   ├── tcad_table_tradeoff/         3 DoF levels for tab:tradeoff
│   └── tcad_table_weakprior/        rule-of-thumb prior for tab:weakprior
│
├── docs/figures/                    committed PNGs of Fig. bootstrap
├── data/                            gitignored; populated by fetch_artifacts.sh
├── outputs/                         gitignored; populated by fetch_artifacts.sh + reproduce.sh
└── legacy/                          unmaintained; diagnostics + COMSOL-rebuild
```

The fixed experiment seed is **42** throughout. All current configs use
`walker.delta_x = 5e-7`, `boundary.rho = 1.56`, and therefore
`boundary.epsilon.{neumann,robin} = 7.8e-7`.

---

## Reproduction flow

```
                     fetch_artifacts.sh
                            |
                            v
            +---------------+---------------+
            |   data/cases/case{1,2,3}/      |
            |   outputs/tcad_table1/...      |  (shipped)
            +---------------+---------------+
                            |
                            v
             reproduce.sh   (auto-skips Phase 1 if MC outputs present)
                            |
        ===================== Phase 1 =====================
                            |  (skipped when shipped artifacts present)
            run_pirw_direct.sh    --> outputs/tcad_table1/pirw_case{1,2,3}/
            run_fastrw_direct.sh  --> outputs/tcad_table1/fastrw_case{1,2,3}/
                            |
        ===================== Phase 2 =====================
                            |
            run_pirw_post.sh      \
            run_fastrw_post.sh     >  outputs/tcad_table1/paper_results/
            run_fasterrw_post.sh  /          case*_*_eps{0.4,0.5}.json
                            |
        ===================== Phase 3 =====================
                            |
            run_bootstrap_sweep.sh         bootstrap_sweep_*.json + Fig. bootstrap
            run_group_size_sweep.sh        case1_group_sweep.json     (tab:multi)
            run_prior_dof_sweep.sh         case1_dof_sweep.json       (tab:tradeoff)
              --skip-fem --skip-mc          (uses shipped Phase-3 MC + timing files)
            run_weak_prior.sh              case1_weakprior_summary.json (tab:weakprior)
              --skip-mc                     (uses shipped Lambda=1e-3 MC)
            run_wallclock_breakdown.sh     case1_eps04_wallclock.json (tab:time)
                            |
        ===================== Phase 4 =====================
                            |
            build_html_report.py  --> outputs/report.html
```

`reproduce.sh` flags:

| Flag | Effect |
| ---- | ------ |
| `--cases=1,2,3` | Restrict to a subset of cases (Phases 1 + 2). |
| `--force-phase1` | Re-run Phase 1 even if shipped MC outputs are present. |
| `--skip-phase3` | Skip the four sub-experiments and the bootstrap-sweep figure. |
| `--skip-report` | Skip the `outputs/report.html` build at the end. |

---

## Manual per-phase invocation

Every helper accepts `--help` (or `-h`) for its full contract. Typical
recipes follow.

### Phase 1 — Metal Monte Carlo

```bash
./scripts/run_pirw_direct.sh        # all three cases, N=4096 paths
./scripts/run_pirw_direct.sh 2      # case 2 only
./scripts/run_fastrw_direct.sh      # all three cases, N=8192 paths
```

Each case writes `direct.csv`, `constraints.json` (the per-path state
stream consumed by post-processing), `summary.json`, and a `last_*.log`.

### Phase 2 — paper-locked-N bootstrap

```bash
./scripts/run_pirw_post.sh          # all cases, both eps
./scripts/run_fastrw_post.sh        # Alg. 1+2
./scripts/run_fasterrw_post.sh      # Alg. 1+2+3
```

Each `(case, method, eps)` cell is computed with **B=500** bootstrap
trials. Outputs land at
`outputs/tcad_table1/paper_results/case{1,2,3}_{pirw,fastrw,fasterrw}_eps{0.4,0.5}.json`.

### Phase 3 — sub-experiments

```bash
./scripts/run_bootstrap_sweep.sh                 # dense N grid + Fig. bootstrap
./scripts/run_group_size_sweep.sh                # tab:multi  (Case 1)
./scripts/run_prior_dof_sweep.sh --skip-fem --skip-mc   # tab:tradeoff (no COMSOL)
./scripts/run_weak_prior.sh --skip-mc            # tab:weakprior
./scripts/run_wallclock_breakdown.sh             # tab:time
```

### Phase 4 — HTML report

```bash
python3 scripts/build_html_report.py
open outputs/report.html
```

---

## Configuration

Every config under `configs/` has the same schema. Temperature inputs
are split by role:

```json
{
  "data": {
    "power_density_path":        "../../data/cases/<case>/power.bin",
    "prior_temperature_path":    "../../data/cases/<case>/comsol/comso_<dof>/temp.bin",
    "reference_temperature_path":"../../data/cases/<case>/comsol/comso_full/temp.bin",
    "temperature_offset": 0
  }
}
```

- `prior_temperature_path` is the FEM-prior temperature field used by
  FastRW's tail correction; PIRW configs set
  `walker.use_tail_correction: false` and ignore the prior.
- `reference_temperature_path` is the ground-truth field used **only**
  for metric reporting (`GT_Temperature` in `direct.csv`).
- `walker.delta_x`, `boundary.rho`, `boundary.epsilon.*` are locked
  across the paper and should not be modified for reproduction.

`run.seed = 42` everywhere. The Metal kernel is deterministic given
the same seed, threadgroup count, and binary.

### Temperature units

`temp.bin` files in `data/cases/*/comsol/*/` and `rule_of_thumb/` are
stored **in Celsius**. The C++ kernel handles ambient subtraction
internally; `temperature_offset` in the config is an additive K offset
applied after the walk.

---

## Algorithm summary

The Robin-boundary thermal PDE is solved by an Itô diffusion in a
three-layer geometry (bottom / heat-source / top), terminated by:
- **Robin reflection** at top and bottom slabs (parameter `h`),
- **Neumann reflection** at lateral walls,
- **Dirichlet absorption** at the source plane (via tail correction).

#### PIRW (baseline)

For each query, draw `N` random walks; each walk's terminal Robin
contribution plus the local-time integral of the power source gives an
unbiased temperature estimate. The plain Monte-Carlo average is
reported.

#### FastRW = Alg. 1 + 2 (this repo)

- **Alg. 1 (path-tail truncation, Λ):** every walk truncates its tail
  once its remaining-weight falls below `Λ` and reuses the prior at the
  truncation point. The bias introduced is `≤ Λ · max_prior_error`.
- **Alg. 2 (inverse-variance fusion, no-self):** each walk's full
  observation plus its truncated-prior reuse become two correlated
  measurements; we combine them with the leave-one-out covariance from
  the other walks at the same query. This is the
  `bootstrap_sweep_fastrw.json::fastrw_avg_abs_*` series.

#### FasterRW = Alg. 1 + 2 + 3

- **Alg. 3 (universal-kriging GP residual):** at each query, regress
  the FastRW residual (FastRW estimate − prior) against the M-1 other
  queries' residuals with a universal-kriging GP (Matern-3/2 kernel,
  amplitude inflated by `amp_factor`). The kriged prediction replaces
  the raw FastRW value. This is the `fasterrw_avg_abs_*` series.

See the paper for derivations; per-script headers (e.g.
`scripts/run_bootstrap_sweep.sh`) document the metric definitions.

---

## Hardware and platform notes

- **Recommended:** Apple Silicon Mac (M1 or later). The Metal kernel
  was developed and benchmarked on **Apple M5 Pro**.
- **Linux / non-Apple:** `scripts/build_and_run.sh` builds the CPU
  `random_walker` target on any POSIX system with C++17 + threads, but
  the runs are roughly **30–60×** slower than Metal. The CPU target is
  unmaintained for paper-locked configs; use it only for development
  smoke tests.
- **Node.js:** all post-processing is pure stdlib Node (`>= 18`).
  There is **no** `npm install` step.
- **Python:** only `numpy` and `matplotlib` are required (in
  `environment.yml`).
- **COMSOL:** the open-source flow **does not require a COMSOL
  license**. The artifact archive ships every prior temperature field
  the pipeline consumes. Scripts that re-generate COMSOL priors
  (`legacy/scripts/run_comsol_*.sh`) are retained in `legacy/` for
  transparency.

### Bit-level reproducibility caveats

- The Metal kernel is deterministic on a given GPU + Metal binary, but
  cross-GPU outputs may differ by a few ULPs.
- Post-processing is fully deterministic (pure Node, no FP atomics).
- Bootstrap seeds derive deterministically from `(seed_base, B, trial)`.

---

## Artifact archive contents

`resrw-artifacts-v1.zip` (≈ 58 MB compressed, 193 MB extracted, 236
files) contains:

| Path | Purpose |
| ---- | ------- |
| `data/cases/case{1,2,3}/power.bin` | Power-density input. |
| `data/cases/case{1,2,3}/metadata.json` | Case metadata. |
| `data/cases/case{1,2,3}/comsol/comso_*/temp.bin` | FEM prior temperature (Celsius). |
| `data/cases/case{1,2,3}/comsol/comso_*/metadata.json` | DoF, COMSOL solve runtime. |
| `data/cases/case1_power6/comsol/comso_{699,1288,10254}/timing_warm.json` | FEM warm-mesh wallclock (for tab:tradeoff / tab:time). |
| `data/cases/case1_power6/rule_of_thumb/` | Uniform prior used by tab:weakprior. |
| `outputs/tcad_table1/{fastrw,pirw}_case{1,2,3}/direct.csv,constraints.json,...` | Phase-1 long-MC outputs (N_max = 4096 PIRW, 8192 FastRW). |
| `outputs/tcad_table_tradeoff/dof{699,1288,10254}/` | Phase-3 MC for tab:tradeoff. |
| `outputs/tcad_table_weakprior/fastrw_case1_rot/` | Phase-3 MC for tab:weakprior (Λ=1e-3 weak prior). |

Items intentionally **not** shipped: COMSOL `.mph` project files, raw
CSV duplicates of `temp.bin`, COMSOL workspace prefs, and case 4 / 5
data which the public reproduction flow does not touch.

---

## Citation

If you use this code or the FastRW / FasterRW algorithms, please cite:

```bibtex
@article{wang_fastrw_2026,
  title   = {FastRW: ...},
  author  = {Wang, Zixiao and ...},
  journal = {IEEE Transactions on Computer-Aided Design},
  year    = {2026},
  note    = {To appear}
}
```

(Fill in venue, DOI, and the precalculation-PIRW reference once
finalized.)

---

## License

MIT — see [LICENSE](LICENSE).
