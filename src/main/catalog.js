'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { fetchJson, fetchWithRetry, readJson, writeJson, exists } = require('./util');
const mods = require('./mods');
const packs = require('./packs');

const MODRINTH = 'https://api.modrinth.com/v2';
// The official CurseForge API wants a private key. This public proxy speaks the same API.
const CURSE = 'https://api.curse.tools/v1/cf';

const KINDS = {
  mod: { modrinth: 'mod', curse: 6, loader: true },
  resourcepack: { modrinth: 'resourcepack', curse: 12, loader: false },
  shader: { modrinth: 'shader', curse: 6552, loader: false },
};

// One chip in the UI, two ids. CurseForge has no separate category for some Modrinth ones.
const MOD_CATEGORIES = {
  optimization: { modrinth: 'optimization', curse: 6814 },
  library: { modrinth: 'library', curse: 421 },
  technology: { modrinth: 'technology', curse: 412 },
  magic: { modrinth: 'magic', curse: 419 },
  adventure: { modrinth: 'adventure', curse: 422 },
  worldgen: { modrinth: 'worldgen', curse: 406 },
  storage: { modrinth: 'storage', curse: 420 },
  food: { modrinth: 'food', curse: 436 },
  utility: { modrinth: 'utility', curse: 5191 },
  decoration: { modrinth: 'decoration', curse: 424 },
  equipment: { modrinth: 'equipment', curse: 434 },
};

function modFilter(kind, category) {
  if (!category || kind !== 'mod') return null;
  const cat = MOD_CATEGORIES[category];
  if (!cat) throw new Error('Неизвестная категория');
  return cat;
}

function kindOf(kind) {
  const spec = KINDS[kind];
  if (!spec) throw new Error('Неизвестный раздел');
  return spec;
}

function assertId(id) {
  if (!/^[\w-]{1,64}$/.test(String(id || ''))) throw new Error('Некорректный проект');
  return String(id);
}

function clip(text, max = 220) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max - 1) + '…' : clean;
}

function httpsIcon(url) {
  return /^https:\/\//.test(String(url || '')) ? url : '';
}

function contentDir(root, kind) {
  return kind === 'mod' ? mods.modsDir(root) : packs.contentDir(root, kind);
}

async function curse(pathname) {
  try {
    return await fetchJson(CURSE + pathname);
  } catch (e) {
    if (e.status === 429) throw new Error('CurseForge просит подождать минуту');
    throw new Error('CurseForge не ответил');
  }
}

async function modrinth(pathname) {
  try {
    return await fetchJson(MODRINTH + pathname);
  } catch (e) {
    if (e.status === 429) throw new Error('Modrinth просит подождать минуту');
    if (e.status === 404) throw new Error('Modrinth не нашёл этот проект');
    throw new Error('Modrinth не ответил');
  }
}

async function known(root) {
  return (await readJson(path.join(root, 'launcher', 'catalog.json'), {})) || {};
}

async function remember(root, source, projectId, filename) {
  const file = path.join(root, 'launcher', 'catalog.json');
  const data = await known(root);
  data[`${source}:${projectId}`] = filename;
  await writeJson(file, data);
}

async function installed(root, kind, source, projectId) {
  const filename = (await known(root))[`${source}:${projectId}`];
  if (!filename) return false;
  const dir = contentDir(root, kind);
  if (await exists(path.join(dir, filename))) return true;
  return kind === 'mod' && await exists(path.join(dir, filename + '.disabled'));
}

const PAGE = 24;

async function searchModrinth(kind, query, mc, offset, category) {
  const spec = kindOf(kind);
  const facets = [['project_type:' + spec.modrinth], ['versions:' + mc]];
  if (spec.loader) facets.push(['categories:fabric']);
  if (category) facets.push(['categories:' + category.modrinth]);
  const params = new URLSearchParams({
    limit: String(PAGE),
    offset: String(offset),
    index: query ? 'relevance' : 'downloads',
    facets: JSON.stringify(facets),
  });
  if (query) params.set('query', query);
  const data = await modrinth('/search?' + params);
  return {
    total: data.total_hits || 0,
    hits: (data.hits || []).map(hit => ({
      source: 'modrinth',
      id: hit.project_id,
      name: hit.title || hit.slug,
      author: hit.author || '',
      description: clip(hit.description),
      icon: httpsIcon(hit.icon_url),
      downloads: hit.downloads || 0,
    })),
  };
}

async function searchCurse(kind, query, mc, offset, category) {
  const spec = kindOf(kind);
  const params = new URLSearchParams({
    gameId: '432',
    classId: String(spec.curse),
    pageSize: String(PAGE),
    index: String(offset),
    sortField: query ? '2' : '6',
    sortOrder: 'desc',
    gameVersion: mc,
  });
  if (spec.loader) params.set('modLoaderType', '4');
  if (category) params.set('categoryId', String(category.curse));
  if (query) params.set('searchFilter', query);
  const data = await curse('/mods/search?' + params);
  return {
    total: data.pagination?.totalCount || 0,
    hits: (data.data || []).map(mod => ({
      source: 'curseforge',
      id: String(mod.id),
      name: mod.name,
      author: mod.authors?.[0]?.name || '',
      description: clip(mod.summary),
      icon: httpsIcon(mod.logo?.url || mod.logo?.thumbnailUrl),
      downloads: mod.downloadCount || 0,
    })),
  };
}

async function search({ root, source, kind, query, mc, offset, category }) {
  kindOf(kind);
  query = String(query || '').trim().slice(0, 80);
  offset = Math.max(0, Math.min(5000, Number(offset) || 0));
  if (source !== 'modrinth' && source !== 'curseforge') throw new Error('Неизвестный каталог');
  const filter = modFilter(kind, category);
  const page = source === 'modrinth'
    ? await searchModrinth(kind, query, mc, offset, filter)
    : await searchCurse(kind, query, mc, offset, filter);
  for (const hit of page.hits) hit.installed = await installed(root, kind, source, hit.id);
  return page;
}

function plainText(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~`>]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1400);
}

function mapModrinthVersion(version, kind) {
  const file = (version.files || []).find(f => f.primary && rightExt(f.filename, kind))
    || (version.files || []).find(f => rightExt(f.filename, kind));
  if (!file?.url) return null;
  return {
    id: version.id,
    number: version.version_number || file.filename,
    type: version.version_type || 'release',
    date: version.date_published || '',
    gameVersions: (version.game_versions || []).slice(0, 4),
    filename: file.filename,
    size: file.size || 0,
  };
}

function mapCurseVersion(file, kind) {
  if (!rightExt(file.fileName || '', kind) || !curseUrl(file)) return null;
  const type = file.releaseType === 2 ? 'beta' : file.releaseType === 3 ? 'alpha' : 'release';
  return {
    id: String(file.id),
    number: file.displayName || file.fileName,
    type,
    date: file.fileDate || '',
    gameVersions: (file.gameVersions || []).filter(v => /^\d/.test(v)).slice(0, 4),
    filename: file.fileName,
    size: file.fileLength || 0,
  };
}

async function project({ source, kind, projectId, mc }) {
  const id = assertId(projectId);
  const spec = kindOf(kind);
  if (source === 'modrinth') {
    const params = new URLSearchParams({ game_versions: JSON.stringify([mc]) });
    if (spec.loader) params.set('loaders', JSON.stringify(['fabric']));
    const [info, versions] = await Promise.all([
      modrinth(`/project/${id}`),
      modrinth(`/project/${id}/version?` + params),
    ]);
    return {
      source,
      id,
      name: info.title || id,
      description: clip(info.description, 400),
      body: plainText(info.body),
      icon: httpsIcon(info.icon_url),
      downloads: info.downloads || 0,
      gallery: (info.gallery || []).slice(0, 8).map(shot => ({
        url: httpsIcon(shot.url || shot.raw_url),
        title: clip(shot.title || shot.description, 80),
      })).filter(shot => shot.url),
      versions: (versions || []).map(version => mapModrinthVersion(version, kind)).filter(Boolean).slice(0, 40),
    };
  }
  if (source === 'curseforge') {
    const params = new URLSearchParams({ gameVersion: mc, pageSize: '40' });
    if (spec.loader) params.set('modLoaderType', '4');
    const [info, files] = await Promise.all([
      curse(`/mods/${id}`),
      curse(`/mods/${id}/files?` + params),
    ]);
    const mod = info.data || {};
    return {
      source,
      id,
      name: mod.name || id,
      description: clip(mod.summary, 400),
      body: plainText(mod.summary),
      icon: httpsIcon(mod.logo?.url || mod.logo?.thumbnailUrl),
      downloads: mod.downloadCount || 0,
      gallery: (mod.screenshots || []).slice(0, 8).map(shot => ({
        url: httpsIcon(shot.url || shot.thumbnailUrl),
        title: clip(shot.title, 80),
      })).filter(shot => shot.url),
      versions: (files.data || []).map(file => mapCurseVersion(file, kind)).filter(Boolean),
    };
  }
  throw new Error('Неизвестный каталог');
}

function pickModrinth(versions, kind) {
  const list = (versions || []).filter(v => (v.files || []).some(f => rightExt(f.filename, kind)));
  const version = list.find(v => v.version_type === 'release') || list[0];
  if (!version) return null;
  const file = version.files.find(f => f.primary && rightExt(f.filename, kind))
    || version.files.find(f => rightExt(f.filename, kind));
  if (!file?.url) return null;
  return {
    url: file.url,
    filename: file.filename,
    sha1: file.hashes?.sha1 || '',
    size: file.size || 0,
    dependencies: kind === 'mod'
      ? (version.dependencies || [])
        .filter(d => d.dependency_type === 'required' && d.project_id)
        .map(d => ({ source: 'modrinth', id: d.project_id }))
      : [],
  };
}

function rightExt(name, kind) {
  return kind === 'mod' ? /\.jar$/i.test(name) : /\.zip$/i.test(name);
}

function curseUrl(file) {
  if (file.downloadUrl) return file.downloadUrl;
  const id = String(file.id || '');
  if (id.length < 5 || !file.fileName) return '';
  return `https://edge.forgecdn.net/files/${id.slice(0, 4)}/${id.slice(4)}/${encodeURIComponent(file.fileName)}`;
}

function pickCurse(files, kind) {
  const list = (files || []).filter(f => rightExt(f.fileName || '', kind) && curseUrl(f));
  const file = list.find(f => f.releaseType === 1) || list[0];
  if (!file) return null;
  const sha1 = (file.hashes || []).find(h => h.algo === 1)?.value || '';
  return {
    url: curseUrl(file),
    filename: file.fileName,
    sha1,
    size: file.fileLength || 0,
    dependencies: kind === 'mod'
      ? (file.dependencies || [])
        .filter(d => d.relationType === 3 && d.modId)
        .map(d => ({ source: 'curseforge', id: String(d.modId) }))
      : [],
  };
}

async function resolve(source, kind, projectId, mc, versionId) {
  const id = assertId(projectId);
  kindOf(kind);
  if (versionId) assertId(versionId);
  if (source === 'modrinth') {
    if (versionId) {
      const version = await modrinth(`/version/${versionId}`);
      if (version.project_id !== id) throw new Error('Эта версия от другого проекта');
      const file = pickModrinth([version], kind);
      if (!file) throw new Error('В этой версии нет подходящего файла');
      return file;
    }
    const params = new URLSearchParams({ game_versions: JSON.stringify([mc]) });
    if (KINDS[kind].loader) params.set('loaders', JSON.stringify(['fabric']));
    const versions = await modrinth(`/project/${id}/version?` + params);
    const file = pickModrinth(versions, kind);
    if (!file) throw new Error(`Для Minecraft ${mc} нет подходящего файла`);
    return file;
  }
  if (source === 'curseforge') {
    if (versionId) {
      const data = await curse(`/mods/${id}/files/${versionId}`);
      const file = pickCurse([data.data], kind);
      if (!file) throw new Error('В этой версии нет подходящего файла');
      return file;
    }
    const params = new URLSearchParams({ gameVersion: mc, pageSize: '12' });
    if (KINDS[kind].loader) params.set('modLoaderType', '4');
    const data = await curse(`/mods/${id}/files?` + params);
    const file = pickCurse(data.data, kind);
    if (!file) throw new Error(`Для Minecraft ${mc} нет подходящего файла`);
    return file;
  }
  throw new Error('Неизвестный каталог');
}

async function download(url, file, sha1) {
  if (!/^https:\/\//.test(url)) throw new Error('Ссылка на файл не подходит');
  const res = await fetchWithRetry(url);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.part';
  const hash = crypto.createHash('sha1');
  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), hasher, fs.createWriteStream(tmp));
    if (sha1 && hash.digest('hex') !== sha1.toLowerCase()) throw new Error('Файл скачался с ошибкой');
    await fsp.rm(file, { force: true });
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

module.exports = { search, project, resolve, download, remember, modFilter };
