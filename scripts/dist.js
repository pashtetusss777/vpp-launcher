'use strict';

// Windows: installer + portable zip.
// macOS: .pkg + .zip. Linux: AppImage, deb, pacman, tar.gz.
// Each platform is built on itself (`npm run dist`).
const { spawnSync } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const appOut = path.join(root, 'dist-app');
const releaseOut = path.join(root, 'dist-release');
const payloadZip = path.join(root, 'build', 'payload.zip');
const pkg = require('../package.json');

function run(cmd, args, env = {}) {
  if ((args[0] === 'npx' && args[1] === 'electron-builder') || args[0] === 'electron-builder') {
    args = [...args, '--publish', 'never'];
  }
  console.log('>', cmd, args.join(' '));
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false', ...env },
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

async function zipPayload() {
  const unpacked = path.join(appOut, 'win-unpacked');
  if (!fs.existsSync(path.join(unpacked, 'Vanilla++.exe'))) {
    throw new Error('Нет dist-app/win-unpacked/Vanilla++.exe');
  }
  await fsp.mkdir(path.dirname(payloadZip), { recursive: true });
  await fsp.rm(payloadZip, { force: true });
  // tar on Windows 10+ can write zip; archive the contents, not the folder name
  run('tar', ['-a', '-cf', payloadZip, '-C', unpacked, '.']);
  const mb = (fs.statSync(payloadZip).size / 1048576).toFixed(1);
  console.log(`payload.zip · ${mb} МБ`);
}

async function zipPortable() {
  const unpacked = path.join(appOut, 'win-unpacked');
  const outZip = path.join(releaseOut, `VanillaPlusPlus-${pkg.version}-portable.zip`);
  if (!fs.existsSync(path.join(unpacked, 'Vanilla++.exe'))) {
    throw new Error('Нет dist-app/win-unpacked/Vanilla++.exe');
  }
  await fsp.mkdir(releaseOut, { recursive: true });
  await fsp.rm(outZip, { force: true });

  const stage = path.join(os.tmpdir(), `vpp-portable-zip-${pkg.version}`);
  const inner = path.join(stage, 'Vanilla++');
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(inner, { recursive: true });
  // robocopy is fastest on Windows for large Electron trees (exit 0–7 = success)
  const copy = spawnSync(
    'robocopy',
    [unpacked, inner, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/nc', '/ns', '/np'],
    { cwd: root, stdio: 'inherit', shell: true },
  );
  if ((copy.status ?? 1) >= 8) {
    console.error('robocopy failed', copy.status);
    process.exit(1);
  }
  run('tar', ['-a', '-cf', outZip, '-C', stage, 'Vanilla++']);
  await fsp.rm(stage, { recursive: true, force: true });
  const mb = (fs.statSync(outZip).size / 1048576).toFixed(1);
  console.log(`portable.zip · ${mb} МБ → ${path.basename(outZip)}`);
}

async function distWindows() {
  await fsp.rm(appOut, { recursive: true, force: true });
  await fsp.mkdir(releaseOut, { recursive: true });
  for (const name of await fsp.readdir(releaseOut).catch(() => [])) {
    if (/portable\.exe$/i.test(name)) await fsp.rm(path.join(releaseOut, name), { force: true });
  }

  run('npx', [
    'electron-builder', '--win', '--dir',
    `--config.directories.output=${appOut}`,
  ]);

  await zipPayload();
  await zipPortable();

  run('npx', [
    'electron-builder', '--win', 'portable',
    '--config', 'electron-builder.setup.json',
  ]);
}

async function distUnix(builderArgs) {
  await fsp.mkdir(releaseOut, { recursive: true });
  run('npx', [
    'electron-builder',
    ...builderArgs,
    `--config.directories.output=${releaseOut}`,
  ]);
}

async function distMac() {
  await fsp.mkdir(releaseOut, { recursive: true });
  // pkg and a second arch in one electron-builder call race on distribution.xml
  for (const arch of ['arm64', 'x64']) {
    run('npx', ['electron-builder', '--mac', 'zip', `--${arch}`, `--config.directories.output=${releaseOut}`]);
    run('npx', ['electron-builder', '--mac', 'pkg', `--${arch}`, `--config.directories.output=${releaseOut}`]);
  }
}

async function main() {
  if (process.platform === 'win32') await distWindows();
  else if (process.platform === 'darwin') await distMac();
  // AppImage rejects "+" in the product filename; the window title in the UI stays Vanilla++
  else if (process.platform === 'linux') {
    await distUnix([
      '--linux', 'AppImage', 'deb', 'pacman', 'tar.gz',
      '--config.productName=VanillaPlusPlus',
      '--config.linux.executableName=VanillaPlusPlus',
    ]);
  }
  else throw new Error(`Сборка для ${process.platform} не настроена`);

  console.log('\nГотово:');
  for (const name of await fsp.readdir(releaseOut)) {
    if (!/\.(exe|zip|pkg|AppImage|deb|pacman|tar\.gz)$/i.test(name)) continue;
    const size = (fs.statSync(path.join(releaseOut, name)).size / 1048576).toFixed(1);
    console.log(`  ${name} · ${size} МБ`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
