'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const USER_AGENT = 'VanillaPlus/1.1 (+https://github.com/Loadstring4EVER)';

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function readTail(file, maxBytes) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fsp.rename(tmp, file);
}

function sha1File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function fetchWithRetry(url, options = {}, tries = 3) {
  let lastError;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      const res = await fetch(url, {
        ...options,
        headers: { 'User-Agent': USER_AGENT, ...(options.headers || {}) },
      });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} - ${url}`), { status: res.status });
      return res;
    } catch (e) {
      lastError = e;
      if (options.signal?.aborted) throw e;
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function fetchJson(url, options) {
  const res = await fetchWithRetry(url, options);
  return res.json();
}

async function fetchText(url, options) {
  const res = await fetchWithRetry(url, options);
  return res.text();
}

// Fetches JSON and keeps a copy, so the loader still starts when the network is down
async function cachedJson(url, file, { sha1, signal } = {}) {
  if (sha1 && await exists(file) && await sha1File(file) === sha1) return readJson(file);
  try {
    const text = await fetchText(url, { signal });
    if (sha1 && crypto.createHash('sha1').update(text).digest('hex') !== sha1) {
      throw new Error(`Файл повреждён при загрузке: ${path.basename(file)}`);
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, text, 'utf8');
    return JSON.parse(text);
  } catch (e) {
    const cached = await readJson(file);
    if (cached) return cached;
    throw e;
  }
}

// group:artifact:version[:classifier][@ext] -> group/artifact/version/artifact-version[-classifier].ext
function mavenPath(coordinate) {
  let [main, ext = 'jar'] = coordinate.split('@');
  const [group, artifact, version, classifier] = main.split(':');
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`;
  return [...group.split('.'), artifact, version, file].join('/');
}

function mavenKey(coordinate) {
  const [group, artifact, , classifier] = coordinate.split('@')[0].split(':');
  return `${group}:${artifact}${classifier ? ':' + classifier : ''}`;
}

function osName() {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux';
}

// Mojang's library and argument rules: nothing allowed unless a rule says so, the last matching rule wins
function rulesAllow(rules, features = {}) {
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let matches = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== osName()) matches = false;
      if (rule.os.arch && rule.os.arch === 'x86' && process.arch !== 'ia32') matches = false;
      if (rule.os.version) {
        try {
          if (!new RegExp(rule.os.version).test(require('os').release())) matches = false;
        } catch { /* a version pattern we cannot read matches nothing */ matches = false; }
      }
    }
    if (rule.features) {
      for (const [key, value] of Object.entries(rule.features)) {
        if (!!features[key] !== value) matches = false;
      }
    }
    if (matches) allowed = rule.action === 'allow';
  }
  return allowed;
}

function formatBytes(bytes) {
  const mb = bytes / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(1).replace('.', ',') + ' ГБ';
  if (mb >= 10) return Math.round(mb) + ' МБ';
  if (mb >= 1) return mb.toFixed(1).replace('.', ',') + ' МБ';
  return Math.max(1, Math.round(bytes / 1024)) + ' КБ';
}

module.exports = {
  USER_AGENT, exists, readJson, readTail, writeJson, sha1File, fetchWithRetry, fetchJson, fetchText, cachedJson,
  mavenPath, mavenKey, osName, rulesAllow, formatBytes,
};
