---
id: T-0155
title: Отчёты политики источников — директива в политике и приём со сводкой
epic: E3
priority: P1
status: done
owner: claude-1 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: [T-0154, T-0184]
zones:
  - scripts/vite/content-security-policy.ts
  - scripts/vite/dev-server.ts
  - scripts/test/content-security-policy.test.ts
  - apps/web-telegram/vite.config.ts
  - backend/api/src/http-app.ts
  - backend/api/src/modules/csp-reports/**
  - backend/api/test/csp-reports.test.ts
  - backend/api/test/csp-reports.integration.test.ts
  - backend/api/test/csp-reports.http.test.ts
shared:
  - backend/api/src/app.module.ts
  - docs/09-ci-cd.md
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0155. Отчёты политики источников — директива в политике и приём со сводкой

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0155.json)](../README.md#значки-статуса) [![T-0154](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0154.json&label=T-0154)](T-0154-csp-ad-sdk-chains.md) [![T-0184](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0184.json&label=T-0184)](T-0184-csp-ad-chains-yandex-richads-styles.md)

[![T-0154](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0154.json&label=T-0154)](T-0154-csp-ad-sdk-chains.md)

## Зачем

Список разрешённых адресов рекламных SDK мы дополняем по скриншотам тестеров:
игрок видит, что реклама не показалась, команда гадает почему. Браузер сам
знает, что заблокировал, и может сказать нам об этом. Задача включает отчёты
и собирает их на сервере в сводку, по которой список дополняется точно. Экран
панели — следующая задача (T-0156).

## Решения

Р108 (`docs/35-stage4-plan.md`, 19.10.2026), дословно: браузер присылает на
наш маршрут отчёт о каждом заблокированном адресе. Сервер хранит их сводкой:
директива, хост, сколько раз и когда последний; число хостов ограничено;
адресов страниц и игроков в сводке нет.

Решение claude-lead-1 от 19.10.2026: право чтения сводки в панели —
`diagnostics.view`, хранилище — Redis, кнопки сброса нет (сводка устаревает
за 30 суток). Ниже эти пункты расписаны.

Уточнения `claude-lead2-1` из Р108 и кода (проверено чтением, не гаданием):

- **Только `report-uri` в заголовке политики.** Политика уходит заголовком
  (`csp.txt` → сниппет Caddy в `infra/prod/deploy.sh:66–75`, dev-сервер Vite
  ставит заголовок в `scripts/vite/dev-server.ts:79–86`), поэтому
  `report-uri` работает: в `<meta>` он не поддерживается, а у нас `<meta>`
  нет. `report-to` не берём: ему нужен отдельный заголовок
  `Reporting-Endpoints`, а выкат ставит один заголовок из `csp.txt`.
  Приёмник при этом понимает оба формата тела (дёшево, и пригодится, когда
  `report-to` понадобится).
- **Адрес приёма:** `POST /api/v1/csp-reports`. Если `VITE_API_URL` пуст
  (прод, `docs/20-env-and-ports.md` §2) — относительный, на тот же домен;
  задан — абсолютный на источник API.
- **Хранилище — Redis**, без миграции: сводка небольшая, ограничена по
  числу ключей и сама устаревает (срок жизни).
- **Не `IngestGuard`.** Его виды (`IngestKind`) требуют лимитов «на установку»
  и «на Telegram ID», проверку `Origin` и выключатель с базой
  (`ingest/ingest.guard.ts:53–95`), а отчёт браузера ничего из этого не
  несёт: подписи запуска и `installId` нет, заголовок `Origin` в таком
  запросе не гарантирован. Лимит — по IP через общий `RateLimiter`, как у
  `online.controller.ts`.
- **Право на чтение в панели — `diagnostics.view`** (группа «Эксплуатация»):
  сводка нужна тем, кто разбирает отчёты устройств. Нового права не заводим.
- **Содержимое сводки** (всё остальное из тела отчёта отбрасывается и не
  попадает ни в Redis, ни в лог): директива, хост, число, момент последнего.

## Как сейчас

- `scripts/vite/content-security-policy.ts` — `PolicyInput` (строки 46–68) и
  `contentSecurityPolicy` (117–151). Директивы собираются в
  `directives: Record<string, string[]>`, `upgrade-insecure-requests`
  добавляется отдельно (149). `originOf(apiOrigin)` (158) уже есть.
- `apps/web-telegram/vite.config.ts:100` — вызов для `csp.txt`;
  `scripts/vite/dev-server.ts:85` — вызов для dev и просмотра сборки.
- `apps/web-telegram/vite.config.ts:38–66` — прокси dev-сервера на API
  перечисляет префиксы по одному; `/api/v1/csp-reports` там нет, без него
  отчёты на dev-сервере уйдут в никуда.
- `backend/api/src/http-app.ts:31–52` — `createHttpApp`: Fastify
  (`FastifyAdapter`, `bodyLimit` 2 МБ), свои разборщики тел не заведены. По
  умолчанию Fastify разбирает только `application/json` и `text/plain`, а
  браузер шлёт отчёт с `Content-Type: application/csp-report` (`report-uri`)
  или `application/reports+json` (`report-to`) — без своего разборщика
  ответ `415`, и отчёт не доходит.
- `backend/api/src/common/domain-error.filter.ts:63–89` — ошибки Fastify со
  статусом 4xx (`400`, `413`, `415`) фильтр переводит в общую форму.
- `backend/api/src/modules/ingest/rate-limiter.ts:48–59` — `consume(rule, key)`
  атомарно; при падении Redis держит лимит в памяти. `RateLimit
  { scope, limit, windowSec }`.
- `backend/api/src/modules/online/online.module.ts` — образец модуля с
  публичным маршрутом, маршрутом панели и своими экземплярами
  `AdminSessionGuard`, `AdminSessionService`, `ADMIN_SESSION_STORE` (`AdminModule`
  их не экспортирует). `online.repository.ts:1–30, 94–110` — образец Redis
  без Lua; таймаут команды — клиент `infra/redis.ts` (2 с). Образец Lua —
  `ingest/rate-limiter.ts:16–22`.
- `backend/api/src/modules/admin/admin-overview.controller.ts:14–23` — образец
  маршрута панели: `@UseGuards(AdminSessionGuard, PermissionGuard)` и
  `@RequirePermission(...)`.
- `backend/api/test/online.http.test.ts` — образец HTTP-теста маршрутов
  игрока и панели на подменах (сессии, роли, Redis).
- `backend/api/src/app.module.ts:92` — `APP_MODULES`; сюда встанет модуль.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Политика.** `PolicyInput` получает `reports?: boolean`. Когда оно
   истинно, в `directives` добавляется
   `"report-uri": [reportUri]`, где `reportUri` — `"/api/v1/csp-reports"`,
   а при непустом `originOf(apiOrigin)` — этот источник плюс тот же путь.
   Директива идёт последней, после `object-src`. Комментарий: почему
   `report-uri`, а не `report-to` (см. «Решения»). По умолчанию `false`:
   политика панели и других площадок не меняется.
3. `apps/web-telegram/vite.config.ts`: в вызов для `csp.txt` (строка 100)
   добавить `reports: true`; в `apiProxy` — строка
   `"/api/v1/csp-reports"`.
4. `scripts/vite/dev-server.ts`: в `policy()` передать `reports: ads` —
   отчёты шлёт только Telegram-сборка с рекламой (у MAX и VK приёмник в
   политике не прописан).
5. **Разборщик тел** в `http-app.ts`, в `configureHttpApp`: через
   `getHttpAdapter().getInstance().addContentTypeParser([...], { parseAs:
   "string", bodyLimit: CSP_REPORT_BODY_LIMIT_BYTES }, …)` для
   `application/csp-report` и `application/reports+json`. Тело — `JSON.parse`;
   ошибка разбора — `done` с ошибкой, у которой `statusCode: 400` и сообщение
   «Некорректный отчёт» (фильтр оформит). Константа
   `CSP_REPORT_BODY_LIMIT_BYTES = 16 * 1024` — рядом с `BODY_LIMIT_BYTES`.
   Остальные типы по-прежнему `415`.
6. **Модуль `modules/csp-reports/`**:
   - `csp-report-parse.ts` — чистые функции. `parseCspReports(body: unknown):
     CspHit[]`, где `CspHit = { directive: string; host: string }`.
     Принимает оба формата, остальные поля игнорирует (Zod, `passthrough`
     не нужен — берутся только названные поля):
     - `report-uri`: `{ "csp-report": { "effective-directive"?,
       "violated-directive"?, "blocked-uri"? } }` — директива из
       `effective-directive`, а нет — первое слово `violated-directive`;
     - `report-to`: массив `{ type, body: { effectiveDirective?, blockedURL? } }`,
       берутся записи с `type: "csp-violation"`, не больше 20 за запрос.
     **Директива** приводится к нижнему регистру и проверяется по списку
     известных (`script-src`, `script-src-elem`, `script-src-attr`,
     `style-src`, `style-src-elem`, `style-src-attr`, `img-src`, `media-src`,
     `font-src`, `connect-src`, `frame-src`, `child-src`, `worker-src`,
     `manifest-src`, `object-src`, `default-src`, `base-uri`, `form-action`,
     `frame-ancestors`); чужое имя — `other`.
     **Хост** из `blocked-uri`: у адреса `http`, `https`, `ws`, `wss` —
     `URL.hostname` в нижнем регистре, без порта, пути и параметров (в них
     могут оказаться чужие данные, поэтому дальше имени хоста адрес не
     идёт); слова `inline`, `eval`, `data`, `blob` остаются как есть; всё
     остальное (расширения браузера, `about`, пустое, битое) — `other`.
     Хост длиннее 253 знаков или с символами вне `[a-z0-9.-]` (после
     `URL`-разбора) — `other`.
   - `csp-reports.repository.ts` — `CspReportsRepository` на Redis, порт для
     подмены в тестах (`CSP_REPORTS_REPOSITORY`). Три ключа: хеш
     `csp:count` (поле `<directive>|<host>` → число), хеш `csp:last` (то же
     поле → момент последнего, мс) и счётчик `csp:overflow`. Запись —
     **одним Lua-скриптом**: если поля в `csp:count` нет и в нём уже
     `MAX_ENTRIES` полей — `INCR csp:overflow`, выход; иначе `HINCRBY
     csp:count`, `HSET csp:last`, `EXPIRE` всех трёх ключей на
     `SUMMARY_TTL_SEC`. Без скрипта два отчёта в одну миллисекунду
     пробивают потолок. Чтение — `HGETALL` обоих хешей и `GET` счётчика,
     запись `last` без пары в `count` пропускается. `MAX_ENTRIES = 200`,
     `SUMMARY_TTL_SEC = 30 * 24 * 3600` — именованные константы с комментарием
     «почему».
   - `csp-reports.service.ts` — `record(body)`: `parseCspReports`, затем
     запись каждого попадания; ошибка Redis не пробрасывается (отчёт
     браузера не повторяют, а игрок его не ждёт) — одна строка `warn` в
     минуту `{ module: "csp-reports", event: "record_failed" }` по образцу
     `rate-limiter.ts:warnFallback`. `summary(): CspSummary` — отдаёт
     `{ entries: [{ directive, host, count, lastAt }], overflow,
     maxEntries }`, `lastAt` — ISO-строка, порядок — свежие сверху.
   - `csp-reports.controller.ts` — два контроллера в одном файле, как в
     `online.controller.ts`:
     - публичный `POST /csp-reports`, `@HttpCode(204)`, без `AuthGuard`;
       лимит по IP через `RateLimiter`: `{ scope: "csp-reports:ip", limit:
       300, windowSec: 60 }` — страница с десятком заблокированных адресов
       шлёт десяток отчётов на загрузку, а мобильные операторы сажают
       сотни людей на один адрес; сверх лимита — `RateLimitedError`;
     - панельный `GET /admin/csp-reports`,
       `@UseGuards(AdminSessionGuard, PermissionGuard)`,
       `@RequirePermission("diagnostics.view")`, ответ `{ data: CspSummary }`.
   - `csp-reports.module.ts` — по образцу `OnlineModule`.
7. `app.module.ts` — одна строка импорта и одна в `APP_MODULES`.
8. **Экспорт провайдера** не нужен: другие модули сводку не читают.
9. **Документы:** `docs/09-ci-cd.md` §10, «Заголовки на краю» — абзац про
   `report-uri` в политике и адрес приёма; `docs/30-configuration-map.md` —
   строки «потолок сводки отчётов (`MAX_ENTRIES`), срок хранения,
   лимит приёма, список допустимых директив» с путями к константам;
   `docs/21-diagrams.md` — диаграмма потока: браузер → Caddy → API →
   Redis → панель (Mermaid `sequenceDiagram`, по образцу блока счётчика
   онлайна рядом со строкой 3469).

## Чего не трогаем

- `IngestGuard`, `IngestKind`, `INGEST_LIMITS` — приёмник к ним не
  привязываем (см. «Решения»).
- Экран панели — T-0156.
- Политику панели `apps/admin/src/csp.ts`: у неё отчётов нет.
- Адреса страниц, `referrer`, `source-file`, `original-policy`, `status-code`,
  любые поля игрока: не читаем, не храним, не логируем — ни целиком, ни
  кусками.
- Кнопка «сбросить сводку»: по решению claude-lead-1 от 19.10.2026 её нет,
  сводка устаревает сама.
- Prometheus: бэкенд метрик ещё не имеет.
- Выключатель приёма: его нет сознательно, приёмник не зависит от базы.

## Тесты

Пишутся первым коммитом, до кода. Интеграционные — на живом Redis
(`docs/17-testing-strategy.md` §4.2).

- `scripts/test/content-security-policy.test.ts`:
  - с `reports: true` есть `report-uri /api/v1/csp-reports`; при
    `apiOrigin: "https://api.rubezh.gonet.fun/api/v1"` —
    `report-uri https://api.rubezh.gonet.fun/api/v1/csp-reports`;
  - без `reports` директивы нет; в панельной политике её тоже нет;
  - директива идёт в одной строке политики через `;`, остальные директивы
    не изменились.
- `backend/api/test/csp-reports.test.ts` (чистая логика):
  - `report-uri`-тело с `effective-directive: "script-src-elem"` и
    `blocked-uri: "https://7ool.net/richpartners/pops/js/md5.js?x=1"` →
    `{ directive: "script-src-elem", host: "7ool.net" }`: ни пути, ни
    параметров;
  - только `violated-directive: "script-src 'self' https://x"` →
    директива `script-src`;
  - `blocked-uri`: `inline`, `eval`, `data`, `blob` → как есть;
    `chrome-extension://abc/x.js`, `""`, `about`, не-строка → `other`;
  - порт и регистр: `https://CDN.Example.COM:8443/a` → `cdn.example.com`;
  - `report-to`-массив из трёх записей, одна с `type: "network-error"` →
    два попадания; массив из 25 записей → не больше 20;
  - неизвестная директива → `other`; мусор вместо тела (`null`, число,
    пустой объект, массив чисел) → ноль попаданий, без исключения;
  - в результате разбора нет ни одного поля, кроме `directive` и `host`
    (ключи объекта проверяются явно).
  - сервис на подмене репозитория: ошибка записи не бросается наружу;
    `summary` отдаёт свежие сверху и ISO-даты.
- `backend/api/test/csp-reports.integration.test.ts` (живой Redis, ключи
  теста чистятся):
  - 3 отчёта на одну пару → `count` 3, `lastAt` — момент последнего;
  - 250 разных хостов подряд → в сводке ровно `MAX_ENTRIES`, `overflow` 50,
    уже учтённая пара при полной сводке по-прежнему растёт;
  - 300 записей разных хостов параллельно (`Promise.all`) → не больше
    `MAX_ENTRIES` полей, `count` суммарно + `overflow` = 300;
  - срок жизни трёх ключей выставлен (`TTL > 0`).
- `backend/api/test/csp-reports.http.test.ts` (по образцу
  `online.http.test.ts`, подмены репозитория, сессий и ролей):
  - `POST /api/v1/csp-reports` с `Content-Type: application/csp-report` →
    `204`, попадание записано;
  - то же с `application/reports+json` и массивом → `204`;
  - с `application/json` → `204` (тело тоже разбирается);
  - с `text/html` → `415`; битый JSON в `application/csp-report` → `400`;
    тело больше 16 КБ → `413`;
  - без заголовка `Origin` запрос проходит;
  - 301-й запрос с одного IP в минуту → `429`;
  - `GET /api/v1/admin/csp-reports` без сессии панели → `401`; с сессией без
    права `diagnostics.view` → `403`; с правом → `200` и форма ответа.

## Аналитика

Нет: сводка и есть учёт, отдельных событий не порождается. Событие с хостом
в аналитику не пишем — оно размножало бы кардинальность без пользы. Метрик
Prometheus нет, и меток `user_id` и подобных тем более.

## Настройки и окружение

Нет новых переменных и ключей каталога: числа — константы модуля (потолок
200, срок 30 суток, лимит приёма 300 в минуту), строки — в карте
конфигурации. Если командам потребуется менять их без релиза, это отдельное
решение.

## Документы

- `docs/09-ci-cd.md` §10; `docs/30-configuration-map.md`;
  `docs/21-diagrams.md` (поток). ER-диаграмма не меняется: базы нет.

## Критерии приёмки

- [ ] Политика Telegram-сборки содержит `report-uri`, политика панели и сборок
      MAX и VK — нет; `csp.txt` и dev-заголовок строятся из одной функции.
- [ ] Приёмник отвечает `204` на тела обоих типов браузера и `415` на
      чужой тип, `400` на битый JSON, `413` на тело больше 16 КБ.
- [ ] В сводке: директива, хост, число, момент последнего. Ни пути, ни
      параметров, ни адреса страницы, ни данных игрока нигде: ни в Redis, ни в
      логе.
- [ ] Число хостов ограничено 200 при параллельной записи; сверх потолка
      растёт счётчик, ничего не теряется молча.
- [ ] Лимит по IP работает, падение Redis не роняет приёмник.
- [ ] `GET /api/v1/admin/csp-reports` закрыт сессией панели и правом
      `diagnostics.view`.
- [ ] Прокси dev-сервера пропускает `/api/v1/csp-reports`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; диаграмма потока на
      месте.

## PR

- **Заголовок:** `feat(api): Принимать отчёты политики источников сводкой`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОТЧЁТЫ ПОЛИТИКИ ИСТОЧНИКОВ**

  Политика клиента Telegram просит браузер сообщать о каждом заблокированном адресе. Сервер копит сводку: директива, хост, сколько раз и когда последний; хостов не больше 200, адресов страниц и игроков нет. Экран в панели — следующая задача.

  🛠 **Что важно знать**

  • Новый маршрут `POST /api/v1/csp-reports`, лимит 300 в минуту с адреса
  • Сводка живёт в Redis 30 суток и сама не пополняется, пока клиент не выкачен с новой политикой
  ```
