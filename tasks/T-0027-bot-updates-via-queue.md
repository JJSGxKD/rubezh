---
id: T-0027
title: Обновления бота не теряются при перезапуске — сначала очередь, потом ответ
epic: E4
priority: P0
status: ready
owner:
size: M
depends_on: [T-0020]
zones:
  - backend/api/src/platforms/telegram/bot-update-queue.ts
  - backend/api/src/platforms/telegram/bot-webhook.controller.ts
  - backend/api/src/platforms/telegram/bot-poller.ts
  - backend/api/src/platforms/telegram/bot-router.ts
  - backend/api/src/platforms/telegram/bot.module.ts
  - backend/api/test/bot-update-queue.test.ts
  - backend/api/test/bot-webhook.test.ts
  - backend/api/test/bot.test.ts
shared:
  - docs/28-diagnostics.md
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: xhigh
release: patch
design: null
---

# T-0027. Обновления бота не теряются при перезапуске — сначала очередь, потом ответ

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0027.json)](README.md#значки-статуса) [![T-0020](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0020.json&label=T-0020)](T-0020-bot-texts-and-reply.md)

## Зачем

Вебхук бота отвечает Telegram «принято» до того, как обработал обновление:
обработка запускается без ожидания. Если процесс в этот момент
перезапускается — выкат, падение, нехватка памяти, — обновление пропадает
насовсем. Telegram его не повторит: ответ «принято» он уже получил. Среди
таких обновлений — `successful_payment`, сообщение об успешной оплате. Игрок
заплатил, а запись оплаты так и не началась.

Опрос (`polling`) теряет обновления так же: смещение сохраняется до
обработки.

## Решения

- **Сначала обновление записывается в очередь BullMQ, потом Telegram
  получает «принято».** Не записалось (Redis недоступен) — ответ 503, и
  Telegram повторит доставку сам. Опрос сдвигает смещение только после того,
  как вся пачка в очереди.
- **Обрабатывает воркер очереди.** Внутри — тот же `BotRouter.dispatch`. Если
  обработчик упал, задание повторяется с растущей паузой. Повтор безопасен:
  - запись оплаты идемпотентна по id оплаты;
  - ответ на `pre_checkout_query` второй раз Telegram просто не примет;
  - приветствие отсекает двойное нажатие своим окном.
- **Повторы одного `update_id` отсекает id задания** —
  `update-<update_id>`. Выполненное задание хранится час, как сейчас ключ
  `bot:update:<id>`. Отдельная отметка в Redis (`BotUpdateDedupe`) больше не
  нужна и уходит.
- **Оплата — первой.** `pre_checkout_query` надо ответить за 10 секунд,
  поэтому оно и `successful_payment` ставятся с приоритетом, как сейчас
  `urgentFirst` в опросе.
- **Маршрутизатор сообщает исход.** `dispatch` возвращает `handled`,
  `unhandled` или `failed` с именем обработчика. Падение по-прежнему пишется
  в лог `handler_failed`, но теперь задание видит падение и повторяется.

## Как сейчас

- `backend/api/src/platforms/telegram/bot-webhook.controller.ts`:
  - `BotUpdateDedupe` (строки 18–35) — `SET bot:update:<id> 1 EX 3600 NX`;
  - `receive` (строки 52–75):
    - выключенный вебхук → `DisabledError`;
    - сверка секрета → `UnauthorizedError`;
    - обновление разбирается `updateSchema`, непонятное → `{ accepted: false }`;
    - `dedupe.claim`;
    - `void this.router.dispatch(...)` без ожидания;
    - `{ accepted: true }`.
- `backend/api/src/platforms/telegram/bot-poller.ts:118-127`:
  - `getUpdates`;
  - `saveOffset(lastUpdateId + 1)` **до** обработки;
  - `for (const update of urgentFirst(updates)) await this.router.dispatch(update)`.

  `urgentFirst` — строка 173: срочные обновления оплаты первыми.
- `backend/api/src/platforms/telegram/bot-router.ts`. После T-0020 там есть
  обработчик по умолчанию. `dispatch(update): Promise<void>`:
  - обработчики по порядку;
  - упавший — лог `handler_failed` и выход.
- Образец очереди — `modules/notifications-bot/bot-notify-queue.ts`:
  - соединения `createQueueConnection(config, "producer" | "worker")`
    (`infra/queues.ts`);
  - `Queue` и `Worker` в `onApplicationBootstrap`, закрытие в
    `onModuleDestroy`;
  - `JOB_OPTIONS` с `attempts`, экспоненциальной паузой и `removeOnComplete`;
  - схема данных задания `jobSchema`: Redis — граница, данные разбираются
    схемой;
  - постановка с таймаутом `withTimeout(..., ENQUEUE_TIMEOUT_MS, ...)`.
- `bot.module.ts` — провайдеры `BotRouter`, `BotCommands`, `BotPoller`,
  `BotUpdateDedupe`, контроллер `BotWebhookController`.
- `config.telegram.updates`: `"off" | "polling" | "webhook"`.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **`bot-router.ts`:**

   ```ts
   export type DispatchResult = { status: "handled"; handler: string } | { status: "unhandled" } | { status: "failed"; handler: string };
   async dispatch(update: TelegramUpdate): Promise<DispatchResult>;
   ```

   - обработчик вернул `true` → `handled`;
   - никто не взял, в том числе обработчик по умолчанию → `unhandled`;
   - упал любой, включая обработчик по умолчанию → лог `handler_failed`, как
     сейчас, и `failed` с его `name`.
3. **Новый `platforms/telegram/bot-update-queue.ts`** — `BotUpdateQueue implements OnApplicationBootstrap, OnModuleDestroy`:
   - очередь `bot-updates`;
   - соединения и жизненный цикл — как в `bot-notify-queue.ts`;
   - работает, только если `config.telegram.updates !== "off"`;
   - константы с комментариями:

     ```ts
     const QUEUE_NAME = "bot-updates";
     const ENQUEUE_TIMEOUT_MS = 2_000;
     /** Повтор одного update_id Telegram шлёт в первые минуты, сутки — предел: выполненное задание помнит id час, упавшее — сутки. */
     const JOB_OPTIONS = { attempts: 5, backoff: { type: "exponential", delay: 5_000, jitter: 0.5 }, removeOnComplete: { age: 3600 }, removeOnFail: { age: 86_400 } } as const;
     /** Оплата ждёт ответа 10 секунд — её задания вперёд остальных. */
     const URGENT_PRIORITY = 1;
     const WORKER_CONCURRENCY = 8;
     ```

   - `enqueue(update: TelegramUpdate): Promise<void>`:
     - `queue.add("update", update, { ...JOB_OPTIONS, jobId: \`update-${update.update_id}\`, priority })`
       с `withTimeout(…, ENQUEUE_TIMEOUT_MS, "очередь обновлений бота")`;
     - `priority = URGENT_PRIORITY`, если в обновлении есть
       `pre_checkout_query` или `message.successful_payment`. Иначе без
       приоритета: тот же признак, что у `urgentFirst`, вынести в
       экспортируемую функцию `isUrgent(update)` и переиспользовать;
     - очереди нет (выключено) → `Error`;
     - ошибка постановки бросается вызывающему;
   - `process(job: Pick<Job<unknown>, "data" | "attemptsMade">)`:
     1. данные задания → `updateSchema.safeParse`. Не по схеме — лог `warn`
        `bot_update_dropped` и выход, без броска;
     2. `const result = await this.router.dispatch(update)`;
     3. `failed` → `throw new Error(\`обработчик ${result.handler} упал\`)`,
        BullMQ повторит задание;
   - `worker.on("failed")` на последней попытке → лог `error`
     `bot_update_abandoned` с полями `updateId` и `reason`;
   - `worker.on("error")` → лог `warn` `worker_error`.
4. **`bot-webhook.controller.ts`:**
   - `BotUpdateDedupe` удалить вместе с классом и провайдером;
   - в `receive` после разбора схемой —
     `await this.updates.enqueue(update.data)`. Ошибка постановки →
     `UnavailableError("Очередь обновлений недоступна")` из
     `common/domain-error.ts`: он отвечает 503;
   - ответ `{ accepted: true }` — только после успешной постановки;
   - комментарий файла переписать: вместо «Ответ сразу… обработчики работают
     после ответа» — «Сначала очередь, потом ответ: обновление записано в
     Redis до 200, иначе перезапуск процесса терял бы его, в том числе
     оплату. Повторы одного `update_id` отсекает id задания».
5. **`bot-poller.ts`**, вместо цикла `dispatch`:
   1. `for (const update of updates) await this.updates.enqueue(update)` —
      порядок задаёт приоритет задания, `urgentFirst` здесь больше не нужен;
   2. только после успешной постановки всей пачки —
      `saveOffset(lastUpdateId + 1)`;
   3. ошибка постановки → смещение не сдвигается, лог `warn`, следующая
      итерация опроса заберёт ту же пачку. Повторы отсечёт id задания.

   `urgentFirst`, если больше не используется, — удалить вместе с тестом на
   неё и перенести проверку признака в тест `isUrgent`.
6. **`bot.module.ts`** — `BotUpdateQueue` в `providers`, `BotUpdateDedupe` убрать.
7. **Документы** — раздел «Документы».

## Чего не трогаем

- Обработчики бота: приветствие, команды, оплату, выгрузку, ответ по
  умолчанию.
- Очередь оплаты `payments-queue.ts`: в неё по-прежнему ставит обработчик
  оплаты.
- Сверку секрета вебхука и схему обновления.

## Тесты

Первым коммитом.

- `backend/api/test/bot.test.ts`, маршрутизатор:
  - взял обработчик → `{ status: "handled", handler }`;
  - никто не взял → `unhandled`;
  - упал → `failed` с именем, в логе `handler_failed`;
  - упал обработчик по умолчанию → `failed`.
- Новый `backend/api/test/bot-update-queue.test.ts`, на подменах очереди и
  маршрутизатора:
  - `enqueue` обычного сообщения → `add` с `jobId: "update-<id>"` и без
    приоритета;
  - `pre_checkout_query` и `successful_payment` → `priority: 1`;
  - `isUrgent` — по двум срочным и одному обычному обновлению;
  - `add` не ответил за 2 с → `enqueue` бросает;
  - `process`:
    - данные не по схеме → не бросает, `dispatch` не вызван;
    - `dispatch` → `handled` или `unhandled` → не бросает;
    - `dispatch` → `failed` → бросает.
- `backend/api/test/bot-webhook.test.ts`:
  - верный секрет и обновление → `enqueue` вызван, 200 `{ accepted: true }`;
  - `enqueue` бросил → 503, `accepted` не отвечается;
  - неверный секрет → 401, `enqueue` не вызван;
  - тело не по схеме → 200 `{ accepted: false }`, `enqueue` не вызван;
  - вебхук выключен → 404, как сейчас.

  Старые кейсы про `BotUpdateDedupe` удалить: отметки больше нет.
- Опрос — в `bot.test.ts`, раздел «чтение обновлений long polling'ом»:
  - пачка из двух → два `enqueue`, затем `saveOffset(last + 1)`;
  - второй `enqueue` бросил → `saveOffset` не вызван.

## Аналитика

Нет новых событий словаря. Структурные логи модуля `bot`:
- `bot_update_dropped` — `warn`;
- `bot_update_abandoned` — `error`;
- `worker_error` — `warn`.

## Настройки и окружение

Нет. Очередь живёт в том же Redis, что остальные очереди BullMQ.

## Документы

- `docs/28-diagnostics.md`:
  - §6.1.3 «Как устроено», схема вверху: строку «задача в BullMQ, ответ
    Telegram сразу» заменить на «обновление — в очередь `bot-updates`, ответ
    Telegram после записи»;
  - пункт «**Вебхук отвечает сразу.**» переписать: «**Сначала очередь, потом
    ответ.** Вебхук отвечает 200, когда обновление уже записано в очередь
    `bot-updates`. Перезапуск процесса его не теряет, а повтор одного
    `update_id` отсекает id задания. Redis недоступен — 503, и Telegram
    повторит сам. Обработчики работают в воркере очереди: упавший повторяется
    с паузой. Выгрузка по-прежнему уходит своей задачей и не держит ответ».
- `docs/21-diagrams.md`:
  - §4.9 (выгрузка): строку `B->>R: SET NX bot:update:{update_id} — повтор не обрабатывается`
    заменить на `B->>Q: очередь bot-updates, jobId update-{update_id} — повтор не обрабатывается`;
  - §4.15 (второй шанс за Stars): в пункте «**Подтверждение идёт через
    очередь**, потому что смещение опроса сохраняется до обработки, а вебхук
    отвечает сразу…» первую часть заменить на «Подтверждение идёт через
    очередь оплаты: обновление уже в очереди `bot-updates` (T-0027), а
    подтверждение — своим заданием, которое повторяется, пока запись не
    пройдёт…»;
  - новый раздел следующим свободным номером после последнего `4.x` —
    «Приём обновлений бота (этап 4, реализовано)», sequence-диаграмма:
    - Telegram → вебхук: секрет, схема;
    - вебхук → BullMQ `bot-updates`: `jobId update-{id}`, приоритет оплаты;
    - `alt` записано → 200, иначе → 503 и повтор Telegram;
    - воркер → `BotRouter.dispatch` → обработчик;
    - `alt` `failed` → повтор задания с паузой.

## Критерии приёмки

- [ ] Вебхук отвечает 200 только после записи обновления в очередь, при
  недоступном Redis — 503.
- [ ] Опрос сдвигает смещение только после записи пачки.
- [ ] Упавший обработчик повторяется: задание `failed` уходит на повтор, на
  последней попытке — лог `bot_update_abandoned`.
- [ ] Повтор одного `update_id` не обрабатывается дважды.
- [ ] `pre_checkout_query` и `successful_payment` — с приоритетом.
- [ ] `BotUpdateDedupe` и `urgentFirst` (если не используется) удалены.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(bot): Обновления бота — сначала очередь, потом ответ`
- **Метка:** `release: patch`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОБНОВЛЕНИЯ БОТА НЕ ТЕРЯЮТСЯ**

  Бот больше не теряет обновления при перезапуске сервера. Раньше вебхук отвечал Telegram «принято» до обработки, и выкат посреди обработки стирал обновление — в том числе сообщение об успешной оплате.

  🤖 **Что изменилось**

  • обновление сначала записывается в очередь, и только потом Telegram получает «принято»; Redis недоступен — Telegram повторит сам
  • упавший обработчик повторяется с паузой, оплата обрабатывается первой
  • опрос в разработке сдвигает смещение только после записи пачки
  ```
