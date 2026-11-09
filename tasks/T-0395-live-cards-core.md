---
id: T-0395
title: Живые карточки бота — ядро — порт, таблица bot_card, отправка, прореженные правки, финал, ответы на запросы
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0393, T-0394]
zones:
  - backend/api/src/platforms/ports/live-card.ts
  - backend/api/src/modules/bot-cards/bot-card-protocol.ts
  - backend/api/src/modules/bot-cards/bot-card-kinds.ts
  - backend/api/src/modules/bot-cards/bot-cards.repository.ts
  - backend/api/src/modules/bot-cards/bot-cards.service.ts
  - backend/api/src/modules/bot-cards/bot-cards-answerer.ts
  - backend/api/src/modules/bot-cards/bot-cards.finalizer.ts
  - backend/api/src/modules/bot-cards/bot-card-events.ts
  - backend/api/src/modules/bot-cards/bot-cards.module.ts
  - backend/api/prisma/migrations/*_bot_card/**
  - backend/api/test/bot-cards.test.ts
  - backend/api/test/bot-card-protocol.test.ts
  - backend/api/test/bot-cards.integration.test.ts
shared:
  - backend/api/src/modules/bot-cards/bot-card-choices.ts
  - backend/api/prisma/schema.prisma
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/src/modules/notifications-bot/bot-notify-queue.ts
  - backend/api/src/modules/notifications-bot/notifications-bot.module.ts
  - backend/api/src/platforms/platforms.module.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - backend/api/src/app.module.ts
  - packages/app-shell/src/state/analytics.ts
  - scripts/test/account-settings-keys.test.ts
  - scripts/test/event-dictionary.test.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 5
---

# T-0395. Живые карточки бота — ядро — порт, таблица bot_card, отправка, прореженные правки, финал, ответы на запросы

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0395.json)](README.md#значки-статуса) [![T-0393](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0393.json&label=T-0393)](T-0393-bot-api-v10-layer.md) [![T-0394](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0394.json&label=T-0394)](T-0394-rich-message-port.md)

## Зачем

Карточки «Сезон», «Награда дня» и «Приглашения» (Р199) — сообщения, которые
бот обновляет сам и которые спрашивают бота по касанию. Задача делает общую
основу, на которую каждая карточка встаёт одним файлом вида:
- порт площадки;
- учёт отправленных карточек в базе;
- правило «живая — одна на вид»;
- правки не чаще раза в N минут;
- финал по концу периода;
- ответы на запросы — с кэшем, лимитом и сроком;
- событие `bot_card_query`.

HTML карточек и Telegram — T-0396.

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52, правила 1–3, 6, 9; §3.11, строка
  «Живая карточка»):
  - домен говорит видом карточки и её состоянием, HTML — дело адаптера;
  - площадка без карточек получает обычное сообщение с тем же содержанием,
    без обновлений;
  - живая карточка одного вида у игрока одна: повторная отправка переводит
    прежнюю в «перенесена ниже»;
  - правки — без звука, не чаще раза в `bot.widget.edit-min-minutes` (10
    минут) на карточку, кроме финальной, и общим темпом с дублем уведомлений
    (`BOT_NOTIFY_PER_SEC`, 5 в секунду);
  - запрос — данные до 64 байт `<версия>:<действие>[:<аргумент>]`, ответ и
    состояние — до 1024 байт;
  - ответ — всегда, в том числе ошибкой; свой срок обработки — 8 секунд;
  - фоновый запрос отвечается из кэша состояния (30 секунд на аккаунт и
    вид); сверх своего лимита — ответ из кэша с пометкой «устарело»;
  - состояние всегда несёт `v: 1`; флаги «перенесена», «выключено»,
    «устарело» и «закрыта» понимает уже первая версия карточки;
  - `bot.formats.enabled` выключен — на запрос «выключено», новые карточки
    не отправляются.
- **Решения тимлида (технические, по Р199):**
  - **общий темп** — правки и отправки карточек по триггерам идут **той же
    очередью BullMQ `notifications-bot`** отдельными именами заданий: её
    лимитер (5 в секунду на все реплики) один на дубль и карточки. Ответ
    на команду игрока (`/season` и др.) уходит сразу, мимо очереди: это
    ответ, а не рассылка;
  - **порт** — `LiveCards` рядом с `Messengers`, а не флаг `cards` у
    `Messenger`. Поддержку вида решает адаптер (`supports(kind)`);
  - **виды регистрируются сами** (`BotCardKinds.register` в `onModuleInit`
    модуля вида), как слушатели `RunsHooks`. Общего списка видов в ядре нет:
    карточки T-0397, T-0398, T-0399 не делят файлов;
  - **выбор игрока** — ключи аккаунта видов (`bot.seasonCard`,
    `bot.invitesCard`, у награды дня — прежний `bot.reminders`) проверяются
    только у карточек по триггеру. Команду игрок вызвал сам — ей выбор не
    мешает;
  - **протокол запроса** — `v<версия>:<действие>[:<аргумент>]`, действие
    обновления — `r`. Пример: `v1:r`, `v1:claim_daily`.
- **Деньги в ядре не живут**: ядро только передаёт действие виду (`act`).
  Начисления — у видов, с проверками своих сервисов (T-0398).

## Как сейчас

- Порты — образец `platforms/ports/messenger.ts`: интерфейс и реестр по
  площадке (`Messengers.for(platform)`). Реестры собираются в
  `platforms/platforms.module.ts`: функции `…For(config, telegramApi)` и
  провайдеры, строки 63–86.
- Очередь дубля — `modules/notifications-bot/bot-notify-queue.ts`:
  - очередь `notifications-bot`, лимитер
    `{ max: BOT_NOTIFY_PER_SEC, duration: 1000 }`, `concurrency: 1`;
  - `process(job)` разбирает `jobSchema` — строки 92–108;
  - модуль `notifications-bot.module.ts` ничего не экспортирует.
- После T-0394:
  - `BotMessagesModule` — `BotMessagePolicy` (звук и тихие часы),
    `BotMessageEvents` (`bot_message_sent`), `BotMessages.compose`
    (`RichDocument` → `OutgoingMessage`);
  - `ports/messenger.ts` — `MessageTopic`, `silent`.
- Лимит частоты — `modules/ingest/rate-limiter.ts` `RateLimiter.consume(rule, key)`,
  глобальный провайдер (образец — `daily/daily.controller.ts`, строка 12).
- Распределённый лок прохода — образец `reminders/reminders.store.ts`
  (`SET NX PX` с токеном, снятие скриптом) и `reminders.scanner.ts`
  (`setInterval` в `onApplicationBootstrap`).
- Аккаунт по идентификатору площадки — `AccountRepository.byPlatformUser(platform, platformUserId)`;
  «можно ли писать» — `MessagingService.state(accountId)`; выбор игрока —
  `AccountSettingsService.valueOf(accountId, key)`.
- Частичный уникальный индекс Prisma не описывает — он пишется в миграции
  руками. Образец — `prisma/migrations/20260930093254_wheel/migration.sql`,
  строка 28; комментарий у модели — `schema.prisma` (`/// … частичный
  уникальный индекс в миграции`).
- Вайп — `modules/wipe/wipe-plan.ts` и счётчики `wipe` и `keep` в
  `test/wipe-plan.test.ts`, строки 41–42.
- Сверка выбора игрока клиента и сервера —
  `scripts/test/account-settings-keys.test.ts`, строки 38–50: обходит только
  `BOT_NOTIFY`.

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **`platforms/ports/live-card.ts`** — без импортов домена:
   ```ts
   export interface LiveCardRef { chatId: string; messageId: number }
   export interface LiveCardMessage {
     kind: string;            // ^[a-z_]{3,16}$
     state: string;           // JSON, ≤ 1024 байт
     caption: string;         // ≤ 1024 знаков — правда и без обновлений
     button: { text: string; url: string } | null;
     silent: boolean;
     topic?: MessageTopic;
   }
   export type LiveCardSendOutcome = { status: "sent"; ref: LiveCardRef; version: string } | Exclude<SendOutcome, { status: "sent" }>;
   export type LiveCardUpdateOutcome = { status: "edited" | "unchanged" | "gone" } | Exclude<SendOutcome, { status: "sent" }>;
   export interface LiveCardPort {
     readonly platform: PlatformId;
     readonly configured: boolean;
     supports(kind: string): boolean;
     send(platformUserId: string, message: LiveCardMessage): Promise<LiveCardSendOutcome>;
     update(ref: LiveCardRef, state: string): Promise<LiveCardUpdateOutcome>;
   }
   export class LiveCards { constructor(ports: readonly LiveCardPort[]); for(platform: PlatformId): LiveCardPort | null }
   export interface LiveCardQuery { platform: PlatformId; platformUserId: string; ref: LiveCardRef | null; data: string }
   export interface LiveCardAnswerer { answer(query: LiveCardQuery): Promise<string> }
   export const LIVE_CARD_ANSWERER = Symbol("LIVE_CARD_ANSWERER");
   ```
   `gone` — сообщения больше нет: игрок удалил его.
   В `platforms.module.ts` — `liveCardsFor()` возвращает `new LiveCards([])` и
   провайдер `LiveCards` в `exports`. Адаптер Telegram добавит T-0396.
3. **`bot-card-protocol.ts`** — чистые функции:
   - `parseQueryData(data)` → `{ version: number; action: string; arg: string | null } | null`
     по `^v(\d{1,2}):([a-z_]{1,24})(?::([A-Za-z0-9_-]{1,32}))?$`;
     не по формату или длиннее 64 байт → `null`;
   - `CARD_FLAGS = { moved: "moved", off: "off", stale: "stale", closed: "x" }`;
   - `encodeState(state: Record<string, unknown>)` → строка JSON с `v: 1`
     первым полем; длиннее 1024 байт → `RangeError` (вид обязан держаться в
     пределе);
   - `stateHash(json)` → sha256 hex;
   - `answerOf(obj)` → строка ≤ 1024 байт; длиннее — `{"v":1,"err":"big"}` и
     строка лога `card_answer_too_big`.
4. **`bot-card-kinds.ts`** — контракт вида и реестр:
   ```ts
   export interface BotCardKind {
     kind: string;                                   // "season" | "daily" | "invites"
     enabled: SettingDefinition<boolean>;            // ключ панели вида
     choice: { setting: string; byDefault: boolean } | null; // выбор игрока для триггеров
     startRef: string;                               // n-<вид>_card — кнопка «▶ Играть»
     periodKey(at: Date): string | null;             // смена периода → финал; null — без финала
     state(accountId: string, at: Date): Promise<Record<string, unknown>>;
     /** финал периода; нет — последнее отправленное состояние с `x: 1` */
     finalState?(last: Record<string, unknown>, at: Date): Record<string, unknown>;
     caption(state: Record<string, unknown>): string;
     fallback(state: Record<string, unknown>): RichDocument; // площадка без карточек
     act?(account: AccountRef, action: string, arg: string | null, at: Date): Promise<{ outcome: "ok" | "already" | "locked"; result: Record<string, unknown> }>;
     actions: readonly string[];                     // разрешённые действия кроме `r`
   }
   @Injectable() export class BotCardKinds { register(kind: BotCardKind): void; get(kind: string): BotCardKind | undefined; all(): BotCardKind[] }
   ```
   Повтор вида при регистрации → исключение на старте.
5. **`bot-card-choices.ts`** — данные без импортов: ключ аккаунта и
   умолчание для каждого вида с выбором,
   `export const BOT_CARD_CHOICES: Record<string, { setting: string; byDefault: boolean }> = {};`.
   Строки добавят задачи видов. В `scripts/test/account-settings-keys.test.ts`
   — второй кейс по образцу первого: для каждой строки клиентский ключ есть в
   `BOT_NOTIFY_ACCOUNT_KEYS`, умолчание то же, ключ есть на сервере. Пустой
   список кейс проходит.
6. **Prisma** — модель в конце `schema.prisma` блоком с заголовком:
   ```prisma
   /// Живая карточка бота (Р199, WP52): сообщение с состоянием, которое бот правит.
   /// Живая (`closed_at IS NULL`) на вид у игрока одна — частичный уникальный индекс в миграции
   model BotCard {
     id        String    @id @default(uuid()) @db.Uuid
     accountId String    @map("account_id") @db.Uuid
     platform  String    @db.VarChar(16)
     kind      String    @db.VarChar(16)
     chatId    String    @map("chat_id") @db.VarChar(32)
     messageId Int       @map("message_id")
     /// версия облика у площадки: у Telegram — первые 8 hex sha256 HTML
     version   String    @db.VarChar(16)
     periodKey String?   @map("period_key") @db.VarChar(16)
     /// последнее отправленное состояние (JSON ≤ 1024 байт): из него «перенесена» и финал
     state     String
     stateHash String    @map("state_hash") @db.VarChar(64)
     createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
     updatedAt DateTime  @map("updated_at") @db.Timestamptz(3)
     closedAt  DateTime? @map("closed_at") @db.Timestamptz(3)
     account Account @relation(fields: [accountId], references: [accountId], onDelete: Cascade)
     @@index([platform, chatId, messageId])
     @@index([kind, periodKey])
     @@map("bot_card")
   }
   ```
   - связь в `model Account` — одной строкой;
   - миграция `<UTC>_bot_card` — по `tasks/README.md`, «Общие файлы», без
     базы. Руками дописать
     `CREATE UNIQUE INDEX "bot_card_live_key" ON "bot_card"("account_id", "kind") WHERE "closed_at" IS NULL;`
   - `wipe-plan.ts` — `BotCard: wipe("живые карточки бота (Р199): после вайпа состояние другое; карточки в чатах отвечают «устарела»")`,
     счётчик `wipe` в тесте +1;
   - `docs/21-diagrams.md` — сущность `bot_card` в конец `erDiagram` и связь
     с `account`.
7. **`bot-cards.repository.ts`** (Prisma, каждый вызов с таймаутом 3 с):
   - `live(accountId, kind)`;
   - `byMessage(platform, chatId, messageId)`;
   - `openReplacing(input)` — в одной транзакции закрывает прежнюю живую
     (`closed_at = now`) и вставляет новую; возвращает id прежней или `null`;
   - `touched(id, state, stateHash, at)`;
   - `close(id, at)`;
   - `dueForFinal(kind, currentPeriodKey, limit)` — живые этого вида с другим
     `period_key`.
8. **Очередь** (`bot-notify-queue.ts`, `notifications-bot.module.ts`):
   - `registerPaced(name: string, handler: (data: unknown) => Promise<void>)`;
   - `addPaced(name, data, { jobId, delayMs })` — `removeOnComplete: true`,
     `removeOnFail: true`, `attempts: 3`, `backoff` экспоненциальный 10 с.
     Без удаления выполненного задания тот же `jobId` нельзя поставить снова:
     BullMQ отклоняет повтор id, пока задание хранится;
   - `process(job)` — по `job.name`: `notify` (и задание без имени) — как
     было, иначе — зарегистрированный обработчик; незнакомое имя — лог и
     выход;
   - имя `notify` в `registerPaced` — исключение;
   - модуль экспортирует `BotNotifyQueue`.
9. **`bot-cards.service.ts`** — `BotCardsService`:
   - `send({ accountId, kind, origin }, at)` → `CardSendResult`
     (`"sent" | "fallback" | "off" | "opted_out" | "not_allowed" | "deferred" | "skipped" | "blocked" | "failed" | "busy"`).
     По порядку:
     1. выключены `bot.formats.enabled` или ключ вида → `off`;
     2. аккаунта нет или он заблокирован → `skipped`;
     3. площадки без бота → `skipped`;
     4. `canMessage` не `true` → `not_allowed`;
     5. у триггера (`origin` не `reply`) — выбор игрока выключен →
        `opted_out`;
     6. `BotMessagePolicy.decide`: `skip` → `skipped`; `wait` →
        `addPaced("card-send", { accountId, kind, origin: "bot" }, { jobId: "card-send:<аккаунт>:<вид>:<период>", delayMs })`
        → `deferred`;
     7. лок `bot-cards:send:<аккаунт>:<вид>` (`SET NX PX 15000` с токеном),
        занят → `busy`;
     8. состояние вида → `encodeState`;
     9. порт поддерживает вид → `send`, иначе `messenger.send(BotMessages.compose(kind.fallback(state), { button }))`;
     10. на успехе порта — `openReplacing`; у прежней — задание
         `card-moved:<id прежней>` — её сохранённое состояние с `moved: 1`.
     - Кнопка — `{ text: "▶ Играть", url: AppLinks.launch(platform, startRef) }`,
       без ссылки — `null`.
     - Подпись — `kind.caption(state)`.
     - Событие — `bot_message_sent`: `kind: "<вид>_card"`; `format: "card"` у
       порта, у запаса — `rich` или `text`.
     - Отказ вставки по уникальному индексу (гонка мимо лока) → только что
       отправленной карточке — `moved` и строка `closed_at` сразу, лог
       `card_race`.
   - `sendLater({ accountId, kind, origin })` — отправка по триггеру (забег,
     пришедший друг) через очередь:
     `addPaced("card-send", { accountId, kind, origin }, { jobId: "card-send:<аккаунт>:<вид>:<период>", delayMs: 0 })`.
     Триггеры зовут её, а не `send`: так отправки идут общим темпом.
   - `touch(accountId, kind)` — есть живая карточка → `addPaced("card-edit", { cardId }, { jobId: "card-edit:<id>", delayMs: max(0, updatedAt + gap − now) })`.
     Повторный `touch`, пока задание ждёт, ничего не добавляет: правки
     сливаются.
   - Обработчик `card-edit`:
     - карточка закрыта → выход;
     - состояние собирается заново;
     - хэш тот же → выход без вызова площадки;
     - `update`: `gone` → `close`; `retry` → бросить (повтор BullMQ);
       успех → `touched`.
   - Обработчики `card-moved` и `card-final` — то же без прореживания;
     `card-final` после правки закрывает карточку.
   - Обработчик `card-send` — `send` с `origin` из данных задания (у
     отложенной тихими часами — `bot`).
10. **`bot-cards.finalizer.ts`** — проход раз в 10 минут
    (`FINAL_SCAN_MS = 600_000`) под локом `bot-cards:final:lock`:
    - для каждого вида с `periodKey(now) !== null` берёт `dueForFinal` (до
      500 за проход);
    - ставит `card-final:<id>`: сохранённое состояние карточки с `x: 1`, или
      `kind.finalState(последнее, now)`, если вид его задал. Состояние
      нового периода сюда не годится: карточка закрывает свою неделю;
    - без входа игроков (`auth.enabled` выкл.) не запускается.
11. **`bot-cards-answerer.ts`** — `BotCardsAnswerer implements LiveCardAnswerer`,
    провайдер `LIVE_CARD_ANSWERER` (`useExisting`), в `exports`.
    `answer(query)` — **всегда строка**; общий срок 8 с (`withTimeout`),
    по истечении — `{"v":1,"err":"timeout"}`. По порядку:
    1. `parseQueryData` → `null` → `err: "bad"`;
    2. `bot.formats.enabled` выкл. → `{ v: 1, off: 1 }`;
    3. аккаунт по `platformUserId` нет или заблокирован → `err: "auth"`;
    4. `ref` нет или карточки по нему нет → `{ v: 1, x: 1 }`;
    5. карточка другого аккаунта → `err: "foreign"`;
    6. карточка закрыта → `{ v: 1, x: 1 }`;
    7. ключ вида выключен → `{ v: 1, off: 1 }`;
    8. `RateLimiter.consume({ scope: "bot-card", limit: 300, windowSec: 3600 }, accountId)`
       → `false`: у `r` — ответ из кэша с `stale: 1` (кэша нет —
       `{ v: 1, stale: 1 }`), у действия — `err: "limited"`;
    9. `r` → кэш Redis `bot-card:state:<аккаунт>:<вид>` (30 с); нет — собрать
       и положить;
    10. действие не из `kind.actions` → `err: "bad"`;
    11. иначе `kind.act(...)` → `{ v: 1, res: outcome, ...result }`; кэш
        состояния этого аккаунта и вида сбрасывается, `touch`.
    - Любая ошибка — `err: "error"` и строка лога без данных игрока.
    - Событие `bot_card_query` — после каждого ответа.
12. **`bot-card-events.ts`** — запись `bot_card_query` по образцу
    `bot-message-events.ts` (T-0394):
    - `card` — вид;
    - `action` — `refresh` для `r`, иначе имя действия;
    - `outcome`: `ok`, `already`, `locked`, `limited`, `off`, `error`;
      `bad`, `auth`, `foreign`, `timeout`, `big` и устаревшая карточка —
      `error`.
13. **`bot-cards.module.ts`:**
    - импортирует `AuthModule`, `MessagingModule`, `AccountSettingsModule`,
      `BotMessagesModule`, `NotificationsBotModule`;
    - провайдеры: `BotCardKinds`, репозиторий, `BotCardsService`,
      `BotCardsAnswerer`, `LIVE_CARD_ANSWERER`, финализатор;
    - **`exports`** — `BotCardKinds`, `BotCardsService`, `LIVE_CARD_ANSWERER`;
    - обработчики очереди регистрируются в `onModuleInit` сервиса;
    - строка в `app.module.ts`.
14. **Настройка** — `setting-catalog.ts`, группа «Сообщения бота» (T-0394):
    `botWidgetEditMinMinutes = integer("bot.widget.edit-min-minutes", BOT_MESSAGES_GROUP, "Правка карточки — не чаще раза в", "Бот правит одну живую карточку не чаще; финальная правка периода — сразу", { min: 1, max: 120, unit: ["минута", "минуты", "минут"] }, 10)`.
15. **Словарь событий** — сначала `docs/22` §3.3: строка `bot_card_query` с
    полями и абзац «серверное». Потом `event-dictionary.ts`:
    `bot_card_query: { version: 1, payload: payload({ card: id, action: id, outcome: z.enum(["ok", "already", "locked", "limited", "off", "error"]) }) }`
    и строка в `app-shell/src/state/analytics.ts`.
16. **`docs/30-configuration-map.md`**, строка 90 — ключи Redis:
    - `bot-card:state:<аккаунт>:<вид>` (30 с);
    - `bot-cards:send:<аккаунт>:<вид>`, `bot-cards:final:lock`;
    - лимит `rl:bot-card:*` — 300 в час;
    - задания `card-*` в очереди `notifications-bot`.

## Чего не трогаем

- Виды карточек и их HTML — T-0397, T-0398, T-0399; адаптер Telegram —
  T-0396.
- Поведение дубля уведомлений: задания `notify` разбираются ровно как
  раньше.
- `BotMessagePolicy` и `bot_message_sent` — только использовать (T-0394).
- Начисления: ядро не зовёт кошелёк, только `kind.act`.

## Тесты

Первым коммитом.

- `backend/api/test/bot-card-protocol.test.ts`:
  - `v1:r` → `{ version: 1, action: "r", arg: null }`;
  - `v1:claim_tasks:abc-1` → с аргументом;
  - `1:r`, `v1:R`, `v1:r:` и строка из 65 байт → `null`;
  - `encodeState` ставит `v: 1` первым и бросает на 1025 байтах;
  - `answerOf` длинного → `{"v":1,"err":"big"}`.
- `backend/api/test/bot-cards.test.ts` (фейки: порт, `Messengers`,
  репозиторий в памяти, Redis, очередь, политика, настройки, часы):
  - два вызова `send(reply)` подряд → две отправки порту; у первой —
    задание `card-moved` с `moved: 1`; живая — одна, вторая;
  - лок занят → `busy`, порт не вызван;
  - `bot.formats.enabled` выкл. → `off`; ключ вида выкл. → `off`;
  - триггер (`player`) при выключенном выборе игрока → `opted_out`;
    команда (`reply`) при том же выборе — отправлена;
  - политика `wait` → `deferred`, задание `card-send` с задержкой;
  - порт не поддерживает вид → `messenger.send` с текстом `plainTextOf(fallback)`
    и кнопкой; событие `format: "text"` или `"rich"`;
  - событие `bot_message_sent` с `kind: "season_card"`, `format: "card"`;
  - `touch` дважды за 10 минут → одно задание `card-edit` с задержкой до
    `updatedAt + 10 мин`;
  - обработчик `card-edit` с тем же хэшем → `update` не вызван; `gone` →
    карточка закрыта;
  - финализатор: живая карточка прошлого периода → `card-final` с `x: 1`,
    затем закрыта; текущего периода — не тронута; второй экземпляр при
    занятом локе ничего не делает;
  - `answer`:
    - `bad` на мусоре;
    - `off` при выключенном формате;
    - `auth` без аккаунта и у заблокированного;
    - `x: 1` без карточки и у закрытой;
    - `foreign` у карточки другого аккаунта;
    - `r` второй раз за 30 с — без сборки состояния (кэш);
    - сверх лимита: `r` → `stale: 1`, действие → `limited`;
    - действие не из `actions` → `bad`;
    - `act` бросает → `error`;
    - `act` дольше 8 с (поддельные часы таймаута) → `timeout`;
    - событие `bot_card_query` с `action: "refresh"` и нужным `outcome` в
      каждом случае.
- `backend/api/test/bot-cards.integration.test.ts` (живые Postgres и Redis):
  - частичный индекс: вторая живая строка того же аккаунта и вида → отказ,
    закрытая — можно;
  - два параллельных `send` → одна живая карточка в базе;
  - `openReplacing` закрывает прежнюю в той же транзакции;
  - `dueForFinal` возвращает только живые с другим периодом;
  - очередь: `addPaced` с тем же `jobId` дважды — одно задание; после
    выполнения тот же `jobId` ставится снова.
- `scripts/test/account-settings-keys.test.ts` — кейс по
  `BOT_CARD_CHOICES` (пустой список проходит).
- `scripts/test/event-dictionary.test.ts` — `bot_card_query` принимает
  `{ card: "daily", action: "claim_daily", outcome: "already" }`, отклоняет
  `outcome: "stale"`.
- `backend/api/test/wipe-plan.test.ts` — счётчик `wipe` +1.
- Существующие тесты дубля уведомлений (`notifications-bot.test.ts`)
  проходят без правок.

## Аналитика

- `bot_card_query` (новое, серверное):
  - `card` — `season`, `daily`, `invites`;
  - `action` — `refresh` или действие вида;
  - `outcome` — `ok`, `already`, `locked`, `limited`, `off`, `error`.
- `bot_message_sent` — существующее (T-0394), `kind: <вид>_card`,
  `format: card`.
- В Prometheus ничего с аккаунтом.

## Настройки и окружение

- `bot.widget.edit-min-minutes` — 10, коридор 1–120, группа «Сообщения
  бота».
- Лимит запросов карточек — константа `CARD_QUERY_LIMIT` (300 в час на
  аккаунт) в `bot-cards-answerer.ts`.
- Переменных окружения нет.

## Документы

- `docs/21-diagrams.md` — ER: `bot_card`.
- `docs/22-analytics-and-metrics.md` §3.3 — `bot_card_query`.
- `docs/30-configuration-map.md`, строка 90 — ключи Redis и лимит (шаг 16).

## Критерии приёмки

- [ ] Порт `LiveCardPort` и реестр `LiveCards` лежат в
      `platforms/ports/live-card.ts`; домен не импортирует адаптеры (тест
      границ слоёв зелёный).
- [ ] Живая карточка вида у игрока одна — и при гонке (частичный
      уникальный индекс плюс лок), прежняя получает `moved`.
- [ ] Правки одной карточки не чаще `bot.widget.edit-min-minutes`, без
      вызова площадки при том же состоянии; финал периода — проходом под
      локом.
- [ ] Правки и отправки по триггерам идут очередью `notifications-bot` с её
      лимитером; задания `notify` работают как раньше.
- [ ] `answer` всегда возвращает строку ≤ 1024 байт за 8 секунд;
      выключатель, лимит, кэш, чужая и устаревшая карточка — по шагу 11.
- [ ] `bot_card_query` описан в `docs/22` и пишется на каждый ответ.
- [ ] Миграция одна, собрана после свежего `dev`; `wipe-plan` и ER обновлены.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Живые карточки бота — ядро`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЖИВЫЕ КАРТОЧКИ БОТА: ЯДРО**

  Основа для карточек «Сезон», «Награда дня» и «Приглашения» (Р199): бот помнит отправленные карточки, правит их не чаще раза в 10 минут, закрывает по концу периода и отвечает на запросы из них. Игрок пока ничего не заметит.

  🛠 **Что внутри**

  • таблица bot_card: живая карточка вида у игрока одна, прежняя становится «перенесена ниже»
  • правки и отправки — той же очередью, что дубль уведомлений, общим темпом 5 в секунду
  • ответ на запрос — всегда за 8 секунд: кэш 30 секунд, лимит 300 в час, выключатель
  • событие bot_card_query

  ⚙️ **Настройки**

  • панель → «Сообщения бота»: bot.widget.edit-min-minutes 10
  ```
