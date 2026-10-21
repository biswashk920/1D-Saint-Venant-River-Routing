"""Prismatic channel cross-sections.

A section is symmetric about the channel axis and defined by its top width B(h) as a
piecewise-linear function of depth h. Everything the solver needs is then exact:

    A(h)   = int_0^h B                       flow area
    I1(h)  = int_0^h A                       hydrostatic pressure force / g
    P(h)   = B(0) + int_0^h sqrt(4 + B'^2)   wetted perimeter (two sloping sides)
    h(A)   closed-form inverse of A(h)       (quadratic per segment)
    c(h)   = sqrt(g A / B)                   wave celerity
    F(h)   = int_0^h sqrt(g B / A) dh        Riemann-invariant integral (tabulated)

For a rectangle F = 2 sqrt(g h), recovering the classical Ritter solution.
"""

import numpy as np

G = 9.81
_BIG = 1.0e6          # last segment is extended to this depth with constant width
_TAB_HMAX = 100.0     # F table covers depths up to this value
_TAB_M = 10000        # table resolution (in sqrt(h))


class Section:
    def __init__(self, heights, widths, name="custom"):
        h = np.asarray(heights, dtype=float)
        b = np.asarray(widths, dtype=float)
        if h[0] != 0.0 or np.any(np.diff(h) <= 0) or np.any(np.diff(b) < 0):
            raise ValueError("heights must start at 0 and increase; widths must not decrease")
        # extend the last width to a very large depth (water never gets there)
        h = np.append(h, max(h[-1], 0.0) + _BIG)
        b = np.append(b, b[-1])
        self.name = name
        self.hk, self.bk = h, b
        self.sk = np.diff(b) / np.diff(h)
        n = len(h) - 1
        self.nseg = n
        d = np.diff(h)
        self.Ak = np.zeros(n + 1)
        self.Ik = np.zeros(n + 1)
        self.Pk = np.zeros(n + 1)
        self.Pk[0] = b[0]
        for k in range(n):
            self.Ak[k + 1] = self.Ak[k] + b[k] * d[k] + 0.5 * self.sk[k] * d[k] ** 2
            self.Ik[k + 1] = (self.Ik[k] + self.Ak[k] * d[k] + 0.5 * b[k] * d[k] ** 2
                              + self.sk[k] * d[k] ** 3 / 6.0)
            self.Pk[k + 1] = self.Pk[k] + np.sqrt(4.0 + self.sk[k] ** 2) * d[k]
        self._build_F_table()

    # ------------------------------------------------------------------ geometry
    def _seg(self, h):
        h = np.asarray(h, dtype=float)
        idx = np.clip(np.searchsorted(self.hk, h, side="right") - 1, 0, self.nseg - 1)
        return idx, h - self.hk[idx]

    def width(self, h):
        i, d = self._seg(h)
        return self.bk[i] + self.sk[i] * d

    def area(self, h):
        i, d = self._seg(np.maximum(h, 0.0))
        return self.Ak[i] + self.bk[i] * d + 0.5 * self.sk[i] * d * d

    def I1(self, h):
        i, d = self._seg(np.maximum(h, 0.0))
        return (self.Ik[i] + self.Ak[i] * d + 0.5 * self.bk[i] * d * d
                + self.sk[i] * d ** 3 / 6.0)

    def perimeter(self, h):
        i, d = self._seg(np.maximum(h, 0.0))
        return self.Pk[i] + np.sqrt(4.0 + self.sk[i] ** 2) * d

    def depth(self, A):
        """Closed-form inverse of area(h)."""
        A = np.maximum(np.asarray(A, dtype=float), 0.0)
        i = np.clip(np.searchsorted(self.Ak, A, side="right") - 1, 0, self.nseg - 1)
        dA = A - self.Ak[i]
        den = self.bk[i] + np.sqrt(self.bk[i] ** 2 + 2.0 * self.sk[i] * dA)
        d = np.divide(2.0 * dA, den, out=np.zeros_like(dA), where=den > 0)
        return self.hk[i] + d

    def celerity(self, h):
        h = np.asarray(h, dtype=float)
        A, B = self.area(h), self.width(h)
        return np.sqrt(G * np.divide(A, B, out=np.zeros_like(A), where=B > 1e-12))

    # -------------------------------------------- Riemann invariant F(h) (tabulated)
    def _build_F_table(self):
        M = _TAB_M
        du = np.sqrt(_TAB_HMAX) / M
        um = (np.arange(M) + 0.5) * du               # midpoints in u = sqrt(h)
        hm = um ** 2
        A, B = self.area(hm), self.width(hm)
        f = 2.0 * um * np.sqrt(G * B / A)             # integrand of dF/du, smooth at u -> 0
        self._du = du
        self._Ftab = np.concatenate([[0.0], np.cumsum(f * du)])

    def F(self, h):
        u = np.sqrt(np.maximum(np.asarray(h, dtype=float), 0.0)) / self._du
        j = np.minimum(u.astype(int), _TAB_M - 1)
        w = u - j
        return self._Ftab[j] * (1 - w) + self._Ftab[j + 1] * w

    # --------------------------------------------------------------- hydraulics
    def conveyance_discharge(self, h, slope, n):
        """Manning discharge Q (m^3/s) at depth h on bed slope `slope`."""
        A, P = self.area(h), self.perimeter(h)
        return A * (A / P) ** (2.0 / 3.0) * np.sqrt(slope) / n

    def normal_depth(self, Q, slope, n):
        lo, hi = 1e-9, 90.0
        for _ in range(200):
            mid = 0.5 * (lo + hi)
            if self.conveyance_discharge(mid, slope, n) < Q:
                lo = mid
            else:
                hi = mid
        return 0.5 * (lo + hi)


# ----------------------------------------------------------------------- factories
def rectangular(b):
    return Section([0.0], [b], name=f"rectangular b={b:g}")


def trapezoid(b, m, hmax=50.0):
    """Bottom width b, side slope m (horizontal : vertical)."""
    return Section([0.0, hmax], [b, b + 2.0 * m * hmax], name=f"trapezoid b={b:g} m={m:g}")


def vee(m, hmax=100.0):
    """V-shaped valley, side slope m (horizontal : vertical)."""
    return Section([0.0, hmax], [0.0, 2.0 * m * hmax], name=f"V-valley m={m:g}")


def compound(b, m, h_bank, b_plain, m_plain=4.0, hmax=50.0):
    """Trapezoidal main channel up to h_bank, then a flat floodplain of total width b_plain."""
    top = b + 2.0 * m * h_bank
    if b_plain <= top:
        raise ValueError("floodplain width must exceed the bank-full top width")
    step = 0.02 * h_bank
    return Section(
        [0.0, h_bank, h_bank + step, hmax],
        [b, top, b_plain, b_plain + 2.0 * m_plain * (hmax - h_bank - step)],
        name=f"compound b={b:g} bank={h_bank:g} plain={b_plain:g}",
    )


def from_spec(spec):
    """Build a section from a plain dict, e.g. {"type": "trapezoid", "b": 5, "m": 2}."""
    kind = spec["type"]
    if kind == "rectangular":
        return rectangular(spec["b"])
    if kind == "trapezoid":
        return trapezoid(spec["b"], spec["m"])
    if kind == "vee":
        return vee(spec["m"])
    if kind == "compound":
        return compound(spec["b"], spec["m"], spec["h_bank"], spec["b_plain"])
    raise ValueError(f"unknown section type {kind!r}")
