'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const {
  exists, readJson, writeJson, sha1File, fetchJson, fetchWithRetry,
} = require('./util');
const { openZip, readEntry } = require('./zip');

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

async function modrinth(pathname, { signal } = {}) {
  try {
    return await fetchJson(MODRINTH + pathname, { signal });
  } catch (e) {
    if (e.status === 429) throw new Error('Modrinth просит подождать минуту');
    if (e.status === 404) throw new Error('Modrinth не нашёл этот модпак');
    throw new Error(e.message?.includes('HTTP') ? 'Modrinth не ответил' : (e.message || 'Modrinth не ответил'));
  }
}

async function latestVersion(project, { signal } = {}) {
  const versions = await modrinth(`/project/${encodeURIComponent(project)}/version`, { signal });
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

function extractZipDirs(mrpackPath, dest, names) {
  return new Promise((resolve, reject) => {
    const args = ['-xf', mrpackPath, '-C', dest, ...names];
    const child = spawn('tar', args, { windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => {
      // tar exits 1 if some members are missing — acceptable for optional overrides
      if (code === 0 || code === 1) resolve();
      else reject(new Error(`Не удалось распаковать overrides (код ${code})`));
    });
  });
}

async function applyOverrides(mrpackPath, root) {
  const staging = path.join(root, 'launcher', 'mrpack-staging');
  await fsp.rm(staging, { recursive: true, force: true });
  await fsp.mkdir(staging, { recursive: true });
  try {
    await extractZipDirs(mrpackPath, staging, ['overrides', 'client-overrides']);
    const applied = [];
    async function walkInto(srcRoot) {
      async function walk(dir, relBase) {
        let entries;
        try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of entries) {
          const src = path.join(dir, ent.name);
          const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
          if (ent.isDirectory()) await walk(src, rel);
          else {
            const safe = safeRel(rel);
            const dest = path.join(root, ...safe.split('/'));
            await fsp.mkdir(path.dirname(dest), { recursive: true });
            await fsp.copyFile(src, dest);
            applied.push(safe);
          }
        }
      }
      await walk(srcRoot, '');
    }
    await walkInto(path.join(staging, 'overrides'));
    await walkInto(path.join(staging, 'client-overrides'));
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

async function status(root, config, { signal } = {}) {
  const project = projectId(config);
  if (!project) return { enabled: false };
  const local = await loadState(root);
  let remote = null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 6000);
  try {
    const version = await latestVersion(project, { signal: abort.signal });
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
      error: e.message || 'Не удалось проверить сборку',
      upToDate: false,
    };
  } finally {
    clearTimeout(timer);
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

  // Remove previously managed files that left the pack
  const prevPaths = new Set((local?.files || []).map(f => f.path));
  const nextPaths = new Set(wanted.map(f => f.path));
  for (const rel of prevPaths) {
    if (nextPaths.has(rel)) continue;
    await fsp.rm(path.join(root, ...rel.split('/')), { force: true }).catch(() => {});
  }

  const missing = [];
  for (const file of wanted) {
    const abs = path.join(root, ...file.path.split('/'));
    if (!await fileMatches(abs, file.sha1, file.size || null)) missing.push(file);
  }

  if (missing.length) {
    const total = missing.reduce((s, f) => s + (f.size || 0), 0) || missing.length;
    let done = 0;
    stage(`Обновляем моды · 0 из ${missing.length}`, { done: 0, total, files: 0, count: missing.length });
    let files = 0;
    for (const file of missing) {
      if (signal?.aborted) throw Object.assign(new Error('Отменено'), { name: 'AbortError' });
      const abs = path.join(root, ...file.path.split('/'));
      let got = 0;
      await downloadFile(file.downloads[0], abs, {
        sha1: file.sha1,
        size: file.size,
        signal,
        onBytes: n => {
          got += n;
          done += n;
          stage(`Обновляем моды · ${files + 1} из ${missing.length}`, {
            done: total ? done : files,
            total: total || missing.length,
            files,
            count: missing.length,
          });
        },
      });
      // correct byte accounting when size unknown
      if (!file.size) done += 0;
      files++;
      stage(`Обновляем моды · ${files} из ${missing.length}`, {
        done: total ? Math.min(done, total) : files,
        total: total || missing.length,
        files,
        count: missing.length,
      });
    }
  }

  stage('Применяем конфиги сборки…');
  // Drop previous override files that are no longer in the new override set after apply
  const prevOverrides = new Set(local?.overrides || []);
  const overrides = await applyOverrides(mrpackPath, root);
  for (const rel of prevOverrides) {
    if (overrides.includes(rel)) continue;
    // only remove if not also a managed index file
    if (nextPaths.has(rel)) continue;
    await fsp.rm(path.join(root, ...rel.split('/')), { force: true }).catch(() => {});
  }

  const deps = depsFromIndex(index);
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
};
