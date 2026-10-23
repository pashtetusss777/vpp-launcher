/*
 * Vanilla++ - the page. Everything that touches the disk, the network or the game goes through
 * window.vanilla (src/main/preload.js); this file only shows it and moves.
 */
(() => {
  'use strict';

  const api = window.vanilla;
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const win = $('#win');

  const plural = (n, one, few, many) => {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icon = id => `<svg><use href="#i-${id}"/></svg>`;
  const fmtBytes = bytes => {
    const mb = bytes / 1048576;
    if (mb >= 1024) return (mb / 1024).toFixed(1).replace('.', ',') + ' ГБ';
    if (mb >= 10) return Math.round(mb) + ' МБ';
    if (mb >= 1) return mb.toFixed(1).replace('.', ',') + ' МБ';
    return Math.max(1, Math.round(bytes / 1024)) + ' КБ';
  };

  // ------------------------------------------------------------------ offline names → stock skins

  // UUID.nameUUIDFromBytes("OfflinePlayer:" + name), then DefaultPlayerSkin.get: the same face the game shows
  function md5(bytes) {
    const K = new Int32Array(64);
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0;
    const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const len = bytes.length, n = (((len + 8) >> 6) + 1) * 64;
    const buf = new Uint8Array(n);
    buf.set(bytes);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(n - 8, (len * 8) >>> 0, true);
    dv.setUint32(n - 4, Math.floor(len * 8 / 2 ** 32), true);
    let a0 = 0x67452301 | 0, b0 = 0xefcdab89 | 0, c0 = 0x98badcfe | 0, d0 = 0x10325476 | 0;
    const M = new Int32Array(16);
    for (let off = 0; off < n; off += 64) {
      for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
      let A = a0, B = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) | 0;
        A = D; D = C; C = B;
        const r = S[(i >> 4) * 4 + (i & 3)];
        B = (B + ((F << r) | (F >>> (32 - r)))) | 0;
      }
      a0 = (a0 + A) | 0; b0 = (b0 + B) | 0; c0 = (c0 + C) | 0; d0 = (d0 + D) | 0;
    }
    const out = new Uint8Array(16), ov = new DataView(out.buffer);
    ov.setInt32(0, a0, true); ov.setInt32(4, b0, true); ov.setInt32(8, c0, true); ov.setInt32(12, d0, true);
    return out;
  }

  function offlineUuid(name) {
    const b = md5(new TextEncoder().encode('OfflinePlayer:' + name));
    b[6] = (b[6] & 0x0f) | 0x30;
    b[8] = (b[8] & 0x3f) | 0x80;
    return b;
  }

  const SKINS = ['alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'steve', 'sunny', 'zuri'];
  const SKIN_NAMES = { alex: 'Alex', ari: 'Ari', efe: 'Efe', kai: 'Kai', makena: 'Makena', noor: 'Noor', steve: 'Steve', sunny: 'Sunny', zuri: 'Zuri' };

  function skinOf(name) {
    const b = offlineUuid(name), dv = new DataView(b.buffer);
    // UUID.hashCode(): the four 32-bit words xor-ed; 18 stock skins, the slim nine and then the wide nine
    const hash = dv.getInt32(0) ^ dv.getInt32(4) ^ dv.getInt32(8) ^ dv.getInt32(12);
    return SKINS[(((hash % 18) + 18) % 18) % 9];
  }

  function uuidString(name) {
    const h = [...offlineUuid(name)].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function paintFace(el, name, skinUrl) {
    const stock = `url(assets/skins/${skinOf(name || 'Steve')}.png)`;
    const applyStock = () => {
      el.dataset.classic = '';
      el.style.backgroundSize = '';
      el.style.backgroundPosition = '';
      el.style.backgroundImage = `${stock}, ${stock}`;
    };
    // Mojang skin CDN is often http:// — CSP only allows https:
    const src = skinUrl ? String(skinUrl).replace(/^http:\/\//i, 'https://') : '';
    if (!src) {
      el.dataset.skin = '';
      applyStock();
      return;
    }
    el.dataset.skin = src;
    applyStock();
    const img = new Image();
    img.onload = () => {
      if (el.dataset.skin !== src) return;
      const url = `url("${src.replace(/"/g, '')}")`;
      const classic = img.naturalHeight * 2 <= img.naturalWidth;
      el.dataset.classic = classic ? '1' : '';
      if (classic) {
        el.style.backgroundSize = 'calc(var(--s) * 8) calc(var(--s) * 4)';
        el.style.backgroundPosition = 'calc(var(--s) * -1) calc(var(--s) * -1)';
        el.style.backgroundImage = url;
      } else {
        el.style.backgroundSize = '';
        el.style.backgroundPosition = '';
        el.style.backgroundImage = `${url}, ${url}`;
      }
    };
    img.onerror = () => { if (el.dataset.skin === src) applyStock(); };
    img.src = src;
  }

  // ------------------------------------------------------------------ state

  let boot = null;
  let phase = 'idle';
  const state = {
    page: 'home',
    nick: '',
    accountId: '',
    accounts: [],
    ram: 4,
    mods: [],
    packs: [],
    shaders: [],
    builtin: [],
    settings: {},
  };

  let saveTimer = null;
  const pending = {};
  function save(patch, now) {
    Object.assign(state.settings, patch);
    Object.assign(pending, patch);
    clearTimeout(saveTimer);
    const flush = () => {
      const p = { ...pending };
      for (const k of Object.keys(pending)) delete pending[k];
      return api.settings(p).catch(e => toast('warn', 'Настройки не сохранились: ' + e.message, 'warn'));
    };
    if (now) return flush();
    saveTimer = setTimeout(flush, 300);
    return Promise.resolve();
  }

  // ------------------------------------------------------------------ backdrop: the menu's panoramas, parallax, particles

  // The same panoramas the client's main menu stands in, drawn the same way: a 3x2 sheet of cube faces
  // looked into, with a slow sway of its own and the cursor's pull. The End's faces disagree where they
  // meet (its shader pack worked the fog out per face), so its view stays narrow and nearly still - as in
  // the menu.
  const PANORAMAS = {
    sakura: { label: 'Сакура', sheet: 'assets/sakura.jpg', fov: 62, sway: 4.5, parallax: 2.2, maxHalf: 60, particles: 'petals' },
    end: { label: 'Энд', sheet: 'assets/end.jpg', fov: 62, sway: 1.0, parallax: 1.0, maxHalf: 44, particles: 'dust' },
  };
  let shownPano = 'sakura';

  const world = $('#world');
  let aimX = 0, aimY = 0, curX = 0, curY = 0, clock = 0;
  win.addEventListener('mousemove', e => {
    const r = win.getBoundingClientRect();
    aimX = (e.clientX - r.left) / r.width * 2 - 1;
    aimY = (e.clientY - r.top) / r.height * 2 - 1;
  });

  const panoCanvas = $('#pano');
  const pano = makePano(panoCanvas);

  function makePano(cv) {
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    cv.width = Math.round(1120 * dpr);
    cv.height = Math.round(680 * dpr);
    const gl = cv.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) return null;
    const vs = 'attribute vec2 p; varying vec2 v; void main() { v = p; gl_Position = vec4(p, 0.0, 1.0); }';
    // the menu shader's panorama(): which face a direction falls on, and where on it
    const fs = `precision highp float;
      uniform sampler2D sheet;
      uniform vec4 view;   // yaw, pitch (radians), tan(half the vertical field), aspect
      uniform float inset;
      varying vec2 v;
      vec3 face(vec3 d) {
        vec3 a = abs(d);
        vec3 fw, rt, up;
        vec2 cell;
        if (a.y >= a.x && a.y >= a.z) {
          if (d.y > 0.0) { fw = vec3(0.0, 1.0, 0.0); rt = vec3(-1.0, 0.0, 0.0); up = vec3(0.0, 0.0, -1.0); cell = vec2(1.0, 1.0); }
          else { fw = vec3(0.0, -1.0, 0.0); rt = vec3(-1.0, 0.0, 0.0); up = vec3(0.0, 0.0, 1.0); cell = vec2(2.0, 1.0); }
        } else if (a.z >= a.x) {
          if (d.z > 0.0) { fw = vec3(0.0, 0.0, 1.0); rt = vec3(-1.0, 0.0, 0.0); cell = vec2(0.0, 0.0); }
          else { fw = vec3(0.0, 0.0, -1.0); rt = vec3(1.0, 0.0, 0.0); cell = vec2(2.0, 0.0); }
          up = vec3(0.0, 1.0, 0.0);
        } else {
          if (d.x < 0.0) { fw = vec3(-1.0, 0.0, 0.0); rt = vec3(0.0, 0.0, -1.0); cell = vec2(1.0, 0.0); }
          else { fw = vec3(1.0, 0.0, 0.0); rt = vec3(0.0, 0.0, 1.0); cell = vec2(0.0, 1.0); }
          up = vec3(0.0, 1.0, 0.0);
        }
        float depth = dot(d, fw);
        vec2 uv = clamp(vec2(0.5 + 0.5 * dot(d, rt) / depth, 0.5 - 0.5 * dot(d, up) / depth), vec2(inset), vec2(1.0 - inset));
        return texture2D(sheet, (cell + uv) / vec2(3.0, 2.0)).rgb;
      }
      void main() {
        float yaw = view.x, pitch = view.y;
        vec3 forward = vec3(-sin(yaw) * cos(pitch), sin(pitch), cos(yaw) * cos(pitch));
        vec3 right = vec3(-cos(yaw), 0.0, -sin(yaw));
        vec3 up = cross(right, forward);
        vec3 dir = normalize(forward + right * v.x * view.z * view.w + up * v.y * view.z);
        float s = 0.0018;
        vec3 c = face(dir) * 0.4
          + face(normalize(dir + right * s)) * 0.15 + face(normalize(dir - right * s)) * 0.15
          + face(normalize(dir + up * s)) * 0.15 + face(normalize(dir - up * s)) * 0.15;
        gl_FragColor = vec4(c, 1.0);
      }`;
    const shader = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    };
    let program;
    try {
      program = gl.createProgram();
      gl.attachShader(program, shader(gl.VERTEX_SHADER, vs));
      gl.attachShader(program, shader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    } catch (e) {
      console.warn('panorama shader failed', e);
      return null;
    }
    gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const at = gl.getAttribLocation(program, 'p');
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 2, gl.FLOAT, false, 0, 0);
    const uView = gl.getUniformLocation(program, 'view'), uInset = gl.getUniformLocation(program, 'inset');
    gl.uniform1i(gl.getUniformLocation(program, 'sheet'), 0);

    const textures = {};
    function load(id) {
      if (textures[id]) return textures[id].ready;
      const entry = textures[id] = { tex: null, faceSize: 1024 };
      entry.ready = new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
          const tex = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
          entry.tex = tex;
          entry.faceSize = img.naturalWidth / 3;
          resolve(true);
        };
        img.onerror = () => resolve(false);
        img.src = PANORAMAS[id].sheet;
      });
      return entry.ready;
    }

    function draw(id, yaw, pitch, tanHalf, aspect) {
      const entry = textures[id];
      if (!entry || !entry.tex) return false;
      gl.viewport(0, 0, cv.width, cv.height);
      gl.bindTexture(gl.TEXTURE_2D, entry.tex);
      gl.uniform4f(uView, yaw, pitch, tanHalf, aspect);
      gl.uniform1f(uInset, 0.75 / entry.faceSize);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return true;
    }

    return { load, draw };
  }

  function drawPano() {
    if (!pano) return;
    const p = PANORAMAS[shownPano];
    const rad = Math.PI / 180;
    const aspect = 1120 / 680;
    const yaw = (p.sway * Math.sin(clock * 0.11) + p.parallax * curX) * rad;
    const pitch = (1.2 * Math.sin(clock * 0.07 + 1.3) * (p.sway / 4.5) - p.parallax * 0.6 * curY) * rad;
    const tanHalf = Math.min(Math.tan(p.fov / 2 * rad), Math.tan(p.maxHalf * rad) / aspect);
    pano.draw(shownPano, yaw, pitch, tanHalf, aspect);
  }

  // what drifts through the air: petals falling past the sakura, the End's dust rising slowly
  const canvas = $('#petals'), ctx = canvas.getContext('2d');
  const PETAL_COLORS = ['#f6c1d3', '#eea6bf', '#f9d4e2', '#e58fb0', '#f3b3c8'];
  const DUST_COLORS = ['#cdb8ff', '#b79cff', '#e4d8ff', '#a98cf5'];
  let particleKind = 'petals';
  const petals = [];
  (function sizeCanvas() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = 1120 * dpr;
    canvas.height = 680 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  })();
  function petal(anywhere) {
    const depth = Math.random();
    if (particleKind === 'dust') {
      return {
        kind: 'dust',
        x: Math.random() * 1180 - 30,
        y: anywhere ? Math.random() * 680 : 700 + Math.random() * 120,
        size: 1 + depth * 1.8,
        vy: -(6 + depth * 14),
        vx: 2 - depth * 4,
        sway: Math.random() * Math.PI * 2,
        color: DUST_COLORS[(Math.random() * DUST_COLORS.length) | 0],
        alpha: .35 + depth * .45,
        twinkle: Math.random() * Math.PI * 2,
        fade: anywhere ? 0 : 1,
      };
    }
    return {
      kind: 'petals',
      x: Math.random() * 1240 - 60,
      y: anywhere ? Math.random() * 680 : -20 - Math.random() * 120,
      size: 3 + depth * 6,
      vy: 16 + depth * 34,
      vx: -6 - depth * 18,
      sway: Math.random() * Math.PI * 2,
      spin: (Math.random() - .5) * 3,
      flip: Math.random() * Math.PI * 2,
      flipSpeed: 1.5 + Math.random() * 2.5,
      rot: Math.random() * Math.PI,
      color: PETAL_COLORS[(Math.random() * PETAL_COLORS.length) | 0],
      alpha: .55 + depth * .4,
      fade: anywhere ? 0 : 1,
    };
  }

  // a new backdrop's air: what drifts now melts away, and the new kind shows up all over at once
  function setParticles(kind) {
    if (kind === particleKind) return;
    particleKind = kind;
    petals.forEach(p => { p.out = true; });
  }
  for (let i = 0; i < 46; i++) petals.push(Object.assign(petal(true), { fade: 1 }));

  function drawParticles(dt) {
    ctx.clearRect(0, 0, 1120, 680);
    for (let i = 0; i < petals.length; i++) {
      let p = petals[i];
      if (p.out) {
        p.fade -= dt * 1.6;
        if (p.fade <= 0) p = petals[i] = petal(true);
      } else if (p.fade < 1) {
        p.fade = Math.min(1, p.fade + dt * 0.8);
      }
      p.sway += dt * 1.3;
      if (p.kind === 'dust') {
        p.x += (p.vx + Math.sin(p.sway * 0.7) * 5 - curX * 2) * dt;
        p.y += p.vy * dt;
        p.twinkle += dt * 2.2;
        // a speck leaving at the top comes back as whatever the backdrop drifts now
        if (p.y < -20) petals[i] = petal(false);
        const a = p.alpha * p.fade * (0.7 + 0.3 * Math.sin(p.twinkle));
        ctx.globalAlpha = a * 0.22;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      p.x += (p.vx + Math.sin(p.sway) * 10 - curX * 4) * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      p.flip += p.flipSpeed * dt;
      if (p.y > 700 || p.x < -40) petals[i] = petal(false);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(Math.cos(p.flip), 1);
      ctx.globalAlpha = p.alpha * p.fade;
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // the backdrop rests while the loader is minimized or the game has the screen
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(.05, (now - last) / 1000);
    last = now;
    if (!document.hidden && phase !== 'running') {
      clock += dt;
      const k = 1 - Math.exp(-3.2 * dt);
      curX += (aimX - curX) * k;
      curY += (aimY - curY) * k;
      world.style.transform = `translate(${(-curX * 14).toFixed(2)}px, ${(-curY * 9).toFixed(2)}px) scale(1.03)`;
      drawPano();
      if (state.settings.particles !== false) drawParticles(dt);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------------------------ pages

  const navWash = $('#navWash');
  function placeWash() {
    const btn = $(`.nav-list .nav[data-page="${state.page}"]`);
    if (btn) navWash.style.transform = `translateY(${btn.offsetTop}px)`;
  }

  function show(page, focus) {
    if (page === 'profile') page = 'accounts';
    if (page === state.page && !focus) return;
    closePreview();
    state.page = page;
    $$('.nav-list .nav').forEach(b => b.classList.toggle('on', b.dataset.page === page));
    placeWash();
    $$('.page').forEach(p => {
      const on = p.dataset.page === page;
      if (on && !p.classList.contains('on')) {
        // replay the entrance of the page's pieces
        p.classList.remove('on');
        void p.offsetWidth;
      }
      p.classList.toggle('on', on);
    });
    win.classList.toggle('paned', page !== 'home');
    if (page === 'mods' || page === 'packs' || page === 'shaders') showShelf(page);
    if (page === 'home') pingServers();
    if (page === 'settings') readMemory();
    if (page === 'logs') loadLogs();
    if (focus === 'ram') setTimeout(() => {
      $('#ramBlock').animate([{ background: 'rgb(var(--accent) / .14)' }, { background: 'transparent' }],
        { duration: 1100, easing: 'ease-out', delay: 250 });
    }, 0);
  }

  document.addEventListener('click', e => {
    const go = e.target.closest('[data-page]');
    if (go && !go.classList.contains('page')) {
      show(go.dataset.page, go.dataset.focus);
      return;
    }
    const act = e.target.closest('[data-act]');
    if (act) action(act.dataset.act);
  });

  async function action(name) {
    try {
      switch (name) {
        case 'folder': await api.open.path('root'); break;
        case 'folder-mods': await api.open.path('mods'); break;
        case 'folder-packs': await api.open.path('resourcepacks'); break;
        case 'folder-shaders': await api.open.path('shaderpacks'); break;
        case 'folder-logs': await api.open.path('logs'); break;
        case 'min': await api.window.minimize(); break;
        case 'close': await api.window.close(); break;
      }
    } catch (e) {
      toast('warn', e.message, 'warn');
    }
  }

  $('.logo').addEventListener('click', () => show('home'));

  // ------------------------------------------------------------------ status line and toast

  const statusTimers = {};
  function status(page, ic, text, kind = '', extra) {
    const el = $(`.page[data-page="${page}"] [data-status]`);
    if (!el) return toast(ic, text, kind);
    el.innerHTML = `<span class="chip-ic ${kind}">${icon(ic)}</span><span>${esc(text)}</span>`;
    if (extra) el.appendChild(extra);
    el.getAnimations().forEach(a => a.cancel());
    el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { duration: 350, easing: 'cubic-bezier(.2,.8,.2,1)' });
    clearTimeout(statusTimers[page]);
    statusTimers[page] = setTimeout(() => {
      el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400, fill: 'forwards' }).onfinish = () => {
        el.innerHTML = '';
        el.getAnimations().forEach(a => a.cancel());
      };
    }, extra ? 6000 : 4200);
  }

  let toastTimer;
  function toast(ic, text, kind = '') {
    const el = $('#toast');
    el.querySelector('.chip-ic').className = 'chip-ic ' + kind;
    el.querySelector('.chip-ic').innerHTML = icon(ic);
    el.querySelector('.toast-text').textContent = text;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 3200);
  }

  // ------------------------------------------------------------------ rows that arrive and leave

  const EASE = 'cubic-bezier(.2,.8,.2,1)';

  function effects(row, { flash = true, shine = true } = {}) {
    if (flash) {
      let f = row.querySelector('.flash');
      if (!f) { f = document.createElement('span'); f.className = 'flash'; row.prepend(f); }
      f.animate([{ opacity: .22 }, { opacity: 0 }], { duration: 900, easing: 'cubic-bezier(.3,0,.6,1)' });
    }
    if (shine) {
      let s = row.querySelector('.shine');
      if (!s) { s = document.createElement('span'); s.className = 'shine'; row.prepend(s); }
      s.animate([{ transform: 'translateX(-120%)' }, { transform: 'translateX(260%)' }], { duration: 700, easing: 'ease-in-out' });
    }
  }

  // grows its slot open first and then slides into it, so it never shows through the rows it pushes
  function arrive(wrap) {
    const row = wrap.firstElementChild;
    const h = wrap.offsetHeight;
    wrap.animate([{ height: '0px' }, { height: h + 'px' }], { duration: 260, easing: EASE });
    row.animate([{ opacity: 0, transform: 'translateX(-18px)' }, { opacity: 1, transform: 'none' }],
      { duration: 330, delay: 100, easing: EASE, fill: 'backwards' });
    setTimeout(() => effects(row), 120);
  }

  // slides out to the right and fades, and only then closes its slot
  function leave(wrap, done) {
    const row = wrap.firstElementChild;
    const h = wrap.offsetHeight;
    wrap.style.pointerEvents = 'none';
    row.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(28px)' }],
      { duration: 210, easing: 'cubic-bezier(.5,0,.75,0)', fill: 'forwards' });
    wrap.animate([{ height: h + 'px' }, { height: '0px' }], { duration: 260, delay: 170, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'forwards' })
      .onfinish = () => { wrap.remove(); if (done) done(); };
  }

  // ------------------------------------------------------------------ mods

  const modList = $('#modList');
  const hueOf = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;

  function modIcon(m) {
    if (m.icon) return `<span class="row-icon has-img"><img src="${m.icon}" alt=""></span>`;
    const h = hueOf(m.name);
    const letters = m.name.replace(/[^A-Za-zА-Яа-я0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
    return `<span class="row-icon" style="background:linear-gradient(135deg,hsl(${h} 42% 40%),hsl(${(h + 40) % 360} 46% 26%))">${esc(letters)}</span>`;
  }

  function modRow(m) {
    const wrap = document.createElement('div');
    wrap.className = 'row-wrap';
    wrap.dataset.id = m.key;
    const badge = m.builtin
      ? (m.missing ? '<span class="pill bad">нет файла</span>' : '<span class="pill accent">встроен</span>')
      : (m.warn ? `<span class="pill warn">${esc(m.warn)}</span>` : '');
    const desc = m.builtin ? m.description : (m.description || m.file);
    wrap.innerHTML = `
      <div class="row ${m.enabled ? '' : 'off'}">
        ${modIcon(m)}
        <div class="row-text">
          <div class="row-title"><span class="name">${esc(m.name)}</span><span class="pill">${esc(m.version)}</span>${badge}</div>
          <div class="row-sub" title="${esc(m.file || '')}">${esc(desc)}</div>
        </div>
        <span class="row-meta">${m.size ? fmtBytes(m.size) : ''}</span>
        <div class="row-actions">
          ${m.builtin
            ? `<span class="lock" title="Без него клиент не запустится">${icon('lock')}</span>`
            : `<button class="switch ${m.enabled ? 'on' : ''}" data-mod-toggle title="Включить или выключить"></button>
               <button class="icon-btn danger" data-mod-remove title="Удалить">${icon('trash')}</button>`}
        </div>
      </div>`;
    return wrap;
  }

  function allMods() {
    return [...state.builtin, ...state.mods];
  }

  function modGroups() {
    const q = $('#modSearch').value.trim().toLowerCase();
    const match = m => !q || m.name.toLowerCase().includes(q) || (m.description || '').toLowerCase().includes(q) || (m.file || '').toLowerCase().includes(q);
    return [
      { key: 'builtin', label: 'Встроенные', mods: state.builtin.filter(match) },
      { key: 'user', label: 'Ваши моды', mods: state.mods.filter(match) },
    ];
  }

  function renderMods() {
    modList.innerHTML = '';
    let any = false;
    for (const g of modGroups()) {
      if (!g.mods.length && g.key === 'builtin') continue;
      const label = document.createElement('div');
      label.className = 'group-label';
      label.dataset.group = g.key;
      label.innerHTML = `${g.label} · <span>${g.mods.length}</span>`;
      modList.appendChild(label);
      const box = document.createElement('div');
      box.dataset.box = g.key;
      g.mods.forEach(m => box.appendChild(modRow(m)));
      modList.appendChild(box);
      any ||= g.mods.length > 0;
    }
    if (!state.mods.length && !$('#modSearch').value) {
      modList.insertAdjacentHTML('beforeend', '<div class="list-empty">Своих модов пока нет. Найдите их на Modrinth или CurseForge, либо добавьте .jar</div>');
    } else if (!any) {
      modList.insertAdjacentHTML('beforeend', '<div class="list-empty">Ничего не нашлось</div>');
    }
    countMods();
  }

  function countMods() {
    const on = state.mods.filter(m => m.enabled).length;
    const text = `${on} ${plural(on, 'мод', 'мода', 'модов')}`;
    $$('[data-mods-text]').forEach(el => el.textContent = text);
    const nav = $('#navMods');
    if (nav.textContent !== String(on)) {
      nav.textContent = on;
      nav.classList.remove('bump');
      void nav.offsetWidth;
      nav.classList.add('bump');
    }
    const label = $('[data-group="user"] span', modList);
    if (label) label.textContent = state.mods.length;
  }

  async function loadMods() {
    const [list, builtin] = await Promise.all([api.mods.list(), api.mods.builtin()]);
    state.mods = list.map(m => ({ ...m, key: m.file, builtin: false }));
    state.builtin = builtin.map(b => ({
      ...b, key: b.id, builtin: true, enabled: true,
      description: b.size ? 'Нужен модам Fabric' : 'Скачается при первом запуске',
    }));
    showBuild();
  }

  // the mods folder can change behind the loader's back; the list follows without losing its place
  let modsSignature = '';
  const signature = () => JSON.stringify(allMods().map(m => [m.key, m.enabled, m.version, m.size]));
  async function refreshMods(arrivals = []) {
    try {
      const before = new Set(state.mods.map(m => m.key));
      await loadMods();
      const now = signature();
      if (now === modsSignature && !arrivals.length) return;
      modsSignature = now;
      if (shelves.mods.source === 'installed') renderMods();
      else countMods();
      for (const m of state.mods) {
        if (!before.has(m.key) && arrivals.includes(m.key)) {
          const wrap = $(`.row-wrap[data-id="${CSS.escape(m.key)}"]`, modList);
          if (wrap) arrive(wrap);
        }
      }
    } catch (e) {
      status('mods', 'warn', 'Список модов не прочитался: ' + e.message, 'warn');
    }
  }
  addEventListener('focus', () => { if (state.page === 'mods' || state.page === 'packs' || state.page === 'shaders') showShelf(state.page); });

  modList.addEventListener('click', async e => {
    const wrap = e.target.closest('.row-wrap');
    if (!wrap) return;
    const m = state.mods.find(x => x.key === wrap.dataset.id);
    if (!m) return;
    if (e.target.closest('[data-mod-toggle]')) {
      const on = !m.enabled;
      try {
        await api.mods.toggle(m.file, on);
      } catch (err) {
        status('mods', 'warn', `Не получилось: ${err.message}`, 'warn');
        return;
      }
      m.enabled = on;
      e.target.closest('[data-mod-toggle]').classList.toggle('on', on);
      wrap.firstElementChild.classList.toggle('off', !on);
      if (on) effects(wrap.firstElementChild, { shine: false });
      status('mods', on ? 'check' : 'minus', on ? `«${m.name}» включён` : `«${m.name}» выключен - при запуске он не загрузится`, on ? 'good' : '');
      countMods();
      modsSignature = signature();
    } else if (e.target.closest('[data-mod-remove]')) {
      let token;
      try {
        token = await api.mods.remove(m.file);
      } catch (err) {
        status('mods', 'warn', `Не получилось удалить: ${err.message}`, 'warn');
        return;
      }
      state.mods = state.mods.filter(x => x !== m);
      modsSignature = signature();
      leave(wrap, countMods);
      const undo = document.createElement('button');
      undo.className = 'undo';
      undo.innerHTML = `${icon('undo')}Вернуть`;
      undo.onclick = async () => {
        try {
          await api.mods.restore(token);
          await refreshMods([m.key]);
          status('mods', 'undo', `«${m.name}» снова на месте`, 'good');
        } catch (err) {
          status('mods', 'warn', `Не вернулся: ${err.message}`, 'warn');
        }
      };
      status('mods', 'trash', `«${m.name}» удалён`, 'bad', undo);
      setTimeout(countMods, 450);
    }
  });

  async function addFiles(paths) {
    if (!paths.length) return;
    let results;
    try {
      results = await api.mods.add(paths);
    } catch (e) {
      status('mods', 'warn', e.message, 'warn');
      return;
    }
    const added = results.filter(r => !r.error);
    const failed = results.filter(r => r.error);
    await refreshMods(added.map(r => r.file));
    if (added.length === 1) {
      status('mods', 'plus', added[0].replaced ? `«${added[0].name}» обновлён` : `Мод «${added[0].name}» добавлен`, 'good');
    } else if (added.length > 1) {
      status('mods', 'plus', `Добавлено ${added.length} ${plural(added.length, 'мод', 'мода', 'модов')}`, 'good');
    }
    if (failed.length) {
      setTimeout(() => status('mods', 'warn', `«${failed[0].file}» - ${failed[0].error}`, 'warn'), added.length ? 1400 : 0);
    }
  }

  $('#modAdd').addEventListener('click', async () => addFiles(await api.pick('jar')));
  $('#modSearch').addEventListener('input', () => onShelfQuery('mods'));

  // a file dragged over any part of the window
  let dragDepth = 0;
  const drop = $('#drop');
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  const isImage = f => /^image\/(png|jpeg|webp)$/.test(f.type);
  addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (dragDepth++ === 0) {
      // pictures become the background, anything else goes to the mods
      const items = [...e.dataTransfer.items];
      const pictures = items.length > 0 && items.every(i => i.kind === 'file' && isImage(i));
      const dropHere = state.page === 'shaders'
        ? ['Отпустите, чтобы добавить шейдер', 'Файл .zip']
        : state.page === 'packs'
          ? ['Отпустите, чтобы добавить ресурспак', 'Файл .zip']
          : ['Отпустите, чтобы добавить мод', `Файлы .jar для Fabric · Minecraft ${boot?.config.minecraft || ''}`];
      $('#dropTitle').textContent = pictures ? 'Отпустите, чтобы поставить фон' : dropHere[0];
      $('#dropSub').textContent = pictures ? 'PNG, JPG или WebP, лучше от 1920×1080' : dropHere[1];
      $('.drop-icon use').setAttribute('href', pictures ? '#i-image' : '#i-plus');
    }
    drop.classList.add('on');
  });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('dragleave', e => { if (!hasFiles(e)) return; if (--dragDepth <= 0) { dragDepth = 0; drop.classList.remove('on'); } });
  addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    drop.classList.remove('on');
    const files = [...e.dataTransfer.files];
    const pictures = files.filter(isImage), rest = files.filter(f => !isImage(f));
    if (pictures.length) loadBackground(api.pathOf(pictures[0]));
    if (rest.length) {
      const jars = rest.filter(f => /\.jar$/i.test(f.name));
      const zips = rest.filter(f => /\.zip$/i.test(f.name));
      if (jars.length) {
        show('mods');
        setTimeout(() => addFiles(jars.map(f => api.pathOf(f)).filter(Boolean)), 250);
      }
      if (zips.length) {
        const page = state.page === 'shaders' ? 'shaders' : 'packs';
        show(page);
        setTimeout(() => addLocal(page, zips.map(f => api.pathOf(f)).filter(Boolean)), jars.length ? 400 : 250);
      }
    }
  });

  // ------------------------------------------------------------------ logs

  const logState = { id: 'game', text: '', filter: '', timer: 0, stickBottom: true };
  const LOG_META = {
    game: 'Лог игры · latest.log',
    output: 'Консоль Java · game-output.log',
    launcher: 'Лог лаунчера · launcher.log',
  };

  function colorizeLogLine(raw) {
    const line = String(raw ?? '');
    if (/^\s+at\s|^\s+Caused by:|^\s+\.\.\. \d+ more|^\s*Exception|^\s*Error|^\s*java\.|^\s*net\.|^\s*com\./.test(line)) {
      const isHead = /^\s*(?:Caused by:|Exception|Error|java\.[a-zA-Z0-9_.]*(?:Exception|Error))/i.test(line);
      return `<span class="log-line stack${isHead ? ' stack-head' : ''}">${esc(line)}</span>`;
    }
    const mc = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+\[([^/\]]+)\/(INFO|WARN|ERROR|FATAL|DEBUG|TRACE)\]:?\s*(.*)$/i);
    if (mc) {
      const level = mc[3].toLowerCase();
      return `<span class="log-line level-${level}"><span class="t">[${esc(mc[1])}]</span> [<span class="th">${esc(mc[2])}</span>/<span class="lv lv-${level}">${esc(mc[3].toUpperCase())}</span>]${mc[4] ? `: <span class="msg">${esc(mc[4])}</span>` : ''}</span>`;
    }
    const mc2 = line.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+\[([^/\]]+)\/(INFO|WARN|ERROR|FATAL|DEBUG|TRACE)\]\s+(\([^)]*\))\s*(.*)$/i);
    if (mc2) {
      const level = mc2[3].toLowerCase();
      return `<span class="log-line level-${level}"><span class="t">[${esc(mc2[1])}]</span> [<span class="th">${esc(mc2[2])}</span>/<span class="lv lv-${level}">${esc(mc2[3].toUpperCase())}</span>] <span class="th">${esc(mc2[4])}</span> <span class="msg">${esc(mc2[5])}</span></span>`;
    }
    const iso = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s*(.*)$/);
    if (iso) {
      const rest = iso[2];
      const bad = /error|fail|exception/i.test(rest);
      const warn = /warn/i.test(rest);
      const level = bad ? 'error' : warn ? 'warn' : 'info';
      return `<span class="log-line level-${level}"><span class="t">[${esc(iso[1])}]</span> <span class="msg">${esc(rest)}</span></span>`;
    }
    const plain = line.match(/^(INFO|WARN|ERROR|FATAL|DEBUG|TRACE)\s*[:\-]?\s*(.*)$/i);
    if (plain) {
      const level = plain[1].toLowerCase();
      return `<span class="log-line level-${level}"><span class="lv lv-${level}">${esc(plain[1].toUpperCase())}</span> <span class="msg">${esc(plain[2])}</span></span>`;
    }
    if (/error|exception|failed/i.test(line)) return `<span class="log-line level-error"><span class="msg">${esc(line)}</span></span>`;
    if (/warn/i.test(line)) return `<span class="log-line level-warn"><span class="msg">${esc(line)}</span></span>`;
    return `<span class="log-line"><span class="msg">${esc(line)}</span></span>`;
  }

  function renderLogView() {
    const view = $('#logView');
    const q = logState.filter.trim().toLowerCase();
    const lines = logState.text ? logState.text.split('\n') : [];
    const matched = q ? lines.filter(line => line.toLowerCase().includes(q)) : lines;
    const nearBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 48;
    if (!matched.length) {
      view.innerHTML = `<div class="log-empty">${logState.text ? 'Ничего не нашлось по фильтру' : 'Логов пока нет - запустите игру'}</div>`;
      return;
    }
    const maxPaint = 2500;
    const paint = matched.length > maxPaint ? matched.slice(-maxPaint) : matched;
    const head = matched.length > maxPaint
      ? `<div class="log-empty" style="padding:8px 0 12px">Показаны последние ${maxPaint} из ${matched.length}</div>`
      : '';
    view.innerHTML = head + paint.map(colorizeLogLine).join('');
    if (logState.stickBottom || nearBottom) view.scrollTop = view.scrollHeight;
  }

  async function loadLogs({ quiet } = {}) {
    try {
      const data = await api.logs.read(logState.id);
      logState.id = data.id;
      logState.text = data.text || '';
      setSeg($('#logSource'), logState.id);
      const src = (data.sources || []).find(s => s.id === logState.id);
      const bits = [LOG_META[logState.id] || 'Лог'];
      if (data.truncated) bits.push('показан хвост файла');
      if (src?.size) bits.push(fmtBytes(src.size));
      if (data.lineCount) bits.push(`${data.lineCount} строк`);
      $('#logMeta').innerHTML = `<svg class="ic"><use href="#i-log"/></svg><span>${esc(bits.join(' · '))}</span>`;
      renderLogView();
    } catch (e) {
      if (!quiet) status('logs', 'warn', e.message, 'warn');
      $('#logView').innerHTML = `<div class="log-empty">${esc(e.message)}</div>`;
    }
  }

  function armLogPoll() {
    clearInterval(logState.timer);
    logState.timer = setInterval(() => {
      if (state.page === 'logs' && !document.hidden) loadLogs({ quiet: true });
    }, 2500);
  }

  $('#logSource').addEventListener('click', e => {
    const button = e.target.closest('button');
    if (!button?.dataset.v) return;
    logState.id = button.dataset.v;
    logState.stickBottom = true;
    setSeg($('#logSource'), logState.id);
    loadLogs();
  });
  $('#logSearch').addEventListener('input', e => {
    logState.filter = e.target.value;
    renderLogView();
  });
  $('#logRefresh').addEventListener('click', () => {
    logState.stickBottom = true;
    loadLogs();
  });
  $('#logOpenExt').addEventListener('click', async () => {
    try {
      const result = await api.logs.open(logState.id);
      if (result) toast('log', result);
    } catch (e) {
      status('logs', 'warn', e.message, 'warn');
    }
  });
  $('#logCopy').addEventListener('click', async () => {
    try {
      const q = logState.filter.trim().toLowerCase();
      const lines = logState.text ? logState.text.split('\n') : [];
      const textToCopy = q ? lines.filter(line => line.toLowerCase().includes(q)).join('\n') : (logState.text || '');
      if (!textToCopy) {
        status('logs', 'warn', 'Лог пуст', 'warn');
        return;
      }
      await navigator.clipboard.writeText(textToCopy);
      status('logs', 'check', q ? 'Отфильтрованные строки скопированы' : 'Лог скопирован в буфер', 'good');
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = logState.text || '';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        status('logs', 'check', 'Лог скопирован в буфер', 'good');
      } catch (e) {
        status('logs', 'warn', 'Не удалось скопировать', 'warn');
      }
    }
  });
  $('#logView').addEventListener('scroll', () => {
    const view = $('#logView');
    logState.stickBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 48;
  });
  addEventListener('focus', () => { if (state.page === 'logs') loadLogs({ quiet: true }); });
  armLogPoll();

  // ------------------------------------------------------------------ Modrinth, CurseForge, resource packs, shaders

  const shelves = {
    mods: { source: 'installed', hits: [], seq: 0, timer: 0 },
    packs: { source: 'installed', hits: [], seq: 0, timer: 0 },
    shaders: { source: 'installed', hits: [], seq: 0, timer: 0 },
  };
  const SHELF = {
    mods: { kind: 'mod', list: '#modList', search: '#modSearch', source: '#modSource', words: ['мод', 'мода', 'модов'], placeholder: 'Поиск по модам' },
    packs: { kind: 'resourcepack', list: '#packList', search: '#packSearch', source: '#packSource', words: ['ресурспак', 'ресурспака', 'ресурспаков'], placeholder: 'Поиск по ресурспакам' },
    shaders: { kind: 'shader', list: '#shaderList', search: '#shaderSearch', source: '#shaderSource', words: ['шейдер', 'шейдера', 'шейдеров'], placeholder: 'Поиск по шейдерам' },
  };
  const stateKey = { packs: 'packs', shaders: 'shaders' };

  function fmtCount(n) {
    if (n >= 1000000) return `${String(Math.round(n / 100000) / 10).replace('.', ',')} млн`;
    if (n >= 1000) return `${String(Math.round(n / 100) / 10).replace('.', ',')} тыс.`;
    return String(n || 0);
  }

  function remoteHint(page, source) {
    const mc = boot?.config.minecraft || '';
    const where = source === 'curseforge' ? 'CurseForge' : 'Modrinth';
    if (page === 'shaders') return `${where} · Minecraft ${mc}. Если Iris не стоит, он скачается вместе с шейдером`;
    if (page === 'packs') return `${where} · Minecraft ${mc}. Ресурспак включится сам`;
    return `${where} · Fabric · Minecraft ${mc}. Нажмите на мод, чтобы выбрать версию`;
  }

  function catalogIcon(hit) {
    const letters = hit.name.replace(/[^A-Za-zА-Яа-я0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
    const h = hueOf(hit.name);
    const img = /^https:\/\//.test(hit.icon) ? `<img src="${esc(hit.icon)}" alt="">` : '';
    return `<span class="row-icon web">${esc(letters)}${img}</span>`;
  }

  function wireIcons(root) {
    $$('img', root).forEach(img => img.addEventListener('error', () => img.remove()));
  }

  function renderRemote(page) {
    const spec = SHELF[page];
    const shelf = shelves[page];
    const list = $(spec.list);
    list.innerHTML = '';
    if (!shelf.hits.length) {
      list.innerHTML = '<div class="list-empty">Ничего не нашлось для этой версии Minecraft</div>';
      return;
    }
    for (const hit of shelf.hits) {
      const wrap = document.createElement('div');
      wrap.className = 'row-wrap';
      wrap.dataset.project = hit.id;
      const sub = [hit.author, hit.description].filter(Boolean).join(' · ');
      wrap.innerHTML = `
        <div class="row remote">
          ${catalogIcon(hit)}
          <div class="row-text">
            <div class="row-title"><span class="name">${esc(hit.name)}</span><span class="pill">${esc(fmtCount(hit.downloads))}</span></div>
            <div class="row-sub">${esc(sub)}</div>
          </div>
          <div class="row-actions">
            <button class="btn wash small" data-install ${hit.installed ? '' : ''}>${hit.installed ? 'Обновить' : 'Скачать'}</button>
          </div>
        </div>`;
      list.appendChild(wrap);
    }
    wireIcons(list);
  }

  async function runSearch(page) {
    const shelf = shelves[page];
    const spec = SHELF[page];
    const seq = ++shelf.seq;
    closePreview();
    const list = $(spec.list);
    list.innerHTML = '<div class="list-empty">Ищем…</div>';
    try {
      const hits = await api.catalog.search(shelf.source, spec.kind, $(spec.search).value.trim());
      if (seq !== shelf.seq) return;
      shelf.hits = hits;
      renderRemote(page);
    } catch (e) {
      if (seq !== shelf.seq) return;
      list.innerHTML = '<div class="list-empty">Поиск не удался</div>';
      status(page, 'warn', e.message, 'warn');
    }
  }

  function queueSearch(page) {
    const shelf = shelves[page];
    clearTimeout(shelf.timer);
    shelf.timer = setTimeout(() => runSearch(page), 280);
  }

  function setShelfSource(page, source) {
    closePreview();
    const shelf = shelves[page];
    shelf.source = source;
    const spec = SHELF[page];
    $(`.page[data-page="${page}"]`).classList.toggle('browsing', source !== 'installed');
    setSeg($(spec.source), source);
    const input = $(spec.search);
    input.placeholder = source === 'installed' ? spec.placeholder : `Поиск на ${source === 'curseforge' ? 'CurseForge' : 'Modrinth'}`;
    const hint = $(`#${spec.source.slice(1, -6)}RemoteHint`);
    if (hint) hint.textContent = remoteHint(page, source);
    if (source === 'installed') {
      if (page === 'mods') renderMods();
      else renderShelf(page);
    } else runSearch(page);
  }

  function onShelfQuery(page) {
    if (shelves[page].source === 'installed') {
      if (page === 'mods') renderMods();
      else renderShelf(page);
    } else queueSearch(page);
  }

  function showShelf(page) {
    if (shelves[page].source === 'installed') {
      if (page === 'mods') refreshMods();
      else refreshShelf(page);
    }
  }

  async function installHit(page, hit, button, versionId) {
    const idle = versionId ? 'Скачать выбранную версию' : (hit.installed ? 'Обновить' : 'Скачать');
    button.disabled = true;
    button.textContent = 'Скачиваем';
    try {
      const result = await api.catalog.install(hit.source, SHELF[page].kind, hit.id, versionId || undefined);
      hit.installed = true;
      button.textContent = 'Готово';
      const extra = (result.extra || []).slice(0, 3);
      let text = `«${result.name || hit.name}» скачан`;
      if (result.iris) {
        const rest = extra.filter(name => !/iris/i.test(name));
        text = rest.length
          ? `«${result.name || hit.name}» скачан. Поставил Iris и ${rest.join(', ')}`
          : `«${result.name || hit.name}» скачан. Поставил Iris, чтобы шейдер включился`;
      }
      else if (extra.length) text = `«${result.name || hit.name}» скачан, вместе с ним: ${extra.join(', ')}`;
      status(page, 'check', text, 'good');
      const rowBtn = $(`${SHELF[page].list} .row-wrap[data-project="${CSS.escape(hit.id)}"] [data-install]`);
      if (rowBtn && rowBtn !== button) {
        rowBtn.disabled = true;
        rowBtn.textContent = 'Готово';
      }
      if (page === 'mods' || result.iris || extra.length) await refreshMods();
      if (page !== 'mods') await refreshShelf(page);
    } catch (e) {
      button.disabled = false;
      button.textContent = idle;
      status(page, 'warn', e.message, 'warn');
    }
  }

  function countShelf(page) {
    const items = state[stateKey[page]] || [];
    const on = items.filter(item => item.enabled).length;
    const nav = page === 'packs' ? $('#navPacks') : $('#navShaders');
    if (nav && nav.textContent !== String(on)) {
      nav.textContent = on;
      nav.classList.remove('bump');
      void nav.offsetWidth;
      nav.classList.add('bump');
    }
  }

  function shelfRow(page, item) {
    const wrap = document.createElement('div');
    wrap.className = 'row-wrap';
    wrap.dataset.file = item.file;
    const letters = item.name.replace(/[^A-Za-zА-Яа-я0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
    const h = hueOf(item.name);
    wrap.innerHTML = `
      <div class="row ${item.enabled ? '' : 'off'}">
        <span class="row-icon" style="background:linear-gradient(135deg,hsl(${h} 42% 40%),hsl(${(h + 40) % 360} 46% 26%))">${esc(letters)}</span>
        <div class="row-text">
          <div class="row-title"><span class="name">${esc(item.name)}</span>${item.enabled ? '<span class="pill accent">включён</span>' : ''}</div>
          <div class="row-sub">${esc(item.description || item.file)}</div>
        </div>
        <span class="row-meta">${item.folder ? 'папка' : item.size ? fmtBytes(item.size) : ''}</span>
        <div class="row-actions">
          <button class="switch ${item.enabled ? 'on' : ''}" data-shelf-toggle title="Включить или выключить"></button>
          <button class="icon-btn danger" data-shelf-remove title="Удалить">${icon('trash')}</button>
        </div>
      </div>`;
    return wrap;
  }

  function renderShelf(page) {
    const spec = SHELF[page];
    const list = $(spec.list);
    const q = $(spec.search).value.trim().toLowerCase();
    const items = (state[stateKey[page]] || []).filter(item => !q || item.name.toLowerCase().includes(q) || (item.description || '').toLowerCase().includes(q));
    list.innerHTML = '';
    if (!items.length) {
      list.innerHTML = `<div class="list-empty">${q ? 'Ничего не нашлось' : page === 'shaders' ? 'Шейдеров пока нет. Найдите их на Modrinth или CurseForge' : 'Ресурспаков пока нет. Найдите их на Modrinth или CurseForge'}</div>`;
    } else items.forEach(item => list.appendChild(shelfRow(page, item)));
    countShelf(page);
  }

  async function loadShelf(page) {
    state[stateKey[page]] = await api.packs.list(SHELF[page].kind);
    countShelf(page);
  }

  async function refreshShelf(page) {
    try {
      await loadShelf(page);
      if (shelves[page].source === 'installed') renderShelf(page);
    } catch (e) {
      status(page, 'warn', e.message, 'warn');
    }
  }

  async function addLocal(page, paths) {
    if (!paths.length) return;
    try {
      const results = await api.packs.add(SHELF[page].kind, paths);
      const added = results.filter(r => !r.error);
      const failed = results.filter(r => r.error);
      await refreshShelf(page);
      if (added.length) status(page, 'plus', added.length === 1 ? `«${added[0].name}» добавлен` : `Добавлено ${added.length}`, 'good');
      if (failed.length) setTimeout(() => status(page, 'warn', `«${failed[0].file}» - ${failed[0].error}`, 'warn'), added.length ? 1400 : 0);
    } catch (e) {
      status(page, 'warn', e.message, 'warn');
    }
  }

  const previewEl = $('#preview');
  const previewState = { page: '', hit: null, versions: [], picked: '', seq: 0 };
  const VER_TYPE = { release: 'релиз', beta: 'бета', alpha: 'альфа' };

  function closePreview() {
    previewState.seq++;
    previewEl.classList.remove('on');
    previewEl.hidden = true;
  }

  function fmtDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function paintPreviewIcon(url, name) {
    const el = $('#previewIcon');
    const seq = previewState.seq;
    const letters = String(name || '?').replace(/[^A-Za-zА-Яа-я0-9 ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
    el.replaceChildren(document.createTextNode(letters));
    if (!/^https:\/\//.test(url || '')) return;
    const img = new Image();
    img.alt = '';
    img.onload = () => { if (seq === previewState.seq) el.replaceChildren(img); };
    img.src = url;
  }

  function renderVersions() {
    const box = $('#previewVersions');
    box.replaceChildren();
    const button = $('#previewInstall');
    if (!previewState.versions.length) {
      box.innerHTML = '<div class="list-empty">Для этой версии Minecraft файлов нет</div>';
      button.disabled = true;
      return;
    }
    button.disabled = false;
    button.textContent = 'Скачать выбранную версию';
    for (const version of previewState.versions) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ver' + (version.id === previewState.picked ? ' on' : '');
      const games = (version.gameVersions || []).join(', ');
      row.innerHTML = `<b>${esc(version.number)}</b><span class="pill">${esc(VER_TYPE[version.type] || 'релиз')}</span>${games ? `<span class="pill">${esc(games)}</span>` : ''}<small>${esc([fmtDate(version.date), version.filename].filter(Boolean).join(' · '))}</small>`;
      row.addEventListener('click', () => {
        previewState.picked = version.id;
        $$('.ver', box).forEach(el => el.classList.toggle('on', el === row));
      });
      box.appendChild(row);
    }
  }

  async function openPreview(page, hit) {
    const seq = ++previewState.seq;
    previewState.page = page;
    previewState.hit = hit;
    previewState.versions = [];
    previewState.picked = '';
    previewEl.hidden = false;
    previewEl.classList.add('on');
    $('#previewName').textContent = hit.name;
    $('#previewSub').textContent = [hit.author, `${fmtCount(hit.downloads)} скачиваний`].filter(Boolean).join(' · ');
    $('#previewText').textContent = hit.description || 'Загружаем описание…';
    $('#previewMc').textContent = boot?.config.minecraft || '';
    $('#previewShots').replaceChildren();
    $('#previewVersions').innerHTML = '<div class="list-empty">Загружаем версии…</div>';
    $('#previewInstall').disabled = true;
    paintPreviewIcon(hit.icon, hit.name);
    try {
      const detail = await api.catalog.project(hit.source, SHELF[page].kind, hit.id);
      if (seq !== previewState.seq) return;
      previewState.hit = { ...hit, name: detail.name || hit.name, icon: detail.icon || hit.icon };
      if (detail.icon) paintPreviewIcon(detail.icon, previewState.hit.name);
      $('#previewName').textContent = previewState.hit.name;
      $('#previewText').textContent = detail.body || detail.description || hit.description || 'Описания нет';
      const shots = $('#previewShots');
      for (const shot of detail.gallery || []) {
        if (!/^https:\/\//.test(shot.url)) continue;
        const img = document.createElement('img');
        img.src = shot.url;
        img.alt = shot.title || '';
        img.title = shot.title || '';
        shots.appendChild(img);
      }
      previewState.versions = detail.versions || [];
      previewState.picked = (previewState.versions.find(v => v.type === 'release') || previewState.versions[0])?.id || '';
      renderVersions();
    } catch (e) {
      if (seq !== previewState.seq) return;
      $('#previewVersions').innerHTML = `<div class="list-empty">${esc(e.message)}</div>`;
    }
  }

  $('#previewClose').addEventListener('click', closePreview);
  addEventListener('keydown', e => { if (e.key === 'Escape' && previewEl.classList.contains('on')) closePreview(); });
  $('#previewInstall').addEventListener('click', () => {
    const { page, hit, picked } = previewState;
    if (!hit || !picked) return;
    installHit(page, hit, $('#previewInstall'), picked);
  });

  function bindShelf(page) {
    const spec = SHELF[page];
    $(spec.source).addEventListener('click', e => {
      const button = e.target.closest('button');
      if (button?.dataset.v) setShelfSource(page, button.dataset.v);
    });
    $(spec.search).addEventListener('input', () => onShelfQuery(page));
    $(spec.list).addEventListener('click', async e => {
      const install = e.target.closest('[data-install]');
      if (install) {
        const id = install.closest('.row-wrap')?.dataset.project;
        const hit = shelves[page].hits.find(item => item.id === id);
        if (hit) installHit(page, hit, install);
        return;
      }
      const wrap = e.target.closest('.row-wrap');
      if (!wrap) return;
      if (shelves[page].source !== 'installed') {
        const hit = shelves[page].hits.find(item => item.id === wrap.dataset.project);
        if (hit) openPreview(page, hit);
        return;
      }
      const item = (state[stateKey[page]] || []).find(entry => entry.file === wrap.dataset.file);
      if (!item) return;
      if (e.target.closest('[data-shelf-toggle]')) {
        const on = !item.enabled;
        try {
          await api.packs.toggle(SHELF[page].kind, item.file, on);
        } catch (err) {
          status(page, 'warn', err.message, 'warn');
          return;
        }
        if (page === 'shaders' && on) {
          for (const other of state.shaders) other.enabled = other === item;
        }
        item.enabled = on;
        renderShelf(page);
        const turned = $(`.row-wrap[data-file="${CSS.escape(item.file)}"] .row`, $(spec.list));
        if (turned && on) effects(turned, { shine: false });
        status(page, on ? 'check' : 'minus', on ? `«${item.name}» включён` : `«${item.name}» выключен`, on ? 'good' : '');
      } else if (e.target.closest('[data-shelf-remove]')) {
        let token;
        try {
          token = await api.packs.remove(SHELF[page].kind, item.file);
        } catch (err) {
          status(page, 'warn', err.message, 'warn');
          return;
        }
        state[stateKey[page]] = state[stateKey[page]].filter(entry => entry !== item);
        leave(wrap, () => countShelf(page));
        const undo = document.createElement('button');
        undo.className = 'undo';
        undo.innerHTML = `${icon('undo')}Вернуть`;
        undo.onclick = async () => {
          try {
            await api.packs.restore(SHELF[page].kind, token);
            await refreshShelf(page);
            status(page, 'undo', `«${item.name}» снова на месте`, 'good');
          } catch (err) {
            status(page, 'warn', err.message, 'warn');
          }
        };
        status(page, 'trash', `«${item.name}» удалён`, 'bad', undo);
      }
    });
  }

  bindShelf('packs');
  bindShelf('shaders');
  $('#modSource').addEventListener('click', e => {
    const button = e.target.closest('button');
    if (button?.dataset.v) setShelfSource('mods', button.dataset.v);
  });
  $('#modList').addEventListener('click', e => {
    const install = e.target.closest('[data-install]');
    const wrap = e.target.closest('.row-wrap');
    if (!wrap || shelves.mods.source === 'installed') return;
    const hit = shelves.mods.hits.find(item => item.id === wrap.dataset.project);
    if (!hit) return;
    if (install) installHit('mods', hit, install);
    else openPreview('mods', hit);
  });
  $('#packAdd').addEventListener('click', async () => addLocal('packs', await api.pick('zip')));
  $('#shaderAdd').addEventListener('click', async () => addLocal('shaders', await api.pick('zip')));

  // ------------------------------------------------------------------ accounts

  const accList = $('#accList');
  const NICK = /^[A-Za-z0-9_]{3,16}$/;
  const KIND = { offline: 'Офлайн', ely: 'Ely.by', microsoft: 'Microsoft' };
  const HINTS = {
    offline: '3-16 символов: латинские буквы, цифры и _. Сервер должен пускать без лицензии Mojang',
    ely: 'Ник или почта Ely.by. Пароль не сохраняется - только сессия. На лицензионный сервер так не зайти',
    microsoft: 'Лицензионный Minecraft. Браузер откроется сам, код появится здесь',
  };
  let buildText = 'Vanilla++';

  function kindOf(a) { return KIND[a?.type] || 'Офлайн'; }

  function saveAccounts() {
    save({ accounts: state.accounts.map(a => ({ ...a })), current: state.accountId || null }, true);
  }

  function renderSide() {
    const acc = state.accounts.find(a => a.id === state.accountId) || null;
    const box = $('#sideAvatar');
    box.innerHTML = '<span class="face round" style="--s:30px"></span>';
    paintFace(box.firstElementChild, state.nick || 'Steve', acc?.skinUrl);
    $('#sideName').textContent = state.nick || 'Без аккаунта';
    $('#sideSub').textContent = kindOf(acc);
    $$('[data-nick-upper]').forEach(el => el.textContent = state.nick ? state.nick.toUpperCase() : 'ИГРОК');
  }

  function accRow(acc) {
    const wrap = document.createElement('div');
    wrap.className = 'row-wrap';
    wrap.dataset.acc = acc.id;
    const current = acc.id === state.accountId;
    const sub = acc.type === 'offline' || !acc.type
      ? `${kindOf(acc)} · скин «${SKIN_NAMES[skinOf(acc.name)]}»`
      : kindOf(acc);
    wrap.innerHTML = `
      <div class="row acc ${current ? 'picked' : ''}">
        <span class="face-wrap"><span class="face" style="--s:32px"></span>${current ? `<span class="badge">${icon('check')}</span>` : ''}</span>
        <div class="row-text">
          <div class="row-title"><span class="name">${esc(acc.name)}</span>${current ? '<span class="pill accent">текущий</span>' : ''}<span class="pill">${esc(kindOf(acc))}</span></div>
          <div class="row-sub">${esc(sub)}</div>
        </div>
        <div class="row-actions">
          <button class="icon-btn danger" data-acc-remove title="Удалить">${icon('close')}</button>
        </div>
      </div>`;
    paintFace($('.face', wrap), acc.name, acc.skinUrl);
    return wrap;
  }

  function renderAccounts() {
    accList.innerHTML = '';
    state.accounts.forEach(a => accList.appendChild(accRow(a)));
    $('#accCount').textContent = state.accounts.length;
    if (!state.accounts.length) accList.innerHTML = '<div class="list-empty">Добавьте аккаунт, под которым будете играть</div>';
  }

  function setCurrent(id, { pop = true } = {}) {
    const acc = state.accounts.find(a => a.id === id) || null;
    state.accountId = acc?.id || '';
    state.nick = acc?.name || '';
    $$('[data-nick]').forEach(el => el.textContent = state.nick || 'Без аккаунта');
    $$('[data-face]').forEach(el => paintFace(el, state.nick || 'Steve', acc?.skinUrl));
    renderSide();
    const kind = $('#currentKind');
    if (!acc) kind.textContent = 'Добавьте аккаунт, чтобы играть';
    else if (acc.type === 'microsoft') kind.textContent = 'Microsoft · лицензия Minecraft';
    else if (acc.type === 'ely') kind.textContent = 'Ely.by · сессия этого лаунчера';
    else kind.textContent = `Офлайн · скин «${SKIN_NAMES[skinOf(state.nick || 'Steve')]}»`;
    const uuid = acc?.uuid || (state.nick ? uuidString(state.nick) : '');
    $('#uuidShort').textContent = uuid ? uuid.slice(0, 8) + '…' : 'UUID';
    $('#copyUuid').dataset.uuid = uuid;
    if (pop && acc) {
      const badge = $('#currentBadge');
      badge.classList.remove('pop');
      void badge.offsetWidth;
      badge.classList.add('pop');
      $('.current').animate([{ background: 'color-mix(in srgb, rgb(var(--accent)) 26%, rgb(255 255 255 / .04))' }, {}],
        { duration: 900, easing: 'ease-out' });
    }
    renderAccounts();
  }

  function upsertAccount(account) {
    const i = state.accounts.findIndex(a => a.id === account.id);
    if (i >= 0) state.accounts[i] = account;
    else state.accounts.push(account);
    setCurrent(account.id);
    saveAccounts();
  }

  accList.addEventListener('click', e => {
    const wrap = e.target.closest('.row-wrap');
    if (!wrap) return;
    const id = wrap.dataset.acc;
    const acc = state.accounts.find(a => a.id === id);
    if (!acc) return;
    if (e.target.closest('[data-acc-remove]')) {
      state.accounts = state.accounts.filter(a => a.id !== id);
      if (id === state.accountId) setCurrent(state.accounts[0]?.id || '', { pop: false });
      else renderAccounts();
      saveAccounts();
      status('accounts', 'trash', `Аккаунт ${acc.name} удалён`, 'bad');
      return;
    }
    if (id !== state.accountId) {
      setCurrent(id);
      saveAccounts();
      status('accounts', 'check', `Теперь вы играете как ${acc.name}`, 'good');
    }
  });

  const nickInput = $('#nickInput'), nickWell = nickInput.closest('.well'), nickHint = $('#nickHint');
  const previewFace = $('#previewFace');

  function checkNick() {
    const v = nickInput.value;
    paintFace(previewFace, v || 'Steve');
    nickWell.classList.toggle('blank', !v);
    const bad = v.length > 0 && !/^[A-Za-z0-9_]*$/.test(v);
    const short = v.length > 0 && v.length < 3;
    nickWell.classList.toggle('bad', bad);
    nickHint.classList.toggle('bad', bad);
    nickHint.textContent = bad ? 'Только латинские буквы, цифры и _'
      : short ? 'Ещё немного: от 3 символов'
      : v && state.accounts.some(a => a.type !== 'ely' && a.type !== 'microsoft' && a.name.toLowerCase() === v.toLowerCase()) ? 'Такой аккаунт уже есть - он станет текущим'
      : v ? `Скин по умолчанию - «${SKIN_NAMES[skinOf(v)]}»`
      : '3-16 символов: латинские буквы, цифры и _';
  }
  nickInput.addEventListener('input', checkNick);
  nickInput.addEventListener('keydown', e => { if (e.key === 'Enter') addAccount(); });

  function addAccount() {
    if (rollTarget) finishRoll();
    const v = nickInput.value.trim();
    if (!NICK.test(v)) {
      nickWell.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' },
        { transform: 'translateX(-3px)' }, { transform: 'translateX(0)' }], { duration: 320 });
      status('accounts', 'warn', v ? 'Такой ник игра не примет' : 'Введите ник или нажмите «Случайный»', 'warn');
      return;
    }
    const same = state.accounts.find(a => (a.type === 'offline' || !a.type) && a.name.toLowerCase() === v.toLowerCase());
    if (same) {
      setCurrent(same.id);
      saveAccounts();
      status('accounts', 'check', `Теперь вы играете как ${same.name}`, 'good');
    } else {
      upsertAccount({ id: `offline:${v.toLowerCase()}`, type: 'offline', name: v, uuid: uuidString(v) });
      status('accounts', 'plus', `Ник ${v} добавлен и выбран`, 'good');
    }
    nickInput.value = '';
    checkNick();
  }
  $('#nickAdd').addEventListener('click', addAccount);

  const NICK_A = ['Dark', 'Frost', 'Shadow', 'Neo', 'Lazy', 'Pink', 'Silent', 'Mint', 'Cyber', 'Night', 'Sakura', 'Toxic', 'Lucky', 'Wild', 'Soft', 'Void'];
  const NICK_B = ['Fox', 'Wolf', 'Cat', 'Blade', 'Ghost', 'Raven', 'Pixel', 'Storm', 'Byte', 'Bunny', 'Ninja', 'Petal', 'Bear', 'Moth'];
  function randomNick() {
    const a = NICK_A[(Math.random() * NICK_A.length) | 0], b = NICK_B[(Math.random() * NICK_B.length) | 0];
    const style = Math.random();
    const n = style < .4 ? a + b + ((Math.random() * 999) | 0)
      : style < .7 ? (a + '_' + b).toLowerCase()
      : a + b.toLowerCase() + '_' + ((Math.random() * 99) | 0);
    return n.slice(0, 16);
  }

  // the client's roll: letters spin and settle from the left, one after another
  let rolling = 0, rollTarget = null;
  function finishRoll() {
    rolling++;
    nickInput.value = rollTarget;
    rollTarget = null;
    checkNick();
  }
  nickInput.addEventListener('keydown', () => { if (rollTarget) finishRoll(); });
  $('#nickRandom').addEventListener('click', () => {
    const target = randomNick();
    rollTarget = target;
    const id = ++rolling;
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_';
    const start = performance.now(), per = 34, spinFor = 180;
    nickInput.focus();
    (function step(now) {
      if (id !== rolling) return;
      const t = now - start;
      let s = '';
      for (let i = 0; i < target.length; i++) {
        s += t > spinFor + i * per ? target[i] : chars[(Math.random() * chars.length) | 0];
      }
      nickInput.value = s;
      paintFace(previewFace, s);
      nickWell.classList.remove('blank');
      if (t < spinFor + target.length * per) requestAnimationFrame(step);
      else {
        rollTarget = null;
        nickInput.value = target;
        checkNick();
        nickWell.animate([{ background: 'rgb(var(--accent) / .3)' }, {}], { duration: 700, easing: 'ease-out' });
      }
    })(start);
  });

  $('#copyUuid').addEventListener('click', e => {
    const uuid = e.currentTarget.dataset.uuid;
    if (!uuid) return;
    navigator.clipboard?.writeText(uuid).catch(() => {});
    status('accounts', 'copy', `UUID скопирован: ${uuid}`);
  });

  function setAccKind(kind) {
    setSeg($('#accKind'), kind);
    $$('.acc-panel').forEach(p => p.classList.toggle('on', p.dataset.kind === kind));
    $('#nickHint').textContent = HINTS[kind] || HINTS.offline;
  }
  $('#accKind').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b?.dataset.v) setAccKind(b.dataset.v);
  });

  $('#elyGo').addEventListener('click', async () => {
    const username = $('#elyUser').value.trim();
    const password = $('#elyPass').value;
    if (!username || !password) {
      status('accounts', 'warn', 'Введите логин и пароль Ely.by', 'warn');
      return;
    }
    const btn = $('#elyGo');
    btn.disabled = true;
    try {
      const account = await api.auth.ely(username, password);
      $('#elyPass').value = '';
      upsertAccount(account);
      status('accounts', 'check', `Вошли как ${account.name}`, 'good');
    } catch (e) {
      status('accounts', 'warn', e.message, 'warn');
    } finally {
      btn.disabled = false;
    }
  });
  $('#elyPass').addEventListener('keydown', e => { if (e.key === 'Enter') $('#elyGo').click(); });

  let msBusy = false;
  let msUserCode = '';

  function copyMsCode() {
    const code = msUserCode || ($('#msCode').textContent || '').trim();
    if (!code || code === 'Ждём код…') return;
    navigator.clipboard?.writeText(code).catch(() => {});
    status('accounts', 'copy', `Код скопирован: ${code}`);
  }

  $('#msCode').addEventListener('click', copyMsCode);

  $('#msGo').addEventListener('click', async () => {
    if (msBusy) {
      await api.auth.microsoftCancel().catch(() => {});
      return;
    }
    msBusy = true;
    msUserCode = '';
    $('#msGoLabel').textContent = 'Отмена';
    $('#msBox').hidden = true;
    $('#msCode').disabled = true;
    $('#msCode').textContent = 'Ждём код…';
    const off = api.auth.onDevice(info => {
      msUserCode = (info.userCode || '').trim();
      $('#msBox').hidden = false;
      $('#msCode').textContent = msUserCode || 'Ждём код…';
      $('#msCode').disabled = !msUserCode;
      $('#msLink').textContent = (info.verificationUri || 'https://www.microsoft.com/link').replace(/^https?:\/\//, '');
      if (msUserCode) copyMsCode();
    });
    try {
      const account = await api.auth.microsoft();
      upsertAccount(account);
      $('#msBox').hidden = true;
      status('accounts', 'check', `Вошли как ${account.name}`, 'good');
    } catch (e) {
      $('#msBox').hidden = true;
      if (!/отмен/.test(e.message)) status('accounts', 'warn', e.message, 'warn');
    } finally {
      off();
      msBusy = false;
      msUserCode = '';
      $('#msGoLabel').textContent = 'Войти через Microsoft';
    }
  });

  // ------------------------------------------------------------------ memory

  const MIN_GB = 1, STEP = .5;
  const sys = { installed: 8, usable: 8, free: null };
  let max = 8, maxPick = 7, recLo = 3, recHi = 4;
  const slider = $('#ramSlider'), fill = $('#ramFill'), thumb = $('#ramThumb');
  const frac = gb => (gb - MIN_GB) / (max - MIN_GB);
  const half = v => Math.round(v * 2) / 2;
  const gbText = v => (Number.isInteger(v) ? String(v) : v.toFixed(1)).replace('.', ',');

  function layoutRam() {
    max = Math.max(2, Math.round(sys.installed));
    // the last gigabyte is never the game's: Windows needs somewhere to stand
    maxPick = Math.max(MIN_GB, max - 1);
    recLo = Math.min(4, Math.max(1.5, half(max * .35)));
    recHi = Math.min(8, max - 4);
    if (recHi < recLo + 1) recHi = Math.min(maxPick, Math.max(recLo + 1, half(max / 2)));

    const ticks = $('#ramTicks');
    ticks.innerHTML = '';
    const step = max <= 8 ? 2 : max <= 16 ? 4 : max <= 32 ? 8 : 16;
    const marks = [MIN_GB];
    for (let g = step; g < max - step * .4; g += step) marks.push(g);
    marks.push(max);
    marks.forEach((gb, i) => {
      const t = document.createElement('span');
      t.style.left = frac(gb) * 100 + '%';
      t.textContent = gb + (i === marks.length - 1 ? ' ГБ' : '');
      ticks.appendChild(t);
    });

    const zone = $('#ramZone');
    zone.style.left = frac(recLo) * 100 + '%';
    zone.style.width = (frac(recHi) - frac(recLo)) * 100 + '%';
    const reserved = $('#ramReserved');
    reserved.style.left = frac(maxPick) * 100 + '%';
    reserved.style.right = '0';

    const presets = $('#ramPresets');
    presets.innerHTML = '';
    const choices = max <= 6 ? [2, 3, 4] : max <= 8 ? [2, 3, 4, 5] : max <= 12 ? [2, 4, 6, 8]
      : max <= 16 ? [2, 4, 6, 8, 12] : [4, 6, 8, 12, 16];
    choices.filter(g => g <= max - 2).forEach(gb => {
      const b = document.createElement('button');
      b.textContent = gb + ' ГБ';
      b.dataset.gb = gb;
      b.onclick = () => setRam(gb, true);
      presets.appendChild(b);
    });
  }

  function setRam(gb, animate, quiet) {
    gb = Math.max(MIN_GB, Math.min(maxPick, half(gb)));
    slider.classList.toggle('anim', !!animate);
    const changed = gb !== state.ram;
    state.ram = gb;
    const p = frac(gb) * 100;
    fill.style.width = p + '%';
    thumb.style.left = p + '%';
    $('#ramValue').textContent = gb.toFixed(1).replace('.', ',');
    $$('[data-ram-text]').forEach(el => el.textContent = gbText(gb) + ' ГБ');
    $$('#ramPresets button').forEach(b => b.classList.toggle('on', +b.dataset.gb === gb));
    ramInfo();
    if (changed && !quiet) {
      save({ ram: gb });
      if (animate) status('settings', 'memory', `Игре выделено ${gbText(gb)} ГБ памяти`, 'good');
    }
  }

  function ramInfo() {
    const info = $('#ramInfo');
    const gb = state.ram;
    // what Windows itself has left: of what it can use, not of what is printed on the sticker
    const left = half(sys.usable - gb);
    const free = sys.free == null ? '' : ` · свободно сейчас ${gbText(Math.max(0, Math.round(sys.free * 10) / 10))} ГБ`;
    if (gb < 2) {
      info.className = 'ram-info warn';
      info.innerHTML = `${icon('warn')}Слишком мало: клиент с модами может не запуститься`;
    } else if (left < Math.min(3, sys.usable * .35)) {
      info.className = 'ram-info warn';
      info.innerHTML = `${icon('warn')}Системе останется ${gbText(Math.max(0, left))} ГБ - Windows и браузер начнут тормозить`;
    } else {
      info.className = 'ram-info';
      info.innerHTML = `${icon('memory')}Установлено ${gbText(half(sys.installed))} ГБ${free}`;
    }
  }

  function ramFromPointer(e) {
    const r = slider.getBoundingClientRect();
    return MIN_GB + Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (max - MIN_GB);
  }
  slider.addEventListener('pointerdown', e => {
    slider.setPointerCapture(e.pointerId);
    slider.classList.add('drag');
    setRam(ramFromPointer(e), true, true);
    setTimeout(() => slider.classList.remove('anim'), 350);
  });
  slider.addEventListener('pointermove', e => {
    if (slider.classList.contains('drag')) setRam(ramFromPointer(e), false, true);
  });
  const endDrag = () => {
    if (!slider.classList.contains('drag')) return;
    slider.classList.remove('drag');
    save({ ram: state.ram });
    status('settings', 'memory', `Игре выделено ${gbText(state.ram)} ГБ памяти`, 'good');
  };
  slider.addEventListener('pointerup', endDrag);
  slider.addEventListener('pointercancel', endDrag);
  slider.addEventListener('wheel', e => { e.preventDefault(); setRam(state.ram + (e.deltaY < 0 ? STEP : -STEP), true); }, { passive: false });

  async function readMemory() {
    const before = sys.installed;
    try {
      Object.assign(sys, await api.memory());
    } catch { /* keep the last reading */ }
    // the sticks' own number came in: the scale follows it
    if (Math.round(sys.installed) !== Math.round(before)) {
      layoutRam();
      setRam(state.ram, false, true);
    }
    ramInfo();
  }
  // what is free changes; while the settings are open, keep it current
  setInterval(() => { if (state.page === 'settings' && !document.hidden) readMemory(); }, 4000);

  // ------------------------------------------------------------------ switches, inputs, segmented, theme

  const SWITCH_TEXT = {
    bundledJava: on => on ? 'Java возьмём у Mojang' : 'Укажите путь к своей Java 25',
    particles: on => on ? 'Частицы включены' : 'Частицы выключены',
    fullscreen: on => on ? 'Игра запустится на весь экран' : 'Игра запустится в окне',
    autoAccent: on => on ? 'Цвет подбирается под фон' : 'Ручной выбор цвета',
  };

  function setSwitch(key, on) {
    const sw = $(`.switch[data-key="${key}"]`);
    if (sw) sw.classList.toggle('on', on);
    if (key === 'bundledJava') $('#javaPathRow').classList.toggle('shut', on);
    if (key === 'particles') canvas.classList.toggle('off', !on);
    if (key === 'autoAccent') {
      state.settings.autoAccent = on;
      if (on && picked) applyBackgroundAccent(picked, true);
    }
  }

  $$('.switch[data-key]').forEach(sw => sw.addEventListener('click', () => {
    const key = sw.dataset.key;
    const on = !sw.classList.contains('on');
    setSwitch(key, on);
    if (key === 'bundledJava') save({ javaMode: on ? 'bundled' : 'custom' });
    else save({ [key]: on });
    status('settings', on ? 'check' : 'minus', SWITCH_TEXT[key](on), on ? 'good' : '');
  }));

  function bindInput(id, key, { parse = v => v, check, done } = {}) {
    const input = $(id);
    input.addEventListener('change', () => {
      const value = parse(input.value.trim());
      if (check && !check(value)) {
        input.value = state.settings[key] ?? '';
        input.closest('.well').animate([{ background: 'rgb(221 127 129 / .25)' }, {}], { duration: 700 });
        return;
      }
      input.value = value;
      save({ [key]: value });
      if (done) done(value);
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
  }
  bindInput('#javaPath', 'javaPath', { done: v => status('settings', 'java', v ? 'Путь к Java сохранён' : 'Путь к Java очищен') });
  bindInput('#jvmArgs', 'jvmArgs', { done: () => status('settings', 'java', 'Аргументы JVM сохранены', 'good') });
  const size = (min, maxV) => ({ parse: v => parseInt(v, 10), check: v => Number.isFinite(v) && v >= min && v <= maxV });
  const sizeDone = () => status('settings', 'monitor', `Окно игры - ${state.settings.width}×${state.settings.height}`, 'good');
  bindInput('#resW', 'width', { ...size(640, 7680), done: sizeDone });
  bindInput('#resH', 'height', { ...size(360, 4320), done: sizeDone });

  $('#javaPick').addEventListener('click', async () => {
    const [file] = await api.pick('java');
    if (!file) return;
    $('#javaPath').value = file;
    save({ javaPath: file });
    status('settings', 'java', 'Java выбрана', 'good');
  });

  function placeSeg(seg) {
    const on = $('button.on', seg), wash = $('.seg-wash', seg);
    if (!on) return;
    wash.style.width = on.offsetWidth + 'px';
    wash.style.transform = `translateX(${on.offsetLeft - 3}px)`;
  }
  function setSeg(seg, value) {
    $$('button', seg).forEach(x => x.classList.toggle('on', x.dataset.v === value));
    placeSeg(seg);
  }
  $('#afterLaunch').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    setSeg($('#afterLaunch'), b.dataset.v);
    save({ afterLaunch: b.dataset.v });
    const what = { hide: 'лоадер свернётся', close: 'лоадер закроется', stay: 'лоадер останется открытым' }[b.dataset.v];
    status('settings', 'check', `После запуска игры ${what}`, 'good');
  });

  // the client's own themes, in its order and colours
  const THEMES = [
    ['Сакура', [244, 168, 190]], ['Вода', [149, 170, 255]], ['Кровь', [221, 127, 129]],
    ['Фиолетовая', [161, 127, 221]], ['Банановая', [221, 218, 127]], ['Малинка', [221, 127, 161]],
    ['Токсичная', [127, 221, 144]], ['Оранжевая', [221, 177, 127]], ['Прикольная', [194, 127, 221]],
  ];
  const FONTS = {
    noto: { label: 'Noto Sans', stack: "'Noto Sans', system-ui, sans-serif", title: "'Poppins', 'Noto Sans', sans-serif" },
    segoe: { label: 'Segoe UI', stack: "'Segoe UI', 'Noto Sans', sans-serif", title: "'Segoe UI', 'Noto Sans', sans-serif" },
    georgia: { label: 'Georgia', stack: "Georgia, 'Noto Sans', serif", title: "Georgia, 'Noto Sans', serif" },
    candara: { label: 'Candara', stack: "Candara, 'Noto Sans', sans-serif", title: "Candara, 'Noto Sans', sans-serif" },
    constantia: { label: 'Constantia', stack: "Constantia, 'Noto Sans', serif", title: "Constantia, 'Noto Sans', serif" },
  };
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) h = s = 0;
    else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return [h * 360, s, l];
  }
  function hslToRgb(h, s, l) {
    h /= 360;
    let r, g, b;
    if (s === 0) r = g = b = l;
    else {
      const hue2rgb = (p, q, t) => {
        if (t < 0) t += 1;
        if (t > 1) t -= 1;
        if (t < 1/6) return p + (q - p) * 6 * t;
        if (t < 1/2) return q;
        if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
        return p;
      };
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1/3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1/3);
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
  }
  let currentThemeMode = 'dark';
  function computeSmoke(rgb, isLight = (currentThemeMode === 'light')) {
    const [h, s, l] = rgbToHsl(...rgb);
    if (isLight) return [248, 248, 250];
    else {
      if (rgb[0] === 244 && rgb[1] === 168 && rgb[2] === 190) return [22, 12, 16];
      if (s < 0.05) return [17, 17, 19];
      const targetSat = Math.min(0.32, Math.max(0.18, s * 0.38));
      const targetLight = 0.068;
      return hslToRgb(h, targetSat, targetLight);
    }
  }

  function applyThemeMode(mode, instant) {
    currentThemeMode = mode === 'light' ? 'light' : 'dark';
    state.settings.themeMode = currentThemeMode;

    const updateDOM = () => {
      document.documentElement.classList.toggle('light', currentThemeMode === 'light');
      const seg = $('#themeMode');
      if (seg) setSeg(seg, currentThemeMode);
      setAccent(accentNow, true);
    };

    if (!instant && typeof document.startViewTransition === 'function') {
      document.startViewTransition(() => {
        updateDOM();
      });
    } else {
      updateDOM();
    }
  }
  const themeModeSeg = $('#themeMode');
  if (themeModeSeg) {
    themeModeSeg.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      const mode = b.dataset.v;
      if (mode === currentThemeMode) return;
      applyThemeMode(mode, false);
      save({ themeMode: mode });
      status('settings', 'palette', `Тема - ${mode === 'light' ? 'светлая' : 'тёмная'}`, 'good');
    });
  }

  function extractImageAccent(url) {
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const cvs = document.createElement('canvas');
          const ctx = cvs.getContext('2d');
          const w = Math.min(80, img.naturalWidth || 80);
          const h = Math.min(80, img.naturalHeight || 80);
          cvs.width = w; cvs.height = h;
          ctx.drawImage(img, 0, 0, w, h);
          const data = ctx.getImageData(0, 0, w, h).data;
          let best = null, maxScore = -1, rSum = 0, gSum = 0, bSum = 0, count = 0;
          for (let i = 0; i < data.length; i += 16) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const [hue, sat, lit] = rgbToHsl(r, g, b);
            if (sat > 0.15 && lit > 0.25 && lit < 0.85) {
              const score = sat * (1 - Math.abs(lit - 0.55));
              if (score > maxScore) { maxScore = score; best = [r, g, b]; }
              rSum += r; gSum += g; bSum += b; count++;
            }
          }
          if (best) resolve(best);
          else if (count > 0) resolve([Math.round(rSum / count), Math.round(gSum / count), Math.round(bSum / count)]);
          else resolve([244, 168, 190]);
        } catch { resolve([244, 168, 190]); }
      };
      img.onerror = () => resolve([244, 168, 190]);
      img.src = url;
    });
  }

  const BG_ACCENTS = {
    sakura: [244, 168, 190],
    end: [184, 137, 230],
  };

  async function applyBackgroundAccent(kind, animate) {
    let rgb = BG_ACCENTS[kind];
    if (kind === 'custom' && customBg) {
      rgb = await extractImageAccent(customBg.url);
    }
    if (!rgb) rgb = BG_ACCENTS.sakura;
    pickCustom(rgb, !animate);
    save({ accent: rgb, theme: null });
  }

  function computeAccentText(rgb, isLight = (currentThemeMode === 'light')) {
    if (!isLight) {
      return `color-mix(in srgb, rgb(${rgb.join(' ')}) 65%, white)`;
    }
    const [h, s] = rgbToHsl(...rgb);
    const isYellowGreen = h >= 35 && h <= 165;
    const targetL = isYellowGreen ? 0.25 : 0.32;
    const targetS = Math.min(0.85, Math.max(0.55, s * 0.9));
    const darkRgb = hslToRgb(h, targetS, targetL);
    return `rgb(${darkRgb.join(' ')})`;
  }

  function computeBtnTextColor(rgb, isLight = (currentThemeMode === 'light')) {
    if (!isLight) return '#ffffff';
    const lum = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    return lum > 140 ? '#0e1411' : '#ffffff';
  }

  let accentNow = [244, 168, 190], smokeNow = [22, 12, 16], accentAnim;
  function setAccent(to, instant) {
    const fromAccent = accentNow.slice();
    const toSmoke = computeSmoke(to);
    const fromSmoke = smokeNow.slice();
    const start = performance.now();
    cancelAnimationFrame(accentAnim);
    (function step(now) {
      const t = instant ? 1 : Math.min(1, (now - start) / 450), e = 1 - Math.pow(1 - t, 3);
      accentNow = fromAccent.map((c, i) => Math.round(c + (to[i] - c) * e));
      smokeNow = fromSmoke.map((c, i) => Math.round(c + (toSmoke[i] - c) * e));
      document.documentElement.style.setProperty('--accent', accentNow.join(' '));
      document.documentElement.style.setProperty('--smoke', smokeNow.join(' '));
      document.documentElement.style.setProperty('--accent-text', computeAccentText(accentNow));
      document.documentElement.style.setProperty('--accent-btn-text', computeBtnTextColor(accentNow));
      if (t < 1) accentAnim = requestAnimationFrame(step);
    })(start);
  }
  const swatches = $('#swatches');
  const rgbHex = rgb => '#' + rgb.map(n => Number(n).toString(16).padStart(2, '0')).join('');
  const hexRgb = hex => [0, 2, 4].map(i => parseInt(String(hex).replace('#', '').slice(i, i + 2), 16));
  function markSwatch(index, instant) {
    $$('.swatch .badge', swatches).forEach(x => x.remove());
    if (swatches.children[index]) swatches.children[index].insertAdjacentHTML('beforeend', `<span class="badge${instant ? '' : ' pop'}">${icon('check')}</span>`);
  }
  function pickTheme(i, instant) {
    const index = THEMES[i] ? i : 0;
    const [name, rgb] = THEMES[index];
    markSwatch(index, instant);
    $('#themeName').textContent = name;
    $('#accentColor').value = rgbHex(rgb);
    setAccent(rgb, instant);
    syncPicker(rgb);
  }
  function pickCustom(rgb, instant) {
    markSwatch(-1, instant);
    $('#themeName').textContent = 'Свой';
    $('#accentColor').value = rgbHex(rgb);
    setAccent(rgb, instant);
    syncPicker(rgb);
  }
  THEMES.forEach(([name, rgb], i) => {
    const b = document.createElement('button');
    b.className = 'swatch';
    b.title = name;
    b.style.background = `rgb(${rgb.join(' ')})`;
    b.onclick = () => {
      if (state.settings?.autoAccent) {
        setSwitch('autoAccent', false);
        save({ autoAccent: false });
      }
      pickTheme(i);
      save({ theme: i, accent: null });
      status('settings', 'palette', `Цвет «${name}»`, 'good');
    };
    swatches.appendChild(b);
  });
  $('#accentColor').addEventListener('input', () => {
    const raw = String($('#accentColor').value).trim();
    if (!/^#?[0-9a-fA-F]{6}$/.test(raw)) return;
    const rgb = hexRgb(raw);
    if (state.settings?.autoAccent) {
      setSwitch('autoAccent', false);
      save({ autoAccent: false });
    }
    pickCustom(rgb, true);
    save({ accent: rgb });
  });

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h = (h * 60 + 360) % 360;
    }
    return [h, max === 0 ? 0 : d / max, max];
  }
  function hsvToRgb(h, s, v) {
    const c = v * s;
    const hp = ((h % 360) + 360) % 360 / 60;
    const x = c * (1 - Math.abs(hp % 2 - 1));
    const m = v - c;
    let r = 0, g = 0, bl = 0;
    if (hp < 1) [r, g, bl] = [c, x, 0];
    else if (hp < 2) [r, g, bl] = [x, c, 0];
    else if (hp < 3) [r, g, bl] = [0, c, x];
    else if (hp < 4) [r, g, bl] = [0, x, c];
    else if (hp < 5) [r, g, bl] = [x, 0, c];
    else [r, g, bl] = [c, 0, x];
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((bl + m) * 255)];
  }
  let pickerH = 340, pickerS = 0.42, pickerV = 0.96, pickerLock = false;
  function paintPicker() {
    const sv = $('#pickerSv');
    if (!sv) return;
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${pickerH} 100% 50%))`;
    $('#pickerCursor').style.left = `${pickerS * 100}%`;
    $('#pickerCursor').style.top = `${(1 - pickerV) * 100}%`;
    $('#pickerHue').value = String(Math.round(pickerH));
    const rgb = hsvToRgb(pickerH, pickerS, pickerV);
    $('#accentColorBtn').style.background = `rgb(${rgb.join(' ')})`;
  }
  function syncPicker(rgb) {
    const btn = $('#accentColorBtn');
    if (!btn || !rgb || rgb.some(n => Number.isNaN(n))) return;
    if (pickerLock) {
      btn.style.background = `rgb(${rgb.join(' ')})`;
      return;
    }
    const [h, s, v] = rgbToHsv(rgb[0], rgb[1], rgb[2]);
    if (s > 0.02) pickerH = h;
    pickerS = s;
    pickerV = v;
    paintPicker();
  }
  function emitAccent(rgb) {
    pickerLock = true;
    try {
      $('#accentColor').value = rgbHex(rgb);
      $('#accentColor').dispatchEvent(new Event('input'));
    } finally {
      pickerLock = false;
    }
  }
  const picker = $('#picker');
  const pickerSv = $('#pickerSv');
  function togglePicker() {
    if (!picker) return;
    if (picker.hidden) {
      syncPicker(hexRgb($('#accentColor').value));
      picker.hidden = false;
    } else picker.hidden = true;
  }
  $('#accentColorBtn').onclick = (e) => { e.stopPropagation(); togglePicker(); };
  $('#accentColorOpen').onclick = (e) => { e.stopPropagation(); togglePicker(); };
  document.addEventListener('pointerdown', (e) => {
    if (!picker || picker.hidden) return;
    if ($('#colorPick').contains(e.target)) return;
    picker.hidden = true;
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && picker && !picker.hidden) picker.hidden = true;
  });
  function pointToSv(ev) {
    const rect = pickerSv.getBoundingClientRect();
    pickerS = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width));
    pickerV = Math.min(1, Math.max(0, 1 - (ev.clientY - rect.top) / rect.height));
    paintPicker();
    emitAccent(hsvToRgb(pickerH, pickerS, pickerV));
  }
  pickerSv.addEventListener('pointerdown', (ev) => {
    pickerSv.setPointerCapture(ev.pointerId);
    pointToSv(ev);
  });
  pickerSv.addEventListener('pointermove', (ev) => {
    if (!pickerSv.hasPointerCapture(ev.pointerId)) return;
    pointToSv(ev);
  });
  $('#pickerHue').addEventListener('input', () => {
    pickerH = Number($('#pickerHue').value);
    paintPicker();
    emitAccent(hsvToRgb(pickerH, pickerS, pickerV));
  });

  function applyFont(id) {
    const key = FONTS[id] ? id : 'noto';
    const font = FONTS[key];
    document.documentElement.style.setProperty('--font', font.stack);
    document.documentElement.style.setProperty('--font-title', font.title);
    $('#fontName').textContent = font.label;
    $$('#fontPicks button').forEach(b => b.classList.toggle('on', b.dataset.font === key));
    return key;
  }
  const fontPicks = $('#fontPicks');
  Object.entries(FONTS).forEach(([id, font]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.font = id;
    b.textContent = font.label;
    b.style.fontFamily = font.stack;
    b.onclick = () => {
      applyFont(id);
      save({ font: id });
      status('settings', 'palette', `Шрифт «${font.label}»`, 'good');
    };
    fontPicks.appendChild(b);
  });

  // ------------------------------------------------------------------ background

  const backgrounds = $('#backgrounds');
  let customBg = null, picked = null;

  function pickBackground(kind, fade) {
    if (kind === 'custom' && !customBg) kind = 'sakura';
    if (kind !== 'custom' && !PANORAMAS[kind]) kind = 'sakura';
    picked = kind;

    // a picture of one's own lies over the panorama; the panorama itself dips to black and back to change
    world.classList.toggle('on', kind === 'custom');
    if (kind === 'custom') world.style.backgroundImage = `url("${customBg.url}")`;
    if (kind !== 'custom' && kind !== shownPano) {
      const swap = () => {
        shownPano = kind;
        panoCanvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: fade ? 420 : 0, easing: 'ease-out', fill: 'forwards' });
      };
      const out = panoCanvas.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fade ? 260 : 0, easing: 'ease-in', fill: 'forwards' });
      Promise.all([out.finished, pano ? pano.load(kind) : Promise.resolve()]).then(() => { if (picked === kind) swap(); });
    } else if (pano && !fade) {
      // the first picture of all fades in from black once it has loaded
      pano.load(shownPano).then(() => panoCanvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 600, easing: 'ease-out' }));
    }
    setParticles(kind === 'custom' ? 'petals' : PANORAMAS[kind].particles);

    $('#bgName').textContent = kind === 'custom' ? customBg.name : PANORAMAS[kind].label;
    const custom = $('.bg-thumb.custom', backgrounds);
    custom.hidden = !customBg;
    if (customBg) custom.style.backgroundImage = `url("${customBg.url}")`;
    $$('.bg-thumb', backgrounds).forEach(t => {
      const on = t.dataset.bg === kind;
      t.classList.toggle('on', on);
      $('.badge', t)?.remove();
      if (on) t.insertAdjacentHTML('beforeend', `<span class="badge${fade ? ' pop' : ''}">${icon('check')}</span>`);
    });
    if (state.settings?.autoAccent) {
      applyBackgroundAccent(kind, fade);
    }
  }

  async function loadBackground(file) {
    if (!file) return;
    try {
      customBg = await api.setBackground(file);
    } catch (e) {
      status(state.page, 'warn', e.message, 'warn');
      return;
    }
    state.settings.background = 'custom';
    pickBackground('custom', true);
    const img = new Image();
    img.onload = () => {
      if (state.settings?.autoAccent) {
        applyBackgroundAccent('custom', true);
      }
      const small = img.naturalWidth < 1600 || img.naturalHeight < 900;
      status(state.page, 'image', small
        ? `Фон заменён, но картинка маленькая (${img.naturalWidth}×${img.naturalHeight}) - лучше от 1920×1080`
        : `Фон заменён на «${customBg.name}»`, small ? 'warn' : 'good');
    };
    img.onerror = () => status(state.page, 'warn', 'Эту картинку не получилось открыть', 'warn');
    img.src = customBg.url;
  }

  backgrounds.addEventListener('click', async e => {
    const t = e.target.closest('.bg-thumb');
    if (!t) return;
    if (t.id === 'bgAdd') {
      const [file] = await api.pick('image');
      loadBackground(file);
    } else if (!t.classList.contains('on')) {
      pickBackground(t.dataset.bg, true);
      save({ background: t.dataset.bg });
      const name = t.dataset.bg === 'custom' ? customBg.name : PANORAMAS[t.dataset.bg].label;
      status('settings', 'image', `Фон - «${name}»`, 'good');
    }
  });

  // ------------------------------------------------------------------ news and quick join

  function renderNews() {
    const news = boot.config.news || {};
    $('#newsTitle').textContent = news.title || 'Что нового';
    $('#newsTag').textContent = news.tag || '';
    $('#news').innerHTML = (news.items || []).map(([what, text]) => `<li><b>${esc(what)}</b> - ${esc(text)}</li>`).join('');
  }

  const pings = {};
  function servers() {
    return state.settings.servers || boot.config.servers || [];
  }
  const pingColor = p => p < 80 ? 'var(--good)' : p < 150 ? 'var(--warn)' : 'var(--bad)';

  function serverIcon(s) {
    const info = pings[s.address];
    if (info?.icon) return `<span class="srv-icon has-img"><img src="${info.icon}" alt=""></span>`;
    const h = hueOf(s.name || s.address);
    const tag = (s.name || s.address).replace(/[^A-Za-zА-Яа-я0-9]/g, '').slice(0, 2).toUpperCase();
    return `<span class="srv-icon" style="background:linear-gradient(135deg,hsl(${h} 55% 52%),hsl(${(h + 30) % 360} 60% 32%))">${esc(tag)}</span>`;
  }

  function serverLine(s) {
    const info = pings[s.address];
    if (!info) return 'проверяем…';
    if (info.error) return 'не отвечает';
    return info.online != null ? `${info.online} ${plural(info.online, 'игрок', 'игрока', 'игроков')}` : 'в сети';
  }

  function renderServers() {
    const list = servers();
    const box = $('#servers');
    if (!list.length) {
      box.innerHTML = '<div class="list-empty">Добавьте сервер кнопкой «+»</div>';
      return;
    }
    box.innerHTML = list.map((s, i) => {
      const info = pings[s.address];
      const ping = !info ? '<span class="ping off">…</span>'
        : info.error ? '<span class="ping off">-</span>'
        : `<span class="ping" style="color:${pingColor(info.latency ?? 999)}">${info.latency ?? '?'} мс</span>`;
      return `
      <div class="server" role="button" tabindex="0" data-server="${i}" title="Запустить и зайти на ${esc(s.address)}">
        ${serverIcon(s)}
        <span class="srv-text"><b>${esc(s.name || s.address)}</b><small>${esc(s.address)} · ${esc(serverLine(s))}</small></span>
        ${ping}
        <span class="srv-go">${icon('play')}</span>
        <button class="srv-remove" data-server-remove="${i}" title="Убрать из списка">${icon('close')}</button>
      </div>`;
    }).join('');
  }

  let pingRound = 0;
  async function pingServers() {
    const round = ++pingRound;
    await Promise.all(servers().map(async s => {
      try {
        pings[s.address] = await api.ping(s.address);
      } catch (e) {
        pings[s.address] = { error: e.message };
      }
    }));
    if (round === pingRound) renderServers();
  }
  setInterval(() => { if (state.page === 'home' && !document.hidden && phase === 'idle') pingServers(); }, 30000);

  $('#servers').addEventListener('click', e => {
    const remove = e.target.closest('[data-server-remove]');
    if (remove) {
      e.stopPropagation();
      const list = servers().slice();
      const [gone] = list.splice(+remove.dataset.serverRemove, 1);
      save({ servers: list }, true);
      renderServers();
      toast('trash', `${gone.name || gone.address} убран из быстрого входа`);
      return;
    }
    const b = e.target.closest('[data-server]');
    if (b) launch(servers()[+b.dataset.server]);
  });

  $('#serverAddOpen').addEventListener('click', () => {
    const form = $('#serverForm');
    form.classList.toggle('on');
    if (form.classList.contains('on')) setTimeout(() => $('#serverAddress').focus(), 150);
  });
  function addServer() {
    const address = $('#serverAddress').value.trim();
    if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$/.test(address)) {
      $('#serverAddress').closest('.well').animate([{ background: 'rgb(221 127 129 / .25)' }, {}], { duration: 700 });
      return;
    }
    const list = servers().slice();
    if (!list.some(s => s.address.toLowerCase() === address.toLowerCase())) {
      const host = address.split(':')[0].replace(/^(mc|play|pvp|join)\./i, '').split('.')[0];
      list.push({ name: host.charAt(0).toUpperCase() + host.slice(1), address });
      save({ servers: list }, true);
    }
    $('#serverAddress').value = '';
    $('#serverForm').classList.remove('on');
    renderServers();
    pingServers();
  }
  $('#serverAdd').addEventListener('click', addServer);
  $('#serverAddress').addEventListener('keydown', e => {
    if (e.key === 'Enter') addServer();
    if (e.key === 'Escape') $('#serverForm').classList.remove('on');
  });

  // ------------------------------------------------------------------ launch

  const play = $('#play'), playFill = $('#playFill'), playLabel = $('#playLabel'), playPct = $('#playPct');
  const playIcon = $('#playIcon'), launchLine = $('#launchLine');
  let runTimer = null, runStart = 0, runServer = null, stopArmed = 0, speed = null;

  function setLine(html, kind = '') {
    launchLine.className = 'launch-line' + (kind ? ' ' + kind : '');
    launchLine.innerHTML = html;
  }

  function when(at) {
    const d = new Date(at), now = new Date();
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (day === 0) return `сегодня в ${hm}`;
    if (day === 86400000) return `вчера в ${hm}`;
    return `${d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })} в ${hm}`;
  }

  function idleLine() {
    const lastLaunch = state.settings.lastLaunch;
    if (lastLaunch?.at) setLine(`<span>Последний запуск - ${when(lastLaunch.at)}${lastLaunch.server ? ` · ${esc(lastLaunch.server)}` : ''}</span>`);
    else setLine(`<span>Первый запуск скачает Minecraft ${esc(boot.config.minecraft)} и Java - это пара минут</span>`);
  }

  function launch(server) {
    if (phase === 'busy') {
      api.game.cancel();
      playLabel.textContent = 'Отменяем…';
      return;
    }
    if (phase === 'running') {
      // a second press within a few seconds: killing the game can cost an unsaved world
      if (Date.now() - stopArmed < 3500) {
        api.game.stop();
        playLabel.textContent = 'Закрываем…';
      } else {
        stopArmed = Date.now();
        playLabel.textContent = 'Точно закрыть?';
        setTimeout(() => { if (phase === 'running' && Date.now() - stopArmed >= 3400) playLabel.textContent = 'Закрыть игру'; }, 3500);
      }
      return;
    }
    if (!state.nick) {
      show('accounts');
      status('accounts', 'warn', 'Сначала добавьте аккаунт, под которым будете играть', 'warn');
      setTimeout(() => nickInput.focus(), 300);
      return;
    }
    if (state.page !== 'home') show('home');
    runServer = server || null;
    api.game.launch(server ? server.address : undefined).catch(e => toast('warn', e.message, 'warn'));
  }

  function busy() {
    phase = 'busy';
    play.classList.remove('running');
    play.classList.add('busy');
    playIcon.setAttribute('href', '#i-download');
    playLabel.textContent = 'Подготовка…';
    playFill.style.width = '2%';
    playPct.textContent = '';
    speed = null;
    setLine(`<span>${runServer ? `Готовим вход на ${esc(runServer.name || runServer.address)}` : 'Готовим игру'}</span>`);
  }

  function progress(p) {
    if (phase !== 'busy') return;
    let pct = null, text = p.text;
    if (p.stage === 'pack') {
      playLabel.textContent = 'Сборка…';
      if (p.total) {
        pct = 2 + 16 * Math.min(1, (p.done || 0) / p.total);
        if (/мод/i.test(p.text || '')) {
          text = p.text;
        } else if (p.done != null) {
          text = `${p.text || 'Сборка'} · ${fmtBytes(p.done)}${p.total ? ` из ${fmtBytes(p.total)}` : ''}`;
        }
      } else pct = 6;
    } else if (p.stage === 'meta') pct = 20;
    else if (p.stage === 'check' && p.total) {
      pct = 22 + 10 * p.done / p.total;
      text = `Проверка файлов · ${p.done} из ${p.total}`;
    } else if (p.stage === 'download' && p.total) {
      pct = 32 + 66 * Math.min(1, p.done / p.total);
      const now = performance.now();
      if (!speed) speed = { at: now, done: p.done, rate: 0 };
      else if (now - speed.at > 700) {
        const rate = (p.done - speed.done) / ((now - speed.at) / 1000);
        speed = { at: now, done: p.done, rate: speed.rate ? speed.rate * .6 + rate * .4 : rate };
      }
      text = `Загрузка · ${fmtBytes(p.done)} из ${fmtBytes(p.total)}${speed.rate > 0 ? ` · ${fmtBytes(speed.rate)}/с` : ''}`;
    } else if (p.stage === 'launch') {
      pct = 100;
      playLabel.textContent = 'Запуск…';
    }
    if (pct != null) {
      playFill.style.width = pct + '%';
      playPct.textContent = Math.floor(pct) + '%';
    }
    setLine(`<span class="ellipsis">${esc(text)}</span>`);
  }

  function running(s) {
    phase = 'running';
    play.classList.remove('busy');
    play.classList.add('running');
    playFill.style.width = '0';
    playPct.textContent = '';
    playLabel.textContent = 'Закрыть игру';
    playIcon.setAttribute('href', '#i-stop');
    runStart = s.startedAt || Date.now();
    const draw = () => {
      const t = Math.floor((Date.now() - runStart) / 1000);
      const clockText = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
      setLine(`<span>Minecraft работает · ${clockText} · ${gbText(state.ram)} ГБ · ${esc(state.nick)}</span>`);
    };
    draw();
    clearInterval(runTimer);
    runTimer = setInterval(draw, 1000);
    const how = state.settings.afterLaunch;
    toast('play', s.server ? `Игра запущена - заходим на ${s.server}` : 'Игра запущена' + (how === 'hide' ? ', лоадер свернётся' : how === 'close' ? ', лоадер закроется' : ''), 'good');
  }

  function idle(s) {
    const was = phase;
    phase = 'idle';
    clearInterval(runTimer);
    play.classList.remove('busy', 'running');
    playFill.style.width = '0';
    playPct.textContent = '';
    playLabel.textContent = 'Играть';
    playIcon.setAttribute('href', '#i-play');
    if (s.error) {
      const crash = s.crash ? `<button class="line-btn" data-open-file="${esc(s.crash)}">${icon('file')}Отчёт</button>` : '';
      setLine(`<span class="chip-ic bad">${icon('warn')}</span><span class="ellipsis" title="${esc(s.tail || s.error)}">${esc(s.error)}</span>${crash}<button class="line-btn" data-open-log>${icon('log')}Лог</button>`, 'error');
      toast('warn', s.error, 'bad');
    } else if (s.cancelled) {
      setLine('<span>Запуск отменён</span>');
    } else if (was === 'running') {
      state.settings.lastLaunch = { at: runStart, server: runServer?.address || null };
      const t = Math.round((s.ranFor || 0) / 60000);
      setLine(`<span>Игра закрыта${t ? ` · играли ${t} ${plural(t, 'минуту', 'минуты', 'минут')}` : ''}</span>`);
    } else {
      idleLine();
    }
    loadMods().catch(() => {});
  }

  launchLine.addEventListener('click', e => {
    const file = e.target.closest('[data-open-file]');
    if (file) api.open.file(file.dataset.openFile);
    if (e.target.closest('[data-open-log]')) show('logs');
  });

  play.addEventListener('click', () => launch());

  api.game.onProgress(progress);
  api.game.onState(s => {
    if (s.phase === 'busy') busy();
    else if (s.phase === 'running') running(s);
    else idle(s);
  });
  api.game.onError(e => toast('warn', e.text, 'warn'));


  // ------------------------------------------------------------------ the loader's own name and what it runs

  function showLauncherUpdate(info) {
    const el = $('#updateBanner');
    if (!el) return;
    if (!info?.version) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    $('#updateText').textContent = `Доступна Vanilla++ ${info.version}`;
    $('#updateGo').textContent = 'Обновить';
  }

  function showPack(pack) {
    const line = $('#packLine');
    if (!line) return;
    if (!pack?.enabled) {
      line.hidden = true;
      line.textContent = '';
      return;
    }
    line.hidden = false;
    const ver = pack.local?.versionNumber || pack.remote?.versionNumber || '';
    if (pack.error) {
      line.textContent = ` · сборка: ${pack.error}`;
      return;
    }
    if (pack.upToDate && ver) line.textContent = ` · сборка ${ver}`;
    else if (ver && pack.remote && !pack.upToDate) line.textContent = ` · сборка ${pack.local?.versionNumber || '—'} → ${pack.remote.versionNumber}`;
    else if (ver) line.textContent = ` · сборка ${ver}`;
    else line.textContent = ' · сборка Modrinth';
  }

  function showBuild() {
    const mc = boot.config.minecraft;
    buildText = `Vanilla++ · ${mc}`;
    $$('[data-build]').forEach(el => el.textContent = buildText);
    renderSide();
    $$('[data-footer]').forEach(el => el.textContent = `Vanilla++ · Minecraft ${mc}`);
    $$('[data-stack]').forEach(el => el.textContent = `Minecraft ${mc} · Fabric ${boot.config.fabricLoader}`);
    showPack(boot.pack);
  }

  // ------------------------------------------------------------------ start

  async function start() {
    boot = await api.init();
    state.settings = boot.settings;
    Object.assign(sys, boot.memory);
    $('#appVersion').textContent = `Vanilla++ ${boot.version}`;
    $('#gameDir').value = boot.gameRoot;

    state.accounts = (boot.settings.accounts || []).map(a => ({ ...a }));
    const current = state.accounts.some(a => a.id === boot.settings.current) ? boot.settings.current : (state.accounts[0]?.id || '');
    setCurrent(current, { pop: false });
    checkNick();
    setAccKind('offline');

    layoutRam();
    // a first guess sits in the middle of what is recommended for this machine
    const ram = boot.settings.ram ?? Math.min(recHi, Math.max(recLo, 4));
    setRam(ram, false, true);
    if (boot.settings.ram == null) save({ ram: state.ram });
    if (!boot.memory.exact) readMemory();

    setSwitch('bundledJava', boot.settings.javaMode !== 'custom');
    setSwitch('particles', boot.settings.particles !== false);
    setSwitch('fullscreen', !!boot.settings.fullscreen);
    setSwitch('autoAccent', !!boot.settings.autoAccent);
    applyThemeMode(boot.settings.themeMode || 'dark', true);
    $('#javaPath').value = boot.settings.javaPath || '';
    $('#jvmArgs').value = boot.settings.jvmArgs || '';
    $('#resW').value = boot.settings.width || 1280;
    $('#resH').value = boot.settings.height || 720;
    setSeg($('#afterLaunch'), boot.settings.afterLaunch || 'hide');
    applyFont(boot.settings.font || 'noto');
    if (Array.isArray(boot.settings.accent) && boot.settings.accent.length === 3) pickCustom(boot.settings.accent, true);
    else pickTheme(boot.settings.theme || 0, true);

    customBg = boot.background;
    pickBackground(boot.settings.background || 'sakura', false);

    renderNews();
    renderServers();
    pingServers();
    showBuild();

    if (boot.state.phase === 'running') running(boot.state);
    else if (boot.state.phase === 'busy') busy();
    else idleLine();
    showLauncherUpdate(boot.update);

    // Asynchronously load shelf items in background without blocking launcher UI
    const initShelves = async () => {
      try {
        await loadMods();
        modsSignature = signature();
        if (state.page === 'mods') renderMods();
        else countMods();
      } catch (e) {
        console.warn('Failed to load mods:', e);
      }
      try {
        await loadShelf('packs');
        if (state.page === 'packs') renderShelf('packs');
      } catch (e) {
        console.warn('Failed to load packs:', e);
      }
      try {
        await loadShelf('shaders');
        if (state.page === 'shaders') renderShelf('shaders');
      } catch (e) {
        console.warn('Failed to load shaders:', e);
      }
    };
    initShelves();

    api.pack.onStatus(pack => {
      boot.pack = pack;
      if (pack.minecraft) boot.config.minecraft = pack.minecraft;
      if (pack.fabricLoader) boot.config.fabricLoader = pack.fabricLoader;
      showBuild();
    });
    if (boot.pack?.enabled) {
      api.pack.status().then(pack => {
        boot.pack = pack;
        showPack(pack);
      }).catch(() => {});
    }

    api.update.check().then(update => {
      if (update) showLauncherUpdate(update);
    }).catch(() => {});

    api.auth.onAccountsUpdated?.(accounts => {
      state.accounts = accounts.map(a => ({ ...a }));
      const current = state.accounts.some(a => a.id === state.accountId) ? state.accountId : (state.accounts[0]?.id || '');
      setCurrent(current, { pop: false });
      renderAccounts();
    });

    const updateBanner = $('#updateBanner');
    if (updateBanner) {
      updateBanner.addEventListener('click', async () => {
        if (updateBanner.disabled) return;
        updateBanner.disabled = true;
        $('#updateGo').textContent = 'Скачиваем…';
        try {
          await api.update.install();
          $('#updateText').textContent = 'Перезапуск…';
        } catch (e) {
          updateBanner.disabled = false;
          $('#updateGo').textContent = 'Обновить';
          toast('warn', e.message, 'bad');
        }
      });
    }
    api.update.onProgress(p => {
      if (!updateBanner || updateBanner.hidden) return;
      if (p.stage === 'download' && p.total) {
        const pct = Math.min(100, Math.round(100 * (p.done || 0) / p.total));
        $('#updateGo').textContent = `${pct}%`;
      } else if (p.stage === 'apply') {
        $('#updateGo').textContent = 'Установка…';
      }
    });

    // #mods, #accounts, #settings open straight on that page
    const first = location.hash.slice(1);
    if (first === 'profile') show('accounts');
    else if (['mods', 'packs', 'shaders', 'accounts', 'settings', 'logs'].includes(first)) show(first);
    document.fonts?.ready.then(() => { placeWash(); $$('.segmented').forEach(placeSeg); });
    placeWash();
  }

  // a segmented control laid out while its page is hidden measures as nothing; measure it when it shows
  new MutationObserver(() => $$('.page.on .segmented').forEach(placeSeg))
    .observe($('.content'), { subtree: true, attributes: true, attributeFilter: ['class'] });

  start().catch(e => {
    console.error(e);
    toast('warn', 'Лоадер не смог прочитать настройки: ' + e.message, 'bad');
  });
})();
