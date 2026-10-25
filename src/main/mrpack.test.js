'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { applyOverrides, installDropped, installIndex } = require('./mrpack');
const { openZip, readEntry } = require('./zip');

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const raw = Buffer.from(entry.data);
    const stored = entry.method === 0 || entry.method === 9;
    const comp = stored ? raw : zlib.deflateRawSync(raw);
    const method = entry.method == null ? 8 : entry.method;
    const claimed = entry.uncompressed == null ? raw.length : entry.uncompressed;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(claimed, 22);
    local.writeUInt16LE(name.length, 26);
    const chunk = Buffer.concat([local, name, comp]);
    locals.push(chunk);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(claimed, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += chunk.length;
  }
  const dir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}

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
