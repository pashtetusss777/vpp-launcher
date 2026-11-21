'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cmp, downloadHostOk, digestOf, assetFor } = require('./updater');

test('a beta is older than the stable release with the same numbers', () => {
  assert.ok(cmp('1.1.11-beta.1', '1.1.11') < 0);
  assert.ok(cmp('1.1.11-beta.1', '1.1.10') > 0);
  assert.ok(cmp('1.1.11-beta.2', '1.1.11-beta.1') > 0);
  assert.equal(cmp('1.1.10', '1.1.10'), 0);
  assert.ok(cmp('1.1.10', '1.1.9') > 0);
});

test('release assets use the same architecture names as the build configuration', () => {
  const version = '1.1.9';
  const names = ['portable.zip', 'arm64.zip', 'x64.zip', 'arm64.AppImage', 'x64.AppImage', 'arm64.tar.gz', 'x64.tar.gz'];
  const assets = names.map(suffix => ({ name: `VanillaPlusPlus-${version}-${suffix}` }));
  for (const [platform, arch, appImage, suffix] of [
    ['win32', 'x64', '', 'portable.zip'],
    ['darwin', 'arm64', '', 'arm64.zip'],
    ['darwin', 'x64', '', 'x64.zip'],
    ['linux', 'x64', '/app.AppImage', 'x64.AppImage'],
    ['linux', 'arm64', '/app.AppImage', 'arm64.AppImage'],
    ['linux', 'x64', '', 'x64.tar.gz'],
    ['linux', 'arm64', '', 'arm64.tar.gz'],
  ]) {
    assert.equal(assetFor(assets, version, platform, arch, appImage).name, `VanillaPlusPlus-${version}-${suffix}`);
  }
});

test('update files must come from GitHub over https with a sha256 digest', () => {
  assert.equal(downloadHostOk('https://github.com/o/r/releases/download/v1/a.zip'), true);
  assert.equal(downloadHostOk('https://evil.example/a.zip'), false);
  assert.equal(downloadHostOk('http://github.com/o/r/a.zip'), false);
  assert.equal(digestOf({ digest: 'sha256:' + 'a'.repeat(64) }), 'a'.repeat(64));
  assert.equal(digestOf({ digest: 'md5:aa' }), '');
});
