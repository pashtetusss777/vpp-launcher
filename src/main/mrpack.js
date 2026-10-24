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
const { openZip, readEntry } = require('./zip');
const mods = require('./mods');

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

function safeRel(rel) {
  const n = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!n || n.includes('..') || /^[a-zA-Z]:/.test(n) || n.startsWith('/')) {
    throw new Error(`Небезопасный путь в сборке: ${rel}`);
  }
  return n;
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
  try {
    for (const prefix of ['overrides/', 'client-overrides/']) {
      for (const name of zip.entries.keys()) {
        const norm = name.replace(/\\/g, '/');
        if (!norm.startsWith(prefix) || norm.endsWith('/')) continue;
        const rel = safeRel(norm.slice(prefix.length));
        const entry = zip.entries.get(name);
        if (!entry || entry.uncompressed > maxFile) {
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

async function installIndex(root, mrpackPath, { signal, report, previous, label = 'Ставим моды' } = {}) {
  const stage = (text, extra = {}) => report?.(text, extra);
  stage('Читаем состав сборки…');
  const index = await readIndexFromMrpack(mrpackPath);
  const wanted = index.files.filter(clientWanted).map(f => {
    const rel = safeRel(f.path);
    return {
      path: rel,
      sha1: f.hashes?.sha1 || '',
      sha512: f.hashes?.sha512 || '',
      size: f.fileSize || f.file_size || 0,
      downloads: (f.downloads || []).filter(u => /^https:\/\//i.test(u)),
    };
  }).filter(f => f.sha1 && f.downloads.length);

  const prevPaths = new Set((previous?.files || []).map(f => f.path));
  const nextPaths = new Set(wanted.map(f => f.path));
  if (previous) {
    for (const rel of prevPaths) {
      if (nextPaths.has(rel)) continue;
      await fsp.rm(path.join(root, ...rel.split('/')), { force: true }).catch(() => {});
    }
  }

  const missing = [];
  for (const file of wanted) {
    const abs = path.join(root, ...file.path.split('/'));
    if (!await fileMatches(abs, file.sha1, file.size || null)) missing.push(file);
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
  const prevOverrides = new Set(previous?.overrides || []);
  const overrides = await applyOverrides(mrpackPath, root);
  if (previous) {
    for (const rel of prevOverrides) {
      if (overrides.includes(rel)) continue;
      if (nextPaths.has(rel)) continue;
      await fsp.rm(path.join(root, ...rel.split('/')), { force: true }).catch(() => {});
    }
  }

  return { index, wanted, missing, overrides, deps: depsFromIndex(index) };
}

async function installJarZip(root, archive, mc) {
  const zip = await openZip(archive);
  const staging = path.join(root, 'launcher', 'import-staging');
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  try {
    const jars = [];
    const maxFile = 256 * 1048576;
    for (const name of zip.entries.keys()) {
      const norm = name.replace(/\\/g, '/');
      if (norm.endsWith('/') || !/\.jar$/i.test(norm)) continue;
      const parts = norm.split('/');
      if (parts.some(part => !part || part === '.' || part === '..' || part === '__MACOSX' || part.startsWith('.'))) continue;
      const entry = zip.entries.get(name);
      if (!entry || entry.uncompressed > maxFile) throw new Error(`Не удалось прочитать файл сборки: ${norm}`);
      const data = await readEntry(zip, name, maxFile);
      if (!data) throw new Error(`Не удалось прочитать файл сборки: ${norm}`);
      const dest = path.join(staging, ...parts);
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, data);
      jars.push(dest);
    }
    if (!jars.length) throw new Error('В архиве нет модов. Нужен .mrpack или zip с файлами .jar');
    return mods.add(root, mc, jars);
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function curseCdn(file) {
  const id = String(file.id || '');
  if (id.length < 5 || !file.fileName) return '';
  return `https://edge.forgecdn.net/files/${id.slice(0, 4)}/${id.slice(4)}/${encodeURIComponent(file.fileName)}`;
}

async function installCurse(root, archive, manifest, report) {
  const stage = (text, extra = {}) => report?.(text, extra);
  const files = (manifest.files || []).filter(f => f && f.projectID && f.fileID && f.required !== false);
  if (!files.length) throw new Error('В сборке CurseForge нет модов');
  let downloaded = 0;
  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    stage(`Ставим моды · ${i + 1} из ${files.length}`, { done: i, total: files.length });
    let info;
    try {
      info = await fetchJson(`https://api.curse.tools/v1/cf/mods/${entry.projectID}/files/${entry.fileID}`);
    } catch {
      throw new Error('CurseForge не ответил');
    }
    const file = info?.data;
    const filename = path.basename(String(file?.fileName || ''));
    if (!file || !/\.jar$/i.test(filename)) continue;
    const url = /^https:\/\//i.test(file.downloadUrl || '') ? file.downloadUrl : curseCdn(file);
    if (!url) continue;
    const dest = path.join(mods.modsDir(root), filename);
    const sha1 = (file.hashes || []).find(h => h.algo === 1)?.value || '';
    if (await fileMatches(dest, sha1, file.fileLength || null)) continue;
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
    label: 'Обновляем моды',
    report: (text, extra) => stage(text, extra),
  });
  const { index, wanted, missing, overrides, deps } = applied;
  const state = {
    project,
    versionId,
    versionNumber,
    name: version.name || versionNumber,
    files: wanted.map(f => ({ path: f.path, sha1: f.sha1 })),
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
  applyOverrides,
};
