'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { writePayload, unwrapPayload } = require('./settings');

const box = {
  encryptString: s => Buffer.from(`X${s}`),
  decryptString: b => Buffer.from(b).toString('utf8').slice(1),
};

test('settings with tokens round-trip through the locker and stay out of plaintext', () => {
  const data = { accounts: [{ name: 'p', refreshToken: 'secret-token' }] };
  const packed = writePayload(data, box);
  assert.equal(String(packed).includes('secret-token'), false);
  const opened = JSON.parse(unwrapPayload(packed, box));
  assert.equal(opened.accounts[0].refreshToken, 'secret-token');
});
