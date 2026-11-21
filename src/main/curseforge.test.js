'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { request, fileUrl } = require('./curseforge');
const { USER_AGENT } = require('./util');

test('CurseForge requests use MCIM and the launcher User-Agent without an API key', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://mod.mcimirror.top/curseforge/v1/mods/search?gameId=432');
    assert.equal(options.headers['User-Agent'], USER_AGENT);
    assert.equal(options.headers['x-api-key'], undefined);
    return Response.json({ data: [] });
  });
  assert.deepEqual(await request('/mods/search?gameId=432'), { data: [] });
});

test('failed API requests retain the friendly error', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  await assert.rejects(request('/mods/12345'), /CurseForge не ответил/);
});

test('edge files are mirrored, while mediafilez and existing mirror URLs are preserved', () => {
  assert.equal(fileUrl({ downloadUrl: 'https://edge.forgecdn.net/files/1234/567/mod.jar' }),
    'https://mod.mcimirror.top/files/1234/567/mod.jar');
  for (const url of ['https://mediafilez.forgecdn.net/files/1234/567/mod.jar',
    'https://mod.mcimirror.top/files/1234/567/mod.jar']) {
    assert.equal(fileUrl({ downloadUrl: url }), url);
  }
});

test('missing URLs use the numeric file id, including eight-digit ids and zero suffixes', () => {
  assert.equal(fileUrl({ id: 1234567, fileName: 'mod name.jar' }),
    'https://mod.mcimirror.top/files/1234/567/mod%20name.jar');
  assert.equal(fileUrl({ id: 12345000, fileName: 'mod.jar' }),
    'https://mod.mcimirror.top/files/12345/0/mod.jar');
});

test('unknown hosts, plaintext URLs, credentials and invalid ids are not used', () => {
  for (const url of ['https://evil.example/mod.jar', 'http://edge.forgecdn.net/mod.jar',
    'https://edge.forgecdn.net.evil.example/mod.jar', 'https://user:pass@edge.forgecdn.net/mod.jar',
    'https://edge.forgecdn.net:444/mod.jar']) {
    assert.equal(fileUrl({ downloadUrl: url }), '');
  }
  for (const id of [0, -1, 'bad/id', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(fileUrl({ id, fileName: 'mod.jar' }), '');
  }
});
