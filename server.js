// ─── YaYa Chicken · Backend (Railway) ────────────────────────────────
// Общая база для системы учёта (Менеджер/Кухня/Цех) и заказов клиента.
// Стек: Node + Express + Postgres. Таблицы создаются сами при старте.
//
// ENV (Railway задаёт сам после Add → Database → Postgres):
//   DATABASE_URL           — строка подключения к Postgres (обязательно)
//   PORT                   — порт (Railway задаёт сам)
//   TELEGRAM_BOT_TOKEN     — опционально: чтобы квитанция уходила в Telegram
//   TELEGRAM_MANAGER_CHAT  — опционально: чат/группа, куда дублировать новые заказы

const express = require('express');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
       ? { rejectUnauthorized: false } : false,
});

const app = express();
app.use(express.json({ limit: '5mb' }));

// ── CORS (фронт на GitHub Pages / Vercel обращается сюда) ────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

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
  `);
  console.log('DB ready');
}

const revOf = (ts) => new Date(ts).getTime(); // ревизия = метка времени в мс

// ── KEY-VALUE (те же ключи, что были в localStorage) ────────────────
// GET  /kv/:key            → { ok, value, rev }
app.get('/kv/:key', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT v, updated_at FROM kv WHERE k=$1', [req.params.key]);
    if (!rows.length) return res.json({ ok: true, value: null, rev: 0 });
    res.json({ ok: true, value: rows[0].v, rev: revOf(rows[0].updated_at) });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// PUT  /kv/:key   body=<любой JSON>   → { ok, rev }   (перезапись целиком)
app.put('/kv/:key', async (req, res) => {
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

// POST /kv/:key/append  body={item}  → { ok }  (безопасное добавление в массив,
// на будущее — чтобы одновременные записи разных устройств не затирали друг друга)
app.post('/kv/:key/append', async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO kv (k, v, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (k) DO UPDATE SET v = kv.v || $2::jsonb, updated_at=now()`,
      [req.params.key, JSON.stringify([req.body.item])]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── ЗАКАЗЫ (совместимо с текущим checkout.js) ───────────────────────
// GET /next-order-num → { num }
app.get('/next-order-num', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT nextval('order_num_seq') AS num");
    res.json({ num: Number(rows[0].num) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// POST /order  — приём заказа ИЛИ квитанции (type:'RECEIPT') от клиента
app.post('/order', async (req, res) => {
  try {
    const body = req.body || {};

    // Повторная отправка квитанции в Telegram — не создаём новый заказ
    if (body.type === 'RECEIPT') {
      await forwardReceipt(body);
      return res.json({ ok: true });
    }

    let num = body.order_num;
    if (!num) {
      const r = await pool.query("SELECT nextval('order_num_seq') AS num");
      num = Number(r.rows[0].num);
    }
    await pool.query('INSERT INTO orders (num, data) VALUES ($1, $2)', [num, body]);
    await notifyNewOrder(num, body);
    res.json({ ok: true, num });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// GET /orders?since=<ISO>&limit=  → список для доски заказов (Кухня/Менеджер)
app.get('/orders', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const { rows } = await pool.query(
      `SELECT id, num, status, data, extract(epoch from created_at)*1000 AS ts
         FROM orders
        WHERE ($1::timestamptz IS NULL OR created_at > $1)
        ORDER BY created_at DESC LIMIT $2`,
      [req.query.since || null, limit]
    );
    res.json({ ok: true, orders: rows });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// POST /orders/:id/status  {status}  → смена статуса (новый→готовится→...→доставлен)
app.post('/orders/:id/status', async (req, res) => {
  try {
    await pool.query('UPDATE orders SET status=$1 WHERE id=$2', [req.body.status, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: String(e) }); }
});

// ── Telegram (опционально) ──────────────────────────────────────────
async function tg(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  } catch (e) { console.log('tg error', e.message); }
}
async function forwardReceipt(r) {
  if (!r.chat_id) return;
  const lines = (r.items || []).map(i => `• ${i.name} ×${i.qty} — ${i.total} тг`).join('\n');
  await tg('sendMessage', { chat_id: r.chat_id,
    text: `🧾 Квитанция №${r.num}\n${lines}\n\nИтого: ${r.total} тг\n📍 ${r.address || ''}` });
}
async function notifyNewOrder(num, o) {
  if (o.chat_id) {
    await tg('sendMessage', { chat_id: o.chat_id,
      text: `✅ Заказ №${num} принят!\nСумма: ${(o.total || 0) + (o.delivery || 0)} тг\nМы уже готовим 🧑‍🍳` });
  }
  if (process.env.TELEGRAM_MANAGER_CHAT) {
    const lines = (o.items || []).map(i => `• ${i.name} ×${i.qty}`).join('\n');
    await tg('sendMessage', { chat_id: process.env.TELEGRAM_MANAGER_CHAT,
      text: `🆕 Заказ №${num}\n${lines}\n📍 ${o.address || ''}\n💰 ${(o.total||0)+(o.delivery||0)} тг · ${o.pay_method||''}` });
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => app.listen(PORT, () => console.log('YaYa backend on', PORT)))
  .catch(e => { console.error('DB init failed', e); process.exit(1); });
