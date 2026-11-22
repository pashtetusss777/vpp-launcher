'use strict';

const { execFile } = require('child_process');
const path = require('path');

// Windows keeps per-app GPU choices (the same ones from Settings > Display > Graphics)
// under HKCU, so a user-level write is enough. One value per Java path; nothing else is touched.
const KEY = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
const PREFERENCE = 'GpuPreference=2;';

function addArgs(exe) {
  return ['add', KEY, '/v', exe, '/t', 'REG_SZ', '/d', PREFERENCE, '/f'];
}

function deleteArgs(exe) {
  return ['delete', KEY, '/v', exe, '/f'];
}

function queryArgs() {
  return ['query', KEY];
}

// reg query prints one line per value: "<path>    REG_SZ    GpuPreference=2;".
// Only values written by this format belong to us.
function ourPaths(output) {
  const out = [];
  for (const line of String(output).split(/\r?\n/)) {
    const m = /^(.+?)\s+REG_SZ\s+GpuPreference=2;/i.exec(line.trim());
    if (m) out.push(m[1].trim());
  }
  return out;
}

function run(args) {
  return new Promise(resolve => {
    execFile('reg', args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

async function preferDiscrete(exe) {
  if (process.platform !== 'win32' || !exe) return;
  await run(addArgs(exe));
}

// Values for the bundled runtime and for the custom Java the player picked; other
// programs' preferences are left completely alone.
async function clearOwned(rootPrefix, customJava) {
  if (process.platform !== 'win32') return;
  const paths = ourPaths(await run(queryArgs())).filter(p =>
    p === customJava || p.startsWith(rootPrefix + path.sep));
  for (const p of paths) await run(deleteArgs(p));
}

module.exports = { addArgs, deleteArgs, queryArgs, ourPaths, preferDiscrete, clearOwned };
