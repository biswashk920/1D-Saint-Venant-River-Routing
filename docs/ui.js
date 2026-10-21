/* Interactive demo: playback, scrubbing, profile view, 3D view wiring, gauges, share links, clip recording. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const G = SV.G, NG = SV.NG;
  const KEYS = ["hUp", "hDown", "slope", "n", "L", "b", "m", "hBank"];
  const LAB = {
    dam: { hUp: "Upstream depth (m)", hDown: "Downstream depth (m)", slope: "Bed slope (m/m)", n: "Manning n (s/m^1/3)", L: "Reach length (m)", b: "Channel width b (m)", m: "Side slope m (H:V)", hBank: "Bank-full depth (m)" },
    route: { hUp: "Peak-flow depth (m)", hDown: "Base-flow depth (m)", slope: "Bed slope (m/m)", n: "Manning n (s/m^1/3)", L: "Reach length (m)", b: "Channel width b (m)", m: "Side slope m (H:V)", hBank: "Bank-full depth (m)" },
    bowl: { hUp: "Lake depth (m)", hDown: "", slope: "", n: "Manning n (s/m^1/3)", L: "Bowl width (m)", b: "Channel width b (m)", m: "Side slope m (H:V)", hBank: "Bank-full depth (m)" },
  };
  const PROBE_COLORS = ["#e8590c", "#2f9e44", "#9c36b5"];
  const MAX_HIST = 4000;

  let key = "dry", type = "rect", vals = {}, sim = null, hist = [], viewIdx = 0, playing = false, probes = [], lastTs = 0;
  let speedMul = 1, N = 400, tab = "profile", exactFn = null, exactInfo = null;
  let renderer = null, scene3 = null, spacetime = null, glError = null, lastDrawT = 0, userGaugeF = null, userEx = null;
  let stDirty = true, stFrame = -1, recorder = null, recChunks = [], recording = false, hashTimer = null, frameNo = 0;
  const errors = [];

  /* ------------------------------------------------------------------ helpers */
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  function fmt(v, step) { const d = step >= 1 ? 0 : Math.min(5, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9))); return Number(v).toFixed(d); }
  const fmtTime = V3D.fmtTime;
  const fmtDist = (x, L) => (L >= 5000 ? (x / 1000).toFixed(1) + " km" : x.toFixed(0) + " m");
  function setupCanvas(c) {
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext("2d"); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }
  const veFromSlider = (v) => Math.pow(10, (v / 100) * Math.log10(200));
  const sliderFromVe = (x) => (Math.log10(Math.max(x, 1)) / Math.log10(200)) * 100;
  const weFromSlider = (v) => Math.pow(10, (v / 100) * Math.log10(60));
  const sliderFromWe = (x) => (Math.log10(Math.max(x, 1)) / Math.log10(60)) * 100;

  /* --------------------------------------------------------------- sliders */
  function relevant(k) {
    if (k === "b") return type !== "vee";
    if (k === "m") return type !== "rect";
    if (k === "hBank") return type === "compound";
    return true;
  }
  function buildSliders() {
    const box = $("sliders"); box.innerHTML = "";
    for (const k of KEYS) {
      const row = document.createElement("div"); row.className = "row"; row.id = "row_" + k;
      row.innerHTML = `<div class="head"><span id="lab_${k}"></span><output id="out_${k}"></output></div><input type="range" id="sl_${k}">`;
      box.appendChild(row);
      $("sl_" + k).addEventListener("input", (e) => {
        vals[k] = parseFloat(e.target.value); $("out_" + k).textContent = fmt(vals[k], parseFloat(e.target.step));
        if (k === "hUp" && SCEN.PRESETS[key].kind !== "route") { /* keep hDown below hUp */ }
        resetSim();
      });
    }
    const sel = $("section");
    for (const [v, label] of Object.entries(SCEN.SECTION_TYPES)) { const o = document.createElement("option"); o.value = v; o.textContent = label; sel.appendChild(o); }
    sel.addEventListener("change", () => { type = sel.value; configureSliders(); resetSim(); });
  }
  function configureSliders() {
    const P = SCEN.PRESETS[key];
    for (const k of KEYS) {
      const spec = P[k], row = $("row_" + k), el = $("sl_" + k);
      const show = !!spec && relevant(k);
      row.hidden = !show;
      if (!show) continue;
      vals[k] = clamp(vals[k], spec[0], spec[1]);
      el.min = spec[0]; el.max = spec[1]; el.step = spec[2]; el.value = vals[k];
      $("lab_" + k).textContent = LAB[P.kind][k];
      $("out_" + k).textContent = fmt(vals[k], spec[2]);
    }
  }

  function setScenario(k, init) {
    init = init || {};
    key = k; const P = SCEN.PRESETS[k];
    type = init.type || P.section;
    vals = SCEN.defaults(k); Object.assign(vals, init.vals || {});
    $("scenario").value = k; $("section").value = type; $("blurb").innerHTML = P.blurb;
    configureSliders();
    $("flatten").checked = init.flat !== undefined ? init.flat : P.flatten;
    probes = []; userGaugeF = init.gauges || null; userEx = init.ex || null;
    resetSim();
  }

  /* ------------------------------------------------------------------ sim control */
  function resetSim() {
    playing = false; $("play").textContent = "Play";
    sim = SCEN.build(key, type, vals, N);
    const P = SCEN.PRESETS[key], sc = vals.hUp / P.hUp[3];
    sim.gauges = P.gauges.map(([name, f, hm], i) => ({ name, f: userGaugeF && userGaugeF[i] !== undefined ? userGaugeF[i] : f, hmark: hm * sc }));
    hist = [sim.solver.snapshot()]; viewIdx = 0; lastDrawT = 0; stDirty = true;
    exactFn = SCEN.exactDepth(sim); exactInfo = V3D.exactLines(sim);
    if (scene3) {
      scene3.cut = $("cut").checked;
      scene3.setup(sim, userEx ? userEx.ve : undefined, userEx ? userEx.we : undefined);
      syncExSliders();
    }
    buildGaugeSliders();
    $("scrub").max = 0; $("scrub").value = 0;
    draw(); scheduleHash();
  }

  function play() {
    if (playing) { playing = false; $("play").textContent = "Play"; return; }
    if (sim.solver.t >= sim.tmax - 1e-9 && viewIdx === hist.length - 1) resetSim();
    if (viewIdx < hist.length - 1) {
      hist = hist.slice(0, viewIdx + 1); sim.solver.restore(hist[viewIdx]); $("scrub").max = hist.length - 1; stDirty = true;
    }
    playing = true; lastTs = 0; $("play").textContent = "Pause";
  }

  function frame(ts) {
    try {
      if (playing) {
        const dtReal = lastTs ? Math.min((ts - lastTs) / 1000, 0.05) : 1 / 60; lastTs = ts;
        const s = sim.solver, target = Math.min(s.t + (sim.tmax / 15) * speedMul * dtReal, sim.tmax);
        s.advanceTo(target, 4000);
        hist.push(s.snapshot()); viewIdx = hist.length - 1;
        $("scrub").max = viewIdx; $("scrub").value = viewIdx; stDirty = true;
        if (s.t >= sim.tmax - 1e-9 || hist.length >= MAX_HIST) {
          playing = false; $("play").textContent = "Replay";
          if (recording) setTimeout(stopRecording, 900);
        }
        draw();
      }
    } catch (e) { errors.push(String(e.stack || e)); console.error(e); playing = false; }
    requestAnimationFrame(frame);
  }

  /* ---------------------------------------------------------------------- drawing */
  function draw() {
    if (!sim) return;
    frameNo++;
    updateStatus();
    const gs = gaugeStats();
    try {
      if (tab === "profile") drawProfile();
      else if (glError) showGlError();
      else if (tab === "3d") draw3D(gs);
      else drawST();
    } catch (e) { errors.push(String(e.stack || e)); console.error(e); }
    drawProbe();
    updateGaugeTable(gs);
  }

  function updateStatus() {
    const s = hist[viewIdx];
    $("tLabel").textContent = `t = ${fmtTime(s.t)} of ${fmtTime(sim.tmax)}   |   ${N} cells, dx = ${(vals.L / N).toPrecision(3)} m   |   ${SCEN.SECTION_TYPES[type]}`;
    let fr = 0;
    for (let i = 0; i < N; i++) {
      const h = sim.sec.depth(s.A[i]);
      if (h > 0.02 * sim.hmax) fr = Math.max(fr, Math.abs(s.Q[i] / s.A[i]) / sim.sec.celerity(h));
    }
    $("frLabel").textContent = `max Froude = ${fr.toFixed(2)}`;
    const avail = SCEN.analyticalAvailable(key, type, vals);
    $("overlayNote").textContent = avail ? "" : (SCEN.PRESETS[key].kind === "route"
      ? "Flood routing has no closed-form solution; the repository validates the solver on the dam-break, oscillating-lake and steady-flow benchmarks instead."
      : "The exact solution is hidden: it only exists for a flat, frictionless bed" + (SCEN.PRESETS[key].kind === "bowl" ? " and a rectangular section." : " (set slope and n to 0)."));
  }

  /* ---- profile (2D) */
  function layerColorCss(layer, h, u) {
    const c = V3D.layerColor(layer, sim.sec, h, u, sim.hmax, scene3 ? scene3.vscale : fallbackVscale());
    return `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
  }
  function fallbackVscale() {
    return sim.kind === "route" ? 1.5 * sim.qp / sim.sec.area(vals.hUp) : sim.kind === "bowl" ? Math.max(1e-6, sim.X0 * Math.sqrt(2 * G * vals.hUp / ((vals.L / 4) ** 2))) : Math.max(sim.sec.F(vals.hUp), 1e-6);
  }
  function drawProfile() {
    const c = $("main"), { ctx, w, h: H } = setupCanvas(c);
    const m = { ml: 58, mr: 14, mt: 14, mb: 36 }, pw = w - m.ml - m.mr, ph = H - m.mt - m.mb;
    const flat = $("flatten").checked, sec = sim.sec, L = vals.L, s = hist[viewIdx], dx = L / N, off = flat ? vals.slope : 0;
    let ymin, ymax;
    if (flat) { ymin = -0.12 * sim.hmax; ymax = 1.2 * sim.hmax; }
    else { const top = Math.max(sim.etaTop, sim.zmax), R = top - sim.zmin || 1; ymin = sim.zmin - 0.08 * R; ymax = top + 0.1 * R; }
    const px = (x) => m.ml + (x / L) * pw, py = (v, x) => m.mt + ((ymax - (v + off * x)) / (ymax - ymin)) * ph;
    const layer = $("layer").value, fg = css("--muted"), grid = css("--grid");
    ctx.font = "12px system-ui, sans-serif"; ctx.strokeStyle = grid; ctx.fillStyle = fg; ctx.lineWidth = 1;
    ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let k = 0; k <= 5; k++) {
      const v = ymin + ((ymax - ymin) * k) / 5, y = m.mt + ph - (ph * k) / 5;
      ctx.beginPath(); ctx.moveTo(m.ml, y); ctx.lineTo(m.ml + pw, y); ctx.stroke();
      ctx.fillText(Math.abs(v) < 1e-9 ? "0" : v.toPrecision(3), m.ml - 6, y);
    }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let k = 0; k <= 5; k++) ctx.fillText(fmtDist((L * k) / 5, L), m.ml + (pw * k) / 5, m.mt + ph + 6);
    ctx.save(); ctx.translate(14, m.mt + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center";
    ctx.fillText(flat ? "depth above bed (m)" : "elevation (m)", 0, 0); ctx.restore();

    const depths = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const hh = sec.depth(s.A[i]); depths[i] = hh > sim.solver.eps ? hh : 0;
      if (!depths[i]) continue;
      const x = (i + 0.5) * dx, z = sim.solver.zc(i), u = s.Q[i] / s.A[i];
      const yt = py(z + hh, x), yb = py(z, x);
      ctx.fillStyle = layerColorCss(layer, hh, u);
      ctx.fillRect(px(x - dx / 2), yt, (pw * dx) / L + 0.8, Math.max(yb - yt, 0.5));
    }
    ctx.strokeStyle = css("--surface"); ctx.lineWidth = 1.6; ctx.beginPath();
    let pen = false;
    for (let i = 0; i < N; i++) {
      const x = (i + 0.5) * dx;
      if (depths[i] > 0) { const y = py(sim.solver.zc(i) + depths[i], x); if (!pen) { ctx.moveTo(px(x), y); pen = true; } else ctx.lineTo(px(x), y); } else pen = false;
    }
    ctx.stroke();
    ctx.fillStyle = css("--bed"); ctx.beginPath(); ctx.moveTo(px(0), m.mt + ph);
    for (let i = 0; i < N; i++) { const x = (i + 0.5) * dx; ctx.lineTo(px(x), py(sim.solver.zc(i), x)); }
    ctx.lineTo(px(L), m.mt + ph); ctx.closePath(); ctx.fill();

    if ($("overlay").checked && exactFn && s.t > 1e-9) {
      ctx.strokeStyle = css("--exact"); ctx.lineWidth = 1.8; ctx.setLineDash([6, 4]); ctx.beginPath();
      for (let k = 0; k <= 400; k++) {
        const x = (L * k) / 400, hh = exactFn(x, s.t), zc = sim.solver.zc(clamp(Math.round(x / dx - 0.5), 0, N - 1));
        const y = py(zc + hh, x); if (k === 0) ctx.moveTo(px(x), y); else ctx.lineTo(px(x), y);
      }
      ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.fillStyle = fg; ctx.textAlign = "left"; ctx.textBaseline = "top";
    if (sim.x0 !== null) {
      ctx.strokeStyle = fg; ctx.lineWidth = 1; ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(px(sim.x0), m.mt); ctx.lineTo(px(sim.x0), m.mt + ph); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillText("dam", px(sim.x0) + 4, m.mt + 2);
    }
    sim.gauges.forEach((g) => {
      ctx.strokeStyle = fg; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(px(g.f * L), m.mt + 14); ctx.lineTo(px(g.f * L), m.mt + ph); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillText(g.name, px(g.f * L) + 3, m.mt + 14);
    });
    probes.forEach((x, j) => { ctx.strokeStyle = PROBE_COLORS[j]; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(px(x), m.mt); ctx.lineTo(px(x), m.mt + ph); ctx.stroke(); });
    drawLegend2D(ctx, w, m, layer);
  }

  function drawLegend2D(ctx, w, m, layer) {
    if (layer === "depth") return;
    const lg = V3D.legend(layer, sim); let x = w - m.mr - 8 - (lg.items ? lg.items.length * 66 : 120), y = m.mt + 6;
    ctx.save(); ctx.font = "11px system-ui, sans-serif"; ctx.textBaseline = "top"; ctx.textAlign = "left";
    ctx.fillStyle = css("--panel"); ctx.globalAlpha = 0.85; ctx.fillRect(x - 6, y - 4, lg.items ? lg.items.length * 66 + 8 : 132, 34); ctx.globalAlpha = 1;
    ctx.fillStyle = css("--muted"); ctx.fillText(lg.items ? "depth x velocity (m²/s)" : lg.title, x, y);
    if (lg.items) lg.items.forEach((it, i) => { ctx.fillStyle = it.color; ctx.fillRect(x + i * 66, y + 14, 10, 10); ctx.fillStyle = css("--muted"); ctx.fillText(it.label, x + i * 66 + 13, y + 14); });
    else { const g = ctx.createLinearGradient(x, 0, x + 120, 0); lg.gradient.forEach((c, i) => g.addColorStop(i / (lg.gradient.length - 1), c)); ctx.fillStyle = g; ctx.fillRect(x, y + 14, 120, 9); }
    ctx.restore();
  }

  function drawProbe() {
    const c = $("probe"), { ctx, w, h } = setupCanvas(c);
    const m = { ml: 58, mr: 14, mt: 10, mb: 30 }, pw = w - m.ml - m.mr, ph = h - m.mt - m.mb;
    const fg = css("--muted"), grid = css("--grid"), sec = sim.sec;
    ctx.font = "12px system-ui, sans-serif";
    const idxs = probes.map((x) => clamp(Math.round(x / (vals.L / N) - 0.5), 0, N - 1));
    let ymax = sim.hmax * 1.1;
    idxs.forEach((i) => { for (let f = 0; f <= viewIdx; f++) ymax = Math.max(ymax, sec.depth(hist[f].A[i]) * 1.05); });
    const px = (t) => m.ml + (t / sim.tmax) * pw, py = (v) => m.mt + ph - (v / ymax) * ph;
    ctx.strokeStyle = grid; ctx.fillStyle = fg; ctx.lineWidth = 1; ctx.textAlign = "right"; ctx.textBaseline = "middle";
    for (let k = 0; k <= 3; k++) { const y = m.mt + ph - (ph * k) / 3; ctx.beginPath(); ctx.moveTo(m.ml, y); ctx.lineTo(m.ml + pw, y); ctx.stroke(); ctx.fillText(((ymax * k) / 3).toPrecision(2), m.ml - 6, y); }
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let k = 0; k <= 4; k++) ctx.fillText(fmtTime((sim.tmax * k) / 4), m.ml + (pw * k) / 4, m.mt + ph + 6);
    ctx.save(); ctx.translate(14, m.mt + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.fillText("depth (m)", 0, 0); ctx.restore();
    const series = idxs.map((i, j) => ({ i, color: PROBE_COLORS[j], label: fmtDist(probes[j], vals.L) }));
    sim.gauges.forEach((g) => { if (tab !== "profile") series.push({ i: clamp(Math.round(g.f * (N - 1)), 0, N - 1), color: "#555", label: g.name, dash: true }); });
    if (!series.length) { ctx.fillStyle = fg; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("No probes yet. Click the profile view to add one.", m.ml + pw / 2, m.mt + ph / 2); return; }
    series.forEach((sr, j) => {
      ctx.strokeStyle = sr.color; ctx.lineWidth = 1.8; ctx.setLineDash(sr.dash ? [4, 3] : []); ctx.beginPath();
      for (let f = 0; f <= viewIdx; f++) { const x = px(hist[f].t), y = py(sec.depth(hist[f].A[sr.i])); if (f === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = sr.color; ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(sr.label, m.ml + 8 + j * 78, m.mt + 2);
    });
    const tx = px(hist[viewIdx].t); ctx.strokeStyle = fg; ctx.beginPath(); ctx.moveTo(tx, m.mt); ctx.lineTo(tx, m.mt + ph); ctx.stroke();
  }

  /* ---- gauges */
  function gaugeStats() {
    const sec = sim.sec, eps = sim.solver.eps;
    const out = sim.gauges.map(() => ({ arr: null, peak: 0, dv: 0, state: 0 }));
    const cells = sim.gauges.map((g) => clamp(Math.round(g.f * (N - 1)), 0, N - 1));
    for (let f = 0; f <= viewIdx; f++) {
      const s = hist[f];
      for (let g = 0; g < out.length; g++) {
        const c = cells[g], h = sec.depth(s.A[c]);
        if (h <= eps) continue;
        const o = out[g]; o.state = Math.max(o.state, 1); o.peak = Math.max(o.peak, h); o.dv = Math.max(o.dv, h * Math.abs(s.Q[c] / s.A[c]));
        if (h >= sim.gauges[g].hmark) { o.state = 2; if (o.arr === null) o.arr = s.t; }
      }
    }
    return out;
  }
  function updateGaugeTable(gs) {
    const tb = $("gtable").tBodies[0]; tb.innerHTML = "";
    const colors = ["#2f9e44", "#f0b429", "#e03131"];
    gs.forEach((o, i) => {
      const g = sim.gauges[i], tr = document.createElement("tr");
      tr.innerHTML = `<td><span class="dot" style="background:${colors[o.state]}"></span>${g.name}</td><td>${fmtDist(g.f * vals.L, vals.L)}</td><td>${g.hmark.toFixed(2)} m</td>` +
        `<td>${o.arr === null ? "-" : fmtTime(o.arr)}</td><td>${o.peak ? o.peak.toFixed(2) + " m" : "-"}</td><td>${o.dv ? o.dv.toFixed(2) + " m²/s" : "-"}</td>`;
      tb.appendChild(tr);
    });
  }
  function buildGaugeSliders() {
    const box = $("gaugeSliders"); box.innerHTML = "";
    sim.gauges.forEach((g, i) => {
      const row = document.createElement("div"); row.className = "gaugerow";
      row.innerHTML = `<span>${g.name}</span><input class="gsl" type="range" min="0.05" max="0.97" step="0.01" value="${g.f}">`;
      row.querySelector("input").addEventListener("input", (e) => {
        g.f = parseFloat(e.target.value); userGaugeF = sim.gauges.map((q) => q.f); draw(); scheduleHash();
      });
      box.appendChild(row);
    });
  }

  /* ---- 3D and space-time */
  function ensureGL() {
    if (renderer || glError) return;
    try {
      renderer = new GLX.Renderer($("gl"));
      scene3 = new V3D.Scene3D(renderer); spacetime = new V3D.SpaceTime(renderer);
      scene3.cam.attach($("gl")); spacetime.cam.attach($("gl"));
      scene3.cam.onChange = spacetime.cam.onChange = () => { if (!playing) draw(); };
      scene3.cut = $("cut").checked;
      scene3.setup(sim, userEx ? userEx.ve : undefined, userEx ? userEx.we : undefined);
      spacetime.resetCamera(); syncExSliders();
    } catch (e) { glError = e; errors.push(String(e)); }
  }
  function showGlError() {
    const m = $("glmsg"); m.style.display = "flex";
    m.textContent = "The 3D view needs WebGL, which is not available in this browser or has been disabled (" + glError.message + "). The profile view still works.";
  }
  function syncExSliders() {
    if (!scene3) return;
    $("ve").value = sliderFromVe(scene3.ve); $("we").value = sliderFromWe(scene3.we);
    $("veOut").textContent = "×" + (scene3.ve >= 10 ? Math.round(scene3.ve) : scene3.ve.toFixed(1));
    $("weOut").textContent = "×" + (scene3.we >= 10 ? Math.round(scene3.we) : scene3.we.toFixed(1));
  }
  function draw3D(gs) {
    $("glmsg").style.display = "none";
    const s = hist[viewIdx], dt = s.t - lastDrawT; lastDrawT = s.t;
    const big = Math.abs(dt) > sim.tmax * 0.05; if (big) scene3.pseeded = false;
    const st = { layer: $("layer").value, ghostFn: $("overlay").checked ? exactFn : null, particles: $("particles").checked, showGauges: $("gauges").checked,
      gaugeState: gs.map((o) => o.state), dtSim: big ? 0 : dt, follow: $("follow").checked && playing, ticks: true };
    scene3.update(s, st);
    renderLabels(scene3.draw(st));
    renderLegend();
    $("hud").textContent = `vertical ×${scene3.ve >= 10 ? Math.round(scene3.ve) : scene3.ve.toFixed(1)} | width ×${scene3.we >= 10 ? Math.round(scene3.we) : scene3.we.toFixed(1)} | not to scale`;
  }
  function drawST() {
    $("glmsg").style.display = "none";
    if (stDirty || stFrame !== viewIdx) {
      if (!playing || frameNo % 3 === 0 || stFrame < 0) { spacetime.build(sim, hist, viewIdx, exactInfo && $("overlay").checked ? exactInfo : null); stFrame = viewIdx; stDirty = false; }
    }
    renderLabels(spacetime.draw());
    renderLegend();
    $("hud").textContent = "depth h(x, t): the shock, rarefaction fan and reflections appear as ridges" + (exactInfo && $("overlay").checked ? "; pink floor lines are the exact wave paths" : "");
  }
  const labelPool = [];
  function renderLabels(list) {
    const box = $("labels");
    while (labelPool.length < list.length) { const sp = document.createElement("span"); box.appendChild(sp); labelPool.push(sp); }
    labelPool.forEach((sp, i) => {
      const l = list[i];
      if (!l) { sp.style.display = "none"; return; }
      sp.style.display = ""; sp.textContent = l.text; sp.className = l.cls || "tick"; sp.style.left = l.x.toFixed(1) + "px"; sp.style.top = l.y.toFixed(1) + "px";
    });
  }
  function renderLegend() {
    const el = $("legend");
    if (tab === "profile") { el.parentElement.style.display = ""; }
    const lg = V3D.legend(tab === "st" ? "depth" : $("layer").value, sim);
    let html = `<b>${lg.title}</b>`;
    if (lg.items) html += lg.items.map((i) => `<span class="it"><span class="sw" style="background:${i.color}"></span>${i.label}</span>`).join("");
    else html += `<div class="bar" style="background:linear-gradient(90deg,${lg.gradient.join(",")})"></div><div class="ends"><span>${lg.a}</span><span>${lg.b}</span></div>`;
    el.innerHTML = html;
  }

  /* ---------------------------------------------------------------------- tabs */
  function setTab(t) {
    tab = t;
    for (const n of ["profile", "3d", "st"]) $("tab-" + n).classList.toggle("on", n === t);
    $("view-profile").hidden = t !== "profile"; $("view-gl").hidden = t === "profile";
    $("camrow").style.display = t === "3d" ? "" : "none";
    if (t !== "profile") { ensureGL(); stDirty = true; lastDrawT = hist[viewIdx].t; if (scene3) scene3.pseeded = false; }
    if (t === "st") $("legend").style.display = ""; 
    draw(); scheduleHash();
  }

  /* ------------------------------------------------------------ share link / recording */
  function scheduleHash() { clearTimeout(hashTimer); hashTimer = setTimeout(writeHash, 250); }
  function writeHash() {
    if (!sim) return;
    const p = new URLSearchParams();
    p.set("s", key); p.set("sec", type); p.set("N", N); p.set("layer", $("layer").value); p.set("tab", tab);
    p.set("ov", $("overlay").checked ? 1 : 0); p.set("flat", $("flatten").checked ? 1 : 0); p.set("cut", $("cut").checked ? 1 : 0);
    p.set("part", $("particles").checked ? 1 : 0); p.set("gau", $("gauges").checked ? 1 : 0);
    for (const k of KEYS) if (!$("row_" + k).hidden) p.set(k, vals[k]);
    if (scene3) { p.set("ve", scene3.ve.toFixed(2)); p.set("we", scene3.we.toFixed(2)); }
    p.set("g", sim.gauges.map((g) => g.f.toFixed(2)).join(","));
    try { history.replaceState(null, "", "#" + p.toString()); } catch (e) { /* sandboxed iframe */ }
  }
  function readHash() {
    const h = location.hash.replace(/^#/, ""); if (!h) return null;
    const p = new URLSearchParams(h), o = {};
    if (!SCEN.PRESETS[p.get("s")]) return null;
    o.key = p.get("s"); o.type = SCEN.SECTION_TYPES[p.get("sec")] ? p.get("sec") : undefined;
    o.vals = {}; for (const k of KEYS) if (p.has(k) && isFinite(parseFloat(p.get(k)))) o.vals[k] = parseFloat(p.get(k));
    o.N = [200, 400, 800].includes(parseInt(p.get("N"), 10)) ? parseInt(p.get("N"), 10) : 400;
    o.layer = ["depth", "velocity", "froude", "hazard"].includes(p.get("layer")) ? p.get("layer") : "depth";
    o.tab = ["profile", "3d", "st"].includes(p.get("tab")) ? p.get("tab") : "profile";
    for (const k of ["ov", "flat", "cut", "part", "gau"]) if (p.has(k)) o[k] = p.get(k) === "1";
    if (p.has("ve") && p.has("we")) o.ex = { ve: parseFloat(p.get("ve")), we: parseFloat(p.get("we")) };
    if (p.has("g")) o.gauges = p.get("g").split(",").map(parseFloat).filter(isFinite);
    return o;
  }
  function copyLink() {
    writeHash();
    const done = () => { $("copyLink").textContent = "Link copied"; setTimeout(() => ($("copyLink").textContent = "Copy link"), 1600); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(location.href).then(done, () => window.prompt("Copy this link:", location.href));
    else window.prompt("Copy this link:", location.href);
  }
  function startRecording() {
    if (recording) { stopRecording(); return; }
    if (!window.MediaRecorder) { alert("Recording is not supported in this browser (try a Chromium-based browser)."); return; }
    if (tab === "profile") setTab("3d");
    if (glError) return;
    resetSim();
    const stream = $("gl").captureStream(30);
    const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 6e6 } : undefined);
    recChunks = [];
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    recorder.onstop = () => {
      const blob = new Blob(recChunks, { type: "video/webm" }); window.__lastClipBytes = blob.size;
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `saint-venant-${key}-${tab}.webm`; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    };
    recording = true; $("record").classList.add("on"); $("record").textContent = "Stop recording";
    recorder.start(); play();
  }
  function stopRecording() {
    if (!recording) return;
    recording = false; $("record").classList.remove("on"); $("record").textContent = "Record clip";
    try { recorder.stop(); } catch (e) { /* already stopped */ }
  }

  /* ----------------------------------------------------------------------- init */
  function init() {
    const sel = $("scenario");
    for (const k of Object.keys(SCEN.PRESETS)) { const o = document.createElement("option"); o.value = k; o.textContent = SCEN.PRESETS[k].label; sel.appendChild(o); }
    buildSliders();
    sel.addEventListener("change", () => setScenario(sel.value));
    $("play").addEventListener("click", play);
    $("reset").addEventListener("click", resetSim);
    $("clearProbes").addEventListener("click", () => { probes = []; draw(); });
    $("copyLink").addEventListener("click", copyLink);
    $("record").addEventListener("click", startRecording);
    $("cells").addEventListener("change", (e) => { N = parseInt(e.target.value, 10); resetSim(); });
    for (const id of ["layer", "overlay", "flatten", "particles", "gauges", "follow"]) $(id).addEventListener("change", () => { draw(); scheduleHash(); });
    $("cut").addEventListener("change", () => { if (scene3) { scene3.setCut($("cut").checked); } draw(); scheduleHash(); });
    $("speed").addEventListener("input", (e) => { speedMul = parseFloat(e.target.value); $("speedOut").innerHTML = speedMul + "&times;"; });
    $("scrub").addEventListener("input", (e) => { playing = false; $("play").textContent = "Play"; viewIdx = parseInt(e.target.value, 10); stDirty = true; draw(); });
    const exInput = () => {
      if (!scene3) return;
      userEx = { ve: veFromSlider(parseFloat($("ve").value)), we: weFromSlider(parseFloat($("we").value)) };
      scene3.setExaggeration(userEx.ve, userEx.we); syncExSliders(); draw(); scheduleHash();
    };
    $("ve").addEventListener("input", exInput); $("we").addEventListener("input", exInput);
    $("autoEx").addEventListener("click", () => { userEx = null; if (scene3) { scene3.setExaggeration(Math.round(scene3.veAuto), Math.round(scene3.weAuto * 10) / 10); syncExSliders(); draw(); scheduleHash(); } });
    for (const b of document.querySelectorAll("[data-cam]")) b.addEventListener("click", () => { if (scene3) { scene3.preset(b.dataset.cam); draw(); } });
    for (const [id, t] of [["tab-profile", "profile"], ["tab-3d", "3d"], ["tab-st", "st"]]) $(id).addEventListener("click", () => setTab(t));
    $("main").addEventListener("click", (e) => {
      const r = e.target.getBoundingClientRect(), ml = 58, mr = 14;
      const x = ((e.clientX - r.left - ml) / (r.width - ml - mr)) * vals.L;
      if (x < 0 || x > vals.L) return;
      if (probes.length >= 3) probes.shift(); probes.push(x); draw();
    });
    window.addEventListener("resize", draw);
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", draw);

    const h = readHash();
    if (h) {
      N = h.N; $("cells").value = String(N); $("layer").value = h.layer;
      for (const [k, id] of [["ov", "overlay"], ["cut", "cut"], ["part", "particles"], ["gau", "gauges"]]) if (h[k] !== undefined) $(id).checked = h[k];
      setScenario(h.key, { type: h.type, vals: h.vals, flat: h.flat, gauges: h.gauges, ex: h.ex });
      if (h.tab !== "profile") setTab(h.tab);
    } else setScenario("dry");
    requestAnimationFrame(frame);
  }

  /* test / automation hooks (used by web/test/browser.js; harmless otherwise) */
  window.__sv = {
    setTab, setScenario: (k, o) => setScenario(k, o),
    setLayer: (l) => { $("layer").value = l; draw(); },
    runTo(frac, frames) {          // deterministic, real-time-independent playback to a fraction of tmax
      resetSim(); frames = frames || 90;
      for (let i = 1; i <= frames; i++) { sim.solver.advanceTo((sim.tmax * frac * i) / frames); hist.push(sim.solver.snapshot()); }
      viewIdx = hist.length - 1; $("scrub").max = viewIdx; $("scrub").value = viewIdx; stDirty = true; lastDrawT = hist[Math.max(viewIdx - 1, 0)].t; draw();
    },
    info: () => ({ key, type, tab, frames: hist.length, t: hist[viewIdx].t, tmax: sim.tmax, glError: glError && String(glError), errors: errors.slice(), ve: scene3 && scene3.ve, we: scene3 && scene3.we, clip: window.__lastClipBytes || 0, hash: location.hash }),
    gauges: () => gaugeStats(), scene: () => scene3, draw, play,
    state: () => ({ sim, hist, viewIdx }),
  };
  window.addEventListener("error", (e) => errors.push(String(e.message)));
  init();
})();
