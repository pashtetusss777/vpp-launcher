'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iconOf } = require('./ping');

test('a server favicon must be a data image without markup', () => {
  assert.equal(iconOf({ favicon: 'data:image/png;base64,abc' }), 'data:image/png;base64,abc');
  assert.equal(iconOf({ favicon: 'https://evil/x.png' }), null);
  assert.equal(iconOf({ favicon: 'data:image/png;base64,a" onerror=x' }), null);
  assert.equal(iconOf({ favicon: '<img>' }), null);
  assert.equal(iconOf({ favicon: 'data:image/' + 'a'.repeat(200001) }), null);
});
