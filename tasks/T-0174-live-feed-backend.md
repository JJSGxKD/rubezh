---
id: T-0174
title: Лента живых событий — сервер: запись настоящих событий за сутки, кэш, маршрут
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0112]
zones:
  - backend/api/src/modules/feed/**
  - backend/api/src/modules/seasons/seasons.module.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/app.module.ts
  - backend/api/test/feed.test.ts
  - backend/api/test/feed.integration.test.ts
  - backend/api/test/feed.http.test.ts
  - backend/api/test/settings.test.ts
shared:
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/21-diagrams.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0174. Лента живых событий — сервер: запись настоящих событий за сутки, кэш, маршрут

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0174.json)](README.md#значки-статуса) [![T-0112](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0112.json&label=T-0112)](T-0112-separate-board-restriction.md)

## Зачем

Р114 (`docs/35-stage4-plan.md`): на главной — короткая лента настоящих событий
за последние сутки, чтобы игра выглядела живой без накрутки. Эта задача —
серверная половина: откуда берутся события, как хранятся, кому видны и каким
ответом уходят клиенту. Строка на главной — T-0176. События «убитый босс» и
«редкий сундук» требуют новых счётчиков забега и подключаются T-0175; здесь
два вида, которые сервер знает уже сейчас.

## Решения

Р114 (19.10.2026) дословно: события — **только настоящие, за последние
сутки**: новый рекорд недели, забег дольше 10 минут, убитый босс, редкий
сундук. Имя — **как в рейтинге**, очищенное (T-0149); скрытые игроки отдельной
доски (Р104) в ленту не попадают. Событий нет — строки нет. Накрутки нет, как и
у онлайна (Р107).

Уточнения `claude-lead2-1` по записанным правилам:

1. **«Настоящее» — это рейтинговый забег:** `RecordedRun.ranked === true`,
   вердикт `ok`, без читов. Тот же фильтр, что пускает забег в рейтинг, поэтому
   сомнительные и отклонённые забеги в ленту не попадают.
2. **Источник — слушатель `RunsHooks.onRecorded`** (первая запись забега;
   повтор итога из очереди клиента слушателей не зовёт, `runs-hooks.ts`).
   События пишутся в Redis сразу при записи забега, база не сканируется.
3. **Хранилище — Redis, потеря не страшна:** лента — витрина последних суток;
   пропавший ключ даёт пустую ленту, и она наполняется сама. Миграций нет.
4. **Скрытые игроки.** Рейтинг исключает игрока двумя путями:
   `RatingRestrictions.excluded()` — закрытый рейтинг (`leaderboard`) и
   блокировка (`all`), и `boardOf` — скрытый вид `separate_board`
   (`runs/rating-restrictions.ts:79–98`, T-0112). Ленту читают все, а сводной
   доски «по зрителю» у неё нет, поэтому исключается всё это вместе: при
   сборке ответа берётся множество `AccountRestrictions.restrictedAccounts`
   по видам `leaderboard` и `separate_board` (блокировка `all` входит в оба
   запроса) и аккаунты с `bannedAt`. Проверка — при чтении, а не при записи:
   ограничение, наложенное в течение суток, убирает уже записанные события.
5. **Рекорд недели** — забег, обошедший текущего лидера таблицы недели своей
   сложности: время строго больше прежнего первого места. Первый рейтинговый
   забег недели на пустой таблице событием не считается (рекордом он не
   является). Лидера ведёт сама лента: ключ `feed:week-top:<ключ сезона>:<сложность>`
   с атомарным «записать, если больше, и вернуть прежнее» (Lua), чтобы не
   зависеть от порядка слушателей сезонов. Сезоны выключены
   (`SeasonSchedule.current()` → `null`) — рекордов недели нет.
6. **Забег дольше 10 минут** — `survivalSec >= feed.long-run-sec`, умолчание
   600 (значение из Р114), настройка панели.
7. **Не больше двух событий одного игрока** в выдаче (настройка
   `feed.per-player`, умолчание 2): иначе один игрок, играющий подряд длинные
   забеги, заполнит ленту собой. Берутся самые свежие.
8. **Имя — `account.displayName`**, ровно то, что читает рейтинг
   (`runs.repository.ts:353`, `seasons.repository.ts:96`). Имя не копируется
   в событие: переименование модератором (T-0151) и чистка (T-0150) видны в
   ленте сразу. В Redis лежит только `accountId`, наружу он **не выходит**.

Решение claude-lead-1 от 19.10.2026: рекорд недели — строго длиннее текущего лидера
таблицы недели этой сложности; первый забег недели на пустой таблице событием
не считается (пункт 5 выше).

Решение claude-lead-1 от 19.10.2026: лимит `feed.per-player` = 2 остаётся (пункт 7 выше).

Решение claude-lead-1 от 19.10.2026: скрытые игроки видят ленту без себя: их события из
выдачи исключены, сама лента им отдаётся (пункт 4 выше).

Решение claude-lead-1 от 19.10.2026: база Redis интеграционного теста — сдвиг 9.

## Как сейчас

- `backend/api/src/modules/runs/runs-hooks.ts` — `RunsHooks.onRecorded(name,
  listener)`; `RecordedRun` (`:11–45`): `runId`, `accountId`, `difficulty`,
  `survivalSec`, `ranked`, `verdict`, `cheats`, `finishedAt`. Экспортируется
  `RunsModule` (`runs.module.ts:47`).
- `backend/api/src/modules/seasons/seasons-projection.ts:50–61` — образец
  слушателя; `SeasonSchedule.current(at)` (`seasons-schedule.ts:24`) → `Season
  { key, startsAt, endsAt } | null`. `SeasonSchedule` в `seasons.module.ts`
  есть в `providers`, но **не в `exports`** (`:43` — только
  `SeasonsProjection`): без экспорта лента его не получит.
- `backend/api/src/modules/runs/rating-restrictions.ts` — `boardOf`, `excluded`,
  `hold`; `restrictions/account-restrictions.ts:85` —
  `restrictedAccounts(kind, at)`: «не кеш, зовётся обходом, а не каждым
  запросом игрока» — поэтому ответ ленты кэшируется (шаг 5).
- `backend/api/src/modules/online/` — свежий образец небольшого модуля с
  Redis, настройками и маршрутом: `online.repository.ts` (все команды с
  таймаутом), `online.service.ts` (чтение `SETTINGS_READER`),
  `online.controller.ts` (`AuthGuard`, `RateLimit`), `online.module.ts`.
- `backend/api/src/modules/settings/setting-catalog.ts:55–94` — группы
  `…_GROUP`, `integer(key, group, title, hint, range, fallback)`.
- Тесты с живым Redis берут свою базу: `redisDatabase(…, N)`; сдвиги 1–8 и 11
  заняты (`grep redisDatabase backend/api/test`) — для ленты **9**.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Ключи настроек** (`setting-catalog.ts`), группа `const FEED_GROUP = "Лента событий"`:

   | Ключ | Название в панели | Пределы | Умолчание |
   |---|---|---|---|
   | `feed.long-run-sec` | Длинный забег от, с | 60–3600 | 600 |
   | `feed.max-shown` | Событий в ленте | 1–50 | 20 |
   | `feed.per-player` | Событий одного игрока | 1–10 | 2 |
   | `feed.refresh-sec` | Как часто клиент обновляет ленту, с | 60–3600 | 300 |

   Подсказки: «Забег не короче этого попадает в ленту», «Сколько последних
   событий отдаётся клиенту за один запрос», «Больше — ленту заполнит один
   игрок», «Клиент спрашивает ленту раз в столько секунд, пока открыта
   главная». Если в `settings.test.ts` или `test/helpers/settings.ts` каталог
   перечислен целиком — добавить ключи туда.
3. **`feed-events.ts`** — типы и схемы Zod:
   ```ts
   export const FEED_KINDS = ["long_run", "week_record", "boss", "chest"] as const;
   export type FeedKind = (typeof FEED_KINDS)[number];
   export interface FeedEvent {
     id: string;          // `<runId>:<kind>` — идемпотентность записи
     kind: FeedKind;
     accountId: string;   // наружу не выходит
     atMs: number;        // finishedAt забега
     seconds: number | null; // время забега: у long_run и week_record
   }
   ```
   Схема разбора из Redis — Zod; битая запись пропускается и считается в
   одну строку `warn` в минуту (`{ module: "feed", event: "bad_record" }`).
   Виды `boss` и `chest` в схеме есть уже сейчас — записывает их T-0175, здесь
   они только читаются и показываются.
4. **`feed-rules.ts`** — чистые функции, без Nest и Redis:
   - `feedEventsOf(run: RecordedRun, rules: { longRunSec: number }, weekRecord: boolean): FeedEvent[]`
     — `[]`, если не `ranked`, вердикт не `ok` или есть читы; иначе `long_run`
     при `survivalSec >= longRunSec` и `week_record`, если `weekRecord`;
   - `visibleEvents(events, { nowMs, hidden: ReadonlySet<string>, perPlayer, limit })`
     — отбрасывает старше 24 часов (`FEED_WINDOW_MS = 86_400_000`) и аккаунты
     из `hidden`, оставляет не больше `perPlayer` самых свежих событий
     каждого игрока, сортирует от свежих к старым, режет до `limit`.
5. **`feed.repository.ts`** — Redis, каждая команда с таймаутом
   (`withTimeout`, 2 с):
   - `add(events)` — `ZADD feed:events NX <atMs> <JSON>`; член — стабильная
     JSON-строка события (повтор того же события не дублируется);
     `ZREMRANGEBYSCORE feed:events -inf (nowMs - окно)` там же, в одном
     конвейере; на ключ `EXPIRE` 172800 с;
   - `recent(sinceMs, cap)` — `ZREVRANGEBYSCORE feed:events +inf sinceMs LIMIT 0 cap`,
     `cap` = 500 (потолок, чтобы выдача не росла с нагрузкой);
   - `bumpWeekTop(seasonKey, difficulty, survivalSec)` — Lua: нет значения →
     записать, вернуть `-1`; больше прежнего → записать, вернуть прежнее;
     иначе `0`. Ключ `feed:week-top:<сезон>:<сложность>`, `EXPIRE` 1 296 000 с
     (15 дней). Возврат `> 0` — рекорд обойдён.
   - `namesOf(accountIds)` — **в Postgres, не в Redis**: один запрос
     `account.findMany({ where: { accountId: { in }, bannedAt: null }, select: { accountId, displayName } })`
     с таймаутом 3 с; не найденные и заблокированные просто не попадают в
     ответ.
6. **`feed.service.ts`:**
   - `onModuleInit` регистрирует `RunsHooks.onRecorded("feed", …)`; слушатель не
     бросает наружу: любая ошибка — одна строка `warn` в минуту, забег от неё
     не страдает (как у `SeasonsProjection`);
   - для `ranked`-забега: `season = SeasonSchedule.current(run.finishedAt)`;
     если сезон есть — `bumpWeekTop`; `weekRecord = результат > 0 &&
     run.survivalSec > прежнее`; затем `feedEventsOf` и `repository.add`;
   - `view(now)` → `{ events: FeedEventView[]; refreshSec: number }`, где
     ```ts
     interface FeedEventView { id: string; kind: FeedKind; name: string; at: string /* ISO */; seconds: number | null }
     ```
     Алгоритм: `recent` → множество скрытых (`restrictedAccounts` по
     `leaderboard` и `separate_board`) → `visibleEvents` → `namesOf` по
     отобранным → событие без имени отбрасывается. `id` во вью — **не** сырое
     значение из Redis, а `sha1(id).slice(0, 12)`: `runId` наружу не нужен.
   - **Кэш ответа:** готовый `FeedView` держится в памяти реплики 30 с, один
     пересчёт за раз (`single-flight`: параллельные запросы ждут тот же
     промис). Игрок на запрос не ходит ни в Postgres, ни в Redis. Ошибка
     пересчёта — отдаётся прежний кэш, если он есть, иначе пустая лента, не
     500.
7. **`feed.controller.ts`** — `GET /api/v1/feed`, `AuthGuard`, лимит
   `{ scope: "feed", limit: 120, windowSec: 3600 }` на аккаунт, ответ `{ data:
   FeedView }`. Незнакомых параметров нет, тела нет.
8. **`feed.module.ts`**, подключение в `app.module.ts`. Модуль импортирует
   `AuthModule`, `RunsModule`, `SeasonsModule`, `RestrictionsModule`.
   **`seasons.module.ts`: добавить `SeasonSchedule` в `exports`** — без этого
   лента не получит расписание сезонов, а тесты, которые собирают модуль
   вручную, этого не заметят: в тест сборки модуля (`feed.http.test.ts`)
   включить проверку, что `FeedService` получает `SeasonSchedule` от
   настоящего `SeasonsModule`.
9. **Документы:**
   - `docs/30` — четыре ключа и ключи Redis `feed:events`, `feed:week-top:*`;
   - `docs/22` — раздел «Лента событий»: что считается событием, что это
     витрина, а не аналитика; события клиента — в T-0176;
   - `docs/21` — диаграмма потока «забег записан → слушатель → Redis → кэш
     ответа → клиент».

## Чего не трогаем

- Клиент: строка на главной — T-0176.
- Новые счётчики забега, события «босс» и «сундук» — T-0175 (здесь только
  виды в схеме и тексты ответа).
- `seasons-projection.ts`, таблицу недели и её хранилище: лидера лента ведёт
  сама.
- Рейтинг, его проекции и ограничения: только чтение множества
  `restrictedAccounts`.
- Метрики Prometheus: их в бэкенде пока нет (`docs/22`).

## Тесты

Пишутся первым коммитом.

- `feed.test.ts` (подмены, часы зафиксированы):
  - `feedEventsOf`: не `ranked` → `[]`; `ranked` с вердиктом не `ok` → `[]`;
    с читами → `[]`; `survivalSec` 599 при пороге 600 → без `long_run`, 600 →
    `long_run` с `seconds: 600`; `weekRecord: true` → `week_record` с тем же
    `seconds`; оба условия → два события с разными `id`;
  - `visibleEvents`: событие старше суток отброшено, ровно 24 ч назад — ещё
    видно; скрытый аккаунт отброшен; три события игрока при `perPlayer: 2` →
    два самых свежих; сортировка от свежих к старым; `limit` режет;
  - рекорд недели: `bumpWeekTop` вернул `-1` (первый забег) → нет
    `week_record`; вернул прежнее 400, забег 450 → есть; забег 400 → нет;
  - сезонов нет (`current()` → `null`) → `week_record` нет, `long_run` есть;
  - ошибка Redis при записи → слушатель не бросает, одна строка `warn` за
    минуту;
  - кэш: два параллельных `view` — один поход в Redis; второй `view` через
    29 с — из кэша, через 31 с — пересчёт; ошибка пересчёта отдаёт прежний
    кэш; без кэша — пустую ленту;
  - имя берётся из базы на момент сборки (переименование видно после
    сброса кэша); аккаунт без имени в ответе `namesOf` (заблокирован) — события
    нет; в ответе нет `accountId` и сырого `runId` ни в одном поле.
- `feed.integration.test.ts` (живые Postgres и Redis, `redisDatabase(…, 9)`):
  - запись одного и того же события дважды → одна запись в `feed:events`;
  - `bumpWeekTop`: 50 параллельных вызовов с разными значениями → итог равен
    максимуму, и возврат `> 0` получили только вызовы, обошедшие прежнее
    значение на момент своей атомарной операции (сумма «обошедших» не
    превышает числа вызовов, итоговое значение — максимум);
  - аккаунт с действующим скрытым видом `separate_board` → его события не
    видны в `view`; ограничение снято (и кэш сброшен) → видны;
  - ключ `feed:events` потерян → `view` отдаёт пустую ленту без ошибки;
  - события старше суток убираются при следующей записи.
- `feed.http.test.ts`:
  - без токена → 401; чужие параметры игнорируются;
  - превышение лимита → 429;
  - ответ — по схеме `{ data: { events, refreshSec } }`, пустая лента — `events: []`;
  - модуль собирается вместе с настоящим `SeasonsModule` (экспорт
    `SeasonSchedule`).

## Аналитика

Событий в таблице аналитики нет: лента — витрина последних суток в Redis, а не
действие игрока. Показы и клики — события клиента (T-0176, словарь `docs/22`).
Метрики: gauge «событий в ленте» появится вместе с метриками бэкенда, в
`docs/22` — строка-заготовка без кода, как у онлайна.

## Настройки и окружение

Четыре ключа каталога (шаг 2). Переменных окружения нет. Ключи Redis —
`feed:events`, `feed:week-top:*`.

## Документы

Шаг 9.

## Критерии приёмки

- [ ] Рейтинговый забег, не короче порога, и обойдённый рекорд недели
  попадают в ленту; нерейтинговые, сомнительные и с читами — нет.
- [ ] События старше суток не отдаются.
- [ ] Игроки со скрытой отдельной доской, с закрытым рейтингом и заблокированные
  в ленте не видны; в ответе нет `accountId` и `runId`.
- [ ] Имя — то же `displayName`, что в рейтинге; переименование видно без правки событий.
- [ ] Игрок на запрос ленты не ходит в базу и Redis: ответ из кэша реплики.
- [ ] Потеря Redis или ошибка пересчёта не дают 500.
- [ ] `SeasonSchedule` экспортирован, `FeedService` получает его в настоящей сборке модулей.
- [ ] Гейт (`CLAUDE.md`) зелёный, интеграционные тесты — на живых Postgres и Redis.

## PR

- **Заголовок:** `feat(feed): Лента живых событий на сервере`
- **Метка:** `release: minor`
- **Для игроков:** нет — строка появится с задачей клиента
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЛЕНТА ЖИВЫХ СОБЫТИЙ НА СЕРВЕРЕ**

  Сервер собирает настоящие события за сутки: забег дольше порога и новый рекорд недели. Скрытые игроки и игроки с закрытым рейтингом в ленту не попадают, имя берётся как в рейтинге. Порог, размер ленты и частота обновления — в панели, группа «Лента событий». Строка на главной — следующей задачей.
  ```
