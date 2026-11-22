'use strict';

const fs = require('fs');
const path = require('path');
const { offlineUuid } = require('./system');

const MARK = 'enc1.';

function locker() {
  try {
    const { safeStorage } = require('electron');
    return safeStorage.isEncryptionAvailable() ? safeStorage : null;
  } catch {
    return null;
  }
}

const DEFAULTS = {
  accounts: [],
  current: null,
  ram: null,
  javaMode: 'bundled',
  javaPath: '',
  jvmArgs: '',
  theme: 0,
  themeMode: 'dark',
  accent: null,
  autoAccent: false,
  font: 'noto',
  background: 'sakura',
  customBackground: null,
  particles: true,
  width: 1280,
  height: 720,
  fullscreen: false,
  gameDir: '',
  afterLaunch: 'hide',
  beta: false,
  servers: null,
  lastLaunch: null,
  analytics: false,
  consentAsked: false,
  clientId: null,
  gpu: null,
  discreteGpu: true,
};

class Settings {
  constructor(file, seeded) {
    this.file = file;
    this.data = { ...DEFAULTS, accounts: [] };
    let fresh = false;
    try {
      const stored = JSON.parse(unwrapPayload(fs.readFileSync(file)));
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)
        || (stored.accounts !== undefined && !Array.isArray(stored.accounts))) throw new Error('Invalid settings');
      Object.assign(this.data, stored);
    } catch (e) {
      if (e.code !== 'ENOENT') {
        throw new Error('Не удалось прочитать настройки. Файл сохранён без изменений; восстановите резервную копию.', { cause: e });
      }
      fresh = true;
    }
    if (fresh && seeded && typeof seeded === 'object') {
      for (const [key, value] of Object.entries(seeded)) {
        if (Object.hasOwn(DEFAULTS, key)) this.data[key] = value;
      }
    }
    normalizeAccounts(this.data);
    // Keep the pre-migration profile before the first encrypted save.
    if (!fresh && !fs.existsSync(file + '.bak')) fs.copyFileSync(file, file + '.bak', fs.constants.COPYFILE_EXCL);
    this.timer = null;
  }

  get() {
    return this.data;
  }

  view() {
    return {
      ...this.data,
      accounts: this.data.accounts.map(publicAccount),
      lastLaunch: this.data.lastLaunch ? {
        at: this.data.lastLaunch.at, server: this.data.lastLaunch.server,
      } : null,
    };
  }

  selectAccount(id) {
    if (!this.data.accounts.some(account => account.id === id)) throw new Error('Аккаунт не найден');
    this.update({ current: id });
    return this.view();
  }

  removeAccount(id) {
    const accounts = this.data.accounts.filter(account => account.id !== id);
    this.update({ accounts, current: this.data.current === id ? accounts[0]?.id || null : this.data.current });
    return this.view();
  }

  addOffline(name) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Некорректный ник');
    const id = `offline:${name.toLowerCase()}`;
    const accounts = this.data.accounts.slice();
    if (!accounts.some(account => account.id === id)) {
      accounts.push({ id, type: 'offline', name, uuid: offlineUuid(name) });
    }
    this.update({ accounts, current: id });
    return publicAccount(accounts.find(account => account.id === id));
  }

  update(patch) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (Object.hasOwn(DEFAULTS, key)) this.data[key] = value;
    }
    this.save();
    return this.data;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 250);
  }

  flush() {
    clearTimeout(this.timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, writePayload(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('settings not saved', e);
    }
  }
}

// Older builds stored a bare nickname. An account is now { id, type, name, uuid, ...tokens }.
function normalizeAccounts(data) {
  const accounts = [];
  for (const item of data.accounts || []) {
    if (typeof item === 'string' && item) {
      accounts.push({ id: `offline:${item.toLowerCase()}`, type: 'offline', name: item, uuid: offlineUuid(item) });
    } else if (item && item.name) {
      accounts.push(item.type ? item : { ...item, type: 'offline', id: item.id || `offline:${String(item.name).toLowerCase()}` });
    }
  }
  data.accounts = accounts;
  const current = accounts.find(a => a.id === data.current) || accounts.find(a => a.name === data.current);
  data.current = current ? current.id : (accounts[0]?.id || null);
}

function publicAccount(account) {
  const { id, type, name, uuid, skinUrl } = account;
  return { id, type, name, uuid, skinUrl };
}

function unwrapPayload(raw, box = locker()) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
  if (buf.length >= MARK.length && buf.subarray(0, MARK.length).toString() === MARK) {
    if (!box) throw new Error('cannot decrypt settings');
    return box.decryptString(Buffer.from(buf.subarray(MARK.length).toString('utf8'), 'base64'));
  }
  const text = buf.toString('utf8');
  const data = JSON.parse(text);
  if (!data.accountSecrets) return text;
  if (!box || !String(data.accountSecrets).startsWith(MARK)) throw new Error('cannot decrypt account secrets');
  const secrets = JSON.parse(box.decryptString(Buffer.from(data.accountSecrets.slice(MARK.length), 'base64')));
  data.accounts = (data.accounts || []).map(account => ({
    ...secrets.find(secret => secret.id === account.id), ...account,
  }));
  delete data.accountSecrets;
  return JSON.stringify(data);
}

function writePayload(data, box = locker()) {
  if (!box) return JSON.stringify(data, null, 2);
  const secrets = (data.accounts || []).map(({ id, accessToken, refreshToken, clientToken }) => ({
    id, accessToken, refreshToken, clientToken,
  }));
  // Older builds must still see valid JSON, profiles and preferences instead of resetting everything.
  return JSON.stringify({
    ...data,
    accounts: (data.accounts || []).map(({ accessToken, refreshToken, clientToken, ...profile }) => profile),
    lastLaunch: data.lastLaunch ? { at: data.lastLaunch.at, server: data.lastLaunch.server } : null,
    accountSecrets: MARK + box.encryptString(JSON.stringify(secrets)).toString('base64'),
  }, null, 2);
}

module.exports = { Settings, DEFAULTS, normalizeAccounts, writePayload, unwrapPayload, publicAccount };
