'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const {
  exists, readJson, writeJson, sha1File, fetchJson, fetchWithRetry,
} = require('./util');
const { openZip, readEntry, readModInfo } = require('./zip');
const mods = require('./mods');
const curseforge = require('./curseforge');

const MODRINTH = 'https://api.modrinth.com/v2';
const STATE_FILE = 'launcher/pack.json';

function projectId(config) {
  const id = String(config?.pack?.modrinthProject || '').trim();
  if (!id || !/^[\w.-]{2,64}$/.test(id)) return '';
  return id;
}

function statePath(root) {
  return path.join(root, STATE_FILE);
}

async function loadState(root) {
  return (await readJson(statePath(root), null)) || null;
}

async function saveState(root, state) {
  await writeJson(statePath(root), state);
}

// These belong to the launcher and the game install. A pack may write the rest, including command_history.txt.
const PACK_DENY = new Set(['launcher', 'versions', 'libraries', 'runtime', 'assets']);

function safeRel(rel) {
  const n = String(rel || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = n.split('/').filter(part => part && part !== '.');
  const top = (parts[0] || '').toLowerCase();
  if (!parts.length || n.startsWith('/') || n.includes('..') || n.includes('\0') || n.includes(':') || PACK_DENY.has(top)
    || parts.some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
    throw new Error(`Небезопасный путь в сборке: ${rel}`);
  }
  return parts.join('/');
}

function packDownload(url) {
  if (!/^https:\/\//i.test(url)) return '';
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return ''; }
  const ok = host === 'cdn.modrinth.com'
    || host === 'github.com'
    || host === 'objects.githubusercontent.com'
    || host === 'raw.githubusercontent.com'
    || host === 'gitlab.com'
    || host.endsWith('.gitlab.com');
  return ok ? url : '';
}

function clientWanted(file) {
  const side = file.env?.client;
  return side !== 'unsupported';
}

async function modrinth(pathname) {
  try {
    return await fetchJson(MODRINTH + pathname);
  } catch (e) {
    if (e.status === 429) throw new Error('Modrinth просит подождать минуту');
    if (e.status === 404) throw new Error('Modrinth не нашёл этот модпак');
    throw new Error(e.message?.includes('HTTP') ? 'Modrinth не ответил' : (e.message || 'Modrinth не ответил'));
  }
}

async function latestVersion(project) {
  const versions = await modrinth(`/project/${encodeURIComponent(project)}/version`);
  if (!Array.isArray(versions) || !versions.length) throw new Error('У модпака нет версий на Modrinth');
  // Prefer a version that actually ships an .mrpack
  const withPack = versions.find(v => (v.files || []).some(f => /\.mrpack$/i.test(f.filename || f.file_name || '')));
  return withPack || versions[0];
}

function pickMrpackFile(version) {
  const files = version.files || [];
  const primary = files.find(f => f.primary && /\.mrpack$/i.test(f.filename || ''));
  const any = files.find(f => /\.mrpack$/i.test(f.filename || ''));
  const file = primary || any || files.find(f => f.primary) || files[0];
  if (!file?.url) throw new Error('В версии модпака нет файла .mrpack');
  return {
    url: file.url,
    filename: file.filename || 'pack.mrpack',
    size: file.size || 0,
    sha1: file.hashes?.sha1 || '',
    sha512: file.hashes?.sha512 || '',
  };
}

async function downloadFile(url, dest, { sha1, size, signal, onBytes } = {}) {
  if (!/^https:\/\//i.test(url)) throw new Error('Ссылка на файл сборки не подходит');
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    let got = 0;
    try {
      const res = await fetchWithRetry(url, { signal });
      const hash = crypto.createHash('sha1');
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          hash.update(chunk);
          got += chunk.length;
          onBytes?.(chunk.length);
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp), { signal });
      const digest = hash.digest('hex');
      if (sha1 && digest !== sha1.toLowerCase()) {
        await fsp.rm(tmp, { force: true });
        throw new Error(`Контрольная сумма не сошлась: ${path.basename(dest)}`);
      }
      await fsp.rm(dest, { force: true });
      await fsp.rename(tmp, dest);
      if (size != null && got !== size) onBytes?.(0); // no-op; sizes may omit
      return;
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      lastError = e;
      if (signal?.aborted) throw e;
    }
  }
  throw lastError;
}

async function fileMatches(abs, sha1, size) {
  try {
    const st = await fsp.stat(abs);
    if (!st.isFile()) return false;
    if (size != null && size > 0 && st.size !== size) return false;
    if (sha1) return (await sha1File(abs)) === sha1.toLowerCase();
    return true;
  } catch {
    return false;
  }
}

// A switched-off mod is the same jar named *.jar.disabled. It is already here.
async function haveFile(abs, sha1, size) {
  if (await fileMatches(abs, sha1, size)) return true;
  if (/\.jar$/i.test(abs)) return fileMatches(abs + '.disabled', sha1, size);
  return false;
}

async function readIndexFromMrpack(mrpackPath) {
  const zip = await openZip(mrpackPath);
  const raw = await readEntry(zip, 'modrinth.index.json', 8 * 1048576);
  if (!raw) throw new Error('В .mrpack нет modrinth.index.json');
  const index = JSON.parse(raw.toString('utf8'));
  if (index.game && index.game !== 'minecraft') throw new Error('Этот mrpack не для Minecraft');
  if (!Array.isArray(index.files)) throw new Error('Повреждённый индекс сборки');
  return index;
}

// GNU tar (the `tar` on Arch and most Linux) cannot read a zip, and an .mrpack is a zip.
// Read the two override folders ourselves. client-overrides is applied second, so it wins.
// Files land in the game folder only after every entry has been read.
async function applyOverrides(mrpackPath, root) {
  const zip = await openZip(mrpackPath);
  const staging = path.join(root, 'launcher', 'mrpack-staging');
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  const applied = [];
  const maxFile = 256 * 1048576;
  const maxTotal = 1024 * 1048576;
  let files = 0;
  let total = 0;
  try {
    for (const prefix of ['overrides/', 'client-overrides/']) {
      for (const name of zip.entries.keys()) {
        const norm = name.replace(/\\/g, '/');
        if (!norm.startsWith(prefix) || norm.endsWith('/')) continue;
        const rel = safeRel(norm.slice(prefix.length));
        const entry = zip.entries.get(name);
        files += 1;
        total += entry?.uncompressed || 0;
        if (!entry || entry.uncompressed > maxFile || files > 4000 || total > maxTotal) {
          throw new Error(`Не удалось прочитать файл сборки: ${rel}`);
        }
        const data = await readEntry(zip, name, maxFile);
        if (!data) throw new Error(`Не удалось прочитать файл сборки: ${rel}`);
        const dest = path.join(staging, ...rel.split('/'));
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.writeFile(dest, data);
        applied.push(rel);
      }
    }
    for (const rel of applied) {
      const dest = path.join(root, ...rel.split('/'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(path.join(staging, ...rel.split('/')), dest);
    }
    return applied;
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function depsFromIndex(index) {
  const d = index.dependencies || {};
  const out = {};
  if (d.minecraft) out.minecraft = String(d.minecraft);
  if (d['fabric-loader']) out.fabricLoader = String(d['fabric-loader']);
  return out;
}

// A minimal fabric-style version range check. Unknown shapes always count as
// satisfied: the sweep must never remove a jar on a guess.
function mcVersionParts(version) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(version).trim());
  return m ? [+m[1], +m[2] || 0, +m[3] || 0] : null;
}

function cmpPartial(v, target) {
  for (let i = 0; i < 3; i++) {
    if (target[i] == null) continue;
    if (v[i] !== target[i]) return v[i] - target[i];
  }
  return 0;
}

function clauseSatisfied(parts, clause) {
  const m = /^(>=|<=|>|<|=|\^|~)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/i.exec(clause.trim());
  if (!m) return true;
  const wild = s => s == null || /^(x|\*)$/i.test(s);
  const target = [+m[2], wild(m[3]) ? null : +m[3], wild(m[4]) ? null : +m[4]];
  if (m[1] === '^') {
    if (parts[0] !== target[0]) return false;
    return cmpPartial(parts, target) >= 0;
  }
  if (m[1] === '~') {
    if (parts[0] !== target[0] || (target[1] != null && parts[1] !== target[1])) return false;
    return cmpPartial(parts, target) >= 0;
  }
  if (wild(m[3])) return parts[0] === target[0];
  const cmp = cmpPartial(parts, target);
  if (m[1] === '>=') return cmp >= 0;
  if (m[1] === '<=') return cmp <= 0;
  if (m[1] === '>') return cmp > 0;
  if (m[1] === '<') return cmp < 0;
  return cmp === 0;
}

function rangeSatisfied(parts, declaration) {
  const items = Array.isArray(declaration) ? declaration : [declaration];
  for (const item of items) {
    if (typeof item !== 'string') return true;
    const clauses = item.trim().split(/\s+/).filter(Boolean);
    if (!clauses.length) return true;
    // Fabric joins clauses of one string with AND; array items are OR.
    if (clauses.every(c => clauseSatisfied(parts, c))) return true;
  }
  return false;
}

// After a pack update, jars the pack dropped (and never told pack.json about)
// keep sitting in mods/. A jar that declares itself tied to another Minecraft
// version goes to launcher/removed; anything without a declaration stays.
async function sweepIncompatible(root, mc, keepPaths, overridesList) {
  const safe = new Set(keepPaths);
  for (const rel of overridesList || []) if (/^mods\//.test(rel)) safe.add(rel);
  const parts = mcVersionParts(mc);
  if (!parts) return [];
  const dir = mods.modsDir(root);
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const swept = [];
  for (const name of names) {
    if (!/\.jar(\.disabled)?$/i.test(name)) continue;
    const rel = `mods/${name}`;
    if (safe.has(rel)) continue;
    if (name.endsWith('.disabled') && safe.has(`mods/${name.slice(0, -9)}`)) continue;
    let info = null;
    try { info = await readModInfo(path.join(dir, name)); } catch { continue; }
    const dep = info?.info?.depends?.minecraft;
    if (!dep || rangeSatisfied(parts, dep)) continue;
    const trash = path.join(root, 'launcher', 'removed');
    await fsp.mkdir(trash, { recursive: true });
    await fsp.rename(path.join(dir, name), path.join(trash, name)).catch(() => {});
    if (fs.existsSync(path.join(trash, name))) swept.push(name);
  }
  return swept;
}

async function status(root, config) {
  const project = projectId(config);
  if (!project) return { enabled: false };
  const local = await loadState(root);
  let remote = null;
  try {
    const version = await latestVersion(project);
    remote = {
      versionId: version.id,
      versionNumber: version.version_number || version.name || version.id,
      name: version.name || version.version_number || '',
    };
  } catch (e) {
    return {
      enabled: true,
      project,
      local: local ? {
        versionId: local.versionId,
        versionNumber: local.versionNumber,
      } : null,
      error: e.message,
      upToDate: false,
    };
  }
  const upToDate = !!(local && local.versionId && local.versionId === remote.versionId);
  return {
    enabled: true,
    project,
    local: local ? { versionId: local.versionId, versionNumber: local.versionNumber } : null,
    remote,
    upToDate,
  };
}

async function installIndex(root, mrpackPath, { signal, report, previous, label = 'Ставим моды', applyPackOverrides = true } = {}) {
  const stage = (text, extra = {}) => report?.(text, extra);
  stage('Читаем состав сборки…');
  const index = await readIndexFromMrpack(mrpackPath);
  const wanted = index.files.filter(clientWanted).map(f => {
    const rel = safeRel(f.path);
    const downloads = (f.downloads || []).map(packDownload).filter(Boolean);
    if ((f.downloads || []).some(u => /^https:\/\//i.test(u)) && !downloads.length) {
      throw new Error(`Ссылка на файл сборки не подходит: ${rel}`);
    }
    return {
      path: rel,
      sha1: f.hashes?.sha1 || '',
      sha512: f.hashes?.sha512 || '',
      size: f.fileSize || f.file_size || 0,
      downloads,
    };
  }).filter(f => f.sha1 && f.downloads.length);

  const prevPaths = new Set();
  for (const file of previous?.files || []) {
    try { prevPaths.add(safeRel(file.path)); } catch { /* a saved path must not escape the game folder */ }
  }
  // pack.json of an older launcher only recorded the downloadable files; the cached
  // mrpack of the previous version lists everything that pack ever placed on disk.
  if (previous?.versionId) {
    try {
      const oldPack = path.join(root, 'launcher', 'mrpack', `${previous.versionId}.mrpack`);
      const zip = await openZip(oldPack);
      const raw = await readEntry(zip, 'modrinth.index.json', 8 * 1048576);
      if (raw) for (const f of JSON.parse(raw.toString('utf8')).files || []) {
        try { prevPaths.add(safeRel(f.path)); } catch { /* never touch unsafe paths */ }
      }
    } catch { /* no cached mrpack for that version */ }
  }
  const nextPaths = new Set(wanted.map(f => f.path));
  if (previous) {
    for (const rel of prevPaths) {
      if (nextPaths.has(rel)) continue;
      await fsp.rm(path.join(root, ...rel.split('/')), { force: true }).catch(() => {});
      // A mod the player switched off lives on as .disabled; both halves must go.
      if (/\.jar$/i.test(rel)) {
        await fsp.rm(path.join(root, ...(`${rel}.disabled`).split('/')), { force: true }).catch(() => {});
      }
    }
  }

  const missing = [];
  for (const file of wanted) {
    const abs = path.join(root, ...file.path.split('/'));
    if (!await haveFile(abs, file.sha1, file.size || null)) missing.push(file);
  }

  if (missing.length) {
    const total = missing.reduce((s, f) => s + (f.size || 0), 0) || missing.length;
    let done = 0;
    let files = 0;
    stage(`${label} · 0 из ${missing.length}`, { done: 0, total, files: 0, count: missing.length });
    for (const file of missing) {
      if (signal?.aborted) throw Object.assign(new Error('Отменено'), { name: 'AbortError' });
      const abs = path.join(root, ...file.path.split('/'));
      await downloadFile(file.downloads[0], abs, {
        sha1: file.sha1,
        size: file.size,
        signal,
        onBytes: n => {
          done += n;
          stage(`${label} · ${files + 1} из ${missing.length}`, {
            done: total ? done : files,
            total: total || missing.length,
            files,
            count: missing.length,
          });
        },
      });
      files++;
      stage(`${label} · ${files} из ${missing.length}`, {
        done: total ? Math.min(done, total) : files,
        total: total || missing.length,
        files,
        count: missing.length,
      });
    }
  }

  stage('Применяем конфиги сборки…');
  const prevOverrides = [];
  for (const rel of previous?.overrides || []) {
    try { prevOverrides.push(safeRel(rel)); } catch { /* ignore a path that could leave the game folder */ }
  }
  const overrides = applyPackOverrides ? await applyOverrides(mrpackPath, root) : (previous?.overrides || []);
  if (previous) {
    for (const rel of prevOverrides) {
      if (overrides.includes(rel)) continue;
      if (nextPaths.has(rel)) continue;
      await fsp.rm(path.join(root, ...rel.split('/')), { force: true }).catch(() => {});
    }
  }

  const deps = depsFromIndex(index);
  let swept = [];
  if (deps.minecraft) {
    swept = await sweepIncompatible(root, deps.minecraft, wanted.map(f => f.path), overrides);
    if (swept.length) {
      stage(`Убраны несовместимые с ${deps.minecraft} моды (${swept.length}): ${swept.slice(0, 3).join(', ')}${swept.length > 3 ? '…' : ''}`);
    }
  }

  return { index, wanted, missing, overrides, swept, deps };
}

async function installJarZip(root, archive, mc) {
  const zip = await openZip(archive);
  const staging = path.join(root, 'launcher', 'import-staging');
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  try {
    const jars = [];
    const maxFile = 256 * 1048576;
    const maxTotal = 1024 * 1048576;
    let files = 0;
    let total = 0;
    for (const name of zip.entries.keys()) {
      const norm = name.replace(/\\/g, '/');
      if (norm.endsWith('/') || !/\.jar$/i.test(norm)) continue;
      const parts = norm.split('/');
      if (parts.some(part => !part || part === '.' || part === '..' || part === '__MACOSX' || part.startsWith('.'))) continue;
      const entry = zip.entries.get(name);
      files += 1;
      total += entry?.uncompressed || 0;
      if (!entry || entry.uncompressed > maxFile || files > 4000 || total > maxTotal) {
        throw new Error(`Не удалось прочитать файл сборки: ${norm}`);
      }
      const data = await readEntry(zip, name, maxFile);
      if (!data) throw new Error(`Не удалось прочитать файл сборки: ${norm}`);
      const dest = path.join(staging, ...parts);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, data);
      jars.push(dest);
    }
    if (!jars.length) throw new Error('В архиве нет модов. Нужен .mrpack или zip с файлами .jar');
    return await mods.add(root, mc, jars);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function installCurse(root, archive, manifest, report) {
  const stage = (text, extra = {}) => report?.(text, extra);
    const files = (manifest.files || []).filter(f => {
      if (!f || f.required === false) return false;
      return Number.isInteger(f.projectID) && f.projectID > 0 && Number.isInteger(f.fileID) && f.fileID > 0;
    });
  if (!files.length) throw new Error('В сборке CurseForge нет модов');
  let downloaded = 0;
  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    stage(`Ставим моды · ${i + 1} из ${files.length}`, { done: i, total: files.length });
    const info = await curseforge.request(`/mods/${entry.projectID}/files/${entry.fileID}`);
    const file = info?.data;
    const filename = path.basename(String(file?.fileName || ''));
    if (!file || !/\.jar$/i.test(filename)) continue;
    const url = curseforge.fileUrl(file);
    if (!url) continue;
    const dest = path.join(mods.modsDir(root), filename);
    const sha1 = (file.hashes || []).find(h => h.algo === 1)?.value || '';
    if (await haveFile(dest, sha1, file.fileLength || null)) continue;
    await downloadFile(url, dest, { sha1, size: file.fileLength || 0 });
    downloaded++;
  }
  stage('Применяем конфиги сборки…');
  await applyOverrides(archive, root);
  return {
    kind: 'curse',
    name: manifest.name || path.basename(archive),
    downloaded,
    total: files.length,
  };
}

async function installDropped(root, file, mc, report) {
  const base = path.basename(String(file || ''));
  if (!/\.(mrpack|zip)$/i.test(base)) throw new Error('Нужен файл .mrpack или .zip');
  let zip;
  try {
    zip = await openZip(file);
  } catch {
    throw new Error('Это не архив .mrpack или .zip');
  }
  if (zip.entries.has('modrinth.index.json')) {
    const applied = await installIndex(root, file, { report });
    return {
      kind: 'mrpack',
      name: applied.index.name || base,
      version: applied.index.versionId || '',
      downloaded: applied.missing.length,
      total: applied.wanted.length,
      minecraft: applied.deps.minecraft || '',
    };
  }
  if (zip.entries.has('manifest.json')) {
    const raw = await readEntry(zip, 'manifest.json', 2 * 1048576);
    let manifest = null;
    try { manifest = JSON.parse(raw.toString('utf8')); } catch { manifest = null; }
    if (manifest?.manifestType === 'minecraftModpack' && Array.isArray(manifest.files)) {
      return installCurse(root, file, manifest, report);
    }
  }
  const results = await installJarZip(root, file, mc);
  return { kind: 'jars', results };
}

async function sync(root, config, { signal, report } = {}) {
  const project = projectId(config);
  if (!project) return { skipped: true, config };

  const stage = (text, extra = {}) => report?.({ stage: 'pack', text, ...extra });
  stage('Проверяем сборку на Modrinth…');

  const version = await latestVersion(project);
  const packFile = pickMrpackFile(version);
  const local = await loadState(root);
  const versionId = version.id;
  const versionNumber = version.version_number || version.name || versionId;

  const cacheDir = path.join(root, 'launcher', 'mrpack');
  await fsp.mkdir(cacheDir, { recursive: true });
  const mrpackPath = path.join(cacheDir, `${versionId}.mrpack`);

  const needPack = !(await fileMatches(mrpackPath, packFile.sha1, packFile.size));
  if (needPack) {
    stage(`Скачиваем сборку ${versionNumber}…`, { done: 0, total: packFile.size || 1 });
    let done = 0;
    await downloadFile(packFile.url, mrpackPath, {
      sha1: packFile.sha1,
      size: packFile.size,
      signal,
      onBytes: n => {
        done += n;
        stage(`Скачиваем сборку ${versionNumber}…`, {
          done,
          total: packFile.size || done,
        });
      },
    });
  }

  const applied = await installIndex(root, mrpackPath, {
    signal,
    previous: local,
    applyPackOverrides: local?.versionId !== versionId,
    label: 'Обновляем моды',
    report: (text, extra) => stage(text, extra),
  });
  const { index, wanted, missing, overrides, deps } = applied;
  const state = {
    project,
    versionId,
    versionNumber,
    name: version.name || versionNumber,
    // Every path the pack lists, not just the downloadable ones: the removal
    // sweep of later updates must know about files it never downloaded itself.
    files: applied.index.files.map(f => {
      try { return { path: safeRel(f.path), sha1: f.hashes?.sha1 || '' }; } catch { return null; }
    }).filter(Boolean),
    overrides,
    dependencies: deps,
    updatedAt: Date.now(),
  };
  await saveState(root, state);

  // Clean old cached mrpacks
  try {
    for (const name of await fsp.readdir(cacheDir)) {
      if (name === `${versionId}.mrpack`) continue;
      if (/\.mrpack$/i.test(name)) await fsp.rm(path.join(cacheDir, name), { force: true });
    }
  } catch { /* ok */ }

  stage('Сборка актуальна', { done: 1, total: 1 });

  const merged = {
    ...config,
    ...(deps.minecraft ? { minecraft: deps.minecraft } : {}),
    ...(deps.fabricLoader ? { fabricLoader: deps.fabricLoader } : {}),
  };

  return {
    skipped: false,
    updated: !local || local.versionId !== versionId || missing.length > 0,
    versionId,
    versionNumber,
    downloaded: missing.length,
    config: merged,
    state,
  };
}

function effectiveConfig(config, state) {
  if (!state?.dependencies) return config;
  return {
    ...config,
    ...(state.dependencies.minecraft ? { minecraft: state.dependencies.minecraft } : {}),
    ...(state.dependencies.fabricLoader ? { fabricLoader: state.dependencies.fabricLoader } : {}),
  };
}

module.exports = {
  projectId,
  status,
  sync,
  loadState,
  effectiveConfig,
  installDropped,
  installIndex,
  applyOverrides,
  safeRel,
  rangeSatisfied,
};
