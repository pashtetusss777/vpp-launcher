'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { writePayload, unwrapPayload, Settings } = require('./settings');

const box = {
  encryptString: s => Buffer.from(`X${s}`),
  decryptString: b => Buffer.from(b).toString('utf8').slice(1),
};

test('settings with tokens round-trip through the locker and stay out of plaintext', () => {
  const data = { accounts: [{ name: 'p', refreshToken: 'secret-token' }] };
  const packed = writePayload(data, box);
  assert.equal(String(packed).includes('secret-token'), false);
  const opened = JSON.parse(unwrapPayload(packed, box));
  assert.equal(opened.accounts[0].refreshToken, 'secret-token');
});

test('encrypted tokens leave legacy builds a valid JSON profile and the selected theme', () => {
  const data = {
    accounts: [{ id: 'msa:one', type: 'microsoft', name: 'Player', refreshToken: 'private-refresh', accessToken: 'private-access' }],
    themeMode: 'light', accent: [178, 178, 178], current: 'msa:one',
    lastLaunch: { at: 1, account: { accessToken: 'old-secret' } },
  };
  const payload = writePayload(data, box);
  const legacy = JSON.parse(payload);
  assert.equal(legacy.accounts[0].name, 'Player');
  assert.equal(legacy.accounts[0].refreshToken, undefined);
  assert.equal(legacy.themeMode, 'light');
  assert.equal(payload.includes('private-refresh'), false);
  assert.equal(payload.includes('private-access'), false);
  assert.equal(payload.includes('old-secret'), false);
  legacy.themeMode = 'dark'; // The previous release's read/modify/write must retain the encrypted tokens.
  const opened = JSON.parse(unwrapPayload(JSON.stringify(legacy), box));
  assert.equal(opened.accounts[0].refreshToken, 'private-refresh');
  assert.equal(opened.themeMode, 'dark');
});

test('legacy full-file encryption is still readable', () => {
  const json = JSON.stringify({ accounts: [{ name: 'Player' }], themeMode: 'light' });
  assert.equal(unwrapPayload('enc1.' + box.encryptString(json).toString('base64'), box), json);
});

test('unreadable settings are never silently replaced by defaults', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vpp-settings-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  for (const text of ['broken-settings', 'null', '[]', '{"accounts":{}}']) {
    await fsp.writeFile(file, text);
    assert.throws(() => new Settings(file), /Файл сохранён без изменений/);
    assert.equal(await fsp.readFile(file, 'utf8'), text);
  }
});

test('without a keyring the tokens are dropped instead of written in the clear', () => {
  const data = {
    accounts: [{ id: 'msa:one', type: 'microsoft', name: 'Player', refreshToken: 'private-refresh' }],
    themeMode: 'light',
  };
  const payload = writePayload(data, null);
  assert.equal(payload.includes('private-refresh'), false);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.accounts[0].name, 'Player');
  assert.equal(parsed.accounts[0].refreshToken, undefined);
});

test('server lists are shape-checked before they reach the network layer', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vpp-servers-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'settings.json');
  await fsp.writeFile(file, JSON.stringify({ accounts: [] }));
  const settings = new Settings(file);
  t.after(() => clearTimeout(settings.timer));
  assert.throws(() => settings.update({ servers: [{ name: 'x', address: 'bad path' }] }), /Некорректный список/);
  assert.throws(() => settings.update({ servers: 'lol' }), /Некорректный список/);
  settings.update({ servers: [{ name: 'Vanilla++', address: 'mc.vanillaplus.plus' }] });
  assert.equal(settings.get().servers[0].address, 'mc.vanillaplus.plus');
});

test('account selection, removal and adding offline profiles preserve refreshed tokens', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'vpp-accounts-'));
  let settings;
  t.after(() => {
    clearTimeout(settings?.timer);
    return fsp.rm(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'settings.json');
  const initial = JSON.stringify({
    accounts: [{ id: 'msa:one', type: 'microsoft', name: 'Player', refreshToken: 'old-refresh' }],
    current: 'msa:one', themeMode: 'light',
  });
  await fsp.writeFile(file, initial);
  settings = new Settings(file);
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), initial);
  settings.update({ accounts: [{ ...settings.get().accounts[0], refreshToken: 'fresh-refresh' }] });
  const offline = settings.addOffline('Other');
  settings.selectAccount('msa:one');
  settings.removeAccount(offline.id);
  assert.equal(settings.get().accounts[0].refreshToken, 'fresh-refresh');
  assert.equal(settings.view().accounts[0].refreshToken, undefined);
  assert.equal(JSON.stringify(settings.view()).includes('fresh-refresh'), false);
  assert.equal(settings.get().themeMode, 'light');
  assert.throws(() => settings.addOffline('bad/name'), /Некорректный ник/);
});
