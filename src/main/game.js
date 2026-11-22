'use strict';

const os = require('os');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const mc = require('./minecraft');
const java = require('./java');
const client = require('./client');
const { Downloader } = require('./download');
const { offlineUuid } = require('./system');
const { exists } = require('./util');

const { ensureAuthlib } = require('./auth');

const LAUNCHER_NAME = 'vanilla-plus';

// Everything the game needs on disk, checked and fetched: Minecraft, its assets, Fabric, Java and Fabric API.
// Reports { stage, text, done, total } as it goes. An Ely.by account also needs authlib-injector.
async function prepare({ root, config, settings, account, signal, report }) {
  const stage = (stage, text, extra = {}) => report({ stage, text, ...extra });

  stage('meta', `Получаем Minecraft ${config.minecraft}`);
  const version = await mc.vanillaVersion(root, config.minecraft, signal);
  stage('meta', 'Получаем Fabric');
  const profile = await mc.fabricProfile(root, config.minecraft, config.fabricLoader, signal);

  const vanilla = mc.vanillaTasks(root, version);
  const fabric = mc.fabricTasks(root, profile);
  stage('meta', 'Получаем список ассетов');
  const assets = await mc.assetTasks(root, version, signal);

  let runtime = null;
  if (settings.javaMode === 'custom') {
    await java.checkCustomJava(settings.javaPath);
  } else {
    stage('meta', `Получаем Java ${version.javaVersion?.majorVersion || ''}`.trim());
    runtime = await java.runtimeTasks(root, version.javaVersion, signal);
  }

  const fabricApi = await client.fabricApiTask(root, config.fabricApi, signal);
  let authlib = null;
  if (account?.type === 'ely') {
    stage('meta', 'Получаем authlib-injector');
    authlib = await ensureAuthlib(root, signal);
  }

  const all = [...vanilla, ...fabric, ...assets, ...(runtime ? runtime.tasks : []), fabricApi];
  const downloader = new Downloader({
    concurrency: 10, signal, seeds: seedDirs(root),
    onProgress: p => stage('download', 'Загрузка', { done: p.done, total: p.total, files: p.files, count: p.count }),
  });
  const missing = await downloader.check(all, (n, total) => {
    if (n % 200 === 0 || n === total) stage('check', 'Проверка файлов', { done: n, total });
  });
  if (missing.length) await downloader.run(missing);
  if (runtime) await java.markExecutable(runtime.executables);
  await removeStale(path.dirname(fabricApi.file), [path.basename(fabricApi.file), path.basename(fabricApi.file) + '.sha1']);

  return {
    version, profile, vanilla, fabric, runtime, fabricApi, authlib,
    javaPath: runtime ? runtime.java : settings.javaPath,
    downloaded: missing.length,
  };
}

// Other launchers' folders on this machine, whose assets and libraries are the very same files
function seedDirs(root) {
  const home = os.homedir();
  const roots = [];
  if (process.platform === 'win32' && process.env.APPDATA) roots.push(process.env.APPDATA);
  else if (process.platform === 'darwin') roots.push(path.join(home, 'Library', 'Application Support'));
  else roots.push(path.join(home, '.local', 'share'), home);
  const names = ['.minecraft', 'PrismLauncher', 'PolyMC', 'MultiMC', '.tlauncher'];
  const bases = roots.flatMap(dir => names.map(n => path.join(dir, n)));
  const own = path.resolve(root);
  const list = env => (process.env[env] || '').split(path.delimiter).filter(Boolean);
  const assets = [...bases.map(b => path.join(b, 'assets')), ...list('VANILLA_SEED_ASSETS')];
  const libraries = [...bases.map(b => path.join(b, 'libraries')), ...list('VANILLA_SEED_LIBRARIES')];
  const notOwn = d => !path.resolve(d).startsWith(own);
  return { assets: assets.filter(notOwn), libraries: libraries.filter(notOwn) };
}

async function removeStale(dir, keep) {
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (/^fabric-api-.*\.jar(\.sha1)?$/.test(n) && !keep.includes(n)) await fsp.rm(path.join(dir, n), { force: true });
  }
}

function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(text || ''))) out.push(m[1] ?? m[2]);
  return out;
}

function buildCommand({ root, prepared, settings, account, server }) {
  const { version, profile, vanilla, fabric } = prepared;
  const gameDir = root;
  const nativesDir = path.join(root, 'versions', version.id, 'natives');
  const cp = mc.classpath(root, version, vanilla, fabric);
  const features = {
    has_custom_resolution: !settings.fullscreen,
    is_quick_play_multiplayer: !!server,
  };
  const vars = {
    auth_player_name: account.name,
    version_name: profile.id || version.id,
    game_directory: gameDir,
    assets_root: path.join(root, 'assets'),
    assets_index_name: version.assetIndex.id,
    auth_uuid: account.uuid.replace(/-/g, ''),
    auth_access_token: account.token || '0',
    clientid: '',
    auth_xuid: account.xuid || '',
    version_type: 'release',
    user_type: account.userType || 'legacy',
    resolution_width: settings.width || 1280,
    resolution_height: settings.height || 720,
    quickPlayMultiplayer: server || '',
    natives_directory: nativesDir,
    launcher_name: LAUNCHER_NAME,
    launcher_version: require('../../package.json').version,
    classpath: cp.join(path.delimiter),
    classpath_separator: path.delimiter,
    library_directory: path.join(root, 'libraries'),
  };

  const ramMb = Math.round((settings.ram || 4) * 1024);
  const extraMods = [prepared.fabricApi?.file].filter(Boolean);
  const jvm = [
    `-Xmx${ramMb}M`,
    `-Xms${Math.min(ramMb, 1024)}M`,
    ...splitArgs(settings.jvmArgs),
  ];
  if (account.ely && prepared.authlib) jvm.unshift(`-javaagent:${prepared.authlib}=https://authserver.ely.by`);
  if (extraMods.length) jvm.push(`-Dfabric.addMods=${extraMods.join(path.delimiter)}`);
  const logging = version.logging?.client;
  if (logging?.argument && logging.file) {
    jvm.push(logging.argument.replace('${path}', path.join(root, 'assets', 'log_configs', logging.file.id)));
  }
  jvm.push(...mc.expandArguments(version.arguments?.jvm, features, vars));
  jvm.push(...mc.expandArguments(profile.arguments?.jvm, features, vars));

  const game = [
    ...mc.expandArguments(version.arguments?.game, features, vars),
    ...mc.expandArguments(profile.arguments?.game, features, vars),
  ];
  if (settings.fullscreen) game.push('--fullscreen');

  return { java: prepared.javaPath, args: [...jvm, profile.mainClass || version.mainClass, ...game], cwd: gameDir, nativesDir };
}

async function start({ root, prepared, settings, account, server, detached, stdio }) {
  const command = buildCommand({ root, prepared, settings, account, server });
  await fsp.mkdir(command.nativesDir, { recursive: true });
  for (const sub of ['java', 'jna', 'lwjgl', 'netty']) await fsp.mkdir(path.join(command.nativesDir, sub), { recursive: true });
  if (!await exists(command.java)) throw new Error(`Java не найдена: ${command.java}`);
  const env = { ...process.env };
  // Hybrid laptops on Linux need the PRIME offload variables to reach the NVIDIA card.
  if (process.platform === 'linux' && settings.discreteGpu !== false) {
    const gpu = await require('./analytics').gpuOf(settings, require('./analytics').defaultGpuDetector());
    if (/nvidia/i.test(gpu)) {
      env.__NV_PRIME_RENDER_OFFLOAD = '1';
      env.__GLX_VENDOR_LIBRARY_NAME = 'nvidia';
    }
  }
  const child = spawn(command.java, command.args, {
    cwd: command.cwd,
    detached: !!detached,
    windowsHide: false,
    env,
    stdio: stdio != null ? ['ignore', stdio, stdio] : detached ? 'ignore' : ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  if (detached) child.unref();
  return { child, command };
}

function accountFor(account) {
  if (!account || typeof account === 'string') {
    const name = account || 'Player';
    return { name, uuid: offlineUuid(name), token: '0', userType: 'legacy', xuid: '', ely: false };
  }
  if (account.type === 'microsoft' && account.accessToken) {
    return { name: account.name, uuid: account.uuid, token: account.accessToken, userType: 'msa', xuid: account.xuid || '', ely: false };
  }
  if (account.type === 'ely' && account.accessToken) {
    return { name: account.name, uuid: account.uuid, token: account.accessToken, userType: 'mojang', xuid: '', ely: true };
  }
  const name = account.name;
  return { name, uuid: account.uuid || offlineUuid(name), token: '0', userType: 'legacy', xuid: '', ely: false };
}

module.exports = { prepare, start, buildCommand, accountFor, splitArgs };
