"""Generate the validation figures used in the README and docs.

    python scripts/validation_plots.py
"""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

from svroute import Solver, dam_break
from svroute.analytical import ritter, stoker, thacker, thacker_params
from svroute.section import rectangular, trapezoid, vee

G = 9.81
OUT = Path(__file__).resolve().parents[1] / "docs" / "figures"
OUT.mkdir(parents=True, exist_ok=True)
SECS = {"Rectangular": rectangular(3.0), "Trapezoid (m = 2)": trapezoid(5.0, 2.0), "V-valley (m = 1.5)": vee(1.5)}

# ---- 1. dam breaks in three cross-sections: numerical vs exact
fig, axes = plt.subplots(2, 3, figsize=(11, 5.6), sharex=True, sharey=True)
for col, (name, sec) in enumerate(SECS.items()):
    for row, hd in enumerate((0.0, 0.2)):
        s = dam_break(sec, N=400, L=100.0, x0=50.0, h_up=1.0, h_down=hd)
        s.run(5.0)
        h_ex = (ritter(s.xc, 5.0, 50.0, 1.0, sec) if hd == 0 else stoker(s.xc, 5.0, 50.0, 1.0, hd, sec))[0]
        ax = axes[row, col]
        ax.plot(s.xc, s.hc, lw=2, label="numerical")
        ax.plot(s.xc, h_ex, "k--", lw=1.1, label="exact")
        err = np.mean(np.abs(s.hc - h_ex))
        ax.set_title(f"{name}, {'dry' if hd == 0 else 'wet'} bed\nL1 error {err:.4f} m", fontsize=9.5)
        ax.grid(alpha=0.3)
        if row == 1:
            ax.set_xlabel("x (m)")
        if col == 0:
            ax.set_ylabel("depth h (m)")
axes[0, 0].legend(fontsize=8)
fig.tight_layout()
fig.savefig(OUT / "dam_break_sections.png", dpi=130)
plt.close(fig)

# ---- 2. grid convergence
fig, ax = plt.subplots(figsize=(5.4, 4))
for name, sec in list(SECS.items())[:2]:
    dxs, errs = [], []
    for N in (100, 200, 400, 800, 1600):
        s = dam_break(sec, N=N, L=100.0, x0=50.0, h_up=1.0, h_down=0.2)
        s.run(5.0)
        h_ex, _ = stoker(s.xc, 5.0, 50.0, 1.0, 0.2, sec)
        dxs.append(s.dx); errs.append(float(np.mean(np.abs(s.hc - h_ex))))
    order = np.polyfit(np.log(dxs), np.log(errs), 1)[0]
    ax.loglog(dxs, errs, "o-", lw=2, label=f"{name}: order {order:.2f}")
    print(f"convergence {name}: observed order {order:.2f}")
ax.loglog(dxs, [errs[0] * (d / dxs[0]) for d in dxs], "k:", label="first order")
ax.loglog(dxs, [errs[0] * (d / dxs[0]) ** 2 for d in dxs], "k--", label="second order")
ax.set(xlabel="dx (m)", ylabel="L1 error in depth (m)", title="Grid convergence, wet-bed dam break")
ax.legend(fontsize=8); ax.grid(alpha=0.3, which="both")
fig.tight_layout(); fig.savefig(OUT / "convergence.png", dpi=130); plt.close(fig)

# ---- 3. Thacker oscillating lake (moving shoreline over a curved bed)
L, hm, N = 100.0, 1.0, 400
kappa, omega = thacker_params(hm, L)
X0, T = L / 8, 2 * np.pi / omega
sec = rectangular(5.0)
s = Solver(sec, N, L, lambda x: kappa * (x - L / 2) ** 2,
           lambda x: np.maximum(hm - kappa * ((x - L / 2) - X0) ** 2, 0.0), bc_up="wall", bc_down="wall")
fig, axes = plt.subplots(1, 3, figsize=(11, 3.4), sharey=True)
for ax, frac in zip(axes, (0.25, 0.5, 1.0)):
    s.run(frac * T)
    he, _ = thacker(s.xc, s.t, hm, L, X0)
    ax.fill_between(s.xc, 0, s.zc, color="#8d6e4b")
    ax.fill_between(s.xc, s.zc, s.zc + s.hc, color="#3b8fd9", alpha=0.8)
    ax.plot(s.xc, s.zc + he, "k--", lw=1.1)
    ax.set_title(f"t = {frac:g} T, L1 error {np.mean(np.abs(s.hc - he)):.4f} m", fontsize=9.5)
    ax.set_xlabel("x (m)"); ax.set_ylim(0, 2.2); ax.grid(alpha=0.3)
axes[0].set_ylabel("elevation (m)")
fig.suptitle("Thacker oscillating lake: numerical water (blue) vs exact free surface (dashed)", fontsize=10)
fig.tight_layout(); fig.savefig(OUT / "thacker.png", dpi=130); plt.close(fig)

# ---- 4. manufactured steady state with friction and bed slope
sec = rectangular(2.0)
Lc, Q, n = 1000.0, 4.0, 0.033
hc = (Q / 2.0) ** (2 / 3) / G ** (1 / 3)
xs = np.linspace(0, Lc, 40001)
hx = hc * 1.5 * (1 + 0.5 * np.exp(-16 * (xs / Lc - 0.5) ** 2))
dh = np.gradient(hx, xs)
A, P = sec.area(hx), sec.perimeter(hx)
Sf = n ** 2 * Q ** 2 * P ** (4 / 3) / A ** (10 / 3)
dz = (Q ** 2 * sec.width(hx) / (G * A ** 3) - 1.0) * dh - Sf
zx = np.concatenate([[0], np.cumsum(0.5 * (dz[1:] + dz[:-1]) * np.diff(xs))]) + 5.0
h_of = lambda x: np.interp(x, xs, hx)
s = Solver(sec, 200, Lc, lambda x: np.interp(x, xs, zx), lambda x: np.full_like(x, h_of(Lc)),
           Q0=lambda x: np.full_like(x, Q), n=n, bc_up="flow", bc_down="depth", q_in=lambda t: Q,
           h_down=float(h_of(Lc)))
s.run(2500.0)
err = np.max(np.abs(s.hc - h_of(s.xc)) / h_of(s.xc))
fig, ax = plt.subplots(figsize=(7.5, 3.4))
ax.fill_between(xs, zx.min() - 0.3, zx, color="#8d6e4b")
ax.fill_between(s.xc, s.zc, s.zc + s.hc, color="#3b8fd9", alpha=0.8, label="numerical (t = 2500 s)")
ax.plot(xs, zx + hx, "k--", lw=1.1, label="exact steady surface")
ax.set(xlabel="x (m)", ylabel="elevation (m)", title=f"Steady flow with friction over a varying bed: max depth error {100 * err:.2f}%")
ax.legend(fontsize=8); ax.grid(alpha=0.3)
fig.tight_layout(); fig.savefig(OUT / "steady_friction.png", dpi=130); plt.close(fig)
print(f"manufactured steady state: max relative depth error {100 * err:.3f}%")
print("figures written to", OUT)
