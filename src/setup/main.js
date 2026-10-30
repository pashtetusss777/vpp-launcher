'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');

const VERSION = require('../../package.json').version;
const APP_NAME = 'Vanilla++';
const PUBLISHER = 'Vanilla++';
/** Apps & Features / «Программы и компоненты» */
const UNINSTALL_REG = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VanillaPlus';
const UNINSTALL_CMD = 'Uninstall.cmd';

let win = null;
let lastExe = '';

function payloadPath() {
  if (!app.isPackaged) return path.join(__dirname, '..', '..', 'build', 'payload.zip');
  return path.join(process.resourcesPath, 'payload.zip');
}

function defaultDir() {
  return path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'Programs', APP_NAME);
}

function createWindow() {
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
    title: `${APP_NAME} — установка`,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => {
    if (process.env.VANILLA_SETUP_SHOT) {
      win.setOpacity(0);
      win.showInactive();
      return;
    }
    win.show();
  });
  win.on('closed', () => { win = null; });
  if (process.env.VANILLA_SETUP_SHOT) {
    win.webContents.once('did-finish-load', async () => {
      try {
        await new Promise(r => setTimeout(r, +(process.env.VANILLA_SETUP_SHOT_WAIT || 1200)));
        const image = await win.webContents.capturePage();
        await fsp.writeFile(process.env.VANILLA_SETUP_SHOT, image.toPNG());
      } catch (e) {
        console.error(e);
      }
      app.quit();
    });
  }
}

function isInstallRoot(names) {
  return names.includes(`${APP_NAME}.exe`)
    || names.includes(UNINSTALL_CMD)
    || names.includes('Uninstall Vanilla++.cmd');
}

async function prepareTarget(dir) {
  let target = path.resolve(dir || defaultDir());
  if (!target || target.length < 4) throw new Error('Укажите папку установки');
  const base = path.basename(target).toLowerCase();
  if (base !== 'vanilla++' && base !== 'vanillaplus' && base !== 'vanilla-plus') {
    target = path.join(target, APP_NAME);
  }
  await fsp.mkdir(target, { recursive: true });
  let names = [];
  try {
    names = await fsp.readdir(target);
  } catch { /* empty */ }
  if (!names.length) return target;
  if (isInstallRoot(names)) {
    await fsp.rm(target, { recursive: true, force: true });
    await fsp.mkdir(target, { recursive: true });
    return target;
  }
  throw new Error('Папка не пуста. Выберите пустую папку или предыдущую установку Vanilla++');
}

function regAdd(name, type, value) {
  const r = spawnSync('reg', ['add', UNINSTALL_REG, '/v', name, '/t', type, '/d', String(value), '/f'], {
    windowsHide: true,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`Не удалось записать реестр (${name}): ${(r.stderr || r.stdout || '').trim()}`);
  }
}

async function dirSizeKb(root) {
  let bytes = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(full);
      else {
        try { bytes += (await fsp.stat(full)).size; } catch { /* skip */ }
      }
    }
  }
  await walk(root);
  return Math.max(1, Math.round(bytes / 1024));
}

function batEscape(s) {
  return String(s).replace(/"/g, '');
}

async function writeUninstaller(target, exe) {
  const uninstaller = path.join(target, UNINSTALL_CMD);
  const body = [
    '@echo off',
    `start "" "${batEscape(exe)}" --uninstall %*`,
  ].join('\r\n');

  await fsp.writeFile(uninstaller, body, 'utf8');

  const sizeKb = await dirSizeKb(target);
  const date = new Date();
  const installDate = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;

  regAdd('DisplayName', 'REG_SZ', APP_NAME);
  regAdd('DisplayVersion', 'REG_SZ', VERSION);
  regAdd('Publisher', 'REG_SZ', PUBLISHER);
  regAdd('InstallLocation', 'REG_SZ', target);
  regAdd('DisplayIcon', 'REG_SZ', `${exe},0`);
  regAdd('UninstallString', 'REG_SZ', `"${exe}" --uninstall`);
  regAdd('QuietUninstallString', 'REG_SZ', `"${exe}" --uninstall --silent`);
  regAdd('InstallDate', 'REG_SZ', installDate);
  regAdd('EstimatedSize', 'REG_DWORD', sizeKb);
  regAdd('NoModify', 'REG_DWORD', 1);
  regAdd('NoRepair', 'REG_DWORD', 1);
  regAdd('URLInfoAbout', 'REG_SZ', 'https://github.com/pashtetusss777/vpp-launcher');

  return uninstaller;
}

async function extractZip(zip, dest, onProgress) {
  await fsp.mkdir(dest, { recursive: true });
  onProgress?.(0.08, 'Распаковываем файлы…');
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', zip, '-C', dest], { windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`Не удалось распаковать (код ${code})`))));
  });
  onProgress?.(0.85, 'Почти готово…');
}

async function writeShortcut(link, target, args = '') {
  try {
    shell.writeShortcutLink(link, {
      target,
      args,
      cwd: path.dirname(target),
      description: APP_NAME,
      icon: target,
      iconIndex: 0,
    });
  } catch {
    const ps = [
      `$ws = New-Object -ComObject WScript.Shell`,
      `$s = $ws.CreateShortcut('${link.replace(/'/g, "''")}')`,
      `$s.TargetPath = '${target.replace(/'/g, "''")}'`,
      `$s.Arguments = '${String(args).replace(/'/g, "''")}'`,
      `$s.WorkingDirectory = '${path.dirname(target).replace(/'/g, "''")}'`,
      `$s.IconLocation = '${target.replace(/'/g, "''")},0'`,
      `$s.Description = '${APP_NAME}'`,
      `$s.Save()`,
    ].join('; ');
    await new Promise((resolve, reject) => {
      const child = spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
      child.on('error', reject);
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error('Не удалось создать ярлык'))));
    });
  }
}

async function install({ dir, desktop, startMenu }) {
  const zip = payloadPath();
  if (!fs.existsSync(zip)) throw new Error('В установщике нет файлов приложения');

  const send = (progress, text) => {
    if (win && !win.isDestroyed()) win.webContents.send('setup:progress', { progress, text });
  };

  send(0.04, 'Готовим папку…');
  const target = await prepareTarget(dir);
  await extractZip(zip, target, send);

  const exe = path.join(target, `${APP_NAME}.exe`);
  if (!fs.existsSync(exe)) throw new Error('После распаковки не найден Vanilla++.exe');

  send(0.9, 'Ярлыки и удаление…');
  const uninstaller = await writeUninstaller(target, exe);

  if (startMenu !== false) {
    const menu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', APP_NAME);
    await fsp.mkdir(menu, { recursive: true });
    await writeShortcut(path.join(menu, `${APP_NAME}.lnk`), exe);
    await writeShortcut(path.join(menu, `Удалить ${APP_NAME}.lnk`), exe, '--uninstall');
    // старый ярлык из прошлых сборок
    try { await fsp.rm(path.join(path.dirname(menu), `${APP_NAME}.lnk`), { force: true }); } catch { /* ok */ }
  }
  if (desktop) {
    await writeShortcut(path.join(app.getPath('desktop'), `${APP_NAME}.lnk`), exe);
  }

  send(1, 'Готово');
  lastExe = exe;
  return { dir: target, exe };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  });
}

app.whenReady().then(() => {
  handle('setup:info', async () => ({
    version: VERSION,
    defaultDir: defaultDir(),
    sakura: pathToFileURL(path.join(__dirname, 'assets', 'backdrop.jpg')).href,
    logo: pathToFileURL(path.join(__dirname, '..', 'renderer', 'assets', 'logo.png')).href,
  }));
  handle('setup:pick', async () => {
    const result = await dialog.showOpenDialog(win, {
      title: 'Папка установки',
      defaultPath: defaultDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('setup:install', opts => install(opts || {}));
  handle('setup:launch', () => {
    if (!lastExe) throw new Error('Сначала установите лаунчер');
    spawn(lastExe, [], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
  });
  handle('setup:close', () => app.quit());
  handle('setup:minimize', () => win?.minimize());
  createWindow();
});

app.on('window-all-closed', () => app.quit());
