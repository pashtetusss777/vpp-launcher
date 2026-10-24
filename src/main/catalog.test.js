'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { modFilter } = require('./catalog');

test('mod categories map to both catalogs', () => {
  assert.equal(modFilter('mod', ''), null);
  assert.equal(modFilter('resourcepack', 'magic'), null);
  assert.deepEqual(modFilter('mod', 'magic'), { modrinth: 'magic', curse: 419 });
  assert.deepEqual(modFilter('mod', 'optimization'), { modrinth: 'optimization', curse: 6814 });
  assert.throws(() => modFilter('mod', 'nope'), /Неизвестная категория/);
});
