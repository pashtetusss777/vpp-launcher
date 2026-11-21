'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { targetDir, installTrustedZip } = require('./install');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vpp-setup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'Vanilla++');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'Vanilla++.exe'), 'old-app');
  await fs.writeFile(path.join(target, 'user.txt'), 'user-data');
  return { root, target };
}

async function unpack(_zip, staged) {
  await fs.writeFile(path.join(staged, 'Vanilla++.exe'), 'new-app');
}

test('failed extraction never touches a working installation', async t => {
  const { target } = await fixture(t);
  await assert.rejects(installTrustedZip(target, target, 'dummy.zip', async () => {
    throw new Error('bad archive');
  }), /bad archive/);
  assert.equal(await fs.readFile(path.join(target, 'Vanilla++.exe'), 'utf8'), 'old-app');
  assert.equal(await fs.readFile(path.join(target, 'user.txt'), 'utf8'), 'user-data');
});

test('new and existing installations work, preserving user files and a previous tree', async t => {
  const { root, target } = await fixture(t);
  assert.equal(await installTrustedZip(target, target, 'dummy.zip', unpack), target);
  assert.equal(await fs.readFile(path.join(target, 'Vanilla++.exe'), 'utf8'), 'new-app');
  assert.equal(await fs.readFile(path.join(target, 'user.txt'), 'utf8'), 'user-data');
  const previous = (await fs.readdir(root)).find(name => name.startsWith('Vanilla++.previous-'));
  assert.equal(await fs.readFile(path.join(root, previous, 'Vanilla++.exe'), 'utf8'), 'old-app');
  const fresh = path.join(root, 'fresh', 'Vanilla++');
  await installTrustedZip(fresh, fresh, 'dummy.zip', unpack);
  assert.equal(await fs.readFile(path.join(fresh, 'Vanilla++.exe'), 'utf8'), 'new-app');
});

test('failure to commit restores the old tree', async t => {
  const { target } = await fixture(t);
  const rename = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (from.startsWith(target + '.install-')) throw new Error('rename denied');
    return rename(from, to);
  });
  await assert.rejects(installTrustedZip(target, target, 'dummy.zip', unpack), /rename denied/);
  assert.equal(await fs.readFile(path.join(target, 'Vanilla++.exe'), 'utf8'), 'old-app');
  assert.equal(await fs.readFile(path.join(target, 'user.txt'), 'utf8'), 'user-data');
});

test('foreign directories are rejected without touching their files', async t => {
  const { target } = await fixture(t);
  await fs.unlink(path.join(target, 'Vanilla++.exe'));
  await assert.rejects(installTrustedZip(target, target, 'dummy.zip', unpack), /Папка не пуста/);
  assert.equal(await fs.readFile(path.join(target, 'user.txt'), 'utf8'), 'user-data');
  assert.throws(() => targetDir(path.parse(target).root, target), /не корень диска/);
});
