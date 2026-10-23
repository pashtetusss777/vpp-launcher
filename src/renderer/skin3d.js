/*
 * A Minecraft player you can spin. The skin is drawn with the usual 64×64 layout:
 * base layer, then the hat and clothes a little larger.
 */
(() => {
  'use strict';

  const canvas = document.getElementById('skinStage');
  if (!canvas) return;
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false });
  if (!gl) return;

  const vs = `
    attribute vec3 aPos;
    attribute vec2 aUv;
    uniform mat4 uMvp;
    varying vec2 vUv;
    void main() {
      vUv = aUv;
      gl_Position = uMvp * vec4(aPos, 1.0);
    }
  `;
  const fs = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    void main() {
      vec4 c = texture2D(uTex, vUv);
      if (c.a < 0.08) discard;
      gl_FragColor = c;
    }
  `;

  function compile(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    return shader;
  }
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const locPos = gl.getAttribLocation(prog, 'aPos');
  const locUv = gl.getAttribLocation(prog, 'aUv');
  const locMvp = gl.getUniformLocation(prog, 'uMvp');

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);

  const buf = gl.createBuffer();
  let count = 0;
  let slim = false;
  let yaw = 0.55;
  let pitch = 0.18;
  let dist = 62;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let ready = false;

  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }
  function rotY(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
  }
  function rotX(a) {
    const c = Math.cos(a), s = Math.sin(a);
    return new Float32Array([1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]);
  }
  function translate(x, y, z) {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  }
  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  }

  // Texture rects use the usual unfolded box: u,v is the top-left of that part.
  function uvOf(u, v, w, h, d) {
    return {
      right: [u, v + d, d, h],
      front: [u + d, v + d, w, h],
      left: [u + d + w, v + d, d, h],
      back: [u + d + w + d, v + d, w, h],
      top: [u + d, v, w, d],
      bottom: [u + w + d, v, w, d],
    };
  }

  function push(out, corners, rect, order) {
    const [u, v, w, h] = rect;
    const u0 = u / 64, v0 = v / 64, u1 = (u + w) / 64, v1 = (v + h) / 64;
    const uv = [[u0, v0], [u0, v1], [u1, v1], [u1, v0]];
    for (const i of order) out.push(corners[i][0], corners[i][1], corners[i][2], uv[i][0], uv[i][1]);
  }

  function box(out, cx, cy, cz, w, h, d, u, v, tex) {
    const tw = tex ? tex[0] : w, th = tex ? tex[1] : h, td = tex ? tex[2] : d;
    const x0 = cx - w / 2, x1 = cx + w / 2;
    const y0 = cy - h / 2, y1 = cy + h / 2;
    const z0 = cz - d / 2, z1 = cz + d / 2;
    const faces = uvOf(u, v, tw, th, td);
    const wind = [0, 1, 2, 0, 2, 3];
    // The top looks down, so its corners go the other way around.
    const top = [0, 1, 3, 1, 2, 3];
    // Each quad is top-left, bottom-left, bottom-right, top-right of that side.
    push(out, [[x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]], faces.right, wind);
    push(out, [[x1, y1, z1], [x1, y0, z1], [x1, y0, z0], [x1, y1, z0]], faces.left, wind);
    push(out, [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]], faces.top, top);
    push(out, [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]], faces.bottom, wind);
    push(out, [[x0, y1, z1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1]], faces.front, wind);
    push(out, [[x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [x0, y1, z0]], faces.back, wind);
  }

  function build() {
    const arm = slim ? 3 : 4;
    const armX = slim ? 5.5 : 6;
    const data = [];
    const parts = [
      [0, 28, 0, 8, 8, 8, 0, 0],
      [0, 18, 0, 8, 12, 4, 16, 16],
      [-armX, 18, 0, arm, 12, 4, 40, 16],
      [armX, 18, 0, arm, 12, 4, 32, 48],
      [-2, 6, 0, 4, 12, 4, 0, 16],
      [2, 6, 0, 4, 12, 4, 16, 48],
    ];
    const clothes = [
      [0, 28, 0, 8, 8, 8, 32, 0, 0.5],
      [0, 18, 0, 8, 12, 4, 16, 32, 0.25],
      [-armX, 18, 0, arm, 12, 4, 40, 32, 0.25],
      [armX, 18, 0, arm, 12, 4, 48, 48, 0.25],
      [-2, 6, 0.05, 4, 12, 4, 0, 32, 0.25],
      [2, 6, 0.05, 4, 12, 4, 0, 48, 0.25],
    ];
    for (const p of parts) box(data, p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7]);
    const inner = data.length / 5;
    for (const p of clothes) {
      box(data, p[0], p[1], p[2], p[3] + p[8] * 2, p[4] + p[8] * 2, p[5] + p[8] * 2, p[6], p[7], [p[3], p[4], p[5]]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    count = data.length / 5;
    return inner;
  }
  let innerCount = build();

  function resize() {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function draw() {
    resize();
    if (!dragging) yaw += 0.004;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!ready) return;
    const aspect = canvas.width / Math.max(1, canvas.height);
    const proj = perspective(0.55, aspect, 0.1, 300);
    const view = translate(0, -16, -dist);
    const model = mul(rotX(pitch), rotY(yaw));
    const mvp = mul(proj, mul(view, model));
    gl.uniformMatrix4fv(locMvp, false, mvp);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(locPos);
    gl.enableVertexAttribArray(locUv);
    gl.vertexAttribPointer(locPos, 3, gl.FLOAT, false, 20, 0);
    gl.vertexAttribPointer(locUv, 2, gl.FLOAT, false, 20, 12);
    gl.drawArrays(gl.TRIANGLES, 0, count);
  }

  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  function frame() {
    const page = document.querySelector('.page[data-page="accounts"]');
    if (page && page.classList.contains('on')) draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('skin'));
      img.src = src;
    });
  }

  function isSlim(img) {
    if (img.naturalHeight * 2 <= img.naturalWidth) return false;
    const probe = document.createElement('canvas');
    probe.width = img.naturalWidth;
    probe.height = img.naturalHeight;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const x = Math.min(img.naturalWidth - 1, Math.floor(47 * img.naturalWidth / 64));
    const y = Math.min(img.naturalHeight - 1, Math.floor(16 * img.naturalHeight / 64));
    return ctx.getImageData(x, y, 1, 1).data[3] < 16;
  }

  let seq = 0;
  async function show(remote, fallback) {
    const token = ++seq;
    let img;
    try {
      let src = remote || fallback;
      if (/^https?:\/\//i.test(src) && window.vanilla?.skinImage) src = await window.vanilla.skinImage(src.replace(/^http:\/\//i, 'https://'));
      img = await loadImage(src);
    } catch {
      try { img = await loadImage(fallback); } catch { return; }
    }
    if (token !== seq) return;
    const nextSlim = isSlim(img);
    if (nextSlim !== slim) {
      slim = nextSlim;
      innerCount = build();
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    ready = true;
    void innerCount;
  }

  canvas.addEventListener('pointerdown', e => {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', e => {
    if (!dragging) return;
    yaw += (e.clientX - lastX) * 0.01;
    pitch = Math.max(-1.05, Math.min(1.05, pitch + (e.clientY - lastY) * 0.01));
    lastX = e.clientX;
    lastY = e.clientY;
  });
  const stop = () => { dragging = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    dist = Math.max(40, Math.min(96, dist + Math.sign(e.deltaY) * 3));
  }, { passive: false });

  window.skinView = { show };
})();
