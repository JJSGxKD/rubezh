---
id: T-0400
title: Приглашение и «Поделиться» итогом — оформленным сообщением с подарком новичку
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0394, T-0253]
zones:
  - backend/api/src/platforms/telegram/telegram-message-preparer.ts
  - backend/api/src/modules/friends/invite-rich.ts
  - backend/api/test/prepared-rich-message.test.ts
shared:
  - backend/api/src/platforms/ports/prepared-message.ts
  - backend/api/src/platforms/telegram/telegram-bot-api.ts
  - backend/api/src/modules/friends/friend-invite.service.ts
  - backend/api/src/modules/friends/friends.module.ts
  - backend/api/src/platforms/platforms.module.ts
  - docs/24-attribution-and-sharing.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: null
batch: 5
---

# T-0400. Приглашение и «Поделиться» итогом — оформленным сообщением с подарком новичку

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0400.json)](README.md#значки-статуса) [![T-0394](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0394.json&label=T-0394)](T-0394-rich-message-port.md) [![T-0253](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0253.json&label=T-0253)](T-0253-invite-and-run-share-cards.md)

## Зачем

Приглашение друга и «Поделиться» на итогах (T-0253) уходят текстом с
картинкой-предпросмотром. Р199 делает их оформленным сообщением:
- заголовок «{Имя} зовёт на рубеж»;
- у итога — «Мой рубеж — 7:42»;
- список с подарком новичку «тебе — 100 монет сразу»;
- кнопка «▶ Играть» по ссылке дружбы.

Так приглашение читается с первого взгляда и говорит, что получит друг.

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52):
  - сценарий «Приглашение и „Поделиться“ итогом» — друг получает
    оформленное приглашение: картинка T-0253, «Мой рубеж — 7:42», «тебе —
    100 монет сразу», кнопка «▶ Играть»;
  - Telegram — `savePreparedInlineMessage` с `InputRichMessageContent`;
  - на площадках без бота — как сейчас (`24-attribution-and-sharing.md`
    §7.7);
  - аналитика — `share_offered`, `share_completed`, `referral_bound` без
    изменений;
  - ключ — `bot.rich.enabled` (и общий `bot.formats.enabled`).
- **Правило 8:** только настоящие числа — время забега и
  `REFERRAL_RULES.welcomeCoins`. Подарок ноль — строки о подарке нет.
- **Р63:** сообщение отправляет игрок, бот его только готовит.
- **Ограничение Bot API.** В `InputRichMessageContent` годятся только уже
  загруженные в Telegram файлы (`file_id`), а картинка приглашения T-0252 и
  T-0253 — PNG по публичному адресу, её `file_id` обычно неизвестен (кэш
  `file_id` T-0252 пополняется только отправкой фото).
- **Решение тимлида (подтвердить владельцу).** Картинка важнее оформления:
  - `file_id` картинки известен из кэша T-0252 → оформленное сообщение с
    фото;
  - неизвестен → **прежнее сообщение T-0253** (текст и большой
    предпросмотр картинки), без оформления.

  Загружать каждую картинку приглашения в Telegram ради `file_id` (например,
  в служебный чат) задача не будет: это сообщения в чате команды на каждое
  приглашение — отдельное решение владельца.

## Как сейчас

- `modules/friends/friend-invite.service.ts`:
  - `inviteMessage(url)` → `PreparedMessageInput` (`title`, `description`,
    `text`, `button`);
  - `preparedMessage(actor)` → `MessagePreparers.for(platform).prepare`, срок
    5 с;
  - после T-0253 — ещё `runId` (итог забега), имя пригласившего и `imageUrl`
    картинки.
- `platforms/ports/prepared-message.ts` — `PreparedMessageInput`; после
  T-0252 — необязательное `imageUrl`.
- `platforms/telegram/telegram-message-preparer.ts` →
  `TelegramBotApi.savePreparedInlineMessage(userId, article)`
  (`telegram-bot-api.ts`, строки 421–439). Статья с `input_message_content: { message_text }`,
  после T-0252 — с `link_preview_options`.
- Кэш `file_id` картинок — `common/card/card-cache.ts` (T-0252), ключ — хэш
  видимого и версия шаблона. **Сверь его API после T-0252**; если по
  `imageUrl` `file_id` не найти, это вопрос в PR, а не догадка.
- После T-0394:
  - `RichDocument` и `plainTextOf` — `platforms/ports/rich-message.ts`;
  - перевод в блоки Telegram — `telegram-rich-render.ts` `toTelegramRich`;
  - `BotMessages.compose(doc, base)` кладёт `rich` только при включённых
    `bot.formats.enabled` и `bot.rich.enabled` и годном документе.
- `referrals/referral-rules.ts` — `REFERRAL_RULES.welcomeCoins` (100).

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **`platforms/ports/prepared-message.ts`** — `PreparedMessageInput` +=
   `rich?: RichDocument`. `text` остаётся всегда: он — запас и для площадок
   без оформления.
3. **`modules/friends/invite-rich.ts`** — чистая функция
   `inviteRich(input: { name: string; survivalSec: number | null; welcomeCoins: number; imageUrl: string | null }): RichDocument`:
   - фото `{ url: imageUrl }` первым блоком, если адрес есть;
   - заголовок — `${name} зовёт на рубеж`;
   - у итога (`survivalSec` не `null`) — абзац с жирным `Мой рубеж — м:сс`;
   - список:
     - `тебе — ${welcomeCoins} монет сразу` — только при `welcomeCoins > 0`,
       слово «монета» по числу;
     - «забеги на несколько минут, прокачка и рейтинг»;
   - абзац «Открой игру по кнопке — и мы сразу станем друзьями».
   Без рода: «зовёт», не «позвал».
4. **`friend-invite.service.ts`** (`friends.module.ts` импортирует
   `BotMessagesModule`) — в подготовке:
   `rich = BotMessages.compose(inviteRich({ … }), { button }).rich` —
   выключатели и проверку документа решает `compose`. Имя, время забега и
   `imageUrl` — те же, что идут на картинку T-0253.
5. **`telegram-bot-api.ts`** — `PreparedArticle` += `rich?: TelegramRichMessage`.
   Есть `rich` → `input_message_content: { rich_message: rich }` и без
   `link_preview_options`.
6. **`telegram-message-preparer.ts`:**
   - `rich` нет → как сейчас;
   - `rich` есть → фото-блок с `url` заменяется на `file_id` из кэша T-0252:
     - нашёлся → статья с `rich` (`toTelegramRich`);
     - не нашёлся → прежняя статья T-0253 (текст и предпросмотр) —
       решение тимлида выше;
   - отказ Telegram на оформленной статье (400) → вторая попытка прежней
     статьёй и лог `prepared_rich_fallback` один раз за процесс;
   - кэш `file_id` подготовка Telegram получает в `platforms.module.ts`
     (`messagePreparersFor`).
7. **`docs/24-attribution-and-sharing.md`** §7.7 — одна строка: при
   включённых `bot.formats.enabled` и `bot.rich.enabled` и известном
   `file_id` картинки приглашение уходит оформленным сообщением, иначе —
   как раньше.

## Чего не трогаем

- Ссылку дружбы, реферальные правила и атрибуцию (Р48).
- Картинки приглашения и итога, `runId` в подготовке, клиент `run-share.ts`
  — T-0253.
- События `share_offered`, `share_completed` — без изменений.
- Кэш `file_id` (`card-cache.ts`) — только читать.

## Сценарий и интерфейс

Игрок нажимает «Позвать друга» или «Поделиться» на итогах, выбирает чат —
как сейчас. Друг видит:
- **с оформлением** (ключи включены, `file_id` картинки известен):
  - картинка T-0253, заголовок «Мирон зовёт на рубеж»;
  - у итога — «**Мой рубеж — 7:42**»;
  - список «тебе — 100 монет сразу», «забеги на несколько минут, прокачка
    и рейтинг»;
  - «Открой игру по кнопке — и мы сразу станем друзьями», кнопка «▶ Играть»;
- **без оформления** — сообщение T-0253 без изменений.

## Тесты

Первым коммитом.

- `backend/api/test/prepared-rich-message.test.ts`:
  - `inviteRich` с именем и `survivalSec: 462` → `plainTextOf` равен ровно
    ожидаемой строке с «Мирон зовёт на рубеж», «Мой рубеж — 7:42», «тебе —
    100 монет сразу»;
  - без `survivalSec` строки «Мой рубеж» нет;
  - `welcomeCoins: 0` → строки о подарке нет; `welcomeCoins: 1` → «1 монету»;
  - `richProblems(inviteRich(…))` пуст;
  - сервис:
    - выключен `bot.rich.enabled` → подготовка без `rich`, как в T-0253;
    - включён → в порт ушёл `rich`;
  - Telegram-подготовка (фейк API и кэша `file_id`):
    - `file_id` есть → статья с `input_message_content.rich_message`, фото-блок
      с `file_id`, без `link_preview_options`;
    - `file_id` нет → прежняя статья с `message_text` и `link_preview_options`;
    - 400 на оформленной → вторая попытка прежней статьёй, лог один раз;
    - без `rich` — тело запроса как до задачи.
- Существующие тесты приглашения и T-0253 проходят без правок.

## Аналитика

Нет новых событий: `share_offered`, `share_completed`, `referral_bound` — как
были. Доля оформленных видна по логу `prepared_rich_fallback` и в задаче не
считается.

## Настройки и окружение

Нет новых ключей: работает под `bot.formats.enabled` и `bot.rich.enabled`
(T-0394).

## Документы

- `docs/24-attribution-and-sharing.md` §7.7 — шаг 7.

## Критерии приёмки

- [ ] При включённых ключах и известном `file_id` картинки приглашение и
      «Поделиться» итогом уходят оформленным сообщением с картинкой,
      заголовком, «Мой рубеж — м:сс» у итога, подарком из `REFERRAL_RULES` и
      кнопкой «▶ Играть» по ссылке дружбы.
- [ ] Без `file_id`, при выключенных ключах и при отказе Telegram — прежнее
      сообщение T-0253.
- [ ] Чисел, кроме времени забега и `welcomeCoins`, в сообщении нет.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(friends): Приглашение и «Поделиться» оформленным сообщением`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое [telegram]: приглашение друга и «Поделиться» итогом приходят оформленным сообщением — с твоим временем и подарком новичку`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОФОРМЛЕННОЕ ПРИГЛАШЕНИЕ**

  Приглашение друга и «Поделиться» итогом умеют уходить оформленным сообщением Telegram: картинка, «{Имя} зовёт на рубеж», «Мой рубеж — 7:42», «тебе — 100 монет сразу», кнопка «▶ Играть» (Р199).

  🛠 **Что внутри**

  • оформление — только когда Telegram уже знает картинку (file_id): в оформленное сообщение по ссылке картинку не вставить
  • иначе, при выключенных ключах и при отказе Telegram — прежнее сообщение с большим предпросмотром

  ❓ **Нужно от команды**

  • @владелец — решить, нужна ли загрузка картинок приглашений в Telegram ради оформления (сейчас оформленное уходит только с уже известной картинкой)
  ```
