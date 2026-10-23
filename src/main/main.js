'use strict';

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { pathToFileURL } = require('url');

const { Settings } = require('./settings');
const system = require('./system');
const mods = require('./mods');
const packs = require('./packs');
const catalog = require('./catalog');
const mrpack = require('./mrpack');
const game = require('./game');
const { ping } = require('./ping');
const auth = require('./auth');
const updater = require('./updater');
const uninstall = require('./uninstall');
const { exists } = require('./util');

const APP_ROOT = path.join(__dirname, '..', '..');
const config = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'launcher.config.json'), 'utf8'));
const VERSION = require('../../package.json').version;

// VANILLA_DATA / VANILLA_GAME_DIR: keep a test run's settings and game files away from the real ones
if (process.env.VANILLA_DATA) app.setPath('userData', path.resolve(process.env.VANILLA_DATA));

const uninstalling = process.argv.includes('--uninstall');
if (!uninstalling) {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    app.on('second-instance', () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  }
}

let win = null;
let settings = null;
let msAbort = null;
// what the game is doing: idle, busy (getting it ready) or running
const session = { phase: 'idle', abort: null, child: null, startedAt: 0, server: null, outputFile: null, stopping: false };

function gameRoot() {
  if (settings.get().gameDir) return settings.get().gameDir;
  if (process.env.VANILLA_GAME_DIR) return path.resolve(process.env.VANILLA_GAME_DIR);
  return path.join(app.getPath('appData'), config.gameDirName || '.vanilla-plus');
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function setPhase(phase, extra = {}) {
  session.phase = phase;
  send('game:state', { phase, startedAt: session.startedAt, server: session.server, ...extra });
}

function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (a instanceof Error ? a.stack : String(a))).join(' ')}\n`;
  fsp.mkdir(path.join(gameRoot(), 'launcher'), { recursive: true })
    .then(() => fsp.appendFile(path.join(gameRoot(), 'launcher', 'launcher.log'), line))
    .catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 680,
    useContentSize: true,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#120a0e',
    title: 'Vanilla++',
    icon: path.join(APP_ROOT, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(APP_ROOT, 'src', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.env.VANILLA_SHOT) {
      win.show();
      return;
    }
    // shown but see-through and without focus: the page runs as if on screen, nobody sees it
    win.setOpacity(0);
    win.showInactive();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', e => e.preventDefault());
  win.on('closed', () => { win = null; });
  if (process.env.VANILLA_SHOT || process.env.VANILLA_DEBUG) {
    const debugLog = path.join(app.getPath('userData'), 'debug.log');
    const write = line => fs.appendFileSync(debugLog, `${line}\n`);
    win.webContents.on('console-message', e => write(`[page:${e.level}] ${e.message} (${e.sourceId}:${e.lineNumber})`));
    win.webContents.on('preload-error', (_e, file, error) => write(`[preload] ${file} ${error.stack || error}`));
  }
  if (process.env.VANILLA_SHOT) screenshotMode();
}

// VANILLA_SHOT=out.png [VANILLA_SHOT_JS=...] - for checking the look without anyone at the screen
function screenshotMode() {
  win.webContents.once('did-finish-load', async () => {
    try {
      const script = process.env.VANILLA_SHOT_JS;
      await new Promise(r => setTimeout(r, +(process.env.VANILLA_SHOT_WAIT || 2500)));
      if (script) {
        const result = await win.webContents.executeJavaScript(script);
        if (result !== undefined) fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), `[shot-js] ${JSON.stringify(result)}\n`);
        await new Promise(r => setTimeout(r, +(process.env.VANILLA_SHOT_AFTER || 1500)));
      }
      const image = await win.webContents.capturePage();
      await fsp.writeFile(process.env.VANILLA_SHOT, image.toPNG());
    } catch (e) {
      console.error(e);
    }
    app.quit();
  });
}

// ------------------------------------------------------------------ what the page asks for

async function builtinMods() {
  const root = gameRoot();
  const apiFile = path.join(root, 'launcher', `fabric-api-${config.fabricApi}.jar`);
  const api = { id: 'fabric-api', name: 'Fabric API', version: config.fabricApi, size: 0 };
  if (await exists(apiFile)) api.size = (await fsp.stat(apiFile)).size;
  return [api];
}

function currentAccount(s) {
  return (s.accounts || []).find(a => a.id === s.current) || s.accounts?.[0] || null;
}

function rememberAccount(account) {
  const s = settings.get();
  const accounts = (s.accounts || []).slice();
  const i = accounts.findIndex(a => a.id === account.id);
  if (i >= 0) accounts[i] = account;
  else accounts.push(account);
  settings.update({ accounts, current: account.id });
  return account;
}

function freshenSkinsInBackground() {
  const s = settings.get();
  const accounts = (s.accounts || []).slice();
  const needsSkins = accounts.filter(a => (a.type === 'microsoft' || a.type === 'ely') && (!a.skinUrl || /^http:\/\//i.test(a.skinUrl)));
  if (!needsSkins.length) return;
  Promise.all(needsSkins.map(async account => {
    try {
      const next = await Promise.race([
        auth.withSkin(account),
        new Promise(resolve => setTimeout(() => resolve(null), 5000)),
      ]);
      if (next && next.skinUrl && next.skinUrl !== account.skinUrl) {
        return next;
      }
    } catch { /* ignore network error */ }
    return null;
  })).then(results => {
    let changed = false;
    const curAccounts = (settings.get().accounts || []).slice();
    for (const next of results) {
      if (!next) continue;
      const i = curAccounts.findIndex(a => a.id === next.id);
      if (i >= 0 && curAccounts[i].skinUrl !== next.skinUrl) {
        curAccounts[i] = next;
        changed = true;
      }
    }
    if (changed) {
      settings.update({ accounts: curAccounts });
      send('accounts:updated', curAccounts);
    }
  }).catch(() => {});
}

async function init() {
  const s = settings.get();
  const root = gameRoot();
  const packState = await mrpack.loadState(root);
  const packConfig = mrpack.effectiveConfig(config, packState);
  const hasProject = !!mrpack.projectId(config);
  const pack = {
    enabled: hasProject,
    project: mrpack.projectId(config),
    local: packState ? { versionId: packState.versionId, versionNumber: packState.versionNumber } : null,
    remote: null,
    upToDate: true,
    dependencies: packState?.dependencies || {},
    minecraft: packState?.minecraft || config.minecraft,
    fabricLoader: packState?.fabricLoader || config.fabricLoader,
  };

  // Run non-critical background network tasks without blocking UI boot
  setImmediate(() => {
    freshenSkinsInBackground();
    if (hasProject) {
      mrpack.status(root, config)
        .then(status => send('pack:status', status))
        .catch(() => {});
    }
  });

  return {
    version: VERSION,
    config: packConfig,
    settings: s,
    gameRoot: root,
    pack,
    memory: await system.memory({ wait: false }),
    background: s.customBackground && await exists(s.customBackground.file)
      ? { url: pathToFileURL(s.customBackground.file).href, name: s.customBackground.name } : null,
    state: { phase: session.phase, startedAt: session.startedAt, server: session.server },
    update: null,
  };
}

async function launch(server) {
  if (session.phase !== 'idle') return { ok: false };
  const s = settings.get();
  let account = currentAccount(s);
  if (!account) {
    send('game:error', { text: 'Добавьте аккаунт: офлайн, Ely.by или Microsoft' });
    return { ok: false };
  }
  const root = gameRoot();
  const abort = new AbortController();
  session.abort = abort;
  session.server = server || null;
  setPhase('busy');
  try {
    if (account.type === 'ely' || account.type === 'microsoft') {
      send('game:progress', { stage: 'meta', text: 'Проверяем сессию аккаунта' });
      account = rememberAccount(await auth.freshen(account));
    }

    let launchConfig = config;
    if (mrpack.projectId(config)) {
      const synced = await mrpack.sync(root, config, {
        signal: abort.signal,
        report: p => send('game:progress', p),
      });
      launchConfig = synced.config || config;
      send('pack:status', {
        enabled: true,
        project: mrpack.projectId(config),
        local: { versionId: synced.versionId, versionNumber: synced.versionNumber },
        remote: { versionId: synced.versionId, versionNumber: synced.versionNumber },
        upToDate: true,
        updated: synced.updated,
        dependencies: synced.state?.dependencies || {},
        minecraft: launchConfig.minecraft,
        fabricLoader: launchConfig.fabricLoader,
      });
    } else {
      launchConfig = mrpack.effectiveConfig(config, await mrpack.loadState(root));
    }

    const prepared = await game.prepare({
      root, config: launchConfig, settings: s, account, signal: abort.signal,
      report: p => send('game:progress', p),
    });
    send('game:progress', {
      stage: 'launch',
      text: server ? `Подключение к ${server}` : `Запуск Minecraft ${launchConfig.minecraft}`,
    });
    const outputFile = path.join(root, 'launcher', 'game-output.log');
    await fsp.mkdir(path.dirname(outputFile), { recursive: true });
    const out = fs.openSync(outputFile, 'w');
    const close = s.afterLaunch === 'close';
    let started;
    try {
      started = await game.start({
        root, prepared, settings: s, account: game.accountFor(account), server, detached: true, stdio: out,
      });
    } finally {
      fs.closeSync(out);
    }
    session.child = started.child;
    session.stopping = false;
    session.outputFile = outputFile;
    session.startedAt = Date.now();
    settings.update({ lastLaunch: { at: session.startedAt, server: server || null, account } });
    log('started', started.command.java, 'pid', started.child.pid);
    setPhase('running', { downloaded: prepared.downloaded });
    started.child.on('exit', code => onExit(code));
    if (close) {
      started.child.unref();
      setTimeout(() => app.quit(), 600);
    } else if (s.afterLaunch === 'hide' && win) {
      setTimeout(() => win && win.minimize(), 1200);
    }
    return { ok: true };
  } catch (e) {
    session.abort = null;
    if (abort.signal.aborted) {
      setPhase('idle', { cancelled: true });
      return { ok: false, cancelled: true };
    }
    log('launch failed', e);
    setPhase('idle', { error: humanError(e) });
    return { ok: false };
  } finally {
    session.abort = null;
  }
}

function humanError(e) {
  const text = String(e?.message || e);
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|fetch failed|ECONNRESET|network/i.test(text)) {
    return 'Нет связи с серверами загрузки - проверьте интернет';
  }
  if (/ENOSPC/.test(text)) return 'На диске закончилось место';
  if (/EPERM|EACCES|EBUSY/.test(text)) return 'Файл занят другой программой или нет прав: ' + text.replace(/^.*?:\s*/, '');
  return text;
}

async function onExit(code) {
  const ranFor = Date.now() - session.startedAt;
  session.child = null;
  const extra = { exitCode: code, ranFor };
  // a game closed with the loader's own button is no crash, whatever code it leaves with
  if (code !== 0 && code !== null && !session.stopping) {
    extra.crash = await newestCrash(session.startedAt);
    extra.tail = await outputTail(session.outputFile);
    extra.error = /OutOfMemoryError|Could not reserve enough space/i.test(extra.tail)
      ? 'Java не хватило памяти - поменяйте её в настройках'
      : `Игра закрылась с ошибкой (код ${code})`;
  }
  session.stopping = false;
  session.startedAt = 0;
  setPhase('idle', extra);
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
  }
}

// The game writes its console as log4j XML; what a person wants to read is the messages and the errors
async function outputTail(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return '';
  }
  const lines = [];
  const re = /<log4j:(?:Message|Throwable)><!\[CDATA\[([\s\S]*?)\]\]>/g;
  let m;
  while ((m = re.exec(text))) lines.push(...m[1].split(/\r?\n/));
  const plain = text.replace(/<log4j:Event[\s\S]*?<\/log4j:Event>/g, '').split(/\r?\n/);
  return [...lines, ...plain].map(l => l.trimEnd()).filter(Boolean).slice(-14).join('\n');
}

async function newestCrash(since) {
  const dir = path.join(gameRoot(), 'crash-reports');
  try {
    const names = await fsp.readdir(dir);
    let best = null;
    for (const n of names) {
      const stat = await fsp.stat(path.join(dir, n));
      if (stat.mtimeMs >= since - 2000 && (!best || stat.mtimeMs > best.time)) best = { file: path.join(dir, n), time: stat.mtimeMs };
    }
    return best?.file || null;
  } catch {
    return null;
  }
}

function stopGame() {
  if (session.child) {
    session.stopping = true;
    try {
      session.child.kill();
    } catch { /* already gone */ }
  }
}

async function openPath(which) {
  const root = gameRoot();
  const target = {
    root,
    mods: mods.modsDir(root),
    resourcepacks: packs.contentDir(root, 'resourcepack'),
    shaderpacks: packs.contentDir(root, 'shader'),
    logs: path.join(root, 'logs'),
    screenshots: path.join(root, 'screenshots'),
  }[which] || root;
  await fsp.mkdir(target, { recursive: true });
  return shell.openPath(target);
}

async function openLog() {
  const file = path.join(gameRoot(), 'logs', 'latest.log');
  if (await exists(file)) return shell.openPath(file);
  const out = path.join(gameRoot(), 'launcher', 'game-output.log');
  if (await exists(out)) return shell.openPath(out);
  return 'Логов пока нет - игра ещё не запускалась';
}

function logSources(root) {
  return [
    { id: 'game', name: 'Игра', file: path.join(root, 'logs', 'latest.log') },
    { id: 'output', name: 'Консоль Java', file: path.join(root, 'launcher', 'game-output.log') },
    { id: 'launcher', name: 'Лаунчер', file: path.join(root, 'launcher', 'launcher.log') },
  ];
}

function decodeLogText(buf) {
  let text = buf.toString('utf8');
  if (text.includes('\uFFFD') && buf.includes(0)) {
    try { text = new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch { /* keep */ }
  }
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function flattenLog4j(text) {
  if (!text.includes('<log4j:')) return text;
  const lines = [];
  const re = /<log4j:Event\b([^>]*)>[\s\S]*?<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?(?:<log4j:Throwable><!\[CDATA\[([\s\S]*?)\]\]>)?[\s\S]*?<\/log4j:Event>/g;
  let m;
  let matched = false;
  while ((m = re.exec(text))) {
    matched = true;
    const attrs = m[1] || '';
    const level = (attrs.match(/\blevel="([^"]+)"/i) || [])[1] || 'INFO';
    const logger = (attrs.match(/\blogger="([^"]+)"/i) || [])[1] || '';
    const stamp = (attrs.match(/\btimestamp="(\d+)"/i) || [])[1];
    const time = stamp
      ? new Date(+stamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      : '';
    const head = time ? `[${time}] [${logger || 'main'}/${level}]` : `[${logger || 'main'}/${level}]`;
    for (const line of String(m[2] || '').split('\n')) lines.push(`${head}: ${line}`);
    if (m[3]) for (const line of String(m[3]).split('\n')) lines.push(line);
  }
  if (!matched) {
    const loose = /<log4j:(?:Message|Throwable)><!\[CDATA\[([\s\S]*?)\]\]>/g;
    while ((m = loose.exec(text))) lines.push(...m[1].split('\n'));
  }
  const rest = text.replace(/<log4j:Event[\s\S]*?<\/log4j:Event>/g, '').trim();
  if (rest) lines.push(...rest.split('\n'));
  return lines.join('\n');
}

async function readLog(id = 'game') {
  const root = gameRoot();
  const sources = [];
  for (const source of logSources(root)) {
    let size = 0;
    let mtime = 0;
    try {
      const stat = await fsp.stat(source.file);
      size = stat.size;
      mtime = stat.mtimeMs;
    } catch { /* missing */ }
    sources.push({ id: source.id, name: source.name, exists: size > 0 || await exists(source.file), size, mtime });
  }
  const pick = logSources(root).find(s => s.id === id) || logSources(root)[0];
  const maxBytes = 700 * 1024;
  let text = '';
  let truncated = false;
  let size = 0;
  try {
    const handle = await fsp.open(pick.file, 'r');
    try {
      const stat = await handle.stat();
      size = stat.size;
      const start = Math.max(0, size - maxBytes);
      truncated = start > 0;
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      text = decodeLogText(buf);
      if (truncated) {
        const cut = text.indexOf('\n');
        if (cut >= 0) text = text.slice(cut + 1);
      }
    } finally {
      await handle.close();
    }
  } catch {
    text = '';
  }
  if (pick.id === 'output') text = flattenLog4j(text);
  const lines = text ? text.split('\n') : [];
  const maxLines = 4000;
  const slice = lines.length > maxLines ? lines.slice(-maxLines) : lines;
  return {
    id: pick.id,
    sources,
    truncated: truncated || lines.length > maxLines,
    empty: !slice.length,
    text: slice.join('\n'),
    lineCount: slice.length,
  };
}

async function pickFile(kind) {
  const filters = {
    java: [{ name: 'Java', extensions: ['exe'] }],
    jar: [{ name: 'Моды Fabric', extensions: ['jar'] }],
    zip: [{ name: 'Архивы', extensions: ['zip'] }],
    image: [{ name: 'Картинки', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  }[kind];
  const result = await dialog.showOpenDialog(win, {
    properties: kind === 'jar' || kind === 'zip' ? ['openFile', 'multiSelections'] : ['openFile'],
    filters,
  });
  return result.canceled ? [] : result.filePaths;
}

async function setBackground(file) {
  const ext = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new Error('Нужна картинка PNG, JPG или WebP');
  const dir = path.join(app.getPath('userData'), 'backgrounds');
  await fsp.mkdir(dir, { recursive: true });
  for (const n of await fsp.readdir(dir)) await fsp.rm(path.join(dir, n), { force: true });
  const target = path.join(dir, `custom-${Date.now()}${ext}`);
  await fsp.copyFile(file, target);
  const name = path.basename(file, path.extname(file));
  settings.update({ customBackground: { file: target, name }, background: 'custom' });
  return { url: pathToFileURL(target).href, name };
}

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      log(channel, e);
      return { ok: false, error: humanError(e) };
    }
  });
}

let installChain = Promise.resolve();

async function installProject(source, kind, projectId, seen, versionId) {
  const key = `${source}:${kind}:${projectId}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const root = gameRoot();
  const mc = config.minecraft;
  const file = await catalog.resolve(source, kind, projectId, mc, versionId);
  const dir = path.join(root, 'launcher', 'incoming', `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const tmp = path.join(dir, packs.safeName(file.filename));
  const names = [];
  try {
    await catalog.download(file.url, tmp, file.sha1);
    if (kind === 'mod') {
      const [result] = await mods.add(root, mc, [tmp]);
      if (result?.error && !result.builtin) throw new Error(result.error);
      if (result?.builtin) return names;
      names.push(result?.name || file.filename);
      await catalog.remember(root, source, projectId, path.basename(tmp));
    } else {
      const saved = await packs.place(root, kind, tmp, file.filename, { enable: true });
      names.push(saved.replace(/\.zip$/i, ''));
      await catalog.remember(root, source, projectId, saved);
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  if (kind === 'mod') {
    for (const dep of (file.dependencies || []).slice(0, 8)) {
      names.push(...await installProject(dep.source, 'mod', dep.id, seen));
    }
  }
  return names;
}

async function installCatalog(source, kind, projectId, versionId) {
  const run = async () => {
    const names = await installProject(source, kind, projectId, new Set(), versionId);
    let iris = false;
    const extra = names.slice(1);
    if (kind === 'shader') {
      const have = (await mods.list(gameRoot(), config.minecraft)).find(mod => mod.id === 'iris');
      if (have && !have.enabled) await mods.setEnabled(gameRoot(), have.file, true);
      if (!have) {
        extra.push(...await installProject('modrinth', 'mod', 'iris', new Set()));
        iris = true;
      }
    }
    return { name: names[0] || '', extra, iris };
  };
  const job = installChain.then(run, run);
  installChain = job.then(() => {}, () => {});
  return job;
}

function registerIpc() {
  handle('init', init);
  handle('settings:update', patch => settings.update(patch));
  handle('system:memory', () => system.memory());
  async function liveConfig() {
    return mrpack.effectiveConfig(config, await mrpack.loadState(gameRoot()));
  }
  handle('mods:list', async () => mods.list(gameRoot(), (await liveConfig()).minecraft));
  handle('mods:builtin', builtinMods);
  handle('mods:add', async files => mods.add(gameRoot(), (await liveConfig()).minecraft, files));
  handle('mods:toggle', (file, on) => mods.setEnabled(gameRoot(), file, on));
  handle('mods:remove', file => mods.remove(gameRoot(), file));
  handle('mods:restore', token => mods.restore(gameRoot(), token));
  handle('packs:list', kind => packs.list(gameRoot(), kind));
  handle('packs:add', (kind, files) => packs.add(gameRoot(), kind, files));
  handle('packs:toggle', (kind, file, on) => packs.setOn(gameRoot(), kind, file, on));
  handle('packs:remove', (kind, file) => packs.remove(gameRoot(), kind, file));
  handle('packs:restore', (kind, token) => packs.restore(gameRoot(), kind, token));
  handle('catalog:search', async (source, kind, query) => catalog.search({
    root: gameRoot(), source, kind, query, mc: (await liveConfig()).minecraft,
  }));
  handle('catalog:project', async (source, kind, projectId) => catalog.project({
    source, kind, projectId, mc: (await liveConfig()).minecraft,
  }));
  handle('catalog:install', (source, kind, projectId, versionId) => installCatalog(source, kind, projectId, versionId));
  handle('pack:status', () => mrpack.status(gameRoot(), config));
  handle('update:check', () => updater.check(config));
  handle('update:install', async () => {
    const result = await updater.install(config, p => send('update:progress', p));
    if (result.restart) setTimeout(() => app.quit(), 400);
    return result;
  });
  handle('game:launch', server => launch(server));
  handle('game:cancel', () => session.abort?.abort());
  handle('game:stop', stopGame);
  handle('open:path', which => openPath(which));
  handle('open:log', openLog);
  handle('logs:read', id => readLog(id));
  handle('logs:open', async id => {
    const pick = logSources(gameRoot()).find(s => s.id === id) || logSources(gameRoot())[0];
    if (await exists(pick.file)) return shell.openPath(pick.file);
    return 'Этого лога пока нет';
  });
  handle('open:file', file => shell.openPath(file));
  handle('pick', kind => pickFile(kind));
  handle('background:set', file => setBackground(file));
  handle('ping', address => ping(address));
  handle('auth:ely', (username, password) => auth.loginEly(username, password));
  handle('auth:microsoft', () => {
    msAbort?.abort();
    msAbort = new AbortController();
    return auth.loginMicrosoft({
      signal: msAbort.signal,
      onCode: info => {
        send('auth:device', info);
        if (info.verificationUri) shell.openExternal(info.verificationUri).catch(() => {});
      },
    });
  });
  handle('auth:microsoft-cancel', () => msAbort?.abort());
  handle('window:minimize', () => win?.minimize());
  handle('window:close', () => {
    session.abort?.abort();
    app.quit();
  });
}

app.whenReady().then(() => {
  system.readInstalled();
  settings = new Settings(path.join(app.getPath('userData'), 'settings.json'), config.defaults);
  if (uninstalling) {
    const root = path.join(__dirname, '..', '..');
    const info = {
      gameDir: gameRoot(),
      sakura: pathToFileURL(path.join(root, 'src', 'setup', 'assets', 'backdrop.jpg')).href,
      logo: pathToFileURL(path.join(root, 'src', 'renderer', 'assets', 'logo.png')).href,
    };
    if (process.argv.includes('--silent')) {
      uninstall.run({ wipe: false, gameDir: info.gameDir }).catch(() => app.quit());
      return;
    }
    uninstall.open(info);
    return;
  }
  registerIpc();
  createWindow();
  mods.emptyTrash(gameRoot(), f => shell.trashItem(f)).catch(() => {});
  packs.emptyTrash(gameRoot(), f => shell.trashItem(f)).catch(() => {});
});

app.on('before-quit', () => {
  settings?.flush();
});

app.on('window-all-closed', () => app.quit());
