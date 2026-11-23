'use strict';

const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { USER_AGENT } = require('./util');

// Anonymous usage stats. Two rows per game session, nothing else. The player
// answers a consent question once; a missing Supabase config disables everything.
const VERSION = require('../../package.json').version;

function endpoint(config) {
  const analytics = config?.analytics || {};
  const url = String(analytics.supabase || '').replace(/\/+$/, '');
  const key = String(analytics.anonKey || '');
  // Only the project's own host: a stranger's URL must not receive our rows.
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) || key.length < 20) return null;
  return { url: `${url}/rest/v1/usage_events`, key };
}

function consented(settings) {
  return settings.get().analytics === true;
}

function clientId(settings) {
  const existing = settings.get().clientId;
  if (typeof existing === 'string' && /^[0-9a-f-]{36}$/.test(existing)) return existing;
  const id = crypto.randomUUID();
  settings.update({ clientId: id });
  return id;
}

// Asked once per machine, then cached in settings forever: hardware does not drift.
// Several adapters share one report; the discrete card wins over an integrated one.
function pickGpu(names) {
  const list = (names || []).map(n => String(n).trim()).filter(Boolean);
  if (!list.length) return '';
  return list.find(n => /nvidia|geforce/i.test(n))
    || list.find(n => /radeon rx|\barc\b/i.test(n) && !/iris|uhd/i.test(n))
    || list[0];
}

function winGpu() {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-CimInstance Win32_VideoController | Sort-Object AdapterRAM -Descending | ForEach-Object { $_.Name }) -join "|"'],
    { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(err ? '' : pickGpu(String(stdout).split('|')));
    });
  });
}

function linuxGpu() {
  return new Promise(resolve => {
    execFile('lspci', [], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve('');
      const names = String(stdout).split('\n')
        .filter(l => /vga|3d controller/i.test(l))
        .map(l => l.split(':', 3)[2]?.trim());
      resolve(pickGpu(names));
    });
  });
}

// Detected once per week: hardware does not drift often, but docks and eGPUs do.
async function gpuOf(settings, detect) {
  const cached = settings.get().gpu;
  if (typeof cached === 'string' && settings.get().gpuAt > Date.now() - 7 * 86400000) return cached;
  let name = '';
  try { name = await detect(); } catch { /* keep the old value */ }
  name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const next = name || (typeof cached === 'string' ? cached : '');
  settings.update({ gpu: next, gpuAt: Date.now() });
  return next;
}

function defaultGpuDetector() {
  if (process.platform === 'win32') return winGpu;
  if (process.platform === 'linux') return linuxGpu;
  return async () => '';
}

function specs(settings) {
  return {
    os: process.platform,
    os_version: os.release(),
    arch: process.arch,
    cpu_cores: os.cpus().length,
    ram_gb: Math.round(os.totalmem() / (1024 ** 3)),
    gpu: settings.get().gpu ?? '',
  };
}

async function post(ep, rows) {
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: {
        apikey: ep.key,
        Authorization: `Bearer ${ep.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify(rows),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Fire and forget on purpose: stats must never delay the game or pile up retries.
async function gameStarted({ config, settings, minecraft, pack, ramGb }) {
  if (!consented(settings)) return false;
  const ep = endpoint(config);
  if (!ep) return false;
  await gpuOf(settings, defaultGpuDetector());
  const row = {
    client_id: clientId(settings),
    event: 'launch',
    launcher_version: VERSION,
    game: String(minecraft || '').slice(0, 32),
    pack: String(pack || '').slice(0, 64),
    ram_allocated_gb: Math.round(ramGb || 0) || null,
    at: new Date().toISOString(),
    ...specs(settings),
  };
  return post(ep, [row]);
}

async function gameEnded({ config, settings, durationS, exitCode, crashed }) {
  if (!consented(settings)) return false;
  const ep = endpoint(config);
  if (!ep) return false;
  const row = {
    client_id: clientId(settings),
    event: 'session_end',
    launcher_version: VERSION,
    duration_s: Math.max(0, Math.round(durationS || 0)),
    exit_code: Number.isInteger(exitCode) ? exitCode : null,
    crashed: !!crashed,
    at: new Date().toISOString(),
  };
  return post(ep, [row]);
}

module.exports = { endpoint, consented, clientId, gpuOf, specs, gameStarted, gameEnded, defaultGpuDetector, pickGpu };
