"""Render the 2D dam-break animation GIF (numerical vs exact).

    python scripts/make_gif.py
"""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation, PillowWriter

from svroute import dam_break
from svroute.analytical import stoker
from svroute.section import trapezoid

OUT = Path(__file__).resolve().parents[1] / "docs" / "figures" / "dam_break.gif"
H0, HD, X0 = 1.0, 0.2, 50.0
sec = trapezoid(5.0, 2.0)
s = dam_break(sec, N=400, L=100.0, x0=X0, h_up=H0, h_down=HD)
fig, ax = plt.subplots(figsize=(7.5, 3.2))
ax.set(xlim=(0, 100), ylim=(0, 1.15), xlabel="x (m)", ylabel="depth (m)")
fill = [ax.fill_between(s.xc, 0, s.hc, color="#3b8fd9", alpha=0.85)]
(exact_line,) = ax.plot([], [], "k--", lw=1.1, label="exact (generalised Stoker)")
title = ax.set_title("")
ax.legend(loc="upper right")
fig.tight_layout()
frames = 60
times = [8.0 * (k + 1) / frames * 0.6 + 0.05 for k in range(frames)]


def update(k):
    s.run(times[k])
    fill[0].remove()
    fill[0] = ax.fill_between(s.xc, 0, s.hc, color="#3b8fd9", alpha=0.85)
    exact_line.set_data(s.xc, stoker(s.xc, s.t, X0, H0, HD, sec)[0])
    title.set_text(f"Dam break in a trapezoidal channel, t = {s.t:4.1f} s")
    return fill + [exact_line, title]


FuncAnimation(fig, update, frames=frames).save(OUT, writer=PillowWriter(fps=20))
print("wrote", OUT)
