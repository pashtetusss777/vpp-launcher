'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { applyOverrides, installDropped, installIndex, safeRel, sync, rangeSatisfied } = require('./mrpack');
const { openZip, readEntry } = require('./zip');
const zip = require('./fixtures/zip');

async function tempRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vpp-mrpack-'));
  await fsp.writeFile(path.join(root, 'keep.txt'), 'mine');
  return root;
}

test('overrides land in the game folder and client-overrides win', async () => {
  const root = await tempRoot();
  const pack = path.join(root, 'pack.mrpack');
  fs.writeFileSync(pack, zip([
    { name: 'overrides/options.txt', data: 'from-overrides' },
    { name: 'client-overrides/options.txt', data: 'from-client' },
  ]));
  const applied = await applyOverrides(pack, root);
  assert.deepEqual(applied, ['options.txt', 'options.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'options.txt'), 'utf8'), 'from-client');
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'mine');
  assert.equal(fs.existsSync(path.join(root, 'launcher', 'mrpack-staging')), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test('a later bad entry does not touch the game folder', async () => {
  const root = await tempRoot();
  const pack = path.join(root, 'pack.mrpack');
  fs.writeFileSync(pack, zip([
    { name: 'overrides/options.txt', data: 'from-overrides' },
    { name: 'overrides/config/bad.bin', data: 'nope', method: 9 },
  ]));
  await assert.rejects(() => applyOverrides(pack, root), /Не удалось прочитать файл сборки: config\/bad\.bin/);
  assert.equal(fs.existsSync(path.join(root, 'options.txt')), false);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'mine');
  await fsp.rm(root, { recursive: true, force: true });
});

test('a jar that cannot be read is an error', async () => {
  const root = await tempRoot();
  const file = path.join(root, 'mods.zip');
  fs.writeFileSync(file, zip([{ name: 'Big.jar', data: 'nope', method: 9 }]));
  await assert.rejects(() => installDropped(root, file, '1.21'), /Не удалось прочитать файл сборки: Big\.jar/);
  assert.equal(fs.existsSync(path.join(root, 'mods')), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test('a pack file at the instance root is installed', async () => {
  const root = await tempRoot();
  const pack = path.join(root, 'pack.mrpack');
  fs.writeFileSync(pack, zip([
    { name: 'overrides/command_history.txt', data: 'give @s apple\n' },
  ]));
  await applyOverrides(pack, root);
  assert.equal(fs.readFileSync(path.join(root, 'command_history.txt'), 'utf8'), 'give @s apple\n');
  await fsp.rm(root, { recursive: true, force: true });
});

test('a disabled pack mod is not downloaded again', async () => {
  const root = await tempRoot();
  const body = Buffer.from('mod-bytes');
  const sha1 = crypto.createHash('sha1').update(body).digest('hex');
  const index = {
    game: 'minecraft',
    files: [{
      path: 'mods/MidnightControls.jar',
      hashes: { sha1 },
      fileSize: body.length,
      downloads: ['https://cdn.modrinth.com/data/x/versions/y/MidnightControls.jar'],
      env: { client: 'required' },
    }],
  };
  const pack = path.join(root, 'pack.mrpack');
  fs.writeFileSync(pack, zip([{ name: 'modrinth.index.json', data: JSON.stringify(index) }]));
  const modsDir = path.join(root, 'mods');
  await fsp.mkdir(modsDir);
  await fsp.writeFile(path.join(modsDir, 'MidnightControls.jar.disabled'), body);
  const applied = await installIndex(root, pack);
  assert.equal(applied.missing.length, 0);
  assert.equal(fs.existsSync(path.join(modsDir, 'MidnightControls.jar')), false);
  assert.equal(fs.readFileSync(path.join(modsDir, 'MidnightControls.jar.disabled')).equals(body), true);
  await fsp.rm(root, { recursive: true, force: true });
});

test('an override cannot leave the game folder or replace launcher state', async () => {
  const root = await tempRoot();
  const pack = path.join(root, 'pack.mrpack');
  fs.writeFileSync(pack, zip([
    { name: 'overrides/../../outside.txt', data: 'no' },
    { name: 'overrides/launcher/pack.json', data: '{}' },
  ]));
  await assert.rejects(() => applyOverrides(pack, root), /Небезопасный путь/);
  assert.equal(fs.readFileSync(path.join(root, 'keep.txt'), 'utf8'), 'mine');
  assert.equal(fs.existsSync(path.join(root, 'launcher', 'pack.json')), false);
  await fsp.rm(root, { recursive: true, force: true });
});

test('leftover mods tied to an older Minecraft go to the trash, unknown ones stay', async t => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.mkdir(path.join(root, 'mods'), { recursive: true });
  const jar = (depends) => zip([{ name: 'fabric.mod.json', data: JSON.stringify({
    id: 'x', name: 'X', version: '1', ...(depends ? { depends: { minecraft: depends } } : {}),
  }) }]);
  await fsp.writeFile(path.join(root, 'mods', 'stale.jar'), jar(['26.2']));
  await fsp.writeFile(path.join(root, 'mods', 'stale-disabled.jar.disabled'), jar('>=26.2 <26.3'));
  await fsp.writeFile(path.join(root, 'mods', 'user-unknown.jar'), jar(null));
  await fsp.writeFile(path.join(root, 'mods', 'not-a-mod.jar'), 'garbage');
  await fsp.writeFile(path.join(root, 'mods', 'kept.jar'), jar('>=26.3'));
  const cache = path.join(root, 'launcher', 'mrpack');
  await fsp.mkdir(cache, { recursive: true });
  const newIndex = { game: 'minecraft', files: [], dependencies: { minecraft: '26.3' } };
  const newPack = path.join(root, 'launcher', 'mrpack', 'newver.mrpack');
  await fsp.writeFile(newPack, zip([{ name: 'modrinth.index.json', data: JSON.stringify(newIndex) }]));
  const applied = await installIndex(root, newPack, {});
  assert.deepEqual(applied.swept.sort(), ['stale-disabled.jar.disabled', 'stale.jar']);
  assert.equal(fs.existsSync(path.join(root, 'launcher', 'removed', 'stale.jar')), true);
  assert.equal(fs.existsSync(path.join(root, 'mods', 'user-unknown.jar')), true);
  assert.equal(fs.existsSync(path.join(root, 'mods', 'not-a-mod.jar')), true);
  assert.equal(fs.existsSync(path.join(root, 'mods', 'kept.jar')), true);
});

test('fabric-style ranges are read the way the loader reads them', () => {
  const parts = [26, 3, 0];
  assert.equal(require('./mrpack').rangeSatisfied(parts, ['26.2']), false);
  assert.equal(require('./mrpack').rangeSatisfied(parts, ['26.3']), true);
  assert.equal(require('./mrpack').rangeSatisfied(parts, '>=26.2 <26.3'), false);
  assert.equal(require('./mrpack').rangeSatisfied(parts, '>=26.2'), true);
  assert.equal(require('./mrpack').rangeSatisfied(parts, '~26.2'), false);
  assert.equal(require('./mrpack').rangeSatisfied(parts, '~26.3'), true);
  assert.equal(require('./mrpack').rangeSatisfied(parts, '^26.2'), true);
  assert.equal(require('./mrpack').rangeSatisfied(parts, '26.x'), true);
  assert.equal(require('./mrpack').rangeSatisfied(parts, '>=26.2 <26.4'), true);
  assert.equal(require('./mrpack').rangeSatisfied(parts, ['26.2', '26.3']), true);
  assert.equal(require('./mrpack').rangeSatisfied(parts, 'who-knows-what'), true);
});

test('the removal sweep knows the previous mrpack index and disabled twins', async t => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // The old pack's index; old launchers never recorded entries without sha1 in pack.json.
  const oldIndex = {
    game: 'minecraft',
    files: [
      { path: 'mods/oldmod.jar', downloads: ['https://cdn.modrinth.com/old.jar'] },
      { path: 'mods/twin.jar', hashes: { sha1: 'x' }, downloads: ['https://cdn.modrinth.com/twin.jar'] },
    ],
    dependencies: { minecraft: '26.2' },
  };
  const cache = path.join(root, 'launcher', 'mrpack');
  await fsp.mkdir(cache, { recursive: true });
  await fsp.writeFile(path.join(cache, 'oldver.mrpack'), zip([{ name: 'modrinth.index.json', data: JSON.stringify(oldIndex) }]));
  await fsp.mkdir(path.join(root, 'mods'), { recursive: true });
  await fsp.writeFile(path.join(root, 'mods', 'oldmod.jar'), 'stale');
  await fsp.writeFile(path.join(root, 'mods', 'twin.jar.disabled'), 'off');
  const newIndex = { game: 'minecraft', files: [], dependencies: { minecraft: '26.3' } };
  const newPack = path.join(root, 'launcher', 'mrpack', 'newver.mrpack');
  await fsp.writeFile(newPack, zip([{ name: 'modrinth.index.json', data: JSON.stringify(newIndex) }]));
  const previous = { versionId: 'oldver', files: [{ path: 'mods/twin.jar', sha1: 'x' }] };
  await installIndex(root, newPack, { previous });
  assert.equal(fs.existsSync(path.join(root, 'mods', 'oldmod.jar')), false);
  assert.equal(fs.existsSync(path.join(root, 'mods', 'twin.jar.disabled')), false);
});

test('a zip header cannot ask for a directory bigger than the file', async () => {
  const root = await tempRoot();
  const pack = path.join(root, 'fake.zip');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(64 * 1048576, 12);
  fs.writeFileSync(pack, end);
  await assert.rejects(() => openZip(pack), /не zip-архив/);
  await fsp.rm(root, { recursive: true, force: true });
});

test('inflate stops at the size written in the archive', async () => {
  const root = await tempRoot();
  const pack = path.join(root, 'bomb.zip');
  fs.writeFileSync(pack, zip([
    { name: 'overrides/options.txt', data: 'hello', uncompressed: 1 },
  ]));
  await assert.rejects(async () => readEntry(await openZip(pack), 'overrides/options.txt', 1024));
  await fsp.rm(root, { recursive: true, force: true });
});

test('protected paths cannot hide behind dot segments or Windows aliases', () => {
  for (const rel of ['../../outside', 'launcher/pack.json', '././launcher/pack.json',
    'config/../../runtime/java', 'launcher./pack.json', 'launcher /pack.json', 'NUL', 'config/CON.txt',
    'config\\..\\launcher\\pack.json', 'C:\\outside', '/outside', '', '.', './']) {
    assert.throws(() => safeRel(rel), /Небезопасный путь/, rel);
  }
  assert.equal(safeRel('././config/test.json'), 'config/test.json');
  assert.equal(safeRel('command_history.txt'), 'command_history.txt');
});

test('a valid ZIP finishes adding its jars before staging is removed', async t => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const jar = zip([{ name: 'fabric.mod.json', data: JSON.stringify({ id: 'example', name: 'Example', version: '1' }) }]);
  const archive = path.join(root, 'mods.zip');
  await fsp.writeFile(archive, zip([{ name: 'mods/example.jar', data: jar }]));
  const result = await installDropped(root, archive, '26.2');
  assert.equal(result.results[0].error, undefined);
  assert.deepEqual(await fsp.readFile(path.join(root, 'mods', 'example.jar')), jar);
  assert.equal(fs.existsSync(path.join(root, 'launcher', 'import-staging')), false);
});

test('CurseForge imports mirror metadata and file downloads while checking sha1', async t => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const body = Buffer.from('dummy-mod-file');
  const sha1 = crypto.createHash('sha1').update(body).digest('hex');
  const archive = path.join(root, 'curse.zip');
  await fsp.writeFile(archive, zip([{ name: 'manifest.json', data: JSON.stringify({
    manifestType: 'minecraftModpack', name: 'Example', files: [{ projectID: 12345, fileID: 1234567 }],
  }) }]));
  const urls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    if (url === 'https://mod.mcimirror.top/curseforge/v1/mods/12345/files/1234567') {
      return Response.json({ data: { id: 1234567, fileName: 'example.jar', fileLength: body.length,
        downloadUrl: 'https://edge.forgecdn.net/files/1234/567/example.jar',
        hashes: [{ algo: 1, value: sha1 }] } });
    }
    assert.equal(url, 'https://mod.mcimirror.top/files/1234/567/example.jar');
    return new Response(body);
  });
  assert.equal((await installDropped(root, archive, '26.2')).downloaded, 1);
  assert.deepEqual(await fsp.readFile(path.join(root, 'mods', 'example.jar')), body);
  assert.equal(urls.length, 2);
});

test('unchanged packs preserve player configuration; a new pack applies its defaults', async t => {
  const root = await tempRoot();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const config = { minecraft: 'old', pack: { modrinthProject: 'example' } };
  const pack = zip([
    { name: 'modrinth.index.json', data: JSON.stringify({ game: 'minecraft', files: [], dependencies: { minecraft: '26.2' } }) },
    { name: 'overrides/options.txt', data: 'pack-defaults' },
  ]);
  const cache = path.join(root, 'launcher', 'mrpack');
  await fsp.mkdir(cache, { recursive: true });
  await fsp.writeFile(path.join(cache, 'v1.mrpack'), pack);
  let id = 'v1';
  t.mock.method(globalThis, 'fetch', async () => Response.json([{
    id, version_number: id, files: [{ filename: 'pack.mrpack', url: 'https://cdn.modrinth.com/example.mrpack',
      size: pack.length, hashes: { sha1: crypto.createHash('sha1').update(pack).digest('hex') } }],
  }]));
  assert.equal((await sync(root, config)).config.minecraft, '26.2');
  await fsp.writeFile(path.join(root, 'options.txt'), 'player-choice');
  await sync(root, config);
  assert.equal(await fsp.readFile(path.join(root, 'options.txt'), 'utf8'), 'player-choice');
  id = 'v2';
  await fsp.writeFile(path.join(cache, 'v2.mrpack'), pack);
  await sync(root, config);
  assert.equal(await fsp.readFile(path.join(root, 'options.txt'), 'utf8'), 'pack-defaults');
});
