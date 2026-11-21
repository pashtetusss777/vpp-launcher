'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { MAX_LOG_BYTES, takeLogLines } = require('./logs');

test('partial log lines and unfinished XML remain bounded', () => {
  for (const id of ['game', 'output']) {
    const state = { pending: '' };
    for (let i = 0; i < 20; i++) takeLogLines(state, id, '<log4j:Event>' + 'x'.repeat(128 * 1024));
    assert.ok(state.pending.length <= MAX_LOG_BYTES);
  }
});

test('complete text lines and XML messages are emitted without losing the remainder', () => {
  const state = { pending: '' };
  assert.equal(takeLogLines(state, 'game', 'one\npar'), 'one\n');
  assert.equal(state.pending, 'par');
  assert.equal(takeLogLines(state, 'game', 'tial\n'), 'partial\n');
  const xml = { pending: '' };
  assert.equal(takeLogLines(xml, 'output', '<log4j:Event level="INFO"><log4j:Message><![CDATA[hello'), '');
  assert.equal(takeLogLines(xml, 'output', ']]></log4j:Message></log4j:Event>tail'), '[main/INFO]: hello');
  assert.equal(xml.pending, 'tail');
});
