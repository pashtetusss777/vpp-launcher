'use strict';

const crypto = require('crypto');
const fsp = require('fs/promises');
const path = require('path');
const { exists, fetchJson, fetchWithRetry } = require('./util');

// Prism Launcher's public Microsoft app. The old Xbox client id 00000000402b5328 is gone from
// the Microsoft account directory (AADSTS700016). The player confirms a device code in the browser.
const MS_CLIENT = 'c36a9fb6-4f2a-41ff-90bd-ae7cc92031eb';
const MS_SCOPE = 'XboxLive.SignIn XboxLive.offline_access';
const XBL_HEADERS = { 'x-xbl-contract-version': '1' };
const MS_DEVICE = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode';
const MS_TOKEN = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const ELY = 'https://authserver.ely.by';

function authlibUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return u.protocol === 'https:' && (
      host === 'authlib-injector.yushi.moe'
      || host === 'github.com'
      || host === 'objects.githubusercontent.com'
      || host.endsWith('.githubusercontent.com')
    );
  } catch {
    return false;
  }
}

function dashed(id) {
  const h = String(id || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) return String(id || '');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (!signal) return;
    const stop = () => { clearTimeout(t); reject(Object.assign(new Error('Вход отменён'), { code: 'cancelled' })); };
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
  });
}

function jwtPayload(token) {
  const part = String(token || '').split('.')[1] || '';
  const pad = part.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(pad, 'base64').toString('utf8'));
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { errorMessage: text.slice(0, 180) };
  }
}

function msMessage(data) {
  const code = data?.error || '';
  if (code === 'authorization_pending' || code === 'slow_down') return code;
  if (code === 'expired_token') return 'Время входа истекло - начните ещё раз';
  if (code === 'access_denied') return 'Вход отменён в браузере';
  if (code === 'invalid_grant') return 'Сессия Microsoft истекла - войдите ещё раз';
  const desc = String(data?.error_description || data?.errorMessage || '');
  if (/AADSTS700016|was not found in the directory/i.test(desc)) return 'Microsoft не узнал приложение лаунчера';
  if (/AADSTS50059|AADSTS50020|no account/i.test(desc)) return 'Этот аккаунт Microsoft не найден';
  const short = desc.split(/Trace ID:|Correlation ID:|Timestamp:/i)[0].replace(/\s+/g, ' ').trim();
  return short ? short.slice(0, 180) : 'Microsoft не принял вход';
}

function xerrMessage(code) {
  if (code === 2148916233) return 'У этого Microsoft-аккаунта нет профиля Xbox - создайте его на xbox.com и войдите снова';
  if (code === 2148916235) return 'Xbox Live недоступен для этого аккаунта';
  if (code === 2148916238) return 'Детский аккаунт Microsoft: вход должен подтвердить взрослый в семье';
  return '';
}

async function formPost(url, fields) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields),
  });
  const data = await readBody(res);
  if (!res.ok) {
    const err = new Error(msMessage(data));
    err.oauth = data.error || '';
    throw err;
  }
  return data;
}

async function jsonPost(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
  const data = await readBody(res);
  if (!res.ok) {
    const friendly = xerrMessage(data.XErr);
    const err = new Error(friendly || data.errorMessage || data.error || `Сервер ответил ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function exchangeMicrosoft(msToken) {
  const xbl = await jsonPost('https://user.auth.xboxlive.com/user/authenticate', {
    Properties: {
      AuthMethod: 'RPS',
      SiteName: 'user.auth.xboxlive.com',
      RpsTicket: `d=${msToken.access_token}`,
    },
    RelyingParty: 'http://auth.xboxlive.com',
    TokenType: 'JWT',
  }, XBL_HEADERS);
  const xsts = await jsonPost('https://xsts.auth.xboxlive.com/xsts/authorize', {
    Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
    RelyingParty: 'rp://api.minecraftservices.com/',
    TokenType: 'JWT',
  }, XBL_HEADERS);
  const uhs = xsts.DisplayClaims?.xui?.[0]?.uhs;
  if (!uhs || !xsts.Token) throw new Error('Xbox не выдал токен для Minecraft');
  const mc = await jsonPost('https://api.minecraftservices.com/authentication/login_with_xbox', {
    identityToken: `XBL3.0 x=${uhs};${xsts.Token}`,
  });
  const profileRes = await fetch('https://api.minecraftservices.com/minecraft/profile', {
    headers: { Authorization: `Bearer ${mc.access_token}` },
  });
  if (profileRes.status === 404 || profileRes.status === 403) {
    throw new Error('На этом аккаунте Microsoft нет Minecraft');
  }
  const profile = await readBody(profileRes);
  if (!profileRes.ok || !profile?.name) throw new Error('Не получилось прочитать профиль Minecraft');
  let xuid = '';
  try {
    xuid = String(jwtPayload(xsts.Token).xid || '');
  } catch { /* the game starts without it */ }
  const bare = String(profile.id).replace(/-/g, '');
  const active = (profile.skins || []).find(s => s.state === 'ACTIVE') || (profile.skins || [])[0];
  const account = {
    id: `msa:${bare}`,
    type: 'microsoft',
    name: profile.name,
    uuid: dashed(bare),
    accessToken: mc.access_token,
    refreshToken: msToken.refresh_token,
    expiresAt: Date.now() + ((mc.expires_in || msToken.expires_in || 3600) * 1000),
    xuid,
    // Mojang still returns http://textures… — CSP in the UI only allows https:
    skinUrl: httpsUrl(active?.url),
  };
  return account.skinUrl ? account : withSkin(account);
}

async function loginMicrosoft({ signal, onCode } = {}) {
  const start = await formPost(MS_DEVICE, { client_id: MS_CLIENT, scope: MS_SCOPE });
  onCode?.({
    userCode: start.user_code,
    verificationUri: start.verification_uri || 'https://www.microsoft.com/link',
    message: start.message || '',
  });
  const deadline = Date.now() + (start.expires_in || 900) * 1000;
  let interval = Math.max(3, start.interval || 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval, signal);
    try {
      const token = await formPost(MS_TOKEN, {
        client_id: MS_CLIENT,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: start.device_code,
      });
      return exchangeMicrosoft(token);
    } catch (e) {
      if (e.oauth === 'authorization_pending') continue;
      if (e.oauth === 'slow_down') {
        interval += 5000;
        continue;
      }
      throw e;
    }
  }
  throw new Error('Время входа истекло - начните ещё раз');
}

async function refreshMicrosoft(account) {
  if (!account.refreshToken) throw new Error('Сессия Microsoft истекла - войдите ещё раз');
  const token = await formPost(MS_TOKEN, {
    client_id: MS_CLIENT,
    grant_type: 'refresh_token',
    refresh_token: account.refreshToken,
    scope: MS_SCOPE,
  });
  const next = await exchangeMicrosoft(token);
  next.id = account.id;
  return next;
}

function elyAccount(data, clientToken, previous) {
  const profile = data.selectedProfile || (previous ? { id: previous.uuid, name: previous.name } : null);
  if (!profile?.name) throw new Error('У аккаунта Ely.by нет персонажа');
  const bare = String(profile.id).replace(/-/g, '');
  return {
    id: previous?.id || `ely:${bare}`,
    type: 'ely',
    name: profile.name,
    uuid: dashed(bare),
    accessToken: data.accessToken,
    clientToken: data.clientToken || clientToken,
    expiresAt: Date.now() + 6 * 3600 * 1000,
  };
}

async function loginEly(username, password) {
  username = String(username || '').trim();
  if (!username || !password) throw new Error('Введите логин и пароль Ely.by');
  const clientToken = crypto.randomUUID();
  let data;
  try {
    data = await jsonPost(`${ELY}/auth/authenticate`, {
      agent: { name: 'Minecraft', version: 1 },
      username,
      password,
      clientToken,
      requestUser: false,
    });
  } catch (e) {
    if (/invalid credentials|forbidden/i.test(e.message)) throw new Error('Неверный логин или пароль Ely.by');
    throw e;
  }
  return withSkin(elyAccount(data, clientToken));
}

async function refreshEly(account) {
  const data = await jsonPost(`${ELY}/auth/refresh`, {
    accessToken: account.accessToken,
    clientToken: account.clientToken,
    requestUser: false,
    selectedProfile: { id: String(account.uuid || '').replace(/-/g, ''), name: account.name },
  });
  return elyAccount(data, account.clientToken, account);
}

function httpsUrl(url) {
  return String(url || '').replace(/^http:\/\//i, 'https://');
}

function skinFromTextures(value) {
  try {
    const json = JSON.parse(Buffer.from(String(value || ''), 'base64').toString('utf8'));
    return httpsUrl(json?.textures?.SKIN?.url);
  } catch {
    return '';
  }
}

async function profileSkin(url) {
  const res = await fetch(url);
  if (!res.ok) return '';
  const data = await res.json().catch(() => null);
  const prop = (data?.properties || []).find(p => p.name === 'textures');
  return prop ? skinFromTextures(prop.value) : '';
}

// The face the account wears in Minecraft: Mojang's texture for a Microsoft account, Ely.by's for Ely.
async function resolveSkin(account) {
  if (!account || account.type === 'offline' || !account.type) return '';
  const id = String(account.uuid || '').replace(/-/g, '');
  if (account.type === 'microsoft') {
    if (account.skinUrl) return httpsUrl(account.skinUrl);
    if (id) return profileSkin(`https://sessionserver.mojang.com/session/minecraft/profile/${id}`);
    return '';
  }
  if (account.type === 'ely') {
    if (id) {
      const url = await profileSkin(`https://authserver.ely.by/session/minecraft/profile/${id}`);
      if (url) return url;
    }
    if (account.name) return `https://skinsystem.ely.by/skins/${encodeURIComponent(account.name)}.png`;
  }
  return '';
}

async function withSkin(account) {
  if (!account || (account.type !== 'microsoft' && account.type !== 'ely')) return account;
  if (account.skinUrl) {
    const skinUrl = httpsUrl(account.skinUrl);
    return skinUrl === account.skinUrl ? account : { ...account, skinUrl };
  }
  try {
    const skinUrl = await resolveSkin(account);
    return skinUrl ? { ...account, skinUrl: httpsUrl(skinUrl) } : account;
  } catch {
    return account;
  }
}

function inspectSkin(buf) {
  const { nativeImage } = require('electron');
  const img = nativeImage.createFromBuffer(buf);
  if (img.isEmpty()) throw new Error('Это не картинка PNG');
  const { width, height } = img.getSize();
  if (width !== 64 || (height !== 64 && height !== 32)) throw new Error('Скин должен быть PNG 64×64');
  if (height === 32) return 'classic';
  // Slim leaves the outer column of the right arm empty.
  const alpha = img.toBitmap()[(16 * width + 47) * 4 + 3];
  return alpha < 16 ? 'slim' : 'classic';
}

function skinFail(data, status, who) {
  if (status === 401 || status === 403) return `Сессия ${who} истекла — войдите ещё раз`;
  if (status === 429) return `${who} просит подождать минуту`;
  const msg = String(data?.errorMessage || data?.error || data?.message || '');
  if (/png|skin|image|variant/i.test(msg)) return 'Файл не похож на скин Minecraft (PNG 64×64)';
  return msg ? msg.slice(0, 180) : `${who} не принял скин (${status})`;
}

function bustSkin(url) {
  const clean = httpsUrl(url);
  if (!clean) return '';
  return `${clean.split('?')[0]}?v=${Date.now()}`;
}

async function postSkin(account, buf, variant) {
  const slim = variant === 'slim';
  const form = new FormData();
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  form.append('file', new Blob([bytes], { type: 'image/png' }), 'skin.png');
  let url;
  if (account.type === 'microsoft') {
    form.append('variant', slim ? 'slim' : 'classic');
    url = 'https://api.minecraftservices.com/minecraft/profile/skins';
  } else {
    form.append('model', slim ? 'slim' : 'default');
    form.append('name', account.name);
    url = 'https://skinsystem.ely.by/api/skins';
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${account.accessToken}`, Accept: 'application/json' },
    body: form,
  });
  const data = await readBody(res);
  if (!res.ok) {
    const err = new Error(skinFail(data, res.status, account.type === 'ely' ? 'Ely.by' : 'Minecraft'));
    err.status = res.status;
    throw err;
  }
  if (account.type === 'microsoft') {
    const active = (data.skins || []).find(s => s.state === 'ACTIVE') || (data.skins || [])[0];
    return {
      ...account,
      name: data.name || account.name,
      skinUrl: bustSkin(active?.url) || account.skinUrl,
    };
  }
  const elyUrl = data.url || data.skin || `https://skinsystem.ely.by/skins/${encodeURIComponent(account.name)}.png`;
  return { ...account, skinUrl: bustSkin(elyUrl) };
}

async function uploadSkin(account, file) {
  if (!account || (account.type !== 'microsoft' && account.type !== 'ely')) {
    throw new Error('Сменить скин можно у лицензии Microsoft и у Ely.by');
  }
  const buf = await fsp.readFile(file);
  if (!buf.length || buf.length > 512 * 1024) throw new Error('Файл скина пустой или слишком большой');
  const variant = inspectSkin(buf);
  let fresh = await freshen(account);
  try {
    return await postSkin(fresh, buf, variant);
  } catch (e) {
    if (e.status !== 401 && e.status !== 403) throw e;
    fresh = fresh.type === 'ely' ? await refreshEly(fresh) : await refreshMicrosoft(fresh);
    return postSkin(fresh, buf, variant);
  }
}

async function freshen(account) {
  if (!account || account.type === 'offline' || !account.type) return account;
  let next = account;
  const fresh = account.expiresAt && account.expiresAt > Date.now() + 120000;
  if (!fresh) {
    if (account.type === 'ely') next = await refreshEly(account);
    else if (account.type === 'microsoft') next = await refreshMicrosoft(account);
  }
  next = await withSkin(next);
  if (!next.skinUrl && account.skinUrl) return { ...next, skinUrl: account.skinUrl };
  return next;
}

async function ensureAuthlib(root, signal) {
  const file = path.join(root, 'launcher', 'authlib-injector.jar');
  if (await exists(file)) {
    const stat = await fsp.stat(file);
    if (stat.size > 50000) return file;
  }
  const meta = await fetchJson('https://authlib-injector.yushi.moe/artifact/latest.json', { signal });
  const url = meta.download_url || meta.downloadUrl;
  const sha = String(meta.checksums?.sha256 || meta.sha256 || '').toLowerCase();
  if (!url || !/^[0-9a-f]{64}$/.test(sha) || !authlibUrl(url)) {
    throw new Error('Не нашёл authlib-injector для входа Ely.by');
  }
  const res = await fetchWithRetry(url, { signal });
  const buf = Buffer.from(await res.arrayBuffer());
  if (crypto.createHash('sha256').update(buf).digest('hex') !== sha) {
    throw new Error('authlib-injector скачался с ошибкой - запустите ещё раз');
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, file);
  return file;
}

module.exports = { loginEly, loginMicrosoft, freshen, ensureAuthlib, dashed, withSkin, uploadSkin, authlibUrl };
