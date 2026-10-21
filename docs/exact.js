/* Exact dam-break and oscillating-lake solutions (JS port of src/svroute/analytical.py). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.EXACT = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const G = 9.81;

  function interp(x, xs, ys) {                   // xs increasing
    if (x <= xs[0]) return ys[0];
    const n = xs.length; if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    return ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / (xs[hi] - xs[lo]);
  }

  /* Generalised Ritter (hd = 0) / Stoker (hd > 0) for any prismatic section. */
  class DamBreak {
    constructor(sec, h0, hd) {
      this.sec = sec; this.h0 = h0; this.hd = hd;
      this.F0 = sec.F(h0); this.c0 = sec.celerity(h0);
      let hm = 0, um = 0, S = 0;
      if (hd > 0) {
        const Ad = sec.area(hd), I1d = sec.I1(hd);
        const f = (h) => this.F0 - sec.F(h) - Math.sqrt((G * (sec.I1(h) - I1d) * (sec.area(h) - Ad)) / (sec.area(h) * Ad));
        let lo = hd, hi = h0;
        for (let i = 0; i < 200; i++) { const mid = 0.5 * (lo + hi); if (f(lo) * f(mid) <= 0) hi = mid; else lo = mid; }
        hm = 0.5 * (lo + hi); const Am = sec.area(hm);
        um = this.F0 - sec.F(hm); S = (um * Am) / (Am - Ad);
      }
      this.hm = hm; this.um = um; this.S = S; this.cm = hd > 0 ? sec.celerity(hm) : 0;
      const n = 4001, hmin = hd > 0 ? hm : 0, s0 = Math.sqrt(h0), s1 = Math.sqrt(hmin);
      this.xi = new Float64Array(n); this.hh = new Float64Array(n); this.uu = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const s = s0 + ((s1 - s0) * i) / (n - 1), h = s * s;
        this.hh[i] = h; this.uu[i] = this.F0 - sec.F(h); this.xi[i] = this.uu[i] - sec.celerity(h);
      }
    }
    depth(x, t, x0) {
      const xi = (x - x0) / Math.max(t, 1e-12);
      if (xi <= -this.c0) return this.h0;
      if (this.hd === 0) return xi <= this.F0 ? interp(xi, this.xi, this.hh) : 0;
      if (xi <= this.um - this.cm) return interp(xi, this.xi, this.hh);
      return xi <= this.S ? this.hm : this.hd;
    }
  }

  function thackerParams(hMax, L) { const kappa = hMax / ((L / 4) * (L / 4)); return { kappa, omega: Math.sqrt(2 * G * kappa) }; }
  function thackerDepth(x, t, hMax, L, X0) {
    const { kappa, omega } = thackerParams(hMax, L), X = X0 * Math.cos(omega * t), xr = x - L / 2 - X;
    return Math.max(hMax - kappa * xr * xr, 0);
  }
  return { DamBreak, thackerParams, thackerDepth };
});
