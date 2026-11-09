---
id: T-0394
title: Оформленное сообщение бота — порт RichDocument с простым текстом, правила звука и тихих часов, bot_message_sent
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0393]
zones:
  - backend/api/src/platforms/ports/rich-message.ts
  - backend/api/src/platforms/telegram/telegram-rich-render.ts
  - backend/api/src/modules/bot-messages/**
  - backend/api/test/rich-message.test.ts
  - backend/api/test/telegram-rich-render.test.ts
  - backend/api/test/telegram-messenger-rich.test.ts
  - backend/api/test/bot-message-policy.test.ts
  - backend/api/test/notifications-bot-policy.test.ts
shared:
  - backend/api/src/platforms/ports/messenger.ts
  - backend/api/src/platforms/telegram/telegram-messenger.ts
  - backend/api/src/modules/notifications-bot/bot-notify-sender.ts
  - backend/api/src/modules/notifications-bot/bot-notify-queue.ts
  - backend/api/src/modules/notifications-bot/notifications-bot.module.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - packages/app-shell/src/state/analytics.ts
  - scripts/test/event-dictionary.test.ts
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0394. Оформленное сообщение бота — порт RichDocument с простым текстом, правила звука и тихих часов, bot_message_sent

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0394.json)](README.md#значки-статуса) [![T-0393](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0393.json&label=T-0393)](T-0393-bot-api-v10-layer.md)

## Зачем

Итог сезона, рекорд забега и новости (Р199) должны приходить читаемыми
таблицами и списками. При этом домен не должен знать про Telegram, а на MAX и
VK — тот же документ простым текстом. Задача вводит язык для таких сообщений
(`RichDocument`) и его простой текст. Сценарии WP52 и дубль уведомлений
получают общие правила звука и тихих часов, а каждое сообщение бота
записывается событием `bot_message_sent`. Сценарии, которые этим пользуются, —
отдельные задачи.

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52, правила 1, 5, 6, 9; §3.11,
  строка «Оформленное сообщение»):
  - домен строит `RichDocument` и его простой текст (`plainTextOf`);
  - Telegram — `sendRichMessage`, главная кнопка дублируется клавиатурой под
    сообщением;
  - отказ площадки на новом методе — тот же документ простым текстом и
    строка лога один раз;
  - всё выключается ключом `bot.formats.enabled` (умолчание — выкл.):
    выключен — бот пишет как до Р199.
- **Правила звука и тихих часов** (правило 6):
  - **ответ на касание или команду** — всегда, со звуком;
  - **сообщение, вызванное самим игроком в игре** — без звука;
  - **сообщение, которое бот пишет сам**:
    - в тихие часы напоминаний (`reminders.quiet-from-hour` —
      `reminders.quiet-to-hour`, Москва) напоминание пропускается, как
      сейчас; остальное ждёт конца тихих часов;
    - со звуком — не больше `bot.loud-per-day` (2) в игровые сутки на
      игрока, остальные — без звука.
- **Возможности — у порта, а не имя площадки** (правило 1):
  - `Messenger` получает необязательное `capabilities: { rich, topics }`;
  - нет поля — площадка умеет только простой текст;
  - живые карточки — свой порт (`LiveCards`, T-0395), поэтому
    `cards` в `Messenger` не дублируется (решение тимлида, техническое).
- **Решение тимлида (подтвердить владельцу).** Правила звука и тихих часов
  действуют и на дубль уведомлений (заявка в друзья, подарок, сообщение
  команды, напоминания), когда включён `bot.formats.enabled`. Дубль — это то,
  что бот пишет сам; без этого потолок «2 со звуком» ничего бы не ограничивал.
  Заявка, пришедшая ночью, ждёт 10:00, а не уходит в 3 часа ночи.
  `bot.formats.enabled` выключен — дубль работает ровно как сейчас.
- **Событие `bot_message_sent`** пишется всегда, независимо от выключателей:
  аналитика игроку ничего не меняет. Поля — WP52, раздел «Аналитика».

## Как сейчас

- `backend/api/src/platforms/ports/messenger.ts`:
  - `OutgoingMessage { text, button, action? }` — строки 10–21;
  - `SendOutcome` — 23–30;
  - `Messenger` — 32–44.
- `backend/api/src/platforms/telegram/telegram-messenger.ts`: `send()` собирает
  клавиатуру (кнопка-ссылка и кнопка действия) и зовёт `sendMessage`;
  `deliver()` переводит ошибки Telegram в исходы. После T-0393 у
  `TelegramBotApi` есть `rich.sendRichMessage` и `SendOptions.silent`.
- Дубль уведомлений — `modules/notifications-bot/`:
  - `bot-notify-sender.ts` `deliver()`: выключатель и тихие часы напоминаний
    (строки 71–74), аккаунт, площадка, «можно ли писать», выбор игрока, окно
    потолка (`claim`), `messenger.send`, исход в ленту;
  - `bot-notify-queue.ts`: задание, `retry` — повторная постановка с паузой
    (`MAX_DEFERRALS = 3`), лимитер 5 в секунду.
  - Тесты собирают отправителя позиционно: `test/notifications-bot.test.ts`,
    строки 82 и 204.
- Тихие часы — `modules/reminders/reminder-rules.ts`: `isQuietHour(at, from, to)`,
  `moscowHour(at)`.
- Серверное событие — образец `modules/rating/run-scorer.service.ts`
  `announce()`, строки 125–155:
  - `EVENTS_SINK` — необязательный;
  - `installId: "server"`, `platformUserId: null`, `appVersion: "server"`;
  - payload — через `EVENT_DICTIONARY.<событие>.payload.parse`.
- Словарь событий — три места, сверка — `scripts/test/event-dictionary.test.ts`:
  - `events/event-dictionary.ts`;
  - `docs/22-analytics-and-metrics.md` §3.3;
  - `packages/app-shell/src/state/analytics.ts` — список клиента совпадает с
    сервером целиком, серверные события тоже в нём (`run_scored`).
- `setting-catalog.ts`:
  - группы — константы `*_GROUP` (строки 65–153);
  - образец выключателя в своей группе — `remindersEnabled`
    (`{ ...feature(…), group: REMINDERS_GROUP }`);
  - числа — `integer(key, group, title, hint, range, fallback)`.
- В `docs/30-configuration-map.md` строка 90 уже описывает ключи WP52 —
  числа в ней совпадают с этой задачей, правка не нужна.

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **`platforms/ports/rich-message.ts`** — тип и чистые функции, без импортов
   из `modules/` и адаптеров:
   ```ts
   export type DateTimeFormat = "r" | `${"w" | ""}${"d" | "D" | ""}${"t" | "T" | ""}`;
   export type RichText = string | RichSpan | readonly RichText[];
   export type RichSpan =
     | { kind: "bold"; text: RichText }
     | { kind: "italic"; text: RichText }
     | { kind: "link"; text: RichText; url: string }
     /** время в поясе читателя; `fallback` — что видит площадка без этой возможности */
     | { kind: "dateTime"; unix: number; format: DateTimeFormat; fallback: string };
   export type RichButton = { text: string; url: string } | { text: string; action: string };
   export type RichBlock =
     | { kind: "heading"; text: RichText; level?: 1 | 2 | 3 }
     | { kind: "paragraph"; text: RichText }
     | { kind: "list"; items: readonly RichText[]; ordered?: boolean }
     | { kind: "table"; header?: readonly RichText[]; rows: readonly (readonly RichText[])[] }
     | { kind: "details"; summary: RichText; blocks: readonly RichBlock[] }
     | { kind: "quote"; text: RichText }
     | { kind: "photo"; photo: { fileId: string } | { url: string }; caption?: RichText }
     | { kind: "buttons"; buttons: readonly RichButton[] }
     | { kind: "divider" }
     | { kind: "footer"; text: RichText };
   export interface RichDocument { blocks: readonly RichBlock[] }
   export const RICH_LIMITS = { blocks: 500, depth: 16, media: 50, columns: 20, textChars: 32_768, plainChars: 4_000, buttonsPerRow: 8 } as const;
   export function plainTextOf(doc: RichDocument): string;
   export function richProblems(doc: RichDocument): string[];
   ```
   **`plainTextOf`** — простой текст для MAX, VK и отказа:
   - блоки разделены пустой строкой;
   - заголовок — строкой как есть;
   - список — строки `• пункт` (у нумерованного `1. пункт`);
   - таблица — строка на ряд, ячейки через ` · `, заголовок — первым рядом;
   - `details` — строка сводки, за ней вложенные блоки;
   - цитата — строка в «ёлочках»;
   - фото — только подпись, если она есть;
   - кнопки — строки `текст: url`, кнопки действия пропускаются;
   - разделитель — пустая строка; подвал — строкой;
   - `bold` и `italic` — текст без пометок;
   - ссылка — `текст (url)`, а если текст равен адресу — один адрес;
   - `dateTime` — `fallback`;
   - пробелы по краям обрезаются.

   **`richProblems`** — список ошибок по-русски, пустой — документ годен:
   - блоков с вложенными больше 500;
   - вложенность глубже 16;
   - фото больше 50;
   - столбцов таблицы больше 20 или ряды разной длины;
   - видимого текста больше 32 768 знаков;
   - `plainTextOf` длиннее 4 000 знаков — свой предел: запасной текст
     обязан уйти обычным сообщением (у Telegram 4 096);
   - в ряду кнопок 0 или больше 8;
   - `action` длиннее 64 байт;
   - адрес кнопки, ссылки или фото не `https://`;
   - `unix` не целое положительное.
3. **`ports/messenger.ts`:**
   - `export type MessageTopic = "news" | "rewards" | "support"`;
   - `OutgoingMessage` += `rich?: RichDocument` (`text` при нём — всегда
     `plainTextOf(rich)`), `silent?: boolean`, `topic?: MessageTopic` —
     адаптер без тем поле пропускает, темы в Telegram — отдельная задача
     WP52 № 14;
   - `SendOutcome` вида `sent` получает `fallback?: true` — оформленное не
     ушло, ушёл простой текст;
   - `Messenger` += `readonly capabilities?: { rich: boolean; topics: boolean }`.
   Комментарии — почему поле необязательное: фейки тестов и площадки без
   оформления работают как раньше.
4. **`platforms/telegram/telegram-rich-render.ts`** —
   `toTelegramRich(doc: RichDocument): TelegramRichMessage` (тип из
   `telegram-rich-api.ts`, T-0393):
   - `heading` → `{ type: "heading", size: level ?? 2 }`;
   - `paragraph`, `footer`, `divider` — одноимённые;
   - `list` → `list` с `items[].blocks = [paragraph]`, у нумерованного —
     `value` и `type: "1"`;
   - `table` → `cells` с `align: "left"`, `valign: "top"`, у заголовка
     `is_header: true`, у таблицы `is_striped: true`;
   - `details` → `details`;
   - `quote` → `blockquote`;
   - `photo` → `photo` с `{ type: "photo", media: fileId | url }`;
   - `buttons` → `buttons`: ссылка — `{ text, url }`, действие —
     `{ text, callback_data }`;
   - `bold`, `italic` → одноимённые; `link` → `url`;
   - `dateTime` → `{ type: "date_time", text: fallback, unix_time, date_time_format }`.
5. **`telegram-messenger.ts`:**
   - `capabilities = { rich: true, topics: false }`;
   - `MessengerBotApi` += `rich`;
   - при `message.rich` — `rich.sendRichMessage(platformUserId, toTelegramRich(rich), { keyboard, silent })`,
     клавиатура — та же, что сейчас (кнопка-ссылка и кнопка действия);
   - без `rich` — `sendMessage` с `silent`;
   - отказ на оформленном — `TelegramApiError` с кодом 400 (кроме `NO_CHAT`)
     или 404 → `sendMessage` с `message.text` и той же клавиатурой;
     итог — `{ status: "sent", fallback: true }`;
   - лог `{ module: "bot", event: "rich_fallback", code }` — один раз за
     процесс (флаг в экземпляре);
   - 403, 429, сеть — как сейчас, без запасного текста.
6. **`modules/bot-messages/`** — новый модуль домена, адаптеры не
   импортирует:
   - **`bot-message-rules.ts`** — чистые функции:
     - `quietEndsAt(now, fromHour, toHour): Date` — ближайший момент, когда
       по Москве наступает `toHour:00`;
     - `gameDayOf(now): string` — `YYYY-MM-DD` по Москве;
     - `loudKey(accountId, gameDay)` → `bot-loud:<аккаунт>:<день>`.
   - **`bot-message-policy.ts`** — `BotMessagePolicy`:
     ```ts
     type Origin = "reply" | "player" | "bot";
     type Decision = { action: "send"; silent: boolean } | { action: "wait"; untilMs: number } | { action: "skip"; reason: "quiet_hours" };
     decide(input: { accountId: string; origin: Origin; reminder?: boolean }, now: Date): Promise<Decision>;
     ```
     - `bot.formats.enabled` выключен → `{ send, silent: false }`: как до Р199;
     - `reply` → `{ send, silent: false }`, в счётчик не идёт;
     - `player` → `{ send, silent: true }`;
     - `bot` в тихий час: напоминание → `skip`, остальное →
       `wait` до `quietEndsAt`;
     - `bot` вне тихих часов → счётчик `INCR` и `EXPIRE` 2 суток одним
       скриптом (как `CONSUME_SCRIPT` в `ingest/rate-limiter.ts`).
       Значение ≤ `bot.loud-per-day` — со звуком, больше — без звука;
     - Redis недоступен → без звука и предупреждение в лог не чаще раза в
       минуту: лишний звук хуже тихого сообщения;
     - счётчик растёт до отправки: неотправленное сообщение место тоже
       занимает, и это допустимо.
   - **`bot-message-events.ts`** — `BotMessageEvents.sent({ kind, format, outcome, topic, silent, platform })`:
     - запись в `EVENTS_SINK` по образцу `run-scorer` `announce()`;
     - `sessionId` — id события; без идентификатора игрока;
     - сбой записи — предупреждение в лог один раз, отправку не роняет.
   - **`bot-messages.service.ts`** — `BotMessages.compose(doc: RichDocument, base: { button; action?; topic? })`
     → `OutgoingMessage`:
     - `text: plainTextOf(doc)` всегда;
     - `rich: doc` — только при включённых `bot.formats.enabled` и
       `bot.rich.enabled` и пустом `richProblems(doc)`;
     - иначе без `rich` и строка лога `rich_rejected` с первой проблемой.
   - **`bot-messages.module.ts`** — провайдеры `BotMessagePolicy`,
     `BotMessageEvents`, `BotMessages`; **`exports` — все три**.
7. **Дубль уведомлений** (`bot-notify-sender.ts`, `bot-notify-queue.ts`,
   `notifications-bot.module.ts`):
   - модуль импортирует `BotMessagesModule`;
   - отправитель получает `@Optional() policy?: BotMessagePolicy` и
     `@Optional() events?: BotMessageEvents` **последними** параметрами:
     позиционные сборки в тестах не ломаются;
   - после проверки «игрок выключил этот вид» и **до** `claim`:
     `policy.decide({ accountId, origin: "bot", reminder: rule.reminder === true }, now)`;
   - `wait` → новый исход `{ status: "deferred"; afterSec }`;
   - `send` → `message.silent = decision.silent`;
   - после `messenger.send` (кроме `retry`) — `events.sent`:
     - `kind` — вид уведомления, `format: "text"`, `topic: "none"`;
     - `outcome` — `fallback` при `sent` с `fallback`, иначе исход.
   - Очередь: `deferred` → повторная постановка с задержкой `afterSec`,
     `jobId` `${notificationId}-q`. В данных задания — `quietDeferred: true`,
     и это **не** тратит `MAX_DEFERRALS`. Задание с `quietDeferred` второй
     раз не откладывается: тихих часов уже нет, а если часы сдвинули
     настройкой — уходит без звука.
8. **`setting-catalog.ts`** — группа `BOT_MESSAGES_GROUP = "Сообщения бота"`:
   - `botFormatsEnabled` — `{ ...feature("bot.formats.enabled", "Сообщения бота нового поколения", hint, () => null, false), group: BOT_MESSAGES_GROUP }`.
     Подсказка: «Оформленные сообщения, живые карточки, темы и эфемерные ответы
     (Р199). Выключено — бот пишет как раньше: простой текст. Включайте после
     просмотра на деве»;
   - `botRichEnabled` — так же, ключ `bot.rich.enabled`, умолчание `true`.
     Название «Оформленные сообщения», подсказка: «Итоги, рекорды и новости
     таблицами и списками. Работает, когда включены сообщения нового
     поколения. Выключено — тот же текст без оформления»;
   - `botLoudPerDay` — `integer("bot.loud-per-day", BOT_MESSAGES_GROUP, "Со звуком — не больше в сутки", hint, { min: 1, max: 5, unit: ["сообщение", "сообщения", "сообщений"] }, 2)`.
     Подсказка: «Сколько сообщений, которые бот пишет сам, приходят игроку со
     звуком за игровые сутки; остальные — без звука. Ответы на команды и
     нажатия не считаются».
9. **Словарь событий** — сначала `docs/22` §3.3, потом код:
   - строка «Уведомления» в обзорной таблице получает `bot_message_sent`;
   - в детальную таблицу — строка `bot_message_sent`: зачем (доходят ли
     сообщения бота, какие уходят запасным текстом, сколько без звука) и
     поля;
   - абзац «серверное событие» по образцу `run_scored`: конверт
     `install_id = 'server'`, без игрока;
   - `event-dictionary.ts`:
     ```ts
     bot_message_sent: { version: 1, payload: payload({
       kind: id,
       format: z.enum(["text", "photo", "rich", "card"]),
       outcome: z.enum(["sent", "blocked", "failed", "fallback"]),
       topic: z.enum(["none", "news", "rewards", "support"]),
       silent: z.boolean(),
     }) },
     ```
     с комментарием «серверное, клиент не шлёт»;
   - `app-shell/src/state/analytics.ts` — строка `"bot_message_sent"` рядом с
     `run_scored`.

## Чего не трогаем

- Тексты уведомлений и картинки (`bot-notify-texts.ts`; картинки — T-0255):
  дубль по-прежнему уходит простым текстом, меняются только звук, время и
  событие.
- Правила напоминаний T-0128: выключатель, окно потолка, пропуск в тихие часы.
- Темы в личке (`topic` адаптер пока пропускает) — WP52 № 14.
- Рассылки из панели (`broadcasts/*`) — WP52 № 11.
- `docs/35-stage4-plan.md` — решение уже записано.

## Тесты

Первым коммитом.

- `backend/api/test/rich-message.test.ts`:
  - `plainTextOf` документа «заголовок, абзац с жирным и ссылкой, список,
    таблица 2×3 с заголовком, details, цитата, фото с подписью, кнопки
    (ссылка и действие), разделитель, подвал, dateTime» — ровно ожидаемая
    строка (снимок строкой в тесте);
  - ссылка, у которой текст равен адресу, — адрес один раз;
  - `richProblems`:
    - 501 блок (с вложенными) → ошибка про блоки;
    - таблица с 21 столбцом и с рядами разной длины → две ошибки;
    - простой текст 4 001 знак → ошибка про запасной текст;
    - кнопка `http://` → ошибка;
    - `action` из 65 байт → ошибка;
    - вложенность 17 `details` → ошибка;
    - годный документ → `[]`.
- `backend/api/test/telegram-rich-render.test.ts`: тот же документ →
  - блоки Telegram с ожидаемыми `type`;
  - у таблицы `is_header` у первого ряда;
  - `date_time` с `unix_time` и `date_time_format: "wDT"`;
  - кнопка действия — `callback_data`.
- `backend/api/test/telegram-messenger-rich.test.ts` (фейк `TelegramBotApi`):
  - с `rich` зовётся `rich.sendRichMessage` с клавиатурой из `button` и
    `action` и `silent`;
  - без `rich` — `sendMessage` с `silent`;
  - `sendRichMessage` бросает 400 `BLOCK_INVALID` → `sendMessage` с
    `message.text`, исход `{ status: "sent", fallback: true }`; лог
    `rich_fallback` один раз на два таких отказа;
  - 404 → то же;
  - 400 `chat not found` → `blocked`, запасной текст не отправляется;
  - 429 → `retry`.
- `backend/api/test/bot-message-policy.test.ts` (фейки Redis и настроек):
  - `quietEndsAt` на 23:30 МСК при окне 21–10 → завтра 10:00 МСК; на 09:59 →
    сегодня 10:00; окно 1–5 на 03:00 → 05:00;
  - формат выключен → `send` со звуком при любом источнике;
  - `reply` → со звуком, счётчик не тронут;
  - `player` → без звука;
  - `bot` в тихий час: напоминание → `skip`, остальное → `wait` до 10:00 МСК;
  - `bot` днём: первые два → со звуком, третий → без звука; на следующие
    игровые сутки — снова со звуком (ключ по московскому дню, проверка на
    00:30 МСК, когда по UTC ещё вчера);
  - Redis бросает → без звука.
- `backend/api/test/notifications-bot-policy.test.ts`:
  - заявка в друзья в 23:00 МСК при включённом формате → `deferred` до
    10:00; очередь ставит задание `<id>-q` с задержкой, `MAX_DEFERRALS` не
    тратится;
  - то же при выключенном формате → уходит сразу, как сейчас;
  - третье за сутки → `silent: true` у `messenger.send`;
  - после отправки `events.sent` получил `kind: "friend_request"`,
    `format: "text"`, `topic: "none"`;
  - `retry` события не пишет;
  - `Reflect.getMetadata("imports", NotificationsBotModule)` содержит
    `BotMessagesModule`, а его `exports` — `BotMessagePolicy`,
    `BotMessageEvents`, `BotMessages`.
- `scripts/test/event-dictionary.test.ts`: `bot_message_sent` принимает
  `{ kind: "season_card", format: "card", outcome: "fallback", topic: "rewards", silent: true }`
  и отклоняет `format: "html"`.
- Существующие `notifications-bot.test.ts` и `reminders.test.ts` проходят без
  правок.

## Аналитика

- `bot_message_sent` (новое, серверное):
  - `kind` — вид сообщения;
  - `format` — `text`, `photo`, `rich`, `card`;
  - `outcome` — `sent`, `blocked`, `failed`, `fallback`;
  - `topic` — `none`, `news`, `rewards`, `support`;
  - `silent`.

  Сначала `docs/22` §3.3, потом код. В Prometheus ничего с аккаунтом.

## Настройки и окружение

- `bot.formats.enabled` — выкл.
- `bot.rich.enabled` — вкл.
- `bot.loud-per-day` — 2, коридор 1–5.

Все три — в группе «Сообщения бота» (`setting-catalog.ts`). Строка 90
`docs/30-configuration-map.md` их уже называет. Ключ Redis
`bot-loud:<аккаунт>:<день>` дописать в эту строку. Переменных окружения нет.

## Документы

- `docs/22-analytics-and-metrics.md` §3.3 — по шагу 9.
- `docs/30-configuration-map.md`, строка 90 — ключ Redis счётчика звука.

## Критерии приёмки

- [ ] `RichDocument`, `plainTextOf`, `richProblems` лежат в
      `platforms/ports/rich-message.ts`, без импортов домена и адаптеров.
- [ ] Telegram шлёт оформленное `sendRichMessage` с той же клавиатурой; на
      400 и 404 уходит простой текст, исход помечен `fallback`, лог — один раз.
- [ ] Площадка без `capabilities` получает только `text` — простой текст
      того же документа.
- [ ] С выключенным `bot.formats.enabled` дубль уведомлений ведёт себя ровно
      как до задачи: тесты T-0128 зелёные без правок.
- [ ] С включённым: ночью — `deferred` до конца тихих часов (напоминание —
      пропуск), третье сообщение за сутки — без звука.
- [ ] `bot_message_sent` описан в `docs/22`, есть в словаре сервера и в
      списке клиента и пишется после каждой окончательной отправки дубля.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Оформленные сообщения бота и правила звука`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет:
  выключатель `bot.formats.enabled` по умолчанию выключен.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОФОРМЛЕННЫЕ СООБЩЕНИЯ БОТА**

  Домен научился писать боту документами из блоков — заголовки, таблицы, раскрывающиеся блоки, кнопки, время в поясе читателя (Р199). Telegram показывает их оформленными, MAX и VK — тем же простым текстом.

  🛠 **Что внутри**

  • RichDocument и его простой текст — порт площадок; отказ Telegram на новом методе — простой текст и строка лога
  • правила звука: ответы — всегда, вызванное игроком — без звука, ночью бот ждёт 10:00, со звуком — не больше 2 в сутки
  • событие bot_message_sent у каждого сообщения бота

  ⚙️ **Настройки**

  • панель → «Сообщения бота»: bot.formats.enabled (выкл.), bot.rich.enabled, bot.loud-per-day 2

  ❓ **Нужно от команды**

  • @владелец — подтвердить: правила звука и тихих часов при включённом bot.formats.enabled действуют и на дубль уведомлений (заявка ночью ждёт 10:00)
  ```
