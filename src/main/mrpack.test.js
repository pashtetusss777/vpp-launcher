'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { applyOverrides, installDropped, installIndex, safeRel, sync } = require('./mrpack');
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
