// Сервер «Нулевого сектора»: раздаёт игру и ретранслирует игроков по WebSocket.
// Две комнаты: dm (все против всех) и ctf (захват флага, красные против синих).
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const num = v => { v = +v; return Number.isFinite(v) ? Math.max(-1000, Math.min(1000, v)) : 0 };

const HOME = [[0, -30], [0, 27]]; // флаг красных (0) и синих (1)
const mkRoom = ctf => ({
  clients: new Map(),
  ctf: ctf ? { fl: [{ x: HOME[0][0], z: HOME[0][1], by: null }, { x: HOME[1][0], z: HOME[1][1], by: null }], sc: [0, 0], resetAt: 0 } : null
});
const rooms = { dm: mkRoom(false), ctf: mkRoom(true) };

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?') || req.url === '/index.html') {
    const wsProto = (req.headers['x-forwarded-proto'] || 'http') === 'https' ? 'wss://' : 'ws://';
    const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
      .replace('window.ZS_WS=null', 'window.ZS_WS=' + JSON.stringify(wsProto + req.headers.host));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.url === '/health') {
    res.end('ok');
  } else {
    res.writeHead(404); res.end('Not found');
  }
});

const wss = new WebSocketServer({ server, maxPayload: 4096 });
const clients = new Map();
let nextId = 1;

wss.on('connection', ws => {
  const id = 'p' + (nextId++);
  const c = { ws, n: 'Игрок', p: {}, hits: 0, joined: false, room: null, team: 0 };
  clients.set(id, c);
  ws.send(JSON.stringify({ t: 'welcome', id }));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw) } catch (e) { return }
    if (m.t === 'join' && !c.joined) {
      c.n = String(m.n || 'Игрок').replace(/[^\wа-яА-ЯёЁ \-]/g, '').slice(0, 14) || 'Игрок';
      const room = m.m === 'ctf' ? rooms.ctf : rooms.dm;
      const cnt = [0, 0];
      for (const o of room.clients.values()) cnt[o.team]++;
      c.team = cnt[0] <= cnt[1] ? 0 : 1; // баланс команд
      c.room = room; room.clients.set(id, c); c.joined = true;
    } else if (m.t === 'p' && c.joined && m.d && typeof m.d === 'object') {
      const d = m.d;
      c.p = { n: c.n, x: num(d.x), z: num(d.z), y: num(d.y), ya: num(d.ya), hp: num(d.hp), k: num(d.k), d: num(d.d) };
    } else if (m.t === 'e' && c.joined && (m.topic === 'hit' || m.topic === 'kill') && m.data) {
      const target = m.topic === 'hit' ? m.data.to : m.data.by;
      const o = c.room.clients.get(target);
      if (!o || target === id || ++c.hits > 40) return;
      if (c.room.ctf && o.team === c.team) return; // нет урона по своим
      const data = m.topic === 'hit'
        ? { to: target, d: Math.max(0, Math.min(100, num(m.data.d))) }
        : { by: target };
      if (o.ws.readyState === 1) o.ws.send(JSON.stringify({ t: 'e', topic: m.topic, from: id, data }));
    }
  });
  ws.on('close', () => { clients.delete(id); if (c.room) c.room.clients.delete(id) });
  ws.on('error', () => {});
});

// Логика захвата флага: подбор вражеского флага, возврат на свою базу (свой флаг должен быть дома)
function ctfStep(room) {
  const g = room.ctf; if (!g) return;
  const now = Date.now();
  if (g.resetAt) { if (now < g.resetAt) return; g.sc = [0, 0]; g.resetAt = 0 }
  g.fl.forEach((f, i) => {
    if (f.by) {
      const c = room.clients.get(f.by);
      if (!c || c.p.hp <= 0) f.by = null; else { f.x = c.p.x; f.z = c.p.z }
    }
    if (!f.by) { f.x = HOME[i][0]; f.z = HOME[i][1] }
  });
  for (const [id, c] of room.clients) {
    if (c.p.x === undefined || c.p.hp <= 0) continue;
    const t = c.team, ef = g.fl[1 - t], own = g.fl[t];
    if (!ef.by && Math.hypot(c.p.x - ef.x, c.p.z - ef.z) < 2.4) ef.by = id;
    if (ef.by === id && !own.by && Math.hypot(c.p.x - HOME[t][0], c.p.z - HOME[t][1]) < 3) {
      ef.by = null; ef.x = HOME[1 - t][0]; ef.z = HOME[1 - t][1];
      g.sc[t]++;
      if (g.sc[t] >= 3) g.resetAt = now + 8000;
    }
  }
}

// Снимок комнат ~15 раз в секунду
setInterval(() => {
  for (const room of Object.values(rooms)) {
    ctfStep(room);
    const p = {};
    for (const [id, c] of room.clients) if (c.p.x !== undefined) p[id] = { ...c.p, tm: c.team };
    const g = room.ctf;
    const cf = g ? { sc: g.sc, fl: g.fl.map(f => ({ by: f.by, x: f.x, z: f.z })), over: g.resetAt ? (g.sc[0] >= 3 ? 0 : 1) : -1 } : undefined;
    for (const c of room.clients.values())
      if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ t: 's', p, ctf: cf, me: c.team }));
  }
}, 66);
setInterval(() => { for (const c of clients.values()) c.hits = 0 }, 1000);

server.listen(PORT, () => console.log('Zero Sector server on port ' + PORT));
