---
id: T-0400
title: Приглашение и «Поделиться» итогом — оформленным сообщением с подарком новичку
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
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
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/24-attribution-and-sharing.md
  - docs/30-configuration-map.md
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
- **Решение владельца 10.11.2026 — картинку загружаем один раз.** Нет
  `file_id` картинки приглашения или итога → бот **один раз** загружает её
  в служебный чат, запоминает `file_id` в кэше T-0252 и дальше шлёт по
  нему. Сменилась картинка — загружает заново. Так оформленное сообщение
  уходит с картинкой всегда, а не только когда Telegram её уже видел.
- **Решения тимлида claude-lead-1 к решению владельца, 10.11.2026:**
  - **служебный чат — новый поток уведомлений `notify.chat.media`**
    («Картинки бота»), по правилу потоков: свой ключ `notify.chat.<поток>`
    в каталоге настроек, переменной окружения нет, **пусто — общий чат**
    (`notify.chat.general`), формат `id чата:тема`. Свой поток, а не
    существующий: картинки — не уведомление ни одного из потоков, и
    владелец может увести их в отдельную тему или чат;
  - **сообщение с картинкой сразу удаляется** (`deleteMessage`): `file_id`
    после удаления действует, а в чате команды не копятся сотни картинок,
    даже когда поток пуст и загрузка идёт в общий чат. Загрузка — без
    звука. Удалить не вышло — строка лога, приглашение это не ломает;
  - **ключ кэша — путь адреса картинки** (`/api/v1/cards/<хэш>.png`, T-0252):
    в нём хэш содержимого, поэтому новая картинка — новый ключ и новая
    загрузка («при смене картинки — заново» выходит само). Домен в ключ не
    входит: смена адреса раздачи не заставит грузить всё заново;
  - **загружаем по адресу**, а не байтами: `sendPhoto` с публичным адресом
    T-0252 — Telegram сам забирает PNG, бэкенду не нужно читать
    `card-store`;
  - **срок** — в пределах прежних 5 с подготовки: загрузка идёт тем же
    сигналом. Не успели, ошибка, нет ни потока, ни общего чата →
    **прежнее сообщение T-0253** (текст и большой предпросмотр), как и при
    выключенных ключах;
  - **протухший `file_id`** (400 на оформленной статье) → запись кэша
    стирается, приглашение уходит прежней статьёй; следующее загрузит
    картинку заново;
  - два одновременных приглашения с новой картинкой могут загрузить её
    дважды — лока нет сознательно: оба `file_id` годны, лишняя загрузка
    дешевле лока на пути игрока.

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
- Кэш `file_id` картинок — `common/card/card-cache.ts` (T-0252, обобщён из
  `welcome.command.ts:30–90`: Redis, `get(key)` / `set(key, fileId)` со
  сроком). Здесь ключ — путь адреса картинки (решения выше). Если после
  T-0252 у кэша нет записи и удаления по произвольному ключу — вопрос в
  PR, а не догадка.
- `telegram-bot-api.ts`:
  - `sendPhoto(chat, photo: Buffer | string, caption, signal?, options?)`
    (строка 313) принимает и адрес, отдаёт `{ messageId, fileId }`;
  - `SendOptions.silent` добавляет T-0393;
  - `deleteMessage` нет.
- Потоки уведомлений — `settings/setting-catalog.ts` (`chat(...)`, строки
  200–232); чтение потока без переменной окружения — образец
  `reminders/reminders.report.ts:53`
  (`parseChatTarget(settings.get(SETTINGS.chatReminders)) ?? …general`).
  `platforms.module.ts` уже получает `SETTINGS_READER` (строка 78).
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
5. **`telegram-bot-api.ts`:**
   - `PreparedArticle` += `rich?: TelegramRichMessage`. Есть `rich` →
     `input_message_content: { rich_message: rich }` и без
     `link_preview_options`;
   - новый `deleteMessage(chat: ChatRef, messageId: number, signal?: AbortSignal): Promise<void>`
     — вызов `deleteMessage` через `this.call`, срок `REQUEST_TIMEOUT_MS`,
     как у `editMessageText`.
6. **`setting-catalog.ts`** — строкой в `SETTINGS` после `chatReminders`:
   ```ts
   // Переменной окружения нет: адрес задаётся только в панели (пусто — общий чат).
   chatMedia: chat(
     "notify.chat.media",
     "Картинки бота",
     "Сюда бот один раз загружает новую картинку приглашения, чтобы Telegram её запомнил, и сразу удаляет сообщение. Пусто — общий чат",
     () => "",
   ),
   ```
7. **`telegram-message-preparer.ts`** — конструктор получает кэш `file_id`
   (`card-cache.ts`) и `SettingsReader`; `platforms.module.ts`
   (`messagePreparersFor`) передаёт их, `inject` += `SETTINGS_READER` и
   провайдер кэша T-0252. Подготовка:
   - `rich` нет → как сейчас;
   - `rich` есть, фото-блока нет → статья с `rich` (`toTelegramRich`);
   - `rich` есть, фото-блок с `url`:
     1. ключ — `pathname` адреса (`new URL(url).pathname`);
     2. `file_id` в кэше есть → фото-блок с ним, статья с `rich`;
     3. нет → загрузка:
        - чат — `parseChatTarget(settings.get(SETTINGS.chatMedia)) ?? parseChatTarget(settings.get(SETTINGS.chatGeneral))`;
          оба пусты → прежняя статья T-0253;
        - `api.sendPhoto(chat, url, "", signal, { silent: true })` тем же
          сигналом подготовки;
        - `fileId` пришёл → `cache.set(ключ, fileId)`, затем
          `api.deleteMessage(chat, messageId, signal)`; ошибка удаления —
          лог `invite_image_delete_failed` (уровень `warn`), подготовка
          идёт дальше;
        - фото-блок с `fileId`, статья с `rich`;
        - ошибка или срок загрузки, `fileId: null` → прежняя статья T-0253
          и лог `invite_image_upload_failed` один раз за процесс;
   - отказ Telegram на оформленной статье (400) → запись кэша по ключу
     стирается (протухший `file_id`), вторая попытка прежней статьёй и лог
     `prepared_rich_fallback` один раз за процесс.
8. **`docs/24-attribution-and-sharing.md`** §7.7 — абзац: при включённых
   `bot.formats.enabled` и `bot.rich.enabled` приглашение уходит
   оформленным сообщением с картинкой; новую картинку бот один раз
   загружает в поток «Картинки бота» (`notify.chat.media`, пусто — общий
   чат) и сразу удаляет сообщение; не вышло — как раньше.
9. **`docs/30-configuration-map.md`** — строкой по образцу
   `notify.chat.ops`: поток «Картинки бота» — `notify.chat.media`, пусто —
   общий чат, переменной окружения нет; что делает — одна загрузка новой
   картинки приглашения с немедленным удалением.

## Чего не трогаем

- Ссылку дружбы, реферальные правила и атрибуцию (Р48).
- Картинки приглашения и итога, `runId` в подготовке, клиент `run-share.ts`
  — T-0253.
- События `share_offered`, `share_completed` — без изменений.
- Кэш `file_id` (`card-cache.ts`) — только пользоваться его API, не
  менять.
- Прочие потоки `notify.chat.*` и `NotifyTargets` — новый поток читается
  на месте, как `notify.chat.reminders`.

## Сценарий и интерфейс

Игрок нажимает «Позвать друга» или «Поделиться» на итогах, выбирает чат —
как сейчас. Друг видит:
- **с оформлением** (ключи включены; картинка известна Telegram или бот
  только что загрузил её в поток «Картинки бота»):
  - картинка T-0253, заголовок «Мирон зовёт на рубеж»;
  - у итога — «**Мой рубеж — 7:42**»;
  - список «тебе — 100 монет сразу», «забеги на несколько минут, прокачка
    и рейтинг»;
  - «Открой игру по кнопке — и мы сразу станем друзьями», кнопка «▶ Играть»;
- **без оформления** (ключи выключены, загрузка не удалась или не успела,
  нет ни потока, ни общего чата) — сообщение T-0253 без изменений.

Команда в потоке «Картинки бота» (или в общем чате) ничего не видит: бот
загружает картинку без звука и тут же удаляет сообщение.

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
    - `file_id` нет, `notify.chat.media` = `-1001:7` → `sendPhoto` в
      `{ chatId: "-1001", threadId: 7 }` с адресом картинки и
      `disable_notification: true`; в кэш записан пришедший `file_id` по
      ключу `/api/v1/cards/<хэш>.png`; `deleteMessage` с тем же
      `message_id`; статья с `rich_message` и этим `file_id`;
    - второе приглашение с той же картинкой → `sendPhoto` не зван;
    - картинка с другим хэшем → новая загрузка;
    - `notify.chat.media` пуст → загрузка в `notify.chat.general`;
      пусты оба → `sendPhoto` не зван, прежняя статья;
    - `sendPhoto` бросает или истёк сигнал → прежняя статья с
      `message_text` и `link_preview_options`, лог
      `invite_image_upload_failed` один раз на два вызова;
    - `deleteMessage` бросает → статья всё равно оформленная, лог
      `invite_image_delete_failed`;
    - 400 на оформленной → запись кэша стёрта, вторая попытка прежней
      статьёй, лог один раз;
    - без `rich` — тело запроса как до задачи.
- Существующие тесты приглашения и T-0253 проходят без правок.

## Аналитика

Нет новых событий: `share_offered`, `share_completed`, `referral_bound` — как
были. Доля оформленных видна по логам `prepared_rich_fallback` и
`invite_image_upload_failed` и в задаче не считается.

## Настройки и окружение

- Работает под `bot.formats.enabled` и `bot.rich.enabled` (T-0394).
- Новый ключ `notify.chat.media` — группа уведомлений команде, пусто —
  общий чат, переменной окружения нет (шаг 6).

## Документы

- `docs/24-attribution-and-sharing.md` §7.7 — шаг 8.
- `docs/30-configuration-map.md` — шаг 9.

## Критерии приёмки

- [ ] При включённых ключах приглашение и «Поделиться» итогом уходят
      оформленным сообщением с картинкой, заголовком, «Мой рубеж — м:сс» у
      итога, подарком из `REFERRAL_RULES` и кнопкой «▶ Играть» по ссылке
      дружбы.
- [ ] Новая картинка загружается в `notify.chat.media` (пусто — общий чат)
      один раз, без звука, сообщение сразу удаляется; повтор той же
      картинки идёт по `file_id` из кэша без загрузки; другая картинка —
      новая загрузка.
- [ ] Загрузка не удалась или не успела в 5 с, нет чата, выключены ключи,
      отказ Telegram — прежнее сообщение T-0253; при отказе на `file_id`
      запись кэша стирается.
- [ ] `notify.chat.media` есть в каталоге настроек без переменной
      окружения и в `docs/30-configuration-map.md`.
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

  • в оформленное сообщение картинку по ссылке не вставить, поэтому новую картинку бот один раз загружает в поток «Картинки бота» без звука, запоминает file_id и сразу удаляет сообщение
  • не вышло, при выключенных ключах и при отказе Telegram — прежнее сообщение с большим предпросмотром

  ⚙️ **Настройки**

  • панель → «Уведомления команде»: notify.chat.media — «Картинки бота» (пусто — общий чат)

  ❓ **Нужно от команды**

  • @владелец — по желанию задать notify.chat.media отдельной темой; без него загрузки идут в общий чат и тут же удаляются
  ```
