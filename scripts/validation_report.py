"""Measure every validation quantity and write docs/VALIDATION.md.

    python scripts/validation_report.py
"""
from pathlib import Path

import numpy as np

from svroute import Solver, dam_break
from svroute.analytical import ritter, stoker, thacker, thacker_params
from svroute.section import compound, rectangular, trapezoid, vee

G = 9.81
SECS = {"rectangular": rectangular(3.0), "trapezoid": trapezoid(5.0, 2.0), "V-valley": vee(1.5),
        "compound": compound(4.0, 1.5, 1.0, 40.0)}
rows = []
l1 = lambda a, b: float(np.mean(np.abs(a - b)))


def section(title):
    rows.append(f"\n### {title}\n")


section("Well-balancing: lake at rest over an uneven bed (200 cells, 20 s)")
rows.append("| Section | max abs discharge Q (m³/s) | max abs surface deviation (m) |\n|---|---|---|")
for name, sec in SECS.items():
    z = lambda x: 0.4 * np.exp(-((x - 50.0) / 8.0) ** 2) + 0.1 * np.sin(x / 7.0)
    s = Solver(sec, 200, 100.0, z, lambda x: 1.5 - z(x), bc_up="wall", bc_down="wall")
    s.run(20.0)
    rows.append(f"| {name} | {np.max(np.abs(s.Qc)):.1e} | {np.max(np.abs(s.hc + s.zc - 1.5)):.1e} |")

section("Dam break vs exact solutions (400 cells, t = 5 s, h_up = 1 m)")
rows.append("| Section | Bed | L1 depth error (m) | L1 velocity error (m/s) | Mass error (relative) |\n|---|---|---|---|---|")
for name, sec in SECS.items():
    for hd in (0.0, 0.2):
        s = dam_break(sec, N=400, L=100.0, x0=50.0, h_up=1.0, h_down=hd)
        v0 = s.volume()
        s.run(5.0)
        h_ex, u_ex = ritter(s.xc, 5.0, 50.0, 1.0, sec) if hd == 0 else stoker(s.xc, 5.0, 50.0, 1.0, hd, sec)
        rows.append(f"| {name} | {'dry (Ritter)' if hd == 0 else 'wet (Stoker)'} | {l1(s.hc, h_ex):.4f} | "
                    f"{l1(s.uc, u_ex):.3f} | {abs(s.volume() - v0) / v0:.1e} |")

section("Grid convergence (wet-bed dam break, L1 depth error)")
rows.append("| Section | 100 | 200 | 400 | 800 | 1600 cells | Observed order |\n|---|---|---|---|---|---|---|")
for name in ("rectangular", "trapezoid", "V-valley"):
    sec, dxs, errs = SECS[name], [], []
    for N in (100, 200, 400, 800, 1600):
        s = dam_break(sec, N=N, L=100.0, x0=50.0, h_up=1.0, h_down=0.2)
        s.run(5.0)
        errs.append(l1(s.hc, stoker(s.xc, 5.0, 50.0, 1.0, 0.2, sec)[0])); dxs.append(s.dx)
    order = np.polyfit(np.log(dxs), np.log(errs), 1)[0]
    rows.append(f"| {name} | " + " | ".join(f"{e:.4f}" for e in errs) + f" | {order:.2f} |")

section("Thacker oscillating lake (moving shoreline over a parabolic bowl)")
rows.append("| Cells | L1 error at T/2 (m) | at T (m) | at 2T (m) | Mass error (relative) |\n|---|---|---|---|---|")
for N in (200, 400, 800):
    L, hm = 100.0, 1.0
    kappa, omega = thacker_params(hm, L); X0, T = L / 8, 2 * np.pi / omega
    s = Solver(rectangular(5.0), N, L, lambda x: kappa * (x - L / 2) ** 2,
               lambda x: np.maximum(hm - kappa * ((x - L / 2) - X0) ** 2, 0.0), bc_up="wall", bc_down="wall")
    v0, e = s.volume(), []
    for frac in (0.5, 1.0, 2.0):
        s.run(frac * T); e.append(l1(s.hc, thacker(s.xc, s.t, hm, L, X0)[0]))
    rows.append(f"| {N} | {e[0]:.4f} | {e[1]:.4f} | {e[2]:.4f} | {abs(s.volume() - v0) / v0:.1e} |")

section("Steady flows with Manning friction")
rows.append("| Test | Result |\n|---|---|")
for name in ("rectangular", "trapezoid", "compound"):
    sec = SECS[name]; S0, n, hn, L = 0.001, 0.03, 1.8, 2000.0
    Qn = float(sec.conveyance_discharge(hn, S0, n))
    s = Solver(sec, 200, L, lambda x: -S0 * x, lambda x: np.full_like(x, hn), Q0=lambda x: np.full_like(x, Qn),
               n=n, bc_up="flow", bc_down="open", q_in=lambda t: Qn)
    s.run(300.0)
    rows.append(f"| Uniform flow is preserved, {name} | max depth deviation {np.max(np.abs(s.hc / hn - 1)):.1e}, discharge {np.max(np.abs(s.Qc / Qn - 1)):.1e} |")
sec = trapezoid(8.0, 2.0); S0, n, hn = 0.001, 0.035, 2.0
Qn = float(sec.conveyance_discharge(hn, S0, n))
s = Solver(sec, 100, 2000.0, lambda x: -S0 * x, lambda x: np.full_like(x, 0.7 * hn), Q0=lambda x: np.full_like(x, Qn),
           n=n, bc_up="flow", bc_down="open", q_in=lambda t: Qn)
s.run(8000.0)
rows.append(f"| Relaxation from 30% too shallow to Manning normal depth (trapezoid, 8000 s) | max deviation {100 * np.max(np.abs(s.hc / hn - 1)):.2f}% |")
sec = rectangular(2.0); Lc, Q, n = 1000.0, 4.0, 0.033
hc = (Q / 2.0) ** (2 / 3) / G ** (1 / 3)
xs = np.linspace(0, Lc, 40001); hx = hc * 1.5 * (1 + 0.5 * np.exp(-16 * (xs / Lc - 0.5) ** 2)); dh = np.gradient(hx, xs)
A, P = sec.area(hx), sec.perimeter(hx)
dz = (Q ** 2 * sec.width(hx) / (G * A ** 3) - 1.0) * dh - n ** 2 * Q ** 2 * P ** (4 / 3) / A ** (10 / 3)
zx = np.concatenate([[0], np.cumsum(0.5 * (dz[1:] + dz[:-1]) * np.diff(xs))]) + 5.0
h_of = lambda x: np.interp(x, xs, hx)
s = Solver(sec, 200, Lc, lambda x: np.interp(x, xs, zx), lambda x: np.full_like(x, h_of(Lc)), Q0=lambda x: np.full_like(x, Q),
           n=n, bc_up="flow", bc_down="depth", q_in=lambda t: Q, h_down=float(h_of(Lc)))
s.run(2500.0)
rows.append(f"| Manufactured steady state (varying bed, friction, subcritical) | max relative depth error {100 * np.max(np.abs(s.hc - h_of(s.xc)) / h_of(s.xc)):.3f}% |")

out = Path(__file__).resolve().parents[1] / "docs" / "VALIDATION.md"
out.write_text("# Validation results\n\nGenerated by `scripts/validation_report.py` from the solver in this repository.\n" + "\n".join(rows) + "\n")
print("\n".join(rows)); print("\nwrote", out)
