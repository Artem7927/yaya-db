// ─── YaYa Chicken · Backend (Railway) ────────────────────────────────
// Общая база для системы учёта (Менеджер/Кухня/Цех) и заказов клиента.
// Стек: Node + Express + Postgres. Таблицы создаются сами при старте.
//
// ENV (Railway задаёт сам после Add → Database → Postgres):
//   DATABASE_URL   — строка подключения к Postgres (обязательно)
//   PORT           — порт (Railway задаёт сам)
//   ADMIN_TOKEN    — ключ кабинета. ПОКА НЕ ЗАДАН, сервер работает как раньше:
//                    ничего не ломается, но и данные клиентов открыты.
//                    Задайте его в Railway → Variables и введите тот же ключ
//                    в кабинете на экране входа — тогда чужие телефоны,
//                    адреса и настройки закроются от посторонних.

const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
       ? { rejectUnauthorized: false } : false,
  max: 12,
});

const app = express();
app.set('trust proxy', 1);              // за прокси Railway — чтобы видеть реальный IP
app.use(express.json({ limit: '2mb' }));

const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();
const AUTH_ON = ADMIN_TOKEN.length > 0;

// ── Кто что может читать ────────────────────────────────────────────
// Витрине нужны только эти ключи: меню, радио, ТВ, остатки, положение
// курьера и его привязка к заказу. Всё остальное — только кабинету.
const PUBLIC_READ = new Set([
  'yaya_radio', 'yaya_tv', 'yaya_menu', 'yaya_stock',
  'yaya_courier_pos', 'yaya_order_couriers',
  'yaya_greetings', 'yaya_greet',
]);
// Сюда витрина может только ДОПИСЫВАТЬ (заявки на поздравления),
// читать этот ключ посторонним нельзя — там телефоны покупателей.
const PUBLIC_APPEND = new Set(['yaya_greet_req']);

// ── CORS (фронт на GitHub Pages / Vercel обращается сюда) ────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,X-Admin-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Ключ кабинета ───────────────────────────────────────────────────
function isAdmin(req) {
  if (!AUTH_ON) return true;                       // ключ не задан — старое поведение
  const t = req.get('X-Admin-Token') || req.query.token || '';
  return String(t) === ADMIN_TOKEN;
}
function needAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ ok: false, error: 'Нужен ключ кабинета' });
}

// ── Ограничение частоты (защита от перебора и мусора) ───────────────
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

// ── Инициализация схемы ─────────────────────────────────────────────
async function initDb() {
  await pool.query(`
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
  `);
  console.log('DB ready · авторизация кабинета:', AUTH_ON ? 'ВКЛЮЧЕНА' : 'выключена (ADMIN_TOKEN не задан)');
}

const revOf = (ts) => new Date(ts).getTime(); // ревизия = метка времени в мс

// ── Проверка ключа (кабинет спрашивает при входе) ───────────────────
// { ok } — ключ подошёл; { auth:false } — на сервере ключ вообще не задан.
app.get('/auth-check', limit(20, 60000), (req, res) => {
  res.json({ ok: isAdmin(req), auth: AUTH_ON });
});

// ── KEY-VALUE (те же ключи, что были в localStorage) ────────────────
// GET  /kv/:key            → { ok, value, rev }
app.get('/kv/:key', async (req, res) => {
  const key = req.params.key;
  if (!PUBLIC_READ.has(key) && !isAdmin(req)) {
    return res.status(401).json({ ok: false, error: 'Нужен ключ кабинета' });
  }
  try {
    const { rows } = await pool.query('SELECT v, updated_at FROM kv WHERE k=$1', [key]);
    if (!rows.length) return res.json({ ok: true, value: null, rev: 0 });
    res.json({ ok: true, value: rows[0].v, rev: revOf(rows[0].updated_at) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// PUT  /kv/:key   body=<любой JSON>   → { ok, rev }   (перезапись целиком)
app.put('/kv/:key', needAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `INSERT INTO kv (k, v, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (k) DO UPDATE SET v=$2, updated_at=now()
       RETURNING updated_at`,
      [req.params.key, req.body]
    );
    res.json({ ok: true, rev: revOf(rows[0].updated_at) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// POST /kv/:key/append  body={item}  → { ok }
// Безопасное добавление в массив: два устройства, пишущие одновременно,
// больше не затирают друг друга (в отличие от PUT целиком).
app.post('/kv/:key/append', limit(20, 60000), async (req, res) => {
  const key = req.params.key;
  if (!PUBLIC_APPEND.has(key) && !isAdmin(req)) {
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

// ── ЗАКАЗЫ (совместимо с текущим checkout.js) ───────────────────────
// GET /next-order-num → { num }
app.get('/next-order-num', limit(30, 60000), async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT nextval('order_num_seq') AS num");
    res.json({ num: Number(rows[0].num) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /order  — приём заказа ИЛИ квитанции (type:'RECEIPT') от клиента
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
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// GET /orders/status?nums=41,42 → статус СВОИХ заказов для витрины.
// Отдаёт только то, что нужно для отслеживания: без имён, телефонов,
// адресов и состава. Полный список доступен только кабинету.
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
    try {
      const k = await pool.query('SELECT v FROM kv WHERE k=$1', ['yaya_order_couriers']);
      if (k.rows.length && k.rows[0].v && typeof k.rows[0].v === 'object') cour = k.rows[0].v;
    } catch (e) {}

    const seen = new Set(), out = [];
    for (const o of rows) {
      const n = Number(o.num);
      if (seen.has(n)) continue;                 // на один номер — самая свежая запись
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

// GET /orders?since=<ISO>&limit=  → полный список для кабинета (Кухня/Менеджер)
app.get('/orders', needAdmin, async (req, res) => {
  try {
    const limitN = Math.min(Number(req.query.limit) || 100, 500);
    const { rows } = await pool.query(
      `SELECT id, num, status, data, extract(epoch from created_at)*1000 AS ts
         FROM orders
        WHERE ($1::timestamptz IS NULL OR created_at > $1)
        ORDER BY created_at DESC LIMIT $2`,
      [req.query.since || null, limitN]
    );
    res.json({ ok: true, orders: rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// POST /orders/:id/status  {status}  → смена статуса (новый→готовится→...→доставлен)
app.post('/orders/:id/status', needAdmin, async (req, res) => {
  try {
    await pool.query('UPDATE orders SET status=$1 WHERE id=$2', [req.body.status, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

app.get('/health', (req, res) => res.json({ ok: true, auth: AUTH_ON }));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log('YaYa backend on', PORT)))
  .catch(e => { console.error('DB init failed', e); process.exit(1); });
