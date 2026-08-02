// ─── YaYa Chicken · Backend (Railway) ────────────────────────────────
// Общая база для системы учёта (Менеджер/Кухня/Цех/Закупщик/Сборщик)
// и заказов витрины. Стек: Node + Express + Postgres.
//
// Роли (токены в таблице access_keys, выдаёт менеджер):
//   MANAGER(мастер, всё+опасное), SUPERVISOR(зал), ASSEMBLER(сборщик),
//   WORKSHOP, KITCHEN, BUYER, COURIER(есть).
// Токен приходит в заголовке X-Token (или X-Admin-Token / ?token).
// Env-токены ADMIN_TOKEN / MANAGER_TOKEN / COURIER_TOKEN валидны всегда
// (нельзя залочиться) и используются как бутстрап access_keys.
//
// ВИДЕОМАГАЗИН (витрина) НЕ ЛОМАЕМ:
//   POST /order, GET /orders/status, GET /next-order-num,
//   GET/PUT /kv/* (публичные ключи), /push/* — работают как раньше.

const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const webpush = require('web-push');
const { DEFAULT_STOCK, DEFAULT_WS_STOCK, DEFAULT_WS_RECIPES, DEFAULT_TECH_CARDS } = require('./seed');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
       ? { rejectUnauthorized: false } : false,
  max: 12,
});

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// ── Web Push (VAPID) ─────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || '';
let   VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
if (!/^(mailto:|https?:)/i.test(VAPID_SUBJECT)) {
  VAPID_SUBJECT = 'mailto:' + String(VAPID_SUBJECT).replace(/^mailto:/i, '').trim();
}
let PUSH_ON = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try { webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE); PUSH_ON = true; }
  catch (e) { console.error('VAPID init error:', e); PUSH_ON = false; }
}

async function loadSubs() {
  try {
    const r = await pool.query('SELECT v FROM kv WHERE k=$1', ['yaya_push_subs']);
    if (r.rows.length && r.rows[0].v && typeof r.rows[0].v === 'object') return r.rows[0].v;
  } catch (e) {}
  return { admin: [], couriers: {}, orders: {} };
}
async function saveSubs(s) {
  try {
    await pool.query(
      `INSERT INTO kv (k, v, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (k) DO UPDATE SET v = $2::jsonb, updated_at = now()`,
      ['yaya_push_subs', JSON.stringify(s)]);
  } catch (e) {}
}
function dedupeSubs(arr) {
  const seen = new Set();
  return (arr || []).filter(s => s && s.endpoint && !seen.has(s.endpoint) && seen.add(s.endpoint));
}
async function sendPush(subs, payload) {
  if (!PUSH_ON || !Array.isArray(subs) || !subs.length) return;
  await Promise.all(subs.map(sub =>
    webpush.sendNotification(sub, JSON.stringify(payload)).catch(() => {})
  ));
}
const DST_PUSH = { on_way: 'Курьер в пути', delivered: 'Заказ доставлен' };
async function notifyDeliveryChanges(prev, next) {
  try {
    prev = prev || {}; next = next || {};
    const changed = [];
    for (const id in next) {
      const nd = next[id] && next[id].delivery_status;
      const od = prev[id] && prev[id].delivery_status;
      if (nd && nd !== od && DST_PUSH[nd]) changed.push({ id, ds: nd });
    }
    if (!changed.length) return;
    const store = await loadSubs();
    for (const ch of changed) {
      try {
        const q = await pool.query('SELECT num FROM orders WHERE id=$1', [ch.id]);
        const num = q.rows[0] && q.rows[0].num;
        if (!num) continue;
        sendPush((store.orders || {})[String(num)], {
          title: 'Заказ #' + num, body: DST_PUSH[ch.ds], tag: 'order-' + num, url: './'
        });
      } catch (e) {}
    }
  } catch (e) {}
}

function envAny(names) {
  const want = names.map(n => n.toLowerCase());
  for (const k of Object.keys(process.env)) {
    if (want.includes(k.toLowerCase())) {
      const v = String(process.env[k] || '').trim();
      if (v) return v;
    }
  }
  return '';
}
const ADMIN_TOKEN  = envAny(['ADMIN_TOKEN', 'admin_token']);
const MANAGER_TOKEN = envAny(['MANAGER_TOKEN', 'manager_token']);
const COURIER_TOKEN = envAny(['COURIER_TOKEN', 'courier_token', 'COURIER_KEY', 'courier_key']);
const AUTH_ON = (ADMIN_TOKEN || MANAGER_TOKEN).length > 0;

const COURIER_KV = new Set(['yaya_order_couriers', 'yaya_courier_pos', 'yaya_couriers']);

// ── Роли ─────────────────────────────────────────────────────────────
const ALL_ROLES = ['MANAGER', 'SUPERVISOR', 'ASSEMBLER', 'WORKSHOP', 'KITCHEN', 'BUYER', 'COURIER'];
// env-бутстрап ключей ролей (валидны и так; сюда попадают в access_keys)
const ROLE_ENV = {
  MANAGER:   envAny(['MANAGER_TOKEN', 'ADMIN_TOKEN', 'YA_MANAGER_TOKEN']),
  SUPERVISOR: envAny(['SUPERVISOR_TOKEN', 'YA_SUPERVISOR_TOKEN']),
  ASSEMBLER: envAny(['ASSEMBLER_TOKEN', 'YA_ASSEMBLER_TOKEN']),
  WORKSHOP:  envAny(['WORKSHOP_TOKEN', 'YA_WORKSHOP_TOKEN']),
  KITCHEN:   envAny(['KITCHEN_TOKEN', 'YA_KITCHEN_TOKEN']),
  BUYER:     envAny(['BUYER_TOKEN', 'YA_BUYER_TOKEN']),
  COURIER:   envAny(['COURIER_TOKEN', 'YA_COURIER_TOKEN']),
};

function tokenOf(req) {
  return req.get('X-Token') || req.get('X-Admin-Token') || req.query.token || '';
}

async function roleOf(req) {
  const t = tokenOf(req);
  if (!t) return null;
  if (ADMIN_TOKEN && t === ADMIN_TOKEN) return 'MANAGER';
  if (MANAGER_TOKEN && t === MANAGER_TOKEN) return 'MANAGER';
  if (COURIER_TOKEN && t === COURIER_TOKEN) return 'COURIER';
  try {
    const { rows } = await pool.query('SELECT role FROM access_keys WHERE token=$1', [t]);
    return rows.length ? rows[0].role : null;
  } catch (e) { return null; }
}

async function isManager(req) { return (await roleOf(req)) === 'MANAGER'; }

function requireRole(...roles) {
  return async (req, res, next) => {
    try {
      const role = await roleOf(req);
      if (!role) return res.status(401).json({ ok: false, error: 'Нужен ключ' });
      if (!roles.includes(role)) return res.status(403).json({ ok: false, error: 'Доступ запрещён для роли ' + role });
      req.role = role;
      next();
    } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
  };
}
// Любая авторизованная роль (для чтения общих данных кабинетов)
function requireAnyRole(req, res, next) {
  requireRole(...ALL_ROLES)(req, res, next);
}

// ── Ограничение частоты ──────────────────────────────────────────────
const hits = new Map();
function limit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = (req.ip || 'x') + '|' + req.path;
    const rec = hits.get(key);
    if (!rec || now > rec.until) hits.set(key, { n: 1, until: now + windowMs });
    else if (++rec.n > max) return res.status(429).json({ ok: false, error: 'Слишком часто' });
    if (hits.size > 5000) for (const [k, v] of hits) if (now > v.until) hits.delete(k);
    next();
  };
}

// ── CORS ─────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Token,X-Token,X-Courier-Name');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── KV helpers ───────────────────────────────────────────────────────
async function kvGet(key, client) {
  const c = client || pool;
  const r = await c.query('SELECT v FROM kv WHERE k=$1', [key]);
  return r.rows.length ? r.rows[0].v : null;
}
async function kvSet(key, val, client) {
  const c = client || pool;
  await c.query(
    `INSERT INTO kv (k, v, updated_at) VALUES ($1, $2::jsonb, now())
     ON CONFLICT (k) DO UPDATE SET v=$2::jsonb, updated_at=now()`,
    [key, JSON.stringify(val)]);
}

// ── Инициализация схемы + сид ────────────────────────────────────────
async function seedIfEmpty(client) {
  const s = (await client.query('SELECT count(*)::int AS n FROM stock')).rows[0].n;
  if (!s && DEFAULT_STOCK.length) {
    for (const i of DEFAULT_STOCK) {
      await client.query(
        `INSERT INTO stock (id,name,qty,unit,min,max,location) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO NOTHING`,
        [i.id, i.name, i.qty, i.unit, i.min, i.max || null, i.location || 'kitchen']);
    }
  }
  const pf = (await client.query('SELECT count(*)::int AS n FROM pf_stock')).rows[0].n;
  if (!pf && DEFAULT_WS_STOCK.length) {
    for (const i of DEFAULT_WS_STOCK) {
      await client.query(
        `INSERT INTO pf_stock (id,name,qty,unit,min) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO NOTHING`,
        [i.id, i.name, i.qty, i.unit, i.min || 0]);
    }
  }
  if ((await kvGet('yaya_tech_v3', client)) == null) {
    await kvSet('yaya_tech_v3', DEFAULT_TECH_CARDS, client);
  }
  if ((await kvGet('yaya_wsrecipes_v3', client)) == null) {
    await kvSet('yaya_wsrecipes_v3', DEFAULT_WS_RECIPES, client);
  }
  if ((await kvGet('yaya_settings', client)) == null) {
    await kvSet('yaya_settings', { cook_minutes: 15, fulfill_minutes: 90 }, client);
  }
  // бутстрап ключей ролей из env
  for (const role of ALL_ROLES) {
    const tok = ROLE_ENV[role];
    if (!tok) continue;
    await client.query(
      `INSERT INTO access_keys (role, token) VALUES ($1, $2)
       ON CONFLICT (role) DO NOTHING`, [role, tok]);
  }
}

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS kv (
        k          TEXT PRIMARY KEY,
        v          JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE SEQUENCE IF NOT EXISTS order_num_seq START 1;
      CREATE TABLE IF NOT EXISTS orders (
        id         BIGSERIAL PRIMARY KEY,
        num        BIGINT,
        status     TEXT NOT NULL DEFAULT 'new',
        data       JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_num     ON orders(num);

      CREATE TABLE IF NOT EXISTS stock (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        qty        NUMERIC NOT NULL DEFAULT 0,
        unit       TEXT NOT NULL DEFAULT 'шт.',
        min        NUMERIC NOT NULL DEFAULT 0,
        max        NUMERIC,
        location   TEXT NOT NULL DEFAULT 'kitchen',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS pf_stock (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        qty        NUMERIC NOT NULL DEFAULT 0,
        unit       TEXT NOT NULL DEFAULT 'шт.',
        min        NUMERIC NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS deductions (
        id     BIGSERIAL PRIMARY KEY,
        ts     TIMESTAMPTZ NOT NULL DEFAULT now(),
        ing    TEXT,
        qty    TEXT,
        unit   TEXT,
        reason TEXT,
        emp    TEXT
      );
      CREATE TABLE IF NOT EXISTS transfers (
        id        BIGSERIAL PRIMARY KEY,
        ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
        dir       TEXT,
        from_name TEXT,
        to_name   TEXT,
        qty       NUMERIC,
        unit      TEXT,
        emp       TEXT
      );
      CREATE TABLE IF NOT EXISTS cook_log (
        id       BIGSERIAL PRIMARY KEY,
        ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
        dish_id  TEXT,
        name     TEXT,
        emoji    TEXT,
        qty      INT,
        spent_kg NUMERIC
      );
      CREATE TABLE IF NOT EXISTS production_log (
        id       BIGSERIAL PRIMARY KEY,
        ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
        name     TEXT,
        batches  INT,
        qty      NUMERIC,
        unit     TEXT,
        spent_kg NUMERIC
      );
      CREATE TABLE IF NOT EXISTS purchases (
        id         BIGSERIAL PRIMARY KEY,
        ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
        ing_id     TEXT,
        ing        TEXT,
        location   TEXT,
        qty        NUMERIC,
        unit       TEXT,
        price      NUMERIC,
        total      NUMERIC,
        supplier   TEXT,
        note       TEXT,
        created_by TEXT
      );
      CREATE TABLE IF NOT EXISTS purchase_media (
        id          BIGSERIAL PRIMARY KEY,
        purchase_id BIGINT REFERENCES purchases(id) ON DELETE CASCADE,
        kind        TEXT,
        url         TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS access_keys (
        role       TEXT PRIMARY KEY,
        token      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS deducted    BOOLEAN DEFAULT false;
      ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilled   TEXT;
      CREATE INDEX IF NOT EXISTS idx_stock_loc     ON stock(location);
      CREATE INDEX IF NOT EXISTS idx_ded_ts        ON deductions(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_transfers_ts  ON transfers(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_cooklog_ts    ON cook_log(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_prodlog_ts    ON production_log(ts DESC);
      CREATE INDEX IF NOT EXISTS idx_purch_ts      ON purchases(ts DESC);
    `);
    await seedIfEmpty(client);
    client.release();
  } catch (e) {
    client.release();
    throw e;
  }
}

const revOf = (ts) => new Date(ts).getTime();
const rowToNum = (n) => Number(n);

// ── Проверка ключа (вход кабинетов) ──────────────────────────────────
app.get('/auth-check', limit(20, 60000), async (req, res) => {
  const t = tokenOf(req);
  if (ADMIN_TOKEN && t === ADMIN_TOKEN)   return res.json({ ok: true, role: 'admin', auth: AUTH_ON });
  if (MANAGER_TOKEN && t === MANAGER_TOKEN) return res.json({ ok: true, role: 'MANAGER', auth: AUTH_ON });
  if (COURIER_TOKEN && t === COURIER_TOKEN) return res.json({ ok: true, role: 'courier', auth: AUTH_ON, courier: true });
  const role = await roleOf(req);
  if (role) return res.json({ ok: true, role, auth: AUTH_ON });
  res.json({ ok: false, auth: AUTH_ON, courier: COURIER_TOKEN.length > 0 });
});

// ── KEY-VALUE (совместимость с кабинетами/витриной) ──────────────────
const PUBLIC_READ = new Set([
  'yaya_radio', 'yaya_tv', 'yaya_menu', 'yaya_stock',
  'yaya_banners', 'yaya_promos',
  'yaya_courier_pos',
  'yaya_greetings', 'yaya_greet',
]);
const PUBLIC_APPEND = new Set(['yaya_greet_req']);

app.get('/kv/:key', async (req, res) => {
  const key = req.params.key;
  if (PUBLIC_READ.has(key)) {
    // публичный ключ — как раньше, без авторизации
  } else if (req.get('X-Courier-Name') && isCourierToken(tokenOf(req)) && COURIER_KV.has(key)) {
    // курьерский ключ
  } else {
    const role = await roleOf(req);
    if (!role) return res.status(401).json({ ok: false, error: 'Нужен ключ кабинета' });
  }
  try {
    const { rows } = await pool.query('SELECT v, updated_at FROM kv WHERE k=$1', [key]);
    if (!rows.length) return res.json({ ok: true, value: null, rev: 0 });
    res.json({ ok: true, value: rows[0].v, rev: revOf(rows[0].updated_at) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

function isCourierToken(t) {
  return COURIER_TOKEN && t === COURIER_TOKEN;
}

app.put('/kv/:key', async (req, res, next) => {
  // курьер пишет только в свои служебные ключи
  if (isCourierToken(tokenOf(req)) && COURIER_KV.has(req.params.key)) return next();
  if (!(await isManager(req))) return res.status(401).json({ ok: false, error: 'Нужен ключ менеджера' });
  next();
}, async (req, res) => {
  try {
    let prevCour = null;
    if (req.params.key === 'yaya_order_couriers') {
      try {
        prevCour = await kvGet('yaya_order_couriers');
      } catch (e) {}
    }
    const { rows } = await pool.query(
      `INSERT INTO kv (k, v, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (k) DO UPDATE SET v=$2, updated_at=now()
       RETURNING updated_at`,
      [req.params.key, req.body]
    );
    res.json({ ok: true, rev: revOf(rows[0].updated_at) });
    if (req.params.key === 'yaya_order_couriers') {
      notifyDeliveryChanges(prevCour, req.body).catch(() => {});
    }
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.post('/kv/:key/append', limit(20, 60000), async (req, res) => {
  const key = req.params.key;
  if (!PUBLIC_APPEND.has(key) && !(await isManager(req))) {
    return res.status(401).json({ ok: false, error: 'Нужен ключ кабинета' });
  }
  const item = req.body && req.body.item;
  if (!item || typeof item !== 'object') {
    return res.status(400).json({ ok: false, error: 'Нужен item' });
  }
  if (JSON.stringify(item).length > 20000) {
    return res.status(413).json({ ok: false, error: 'Слишком большая запись' });
  }
  try {
    await pool.query(
      `INSERT INTO kv (k, v, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (k) DO UPDATE SET
         v = CASE WHEN jsonb_typeof(kv.v)='array' THEN kv.v || $2::jsonb ELSE $2::jsonb END,
         updated_at = now()`,
      [key, JSON.stringify([item])]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── НАСТРОЙКИ ────────────────────────────────────────────────────────
app.get('/settings', requireAnyRole, async (req, res) => {
  try {
    const s = await kvGet('yaya_settings');
    res.json({ ok: true, settings: s || { cook_minutes: 15, fulfill_minutes: 90 } });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});
app.put('/settings', requireRole('MANAGER'), async (req, res) => {
  try {
    const cur = (await kvGet('yaya_settings')) || {};
    const body = req.body || {};
    const s = {
      cook_minutes: Math.max(1, Number(body.cook_minutes) || cur.cook_minutes || 15),
      fulfill_minutes: Math.max(1, Number(body.fulfill_minutes) || cur.fulfill_minutes || 90),
    };
    await kvSet('yaya_settings', s);
    res.json({ ok: true, settings: s });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── КЛЮЧИ ДОСТУПА (только MANAGER) ──────────────────────────────────
app.get('/keys', requireRole('MANAGER'), async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT role, token, updated_at FROM access_keys ORDER BY role');
    res.json({ ok: true, keys: rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});
app.post('/keys/:role/rotate', requireRole('MANAGER'), async (req, res) => {
  const role = String(req.params.role || '').toUpperCase();
  if (!ALL_ROLES.includes(role)) return res.status(400).json({ ok: false, error: 'Неизвестная роль' });
  const token = crypto.randomBytes(24).toString('base64url');
  try {
    await pool.query(
      `INSERT INTO access_keys (role, token) VALUES ($1, $2)
       ON CONFLICT (role) DO UPDATE SET token=$2, updated_at=now()`,
      [role, token]);
    res.json({ ok: true, role, token });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── СКЛАД СЫРЬЯ ──────────────────────────────────────────────────────
function stockAccess(role, item) {
  if (role === 'MANAGER') return true;
  if (role === 'WORKSHOP') return (item.location || 'kitchen') === 'workshop';
  if (role === 'KITCHEN')  return (item.location || 'kitchen') === 'kitchen';
  return false;
}

app.get('/stock', requireAnyRole, async (req, res) => {
  try {
    const loc = req.query.location;
    const { rows } = await pool.query(
      `SELECT id, name, qty, unit, min, max, location, updated_at FROM stock
        WHERE ($1::text IS NULL OR location=$1) ORDER BY id`,
      [loc || null]);
    res.json({ ok: true, items: rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// PATCH /stock/:id — скорректировать остаток (атомарно, + журнал)
// body: { qty }  — установить точный остаток (Пересчёт)
// body: { delta, reason, emp } — приход/расход на delta
app.patch('/stock/:id', requireRole('MANAGER', 'WORKSHOP', 'KITCHEN'), async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const it = (await client.query('SELECT * FROM stock WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!it) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ ok: false, error: 'Позиция не найдена' }); }
      if (!stockAccess(req.role, it)) { await client.query('ROLLBACK'); client.release(); return res.status(403).json({ ok: false, error: 'Нет доступа к этому складу' }); }
      let delta;
      if (body.qty != null) {
        const newQty = Number(body.qty);
        delta = newQty - Number(it.qty);
        it.qty = newQty;
      } else if (body.delta != null) {
        delta = Number(body.delta);
        it.qty = Math.max(0, Number(it.qty) + delta);
      } else {
        await client.query('ROLLBACK'); client.release();
        return res.status(400).json({ ok: false, error: 'Нужно qty или delta' });
      }
      await client.query('UPDATE stock SET qty=$1, updated_at=now() WHERE id=$2', [it.qty, id]);
      await client.query(
        `INSERT INTO deductions (ing, qty, unit, reason, emp) VALUES ($1,$2,$3,$4,$5)`,
        [it.name, (delta >= 0 ? '+' : '') + Number(delta.toFixed(4)), it.unit,
         body.reason || 'Корректировка', body.emp || req.role]);
      await client.query('COMMIT');
      client.release();
      res.json({ ok: true, item: { id: it.id, name: it.name, qty: rowToNum(it.qty), unit: it.unit, min: rowToNum(it.min), max: it.max == null ? null : rowToNum(it.max), location: it.location } });
    } catch (e) { await client.query('ROLLBACK'); client.release(); throw e; }
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// POST /stock — добавить позицию
app.post('/stock', requireRole('MANAGER', 'WORKSHOP', 'KITCHEN'), async (req, res) => {
  try {
    const b = req.body || {};
    const location = (b.location || 'workshop') === 'kitchen' ? 'kitchen' : 'workshop';
    if (!stockAccess(req.role, { location })) return res.status(403).json({ ok: false, error: 'Нет доступа к этому складу' });
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ ok: false, error: 'Нужно название' });
    const id = b.id || ('i' + Date.now() + Math.floor(Math.random() * 1000));
    await pool.query(
      `INSERT INTO stock (id, name, qty, unit, min, max, location) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET name=$2, unit=$4, min=$5, max=$6, location=$7`,
      [id, String(b.name).trim(), Number(b.qty) || 0, String(b.unit || 'кг'), Number(b.min) || 1, b.max == null ? null : Number(b.max), location]);
    res.json({ ok: true, item: { id, name: String(b.name).trim(), qty: Number(b.qty) || 0, unit: String(b.unit || 'кг'), min: Number(b.min) || 1, max: b.max == null ? null : Number(b.max), location } });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// DELETE /stock/:id — удалить позицию
app.delete('/stock/:id', requireRole('MANAGER', 'WORKSHOP', 'KITCHEN'), async (req, res) => {
  try {
    const it = (await pool.query('SELECT * FROM stock WHERE id=$1', [req.params.id])).rows[0];
    if (!it) return res.json({ ok: true });
    if (!stockAccess(req.role, it)) return res.status(403).json({ ok: false, error: 'Нет доступа к этому складу' });
    await pool.query('DELETE FROM stock WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// POST /stock/:id/receive — приход от закупщика (атомарно)
// body: { qty, price, supplier, note, media[] }
app.post('/stock/:id/receive', requireRole('MANAGER', 'BUYER'), async (req, res) => {
  try {
    const b = req.body || {};
    const qty = Number(b.qty);
    if (!(qty > 0)) return res.status(400).json({ ok: false, error: 'Нужно количество > 0' });
    const price = Number(b.price) || 0;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const it = (await client.query('SELECT * FROM stock WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!it) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ ok: false, error: 'Позиция не найдена' }); }
      const newQty = Number(it.qty) + qty;
      const newMax = (it.max == null || newQty > Number(it.max)) ? newQty : Number(it.max);
      await client.query('UPDATE stock SET qty=$1, max=$2, updated_at=now() WHERE id=$3', [newQty, newMax, it.id]);
      const p = (await client.query(
        `INSERT INTO purchases (ing_id, ing, location, qty, unit, price, total, supplier, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [it.id, it.name, it.location, qty, it.unit, price, qty * price, String(b.supplier || ''), String(b.note || ''), req.role])).rows[0];
      const media = Array.isArray(b.media) ? b.media.slice(0, 5) : [];
      for (const m of media) {
        if (!m || typeof m.url !== 'string') continue;
        await client.query(
          'INSERT INTO purchase_media (purchase_id, kind, url) VALUES ($1,$2,$3)',
          [p.id, m.kind === 'receipt' ? 'receipt' : 'product', String(m.url).slice(0, 2000000)]);
      }
      await client.query(
        `INSERT INTO deductions (ing, qty, unit, reason, emp) VALUES ($1,$2,$3,$4,$5)`,
        [it.name, '+' + qty, it.unit, 'Закупка (' + (it.location === 'kitchen' ? 'Кухня' : 'Цех') + ')', req.role]);
      await client.query('COMMIT');
      client.release();
      res.json({ ok: true, purchaseId: p.id });
    } catch (e) { await client.query('ROLLBACK'); client.release(); throw e; }
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// GET /purchases?date=YYYY-MM-DD
app.get('/purchases', requireAnyRole, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, ts, ing_id, ing, location, qty, unit, price, total, supplier, note, created_by
         FROM purchases ORDER BY ts DESC LIMIT 2000`);
    res.json({ ok: true, items: rows.map(r => ({ ...r, ts: Number(r.ts) })) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── ПФ-СКЛАД (полуфабрикаты) ─────────────────────────────────────────
app.get('/pf-stock', requireAnyRole, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name, qty, unit, min, updated_at FROM pf_stock ORDER BY id');
    res.json({ ok: true, items: rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── ЖУРНАЛЫ (append + чтение) ────────────────────────────────────────
const JOURNAL_INS = {
  deductions:  'INSERT INTO deductions (ing, qty, unit, reason, emp) VALUES ($1,$2,$3,$4,$5)',
  transfers:   'INSERT INTO transfers (dir, from_name, to_name, qty, unit, emp) VALUES ($1,$2,$3,$4,$5,$6)',
  'cook-log':  'INSERT INTO cook_log (dish_id, name, emoji, qty, spent_kg) VALUES ($1,$2,$3,$4,$5)',
  'production-log': 'INSERT INTO production_log (name, batches, qty, unit, spent_kg) VALUES ($1,$2,$3,$4,$5)',
};
const JOURNAL_TBL = { deductions: 'deductions', transfers: 'transfers', 'cook-log': 'cook_log', 'production-log': 'production_log' };
const JOURNAL_SEL = {
  deductions:       'id, ts, ing, qty, unit, reason, emp',
  transfers:        'id, ts, dir, from_name, to_name, qty, unit, emp',
  'cook-log':       'id, ts, dish_id, name, emoji, qty, spent_kg',
  'production-log': 'id, ts, name, batches, qty, unit, spent_kg',
};
const JOURNAL_ROLES = { deductions: ALL_ROLES, transfers: ['MANAGER', 'WORKSHOP', 'KITCHEN'], 'cook-log': ['MANAGER', 'KITCHEN'], 'production-log': ['MANAGER', 'WORKSHOP'] };

app.post('/deductions', requireAnyRole, async (req, res) => {
  try {
    const b = req.body || {};
    if (b.ing == null) return res.status(400).json({ ok: false, error: 'Нужен ing' });
    await pool.query(JOURNAL_INS.deductions, [String(b.ing), String(b.qty == null ? '' : b.qty), String(b.unit || ''), String(b.reason || ''), String(b.emp || req.role)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});
app.get('/deductions', requireAnyRole, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT ' + JOURNAL_SEL.deductions + ' FROM deductions ORDER BY ts DESC LIMIT 3000');
    res.json({ ok: true, items: rows.map(r => ({ ...r, ts: Number(r.ts) })) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.post('/transfers', requireRole('MANAGER', 'WORKSHOP', 'KITCHEN'), async (req, res) => {
  try {
    const b = req.body || {};
    await pool.query(JOURNAL_INS.transfers, [String(b.dir || 'ws-ks'), String(b.fromName || ''), String(b.toName || ''), Number(b.qty) || 0, String(b.unit || ''), String(b.emp || req.role)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});
app.get('/transfers', requireAnyRole, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT ' + JOURNAL_SEL.transfers + ' FROM transfers ORDER BY ts DESC LIMIT 2000');
    res.json({ ok: true, items: rows.map(r => ({ ...r, ts: Number(r.ts) })) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.post('/cook-log', requireRole('MANAGER', 'KITCHEN'), async (req, res) => {
  try {
    const b = req.body || {};
    await pool.query(JOURNAL_INS['cook-log'], [String(b.dishId || ''), String(b.name || ''), String(b.emoji || ''), Number(b.qty) || 0, b.spentKg == null ? null : Number(b.spentKg)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});
app.get('/cook-log', requireAnyRole, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT ' + JOURNAL_SEL['cook-log'] + ' FROM cook_log ORDER BY ts DESC LIMIT 3000');
    res.json({ ok: true, items: rows.map(r => ({ ...r, ts: Number(r.ts) })) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.post('/production-log', requireRole('MANAGER', 'WORKSHOP'), async (req, res) => {
  try {
    const b = req.body || {};
    await pool.query(JOURNAL_INS['production-log'], [String(b.name || ''), Number(b.batches) || 0, Number(b.qty) || 0, String(b.unit || ''), b.spentKg == null ? null : Number(b.spentKg)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});
app.get('/production-log', requireAnyRole, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT ' + JOURNAL_SEL['production-log'] + ' FROM production_log ORDER BY ts DESC LIMIT 3000');
    res.json({ ok: true, items: rows.map(r => ({ ...r, ts: Number(r.ts) })) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── ПРОИЗВОДСТВО (цех) ───────────────────────────────────────────────
// POST /produce { recipeId, batches } — транзакция
app.post('/produce', requireRole('MANAGER', 'WORKSHOP'), async (req, res) => {
  try {
    const recipeId = req.body.recipeId, batches = Math.max(1, Number(req.body.batches) || 1);
    const recipes = (await kvGet('yaya_wsrecipes_v3')) || DEFAULT_WS_RECIPES;
    const rec = Array.isArray(recipes) ? recipes.find(r => r.id === recipeId) : null;
    if (!rec) return res.status(404).json({ ok: false, error: 'Рецепт не найден' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let spent = 0;
      for (const it of rec.items) {
        const row = (await client.query('SELECT * FROM stock WHERE id=$1 FOR UPDATE', [it.ingId])).rows[0];
        if (!row) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ ok: false, error: 'Нет ингредиента ' + it.ingId }); }
        const need = Number(it.qty) * batches;
        spent += need;
        if (Number(row.qty) < need) {
          await client.query('ROLLBACK'); client.release();
          return res.status(400).json({ ok: false, error: 'Недостаточно сырья: ' + row.name });
        }
        await client.query('UPDATE stock SET qty=qty-$1, updated_at=now() WHERE id=$2', [need, it.ingId]);
        await client.query('INSERT INTO deductions (ing, qty, unit, reason, emp) VALUES ($1,$2,$3,$4,$5)',
          [row.name, '-' + Number(need.toFixed(4)), it.unit, 'Производство: ' + rec.name, req.role]);
      }
      const outQty = Number(rec.outputQty) * batches;
      await client.query(
        `INSERT INTO pf_stock (id, name, qty, unit, min, updated_at) VALUES ($1,$2,$3,$4,COALESCE((SELECT min FROM pf_stock WHERE id=$1),0),now())
         ON CONFLICT (id) DO UPDATE SET qty=pf_stock.qty+$3, updated_at=now()`,
        [rec.outputId, rec.name, outQty, rec.outputUnit]);
      await client.query(
        'INSERT INTO production_log (name, batches, qty, unit, spent_kg) VALUES ($1,$2,$3,$4,$5)',
        [rec.name, batches, outQty, rec.outputUnit, Number(spent.toFixed(4))]);
      await client.query('COMMIT');
      client.release();
      res.json({ ok: true, outputId: rec.outputId, qty: outQty, unit: rec.outputUnit });
    } catch (e) { await client.query('ROLLBACK'); client.release(); throw e; }
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── ПЕРЕМЕЩЕНИЯ цех↔кухня ───────────────────────────────────────────
// POST /transfer { dir:'ws-ks'|'ks-ws', fromId, toId, qty }
app.post('/transfer', requireRole('MANAGER', 'WORKSHOP', 'KITCHEN'), async (req, res) => {
  try {
    const b = req.body || {};
    const dir = b.dir === 'ks-ws' ? 'ks-ws' : 'ws-ks';
    const qty = Number(b.qty);
    if (!(qty > 0)) return res.status(400).json({ ok: false, error: 'Нужно количество > 0' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let fromName = '', toName = '—', unit = '';
      if (dir === 'ws-ks') {
        const from = (await client.query('SELECT * FROM pf_stock WHERE id=$1 FOR UPDATE', [b.fromId])).rows[0];
        if (!from) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ ok: false, error: 'Нет полуфабриката' }); }
        if (Number(from.qty) < qty) { await client.query('ROLLBACK'); client.release(); return res.status(400).json({ ok: false, error: 'Мало на складе: ' + from.name }); }
        await client.query('UPDATE pf_stock SET qty=qty-$1, updated_at=now() WHERE id=$2', [qty, b.fromId]);
        fromName = from.name; unit = from.unit;
        if (b.toId) {
          const to = (await client.query('SELECT * FROM stock WHERE id=$1 FOR UPDATE', [b.toId])).rows[0];
          if (!to) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ ok: false, error: 'Нет позиции приёмника' }); }
          await client.query('UPDATE stock SET qty=qty+$1, updated_at=now() WHERE id=$2', [qty, b.toId]);
          toName = to.name;
        }
      } else {
        const from = (await client.query('SELECT * FROM stock WHERE id=$1 FOR UPDATE', [b.fromId])).rows[0];
        if (!from) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ ok: false, error: 'Нет позиции' }); }
        if (Number(from.qty) < qty) { await client.query('ROLLBACK'); client.release(); return res.status(400).json({ ok: false, error: 'Мало на складе: ' + from.name }); }
        await client.query('UPDATE stock SET qty=qty-$1, updated_at=now() WHERE id=$2', [qty, b.fromId]);
        fromName = from.name; unit = from.unit;
        if (b.toId) {
          const to = (await client.query('SELECT * FROM stock WHERE id=$1 FOR UPDATE', [b.toId])).rows[0];
          if (!to) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ ok: false, error: 'Нет позиции приёмника' }); }
          await client.query('UPDATE stock SET qty=qty+$1, updated_at=now() WHERE id=$2', [qty, b.toId]);
          toName = to.name;
        }
      }
      await client.query('INSERT INTO transfers (dir, from_name, to_name, qty, unit, emp) VALUES ($1,$2,$3,$4,$5,$6)',
        [dir, fromName, toName, qty, unit, req.role]);
      await client.query('INSERT INTO deductions (ing, qty, unit, reason, emp) VALUES ($1,$2,$3,$4,$5)',
        ['[' + (dir === 'ws-ks' ? 'ЦЕХ→КУХНЯ' : 'КУХНЯ→ЦЕХ') + '] ' + fromName, '+' + qty, unit, 'Передача', req.role]);
      await client.query('COMMIT');
      client.release();
      res.json({ ok: true });
    } catch (e) { await client.query('ROLLBACK'); client.release(); throw e; }
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── ВИТРИНА: заказы (не ломаем) ──────────────────────────────────────
app.get('/next-order-num', limit(30, 60000), async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT nextval('order_num_seq') AS num");
    res.json({ num: Number(rows[0].num) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/order', limit(20, 60000), async (req, res) => {
  try {
    const body = req.body || {};
    let num = body.order_num;
    if (!num) {
      const r = await pool.query("SELECT nextval('order_num_seq') AS num");
      num = Number(r.rows[0].num);
    }
    await pool.query('INSERT INTO orders (num, data) VALUES ($1, $2)', [num, body]);
    res.json({ ok: true, num });
    if (body.type !== 'RECEIPT') {
      try {
        const store = await loadSubs();
        const total = (Number(body.total) || 0) + (Number(body.delivery) || 0);
        const addr = String(body.address || '').trim();
        let newCount = 0;
        try { const bc = await pool.query("SELECT count(*)::int AS n FROM orders WHERE status='new'"); newCount = bc.rows[0].n; } catch (e) {}
        sendPush(store.admin, {
          title: 'Новый заказ #' + num,
          body: (total ? total.toLocaleString('ru') + ' тг' : '') + (addr ? ' · ' + addr : ' · Самовывоз'),
          tag: 'order-' + num, url: './', count: newCount
        });
      } catch (e) {}
    }
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.get('/orders/status', limit(120, 60000), async (req, res) => {
  try {
    const nums = String(req.query.nums || '')
      .split(',').map(s => Number(String(s).trim()))
      .filter(n => Number.isFinite(n) && n > 0).slice(0, 50);
    if (!nums.length) return res.json({ ok: true, orders: [] });
    const { rows } = await pool.query(
      `SELECT id, num, status, data->>'total' AS total, data->>'delivery' AS delivery
         FROM orders WHERE num = ANY($1::bigint[])
        ORDER BY created_at DESC`, [nums]);
    let cour = {};
    try { cour = (await kvGet('yaya_order_couriers')) || {}; } catch (e) {}
    const seen = new Set(), out = [];
    for (const o of rows) {
      const n = Number(o.num);
      if (seen.has(n)) continue;
      seen.add(n);
      const c = cour[o.id] || cour[String(o.id)] || {};
      out.push({
        num: n,
        status: o.status || 'new',
        delivery_status: c.delivery_status || 'pending',
        courier: c.courier || '',
        total: Number(o.total) || 0,
        delivery: Number(o.delivery) || 0,
      });
    }
    res.json({ ok: true, orders: out });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// GET /orders — кабинеты видят все; курьер — только свои
app.get('/orders', async (req, res) => {
  const role = await roleOf(req);
  if (!role && !isCourierToken(tokenOf(req))) {
    return res.status(401).json({ ok: false, error: 'Нужен ключ' });
  }
  try {
    const limitN = Math.min(Number(req.query.limit) || 100, 500);
    const { rows } = await pool.query(
      `SELECT id, num, status, data, extract(epoch from created_at)*1000 AS ts,
              extract(epoch from accepted_at)*1000 AS accepted_ts,
              deducted, fulfilled
         FROM orders
        WHERE ($1::timestamptz IS NULL OR created_at > $1)
        ORDER BY created_at DESC LIMIT $2`,
      [req.query.since || null, limitN]
    );
    if (role !== 'COURIER' && !isCourierToken(tokenOf(req))) {
      return res.json({ ok: true, orders: rows });
    }
    let cour = {};
    try { cour = (await kvGet('yaya_order_couriers')) || {}; } catch (e) {}
    const norm = s => String(s == null ? '' : s).trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
    const dec = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
    const me = norm(dec(req.get('X-Courier-Name') || '') || req.query.me || '');
    const out = [];
    for (const o of rows) {
      const c = cour[o.id] || cour[String(o.id)] || {};
      if (me && norm(c.courier) !== me) continue;
      out.push({
        id: o.id, num: o.num, status: o.status,
        delivery_status: c.delivery_status || 'pending',
        courier: c.courier || '',
        ts: o.ts,
        data: o.data,
      });
    }
    res.json({ ok: true, orders: out });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── Техкарта по заказу (списание на сервере, единожды) ───────────────
// items = [{id (menuId), qty, ...}]; tc = { menuId: [{ingId,qty,unit}] }
// sign>0 — списать (done), sign<0 — вернуть (cancel)
async function applyTechCard(tc, items, sign, client) {
  const ded = [];
  for (const ci of items || []) {
    const recipe = tc[ci.id];
    if (!recipe) continue;
    for (const r of recipe) {
      const need = Number((Number(r.qty) * (Number(ci.qty) || 1)).toFixed(4));
      if (!(need > 0)) continue;
      const delta = sign > 0 ? -need : need;
      const pf = (await client.query('SELECT * FROM pf_stock WHERE id=$1 FOR UPDATE', [r.ingId])).rows[0];
      if (pf) {
        await client.query('UPDATE pf_stock SET qty=GREATEST(0,qty+$1), updated_at=now() WHERE id=$2', [delta, r.ingId]);
        ded.push({ ing: pf.name, qty: (sign > 0 ? '-' : '+') + need, unit: r.unit,
          reason: sign > 0 ? 'Автосписание по заказу' : 'Возврат по отмене', emp: 'Система' });
        continue;
      }
      const st = (await client.query('SELECT * FROM stock WHERE id=$1 FOR UPDATE', [r.ingId])).rows[0];
      if (st) {
        await client.query('UPDATE stock SET qty=GREATEST(0,qty+$1), updated_at=now() WHERE id=$2', [delta, r.ingId]);
        ded.push({ ing: st.name, qty: (sign > 0 ? '-' : '+') + need, unit: r.unit,
          reason: sign > 0 ? 'Автосписание по заказу' : 'Возврат по отмене', emp: 'Система' });
      }
    }
  }
  return ded;
}
async function insertDeductions(client, ded) {
  for (const d of ded) {
    await client.query('INSERT INTO deductions (ing, qty, unit, reason, emp) VALUES ($1,$2,$3,$4,$5)',
      [d.ing, d.qty, d.unit, d.reason, d.emp]);
  }
}
function pushStatusLabel(status) {
  const map = { cook: 'Ваш заказ готовится', done: 'Заказ готов', cancel: 'Заказ отменён', fulfilled: 'Заказ выдан' };
  return map[status] || 'Статус заказа обновлён';
}

// POST /orders/:id/status { status } — жизненный цикл заказа
app.post('/orders/:id/status', requireRole('MANAGER', 'SUPERVISOR', 'ASSEMBLER'), async (req, res) => {
  try {
    const id = req.params.id;
    const status = String(req.body.status || '');
    if (!['cook', 'done', 'cancel'].includes(status)) {
      return res.status(400).json({ ok: false, error: 'Недопустимый статус' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ord = (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!ord) { await client.query('ROLLBACK'); client.release(); return res.status(404).json({ ok: false, error: 'Заказ не найден' }); }
      if (status === 'cook') {
        await client.query('UPDATE orders SET status=$1, accepted_at=COALESCE(accepted_at,now()) WHERE id=$2', ['cook', id]);
      } else if (status === 'done') {
        if (!ord.deducted) {
          const tc = (await kvGet('yaya_tech_v3', client)) || {};
          const ded = await applyTechCard(tc, (ord.data && ord.data.items) || [], 1, client);
          await insertDeductions(client, ded);
          await client.query('UPDATE orders SET status=$1, deducted=true WHERE id=$2', ['done', id]);
        } else {
          await client.query('UPDATE orders SET status=$1 WHERE id=$2', ['done', id]);
        }
      } else if (status === 'cancel') {
        if (ord.deducted) {
          const tc = (await kvGet('yaya_tech_v3', client)) || {};
          const ded = await applyTechCard(tc, (ord.data && ord.data.items) || [], -1, client);
          await insertDeductions(client, ded);
          await client.query('UPDATE orders SET status=$1, deducted=false WHERE id=$2', ['cancel', id]);
        } else {
          await client.query('UPDATE orders SET status=$1 WHERE id=$2', ['cancel', id]);
        }
      }
      await client.query('COMMIT');
      client.release();
      res.json({ ok: true });
      try {
        const q = await pool.query('SELECT num FROM orders WHERE id=$1', [id]);
        const num = q.rows[0] && q.rows[0].num;
        if (num) {
          const store = await loadSubs();
          sendPush((store.orders || {})[String(num)], { title: 'Заказ #' + num, body: pushStatusLabel(status), tag: 'order-' + num, url: './' });
        }
      } catch (e) {}
    } catch (e) { await client.query('ROLLBACK'); client.release(); throw e; }
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// POST /orders/:id/fulfill { mode:'cafe'|'pickup'|'courier' }
app.post('/orders/:id/fulfill', requireRole('MANAGER', 'SUPERVISOR', 'ASSEMBLER'), async (req, res) => {
  try {
    const id = req.params.id;
    const mode = String(req.body.mode || '');
    if (!['cafe', 'pickup', 'courier'].includes(mode)) {
      return res.status(400).json({ ok: false, error: 'Недопустимый mode' });
    }
    const ord = (await pool.query('SELECT * FROM orders WHERE id=$1', [id])).rows[0];
    if (!ord) return res.status(404).json({ ok: false, error: 'Заказ не найден' });
    if (mode === 'courier') {
      const cur = (await kvGet('yaya_order_couriers')) || {};
      const prev = JSON.parse(JSON.stringify(cur));
      const key = String(ord.id);
      cur[key] = Object.assign({}, cur[key] || {}, { fulfilled: true, courier: cur[key] && cur[key].courier || '', delivery_status: cur[key] && cur[key].delivery_status || 'pending' });
      await kvSet('yaya_order_couriers', cur);
      notifyDeliveryChanges(prev, cur).catch(() => {});
    }
    await pool.query('UPDATE orders SET status=$1, fulfilled=$2 WHERE id=$3', ['fulfilled', mode, id]);
    res.json({ ok: true });
    try {
      const num = ord.num;
      const store = await loadSubs();
      const label = mode === 'courier' ? 'Передан курьеру' : (mode === 'pickup' ? 'Готов к самовывозу' : 'Выдан в кафе');
      sendPush((store.orders || {})[String(num)], { title: 'Заказ #' + num, body: label, tag: 'order-' + num, url: './' });
    } catch (e) {}
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.get('/push/public-key', (req, res) => res.json({ ok: true, key: VAPID_PUBLIC }));

app.post('/push/subscribe', async (req, res) => {
  try {
    const { role, name, num, sub } = req.body || {};
    if (!sub || !sub.endpoint) return res.status(400).json({ ok: false, error: 'нет подписки' });
    if (role === 'admin'   && !(await isManager(req))) return res.status(401).json({ ok: false });
    if (role === 'courier' && !(await isManager(req)) && !isCourierToken(tokenOf(req))) return res.status(401).json({ ok: false });
    const store = await loadSubs();
    if (role === 'admin') {
      store.admin = dedupeSubs([...(store.admin || []), sub]);
    } else if (role === 'courier' && name) {
      const key = String(name).trim().toLowerCase();
      store.couriers = store.couriers || {};
      store.couriers[key] = dedupeSubs([...(store.couriers[key] || []), sub]);
    } else if (role === 'client' && num) {
      store.orders = store.orders || {};
      store.orders[String(num)] = dedupeSubs([...(store.orders[String(num)] || []), sub]);
    } else {
      return res.status(400).json({ ok: false, error: 'неверная роль' });
    }
    await saveSubs(store);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.post('/push/notify-courier', requireRole('MANAGER'), async (req, res) => {
  try {
    const { name, num } = req.body || {};
    if (!name) return res.status(400).json({ ok: false });
    const store = await loadSubs();
    const key = String(name).trim().toLowerCase();
    sendPush((store.couriers || {})[key], {
      title: 'Новый заказ на доставку',
      body: num ? ('Заказ #' + num + ' назначен на вас') : 'Вам назначен заказ',
      tag: 'assign', url: './'
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.get('/push/status', async (req, res) => {
  try {
    const st = await loadSubs();
    const cour = st.couriers || {}; let courN = 0; for (const k in cour) courN += (cour[k] || []).length;
    const ord = st.orders || {};   let ordN  = 0; for (const k in ord)  ordN  += (ord[k]  || []).length;
    res.json({ ok: true, push: PUSH_ON, subject: VAPID_SUBJECT, admin: (st.admin || []).length, couriers: courN, orders: ordN });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});
app.post('/push/test', requireRole('MANAGER'), async (req, res) => {
  try {
    const st = await loadSubs();
    const n = (st.admin || []).length;
    await sendPush(st.admin, { title: 'Проверка уведомлений', body: 'Если вы это видите — пуш работает', tag: 'test', url: './' });
    res.json({ ok: true, sent: n, push: PUSH_ON });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.get('/health', (req, res) => res.json({ ok: true, auth: AUTH_ON, push: PUSH_ON }));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log('YaYa backend on', PORT)))
  .catch(e => { console.error('DB init failed', e); process.exit(1); });
