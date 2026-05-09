#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMSOL_BIN="${COMSOL_BIN:-/Applications/COMSOL62/Multiphysics/bin/comsol}"
SRC_FILE="${ROOT_DIR}/scripts/comsol_powered_slab_benchmark.java"
DEFAULT_OUT_DIR="${ROOT_DIR}/outputs/comsol_powered_slab_benchmark"
OUT_DIR="${DEFAULT_OUT_DIR}"
PREFS_DIR="${COMSOL_PREFS_DIR:-}"
NP="${COMSOL_NP:-auto}"
COMPILE_ONLY=0
PREPARE_ONLY=0
SMOKE_MODE=1
RUN_RW_SMOKE=0
RW_SAMPLES=200
RW_EXECUTABLE=""

usage() {
  cat <<'USAGE'
Usage: scripts/run_comsol_powered_slab_benchmark.sh [options]

Options:
  --compile-only       Only run `comsol compile`; do not execute batch.
  --prepare-only       Run Java class with BUILD_SKIP_SOLVE=1.
  --smoke              Use smoke case set and mesh. This is the default.
  --full               Add the t_heat sweep case and use a finer mesh.
  --rw-smoke           After COMSOL, run generated RW configs and write combined_summary.csv/json.
  --rw-samples N       Sample count passed to RW for each generated config. Default: 200.
  --rw-executable EXE  RW executable. Default: build-metal/random_walker, then build/random_walker.
  --output-dir DIR     Output directory. Default: outputs/comsol_powered_slab_benchmark.
  --prefs-dir DIR      Isolated COMSOL prefs directory. Default: <output-dir>/comsol_prefs.
  --np N               COMSOL -np value. Default: auto or COMSOL_NP.
  --comsol PATH        COMSOL CLI path. Default: /Applications/COMSOL62/Multiphysics/bin/comsol.
  -h, --help           Show this help.

Environment:
  COMSOL_BIN           Override COMSOL CLI path.
  COMSOL_NP            Override COMSOL core count.
  COMSOL_PREFS_DIR     Override isolated COMSOL preferences directory.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --compile-only)
      COMPILE_ONLY=1
      shift
      ;;
    --prepare-only)
      PREPARE_ONLY=1
      shift
      ;;
    --smoke)
      SMOKE_MODE=1
      shift
      ;;
    --full)
      SMOKE_MODE=0
      shift
      ;;
    --rw-smoke)
      RUN_RW_SMOKE=1
      shift
      ;;
    --rw-samples)
      RW_SAMPLES="$2"
      shift 2
      ;;
    --rw-executable)
      RW_EXECUTABLE="$2"
      shift 2
      ;;
    --output-dir)
      OUT_DIR="$2"
      shift 2
      ;;
    --prefs-dir)
      PREFS_DIR="$2"
      shift 2
      ;;
    --np)
      NP="$2"
      shift 2
      ;;
    --comsol)
      COMSOL_BIN="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -f "${HOME}/.zshrc" ]]; then
  set +u
  source "${HOME}/.zshrc"
  set -u
fi

if [[ ! -x "${COMSOL_BIN}" ]]; then
  echo "COMSOL CLI is not executable: ${COMSOL_BIN}" >&2
  exit 2
fi
if [[ ! -f "${SRC_FILE}" ]]; then
  echo "Missing Java source: ${SRC_FILE}" >&2
  exit 2
fi

if [[ "${OUT_DIR}" != /* ]]; then
  OUT_DIR="${ROOT_DIR}/${OUT_DIR}"
fi
if [[ -z "${PREFS_DIR}" ]]; then
  PREFS_DIR="${OUT_DIR}/comsol_prefs"
elif [[ "${PREFS_DIR}" != /* ]]; then
  PREFS_DIR="${ROOT_DIR}/${PREFS_DIR}"
fi

java_literal() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  print -r -- "${value}"
}

mkdir -p "${OUT_DIR}/build"
mkdir -p "${PREFS_DIR}"
PREFS_FILE="${PREFS_DIR}/comsol.prefs"
USER_PREFS="${HOME}/Library/Preferences/COMSOL/v62/comsol.prefs"
if [[ ! -f "${PREFS_FILE}" ]]; then
  if [[ -f "${USER_PREFS}" ]]; then
    cp "${USER_PREFS}" "${PREFS_FILE}"
  else
    : > "${PREFS_FILE}"
  fi
fi

set_pref() {
  local key="$1"
  local value="$2"
  local escaped_key="${key//./\\.}"
  if grep -q "^${escaped_key}=" "${PREFS_FILE}"; then
    perl -0pi -e "s#^${escaped_key}=.*#${key}=${value}#m" "${PREFS_FILE}"
  else
    print -r -- "${key}=${value}" >> "${PREFS_FILE}"
  fi
}

set_pref "security.comsol.allowbatch" "on"
set_pref "security.comsol.allowmethods" "on"
set_pref "security.external.enable" "off"
set_pref "security.external.filepermission" "all"
set_pref "security.external.propertypermission" "on"
set_pref "security.external.runtimepermission" "on"

BUILD_SRC="${OUT_DIR}/build/comsol_powered_slab_benchmark.java"
CLASS_FILE="${OUT_DIR}/build/comsol_powered_slab_benchmark.class"
cp "${SRC_FILE}" "${BUILD_SRC}"

ROOT_JAVA="$(java_literal "${ROOT_DIR}")"
OUT_JAVA="$(java_literal "${OUT_DIR}")"
SKIP_JAVA="false"
if [[ "${PREPARE_ONLY}" == "1" ]]; then
  SKIP_JAVA="true"
fi
SMOKE_JAVA="false"
if [[ "${SMOKE_MODE}" == "1" ]]; then
  SMOKE_JAVA="true"
fi

perl -0pi -e "s#private static final String DEFAULT_REPO_ROOT = \".*?\";#private static final String DEFAULT_REPO_ROOT = \"${ROOT_JAVA}\";#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final String BUILD_OUTPUT_DIR = \".*?\";#private static final String BUILD_OUTPUT_DIR = \"${OUT_JAVA}\";#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final boolean BUILD_SKIP_SOLVE = (true|false);#private static final boolean BUILD_SKIP_SOLVE = ${SKIP_JAVA};#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final boolean BUILD_SMOKE_MODE = (true|false);#private static final boolean BUILD_SMOKE_MODE = ${SMOKE_JAVA};#s" "${BUILD_SRC}"

echo "COMSOL: ${COMSOL_BIN}"
"${COMSOL_BIN}" -version | tee "${OUT_DIR}/comsol_version.txt"

echo "Compiling ${BUILD_SRC}"
(
  cd "${OUT_DIR}/build"
  "${COMSOL_BIN}" compile "comsol_powered_slab_benchmark.java"
)

if [[ ! -f "${CLASS_FILE}" ]]; then
  echo "Expected class file was not produced: ${CLASS_FILE}" >&2
  exit 1
fi

if [[ "${COMPILE_ONLY}" == "1" ]]; then
  echo "Compile-only complete: ${CLASS_FILE}"
  exit 0
fi

echo "Running COMSOL batch. Output directory: ${OUT_DIR}"
echo "Using isolated COMSOL prefs: ${PREFS_DIR}"
rm -f "${OUT_DIR}/java_exception.txt"
COMSOL_NP_ARGS=()
if [[ "${NP}" != "auto" ]]; then
  COMSOL_NP_ARGS=(-np "${NP}")
fi
(
  cd "${ROOT_DIR}"
  "${COMSOL_BIN}" -prefsdir "${PREFS_DIR}" "${COMSOL_NP_ARGS[@]}" batch \
    -inputfile "${CLASS_FILE}" \
    -outputfile "${OUT_DIR}/powered_slab_benchmark.mph" \
    -batchlog "${OUT_DIR}/comsol_batch.log" \
    -batchlogout
)

if [[ -f "${OUT_DIR}/java_exception.txt" ]]; then
  echo "COMSOL Java run wrote ${OUT_DIR}/java_exception.txt" >&2
  exit 1
fi
if [[ ! -f "${OUT_DIR}/benchmark_summary.csv" ]]; then
  echo "Missing expected COMSOL summary: ${OUT_DIR}/benchmark_summary.csv" >&2
  exit 1
fi

if [[ "${RUN_RW_SMOKE}" != "1" ]]; then
  echo "RW smoke not requested. COMSOL/analytic summary: ${OUT_DIR}/benchmark_summary.csv"
  exit 0
fi

if [[ -z "${RW_EXECUTABLE}" ]]; then
  if [[ -x "${ROOT_DIR}/build-metal/random_walker" ]]; then
    RW_EXECUTABLE="${ROOT_DIR}/build-metal/random_walker"
  elif [[ -x "${ROOT_DIR}/build/random_walker" ]]; then
    RW_EXECUTABLE="${ROOT_DIR}/build/random_walker"
  else
    echo "Missing RW executable. Build random_walker or pass --rw-executable." >&2
    exit 2
  fi
fi
if [[ "${RW_EXECUTABLE}" != /* ]]; then
  RW_EXECUTABLE="${ROOT_DIR}/${RW_EXECUTABLE}"
fi
if [[ ! -x "${RW_EXECUTABLE}" ]]; then
  echo "RW executable is not executable: ${RW_EXECUTABLE}" >&2
  exit 2
fi

echo "Running RW smoke with ${RW_EXECUTABLE}; samples=${RW_SAMPLES}"
for config in "${OUT_DIR}"/rw_configs/*.json(N); do
  echo "RW config: ${config}"
  "${RW_EXECUTABLE}" "${config}" "${RW_SAMPLES}" 1
done

node - "${OUT_DIR}" <<'NODE'
const fs = require("fs");
const path = require("path");

const outDir = process.argv[2];

function parseCsv(file) {
  const text = fs.readFileSync(file, "utf8").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const header = lines.shift().split(",");
  return lines.map((line) => {
    const values = line.split(",");
    const row = {};
    header.forEach((key, i) => {
      const raw = values[i] ?? "";
      const num = Number(raw);
      row[key] = raw === "" || Number.isNaN(num) ? raw : num;
    });
    return row;
  });
}

function writeCsv(file, rows) {
  const header = [
    "case_id",
    "rw_mode",
    "h_top_W_m2K",
    "q_vol_W_m3",
    "t_heat_m",
    "analytic_T_K",
    "comsol_T_K",
    "comsol_minus_analytic_K",
    "RW_Normal_Mean",
    "RW_minus_analytic_K",
    "RW_minus_COMSOL_K",
    "component_T0_heat",
    "component_T1_tail_or_dirichlet",
    "component_T3_robin",
    "component_sum",
    "component_difference",
    "top_T3_robin",
    "bottom_T3_robin",
    "robin_local_time",
    "final_e_hat_mean",
    "cutoff_fraction",
    "RW_status",
  ];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => row[key] ?? "").join(","));
  }
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
}

const baseRows = parseCsv(path.join(outDir, "benchmark_summary.csv"));
const byCase = new Map(baseRows.map((row) => [row.case_id, row]));
const combined = [];
const configsDir = path.join(outDir, "rw_configs");
for (const name of fs.readdirSync(configsDir).filter((name) => name.endsWith(".json")).sort()) {
  const config = JSON.parse(fs.readFileSync(path.join(configsDir, name), "utf8"));
  const match = name.match(/^(.*)_(current|event|hit)\.json$/);
  const caseId = match ? match[1] : config.case_name;
  const mode = config.walker.robin_local_time_mode;
  const base = byCase.get(caseId);
  if (!base) continue;
  const runDir = config.output.directory;
  const csvFile = path.join(runDir, config.output.csv || "FastRw.csv");
  const diagFile = path.join(runDir, config.output.diagnostics || "diagnostics.json");
  const row = {
    case_id: caseId,
    rw_mode: mode,
    h_top_W_m2K: base.h_top_W_m2K,
    q_vol_W_m3: base.q_vol_W_m3,
    t_heat_m: base.t_heat_m,
    analytic_T_K: base.analytic_T_K,
    comsol_T_K: base.comsol_T_K,
    comsol_minus_analytic_K: base.comsol_minus_analytic_K,
    RW_status: "missing",
  };
  if (fs.existsSync(csvFile) && fs.existsSync(diagFile)) {
    const rw = parseCsv(csvFile)[0];
    const diag = JSON.parse(fs.readFileSync(diagFile, "utf8")).point_diagnostics[0];
    const components = diag.components || {};
    const robin = diag.robin || {};
    row.RW_Normal_Mean = rw.Normal_Mean;
    row.RW_minus_analytic_K = rw.Normal_Mean - base.analytic_T_K;
    row.RW_minus_COMSOL_K = rw.Normal_Mean - base.comsol_T_K;
    row.component_T0_heat = components.T0_heat;
    row.component_T1_tail_or_dirichlet = components.T1_tail_or_dirichlet;
    row.component_T3_robin = components.T3_robin;
    row.component_sum = diag.component_sum;
    row.component_difference = diag.component_difference;
    row.top_T3_robin = robin.top_T3_robin_mean;
    row.bottom_T3_robin = robin.bottom_T3_robin_mean;
    row.robin_local_time = robin.effective_local_time_mean;
    row.final_e_hat_mean = diag.final_e_hat_mean;
    row.cutoff_fraction = diag.cutoff ? diag.cutoff.fraction : "";
    row.RW_status = "ok";
  }
  combined.push(row);
}
writeCsv(path.join(outDir, "combined_summary.csv"), combined);
fs.writeFileSync(path.join(outDir, "combined_summary.json"), `${JSON.stringify({ rows: combined }, null, 2)}\n`);
NODE

echo "Combined COMSOL/analytic/RW summary: ${OUT_DIR}/combined_summary.csv"
