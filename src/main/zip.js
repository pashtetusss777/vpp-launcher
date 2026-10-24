'use strict';

const fsp = require('fs/promises');
const zlib = require('zlib');

// Just enough of a zip reader to look inside mod jars: the central directory, and one entry at a time
async function openZip(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const tail = Math.min(size, 65557);
    const end = Buffer.alloc(tail);
    await handle.read(end, 0, tail, size - tail);
    let eocd = -1;
    for (let i = tail - 22; i >= 0; i--) {
      if (end.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('не zip-архив');
    const count = end.readUInt16LE(eocd + 10);
    const dirSize = end.readUInt32LE(eocd + 12);
    const dirOffset = end.readUInt32LE(eocd + 16);
    // Sizes come from the archive header. Refuse a directory that is not inside the file.
    if (dirSize > 8 * 1048576 || dirOffset > size || dirOffset + dirSize > size) throw new Error('не zip-архив');
    const dir = Buffer.alloc(dirSize);
    await handle.read(dir, 0, dirSize, dirOffset);
    const entries = new Map();
    let p = 0;
    for (let i = 0; i < count && p + 46 <= dir.length; i++) {
      if (dir.readUInt32LE(p) !== 0x02014b50) break;
      const method = dir.readUInt16LE(p + 10);
      const compressed = dir.readUInt32LE(p + 20);
      const uncompressed = dir.readUInt32LE(p + 24);
      const nameLen = dir.readUInt16LE(p + 28);
      const extraLen = dir.readUInt16LE(p + 30);
      const commentLen = dir.readUInt16LE(p + 32);
      const local = dir.readUInt32LE(p + 42);
      const name = dir.toString('utf8', p + 46, p + 46 + nameLen);
      entries.set(name, { method, compressed, uncompressed, local });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { file, entries, size };
  } finally {
    await handle.close();
  }
}

async function readEntry(zip, name, maxBytes = 4 * 1048576) {
  const entry = zip.entries.get(name);
  if (!entry || entry.uncompressed > maxBytes || entry.compressed > maxBytes) return null;
  const handle = await fsp.open(zip.file, 'r');
  try {
    const size = zip.size ?? (await handle.stat()).size;
    if (entry.local < 0 || entry.local + 30 > size) return null;
    const header = Buffer.alloc(30);
    await handle.read(header, 0, 30, entry.local);
    if (header.readUInt32LE(0) !== 0x04034b50) return null;
    const start = entry.local + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
    if (start < 0 || start > size || start + entry.compressed > size) return null;
    const data = Buffer.alloc(entry.compressed);
    await handle.read(data, 0, entry.compressed, start);
    if (entry.method === 0) return data;
    if (entry.method === 8) {
      // The archive's own size is the cap, so a short header cannot expand into a huge file.
      const out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(entry.uncompressed, 1) });
      if (out.length > entry.uncompressed) return null;
      return out;
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function readModInfo(file) {
  const zip = await openZip(file);
  const raw = await readEntry(zip, 'fabric.mod.json');
  if (!raw) return null;
  let info;
  try {
    // some mods put raw line breaks inside their strings; the game reads them, so do we
    info = JSON.parse(raw.toString('utf8').replace(/^﻿/, '').replace(/[\u0000-\u001F]+/g, ' '));
  } catch {
    return null;
  }
  let icon = null;
  const iconPath = typeof info.icon === 'string' ? info.icon : info.icon && typeof info.icon === 'object'
    ? Object.entries(info.icon).sort((a, b) => Math.abs(+a[0] - 64) - Math.abs(+b[0] - 64))[0]?.[1] : null;
  if (iconPath) {
    const png = await readEntry(zip, iconPath.replace(/^\//, ''), 512 * 1024).catch(() => null);
    if (png) icon = 'data:image/png;base64,' + png.toString('base64');
  }
  return { info, icon };
}

module.exports = { openZip, readEntry, readModInfo };
