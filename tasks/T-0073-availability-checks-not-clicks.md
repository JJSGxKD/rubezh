---
id: T-0073
title: Проверки доступности не считаются кликами; клики без класса устройства — отдельной строкой
epic: E14
priority: P1
status: ready
owner:
author: claude-lead2-4
size: M
depends_on: [T-0057]
zones:
  - backend/api/src/modules/links/availability-checkers.ts
  - backend/api/src/modules/links/links.service.ts
  - backend/api/src/modules/links/links.repository.ts
  - backend/api/src/modules/links/redirect.controller.ts
  - backend/api/test/availability-checkers.test.ts
  - backend/api/test/links.test.ts
  - backend/api/test/links.integration.test.ts
  - apps/admin/src/api/links.ts
  - apps/admin/src/screens/links/LinkCard.tsx
  - apps/admin/test/links.test.ts
shared:
  - apps/admin/src/ui/help.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/24-attribution-and-sharing.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: high
release: patch
design: null
batch: 2
---

# T-0073. Проверки доступности не считаются кликами; клики без класса устройства — отдельной строкой

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0073.json)](README.md#значки-статуса) [![T-0057](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0057.json&label=T-0057)](T-0057-link-target-and-direct-links.md)

## Зачем

У ссылки рекламной сети из 89 кликов 52 пришли с `Referer: check-host.net`,
34 — без класса устройства, и только 3 — с телефона (2 запуска). Сервисы
проверки доступности и мониторинга раздувают клики и роняют долю запусков:
по цифрам кажется, что реклама не работает, хотя людей среди кликов почти нет
(`tasks/inbox.md`, строка от 13.10).

После задачи такие запросы кликом не пишутся — так же, как запросы краулеров
превью, — а в карточке ссылки клики разложены по устройствам, и те, у которых
класс не определён, стоят отдельной строкой «Устройство не определено», а не
теряются среди телефонов.

## Решения

Решение тимлида `claude-lead-1` от 13.10.2026 (запись в `tasks/inbox.md`);
исполнитель его не пересматривает:

- Известные сервисы проверки доступности отсекаются **так же, как краулеры
  превью** (`docs/24-attribution-and-sharing.md` §3.3): запрос не пишется
  кликом и не попадает в цифры ссылки.
- Признак — `Referer` или `User-Agent` из **явного списка в коде**:
  `check-host.net` и ещё четыре распространённых сервиса. У каждого в списке
  комментарий, почему он там.
- Клики без класса устройства в «воронке ссылки» (цифры карточки) идут
  отдельной строкой «Устройство не определено».

Что принято здесь по записанному и устоявшемуся (подтверждение — в разделе
«Вопросы к тимлиду», на работу исполнителя оно не влияет):

- **Список сервисов** (признаки взяты из публичных описаний сервисов):

  | `service` | Признак | Откуда |
  |---|---|---|
  | `check-host` | `Referer` `check-host.net`; в User-Agent — `CheckHost` | Referer наблюдали на 52 кликах из 89; User-Agent — по сторонним справочникам ботов, документация сервиса его не называет |
  | `uptimerobot` | User-Agent `UptimeRobot` | справка сервиса: `Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)` |
  | `pingdom` | User-Agent `Pingdom` | токен `Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)`; документация SolarWinds советует опознавать трафик по слову pingdom |
  | `site24x7` | User-Agent `Site24x7` | в справке Site24x7 браузерные мониторы дописывают `Site24x7` к User-Agent |
  | `hosttracker` | User-Agent `HostTracker` | `Mozilla/5.0 (compatible;HostTracker/2.0;+http://www.host-tracker.com/)`; сервис проверяет сайты с сотен точек и распространён у русскоязычных владельцев сайтов |

- **Ответ проверке.** Страница 200 «как краулеру», но **без кеша**
  (`no-store`): общий кеш не должен отдать заглушку человеку. Если приложение
  сейчас не собрать — 503, как человеку: монитор обязан видеть настоящую
  недоступность.
- **Старые клики.** Клики с `Referer` из списка, записанные до этой задачи,
  остаются в базе, но в цифры ссылки (клики, клики за 30 дней, классы
  устройств) не идут. Строки не удаляем и не правим.
- **Метрики.** Prometheus-счётчика нет: экспорта метрик в бэкенде пока нет
  (`prom-client` — план, `docs/35-stage4-plan.md`, Б8). Каждый отсечённый
  запрос — строка лога с именем сервиса (раздел «Аналитика»).

## Как сейчас

- **`backend/api/src/modules/links/crawler.ts:10-32`** — `CRAWLERS` и
  `isCrawler(userAgent)`: боты превью и поисковиков; пустой User-Agent —
  тоже краулер. Сервисов проверки в списке нет, а общее правило
  `/\bbot\b|crawler|spider|preview/i` их не ловит: в `UptimeRobot` слова
  `bot` отдельно нет, в `Pingdom.com_bot_version` оно с подчёркиваниями, а
  подчёркивание — часть слова.
- **`backend/api/src/modules/links/links.service.ts:67-93`** — `visit`:
  - `:71` — `isCrawler` → `{ kind: "preview", url }`;
  - `:73-75` — `newClickId()`, `appLinks.launch(...)`, `null` →
    `{ kind: "unavailable", url }`;
  - `:77-91` — `recordClick(...)` мимо ответа; `:83` — `refererHost:
    hostOf(visitor.referer)`, `:84` — `deviceClass: classifyClient(null,
    visitor.userAgent).deviceClass`;
  - `:136-143` — `hostOf(referer)`: хост (`URL.host`, строчными, с портом, если
    он не стандартный), `null` при мусоре.
- **`backend/api/src/modules/links/redirect.controller.ts:62-71`** —
  ответ по виду `Visit`: `:69` — `preview` с `cache-control: private,
  max-age=300` (PR #293: общий кеш CDN не различает User-Agent), `:70` — `unavailable` 503, `:71` — 302.
- **`backend/api/src/modules/attribution/client-class.ts:52-64`** — у клика
  нет данных клиента Telegram, поэтому `classifyClient(null, ua)` отдаёт
  только `mobile` (Android и iOS по User-Agent) или `unknown` (всё остальное,
  в том числе браузер на компьютере и робот). `desktop` и `web` на клике
  получить нельзя. В колонке `link_click.device_class` (`VarChar(16)`,
  nullable) у старых строк бывает и `NULL`.
- **`backend/api/src/modules/links/links.repository.ts`:**
  - `:42-47` — `LinkStats`: `clicks`, `clicks30d`, `launches`;
  - `:91-112` — `list`: один `$queryRaw` (`:97-106`) по `link_click`
    с `GROUP BY c.link_code`; класса устройства в нём нет.
- **`backend/api/src/modules/admin/admin-links.controller.ts:56-66`** — список
  отдаёт `{ ...link, conversions }`: новое поле `LinkStats` дойдёт до панели
  само, контроллер не меняется.
- **Панель:**
  - `apps/admin/src/api/links.ts:40-45` — `linkStatsSchema`; `:79-82` —
    `freshRow` (нули для только что заведённой ссылки);
  - `apps/admin/src/screens/links/LinkCard.tsx:94-100` — `KeyValue`: «Кликов»,
    «Запусков», «Клик → запуск»;
  - `apps/admin/src/ui/help.ts:56-66` — подсказки `HELP.links`.
- **Тесты:** `backend/api/test/links.test.ts` — `MemoryLinks` (`:27-44`, его
  `list()` строит `LinkStats` вручную), краулеры (`:80-87`), переход
  (`:89-145`), HTTP `/r/:code` (`:163-213`); `links.integration.test.ts:31-61`
  — клики и запуски на живом Postgres; `apps/admin/test/links.test.ts:49-62`.
- **«Воронка ссылки» в коде** — это цифры карточки ссылки (клики → запуски →
  доля). Отчёт `modules/funnel/funnel-report.ts` считает аккаунты по
  первому касанию, класса устройства клика в нём нет, и этой задачей он не
  затрагивается.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»). Они падают — так и должно быть.
2. **Новый `backend/api/src/modules/links/availability-checkers.ts`** — чистый
   модуль, без Nest и базы:

   ```ts
   export interface AvailabilityChecker {
     /** имя в логе, а когда появится экспорт метрик — значение метки; строчные латиница, цифры и дефис, список конечный */
     service: string;
     /** точные хосты `Referer`: строчные, без схемы и порта */
     refererHosts: readonly string[];
     /** фрагмент User-Agent; `null` — по нему сервис не опознаётся */
     userAgent: RegExp | null;
   }
   export const AVAILABILITY_CHECKERS: readonly AvailabilityChecker[];
   /** Хосты `Referer` из списка — для исключения старых кликов в SQL. */
   export const CHECKER_REFERER_HOSTS: readonly string[];
   /** Имя сервиса проверки или `null`: запрос похож на человека. */
   export function checkerOf(visitor: { userAgent: string | null; refererHost: string | null }): string | null;
   ```

   - **Список** — пять записей из таблицы раздела «Решения», в том же
     порядке; User-Agent — регулярные выражения без флагов, кроме `i`
     (`/CheckHost/i`, `/UptimeRobot/i`, `/Pingdom/i`, `/Site24x7/i`,
     `/HostTracker/i`); `refererHosts` непуст только у `check-host`
     (`["check-host.net"]`), у остальных — `[]`.
   - **Комментарий над каждой записью** — по-русски: что за сервис и на чём
     держится признак (колонка «Откуда» таблицы, дословно по смыслу). У
     `check-host` — оговорка, что User-Agent не подтверждён документацией и
     главный признак — Referer.
   - **Комментарий над списком:** признак — подсказка, а не проверка
     личности; подделать его может кто угодно, и цена ошибки — один
     неучтённый клик. Новый сервис добавляется записью в этот список; общее
     правило краулеров (`crawler.ts`) не растягиваем.
   - **`checkerOf`:** хост Referer приводится к строчным и теряет `:порт`
     (`/:\d+$/`); совпадение — **точное** (`check-host.net.evil.example` и
     `evil-check-host.net` — не он); сначала сравниваются хосты по списку,
     потом User-Agent; отдаётся `service` первой подошедшей записи.
     `userAgent === null` не подходит ни к одному User-Agent-признаку.
   - `CHECKER_REFERER_HOSTS` — `flatMap` по `refererHosts`.
3. **`links.service.ts`** — `visit`:
   - в тип `Visit` добавить `| { kind: "check"; url: string | null }`;
   - после проверки `appLinks.launch(...) === null` (ответ `unavailable`) и
     **до** `recordClick` добавить:

     ```ts
     const checker = checkerOf({ userAgent: visitor.userAgent, refererHost: hostOf(visitor.referer) });
     if (checker !== null) {
       this.logger.log(JSON.stringify({ module: "links", event: "availability_check_skipped", link: link.code, service: checker }));
       return { kind: "check", url };
     }
     ```

   - `isCrawler` остаётся первой проверкой как есть; порядок «краулер →
     недоступно → проверка → клик» не менять. Комментарием объяснить, почему
     проверка стоит после `unavailable`: монитор должен видеть настоящую
     недоступность;
   - импорт `checkerOf` из `./availability-checkers.js`.
4. **`redirect.controller.ts`** — перед строкой с 302 добавить ветку:

   ```ts
   // Проверка доступности: 200 — «ссылка жива». Без кеша: общий кеш отдал бы эту заглушку человеку.
   if (visit.kind === "check") return html(200, linkPage({ url: visit.url, target: null }), "no-store");
   ```

   Остальные ветки и лимит `VISITS_PER_MINUTE` не менять.
5. **`links.repository.ts`:**
   - добавить и экспортировать
     `interface DeviceCounts { mobile: number; desktop: number; web: number; unknown: number }`;
     в `LinkStats` — поле `devices: DeviceCounts` с комментарием: «клики по
     классу устройства; без класса (`NULL`) и любой незнакомый — в `unknown`»;
   - в запросе `list` (`:97-106`) добавить столбцы и условие:

     ```sql
     count(*) FILTER (WHERE c.device_class = 'mobile')::int AS mobile_clicks,
     count(*) FILTER (WHERE c.device_class = 'desktop')::int AS desktop_clicks,
     count(*) FILTER (WHERE c.device_class = 'web')::int AS web_clicks,
     count(*) FILTER (WHERE c.device_class IS NULL OR c.device_class NOT IN ('mobile', 'desktop', 'web'))::int AS unknown_clicks,
     ...
     WHERE c.link_code IN (${Prisma.join(codes)})
       AND (c.referer_host IS NULL OR c.referer_host NOT IN (${Prisma.join(CHECKER_REFERER_HOSTS)}))
     ```

     Алиас — именно `unknown_clicks`, не `unknown`. Условие именно
     `IS NULL OR NOT IN`: у клика без Referer хост `NULL`, а `NULL NOT IN (...)`
     даёт `NULL` — такой клик выпал бы из счёта. Комментарий в запросе: клики
     проверок, записанные до T-0073, в базе остаются, но не считаются;
   - тип строки результата и сборка `devices` из `*_clicks` (`?? 0` для ссылки
     без кликов); подзапрос `launches` не менять.
6. **Панель, `apps/admin/src/api/links.ts`:**
   - `deviceCountsSchema = z.object({ mobile, desktop, web, unknown: z.number() })`,
     тип `DeviceCounts`;
   - в `linkStatsSchema` — `devices: deviceCountsSchema.catch({ mobile: 0, desktop: 0, web: 0, unknown: 0 })`
     (сервер старее панели — блока просто не будет, список не ломается);
   - `freshRow` — те же нули в `devices`;
   - ```ts
     export type DeviceKey = keyof DeviceCounts;
     export const DEVICE_TITLES: Record<DeviceKey, string> = {
       mobile: "С телефона",
       desktop: "С компьютера",
       web: "Из веб-версии",
       unknown: "Устройство не определено",
     };
     export interface DeviceRow { key: DeviceKey; title: string; count: number }
     /** Строки блока «Клики по устройствам»: телефон, компьютер, веб, не определено; нулевые пропускаются. */
     export function deviceRows(devices: DeviceCounts): DeviceRow[];
     ```
7. **`apps/admin/src/ui/help.ts`** — в `HELP.links` два ключа:
   - `clicks`: «Переходы людей по ссылке. Превью мессенджеров и известные
     сервисы проверки доступности кликами не считаются.»
   - `deviceUnknown`: «Не телефон: браузер на компьютере, неизвестный клиент
     или робот, которого нет в списке проверок сервера. Много таких кликов
     при малом числе запусков — повод присмотреться к ссылке: её могут
     проверять роботы.»
8. **`LinkCard.tsx`** — в `CardBody`:
   - у строки «Кликов» третьим элементом `HELP.links.clicks`;
   - после блока цифр — секция, если `deviceRows(link.devices)` не пуст:

     ```tsx
     <section className="flex flex-col gap-2">
       <h3 className="text-sm font-semibold">Клики по устройствам</h3>
       <KeyValue items={rows.map(/* [title, formatNumber(count)]; у "unknown" третьим — HELP.links.deviceUnknown */)} />
     </section>
     ```

     Тип кортежа — как требует `KeyValue`. Никаких новых компонентов и
     стилей: только классы, которые уже есть в этом файле.
9. **Документы** — раздел «Документы».
10. Гейт (`CLAUDE.md`) и `pnpm docs:check`; интеграционный тест — на живом
    Postgres.

## Чего не трогаем

- `crawler.ts` и `CRAWLERS`: краулеры превью остаются как были, проверки
  доступности — отдельный список с другим ответом (без кеша).
- `classifyClient` и `client-class.ts`: компьютер и веб по User-Agent на
  клике не «улучшаем» — данных клиента Telegram у клика нет.
- Схему БД и миграции: колонки уже есть. Старые клики не удаляем и не
  правим.
- `admin-links.controller.ts`: `devices` идёт через `...link`.
- `LinksScreen.tsx`: колонки списка те же, число кликов в них станет честнее
  само.
- `modules/funnel/*` и экран «Воронка» — это аккаунты по первому касанию
  (T-0053, T-0068), а не клики.
- Блокировки (403) для проверок нет: сервис получает ответ, а не отказ.
  Отсечение по IP-адресам и подсетям сервисов — не делаем.
- `T-0057` (цель ссылки, прямые ссылки), `T-0058` (страница переходника),
  `T-0067` (ссылки партнёра): их поля и поведение не меняем; эта задача
  идёт после T-0057 и правит `visit`, `list`, карточку и схему уже в том виде,
  какой они приняли. Номера строк из «Как сейчас» после T-0057 сместятся —
  ориентир по именам функций.
- Лимит частоты `/r/<код>` и порядок «краулер → недоступно → проверка».

## Сценарий и интерфейс

Карточка ссылки в панели, раздел «Привлечение» → «Ссылки», открывается из
списка (`#/links/<код>`), право `links.manage` — как у всей карточки.
Макета нет (`design: null`): блок строится из уже существующих `KeyValue` и
заголовка секции.

- **Есть клики:** под цифрами «Кликов / Запусков / Клик → запуск» — секция
  «Клики по устройствам», строки с ненулевым числом в порядке «С телефона»,
  «С компьютера», «Из веб-версии», «Устройство не определено» (последняя —
  всегда внизу и с подсказкой `?`).
- **Нет кликов** (новая ссылка, `freshRow`) **или сервер старее панели**
  (поля `devices` нет): секции нет, остальное как раньше.
- **Загрузка, ошибка, нет сети:** у карточки нет собственных — она живёт на
  уже загруженном списке; их показывает экран списка.
- **Проверка глазами:** карточка в панели на 390 и 1440 px, секция не ломает
  раскладку диалога; снимки приложить к PR.

## Тесты

Пишутся первым коммитом, до кода.

- **`backend/api/test/availability-checkers.test.ts`** (новый, без базы):
  - `checkerOf({ userAgent: <браузер>, refererHost: "check-host.net" })` →
    `"check-host"`; то же с `"check-host.net:443"` → `"check-host"`;
  - `refererHost: "evil-check-host.net"`, `"check-host.net.evil.example"`,
    `"t.me"`, `null` с браузерным User-Agent → `null`;
  - User-Agent → сервис, `refererHost: null`:
    - `"Mozilla/5.0+(compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)"` →
      `"uptimerobot"`;
    - `"Pingdom.com_bot_version_1.4_(http://www.pingdom.com/)"` → `"pingdom"`;
    - `"Mozilla/5.0 (Windows NT 6.1; WOW64; rv:45.0.247) Gecko/20100101 Firefox/83.0 Site24x7"` →
      `"site24x7"`;
    - `"Mozilla/5.0 (compatible;HostTracker/2.0;+http://www.host-tracker.com/)"` →
      `"hosttracker"`;
    - `"Mozilla/5.0 (compatible; CheckHost/1.0)"` → `"check-host"`;
  - люди и краулеры → `null`: Android Chrome
    (`"Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36"`),
    Linux Chrome (`"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36"`),
    `"TelegramBot (like TwitterBot)"`, `userAgent: null`;
  - **форма списка:** `service` уникальны и подходят под `/^[a-z0-9-]+$/`;
    у каждой записи есть признак (`refererHosts` непуст или `userAgent` не
    `null`); хосты строчные, без схемы, пути и порта; записей не меньше
    пяти; `CHECKER_REFERER_HOSTS` содержит `"check-host.net"`;
  - **достижимость:** образцы User-Agent из тестов выше (кроме браузеров и
    `TelegramBot`) **не** краулеры: `isCrawler(образец)` → `false`, иначе
    запись в списке недостижима.
- **`backend/api/test/links.test.ts`** (на подменах; `MemoryLinks.list()`
  дополнить `devices` нулями — иначе тип не сойдётся):
  - `visit` с `referer: "https://check-host.net/check-http?host=x"` и
    браузерным User-Agent → `{ kind: "check", url: <адрес ссылки> }`, после
    `setImmediate` кликов нет;
  - `visit` с User-Agent UptimeRobot и обычным Referer → `kind: "check"`,
    кликов нет;
  - `visit` с Referer `https://check-host.net.evil.example/` и браузерным
    User-Agent → `redirect`, клик записан (точное совпадение хоста);
  - приложение недоступно (`miniApp = null`): `visit` от UptimeRobot →
    `unavailable` (проверка видит настоящую недоступность);
  - краулер по-прежнему `{ kind: "preview", url }` (существующий тест не
    меняется);
  - лог: `vi.spyOn(Logger.prototype, "log")` — после `visit` от Pingdom
    вызван с JSON, где `event: "availability_check_skipped"`,
    `service: "pingdom"`, `link` — код ссылки; для человека лог не пишется;
  - HTTP `/r/:code`: запрос с User-Agent UptimeRobot → 200, `cache-control:
    no-store`, тело содержит `og:title`, кликов нет; запрос `TelegramBot` —
    по-прежнему `cache-control: private, max-age=300`.
- **`backend/api/test/links.integration.test.ts`** (`runner: local`,
  Postgres) — новый случай «проверки не считаются, устройства отдельно».
  Ссылка и пять кликов через `recordClick`:
  1. `refererHost: "t.me"`, `deviceClass: "mobile"`;
  2. `refererHost: null`, `deviceClass: "mobile"`;
  3. `refererHost: null`, `deviceClass: "unknown"`;
  4. `refererHost: null`, `deviceClass: null`;
  5. `refererHost: "check-host.net"`, `deviceClass: "unknown"`.

  Ожидание: `clicks: 4`, `clicks30d: 4`,
  `devices: { mobile: 2, desktop: 0, web: 0, unknown: 2 }`. Клик 5 не
  считается, клики 2–4 с `NULL` в Referer — считаются. Существующий случай
  «клики и запуски» остаётся зелёным и дополняется
  `devices: { mobile: 2, desktop: 0, web: 0, unknown: 0 }`.
- **`apps/admin/test/links.test.ts`:**
  - строка списка с `devices: { mobile: 3, desktop: 0, web: 0, unknown: 34 }`
    разбирается в те же числа;
  - строка без `devices` (ответ старого сервера) разбирается, `devices` —
    четыре нуля, список не ломается;
  - `deviceRows({ mobile: 3, desktop: 0, web: 0, unknown: 34 })` →
    `[{ key: "mobile", title: "С телефона", count: 3 }, { key: "unknown", title: "Устройство не определено", count: 34 }]`;
  - `deviceRows` с четырьмя нулями → `[]`; порядок при всех ненулевых —
    телефон, компьютер, веб, не определено;
  - `freshRow(...)` несёт нулевые `devices`.

## Аналитика

Новых событий нет: клики по ссылкам — таблица `link_click`, а не события
(`docs/22-analytics-and-metrics.md`, «Клики по ссылкам — таблица, а не
события»); `link_clicked` и `redirect_served` по-прежнему отложены.

Отсечённые проверки видны в логе: строка `{ module: "links", event:
"availability_check_skipped", link, service }` с уровнем `log` — по одной на
запрос; объём ограничен лимитом частоты `/r/<код>`. Prometheus-счётчик не
заводим: экспорта метрик в бэкенде ещё нет. Когда он появится, метка
`service` берётся из конечного списка пяти имён — низкая кардинальность,
`link` и адреса в метки не идут.

## Настройки и окружение

Нет: список сервисов — код (`AVAILABILITY_CHECKERS`), как `CRAWLERS`. Новых
ключей `setting-catalog.ts` и переменных окружения нет.

## Документы

- **`docs/24-attribution-and-sharing.md`** §3.3 — третьим пунктом: запросы
  известных сервисов проверки доступности тоже не клики; признак — `Referer`
  или User-Agent из `links/availability-checkers.ts`; ответ 200 без кеша
  (503, если приложение недоступно); старые клики остаются в базе, но не
  считаются; класс устройства на клике известен только у телефонов, остальное
  в карточке — «Устройство не определено».
- **`docs/22-analytics-and-metrics.md`** — в абзаце «Клики по ссылкам —
  таблица, а не события»: после «Краулеры превью кликами не считаются и не
  пишутся вовсе» добавить «Так же — известные проверки доступности».
- **`docs/21-diagrams.md`** — подпись связи `LINK ||--o{ LINK_CLICK` («клики;
  краулеры превью не пишутся») дополнить проверками доступности; абзац после
  диаграммы потока клика («Краулер мессенджера… кликом не считается») — тем
  же. Схема БД не меняется.
- **`docs/30-configuration-map.md`** — в строку про редирект-ссылки и список
  краулеров добавить «список проверок доступности» → `availability-checkers.ts`
  → `AVAILABILITY_CHECKERS`.

## Вопросы к тимлиду

Подтверждено `claude-lead-1` 13.10.2026 — делать как написано:

1. «Воронка ссылки» из записи 13.10 — это цифры карточки ссылки (клики,
   запуски, доля), а не отчёт `funnel-report.ts`.
2. Старые клики с Referer из списка не считаются в цифрах ссылки
   (чтение, не удаление). Разовая чистка таблицы — отдельное решение: это
   удаление данных.
3. Ответ проверке — 200 без кеша, 503 при недоступности приложения; не 302
   на приложение и не 403.
4. Prometheus-счётчика нет (нет экспорта метрик), только строка лога.
5. User-Agent `CheckHost` не подтверждён документацией сервиса, а Referer
   `check-host.net` — наблюдение с прода; остальные четыре сервиса — по
   публичным описаниям. Состав списка можно менять правкой одной записи.
6. Зависимость от T-0057 (общие зоны `links.service.ts`, `links.repository.ts`,
   карточка, схема панели, тесты): без неё два PR правили бы одни и те же
   строки. T-0058 и T-0067 (v0.9) пересекаются с этой задачей зонами и
   встанут в очередь по захвату; порядок между ними задаёт версия.

## Критерии приёмки

- [ ] Запрос с `Referer` `check-host.net` или с User-Agent сервиса из списка
  не пишет клик и получает 200 без кеша; при недоступном приложении — 503.
- [ ] Человек с похожим, но другим хостом Referer (`check-host.net.evil.example`)
  кликом считается.
- [ ] Краулеры превью работают как раньше (`private, max-age=300`).
- [ ] Каждая запись списка — с комментарием, почему она в нём; в списке
  `check-host.net` и ещё четыре сервиса.
- [ ] Клики с Referer из списка, записанные раньше, не входят в клики,
  клики за 30 дней и устройства ссылки; клики без Referer входят.
- [ ] В карточке ссылки — секция «Клики по устройствам»; клики без класса
  устройства стоят строкой «Устройство не определено», телефоны — отдельной
  строкой «С телефона»; нулевые строки не показываются.
- [ ] Ответ старого сервера (без `devices`) не ломает список ссылок.
- [ ] Миграций нет, строки `link_click` не удалены и не изменены.
- [ ] Документы из раздела «Документы» обновлены.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; интеграционные тесты —
  на живом Postgres.

## PR

- **Заголовок:** `fix(links): Проверки доступности — не клики`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПРОВЕРКИ ДОСТУПНОСТИ НЕ КЛИКИ**

  Переходы сервисов проверки доступности (check-host.net, UptimeRobot, Pingdom, Site24x7, HostTracker) больше не пишутся кликом по ссылке: клики и доля запусков показывают людей. В карточке ссылки клики разложены по устройствам, а те, у которых класс не определён, стоят отдельной строкой «Устройство не определено».

  🛠 **Ссылки**

  • старые клики с Referer check-host.net остаются в базе, но в цифры ссылки не идут
  • проверка получает страницу 200 без кеша, а если приложение недоступно — 503
  • новый сервис проверки — одна запись в links/availability-checkers.ts
  ```
