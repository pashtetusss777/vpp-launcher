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
  while (true) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, size: pos - offset };
    shift += 7;
    if (shift > 35) throw new Error('битый ответ');
  }
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
    const srvPromise = dns.resolveSrv(`_minecraft._tcp.${host}`);
    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('dns timeout')), 2500));
    const [srv] = await Promise.race([srvPromise, timeoutPromise]);
    if (srv) return { host: srv.name, port: srv.port, shownHost: host };
  } catch { /* no SRV record or timeout: the plain address */ }
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
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const len = readVarint(buffer, 0);
        if (!len || buffer.length < len.size + len.value) return;
        const body = buffer.subarray(len.size, len.size + len.value);
        buffer = buffer.subarray(len.size + len.value);
        const id = readVarint(body, 0);
        if (!status && id.value === 0x00) {
          const strLen = readVarint(body, id.size);
          const json = body.toString('utf8', id.size + strLen.size, id.size + strLen.size + strLen.value);
          try {
            status = JSON.parse(json);
          } catch {
            finish(new Error('битый ответ'));
            return;
          }
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
            icon: typeof status.favicon === 'string' && status.favicon.startsWith('data:image/') ? status.favicon : null,
          });
        }
      }
    });
    socket.on('close', () => {
      if (status) finish(null, { latency: null, online: status.players?.online ?? null, max: status.players?.max ?? null, motd: '', version: status.version?.name || '', icon: status.favicon || null });
      else finish(new Error('соединение закрыто'));
    });
  });
}

module.exports = { ping, parseAddress };
