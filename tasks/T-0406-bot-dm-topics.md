---
id: T-0406
title: Темы в личке бота — «Новости», «Награды», «Поддержка»
epic: E5
priority: P3
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0393, T-0394, T-0395, T-0396, T-0403]
zones:
  - backend/api/src/platforms/telegram/telegram-topics.ts
  - backend/api/src/platforms/telegram/telegram-topics.store.ts
  - backend/api/prisma/migrations/*_bot_topic/**
  - backend/api/test/telegram-topics.test.ts
  - backend/api/test/telegram-topics-routing.test.ts
  - backend/api/test/telegram-topics.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/src/platforms/platforms.module.ts
  - backend/api/src/platforms/telegram/telegram-messenger.ts
  - backend/api/src/platforms/telegram/telegram-live-cards.ts
  - backend/api/src/platforms/telegram/bot-commands.ts
  - backend/api/src/platforms/telegram/bot-fallback.ts
  - backend/api/src/modules/notifications-bot/bot-notify-rules.ts
  - backend/api/src/modules/notifications-bot/bot-notify-sender.ts
  - backend/api/src/modules/bot-cards/bot-cards.service.ts
  - backend/api/src/modules/broadcasts/broadcast-sender.ts
  - backend/api/test/broadcasts.test.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/21-diagrams.md
  - docs/28-diagnostics.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 5
---

# T-0406. Темы в личке бота — «Новости», «Награды», «Поддержка»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0406.json)](README.md#значки-статуса) [![T-0393](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0393.json&label=T-0393)](T-0393-bot-api-v10-layer.md) [![T-0394](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0394.json&label=T-0394)](T-0394-rich-message-port.md) [![T-0395](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0395.json&label=T-0395)](T-0395-live-cards-core.md) [![T-0396](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0396.json&label=T-0396)](T-0396-live-cards-telegram.md) [![T-0403](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0403.json&label=T-0403)](T-0403-rich-broadcasts-server.md)

## Зачем

Всё, что пишет бот, сейчас идёт одной лентой: новости, итоги, карточки,
напоминания и ответы на `/help` вперемешку. Telegram разрешает боту темы в
личке. После задачи у игрока в чате с ботом три темы:
- «Новости» — рассылки и «Что нового»;
- «Награды» — итог сезона, живые карточки, напоминания, рекорд;
- «Поддержка» — `/help`, ответ на переписку, сообщения команды из панели.

Остальное — в общий чат, как сейчас (Р199, сценарий «Темы в личке»). На MAX
и VK тем нет — всё как раньше.

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52, сценарий «Темы в личке»,
  правила 1, 9; §3.11, строка «Темы в личке»):
  - домен говорит, в какую тему сообщение (`OutgoingMessage.topic`,
    T-0394), адаптер решает, есть ли темы;
  - режим тем включает владелец в BotFather; бот узнаёт его по
    `getMe().has_topics_enabled` (`BotIdentity.topicsEnabled`, T-0393);
  - ключ `bot.topics.enabled` — умолчание **выкл.**; действует, только когда
    включён `bot.formats.enabled`;
  - поле `topic` у `bot_message_sent`.
- **Карта вид → тема** (сценарий WP52):

  | Тема | Что | Где задаётся |
  |---|---|---|
  | `news` | рассылки, «Что нового» | `broadcast-sender.ts` `messageOf` |
  | `rewards` | итог сезона, напоминания (`season_overtaken`, `season_closing`, `daily_reward_ready`, `wheel_ready`), живые карточки, рекорд | `bot-notify-rules.ts`, `bot-cards.service.ts`; рекорд — уже T-0401 |
  | `support` | `/help` в личке, ответ на переписку (`bot-fallback.ts`), `team_message` | `bot-commands.ts`, `bot-fallback.ts`, `bot-notify-rules.ts` |
  | — | заявка и подарок друга, приветствие `/start`, остальное | общий чат |

- **Решения тимлида (технические):**
  - **Тема — на чат, а не на аккаунт.** Тема живёт в чате Telegram: ответ на
    `/help` нужен и тому, у кого ещё нет аккаунта. Таблица `bot_topic` —
    `(platform, chat_id, topic)` → `thread_id`, без связи с `account`;
  - адаптер Telegram держит её сам через `PRISMA`: домену id темы ни к чему;
  - **создание — лениво**, при первом сообщении в тему, под локом Redis на
    чат и тему. Лок занят → сообщение уходит в общий чат: две темы
    «Новости» хуже одного сообщения не на месте;
  - **тема пропала** (игрок удалил её; ответ `400` про тему) → строка
    стирается, тема создаётся заново **один раз**, сообщение уходит в неё.
    Снова отказ — в общий чат;
  - **создать не дали** (`400` на `createForumTopic`) → отметка «темы не
    выходят» на чат на сутки в Redis, сообщения — в общий чат;
  - **ответ на команду — там, где спросили.** `/help`, написанный в теме, —
    в ту же тему. В общем чате — в «Поддержку». Так велит сценарий WP52, а
    ответ в той же теме не теряется;
  - **вайп** — `keep`: темы остаются в чатах игроков, и после вайпа бот
    должен писать в них же.
- **Шаг владельца после мерджа:** включить режим тем в BotFather. До этого
  `has_topics_enabled = false`, и ключ ничего не меняет.

## Как сейчас

- После T-0393:
  - `TelegramRichApi.createForumTopic(chatId: number, name, iconColor, signal?)`
    → `{ threadId }`; цвета — `TopicColor`;
  - `BotIdentity.topicsEnabled`;
  - `sendMessage`, `sendRichMessage`, `sendWidget` принимают тему —
    `ChatRef` `{ chatId, threadId }` или `threadId` в `WidgetSend`.
- После T-0394:
  - `MessageTopic = "news" | "rewards" | "support"`,
    `OutgoingMessage.topic?`;
  - `Messenger.capabilities?: { rich, topics }`; Telegram отдаёт
    `topics: false`;
  - `bot_message_sent.topic` — `none`, `news`, `rewards`, `support`;
  - отправитель дубля пишет `topic: "none"`.
- После T-0395 и T-0396:
  - `LiveCardMessage.topic?`; `BotCardsService.send` тему не ставит;
  - `TelegramLiveCards.send` тему не передаёт («темы — WP52 № 14»).
- После T-0403 — оформленная рассылка шлёт `topic: "news"`, простая — без
  темы. Её `messageOf` сравнивается целиком в `test/broadcasts.test.ts`,
  строки 109 и 148.
- `platforms/telegram/bot-commands.ts` `handle()` — ответ на `/help` в
  `{ chatId, threadId: message.message_thread_id ?? null }`.
- `platforms/telegram/bot-fallback.ts` `handle()` — ответ в
  `{ chatId, threadId: null }`. Провайдер — `welcome.module.ts`.
- `notifications-bot/bot-notify-rules.ts` — `BotNotifyRule` без темы; после
  T-0255 и T-0256 есть ещё `wheel_ready` и `season_result`.
- `platforms/platforms.module.ts` — `messengersFor(config, telegramApi)`,
  `@Global`. `PRISMA` (`infra/database.ts`) и `REDIS` (`infra/redis.ts`) —
  глобальные.
- `wipe-plan.ts` — новая модель без строки ломает `typecheck`;
  `test/wipe-plan.test.ts` считает `keep`.

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **Prisma** — модель в конце `schema.prisma` блоком с заголовком:
   ```prisma
   /// Тема в личке с ботом (Р199, WP52): куда бот пишет новости, награды и поддержку.
   /// Тема — свойство чата площадки, а не аккаунта: ответ на /help нужен и без аккаунта
   model BotTopic {
     platform  String   @db.VarChar(16)
     chatId    String   @map("chat_id") @db.VarChar(32)
     /// `news` | `rewards` | `support`
     topic     String   @db.VarChar(16)
     threadId  Int      @map("thread_id")
     createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
     @@id([platform, chatId, topic])
     @@map("bot_topic")
   }
   ```
   - миграция `<UTC>_bot_topic` — по `tasks/README.md`, «Общие файлы», без
     базы;
   - `wipe-plan.ts` — `BotTopic: keep("темы в личке с ботом остаются в чатах игроков — бот пишет в них и после вайпа")`,
     счётчик `keep` в тесте +1;
   - `docs/21-diagrams.md` — сущность `bot_topic` в конец `erDiagram`, без
     связей.
3. **`telegram-topics.store.ts`** — `TopicStore` (интерфейс) и
   `PrismaTopicStore` через `PRISMA`, каждый вызов с таймаутом 3 с:
   - `get(chatId, topic)` → `number | null`;
   - `put(chatId, topic, threadId)` — `createMany` с `skipDuplicates`, потом
     `get`: при гонке побеждает первая запись;
   - `drop(chatId, topic)`.

   Площадка — `"telegram"` константой.
4. **`telegram-topics.ts`** — `TelegramTopics`:
   ```ts
   export const TOPIC_LOOKS: Record<MessageTopic, { name: string; color: TopicColor }> = {
     news: { name: "Новости", color: 0x6fb9f0 },
     rewards: { name: "Награды", color: 0xffd67e },
     support: { name: "Поддержка", color: 0x8eee98 },
   };
   class TelegramTopics {
     enabled(): boolean;                                   // bot.formats.enabled && bot.topics.enabled && identity.topicsEnabled
     threadFor(chatId: string, topic: MessageTopic): Promise<number | null>;
     forget(chatId: string, topic: MessageTopic): Promise<void>;
   }
   export function isThreadGone(error: TelegramApiError): boolean; // 400 и /thread not found|TOPIC_(?:DELETED|CLOSED|ID_INVALID)/i
   ```
   `threadFor`:
   1. `enabled()` ложно или `chatId` не число → `null`;
   2. Redis `bot-topic:off:<чат>` есть → `null`;
   3. есть в хранилище → его `threadId`;
   4. лок `SET bot-topic:lock:<чат>:<тема> 1 PX 10000 NX` не взят → `null`;
   5. `createForumTopic(Number(chatId), name, color)`:
      - успех → `put` → его итог;
      - `TelegramApiError` 400 → `SET bot-topic:off:<чат> 1 EX 86400` и лог
        `topic_create_refused` с кодом **один раз за процесс** → `null`;
      - прочее (429, сеть) → `null`, без отметки;
   6. лок снимается в `finally`;
   7. Redis или база упали → `null` и предупреждение не чаще раза в минуту:
      сообщение важнее темы.

   При старте, если ключ включён, а `identity.topicsEnabled` ложно, — лог
   `topics_off_in_botfather` уровнем `warn` один раз.
5. **`platforms.module.ts`** — провайдер `TelegramTopics` (зависимости:
   `SETTINGS_READER`, `BotIdentity`, `TELEGRAM_BOT_API`, `PrismaTopicStore`,
   `REDIS`) в `exports`; `messengersFor` и фабрика живых карточек получают
   его.
6. **`telegram-messenger.ts`:**
   - `capabilities` — геттер: `{ rich: true, topics: topics?.enabled() ?? false }`;
   - `send`: у `message.topic` — `threadId = await topics.threadFor(id, topic)`;
     адрес — `{ chatId: id, threadId }`, отправка та же (текст, оформленное,
     картинка);
   - ответ `400` и `isThreadGone` → `forget`, новый `threadFor`, одна
     повторная отправка. Снова отказ или темы нет → без темы;
   - без `topics` (тесты, конструктор прежней арности) — как сейчас:
     `topics` — последний необязательный параметр конструктора.
7. **`telegram-live-cards.ts`** — `send`: у `message.topic` — `threadId` тем
   же способом в `WidgetSend.threadId`; `isThreadGone` → забыть, одна
   повторная отправка, иначе без темы.
8. **Домен ставит темы:**
   - `bot-notify-rules.ts` — `BotNotifyRule` += `topic?: MessageTopic` с
     комментарием «тема в личке с ботом (Р199); нет — общий чат»; значения —
     по карте из «Решений»;
   - `bot-notify-sender.ts`:
     - `message.topic = rule.topic`;
     - `events.sent` — `topic: messenger.capabilities?.topics === true ? rule.topic ?? "none" : "none"`;
   - `bot-cards.service.ts` — `topic: "rewards"` у `LiveCardMessage` и у
     запасного сообщения; в событии — по тому же правилу;
   - `broadcast-sender.ts` `messageOf` — `topic: "news"` и у простой
     рассылки; `test/broadcasts.test.ts`, строки 109 и 148, — ожидание с
     `topic: "news"`.
9. **`bot-commands.ts`** и **`bot-fallback.ts`** — ответ в личном чате:
   - `message.message_thread_id` есть → в эту тему;
   - нет → `topics.threadFor(chatId, "support")`, `null` → общий чат;
   - `isThreadGone` → общий чат, без пересоздания: ответ не ждёт;
   - `TelegramTopics` — `@Optional()` последним параметром: тесты
     `bot-commands.test.ts` и `bot-fallback.test.ts` собирают их без правок;
   - чат команды (`isAdminChat`) — как сейчас, темы не трогаем.
10. **Настройка** — `setting-catalog.ts`, группа `BOT_MESSAGES_GROUP`:
    `botTopicsEnabled` — `{ ...feature("bot.topics.enabled", "Темы в личке бота", "«Новости», «Награды» и «Поддержка» в чате игрока с ботом. Сначала включите режим тем в BotFather. Работает, когда включены сообщения нового поколения", () => null, false), group: BOT_MESSAGES_GROUP }`.
11. **Документы:**
    - `docs/28-diagnostics.md` §6.1.2, рядом с «профиль бота — из кода» —
      абзац «Темы в личке»:
      - какие темы и что в них;
      - режим тем включается **руками в BotFather**: Bot API его не меняет;
      - без режима ключ ничего не меняет, в логе `topics_off_in_botfather`;
    - `docs/30-configuration-map.md`, строка 90 — ключи Redis
      `bot-topic:lock:*`, `bot-topic:off:<чат>` (сутки) и таблица
      `bot_topic`.

## Чего не трогаем

- Чат команды и его темы (`ChatTarget` из настроек) — без изменений.
- Порт `Messenger` и `OutgoingMessage`: поля дал T-0394.
- Приветствие `/start` и картинки бота — в общем чате.
- MAX и VK: у них тем нет, адаптеров тут нет.

## Сценарий и интерфейс

Владелец включил режим тем в BotFather и ключ `bot.topics.enabled`. Игрок:

1. Пришёл итог недели — в чате с ботом появилась тема «Награды» (жёлтая), в
   ней сообщение. Дальше карточки, напоминания и рекорды — туда же.
2. Пришла рассылка — тема «Новости» (голубая).
3. Написал `/help` в общем чате — ответ в теме «Поддержка» (зелёная).
   Написал в теме — ответ там же.
4. Удалил тему «Награды» — следующее сообщение создаёт её заново.

Состояния:
- режим тем выключен в BotFather или ключ выключен — всё в общем чате, как
  сейчас;
- Telegram не дал создать тему этому чату — сутки всё в общем чате;
- MAX и VK — без тем.

## Тесты

Первым коммитом.

- `backend/api/test/telegram-topics.test.ts` (фейки API, хранилища, Redis,
  настроек и `BotIdentity`):
  - `enabled()` — истина только при трёх условиях; каждое ложное → `false`;
  - `threadFor` нового чата → `createForumTopic(111, "Награды", 0xffd67e)`,
    `put`, ответ — `threadId`; второй вызов — из хранилища, без API;
  - лок занят → `null`, API не зван;
  - `createForumTopic` 400 → `null`, отметка `bot-topic:off:111` на сутки;
    следующий вызов — `null` без API; лог один раз на два отказа;
  - 429 → `null`, отметки нет;
  - `chatId` `dev-1` → `null`;
  - хранилище бросает → `null`.
- `backend/api/test/telegram-topics-routing.test.ts`:
  - `TelegramMessenger.send` с `topic: "news"` → `sendMessage` с
    `{ chatId, threadId }`; оформленное — `sendRichMessage` с той же темой;
  - `400 message thread not found` → `forget`, вторая отправка в новую тему;
    снова отказ → третья отправка без темы;
  - `capabilities.topics` следует за `enabled()`;
  - без `topics` в конструкторе — как до задачи;
  - `TelegramLiveCards.send` с `topic` → `sendWidget` с `threadId`;
  - `/help` в общем личном чате → ответ в тему «Поддержка»; `/help` в теме
    42 → в 42; темы выключены → `threadId: null`;
  - ответ на переписку — так же;
  - `BotNotifySender`: `season_result` → `messenger.send` с
    `topic: "rewards"`; `friend_request` — без темы; `events.sent` с
    `topic: "rewards"` только при `capabilities.topics`;
  - `BotCardsService.send` → `LiveCardMessage.topic === "rewards"`.
- `backend/api/test/telegram-topics.integration.test.ts` (Postgres):
  `put` дважды одного чата и темы → одна строка, второй `put` возвращает
  первый `threadId`; `drop` — строки нет.
- `backend/api/test/wipe-plan.test.ts` — счётчик `keep` +1.
- `backend/api/test/broadcasts.test.ts` — ожидания строк 109 и 148 с
  `topic: "news"`.
- Существующие `bot-commands.test.ts`, `bot-fallback.test.ts`,
  `messenger.test.ts` — без правок.

## Аналитика

`bot_message_sent.topic` (T-0394) — `news`, `rewards`, `support`, когда
темы включены; иначе `none`. Новых событий нет.

## Настройки и окружение

- `bot.topics.enabled` — выкл., группа «Сообщения бота».
- Ключи Redis `bot-topic:lock:<чат>:<тема>` (10 с), `bot-topic:off:<чат>`
  (сутки).
- Режим тем — в BotFather, руками.

## Документы

- `docs/28-diagnostics.md` §6.1.2 — шаг 11.
- `docs/30-configuration-map.md`, строка 90 — шаг 11.
- `docs/21-diagrams.md` — ER, шаг 2.

## Критерии приёмки

- [ ] При включённых ключах и режиме тем в BotFather сообщения уходят в
      «Новости», «Награды» и «Поддержку» по карте; остальное — в общий чат.
- [ ] Тема создаётся лениво, одна на чат и тему, и пересоздаётся один раз,
      если её удалили.
- [ ] Любая неудача с темой — сообщение уходит в общий чат, а не теряется.
- [ ] Выключенные ключи, режим тем выключен в BotFather, MAX и VK — как до
      задачи.
- [ ] Таблица `bot_topic` в миграции, плане вайпа (`keep`) и ER.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Темы в личке бота`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое [telegram]: в чате с ботом — темы «Новости», «Награды» и «Поддержка»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ТЕМЫ В ЛИЧКЕ БОТА**

  Бот раскладывает свои сообщения по темам в чате игрока: «Новости» — рассылки и «Что нового», «Награды» — итоги, карточки, напоминания и рекорды, «Поддержка» — /help, ответ на переписку и сообщения команды. Остальное — в общий чат (Р199).

  🛠 **Что внутри**

  • тема создаётся при первом сообщении в неё; удалённую игроком — заново, один раз
  • любая неудача с темой — сообщение уходит в общий чат
  • таблица bot_topic: тема — свойство чата, после вайпа остаётся

  ⚙️ **Настройки**

  • панель → «Сообщения бота»: bot.topics.enabled (выкл.; работает при включённом bot.formats.enabled)

  ❓ **Нужно от команды**

  • @владелец — включить режим тем у бота в BotFather, затем ключ bot.topics.enabled на деве и посмотреть темы
  ```
