"""Figures for the report from results/results.json.   Usage: npm run charts  (needs matplotlib)"""
import json
import pathlib

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
RES = json.loads((ROOT / "results" / "results.json").read_text())
OUT = ROOT / "results"
GREY, BLUE, RED = "#9a9a94", "#2457c5", "#b3261e"
plt.rcParams.update({"font.size": 10, "axes.spines.top": False, "axes.spines.right": False})

# 1. gas per reading: batched vs one transaction per reading
e1, e2 = RES["e1"], RES["e2"]
fig, ax = plt.subplots(figsize=(6.4, 3.6))
labels = [str(r["batchSize"]) for r in e1]
vals = [r["gasPerRecord"] for r in e1]
xs = list(range(len(labels)))
ax.plot(xs, vals, color=BLUE, marker="o", lw=2)
ax.axhline(e2["gasPerRecord"], color=GREY, lw=1.2, ls="--")
ax.text(xs[-1], e2["gasPerRecord"] * 1.15, f"one transaction per reading: {e2['gasPerRecord']:,} gas", ha="right", color="#555")
for i, v in enumerate(vals):
    ax.text(i + 0.06, v * 1.25, f"{v:,.0f}", ha="left", fontweight="bold")
ax.set_xticks(xs, labels)
ax.set_ylim(10, 200000)
ax.set_yscale("log")
ax.set_xlabel("Readings per batch")
ax.set_ylabel("Gas per reading (log scale)")
ax.set_title(f"Batching cuts on-chain cost per reading {e2['gasPerRecord'] / vals[-1]:.0f}x at {labels[-1]} per batch", loc="left")
fig.tight_layout()
fig.savefig(OUT / "fig-gas-per-reading.png", dpi=200)

# 2. exposure window by batching interval
e3 = RES["e3"]
fig, ax = plt.subplots(figsize=(6.4, 3.6))
xs = [r["intervalSec"] for r in e3]
mid = [r["exposureMsP50"] / 1000 for r in e3]
p95 = [r["exposureMsP95"] / 1000 for r in e3]
mx = [r["exposureMsMax"] / 1000 for r in e3]
ax.plot(xs, mid, marker="o", color=BLUE, label="median")
ax.plot(xs, p95, marker="o", color=GREY, label="95th percentile")
ax.plot(xs, mx, marker="o", color=GREY, ls=":", label="maximum")
ax.set_xticks(xs)
ax.set_xlabel("Batching interval (s)")
ax.set_ylabel("Reading -> anchored (s)")
ax.set_title("Exposure window grows with the batching interval (50 readings/s, 2 s blocks)", loc="left", fontsize=9.5)
ax.legend(frameon=False)
fig.tight_layout()
fig.savefig(OUT / "fig-exposure-window.png", dpi=200)

# 3. proof size by batch size
fig, ax = plt.subplots(figsize=(6.4, 3.2))
ax.plot([r["batchSize"] for r in e1], [r["proofBytesMax"] for r in e1], marker="o", color=BLUE)
ax.set_xscale("log", base=2)
ax.set_xlabel("Readings per batch (log 2)")
ax.set_ylabel("Proof size (bytes)")
ax.set_title("Proof grows by 32 bytes each time the batch doubles", loc="left")
fig.tight_layout()
fig.savefig(OUT / "fig-proof-size.png", dpi=200)
print("wrote", ", ".join(p.name for p in sorted(OUT.glob("fig-*.png"))))
