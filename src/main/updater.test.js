'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cmp } = require('./updater');

test('a beta is older than the stable release with the same numbers', () => {
  assert.ok(cmp('1.1.11-beta.1', '1.1.11') < 0);
  assert.ok(cmp('1.1.11-beta.1', '1.1.10') > 0);
  assert.ok(cmp('1.1.11-beta.2', '1.1.11-beta.1') > 0);
  assert.equal(cmp('1.1.10', '1.1.10'), 0);
  assert.ok(cmp('1.1.10', '1.1.9') > 0);
});
