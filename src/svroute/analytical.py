"""Exact (analytical or semi-analytical) benchmark solutions.

Dam break on a flat, frictionless bed, for ANY prismatic section:

* ritter(...)  dam break onto a dry bed, generalized Ritter solution
* stoker(...)  dam break onto a wet bed, generalized Stoker solution
* thacker(...) oscillating lake in a parabolic bowl (moving shoreline), Thacker (1981)

For a general section the rarefaction fan follows from the Riemann invariant
u + F(h) = F(h0), F(h) = int_0^h sqrt(g B / A) dh, with the fan characteristics
x - x0 = (u - c) t. The bore of the wet-bed problem follows from mass and momentum:

    u_m = sqrt( g (I1_m - I1_d) (A_m - A_d) / (A_m A_d) ),   S = u_m A_m / (A_m - A_d)

and the middle state from F(h0) - F(h_m) = u_m. For a rectangle these reduce to the textbook
Ritter and Stoker formulas.
"""

import numpy as np

from .section import rectangular

G = 9.81


def _fan(sec, h0, hmin=0.0, n=4001):
    """Rarefaction fan parametrised by depth from h0 down to hmin: returns (xi, h, u)."""
    s = np.linspace(np.sqrt(h0), np.sqrt(hmin), n)
    h = s ** 2
    F0 = float(sec.F(h0))
    u = F0 - sec.F(h)
    xi = u - sec.celerity(h)
    return xi, h, u


def ritter(x, t, x0, h0, section=None):
    """Dam break onto a dry bed. Returns (h, u)."""
    sec = section or rectangular(1.0)
    xi_q = (np.asarray(x, dtype=float) - x0) / max(t, 1e-12)
    xi, h, u = _fan(sec, h0)
    F0 = float(sec.F(h0))
    c0 = float(sec.celerity(h0))
    hq = np.where(xi_q <= -c0, h0, np.where(xi_q <= F0, np.interp(xi_q, xi, h), 0.0))
    uq = np.where((xi_q > -c0) & (xi_q <= F0), np.interp(xi_q, xi, u), 0.0)
    return hq, uq


def stoker_middle_state(h0, hd, section=None):
    sec = section or rectangular(1.0)
    F0 = float(sec.F(h0))
    Ad, I1d = float(sec.area(hd)), float(sec.I1(hd))

    def f(hm):
        Am, I1m = float(sec.area(hm)), float(sec.I1(hm))
        bore = np.sqrt(G * (I1m - I1d) * (Am - Ad) / (Am * Ad))
        return F0 - float(sec.F(hm)) - bore

    lo, hi = hd, h0
    for _ in range(200):
        mid = 0.5 * (lo + hi)
        if f(lo) * f(mid) <= 0:
            hi = mid
        else:
            lo = mid
    hm = 0.5 * (lo + hi)
    Am = float(sec.area(hm))
    um = F0 - float(sec.F(hm))
    S = um * Am / (Am - Ad)
    return hm, um, S


def stoker(x, t, x0, h0, hd, section=None):
    """Dam break onto a wet bed of depth hd > 0. Returns (h, u)."""
    sec = section or rectangular(1.0)
    hm, um, S = stoker_middle_state(h0, hd, sec)
    cm = float(sec.celerity(hm))
    c0 = float(sec.celerity(h0))
    xi_q = (np.asarray(x, dtype=float) - x0) / max(t, 1e-12)
    xi, h, u = _fan(sec, h0, hmin=hm)
    in_fan = (xi_q > -c0) & (xi_q <= um - cm)
    hq = np.where(xi_q <= -c0, h0,
                  np.where(in_fan, np.interp(xi_q, xi, h),
                           np.where(xi_q <= S, hm, hd)))
    uq = np.where(in_fan, np.interp(xi_q, xi, u),
                  np.where((xi_q > um - cm) & (xi_q <= S), um, 0.0))
    return hq, uq


def thacker_params(h_max, L):
    """Parabolic bowl z = kappa (x - L/2)^2 whose rim is at depth h_max for |x - L/2| = L/4."""
    kappa = h_max / (L / 4.0) ** 2
    omega = np.sqrt(2.0 * G * kappa)
    return kappa, omega


def thacker(x, t, h_max, L, X0):
    """Oscillating planar lake in a parabolic bowl (frictionless). Returns (h, u).

    Lake depth h = h_max - kappa (x - L/2 - X(t))^2 where wet, X(t) = X0 cos(omega t), and
    the velocity is uniform in space, u = -X0 omega sin(omega t)."""
    kappa, omega = thacker_params(h_max, L)
    X = X0 * np.cos(omega * t)
    xr = np.asarray(x, dtype=float) - L / 2.0
    h = np.maximum(h_max - kappa * (xr - X) ** 2, 0.0)
    u = np.where(h > 0, -X0 * omega * np.sin(omega * t), 0.0)
    return h, u
