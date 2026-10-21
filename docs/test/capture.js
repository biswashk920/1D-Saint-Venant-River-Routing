// Captures frames of the 3D view for the README animation.
//   node web/test/capture.js <outDir> [scenario] [section] [frames]
const http = require("http"), fs = require("fs"), path = require("path");
let pw; try { pw = require("playwright"); } catch (e) { pw = require(process.env.PLAYWRIGHT_MODULE || "playwright"); }
const WEB = path.join(__dirname, ".."), out = path.resolve(process.argv[2] || "frames");
const scen = process.argv[3] || "wet", sect = process.argv[4] || "trap", n = parseInt(process.argv[5] || "40", 10);
fs.mkdirSync(out, { recursive: true });
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
(async () => {
  const srv = http.createServer((req, res) => {
    let p = req.url.split("?")[0].split("#")[0]; if (p === "/") p = "/index.html";
    const f = path.join(WEB, p); if (!fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "text/plain" }); fs.createReadStream(f).pipe(res);
  }).listen(0, "127.0.0.1");
  await new Promise((r) => srv.on("listening", r));
  const browser = await pw.chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1360, height: 1000 } })).newPage();
  await page.goto(`http://127.0.0.1:${srv.address().port}/`); await page.waitForFunction(() => window.__sv);
  await page.evaluate(([s, t]) => { __sv.setTab("3d"); __sv.setScenario(s, { type: t }); }, [scen, sect]);
  for (let i = 0; i < n; i++) {
    const frac = 0.03 + (0.62 * i) / (n - 1);
    await page.evaluate((f) => __sv.runTo(f, 70), frac);
    await page.locator(".glwrap").screenshot({ path: path.join(out, `f${String(i).padStart(3, "0")}.png`) });
  }
  await browser.close(); srv.close(); console.log(`wrote ${n} frames to ${out}`);
})();
