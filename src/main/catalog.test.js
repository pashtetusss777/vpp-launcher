'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { modFilter, project, resolve } = require('./catalog');

test('mod categories map to both catalogs', () => {
  assert.equal(modFilter('mod', ''), null);
  assert.equal(modFilter('resourcepack', 'magic'), null);
  assert.deepEqual(modFilter('mod', 'magic'), { modrinth: 'magic', curse: 419 });
  assert.deepEqual(modFilter('mod', 'optimization'), { modrinth: 'optimization', curse: 6814 });
  assert.throws(() => modFilter('mod', 'nope'), /Неизвестная категория/);
});

test('CurseForge project details and selected files use the same mirror', async t => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    assert.ok(url.startsWith('https://mod.mcimirror.top/curseforge/v1/'));
    if (url.endsWith('/mods/12345')) return Response.json({ data: { id: 12345, name: 'Example' } });
    const file = { id: 1234567, fileName: 'example.jar', releaseType: 1,
      downloadUrl: 'https://edge.forgecdn.net/files/1234/567/example.jar',
      hashes: [{ algo: 1, value: 'a'.repeat(40) }], dependencies: [] };
    return Response.json({ data: url.includes('/files?') ? [file] : file });
  });
  const details = await project({ source: 'curseforge', kind: 'mod', projectId: '12345', mc: '26.2' });
  assert.equal(details.versions[0].id, '1234567');
  const file = await resolve('curseforge', 'mod', '12345', '26.2', '1234567');
  assert.equal(file.url, 'https://mod.mcimirror.top/files/1234/567/example.jar');
  assert.equal(file.sha1, 'a'.repeat(40));
  assert.equal(urls.length, 3);
});
