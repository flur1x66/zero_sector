// Сервер «Нулевого сектора»: раздаёт игру и ретранслирует игроков по WebSocket.
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000;
const num = v => { v = +v; return Number.isFinite(v) ? Math.max(-1000, Math.min(1000, v)) : 0 };

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
  const c = { ws, n: 'Игрок', p: {}, hits: 0, joined: false };
  clients.set(id, c);
  ws.send(JSON.stringify({ t: 'welcome', id }));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw) } catch (e) { return }
    if (m.t === 'join') {
      c.n = String(m.n || 'Игрок').replace(/[^\wа-яА-ЯёЁ \-]/g, '').slice(0, 14) || 'Игрок';
      c.joined = true;
    } else if (m.t === 'p' && m.d && typeof m.d === 'object') {
      const d = m.d;
      c.p = { n: c.n, x: num(d.x), z: num(d.z), y: num(d.y), ya: num(d.ya), hp: num(d.hp), k: num(d.k), d: num(d.d) };
    } else if (m.t === 'e' && (m.topic === 'hit' || m.topic === 'kill') && m.data) {
      const target = m.topic === 'hit' ? m.data.to : m.data.by;
      const o = clients.get(target);
      if (!o || target === id || ++c.hits > 40) return;
      const data = m.topic === 'hit'
        ? { to: target, d: Math.max(0, Math.min(100, num(m.data.d))) }
        : { by: target };
      if (o.ws.readyState === 1) o.ws.send(JSON.stringify({ t: 'e', topic: m.topic, from: id, data }));
    }
  });
  ws.on('close', () => clients.delete(id));
  ws.on('error', () => {});
});

// Снимок всех игроков ~15 раз в секунду
setInterval(() => {
  const p = {};
  for (const [id, c] of clients) if (c.joined && c.p.x !== undefined) p[id] = c.p;
  const s = JSON.stringify({ t: 's', p });
  for (const c of clients.values()) if (c.ws.readyState === 1) c.ws.send(s);
}, 66);
setInterval(() => { for (const c of clients.values()) c.hits = 0 }, 1000);

server.listen(PORT, () => console.log('Zero Sector server on port ' + PORT));
