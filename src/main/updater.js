'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { fetchWithRetry } = require('./util');

const VERSION = require('../../package.json').version;

function repoOf(config) {
  const repo = String(config?.updates?.github || '').trim();
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : '';
}

function piece(seg) {
  const [num, pre] = String(seg || '0').split('-');
  return { n: parseInt(num, 10) || 0, pre: pre || '' };
}

function cmp(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(piece);
  const pb = String(b).replace(/^v/, '').split('.').map(piece);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || { n: 0, pre: '' };
    const db = pb[i] || { n: 0, pre: '' };
    if (da.n !== db.n) return da.n - db.n;
    // 1.1.11-beta.1 is older than 1.1.11, so a beta build can move on to the stable one.
    if (da.pre !== db.pre) {
      if (!da.pre) return 1;
      if (!db.pre) return -1;
      return da.pre < db.pre ? -1 : 1;
    }
  }
  return 0;
}

function electronApp() {
  return require('electron').app;
}

function assetFor(assets, version) {
  const name = (suffix) => assets.find(a => a.name === `VanillaPlusPlus-${version}-${suffix}`);
  if (process.platform === 'win32') return name('portable.zip');
  if (process.platform === 'darwin') return name(process.arch === 'arm64' ? 'arm64.zip' : 'x64.zip');
  if (process.env.APPIMAGE) {
    return name(process.arch === 'arm64' ? 'arm64.AppImage' : 'x86_64.AppImage');
  }
  if (process.arch === 'arm64') return name('arm64.tar.gz') || name('aarch64.pacman');
  return name('x64.tar.gz') || name('x64.pacman') || name('amd64.deb');
}

function releaseInfo(data) {
  const version = String(data?.tag_name || '').replace(/^v/, '');
  if (!version || cmp(version, VERSION) <= 0) return null;
  const asset = assetFor(data.assets || [], version);
  if (!asset?.browser_download_url) return null;
  return {
    version,
    name: asset.name,
    url: asset.browser_download_url,
    size: asset.size || 0,
    notes: String(data.body || '').slice(0, 500),
    pre: !!data.prerelease,
  };
}

async function latest(config, beta) {
  const repo = repoOf(config);
  if (!repo || !electronApp().isPackaged) return null;
  const headers = { Accept: 'application/vnd.github+json' };
  if (!beta) {
    const res = await fetchWithRetry(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
    return releaseInfo(await res.json());
  }
  const res = await fetchWithRetry(`https://api.github.com/repos/${repo}/releases?per_page=20`, { headers });
  const list = await res.json();
  if (!Array.isArray(list)) return null;
  let best = null;
  for (const rel of list) {
    if (!rel || rel.draft) continue;
    const info = releaseInfo(rel);
    if (info && (!best || cmp(info.version, best.version) > 0)) best = info;
  }
  return best;
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
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: os.tmpdir(),
  });
  child.unref();
}

// cmd.exe is a console program. Detached from the launcher it opens its own window,
// and windowsHide does not stop that. wscript is a windowed program and starts cmd hidden.
function spawnHiddenCmd(script) {
  const vbs = script.replace(/\.cmd$/i, '.vbs');
  const run = `cmd.exe /d /c ""${String(script).replace(/"/g, '""')}""`;
  fs.writeFileSync(vbs, `CreateObject("Wscript.Shell").Run "${run}", 0, False\r\n`, 'utf8');
  const host = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  spawnLater(host, ['//B', '//Nologo', vbs]);
  return vbs;
}

async function sweep(dir, keepName) {
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return; }
  await Promise.all(names.map(async name => {
    if (keepName && name === keepName) return;
    await fsp.rm(path.join(dir, name), { recursive: true, force: true }).catch(() => {});
  }));
}

async function freshDir(parent, name) {
  const dir = path.join(parent, name);
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    await fsp.mkdir(dir);
    return dir;
  } catch {
    const alt = path.join(parent, `${name}-${Date.now()}`);
    await fsp.mkdir(alt, { recursive: true });
    return alt;
  }
}

function batQuote(p) {
  return String(p).replace(/%/g, '%%');
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
  const cache = path.dirname(file);
  const work = await freshDir(cache, 'unpack');

  if (process.platform === 'win32') {
    await extract(file, work);
    const inner = path.join(work, 'Vanilla++');
    const source = fs.existsSync(path.join(inner, 'Vanilla++.exe')) ? inner : work;
    const install = path.dirname(process.execPath);
    const script = path.join(os.tmpdir(), `vanilla-plus-update-${process.pid}.cmd`);
    const vbs = script.replace(/\.cmd$/i, '.vbs');
    const exe = path.join(install, 'Vanilla++.exe');
    await fsp.writeFile(script, [
      '@echo off',
      'set /a N=0',
      ':wait',
      `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul`,
      'if errorlevel 1 goto copy',
      'set /a N+=1',
      'if %N% GEQ 40 goto copy',
      'ping -n 2 127.0.0.1 >nul',
      'goto wait',
      ':copy',
      'ping -n 3 127.0.0.1 >nul',
      `robocopy "${batQuote(source)}" "${batQuote(install)}" /E /R:1 /W:1 /NFL /NDL /NJH /NJS /nc /ns /np`,
      `start "" "${batQuote(exe)}"`,
      ':cleanup',
      'set /a N=0',
      ':wipe',
      `rmdir /s /q "${batQuote(cache)}"`,
      `if not exist "${batQuote(cache)}" goto done`,
      'set /a N+=1',
      'if %N% GEQ 10 goto done',
      'ping -n 2 127.0.0.1 >nul',
      'goto wipe',
      ':done',
      `del /q "${batQuote(vbs)}"`,
      '(goto) 2>nul & del "%~f0"',
    ].join('\r\n'), 'utf8');
    spawnHiddenCmd(script);
    return { restart: true };
  }

  if (process.platform === 'darwin') {
    await extract(file, work);
    const next = await findApp(work);
    const current = path.resolve(process.execPath, '..', '..', '..');
    if (!next || !current.endsWith('.app')) throw new Error('Не нашёл приложение в обновлении');
    const script = path.join(os.tmpdir(), `vanilla-plus-update-${process.pid}.sh`);
    await fsp.writeFile(script, [
      '#!/bin/sh',
      'sleep 2',
      `rm -rf ${JSON.stringify(current)}`,
      `mv ${JSON.stringify(next)} ${JSON.stringify(current)}`,
      `open ${JSON.stringify(current)}`,
      `rm -rf ${JSON.stringify(cache)}`,
      'rm -f "$0"',
    ].join('\n'), 'utf8');
    await fsp.chmod(script, 0o755);
    spawnLater('/bin/sh', ['-c', `nohup /bin/sh ${JSON.stringify(script)} >/dev/null 2>&1 &`]);
    return { restart: true };
  }

  if (process.env.APPIMAGE && info.name.endsWith('.AppImage')) {
    const target = process.env.APPIMAGE;
    const script = path.join(os.tmpdir(), `vanilla-plus-update-${process.pid}.sh`);
    await fsp.writeFile(script, [
      '#!/bin/sh',
      'sleep 2',
      `mv ${JSON.stringify(file)} ${JSON.stringify(target)}`,
      `chmod +x ${JSON.stringify(target)}`,
      `${JSON.stringify(target)} >/dev/null 2>&1 &`,
      `rm -rf ${JSON.stringify(cache)}`,
      'rm -f "$0"',
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
    const script = path.join(os.tmpdir(), `vanilla-plus-update-${process.pid}.sh`);
    const exe = process.execPath;
    await fsp.writeFile(script, [
      '#!/bin/sh',
      'sleep 2',
      `cp -a ${JSON.stringify(source)}/. ${JSON.stringify(install)}/`,
      `chmod +x ${JSON.stringify(exe)}`,
      `${JSON.stringify(exe)} >/dev/null 2>&1 &`,
      `rm -rf ${JSON.stringify(cache)}`,
      'rm -f "$0"',
    ].join('\n'), 'utf8');
    await fsp.chmod(script, 0o755);
    spawnLater('/bin/sh', ['-c', `nohup /bin/sh ${JSON.stringify(script)} >/dev/null 2>&1 &`]);
    return { restart: true };
  }

  return { restart: false, file };
}

let pending = null;

async function check(config, beta) {
  try {
    pending = await latest(config, beta);
    return pending;
  } catch (e) {
    pending = null;
    throw e;
  }
}

async function install(config, beta, onProgress) {
  const info = pending || await latest(config, beta);
  if (!info) throw new Error('Обновление не найдено');
  const dir = path.join(electronApp().getPath('userData'), 'updates');
  await fsp.mkdir(dir, { recursive: true });
  await sweep(dir);
  onProgress?.({ stage: 'download', done: 0, total: info.size || 1, version: info.version });
  const file = await download(info, dir, p => onProgress?.({ stage: 'download', ...p, version: info.version }));
  onProgress?.({ stage: 'apply', version: info.version });
  const result = await scheduleReplace(file, info);
  return { ...result, version: info.version, file };
}

module.exports = { check, install, repoOf, cmp };
