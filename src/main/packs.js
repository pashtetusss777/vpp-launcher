'use strict';

const fsp = require('fs/promises');
const path = require('path');
const { openZip, readEntry } = require('./zip');

const KINDS = {
  resourcepack: 'resourcepacks',
  shader: 'shaderpacks',
};

function contentDir(root, kind) {
  const folder = KINDS[kind];
  if (!folder) throw new Error('Неизвестный раздел');
  return path.join(root, folder);
}

function trashDir(root, kind) {
  return path.join(root, 'launcher', 'removed', KINDS[kind] ? kind : '');
}

function safeName(name) {
  const base = path.basename(String(name || '')).replace(/[^\w.\-+() ]+/g, '_').replace(/^\.+/, '');
  if (!base || base === '.' || base === '..') throw new Error('Некорректное имя файла');
  return base;
}

function plain(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.replace(/§./g, '').replace(/\s+/g, ' ').trim();
  if (Array.isArray(value)) return value.map(plain).join('');
  if (typeof value === 'object') return plain(value.text) + plain(value.extra);
  return '';
}

async function readText(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function writeLine(file, key, value, sep) {
  const text = await readText(file);
  const line = `${key}${sep}${value}`;
  const re = new RegExp(`^${key}${sep === '=' ? '=' : ':'}.*$`, 'm');
  const next = re.test(text)
    ? text.replace(re, line)
    : (text && !text.endsWith('\n') ? text + '\n' : text) + line + '\n';
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, next, 'utf8');
  await fsp.rename(tmp, file);
}

async function packMeta(file, isDir) {
  try {
    const raw = isDir
      ? await fsp.readFile(path.join(file, 'pack.mcmeta'), 'utf8')
      : (await readEntry(await openZip(file), 'pack.mcmeta'))?.toString('utf8');
    if (!raw) return {};
    const json = JSON.parse(raw.replace(/^﻿/, ''));
    return { description: plain(json.pack?.description).slice(0, 180) };
  } catch {
    return {};
  }
}

async function enabledPacks(root) {
  const text = await readText(path.join(root, 'options.txt'));
  const line = text.match(/^resourcePacks:(.*)$/m);
  if (!line) return new Set();
  try {
    const list = JSON.parse(line[1]);
    return new Set((Array.isArray(list) ? list : [])
      .filter(item => typeof item === 'string' && item.startsWith('file/'))
      .map(item => item.slice(5)));
  } catch {
    return new Set();
  }
}

async function activeShader(root) {
  const text = await readText(path.join(root, 'config', 'iris.properties'));
  const pack = (text.match(/^shaderPack=(.*)$/m) || [])[1]?.trim() || '';
  const flag = text.match(/^enableShaders=(.*)$/mi);
  const on = flag ? /^(true|yes)$/i.test(flag[1].trim()) : !!pack;
  return on ? pack : '';
}

async function list(root, kind) {
  const dir = contentDir(root, kind);
  await fsp.mkdir(dir, { recursive: true });
  const names = await fsp.readdir(dir);
  const enabled = kind === 'resourcepack' ? await enabledPacks(root) : null;
  const shader = kind === 'shader' ? await activeShader(root) : '';
  const items = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const file = path.join(dir, name);
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch { continue; }
    const isDir = stat.isDirectory();
    if (!isDir && !/\.zip$/i.test(name)) continue;
    if (isDir && kind === 'resourcepack') {
      try {
        await fsp.access(path.join(file, 'pack.mcmeta'));
      } catch { continue; }
    }
    const meta = kind === 'resourcepack' ? await packMeta(file, isDir) : {};
    const label = name.replace(/\.zip$/i, '');
    items.push({
      file: name,
      name: label,
      description: meta.description || (isDir ? 'Папка' : name),
      enabled: kind === 'shader' ? shader === name : enabled.has(name),
      size: isDir ? 0 : stat.size,
      folder: isDir,
    });
  }
  return items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

async function place(root, kind, source, filename, { enable = true } = {}) {
  const name = safeName(filename);
  if (kind === 'shader' && !/\.zip$/i.test(name)) throw new Error('Шейдеру нужен файл .zip');
  if (kind === 'resourcepack' && !/\.zip$/i.test(name)) throw new Error('Ресурспаку нужен файл .zip');
  const dir = contentDir(root, kind);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, name);
  await fsp.rm(dest, { force: true });
  await fsp.copyFile(source, dest);
  if (enable) await setOn(root, kind, name, true);
  return name;
}

async function add(root, kind, files) {
  const results = [];
  for (const source of files) {
    const name = path.basename(source);
    try {
      if (!/\.zip$/i.test(name)) throw new Error('нужен файл .zip');
      const saved = await place(root, kind, source, name, { enable: true });
      results.push({ file: saved, name: saved.replace(/\.zip$/i, '') });
    } catch (e) {
      results.push({ file: name, error: e.message });
    }
  }
  return results;
}

async function setOn(root, kind, file, on) {
  const name = safeName(file);
  if (kind === 'resourcepack') {
    const options = path.join(root, 'options.txt');
    const text = await readText(options);
    const line = text.match(/^resourcePacks:(.*)$/m);
    let list = ['vanilla'];
    if (line) {
      try {
        const parsed = JSON.parse(line[1]);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        throw new Error('Не смог прочитать список ресурспаков в options.txt');
      }
    }
    const id = `file/${name}`;
    list = list.filter(item => item !== id);
    if (on) list.push(id);
    await writeLine(options, 'resourcePacks', JSON.stringify(list), ':');
    return;
  }
  if (kind === 'shader') {
    const props = path.join(root, 'config', 'iris.properties');
    await writeLine(props, 'shaderPack', on ? name : '', '=');
    await writeLine(props, 'enableShaders', on ? 'true' : 'false', '=');
    return;
  }
  throw new Error('Неизвестный раздел');
}

async function remove(root, kind, file) {
  const name = safeName(file);
  const trash = trashDir(root, kind);
  await fsp.mkdir(trash, { recursive: true });
  await setOn(root, kind, name, false).catch(() => {});
  const from = path.join(contentDir(root, kind), name);
  const to = path.join(trash, name);
  await fsp.rm(to, { recursive: true, force: true });
  await fsp.rename(from, to);
  return name;
}

async function restore(root, kind, token) {
  const name = safeName(token);
  await fsp.rename(path.join(trashDir(root, kind), name), path.join(contentDir(root, kind), name));
  await setOn(root, kind, name, true);
}

async function emptyTrash(root, moveToRecycleBin) {
  for (const kind of Object.keys(KINDS)) {
    const trash = trashDir(root, kind);
    let names = [];
    try {
      names = await fsp.readdir(trash);
    } catch { continue; }
    for (const name of names) {
      const file = path.join(trash, name);
      try {
        await moveToRecycleBin(file);
      } catch {
        await fsp.rm(file, { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}

module.exports = { list, add, place, setOn, remove, restore, emptyTrash, contentDir, safeName };
