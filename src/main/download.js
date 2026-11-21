'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { fetchWithRetry, sha1File } = require('./util');

// A task is { url, file, sha1?, size?, deep? }. A file already on disk counts as good when its size matches,
// and, for a deep task, its sha1 too; whatever is downloaded is always checked against its sha1.
class Downloader {
  constructor({ concurrency = 8, signal, onProgress, seeds = {} } = {}) {
    this.concurrency = concurrency;
    this.seeds = seeds;
    this.abort = new AbortController();
    this.signal = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    this.onProgress = onProgress || (() => {});
    this.lastReport = 0;
  }

  async check(tasks, onCheck) {
    const missing = [];
    let checked = 0;
    await this.pool(tasks, 16, async task => {
      if (!await this.isGood(task) && !await this.fromSeed(task)) missing.push(task);
      checked++;
      if (onCheck) onCheck(checked, tasks.length);
    });
    return missing;
  }

  async isGood(task) {
    let stat;
    try {
      stat = await fsp.stat(task.file);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;
    if (task.size != null && stat.size !== task.size) return false;
    if (task.deep && task.sha1) return (await sha1File(task.file)) === task.sha1;
    return true;
  }

  // The same file from another launcher on this machine (.minecraft, Prism): linked or copied, not downloaded
  async fromSeed(task) {
    const dirs = task.seed && task.sha1 ? this.seeds[task.seed.kind] : null;
    if (!dirs) return false;
    for (const dir of dirs) {
      const candidate = path.join(dir, ...task.seed.rel.split('/'));
      try {
        const stat = await fsp.stat(candidate);
        if (task.size != null && stat.size !== task.size) continue;
        if (await sha1File(candidate) !== task.sha1) continue;
        await fsp.mkdir(path.dirname(task.file), { recursive: true });
        await fsp.rm(task.file, { force: true });
        try {
          await fsp.link(candidate, task.file);
        } catch {
          await fsp.copyFile(candidate, task.file);
        }
        return true;
      } catch { /* not there */ }
    }
    return false;
  }

  async run(tasks) {
    const total = tasks.reduce((sum, t) => sum + (t.size || 0), 0);
    const state = { total, done: 0, files: 0, count: tasks.length };
    this.report(state, true);
    await this.pool(tasks, this.concurrency, task => this.fetchOne(task, state));
    this.report(state, true);
  }

  async fetchOne(task, state) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      let got = 0;
      try {
        await fsp.mkdir(path.dirname(task.file), { recursive: true });
        const res = await fetchWithRetry(task.url, { signal: this.signal });
        const hash = crypto.createHash('sha1');
        const tmp = task.file + '.part';
        const counter = new Transform({
          transform: (chunk, _enc, done) => {
            hash.update(chunk);
            got += chunk.length;
            state.done += chunk.length;
            this.report(state);
            done(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body), counter, fs.createWriteStream(tmp), { signal: this.signal });
        const digest = hash.digest('hex');
        if (task.sha1 && digest !== task.sha1) {
          await fsp.rm(tmp, { force: true });
          throw new Error(`Контрольная сумма не сошлась: ${path.basename(task.file)}`);
        }
        await fsp.rename(tmp, task.file);
        if (task.size == null) state.total += got;
        else state.done += task.size - got;
        state.files++;
        this.report(state);
        return;
      } catch (e) {
        state.done -= got;
        lastError = e;
        if (this.signal?.aborted) throw e;
      }
    }
    throw lastError;
  }

  report(state, force) {
    const now = Date.now();
    if (!force && now - this.lastReport < 90) return;
    this.lastReport = now;
    this.onProgress({ ...state });
  }

  async pool(items, limit, worker) {
    let next = 0;
    let failure;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        if (this.signal?.aborted) throw this.signal.reason || new Error('Отменено');
        const item = items[next++];
        try {
          await worker(item);
        } catch (e) {
          failure ||= e;
          this.abort.abort(e);
          throw e;
        }
      }
    });
    const results = await Promise.allSettled(runners);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw failure || rejected.reason;
  }
}

module.exports = { Downloader };
