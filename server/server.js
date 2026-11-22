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

/* ---------- NFT-подарки: справочник оформления и шансы выпадения ---------- */
// Шансы указаны в процентах, в каждой группе их сумма равна 100. Сервер проверяет это при запуске.
const MODELS = [   // Модель: название, модификатор цвета эмодзи (CSS filter), значок, редкость
  { name: 'Классика',   rarity: 50, mod: '',                                                                                       badge: '' },
  { name: 'Золотая',    rarity: 25, mod: 'sepia(1) saturate(3) hue-rotate(-12deg) brightness(1.05)',                               badge: '✨' },
  { name: 'Неоновая',   rarity: 15, mod: 'hue-rotate(140deg) saturate(2.6) brightness(1.15) drop-shadow(0 0 8px #00e5ff)',        badge: '⚡' },
  { name: 'Алмазная',   rarity: 7,  mod: 'hue-rotate(185deg) saturate(1.7) brightness(1.3) contrast(1.1)',                         badge: '💎' },
  { name: 'Мифическая', rarity: 3,  mod: 'hue-rotate(275deg) saturate(2.4) brightness(1.1) drop-shadow(0 0 10px #c026d3)',        badge: '🔮' }
];
const BACKGROUNDS = [   // Фон карточки: название, CSS-градиент, редкость
  { name: 'Изумруд',           rarity: 30, gradient: 'linear-gradient(135deg,#0f9b6e,#46d39a)' },
  { name: 'Сапфир',            rarity: 25, gradient: 'linear-gradient(135deg,#1e4fd8,#5aa9ff)' },
  { name: 'Закат',             rarity: 20, gradient: 'linear-gradient(135deg,#ff6a3d,#ff3d81)' },
  { name: 'Космос',            rarity: 15, gradient: 'linear-gradient(135deg,#0a0a2a,#1b1464 45%,#6a3cc9)' },
  { name: 'Обсидиан',          rarity: 7,  gradient: 'linear-gradient(135deg,#0b0b0f,#2a2a35 60%,#4a4a5a)' },
  { name: 'Радужный градиент', rarity: 3,  gradient: 'linear-gradient(135deg,#ff5f6d,#ffc371 25%,#47e891 50%,#4facfe 75%,#a855f7)' }
];
const PATTERNS = [   // Узор поверх фона: название, символ-повторитель, редкость
  { name: 'Без узора', rarity: 35, symbol: '' },
  { name: 'Звёзды',    rarity: 25, symbol: '✦' },
  { name: 'Волны',     rarity: 18, symbol: '〰' },
  { name: 'Соты',      rarity: 12, symbol: '⬡' },
  { name: 'Кристаллы', rarity: 7,  symbol: '◆' },
  { name: 'Фракталы',  rarity: 3,  symbol: '❋' }
];
for (const [n, list] of [['MODELS', MODELS], ['BACKGROUNDS', BACKGROUNDS], ['PATTERNS', PATTERNS]]) {
  const sum = list.reduce((s, x) => s + x.rarity, 0);
  if (Math.abs(sum - 100) > 1e-9) { console.error('Сумма шансов в ' + n + ' должна быть 100, сейчас ' + sum); process.exit(1); }
}
// Взвешенный случайный выбор (криптостойкий генератор, точность до 0,01%)
function rollOne(list) {
  const total = list.reduce((s, x) => s + Math.round(x.rarity * 100), 0);
  let r = crypto.randomInt(0, total);
  for (const x of list) { r -= Math.round(x.rarity * 100); if (r < 0) return x; }
  return list[list.length - 1];
}
function rollTraits() {
  const m = rollOne(MODELS), b = rollOne(BACKGROUNDS), p = rollOne(PATTERNS);
  return {
    model_name: m.name, model_rarity: m.rarity, model_mod: m.mod, model_badge: m.badge,
    bg_name: b.name, bg_gradient: b.gradient, bg_rarity: b.rarity,
    pattern_name: p.name, pattern_rarity: p.rarity, pattern_symbol: p.symbol
  };
}

/* ---------- Маркет ---------- */
const MARKET_FEE_PCT = Math.min(50, Math.max(0, Number(process.env.MARKET_FEE_PCT ?? 5) || 0));   // комиссия с продажи, % (по умолчанию 5)
const MAX_PRICE = 100000000;
const CATALOG = { models: MODELS, backgrounds: BACKGROUNDS, patterns: PATTERNS, feePct: MARKET_FEE_PCT, maxPrice: MAX_PRICE };

/* ---------- Экономика: монеты ---------- */
const START_COINS = 50, DAILY_COINS = 50, DAILY_MS = 24 * 3600 * 1000;
const CHAT_COINS = 2, CHAT_COOLDOWN = 15000, CHAT_DAY_CAP = 100, MAX_COINS = 1000000000;
const dayKey = ts => new Date(ts).toISOString().slice(0, 10);   // день по UTC
// Все операции с монетами и тиражом идут по очереди (сервер работает в одном экземпляре)
let chain = Promise.resolve();
const locked = fn => { const r = chain.then(() => fn()); chain = r.then(() => {}, () => {}); return r; };

/* ---------- SSE: рассылка подключённым клиентам ---------- */
const clients = new Set();
const frame = (ev, data) => 'event: ' + ev + '\ndata: ' + JSON.stringify(data) + '\n\n';
function broadcast(ev, data) { const m = frame(ev, data); for (const c of clients) c.res.write(m); }
function toUsers(ev, data, ids) { const m = frame(ev, data); for (const c of clients) if (ids.includes(c.uid)) c.res.write(m); }

/* ---------- хранилище (Supabase) ---------- */
const MSG_COLS = 'id,uid,type,text,to_uid,emoji,gname,ts,reply_to,reply_uid,reply_text';
const DM_COLS = 'id,from_uid,to_uid,text,ts,reply_to,reply_uid,reply_text,kind,gift';
const GIFT_COLS = 'id,emoji,name,ts,price,supply,sold';
const RECV_COLS = 'id,user_id,gift_id,emoji,name,price,serial,supply,note,from_uid,ts,model_name,model_rarity,model_mod,model_badge,bg_name,bg_gradient,bg_rarity,pattern_name,pattern_rarity,pattern_symbol,is_listed,list_price,listed_at';
const rp = r => r.reply_to ? { id: r.reply_to, uid: r.reply_uid, text: r.reply_text } : undefined;
const outMsg = r => r.type === 'gift'
  ? { id: r.id, uid: r.uid, type: 'gift', to: r.to_uid, emoji: r.emoji, gname: r.gname, ts: r.ts, reply: rp(r) }
  : { id: r.id, uid: r.uid, type: 'text', text: r.text, ts: r.ts, reply: rp(r) };
const outDm = r => ({ id: r.id, from: r.from_uid, to: r.to_uid, text: r.text, ts: r.ts, reply: rp(r), kind: r.kind || 'text', gift: r.gift || undefined });
const outGift = g => ({ id: g.id, emoji: g.emoji, name: g.name, price: g.price | 0, supply: g.supply | 0, sold: g.sold | 0, ts: g.ts });
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
// Подарок игрока: владелец, номер из тиража, модель/фон/узор (у старых подарков их нет) и статус на Маркете
const outRecv = r => ({
  id: r.id, owner: r.user_id, emoji: r.emoji, name: r.name, from: r.from_uid, ts: r.ts,
  price: r.price | 0, serial: r.serial | 0, supply: r.supply | 0, note: r.note || '',
  model: r.model_name ? { name: r.model_name, rarity: Number(r.model_rarity), mod: r.model_mod || '', badge: r.model_badge || '' } : undefined,
  bg: r.bg_name ? { name: r.bg_name, gradient: r.bg_gradient || '', rarity: Number(r.bg_rarity) } : undefined,
  pattern: r.pattern_name ? { name: r.pattern_name, rarity: Number(r.pattern_rarity), symbol: r.pattern_symbol || '' } : undefined,
  listed: !!r.is_listed, listPrice: r.is_listed ? (r.list_price | 0) : 0
});

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
  const u = await run(sb.from('users').select('id,nick,is_banned').eq('id', s.user_id).maybeSingle());
  if (u) sessCache.set(token, { u, exp: Date.now() + 60000 });
  return u;
}
const ECO_COLS = 'id,nick,coins,last_daily,chat_last_ts,chat_day,chat_day_coins';
const getEco = id => run(sb.from('users').select(ECO_COLS).eq('id', id).maybeSingle());
// «Сравнить и поменять»: баланс меняется, только если он не изменился с момента чтения
async function casUser(id, oldCoins, patch) {
  const rows = await run(sb.from('users').update(patch).eq('id', id).eq('coins', oldCoins).select('coins'));
  return rows && rows.length ? rows[0] : null;
}
// Начислить/списать монеты по «сравнить и поменять» (до 4 попыток); возвращает { coins, lastDaily } или null
async function addCoins(id, delta) {
  for (let i = 0; i < 4; i++) {
    const r = await getEco(id); if (!r) return null;
    const coins = Math.max(0, Math.min(MAX_COINS, r.coins + delta));
    if (await casUser(id, r.coins, { coins })) return { coins, lastDaily: Number(r.last_daily) || 0 };
  }
  return null;
}
const itemOf = id => run(sb.from('received').select(RECV_COLS).eq('id', id).maybeSingle());
const itemCard = it => ({ item: it.id, emoji: it.emoji, name: it.name, serial: it.serial, supply: it.supply, model: it.model, bg: it.bg, pattern: it.pattern });
// Системное сообщение о сделке/передаче: одна запись в личной переписке двух участников, видят оба
async function tradeNote(fromId, toId, text, gift) {
  const dm = await run(sb.from('dms').insert({ from_uid: fromId, to_uid: toId, text, ts: Date.now(), kind: 'trade', gift }).select(DM_COLS).single());
  toUsers('dm', outDm(dm), [fromId, toId]);
}
const pushCoins = (id, coins, lastDaily) => toUsers('coins', { coins, lastDaily: Number(lastDaily) || 0 }, [id]);
// +2 монеты за сообщение: кулдаун 15 с и не более 100 монет в день
async function rewardChat(uid) {
  try {
    return await locked(async () => {
      const r = await getEco(uid); if (!r) return null;
      const now = Date.now(), day = dayKey(now);
      const dc = r.chat_day === day ? (r.chat_day_coins | 0) : 0;
      if (now - (Number(r.chat_last_ts) || 0) < CHAT_COOLDOWN) return null;
      if (dc + CHAT_COINS > CHAT_DAY_CAP) return null;
      const coins = Math.min(MAX_COINS, r.coins + CHAT_COINS);
      if (!(await casUser(uid, r.coins, { coins, chat_last_ts: now, chat_day: day, chat_day_coins: dc + CHAT_COINS }))) return null;
      pushCoins(uid, coins, r.last_daily);
      return { coins, earned: CHAT_COINS };
    });
  } catch (e) { console.error(e); return null; }   // сбой начисления не должен ломать отправку сообщения
}

/* ---------- Присутствие: онлайн / был(а) в сети ---------- */
// Небольшая пауза (5 с, меняется переменной PRESENCE_GRACE_MS), чтобы короткий обрыв связи не мигал статусом
const GRACE = Number(process.env.PRESENCE_GRACE_MS) || 5000;
const online = new Map(), offTimers = new Map();      // uid -> число подключений / таймер «ушёл в офлайн»
const isOnline = id => online.has(id) || offTimers.has(id);
function goOnline(uid) {
  const t = offTimers.get(uid);
  if (t) { clearTimeout(t); offTimers.delete(uid); }
  const n = online.get(uid) || 0; online.set(uid, n + 1);
  if (n === 0 && !t) broadcast('presence', { id: uid, on: true });
}
function goOffline(uid) {
  const n = (online.get(uid) || 1) - 1;
  if (n > 0) { online.set(uid, n); return; }
  online.delete(uid);
  offTimers.set(uid, setTimeout(async () => {
    offTimers.delete(uid);
    if (online.has(uid)) return;
    const ls = Date.now();
    broadcast('presence', { id: uid, on: false, ls });
    try { await run(sb.from('users').update({ last_seen: ls }).eq('id', uid)); } catch (e) { console.error(e); }
  }, GRACE));
}

/* ---------- Блокировки и бан ---------- */
const BANNED_MSG = 'Владелец ограничил вам отправку сообщений.';
const BLOCK_MSG = { me: 'Вы заблокировали этого пользователя. Разблокируйте его, чтобы писать.', them: 'Этот пользователь ограничил получение сообщений от вас.' };
// Возвращает 'me' (я заблокировал его), 'them' (он заблокировал меня) или null
async function blockState(a, b) {
  const mine = await run(sb.from('blocked_users').select('blocker_id').eq('blocker_id', a).eq('blocked_id', b).maybeSingle());
  if (mine) return 'me';
  const theirs = await run(sb.from('blocked_users').select('blocker_id').eq('blocker_id', b).eq('blocked_id', a).maybeSingle());
  return theirs ? 'them' : null;
}
const myBlocks = async id => (await run(sb.from('blocked_users').select('blocked_id').eq('blocker_id', id))).map(r => r.blocked_id);
const dropSess = id => { for (const [t, c] of sessCache) if (c.u.id === id) sessCache.delete(t); };
const typingAt = new Map();

async function initData(u) {
  const [owner, members, gifts, recv, msgs, dms, eco, blocked, listings] = await Promise.all([
    ownerId(),
    run(sb.from('users').select('id,nick,bio,avatar_ts,last_seen,is_banned').order('created_at', { ascending: true }).limit(5000)),
    run(sb.from('gifts').select(GIFT_COLS).order('ts', { ascending: true })),
    run(sb.from('received').select(RECV_COLS).order('ts', { ascending: false }).limit(5000)),
    run(sb.from('messages').select(MSG_COLS).order('ts', { ascending: false }).limit(200)),
    run(sb.from('dms').select(DM_COLS).or('from_uid.eq.' + u.id + ',to_uid.eq.' + u.id).order('ts', { ascending: false }).limit(500)),
    getEco(u.id),
    myBlocks(u.id),
    run(sb.from('received').select(RECV_COLS).eq('is_listed', true).order('listed_at', { ascending: false }).limit(300))
  ]);
  const received = {};
  recv.reverse().forEach(r => (received[r.user_id] = received[r.user_id] || []).push(outRecv(r)));
  return {
    me: { id: u.id, nick: u.nick, owner: owner === u.id, banned: !!u.is_banned, coins: eco ? eco.coins : 0, lastDaily: eco ? Number(eco.last_daily) || 0 : 0 },
    members: members.map(m => ({ ...pubUser(m), ls: Number(m.last_seen) || 0, on: isOnline(m.id) })), gifts: gifts.map(outGift), received,
    market: listings.map(outRecv), catalog: CATALOG,
    blocked, bans: owner === u.id ? members.filter(m => m.is_banned).map(m => m.id) : [],
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
    req.on('close', () => { clearInterval(ka); clients.delete(c); goOffline(u.id); });
    res.write(frame('init', init));
    goOnline(u.id);
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
  /* ----- Маркет: лоты на продажу (последние, по цене, по виду подарка) ----- */
  if (req.method === 'GET' && p === '/api/market') {
    const u = await userOf(url.searchParams.get('token'));
    if (!u) return send(res, 401, { error: 'Нужно войти' });
    const sort = url.searchParams.get('sort'), gift = url.searchParams.get('gift');
    const limit = Math.min(200, Math.max(1, Math.trunc(Number(url.searchParams.get('limit'))) || 100));
    let q = sb.from('received').select(RECV_COLS).eq('is_listed', true);
    if (gift && UUID.test(gift)) q = q.eq('gift_id', gift);
    q = sort === 'price_asc' ? q.order('list_price', { ascending: true })
      : sort === 'price_desc' ? q.order('list_price', { ascending: false })
      : q.order('listed_at', { ascending: false });
    return send(res, 200, { items: (await run(q.limit(limit))).map(outRecv) });
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
    const { data: u, error } = await sb.from('users').insert({ nick, nick_lower: low, salt, hash: await hashPw(pw, salt), coins: START_COINS }).select('id,nick').single();
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
    if (u.is_banned) return send(res, 403, { error: BANNED_MSG });
    const text = clean(b.text, 1000); if (!text) return send(res, 400, { error: 'Пустое сообщение' });
    let rep = {};
    if (b.reply != null) {
      if (!UUID.test(String(b.reply))) return send(res, 400, { error: 'Исходное сообщение удалено' });
      rep = await replyOfMsg(b.reply);
      if (!rep) return send(res, 400, { error: 'Исходное сообщение удалено' });
    }
    const r = await run(sb.from('messages').insert({ uid: u.id, type: 'text', text, ts: Date.now(), ...rep }).select(MSG_COLS).single());
    broadcast('msg', outMsg(r));
    return send(res, 200, { ok: true, ...(await rewardChat(u.id) || {}) });
  }
  if (p === '/api/dm') {
    if (u.is_banned) return send(res, 403, { error: BANNED_MSG });
    const text = clean(b.text, 1000);
    if (!UUID.test(String(b.to)) || b.to === u.id) return send(res, 400, { error: 'Выберите другого пользователя' });
    if (!text) return send(res, 400, { error: 'Пустое сообщение' });
    const to = await run(sb.from('users').select('id').eq('id', b.to).maybeSingle());
    if (!to) return send(res, 400, { error: 'Пользователь не найден' });
    const bs = await blockState(u.id, to.id);
    if (bs) return send(res, 403, { error: BLOCK_MSG[bs] });
    let rep = {};
    if (b.reply != null) {
      if (!UUID.test(String(b.reply))) return send(res, 400, { error: 'Исходное сообщение удалено' });
      rep = await replyOfDm(b.reply, u.id, to.id);
      if (!rep) return send(res, 400, { error: 'Исходное сообщение удалено' });
    }
    const r = await run(sb.from('dms').insert({ from_uid: u.id, to_uid: to.id, text, ts: Date.now(), ...rep }).select(DM_COLS).single());
    toUsers('dm', outDm(r), [u.id, to.id]);
    return send(res, 200, { ok: true, ...(await rewardChat(u.id) || {}) });
  }

  /* ----- «печатает…»: лёгкое событие только собеседнику ----- */
  if (p === '/api/typing') {
    if (u.is_banned || !UUID.test(String(b.to)) || b.to === u.id) return send(res, 200, { ok: true });
    const k = u.id + b.to, now = Date.now();
    if (now - (typingAt.get(k) || 0) < 1000) return send(res, 200, { ok: true });   // не чаще раза в секунду
    if (typingAt.size > 5000) typingAt.clear();
    typingAt.set(k, now);
    if (!(await blockState(u.id, b.to))) toUsers('typing', { from: u.id }, [b.to]);
    return send(res, 200, { ok: true });
  }

  /* ----- личный чёрный список ----- */
  if (p === '/api/block') {
    if (!UUID.test(String(b.id)) || b.id === u.id || typeof b.block !== 'boolean') return send(res, 400, { error: 'Некорректный запрос' });
    const t = await run(sb.from('users').select('id').eq('id', b.id).maybeSingle());
    if (!t) return send(res, 404, { error: 'Пользователь не найден' });
    if (b.block) {
      const ex = await run(sb.from('blocked_users').select('blocker_id').eq('blocker_id', u.id).eq('blocked_id', t.id).maybeSingle());
      if (!ex) {
        const { error } = await sb.from('blocked_users').insert({ blocker_id: u.id, blocked_id: t.id, created_at: Date.now() });
        if (error && error.code !== '23505') throw error;   // 23505: уже заблокирован (гонка), это нормально
      }
    } else {
      await run(sb.from('blocked_users').delete().eq('blocker_id', u.id).eq('blocked_id', t.id));
    }
    const list = await myBlocks(u.id);
    toUsers('blocks', { blocked: list }, [u.id]);   // обновит список на других устройствах; второй стороне ничего не отправляется
    return send(res, 200, { ok: true, blocked: list });
  }

  /* ----- ежедневный бонус ----- */
  if (p === '/api/daily') {
    return locked(async () => {
      const r = await getEco(u.id), now = Date.now(), last = Number(r.last_daily) || 0;
      if (now - last < DAILY_MS) return send(res, 429, { error: 'Бонус пока недоступен', lastDaily: last, coins: r.coins });
      const coins = Math.min(MAX_COINS, r.coins + DAILY_COINS);
      if (!(await casUser(u.id, r.coins, { coins, last_daily: now }))) return send(res, 409, { error: 'Попробуйте ещё раз' });
      pushCoins(u.id, coins, now);
      return send(res, 200, { ok: true, coins, lastDaily: now, gained: DAILY_COINS });
    });
  }

  /* ----- покупка и отправка подарка: карточка приходит в ЛС получателя ----- */
  if (p === '/api/buy') {
    if (u.is_banned) return send(res, 403, { error: BANNED_MSG });
    const isOwner = (await ownerId()) === u.id;
    return locked(async () => {
      if (!UUID.test(String(b.giftId)) || !UUID.test(String(b.to)) || b.to === u.id) return send(res, 400, { error: 'Выберите подарок и другого получателя' });
      const note = clean(b.note, 80);
      const g = await run(sb.from('gifts').select(GIFT_COLS).eq('id', b.giftId).maybeSingle());
      const to = await run(sb.from('users').select('id,nick').eq('id', b.to).maybeSingle());
      if (!g || !to) return send(res, 404, { error: 'Подарок или получатель не найден' });
      const bs = await blockState(u.id, to.id);
      if (bs) return send(res, 403, { error: BLOCK_MSG[bs] });
      const price = g.price | 0, supply = g.supply | 0, sold = g.sold | 0;
      if (supply > 0 && sold >= supply) return send(res, 409, { error: 'Подарок распродан' });
      const free = b.free === true && isOwner;          // бесплатно может дарить только владелец
      const me = await getEco(u.id), paid = !free && price > 0;
      if (paid && me.coins < price) return send(res, 402, { error: 'Не хватает монет: нужно ' + price + ', у вас ' + me.coins });
      const newCoins = paid ? me.coins - price : me.coins;
      // 1) списываем монеты
      if (paid && !(await casUser(u.id, me.coins, { coins: newCoins }))) return send(res, 409, { error: 'Баланс изменился, попробуйте ещё раз' });
      const refund = async () => { if (!paid) return; try { const c = await getEco(u.id); await casUser(u.id, c.coins, { coins: Math.min(MAX_COINS, c.coins + price) }); } catch (e) { console.error(e); } };
      // 2) занимаем следующий номер тиража (условное обновление защищает от гонок)
      const serial = sold + 1;
      let claimed;
      try { claimed = await run(sb.from('gifts').update({ sold: serial }).eq('id', g.id).eq('sold', sold).select(GIFT_COLS)); }
      catch (e) { await refund(); throw e; }
      if (!claimed.length) { await refund(); return send(res, 409, { error: 'Подарок только что купили, попробуйте ещё раз' }); }
      // 3) запись в профиль получателя и карточка в личные сообщения
      const ts = Date.now(); let rec = null, dm = null;
      try {
        // при покупке экземпляру выпадают случайные модель, фон и узор (по весам редкости)
        rec = await run(sb.from('received').insert({ user_id: to.id, gift_id: g.id, emoji: g.emoji, name: g.name, price, serial, supply: supply || null, note: note || null, from_uid: u.id, ts, ...rollTraits() }).select(RECV_COLS).single());
        const o = outRecv(rec);
        const card = { id: g.id, emoji: g.emoji, name: g.name, price, serial, supply, note, item: rec.id, model: o.model, bg: o.bg, pattern: o.pattern };
        dm = await run(sb.from('dms').insert({ from_uid: u.id, to_uid: to.id, text: '🎁 ' + g.name, ts, kind: 'gift', gift: card }).select(DM_COLS).single());
      } catch (e) {   // откат: вернуть монеты, номер и записи
        try { if (rec) await sb.from('received').delete().eq('id', rec.id); await sb.from('gifts').update({ sold }).eq('id', g.id).eq('sold', serial); } catch (e2) { console.error(e2); }
        await refund(); throw e;
      }
      toUsers('dm', outDm(dm), [u.id, to.id]);
      broadcast('received', { to: to.id, item: outRecv(rec) });
      broadcast('gift', outGift(claimed[0]));
      pushCoins(u.id, newCoins, me.last_daily);
      return send(res, 200, { ok: true, coins: newCoins, serial, supply });
    });
  }

  /* ----- Маркет: выставить подарок на продажу ----- */
  if (p === '/api/market/list') {
    if (u.is_banned) return send(res, 403, { error: BANNED_MSG });
    if (!UUID.test(String(b.itemId))) return send(res, 404, { error: 'Подарок не найден' });
    const price = Math.trunc(Number(b.price));
    if (!Number.isFinite(price) || price < 1 || price > MAX_PRICE) return send(res, 400, { error: 'Цена: целое число от 1 до ' + MAX_PRICE + ' монет' });
    return locked(async () => {
      const it = await itemOf(b.itemId);
      if (!it) return send(res, 404, { error: 'Подарок не найден' });
      if (it.user_id !== u.id) return send(res, 403, { error: 'Это не ваш подарок' });
      if (it.is_listed) return send(res, 409, { error: 'Подарок уже выставлен на продажу' });
      const rows = await run(sb.from('received').update({ is_listed: true, list_price: price, listed_at: Date.now() })
        .eq('id', it.id).eq('user_id', u.id).eq('is_listed', false).select(RECV_COLS));
      if (!rows.length) return send(res, 409, { error: 'Подарок уже выставлен на продажу' });
      const item = outRecv(rows[0]);
      broadcast('listing', { item });
      return send(res, 200, { ok: true, item });
    });
  }
  /* ----- Маркет: снять с продажи (в любой момент) ----- */
  if (p === '/api/market/unlist') {
    if (!UUID.test(String(b.itemId))) return send(res, 404, { error: 'Подарок не найден' });
    return locked(async () => {
      const it = await itemOf(b.itemId);
      if (!it) return send(res, 404, { error: 'Подарок не найден' });
      if (it.user_id !== u.id) return send(res, 403, { error: 'Это не ваш подарок' });
      if (!it.is_listed) return send(res, 409, { error: 'Подарок не выставлен на продажу' });
      const rows = await run(sb.from('received').update({ is_listed: false, list_price: null, listed_at: null })
        .eq('id', it.id).eq('user_id', u.id).eq('is_listed', true).select(RECV_COLS));
      if (!rows.length) return send(res, 409, { error: 'Лот уже недоступен' });
      const item = outRecv(rows[0]);
      broadcast('unlist', { item });
      return send(res, 200, { ok: true, item });
    });
  }
  /* ----- Маркет: купить лот за монеты ----- */
  if (p === '/api/market/buy') {
    if (u.is_banned) return send(res, 403, { error: BANNED_MSG });
    if (!UUID.test(String(b.itemId))) return send(res, 404, { error: 'Лот не найден' });
    return locked(async () => {
      const it = await itemOf(b.itemId);
      if (!it || !it.is_listed) return send(res, 409, { error: 'Лот уже недоступен: его купили или сняли с продажи' });
      if (it.user_id === u.id) return send(res, 400, { error: 'Нельзя купить свой лот' });
      const bs = await blockState(u.id, it.user_id);
      if (bs) return send(res, 403, { error: BLOCK_MSG[bs] });
      const seller = it.user_id, price = it.list_price | 0;
      const fee = Math.floor(price * MARKET_FEE_PCT / 100), payout = price - fee;
      const me = await getEco(u.id);
      if (me.coins < price) return send(res, 402, { error: 'Не хватает монет: нужно ' + price + ', у вас ' + me.coins });
      // 1) списываем монеты у покупателя
      const paid = await casUser(u.id, me.coins, { coins: me.coins - price });
      if (!paid) return send(res, 409, { error: 'Баланс изменился, попробуйте ещё раз' });
      const refund = async () => { try { await addCoins(u.id, price); } catch (e) { console.error(e); } };
      // 2) забираем лот: условное обновление срабатывает, только если он всё ещё продаётся этому продавцу по этой цене
      let claimed;
      try {
        claimed = await run(sb.from('received').update({ user_id: u.id, is_listed: false, list_price: null, listed_at: null })
          .eq('id', it.id).eq('user_id', seller).eq('is_listed', true).eq('list_price', price).select(RECV_COLS));
      } catch (e) { await refund(); throw e; }
      if (!claimed.length) { await refund(); return send(res, 409, { error: 'Лот уже недоступен: его купили или сняли с продажи' }); }
      // 3) зачисляем деньги продавцу (за вычетом комиссии)
      const credited = await addCoins(seller, payout);
      if (!credited) {   // откат: вернуть подарок продавцу и деньги покупателю
        try { await run(sb.from('received').update({ user_id: seller, is_listed: true, list_price: price, listed_at: it.listed_at }).eq('id', it.id).eq('user_id', u.id)); } catch (e) { console.error(e); }
        await refund();
        return send(res, 409, { error: 'Не удалось завершить сделку, попробуйте ещё раз' });
      }
      // 4) история и уведомления в ЛС; сделка уже завершена, поэтому сбой здесь только пишем в журнал
      const item = outRecv(claimed[0]);
      try { await run(sb.from('market_sales').insert({ item_id: it.id, seller_id: seller, buyer_id: u.id, price, fee, ts: Date.now() })); } catch (e) { console.error(e); }
      try {
        await tradeNote(u.id, seller, '🛒 Сделка: «' + it.name + '»' + (it.serial ? ' #' + it.serial : '') + ' за ' + price + ' 🪙',
          { type: 'sale', ...itemCard(item), price, fee, payout, seller, buyer: u.id });
      } catch (e) { console.error(e); }
      broadcast('sold', { item, from: seller, to: u.id, price, fee });
      pushCoins(u.id, paid.coins, me.last_daily);
      pushCoins(seller, credited.coins, credited.lastDaily);
      return send(res, 200, { ok: true, coins: paid.coins, item });
    });
  }
  /* ----- Передать подарок другому игроку (нельзя, пока он стоит на продаже) ----- */
  if (p === '/api/nft/transfer') {
    if (u.is_banned) return send(res, 403, { error: BANNED_MSG });
    if (!UUID.test(String(b.itemId))) return send(res, 404, { error: 'Подарок не найден' });
    if (!UUID.test(String(b.to)) || b.to === u.id) return send(res, 400, { error: 'Выберите другого получателя' });
    return locked(async () => {
      const it = await itemOf(b.itemId);
      if (!it) return send(res, 404, { error: 'Подарок не найден' });
      if (it.user_id !== u.id) return send(res, 403, { error: 'Это не ваш подарок' });
      if (it.is_listed) return send(res, 409, { error: 'Подарок стоит на продаже: сначала снимите его с продажи' });
      const to = await run(sb.from('users').select('id,nick').eq('id', b.to).maybeSingle());
      if (!to) return send(res, 404, { error: 'Получатель не найден' });
      const bs = await blockState(u.id, to.id);
      if (bs) return send(res, 403, { error: BLOCK_MSG[bs] });
      const rows = await run(sb.from('received').update({ user_id: to.id }).eq('id', it.id).eq('user_id', u.id).eq('is_listed', false).select(RECV_COLS));
      if (!rows.length) return send(res, 409, { error: 'Подарок уже недоступен для передачи' });
      const item = outRecv(rows[0]);
      try { await tradeNote(u.id, to.id, '🎁 Передача: «' + it.name + '»' + (it.serial ? ' #' + it.serial : ''), { type: 'transfer', ...itemCard(item), from: u.id, to: to.id }); } catch (e) { console.error(e); }
      broadcast('transfer', { item, from: u.id, to: to.id });
      return send(res, 200, { ok: true, item });
    });
  }
  /* ----- Улучшить старый подарок: бросить модель, фон и узор (только если их ещё нет) ----- */
  if (p === '/api/nft/roll') {
    if (!UUID.test(String(b.itemId))) return send(res, 404, { error: 'Подарок не найден' });
    return locked(async () => {
      const it = await itemOf(b.itemId);
      if (!it) return send(res, 404, { error: 'Подарок не найден' });
      if (it.user_id !== u.id) return send(res, 403, { error: 'Это не ваш подарок' });
      if (it.model_name) return send(res, 409, { error: 'У этого подарка уже есть модель и фон' });
      if (it.is_listed) return send(res, 409, { error: 'Подарок стоит на продаже: сначала снимите его с продажи' });
      const rows = await run(sb.from('received').update(rollTraits()).eq('id', it.id).eq('user_id', u.id).eq('is_listed', false).is('model_name', null).select(RECV_COLS));
      if (!rows.length) return send(res, 409, { error: 'У этого подарка уже есть модель и фон' });
      const item = outRecv(rows[0]);
      broadcast('rolled', { item });
      return send(res, 200, { ok: true, item });
    });
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
    dropSess(u.id);
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
  /* ----- бан от владельца: нельзя писать в общий чат, в ЛС и дарить подарки ----- */
  if (p === '/api/ban') {
    if (!UUID.test(String(b.id)) || b.id === u.id || typeof b.ban !== 'boolean') return send(res, 400, { error: 'Нельзя забанить себя' });
    const t = await run(sb.from('users').select('id,nick').eq('id', b.id).maybeSingle());
    if (!t) return send(res, 404, { error: 'Пользователь не найден' });
    await run(sb.from('users').update({ is_banned: b.ban }).eq('id', t.id));
    dropSess(t.id);   // чтобы запрет подействовал сразу, а не через минуту
    toUsers('ban', { banned: b.ban }, [t.id]);
    toUsers('bans', { id: t.id, banned: b.ban }, [u.id]);
    return send(res, 200, { ok: true, id: t.id, nick: t.nick, banned: b.ban });
  }
  const num = (v, max) => { const n = Math.trunc(Number(v === '' || v == null ? 0 : v)); return Number.isFinite(n) && n >= 0 && n <= max ? n : null; };
  if (p === '/api/gifts') {
    const emoji = clean(b.emoji, 8), name = clean(b.name, 30), price = num(b.price, 1000000), supply = num(b.supply, 1000000);
    if (!emoji || !name) return send(res, 400, { error: 'Нужны эмодзи и название' });
    if (price === null) return send(res, 400, { error: 'Цена: целое число от 0 до 1 000 000' });
    if (supply === null) return send(res, 400, { error: 'Лимит выпуска: целое число (0 или пусто — без лимита)' });
    const g = await run(sb.from('gifts').insert({ emoji, name, price, supply: supply || null, sold: 0, ts: Date.now() }).select(GIFT_COLS).single());
    broadcast('gift', outGift(g));
    return send(res, 200, outGift(g));
  }
  if (p === '/api/gifts/update') {
    if (!UUID.test(String(b.id))) return send(res, 400, { error: 'Нет такого подарка' });
    const cur = await run(sb.from('gifts').select(GIFT_COLS).eq('id', b.id).maybeSingle());
    if (!cur) return send(res, 404, { error: 'Подарок не найден' });
    const upd = {};
    if (b.emoji !== undefined) { const v = clean(b.emoji, 8); if (!v) return send(res, 400, { error: 'Нужен эмодзи' }); upd.emoji = v; }
    if (b.name !== undefined) { const v = clean(b.name, 30); if (!v) return send(res, 400, { error: 'Нужно название' }); upd.name = v; }
    if (b.price !== undefined) { const v = num(b.price, 1000000); if (v === null) return send(res, 400, { error: 'Цена: целое число от 0 до 1 000 000' }); upd.price = v; }
    if (b.supply !== undefined) {
      const v = num(b.supply, 1000000);
      if (v === null) return send(res, 400, { error: 'Лимит выпуска: целое число (0 или пусто — без лимита)' });
      if (v > 0 && v < (cur.sold | 0)) return send(res, 400, { error: 'Тираж не может быть меньше уже проданного (' + (cur.sold | 0) + ')' });
      upd.supply = v || null;
    }
    if (!Object.keys(upd).length) return send(res, 200, outGift(cur));
    // уже отправленные подарки хранят свою копию данных и не меняются
    const g = await run(sb.from('gifts').update(upd).eq('id', cur.id).select(GIFT_COLS).single());
    broadcast('gift', outGift(g));
    return send(res, 200, outGift(g));
  }
  if (p === '/api/gifts/delete') {
    if (!UUID.test(String(b.id))) return send(res, 400, { error: 'Нет такого подарка' });
    await run(sb.from('gifts').delete().eq('id', b.id));   // подарки, уже полученные пользователями, остаются в их профилях
    broadcast('giftdel', { id: b.id });
    return send(res, 200, { ok: true });
  }
  /* ----- баланс монет: выдать или списать по нику ----- */
  if (p === '/api/coins') {
    return locked(async () => {
      const amount = Math.trunc(Number(b.amount));
      if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000000) return send(res, 400, { error: 'Укажите количество монет от 1 до 1 000 000' });
      const t = await run(sb.from('users').select('id,nick').eq('nick_lower', clean(b.nick, 40).toLowerCase()).maybeSingle());
      if (!t) return send(res, 404, { error: 'Пользователь с таким ником не найден' });
      const r = await getEco(t.id), coins = Math.max(0, Math.min(MAX_COINS, r.coins + amount));
      if (!(await casUser(t.id, r.coins, { coins }))) return send(res, 409, { error: 'Баланс изменился, попробуйте ещё раз' });
      pushCoins(t.id, coins, r.last_daily);
      return send(res, 200, { ok: true, nick: t.nick, coins, applied: coins - r.coins });
    });
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
