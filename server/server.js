// Мессенджер: сервер без внешних зависимостей (нужен только Node.js 18+)
// Запуск: node server.js   (порт: PORT, файл данных: DATA_FILE, владелец: OWNER_NICK)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const WWW = path.join(__dirname, '..', 'app', 'www');

let D = { users: {}, nicks: {}, messages: [], dms: [], gifts: [], received: {}, sessions: {}, owner: null };
try { D = Object.assign(D, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) {}

let st = null;
function save() {
  clearTimeout(st);
  st = setTimeout(() => { const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(D)); fs.renameSync(t, FILE); }, 200);
}
const rid = () => crypto.randomBytes(8).toString('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fails = {};

const clients = new Set();
function broadcast(ev, data) {
  const m = 'event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of clients) c.res.write(m);
}
function toUsers(ev, data, ids) {
  const m = 'event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const c of clients) if (ids.includes(c.uid)) c.res.write(m);
}
const pub = u => ({ id: u.id, nick: u.nick });
const members = () => Object.values(D.users).map(pub);

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function body(req) {
  return new Promise((ok, no) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 20000) { no(new Error('big')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(e); } });
  });
}
function userOf(token) { const id = D.sessions[token]; return id && D.users[id] || null; }
function newSession(u) { const t = crypto.randomBytes(24).toString('hex'); D.sessions[t] = u.id; save(); return t; }
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);

async function api(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { ok: true });
  if (req.method === 'GET' && p === '/api/me') {
    const u = userOf(url.searchParams.get('token'));
    return u ? send(res, 200, { id: u.id, nick: u.nick }) : send(res, 401, { error: 'Нужно войти' });
  }
  if (req.method === 'GET' && p === '/api/events') {
    const u = userOf(url.searchParams.get('token'));
    if (!u) return send(res, 401, { error: 'Нужно войти' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const c = { res, uid: u.id }; clients.add(c);
    const ka = setInterval(() => res.write(': ka\n\n'), 25000);
    req.on('close', () => { clearInterval(ka); clients.delete(c); });
    res.write('event: init\ndata: ' + JSON.stringify({
      me: { id: u.id, nick: u.nick, owner: D.owner === u.id },
      members: members(), gifts: D.gifts, received: D.received, messages: D.messages.slice(-200),
      dms: D.dms.filter(m => m.from === u.id || m.to === u.id).slice(-500)
    }) + '\n\n');
    return;
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'Не найдено' });
  const b = await body(req);

  if (p === '/api/register') {
    const nick = clean(b.nick, 40), pw = String(b.password || ''), low = nick.toLowerCase();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(nick)) return send(res, 400, { error: 'Ник: 3–20 символов, латиница, цифры и _' });
    if (pw.length < 6 || pw.length > 100) return send(res, 400, { error: 'Пароль: от 6 символов' });
    if (D.nicks[low]) return send(res, 409, { error: 'Ник «' + nick + '» уже занят' });
    const u = { id: rid(), nick, salt: rid(), created: Date.now() };
    u.hash = hashPw(pw, u.salt);
    D.users[u.id] = u; D.nicks[low] = u.id;
    if (!D.owner || (process.env.OWNER_NICK && process.env.OWNER_NICK.toLowerCase() === low)) D.owner = u.id;
    const token = newSession(u); save();
    broadcast('member', pub(u));
    return send(res, 200, { token, me: { id: u.id, nick: u.nick } });
  }
  if (p === '/api/login') {
    const low = clean(b.nick, 40).toLowerCase(), f = fails[low] || { n: 0, until: 0 };
    if (Date.now() < f.until) return send(res, 429, { error: 'Слишком много попыток, подождите минуту' });
    const u = D.users[D.nicks[low]];
    if (!u || !same(hashPw(String(b.password || ''), u.salt), u.hash)) {
      f.n++; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } fails[low] = f;
      return send(res, 401, { error: 'Неверный ник или пароль' });
    }
    delete fails[low];
    return send(res, 200, { token: newSession(u), me: { id: u.id, nick: u.nick } });
  }

  const u = userOf(b.token);
  if (!u) return send(res, 401, { error: 'Нужно войти' });
  const owner = D.owner === u.id;

  if (p === '/api/logout') { delete D.sessions[b.token]; save(); return send(res, 200, { ok: true }); }
  if (p === '/api/send') {
    const text = clean(b.text, 1000); if (!text) return send(res, 400, { error: 'Пустое сообщение' });
    const m = { id: rid(), uid: u.id, type: 'text', text, ts: Date.now() };
    D.messages.push(m); if (D.messages.length > 5000) D.messages.shift(); save(); broadcast('msg', m);
    return send(res, 200, { ok: true });
  }
  if (p === '/api/dm') {
    const text = clean(b.text, 1000), to = D.users[b.to];
    if (!to || to.id === u.id) return send(res, 400, { error: 'Выберите другого пользователя' });
    if (!text) return send(res, 400, { error: 'Пустое сообщение' });
    const m = { id: rid(), from: u.id, to: to.id, text, ts: Date.now() };
    D.dms.push(m); if (D.dms.length > 20000) D.dms.shift(); save();
    toUsers('dm', m, [u.id, to.id]);
    return send(res, 200, { ok: true });
  }
  if (!owner) return send(res, 403, { error: 'Только для владельца' });
  if (p === '/api/gifts') {
    const emoji = clean(b.emoji, 8), name = clean(b.name, 30);
    if (!emoji || !name) return send(res, 400, { error: 'Нужны эмодзи и название' });
    const g = { id: rid(), emoji, name, ts: Date.now() }; D.gifts.push(g); save(); broadcast('gift', g);
    return send(res, 200, g);
  }
  if (p === '/api/gifts/delete') {
    D.gifts = D.gifts.filter(g => g.id !== b.id); save(); broadcast('giftdel', { id: b.id });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/give') {
    const g = D.gifts.find(x => x.id === b.giftId), to = D.users[b.to];
    if (!g || !to) return send(res, 400, { error: 'Нет такого подарка или участника' });
    const item = { emoji: g.emoji, name: g.name, from: u.id, ts: Date.now() };
    (D.received[to.id] = D.received[to.id] || []).push(item);
    const m = { id: rid(), uid: u.id, type: 'gift', to: to.id, emoji: g.emoji, gname: g.name, ts: Date.now() };
    D.messages.push(m); save();
    broadcast('received', { to: to.id, item }); broadcast('msg', m);
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Не найдено' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.js': 'text/javascript', '.png': 'image/png' };
http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let f = path.normalize(path.join(WWW, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(WWW) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { if (!res.headersSent) send(res, 400, { error: 'Некорректный запрос' }); }
}).listen(PORT, () => console.log('Сервер запущен: http://localhost:' + PORT));
