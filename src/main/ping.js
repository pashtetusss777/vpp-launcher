'use strict';

const net = require('net');
const dns = require('dns').promises;

function varint(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function readVarint(buf, offset) {
  let value = 0, shift = 0, pos = offset;
  while (pos < offset + 5) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    if (shift === 28 && (b & 0xf0)) throw new Error('битый ответ');
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: value >>> 0, size: pos - offset };
    shift += 7;
  }
  throw new Error('битый ответ');
}

function statusOf(body, offset) {
  const length = readVarint(body, offset);
  if (!length || offset + length.size + length.value !== body.length) throw new Error('битый ответ');
  const status = JSON.parse(body.toString('utf8', offset + length.size));
  if (!status || typeof status !== 'object' || Array.isArray(status)) throw new Error('битый ответ');
  return status;
}

function packet(id, ...parts) {
  const body = Buffer.concat([varint(id), ...parts]);
  return Buffer.concat([varint(body.length), body]);
}

function mcString(s) {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varint(b.length), b]);
}

function parseAddress(address) {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(address.trim());
  return { host: m ? m[1] : address.trim(), port: m && m[2] ? +m[2] : null };
}

async function resolve(address) {
  const { host, port } = parseAddress(address);
  if (port) return { host, port };
  try {
    const [srv] = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (srv) return { host: srv.name, port: srv.port, shownHost: host };
  } catch { /* no SRV record: the plain address */ }
  return { host, port: 25565 };
}

function flatten(component) {
  if (component == null) return '';
  if (typeof component === 'string') return component;
  if (Array.isArray(component)) return component.map(flatten).join('');
  return (component.text || '') + (component.extra || []).map(flatten).join('');
}

// Server list ping: what the multiplayer screen shows, players and latency
async function ping(address, timeout = 5000) {
  const target = await resolve(address);
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error('Некорректный порт');
  return new Promise((resolvePing, reject) => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    let buffer = Buffer.alloc(0), status = null, sentAt = 0, done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err); else resolvePing(value);
    };
    const timer = setTimeout(() => finish(new Error('нет ответа')), timeout);
    socket.on('error', e => finish(e));
    socket.on('connect', () => {
      const port = Buffer.alloc(2);
      port.writeUInt16BE(target.port);
      socket.write(packet(0x00, varint(-1), mcString(target.shownHost || target.host), port, varint(1)));
      socket.write(packet(0x00));
    });
    socket.on('data', chunk => {
      if (done) return;
      if (buffer.length + chunk.length > 1024 * 1024) return finish(new Error('битый ответ'));
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (true) {
          const len = readVarint(buffer, 0);
          if (!len) return;
          if (len.value < 1 || len.value > 1024 * 1024) return finish(new Error('битый ответ'));
          if (buffer.length < len.size + len.value) return;
          const body = buffer.subarray(len.size, len.size + len.value);
          buffer = buffer.subarray(len.size + len.value);
          const id = readVarint(body, 0);
          if (!id) return finish(new Error('битый ответ'));
          if (!status && id.value === 0x00) {
            status = statusOf(body, id.size);
            const payload = Buffer.alloc(8);
            payload.writeBigInt64BE(BigInt(Date.now()));
            sentAt = Date.now();
            socket.write(packet(0x01, payload));
          } else if (status && id.value === 0x01) {
            finish(null, {
              latency: Date.now() - sentAt,
              online: status.players?.online ?? null,
              max: status.players?.max ?? null,
              motd: flatten(status.description).replace(/§./g, '').trim(),
              version: status.version?.name || '',
              icon: iconOf(status),
            });
            return;
          }
        }
      } catch (e) {
        finish(e instanceof Error ? e : new Error('битый ответ'));
      }
    });
    socket.on('close', () => {
      if (status) finish(null, { latency: null, online: status.players?.online ?? null, max: status.players?.max ?? null, motd: '', version: status.version?.name || '', icon: iconOf(status) });
      else finish(new Error('соединение закрыто'));
    });
  });
}

function iconOf(status) {
  const icon = status?.favicon;
  if (typeof icon !== 'string' || icon.length > 200000) return null;
  if (!icon.startsWith('data:image/') || /[\0-\x1f"<>]/.test(icon)) return null;
  return icon;
}

module.exports = { ping, parseAddress, iconOf, readVarint, statusOf };
