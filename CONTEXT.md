Правь на месте при изменении кода, НЕ дописывай.

# CONTEXT — yaya-db (сервер)

## 1. Назначение репо
Единый бэкенд и API для всех клиентов YaYa Chicken — Node/Express + Postgres (Railway) — общее хранилище для системы учёта и заказов витрины (package.json). URL: https://yaya-db-production.up.railway.app.

## 2. Стек и точка входа
Node >=18, Express ^4.19, pg ^8.11 (Postgres), web-push ^3.6 (VAPID). Корень/точка входа — server.js (`npm start`, PORT env или 3000); server.js сам создаёт схему БД и стартует только после initDb. seed.js — только данные для сида пустых таблиц. Роутов/README нет.

## 3. Структура
- server.js — весь бэкенд: инициализация схемы, KV-слой, роли/авторизация, все эндпоинты, web-push, идемпотентные миграции.
- seed.js — дефолтные данные: stock (сырьё), pf_stock (полуфабрикаты), ws-рецепты, cook-рецепты, техкарты заказов; применяются только при пустых таблицах/отсутствующих KV-ключах.
- tools/day-sim.cjs — симулятор рабочего дня (генерит заказы/готовку/списание) против production API, требует MANAGER-токен (env YAYA_TOKEN); пишет отчёт.
- tools/day-sim-report.json — отчёт последнего прогона day-sim.

## 4. Публичные интерфейсы (API)
Токен: X-Admin-Token | X-Token | ?token; курьер дополнительно — X-Courier-Name. Роли: MANAGER, SUPERVISOR, ASSEMBLER, WORKSHOP, KITCHEN, BUYER, COURIER.

Публичные (без авторизации):
- GET /health — health, флаги auth/push
- GET /auth-check — проверка токена, возвращает роль (limit 20/мин)
- GET /next-order-num — следующий номер заказа (30/мин)
- POST /order — принять заказ витрины (20/мин)
- GET /orders/status?nums= — статусы заказов витрины по номерам (120/мин)
- GET /kv/:key — только ключи PUBLIC_READ: yaya_radio, yaya_tv, yaya_menu, yaya_stock, yaya_banners, yaya_promos, yaya_courier_pos, yaya_greetings, yaya_greet
- POST /kv/:key/append — публично только для yaya_greet_req (20/мин)
- GET /push/public-key — VAPID-ключ
- POST /push/subscribe — подписка (role из body: admin/courier/workshop/kitchen/buyer/client)
- GET /push/status — статистика подписок и статус push

Роль-гейтед:
- GET /kv/:key — любая роль; курьер-токен + X-Courier-Name — только COURIER_KV
- PUT /kv/:key — MANAGER; курьер-токен — только yaya_order_couriers/yaya_courier_pos/yaya_couriers
- POST /kv/:key/append — MANAGER (кроме публичного yaya_greet_req)
- GET /purchase-assign — любая роль
- PUT /purchase-assign — MANAGER; значение позиции: строка '🚚'|'🛍'|'🛒' либо {t:'🧾',sum,performer}; performer сохраняется только из ['BUYER','MANAGER','SUPPLIER'] (иначе поле отбрасывается); sum≤0 → '🛒'
- GET /settings — любая роль
- PUT /settings — MANAGER
- GET /keys — MANAGER
- POST /keys/:role/rotate — MANAGER (новая access_keys-токен роли)
- GET /stock?location= — любая роль
- PATCH /stock/:id — MANAGER/WORKSHOP/KITCHEN (+ гейт по location) — пересчёт qty или delta, журнал + media
- POST /stock — MANAGER/WORKSHOP/KITCHEN (+ гейт по location) — добавить позицию
- DELETE /stock/:id — MANAGER/WORKSHOP/KITCHEN (+ гейт по location)
- POST /stock/:id/receive — MANAGER/BUYER — приход на склад, покупка status=accepted
- POST /stock/:id/deliver — MANAGER/BUYER — создаёт поставку status=pending (склад не меняется)
  - оба INSERT в purchases пишут assign_type, assign_sum, performer из снимка assign-KV на момент проведения: performer = маппинг типа (🛍→BUYER, 🛒→MANAGER, 🚚→SUPPLIER) либо явный aEntry.performer для 🧾; created_by — роль токена
- GET /purchases?status=&location=&from=&to= — любая роль; from/to — эпоха ms, полуинтервал [from,to) по ts (TIMESTAMPTZ), необязательны, комбинируются со status/location
- GET /purchases/:id/media — любая роль
- GET /supply-log?from=&to= — MANAGER — лента assigned (supply_assign_log) + delivered (purchases, assign_type NOT NULL); delivered-записи несут location, status (pending/accepted/rejected), performer, accepted_by, created_by; даты — epoch ms; фильтр по статусу — на клиенте
- POST /deliveries/:id/accept — MANAGER/WORKSHOP/KITCHEN (+ гейт по location поставки), body.recv_qty — факт
- POST /deliveries/:id/reject — MANAGER/WORKSHOP/KITCHEN (+ гейт по location), body.reason
- POST /deliveries/:id/cancel — MANAGER/BUYER (только pending)
- GET /pf-stock — любая роль
- PATCH /pf-stock/:id — MANAGER/WORKSHOP/KITCHEN — пересчёт остатка ПФ (без гейта location)
- GET /deductions — любая роль
- GET /deductions/:id/media — любая роль
- GET /transfers — любая роль — журнал свершившихся передач: SELECT id, ts, dir, from_name, to_name, qty, unit, emp, status, performer, accepted_by FROM transfers WHERE status <> 'pending' ORDER BY ts DESC LIMIT 2000; к каждой шапке приклеен состав пачки одним батч-запросом transfer_items (без N+1). Ответ {ok:true, items:[{..., ts(epoch ms), pf_items:[{item_id,name,qty,unit}]}]}; у старых записей без transfer_items pf_items=[]
- GET /cook-log — любая роль
- GET /production-log — любая роль
- POST /deductions — любая роль
- POST /transfers — MANAGER/WORKSHOP/KITCHEN
- POST /cook-log — MANAGER/KITCHEN
- POST /production-log — MANAGER/WORKSHOP
- POST /produce — MANAGER/WORKSHOP — производство ПФ цеха (сырьё → pf_stock workshop)
- GET /cook-recipes — MANAGER/KITCHEN
- POST /cook — MANAGER/KITCHEN — сырьё → готовые порции (pf_stock kitchen, ready_<dishId>)
- POST /transfer — MANAGER/WORKSHOP/KITCHEN — ПАЧКА передач ПФ, body {dir:'ws-ks'|'ks-ws', items:[{fromId,qty}]} (оба направления совместимы со старым одиночным {fromId,qty} — оборачивается в items). ws-ks (двухфазный): списывает у цеха (pf_stock workshop) атомарно, создаёт пачку transfers status='pending' + transfer_items, performer='BUYER', кухне НЕ зачисляет (зачисление — только на /transfers/:id/accept). ks-ws (МГНОВЕННАЯ ПАЧКА): списывает у кухни + зачисляет цеху в ОДНОМ COMMIT (без приёмки), шапка transfers status='accepted' (from_name=to_name=headName «имя первой позиции [+N]», qty=сумма пачки, accepted_by=роль) + transfer_items + deductions '[КУХНЯ→ЦЕХ]' по позициям; нехватка любой позиции → полный ROLLBACK; ответ {ok:true, transfer_id, count}
- POST /transfers/:id/accept — MANAGER/KITCHEN — кухня принимает pending-пачку: зачисляет позиции на склад кухни (pf_stock location='kitchen', ON CONFLICT (id,location) += qty), status='accepted'
- POST /transfers/:id/reject — MANAGER/KITCHEN — кухня отклоняет pending-пачку: возвращает объём цеху (pf_stock location='workshop'), status='rejected'
- GET /transfers/incoming — MANAGER/KITCHEN — pending-пачки ws-ks с items [{item_id,name,qty,unit}]
- GET /transfers/outgoing — MANAGER/WORKSHOP — то же, для цеха
- GET /orders — любая роль; COURIER видит только свои (X-Courier-Name/?me)
- POST /orders/:id/status — MANAGER/SUPERVISOR/ASSEMBLER — cook/done/cancel, автосписание по техкарте
- POST /orders/:id/fulfill — MANAGER/SUPERVISOR/ASSEMBLER — mode cafe|pickup|courier
- POST /admin/reset-orders — MANAGER, 3/мин — очистка заказов с бэкапом в KV
- POST /push/notify-courier — MANAGER
- POST /push/test — MANAGER

### Таблицы pf_requests и buy_snapshots (сессия 2026-08)

**pf_requests** — заявки кухни цеху на дослать ПФ до нормы. Колонки: id (TEXT PK), item_id, name, qty, unit, from_loc (DEFAULT 'kitchen'), status (open|done, DEFAULT 'open'), created_at. Партиал-индекс `idx_pfreq_open` на `(item_id, from_loc) WHERE status='open'` — одна открытая заявка на ПФ+локацию.

- POST /pf-requests (MANAGER, KITCHEN): body `{item_id}`. Читает pf_stock(kitchen), считает `need=round(min*1.5 − qty)`, need≤0 → `{ok,skip:true}`. UPSERT открытой заявки: сначала UPDATE qty, если 0 строк → INSERT (id='pfr'+Date.now()+rand). Не ON CONFLICT — индекс партиальный, не детерминирует INSERT.
- GET /pf-requests (MANAGER, KITCHEN, WORKSHOP): `?status` фильтр, ORDER BY created_at DESC. АВТО-ЗАКРЫТИЕ: перед SELECT — UPDATE open→done для заявок, где pf_stock(kitchen) вышел в норму (`min>0 AND qty>=min*1.5`). UPDATE обёрнут в inner try/catch — падение не роняет GET, SELECT отдаёт актуальный список. Так заявки гаснут сами, когда цех дошлёт ПФ и кухня примет.

**buy_snapshots** — дневные снимки дефицита закупки. Колонки: snap_date (DATE), item_id, name, qty, min, need, unit, location. PK `(snap_date, item_id)`.

- ensureSnapshot() вызывается fire-and-forget из GET /stock: при первом заходе за день (нет строк за CURRENT_DATE) фиксирует срез дефицита (`qty < min*1.5 AND min>0, need>0`). Идемпотентна. Крона нет — снимок = первый заход дня; нет захода = нет снимка за день. История копится только с деплоя, задним числом не наполняется.
- GET /buy-snapshots (MANAGER, BUYER): period=day (`?date=YYYY-MM-DD`, дефолт сегодня) / month (`?ym=YYYY-MM`) / year (`?y=YYYY`). month/year — агрегат `MAX(need)` по item_id (пиковая потребность за период).
- GET /buy-snapshots/dates (MANAGER, BUYER): DISTINCT snap_date.

## 5. Внешние связи — кто обращается к серверу
Все 4 фронтенда обращаются к ОДНОМУ серверу (один Postgres, один VAPID):
- yaya-kitchen (public): POST /order, GET /next-order-num, GET /orders/status, GET/PUT /kv/* (yaya_menu, yaya_banners, yaya_tv*, yaya_greet_req), /push/public-key, /push/subscribe.
- yaya-chicken-admin (MANAGER/SUPERVISOR/ASSEMBLER): /auth-check, /orders, /orders/:id/status, /orders/:id/fulfill, /admin/reset-orders, /kv/* (yaya_menu, yaya_stock, yaya_banners, yaya_tv, yaya_couriers, yaya_order_couriers), /push/* (notify-courier, status, test), /settings, /keys.
- yaya-chicken-courier (COURIER): /auth-check, /orders, /orders/:id/status, /kv/* (yaya_order_couriers, yaya_courier_pos, yaya_couriers).
- yaya-kabinet (учёт, роль-гейтед): /stock*, /pf-stock*, /purchases, /purchase-assign, /deliveries/:id/(accept|reject|cancel), /deductions*, /transfers|/transfer, /produce, /cook*, /production-log, /cook-log, /settings, /keys, /kv/*.
- Внутри репо: tools/day-sim.cjs дёргает тот же API (MANAGER-токен; YAYA_API).

KV — межрепный контракт: yaya_menu (admin/kabinet→kitchen/kabinet), yaya_order_couriers/yaya_courier_pos (admin↔courier), yaya_banners/tv (admin→kitchen). Смена схемы значения KV — скрытая поломка у другого репо.

## 6. Готчи
- KV: таблица kv(k PK, v jsonb, updated_at) + хелперы kvGet/kvSet. Ключи: публичное чтение — yaya_radio, yaya_tv, yaya_menu, yaya_stock, yaya_banners, yaya_promos, yaya_courier_pos, yaya_greetings, yaya_greet; публичный append — yaya_greet_req; курьерские (чтение + PUT курьером) — yaya_order_couriers, yaya_courier_pos, yaya_couriers; серверные — yaya_push_subs ({admin, couriers, orders, roles}), yaya_tech_v3 (техкарты), yaya_wsrecipes_v3, yaya_cookrecipes_v1, yaya_settings (cook_minutes, fulfill_minutes), yaya_purchase_assign_v1; маркеры миграций — yaya_migr_ready_fries_v1, yaya_migr_ready_r31_v1; бэкапы — yaya_flip_r31_backup_<ts>, yaya_schema_backup_<ts>, yaya_orders_backup_<ts>.
- Роли: ALL_ROLES = [MANAGER, SUPERVISOR, ASSEMBLER, WORKSHOP, KITCHEN, BUYER, COURIER]; requireRole/requireAnyRole. Токены ролей: код поддерживает env-путь для ВСЕХ ролей — ROLE_ENV (server.js) читает SUPERVISOR_TOKEN/ASSEMBLER_TOKEN/WORKSHOP_TOKEN/KITCHEN_TOKEN/BUYER_TOKEN (+ YA_*-варианты) и при старте бутстрапит их в таблицу access_keys. На проде (Railway) заданы только ADMIN_TOKEN (=роль MANAGER) и courier_token (=роль COURIER); токены остальных ролей на проде из env НЕ приходят, а живут в access_keys (ротация POST /keys/:role/rotate, только MANAGER). roleOf напрямую сверяет только env ADMIN_TOKEN/MANAGER_TOKEN→MANAGER и courier_token→COURIER; источник правды по правам — Postgres.
- Источник правды — Postgres. env: ADMIN_TOKEN, MANAGER_TOKEN, courier_token, DATABASE_URL, VAPID_PUBLIC/PRIVATE/SUBJECT, PORT.
- CORS: Access-Control-Allow-Origin: *; методы GET,POST,PUT,PATCH,DELETE,OPTIONS; заголовки Content-Type,X-Admin-Token,X-Token,X-Courier-Name.
- Единая VAPID-пара: /push/public-key, /push/subscribe (KV yaya_push_subs), /push/notify-courier (MANAGER). Клиентские пуши — по номеру заказа: store.orders[<num>]. Роли-пуши — store.roles[kitchen|workshop|buyer].
- PUT /kv/yaya_order_couriers триггерит пуши клиентам при смене delivery_status (on_way→'Курьер в пути', delivered→'Заказ доставлен'); /admin/reset-orders чистит этот ключ и store.orders.
- Жизненный цикл заказа: new→cook→done→fulfilled (или cancel). Списание по yaya_tech_v3 — единожды при done (флаг deducted); cancel возвращает остатки. Нехватка ПФ кафе (location='kitchen') — списывается что есть, остаток логируется как 'НЕДОСТАЧА ПФ в кафе' и возвращается в shortage/deduct_shortage (вариант B).
- Передачи ПФ цех↔кухня: ОБЕ ветки POST /transfer пишут transfer_items. ws-ks — двухфазная (цех списывает сразу → transfers status='pending', кухня зачисляет на /transfers/:id/accept, reject возвращает объём цеху); «В пути» = pending-пачка — на складах НЕ отражается. ks-ws — мгновенная (кухня списывается и цех зачисляется одним COMMIT, status='accepted'). GET /transfers для журнала менеджера исключает pending (только свершившиеся: accepted/rejected) и отдаёт состав пачек в pf_items.
- initDb на старте: CREATE TABLE IF NOT EXISTS (kv, orders, stock, pf_stock, deductions, transfers, cook_log, production_log, purchases, purchase_media, deduction_media, access_keys, seq order_num_seq) → migrateSchema (pf_stock составной PK (id,location), колонки crit/max) → идемпотентные ALTER TABLE purchases ADD COLUMN: assign_type, assign_sum, performer (TEXT); двухфазные передачи ПФ: transfers ADD COLUMN status (БЕЗ DEFAULT → backfill старых записей в 'accepted' → DEFAULT 'pending'), accepted_by, accepted_at, performer; CREATE TABLE transfer_items (id BIGSERIAL PK, transfer_id BIGINT FK→transfers(id), item_id TEXT NOT NULL, name, qty NUMERIC NOT NULL, unit; индекс idx_transfer_items_transfer) → seedIfEmpty (сиды + бутстрап access_keys из ROLE_ENV) → migrateReadyR31; при ошибке — process.exit(1). pf_stock без изменений (PK id+location).
- Миграции фри: migrateReadyFries (r31→ready_s14, 1 порция=0.2кг) определена, но в initDb НЕ вызывается; активная — migrateReadyR31 (ready_s14→r31, с бэкапом yaya_flip_r31_backup_<ts>, при отсутствии техкарт — громкое падение).
- Гейты по location: stock — WORKSHOP только 'workshop', KITCHEN только 'kitchen', MANAGER всё; /deliveries/:id accept|reject — по location поставки; PATCH /pf-stock/:id и /transfer — гейта location НЕТ.
- Rate-limit в памяти (Map, ключ ip|path, сбрасывается при рестарте): /auth-check 20/мин, /next-order-num 30/мин, /order 20/мин, /orders/status 120/мин, /kv/:key/append 20/мин, /admin/reset-orders 3/мин.
- POST /order: при body.type='RECEIPT' пуш админу не отправляется.
- GET /orders для курьера: фильтр по нормализованному имени (lowercase, ё→е, схлопывание пробелов) из X-Courier-Name/?me против yaya_order_couriers[<id>].courier; к env-курьеру применимо так же.
- /auth-check: ADMIN_TOKEN→role 'admin', MANAGER_TOKEN→'MANAGER', courier_token→'courier' (lowercase), токены access_keys→своя роль; AUTH_ON = наличие ADMIN/MANAGER env.
- express.json limit '2mb'; app.set('trust proxy', 1); OPTIONS → 204.
- Гонка двух параллельных POST /pf-requests по одному item_id: второй ловит UNIQUE-violation `idx_pfreq_open` → 500. Данные целы, дубля нет; редкий кейс (одна кухня, два клика в секунду).
