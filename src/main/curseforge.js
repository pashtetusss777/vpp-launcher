'use strict';

const { fetchJson } = require('./util');

const MIRROR = 'https://mod.mcimirror.top';

async function request(pathname) {
  try {
    return await fetchJson(`${MIRROR}/curseforge/v1${pathname}`);
  } catch (e) {
    if (e.status === 429) throw new Error('CurseForge просит подождать минуту');
    throw new Error('CurseForge не ответил');
  }
}

function fileUrl(file) {
  try {
    const url = new URL(file.downloadUrl);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === 'mod.mcimirror.top' || url.hostname.endsWith('.forgecdn.net'))) {
      // MCIM mirrors edge, but explicitly does not mirror mediafilez.
      if (url.hostname === 'edge.forgecdn.net') url.hostname = 'mod.mcimirror.top';
      return url.href;
    }
  } catch { /* use the file id when the upstream URL is missing or invalid */ }
  const id = Number(file.id);
  if (!Number.isSafeInteger(id) || id < 10000 || !file.fileName) return '';
  return `${MIRROR}/files/${Math.floor(id / 1000)}/${id % 1000}/${encodeURIComponent(file.fileName)}`;
}

module.exports = { request, fileUrl };
