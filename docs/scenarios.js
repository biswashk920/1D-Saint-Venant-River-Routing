/* Scenario presets and builders for the demo. DOM-free so it can be tested in Node. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./section.js"), require("./solver.js"), require("./exact.js"));
  else root.SCEN = factory(root.SEC, root.SV, root.EXACT);
})(typeof self !== "undefined" ? self : this, function (SEC, SV, EX) {
  "use strict";
  const G = SV.G;

  /* slider spec: [min, max, step, default]; null = not used by this preset */
  const COMMON = { b: [2, 120, 1, 20], m: [0.5, 6, 0.1, 2] };
  const PRESETS = {
    dry: {
      label: "Dam break, dry bed", kind: "dam", damFrac: 0.5, flatten: false, section: "rect",
      blurb: "A pool released onto a dry bed. Exact solution: Ritter (1892), generalised to any cross-section.",
      hUp: [0.2, 5, 0.1, 1], hDown: null, slope: [0, 0.02, 0.001, 0], n: [0, 0.05, 0.005, 0], L: [50, 500, 10, 100],
      b: [2, 60, 1, 20], m: COMMON.m, hBank: [0.2, 3, 0.1, 0.5],
      gauges: [["Gauge A", 0.62, 0.25], ["Gauge B", 0.75, 0.15], ["Gauge C", 0.88, 0.2]],
    },
    wet: {
      label: "Dam break, wet bed", kind: "dam", damFrac: 0.5, flatten: false, section: "rect",
      blurb: "A pool released onto a shallow tailwater: a rarefaction fan followed by a bore. Exact solution: Stoker (1957), generalised to any cross-section.",
      hUp: [0.2, 5, 0.1, 1], hDown: [0.05, 2, 0.05, 0.2], slope: [0, 0.02, 0.001, 0], n: [0, 0.05, 0.005, 0], L: [50, 500, 10, 100],
      b: [2, 60, 1, 20], m: COMMON.m, hBank: [0.2, 3, 0.1, 0.5],
      gauges: [["Gauge A", 0.62, 0.35], ["Gauge B", 0.75, 0.45], ["Gauge C", 0.88, 0.6]],
    },
    route: {
      label: "Flood routing", kind: "route", flatten: true, section: "trap",
      blurb: "A flood hydrograph enters a sloping river reach flowing at its base-flow normal depth. Depths are Manning normal depths of the base and peak flows.",
      hUp: [1, 6, 0.1, 3.5], hDown: [0.5, 3, 0.1, 1.5], slope: [0.0002, 0.005, 0.0001, 0.001], n: [0.01, 0.08, 0.005, 0.03], L: [5000, 50000, 1000, 20000],
      b: [5, 120, 1, 40], m: COMMON.m, hBank: [1, 5, 0.1, 3],
      gauges: [["Village", 0.35, 2.2], ["Bridge", 0.6, 2.5], ["Town", 0.85, 2.1]],
    },
    glof: {
      label: "GLOF / landslide-dam failure", kind: "dam", damFrac: 0.2, flatten: false, section: "vee",
      blurb: "Instantaneous failure of a dam holding a lake, released into a steep, rough valley. (Real breaches grow over time; this is the worst-case instantaneous limit.)",
      hUp: [5, 60, 1, 30], hDown: [0.1, 5, 0.1, 0.5], slope: [0.005, 0.05, 0.001, 0.02], n: [0.02, 0.1, 0.005, 0.05], L: [2000, 30000, 500, 10000],
      b: [2, 100, 1, 10], m: [0.5, 6, 0.1, 2], hBank: [2, 30, 1, 10],
      gauges: [["Village", 0.4, 8], ["Bridge", 0.6, 13], ["Town", 0.85, 10]],
    },
    bowl: {
      label: "Oscillating lake (Thacker)", kind: "bowl", flatten: false, section: "rect",
      blurb: "A lake sloshing in a parabolic bowl, with a moving shoreline. Exact solution: Thacker (1981). Friction damps it, so the exact curve only applies at n = 0.",
      hUp: [0.2, 5, 0.1, 1], hDown: null, slope: null, n: [0, 0.05, 0.005, 0], L: [50, 500, 10, 100],
      b: [2, 60, 1, 20], m: COMMON.m, hBank: [0.2, 3, 0.1, 0.5],
      gauges: [["Gauge A", 0.35, 0.2], ["Gauge B", 0.5, 0.5], ["Gauge C", 0.65, 0.2]],
    },
  };

  const SECTION_TYPES = { rect: "Rectangular", trap: "Trapezoid", vee: "V-shaped valley", compound: "Compound (channel + floodplain)" };

  function defaults(key) {
    const p = PRESETS[key], out = {};
    for (const k of ["hUp", "hDown", "slope", "n", "L", "b", "m", "hBank"]) out[k] = p[k] ? p[k][3] : 0;
    return out;
  }

  function makeSection(type, v) {
    if (type === "rect") return SEC.rectangular(v.b);
    if (type === "trap") return SEC.trapezoid(v.b, v.m);
    if (type === "vee") return SEC.vee(v.m);
    const top = v.b + 2 * v.m * v.hBank;
    return SEC.compound(v.b, v.m, v.hBank, 4 * top);
  }

  function build(key, type, v, N) {
    const P = PRESETS[key], sec = makeSection(type, v);
    let solver, tmax, x0 = null, hmax, extra = {};
    if (P.kind === "route") {
      const hb = Math.min(v.hDown, v.hUp / 1.05), hp = v.hUp;
      const qb = sec.manningQ(hb, v.slope, v.n), qp = sec.manningQ(hp, v.slope, v.n);
      const d = 1e-4 * hp, ck = (sec.manningQ(hp + d, v.slope, v.n) - sec.manningQ(hp - d, v.slope, v.n)) / (2 * d) / sec.width(hp);
      const travel = v.L / ck, w = 0.12 * travel, tp = 2.5 * w;
      const qIn = (t) => qb + (qp - qb) * Math.exp(-Math.pow((t - tp) / w, 2));
      tmax = tp + 1.15 * travel + 3 * w; hmax = hp;
      solver = new SV.Solver({
        section: sec, N, L: v.L, n: v.n, bcUp: "flow", bcDown: "open", qIn,
        z: (x) => -v.slope * x, h0: () => hb, Q0: () => qb,
      });
      extra = { qb, qp, hb, hp, tp, w };
    } else if (P.kind === "bowl") {
      const { kappa, omega } = EX.thackerParams(v.hUp, v.L), X0 = v.L / 8;
      tmax = (2 * 2 * Math.PI) / omega; hmax = v.hUp;
      solver = new SV.Solver({
        section: sec, N, L: v.L, n: v.n, bcUp: "wall", bcDown: "wall",
        z: (x) => kappa * (x - v.L / 2) ** 2,
        h0: (x) => Math.max(v.hUp - kappa * (x - v.L / 2 - X0) ** 2, 0),
      });
      extra = { X0 };
    } else {
      x0 = P.damFrac * v.L;
      solver = SV.damBreak({
        section: sec, N, L: v.L, x0, hUp: v.hUp, hDown: v.hDown, slope: v.slope, n: v.n,
        bcUp: "wall", bcDown: "open",
      });
      const front = Math.max(sec.F(v.hUp), 1e-6);
      tmax = ((v.L - x0) / front) * (v.slope > 0 || v.n > 0 ? 5 : 1.6);
      hmax = Math.max(v.hUp, v.hDown);
    }
    let zmin = Infinity, zmax = -Infinity, etaTop = -Infinity;
    for (let i = 0; i < N; i++) {
      const z = solver.zc(i), h = sec.depth(solver.A[i + SV.NG]);
      zmin = Math.min(zmin, z); zmax = Math.max(zmax, z);
      etaTop = Math.max(etaTop, z + h, P.kind === "route" ? z + hmax : -Infinity);
    }
    if (P.kind === "bowl") etaTop = Math.max(etaTop, zmin + v.hUp);
    return { solver, sec, tmax, x0, hmax, zmin, zmax, etaTop, kind: P.kind, key, type, vals: v, ...extra };
  }

  /* an exact solution exists for flat, frictionless dam breaks (any section) and the rectangular bowl */
  function analyticalAvailable(key, type, v) {
    const P = PRESETS[key];
    if (P.kind === "dam") return v.slope === 0 && v.n === 0;
    if (P.kind === "bowl") return v.n === 0 && type === "rect";
    return false;
  }

  /* exact depth function (x, t) -> h, or null */
  function exactDepth(sim) {
    const v = sim.vals;
    if (!analyticalAvailable(sim.key, sim.type, v)) return null;
    if (sim.kind === "bowl") return (x, t) => EX.thackerDepth(x, t, v.hUp, v.L, sim.X0);
    const ex = new EX.DamBreak(sim.sec, v.hUp, v.hDown);
    return (x, t) => ex.depth(x, t, sim.x0);
  }

  return { PRESETS, SECTION_TYPES, defaults, build, makeSection, analyticalAvailable, exactDepth };
});
