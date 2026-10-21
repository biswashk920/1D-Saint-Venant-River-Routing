"""Validation of the solver against exact solutions and engineering benchmarks.

Run with:  pytest -v
"""

import numpy as np
import pytest

from svroute import Solver, dam_break
from svroute.analytical import ritter, stoker, stoker_middle_state, thacker, thacker_params
from svroute.section import compound, rectangular, trapezoid, vee

G = 9.81
SECTIONS = {
    "rectangular": rectangular(3.0),
    "trapezoid": trapezoid(5.0, 2.0),
    "vee": vee(1.5),
    "compound": compound(4.0, 1.5, 1.0, 40.0),
}


def l1(a, b):
    return float(np.mean(np.abs(a - b)))


# ----------------------------------------------------------------- geometry
def test_section_geometry_matches_closed_forms():
    h = np.array([0.1, 1.0, 2.5])
    r = rectangular(5.0)
    assert np.allclose(r.area(h), 5 * h) and np.allclose(r.perimeter(h), 5 + 2 * h)
    t = trapezoid(4.0, 2.0)
    assert np.allclose(t.area(h), 4 * h + 2 * h ** 2)
    assert np.allclose(t.I1(h), 2 * h ** 2 + 2 * h ** 3 / 3)
    assert np.allclose(t.perimeter(h), 4 + 2 * h * np.sqrt(5))
    v = vee(2.0)
    assert np.allclose(v.area(h), 2 * h ** 2)
    assert np.allclose(v.F(h), 2 * np.sqrt(2 * G * h), rtol=1e-6)   # exact invariant for a V
    assert np.allclose(r.F(h), 2 * np.sqrt(G * h), rtol=1e-6)       # classical 2 sqrt(g h)


@pytest.mark.parametrize("name", SECTIONS)
def test_depth_is_inverse_of_area(name):
    s = SECTIONS[name]
    h = np.concatenate([[0.0, 1e-6], np.linspace(0.01, 6.0, 300)])
    assert np.allclose(s.depth(s.area(h)), h, atol=1e-9)


# -------------------------------------------------------------- well-balancing
@pytest.mark.parametrize("name", SECTIONS)
def test_lake_at_rest_over_uneven_bed(name):
    L, N = 100.0, 200
    z = lambda x: 0.4 * np.exp(-((x - 50.0) / 8.0) ** 2) + 0.1 * np.sin(x / 7.0)
    s = Solver(SECTIONS[name], N, L, z, lambda x: 1.5 - z(x), bc_up="wall", bc_down="wall")
    s.run(20.0)
    assert np.max(np.abs(s.Qc)) < 1e-9
    assert np.max(np.abs(s.hc + s.zc - 1.5)) < 1e-12


# ------------------------------------------------------ analytical-code self-checks
def test_generalized_ritter_reduces_to_textbook_formula():
    x = np.linspace(0, 100, 501)
    h, u = ritter(x, 5.0, 50.0, 1.0, rectangular(2.0))
    c0 = np.sqrt(G)
    xi = (x - 50.0) / 5.0
    h_ref = np.where(xi <= -c0, 1.0, np.where(xi <= 2 * c0, (2 * c0 - xi) ** 2 / (9 * G), 0.0))
    u_ref = np.where((xi > -c0) & (xi <= 2 * c0), 2.0 / 3.0 * (c0 + xi), 0.0)
    assert np.max(np.abs(h - h_ref)) < 1e-4 and np.max(np.abs(u - u_ref)) < 1e-3


def test_generalized_stoker_reduces_to_textbook_formula():
    h0, hd = 1.0, 0.2
    hm, um, S = stoker_middle_state(h0, hd, rectangular(2.0))
    c0 = np.sqrt(G * h0)
    f = lambda h: 2 * (c0 - np.sqrt(G * h)) - (h - hd) * np.sqrt(G * (h + hd) / (2 * h * hd))
    assert abs(f(hm)) < 1e-4
    assert abs(S - hm * um / (hm - hd)) < 1e-12


# ------------------------------------------------------------- dam-break benchmarks
@pytest.mark.parametrize("name", ["rectangular", "trapezoid", "vee", "compound"])
def test_ritter_dry_bed_every_section(name):
    sec = SECTIONS[name]
    s = dam_break(sec, N=400, L=100.0, x0=50.0, h_up=1.0, h_down=0.0)
    v0 = s.volume()
    s.run(5.0)
    h_ex, _ = ritter(s.xc, 5.0, 50.0, 1.0, sec)
    assert l1(s.hc, h_ex) < 0.006
    assert abs(s.volume() - v0) / v0 < 1e-12          # exact mass conservation


@pytest.mark.parametrize("name", ["rectangular", "trapezoid", "vee", "compound"])
def test_stoker_wet_bed_every_section(name):
    sec = SECTIONS[name]
    s = dam_break(sec, N=400, L=100.0, x0=50.0, h_up=1.0, h_down=0.2)
    s.run(5.0)
    h_ex, u_ex = stoker(s.xc, 5.0, 50.0, 1.0, 0.2, sec)
    assert l1(s.hc, h_ex) < 0.004
    assert l1(s.uc, u_ex) < 0.03


@pytest.mark.parametrize("name", ["rectangular", "trapezoid"])
def test_grid_convergence_order(name):
    sec = SECTIONS[name]
    errs, dxs = [], []
    for N in (100, 200, 400, 800):
        s = dam_break(sec, N=N, L=100.0, x0=50.0, h_up=1.0, h_down=0.2)
        s.run(5.0)
        h_ex, _ = stoker(s.xc, 5.0, 50.0, 1.0, 0.2, sec)
        errs.append(l1(s.hc, h_ex))
        dxs.append(s.dx)
    order = np.polyfit(np.log(dxs), np.log(errs), 1)[0]
    assert errs[-1] < errs[0]
    assert order > 0.8, f"observed order {order:.2f}"


# --------------------------------------------------- Thacker oscillating lake (wet/dry + slope)
def test_thacker_oscillating_lake_moving_shoreline():
    L, hm, N = 100.0, 1.0, 400
    kappa, omega = thacker_params(hm, L)
    X0, T = L / 8.0, 2 * np.pi / omega
    sec = rectangular(5.0)
    z = lambda x: kappa * (x - L / 2) ** 2
    h0 = lambda x: np.maximum(hm - kappa * ((x - L / 2) - X0) ** 2, 0.0)
    s = Solver(sec, N, L, z, h0, bc_up="wall", bc_down="wall")
    v0 = s.volume()
    for frac in (0.5, 1.0, 2.0):                      # half, one and two periods
        s.run(frac * T)
        he, _ = thacker(s.xc, s.t, hm, L, X0)
        assert l1(s.hc, he) < 0.002
    assert abs(s.volume() - v0) / v0 < 1e-12


# ------------------------------------------------------------------ steady flows
def _uniform_setup(sec, S0=0.001, n=0.03, hn=1.8, L=2000.0, N=200):
    Qn = float(sec.conveyance_discharge(hn, S0, n))
    return dict(section=sec, N=N, L=L, z=lambda x: -S0 * x, n=n, bc_up="flow",
                bc_down="open", q_in=lambda t: Qn), Qn


@pytest.mark.parametrize("name", ["rectangular", "trapezoid", "compound"])
def test_uniform_flow_is_a_steady_solution(name):
    sec = SECTIONS[name]
    S0, n = 0.001, 0.03
    hn = 1.8
    kw, Qn = _uniform_setup(sec, S0, n, hn)
    assert abs(sec.normal_depth(Qn, S0, n) - hn) < 1e-8      # Manning inversion
    s = Solver(h0=lambda x: np.full_like(x, hn), Q0=lambda x: np.full_like(x, Qn), **kw)
    s.run(300.0)
    assert np.max(np.abs(s.hc / hn - 1.0)) < 0.002
    assert np.max(np.abs(s.Qc / Qn - 1.0)) < 0.002


def test_relaxation_to_manning_normal_depth_in_trapezoid():
    """Start 30% too shallow with the normal discharge imposed upstream. The depth
    disturbance leaves at the kinematic wave speed (about 1.5 u), after which the
    solution must sit on the Manning normal depth."""
    sec = trapezoid(8.0, 2.0)
    S0, n, hn = 0.001, 0.035, 2.0
    kw, Qn = _uniform_setup(sec, S0, n, hn, L=2000.0, N=100)
    s = Solver(h0=lambda x: np.full_like(x, 0.7 * hn), Q0=lambda x: np.full_like(x, Qn), **kw)
    s.run(8000.0)
    assert np.max(np.abs(s.hc / hn - 1.0)) < 0.01


def test_manufactured_steady_state_with_friction_and_bed_slope():
    """Bed profile engineered so a chosen depth profile h(x) is the exact steady solution
    of the full equations with Manning friction (MacDonald et al. style benchmark)."""
    sec = rectangular(2.0)
    L, Q, n = 1000.0, 4.0, 0.033
    hc = (Q / 2.0) ** (2 / 3) / G ** (1 / 3)
    xs = np.linspace(0, L, 40001)
    hx = hc * 1.5 * (1 + 0.5 * np.exp(-16 * (xs / L - 0.5) ** 2))
    dh = np.gradient(hx, xs)
    A, P = sec.area(hx), sec.perimeter(hx)
    Sf = n ** 2 * Q ** 2 * P ** (4 / 3) / A ** (10 / 3)
    Fr2 = Q ** 2 * sec.width(hx) / (G * A ** 3)
    dz = (Fr2 - 1.0) * dh - Sf                              # steady energy equation
    zx = np.concatenate([[0], np.cumsum(0.5 * (dz[1:] + dz[:-1]) * np.diff(xs))])
    zx += 5.0
    h_of = lambda x: np.interp(x, xs, hx)
    s = Solver(sec, 200, L, lambda x: np.interp(x, xs, zx), lambda x: np.full_like(x, h_of(L)),
               Q0=lambda x: np.full_like(x, Q), n=n, bc_up="flow", bc_down="depth",
               q_in=lambda t: Q, h_down=float(h_of(L)))
    s.run(2500.0)
    err = np.max(np.abs(s.hc - h_of(s.xc)) / h_of(s.xc))
    assert err < 0.001, f"max relative depth error {err:.5f}"


# --------------------------------------------------------------------- robustness
def test_positivity_and_finiteness_on_steep_dry_valley():
    s = dam_break(vee(2.0), N=300, L=1000.0, x0=200.0, h_up=10.0, h_down=0.0,
                  slope=0.02, n=0.04)
    v0 = s.volume()
    outflow = []
    s.run(60.0)
    assert np.min(s.hc) >= 0.0
    assert np.all(np.isfinite(s.hc)) and np.all(np.isfinite(s.Qc))
    assert s.volume() <= v0 * (1 + 1e-9)                     # no water created
