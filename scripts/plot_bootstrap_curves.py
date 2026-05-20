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

XMIN, XMAX = 32, 4096

# Unified font size for every text element.
FS = 20

# Y-axis upper limit (shared across cases).
YMAX = 1.5


def load_curve(json_path: Path, prefix: str):
    """Return (Ns, means, stds) sorted by N for the given method prefix."""
    with open(json_path) as f:
        data = json.load(f)
    rows = sorted(data["results"], key=lambda r: r["N"])
    Ns = np.array([r["N"] for r in rows], dtype=float)
    means = np.array([r[f"{prefix}_avg_abs_mean"] for r in rows], dtype=float)
    stds = np.array([r[f"{prefix}_avg_abs_std"] for r in rows], dtype=float)
    return Ns, means, stds


def pick_N_star(Ns, means, eps):
    """Smallest N where mean <= eps."""
    for n, m in sorted(zip(Ns.tolist(), means.tolist())):
        if m <= eps:
            return n, m
    return None


def plot_one_case(case):
    fastrw_json = case["fastrw_dir"] / "bootstrap_sweep_fastrw.json"
    pirw_json = case["pirw_dir"] / "bootstrap_sweep_pirw.json"
    for p in (fastrw_json, pirw_json):
        if not p.exists():
            raise FileNotFoundError(
                f"{p} not found -- run scripts/run_bootstrap_sweep.sh first."
            )

    pN, pM, pS = load_curve(pirw_json, "direct")
    fN, fM, fS = load_curve(fastrw_json, "fastrw")
    feN, feM, feS = load_curve(fastrw_json, "fasterrw")

    fig, ax = plt.subplots(figsize=(7, 5), dpi=150)

    def plot_curve(ax, Ns, means, stds, color, label):
        ax.plot(Ns, means, color=color, lw=3.6, label=label, marker="o", ms=7)
        ax.fill_between(Ns, means - stds, means + stds, color=color, alpha=0.18, linewidth=0)

    plot_curve(ax, pN, pM, pS, COLORS["pirw"], "PIRW")
    plot_curve(ax, fN, fM, fS, COLORS["fastrw"], "FastRW")
    plot_curve(ax, feN, feM, feS, COLORS["fasterrw"], "FasterRW")

    # Horizontal eps guide lines (dashed; labelled on the right at FS).
    for eps in EPS_LIST:
        ax.axhline(eps, color="#888", ls="--", lw=1.2, alpha=0.7)
        ax.text(XMAX * 1.02, eps, f"  ε={eps}", va="center", ha="left",
                fontsize=FS, color="#555")

    # Mark N* per (method, eps) with hollow circles only (no text label).
    for Ns, means, color in [
        (pN, pM, COLORS["pirw"]),
        (fN, fM, COLORS["fastrw"]),
        (feN, feM, COLORS["fasterrw"]),
    ]:
        for eps in EPS_LIST:
            star = pick_N_star(Ns, means, eps)
            if star is None:
                continue
            n, m = star
            ax.plot(
                n, m,
                marker="o", markerfacecolor="white", markeredgecolor=color,
                markersize=18, markeredgewidth=3.2, zorder=5,
            )

    # Axes
    ax.set_xscale("log", base=2)
    ax.set_xlim(XMIN, XMAX)
    xticks = [32, 64, 128, 256, 512, 1024, 2048, 4096]
    # Keep ticks at every position, label every other one (32, 128, 512, 2048).
    ax.set_xticks(xticks)
    ax.set_xticklabels([str(x) if i % 2 == 0 else "" for i, x in enumerate(xticks)])

    # y range: fixed upper bound (YMAX) shared across cases; lower bound
    # snug under the lowest shaded band so the curves hug the bottom edge.
    def lower_band(Ns, M, S):
        mask = (Ns >= XMIN) & (Ns <= XMAX)
        return M[mask] - S[mask]
    ymin_data = float(np.concatenate([
        lower_band(pN, pM, pS),
        lower_band(fN, fM, fS),
        lower_band(feN, feM, feS),
    ]).min())
    ymin = max(0.0, ymin_data - 0.02 * (YMAX - ymin_data))
    ax.set_ylim(ymin, YMAX)
    ax.yaxis.set_major_locator(MultipleLocator(0.5))

    ax.set_xlabel("N (paths per query)", fontsize=FS)
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
