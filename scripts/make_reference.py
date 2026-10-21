"""Write Python reference results that web/test/compare.js checks the JS port against.

    python scripts/make_reference.py
"""
import json
from pathlib import Path

import numpy as np

from svroute import Solver, dam_break
from svroute.analytical import ritter, stoker, thacker, thacker_params
from svroute.section import from_spec

SECTIONS = {
    "rect": {"type": "rectangular", "b": 3.0},
    "trap": {"type": "trapezoid", "b": 5.0, "m": 2.0},
    "vee": {"type": "vee", "m": 2.0},
    "compound": {"type": "compound", "b": 4.0, "m": 1.5, "h_bank": 1.0, "b_plain": 40.0},
}

DAM = {
    "dry_rect": dict(section="rect", N=200, L=100.0, x0=50.0, h_up=1.0, h_down=0.0, t=5.0),
    "wet_trap": dict(section="trap", N=200, L=100.0, x0=50.0, h_up=1.0, h_down=0.2, t=5.0),
    "dry_vee": dict(section="vee", N=200, L=100.0, x0=50.0, h_up=1.0, h_down=0.0, t=5.0),
    "wet_compound": dict(section="compound", N=200, L=100.0, x0=50.0, h_up=1.5, h_down=0.3, t=5.0),
    "sloped_friction_trap": dict(section="trap", N=200, L=500.0, x0=100.0, h_up=3.0, h_down=0.5,
                                 slope=0.01, n=0.03, t=20.0),
    "glof_vee": dict(section="vee", N=200, L=1000.0, x0=200.0, h_up=10.0, h_down=0.0,
                     slope=0.02, n=0.05, t=60.0),
}

out = {"sections": {}, "dam": {}, "route": {}, "thacker": {}, "exact": {}}

# --- section functions sampled at fixed depths
hs = [0.0, 1e-4, 0.05, 0.3, 0.99, 1.0, 1.01, 1.5, 3.0, 8.0]
for name, spec in SECTIONS.items():
    s = from_spec(spec)
    h = np.array(hs)
    out["sections"][name] = {"spec": spec, "h": hs, "A": s.area(h).tolist(), "B": s.width(h).tolist(),
                             "I1": s.I1(h).tolist(), "P": s.perimeter(h).tolist(),
                             "F": s.F(h).tolist(), "depth": s.depth(s.area(h)).tolist(),
                             "c": s.celerity(h).tolist()}

# --- dam-break / slope / friction cases
for name, c in DAM.items():
    c = dict(c)
    t = c.pop("t")
    spec = SECTIONS[c.pop("section")]
    s = dam_break(from_spec(spec), **c)
    s.run(t)
    out["dam"][name] = {"spec": spec, "params": {**c, "t": t}, "A": s.Ac.tolist(), "Q": s.Qc.tolist()}

# --- flood routing: inflow hydrograph boundary, Manning friction
spec = {"type": "trapezoid", "b": 20.0, "m": 2.0}
sec = from_spec(spec)
S0, n, hb, hp, L, N, t_end = 0.001, 0.03, 1.5, 3.0, 5000.0, 150, 600.0
Qb, Qp = float(sec.conveyance_discharge(hb, S0, n)), float(sec.conveyance_discharge(hp, S0, n))
w, tp = 100.0, 300.0
qin = lambda t: Qb + (Qp - Qb) * np.exp(-(((t - tp) / w) ** 2))
s = Solver(sec, N, L, lambda x: -S0 * x, lambda x: np.full_like(x, hb),
           Q0=lambda x: np.full_like(x, Qb), n=n, bc_up="flow", bc_down="open", q_in=qin)
s.run(t_end)
out["route"]["trap_hydrograph"] = {
    "spec": spec, "params": dict(S0=S0, n=n, hb=hb, hp=hp, L=L, N=N, t=t_end, w=w, tp=tp),
    "A": s.Ac.tolist(), "Q": s.Qc.tolist()}

# --- Thacker oscillating lake
Lb, hm_, Nb = 100.0, 1.0, 200
kappa, omega = thacker_params(hm_, Lb)
X0, tb = Lb / 8.0, 1.3 * 2 * np.pi / omega
spec = {"type": "rectangular", "b": 5.0}
s = Solver(from_spec(spec), Nb, Lb, lambda x: kappa * (x - Lb / 2) ** 2,
           lambda x: np.maximum(hm_ - kappa * ((x - Lb / 2) - X0) ** 2, 0.0),
           bc_up="wall", bc_down="wall")
s.run(tb)
he, _ = thacker(s.xc, tb, hm_, Lb, X0)
out["thacker"]["bowl"] = {"spec": spec, "params": dict(L=Lb, h_max=hm_, N=Nb, X0=X0, t=tb),
                          "A": s.Ac.tolist(), "Q": s.Qc.tolist(), "h_exact": he.tolist()}

# --- exact solutions sampled on a grid
xs = np.linspace(0, 100, 101)
for name, (sname, h0, hd) in {"ritter_trap": ("trap", 1.0, 0.0), "stoker_vee": ("vee", 1.0, 0.2),
                              "stoker_compound": ("compound", 1.5, 0.3)}.items():
    sec = from_spec(SECTIONS[sname])
    h = (ritter(xs, 5.0, 50.0, h0, sec) if hd == 0 else stoker(xs, 5.0, 50.0, h0, hd, sec))[0]
    out["exact"][name] = {"spec": SECTIONS[sname], "h0": h0, "hd": hd, "t": 5.0, "x0": 50.0,
                          "xs": xs.tolist(), "h": h.tolist()}

path = Path(__file__).resolve().parents[1] / "web" / "test" / "reference.json"
path.write_text(json.dumps(out))
print("wrote", path, f"({path.stat().st_size // 1024} KB)")
