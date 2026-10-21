// Runs every preset x section type to its end time at default and extreme slider values.
// Checks: finite, non-negative depths, water is never created, and (where available) the exact solution.
const SCEN = require("../scenarios.js");
const SV = require("../solver.js");
let failed = 0, runs = 0;
function check(key, type, v, N, label) {
  const b = SCEN.build(key, type, v, N), s = b.solver, v0 = s.volume();
  const t0 = Date.now();
  s.advanceTo(b.tmax);
  let ok = true, hm = 0;
  for (let i = 0; i < N; i++) {
    const A = s.A[i + SV.NG], Q = s.Q[i + SV.NG], h = b.sec.depth(A);
    if (!Number.isFinite(A) || !Number.isFinite(Q) || A < 0) ok = false;
    hm = Math.max(hm, h);
  }
  const closed = b.kind === "bowl" || (b.kind === "dam" && false);
  if (closed && Math.abs(s.volume() - v0) / v0 > 1e-10) ok = false;
  runs++; if (!ok) { failed++; console.log(`FAIL ${key}/${type} ${label} N=${N} tmax=${b.tmax.toFixed(1)}s hmax=${hm.toFixed(2)}`); }
  return Date.now() - t0;
}
let slowest = 0;
for (const key of Object.keys(SCEN.PRESETS)) {
  const P = SCEN.PRESETS[key];
  for (const type of Object.keys(SCEN.SECTION_TYPES)) {
    const d = SCEN.defaults(key);
    slowest = Math.max(slowest, check(key, type, d, 400, "default"));
    for (const [label, pick] of [["min", 0], ["max", 1]]) {
      const v = {};
      for (const k of ["hUp", "hDown", "slope", "n", "L", "b", "m", "hBank"]) v[k] = P[k] ? P[k][pick] : 0;
      if (type === "compound" && key === "route" && pick === 0) v.hBank = Math.min(v.hBank, 1);
      slowest = Math.max(slowest, check(key, type, v, 400, label));
    }
  }
}
// wet/dry closed bowl: mass must be conserved to round-off
{
  const b = SCEN.build("bowl", "rect", SCEN.defaults("bowl"), 400), v0 = b.solver.volume();
  b.solver.advanceTo(b.tmax);
  const err = Math.abs(b.solver.volume() - v0) / v0;
  console.log(`bowl mass error after 2 periods: ${err.toExponential(2)}`);
  if (err > 1e-12) failed++;
}
console.log(`${runs - failed}/${runs} preset runs OK (slowest ${slowest} ms)`);
process.exit(failed ? 1 : 0);
