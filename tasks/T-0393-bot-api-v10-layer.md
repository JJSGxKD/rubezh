---
id: T-0393
title: Слой Bot API 10.x — оформленные и эфемерные сообщения, темы, виджеты и приём widget_query
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/platforms/telegram/telegram-api-call.ts
  - backend/api/src/platforms/telegram/telegram-raw-call.ts
  - backend/api/src/platforms/telegram/telegram-rich-api.ts
  - backend/api/src/platforms/telegram/telegram-widget-api.ts
  - backend/api/test/telegram-bot-api-v10.test.ts
shared:
  - backend/api/src/platforms/telegram/telegram-bot-api.ts
  - backend/api/src/platforms/telegram/bot-update-queue.ts
  - backend/api/src/platforms/telegram/bot-identity.ts
  - backend/api/test/bot-update-queue.test.ts
  - backend/api/test/bot-fallback.test.ts
  - docs/16-tech-stack-decisions.md
  - docs/28-diagnostics.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0393. Слой Bot API 10.x — оформленные и эфемерные сообщения, темы, виджеты и приём widget_query

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0393.json)](README.md#значки-статуса)

## Зачем

Сценарии Р199 (оформленные итоги, живые карточки, темы в личке, эфемерные
ответы в чате команды) упираются в методы Bot API 10.1–10.4, которых у нашего
клиента `TelegramBotApi` нет. Задача добавляет только транспорт и типы — без
домена: после неё у адаптера Telegram есть все нужные вызовы с разбором ответов
схемами, а обновление `widget_query` доходит до маршрутизатора бота вперёд
обычных.

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52, правило 2): слой Bot API — первым;
  оформленные и эфемерные сообщения — через grammY 1.46.0, виджеты — **сырыми
  вызовами со своими Zod-схемами**: в grammY их нет. `widget_query` идёт в
  очереди обновлений с высоким приоритетом, как предварительная проверка
  оплаты: Telegram ждёт ответа 15 секунд.
- Сверено тимлидом 10.11.2026 по `node_modules`: grammY **1.46.0** — последняя
  версия, `@grammyjs/types` **5.0.0**. В `Api` grammY есть `sendRichMessage`,
  `sendRichMessageDraft`, `editMessageText` с `rich_message`,
  `editEphemeralMessage*`, `createForumTopic`; у `sendMessage` и
  `sendRichMessage` — `ephemeral_message_parameters`; у `UserFromGetMe` —
  `has_topics_enabled`. **Нет** `sendWidget`, `sendSharedWidget`,
  `editMessageWidgetData`, `editSharedWidgetData`, `answerWidgetQuery` и
  полей `widget_query` / `shared_widget_query` у `Update`.
- **`receiver_user_id` в типах grammY обязателен**, а с Bot API 10.4 его можно
  опустить у эфемерного ответа на нажатие. Мы его **всегда передаём**: Telegram
  разрешает `receiver_user_id` вместе с `callback_query_id`, если это id
  нажавшего. Так типы grammY сходятся без приведения.
- **Файл не растёт сверх 500 строк** (`CLAUDE.md`, «Стиль кода»):
  `telegram-bot-api.ts` уже 525 строк. Разбор ошибок grammY и `TelegramApiError`
  уходят в `telegram-api-call.ts` отдельным коммитом рефакторинга, новые методы —
  в `telegram-rich-api.ts` и `telegram-widget-api.ts`. `TelegramBotApi` даёт их
  составом: поля `rich` и `widgets`. Внедрение (`TELEGRAM_BOT_API`) не меняется.
- **Повтор `widget_query` бесполезен.** Ответ через 5 секунд паузы BullMQ
  Telegram уже не примет, поэтому у этих заданий одна попытка
  (решение тимлида, техническое).

## Как сейчас

- `backend/api/src/platforms/telegram/telegram-bot-api.ts` (525 строк):
  - `ALLOWED_UPDATES` — строка 57;
  - `TelegramApiError` — строки 74–85;
  - `updateSchema` (Zod) — строки 119–172;
  - `BotCommand` — 182–185, `InlineButton` и `SendOptions` — 192–199;
  - `getMe` — 269–273;
  - `sendMessage` — 295–301, `editMessageText` — 303–307;
  - приватный `call()` (таймаут, `GrammyError` → `TelegramApiError`, сеть без
    токена в тексте) — 498–515, `replyMarkup()` — 523–525.
- `bot-update-queue.ts`: `isUrgent()` (строки 46–48) — оплата;
  `URGENT_PRIORITY = 1`, `ORDINARY_PRIORITY = 2`; `JOB_OPTIONS` с
  `attempts: 5` — строка 34; `enqueue()` — 94–99.
- `bot-identity.ts` спрашивает `getMe` на старте и хранит `username`.
  `getMe` подменяют в `test/bot-fallback.test.ts`, строка 47:
  `{ id: 1, username }`.
- `bot-fallback.ts` (строка 71) на обновление без `message` отвечает `true`
  и ничего не делает. Значит, `widget_query` без своего обработчика молча
  глотается, а не роняет очередь. Обработчик появится в T-0396.
- Виджетов в боте пока нет. `widget_query` придёт только на карточку, которую
  отправит T-0396.

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **Рефакторинг отдельным коммитом**
   (`refactor(bot): Вынеси вызов Bot API в telegram-api-call`):
   - `TelegramApiError` и тело `call()` переезжают в `telegram-api-call.ts`;
   - `call()` становится функцией
     `callBotApi<T>(method, timeoutMs, signal, run): Promise<T>`, сигнал —
     тот же `GrammySignal`;
   - `telegram-bot-api.ts` реэкспортирует `TelegramApiError`
     (`export { TelegramApiError } from "./telegram-api-call.js"`): прежние
     импорты не меняются;
   - поведение то же, существующие тесты зелёные без правок.
3. **`telegram-raw-call.ts`** — сырой вызов для методов, которых нет в grammY:
   ```ts
   export async function rawBotCall<T>(
     transport: { token: string; apiRoot: string; fetch: FetchLike },
     method: string,
     body: Record<string, unknown>,
     result: z.ZodType<T>,
     timeoutMs: number,
     signal?: AbortSignal,
   ): Promise<T>
   ```
   - `POST ${apiRoot}/bot${token}/${method}`, тело — JSON, заголовок
     `content-type: application/json`, срок — `AbortSignal.timeout` вместе с
     `signal` (как в `call()`);
   - ответ разбирается схемой
     `{ ok: true, result } | { ok: false, error_code, description, parameters?: { retry_after? } }`;
   - `ok: false` → `TelegramApiError(method, error_code, description, retry_after ?? null)`;
   - сеть, таймаут или ответ не по схеме →
     `TelegramApiError(method, 0, "сеть недоступна (<имя ошибки>)", null)`.
     **В тексте ошибки нет ни URL, ни токена**: `cause` наружу не уходит;
   - комментарий в шапке: виджетов в grammY 1.46.0 нет, перейти на методы
     grammY, когда они появятся. Без истории и дат.
4. **`telegram-widget-api.ts`** — класс `TelegramWidgetApi` (конструктор
   `(token, apiRoot, fetchImpl)`), срок вызова — 15 секунд. Каждый метод
   выбрасывает `undefined`-поля из тела.
   - `sendWidget(chatId: string, widget: WidgetSend, signal?)` → `{ messageId: number }`:
     - `WidgetSend` = `{ html, width?, height?, publicData?, chatData?, caption?, allowQueries?, isShared?, silent?, protect?, threadId?, keyboard?: InlineButton[][] }`;
     - поля Bot API: `html`, `width`, `height`, `public_data`, `chat_data`,
       `caption`, `allow_queries`, `is_shared`, `disable_notification`,
       `protect_content`, `message_thread_id`,
       `reply_markup: { inline_keyboard }`;
     - проверки до вызова — `RangeError` с понятным текстом: `html` 1–32 768
       байт, `chat_data` и `public_data` до 1024 байт, `caption` до 1024
       знаков, `height` 50–600;
     - ответ — `message_id`, а у общего виджета ещё `widget.id`: схема
       `{ message_id, widget?: { id?: string } }`, в результат
       `widgetId: string | null`.
   - `sendSharedWidget(chatId, widgetId, options: { chatData?, caption?, silent?, threadId?, keyboard? }, signal?)` → `{ messageId }`.
   - `editMessageWidgetData(chatId: string, messageId: number, data: { publicData?: string; chatData?: string }, signal?)` → `"edited" | "unchanged"`.
     Ответ `400` с описанием, где есть `message is not modified`
     (без учёта регистра), — это `"unchanged"`, а не ошибка.
   - `editSharedWidgetData(widgetId, publicData, cacheTimeSec?: number, signal?)` → `void`.
     `cache_time` — 5–3600, иначе `RangeError`.
   - `answerWidgetQuery(queryId: string, data?: string, signal?)` → `void`.
     `data` до 1024 байт; срок вызова — **5 секунд**: ответ на запрос
     карточки ограничен 15 секундами всего.
5. **`telegram-rich-api.ts`** — класс `TelegramRichApi`. Конструктор
   принимает тот же экземпляр `Api` grammY, что у `TelegramBotApi`; вызовы идут
   через `callBotApi`, срок — 15 секунд.
   - `sendRichMessage(chat: ChatRef, message: TelegramRichMessage, options: RichSendOptions = {}, signal?)` → `number` (id сообщения):
     - `TelegramRichMessage` — реэкспорт типа `InputRichMessage<InputFile>`
       из `grammy/types`: остальные файлы адаптера берут тип отсюда;
     - `RichSendOptions` = `{ keyboard?: InlineButton[][]; silent?: boolean; ephemeral?: Ephemeral }`;
       поле темы берётся из `chatFields(chat)`;
     - поля Bot API: `reply_markup`, `message_thread_id`,
       `disable_notification`, `ephemeral_message_parameters`.
   - `editRichMessage(chat: ChatRef, messageId: number, message: TelegramRichMessage, signal?)` →
     `editMessageText` с `rich_message`.
   - `createForumTopic(chatId: number, name: string, iconColor: TopicColor, signal?)` → `{ threadId: number }`:
     - `TopicColor` — `0x6fb9f0 | 0xffd67e | 0xcb86db | 0x8eee98 | 0xff93b2 | 0xfb6f5f`;
     - `name` 1–128 знаков;
     - ответ — схема `{ message_thread_id: number }`.
6. **`telegram-bot-api.ts`:**
   - поля `readonly rich: TelegramRichApi` и `readonly widgets: TelegramWidgetApi`
     собираются в конструкторе из того же `token`, `apiRoot`, `fetchImpl` и
     `Api`;
   - `SendOptions` получает `silent?: boolean` (`disable_notification`) и
     `ephemeral?: Ephemeral`, где
     `Ephemeral = { receiverUserId: number; callbackQueryId?: string; replaceOriginal?: boolean }`
     переводится в
     `ephemeral_message_parameters: { receiver_user_id, callback_query_id?, replace_callback_query_message? }`.
     `sendMessage` их передаёт;
   - `BotCommand` получает `is_ephemeral?: boolean`: `setMyCommands` уже передаёт
     объект как есть;
   - `getMe` возвращает ещё `topicsEnabled: boolean` (`has_topics_enabled ?? false`);
   - `ALLOWED_UPDATES` += `"widget_query"`, `"shared_widget_query"`;
   - `updateSchema` += `widget_query` и `shared_widget_query`. Схемы
     терпимы к незнакомым полям, как остальные:
     ```ts
     widget_query: z.object({
       id: z.string().max(256),
       from: userSchema,
       chat: chatSchema.optional(),
       message_id: z.number().int().optional(),
       inline_message_id: z.string().max(256).optional(),
       chat_instance: z.string().max(256),
       chat_type: z.string().max(32).optional(),
       type: z.object({ type: z.string().max(32) }),
       data: z.string().min(1).max(64),
       widget_id: z.string().max(256).optional(),
     }).optional(),
     shared_widget_query: z.object({
       id: z.string().max(256),
       from: userSchema,
       type: z.object({ type: z.string().max(32) }),
       data: z.string().min(1).max(64),
       widget_id: z.string().max(256),
     }).optional(),
     ```
     `data` до 64 **байт**, а не знаков: в схеме — `.refine` по
     `Buffer.byteLength(data, "utf8") <= 64`;
   - после задачи файл не длиннее 500 строк.
7. **`bot-identity.ts`** — хранит `topicsEnabled` из `getMe` (геттер
   `topicsEnabled: boolean`, `false`, пока не узнали). Лог `identity` получает
   поле `topicsEnabled`. Фейк в `test/bot-fallback.test.ts`, строка 47:
   `{ id: 1, username: …, topicsEnabled: false }`.
8. **`bot-update-queue.ts`:**
   - `isUrgent()` — ещё `widget_query` и `shared_widget_query`;
   - новая экспортируемая функция `jobOptionsFor(update)` возвращает
     `{ ...JOB_OPTIONS, jobId, priority, attempts }`: у запросов виджета
     `attempts: 1`, у остальных — как было;
   - комментарий у `isUrgent`: ответ на запрос карточки — 15 секунд,
     повтор после паузы опоздает.
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Домен и порты (`platforms/ports/*`): `RichDocument`, `LiveCardPort` и правила
  звука — T-0394 и T-0395.
- Обработчик `widget_query` и HTML карточек — T-0396.
- `telegram-messenger.ts`, `telegram-message-preparer.ts`: их переводят на
  новые методы T-0394 и T-0400.
- `sendRichMessageDraft` и `editEphemeralMessage*` не оборачиваем: сценариев
  для них нет.
- Существующие методы `TelegramBotApi` — без изменения поведения.

## Тесты

Первым коммитом. Новый `backend/api/test/telegram-bot-api-v10.test.ts`; сеть —
подменённый `fetch`, который записывает `url` и разобранное тело.

- `sendRichMessage` с клавиатурой, `silent` и темой (`ChatRef` с `threadId: 7`):
  - тело содержит `rich_message.blocks`, `reply_markup.inline_keyboard`,
    `disable_notification: true`, `message_thread_id: 7`;
  - результат — `message_id` из ответа.
- `sendMessage` с `ephemeral: { receiverUserId: 5, callbackQueryId: "q1" }` →
  `ephemeral_message_parameters` равно
  `{ receiver_user_id: 5, callback_query_id: "q1" }`; без `ephemeral` поля нет.
- `editRichMessage` → метод `editMessageText` с `rich_message` и без `text`.
- `createForumTopic(5, "Новости", 0x6fb9f0)` → тело
  `{ chat_id: 5, name: "Новости", icon_color: 7322096 }`, результат
  `{ threadId }`; имя из 129 знаков → `RangeError` без сети.
- `getMe` с `has_topics_enabled: true` → `topicsEnabled: true`; без поля → `false`.
- `sendWidget`:
  - URL — `…/bot<токен>/sendWidget`;
  - тело несёт `allow_queries`, `protect_content`, `chat_data`,
    `reply_markup`; `undefined`-поля в тело не попадают;
  - `html` из 32 769 байт и `chat_data` из 1025 байт → `RangeError`,
    `fetch` не вызван;
  - ответ с `widget: { id: "w1" }` → `widgetId: "w1"`, без него → `null`.
- `editMessageWidgetData`:
  - ответ `400 Bad Request: message is not modified` → `"unchanged"`;
  - ответ `ok: true` → `"edited"`;
  - `400` с другим описанием → `TelegramApiError` с кодом 400.
- `answerWidgetQuery`: `data` из 1025 байт → `RangeError`; срок вызова — 5 секунд
  (подменённый `fetch` ждёт сигнала, проверяется отмена).
- `editSharedWidgetData`: `cache_time` 4 → `RangeError`; 300 → в теле
  `cache_time: 300`.
- Ошибки сырого вызова:
  - `429` с `parameters.retry_after: 3` → `TelegramApiError`,
    `errorCode` 429, `retryAfterSec` 3;
  - сетевой сбой (`fetch` бросает `TypeError` с URL с токеном в `cause`) →
    `errorCode` 0, в `message` нет подстроки токена;
  - тело не JSON → код 0.
- `updateSchema`:
  - разбирает `widget_query` с `type: { type: "data", wallet_card: {…} }` и
    незнакомым полем верхнего уровня `foo` — незнакомое не роняет разбор;
  - `widget_query` с `data` из 65 байт (кириллица — 33 знака) не проходит;
  - `shared_widget_query` без `widget_id` не проходит.
- `ALLOWED_UPDATES` содержит `widget_query` и `shared_widget_query`.
- `backend/api/test/bot-update-queue.test.ts`:
  - `isUrgent` верен для `widget_query` и `shared_widget_query`;
  - `jobOptionsFor` даёт им `priority: 1` и `attempts: 1`, сообщению —
    `priority: 2` и `attempts: 5`.
- Рефакторинг: все существующие тесты бота (`bot-*.test.ts`,
  `telegram-*.test.ts`) проходят без правок, кроме фейка `getMe`.

## Аналитика

Нет: транспорт. События — в задачах сценариев (T-0394, T-0395).

## Настройки и окружение

Нет. Новых переменных нет: токен и `apiRoot` — прежние.

## Документы

- `docs/16-tech-stack-decisions.md` §5, строка «Телеграм-бот» — одно
  предложение: «Виджеты Bot API 10.4 (`sendWidget`, `answerWidgetQuery` и
  др.) — сырыми вызовами со своими Zod-схемами
  (`platforms/telegram/telegram-widget-api.ts`), пока их нет в grammY».
- `docs/28-diagnostics.md` §6.1.3 — в абзац про приоритет очереди обновлений:
  запросы виджетов идут с приоритетом оплаты и одной попыткой.

## Критерии приёмки

- [ ] У `TelegramBotApi` есть `rich` (`sendRichMessage`, `editRichMessage`,
      `createForumTopic`) и `widgets` (`sendWidget`, `sendSharedWidget`,
      `editMessageWidgetData`, `editSharedWidgetData`, `answerWidgetQuery`).
- [ ] `sendMessage` умеет эфемерное сообщение и `silent`; `getMe` отдаёт
      `topicsEnabled`, `BotIdentity` его хранит.
- [ ] `widget_query` и `shared_widget_query` проходят `updateSchema`, входят в
      `ALLOWED_UPDATES`; в очереди — приоритет оплаты и одна попытка.
- [ ] Ни одна ошибка нового слоя не содержит токен и URL Bot API.
- [ ] `telegram-bot-api.ts` не длиннее 500 строк; рефакторинг — отдельным
      коммитом без изменения поведения.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Добавь слой Bot API 10.x для сообщений нового поколения`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СЛОЙ BOT API 10.X**

  У бота появился транспорт для сообщений нового поколения (Р199): оформленные и эфемерные сообщения, темы в личке и виджеты-карточки. Игрок пока ничего не заметит — это основа для сценариев WP52.

  🛠 **Что внутри**

  • оформленные сообщения и темы — через grammY, виджеты — своими вызовами со схемами (в grammY их ещё нет)
  • запросы из карточек идут в очереди бота вперёд обычных, как оплата
  • telegram-bot-api.ts разделён: вызов и ошибки — отдельным файлом
  ```
