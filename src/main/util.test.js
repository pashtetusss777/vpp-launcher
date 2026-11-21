'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { readTail } = require('./util');

test('log tail reads only the bounded final bytes, including empty files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vpp-log-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'output.log');
  await fs.writeFile(file, Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 65), Buffer.from('last-line')]));
  assert.equal((await readTail(file, 9)).toString(), 'last-line');
  assert.equal((await readTail(file, 1024)).length, 1024);
  await fs.writeFile(file, '');
  assert.equal((await readTail(file, 1024)).length, 0);
});
