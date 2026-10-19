---
id: T-0159
title: Юзернейм бота в имени и bio — порт площадки BotMentions и getChat у Telegram
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/platforms/ports/bot-mention.ts
  - backend/api/src/platforms/telegram/telegram-bot-mention.ts
  - backend/api/src/platforms/telegram/telegram-bot-api.ts
  - backend/api/src/platforms/platforms.module.ts
  - backend/api/test/telegram-bot-mention.test.ts
shared: []
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0159. Юзернейм бота в имени и bio — порт площадки BotMentions и getChat у Telegram

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0159.json)](README.md#значки-статуса)

## Зачем

Р110 (`docs/35-stage4-plan.md`): игрок вписывает юзернейм бота игры в своё имя
на площадке и, отдельно, в bio, а сервер каждые игровые сутки проверяет, что он
на месте, и платит за сутки. Эта задача — первая из трёх: порт площадки
`BotMentions` и его реализация для Telegram (метод `getChat`). Модуль с
таблицей, проверкой, наградой и ночным проходом — T-0162, экран — T-0160.

## Решения

- **Р110** (19.10.2026, `docs/35-stage4-plan.md`): проверка идёт через порт
  площадки (у Telegram — данные чата пользователя у бота, `getChat`); у
  площадок без такой возможности заданий нет. Bio скрыто настройкой
  приватности — задание говорит, что проверить нельзя.
- **Платформенная нейтральность** (Р22, `docs/35-stage4-plan.md` §3.11): домен
  просит порт `BotMentions`, Telegram знает только его адаптер.
- **Р111**: из показываемого ника юзернейм бота вырезается. Это не мешает
  проверке: она читает имя, пришедшее от площадки, а не `Account.displayName`.
- Решение claude-lead-1 от 19.10.2026: «юзернейм стоит» — это `@юзернейм` бота
  без учёта регистра, с границами слова; без `@` не считается (так он же
  вырезается из показываемого ника по Р111).
- Решение claude-lead-1 от 19.10.2026: пустое и закрытое bio неразличимы — один
  исход `hidden` и одна фраза для игрока (фраза — в T-0160). Поля `getChat`
  исполнитель сверяет с документацией Bot API до кода.
- Уточнения `claude-lead2-1` по записанным решениям (механика, не продукт):
  - **Одна проверка на аккаунт, а не на задание**: имя и bio приходят одним
    `getChat`, поэтому порт принимает список видов, а не один.
  - **Текст имени и bio нигде не сохраняется и не пишется в лог** — только
    итог проверки.
- Задача выделена из прежней T-0159 вместе с T-0162 (решение claude-lead-1 от
  19.10.2026): здесь порт и адаптер Telegram, там модуль на сервере.

## Как сейчас

- `backend/api/src/platforms/ports/channel-membership.ts:1–47` — образец порта
  проверки через бота: интерфейс, класс-реестр `ChannelMemberships.for(platform)`.
  Адаптер — `platforms/telegram/telegram-channel-membership.ts:1–52`; сборка и
  экспорт — `platforms/platforms.module.ts:41–44, 66–78` (`@Global()`).
- `backend/api/src/platforms/ports/messenger.ts:19–40` — образец порта с темпом:
  поле `ratePerSec` и исходы `retry`/`blocked`/`failed`. Темп Telegram — 25 в
  секунду (`telegram-messenger.ts:26`), коды ошибок в исходы переводит
  `telegram-messenger.ts:28–50`.
- `backend/api/src/platforms/telegram/telegram-bot-api.ts:444–448` —
  `getChatMember` (образец метода: `this.call(…)`, ответ парсится Zod);
  `getChat` в клиенте нет. Ошибки — `TelegramApiError` с `errorCode` и
  `retryAfterSec` (строки 74–85).
- `backend/api/src/platforms/telegram/bot-identity.ts:30–32` — `username`
  бота (из `getMe` на старте); `null`, пока не узнали или бот выключен.
- `Account.platformUserId` (`prisma/schema.prisma:165`) — id игрока на площадке
  (у Telegram — число; у аккаунта разработчика `dev-…`).

Чего не хватает: порта проверки и метода `getChat`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Порт `platforms/ports/bot-mention.ts`:**

   ```ts
   export type MentionKind = "name" | "bio";
   export type MentionFinding = "present" | "absent" | "hidden";

   export type MentionOutcome =
     | { status: "checked"; findings: Partial<Record<MentionKind, MentionFinding>> }
     /** площадка просит подождать или связь сбойнула: повторить не раньше, чем через `afterSec` */
     | { status: "retry"; afterSec: number }
     /** проверить нельзя и повтор не поможет: нет чата с игроком, это не аккаунт площадки, имя бота неизвестно */
     | { status: "unavailable"; reason: string };

   export interface BotMention {
     readonly platform: PlatformId;
     /** бот настроен и имя его известно */
     readonly configured: boolean;
     /** сколько проверок в секунду площадка принимает от бота */
     readonly ratePerSec: number;
     /** юзернейм бота игры без «@»; `null` — не известен */
     botUsername(): string | null;
     /** один запрос площадки на все `kinds`; в `findings` — только запрошенные виды */
     check(platformUserId: string, kinds: readonly MentionKind[]): Promise<MentionOutcome>;
   }

   export class BotMentions {
     for(platform: PlatformId): BotMention | null; // только настроенные
   }

   /** Есть ли в тексте `@<username>` с границами (раздел «Решения»). */
   export function containsMention(text: string, username: string): boolean;
   ```

   `containsMention`: без учёта регистра; перед `@` и после имени нет символа
   `[A-Za-z0-9_]`; пустой текст или пустое имя — `false`. Регулярное выражение
   строится с экранированием имени; имя длиннее 64 знаков — `false` (границы
   Telegram, защита от раздувания выражения).
3. **`TelegramBotApi.getChat(chatId: number, signal?)`** в
   `telegram-bot-api.ts`, рядом с `getChatMember`: `this.call("getChat",
   REQUEST_TIMEOUT_MS, …)`, ответ разбирается схемой
   `z.object({ id: z.number().int(), type: z.string(), first_name: z.string().max(256).optional(),
   last_name: z.string().max(256).optional(), bio: z.string().max(512).optional() })`;
   возвращает `{ firstName, lastName, bio }` с `null` вместо отсутствующих.
   Сверить поля с документацией Bot API (`ChatFullInfo`) до кода: если `bio`
   приходит иначе, остановиться и задать вопрос (раздел «Если что-то неясно» в
   `tasks/README.md`).
4. **Адаптер `platforms/telegram/telegram-bot-mention.ts`** — `TelegramBotMention
   implements BotMention`, `platform = "telegram"`, `ratePerSec = 25` (как
   у `TelegramMessenger`; общий лимит бота делят рассылки и проверки, поэтому
   ночной проход T-0162 берёт только половину).
   Конструктор: `api: Pick<TelegramBotApi, "getChat">`, `username: () => string | null`,
   `enabled: boolean`; `configured = enabled && username() !== null`.
   `check`:
   - `platformUserId` не `^\d{1,20}$` → `{ status: "unavailable", reason: "not_platform_account" }`;
   - `username()` пуст → `unavailable`, `bot_unknown`;
   - один вызов `getChat(Number(id))`; `name` — текст `"${firstName} ${lastName}"`
     через `containsMention`: `present` / `absent`; `bio`: поле нет →
     `hidden`, иначе `present` / `absent`;
   - `TelegramApiError`: `429` → `retry` с `retryAfterSec ?? 5`; код `0` или
     `>= 500` → `retry` 5 с; `400` и `403` → `unavailable` с кодом в `reason`;
     прочие коды — `unavailable`. Не `TelegramApiError` — пробросить.
5. **Сборка в `platforms.module.ts`:** `botMentionsFor(config, telegramApi,
   identity)` → `new BotMentions([new TelegramBotMention(telegramApi, () => identity.username,
   config.telegram.botToken !== "")])`, провайдер и экспорт `BotMentions`.
   `BotIdentity` уже в модуле платформ — проверить, что он доступен фабрике.

## Чего не трогаем

- Таблицу состояния, миграцию, ключи настроек, награду, серию, ночной проход,
  ручную проверку, маршруты — T-0162.
- Экран и тексты для игрока, события аналитики и их словарь — T-0160.
- Очистка ника от упоминаний (Р111) — `auth/display-name.ts`, другая задача.
- Рассылки (`broadcast-sender.ts`) и их темп.
- Площадки MAX и VK: у них порта нет, заданий нет (Р110).

## Тесты

Пишутся первым коммитом. Юзернейм бота в тестах — вымышленный, `game_bot`.

- `telegram-bot-mention.test.ts` (подмена API):
  - `containsMention`: «Иван @game_bot» → да; «Иван @GAME_BOT» → да;
    «@game_bot2» → нет; «@game_bot_x» → нет; «Иван game_bot» без `@` → нет;
    «mail@game_bot» → нет; «@game_bot.» → да; пустой текст → нет;
  - имя в `last_name` («Иван» / «@game_bot») → `name: present`; нет → `absent`;
  - `bio` нет в ответе → `hidden`; есть без юзернейма → `absent`; с ним →
    `present`;
  - запрошено только `["name"]` — в `findings` нет `bio`; запрошено оба — один
    вызов `getChat`;
  - `429` с `retry_after: 7` → `retry`, `afterSec: 7`; код `0` и `502` → `retry`,
    5; `400 chat not found` и `403` → `unavailable`;
  - `platformUserId = "dev-abc"` → `unavailable`, `not_platform_account`, вызова
    API нет; имя бота неизвестно → `unavailable`, `bot_unknown`.
- `scripts/test/layer-boundaries.test.ts` остаётся зелёным: домен не
  импортирует Telegram и grammY.

## Аналитика

Нет: порт события не порождает. Факты суток — T-0162, события клиента — T-0160.

## Настройки и окружение

Нет. Токен бота и имя бота — уже существующие `TELEGRAM_BOT_TOKEN` и `getMe` на
старте. Ключи настроек — T-0162.

## Документы

Нет: порт — внутренность бэкенда, документы (`docs/30`, `docs/21`) обновляет
T-0162.

## Критерии приёмки

- [ ] Порт `BotMentions` в `platforms/ports/`, домен не импортирует Telegram и
  grammY; `scripts/test/layer-boundaries.test.ts` зелёный.
- [ ] Один вызов `getChat` на проверку, оба вида вместе.
- [ ] Закрытое и пустое bio дают один исход `hidden`, не `absent`.
- [ ] Ошибки `getChat` переводятся в `retry` и `unavailable` по шагу 4.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(platforms): Порт проверки юзернейма бота и getChat`
- **Метка:** `release: minor`
- **Для игроков:** нет — задания появятся с модулем (T-0162) и экраном (T-0160)
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОРТ ПРОВЕРКИ ЮЗЕРНЕЙМА БОТА**

  Площадки получили порт, через который сервер сможет проверять, что юзернейм бота стоит в имени или bio игрока. У Telegram он работает через getChat, одним запросом на оба вида. Игрокам пока ничего не видно: модуль с наградой — следующая задача.
  ```
