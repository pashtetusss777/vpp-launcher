'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { app } = require('electron');
const { fetchWithRetry } = require('./util');

const VERSION = require('../../package.json').version;

function repoOf(config) {
  const repo = String(config?.updates?.github || '').trim();
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : '';
}

function cmp(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function assetFor(assets, version) {
  const name = (suffix) => assets.find(a => a.name === `VanillaPlus-${version}-${suffix}`);
  if (process.platform === 'win32') return name('portable.zip');
  if (process.platform === 'darwin') return name(process.arch === 'arm64' ? 'arm64.zip' : 'x64.zip');
  if (process.env.APPIMAGE) {
    return name(process.arch === 'arm64' ? 'arm64.AppImage' : 'x86_64.AppImage');
  }
  if (process.arch === 'arm64') return name('arm64.tar.gz') || name('aarch64.pacman');
  return name('x64.tar.gz') || name('x64.pacman') || name('amd64.deb');
}

async function latest(config) {
  const repo = repoOf(config);
  if (!repo || !app.isPackaged) return null;
  const res = await fetchWithRetry(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  const data = await res.json();
  const version = String(data.tag_name || '').replace(/^v/, '');
  if (!version || cmp(version, VERSION) <= 0) return null;
  const asset = assetFor(data.assets || [], version);
  if (!asset?.browser_download_url) return null;
  return {
    version,
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size || 0,
    notes: String(data.body || '').slice(0, 500),
  };
}

async function download(info, dir, onProgress) {
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, info.name);
  const tmp = dest + '.part';
  const res = await fetchWithRetry(info.url);
  const total = info.size || Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      done += chunk.length;
      onProgress?.({ done, total: total || done });
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp));
  await fsp.rm(dest, { force: true });
  await fsp.rename(tmp, dest);
  return dest;
}

function extract(archive, dest) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', dest], { windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`Не удалось распаковать обновление (${code})`))));
  });
}

async function findApp(dir, depth = 0) {
  if (depth > 3) return '';
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return ''; }
  const hit = names.find(n => n.endsWith('.app'));
  if (hit) return path.join(dir, hit);
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      if ((await fsp.stat(full)).isDirectory()) {
        const found = await findApp(full, depth + 1);
        if (found) return found;
      }
    } catch { /* skip */ }
  }
  return '';
}

function spawnLater(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function canWrite(dir) {
  try {
    await fsp.access(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function scheduleReplace(file, info) {
  const work = path.join(path.dirname(file), 'unpack');
  await fsp.rm(work, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true });

  if (process.platform === 'win32') {
    await extract(file, work);
    const inner = path.join(work, 'Vanilla++');
    const source = fs.existsSync(path.join(inner, 'Vanilla++.exe')) ? inner : work;
    const install = path.dirname(process.execPath);
    const script = path.join(path.dirname(file), 'apply.cmd');
    const exe = path.join(install, 'Vanilla++.exe');
    await fsp.writeFile(script, [
      '@echo off',
      'timeout /t 2 /nobreak >nul',
      `robocopy "${source}" "${install}" /E /NFL /NDL /NJH /NJS /nc /ns /np`,
      `start "" "${exe}"`,
      'del "%~f0"',
    ].join('\r\n'), 'utf8');
    spawnLater('cmd.exe', ['/c', 'start', '', '/min', script]);
    return { restart: true };
  }

  if (process.platform === 'darwin') {
    await extract(file, work);
    const next = await findApp(work);
    const current = path.resolve(process.execPath, '..', '..', '..');
    if (!next || !current.endsWith('.app')) throw new Error('Не нашёл приложение в обновлении');
    const script = path.join(path.dirname(file), 'apply.sh');
    await fsp.writeFile(script, [
      '#!/bin/sh',
      'sleep 2',
      `rm -rf ${JSON.stringify(current)}`,
      `mv ${JSON.stringify(next)} ${JSON.stringify(current)}`,
      `open ${JSON.stringify(current)}`,
    ].join('\n'), 'utf8');
    await fsp.chmod(script, 0o755);
    spawnLater('/bin/sh', ['-c', `nohup /bin/sh ${JSON.stringify(script)} >/dev/null 2>&1 &`]);
    return { restart: true };
  }

  if (process.env.APPIMAGE && info.name.endsWith('.AppImage')) {
    const target = process.env.APPIMAGE;
    const script = path.join(path.dirname(file), 'apply.sh');
    await fsp.writeFile(script, [
      '#!/bin/sh',
      'sleep 2',
      `mv ${JSON.stringify(file)} ${JSON.stringify(target)}`,
      `chmod +x ${JSON.stringify(target)}`,
      `${JSON.stringify(target)} >/dev/null 2>&1 &`,
    ].join('\n'), 'utf8');
    await fsp.chmod(script, 0o755);
    spawnLater('/bin/sh', ['-c', `nohup /bin/sh ${JSON.stringify(script)} >/dev/null 2>&1 &`]);
    return { restart: true };
  }

  const install = path.dirname(process.execPath);
  if (info.name.endsWith('.tar.gz') && await canWrite(install)) {
    await extract(file, work);
    const names = await fsp.readdir(work);
    const only = names.length === 1 ? path.join(work, names[0]) : work;
    const source = (await fsp.stat(only)).isDirectory() ? only : work;
    const script = path.join(path.dirname(file), 'apply.sh');
    const exe = process.execPath;
    await fsp.writeFile(script, [
      '#!/bin/sh',
      'sleep 2',
      `cp -a ${JSON.stringify(source)}/. ${JSON.stringify(install)}/`,
      `chmod +x ${JSON.stringify(exe)}`,
      `${JSON.stringify(exe)} >/dev/null 2>&1 &`,
    ].join('\n'), 'utf8');
    await fsp.chmod(script, 0o755);
    spawnLater('/bin/sh', ['-c', `nohup /bin/sh ${JSON.stringify(script)} >/dev/null 2>&1 &`]);
    return { restart: true };
  }

  return { restart: false, file };
}

let pending = null;

async function check(config) {
  try {
    pending = await latest(config);
    return pending;
  } catch (e) {
    pending = null;
    throw e;
  }
}

async function install(config, onProgress) {
  const info = pending || await latest(config);
  if (!info) throw new Error('Обновление не найдено');
  const dir = path.join(app.getPath('userData'), 'updates');
  onProgress?.({ stage: 'download', done: 0, total: info.size || 1, version: info.version });
  const file = await download(info, dir, p => onProgress?.({ stage: 'download', ...p, version: info.version }));
  onProgress?.({ stage: 'apply', version: info.version });
  const result = await scheduleReplace(file, info);
  return { ...result, version: info.version, file };
}

module.exports = { check, install, repoOf };
