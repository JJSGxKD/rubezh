---
id: T-0386
title: Пул Xray — учёт трафика по узлу и подписке
epic: E13
priority: P2
status: ready
owner:
author: claude-lead2-4
size: M
depends_on: [T-0384]
zones:
  - packages/proxy-kit/src/xray-config.ts
  - packages/proxy-kit/src/xray-stats.ts
  - packages/proxy-kit/test/xray-config.test.ts
  - packages/proxy-kit/test/xray-stats.test.ts
  - packages/proxy-kit/test/fixtures/xray/**
  - backend/api/src/modules/proxies/subscription/traffic/**
  - backend/api/src/modules/proxies/subscription/xray-config-assembly.ts
  - backend/api/src/modules/proxies/proxies.module.ts
  - backend/api/src/modules/admin/admin-proxy-traffic.controller.ts
  - backend/api/test/proxy-traffic.test.ts
  - backend/api/test/proxy-traffic.integration.test.ts
  - apps/admin/src/api/proxy-traffic.ts
  - apps/admin/src/screens/proxies/TrafficPanel.tsx
  - apps/admin/src/screens/proxies/traffic-view.ts
  - apps/admin/src/screens/proxies/ProxiesScreen.tsx
  - apps/admin/test/proxy-traffic.test.ts
shared:
  - packages/proxy-kit/src/index.ts
  - packages/proxy-kit/README.md
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/config/app-config.ts
  - .env.example
  - infra/prod/api.env.example
  - apps/admin/src/ui/help.ts
  - docs/20-env-and-ports.md
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 5
---

# T-0386. Пул Xray — учёт трафика по узлу и подписке

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0386.json)](README.md#значки-статуса) [![T-0384](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0384.json&label=T-0384)](T-0384-xray-multi-subscription.md)

## Зачем

Сколько трафика сервер прогоняет через каждый узел и каждую подписку, сейчас не
видно. Есть только цифра поставщика из `subscription-userinfo`, и она общая на все
его устройства. Р192 требует считать трафик ядром Xray по узлу и подписке и
показывать его за сутки, неделю и месяц.

## Решения

- **Р192** (`docs/35-stage4-plan.md`): учёт трафика ядром Xray по узлу и подписке за
  день, неделю и месяц.
- **Р101, T-0093**: спутник Xray — без TUN, порты не публикуются, сеть `tunnel`
  (`internal: true`) общая только у API и Xray; контейнер `read_only`, `cap_drop: [ALL]`.
- **T-0384**: тег выхода — `out-<ключ подписки>-<ключ узла>`. По нему счётчик
  относится к узлу и подписке. Конфиг собирает `xray-config-assembly.ts`.

Решения этой спецификации (`claude-lead2-4`, 07.11.2026, в рамках Р192):

- **Счётчики — штатная статистика Xray**: блок `stats`, `policy.system.statsOutboundUplink`
  и `statsOutboundDownlink`, блок `api` только со службой `StatsService`. Других служб
  API Xray (`HandlerService` с правкой выходов на лету и т. п.) нет. Эта служба
  отдаёт только счётчики и их сброс.
- **Сервис статистики слушает внутри сети `tunnel`** — `0.0.0.0:<XRAY_STATS_PORT>`
  в контейнере Xray. Порт не публикуется, в `compose.yml` ничего не меняется: API уже в
  сети `tunnel`. Это не противоречит `read_only` и `cap_drop`: счётчики живут в
  памяти, а слушать порт выше 1024 права не нужны.
- **Чтение — со сбросом** (`QueryStats`, `reset: true`). Каждое чтение возвращает
  трафик с прошлого чтения, и сброс атомарен в самом Xray. Поэтому реплики API
  читают без замка: два чтения не получат одни и те же байты. Запись в базу —
  прибавлением (`ON CONFLICT … DO UPDATE SET up_bytes = up_bytes + EXCLUDED.up_bytes`).
- **Без новых зависимостей.** Запрос gRPC — `node:http2` в бэкенде. Кодирование
  трёх сообщений protobuf и рамки gRPC — чистые функции в `proxy-kit`.
- **Корзины — по часам**, таблица `proxy_traffic_hour`. По нагрузке: 100 узлов × 24 часа =
  2 400 строк в сутки, за срок хранения — около 84 тысяч. Это немного, а часы дают
  честные «последние 24 часа» без поясов. Сутки, неделя и месяц — скользящие окна
  последних 24, 168 и 720 часов, по UTC. Чтение — раз в 60 секунд, байты
  относятся к часу чтения.
- **Срок хранения — 35 суток** (`TRAFFIC_RETENTION_DAYS`): отчёт за месяц — 30 суток и
  запас. Старые строки удаляются раз в час.
- **Перезапуск ядра.** После перезапуска Xray (смена конфига через `run.sh`, падение)
  счётчики начинаются с нуля. При чтении со сбросом это не даёт ни отрицательных, ни
  задвоенных чисел. Теряется трафик между последним чтением и перезапуском. Перед
  записью нового конфига API снимает счётчики (`flush`), поэтому при смене конфига
  теряются секунды до перезапуска, а при падении — до минуты. Это пишется в
  подсказке отчёта.
- **Не удалось записать в базу** — снятые числа держатся в памяти процесса (до
  10 000 строк) и прибавляются на следующем чтении. Если процесс перезапустится
  раньше, числа пропадут: потеря — минута учёта, а не деньги.
- **Без внешнего ключа на подписку.** Строки удалённой подписки в отчёт не попадают:
  отчёт соединяется с живыми подписками. Сами строки уходят по сроку хранения.
  Счётчик тега, который не узел (`block`, `api`, служебные выходы с суффиксом),
  пропускается: служебный выход повторил бы байты своего узла.
- **«Отдано»** — `uplink` (от нас к узлу), **«Получено»** — `downlink`.

## Как сейчас

- `packages/proxy-kit/src/xray-config.ts` (после T-0384): `buildXrayConfig(placed, options)`
  собирает `log`, `inbounds`, `outbounds`, `routing`. Блоков `stats`, `api`, `policy` нет.
  Имена полей — таблица `F`. Золотые файлы — `test/fixtures/xray/*.json`. Их
  прогоняет `infra/prod/xray/check-config.sh` в образе спутника.
- `backend/api/src/modules/proxies/subscription/xray-config-assembly.ts` (T-0384) —
  `assembleConfig(...)` собирает и пишет `config.json`.
- `backend/api/src/config/app-config.ts` ~219–222, 465, 535 — `XRAY_HOST`,
  `XRAY_SOCKS_PORT_BASE`, `XRAY_SLOT_COUNT`, `XRAY_CONFIG_PATH`, проверка
  `base + count ≤ 65535`, `config.xray`.
- `infra/prod/compose.yml` ~186–213 — сервис `xray`: `read_only`, `cap_drop: [ALL]`,
  сети `tunnel`, `tunnel-egress`. API — в `tunnel` (~58).
- Образец таймера без замка — `subscription.scheduler.ts` (`setInterval`, `unref`,
  `autostart`). Плана вайпа для новой модели нет.
- **Ошибки запросов в панели** — так, как в `dev` на день работы: T-0374 (пачка 4) заводит
  `toastError(error)` и строку подробностей в `ErrorNotice`. Влита — новые компоненты
  зовут её, а не `toast.error(result.error.message)`.
- `docs/20-env-and-ports.md` §2 — карта портов: строка спутника Xray занимает
  `10800`–`10899` под SOCKS-входы. **Порта для статистики в карте нет** — раздел
  «Вопросы к тимлиду».

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Порт — по процедуре `docs/20-env-and-ports.md` §7.** Строка в §2: «Спутник Xray,
   статистика узлов (Р192) — `XRAY_STATS_PORT` — dev `—` — staging `—` — production
   **не публикуется**: внутри сети `tunnel`, порт `10799`». Затем
   `.env.example` и `infra/prod/api.env.example` (`XRAY_STATS_PORT=10799`), Zod в
   `app-config.ts`: `z.coerce.number().int().min(1024).max(65_535).default(10799)`. Refine:
   порт вне `[XRAY_SOCKS_PORT_BASE, XRAY_SOCKS_PORT_BASE + XRAY_SLOT_COUNT)`, иначе
   «XRAY_STATS_PORT пересекается с портами SOCKS-входов Xray». В `config.xray` —
   `statsPort`. Секретов нет, в CI ничего не заводится.
3. **`packages/proxy-kit/src/xray-config.ts`:** в `XrayConfigOptions` —
   `stats?: { port: number }`. Задан — в конфиг добавляются:

   ```json
   "stats": {},
   "api": { "tag": "api", "listen": "<options.listen>:<port>", "services": ["StatsService"] },
   "policy": { "system": { "statsOutboundUplink": true, "statsOutboundDownlink": true } }
   ```

   Имена — в таблицу `F`. Не задан — конфиг тот же, что сейчас: прежние золотые
   файлы не меняются. Новый золотой файл `test/fixtures/xray/vless-reality-stats.json`.
4. **Проверка в образе** (поэтому `runner: local`): `bash infra/prod/xray/check-config.sh` —
   все золотые файлы `ok`. Затем живая проверка: поднять образ спутника с новым
   золотым конфигом (подстановки — как в `check-config.sh`) и выполнить
   `docker exec <контейнер> xray api statsquery --server=127.0.0.1:<порт> -pattern outbound`.
   Если Xray не принял `api.listen`, взять классическую форму: вход `dokodemo-door`
   с тегом `api-in` на этом порту, `settings.address = "127.0.0.1"`, и первым правилом
   маршрутизации `inboundTag: ["api-in"] → outboundTag: "api"`. В описании PR — какая
   форма принята, вывод `check-config.sh` и `statsquery`.
5. **`packages/proxy-kit/src/xray-stats.ts`** (новый, чистые функции, без сети):
   - `encodeQueryStatsRequest({ pattern: string; reset: boolean }): Uint8Array` —
     protobuf `QueryStatsRequest { string pattern = 1; bool reset = 2; }`;
   - `decodeQueryStatsResponse(bytes: Uint8Array): { name: string; value: bigint }[]` —
     `QueryStatsResponse { repeated Stat stat = 1; }`, `Stat { string name = 1; int64 value = 2; }`.
     Незнакомые поля (типы 0, 1, 2, 5) пропускаются. Обрыв, неверный тип провода,
     длина за концом — `XrayStatsFormatError`;
   - `grpcFrame(message)` и `grpcUnframe(bytes)` — префикс 5 байт (флаг сжатия 0,
     длина uint32 BE). Флаг 1 и неполная рамка — `XrayStatsFormatError`;
   - `STATS_SERVICE_PATH = "/xray.app.stats.command.StatsService/QueryStats"`;
   - `trafficOfStats(stats)` → `{ group: string; nodeKey: string; direction: "up" | "down"; bytes: bigint }[]`.
     Имя `outbound>>>(тег)>>>traffic>>>(uplink|downlink)`, тег — строго
     `^out-([a-z0-9]{1,16})-([0-9a-f]{16})$`. Остальные имена и значения `< 0`
     пропускаются;
   - экспорт из `index.ts`.
6. **Миграция** — после перебазирования на свежий `dev`, без базы (`tasks/README.md`,
   «Общие файлы»). Блок в конце `schema.prisma`:

   ```prisma
   // Трафик узлов Xray по часам (docs/35-stage4-plan.md Р192, T-0386): считает ядро Xray,
   // строки старше 35 суток удаляются. Внешнего ключа на подписку нет: отчёт соединяется с живыми.
   model ProxyTrafficHour {
     hour            DateTime @db.Timestamptz(0)
     subscriptionKey String   @map("subscription_key") @db.VarChar(16)
     nodeKey         String   @map("node_key") @db.VarChar(16)
     /// название узла на последнем чтении: узел мог уйти из подписки
     nodeName        String   @map("node_name") @db.VarChar(80)
     upBytes         BigInt   @map("up_bytes")
     downBytes       BigInt   @map("down_bytes")

     @@id([hour, subscriptionKey, nodeKey])
     @@map("proxy_traffic_hour")
   }
   ```

   В `migration.sql` руками: `CHECK ("up_bytes" >= 0 AND "down_bytes" >= 0)`,
   `CHECK ("hour" = date_trunc('hour', "hour"))`. `wipe-plan.ts`:
   `ProxyTrafficHour: keep("учёт трафика узлов Xray — служебные данные команды, к игрокам не относятся")`
   и счётчик моделей в `wipe-plan.test.ts`.
7. **`subscription/traffic/`** (новый каталог, файлы < 300 строк):
   - `traffic-rules.ts` — `TRAFFIC_RETENTION_DAYS = 35`, `COLLECT_MS = 60_000`,
     `CLEANUP_MS = 3_600_000`, `PENDING_MAX = 10_000`, `STATS_TIMEOUT_MS = 3_000`,
     `PERIOD_HOURS = { day: 24, week: 168, month: 720 }`;
   - `xray-stats.client.ts` — порт `StatsSource { query(reset: true): Promise<{ name: string; value: bigint }[]> }`
     и реализация на `node:http2`: соединение `http://<XRAY_HOST>:<XRAY_STATS_PORT>`,
     `POST`, `:path` — `STATS_SERVICE_PATH`, заголовки `content-type: application/grpc`,
     `te: trailers`. Тело — `grpcFrame(encodeQueryStatsRequest({ pattern: "outbound>>>", reset: true }))`.
     `grpc-status` из трейлеров либо из заголовков (ответ без тела) должен быть `0`.
     Таймаут `STATS_TIMEOUT_MS`, сессия закрывается после вызова. Любой сбой —
     `XrayStatsUnavailableError` без адреса и тела ответа в тексте;
   - `traffic.repository.ts` — `add(rows)`: одним запросом
     `INSERT … SELECT FROM unnest(...) ON CONFLICT (hour, subscription_key, node_key) DO UPDATE SET up_bytes = proxy_traffic_hour.up_bytes + EXCLUDED.up_bytes, down_bytes = … , node_name = EXCLUDED.node_name`.
     Ещё `report(fromHour)`: сумма по `(subscription_key, node_key)` с последним
     `node_name` и `deleteBefore(hour)`;
   - `traffic.collector.ts` — `TrafficCollector` (`OnApplicationBootstrap`,
     `OnModuleDestroy`, таймер `unref`, `autostart: config.databaseUrl !== ""`):
     `collect(now)` — `query` → `trafficOfStats` → строки часа
     `date_trunc('hour', now)` с названиями из `SubscriptionRepository.list()`
     (нет узла — `node_name` = ключ узла) → вместе с отложенными → `add`. Не
     записалось — строки в отложенные (сверх `PENDING_MAX` — самые старые
     отбрасываются, в лог одна строка). Xray не отвечает — в лог не чаще раза в
     10 минут (`module: "proxy-traffic"`, `event: "stats_unavailable"`). `flush()` —
     то же, что `collect`, вызывается перед записью конфига. `lastCollectedAt` —
     в памяти. Раз в `CLEANUP_MS` — `deleteBefore(now − 35 суток)`;
   - `traffic.service.ts` — `report(actor, period)`: `proxies.view`; окно —
     `PERIOD_HOURS[period]` часов до текущего часа включительно; соединение с живыми
     подписками и узлами. Ответ:

     ```ts
     interface TrafficReport {
       period: "day" | "week" | "month";
       from: string; to: string;               // ISO, границы часов
       lastCollectedAt: string | null;          // этой репликой
       subscriptions: {
         key: string; name: string; upBytes: number; downBytes: number;
         nodes: { nodeKey: string; name: string; inSubscription: boolean; upBytes: number; downBytes: number }[];
       }[];
     }
     ```

     Байты числом, как `trafficUsedBytes` в T-0093: до 2^53 — петабайты.
8. **Снятие перед записью конфига** — `xray-config-assembly.ts`: в зависимостях —
   `beforeWrite?: () => Promise<void>`. Он зовётся перед записью `config.json`, его
   ошибка запись не останавливает (лог). В `buildXrayConfig` передаётся
   `stats: { port: config.xray.statsPort }`. `proxies.module.ts`: провайдеры
   `TrafficCollector`, `TrafficService`; `beforeWrite: () => collector.flush()`;
   `TrafficService` — в `exports`: его берёт контроллер из `AdminModule`.
9. **Контроллер** `admin-proxy-traffic.controller.ts`: `GET /api/v1/admin/proxy-traffic?period=day|week|month`.
   Zod, по умолчанию `day`, другое — 400. Право `proxies.view`. Регистрация в
   `admin.module.ts`.
10. **Панель:** клиент `api/proxy-traffic.ts`. Чистые функции в `traffic-view.ts`:
    `bytesText`, `trafficRows` (узлы всех подписок, по «всего» по убыванию),
    `subscriptionTotals`. Блок `TrafficPanel.tsx` вставляется в `ProxiesScreen.tsx`
    одной строкой под блоком подписок. Пояснение — `HELP.proxies.traffic`.
11. **Документы** — раздел «Документы».

## Чего не трогаем

- `infra/prod/compose.yml`, `run.sh`, `Dockerfile`: порт не публикуется, сеть уже общая.
  Нужна правка compose — стоп, вопрос тимлиду.
- Трафик поставщика (`subscription-userinfo`) и строку `trafficLine` — она остаётся в
  карточке подписки.
- Прометей: метки по узлу и подписке — высокая кардинальность (`CLAUDE.md`,
  «Аналитика»), метрик не заводим.
- Перебор, разбор подписки, карточку подписки (`SubscriptionCard.tsx`) — T-0384, T-0385.

## Сценарий и интерфейс

Блок «Трафик через узлы Xray» под блоком подписок. Под заголовком: «Сколько сервер
прогнал через узлы — считает ядро Xray на нашем сервере. Поставщик считает
по-своему, его цифры — в карточке подписки».

- **Переключатель** «Сутки» · «7 дней» · «30 дней» (по умолчанию «Сутки»), подпись
  окна: «с 06.11 14:00 до 07.11 14:00» по времени смотрящего.
- **По подпискам** — строка на подписку: «<Название>: отдано 1,2 ГБ · получено 15,3 ГБ ·
  всего 16,5 ГБ».
- **Таблица узлов:** «Узел», «Подписка», «Отдано», «Получено», «Всего»; по «Всего»
  по убыванию. Узел, которого уже нет в подписке, — «<название> (нет в подписке)».
  `bytesText`: меньше 1 КБ — «512 Б», затем «КБ», «МБ», «ГБ», «ТБ» с одним знаком
  после запятой (`ru-RU`).
- **Пусто** — «За этот период трафика через узлы не было».
- **Счётчиков нет** (`lastCollectedAt === null`) — плашка: «Сервер ещё не получил
  счётчики Xray: контейнер не подключён или не отвечает. На машине разработчика так и
  должно быть».
- **Загрузка, ошибка, нет сети** — как у соседних блоков.
- **Ограничение аккаунта** — блок виден с `proxies.view`, кнопок правки нет.

`HELP.proxies.traffic`: «Считает ядро Xray: сколько байт ушло к узлу и пришло от него.
Окна скользящие — последние 24 часа, 7 и 30 суток. История хранится 35 суток. При
перезапуске Xray (смена конфига, сбой) теряются секунды учёта».

## Тесты

Первым коммитом.

- **`packages/proxy-kit/test/xray-stats.test.ts`:**
  - `encodeQueryStatsRequest({ pattern: "outbound>>>", reset: true })` — байты
    `0a 0b 6f 75 74 62 6f 75 6e 64 3e 3e 3e 10 01`; `reset: false` — без поля 2;
  - `decodeQueryStatsResponse` — две записи, `value` больше 2^53 (`bigint` без потери),
    незнакомое поле 3 пропущено; обрыв посреди строки, тип провода 3 → `XrayStatsFormatError`;
  - `grpcFrame`/`grpcUnframe` туда и обратно; флаг сжатия 1, рамка короче
    заявленной → ошибка;
  - `trafficOfStats`: `outbound>>>out-main-0123456789abcdef>>>traffic>>>uplink` →
    `main`, `up`; `outbound>>>block>>>…`, `outbound>>>out-main-0123456789abcdef-dial>>>…`,
    `inbound>>>…`, `user>>>…` → пропуск.
- **`packages/proxy-kit/test/xray-config.test.ts`** — без `stats` конфиг прежний (все
  старые золотые файлы); со `stats` — три блока, `api.services` только `StatsService`,
  новый золотой файл.
- **`backend/api/test/proxy-traffic.test.ts`** (подмены: `StatsSource`, репозиторий,
  часы):
  - чтение → строки часа чтения, вверх и вниз отдельно, название из узлов подписки;
  - два чтения в одном часе складываются; чтение после смены часа — в новый час;
  - ошибка записи → следующее чтение пишет сумму обоих; переполнение отложенных —
    старые отброшены, одна строка в логе;
  - `StatsSource` бросает → ничего не записано, лог не чаще раза в 10 минут, таймер жив;
  - `flush` зовётся перед записью конфига в `assembleConfig`; его ошибка запись не
    останавливает;
  - отчёт: окна 24/168/720 часов, удалённая подписка не попадает, узел вне подписки —
    `inSubscription: false`; без `proxies.view` — 403; `period=year` — 400;
  - `app-config`: `XRAY_STATS_PORT` внутри диапазона SOCKS-входов → ошибка с текстом шага 2.
- **`backend/api/test/proxy-traffic.integration.test.ts`** (Postgres): `add` дважды по
  одному ключу — сумма; две параллельные `add` одного ключа — сумма без потерь;
  `deleteBefore` удаляет только старое; `hour` не на границе часа и отрицательные
  байты нарушают CHECK.
- **`apps/admin/test/proxy-traffic.test.ts`** — `bytesText` (0, 1023, 1024, 1,5 ГБ,
  2 ТБ), порядок `trafficRows`, подпись «(нет в подписке)».
- **Вручную, в PR:** вывод `check-config.sh` и `xray api statsquery` (шаг 4).

## Аналитика

Нет: это учёт работы спутника для панели, игрок его не видит. В Prometheus не идёт —
метки по узлам дали бы высокую кардинальность.

## Настройки и окружение

`XRAY_STATS_PORT` — шаг 2 (порт `10799`, ответ на вопрос 1). Ключей панели нет: сроки и
частота — константы `traffic-rules.ts`.

## Документы

- **`docs/20-env-and-ports.md`** — строка в §2, переменная в §7 («9.3 Спутник Xray»), в
  разделе про спутник — «служба статистики только `StatsService`, внутри сети
  `tunnel`, порт не публикуется».
- **`packages/proxy-kit/README.md`**, «Что умеет» — блоки статистики в конфиге и
  кодек `xray-stats.ts`.
- **`docs/21-diagrams.md`** — ER (`proxy_traffic_hour`); в потоке подписки — «API ← счётчики
  Xray (gRPC, раз в минуту, со сбросом)».
- **`docs/29-admin-panel.md`**, строка «Прокси» — блок «Трафик через узлы Xray».
- **`docs/30-configuration-map.md`** — строка: частота чтения, срок хранения, окна —
  `traffic-rules.ts`; `XRAY_STATS_PORT` — в строке переменных `XRAY_*`.

## Критерии приёмки

- [ ] В конфиге спутника есть `stats`, `api` (только `StatsService`) и `policy`; порт —
      из карты портов, не опубликован; `check-config.sh` и `statsquery` зелёные.
- [ ] Трафик пишется по часам, по узлу и подписке, без задвоений при нескольких
      репликах; перезапуск Xray не даёт отрицательных чисел.
- [ ] В панели — отчёт за сутки, 7 и 30 дней по подпискам и узлам.
- [ ] Строки старше 35 суток удаляются.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и интеграционные тесты зелёные.

## PR

- **Заголовок:** `feat(api): Учёт трафика узлов Xray`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — УЧЁТ ТРАФИКА УЗЛОВ XRAY**

  В разделе «Прокси» появился блок «Трафик через узлы Xray»: сколько сервер прогнал через каждый узел и подписку за сутки, 7 и 30 дней. Считает само ядро Xray.

  🛠 **Эксплуатация**

  • Xray отдаёт счётчики только внутри сети tunnel, порт XRAY_STATS_PORT не публикуется
  • история хранится 35 суток
  • при перезапуске Xray теряются секунды учёта
  ```

## Вопросы к тимлиду

Ответы `claude-lead-1`, 07.11.2026:

1. **Порт службы статистики — `10799`**: сразу под SOCKS-входами (`10800`…), не пересечётся с ними
   и при `XRAY_SLOT_COUNT` до 500. Строка — в карту портов `docs/20-env-and-ports.md` §2 этим же PR.
2. **Срок хранения — 35 суток**: Р192 просит окна «сутки, неделя, месяц», прошлый календарный
   месяц — не просит.
