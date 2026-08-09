#!/usr/bin/env node
/**
 * tools/day-sim.cjs — нагрузочная симуляция «одного дня» против живого сервера.
 * Приватный замер: ~180 заказов за сжатый день, два горба (обед/ужин), готовка
 * наперёд пула ready_s14, сходимость по журналу и восстановление данных.
 * ПРОДУКТОВЫЙ КОД НЕ ТРОГАЕТ — только публичные HTTP-эндпоинты.
 *
 * Требования:
 *   MANAGER-ключ. Токен: env YAYA_TOKEN, либо путь к файлу (первая строка)
 *   через env DAYSIM_TOKEN_FILE. API по умолчанию production Railway.
 *
 * Запуск:  node tools/day-sim.cjs   (SPEED=1 → день ≈ 7.2 мин)
 *          node tools/day-sim.cjs 2 (ускорить вдвое)
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ═══════════════ КОНФИГ (все параметры настраиваемые) ═══════════════
const CFG = {
  YAYA_API: process.env.YAYA_API || 'https://yaya-db-production.up.railway.app',
  SPEED: Number(process.env.SPEED || process.argv[2] || 1), // множитель скорости (1 = ~7.2 мин на день)
  COMPRESS: 100,                                            // сжатие реального времени (12ч → 432с)
  DAY_START_H: Number(process.env.DAY_START || 10), DAY_END_H: Number(process.env.DAY_END || 22),
  ORDERS: Number(process.env.ORDERS || 180),
  BASKET_MIN: 1, BASKET_MAX: 3,
  FRIES_SHARE: 0.18,                                        // доля заказов, содержащих фри-блюдо
  CANCEL_SHARE: 0.06,                                       // доля заказов done→cancel (проверка возврата)
  ACCEPT_MIN: 5, COOK_MIN: 40,                              // реальные минуты: new→cook, cook→done
  MAX_INFLIGHT_ORDERS: 15,                                  // одновременно «в работе» созданий
  TICK_MS: 1500,
  TIMEOUT_MS: 20000,
  MAX_WALL_MIN: 45,                                         // стоп-кран всего прогона
  RESET_START_NUM: 1,
  // готовка наперёд (пул ready_s14)
  POOL_ID: 'ready_s14',
  POOL_BUFFER: 12,                                          // порций буфера
  POOL_LOOKAHEAD_MIN: 45,                                   // горизонт прогноза спроса (реальные минуты)
  COOK_BATCH: 20,                                           // порций за один POST /cook
  POOL_REFRESH_MS: 4000,                                    // обновление кэша пула
  COOK_MIN_GAP_MS: 3000,                                    // пауза между батчами готовки
  R31_PER_PORTION: 0.2,                                     // кг r31 на 1 порцию фри
  REPORT_FILE: path.join(__dirname, 'day-sim-report.json'),
};

// ═══════════════ Служебные утилиты ═══════════════
const round = (x, p = 3) => Math.round(x * 10 ** p) / 10 ** p;
const ts = () => new Date().toISOString();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const EP = {
  POST_ORDER: 'POST /order',
  POST_STATUS: 'POST /orders/:id/status',
  POST_COOK: 'POST /cook',
  GET_STOCK: 'GET /stock',
  GET_PF: 'GET /pf-stock',
  GET_ORDERS: 'GET /orders',
  GET_COOKLOG: 'GET /cook-log',
  GET_DEDUCTIONS: 'GET /deductions',
  GET_KV: 'GET /kv/:key',
  GET_COOKREC: 'GET /cook-recipes',
  PATCH_STOCK: 'PATCH /stock/:id',
  PATCH_PF: 'PATCH /pf-stock/:id',
  RESET: 'POST /admin/reset-orders',
};
const lat = {}, errTypes = {};
for (const k in EP) { lat[EP[k]] = []; errTypes[EP[k]] = { x429: 0, x5xx: 0, timeout: 0, other: 0 }; }
let TOKEN = '';
function headers(json) { return { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN, ...(json ? {} : {}) }; }
async function call(method, urlPath, ep, body) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.TIMEOUT_MS);
  try {
    const r = await fetch(CFG.YAYA_API + urlPath, {
      method, headers: headers(), signal: ctrl.signal, cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ms = Date.now() - t0;
    lat[ep].push(ms);
    if (r.status === 429) errTypes[ep].x429++;
    else if (r.status >= 500) errTypes[ep].x5xx++;
    if (r.status === 0) errTypes[ep].other++;
    let d = null; try { d = await r.json(); } catch (e) {}
    return { status: r.status, ms, body: d };
  } catch (e) {
    const ms = Date.now() - t0;
    lat[ep].push(ms);
    errTypes[ep].timeout++;
    return { status: 0, ms, error: String(e) };
  } finally { clearTimeout(timer); }
}
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };

// ═══════════════ Снимки состояния ═══════════════
function StockSnap(items) {
  const q = {}; for (const i of items) q[i.id] = Number(i.qty);
  return {
    qty: id => q[id] != null ? q[id] : null,
    ids: Object.keys(q), snap: q,
  };
}
function PfSnap(items) {
  const q = {}; for (const i of items) q[i.id + '|' + (i.location || 'workshop')] = Number(i.qty);
  return {
    qty: (id, loc) => q[id + '|' + (loc || 'workshop')] != null ? q[id + '|' + (loc || 'workshop')] : null,
    keys: Object.keys(q), snap: q,
  };
}
async function stockSnap() { const r = await call('GET', '/stock', EP.GET_STOCK); const items = (r.body && r.body.items) || []; return { ok: r.status === 200, snap: StockSnap(items) }; }
async function pfSnap() { const r = await call('GET', '/pf-stock', EP.GET_PF); const items = (r.body && r.body.items) || []; return { ok: r.status === 200, snap: PfSnap(items) }; }

// ═══════════════ Планировщик прибытий (два горба) ═══════════════
const DURATION_S = (CFG.DAY_END_H - CFG.DAY_START_H) * 3600 / CFG.COMPRESS; // 432с при SPEED=1
function intensity(h) { // часы [10,22]: обед 12–14, ужин 18–21, фон в остальное
  const lunch = 1.15 * Math.exp(-0.5 * Math.pow((h - 13.0) / 1.05, 2));
  const dinner = 1.50 * Math.exp(-0.5 * Math.pow((h - 19.4) / 1.55, 2));
  return 0.05 + lunch + dinner;
}
let INT_MAX = 0;
for (let h = 10; h <= 22; h += 0.01) INT_MAX = Math.max(INT_MAX, intensity(h));
function genArrivals(n) {
  const out = []; let guard = 0;
  while (out.length < n && guard++ < n * 400) {
    const h = CFG.DAY_START_H + Math.random() * (CFG.DAY_END_H - CFG.DAY_START_H);
    if (Math.random() <= intensity(h) / INT_MAX) out.push(h);
  }
  return out.map(h => ({ atSim: (h - CFG.DAY_START_H) / (CFG.DAY_END_H - CFG.DAY_START_H) * DURATION_S })).sort((a, b) => a.atSim - b.atSim);
}

// ═══════════════ Метрики/статистика ═══════════════
const stats = {
  created: 0, done: 0, cancel: 0, leftover: 0,
  order429: [], order429Count: 0,
  cookBatches: 0, producedPortions: 0, producedKg: 0,
  cookRejected400: [], readyShortOrders: 0,
  shortages: [], // {sim, order, id, name, need, had, short}
  concurrencySamples: [], concurrencyPeak: 0, concurrencyPeakSim: 0,
  creationWallMs: 0,
  byStatusServer: null,
  ordersByHour: {}, 
};
let liveOrders = new Set();
let startWall = 0;
let lastTickPrint = -1e9;
const simNow = () => (Date.now() - startWall) / 1000 * CFG.SPEED;
let friesQty = {};

// ═══════════════ Движок событий ═══════════════
let events = [];
function scheduleEvent(atSec, fn) { events.push({ at: atSec, fn }); events.sort((a, b) => a.at - b.at); }

// ═══════════════ Жизненный цикл заказа ═══════════════
let inflightCreate = 0;
async function createOrder(ord) {
  while (inflightCreate >= CFG.MAX_INFLIGHT_ORDERS) await sleep(250);
  inflightCreate++;
  try {
    for (let attempt = 1; ; attempt++) {
      const r = await call('POST', '/order', EP.POST_ORDER, { order_num: null, items: ord.items, total: ord.total, type: 'IN', address: 'Симуляция дня' });
      if (r.status === 200 && r.body && r.body.ok) { stats.created++; stats.creationWallMs = Date.now() - startWall; return r.body.num; }
      if (r.status === 429) { stats.order429Count++; stats.order429.push({ wall: ts(), sim: round(simNow()), attempt }); const w = Math.min(12000, 2500 * attempt + Math.random() * 2000); await sleep(w); continue; }
      if (r.status >= 500 || r.status === 0) { await sleep(800); continue; }
      throw new Error('POST /order status ' + r.status + ' ' + JSON.stringify(r.body));
    }
  } finally { inflightCreate--; }
}
let idByNum = {};
async function orderId(num) {
  if (idByNum[num]) return idByNum[num];
  const r = await call('GET', '/orders?limit=100', EP.GET_ORDERS);
  if (r.status === 200 && r.body && Array.isArray(r.body.orders)) {
    for (const o of r.body.orders) idByNum[o.num] = o.id;
  }
  return idByNum[num];
}
async function runOrder(ord) {
  liveOrders.add(ord.token);
  try {
    ord.num = await createOrder(ord);
    if (!ord.num) return;
    ord.id = await orderId(ord.num);
    scheduleEvent(simNow() + CFG.ACCEPT_MIN * 60 / CFG.COMPRESS, () => stepCook(ord));
  } catch (e) { console.error('[order]', ord.num, String(e)); stats.leftover++; liveOrders.delete(ord.token); }
}
async function stepCook(ord) {
  try {
    const r = await call('POST', '/orders/' + ord.id + '/status', EP.POST_STATUS, { status: 'cook' });
    if (r.status !== 200 && r.status !== 400) { /* повтор не делаем — шаг дальше */ }
  } catch (e) { console.error('[stepCook]', ord.num, String(e)); }
  scheduleEvent(simNow() + CFG.COOK_MIN * 60 / CFG.COMPRESS, () => stepFinal(ord));
}
async function stepFinal(ord) {
  const cancel = Math.random() < CFG.CANCEL_SHARE;
  let r1 = null;
  try { r1 = await call('POST', '/orders/' + ord.id + '/status', EP.POST_STATUS, { status: 'done' }); } catch (e) { console.error('[stepFinal]', ord.num, String(e)); }
  if (r1 && r1.status === 200 && r1.body) {
    const shorts = (r1.body.shortage || []).filter(s => s && s.id);
    ord.doneShorts = shorts;
    for (const s of shorts) {
      stats.shortages.push({ sim: round(simNow()), order: ord.num, id: s.id, name: s.name, need: s.need, had: s.had, short: s.short });
      if (s.id === CFG.POOL_ID) stats.readyShortOrders++;
    }
  }
  if (cancel) {
    try {
      const r2 = await call('POST', '/orders/' + ord.id + '/status', EP.POST_STATUS, { status: 'cancel' });
      if (r2.status === 200 && r2.body && r2.body.ok) stats.cancel++;
    } catch (e) { console.error('[stepFinal]', ord.num, String(e)); }
    ord.final = 'cancel';
  } else {
    ord.final = 'done';
    stats.done++;
  }
  liveOrders.delete(ord.token);
}

// ═══════════════ Готовка наперёд (пул ready_s14) ═══════════════
let pool = null, poolAt = 0, r31 = null, r31At = 0, lastCook = 0;
let friesCum = []; // [{at, cum}] — накопленный фри-спрос планируемых заказов
function friesCumAt(t) {
  if (!friesCum.length) return 0;
  if (t <= friesCum[0].at) return 0;
  for (let i = friesCum.length - 1; i >= 0; i--) if (friesCum[i].at <= t) return friesCum[i].cum;
  return 0;
}
async function cookAhead(now) {
  if (now >= DURATION_S + 10) return;
  if (Date.now() - poolAt > CFG.POOL_REFRESH_MS) {
    poolAt = Date.now();
    const pf = await pfSnap();
    pool = pf.ok ? pf.snap.qty(CFG.POOL_ID, 'kitchen') : pool;
    if (pool == null) pool = 0;
  }
  if (Date.now() - r31At > 10000) {
    r31At = Date.now();
    const s = await stockSnap();
    r31 = s.ok ? s.snap.qty('r31') : r31;
  }
  const horizon = Math.min(now + CFG.POOL_LOOKAHEAD_MIN * 60 / CFG.COMPRESS, DURATION_S);
  const target = (friesCumAt(horizon) - friesCumAt(now)) + CFG.POOL_BUFFER;
  const missing = target - pool;
  if (missing > 0.5 && Date.now() - lastCook >= CFG.COOK_MIN_GAP_MS) {
    const cap = r31 != null ? Math.floor((r31 + 1e-9) / CFG.R31_PER_PORTION) : Infinity;
    const qty = Math.max(1, Math.min(missing, CFG.COOK_BATCH, cap));
    if (qty >= 1) {
      lastCook = Date.now();
      const r = await call('POST', '/cook', EP.POST_COOK, { dishId: 's14', qty, name: 'Фри', emoji: '🍟' });
      if (r.status === 200 && r.body && r.body.ok) {
        stats.cookBatches++; stats.producedPortions += qty; stats.producedKg += round(qty * CFG.R31_PER_PORTION, 4);
        pool = Number(r.body.ready); poolAt = Date.now();
      } else if (r.status === 400) {
        stats.cookRejected400.push({ sim: round(now), qty, err: r.body && r.body.error });
      }
    }
  }
}

// ═══════════════ Тик-сэмплинг и завершение ═══════════════
function sampleConcurrency(now) {
  stats.concurrencySamples.push({ sim: round(now), n: liveOrders.size });
  if (liveOrders.size > stats.concurrencyPeak) { stats.concurrencyPeak = liveOrders.size; stats.concurrencyPeakSim = round(now); }
  const h = (now / DURATION_S) * 12 + CFG.DAY_START_H;
  stats.ordersByHour[h.toFixed(0)] = (stats.ordersByHour[h.toFixed(0)] || 0);
}
function allTerminal() {
  return liveOrders.size === 0 && inflightCreate === 0 && events.length === 0;
}

// ═══════════════ Пост-обработка: сходимость и отчёт ═══════════════
function percentileReport() {
  const out = {};
  for (const k of Object.keys(EP)) {
    const ep = EP[k];
    out[ep] = { n: lat[ep].length, p50: round(pct(lat[ep], 0.50)), p95: round(pct(lat[ep], 0.95)), max: round(pct(lat[ep], 1.0)), errors: errTypes[ep] };
  }
  return out;
}
async function reconcile(snapStock, snapPf, finalOrders, cookLogBefore) {
  // cook_log diff → произведено порций (server-side факт)
  const cl = await call('GET', '/cook-log', EP.GET_COOKLOG);
  let cookLogAfterSum = 0, cookLogBeforeSum = 0;
  const sumLog = list => (list || []).filter(x => x.dish_id === 's14').reduce((s, x) => s + Number(x.qty), 0);
  cookLogAfterSum = sumLog(cl.body && cl.body.items);
  cookLogBeforeSum = sumLog(cookLogBefore);
  const producedServer = cookLogAfterSum - cookLogBeforeSum;

  // deductions журнал
  const dd = await call('GET', '/deductions', EP.GET_DEDUCTIONS);
  const ded = (dd.body && dd.body.items) || [];
  const ignoreReasons = s => /НЕДОСТАЧА|Корректировка|Инвентаризация/.test(s);
  const journal = {}; // name → сумма qty
  for (const d of ded) {
    if (ignoreReasons(d.reason || '')) continue;
    const q = parseFloat(d.qty);
    if (!Number.isFinite(q)) continue;
    journal[d.ing] = (journal[d.ing] || 0) + q;
  }

  const curS = await stockSnap(), curP = await pfSnap();
  // имя → ключи
  const nameMap = {};
  const addName = (name, key) => { if (!name) return; (nameMap[name] = nameMap[name] || []); if (!nameMap[name].includes(key)) nameMap[name].push(key); };
  const curSItems = curS.ok ? Object.keys(curS.snap.snap).map(id => ({ id })) : [];
  const curPItems = curP.ok ? curP.snap.keys.map(k => ({ id: k.split('|')[0], loc: k.split('|')[1] })) : [];
  // для имён нужен запрос списков (stock/pf) с именами
  const rawS = (await call('GET', '/stock', EP.GET_STOCK)).body.items;
  const rawP = (await call('GET', '/pf-stock', EP.GET_PF)).body.items;
  for (const i of rawS) addName(i.name, 's:' + i.id);
  for (const i of rawP) addName(i.name, 'pf:' + i.id + ':' + (i.location || 'workshop'));

  const mismatches = [], okCount = 0, detail = [];
  const producedForKey = k => (k === 'pf:ready_s14:kitchen' ? stats.producedPortions : 0);

  // по stock
  for (const id of Object.keys(snapStock.snap.snap)) {
    const cur = curS.ok ? (curS.snap.snap[id] != null ? curS.snap.snap[id] : 0) : null;
    if (cur == null) continue;
    const measured = Number(snapStock.snap.snap[id]) - cur;
    const jnet = journal[nameKey(rawS, id)] || 0;
    const expected = -(jnet);
    const row = { key: 's:' + id, measured: round(measured, 4), journalNet: round(jnet, 4), expected: round(expected, 4) };
    if (Math.abs(expected - measured) > 1e-6) { row.mismatch = true; mismatches.push(row); } else row.ok = true;
    detail.push(row);
  }
  // по pf (id+loc)
  for (const k of Object.keys(snapPf.snap.snap)) {
    const [id, loc] = k.split('|');
    const cur = curP.ok ? (curP.snap.snap[k] != null ? curP.snap.snap[k] : 0) : null;
    if (cur == null) continue;
    const measured = Number(snapPf.snap.snap[k]) - cur;
    const jnet = journal[nameKeyPf(rawP, id, loc)] || 0;
    const prod = producedForKey(k);
    const expected = -(jnet + prod);
    const row = { key: 'pf:' + k, measured: round(measured, 4), journalNet: round(jnet, 4), produced: prod, expected: round(expected, 4) };
    if (Math.abs(expected - measured) > 1e-6) { row.mismatch = true; mismatches.push(row); } else row.ok = true;
    detail.push(row);
  }

  // ready_s14 формула из ТЗ: произведено − потреблено == Δ
  let consumedNeed = 0, consumedShort = 0;
  for (const o of finalOrders) {
    if (o.final !== 'done') continue;
    const need = (o.items || []).reduce((s, it) => s + (friesQty[it.id] || 0) * it.qty, 0);
    const short = (o.doneShorts || []).filter(x => x.id === CFG.POOL_ID).reduce((s, x) => s + x.short, 0);
    consumedNeed += need; consumedShort += short;
  }
  const consumedActual = consumedNeed - consumedShort;
  const curReady = curP.ok ? (curP.snap.snap['ready_s14|kitchen'] != null ? curP.snap.snap['ready_s14|kitchen'] : 0) : null;
  const measuredReady = Number(snapPf.snap.snap['ready_s14|kitchen'] || 0) - (curReady || 0);
  const readyRow = {
    produced: stats.producedPortions, producedServer,
    consumedNeed, consumedShort, consumedActual,
    measuredDelta: round(measuredReady, 4),
    formula: 'produced - consumedActual == -measuredDelta',
    check: Math.abs((stats.producedPortions - consumedActual) + measuredReady) < 1e-6,
  };

  return { detail, mismatches, readyRow, producedServer, okCount };
}
function nameKey(items, id) {
  const it = (items || []).find(x => x.id === id);
  return it && it.name;
}
function nameKeyPf(items, id, loc) {
  const it = (items || []).find(x => x.id === id && (x.location || 'workshop') === loc);
  return it && it.name;
}

// ═══════════════ Основной прогон ═══════════════
(async () => {
  // ── токен ──
  if (!TOKEN) {
    TOKEN = process.env.YAYA_TOKEN || '';
    if (!TOKEN && process.env.DAYSIM_TOKEN_FILE) {
      try { TOKEN = fs.readFileSync(process.env.DAYSIM_TOKEN_FILE, 'utf8').trim(); } catch (e) {}
    }
  }
  if (!TOKEN) { console.error('Нет MANAGER-токена: задайте YAYA_TOKEN или DAYSIM_TOKEN_FILE'); process.exit(2); }

  // ── данные сервера: меню + техкарты + cook-recipes ──
  const menuR = await call('GET', '/kv/yaya_menu', EP.GET_KV);
  const tcR = await call('GET', '/kv/yaya_tech_v3', EP.GET_KV);
  const crR = await call('GET', '/cook-recipes', EP.GET_COOKREC);
  const menu = menuR.body && menuR.body.value || {};
  const tc = tcR.body && tcR.body.value || {};
  const cookRecipes = Array.isArray(crR.body) ? crR.body : [];
  const dishById = {};
  for (const cat of (menu.categories || [])) for (const it of (cat.items || [])) dishById[it.id] = it;
  const dishes = Object.keys(tc).filter(id => Array.isArray(tc[id]) && tc[id].length && dishById[id]);
  if (dishes.length < 10) { console.error('Мало блюд с техкартами на сервере:', dishes.length); process.exit(3); }
  const friesPool = ['s14', 'b26', 'b27', 'b30', 'b31', 'd38', 'd39', 's1', 's4', 's5'].filter(id => tc[id] && tc[id].length);
  const nonFries = dishes.filter(id => !friesPool.includes(id));
  for (const id of dishes) {
    friesQty[id] = (tc[id] || []).filter(r => r.ingId === CFG.POOL_ID).reduce((s, r) => s + Number(r.qty), 0);
  }
  const delaySim = () => { const acc = CFG.ACCEPT_MIN * 60 / CFG.COMPRESS, cook = CFG.COOK_MIN * 60 / CFG.COMPRESS; return round(acc + cook, 2); };

  // корзины
  const baskets = genArrivals(CFG.ORDERS).map(a => {
    const n = CFG.BASKET_MIN + Math.floor(Math.random() * (CFG.BASKET_MAX - CFG.BASKET_MIN + 1));
    const items = [];
    const isFries = Math.random() < CFG.FRIES_SHARE;
    if (isFries && friesPool.length) items.push(friesPool[Math.floor(Math.random() * friesPool.length)]);
    let guard = 0;
    while (items.length < n && guard++ < 40) {
      const pool2 = items.length ? nonFries : (Math.random() < CFG.FRIES_SHARE ? friesPool : nonFries);
      if (!pool2.length) break;
      const d = pool2[Math.floor(Math.random() * pool2.length)];
      if (!items.includes(d)) items.push(d);
    }
    const lines = items.map(id => ({ id, name: (dishById[id] && dishById[id].name) || id, qty: 1 }));
    return Object.assign(a, {
      items: lines,
      total: lines.reduce((s, l) => s + ((dishById[l.id] && dishById[l.id].price) || 2000), 0) + (Math.random() < 0.3 ? 1000 : 0),
      token: 'o' + Math.random().toString(36).slice(2, 10),
      final: null, num: null, id: null, doneShorts: [],
    });
  });
  const plannedFries = baskets.reduce((s, b) => s + b.items.reduce((x, it) => x + (friesQty[it.id] || 0) * it.qty, 0), 0);
  let cum = 0; friesCum = baskets.map(b => { cum += b.items.reduce((x, it) => x + (friesQty[it.id] || 0) * it.qty, 0); return { at: b.atSim, cum }; });

  console.log('[day-sim] день', (CFG.DAY_END_H - CFG.DAY_START_H) + 'ч →', round(DURATION_S, 0) + 'с (SPEED=' + CFG.SPEED + ') | заказов:', CFG.ORDERS,
    '| блюд с техкартой:', dishes.length, '| фри-пул:', friesPool.length, '| фри-порций запланировано:', round(plannedFries, 1), '| сервис-время на заказ (sim):', delaySim() + 'с');

  // ── 1. reset-orders (бэкап #1) ──
  const r1 = await call('POST', '/admin/reset-orders', EP.RESET, { confirm: true, confirm_phrase: 'DELETE ALL ORDERS', start_num: CFG.RESET_START_NUM });
  if (r1.status !== 200 || !r1.body || !r1.body.ok) { console.error('reset-orders не удался:', r1.status, JSON.stringify(r1.body)); process.exit(4); }
  const backup1 = r1.body.backup_key;
  console.log('[reset] бэкап #1:', backup1, '| очищено:', JSON.stringify(r1.body.cleared));

  // ── 2. снапшот ──
  const sSnap = await stockSnap(), pSnap = await pfSnap();
  const cookLogBeforeR = await call('GET', '/cook-log', EP.GET_COOKLOG);
  const cookLogBefore = cookLogBeforeR.body && cookLogBeforeR.body.items;
  console.log('[snapshot] stock:', Object.keys(sSnap.snap.snap).length, '| pf:', Object.keys(pSnap.snap.snap).length);

  // ── 3. прогон ──
  startWall = Date.now();
  console.log('[sim] старт', ts(), '| DURATION_S =', DURATION_S);
  let allArrivals = baskets.slice();
  const pump = setInterval(() => {
    try {
      pumpTick();
    } catch (e) { console.error('[pump] tick error:', e); }
  }, CFG.TICK_MS);
  function pumpTick() {
    const now = simNow();
    let guard = 2000;
    while (allArrivals.length && allArrivals[0].atSim <= now && guard-- > 0) {
      const b = allArrivals.shift();
      runOrder(b).catch(e => { console.error('[order] async:', String(e)); stats.leftover++; liveOrders.delete(b.token); });
    }
    guard = 4000;
    while (events.length && events[0].at <= now && guard-- > 0) {
      const ev = events.shift();
      ev.fn().catch(e => { console.error('[event] async:', String(e)); });
    }
    cookAhead(now).catch(e => console.error('[cookAhead]', String(e)));
    sampleConcurrency(now);
    if (!lastTickPrint || now - lastTickPrint > 60) {
      lastTickPrint = now;
      console.log('[tick]', round(now, 0) + 'с', '| arrivals left:', allArrivals.length, '| events:', events.length, '| inflight:', inflightCreate, '| live orders:', liveOrders.size, '| done:', stats.done, 'cancel:', stats.cancel, 'leftover:', stats.leftover);
    }
    const wall = (Date.now() - startWall) / 60000;
    if ((allArrivals.length === 0 && events.length === 0 && inflightCreate === 0 && liveOrders.size === 0) || wall > CFG.MAX_WALL_MIN) {
      clearInterval(pump);
      if (wall > CFG.MAX_WALL_MIN) { console.error('[sim] ТАЙМАУТ, leftover возможен'); }
    }
  }

  // ждём завершения pump'а
  await new Promise(res => {
    const done = () => {
      const wall = (Date.now() - startWall) / 60000;
      if ((allArrivals.length === 0 && events.length === 0 && inflightCreate === 0 && liveOrders.size === 0) || wall > CFG.MAX_WALL_MIN) return res();
      setTimeout(done, 500);
    };
    setTimeout(done, 500);
  });
  stats.leftover = stats.created - stats.done - stats.cancel;
  console.log('[sim] финиш', ts(), '| создано:', stats.created, '| done:', stats.done, '| cancel:', stats.cancel, '| leftover:', stats.leftover);

  // ── 4. сходимость ──
  const ordersR = await call('GET', '/orders?limit=300', EP.GET_ORDERS);
  const serverOrders = (ordersR.body && ordersR.body.orders) || [];
  const byStatus = { new: 0, cook: 0, done: 0, cancel: 0 };
  for (const o of serverOrders) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  stats.byStatusServer = byStatus;
  const finalOrders = baskets.filter(b => b.final);
  const rec = await reconcile(sSnap, pSnap, finalOrders, cookLogBefore);
  const created = stats.created;
  const orderMatch = created === byStatus.new + byStatus.cook + byStatus.done + byStatus.cancel;

  // ── 5. восстановление ──
  const resDiffs = [];
  const curS = await stockSnap();
  for (const id of Object.keys(sSnap.snap.snap)) {
    const q = sSnap.snap.snap[id];
    if (Math.abs((curS.snap.snap[id] != null ? curS.snap.snap[id] : 0) - q) > 1e-9) {
      await call('PATCH', '/stock/' + encodeURIComponent(id), EP.PATCH_STOCK, { qty: q });
    }
  }
  const curP = await pfSnap();
  for (const k of Object.keys(pSnap.snap.snap)) {
    const [id] = k.split('|');
    const q = pSnap.snap.snap[k];
    await call('PATCH', '/pf-stock/' + encodeURIComponent(id), EP.PATCH_PF, { qty: q });
  }
  const r2 = await call('POST', '/admin/reset-orders', EP.RESET, { confirm: true, confirm_phrase: 'DELETE ALL ORDERS', start_num: CFG.RESET_START_NUM });
  const backup2 = r2.body && r2.body.backup_key;
  const vS = await stockSnap(), vP = await pfSnap();
  for (const id of Object.keys(sSnap.snap.snap)) {
    const want = sSnap.snap.snap[id], got = vS.snap.snap[id];
    if (Math.abs(want - got) > 1e-9) resDiffs.push({ key: 's:' + id, want, got });
  }
  for (const k of Object.keys(pSnap.snap.snap)) {
    const want = pSnap.snap.snap[k], got = vP.snap.snap[k];
    if (Math.abs(want - got) > 1e-9) resDiffs.push({ key: 'pf:' + k, want, got });
  }
  console.log('[restore] бэкап #2:', backup2, '| остаточные расхождения:', resDiffs.length);

  // ── отчёт ──
  const wallMin = round((Date.now() - startWall) / 60000, 1);
  const offeredPerMin = round(CFG.ORDERS / (DURATION_S / 60), 1);
  const effectivePerMin = round(stats.created / Math.max(wallMin / 60, 0.0001), 1);
  const report = {
    meta: { startedAt: ts(), wallMin, simDaySec: round(DURATION_S, 0), speed: CFG.SPEED, compress: CFG.COMPRESS, config: CFG },
    orderAccounting: {
      created, done: stats.done, cancelled: stats.cancel, leftover: stats.leftover,
      serverByStatus: byStatus, orderMatch, formula: 'created == done + cancelled + leftover', ok: orderMatch,
    },
    arrivals: { planned: CFG.ORDERS, friesPortionsPlanned: round(plannedFries, 1), peakRatePerMin: round(1 / (0.0001 + Math.min(...baskets.map((b, i, a) => a[i + 1] ? a[i + 1].atSim - b.atSim : 999)) * 60 / CFG.SPEED), 0) },
    concurrency: { peak: stats.concurrencyPeak, peakSim: stats.concurrencyPeakSim, samples: stats.concurrencySamples.length },
    throughput: { offeredPerMin, effectivePerMin, creationWallMs: round(stats.creationWallMs / 1000, 1) },
    latency: percentileReport(),
    errors: { order429Count: stats.order429Count, order429Sample: stats.order429.slice(0, 25) },
    pool: {
      producedPortions: stats.producedPortions, producedKg: stats.producedKg,
      producedServer: rec.producedServer, cookBatches: stats.cookBatches,
      cookRejected400: stats.cookRejected400.length, cookRejected400Sample: stats.cookRejected400.slice(0, 10),
      readyShortOrders: stats.readyShortOrders, shortagesTotal: stats.shortages.length,
    },
    shortages: stats.shortages.slice(0, 100),
    consumption: rec.detail.filter(r => r.mismatch),
    reconciliation: {
      mismatches: rec.mismatches,
      ready_s14: rec.readyRow,
      ready_s14FormulaOk: rec.readyRow.check,
      journalTotalItems: rec.detail.length,
    },
    restore: { backup1, backup2, residualDiffs: resDiffs },
    whereItBreaks: [],
  };

  // «ГДЕ РВЁТСЯ»
  const wib = [];
  if (stats.order429Count > 0) wib.push('Потолок создания заказов: POST /order 20/мин на IP → ' + stats.order429Count + ' × 429; effective ' + effectivePerMin + '/мин vs offered ' + offeredPerMin + '/мин (создание заняло ' + report.throughput.creationWallMs + 'с).');
  if (rec.readyRow.consumedShort > 0) wib.push('Недостача пула ready_s14: ' + rec.readyRow.consumedShort + ' порций (shortage на заказах), минимум спроса vs производства.');
  if (stats.cookRejected400.length) wib.push('Готовка упирается в сырьё: POST /cook 400 × ' + stats.cookRejected400.length + ' — r31 кончается, потолок ≈ ' + round((stats.producedKg), 2) + ' кг.');
  if (rec.mismatches.length) {
    const clamp = rec.mismatches.filter(m => /^s:/.test(m.key));
    wib.push('Расхождение журнал↔остаток по ' + rec.mismatches.length + ' позициям (напр. ' + rec.mismatches.slice(0, 5).map(m => m.key).join(', ') + ') — при нулевом остатке applyTechCard пишет полное списание, остаток клипится на 0.');
  }
  if (resDiffs.length) wib.push('Восстановление ПФ не идеально: ' + resDiffs.map(d => d.key + ' want ' + d.want + ' got ' + d.got).join('; ') + ' — PATCH /pf-stock/:id пишет все локации id, много-локационные позиции (p4) не восстановить точно.');
  const pfShorts = stats.shortages.filter(s => s.id !== CFG.POOL_ID).length;
  if (pfShorts > 0) wib.push('НЕДОСТАЧА ПФ в кафе × ' + pfShorts + ' — блюда едят ПФ (p1..p10), которых нет в pf_stock kitchen (готовят в цеху): заказ проходит, пул не пополняется.');
  if (!orderMatch) wib.push('Счётчик заказов не сошёлся: created ' + created + ' vs сервер ' + JSON.stringify(byStatus));
  if (!rec.readyRow.check) wib.push('Формула ready_s14 (произведено − потреблено == Δ) НЕ сошлась.');
  report.whereItBreaks = wib;

  console.log('── ГДЕ РВЁТСЯ ──');
  for (const w of wib) console.log('•', w);
  console.log('── ready_s14 формула ──', JSON.stringify(rec.readyRow));
  console.log('── mismatches ──', rec.mismatches.length);
  fs.writeFileSync(CFG.REPORT_FILE, JSON.stringify(report, null, 2));
  console.log('── отчёт сохранён:', CFG.REPORT_FILE, '──');
  console.log('backup_keys:', JSON.stringify([backup1, backup2]));
  process.exit(0);
})().catch(e => { console.error('[day-sim] fatal:', e); process.exit(1); });
