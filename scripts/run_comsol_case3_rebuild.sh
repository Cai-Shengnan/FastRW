#!/usr/bin/env zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
COMSOL_BIN="${COMSOL_BIN:-/Applications/COMSOL62/Multiphysics/bin/comsol}"
SRC_FILE="${ROOT_DIR}/scripts/comsol_case3_rebuild.java"
DEFAULT_OUT_DIR="${ROOT_DIR}/outputs/comsol_case3_rebuild"
OUT_DIR="${DEFAULT_OUT_DIR}"
PREFS_DIR="${COMSOL_PREFS_DIR:-}"
NP="${COMSOL_NP:-auto}"
COMPILE_ONLY=0
PREPARE_ONLY=0
SMOKE_MODE=0
OUT_DIR_SET=0
CONFIG_REL="configs/case3_16core.json"
MESH_LABEL="full"
MESH_HMAX="dx_cell"
MESH_HMIN="dz_cell"
MESH_HGRAD="1.2"
MESH_HNARROW="0.8"
MESH_HCURVE="0.3"

usage() {
  cat <<'USAGE'
Usage: scripts/run_comsol_case3_rebuild.sh [options]

Options:
  --config FILE        Case config to solve. Default: configs/case3_16core.json.
  --compile-only       Only run `comsol compile`; do not execute batch.
  --prepare-only       Run Java class with COMSOL_CASE3_SKIP_SOLVE=1.
  --smoke              Use a coarse mesh and default to outputs/comsol_case3_rebuild_smoke.
  --mesh-label NAME    Label recorded in metadata. Default: full.
  --hmax VALUE         COMSOL mesh hmax expression. Default: dx_cell.
  --hmin VALUE         COMSOL mesh hmin expression. Default: dz_cell.
  --hgrad VALUE        COMSOL mesh hgrad value. Default: 1.2.
  --hnarrow VALUE      COMSOL mesh hnarrow value. Default: 0.8.
  --hcurve VALUE       COMSOL mesh hcurve value. Default: 0.3.
  --output-dir DIR     Output directory. Default: outputs/comsol_case3_rebuild.
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
    --config)
      CONFIG_REL="$2"
      shift 2
      ;;
    --prepare-only)
      PREPARE_ONLY=1
      shift
      ;;
    --smoke)
      SMOKE_MODE=1
      MESH_LABEL="smoke"
      MESH_HMAX="4[mm]"
      MESH_HMIN="500[um]"
      MESH_HGRAD="2.0"
      MESH_HNARROW="1"
      MESH_HCURVE="1"
      shift
      ;;
    --mesh-label)
      MESH_LABEL="$2"
      shift 2
      ;;
    --hmax)
      MESH_HMAX="$2"
      shift 2
      ;;
    --hmin)
      MESH_HMIN="$2"
      shift 2
      ;;
    --hgrad)
      MESH_HGRAD="$2"
      shift 2
      ;;
    --hnarrow)
      MESH_HNARROW="$2"
      shift 2
      ;;
    --hcurve)
      MESH_HCURVE="$2"
      shift 2
      ;;
    --output-dir)
      OUT_DIR="$2"
      OUT_DIR_SET=1
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

if [[ "${SMOKE_MODE}" == "1" && "${OUT_DIR_SET}" == "0" ]]; then
  OUT_DIR="${ROOT_DIR}/outputs/comsol_case3_rebuild_smoke"
fi

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
if [[ "${CONFIG_REL}" == /* ]]; then
  CONFIG_FILE="${CONFIG_REL}"
  CONFIG_REL="${CONFIG_FILE#${ROOT_DIR}/}"
else
  CONFIG_FILE="${ROOT_DIR}/${CONFIG_REL}"
fi
if [[ ! -f "${CONFIG_FILE}" ]]; then
  echo "Missing case config: ${CONFIG_FILE}" >&2
  exit 2
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

BUILD_SRC="${OUT_DIR}/build/comsol_case3_rebuild.java"
CLASS_FILE="${OUT_DIR}/build/comsol_case3_rebuild.class"
cp "${SRC_FILE}" "${BUILD_SRC}"

ROOT_JAVA="$(java_literal "${ROOT_DIR}")"
OUT_JAVA="$(java_literal "${OUT_DIR}")"
CONFIG_JAVA="$(java_literal "${CONFIG_REL}")"
SKIP_JAVA="false"
if [[ "${PREPARE_ONLY}" == "1" ]]; then
  SKIP_JAVA="true"
fi
SMOKE_JAVA="false"
if [[ "${SMOKE_MODE}" == "1" ]]; then
  SMOKE_JAVA="true"
fi
MESH_LABEL_JAVA="$(java_literal "${MESH_LABEL}")"
MESH_HMAX_JAVA="$(java_literal "${MESH_HMAX}")"
MESH_HMIN_JAVA="$(java_literal "${MESH_HMIN}")"
MESH_HGRAD_JAVA="$(java_literal "${MESH_HGRAD}")"
MESH_HNARROW_JAVA="$(java_literal "${MESH_HNARROW}")"
MESH_HCURVE_JAVA="$(java_literal "${MESH_HCURVE}")"
perl -0pi -e "s#private static final String DEFAULT_REPO_ROOT = \".*?\";#private static final String DEFAULT_REPO_ROOT = \"${ROOT_JAVA}\";#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final String CONFIG_REL = \".*?\";#private static final String CONFIG_REL = \"${CONFIG_JAVA}\";#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final String BUILD_OUTPUT_DIR = \".*?\";#private static final String BUILD_OUTPUT_DIR = \"${OUT_JAVA}\";#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final boolean BUILD_SKIP_SOLVE = (true|false);#private static final boolean BUILD_SKIP_SOLVE = ${SKIP_JAVA};#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final boolean BUILD_SMOKE_MODE = (true|false);#private static final boolean BUILD_SMOKE_MODE = ${SMOKE_JAVA};#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final String BUILD_MESH_LABEL = \".*?\";#private static final String BUILD_MESH_LABEL = \"${MESH_LABEL_JAVA}\";#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final String BUILD_MESH_HMAX = \".*?\";#private static final String BUILD_MESH_HMAX = \"${MESH_HMAX_JAVA}\";#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final String BUILD_MESH_HMIN = \".*?\";#private static final String BUILD_MESH_HMIN = \"${MESH_HMIN_JAVA}\";#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final String BUILD_MESH_HGRAD = \".*?\";#private static final String BUILD_MESH_HGRAD = \"${MESH_HGRAD_JAVA}\";#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final String BUILD_MESH_HNARROW = \".*?\";#private static final String BUILD_MESH_HNARROW = \"${MESH_HNARROW_JAVA}\";#s" "${BUILD_SRC}"
perl -0pi -e "s#private static final String BUILD_MESH_HCURVE = \".*?\";#private static final String BUILD_MESH_HCURVE = \"${MESH_HCURVE_JAVA}\";#s" "${BUILD_SRC}"

echo "COMSOL: ${COMSOL_BIN}"
"${COMSOL_BIN}" -version | tee "${OUT_DIR}/comsol_version.txt"

echo "Compiling ${BUILD_SRC}"
(
  cd "${OUT_DIR}/build"
  "${COMSOL_BIN}" compile "comsol_case3_rebuild.java"
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
    -outputfile "${OUT_DIR}/case3_rebuild.mph" \
    -batchlog "${OUT_DIR}/comsol_batch.log" \
    -batchlogout
)
