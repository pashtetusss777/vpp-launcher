'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function on(channel, fn) {
  const listener = (_e, payload) => fn(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('vanilla', {
  init: () => call('init'),
  settings: patch => call('settings:update', patch),
  memory: () => call('system:memory'),
  mods: {
    list: () => call('mods:list'),
    builtin: () => call('mods:builtin'),
    add: files => call('mods:add', files),
    toggle: (file, on) => call('mods:toggle', file, on),
    remove: file => call('mods:remove', file),
    restore: token => call('mods:restore', token),
  },
  packs: {
    list: kind => call('packs:list', kind),
    add: (kind, files) => call('packs:add', kind, files),
    toggle: (kind, file, on) => call('packs:toggle', kind, file, on),
    remove: (kind, file) => call('packs:remove', kind, file),
    restore: (kind, token) => call('packs:restore', kind, token),
  },
  catalog: {
    search: (source, kind, query) => call('catalog:search', source, kind, query),
    project: (source, kind, projectId) => call('catalog:project', source, kind, projectId),
    install: (source, kind, projectId, versionId) => call('catalog:install', source, kind, projectId, versionId),
  },
  pack: {
    status: () => call('pack:status'),
    onStatus: fn => on('pack:status', fn),
  },
  update: {
    check: () => call('update:check'),
    install: () => call('update:install'),
    onProgress: fn => on('update:progress', fn),
  },
  game: {
    launch: server => call('game:launch', server),
    cancel: () => call('game:cancel'),
    stop: () => call('game:stop'),
    onProgress: fn => on('game:progress', fn),
    onState: fn => on('game:state', fn),
    onError: fn => on('game:error', fn),
  },
  open: {
    path: which => call('open:path', which),
    log: () => call('open:log'),
    file: file => call('open:file', file),
  },
  logs: {
    read: id => call('logs:read', id),
    open: id => call('logs:open', id),
  },
  pick: kind => call('pick', kind),
  setBackground: file => call('background:set', file),
  ping: address => call('ping', address),
  pathOf: file => webUtils.getPathForFile(file),
  auth: {
    ely: (username, password) => call('auth:ely', username, password),
    microsoft: () => call('auth:microsoft'),
    microsoftCancel: () => call('auth:microsoft-cancel'),
    onDevice: fn => on('auth:device', fn),
  },
  window: {
    minimize: () => call('window:minimize'),
    close: () => call('window:close'),
  },
});
