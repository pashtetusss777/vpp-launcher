'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { iconOf, readVarint, statusOf } = require('./ping');

test('a server favicon must be a data image without markup', () => {
  assert.equal(iconOf({ favicon: 'data:image/png;base64,abc' }), 'data:image/png;base64,abc');
  assert.equal(iconOf({ favicon: 'https://evil/x.png' }), null);
  assert.equal(iconOf({ favicon: 'data:image/png;base64,a" onerror=x' }), null);
  assert.equal(iconOf({ favicon: '<img>' }), null);
  assert.equal(iconOf({ favicon: 'data:image/' + 'a'.repeat(200001) }), null);
});

test('truncated, oversized and malformed status fields are rejected', () => {
  assert.equal(readVarint(Buffer.from([0x80]), 0), null);
  assert.throws(() => readVarint(Buffer.from([255, 255, 255, 255, 255, 0]), 0));
  for (const body of [Buffer.alloc(0), Buffer.from([8, 123]), Buffer.from([4, 110, 117, 108, 108])]) {
    assert.throws(() => statusOf(body, 0));
  }
  const json = Buffer.from('{"players":{"online":1}}');
  assert.equal(statusOf(Buffer.concat([Buffer.from([json.length]), json]), 0).players.online, 1);
});
