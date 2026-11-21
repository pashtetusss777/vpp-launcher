'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const mods = require('./mods');
const zip = require('./fixtures/zip');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vpp-mods-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'mods'));
  const jar = zip([{ name: 'fabric.mod.json', data: JSON.stringify({ id: 'example', name: 'Example', version: '1' }) }]);
  const old = path.join(root, 'mods', 'old.jar');
  const source = path.join(root, 'new.jar');
  await fs.writeFile(old, jar);
  await fs.writeFile(source, jar);
  return { root, jar, old, source };
}

test('adding a mod already in mods never deletes its source', async t => {
  const { root, old, jar } = await fixture(t);
  await mods.add(root, '26.2', [old]);
  assert.deepEqual(await fs.readFile(old), jar);
});

test('copy failure preserves the working mod', async t => {
  const { root, old, jar, source } = await fixture(t);
  t.mock.method(fs, 'copyFile', async () => { throw new Error('disk full'); });
  await assert.rejects(mods.add(root, '26.2', [source]), /disk full/);
  assert.deepEqual(await fs.readFile(old), jar);
});

test('commit failure preserves the working mod', async t => {
  const { root, old, jar, source } = await fixture(t);
  t.mock.method(fs, 'rename', async () => { throw new Error('file busy'); });
  await assert.rejects(mods.add(root, '26.2', [source]), /file busy/);
  assert.deepEqual(await fs.readFile(old), jar);
});

test('two files for one mod in a batch leave only the last version', async t => {
  const { root, source, jar } = await fixture(t);
  const next = path.join(root, 'next.jar');
  await fs.writeFile(next, jar);
  await mods.add(root, '26.2', [source, next]);
  assert.deepEqual(await fs.readdir(path.join(root, 'mods')), ['next.jar']);
});
