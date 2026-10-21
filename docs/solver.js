/* 1D Saint-Venant solver: JS port of src/svroute/solver.py (same scheme, same defaults).
 * HLL (Einfeldt speeds, exact dry fronts) + MUSCL(minmod) + hydrostatic reconstruction with
 * pressure-consistent source + positivity-preserving flux limiter + SSP-RK2 with implicit friction.
 * Browser: window.SV.  Node: module.exports. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./section.js"));
  else root.SV = factory(root.SEC);
})(typeof self !== "undefined" ? self : this, function (SEC) {
  "use strict";
  const G = 9.81, NG = 2;
  const minmod = (a, b) => (a * b <= 0 ? 0 : Math.abs(a) < Math.abs(b) ? a : b);
  function limitedSlope(x, s) {
    const n = x.length; s[0] = 0; s[n - 1] = 0;
    for (let i = 1; i < n - 1; i++) s[i] = minmod(x[i] - x[i - 1], x[i + 1] - x[i]);
  }

  const _f = [0, 0];
  function hll(sec, eps, hL, uL, hR, uR) {
    const dryL = hL <= eps, dryR = hR <= eps;
    if (dryL && dryR) { _f[0] = 0; _f[1] = 0; return _f; }
    if (dryL) { hL = 0; uL = 0; }
    if (dryR) { hR = 0; uR = 0; }
    const AL = sec.area(hL), AR = sec.area(hR), cL = sec.celerity(hL), cR = sec.celerity(hR);
    const sqL = Math.sqrt(AL), sqR = Math.sqrt(AR), den0 = sqL + sqR > 0 ? sqL + sqR : 1;
    const um = (sqL * uL + sqR * uR) / den0, cm = Math.sqrt(0.5 * (cL * cL + cR * cR));
    let sL = Math.min(uL - cL, um - cm), sR = Math.max(uR + cR, um + cm);
    if (dryL) { sL = uR - sec.F(hR); sR = uR + cR; }
    if (dryR) { sL = uL - cL; sR = uL + sec.F(hL); }
    const QL = AL * uL, QR = AR * uR;
    const fqL = QL * uL + G * sec.I1(hL), fqR = QR * uR + G * sec.I1(hR);
    if (sL >= 0) { _f[0] = QL; _f[1] = fqL; }
    else if (sR <= 0) { _f[0] = QR; _f[1] = fqR; }
    else {
      const d = sR - sL === 0 ? 1 : sR - sL;
      _f[0] = (sR * QL - sL * QR + sL * sR * (AR - AL)) / d;
      _f[1] = (sR * fqL - sL * fqR + sL * sR * (QR - QL)) / d;
    }
    return _f;
  }

  class Solver {
    /* o: section, N, L, z(x), h0(x) depth, Q0(x)?, n, bcUp:'wall'|'open'|'flow', bcDown:'wall'|'open'|'depth',
     *    qIn(t)?, hDown?, cfl, eps */
    constructor(o) {
      this.sec = o.section; this.N = o.N; this.L = o.L; this.dx = o.L / o.N;
      this.n = o.n || 0;
      this.bcUp = o.bcUp || "wall"; this.bcDown = o.bcDown || "open";
      this.qIn = o.qIn || (() => 0); this.hDown = o.hDown || 0;
      this.cfl = o.cfl || 0.4; this.eps = o.eps === undefined ? 1e-4 : o.eps;
      const M = this.N + 2 * NG; this.M = M;
      const w = () => new Float64Array(M), I = () => new Float64Array(this.N + 1), C = () => new Float64Array(this.N);
      this.x = w(); this.z = w(); this.A = w(); this.Q = w();
      for (let i = 0; i < M; i++) {
        const x = (i - NG + 0.5) * this.dx;
        this.x[i] = x; this.z[i] = o.z(x);
        let h = Math.max(o.h0(x), 0); if (h <= this.eps) h = 0;
        this.A[i] = this.sec.area(h);
        this.Q[i] = h === 0 ? 0 : (o.Q0 ? o.Q0(x) : 0);
      }
      this.t = 0;
      this._ghostZ();
      this.applyBC(this.A, this.Q, 0);
      this.h = w(); this.u = w(); this.eta = w(); this.se = w(); this.su = w(); this.sz = w();
      this.etaL = I(); this.etaR = I(); this.uL = I(); this.uR = I(); this.zL = I(); this.zR = I();
      this.hL = I(); this.hR = I(); this.hLs = I(); this.hRs = I(); this.FA = I(); this.FQ = I();
      this.theta = new Float64Array(this.N + 2);
      this.dA1 = C(); this.dQ1 = C(); this.dA2 = C(); this.dQ2 = C();
      this.A1 = w(); this.Q1 = w(); this.A2 = w(); this.Q2 = w();
    }

    _ghostZ() {
      const z = this.z, N = this.N;
      if (this.bcUp === "wall") { z[1] = z[2]; z[0] = z[3]; } else { z[1] = 2 * z[2] - z[3]; z[0] = 2 * z[1] - z[2]; }
      if (this.bcDown === "wall") { z[N + 2] = z[N + 1]; z[N + 3] = z[N]; }
      else { z[N + 2] = 2 * z[N + 1] - z[N]; z[N + 3] = 2 * z[N + 2] - z[N + 1]; }
    }

    applyBC(A, Q, t) {
      const N = this.N;
      if (this.bcUp === "wall") { A[1] = A[2]; A[0] = A[3]; Q[1] = -Q[2]; Q[0] = -Q[3]; }
      else if (this.bcUp === "open") { A[1] = A[0] = A[2]; Q[1] = Q[0] = Q[2]; }
      else { A[1] = A[0] = A[2]; Q[1] = Q[0] = this.qIn(t); }
      if (this.bcDown === "wall") { A[N + 2] = A[N + 1]; A[N + 3] = A[N]; Q[N + 2] = -Q[N + 1]; Q[N + 3] = -Q[N]; }
      else if (this.bcDown === "open") { A[N + 2] = A[N + 3] = A[N + 1]; Q[N + 2] = Q[N + 3] = Q[N + 1]; }
      else { A[N + 2] = A[N + 3] = this.sec.area(this.hDown); Q[N + 2] = Q[N + 3] = Q[N + 1]; }
    }

    rhs(A, Q, dt, dA, dQ) {
      const sec = this.sec, N = this.N, M = this.M, eps = this.eps, dx = this.dx, z = this.z;
      const h = this.h, u = this.u, eta = this.eta;
      for (let i = 0; i < M; i++) {
        h[i] = sec.depth(A[i]);
        u[i] = h[i] > eps ? Q[i] / A[i] : 0;
        eta[i] = h[i] + z[i];
      }
      limitedSlope(eta, this.se); limitedSlope(u, this.su); limitedSlope(z, this.sz);
      const { se, su, sz, etaL, etaR, uL, uR, zL, zR, hL, hR, hLs, hRs, FA, FQ, theta } = this;
      for (let m = 0; m <= N; m++) {
        const a = m + 1, b = m + 2;
        etaL[m] = eta[a] + 0.5 * se[a]; etaR[m] = eta[b] - 0.5 * se[b];
        uL[m] = u[a] + 0.5 * su[a]; uR[m] = u[b] - 0.5 * su[b];
        zL[m] = z[a] + 0.5 * sz[a]; zR[m] = z[b] - 0.5 * sz[b];
        hL[m] = Math.max(etaL[m] - zL[m], 0); hR[m] = Math.max(etaR[m] - zR[m], 0);
        const zs = Math.max(zL[m], zR[m]);
        hLs[m] = Math.max(etaL[m] - zs, 0); hRs[m] = Math.max(etaR[m] - zs, 0);
        const f = hll(sec, eps, hLs[m], uL[m], hRs[m], uR[m]);
        FA[m] = f[0]; FQ[m] = f[1];
      }
      // positivity-preserving limiter
      theta[0] = 1; theta[N + 1] = 1;
      for (let k = 0; k < N; k++) {
        const out = Math.max(FA[k + 1], 0) + Math.max(-FA[k], 0), Ac = A[k + NG];
        theta[k + 1] = out * dt > Ac * dx ? (Ac * dx) / (out * dt) : 1;
      }
      for (let m = 0; m <= N; m++) {
        const th = FA[m] >= 0 ? theta[m] : theta[m + 1];
        FA[m] *= th; FQ[m] *= th;
      }
      for (let k = 0; k < N; k++) {
        const FQr = FQ[k + 1] + G * (sec.I1(hL[k + 1]) - sec.I1(hLs[k + 1]));
        const FQl = FQ[k] + G * (sec.I1(hR[k]) - sec.I1(hRs[k]));
        const hr = hL[k + 1], hl = hR[k], dh = hr - hl;
        const Abar = Math.abs(dh) > 1e-10 ? (sec.I1(hr) - sec.I1(hl)) / dh : sec.area(0.5 * (hr + hl));
        const src = (-G * Abar * (zL[k + 1] - zR[k])) / dx;
        dA[k] = -(FA[k + 1] - FA[k]) / dx;
        dQ[k] = -(FQr - FQl) / dx + src;
      }
    }

    _clean(A, Q) {
      for (let i = NG; i < this.M - NG; i++) {
        if (A[i] < 0) A[i] = 0;
        if (this.sec.depth(A[i]) <= this.eps) Q[i] = 0;
      }
    }

    _friction(A, Q, dt) {
      if (this.n <= 0) return;
      const sec = this.sec, n2 = this.n * this.n;
      for (let i = NG; i < this.M - NG; i++) {
        const h = sec.depth(A[i]), wet = h > this.eps;
        const As = wet ? A[i] : 1, Ps = wet ? sec.perimeter(h) : 1;
        const k = (dt * G * n2 * Math.pow(Ps, 4 / 3)) / Math.pow(As, 7 / 3), q = Q[i];
        Q[i] = Math.sign(q) * (Math.sqrt(1 + 4 * k * Math.abs(q)) - 1) / (2 * k);
      }
    }

    stableDt() {
      let smax = 0;
      for (let i = NG; i < this.M - NG; i++) {
        const h = this.sec.depth(this.A[i]);
        const u = h > this.eps ? this.Q[i] / this.A[i] : 0;
        const s = Math.abs(u) + this.sec.celerity(h);
        if (s > smax) smax = s;
      }
      return smax > 0 ? (this.cfl * this.dx) / smax : Infinity;
    }

    step(dt) {
      const A = this.A, Q = this.Q, A1 = this.A1, Q1 = this.Q1, A2 = this.A2, Q2 = this.Q2, N = this.N;
      this.applyBC(A, Q, this.t);
      this.rhs(A, Q, dt, this.dA1, this.dQ1);
      A1.set(A); Q1.set(Q);
      for (let k = 0; k < N; k++) { A1[k + NG] += dt * this.dA1[k]; Q1[k + NG] += dt * this.dQ1[k]; }
      this._friction(A1, Q1, dt); this._clean(A1, Q1);
      this.applyBC(A1, Q1, this.t + dt);
      this.rhs(A1, Q1, dt, this.dA2, this.dQ2);
      A2.set(A1); Q2.set(Q1);
      for (let k = 0; k < N; k++) { A2[k + NG] += dt * this.dA2[k]; Q2[k + NG] += dt * this.dQ2[k]; }
      this._friction(A2, Q2, dt); this._clean(A2, Q2);
      for (let i = NG; i < NG + N; i++) { A[i] = 0.5 * (A[i] + A2[i]); Q[i] = 0.5 * (Q[i] + Q2[i]); }
      this._clean(A, Q);
      this.t += dt;
    }

    /* advance to tend (or at most maxSteps steps, to keep frames responsive) */
    advanceTo(tend, maxSteps) {
      let steps = 0;
      while (this.t < tend - 1e-12 && steps < (maxSteps || Infinity)) {
        this.applyBC(this.A, this.Q, this.t);
        this.step(Math.min(this.stableDt(), tend - this.t));
        steps++;
      }
      return steps;
    }

    snapshot() { return { t: this.t, A: this.A.slice(NG, this.M - NG), Q: this.Q.slice(NG, this.M - NG) }; }
    restore(s) { this.A.set(s.A, NG); this.Q.set(s.Q, NG); this.t = s.t; this.applyBC(this.A, this.Q, this.t); }
    xc(i) { return this.x[i + NG]; }
    zc(i) { return this.z[i + NG]; }
    volume() { let v = 0; for (let i = NG; i < NG + this.N; i++) v += this.A[i]; return v * this.dx; }
  }

  /* Dam at x0: flat pool level hUp above the bed at the dam upstream, depth hDown downstream. */
  function damBreak(o) {
    const slope = o.slope || 0, x0 = o.x0, etaUp = -slope * x0 + o.hUp;
    return new Solver({
      section: o.section, N: o.N, L: o.L, n: o.n || 0,
      bcUp: o.bcUp || "wall", bcDown: o.bcDown || "open",
      z: (x) => -slope * x,
      h0: (x) => (x < x0 ? Math.max(etaUp + slope * x, 0) : o.hDown),
    });
  }

  return { Solver, damBreak, G, NG };
});
