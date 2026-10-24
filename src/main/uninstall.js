'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

const VERSION = require('../../package.json').version;
const UNINSTALL_REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VanillaPlus';
const APP_NAME = 'Vanilla++';

let win = null;

function installDir() {
  return path.dirname(process.execPath);
}

function quote(p) {
  return `"${String(p).replace(/"/g, '')}"`;
}

async function removeLinks() {
  const menu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', APP_NAME);
  await fsp.rm(menu, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(path.join(path.dirname(menu), `${APP_NAME}.lnk`), { force: true }).catch(() => {});
  await fsp.rm(path.join(app.getPath('desktop'), `${APP_NAME}.lnk`), { force: true }).catch(() => {});
}

function scheduleWipe(extraDirs) {
  const install = installDir();
  const targets = [install];
  for (const dir of extraDirs) {
    if (dir && path.resolve(dir) !== path.resolve(install)) targets.push(dir);
  }
  const lines = [
    '@echo off',
    `taskkill /f /pid ${process.pid} >nul 2>&1`,
    'taskkill /f /im "Vanilla++.exe" >nul 2>&1',
    'set /a N=0',
    ':wait',
    `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul`,
    'if errorlevel 1 goto wipe',
    'set /a N+=1',
    'if %N% GEQ 30 goto wipe',
    'ping -n 2 127.0.0.1 >nul',
    'goto wait',
    ':wipe',
    'ping -n 2 127.0.0.1 >nul',
  ];
  for (const dir of targets) {
    const tag = lines.length;
    const q = quote(dir).replace(/%/g, '%%');
    lines.push(
      'set /a N=0',
      `:rm${tag}`,
      `rmdir /s /q ${q}`,
      `if not exist ${q} goto next${tag}`,
      'set /a N+=1',
      `if %N% GEQ 15 goto next${tag}`,
      'ping -n 2 127.0.0.1 >nul',
      `goto rm${tag}`,
      `:next${tag}`,
    );
  }
  const script = path.join(app.getPath('temp'), 'vanilla-plus-uninstall.cmd');
  const vbs = script.replace(/\.cmd$/i, '.vbs');
  lines.push(`del /q ${quote(vbs)}`, '(goto) 2>nul & del "%~f0"');
  fs.writeFileSync(script, lines.join('\r\n'), 'utf8');
  const run = `cmd.exe /d /c ""${script.replace(/"/g, '""')}""`;
  fs.writeFileSync(vbs, `CreateObject("Wscript.Shell").Run "${run}", 0, False\r\n`, 'utf8');
  const host = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
  spawn(host, ['//B', '//Nologo', vbs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: os.tmpdir(),
  }).unref();
}

async function run({ wipe, gameDir }) {
  await removeLinks();
  spawn('reg', ['delete', UNINSTALL_REG, '/f'], { windowsHide: true, stdio: 'ignore' }).unref();
  const extra = [];
  if (wipe) {
    extra.push(app.getPath('userData'));
    if (gameDir) extra.push(gameDir);
  }
  scheduleWipe(extra);
  setTimeout(() => app.quit(), 350);
  return true;
}

function open(info) {
  win = new BrowserWindow({
    width: 920,
    height: 560,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#120a0e',
    title: `${APP_NAME} — удаление`,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'setup', 'uninstall-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, '..', 'setup', 'uninstall.html'));
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });

  const reply = fn => ipcMain.handle('uninstall:run', async (_e, opts) => {
    try {
      return { ok: true, value: await fn(opts || {}) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
  ipcMain.handle('uninstall:info', async () => ({
    ok: true,
    value: {
      version: VERSION,
      installDir: installDir(),
      sakura: info.sakura,
      logo: info.logo,
    },
  }));
  reply(opts => run({ wipe: !!opts.wipe, gameDir: info.gameDir }));
  ipcMain.handle('uninstall:close', () => app.quit());
  ipcMain.handle('uninstall:minimize', () => win?.minimize());
}

module.exports = { open, run };
