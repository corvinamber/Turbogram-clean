// Turbogram: сервер на Node.js 18+, данные хранятся в Supabase (Postgres).
// Нужны переменные окружения: SUPABASE_URL, SUPABASE_SERVICE_KEY (см. README).
// Необязательно: PORT, OWNER_NICK (ник владельца, который выпускает подарки).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { promisify } = require('util');
const { createClient } = require('@supabase/supabase-js');
const scrypt = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
// РЕЖИМ ПРЕДПРОСМОТРА (по умолчанию выключен): вход по одному нику без проверки пароля.
// Включается только вручную: PREVIEW_NO_PASSWORD=1. Сервер при этом слушает лишь localhost.
const PREVIEW = process.env.PREVIEW_NO_PASSWORD === '1';
const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Задайте SUPABASE_URL и SUPABASE_SERVICE_KEY (см. README).');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const WWW = path.join(__dirname, '..', 'app', 'www');

const run = async p => { const { data, error } = await p; if (error) throw error; return data; };
const rid = () => crypto.randomBytes(8).toString('hex');
const hashPw = async (pw, salt) => (await scrypt(pw, salt, 32)).toString('hex');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const clean = (s, n) => String(s == null ? '' : s).trim().slice(0, n);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fails = new Map();           // защита от подбора пароля (в памяти, это допустимо)
const sessCache = new Map();       // token -> { u, exp }

/* ---------- SSE: рассылка подключённым клиентам ---------- */
const clients = new Set();
const frame = (ev, data) => 'event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n';
function broadcast(ev, data) { const m = frame(ev, data); for (const c of clients) c.res.write(m); }
function toUsers(ev, data, ids) { const m = frame(ev, data); for (const c of clients) if (ids.includes(c.uid)) c.res.write(m); }

/* ---------- хранилище (Supabase) ---------- */
const MSG_COLS = 'id,uid,type,text,to_uid,emoji,gname,ts,reply_to,reply_uid,reply_text';
const DM_COLS = 'id,from_uid,to_uid,text,ts,reply_to,reply_uid,reply_text';
const rp = r => r.reply_to ? { id: r.reply_to, uid: r.reply_uid, text: r.reply_text } : undefined;
const outMsg = r => r.type === 'gift'
  ? { id: r.id, uid: r.uid, type: 'gift', to: r.to_uid, emoji: r.emoji, gname: r.gname, ts: r.ts, reply: rp(r) }
  : { id: r.id, uid: r.uid, type: 'text', text: r.text, ts: r.ts, reply: rp(r) };
const outDm = r => ({ id: r.id, from: r.from_uid, to: r.to_uid, text: r.text, ts: r.ts, reply: rp(r) });
// Цитата строится на сервере по исходному сообщению, клиенту не доверяем
const snip = (t, n = 100) => String(t || '').slice(0, n);
async function replyOfMsg(id) {
  const o = await run(sb.from('messages').select('id,uid,type,text,gname').eq('id', id).maybeSingle());
  return o ? { reply_to: o.id, reply_uid: o.uid, reply_text: o.type === 'gift' ? '🎁 ' + (o.gname || '') : snip(o.text) } : null;
}
async function replyOfDm(id, a, b) {
  const o = await run(sb.from('dms').select('id,from_uid,to_uid,text').eq('id', id).maybeSingle());
  const ok = o && ((o.from_uid === a && o.to_uid === b) || (o.from_uid === b && o.to_uid === a));
  return ok ? { reply_to: o.id, reply_uid: o.from_uid, reply_text: snip(o.text) } : null;
}
// Публичные данные профиля: сам аватар в списки не кладём (он отдаётся отдельным запросом /api/avatar/<id>)
const pubUser = r => ({ id: r.id, nick: r.nick, bio: r.bio || '', av: r.avatar_ts || 0 });
function okAvatar(a) {
  if (typeof a !== 'string' || a.length > 150000) return false;
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/.exec(a);
  if (!m) return false;
  const buf = Buffer.from(m[1], 'base64');
  return buf.length <= 100000 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;   // это действительно JPEG
}
const outRecv = r => ({ emoji: r.emoji, name: r.name, from: r.from_uid, ts: r.ts });

let ownerCache = null;
async function ownerId() {
  if (ownerCache) return ownerCache;
  const want = (process.env.OWNER_NICK || '').toLowerCase();
  let r = null;
  if (want) r = await run(sb.from('users').select('id').eq('nick_lower', want).maybeSingle());
  else r = (await run(sb.from('users').select('id').order('created_at', { ascending: true }).limit(1)))[0];
  if (r) ownerCache = r.id;
  return ownerCache;
}
async function newSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  await run(sb.from('sessions').insert({ token, user_id: userId }));
  return token;
}
async function userOf(token) {
  if (!token || typeof token !== 'string') return null;
  const c = sessCache.get(token);
  if (c && c.exp > Date.now()) return c.u;
  const s = await run(sb.from('sessions').select('user_id').eq('token', token).maybeSingle());
  if (!s) return null;
  const u = await run(sb.from('users').select('id,nick').eq('id', s.user_id).maybeSingle());
  if (u) sessCache.set(token, { u, exp: Date.now() + 60000 });
  return u;
}
async function initData(u) {
  const [owner, members, gifts, recv, msgs, dms] = await Promise.all([
    ownerId(),
    run(sb.from('users').select('id,nick,bio,avatar_ts').order('created_at', { ascending: true }).limit(5000)),
    run(sb.from('gifts').select('id,emoji,name,ts').order('ts', { ascending: true })),
    run(sb.from('received').select('user_id,emoji,name,from_uid,ts').order('ts', { ascending: true })),
    run(sb.from('messages').select(MSG_COLS).order('ts', { ascending: false }).limit(200)),
    run(sb.from('dms').select(DM_COLS).or('from_uid.eq.' + u.id + ',to_uid.eq.' + u.id).order('ts', { ascending: false }).limit(500))
  ]);
  const received = {};
  recv.forEach(r => (received[r.user_id] = received[r.user_id] || []).push(outRecv(r)));
  return {
    me: { id: u.id, nick: u.nick, owner: owner === u.id },
    members: members.map(pubUser), gifts, received,
    messages: msgs.reverse().map(outMsg),
    dms: dms.reverse().map(outDm)
  };
}

/* ---------- HTTP ---------- */
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function body(req, max = 20000) {
  return new Promise((ok, no) => {
    let s = '';
    const bad = () => { const e = new Error('bad'); e.bad = true; no(e); };
    req.on('data', c => { s += c; if (s.length > max) { bad(); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(); } });
  });
}

async function api(req, res, url) {
  const p = url.pathname;
  if (req.method === 'GET' && p === '/api/ping') return send(res, 200, { ok: true, preview: PREVIEW });
  if (req.method === 'GET' && p === '/api/me') {
    const u = await userOf(url.searchParams.get('token'));
    return u ? send(res, 200, u) : send(res, 401, { error: 'Нужно войти' });
  }
  if (req.method === 'GET' && p === '/api/events') {
    const u = await userOf(url.searchParams.get('token'));
    if (!u) return send(res, 401, { error: 'Нужно войти' });
    const init = await initData(u);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const c = { res, uid: u.id }; clients.add(c);
    const ka = setInterval(() => res.write(': ka\n\n'), 25000);
    req.on('close', () => { clearInterval(ka); clients.delete(c); });
    res.write(frame('init', init));
    return;
  }
  const am = /^\/api\/avatar\/([0-9a-f-]{36})$/i.exec(p);
  if (req.method === 'GET' && am) {
    const r = UUID.test(am[1]) ? await run(sb.from('users').select('avatar').eq('id', am[1]).maybeSingle()) : null;
    const mm = r && r.avatar && /^data:image\/jpeg;base64,(.+)$/.exec(r.avatar);
    if (!mm) { res.writeHead(404); return res.end(); }
    // адрес картинки содержит версию (?v=), поэтому её можно кэшировать надолго
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.end(Buffer.from(mm[1], 'base64'));
  }
  if (req.method === 'GET' && p === '/api/nick-free') {
    const u = await userOf(url.searchParams.get('token'));
    if (!u) return send(res, 401, { error: 'Нужно войти' });
    const nick = clean(url.searchParams.get('nick'), 40);
    if (!/^[A-Za-z0-9_]{3,20}$/.test(nick)) return send(res, 200, { free: false });
    const r = await run(sb.from('users').select('id').eq('nick_lower', nick.toLowerCase()).maybeSingle());
    return send(res, 200, { free: !r || r.id === u.id });
  }
  if (req.method !== 'POST') return send(res, 404, { error: 'Не найдено' });
  const b = await body(req, p === '/api/profile' ? 300000 : 20000);

  if (p === '/api/register') {
    const nick = clean(b.nick, 40), pw = String(b.password || ''), low = nick.toLowerCase();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(nick)) return send(res, 400, { error: 'Ник: 3–20 символов, латиница, цифры и _' });
    if (pw.length < 6 || pw.length > 100) return send(res, 400, { error: 'Пароль: от 6 символов' });
    const salt = rid();
    // уникальность ника гарантирует ограничение UNIQUE(nick_lower) в базе
    const { data: u, error } = await sb.from('users').insert({ nick, nick_lower: low, salt, hash: await hashPw(pw, salt) }).select('id,nick').single();
    if (error) {
      if (error.code === '23505') return send(res, 409, { error: 'Ник «' + nick + '» уже занят' });
      throw error;
    }
    const token = await newSession(u.id);
    broadcast('member', pubUser(u));
    return send(res, 200, { token, me: u });
  }
  if (p === '/api/login') {
    const low = clean(b.nick, 40).toLowerCase(), f = fails.get(low) || { n: 0, until: 0 };
    if (Date.now() < f.until) return send(res, 429, { error: 'Слишком много попыток, подождите минуту' });
    const u = await run(sb.from('users').select('id,nick,salt,hash').eq('nick_lower', low).maybeSingle());
    if (!u || (!PREVIEW && !same(await hashPw(String(b.password || ''), u.salt), u.hash))) {
      f.n++; if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } fails.set(low, f);
      return send(res, 401, { error: 'Неверный ник или пароль' });
    }
    fails.delete(low);
    return send(res, 200, { token: await newSession(u.id), me: { id: u.id, nick: u.nick } });
  }

  const u = await userOf(b.token);
  if (!u) return send(res, 401, { error: 'Нужно войти' });

  if (p === '/api/logout') {
    sessCache.delete(b.token);
    await run(sb.from('sessions').delete().eq('token', b.token));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/send') {
    const text = clean(b.text, 1000); if (!text) return send(res, 400, { error: 'Пустое сообщение' });
    let rep = {};
    if (b.reply != null) {
      if (!UUID.test(String(b.reply))) return send(res, 400, { error: 'Исходное сообщение удалено' });
      rep = await replyOfMsg(b.reply);
      if (!rep) return send(res, 400, { error: 'Исходное сообщение удалено' });
    }
    const r = await run(sb.from('messages').insert({ uid: u.id, type: 'text', text, ts: Date.now(), ...rep }).select(MSG_COLS).single());
    broadcast('msg', outMsg(r));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/dm') {
    const text = clean(b.text, 1000);
    if (!UUID.test(String(b.to)) || b.to === u.id) return send(res, 400, { error: 'Выберите другого пользователя' });
    if (!text) return send(res, 400, { error: 'Пустое сообщение' });
    const to = await run(sb.from('users').select('id').eq('id', b.to).maybeSingle());
    if (!to) return send(res, 400, { error: 'Пользователь не найден' });
    let rep = {};
    if (b.reply != null) {
      if (!UUID.test(String(b.reply))) return send(res, 400, { error: 'Исходное сообщение удалено' });
      rep = await replyOfDm(b.reply, u.id, to.id);
      if (!rep) return send(res, 400, { error: 'Исходное сообщение удалено' });
    }
    const r = await run(sb.from('dms').insert({ from_uid: u.id, to_uid: to.id, text, ts: Date.now(), ...rep }).select(DM_COLS).single());
    toUsers('dm', outDm(r), [u.id, to.id]);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/profile') {
    const upd = {};
    if (b.nick !== undefined) {
      const nick = clean(b.nick, 40);
      if (!/^[A-Za-z0-9_]{3,20}$/.test(nick)) return send(res, 400, { error: 'Ник: 3–20 символов, латиница, цифры и _' });
      if (nick !== u.nick) { upd.nick = nick; upd.nick_lower = nick.toLowerCase(); }
    }
    if (b.bio !== undefined) upd.bio = String(b.bio == null ? '' : b.bio).trim().slice(0, 200);
    if (b.avatar !== undefined) {
      if (b.avatar === null) { upd.avatar = null; upd.avatar_ts = 0; }
      else if (okAvatar(b.avatar)) { upd.avatar = b.avatar; upd.avatar_ts = Date.now(); }
      else return send(res, 400, { error: 'Некорректное изображение (нужен JPEG до 100 КБ)' });
    }
    if (!Object.keys(upd).length) return send(res, 200, { ok: true, me: pubUser(await run(sb.from('users').select('id,nick,bio,avatar_ts').eq('id', u.id).maybeSingle())) });
    // уникальность ника гарантирует UNIQUE(nick_lower) в базе, поэтому гонки невозможны
    const { data: r, error } = await sb.from('users').update(upd).eq('id', u.id).select('id,nick,bio,avatar_ts').single();
    if (error) {
      if (error.code === '23505') return send(res, 409, { error: 'Ник «' + upd.nick + '» уже занят' });
      throw error;
    }
    for (const [t, c] of sessCache) if (c.u.id === u.id) sessCache.delete(t);
    broadcast('profile', pubUser(r));
    return send(res, 200, { ok: true, me: pubUser(r) });
  }
  if (p === '/api/delete') {
    const dm = b.kind === 'dm';
    if (!dm && b.kind !== 'msg') return send(res, 400, { error: 'Некорректный запрос' });
    if (!UUID.test(String(b.id))) return send(res, 404, { error: 'Сообщение уже удалено' });
    const t = dm ? 'dms' : 'messages';
    const row = await run(sb.from(t).select(dm ? 'id,from_uid,to_uid' : 'id,uid').eq('id', b.id).maybeSingle());
    if (!row) return send(res, 404, { error: 'Сообщение уже удалено' });
    const author = dm ? row.from_uid : row.uid;
    // удалять может автор сообщения или владелец
    if (author !== u.id && (await ownerId()) !== u.id) return send(res, 403, { error: 'Можно удалять только свои сообщения' });
    await run(sb.from(t).delete().eq('id', b.id));
    const ev = { kind: dm ? 'dm' : 'msg', id: b.id };
    if (dm) toUsers('del', ev, [row.from_uid, row.to_uid]); else broadcast('del', ev);
    return send(res, 200, { ok: true });
  }

  if ((await ownerId()) !== u.id) return send(res, 403, { error: 'Только для владельца' });
  if (p === '/api/gifts') {
    const emoji = clean(b.emoji, 8), name = clean(b.name, 30);
    if (!emoji || !name) return send(res, 400, { error: 'Нужны эмодзи и название' });
    const g = await run(sb.from('gifts').insert({ emoji, name, ts: Date.now() }).select('id,emoji,name,ts').single());
    broadcast('gift', g);
    return send(res, 200, g);
  }
  if (p === '/api/gifts/delete') {
    if (!UUID.test(String(b.id))) return send(res, 400, { error: 'Нет такого подарка' });
    await run(sb.from('gifts').delete().eq('id', b.id));
    broadcast('giftdel', { id: b.id });
    return send(res, 200, { ok: true });
  }
  if (p === '/api/give') {
    if (!UUID.test(String(b.giftId)) || !UUID.test(String(b.to))) return send(res, 400, { error: 'Нет такого подарка или участника' });
    const g = await run(sb.from('gifts').select('id,emoji,name').eq('id', b.giftId).maybeSingle());
    const to = await run(sb.from('users').select('id').eq('id', b.to).maybeSingle());
    if (!g || !to) return send(res, 400, { error: 'Нет такого подарка или участника' });
    const ts = Date.now();
    await run(sb.from('received').insert({ user_id: to.id, emoji: g.emoji, name: g.name, from_uid: u.id, ts }));
    const m = await run(sb.from('messages').insert({ uid: u.id, type: 'gift', to_uid: to.id, emoji: g.emoji, gname: g.name, ts }).select(MSG_COLS).single());
    broadcast('received', { to: to.id, item: { emoji: g.emoji, name: g.name, from: u.id, ts } });
    broadcast('msg', outMsg(m));
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
    const f = path.normalize(path.join(WWW, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!f.startsWith(WWW) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (!e.bad) console.error(e);
    if (!res.headersSent) send(res, e.bad ? 400 : 500, { error: e.bad ? 'Некорректный запрос' : 'Ошибка сервера, попробуйте позже' });
  }
}).listen(PORT, ...(PREVIEW ? ['127.0.0.1'] : []), () => {
  console.log('Turbogram запущен: http://localhost:' + PORT);
  if (PREVIEW) console.warn('⚠ РЕЖИМ ПРЕДПРОСМОТРА: пароли НЕ проверяются, доступ только с этого компьютера. Не используйте на рабочем сервере!');
  // чистим сессии старше 90 дней
  sb.from('sessions').delete().lt('created_at', new Date(Date.now() - 90 * 864e5).toISOString())
    .then(() => {}, () => {});
});
