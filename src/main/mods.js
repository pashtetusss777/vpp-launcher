'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { readModInfo } = require('./zip');

const cache = new Map();

function modsDir(root) {
  return path.join(root, 'mods');
}

function trashDir(root) {
  return path.join(root, 'launcher', 'removed');
}

function describe(info, fallbackName) {
  const authors = (info.authors || []).map(a => (typeof a === 'string' ? a : a?.name)).filter(Boolean);
  return {
    id: info.id || fallbackName,
    name: info.name || info.id || fallbackName,
    version: info.version || '-',
    description: typeof info.description === 'string' ? info.description.trim() : '',
    authors,
    minecraft: info.depends?.minecraft,
  };
}

// Whether the mod says it is for another Minecraft than ours; anything it does not say is taken as fine
function versionWarning(wanted, mc) {
  if (!wanted) return null;
  const list = Array.isArray(wanted) ? wanted : [wanted];
  const text = list.join(' ');
  if (/\*|26\.|>=\s*1\.2\d/.test(text) || text.includes(mc)) return null;
  const shown = text.match(/\d+\.\d+(\.\d+)?/);
  return shown ? `для ${shown[0]}` : null;
}

async function inspect(file, mc) {
  const stat = await fsp.stat(file);
  const key = `${file}|${stat.size}|${stat.mtimeMs}`;
  const name = path.basename(file);
  const enabled = name.endsWith('.jar');
  const base = name.replace(/\.disabled$/, '');
  if (!cache.has(key)) {
    let entry;
    try {
      const mod = await readModInfo(file);
      entry = mod ? { ...describe(mod.info, base), icon: mod.icon, fabric: true } : { ...describe({}, base), fabric: false };
    } catch {
      entry = { ...describe({}, base), fabric: false, broken: true };
    }
    cache.set(key, entry);
  }
  const entry = cache.get(key);
  return {
    ...entry, file: base, enabled, size: stat.size,
    warn: !entry.fabric ? (entry.broken ? 'повреждён' : 'не Fabric') : versionWarning(entry.minecraft, mc),
  };
}

async function list(root, mc) {
  const dir = modsDir(root);
  await fsp.mkdir(dir, { recursive: true });
  const names = (await fsp.readdir(dir)).filter(n => /\.jar(\.disabled)?$/i.test(n));
  const results = await Promise.all(names.map(async n => {
    try {
      return await inspect(path.join(dir, n), mc);
    } catch {
      return null;
    }
  }));
  const mods = results.filter(Boolean);
  return mods.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

async function add(root, mc, files) {
  const dir = modsDir(root);
  await fsp.mkdir(dir, { recursive: true });
  const existing = await list(root, mc);
  const results = [];
  for (const source of files) {
    const name = path.basename(source);
    if (!/\.jar$/i.test(name)) {
      results.push({ file: name, error: 'не мод: нужен файл .jar' });
      continue;
    }
    let mod;
    try {
      mod = await readModInfo(source);
    } catch {
      mod = null;
    }
    if (!mod) {
      results.push({ file: name, error: 'это не мод Fabric' });
      continue;
    }
    const info = describe(mod.info, name);
    if (['litka', 'fabric-api', 'fabric'].includes(info.id)) {
      results.push({ file: name, error: `«${info.name}» уже встроен в лоадер`, builtin: true });
      continue;
    }
    const same = existing.find(m => m.id === info.id);
    if (same) {
      // a newer file of the same mod takes the old one's place
      await fsp.rm(path.join(dir, same.file + (same.enabled ? '' : '.disabled')), { force: true });
    }
    await fsp.copyFile(source, path.join(dir, name));
    results.push({ file: name, name: info.name, replaced: !!same });
  }
  return results;
}

async function setEnabled(root, file, on) {
  const dir = modsDir(root);
  const from = path.join(dir, on ? file + '.disabled' : file);
  const to = path.join(dir, on ? file : file + '.disabled');
  await fsp.rename(from, to);
}

// Removed mods wait in launcher/removed until the loader closes, so «Вернуть» can bring them back
async function remove(root, file) {
  const dir = modsDir(root);
  const trash = trashDir(root);
  await fsp.mkdir(trash, { recursive: true });
  for (const name of [file, file + '.disabled']) {
    try {
      await fsp.rename(path.join(dir, name), path.join(trash, name));
      return name;
    } catch { /* try the other name */ }
  }
  throw new Error('файл не найден');
}

async function restore(root, token) {
  await fsp.rename(path.join(trashDir(root), token), path.join(modsDir(root), token));
}

async function emptyTrash(root, moveToRecycleBin) {
  const trash = trashDir(root);
  let names = [];
  try {
    names = await fsp.readdir(trash);
  } catch {
    return;
  }
  for (const n of names) {
    const file = path.join(trash, n);
    try {
      await moveToRecycleBin(file);
    } catch {
      await fsp.rm(file, { force: true }).catch(() => {});
    }
  }
}

module.exports = { list, add, setEnabled, remove, restore, emptyTrash, modsDir, inspect };
