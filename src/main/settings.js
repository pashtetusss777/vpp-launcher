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
};

class Settings {
  constructor(file, seeded) {
    this.file = file;
    this.data = { ...DEFAULTS };
    let fresh = false;
    try {
      Object.assign(this.data, JSON.parse(unwrapPayload(fs.readFileSync(file))));
    } catch {
      fresh = true;
    }
    if (fresh && seeded && typeof seeded === 'object') {
      for (const [key, value] of Object.entries(seeded)) {
        if (key in DEFAULTS) this.data[key] = value;
      }
    }
    normalizeAccounts(this.data);
    this.timer = null;
  }

  get() {
    return this.data;
  }

  update(patch) {
    for (const [key, value] of Object.entries(patch || {})) {
      if (key in DEFAULTS) this.data[key] = value;
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

function unwrapPayload(raw, box = locker()) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
  if (buf.length >= MARK.length && buf.subarray(0, MARK.length).toString() === MARK) {
    if (!box) throw new Error('cannot decrypt settings');
    return box.decryptString(Buffer.from(buf.subarray(MARK.length).toString('utf8'), 'base64'));
  }
  return buf.toString('utf8');
}

function writePayload(data, box = locker()) {
  const text = JSON.stringify(data, null, 2);
  if (!box) return text;
  return MARK + box.encryptString(text).toString('base64');
}

module.exports = { Settings, DEFAULTS, normalizeAccounts, writePayload, unwrapPayload };
