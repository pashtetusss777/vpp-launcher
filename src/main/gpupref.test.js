'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const gpupref = require('./gpupref');

test('the registry value is exactly the Java path and the high-performance flag', () => {
  const exe = String.raw`C:\Users\me\AppData\Roaming\.vanilla-plus-plus\runtime\java-runtime\bin\javaw.exe`;
  assert.deepEqual(gpupref.addArgs(exe), ['add', String.raw`HKCU\Software\Microsoft\DirectX\UserGpuPreferences`,
    '/v', exe, '/t', 'REG_SZ', '/d', 'GpuPreference=2;', '/f']);
  assert.deepEqual(gpupref.deleteArgs(exe), ['delete', String.raw`HKCU\Software\Microsoft\DirectX\UserGpuPreferences`,
    '/v', exe, '/f']);
});

test('only values with our format count as ours', () => {
  const output = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\DirectX\\UserGpuPreferences',
    '    C:\\games\\javaw.exe    REG_SZ    GpuPreference=2;',
    '    DirectXUserGlobalPreferences    REG_SZ    SwapChainUpgradeMode=1;',
    '    C:\\other\\game.exe    REG_SZ    AutoHDREnable=2;',
    '',
  ].join('\r\n');
  assert.deepEqual(gpupref.ourPaths(output), ['C:\\games\\javaw.exe']);
  assert.deepEqual(gpupref.ourPaths(''), []);
});
