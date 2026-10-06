---
id: T-0035
title: Тревога в чат команды о всплеске ошибок 5xx
epic: E3
priority: P1
status: ready
owner:
size: S
depends_on: [T-0003, T-0033]
zones:
  - backend/api/src/modules/admin-notify/server-error-alarm.ts
  - backend/api/src/modules/admin-notify/admin-notify.module.ts
  - backend/api/src/modules/settings/notify-targets.ts
  - backend/api/src/http-app.ts
  - backend/api/test/server-error-alarm.test.ts
shared:
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/28-diagnostics.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: null
---

# T-0035. Тревога в чат команды о всплеске ошибок 5xx

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0035.json)](README.md#значки-статуса) [![T-0003](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0003.json&label=T-0003)](T-0003-payments-fulfillment-sweeper.md) [![T-0033](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0033.json&label=T-0033)](T-0033-health-ready.md)

## Зачем

Внешняя проверка (T-0034) скажет, что прод лежит целиком. Но API может быть
жив и отвечать на проверку, а часть запросов — падать с 500 или 503: сломался
модуль, отвалилась очередь, кончилось место. Сейчас этого никто не видит. Пункт
К10 аудита, вторая половина.

## Решения

- **Решение пользователя от 06.10.2026 — лёгкий мониторинг без новых
  сервисов:** счётчик 5xx живёт в самом API и в Redis.
- **Порог:** 20 ответов 5xx за календарную минуту на все реплики. Тревога —
  в момент, когда счётчик минуты дошёл до порога, а потом тишина 15 минут.
  Всплеск даёт одно сообщение, а не по сообщению в минуту.
- **Новый поток уведомлений «Сбои сервера» — `notify.chat.ops`.** Адрес
  задаётся в панели, без переменной окружения, пусто — общий чат команды.
  Так заведены все новые потоки (решение пользователя от 05.10).
- **Redis недоступен** — счётчик и тишина в памяти процесса. При нескольких
  репликах порог мягче, но сообщение о сбое важнее точности. Без Redis 5xx и
  так посыплются.
- **В сообщении** — число, минута, коды по количеству (500 × 14, 503 × 6).
  Без путей, текстов ошибок и данных игроков.

## Как сейчас

- `backend/api/src/http-app.ts`, `configureHttpApp`:
  - глобальный фильтр ошибок `DomainErrorFilter`;
  - хук Fastify `onSend` для заголовков безопасности
    (`app.getHttpAdapter().getInstance().addHook(...)`).

  Счётчика ответов нет.
- Неизвестные ошибки фильтр превращает в 500 (`common/domain-error.filter.ts:58-59`).
  `UnavailableError` — 503.
- Образец уведомления команды — `modules/admin-notify/fx-alert-notifier.ts` и
  `payments-alert-notifier.ts` из T-0003:
  - адрес — `targets.chats().<поток>`;
  - отправка с таймаутом;
  - нет чата или Redis — в лог и дальше.
- Потоки — `modules/settings/notify-targets.ts` (`AdminChats`, `chats()`,
  `orGeneral(SETTINGS.…)`) и `setting-catalog.ts`, конструктор
  `chat(key, title, hint, env)`. Поток без окружения — `() => ""`, как
  `notify.chat.payments` в T-0003.

## Шаги по порядку

1. Тест первым коммитом (раздел «Тесты»).
2. **`setting-catalog.ts`** — в группе потоков, после `chatPayments`:

   ```ts
   chatOps: chat("notify.chat.ops", "Сбои сервера", "Всплеск ошибок 5xx API: 20 за минуту и больше. Пусто — общий чат", () => ""),
   ```
3. **`notify-targets.ts`:**
   - `AdminChats` — поле `ops: ChatTarget | null` с комментарием;
   - `chats()` — `ops: orGeneral(SETTINGS.chatOps)`.
4. **Новый `modules/admin-notify/server-error-alarm.ts`** — `ServerErrorAlarm`:
   - константы с комментариями «почему»:

     ```ts
     const THRESHOLD = 20;
     const QUIET_SEC = 15 * 60;
     const SEND_TIMEOUT_MS = 5_000;
     ```

   - `record(status: number, nowMs = Date.now()): Promise<void>`:
     1. `minute = Math.floor(nowMs / 60_000)`;
     2. `HINCRBY alarm:5xx:<minute> <status> 1` и `HINCRBY alarm:5xx:<minute> total 1`
        в одном `multi`, `EXPIRE alarm:5xx:<minute> 120`;
     3. `total === THRESHOLD` → `SET alarm:5xx:quiet 1 EX QUIET_SEC NX`;
        поставилось — `HGETALL` минуты и отправка;
     4. ошибка Redis → тот же расчёт в памяти: `Map` минуты, поле
        `quietUntilMs`. Старые минуты удалять при каждом вызове.
   - сообщение:

     ```
     🔥 Всплеск ошибок API: <total> ответов 5xx за минуту с <ЧЧ:ММ> UTC
     Коды: 500 × 14, 503 × 6
     Следующее сообщение — не раньше чем через 15 минут. Логи: docker compose logs --tail 200 api
     ```

     Коды — по убыванию количества.
   - отправка — как в `fx-alert-notifier.ts`, в `targets.chats().ops`. Нет
     чата или токена бота — лог `warn` `server_error_alarm` с полями и выход.
     Ошибка отправки — в лог.
   - `record` никогда не бросает: ответ игроку уже ушёл, а счётчик —
     второстепенен.
5. **`admin-notify.module.ts`** — `ServerErrorAlarm` в `providers` и `exports`.
6. **`http-app.ts`, `configureHttpApp`:**
   - `const alarm = app.get(ServerErrorAlarm, { strict: false })` в
     `try/catch`. В тестах HTTP-слоя без модуля уведомлений провайдера нет —
     тогда хук не ставится;
   - хук Fastify `onResponse`:
     `if (reply.statusCode >= 500) void alarm.record(reply.statusCode)`;
   - комментарий — почему `onResponse`: ответ уже ушёл, счётчик не держит
     игрока.
7. **Документы** — раздел «Документы».

## Чего не трогаем

- `DomainErrorFilter` и коды ошибок.
- Лог необработанных ошибок: он остаётся как есть.
- Внешнюю проверку — T-0034.

## Тесты

Первым коммитом, новый `backend/api/test/server-error-alarm.test.ts`. Redis —
подмена в памяти с `multi`, `hincrby`, `expire`, `set NX`, `hgetall` или
тестовый Redis, как у соседних тестов. Отправка — подмена.

- 19 ответов 500 за минуту → сообщений нет;
- 20-й → одно сообщение, в нём «20 ответов 5xx» и «500 × 20»;
- 25 за ту же минуту → по-прежнему одно сообщение;
- следующая минута, ещё 20 → сообщений нет: тишина 15 минут;
- через 16 минут, 20 за минуту → второе сообщение;
- 12 × 500 и 8 × 503 → «Коды: 500 × 12, 503 × 8»;
- Redis бросает → счёт в памяти, на 20-м — одно сообщение;
- отправка бросает → `record` не бросает;
- HTTP — через `createHttpApp` с маршрутом, который бросает `Error`:
  21 запрос → `record` вызван 21 раз с 500. Если собрать такой модуль в
  тесте сложно — подменить `ServerErrorAlarm` и проверить вызовы хука.

## Аналитика

Нет событий продукта. Метрики Prometheus не заводим: решение пользователя —
без новых сервисов.

## Настройки и окружение

- Новый ключ каталога настроек `notify.chat.ops` — поток «Сбои сервера», без
  переменной окружения, пусто — общий чат.

## Документы

- `docs/28-diagnostics.md`, раздел об уведомлениях команды — строка «Сбои
  сервера: 20+ ответов 5xx за минуту — одно сообщение, затем тишина 15 минут;
  поток `notify.chat.ops`».
- `docs/30-configuration-map.md` — строка «Тревога о 5xx: порог, тишина» →
  `admin-notify/server-error-alarm.ts`, `THRESHOLD`, `QUIET_SEC`; поток —
  панель, `notify.chat.ops`.

## Критерии приёмки

- [ ] При 20 ответах 5xx за минуту в чат команды (поток «Сбои сервера» или
  общий) приходит одно сообщение с числом и кодами. Следующее — не раньше
  чем через 15 минут.
- [ ] Ответ игроку не ждёт счётчика.
- [ ] Без Redis тревога работает по памяти процесса.
- [ ] Поток `notify.chat.ops` есть в панели, без переменной окружения.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Тревога о всплеске ошибок 5xx`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ТРЕВОГА О ВСПЛЕСКЕ ОШИБОК**

  Если API жив, но запросы массово падают с ошибкой сервера, команда узнает об этом сразу: 20 ответов 5xx за минуту — сообщение в чат.

  🔥 **Как устроено**

  • счётчик в самом API и в Redis, без новых сервисов на сервере
  • одно сообщение на всплеск: число, минута и коды; затем тишина 15 минут
  • новый поток уведомлений «Сбои сервера» — адрес в панели, пусто — общий чат

  ❓ **Нужно от команды**

  • @участник1 — если нужен отдельный поток для сбоев: создать тему в чате и вписать её адрес в панели (notify.chat.ops)
  ```
