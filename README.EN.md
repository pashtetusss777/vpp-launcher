<div align="center">
  <img src=".github/assets/logo-header.png" width="140" alt="Vanilla++">

  # Vanilla++

  A Minecraft launcher for the **mc.vanillaplus.plus** server. Installs the game,
  Java and mods, keeps everything current, starts with a couple of clicks.

  [![Release](https://img.shields.io/github/v/release/pashtetusss777/vpp-launcher)](https://github.com/pashtetusss777/vpp-launcher/releases/latest)
  [![Downloads](https://img.shields.io/github/downloads/pashtetusss777/vpp-launcher/total)](https://github.com/pashtetusss777/vpp-launcher/releases)
  [![CI](https://img.shields.io/github/actions/workflow/status/pashtetusss777/vpp-launcher/release.yml?label=CI)](https://github.com/pashtetusss777/vpp-launcher/actions/workflows/release.yml)
  [![License](https://img.shields.io/github/license/pashtetusss777/vpp-launcher)](LICENSE)

  **Windows · macOS · Linux** · Electron · Fabric

  [Русский](README.md) | English
</div>

## Screenshots

| | |
|---|---|
| ![Home](.github/assets/screens/01-home-dark.png) | ![Light theme](.github/assets/screens/09-home-light.png) |
| ![Mods](.github/assets/screens/02-mods.png) | ![Mod catalog](.github/assets/screens/03-mods-catalog.png) |
| ![Resource packs](.github/assets/screens/04-packs.png) | ![Shaders](.github/assets/screens/05-shaders.png) |
| ![Accounts](.github/assets/screens/06-accounts.png) | ![Settings](.github/assets/screens/07-settings.png) |
| ![Logs](.github/assets/screens/08-logs.png) | |

## What it does

- **One-click play.** The launcher downloads Minecraft, Fabric and Mojang's Java by itself and picks the version and memory your machine needs.
- **The server modpack.** The pack lives on Modrinth and syncs on every launch. It does not wipe your game settings.
- **Mod catalog.** Search on Modrinth and CurseForge, with categories, versions and dependencies. Every download is checked against sha1 and sha256.
- **Resource packs and shaders.** One toggle each. Iris for shaders gets installed on its own if it is missing.
- **Accounts.** Microsoft, Ely.by, or a plain nickname for servers that allow it. Skins can be changed right in the launcher.
- **Your own mods and packs.** Drag a `.jar`, `.mrpack` or `.zip` into the window, the launcher handles the rest.
- **Launcher updates.** Press the button on the banner and everything else happens on its own. Every update file is checked against its checksum.
- **Logs.** A live log tail in the UI and an honest take on crashes instead of panicking over every hiccup.

## Installation

Grab a file from the [latest release](https://github.com/pashtetusss777/vpp-launcher/releases/latest):

| Platform | File |
|---|---|
| Windows | `VanillaPlusPlus-<version>-x64.exe` (installer) or `-portable.zip` |
| macOS | `-arm64.pkg` / `-arm64.zip`, `-x64.pkg` / `-x64.zip` |
| Linux | `-x64.AppImage`, `-x64.tar.gz`, `-amd64.deb`, `-x64.pacman` (arm64 variants too) |

The launcher updates itself, just press the button on the banner. If an update goes wrong, the previous version stays next to it in a `Vanilla++.previous-*` folder, so you are never left launcherless.

> **Disclaimer.** Vanilla++ is not affiliated with Mojang or Ely.by. Not an official Minecraft product.

## Building from source

```sh
npm ci         # dependencies, Node 22+ required
npm start      # run from source
npm test       # 46 regression tests, no network and no game launch
npm run dist   # builds for the current platform
```

## Settings and profile recovery

- Windows: `%APPDATA%\Vanilla++\settings.json`. Theme and accounts are plain JSON, tokens live separately in the encrypted `accountSecrets` field. The older `enc1.` format is still readable.
- Before the first migration of an old file a `settings.json.bak` copy is created. If the settings file is damaged, the launcher tells you instead of silently resetting the profile.
- For a full backup of encrypted settings, keep the `Local State` file from the same folder along with them: on Windows the decryption key is bound to the OS user. And no, do not publish these files.

## FAQ

**Where are the game files and mods?**
In `%APPDATA%\.vanilla-plus-plus`. The "Папка игры" button in the launcher opens it for you. Mods live in `mods`, logs in `launcher`.

**Can I play without a Mojang license?**
Yes, add an offline account with a nickname. This only works on servers that allow it, and our server does.

**I already have .minecraft or Prism installed. Download everything again?**
No. The launcher finds ready libraries and assets from other launchers on your machine and takes them from there, so much less gets downloaded.

**How much memory should the game get?**
4 GB is enough for vanilla, go with 6 or 8 for mods. More is not better: the game never gets all of the machine's memory anyway.

**How do I add my own mod?**
Drag a `.jar` into the launcher window or add it through the catalog. Toggle it on and off, or remove it with a one-click undo.

**Can I change the Minecraft version?**
The version comes from the server modpack and is not picked separately. That way all players sit on the same version and the same pack.

**My accounts and theme disappeared after an update. What now?**
This is fixable: close the launcher and check the "Settings and profile recovery" section above. The `settings.json.bak` copy is usually right there.

**My antivirus complains about updates.**
Updates on Windows replace files silently through a hidden script, which some antivirus products dislike. If in doubt, compare the file's sha256 with the digest from the release.

**CurseForge is not responding.**
The catalog runs through the unofficial [MCIM](https://www.mcimirror.top) mirror, which can be down on some days or networks. Modrinth is reached directly and does not depend on it.

**The game crashed. What do I do?**
Open "Логи" in the launcher: it shows the log tail and the crash report. Most often a single mod is to blame, switch it off and start again.

## License

[GPL-3.0-only](LICENSE)
