'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cmp, downloadHostOk, digestOf } = require('./updater');

test('a beta is older than the stable release with the same numbers', () => {
  assert.ok(cmp('1.1.11-beta.1', '1.1.11') < 0);
  assert.ok(cmp('1.1.11-beta.1', '1.1.10') > 0);
  assert.ok(cmp('1.1.11-beta.2', '1.1.11-beta.1') > 0);
  assert.equal(cmp('1.1.10', '1.1.10'), 0);
  assert.ok(cmp('1.1.10', '1.1.9') > 0);
});

test('update files must come from GitHub over https with a sha256 digest', () => {
  assert.equal(downloadHostOk('https://github.com/o/r/releases/download/v1/a.zip'), true);
  assert.equal(downloadHostOk('https://evil.example/a.zip'), false);
  assert.equal(downloadHostOk('http://github.com/o/r/a.zip'), false);
  assert.equal(digestOf({ digest: 'sha256:' + 'a'.repeat(64) }), 'a'.repeat(64));
  assert.equal(digestOf({ digest: 'md5:aa' }), '');
});
