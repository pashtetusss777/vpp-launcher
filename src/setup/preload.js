'use strict';

const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

contextBridge.exposeInMainWorld('setup', {
  info: () => call('setup:info'),
  pick: () => call('setup:pick'),
  install: opts => call('setup:install', opts),
  launch: () => call('setup:launch'),
  close: () => call('setup:close'),
  minimize: () => call('setup:minimize'),
  onProgress: fn => {
    const listener = (_e, payload) => fn(payload);
    ipcRenderer.on('setup:progress', listener);
    return () => ipcRenderer.removeListener('setup:progress', listener);
  },
});
