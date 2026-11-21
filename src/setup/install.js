'use strict';

const fs = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

function targetDir(dir, fallback) {
  const target = path.resolve(dir || fallback);
  if (path.parse(target).root === target) throw new Error('Укажите папку установки, не корень диска');
  return ['vanilla++', 'vanillaplus', 'vanilla-plus'].includes(path.basename(target).toLowerCase())
    ? target : path.join(target, 'Vanilla++');
}

async function extractZip(zip, dest) {
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', zip, '-C', dest], { windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Не удалось распаковать (код ${code})`)));
  });
}

async function installTrustedZip(dir, fallback, zip, extract = extractZip) {
  const target = targetDir(dir, fallback);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const lock = target + '.install-lock';
  try {
    await fs.mkdir(lock); // One installer owns this destination until commit or rollback finishes.
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error('Установка уже идёт или была прервана. Проверьте папку .install-lock рядом с лаунчером.');
    throw e;
  }
  let staged;
  let old;
  try {
    const names = await fs.readdir(target).catch(e => {
      if (e.code !== 'ENOENT') throw e;
      return [];
    });
    if (names.length && !names.some(name => ['Vanilla++.exe', 'Uninstall.cmd', 'Uninstall Vanilla++.cmd'].includes(name))) {
      throw new Error('Папка не пуста. Выберите пустую папку или предыдущую установку Vanilla++');
    }
    staged = await fs.mkdtemp(target + '.install-');
    await extract(zip, staged);
    if (!(await fs.stat(path.join(staged, 'Vanilla++.exe'))).isFile()) {
      throw new Error('После распаковки не найден Vanilla++.exe');
    }
    // Preserve every old file, including unknown files and resources absent from the new archive.
    for (const name of names) {
      const dest = path.join(staged, name);
      try { await fs.lstat(dest); } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        await fs.cp(path.join(target, name), dest, { recursive: true, dereference: false, errorOnExist: true, force: false });
      }
    }
    try {
      await fs.lstat(target);
      old = await fs.mkdtemp(target + '.previous-');
      await fs.rmdir(old);
      await fs.rename(target, old);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    try {
      await fs.rename(staged, target);
      staged = null;
    } catch (e) {
      if (old) {
        await fs.rename(old, target);
        old = null;
      }
      throw e;
    }
    // Keep the previous tree as a backup; it may contain user files overwritten by the archive.
    return target;
  } finally {
    if (staged) await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
    await fs.rmdir(lock);
  }
}

module.exports = { targetDir, installTrustedZip };
