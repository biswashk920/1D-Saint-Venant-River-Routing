/* Minimal WebGL 1 renderer: lit meshes (with fog, specular, alpha), coloured lines, sky gradient,
 * orbit camera with mouse/touch controls, and 3D -> screen projection for HTML labels.
 * No dependencies. */
(function (root, factory) { root.GLX = factory(); })(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ---------------------------------------------------------------- vector / matrix helpers */
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

  function perspective(fovy, aspect, near, far) {
    const t = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function lookAt(e, c, up) {
    const z = norm(sub(e, c)), x = norm(cross(up, z)), y = cross(z, x);
    return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1];
  }
  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
    return o;
  }

  /* ----------------------------------------------------------------------- orbit camera */
  class OrbitCamera {
    constructor() { this.target = [0, 0, 0]; this.dist = 16; this.yaw = Math.PI + 0.55; this.pitch = 0.5; this.fov = 0.8; this.onChange = null; }
    eye() {
      const cp = Math.cos(this.pitch);
      return [this.target[0] + this.dist * cp * Math.sin(this.yaw), this.target[1] + this.dist * Math.sin(this.pitch),
        this.target[2] + this.dist * cp * Math.cos(this.yaw)];
    }
    set(yaw, pitch, dist, target) {
      this.yaw = yaw; this.pitch = pitch; if (dist) this.dist = dist; if (target) this.target = target.slice();
    }
    attach(canvas) {
      const pts = new Map(); let lastPinch = 0;
      const changed = () => { if (this.onChange) this.onChange(); };
      canvas.style.touchAction = "none";
      canvas.addEventListener("contextmenu", (e) => e.preventDefault());
      canvas.addEventListener("pointerdown", (e) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); lastPinch = 0; });
      canvas.addEventListener("pointerup", (e) => pts.delete(e.pointerId));
      canvas.addEventListener("pointercancel", (e) => pts.delete(e.pointerId));
      canvas.addEventListener("pointermove", (e) => {
        if (!pts.has(e.pointerId)) return;
        const p = pts.get(e.pointerId), dx = e.clientX - p[0], dy = e.clientY - p[1];
        pts.set(e.pointerId, [e.clientX, e.clientY]);
        if (pts.size === 2) {                       // pinch zoom
          const [a, b] = [...pts.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
          if (lastPinch) this.dist = Math.max(0.5, Math.min(200, this.dist * (lastPinch / d)));
          lastPinch = d; changed(); return;
        }
        if (e.buttons & 2 || e.shiftKey) {          // pan
          const eye = this.eye(), f = norm(sub(this.target, eye)), r = norm(cross(f, [0, 1, 0])), u = cross(r, f);
          const k = this.dist * 0.0016;
          for (let i = 0; i < 3; i++) this.target[i] += (-r[i] * dx + u[i] * dy) * k;
        } else {
          this.yaw -= dx * 0.006;
          this.pitch = Math.max(-0.1, Math.min(1.56, this.pitch + dy * 0.006));
        }
        changed();
      });
      canvas.addEventListener("wheel", (e) => {
        e.preventDefault();
        this.dist = Math.max(0.5, Math.min(200, this.dist * Math.exp(e.deltaY * 0.0012))); changed();
      }, { passive: false });
    }
  }

  /* ----------------------------------------------------------------------------- shaders */
  const LIT_VS = `attribute vec3 aPos; attribute vec3 aNrm; attribute vec4 aCol; uniform mat4 uVP;
    varying vec3 vPos; varying vec3 vNrm; varying vec4 vCol;
    void main(){ vPos=aPos; vNrm=aNrm; vCol=aCol; gl_Position=uVP*vec4(aPos,1.0); }`;
  const LIT_FS = `#ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif
    varying vec3 vPos; varying vec3 vNrm; varying vec4 vCol;
    uniform vec3 uCam; uniform vec3 uLight; uniform vec3 uFog; uniform float uFogD; uniform float uSpec; uniform float uAmb;
    void main(){
      vec3 n=normalize(vNrm); vec3 V=normalize(uCam-vPos);
      if(dot(n,V)<0.0) n=-n;
      float d=max(dot(n,uLight),0.0);
      vec3 col=vCol.rgb*(uAmb+(1.0-uAmb)*d);
      vec3 H=normalize(uLight+V);
      col+=vec3(pow(max(dot(n,H),0.0),70.0)*uSpec);
      float f=1.0-exp(-uFogD*length(uCam-vPos));
      gl_FragColor=vec4(mix(col,uFog,f),vCol.a);
    }`;
  const LINE_VS = `attribute vec3 aPos; attribute vec4 aCol; uniform mat4 uVP; varying vec4 vCol;
    void main(){ vCol=aCol; gl_Position=uVP*vec4(aPos,1.0); }`;
  const LINE_FS = `precision mediump float; varying vec4 vCol; void main(){ gl_FragColor=vCol; }`;
  const SKY_VS = `attribute vec2 aXY; varying float vY; void main(){ vY=aXY.y*0.5+0.5; gl_Position=vec4(aXY,0.999,1.0); }`;
  const SKY_FS = `precision mediump float; varying float vY; uniform vec3 uTop; uniform vec3 uBot;
    void main(){ gl_FragColor=vec4(mix(uBot,uTop,smoothstep(0.0,1.0,vY)),1.0); }`;

  function compile(gl, vs, fs, attribs) {
    const mk = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader: " + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    for (const [name, loc] of Object.entries(attribs)) gl.bindAttribLocation(p, loc, name);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("link: " + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  /* ----------------------------------------------------------------------- buffers/objects */
  class Mesh {
    constructor(r, indices, vertexCount) {
      const gl = r.gl; this.r = r; this.n = indices.length; this.vc = vertexCount;
      this.ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);
      this.pb = gl.createBuffer(); this.nb = gl.createBuffer(); this.cb = gl.createBuffer();
      this.visible = true;
    }
    dispose() { const gl = this.r.gl; for (const b of [this.ib, this.pb, this.nb, this.cb]) gl.deleteBuffer(b); }
    set(pos, nrm, col) {
      const gl = this.r.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.nb); gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cb); gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
    }
  }
  class Lines {
    constructor(r) { this.r = r; const gl = r.gl; this.pb = gl.createBuffer(); this.cb = gl.createBuffer(); this.n = 0; this.visible = true; }
    dispose() { const gl = this.r.gl; gl.deleteBuffer(this.pb); gl.deleteBuffer(this.cb); }
    set(pos, col, nVerts) {
      const gl = this.r.gl; this.n = nVerts;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.pb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cb); gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
    }
  }

  /* ------------------------------------------------------------------------------ renderer */
  class Renderer {
    constructor(canvas) {
      const gl = canvas.getContext("webgl", { antialias: true, alpha: false, preserveDrawingBuffer: true }) ||
        canvas.getContext("experimental-webgl");
      if (!gl) throw new Error("WebGL is not available in this browser");
      this.gl = gl; this.canvas = canvas;
      this.lit = compile(gl, LIT_VS, LIT_FS, { aPos: 0, aNrm: 1, aCol: 2 });
      this.line = compile(gl, LINE_VS, LINE_FS, { aPos: 0, aCol: 2 });
      this.sky = compile(gl, SKY_VS, SKY_FS, { aXY: 0 });
      this.skyBuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      this.light = norm([-0.45, 0.8, -0.35]);
      this.theme = { top: [0.62, 0.78, 0.95], bot: [0.93, 0.96, 0.99], fog: [0.86, 0.91, 0.96], fogD: 0.012 };
      this.vp = null; this.eye = [0, 0, 0]; this.cssW = 1; this.cssH = 1;
    }
    resize() {
      const c = this.canvas, dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(2, Math.round(c.clientWidth * dpr)), h = Math.max(2, Math.round(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      this.cssW = c.clientWidth; this.cssH = c.clientHeight;
      this.gl.viewport(0, 0, c.width, c.height);
    }
    begin(cam) {
      const gl = this.gl; this.resize();
      gl.clearColor(0.9, 0.93, 0.97, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      // sky gradient
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.useProgram(this.sky.p);
      gl.uniform3fv(this.sky.u.uTop, this.theme.top); gl.uniform3fv(this.sky.u.uBot, this.theme.bot);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
      for (let i = 0; i < 3; i++) gl.disableVertexAttribArray(i);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
      const aspect = this.canvas.width / this.canvas.height;
      this.eye = cam.eye();
      const proj = perspective(cam.fov, aspect, 0.05, 400), view = lookAt(this.eye, cam.target, [0, 1, 0]);
      this.vp = mul(proj, view);
    }
    drawMesh(m, o) {
      if (!m.visible) return;
      o = o || {};
      const gl = this.gl, P = this.lit;
      gl.useProgram(P.p);
      gl.uniformMatrix4fv(P.u.uVP, false, this.vp);
      gl.uniform3fv(P.u.uCam, this.eye); gl.uniform3fv(P.u.uLight, this.light);
      gl.uniform3fv(P.u.uFog, this.theme.fog); gl.uniform1f(P.u.uFogD, this.theme.fogD);
      gl.uniform1f(P.u.uSpec, o.spec || 0); gl.uniform1f(P.u.uAmb, o.amb === undefined ? 0.38 : o.amb);
      if (o.blend) { gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false); }
      else { gl.disable(gl.BLEND); gl.depthMask(true); }
      gl.bindBuffer(gl.ARRAY_BUFFER, m.pb); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.nb); gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, m.cb); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ib);
      gl.drawElements(gl.TRIANGLES, m.n, gl.UNSIGNED_SHORT, 0);
      gl.depthMask(true);
    }
    drawLines(l) {
      if (!l.visible || l.n === 0) return;
      const gl = this.gl, P = this.line;
      gl.useProgram(P.p); gl.uniformMatrix4fv(P.u.uVP, false, this.vp);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
      gl.disableVertexAttribArray(1);
      gl.bindBuffer(gl.ARRAY_BUFFER, l.pb); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, l.cb); gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.LINES, 0, l.n);
      gl.depthMask(true);
    }
    /* world point -> CSS pixel position inside the canvas (null if behind the camera) */
    project(p) {
      const m = this.vp, x = p[0], y = p[1], z = p[2];
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12], cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 0.01) return null;
      return [(cx / cw * 0.5 + 0.5) * this.cssW, (1 - (cy / cw * 0.5 + 0.5)) * this.cssH];
    }
    makeMesh(indices, vc) { return new Mesh(this, indices, vc); }
    makeLines() { return new Lines(this); }
  }

  /* grid helpers shared by the scenes */
  function gridIndices(nj, nk) {
    const idx = [];
    for (let j = 0; j < nj - 1; j++) for (let k = 0; k < nk - 1; k++) {
      const a = j * nk + k, b = (j + 1) * nk + k, c = j * nk + k + 1, d = (j + 1) * nk + k + 1;
      idx.push(a, b, c, c, b, d);
    }
    return idx;
  }
  /* upward-pointing normals of a (nj x nk) grid: j along +x, k along +z */
  function gridNormals(pos, nj, nk, out) {
    for (let j = 0; j < nj; j++) for (let k = 0; k < nk; k++) {
      const j0 = Math.max(j - 1, 0), j1 = Math.min(j + 1, nj - 1), k0 = Math.max(k - 1, 0), k1 = Math.min(k + 1, nk - 1);
      const a = (j1 * nk + k) * 3, b = (j0 * nk + k) * 3, c = (j * nk + k1) * 3, d = (j * nk + k0) * 3;
      const tx = [pos[a] - pos[b], pos[a + 1] - pos[b + 1], pos[a + 2] - pos[b + 2]];
      const tz = [pos[c] - pos[d], pos[c + 1] - pos[d + 1], pos[c + 2] - pos[d + 2]];
      const n = norm(cross(tz, tx)), o = (j * nk + k) * 3;
      out[o] = n[0]; out[o + 1] = n[1]; out[o + 2] = n[2];
    }
  }

  return { Renderer, OrbitCamera, gridIndices, gridNormals, v3: { sub, dot, cross, norm }, mul, perspective, lookAt };
});
