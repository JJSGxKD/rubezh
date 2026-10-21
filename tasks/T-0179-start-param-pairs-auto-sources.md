---
id: T-0179
title: Авторазбор стартовых параметров ключ-значение — автоисточники и сводка незнакомых ключей
epic: E14
priority: P2
status: done
owner: claude-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/attribution/start-param.ts
  - backend/api/src/modules/attribution/start-param-pairs.ts
  - backend/api/src/modules/attribution/session-recorder.ts
  - backend/api/src/modules/attribution/attribution.module.ts
  - backend/api/src/modules/broadcasts/segment.ts
  - backend/api/src/modules/links/auto-sources.service.ts
  - backend/api/src/modules/links/auto-sources.repository.ts
  - backend/api/src/modules/links/links.repository.ts
  - backend/api/src/modules/links/links.module.ts
  - apps/admin/src/api/broadcasts.ts
  - apps/admin/src/api/funnel.ts
  - apps/admin/src/api/overview.ts
  - apps/admin/src/api/player-list.ts
  - backend/api/test/start-param.test.ts
  - backend/api/test/start-param-pairs.test.ts
  - backend/api/test/auto-sources.test.ts
  - backend/api/test/auto-sources.integration.test.ts
  - backend/api/test/session-recorder.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/test/links.test.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/24-attribution-and-sharing.md
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0179. Авторазбор стартовых параметров ключ-значение — автоисточники и сводка незнакомых ключей

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0179.json)](README.md#значки-статуса)

## Зачем

Ссылку в бота или Mini App с метками сейчас приходится сначала завести в панели
(`/r/<код>` или `l-<код>`): без этого запуск по ней записывается как
«неизвестно». Реклама и посты уходят в мир быстрее, чем их заводят в панель, и
первые игроки теряются. После задачи ссылка вида `src-tgads_cmp-oct` разбирается
сама: сервер заводит источник с пометкой «авто», и переходы с запусками
считаются с первого игрока. Это серверная половина; панель («Ссылки»:
пометка, переименование, скрытие, сводка незнакомых ключей) — T-0180.

## Решения

Р116 (`docs/35-stage4-plan.md`, 19.10.2026), дословно по смыслу:

- формат параметра — **`ключ-значение_ключ-значение`**;
- ключи — **закрытый список**, расширяется в коде с записью в
  `docs/24-attribution-and-sharing.md`;
- узнанные ключи **сразу создают источник с пометкой «авто»**;
- от мусора — **потолок новых автоисточников в сутки**; число — ключом
  каталога настроек;
- **незнакомые ключи** источником не становятся, но копятся сводкой (ключ,
  сколько раз, когда последний), с потолком числа ключей.

Подробности, которых Р116 не называет, предложил `claude-lead2-1`; приняты
`claude-lead-1` 19.10.2026:

- **Стартовый список ключей:**

  | Ключ | Что | Куда ложится у источника |
  |---|---|---|
  | `src` | источник | `link.source` |
  | `cmp` | кампания | `link.campaign` (нет `cmp` — `auto`) |
  | `plc` | место размещения | `link.medium` |
  | `prt` | партнёр | `link.partner` — **только метка**: ни привязки к карточке партнёра, ни начислений |

- **Ключ — не короче двух знаков.** Однобуквенные приставки заняты:
  `c-` (клик), `l-` (прямая ссылка), `f-` (дружба), `n-` (уведомление).
  Зарезервированы и не бывают ключами автоисточника: `panel`, `role` (вход в
  панель и подтверждение роли в боте, `PANEL_LOGIN_PREFIX`, `ROLE_CONFIRM_PREFIX`).
- Значение — `A-Za-z0-9`, 1–24 знака, без `-` и `_` (это разделители); хранится в
  нижнем регистре. Так же ключ: `[A-Za-z][A-Za-z0-9]{1,15}`, нижний регистр.
- Потолок — **20 новых автоисточников за скользящие 24 часа**, ключ
  `links.auto-daily-cap`, пределы 0–500, 0 — автосоздание выключено.
- Потолок числа незнакомых ключей — **200** (константа в коде).
- Источник привязан к **набору известных пар**, а не к одной паре: `src-a_cmp-b` и
  `src-a_cmp-c` — два источника. Порядок пар в параметре значения не имеет.

Решение claude-lead-1 от 19.10.2026: ключи `src`, `cmp`, `plc`, `prt` и правила значений
приняты; `prt` пока только метка, без привязки к карточке партнёра; потолки —
20 новых автоисточников в сутки и 200 незнакомых ключей — приняты.

## Как сейчас

- `backend/api/src/modules/attribution/start-param.ts:41-85` — `START_KINDS`,
  `parseStartParam`; формат Telegram (`TELEGRAM_START_PARAM`, строка 55) — до 64
  знаков `A-Za-z0-9_-`. Уже занято: `c-<код>`, `l-<код>`, `f-<код>`, `n-<вид>`,
  `_tgr_<id>`, `invite`. Всё прочее, подходящее по алфавиту, — `unknown` с сырой
  строкой (строка 84).
- Тот же разбор и для Mini App (`auth.service.ts:107`, параметр из подписанного
  `initData`), и для `/start` в боте (`auth.service.ts:151`, `enterChannel`; бот —
  `platforms/telegram/welcome.command.ts:169`). Оба пути приходят в
  `announce` → `AuthHooks` → `SessionRecorder.record`
  (`attribution/session-recorder.ts:73`) → задание очереди `sessions` →
  `process` (строка 94) → `sessions.repository.ts` `record`. Значит, **одно место**
  вносит автоисточник и для Mini App, и для бота.
- `session-recorder.ts:112` `sessionOf` кладёт в сессию `startKind`,
  `startParam` (сырой) и `startRef`; в `account_session` и `acquisition` поля
  `start_param`, `start_ref` — `VarChar(64)` (`schema.prisma:588,590,623,624`).
- `model Link` (`schema.prisma:1021`): `code` — ключ, `campaign` обязателен,
  `source`, `medium`, `note`, `network`, `target`, `createdBy` без внешнего
  ключа. Признака «авто», скрытия и названия нет. Каталог ссылок —
  `links.repository.ts` `list(200)` (строка 102): запуски через
  `account_session.start_kind = 'click'`, прямые — `start_kind = 'link'` по
  `start_ref = link.code` (строки 130-135).
- Копия `START_KINDS` для сегментов рассылок — `broadcasts/segment.ts:29`.
  `player-list/player-list-query.ts:3` берёт список из `start-param.ts`.
- Подписи видов касания в панели: `apps/admin/src/api/{broadcasts.ts:28,
  overview.ts:61, player-list.ts:20, funnel.ts:117}`.
- Каталог настроек — `settings/setting-catalog.ts`: `integer(key, group, title,
  hint, range, fallback)` (образец — группа «Онлайн», T-0147); читается
  `this.settings.get(SETTINGS.<ключ>)`. Группа ссылок `LINKS_GROUP`
  (`setting-catalog.ts:94`) — про домен Telegram, не про это.
- Событий для серверной атрибуции нет: клики и запуски — таблицы и сессии
  (`docs/22` «Клики по ссылкам — таблица, а не события»).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция** по процедуре «Общие файлы» из `tasks/README.md` (`prisma migrate
   dev --create-only` один раз, на отдельной базе; проверить, что папка миграции
   одна). Только добавления:
   - `StartKind` += `tagged`, комментарий `/// ссылка с метками ключ-значение,
     источник заведён сам (Р116)`;
   - `Link`: `auto Boolean @default(false)` (`/// источник заведён сам по
     параметру запуска (Р116)`), `autoKey String? @unique @db.VarChar(64)`
     (`/// канонический набор известных пар: src-…_cmp-…`), `partner String?
     @db.VarChar(64)`, `title String? @db.VarChar(80)` (`/// название, которое
     дали в панели; пусто — показывается кампания`), `hiddenAt DateTime?
     @db.Timestamptz(3)` (`/// скрыт в панели; запуски по нему считаются`);
   - новая модель `StartParamKey` → таблица `start_param_key`: `key
     String @id @db.VarChar(16)`, `hits Int`, `firstAt`, `lastAt`
     (`Timestamptz(3)`), комментарий «незнакомый ключ параметра запуска: сколько
     раз и когда последний, значения не храним».
3. **Новый `attribution/start-param-pairs.ts`** — чистые функции, без Nest и базы:
   - `AUTO_KEYS = ["src", "cmp", "plc", "prt"] as const` (порядок — канонический) и
     `RESERVED_KEYS = ["panel", "role"]`;
   - `parsePairs(value: string): PairsResult | null`. `null` — это не формат
     пар. Строка делится по `_`, каждая часть — `^([A-Za-z][A-Za-z0-9]{1,15})-([A-Za-z0-9]{1,24})$`;
     пустая часть, повтор ключа, ключ из `RESERVED_KEYS`, больше шести частей —
     `null`;
   - `PairsResult = { known: Partial<Record<AutoKey, string>>; canonical: string
     | null; unknownKeys: string[] }`: ключи и значения в нижнем регистре,
     `canonical` — известные пары в порядке `AUTO_KEYS` через `_` (`src-tgads_cmp-oct`),
     `null`, если известных нет; `unknownKeys` — незнакомые ключи по алфавиту.
4. **`start-param.ts`:**
   - `START_KINDS` += `"tagged"` (и копия в `broadcasts/segment.ts`);
   - у `StartParam` — необязательное поле `unknownKeys?: string[]`: есть только у
     результата, разобранного как пары (у остальных видов его нет, чтобы не
     сломать `toEqual` в тестах);
   - в конце `parseStartParam`, **после** всех существующих видов, перед
     `unknown`: `parsePairs`; есть `canonical` → `{ kind: "tagged", raw: value,
     ref: canonical, unknownKeys }`; пар нет, но ключи есть → `{ kind: "unknown",
     raw: value, ref: null, unknownKeys }`. Порядок важен: `c-`, `l-`, `f-`, `n-`,
     `_tgr_`, `invite` разбираются раньше и пар не касаются.
5. **`links/auto-sources.repository.ts`** (интерфейс + Prisma, токен
   `AUTO_SOURCES_REPOSITORY`):
   - `ensure(input: { autoKey, source, campaign, medium, partner, platform, now,
     cap }): Promise<"created" | "existing" | "capped">`. Одна транзакция с
     `pg_advisory_xact_lock(hashtext('link_auto_source'))`: источник с таким
     `auto_key` есть (в том числе скрытый) → `existing`; иначе считаем `auto = true
     AND created_at > now - 24 ч`, не меньше `cap` → `capped`; иначе вставка с
     `newLinkCode()`, `auto = true`, `target = 'app'`, `network = null`,
     `createdBy = null`. `cap = 0` → `capped` без запроса. Замок нужен: без него
     параллельные первые игроки разных ссылок пробивают потолок;
   - `noteUnknownKeys(keys: string[], now): Promise<void>` — для каждого ключа
     `INSERT … ON CONFLICT (key) DO UPDATE SET hits = hits + 1, last_at = …`; новые
     ключи вставляются, только пока в таблице меньше `UNKNOWN_KEYS_MAX` (200),
     иначе пропускаются.
6. **`links/auto-sources.service.ts`** — `onSession(session: { startParam: string
   | null; platform; startedAt })`:
   - разобрать `parseStartParam(session.startParam)` заново (разбор чистый, а в
     задании очереди только сырая строка);
   - `tagged` → `known` в поля источника по таблице из «Решений», `ensure`; результат
     — строка лога `{ module: "links", event: "auto_source", result }` (`created`
     — уровень `log`, остальное — `debug`);
   - `unknownKeys` не пуст → `noteUnknownKeys`;
   - платформа источника — платформа сессии, если она есть в `enum Platform`,
     иначе `telegram`.
7. **`session-recorder.ts`** `process`: после `sessions.record(...)`, **только если
   результат `recorded`** (повтор задания очереди счётчики не двигает), вызвать
   `autoSources.onSession(...)` в `try/catch` — ошибка пишется `warn` и не
   пробрасывается: сессия уже записана, а источник заведёт следующий игрок. Модуль:
   `AttributionModule` импортирует `LinksModule`, а `LinksModule` в `exports`
   добавляет `AutoSourcesService` (без экспорта провайдер молча пропадёт для других
   модулей). Цикла быть не должно: `LinksModule` модуль атрибуции не импортирует —
   проверить запуском `AppModule` в тесте.
8. **`links.repository.ts`** `list`: запрос прямых запусков считает и
   `start_kind = 'tagged' AND start_ref = link.auto_key`, поле `directLaunches`
   остаётся тем же («запуски без клика»). Запись `LinkRecord` получает `auto`,
   `partner`, `title`, `hiddenAt` (скрытые из `list` **не убираются**: фильтр — в
   панели, T-0180). Сессии, пришедшие до заведения источника, считаются сразу, потому
   что связь идёт по ключу, а не по времени.
9. **Ключ настройки** `links.auto-daily-cap` в `setting-catalog.ts`: группа
   `const AUTO_SOURCES_GROUP = "Автоисточники"`, `integer`, пределы 0–500, единица
   «источник / источника / источников», умолчание 20, подсказка: «Сколько новых
   источников в сутки сервер заводит сам по ссылкам с метками. Нуль — не заводить;
   запуски по таким ссылкам всё равно записываются и подхватятся, когда источник
   появится».
10. **Подписи вида касания `tagged`** — «ссылка с метками»: четыре файла
    `apps/admin/src/api/*.ts` из «Как сейчас». Больше ничего в панели не менять
    (экран — T-0180).
11. **Документы:** `docs/24` — новый §3.6 «Ссылки с метками (Р116)»: формат, список
    ключей и как добавить ключ, границы Telegram (64 знака, `A-Za-z0-9_-`), чем
    отличается от `l-<код>`, потолок и сводка, тот же путь для Mini App и бота;
    раздел 5 — вид `tagged`. `docs/22` — строка `session_started`: новый
    `start_kind`; абзац «таблица, а не события» — автоисточники и
    `start_param_key`. `docs/21` — ER: колонки `link`, таблица `start_param_key`,
    значение `tagged` в перечислении. `docs/30` — ключ `links.auto-daily-cap`.

## Чего не трогаем

- Переходник `/r/<код>`, `l-<код>`, `c-<код>` и их разбор: старые форматы работают
  как раньше (регрессия — в тестах).
- Панель «Ссылки» — T-0180. Прямые ссылки для рекламы сетей — T-0181.
- Ежедневный отчёт в чат команды (`admin-notify/daily-stats*.ts`): вид `tagged` там
  попадёт в «неизвестно», как сейчас `link` (`tasks/inbox.md`, строка про отчёт).
- Привязка `prt` к карточке партнёра, начисления, постбэки: метка и только.
- Антифрод: объём самих запусков он не ограничивает, потолок только на число
  новых источников.

## Тесты

Пишутся первым коммитом. Живые Postgres и Redis — по `docs/17-testing-strategy.md`
§4.2.

- `start-param-pairs.test.ts` (чистые):
  - `src-tgads_cmp-oct` → `tagged`, `ref: "src-tgads_cmp-oct"`;
  - `CMP-Oct_SRC-TGads` → `tagged`, `ref: "src-tgads_cmp-oct"` (порядок и регистр);
  - `cmp-oct_zzz-1` → `tagged`, `ref: "cmp-oct"`, `unknownKeys: ["zzz"]`;
  - `zzz-1_yyy-2` → `unknown`, `raw` сохранена, `unknownKeys: ["yyy", "zzz"]`;
  - `src-a_src-b`, `src-a_`, `_src-a`, `src-`, `src-a-b`, `s-1` (ключ в один знак),
    `panel-x1`, `role-x1`, значение в 25 знаков, семь пар → `unknown`, поля
    `unknownKeys` нет;
  - регрессия `start-param.test.ts`: `c-AbCdEf123456`, `l-AbCdEf1234`,
    `f-AbCdEf1234`, `n-friend_request`, `invite`, `_tgr_123` разбираются как раньше.
- `auto-sources.test.ts` (подмены):
  - первая сессия `src-tgads_cmp-oct_plc-post_prt-ivan` → источник создан:
    `source tgads`, `campaign oct`, `medium post`, `partner ivan`, `auto true`;
  - без `cmp` → `campaign auto`;
  - тот же ключ ещё раз, в другом порядке пар → `existing`, строка одна;
  - потолок 2: третий разный ключ → `capped`, строки нет, сессия записана; потолок 0
    → `capped` для первого же;
  - скрытый источник: повторный запуск не создаёт нового и не снимает скрытие;
  - незнакомые ключи: счётчик растёт, `last_at` обновляется; 201-й ключ не
    добавляется;
  - сессия `duplicate` от очереди → ни источник, ни счётчик не меняются;
  - ошибка `ensure` → `process` не падает, сессия записана, `warn` в логе.
- `auto-sources.integration.test.ts` (живая база):
  - 20 параллельных регистраций разных ключей при потолке 5 → ровно 5 строк;
  - 20 параллельных регистраций одного ключа → одна строка;
  - три аккаунта запустили игру по `src-x` до заведения источника и один после →
    `directLaunches: 4` у источника, `launches: 0`;
  - вход через `enterChannel` (бот) и через Mini App дают один источник;
  - `AppModule` собирается: `AutoSourcesService` виден из `AttributionModule`.
- `session-recorder.test.ts`: `process` вызывает `onSession` только при `recorded`.

## Аналитика

Новых событий нет: серверная атрибуция — таблицы и сессии, не события
(`docs/22`, «Клики по ссылкам — таблица, а не события»). Видно:

- `session_started` и `acquisition` получают значение `start_kind = tagged`, в
  `start_ref` — канонический набор пар (разрезы по источнику и кампании — через
  `link.auto_key`);
- автоисточник — строка `link` с `auto = true`, незнакомые ключи — таблица
  `start_param_key`;
- в логе — `auto_source` с исходом (`created`, `existing`, `capped`). Метрик
  Prometheus в бэкенде пока нет; когда появятся, счётчик исходов — с меткой
  `result` без идентификаторов (`docs/22`, кардинальность).

## Настройки и окружение

Один ключ каталога: `links.auto-daily-cap`, 0–500, умолчание 20. Переменных
окружения нет.

## Документы

См. шаг 11: `docs/24` (§3.6, раздел 5), `docs/22`, `docs/21`, `docs/30`. Если
`layer-boundaries` или тест словаря потребует правки — в тех же файлах.

## Критерии приёмки

- [ ] `src-a_cmp-b` через Mini App и через `/start` заводит один источник с
  пометкой «авто», запуски по нему видны в `directLaunches` с первого игрока.
- [ ] Порядок и регистр пар не плодят источников.
- [ ] Новых автоисточников за 24 часа не больше значения `links.auto-daily-cap`,
  в том числе при параллельных запусках; при 0 не создаётся ни один.
- [ ] Незнакомые ключи копятся в `start_param_key` (ключ, число, последний раз),
  не больше 200 ключей; значения не сохраняются.
- [ ] `c-`, `l-`, `f-`, `n-`, `_tgr_`, `invite`, `panel-`, `role-` ведут себя как
  раньше.
- [ ] Повтор задания очереди не двигает ни источники, ни счётчики.
- [ ] Миграция только добавляет; папка миграции одна.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(attribution): Авторазбор ссылок с метками и автоисточники`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — АВТОРАЗБОР ССЫЛОК С МЕТКАМИ И АВТОИСТОЧНИКИ**

  Ссылка в бота или Mini App вида src-tgads_cmp-oct теперь разбирается сама: сервер заводит источник с пометкой «авто», и запуски по нему считаются с первого игрока. Незнакомые ключи копятся сводкой. Панель — следующей задачей.

  🛠 **Как это работает**

  • ключи пока четыре: src (источник), cmp (кампания), plc (место), prt (партнёр, только метка)
  • новых автоисточников не больше 20 в сутки — число меняется в панели, «Настройки», «Автоисточники»; 0 — выключить
  • старые ссылки (/r/<код>, прямые, дружба, приглашения) работают как раньше

  ❓ **Нужно от команды**

  • @участник1 — после выката сходить по тестовой ссылке с метками из бота и из Mini App и убедиться, что источник один
  ```
