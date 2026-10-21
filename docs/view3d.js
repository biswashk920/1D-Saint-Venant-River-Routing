/* 3D views built on gl.js:
 *  Scene3D     - the river reach as a 3D valley with the computed water surface
 *  SpaceTime   - the depth surface h(x, t) with the exact wave lines
 * Everything drawn comes from the 1D solution plus the section geometry B(h): the lateral spread of
 * water is the width B(h) of the cross-section at the computed depth, not a separate 2D computation. */
(function (root, factory) { root.V3D = factory(root.GLX, root.SV, root.SCEN, root.EXACT); })(typeof self !== "undefined" ? self : this, function (GLX, SV, SCEN, EXACT) {
  "use strict";
  const G = SV.G, LW = 10;                       // world length of the reach
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  function hsl(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    const f = (p, q, t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    return [f(p, q, h + 1 / 3), f(p, q, h), f(p, q, h - 1 / 3)];
  }
  const RAMP = [[0.27, 0.0, 0.33], [0.23, 0.32, 0.55], [0.13, 0.57, 0.55], [0.37, 0.79, 0.38], [0.99, 0.91, 0.14]];
  function ramp(t) {
    t = clamp(t, 0, 1) * (RAMP.length - 1); const i = Math.min(Math.floor(t), RAMP.length - 2);
    return mix(RAMP[i], RAMP[i + 1], t - i);
  }
  const HAZARD = [[0.3, [0.30, 0.74, 0.36], "< 0.3"], [0.6, [0.96, 0.84, 0.22], "0.3 - 0.6"], [1.2, [0.96, 0.55, 0.16], "0.6 - 1.2"],
    [4.0, [0.86, 0.16, 0.16], "1.2 - 4"], [Infinity, [0.45, 0.05, 0.22], "> 4"]];
  const hazardColor = (dv) => { for (const [lim, c] of HAZARD) if (dv < lim) return c; return HAZARD[4][1]; };

  const C_BED = [0.74, 0.62, 0.42], C_BANK = [0.47, 0.57, 0.35], C_PLAIN = [0.40, 0.52, 0.31], C_EARTH = [0.45, 0.34, 0.24];
  const C_SHALLOW = [0.30, 0.68, 0.88], C_DEEP = [0.04, 0.26, 0.55];

  function layerColor(layer, sec, h, u, hmax, vscale) {
    if (layer === "velocity") return hsl(240 - 240 * clamp(Math.abs(u) / vscale, 0, 1), 0.75, 0.5);
    if (layer === "froude") { const fr = h > 0 ? Math.abs(u) / sec.celerity(h) : 0; return hsl(240 - 240 * clamp(fr / 2, 0, 1), 0.75, 0.5); }
    if (layer === "hazard") return hazardColor(h * Math.abs(u));
    return mix(C_SHALLOW, C_DEEP, clamp(h / hmax, 0, 1));
  }

  /* ---------------------------------------------------------------- a small box builder */
  const BOX_IDX = (n) => { const o = []; for (let b = 0; b < n; b++) for (let f = 0; f < 6; f++) { const v = b * 24 + f * 4; o.push(v, v + 1, v + 2, v, v + 2, v + 3); } return o; };
  const FACES = [[[1, 0, 0], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]]], [[-1, 0, 0], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]]],
    [[0, 1, 0], [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]]], [[0, -1, 0], [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]]],
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]], [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]]];
  function putBox(P, N, C, b, cx, cy, cz, sx, sy, sz, col, a) {
    let v = b * 24;
    for (const [n, vs] of FACES) for (const q of vs) {
      P[v * 3] = cx + q[0] * sx / 2; P[v * 3 + 1] = cy + q[1] * sy / 2; P[v * 3 + 2] = cz + q[2] * sz / 2;
      N[v * 3] = n[0]; N[v * 3 + 1] = n[1]; N[v * 3 + 2] = n[2];
      C[v * 4] = col[0]; C[v * 4 + 1] = col[1]; C[v * 4 + 2] = col[2]; C[v * 4 + 3] = a === undefined ? 1 : a; v++;
    }
  }

  /* ----------------------------------------------------------------------- cross-section outline */
  function outline(sec, hcap) {
    const hs = [];
    for (let i = 0; i <= 30; i++) hs.push((hcap * i) / 30);
    for (const hk of sec.hk) if (hk > 1e-9 && hk < hcap) hs.push(hk);
    hs.sort((a, b) => a - b);
    const Y = [0], D = [0];
    for (const h of hs) { Y.push(sec.width(h) / 2); D.push(h); }
    const yc = Y[Y.length - 1], ext = Math.max(0.8 * yc, 2 * hcap);
    for (const t of [0.25, 0.6, 1]) { Y.push(yc + ext * t); D.push(hcap + 0.08 * ext * t); }
    return { Y, D, yc, W: yc + ext };
  }

  /* ============================================================================ Scene3D */
  class Scene3D {
    constructor(renderer) {
      this.r = renderer; this.cam = new GLX.OrbitCamera(); this.ve = 1; this.we = 1; this.cut = false;
      this.sim = null; this.NP = 450; this.labels = []; this.tickLabels = [];
    }

    /* called whenever the scenario is (re)built */
    setup(sim, veOverride, weOverride) {
      const r = this.r, sec = sim.sec, v = sim.vals, L = v.L;
      this.sim = sim; this.sec = sec; this.L = L; this.N = sim.solver.N; this.s = LW / L;
      this.hcap = 1.5 * sim.hmax;
      this.relief = Math.max(sim.zmax - sim.zmin, 0);
      this.out = outline(sec, this.hcap);
      this.veAuto = clamp(Math.min((0.06 * L) / sim.hmax, (0.3 * L) / Math.max(this.relief, 1e-9)), 1, 120);
      this.weAuto = clamp((0.16 * L) / this.out.W, 1, 60);
      this.ve = veOverride !== undefined ? veOverride : Math.round(this.veAuto);
      this.we = weOverride !== undefined ? weOverride : Math.round(this.weAuto * 10) / 10;
      this.nx = Math.min(this.N, 200);
      this.cols = Array.from({ length: this.nx }, (_, j) => Math.round((j * (this.N - 1)) / (this.nx - 1)));
      this.xm = this.cols.map((c) => sim.solver.xc(c));
      this.umax = 1e-6;
      this.vscale = sim.kind === "route" ? 1.5 * sim.qp / sec.area(v.hUp)
        : sim.kind === "bowl" ? Math.max(1e-6, sim.X0 * EXkappaOmega(v)) : Math.max(sec.F(v.hUp), 1e-6);
      this.initParticles();
      this.buildStatic();
      this.preset("oblique");
    }

    Y(elev) { return (elev - this.sim.zmin) * this.s * this.ve; }

    preset(name) {
      const c = this.cam, top = this.Y(this.sim.zmax + this.hcap) * 0.5;
      const t = [0, Math.max(top * 0.4, 0.2), 0];
      if (name === "oblique") c.set(Math.PI - 0.7, 0.4, 9.2, t);
      else if (name === "side") c.set(Math.PI, 0.08, 9.5, t);
      else if (name === "top") c.set(Math.PI, 1.5, 10, [0, 0, 0]);
      else if (name === "front") c.set(Math.PI - 0.35, 0.3, 4.5, t);
    }

    setExaggeration(ve, we) { this.ve = ve; this.we = we; this.buildStatic(); }
    setCut(cut) { this.cut = cut; this.buildStatic(); }

    /* ---------------------------------------------------------------- static geometry */
    disposeStatic() {
      for (const k of ["terrain", "earth", "dam", "tickLines", "water", "ghost", "ghostLines", "cutWater", "gaugeMesh", "partLines"]) {
        if (this[k]) { this[k].dispose(); this[k] = null; }
      }
    }

    buildStatic() {
      this.disposeStatic();
      const r = this.r, sim = this.sim, sec = this.sec, s = this.s, ve = this.ve, we = this.we, L = this.L;
      const { Y: LY, D: LD } = this.out, K = LY.length, nx = this.nx, cut = this.cut;
      const cols = cut ? K : 2 * K - 1;
      const lat = (m) => (cut ? LY[m] : m < K - 1 ? -LY[K - 1 - m] : LY[m - (K - 1)]);
      const dep = (m) => (cut ? LD[m] : m < K - 1 ? LD[K - 1 - m] : LD[m - (K - 1)]);
      const pos = new Float32Array(nx * cols * 3), nrm = new Float32Array(nx * cols * 3), col = new Float32Array(nx * cols * 4);
      for (let j = 0; j < nx; j++) {
        const z = sim.solver.zc(this.cols[j]), xw = (this.xm[j] - L / 2) * s;
        for (let m = 0; m < cols; m++) {
          const o = j * cols + m, d = dep(m);
          pos[o * 3] = xw; pos[o * 3 + 1] = this.Y(z + d); pos[o * 3 + 2] = lat(m) * s * we;
          const t = d / this.hcap;
          const c = d < 1e-9 ? C_BED : d <= this.hcap + 1e-9 ? mix(C_BED, C_BANK, Math.min(1, t * 1.4)) : C_PLAIN;
          const sh = 0.94 + 0.06 * Math.sin(xw * 3.1 + m * 0.7);
          col[o * 4] = c[0] * sh; col[o * 4 + 1] = c[1] * sh; col[o * 4 + 2] = c[2] * sh; col[o * 4 + 3] = 1;
        }
      }
      GLX.gridNormals(pos, nx, cols, nrm);
      this.terrain = r.makeMesh(GLX.gridIndices(nx, cols), nx * cols); this.terrain.set(pos, nrm, col);
      this.terrainCols = cols;

      // earth block under the cut plane
      if (cut) {
        const P = new Float32Array(nx * 2 * 3), N = new Float32Array(nx * 2 * 3), C = new Float32Array(nx * 2 * 4), idx = [];
        const yLow = -0.55;
        for (let j = 0; j < nx; j++) {
          const z = sim.solver.zc(this.cols[j]), xw = (this.xm[j] - L / 2) * s;
          for (let q = 0; q < 2; q++) {
            const o = j * 2 + q;
            P[o * 3] = xw; P[o * 3 + 1] = q === 0 ? yLow : this.Y(z); P[o * 3 + 2] = 0;
            N[o * 3 + 2] = -1;
            const c = q === 0 ? mix(C_EARTH, [0.25, 0.19, 0.14], 0.5) : C_EARTH;
            C[o * 4] = c[0]; C[o * 4 + 1] = c[1]; C[o * 4 + 2] = c[2]; C[o * 4 + 3] = 1;
          }
          if (j < nx - 1) { const a = j * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
        }
        this.earth = r.makeMesh(idx, nx * 2); this.earth.set(P, N, C);
      } else this.earth = null;

      // dam
      if (sim.x0 !== null) {
        const z = sim.solver.zc(Math.round((sim.x0 / L) * (this.N - 1))), W = this.out.W * s * we;
        const top = this.Y(z + sim.vals.hUp * 1.2), bot = this.Y(z) - 0.0;
        const P = new Float32Array(24 * 3), N = new Float32Array(24 * 3), C = new Float32Array(24 * 4);
        putBox(P, N, C, 0, (sim.x0 - L / 2) * s, (top + Math.min(bot, 0)) / 2, cut ? W / 2 : 0, 0.07, top - Math.min(bot, 0), cut ? W : 2 * W, [0.62, 0.62, 0.64]);
        this.dam = r.makeMesh(BOX_IDX(1), 24); this.dam.set(P, N, C);
      } else this.dam = null;

      // chainage ticks (lines on the terrain surface) and their labels
      this.buildTicks(cols, pos);

      // dynamic water meshes
      this.J = cut ? 6 : 11;
      this.svals = Array.from({ length: this.J }, (_, k) => (cut ? k / (this.J - 1) : -1 + (2 * k) / (this.J - 1)));
      const nJ = nx * this.J;
      this.wPos = new Float32Array(nJ * 3); this.wNrm = new Float32Array(nJ * 3); this.wCol = new Float32Array(nJ * 4);
      this.water = r.makeMesh(GLX.gridIndices(nx, this.J), nJ);
      const J2 = cut ? 2 : 3;
      this.J2 = J2; this.gPos = new Float32Array(nx * J2 * 3); this.gNrm = new Float32Array(nx * J2 * 3); this.gCol = new Float32Array(nx * J2 * 4);
      this.ghost = r.makeMesh(GLX.gridIndices(nx, J2), nx * J2);
      this.ghostLines = r.makeLines(); this.gLP = new Float32Array(nx * 3 * 2 * 3 * 2); this.gLC = new Float32Array(nx * 3 * 2 * 4 * 2);
      if (cut) {
        this.cutWater = r.makeMesh((() => { const idx = []; for (let j = 0; j < nx - 1; j++) { const a = j * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); } return idx; })(), nx * 2);
        this.cwPos = new Float32Array(nx * 2 * 3); this.cwNrm = new Float32Array(nx * 2 * 3); this.cwCol = new Float32Array(nx * 2 * 4);
        for (let i = 0; i < nx * 2; i++) this.cwNrm[i * 3 + 2] = -1;
      } else this.cutWater = null;

      // gauges and particles
      this.gauges = sim.gauges || SCEN.PRESETS[sim.key].gauges.map(([name, f, hm]) => ({ name, f, hmark: hm }));
      this.gaugeMesh = r.makeMesh(BOX_IDX(this.gauges.length * 3), this.gauges.length * 3 * 24);
      this.gP = new Float32Array(this.gauges.length * 3 * 24 * 3); this.gN = new Float32Array(this.gauges.length * 3 * 24 * 3); this.gC = new Float32Array(this.gauges.length * 3 * 24 * 4);
      this.partLines = r.makeLines(); this.ppos = new Float32Array(this.NP * 2 * 3); this.pcol = new Float32Array(this.NP * 2 * 4);
      this.last = null;
    }

    buildTicks(cols, tpos) {
      const nx = this.nx, lines = [], labels = [];
      const edge = (j, m) => (j * cols + m) * 3;
      for (let k = 0; k <= 5; k++) {
        const j = Math.round((k / 5) * (nx - 1));
        for (let m = 0; m < cols - 1; m++) {
          const a = edge(j, m), b = edge(j, m + 1);
          lines.push([tpos[a], tpos[a + 1] + 0.004, tpos[a + 2]], [tpos[b], tpos[b + 1] + 0.004, tpos[b + 2]]);
        }
        const e = edge(j, cols - 1);
        labels.push({ p: [tpos[e], tpos[e + 1] + 0.05, tpos[e + 2]], text: this.L >= 5000 ? ((this.xm[j] / 1000).toFixed(1) + " km") : (this.xm[j].toFixed(0) + " m") });
      }
      const P = new Float32Array(lines.length * 3), C = new Float32Array(lines.length * 4);
      lines.forEach((p, i) => { P.set(p, i * 3); C.set([1, 1, 1, 0.38], i * 4); });
      this.tickLines = this.r.makeLines(); this.tickLines.set(P, C, lines.length);
      this.tickLabels = labels;
    }

    /* ---------------------------------------------------------------- particles */
    initParticles() {
      this.px = new Float32Array(this.NP); this.pf = new Float32Array(this.NP);
      for (let i = 0; i < this.NP; i++) { this.px[i] = -1; this.pf[i] = (Math.random() * 2 - 1) * 0.9; }
      this.pseeded = false;
    }

    /* ------------------------------------------------------------- per-frame update */
    update(snap, st) {
      const sim = this.sim, sec = this.sec, s = this.s, ve = this.ve, we = this.we, L = this.L, nx = this.nx, J = this.J, eps = sim.solver.eps;
      const A = snap.A, Q = snap.Q, hs = new Float64Array(nx), us = new Float64Array(nx), es = new Float64Array(nx);
      let umax = 1e-6, front = -1;
      for (let j = 0; j < nx; j++) {
        const c = this.cols[j], h = sec.depth(A[c]), wet = h > eps;
        hs[j] = wet ? h : 0; us[j] = wet ? Q[c] / A[c] : 0; es[j] = sim.solver.zc(c) + hs[j];
        if (wet) { umax = Math.max(umax, Math.abs(us[j])); front = j; }
      }
      this.umax = umax;
      const layer = st.layer, hmax = sim.hmax;
      const cc = new Array(nx);
      for (let j = 0; j < nx; j++) {
        const h = hs[j], u = us[j];
        const c = layerColor(layer, sec, h, u, hmax, this.vscale);
        // foam on steep, fast fronts (bores)
        const hl = hs[Math.max(j - 1, 0)], hr = hs[Math.min(j + 1, nx - 1)];
        const jump = h > 0 ? Math.abs(hr - hl) / h : (hl + hr > 0 ? 1 : 0), fr = h > 0 ? Math.abs(u) / sec.celerity(h) : 0;
        const foam = layer === "depth" && fr > 0.7 ? clamp((jump - 0.25) / 0.6, 0, 0.9) : 0;
        cc[j] = mix(c, [0.96, 0.98, 1], foam);
      }
      const wP = this.wPos, wN = this.wNrm, wC = this.wCol;
      for (let j = 0; j < nx; j++) {
        const h = hs[j], wet = h > 0, W = wet ? sec.width(h) / 2 : 0, xw = (this.xm[j] - L / 2) * s, yw = this.Y(es[j]);
        const j0 = Math.max(j - 1, 0), j1 = Math.min(j + 1, nx - 1);
        const slope = (es[j1] - es[j0]) / Math.max(this.xm[j1] - this.xm[j0], 1e-9) * ve;
        const nl = Math.hypot(slope, 1);
        for (let k = 0; k < J; k++) {
          const o = j * J + k, sv = this.svals[k];
          wP[o * 3] = xw; wP[o * 3 + 1] = yw; wP[o * 3 + 2] = W * sv * s * we;
          wN[o * 3] = -slope / nl; wN[o * 3 + 1] = 1 / nl; wN[o * 3 + 2] = 0;
          const edge = Math.abs(sv) > 0.999;
          wC[o * 4] = cc[j][0]; wC[o * 4 + 1] = cc[j][1]; wC[o * 4 + 2] = cc[j][2];
          wC[o * 4 + 3] = wet ? (edge ? 0.5 : 0.86) : 0;
        }
      }
      this.water.set(wP, wN, wC);
      if (this.cutWater) {
        for (let j = 0; j < nx; j++) {
          const xw = (this.xm[j] - L / 2) * s, wet = hs[j] > 0;
          for (let q = 0; q < 2; q++) {
            const o = j * 2 + q;
            this.cwPos[o * 3] = xw; this.cwPos[o * 3 + 1] = q === 0 ? this.Y(sim.solver.zc(this.cols[j])) : this.Y(es[j]); this.cwPos[o * 3 + 2] = 0;
            this.cwCol[o * 4] = cc[j][0] * 0.9; this.cwCol[o * 4 + 1] = cc[j][1] * 0.9; this.cwCol[o * 4 + 2] = cc[j][2] * 0.95; this.cwCol[o * 4 + 3] = wet ? 0.8 : 0;
          }
        }
        this.cutWater.set(this.cwPos, this.cwNrm, this.cwCol);
      }

      this.updateGhost(snap, st);
      this.updateGauges(hs, st);
      this.updateParticles(snap, st, hs, us, es);
      this.dam && (this.dam.visible = snap.t < 1e-9);
      this.frontX = front >= 0 ? (this.xm[front] - L / 2) * s : 0;
      if (st.follow) this.cam.target[0] += (this.frontX - this.cam.target[0]) * 0.1;
    }

    updateGhost(snap, st) {
      const show = !!st.ghostFn && snap.t > 1e-9;
      this.ghost.visible = show; this.ghostLines.visible = show;
      if (!show) return;
      const sec = this.sec, s = this.s, we = this.we, nx = this.nx, J2 = this.J2, L = this.L, cut = this.cut;
      const sv = cut ? [0, 1] : [-1, 0, 1];
      let nl = 0;
      const hx = new Float64Array(nx);
      for (let j = 0; j < nx; j++) {
        const h = st.ghostFn(this.xm[j], snap.t); hx[j] = h > this.sim.solver.eps ? h : 0;
        const wet = hx[j] > 0, W = wet ? sec.width(hx[j]) / 2 : 0, xw = (this.xm[j] - L / 2) * s;
        const y = this.Y(this.sim.solver.zc(this.cols[j]) + hx[j]) + 0.006;
        for (let k = 0; k < J2; k++) {
          const o = j * J2 + k;
          this.gPos[o * 3] = xw; this.gPos[o * 3 + 1] = y; this.gPos[o * 3 + 2] = W * sv[k] * s * we;
          this.gNrm[o * 3 + 1] = 1;
          this.gCol[o * 4] = 0.93; this.gCol[o * 4 + 1] = 0.2; this.gCol[o * 4 + 2] = 0.55; this.gCol[o * 4 + 3] = wet ? 0.1 : 0;
        }
      }
      this.ghost.set(this.gPos, this.gNrm, this.gCol);
      for (let j = 0; j < nx - 1; j++) {
        if (hx[j] <= 0 || hx[j + 1] <= 0) continue;
        for (let k = 0; k < J2; k++) {
          if (!cut && k === 1) continue;
          for (let e = 0; e < 2; e++) {
            const o = (j + e) * J2 + k, q = nl * 3, cq = nl * 4;
            this.gLP[q] = this.gPos[o * 3]; this.gLP[q + 1] = this.gPos[o * 3 + 1] + 0.004; this.gLP[q + 2] = this.gPos[o * 3 + 2];
            this.gLC[cq] = 0.95; this.gLC[cq + 1] = 0.15; this.gLC[cq + 2] = 0.5; this.gLC[cq + 3] = 1;
            nl++;
          }
        }
      }
      this.ghostLines.set(this.gLP, this.gLC, nl);
    }

    updateGauges(hs, st) {
      const sim = this.sim, s = this.s, L = this.L, n = this.gauges.length;
      const P = this.gP, N = this.gN, C = this.gC;
      this.gaugePoints = [];
      for (let g = 0; g < n; g++) {
        const gg = this.gauges[g], x = gg.f * L, c = clamp(Math.round((x / L) * (this.N - 1)), 0, this.N - 1);
        const j = clamp(Math.round((x / L) * (this.nx - 1)), 0, this.nx - 1);
        const z = sim.solver.zc(c), xw = (x - L / 2) * s, y0 = this.Y(z), y1 = this.Y(z + this.hcap), ym = this.Y(z + gg.hmark);
        const state = !st.showGauges ? 0 : (st.gaugeState ? st.gaugeState[g] : 0);
        const flag = state === 2 ? [0.9, 0.12, 0.12] : state === 1 ? [0.97, 0.72, 0.15] : [0.2, 0.7, 0.3];
        putBox(P, N, C, g * 3, xw, (y0 + y1) / 2, 0, 0.04, y1 - y0, 0.04, [0.92, 0.92, 0.9]);
        putBox(P, N, C, g * 3 + 1, xw + 0.15, ym, 0, 0.3, 0.1, 0.05, flag);
        putBox(P, N, C, g * 3 + 2, xw, y0, 0, 0.14, 0.03, 0.14, [0.3, 0.3, 0.3]);
        this.gaugePoints.push({ p: [xw, y1 + 0.12, 0], name: gg.name });
      }
      this.gaugeMesh.set(P, N, C);
      this.gaugeMesh.visible = !!st.showGauges;
    }

    updateParticles(snap, st, hs, us, es) {
      this.partLines.visible = !!st.particles;
      if (!st.particles) return;
      const nx = this.nx, L = this.L, s = this.s, we = this.we, sec = this.sec, dt = st.dtSim || 0;
      const x0 = this.xm[0], dxd = (this.xm[nx - 1] - x0) / (nx - 1);
      const wetIdx = []; for (let j = 0; j < nx; j++) if (hs[j] > 0) wetIdx.push(j);
      if (!wetIdx.length) { this.partLines.set(this.ppos, this.pcol, 0); return; }
      const sample = (arr, x) => { const f = clamp((x - x0) / dxd, 0, nx - 1), i = Math.min(Math.floor(f), nx - 2), w = f - i; return arr[i] * (1 - w) + arr[i + 1] * w; };
      let n = 0;
      const streak = 0.04 * L;
      for (let i = 0; i < this.NP; i++) {
        let x = this.px[i];
        const f = clamp((x - x0) / dxd, 0, nx - 1), jj = Math.round(f);
        if (x < 0 || hs[jj] <= 0 || !this.pseeded) {
          const j = wetIdx[(Math.random() * wetIdx.length) | 0]; x = this.xm[j] + (Math.random() - 0.5) * dxd; this.pf[i] = (Math.random() * 2 - 1) * 0.9;
        } else x += sample(us, x) * dt;
        if (x < this.xm[0] || x > this.xm[nx - 1]) x = -1;
        this.px[i] = x;
        if (x < 0) continue;
        const u = sample(us, x), h = sample(hs, x), e = sample(es, x), W = sec.width(h) / 2 * this.pf[i];
        const len = clamp(Math.abs(u) / this.umax, 0, 1) * streak, dir = u >= 0 ? 1 : -1;
        const o = n * 2;
        for (let q = 0; q < 2; q++) {
          const xx = x - dir * len * q;
          this.ppos[(o + q) * 3] = (xx - L / 2) * s; this.ppos[(o + q) * 3 + 1] = this.Y(e) + 0.012; this.ppos[(o + q) * 3 + 2] = W * s * we;
          this.pcol[(o + q) * 4] = 1; this.pcol[(o + q) * 4 + 1] = 1; this.pcol[(o + q) * 4 + 2] = 1; this.pcol[(o + q) * 4 + 3] = q === 0 ? 0.9 : 0;
        }
        n++;
      }
      this.pseeded = true;
      this.partLines.set(this.ppos, this.pcol, n * 2);
    }

    /* -------------------------------------------------------------------- draw */
    draw(st) {
      const r = this.r;
      r.theme.fogD = 0.012;
      r.begin(this.cam);
      r.drawMesh(this.terrain, { amb: 0.42 });
      if (this.earth) r.drawMesh(this.earth, { amb: 0.5 });
      if (this.dam) r.drawMesh(this.dam, { amb: 0.5 });
      if (this.gaugeMesh) r.drawMesh(this.gaugeMesh, { amb: 0.55 });
      if (st.ticks) r.drawLines(this.tickLines);
      r.drawMesh(this.water, { blend: true, spec: 0.55, amb: 0.5 });
      if (this.cutWater) r.drawMesh(this.cutWater, { blend: true, amb: 0.6 });
      r.drawMesh(this.ghost, { blend: true, amb: 0.9 });
      r.drawLines(this.ghostLines);
      r.drawLines(this.partLines);
      // labels
      const out = [];
      if (st.ticks) for (const t of this.tickLabels) { const q = r.project(t.p); if (q) out.push({ x: q[0], y: q[1], text: t.text, cls: "tick" }); }
      if (st.showGauges) for (const g of this.gaugePoints || []) { const q = r.project(g.p); if (q) out.push({ x: q[0], y: q[1], text: g.name, cls: "gauge" }); }
      return out;
    }
  }

  function EXkappaOmega(v) { const kappa = v.hUp / ((v.L / 4) * (v.L / 4)); return Math.sqrt(2 * G * kappa); }

  /* ========================================================================= SpaceTime */
  class SpaceTime {
    constructor(renderer) { this.r = renderer; this.cam = new GLX.OrbitCamera(); this.mesh = null; this.lines = renderer.makeLines(); this.axes = renderer.makeLines(); this.labels = []; }

    resetCamera() { this.cam.set(Math.PI - 0.75, 0.55, 17, [0, 0.8, 0]); }

    /* hist: array of {t, A, Q}; upTo: last frame to include */
    build(sim, hist, upTo, exactInfo) {
      const r = this.r, sec = sim.sec, L = sim.vals.L, N = sim.solver.N;
      const nxs = Math.min(N, 160), nts = Math.max(2, Math.min(upTo + 1, 160));
      const hscale = sim.hmax * 1.05, XW = 10, TW = 6, HW = 2.6;
      const pos = new Float32Array(nxs * nts * 3), nrm = new Float32Array(nxs * nts * 3), col = new Float32Array(nxs * nts * 4);
      for (let k = 0; k < nts; k++) {
        const f = hist[Math.min(Math.round((k * Math.max(upTo, 1)) / (nts - 1)), upTo)];
        for (let j = 0; j < nxs; j++) {
          const c = Math.round((j * (N - 1)) / (nxs - 1)), h = sec.depth(f.A[c]) > sim.solver.eps ? sec.depth(f.A[c]) : 0;
          const o = k * nxs + j;
          pos[o * 3] = ((sim.solver.xc(c)) / L - 0.5) * XW; pos[o * 3 + 1] = (h / hscale) * HW; pos[o * 3 + 2] = (f.t / sim.tmax) * TW - TW / 2;
          const cl = ramp(h / hscale); col[o * 4] = cl[0]; col[o * 4 + 1] = cl[1]; col[o * 4 + 2] = cl[2]; col[o * 4 + 3] = 1;
        }
      }
      // grid is (time rows) x (space columns); GLX.gridNormals expects j along x, k along z -> swap roles
      const tp = new Float32Array(pos.length), tn = new Float32Array(pos.length), tc = new Float32Array(col.length);
      for (let k = 0; k < nts; k++) for (let j = 0; j < nxs; j++) {
        const a = k * nxs + j, b = j * nts + k;
        tp.set(pos.subarray(a * 3, a * 3 + 3), b * 3); tc.set(col.subarray(a * 4, a * 4 + 4), b * 4);
      }
      GLX.gridNormals(tp, nxs, nts, tn);
      if (this.mesh) this.mesh.dispose();
      this.mesh = r.makeMesh(GLX.gridIndices(nxs, nts), nxs * nts); this.mesh.set(tp, tn, tc);

      // axes box + ticks + characteristic lines on the floor
      const segs = [], cols = [];
      const seg = (a, b, c) => { segs.push(a, b); cols.push(c, c); };
      const g = [0.35, 0.4, 0.5, 0.55], X0 = -XW / 2, X1 = XW / 2, T0 = -TW / 2, T1 = TW / 2;
      seg([X0, 0, T0], [X1, 0, T0], g); seg([X0, 0, T1], [X1, 0, T1], g); seg([X0, 0, T0], [X0, 0, T1], g); seg([X1, 0, T0], [X1, 0, T1], g);
      seg([X0, 0, T0], [X0, HW, T0], g); seg([X0, 0, T1], [X0, HW, T1], g);
      for (let i = 1; i < 5; i++) { seg([X0 + (XW * i) / 5, 0, T0], [X0 + (XW * i) / 5, 0, T1], [0.5, 0.55, 0.65, 0.25]); seg([X0, 0, T0 + (TW * i) / 5], [X1, 0, T0 + (TW * i) / 5], [0.5, 0.55, 0.65, 0.25]); }
      const labels = [];
      for (let i = 0; i <= 5; i++) {
        labels.push({ p: [X0 + (XW * i) / 5, 0, T0 - 0.2], text: L >= 5000 ? ((L * i) / 5000).toFixed(0) + " km" : ((L * i) / 5).toFixed(0) + " m" });
        labels.push({ p: [X1 + 0.15, 0, T0 + (TW * i) / 5], text: fmtTime((sim.tmax * i) / 5) });
      }
      labels.push({ p: [0, 0, T0 - 1.25], text: "distance along reach", cls: "axis" });
      labels.push({ p: [X1 + 1.5, 0, 0], text: "time", cls: "axis" });
      labels.push({ p: [X0, HW + 0.2, T0], text: "depth (peak scale " + hscale.toFixed(1) + " m)", cls: "axis" });
      // exact wave lines (flat dam break): rarefaction tail, fan head, front
      const tNow = hist[upTo].t;
      if (exactInfo) {
        for (const ln of exactInfo.lines(tNow)) {
          const z = (t) => (t / sim.tmax) * TW - TW / 2, xw = (x) => (x / L - 0.5) * XW;
          const pts = 40;
          for (let q = 0; q < pts; q++) {
            const t0 = (tNow * q) / pts, t1 = (tNow * (q + 1)) / pts;
            const xa = ln.x(t0), xb = ln.x(t1);
            if (xa < 0 || xa > L || xb < 0 || xb > L) continue;
            seg([xw(xa), 0.01, z(t0)], [xw(xb), 0.01, z(t1)], [0.93, 0.2, 0.55, 1]);
          }
        }
      }
      const P = new Float32Array(segs.length * 3), C = new Float32Array(segs.length * 4);
      segs.forEach((p, i) => { P.set(p, i * 3); C.set(cols[i].length === 3 ? [...cols[i], 1] : cols[i], i * 4); });
      this.axes.set(P, C, segs.length);
      this.labels = labels; this.upTo = upTo;
    }

    draw() {
      const r = this.r; r.theme.fogD = 0.004;
      r.begin(this.cam);
      if (this.mesh) r.drawMesh(this.mesh, { amb: 0.5, spec: 0.1 });
      r.drawLines(this.axes);
      return this.labels.map((l) => { const q = r.project(l.p); return q ? { x: q[0], y: q[1], text: l.text, cls: l.cls || "tick" } : null; }).filter(Boolean);
    }
  }

  function fmtTime(t) { return t >= 7200 ? (t / 3600).toFixed(1) + " h" : t >= 600 ? (t / 60).toFixed(1) + " min" : t.toFixed(1) + " s"; }

  /* exact wave lines x(t) for flat, frictionless dam breaks (drawn on the floor of the space-time view) */
  function exactLines(sim) {
    const v = sim.vals;
    if (!SCEN.analyticalAvailable(sim.key, sim.type, v)) return null;
    const sec = sim.sec;
    if (sim.kind === "bowl") {
      const kappa = v.hUp / ((v.L / 4) ** 2), omega = Math.sqrt(2 * G * kappa), half = Math.sqrt(v.hUp / kappa);
      const X = (t) => sim.X0 * Math.cos(omega * t);
      return { lines: () => [{ x: (t) => v.L / 2 + X(t) - half }, { x: (t) => v.L / 2 + X(t) + half }] };
    }
    const x0 = sim.x0, c0 = sec.celerity(v.hUp);
    if (v.hDown <= 0) {
      const F0 = sec.F(v.hUp);
      return { lines: () => [{ x: (t) => x0 - c0 * t }, { x: (t) => x0 + F0 * t }] };
    }
    const EXm = new EXACT.DamBreak(sec, v.hUp, v.hDown);
    return { lines: () => [{ x: (t) => x0 - c0 * t }, { x: (t) => x0 + (EXm.um - EXm.cm) * t }, { x: (t) => x0 + EXm.S * t }] };
  }

  /* legends for the colour layers: [{color:[r,g,b], label}] */
  function legend(layer, sim) {
    const css = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
    if (layer === "hazard") return { title: "Hazard: depth × velocity (m²/s), illustrative bands", items: HAZARD.map(([, c, l]) => ({ color: css(c), label: l })) };
    if (layer === "velocity") return { title: "Velocity", gradient: [0, 0.25, 0.5, 0.75, 1].map((t) => css(hsl(240 - 240 * t, 0.75, 0.5))), a: "0", b: "fast" };
    if (layer === "froude") return { title: "Froude number", gradient: [0, 0.25, 0.5, 0.75, 1].map((t) => css(hsl(240 - 240 * t, 0.75, 0.5))), a: "0", b: "2+  (red = supercritical)" };
    return { title: "Water depth", gradient: [css(C_SHALLOW), css(C_DEEP)], a: "shallow", b: "deep" };
  }

  return { Scene3D, SpaceTime, exactLines, legend, layerColor, fmtTime, LW };
});
