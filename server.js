// Cube Racer server - ZERO dependencies (nothing to npm install). Serves the game from ./public and runs
// multiplayer over a small built-in WebSocket implementation. Rooms, countdown, checkpoint validation,
// laps, live positions and results are all handled here.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LAPS, CP_COUNT } from './public/js/track.js';
import { sanitizeCosmetics, sanitizeName, sanitizeSkin } from './public/js/catalog.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 8;
const COUNTDOWN_MS = 4000;
const FINISH_GRACE_MS = Number(process.env.FINISH_GRACE_MS) || 25000; // after the first finisher, everyone else gets this long
const TICK_MS = 50;            // snapshot rate (20 Hz)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// ------------------------------------------------------------------ minimal WebSocket (RFC 6455)
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 256 * 1024;

class Conn {
  constructor(socket, onMessage, onClose) {
    this.socket = socket; this.buf = Buffer.alloc(0); this.frags = []; this.fragOp = 0; this.closed = false;
    this.onMessage = onMessage; this.onClose = onClose;
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }
  finish() { if (this.closed) return; this.closed = true; this.onClose(); }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), op = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (b.length < 10) return; len = b.readUInt32BE(2) * 2 ** 32 + b.readUInt32BE(6); off = 10; }
      if (len > MAX_FRAME) return this.close();
      if (masked) off += 4;
      if (b.length < off + len) return;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (masked) { const m = b.subarray(off - 4, off); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this.buf = b.subarray(off + len);
      if (op === 0x8) return this.close();
      if (op === 0x9) { this.frame(0xA, payload); continue; }   // ping -> pong
      if (op === 0xA) continue;                                  // pong
      if (op === 0x1 || op === 0x2) { this.fragOp = op; this.frags = [payload]; }
      else if (op === 0x0) this.frags.push(payload);
      if (fin) {
        const msg = Buffer.concat(this.frags); this.frags = [];
        if (this.fragOp === 0x1) { try { this.onMessage(msg.toString('utf8')); } catch (e) { console.error('message handler error:', e); } }
      }
    }
  }
  frame(op, payload) {
    if (this.closed || this.socket.destroyed) return;
    const n = payload.length;
    let head;
    if (n < 126) head = Buffer.from([0x80 | op, n]);
    else if (n < 65536) head = Buffer.from([0x80 | op, 126, n >> 8, n & 255]);
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeUInt32BE(Math.floor(n / 2 ** 32), 2); head.writeUInt32BE(n >>> 0, 6); }
    this.socket.write(Buffer.concat([head, payload]));
  }
  send(obj, droppable = false) {
    if (this.closed) return;
    if (droppable && this.socket.writableLength > 262144) return; // slow client: skip snapshots instead of queueing forever
    this.frame(0x1, Buffer.from(JSON.stringify(obj)));
  }
  ping() { this.frame(0x9, Buffer.alloc(0)); }
  close() { if (this.closed) return; try { this.frame(0x8, Buffer.alloc(0)); this.socket.end(); } catch {} this.finish(); }
}

// ------------------------------------------------------------------ rooms & players
const rooms = new Map();
const allConns = new Set();
let nextId = 1;

class Player {
  constructor(conn) {
    this.id = nextId++; this.conn = conn; this.name = 'Racer'; this.skin = ''; this.cos = sanitizeCosmetics({});
    this.room = null; this.resetRace();
  }
  resetRace() { this.st = null; this.seq = 0; this.fin = false; this.finTime = 0; this.slot = 0; }
  send(o, d) { this.conn.send(o, d); }
}

function makeCode() {
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  for (;;) { let c = ''; for (let i = 0; i < 4; i++) c += A[crypto.randomInt(A.length)]; if (!rooms.has(c)) return c; }
}
function createRoom(isPublic) {
  const room = { code: makeCode(), isPublic, hostId: 0, phase: 'lobby', players: new Map(), raceStart: 0, timers: [] };
  rooms.set(room.code, room);
  return room;
}
const broadcast = (room, o, d) => { for (const p of room.players.values()) p.send(o, d); };
const appearance = (p) => ({ t: 'appearance', id: p.id, name: p.name, skin: p.skin, cos: p.cos });
function roomInfo(room) {
  return { t: 'room', code: room.code, phase: room.phase, hostId: room.hostId, laps: LAPS, max: MAX_PLAYERS,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name })) };
}
function clearTimers(room) { room.timers.forEach(clearTimeout); room.timers = []; }

function joinRoom(p, room) {
  leaveRoom(p);
  p.room = room; p.resetRace();
  room.players.set(p.id, p);
  if (!room.hostId) room.hostId = p.id;
  for (const o of room.players.values()) p.send(appearance(o)); // joiner learns everyone's look
  broadcast(room, appearance(p));                                // everyone learns the joiner's look
  broadcast(room, roomInfo(room));
}
function leaveRoom(p) {
  const room = p.room; if (!room) return;
  room.players.delete(p.id); p.room = null;
  if (room.players.size === 0) { clearTimers(room); rooms.delete(room.code); return; }
  if (room.hostId === p.id) room.hostId = room.players.values().next().value.id;
  broadcast(room, { t: 'left', id: p.id });
  broadcast(room, roomInfo(room));
  if (room.phase === 'racing') maybeEndRace(room);
}

function startRace(room) {
  room.phase = 'countdown'; room.firstFinish = false;
  const slots = {}; let i = 0;
  for (const p of room.players.values()) { p.resetRace(); p.slot = i; slots[p.id] = i++; }
  broadcast(room, { t: 'phase', phase: 'countdown', ms: COUNTDOWN_MS, slots, laps: LAPS });
  broadcast(room, roomInfo(room));
  room.timers.push(setTimeout(() => {
    room.phase = 'racing'; room.raceStart = Date.now();
    broadcast(room, { t: 'phase', phase: 'racing' });
  }, COUNTDOWN_MS));
}

function ranking(room) {
  return [...room.players.values()].sort((a, b) => {
    if (a.fin !== b.fin) return a.fin ? -1 : 1;
    if (a.fin) return a.finTime - b.finTime;
    return (b.st ? b.st.pr : -1e9) - (a.st ? a.st.pr : -1e9);
  });
}
function maybeEndRace(room) {
  if (room.phase !== 'racing') return;
  if ([...room.players.values()].every((p) => p.fin)) room.timers.push(setTimeout(() => endRace(room), 1500));
}
function endRace(room) {
  if (room.phase !== 'racing') return;
  room.phase = 'results'; clearTimers(room);
  const rows = ranking(room).map((p, i) => ({ pos: i + 1, id: p.id, name: p.name, fin: p.fin, time: p.fin ? p.finTime : null }));
  broadcast(room, { t: 'results', rows });
  broadcast(room, roomInfo(room));
}

function handle(p, msg) {
  switch (msg.t) {
    case 'profile':
      p.name = sanitizeName(msg.name); p.skin = sanitizeSkin(msg.skin); p.cos = sanitizeCosmetics(msg.cos);
      if (p.room) { broadcast(p.room, appearance(p)); broadcast(p.room, roomInfo(p.room)); }
      break;
    case 'quick': {
      let room = [...rooms.values()].find((r) => r.isPublic && r.phase === 'lobby' && r.players.size < MAX_PLAYERS);
      if (!room) room = createRoom(true);
      joinRoom(p, room); break;
    }
    case 'create': joinRoom(p, createRoom(false)); break;
    case 'join': {
      const room = rooms.get(String(msg.code || '').toUpperCase().trim());
      if (!room) return p.send({ t: 'err', msg: 'Room not found' });
      if (room.phase === 'countdown' || room.phase === 'racing') return p.send({ t: 'err', msg: 'Race already in progress' });
      if (room.players.size >= MAX_PLAYERS) return p.send({ t: 'err', msg: 'Room is full' });
      joinRoom(p, room); break;
    }
    case 'leave': leaveRoom(p); break;
    case 'start':
      if (p.room && p.room.hostId === p.id && (p.room.phase === 'lobby')) startRace(p.room);
      break;
    case 'lobby': // host sends everyone back to the lobby after results
      if (p.room && p.room.hostId === p.id && p.room.phase === 'results') {
        p.room.phase = 'lobby'; for (const o of p.room.players.values()) o.resetRace();
        broadcast(p.room, roomInfo(p.room));
      }
      break;
    case 'state': {
      const room = p.room; if (!room || room.phase !== 'racing') return;
      const ok = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
      if (!ok(msg.p) || !ok(msg.f) || !ok(msg.u)) return;
      p.st = { p: msg.p, f: msg.f, u: msg.u, s: +msg.s || 0, b: msg.b ? 1 : 0, g: msg.g ? 1 : 0, pr: Number.isFinite(msg.pr) ? msg.pr : 0 };
      break;
    }
    case 'cp': { // the client reports crossing checkpoint k; the server only accepts them in order
      const room = p.room; if (!room || room.phase !== 'racing' || p.fin) return;
      if (msg.k !== (p.seq + 1) % CP_COUNT) return;
      p.seq++;
      if (Math.floor(p.seq / CP_COUNT) >= LAPS) {
        p.fin = true; p.finTime = Date.now() - room.raceStart;
        broadcast(room, { t: 'finish', id: p.id, time: p.finTime });
        if (!room.firstFinish) { room.firstFinish = true; room.timers.push(setTimeout(() => endRace(room), FINISH_GRACE_MS)); }
        maybeEndRace(room);
      }
      break;
    }
  }
}

// snapshot loop: ~20 Hz live positions for every room that is racing
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase !== 'racing') continue;
    const rk = ranking(room).map((p) => p.id);
    const pl = [...room.players.values()].map((p) => ({ id: p.id, st: p.st, lap: Math.floor(p.seq / CP_COUNT), fin: p.fin ? 1 : 0 }));
    broadcast(room, { t: 'snap', pl, rk }, true);
  }
}, TICK_MS);

// ------------------------------------------------------------------ http + upgrade
export function createServer() {
  const server = http.createServer((req, res) => {
    let url;
    try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch { res.writeHead(400); return res.end('Bad request'); }
    if (url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url === '/') url = '/index.html';
    const file = path.join(PUBLIC, path.normalize(url));
    if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) { socket.destroy(); return; }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    socket.setNoDelay(true);
    let player;
    const conn = new Conn(socket,
      (text) => { let m; try { m = JSON.parse(text); } catch { return; } if (m && typeof m === 'object') handle(player, m); },
      () => { if (player) leaveRoom(player); });
    player = new Player(conn);
    allConns.add(conn); socket.on('close', () => allConns.delete(conn));
    conn.send({ t: 'welcome', id: player.id, laps: LAPS, cpCount: CP_COUNT });
  });

  const keepAlive = setInterval(() => { for (const c of allConns) c.ping(); }, 25000);
  server.on('close', () => clearInterval(keepAlive));
  return server;
}

process.on('uncaughtException', (e) => console.error('uncaught:', e));
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, '0.0.0.0', () => console.log(`Cube Racer running on port ${port}`));
}
