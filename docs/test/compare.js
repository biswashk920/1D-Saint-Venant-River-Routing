// Checks that the JS port reproduces the Python reference results.  Run: node web/test/compare.js
const fs = require("fs"), path = require("path");
const SEC = require("../section.js"), SV = require("../solver.js"), EX = require("../exact.js");
const ref = JSON.parse(fs.readFileSync(path.join(__dirname, "reference.json"), "utf8"));
let failed = false;
function report(name, err, tol) {
  const ok = err < tol; if (!ok) failed = true;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: max relative diff = ${err.toExponential(2)} (tol ${tol})`);
}
// largest difference, relative to the field's magnitude (floor 1)
const maxDiff = (a, b) => {
  let m = 0, s = 1;
  for (let i = 0; i < b.length; i++) { m = Math.max(m, Math.abs(a[i] - b[i])); s = Math.max(s, Math.abs(b[i])); }
  return m / s;
};

// sections
for (const [name, c] of Object.entries(ref.sections)) {
  const s = SEC.fromSpec(c.spec);
  const get = (f) => c.h.map((h) => f(h));
  let e = 0;
  e = Math.max(e, maxDiff(get((h) => s.area(h)), c.A), maxDiff(get((h) => s.width(h)), c.B),
    maxDiff(get((h) => s.I1(h)), c.I1), maxDiff(get((h) => s.perimeter(h)), c.P),
    maxDiff(get((h) => s.F(h)), c.F), maxDiff(c.A.map((A) => s.depth(A)), c.depth),
    maxDiff(get((h) => s.celerity(h)), c.c));
  report(`section ${name} (A,B,I1,P,F,depth,c)`, e, 1e-9);
}

// dam-break / slope / friction
for (const [name, c] of Object.entries(ref.dam)) {
  const p = c.params;
  const s = SV.damBreak({ section: SEC.fromSpec(c.spec), N: p.N, L: p.L, x0: p.x0, hUp: p.h_up, hDown: p.h_down,
    slope: p.slope || 0, n: p.n || 0 });
  s.advanceTo(p.t);
  const A = Array.from(s.A.slice(SV.NG, SV.NG + p.N)), Q = Array.from(s.Q.slice(SV.NG, SV.NG + p.N));
  report(`dam ${name} (A, Q)`, Math.max(maxDiff(A, c.A), maxDiff(Q, c.Q)), 1e-7);
}

// flood routing with inflow hydrograph
{
  const c = ref.route.trap_hydrograph, p = c.params, sec = SEC.fromSpec(c.spec);
  const Qb = sec.manningQ(p.hb, p.S0, p.n), Qp = sec.manningQ(p.hp, p.S0, p.n);
  const s = new SV.Solver({ section: sec, N: p.N, L: p.L, z: (x) => -p.S0 * x, h0: () => p.hb, Q0: () => Qb,
    n: p.n, bcUp: "flow", bcDown: "open", qIn: (t) => Qb + (Qp - Qb) * Math.exp(-(((t - p.tp) / p.w) ** 2)) });
  s.advanceTo(p.t);
  report("route trap_hydrograph (A, Q)", Math.max(maxDiff(Array.from(s.A.slice(2, 2 + p.N)), c.A),
    maxDiff(Array.from(s.Q.slice(2, 2 + p.N)), c.Q)), 1e-7);
}

// Thacker oscillating lake: solver vs Python solver, and exact solution
{
  const c = ref.thacker.bowl, p = c.params, { kappa } = EX.thackerParams(p.h_max, p.L);
  const s = new SV.Solver({ section: SEC.fromSpec(c.spec), N: p.N, L: p.L, z: (x) => kappa * (x - p.L / 2) ** 2,
    h0: (x) => Math.max(p.h_max - kappa * (x - p.L / 2 - p.X0) ** 2, 0), bcUp: "wall", bcDown: "wall" });
  s.advanceTo(p.t);
  report("thacker bowl (A, Q)", Math.max(maxDiff(Array.from(s.A.slice(2, 2 + p.N)), c.A),
    maxDiff(Array.from(s.Q.slice(2, 2 + p.N)), c.Q)), 1e-7);
  const he = Array.from({ length: p.N }, (_, i) => EX.thackerDepth(s.xc(i), p.t, p.h_max, p.L, p.X0));
  report("thacker exact (JS vs Python)", maxDiff(he, c.h_exact), 1e-12);
}

// exact dam-break solutions
for (const [name, c] of Object.entries(ref.exact)) {
  const sec = SEC.fromSpec(c.spec), ex = new EX.DamBreak(sec, c.h0, c.hd);
  report(`exact ${name}`, maxDiff(c.xs.map((x) => ex.depth(x, c.t, c.x0)), c.h), 1e-6);
}
process.exit(failed ? 1 : 0);
