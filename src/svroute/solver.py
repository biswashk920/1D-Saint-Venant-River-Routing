"""Finite-volume solver for the 1D Saint-Venant equations in a prismatic channel.

Unknowns: flow area A and discharge Q (m^3/s), for an arbitrary symmetric cross-section.

    dA/dt + dQ/dx = 0
    dQ/dt + d(Q^2/A + g I1(h))/dx = -g A_bar dz/dx - g n^2 |Q| Q P^(4/3) / A^(7/3)

with h the depth, z the bed elevation, I1(h) = int_0^h A(eta) d(eta) the hydrostatic pressure
integral (so that d I1/dx = A dh/dx in a prismatic channel).

Scheme
------
* HLL approximate Riemann solver, Einfeldt wave speeds, exact dry-front speeds (Riemann invariant)
* MUSCL reconstruction of (eta = h + z, u, z) with a minmod limiter
* Audusse hydrostatic reconstruction, with a pressure-consistent bed source term
  (A_bar = mean area over the face-depth interval) -> exactly well-balanced in ANY section
* SSP-RK2 (Heun) time stepping, adaptive CFL time step
* Manning friction, fully implicit (exact quadratic solve), applied after each Euler substep
"""

import numpy as np

from .section import rectangular

G = 9.81
NG = 2  # ghost cells per side


def minmod(a, b):
    return np.where(a * b <= 0.0, 0.0, np.where(np.abs(a) < np.abs(b), a, b))


def limited_slope(x):
    s = np.zeros_like(x)
    s[1:-1] = minmod(x[1:-1] - x[:-2], x[2:] - x[1:-1])
    return s


class Solver:
    """1D solver on a uniform grid of N cells over [0, L].

    Parameters
    ----------
    section : Section (see svroute.section)
    N, L : number of cells, reach length (m)
    z : callable x -> bed elevation (m)
    h0 : callable x -> initial depth (m)
    Q0 : callable x -> initial discharge (m^3/s), default 0
    n : Manning roughness (s/m^(1/3)); 0 = frictionless
    bc_up : 'wall' | 'open' | 'flow'  ('flow' imposes the discharge q_in(t) in m^3/s)
    bc_down : 'wall' | 'open' | 'depth'  ('depth' imposes the depth h_down)
    """

    def __init__(self, section, N, L, z, h0, Q0=None, n=0.0, bc_up="wall",
                 bc_down="open", q_in=None, h_down=None, cfl=0.4, eps=1e-4):
        self.sec = section
        self.N, self.L = N, L
        self.dx = L / N
        self.x = (np.arange(N + 2 * NG) - NG + 0.5) * self.dx
        self.n = n
        self.bc_up, self.bc_down = bc_up, bc_down
        self.q_in, self.h_down = q_in, h_down
        self.cfl, self.eps = cfl, eps
        self.z = z(self.x)
        h = np.maximum(h0(self.x), 0.0)
        h[h <= eps] = 0.0
        self.A = section.area(h)
        self.Q = np.zeros_like(self.A) if Q0 is None else Q0(self.x).astype(float)
        self.Q[h == 0.0] = 0.0
        self.t = 0.0
        self._ghost_z()
        self.apply_bc(self.A, self.Q, 0.0)

    # ------------------------------------------------------------ views
    @property
    def xc(self):
        return self.x[NG:-NG]

    @property
    def zc(self):
        return self.z[NG:-NG]

    @property
    def Ac(self):
        return self.A[NG:-NG]

    @property
    def Qc(self):
        return self.Q[NG:-NG]

    @property
    def hc(self):
        return self.sec.depth(self.Ac)

    @property
    def uc(self):
        A = self.Ac
        return np.divide(self.Qc, A, out=np.zeros_like(A), where=self.hc > self.eps)

    def volume(self):
        return float(np.sum(self.Ac) * self.dx)

    # ------------------------------------------------------- boundaries
    def _ghost_z(self):
        z, N = self.z, self.N
        if self.bc_up == "wall":
            z[1], z[0] = z[2], z[3]
        else:
            z[1] = 2 * z[2] - z[3]
            z[0] = 2 * z[1] - z[2]
        if self.bc_down == "wall":
            z[N + 2], z[N + 3] = z[N + 1], z[N]
        else:
            z[N + 2] = 2 * z[N + 1] - z[N]
            z[N + 3] = 2 * z[N + 2] - z[N + 1]

    def apply_bc(self, A, Q, t):
        N = self.N
        if self.bc_up == "wall":
            A[1], A[0] = A[2], A[3]
            Q[1], Q[0] = -Q[2], -Q[3]
        elif self.bc_up == "open":
            A[1] = A[0] = A[2]
            Q[1] = Q[0] = Q[2]
        else:  # 'flow'
            A[1] = A[0] = A[2]
            Q[1] = Q[0] = self.q_in(t)
        if self.bc_down == "wall":
            A[N + 2], A[N + 3] = A[N + 1], A[N]
            Q[N + 2], Q[N + 3] = -Q[N + 1], -Q[N]
        elif self.bc_down == "open":
            A[N + 2] = A[N + 3] = A[N + 1]
            Q[N + 2] = Q[N + 3] = Q[N + 1]
        else:  # 'depth'
            A[N + 2] = A[N + 3] = float(self.sec.area(self.h_down))
            Q[N + 2] = Q[N + 3] = Q[N + 1]

    # ------------------------------------------------------ Riemann solver
    def _hll(self, hL, uL, hR, uR):
        sec, eps = self.sec, self.eps
        dryL, dryR = hL <= eps, hR <= eps
        hL = np.where(dryL, 0.0, hL)
        hR = np.where(dryR, 0.0, hR)
        uL = np.where(dryL, 0.0, uL)
        uR = np.where(dryR, 0.0, uR)
        AL, AR = sec.area(hL), sec.area(hR)
        cL, cR = sec.celerity(hL), sec.celerity(hR)

        sqL, sqR = np.sqrt(AL), np.sqrt(AR)
        den = np.where(sqL + sqR > 0, sqL + sqR, 1.0)
        um = (sqL * uL + sqR * uR) / den
        cm = np.sqrt(0.5 * (cL ** 2 + cR ** 2))
        sL = np.minimum(uL - cL, um - cm)
        sR = np.maximum(uR + cR, um + cm)
        # dry fronts: exact rarefaction-tip speed from the Riemann invariant
        sL = np.where(dryL, uR - sec.F(hR), sL)
        sR = np.where(dryL, uR + cR, sR)
        sL = np.where(dryR, uL - cL, sL)
        sR = np.where(dryR, uL + sec.F(hL), sR)

        QL, QR = AL * uL, AR * uR
        fqL = QL * uL + G * sec.I1(hL)
        fqR = QR * uR + G * sec.I1(hR)
        both_dry = dryL & dryR
        d = np.where(both_dry | (sR - sL == 0.0), 1.0, sR - sL)
        fa = (sR * QL - sL * QR + sL * sR * (AR - AL)) / d
        fq = (sR * fqL - sL * fqR + sL * sR * (QR - QL)) / d
        FA = np.where(sL >= 0.0, QL, np.where(sR <= 0.0, QR, fa))
        FQ = np.where(sL >= 0.0, fqL, np.where(sR <= 0.0, fqR, fq))
        return np.where(both_dry, 0.0, FA), np.where(both_dry, 0.0, FQ)

    # -------------------------------------------------------------- rhs
    def rhs(self, A, Q, dt):
        sec, eps, dx, z = self.sec, self.eps, self.dx, self.z
        h = sec.depth(A)
        u = np.divide(Q, A, out=np.zeros_like(A), where=h > eps)
        eta = h + z
        se, su, sz = limited_slope(eta), limited_slope(u), limited_slope(z)

        # interface m sits between full-array cells m+1 and m+2 (m = 0..N)
        etaL = (eta + 0.5 * se)[1:-2]
        etaR = (eta - 0.5 * se)[2:-1]
        uL = (u + 0.5 * su)[1:-2]
        uR = (u - 0.5 * su)[2:-1]
        zL = (z + 0.5 * sz)[1:-2]
        zR = (z - 0.5 * sz)[2:-1]

        hL = np.maximum(etaL - zL, 0.0)
        hR = np.maximum(etaR - zR, 0.0)
        zs = np.maximum(zL, zR)
        hLs = np.maximum(etaL - zs, 0.0)
        hRs = np.maximum(etaR - zs, 0.0)

        FA, FQ = self._hll(hLs, uL, hRs, uR)

        # positivity-preserving limiter: a cell cannot export more water than it holds
        Ac = A[NG:-NG]
        outflow = np.maximum(FA[1:], 0.0) + np.maximum(-FA[:-1], 0.0)
        theta = np.where(outflow * dt > Ac * dx,
                         Ac * dx / np.where(outflow > 0, outflow * dt, 1.0), 1.0)
        theta = np.concatenate([[1.0], theta, [1.0]])          # ghost cells: no limiting
        th_if = np.where(FA >= 0.0, theta[:-1], theta[1:])
        FA, FQ = FA * th_if, FQ * th_if

        # cell i: right face = interface i-1 (left state), left face = interface i-2 (right state)
        FA_r, FA_l = FA[1:], FA[:-1]
        FQ_r = FQ[1:] + G * (sec.I1(hL[1:]) - sec.I1(hLs[1:]))
        FQ_l = FQ[:-1] + G * (sec.I1(hR[:-1]) - sec.I1(hRs[:-1]))

        # pressure-consistent bed source: A_bar = mean of A(h) over [h_left_face, h_right_face]
        hr_, hl_ = hL[1:], hR[:-1]      # depths at the cell's right and left faces
        dh = hr_ - hl_
        Abar = np.where(np.abs(dh) > 1e-10,
                        (sec.I1(hr_) - sec.I1(hl_)) / np.where(dh == 0, 1.0, dh),
                        sec.area(0.5 * (hr_ + hl_)))
        src = -G * Abar * (zL[1:] - zR[:-1]) / dx

        dA = -(FA_r - FA_l) / dx
        dQ = -(FQ_r - FQ_l) / dx + src
        return dA, dQ

    # ------------------------------------------------------------- step
    def _clean(self, A, Q):
        """Dry cells keep their (sub-threshold) film of water, so mass is conserved exactly;
        only their discharge is zeroed. Negative areas from round-off are floored at zero."""
        c = slice(NG, -NG)
        A[c] = np.maximum(A[c], 0.0)
        dry = self.sec.depth(A[c]) <= self.eps
        Q[c] = np.where(dry, 0.0, Q[c])

    def stable_dt(self):
        h = self.hc
        speed = np.abs(self.uc) + self.sec.celerity(h)
        smax = speed.max()
        return self.cfl * self.dx / smax if smax > 0 else np.inf

    def _friction(self, A, Q, dt):
        """Fully implicit Manning friction on the interior cells (in place):
        Q_new (1 + dt c |Q_new|) = Q_pre, solved exactly, with c = g n^2 P^(4/3) / A^(7/3).
        Applied after every Euler substep, so bed slope and friction balance exactly at
        steady state and every intermediate state respects the boundary conditions."""
        if self.n <= 0.0:
            return
        c = slice(NG, -NG)
        h = self.sec.depth(A[c])
        wet = h > self.eps
        As = np.where(wet, A[c], 1.0)
        Ps = np.where(wet, self.sec.perimeter(h), 1.0)
        k = dt * G * self.n ** 2 * Ps ** (4.0 / 3.0) / As ** (7.0 / 3.0)
        q = Q[c]
        Q[c] = np.sign(q) * (np.sqrt(1.0 + 4.0 * k * np.abs(q)) - 1.0) / (2.0 * k)

    def step(self, dt):
        """SSP-RK2 (Heun): U1 = E(U), U2 = E(U1), U_new = (U + U2)/2, where E is one Euler
        substep followed by implicit friction and the dry-cell cleanup."""
        A, Q, c = self.A, self.Q, slice(NG, -NG)
        self.apply_bc(A, Q, self.t)
        dA1, dQ1 = self.rhs(A, Q, dt)
        A1, Q1 = A.copy(), Q.copy()
        A1[c] += dt * dA1
        Q1[c] += dt * dQ1
        self._friction(A1, Q1, dt)
        self._clean(A1, Q1)
        self.apply_bc(A1, Q1, self.t + dt)
        dA2, dQ2 = self.rhs(A1, Q1, dt)
        A2, Q2 = A1.copy(), Q1.copy()
        A2[c] += dt * dA2
        Q2[c] += dt * dQ2
        self._friction(A2, Q2, dt)
        self._clean(A2, Q2)
        A[c] = 0.5 * (A[c] + A2[c])
        Q[c] = 0.5 * (Q[c] + Q2[c])
        self._clean(A, Q)
        self.t += dt

    def run(self, tend, callback=None):
        while self.t < tend - 1e-12:
            self.apply_bc(self.A, self.Q, self.t)
            dt = min(self.stable_dt(), tend - self.t)
            self.step(dt)
            if callback:
                callback(self)
        return self
