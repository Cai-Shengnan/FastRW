#!/usr/bin/env python3
"""Plot bootstrap-mean ± 1σ curves for PIRW / FastRW / FasterRW across case1/case2/case3.

For each case <k>, reads:
  outputs/tcad_table1/pirw_case<k>/bootstrap_sweep_pirw.json
  outputs/tcad_table1/fastrw_case<k>/bootstrap_sweep_fastrw.json
and writes:
  outputs/tcad_table1/case<k>_bootstrap_curve.{png,pdf}

Three curves per plot with shaded ±1σ bands, horizontal dashed lines at
ε ∈ {0.3, 0.4, 0.5} K, hollow circle markers at the smallest N (per method)
that crosses each ε threshold.

Usage:
  scripts/plot_bootstrap_curves.py                # all three cases
  scripts/plot_bootstrap_curves.py 1 3            # only case1 and case3
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.ticker import MultipleLocator

# LaTeX-style English font: Computer Modern via mathtext, serif elsewhere.
# Avoids requiring an actual LaTeX install (text.usetex=False).
mpl.rcParams["font.family"] = "serif"
mpl.rcParams["font.serif"] = ["CMU Serif", "Computer Modern Roman", "DejaVu Serif"]
mpl.rcParams["mathtext.fontset"] = "cm"

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "outputs" / "tcad_table1"

CASE_META = {
    1: {"label": "Case 1", "prior_dof": 1288, "prior_avg_abs": 0.71},
    2: {"label": "Case 2", "prior_dof": 2779, "prior_avg_abs": 0.94},
    3: {"label": "Case 3", "prior_dof": 2841, "prior_avg_abs": 0.40},
}


def build_case(k: int) -> dict:
    meta = CASE_META[k]
    return {
        **meta,
        "fastrw_dir": DATA_DIR / f"fastrw_case{k}",
        "pirw_dir":   DATA_DIR / f"pirw_case{k}",
        "out_stem":   DATA_DIR / f"bootstrap_case{k}",
    }

EPS_LIST = [0.5, 0.4]
COLORS = {
    "pirw": "#5e5e5e",       # gray
    "fastrw": "#1f6feb",     # blue
    "fasterrw": "#e36209",   # orange
}

# Unified font size for every text element.
FS = 20

# Y-axis upper limit (shared across cases).
YMAX = 1.5


def load_curve(json_path: Path, prefix: str):
    """Return (Xs, means, stds) sorted by X = N * mean_avg_steps.

    X measures total path-step work (the fair compute-cost axis): PIRW
    paths run full length, FastRW truncates, so the same N corresponds
    to very different amounts of work.
    """
    with open(json_path) as f:
        data = json.load(f)
    rows = sorted(data["results"], key=lambda r: r["N"])
    # Per-N mean_avg_steps if present (FastRW sweeps log it per row);
    # otherwise fall back to the top-level scalar.
    fallback_steps = data.get("mean_avg_steps")
    steps = np.array([r.get("mean_avg_steps", fallback_steps) for r in rows], dtype=float)
    Ns = np.array([r["N"] for r in rows], dtype=float)
    Xs = Ns * steps
    means = np.array([r[f"{prefix}_avg_abs_mean"] for r in rows], dtype=float)
    stds = np.array([r[f"{prefix}_avg_abs_std"] for r in rows], dtype=float)
    return Xs, means, stds


def pick_x_star(Xs, means, eps):
    """Smallest X where mean <= eps."""
    for x, m in sorted(zip(Xs.tolist(), means.tolist())):
        if m <= eps:
            return x, m
    return None


def plot_one_case(case):
    fastrw_json = case["fastrw_dir"] / "bootstrap_sweep_fastrw.json"
    pirw_json = case["pirw_dir"] / "bootstrap_sweep_pirw.json"
    for p in (fastrw_json, pirw_json):
        if not p.exists():
            raise FileNotFoundError(
                f"{p} not found -- run scripts/run_bootstrap_sweep.sh first."
            )

    pX, pM, pS = load_curve(pirw_json, "direct")
    fX, fM, fS = load_curve(fastrw_json, "fastrw")
    feX, feM, feS = load_curve(fastrw_json, "fasterrw")

    # Rescale to billions of path-steps for axis readability.
    UNIT = 1e9
    pXu, fXu, feXu = pX / UNIT, fX / UNIT, feX / UNIT

    fig, ax = plt.subplots(figsize=(7, 5), dpi=150)

    def plot_curve(ax, Xs, means, stds, color, label):
        ax.plot(Xs, means, color=color, lw=3.6, label=label, marker="o", ms=7)
        ax.fill_between(Xs, means - stds, means + stds, color=color, alpha=0.18, linewidth=0)

    plot_curve(ax, pXu, pM, pS, COLORS["pirw"], "PIRW")
    plot_curve(ax, fXu, fM, fS, COLORS["fastrw"], "FastRW")
    plot_curve(ax, feXu, feM, feS, COLORS["fasterrw"], "FasterRW")

    # x range: union of all three curves on log scale.
    xmin = float(min(pXu.min(), fXu.min(), feXu.min()))
    xmax = float(max(pXu.max(), fXu.max(), feXu.max()))
    # Pad in log space.
    log_pad = 0.04 * (np.log10(xmax) - np.log10(xmin))
    xlo = 10 ** (np.log10(xmin) - log_pad)
    xhi = 10 ** (np.log10(xmax) + log_pad)

    # Horizontal eps guide lines (dashed; labelled on the right at FS).
    for eps in EPS_LIST:
        ax.axhline(eps, color="#888", ls="--", lw=1.2, alpha=0.7)
        ax.text(xhi * 1.02, eps, f"  ε={eps}", va="center", ha="left",
                fontsize=FS, color="#555")

    # Mark X* per (method, eps) with hollow circles only (no text label).
    for Xs, means, color in [
        (pXu, pM, COLORS["pirw"]),
        (fXu, fM, COLORS["fastrw"]),
        (feXu, feM, COLORS["fasterrw"]),
    ]:
        for eps in EPS_LIST:
            star = pick_x_star(Xs, means, eps)
            if star is None:
                continue
            x, m = star
            ax.plot(
                x, m,
                marker="o", markerfacecolor="white", markeredgecolor=color,
                markersize=18, markeredgewidth=3.2, zorder=5,
            )

    # Axes
    ax.set_xscale("log")
    ax.set_xlim(xlo, xhi)

    # y range: fixed upper bound (YMAX) shared across cases; lower bound
    # snug under the lowest shaded band so the curves hug the bottom edge.
    def lower_band(Xs, M, S):
        mask = (Xs >= xlo) & (Xs <= xhi)
        return M[mask] - S[mask]
    ymin_data = float(np.concatenate([
        lower_band(pXu, pM, pS),
        lower_band(fXu, fM, fS),
        lower_band(feXu, feM, feS),
    ]).min())
    ymin = max(0.0, ymin_data - 0.02 * (YMAX - ymin_data))
    ax.set_ylim(ymin, YMAX)
    ax.yaxis.set_major_locator(MultipleLocator(0.5))

    ax.set_xlabel(r"Workload  $N \times \mathrm{steps}$  ($\times 10^9$)",
                  fontsize=FS)
    ax.set_ylabel("avg abs error (K)", fontsize=FS)
    ax.tick_params(axis="both", labelsize=FS)
    ax.grid(True, which="major", ls="--", lw=0.6, color="#bbb", alpha=0.7)
    ax.legend(loc="upper right", fontsize=FS, framealpha=0.95)

    # Margin so eps labels fit on the right
    plt.subplots_adjust(right=0.88)

    out_stem = case["out_stem"]
    png_path = out_stem.with_suffix(".png")
    pdf_path = out_stem.with_suffix(".pdf")
    fig.savefig(png_path, dpi=150, bbox_inches="tight", pad_inches=0)
    fig.savefig(pdf_path, bbox_inches="tight", pad_inches=0)
    plt.close(fig)
    print(f"Wrote {png_path}")
    print(f"Wrote {pdf_path}")


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Plot bootstrap-mean ± 1σ curves for case 1/2/3."
    )
    parser.add_argument(
        "cases",
        nargs="*",
        type=int,
        help="Cases to plot (1, 2, or 3; default: all three).",
    )
    args = parser.parse_args(argv)
    case_ids = args.cases if args.cases else [1, 2, 3]
    for k in case_ids:
        if k not in CASE_META:
            parser.error(f"invalid case {k}: choose from 1, 2, 3")
    for k in case_ids:
        plot_one_case(build_case(k))


if __name__ == "__main__":
    main(sys.argv[1:])
