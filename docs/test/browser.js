// End-to-end test in a Chromium-based browser (Playwright). Run:
//   npm i --no-save playwright && npx playwright install chromium     (once)
//   node web/test/browser.js [--shots <dir>]                           (writes screenshots if --shots given)
const http = require("http"), fs = require("fs"), path = require("path");
let pw;
try { pw = require("playwright"); } catch (e) { pw = require(process.env.PLAYWRIGHT_MODULE || "playwright"); }

const WEB = path.join(__dirname, "..");
const shotsIdx = process.argv.indexOf("--shots");
const SHOTS = shotsIdx > 0 ? path.resolve(process.argv[shotsIdx + 1]) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"} ${msg}`); if (!cond) failures++; };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split("?")[0].split("#")[0]); if (p === "/") p = "/index.html";
      const f = path.join(WEB, p);
      if (!f.startsWith(WEB) || !fs.existsSync(f)) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
    }).listen(0, "127.0.0.1", () => resolve(srv));
  });
}

/* how much is drawn? count distinct coarse colours and the share of non-background pixels in the GL canvas */
const canvasStats = () => {
  const c = document.getElementById("gl"), t = document.createElement("canvas"); t.width = 160; t.height = 100;
  const x = t.getContext("2d"); x.drawImage(c, 0, 0, 160, 100);
  const d = x.getImageData(0, 0, 160, 100).data, seen = new Set(); let mean = 0;
  for (let i = 0; i < d.length; i += 4) { seen.add((d[i] >> 4) * 256 + (d[i + 1] >> 4) * 16 + (d[i + 2] >> 4)); mean += d[i] + d[i + 1] + d[i + 2]; }
  return { colours: seen.size, mean: mean / (d.length / 4) / 3 };
};

(async () => {
  const srv = await serve(), base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await pw.chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push("pageerror: " + e.message));
  await page.goto(base); await page.waitForFunction(() => window.__sv);
  console.log("browser:", await page.evaluate(() => navigator.userAgent));
  const shot = async (name) => {
    if (!SHOTS) return;
    const sel = name.startsWith("profile") ? "#main" : ".glwrap";
    await page.locator(sel).screenshot({ path: path.join(SHOTS, name + ".png") });
  };

  // 1. numerics inside Chromium reproduce the Python reference
  const cmp = await page.evaluate(async () => {
    const ref = await (await fetch("test/reference.json")).json(), out = {};
    const rel = (a, b) => { let m = 0, s = 1; for (let i = 0; i < b.length; i++) { m = Math.max(m, Math.abs(a[i] - b[i])); s = Math.max(s, Math.abs(b[i])); } return m / s; };
    for (const [name, c] of Object.entries(ref.dam)) {
      const p = c.params, s = SV.damBreak({ section: SEC.fromSpec(c.spec), N: p.N, L: p.L, x0: p.x0, hUp: p.h_up, hDown: p.h_down, slope: p.slope || 0, n: p.n || 0 });
      s.advanceTo(p.t); out[name] = Math.max(rel(Array.from(s.A.slice(2, 2 + p.N)), c.A), rel(Array.from(s.Q.slice(2, 2 + p.N)), c.Q));
    }
    return out;
  });
  for (const [n, e] of Object.entries(cmp)) ok(e < 1e-7, `Chromium numerics vs Python reference: ${n} (rel diff ${e.toExponential(1)})`);

  // 2. profile view, every preset
  for (const key of ["dry", "wet", "route", "glof", "bowl"]) {
    await page.evaluate((k) => { __sv.setTab("profile"); __sv.setScenario(k); __sv.runTo(0.55); }, key);
    const info = await page.evaluate(() => __sv.info());
    ok(info.errors.length === 0, `profile ${key}: no JS errors ${info.errors.join(" | ").slice(0, 120)}`);
    if (key === "wet" || key === "route") await shot("profile_" + key);
  }

  // 3. 3D view, every preset x section type
  const glInfo = await page.evaluate(() => { __sv.setTab("3d"); return __sv.info(); });
  ok(!glInfo.glError, `WebGL context created ${glInfo.glError || ""}`);
  const combos = [["dry", "rect", 0.5], ["wet", "trap", 0.55], ["wet", "vee", 0.55], ["wet", "compound", 0.55], ["route", "trap", 0.6], ["route", "compound", 0.6], ["glof", "vee", 0.5], ["bowl", "rect", 0.4]];
  for (const [key, type, frac] of combos) {
    await page.evaluate(([k, t, f]) => { __sv.setTab("3d"); __sv.setScenario(k, { type: t }); __sv.runTo(f); }, [key, type, frac]);
    const st = await page.evaluate(canvasStats), info = await page.evaluate(() => __sv.info());
    ok(info.errors.length === 0 && st.colours > 40 && st.mean > 20 && st.mean < 245, `3D ${key}/${type}: renders (${st.colours} colours, mean ${st.mean.toFixed(0)}) errors=${info.errors.length}`);
    await shot(`3d_${key}_${type}`);
  }

  // 4. layers, cut-away, exaggeration, camera presets
  await page.evaluate(() => { __sv.setScenario("glof", { type: "vee" }); __sv.runTo(0.5); });
  for (const layer of ["velocity", "froude", "hazard"]) {
    await page.evaluate((l) => __sv.setLayer(l), layer);
    const st = await page.evaluate(canvasStats); ok(st.colours > 40, `3D layer ${layer} renders (${st.colours} colours)`);
    await shot(`3d_glof_${layer}`);
  }
  await page.selectOption("#layer", "depth");
  await page.evaluate(() => { __sv.setScenario("wet", { type: "trap" }); __sv.runTo(0.6); });
  await page.check("#cut"); await shot("3d_wet_cut");
  const stCut = await page.evaluate(canvasStats); ok(stCut.colours > 40, `3D cut-away renders (${stCut.colours} colours)`);
  await page.uncheck("#cut");
  await page.evaluate(() => { document.getElementById("ve").value = 70; document.getElementById("ve").dispatchEvent(new Event("input")); });
  ok((await page.evaluate(() => __sv.info().ve)) > 30, "vertical exaggeration slider changes the scene");
  for (const cam of ["side", "top", "front"]) { await page.click(`[data-cam=${cam}]`); }
  ok((await page.evaluate(() => __sv.info().errors.length)) === 0, "camera presets: no errors");
  await page.mouse.move(600, 500); await page.mouse.down(); await page.mouse.move(700, 470, { steps: 5 }); await page.mouse.up();
  await page.mouse.wheel(0, -300);
  ok((await page.evaluate(() => __sv.info().errors.length)) === 0, "orbit drag and wheel zoom: no errors");

  // 5. space-time surface
  for (const [k, t] of [["wet", "rect"], ["dry", "vee"]]) {
    await page.evaluate(([k2, t2]) => { __sv.setScenario(k2, { type: t2 }); __sv.runTo(0.7, 120); __sv.setTab("st"); }, [k, t]);
    const st = await page.evaluate(canvasStats); ok(st.colours > 40, `space-time ${k}/${t} renders (${st.colours} colours)`);
    await shot(`spacetime_${k}_${t}`);
  }

  // 6. gauges report physically sensible values
  await page.evaluate(() => { __sv.setTab("3d"); __sv.setScenario("route"); __sv.runTo(1.0, 160); });
  const g = await page.evaluate(() => __sv.gauges());
  const arrs = g.filter((x) => x.arr !== null).map((x) => x.arr);
  ok(g.every((x) => x.peak > 0) && arrs.length >= 1 && arrs.every((a, i) => i === 0 || a >= arrs[i - 1]) && g[0].peak > g[2].peak,
    `routing gauges: peaks ${g.map((x) => x.peak.toFixed(2)).join(", ")} m (attenuating downstream); arrivals ${g.map((x) => (x.arr === null ? "-" : (x.arr / 60).toFixed(0) + "min")).join(", ")} ordered`);
  await shot("3d_route_trap_gauges");

  // 7. share link round-trip
  await page.evaluate(() => { __sv.setTab("3d"); __sv.setScenario("glof", { type: "vee" }); __sv.setLayer("hazard"); });
  await page.waitForTimeout(500);
  const hash = await page.evaluate(() => location.hash);
  const page2 = await ctx.newPage(); page2.on("pageerror", (e) => logs.push("pageerror2: " + e.message));
  await page2.goto(base + hash); await page2.waitForFunction(() => window.__sv && window.__sv.info().tab === "3d");
  const i2 = await page2.evaluate(() => ({ ...__sv.info(), layer: document.getElementById("layer").value }));
  ok(i2.key === "glof" && i2.type === "vee" && i2.layer === "hazard" && i2.tab === "3d", `share link restores scenario, section, layer, tab (${hash.slice(0, 60)}...)`);
  await page2.close();

  // 8. clip recording
  await page.evaluate(() => { __sv.setScenario("dry", { type: "rect" }); __sv.setTab("3d"); });
  await page.selectOption("#cells", "200"); await page.fill("#speed", "4").catch(() => {});
  await page.evaluate(() => { const s = document.getElementById("speed"); s.value = 4; s.dispatchEvent(new Event("input")); });
  const dl = page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
  await page.click("#record");
  const download = await dl;
  const clip = await page.evaluate(() => __sv.info().clip);
  ok(!!download && clip > 5000, `record clip: downloaded ${download ? download.suggestedFilename() : "nothing"} (${clip} bytes)`);

  // 9. console must be clean
  const bad = logs.filter((l) => !/GPU stall|swiftshader|GL Driver Message|WebGL/i.test(l));
  ok(bad.length === 0, `console clean${bad.length ? ": " + bad.slice(0, 3).join(" || ") : ""}`);
  if (logs.length - bad.length) console.log(`(${logs.length - bad.length} benign software-GL driver messages ignored)`);

  await browser.close(); srv.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL BROWSER TESTS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
