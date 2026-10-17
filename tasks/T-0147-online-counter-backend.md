---
id: T-0147
title: Счётчик онлайна — бэкенд: активность, пинг, подсчёт, ключи настроек
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/online/**
  - backend/api/src/modules/auth/auth.guard.ts
  - backend/api/src/modules/auth/auth.module.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/app.module.ts
  - backend/api/test/online.test.ts
  - backend/api/test/online.integration.test.ts
  - backend/api/test/online.http.test.ts
shared:
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0147. Счётчик онлайна — бэкенд: активность, пинг, подсчёт, ключи настроек

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0147.json)](README.md#значки-статуса)

## Зачем

Р107 (`docs/35-stage4-plan.md`): игрок видит, сколько людей сейчас в игре и в
забеге, панель — то же по площадкам. Эта задача — серверная половина. Клиент и
панель — следующими задачами по готовому ответу этого API.

## Решения

Всё — из Р107 (15.10.2026). Уточнения `claude-lead-1` от 15.10.2026:

- **Активность — любой запрос под сессией игрока** (`AuthGuard`), плюс пинг.
  Запросы панели (`AdminSessionGuard`) не считаются.
- **«В забеге»** — только по пингу с `inRun: true`. Пинг с `inRun: false`
  убирает аккаунт из «в забеге» сразу, не дожидаясь окна.
- **«Сегодня играли»** — аккаунты с активностью за игровые сутки
  (`GAME_DAY_TIME_ZONE`, `common/game-day.ts`), приблизительный счёт
  HyperLogLog: точность ±1% для витрины достаточна, память постоянная.
- **Пороги применяет сервер.** Ниже порога поле в ответе — `null`, клиент
  ничего не решает: порог меняется из панели без релиза.
- **Пересчёт раз в 15 с** — планировщиком BullMQ с постоянным id, как
  `export/retention.job.ts`. Планировщик выпускает одно задание на тик на все
  реплики — это и есть распределённый лок из Р107.
- **Рекорд онлайна** — в Redis (значение и время). Перенос в базу — вместе со
  сводкой «чего достигли» (входящие), не здесь.
- **Prometheus в бэкенде пока нет** — gauge из Р107 появится вместе с метриками;
  в `docs/22` — строка-заготовка, без кода.

## Как сейчас

- `backend/api/src/modules/auth/auth.guard.ts:30–62` — `AuthGuard`;
  `revocations` подключён `@Optional()`, потому что гард собирают вручную
  десятки тестов (комментарий в строках 31–32). Claims — `{ accountId,
  platform, platformUserId }` (`auth/access-token.ts:34`).
- `backend/api/src/modules/export/retention.job.ts:50–64` — образец
  периодического задания: `upsertJobScheduler(id, { every })`, воркер с
  `concurrency: 1`, ошибки — `warn` в лог.
- `backend/api/src/modules/settings/setting-catalog.ts:103` — `integer(key,
  group, title, hint, range, fallback)`; группы — константы `…_GROUP`
  (строки 55–94).
- `backend/api/src/modules/account-settings/account-settings.controller.ts:13`
  — лимит частоты: `RateLimit { scope, limit, windowSec }` и `RateLimiter`
  из `ingest/rate-limiter.ts`.
- `backend/api/src/modules/admin/admin-overview.controller.ts:14–23` — образец
  маршрута панели: `@UseGuards(AdminSessionGuard, PermissionGuard)`,
  `@RequirePermission("analytics.gameplay.view")`.
- `backend/api/src/infra/redis.ts` — клиент Redis.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Ключи настроек** — группа `const ONLINE_GROUP = "Онлайн"`, четыре `integer`:

   | Ключ | Название в панели | Пределы | Умолчание |
   |---|---|---|---|
   | `online.window-sec` | Окно активности, с | 30–600 | 120 |
   | `online.ping-sec` | Интервал пинга, с | 15–300 | 45 |
   | `online.min-shown` | Онлайн виден игроку от | 0–100000 | 20 |
   | `online.run-min-shown` | «В забеге» виден игроку от | 0–100000 | 5 |

   Подсказки: «Аккаунт считается онлайн, пока с последней активности прошло
   меньше окна», «Клиент шлёт пинг с этим интервалом; если он не меньше половины
   окна, берётся половина окна», «Ниже — игрок видит «сегодня играли»», «Ниже —
   на кнопке «Играть» числа нет».
3. **`modules/online/online.repository.ts`** — только Redis, все команды с
   таймаутом:
   - `touch(accountId, platform, nowMs, gameDay)` — pipeline:
     `ZADD online:app:<platform> nowMs accountId`,
     `PFADD online:day:<gameDay> accountId`,
     `PFADD online:day:<gameDay>:<platform> accountId`, `EXPIRE` дневных
     ключей 172800 с;
   - `setInRun(accountId, platform, inRun, nowMs)` — `ZADD` или `ZREM`
     в `online:run:<platform>`;
   - `recount(nowMs, windowMs, gameDay)` — по каждой площадке
     `ZREMRANGEBYSCORE … -inf (nowMs-windowMs)` и `ZCARD` для `app` и `run`,
     `PFCOUNT` дневных ключей. Итог — JSON в `online:counts`;
   - `counts()` — чтение `online:counts`, разбор Zod-схемой, нет ключа —
     `null`;
   - `peak()` / `setPeak(value, atMs)` — `online:peak`.
   Площадки — `PlatformId` (`telegram`, `max`, `vk`, `web`).
4. **`online.service.ts`**:
   - `touch(claims, now)` — вызывается гардом, **не блокирует ответ**: промис
     без `await` в гарде, ошибка — счётчик и не больше одной строки `warn` в
     минуту (`{ module: "online", event: "touch_failed" }`);
   - `ping(claims, inRun, now)` → `PingResult`:
     ```ts
     interface PingResult {
       online: number | null;      // всего по площадкам; null — ниже online.min-shown
       inRun: number | null;       // null — ниже online.run-min-shown
       todayPlayed: number | null; // только когда online === null
       nextPingSec: number;        // min(online.ping-sec, floor(online.window-sec / 2))
     }
     ```
     Нет посчитанных чисел (первые 15 с после старта, Redis пуст) — все три
     `null`;
   - `adminSnapshot()` → `{ byPlatform: Record<PlatformId, { app, run, today }>,
     total: { app, run, today }, peak: { value, at } | null, at }` — без
     порогов;
   - `recount(now)` — для задания: пересчёт, затем рекорд — если `total.app`
     больше `peak.value`, записать новый рекорд.
5. **`online.job.ts`** — по образцу `retention.job.ts`: очередь `online`,
   планировщик `"recount"` с `every: 15_000`, воркер `concurrency: 1`.
   Выключен там же, где выключены другие задания (тот же признак, что у
   `retention.job.ts`).
6. **`online.controller.ts`**:
   - `POST /api/v1/online/ping` — `AuthGuard`, тело Zod
     `z.object({ inRun: z.boolean() })`, лимит `{ scope: "online-ping", limit: 240, windowSec: 3600 }`,
     ответ `{ data: PingResult }`. Активность сам пинг пишет через гард, как
     любой запрос;
   - `GET /api/v1/admin/online` — `AdminSessionGuard`, `PermissionGuard`,
     `@RequirePermission("analytics.gameplay.view")`, ответ
     `{ data: adminSnapshot }`.
7. **`AuthGuard`** — `@Optional() private readonly online?: OnlineActivity`
   (узкий интерфейс `{ touch(claims, now): void }`, не весь сервис). После
   `request.account = check.claims` — `this.online?.touch(check.claims, new Date())`.
   Комментарий: активность — любой запрос под сессией, поэтому клиент не
   шлёт пинг, если уже ходил в API.
8. **`online.module.ts`**, подключение в `app.module.ts` и провайдер
   `OnlineActivity` для `AuthModule`. Цикл модулей не заводить: `OnlineActivity`
   — токен в `modules/online/online-activity.ts`, его реализует сервис.
9. **Документы:**
   - `docs/30` — четыре ключа и ключи Redis `online:*`;
   - `docs/22` — раздел «Онлайн»: что считается, что это не событие,
     заготовка gauge `online_accounts{platform,state}` до появления метрик;
   - `docs/21` — диаграмма потока «пинг → Redis → пересчёт → ответ».

## Чего не трогаем

- Клиент и панель: экраны — следующими задачами (T-0148).
- `AdminSessionGuard`: панель онлайном не считается.
- Антифрод-урезание числа (Р107, «позже»).

## Тесты

- `online.test.ts` (подмены):
  - `nextPingSec`: 45 при окне 120; 50 при пинге 60 и окне 100;
  - пороги: `total.app` 19 при пороге 20 → `online: null`, `todayPlayed` —
    число; 20 → `online: 20`, `todayPlayed: null`;
  - `inRun` 4 при пороге 5 → `null`; 5 → `5`;
  - нет `online:counts` → три `null`;
  - рекорд: 30 при рекорде 25 → новый рекорд; 20 при рекорде 25 → прежний;
  - ошибка Redis в `touch` → гард пропускает запрос, `warn` не чаще раза в
    минуту.
- `online.integration.test.ts` (живой Redis, своя база — `redisDatabase(…, 6)`,
  `docs/17` §4.2; сдвиг 2, то есть база 13, занят `runs.integration.test.ts` —
  ответ claude-lead-1 на вопрос 1 PR #375, 17.10.2026):
  - три аккаунта двух площадок, один — 130 с назад → `app`: 2, по
    площадкам верно;
  - пинг `inRun: true`, затем `false` → `run` 1, затем 0;
  - тот же аккаунт десять раз за сутки → `today` 1; два аккаунта → 2;
  - 50 параллельных `touch` одного аккаунта → `app` 1.
- `online.http.test.ts`:
  - пинг без токена → 401; тело без `inRun` → 400;
  - превышение лимита → 429;
  - `GET /admin/online` без права → 403, с правом → снимок по площадкам.

## Аналитика

Событий нет: онлайн — мгновенное состояние, а не действие игрока. Рекорд — в
`online:peak`, в сводку «чего достигли» перейдёт её задачей. Gauge — когда в
бэкенде появятся метрики (`docs/22`).

## Настройки и окружение

Четыре ключа каталога (шаг 2). Переменных окружения нет.

## Документы

Шаг 9.

## Критерии приёмки

- [ ] Любой запрос игрока под сессией отмечает активность и не ждёт Redis.
- [ ] Пинг возвращает числа с порогами из панели и интервал до следующего
  пинга.
- [ ] Ниже порога вместо онлайна — «сегодня играли».
- [ ] Числа пересчитываются раз в 15 с одним заданием на все реплики.
- [ ] Панель получает разбивку по площадкам и рекорд.
- [ ] Гейт (`CLAUDE.md`) зелёный, интеграционные тесты — на живом Redis.

## PR

- **Заголовок:** `feat(online): Счётчик онлайна на сервере`
- **Метка:** `release: minor`
- **Для игроков:** нет — число появится с задачей клиента
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СЧЁТЧИК ОНЛАЙНА НА СЕРВЕРЕ**

  Сервер считает онлайн и «в забеге» по площадкам: любой запрос игрока — активность, клиент шлёт пинг раз в 45 с только в тишине. Пороги показа, окно и интервал — в панели, группа «Онлайн». Ниже порога игроку уходит «сегодня играли». Экраны — следующей задачей.
  ```
