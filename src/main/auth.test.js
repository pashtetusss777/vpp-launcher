'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { authlibUrl } = require('./auth');

test('authlib-injector is only fetched from known https hosts', () => {
  assert.equal(authlibUrl('https://authlib-injector.yushi.moe/artifact/1.jar'), true);
  assert.equal(authlibUrl('https://evil.example/1.jar'), false);
  assert.equal(authlibUrl('http://authlib-injector.yushi.moe/1.jar'), false);
});
