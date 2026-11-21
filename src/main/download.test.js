'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate } = require('timers/promises');
const { Downloader } = require('./download');

test('pool waits for other workers after failure and never starts another task', async () => {
  const downloader = new Downloader();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = [];
  let settled = false;
  const job = downloader.pool([0, 1, 2], 2, async item => {
    started.push(item);
    if (item === 0) await blocked;
    else throw new Error('download failed');
  });
  const failure = assert.rejects(job, /download failed/).then(() => { settled = true; });
  await setImmediate();
  assert.equal(downloader.signal.aborted, true);
  assert.equal(settled, false);
  release();
  await failure;
  assert.deepEqual(started, [0, 1]);
});

test('a cancelled pool does not start a worker', async () => {
  const abort = new AbortController();
  abort.abort(new Error('cancelled'));
  const downloader = new Downloader({ signal: abort.signal });
  await assert.rejects(downloader.pool([1], 1, async () => assert.fail('started')), /cancelled/);
});
