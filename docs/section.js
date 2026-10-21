/* Prismatic channel cross-sections: JS port of src/svroute/section.py (same maths, same tables). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SEC = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const G = 9.81, BIG = 1e6, TAB_HMAX = 100, TAB_M = 10000;

  function seg(arr, v, n) {            // largest idx with arr[idx] <= v, clipped to [0, n-1]
    let lo = 0, hi = arr.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (arr[mid] <= v) lo = mid; else hi = mid - 1; }
    return lo < 0 ? 0 : lo > n - 1 ? n - 1 : lo;
  }

  class Section {
    constructor(heights, widths, name) {
      const h = heights.slice(), b = widths.slice();
      if (h[0] !== 0) throw new Error("heights must start at 0");
      h.push(h[h.length - 1] + BIG); b.push(b[b.length - 1]);
      this.name = name || "custom";
      this.hk = h; this.bk = b;
      const n = h.length - 1; this.nseg = n;
      this.sk = []; this.Ak = [0]; this.Ik = [0]; this.Pk = [b[0]];
      for (let k = 0; k < n; k++) {
        const d = h[k + 1] - h[k], s = (b[k + 1] - b[k]) / d;
        this.sk.push(s);
        this.Ak.push(this.Ak[k] + b[k] * d + 0.5 * s * d * d);
        this.Ik.push(this.Ik[k] + this.Ak[k] * d + 0.5 * b[k] * d * d + (s * d * d * d) / 6);
        this.Pk.push(this.Pk[k] + Math.sqrt(4 + s * s) * d);
      }
      // Riemann-invariant table F(h), midpoint rule in u = sqrt(h)  (identical to Python)
      const du = Math.sqrt(TAB_HMAX) / TAB_M;
      this._du = du;
      this._F = new Float64Array(TAB_M + 1);
      let acc = 0;
      for (let j = 0; j < TAB_M; j++) {
        const um = (j + 0.5) * du, hm = um * um;
        acc += 2 * um * Math.sqrt((G * this.width(hm)) / this.area(hm)) * du;
        this._F[j + 1] = acc;
      }
    }
    width(h) { const i = seg(this.hk, h, this.nseg); return this.bk[i] + this.sk[i] * (h - this.hk[i]); }
    area(h) {
      if (h < 0) h = 0;
      const i = seg(this.hk, h, this.nseg), d = h - this.hk[i];
      return this.Ak[i] + this.bk[i] * d + 0.5 * this.sk[i] * d * d;
    }
    I1(h) {
      if (h < 0) h = 0;
      const i = seg(this.hk, h, this.nseg), d = h - this.hk[i];
      return this.Ik[i] + this.Ak[i] * d + 0.5 * this.bk[i] * d * d + (this.sk[i] * d * d * d) / 6;
    }
    perimeter(h) {
      if (h < 0) h = 0;
      const i = seg(this.hk, h, this.nseg), d = h - this.hk[i];
      return this.Pk[i] + Math.sqrt(4 + this.sk[i] * this.sk[i]) * d;
    }
    depth(A) {
      if (A < 0) A = 0;
      const i = seg(this.Ak, A, this.nseg), dA = A - this.Ak[i];
      const den = this.bk[i] + Math.sqrt(this.bk[i] * this.bk[i] + 2 * this.sk[i] * dA);
      return this.hk[i] + (den > 0 ? (2 * dA) / den : 0);
    }
    celerity(h) {
      const B = this.width(h);
      return Math.sqrt(G * (B > 1e-12 ? this.area(h) / B : 0));
    }
    F(h) {
      const u = Math.sqrt(Math.max(h, 0)) / this._du;
      const j = Math.min(Math.floor(u), TAB_M - 1), w = u - j;
      return this._F[j] * (1 - w) + this._F[j + 1] * w;
    }
    manningQ(h, slope, n) {
      const A = this.area(h), P = this.perimeter(h);
      return (A * Math.pow(A / P, 2 / 3) * Math.sqrt(slope)) / n;
    }
    normalDepth(Q, slope, n) {
      let lo = 1e-9, hi = 90;
      for (let i = 0; i < 200; i++) {
        const mid = 0.5 * (lo + hi);
        if (this.manningQ(mid, slope, n) < Q) lo = mid; else hi = mid;
      }
      return 0.5 * (lo + hi);
    }
  }

  const rectangular = (b) => new Section([0], [b], "rectangular");
  const trapezoid = (b, m, hmax) => { hmax = hmax || 50; return new Section([0, hmax], [b, b + 2 * m * hmax], "trapezoid"); };
  const vee = (m, hmax) => { hmax = hmax || 100; return new Section([0, hmax], [0, 2 * m * hmax], "V-valley"); };
  function compound(b, m, hBank, bPlain, mPlain, hmax) {
    mPlain = mPlain || 4; hmax = hmax || 50;
    const top = b + 2 * m * hBank, step = 0.02 * hBank;
    if (bPlain <= top) throw new Error("floodplain width must exceed the bank-full top width");
    return new Section([0, hBank, hBank + step, hmax],
      [b, top, bPlain, bPlain + 2 * mPlain * (hmax - hBank - step)], "compound");
  }

  function fromSpec(sp) {
    if (sp.type === "rectangular") return rectangular(sp.b);
    if (sp.type === "trapezoid") return trapezoid(sp.b, sp.m);
    if (sp.type === "vee") return vee(sp.m);
    if (sp.type === "compound") return compound(sp.b, sp.m, sp.h_bank, sp.b_plain);
    throw new Error("unknown section type " + sp.type);
  }

  return { Section, rectangular, trapezoid, vee, compound, fromSpec, G };
});
