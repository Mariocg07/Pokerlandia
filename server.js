/*
  PokerLandia — game server.

  Zero dependencies: plain Node. Serves the client over HTTP and runs the
  tables over WebSocket. The server owns every card; a client is only ever
  told its own hole cards, so there is nothing to dig out of the page.

    node server.js            # then open the printed address
*/
'use strict';

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const os     = require('os');

const Engine = require('./engine.js');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_SEATS = 9;

/* =========================================================
   Minimal WebSocket (RFC 6455) — enough for small JSON messages
   ========================================================= */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Conn {
  constructor(socket){
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frags = [];
    this.fragOp = 0;
    this.open = true;
    this.onMessage = null;
    this.onClose = null;

    socket.on('data', d => this._data(d));
    socket.on('error', () => this.close());
    socket.on('close', () => {
      if (this.open){ this.open = false; if (this.onClose) this.onClose(); }
    });
  }

  _data(chunk){
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;){
      const frame = this._readFrame();
      if (!frame) break;
      const { op, payload } = frame;
      if (op === 0x8){ this.close(); return; }             // close
      if (op === 0x9){ this._send(0xA, payload); continue; } // ping -> pong
      if (op === 0xA) continue;                              // pong
      if (op === 0x0){                                       // continuation
        this.frags.push(payload);
        if (frame.fin){
          const full = Buffer.concat(this.frags);
          this.frags = [];
          this._deliver(this.fragOp, full);
        }
        continue;
      }
      if (frame.fin) this._deliver(op, payload);
      else { this.fragOp = op; this.frags = [payload]; }
    }
  }

  _readFrame(){
    const b = this.buf;
    if (b.length < 2) return null;
    const fin  = (b[0] & 0x80) !== 0;
    const op   =  b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126){
      if (b.length < off + 2) return null;
      len = b.readUInt16BE(off); off += 2;
    } else if (len === 127){
      if (b.length < off + 8) return null;
      const hi = b.readUInt32BE(off), lo = b.readUInt32BE(off + 4);
      if (hi !== 0){ this.close(); return null; }           // absurdly large
      len = lo; off += 8;
    }
    let key = null;
    if (masked){
      if (b.length < off + 4) return null;
      key = b.slice(off, off + 4); off += 4;
    }
    if (b.length < off + len) return null;
    const payload = Buffer.from(b.slice(off, off + len));
    if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
    this.buf = b.slice(off + len);
    return { fin, op, payload };
  }

  _deliver(op, payload){
    if (op !== 0x1) return;                                  // text only
    if (!this.onMessage) return;
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); }
    catch (e) { return; }
    this.onMessage(msg);
  }

  _send(op, payload){
    if (!this.open) return;
    const len = payload.length;
    let head;
    if (len < 126){
      head = Buffer.alloc(2);
      head[1] = len;
    } else if (len < 65536){
      head = Buffer.alloc(4);
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else {
      head = Buffer.alloc(10);
      head[1] = 127;
      head.writeUInt32BE(0, 2);
      head.writeUInt32BE(len, 6);
    }
    head[0] = 0x80 | op;
    try { this.socket.write(Buffer.concat([head, payload])); }
    catch (e) { this.close(); }
  }

  send(obj){ this._send(0x1, Buffer.from(JSON.stringify(obj), 'utf8')); }

  close(){
    if (!this.open) return;
    this.open = false;
    try { this._send(0x8, Buffer.alloc(0)); this.socket.end(); } catch (e) {}
    if (this.onClose) this.onClose();
  }
}

/* =========================================================
   HTTP
   ========================================================= */

const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
               '.css':'text/css; charset=utf-8', '.ico':'image/x-icon' };

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/index.html';

  // the engine is shared with the client for offline play
  const file = url === '/engine.js'
    ? path.join(__dirname, 'engine.js')
    : path.join(PUBLIC_DIR, path.normalize(url).replace(/^(\.\.[\/\\])+/, ''));

  if (!file.startsWith(PUBLIC_DIR) && file !== path.join(__dirname, 'engine.js')){
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err){ res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
                         'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key){ socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  attach(new Conn(socket));
});

/* =========================================================
   Rooms
   ========================================================= */

const clients = new Map();   // cid -> {cid, conn, name, code}
const rooms   = new Map();   // code -> room
let cidSeq = 0;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no look-alikes
function makeCode(){
  let c;
  do {
    c = '';
    for (let i = 0; i < 5; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  } while (rooms.has(c));
  return c;
}

function createRoom(isPublic, hostCid){
  const room = {
    code: makeCode(), isPublic: !!isPublic, hostCid,
    seats: [],                 // {cid|null, name, bot}
    G: null, started: false, prevBoard: 0,
    stack: 10000, speed: 8,
    timer: null, created: Date.now()
  };
  rooms.set(room.code, room);
  return room;
}

function destroyRoom(room){
  clearTimeout(room.timer);
  rooms.delete(room.code);
}

const humanSeats = room => room.seats.filter(s => s.cid);

function roomInfo(room){
  return {
    code: room.code, isPublic: room.isPublic, started: room.started,
    host: room.hostCid, stack: room.stack, speed: room.speed,
    seats: room.seats.map((s, i) => ({ i, name: s.name, bot: s.bot, you: false, cid: s.cid }))
  };
}

function sendRoom(room){
  room.seats.forEach((s, i) => {
    if (!s.cid) return;
    const c = clients.get(s.cid);
    if (!c) return;
    const info = roomInfo(room);
    info.seats.forEach(x => { x.you = x.cid === s.cid; delete x.cid; });
    info.youSeat = i;
    info.youAreHost = room.hostCid === s.cid;
    c.conn.send({ t: 'room', room: info });
  });
}

function publicList(){
  const out = [];
  for (const room of rooms.values()){
    if (!room.isPublic) continue;
    out.push({ code: room.code, players: humanSeats(room).length,
               seats: room.seats.length, started: room.started });
  }
  return out.sort((a, b) => b.players - a.players).slice(0, 20);
}

function broadcastPublicList(){
  for (const c of clients.values())
    if (!c.code) c.conn.send({ t: 'publicRooms', rooms: publicList() });
}

function joinRoom(c, room){
  if (room.started) return fail(c, 'That table has already started.');
  if (room.seats.length >= MAX_SEATS) return fail(c, 'That table is full.');
  room.seats.push({ cid: c.cid, name: c.name, bot: false });
  c.code = room.code;
  sendRoom(room);
  broadcastPublicList();
}

function leaveRoom(c){
  const room = rooms.get(c.code);
  c.code = null;
  if (!room) return;
  const ix = room.seats.findIndex(s => s.cid === c.cid);

  if (room.started && ix >= 0 && room.G){
    // keep the table moving; the empty seat plays itself out
    room.seats[ix].bot = true;
    room.seats[ix].cid = null;
    if (room.G.players[ix]) room.G.players[ix].bot = true;
  } else if (ix >= 0){
    room.seats.splice(ix, 1);
  }

  if (!humanSeats(room).length){ destroyRoom(room); broadcastPublicList(); return; }
  if (room.hostCid === c.cid) room.hostCid = humanSeats(room)[0].cid;
  sendRoom(room);
  broadcastPublicList();
}

const fail = (c, msg) => c.conn.send({ t: 'error', msg });

/* =========================================================
   Table loop — the server paces itself so clients can animate
   ========================================================= */

function pushState(room, anim){
  room.seats.forEach((s, i) => {
    if (!s.cid) return;
    const c = clients.get(s.cid);
    if (!c) return;
    c.conn.send({ t: 'state', anim, g: Engine.view(room.G, i) });
  });
}

function startGame(room){
  if (room.seats.length < 2) return;
  room.started = true;
  room.G = Engine.createGame(
    room.seats.map(s => ({ name: s.name, bot: s.bot })),
    room.stack, room.speed);
  room.prevBoard = 0;
  sendRoom(room);
  pushState(room, 'newhand');
  room.timer = setTimeout(() => drive(room), 2600);
  broadcastPublicList();
}

function endGame(room){
  room.started = false;
  room.G = null;
  room.seats = room.seats.filter(s => s.cid);      // drop the stand-ins
  if (!room.seats.length){ destroyRoom(room); broadcastPublicList(); return; }
  sendRoom(room);
  broadcastPublicList();
}

function drive(room){
  clearTimeout(room.timer);
  const G = room.G;
  if (!G) return;

  if (G.phase === 'over'){
    pushState(room, 'over');
    room.timer = setTimeout(() => endGame(room), 11000);
    return;
  }
  if (G.phase === 'showdown'){
    pushState(room, 'showdown');
    room.timer = setTimeout(() => {
      Engine.newHand(G);
      room.prevBoard = 0;
      pushState(room, 'newhand');
      room.timer = setTimeout(() => drive(room), 2600);
    }, 6500);
    return;
  }
  if (G.phase === 'runout'){
    room.timer = setTimeout(() => { Engine.runoutRest(G); afterMove(room); }, 1500);
    return;
  }

  const p = G.players[G.toAct];
  if (!p){ return; }
  pushState(room, 'turn');

  if (p.bot){
    room.timer = setTimeout(() => {
      if (!room.G) return;
      Engine.applyAction(G, p, Engine.botAction(G, p));
      afterMove(room);
    }, 900 + Math.random() * 800);
    return;
  }
  // a human has 45 seconds, then the table acts for them rather than stalling
  room.timer = setTimeout(() => {
    if (!room.G) return;
    const L = Engine.legalActions(G, p);
    Engine.applyAction(G, p, { type: L.canCheck ? 'check' : 'fold' });
    afterMove(room);
  }, 45000);
}

function afterMove(room){
  const G = room.G;
  if (!G) return;
  if (G.board.length !== room.prevBoard){
    room.prevBoard = G.board.length;
    pushState(room, 'street');
    room.timer = setTimeout(() => drive(room), 2600);   // room for the reveal
    return;
  }
  drive(room);
}

/* =========================================================
   Message handling
   ========================================================= */

function attach(conn){
  const cid = ++cidSeq;
  const c = { cid, conn, name: 'Player', code: null };
  clients.set(cid, c);
  conn.send({ t: 'hello', cid });
  conn.send({ t: 'publicRooms', rooms: publicList() });

  conn.onClose = () => { leaveRoom(c); clients.delete(cid); };

  conn.onMessage = (m) => {
    try { handle(c, m); }
    catch (e) { console.error('message error', e); }
  };
}

function handle(c, m){
  const room = c.code ? rooms.get(c.code) : null;

  switch (m.t){
    case 'name':
      c.name = String(m.name || 'Player').slice(0, 12).trim() || 'Player';
      if (room){
        const s = room.seats.find(x => x.cid === c.cid);
        if (s) s.name = c.name;
        sendRoom(room);
      }
      return;

    case 'listRooms':
      c.conn.send({ t: 'publicRooms', rooms: publicList() });
      return;

    case 'joinPublic': {
      if (room) leaveRoom(c);
      let target = null;
      for (const r of rooms.values())
        if (r.isPublic && !r.started && r.seats.length < MAX_SEATS){ target = r; break; }
      if (!target) target = createRoom(true, c.cid);
      joinRoom(c, target);
      return;
    }

    case 'createRoom': {
      if (room) leaveRoom(c);
      const r = createRoom(!!m.isPublic, c.cid);
      joinRoom(c, r);
      return;
    }

    case 'joinCode': {
      const code = String(m.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const r = rooms.get(code);
      if (!r) return fail(c, 'No table with that code.');
      if (room) leaveRoom(c);
      joinRoom(c, r);
      return;
    }

    case 'leave':
      leaveRoom(c);
      c.conn.send({ t: 'left' });
      c.conn.send({ t: 'publicRooms', rooms: publicList() });
      return;
  }

  if (!room) return;
  const isHost = room.hostCid === c.cid;

  switch (m.t){
    case 'addBot':
      if (!isHost || room.started) return;
      if (room.seats.length >= MAX_SEATS) return;
      room.seats.push({ cid: null, name: botName(room), bot: true });
      sendRoom(room); broadcastPublicList();
      return;

    case 'removeSeat': {
      if (!isHost || room.started) return;
      const s = room.seats[m.i];
      if (!s || !s.bot) return;                    // only stand-ins can be removed
      room.seats.splice(m.i, 1);
      sendRoom(room); broadcastPublicList();
      return;
    }

    case 'config':
      if (!isHost || room.started) return;
      room.stack = Math.max(100, Math.min(1000000, parseInt(m.stack, 10) || 10000));
      room.speed = [4, 8, 15].indexOf(+m.speed) >= 0 ? +m.speed : 8;
      sendRoom(room);
      return;

    case 'start':
      if (!isHost || room.started) return;
      if (room.seats.length < 2) return fail(c, 'You need at least two seats.');
      startGame(room);
      return;

    case 'action': {
      if (!room.started || !room.G) return;
      const G = room.G;
      const ix = room.seats.findIndex(s => s.cid === c.cid);
      if (ix < 0 || G.toAct !== ix || G.phase !== 'betting') return;
      clearTimeout(room.timer);
      Engine.applyAction(G, G.players[ix], m.act || { type: 'fold' });
      afterMove(room);
      return;
    }
  }
}

const BOT_NAMES = ['Marisol','Ruiz','Okafor','Delgado','Vance','Ibarra','Nakamura','Whitlock'];
function botName(room){
  const taken = new Set(room.seats.map(s => s.name));
  for (const n of BOT_NAMES) if (!taken.has(n)) return n;
  return 'Bot ' + (room.seats.length + 1);
}

/* stale empty rooms shouldn't pile up */
setInterval(() => {
  for (const room of rooms.values())
    if (!humanSeats(room).length && Date.now() - room.created > 60000) destroyRoom(room);
}, 30000).unref?.();

/* =========================================================
   Boot
   ========================================================= */

function addresses(){
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs))
    for (const net of ifs[name])
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
  return out;
}

if (require.main === module){
  server.listen(PORT, () => {
    console.log('\n  PokerLandia is running\n');
    console.log('    On this machine:  http://localhost:' + PORT);
    for (const a of addresses())
      console.log('    On your network:  http://' + a + ':' + PORT);
    console.log('\n  Share a network address with friends on the same wifi,');
    console.log('  or deploy this folder anywhere that runs Node.\n');
  });
}

module.exports = { server, rooms, clients, Conn };
