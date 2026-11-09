---
id: T-0407
title: Эфемерные ответы в чате команды — /help, меню выгрузки и отказы видит только спросивший
epic: E5
priority: P3
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0393, T-0394]
zones:
  - backend/api/src/platforms/telegram/team-ephemeral.ts
  - backend/api/src/modules/export/export-bot.command.ts
  - backend/api/src/modules/feedback/feedback-bot.command.ts
  - backend/api/test/team-ephemeral.test.ts
  - backend/api/test/export-bot.test.ts
shared:
  - backend/api/src/platforms/telegram/telegram-bot-api.ts
  - backend/api/src/platforms/telegram/bot-router.ts
  - backend/api/src/platforms/telegram/bot-commands.ts
  - backend/api/src/platforms/telegram/bot.module.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - docs/28-diagnostics.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: null
batch: 5
---

# T-0407. Эфемерные ответы в чате команды — /help, меню выгрузки и отказы видит только спросивший

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0407.json)](README.md#значки-статуса) [![T-0393](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0393.json&label=T-0393)](T-0393-bot-api-v10-layer.md) [![T-0394](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0394.json&label=T-0394)](T-0394-rich-message-port.md)

## Зачем

В чате команды бот отвечает всем участникам. Каждый `/help` — длинная
справка в общей ленте. `/export` там вместо меню пишет отказ, который тоже
видят все. Bot API 10.2–10.4 даёт эфемерные сообщения: их видят только
адресат и бот. После задачи в чате команды:
- `/help` и отказы получает только спросивший;
- `/export` показывает меню выгрузки только нажавшему;
- архив приходит в личку, как раньше.

Чат команды — инструмент, только Telegram, порт не нужен (Р199, §3.11).

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52, строка «Чат команды» таблицы
  сценариев, правила 5 и 9):
  - эфемерным идёт только то, что не жалко потерять: справка, меню, отказы.
    Доставку эфемерных Telegram не обещает;
  - ключ `bot.team-ephemeral.enabled` — умолчание **вкл.**; действует, только
    когда включён `bot.formats.enabled`. Выключен любой — всё как до задачи;
  - аналитика — строки лога, событий нет.
- **Указания тимлида к плану WP52 (№ 15):**
  - `/help` в чате команды — эфемерно спросившему, `is_ephemeral` в меню
    команд этого чата;
  - `/export` в чате команды:
    - меню — эфемерно;
    - нажатие — эфемерный ответ «Готовлю выгрузку — пришлю в личку»;
    - статус и архив — в личку, как сейчас;
    - нет права — эфемерный отказ;
  - `/stats` остаётся публичным: сводка нужна всей команде.
    `daily-stats.reporter.ts` не трогаем: он в общих файлах T-0257.
- **Решения тимлида (технические):**
  - **логика — в одном месте адаптера.** Новый `TeamEphemeral`
    (`platforms/telegram/team-ephemeral.ts`) знает:
    - чаты команды — список переезжает туда из `BotCommands`;
    - выключатели;
    - как ответить эфемерно и что делать при отказе.

    Модули `export` и `feedback` — исключения теста границ слоёв
    (`TEAM_TOOLS` в `scripts/test/layer-boundaries.test.ts`). Импорт из
    `platforms/telegram` им разрешён, новых исключений нет;
  - **как Telegram принимает эфемерный ответ** (`core.telegram.org/bots/api`,
    «Ephemeral Messages and Commands»):
    - на эфемерную команду — с `reply_parameters.ephemeral_message_id`
      входящего, в течение 15 секунд;
    - на нажатие — с `callback_query_id`, в течение 15 секунд;
    - на обычную команду — только если бот администратор чата.

    `receiver_user_id` передаём всегда — так решил T-0393;
  - **отказ площадки — прежний вид.** Ответ `400` или `403` на эфемерную
    отправку → тот же ответ, что до задачи (публичный текст или
    всплывающая подсказка нажатия). Строка лога `team_ephemeral_refused` —
    один раз за процесс. Остальные ошибки бросаются, как сейчас: задание
    очереди повторит;
  - **отказ без права — только в чате команды.** Там меню команд
    администратора видят все участники (`BotCommands.publish`), так что
    эфемерный отказ ничего не раскрывает. В остальных чатах — молчание, как
    сейчас (`docs/28-diagnostics.md` §6.1.4);
  - **данные — только в личку.** Нажатие в чате команды допускается, но
    статус и архив уходят в личный чат нажавшего (`chatId = adminId`), как
    и раньше. Личного чата с ботом нет (`403`) → лок снимается, эфемерный
    ответ «Откройте личный чат с ботом…», задание не ставится;
  - **`/feedback`** в чате команды — эфемерная подсказка «напишите
    `/feedback` в личке» вместо публичного отказа. Файл в личку по команде
    из группы не шлём: эта задача меняет только видимость ответов.

## Как сейчас

- `platforms/telegram/bot-commands.ts`:
  - `handle()` (строка 76) отвечает на `/help` публично в
    `{ chatId, threadId: message.message_thread_id ?? null }`;
  - `adminChats()` и `isAdminChat()` (строки 106–116) — чаты команды из
    `NotifyTargets`;
  - `publish()` (строка 65) ставит меню администратора в каждый чат команды
    и личку администратора;
  - после T-0406 у конструктора последним может стоять
    `@Optional() topics?: TelegramTopics`.
- `platforms/telegram/bot-router.ts` — `BotCommandSpec`
  `{ command, description, descriptionEn?, audience }`.
- `platforms/telegram/telegram-bot-api.ts`:
  - `updateSchema.message` без `ephemeral_message_id`;
  - после T-0393:
    - `SendOptions` — `{ keyboard?, silent?, ephemeral?: Ephemeral }`;
    - `Ephemeral` — `{ receiverUserId, callbackQueryId?, replaceOriginal? }`
      → `ephemeral_message_parameters`;
    - `BotCommand.is_ephemeral?`.
- `modules/export/export-bot.command.ts`:
  - `handleCommand()` (строка 167): нет права → молчание; группа → публичный
    отказ «Выгрузка — только в личном чате с ботом…»; личка → меню;
  - `handleCallback()` (строка 190): допускает нажатие только в личке
    нажавшего (строка 195), остальное гасит пустым `answerCallbackQuery`;
  - `start()` (строка 218): подсказки нажатия `answerCallbackQuery` с
    текстом, статус — `sendMessage(adminId, …)`.
- `modules/feedback/feedback-bot.command.ts`, `handle()` (строка 46): не из
  `ADMIN_TELEGRAM_IDS` → молчание; группа → публичный отказ «Отзывы — только
  в личном чате с ботом…».
- `platforms/telegram/bot.module.ts` — `BotModule`, экспортирует только
  `BotRouter`. `ExportModule` и `FeedbackModule` его импортируют.
- Тесты: `test/bot-commands.test.ts` строит `BotCommands` четырьмя
  параметрами; `test/export-bot.test.ts` строит `ExportBotCommand`
  позиционно (строка 104). Чата `-100500` в нём нет среди чатов команды.
- `test/helpers/settings.ts` — `panelSettings({ "bot.formats.enabled": true })`
  для настроек в тестах.

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **`telegram-bot-api.ts`:**
   - `updateSchema.message` += `ephemeral_message_id: z.number().int().optional()`
     с комментарием «команда пришла эфемерной: видна только боту (Bot API
     10.2)»;
   - `Ephemeral` += `replyToEphemeralId?: number`. Задан — `sendMessage`
     добавляет `reply_parameters: { ephemeral_message_id }`. Тип
     `ReplyParameters` grammY поле знает, приведения не нужны.
3. **`bot-router.ts`** — `BotCommandSpec` += `ephemeral?: boolean` с
   комментарием «в чате команды команда видна только набравшему, ответ —
   ему же (Р199)».
4. **`setting-catalog.ts`**, группа `BOT_MESSAGES_GROUP` (T-0394):
   ```ts
   botTeamEphemeralEnabled: {
     ...feature(
       "bot.team-ephemeral.enabled",
       "Эфемерные ответы в чате команды",
       "/help, меню выгрузки и отказы в чате команды видит только спросивший. Работает, когда включены сообщения нового поколения. Выключено — бот отвечает всем, как раньше",
       () => null,
       true,
     ),
     group: BOT_MESSAGES_GROUP,
   },
   ```
5. **`team-ephemeral.ts`** — `@Injectable() class TeamEphemeral`.
   Конструктор: `@Inject(SETTINGS_READER) settings`, `NotifyTargets`,
   `@Inject(TELEGRAM_BOT_API) api: TeamEphemeralApi`.
   `TeamEphemeralApi = Pick<TelegramBotApi, "sendMessage" | "answerCallbackQuery">`.
   ```ts
   /** оба ключа включены: `bot.formats.enabled` и `bot.team-ephemeral.enabled` */
   enabled(): boolean;
   /** чаты команды без повторов — перенос `adminChats()` из `BotCommands` */
   teamChats(): ChatTarget[];
   isTeamChat(chatId: string): boolean;
   /** ключи поменялись в панели — меню команд надо переставить */
   onSwitchChange(listener: () => void): void;
   /**
    * Эфемерный ответ на команду в чате команды. `false` — так ответить нельзя
    * (выключено, не чат команды, нет `from`, площадка отказала), и
    * вызывающий отвечает по-старому.
    */
   tryReply(message: TelegramMessage, text: string, options?: { keyboard?: InlineButton[][] }): Promise<boolean>;
   /**
    * Ответ на нажатие. В чате команды при включённых ключах — эфемерное
    * сообщение нажавшему и пустой `answerCallbackQuery`; иначе или при
    * отказе — `answerCallbackQuery(id, text)`, как сейчас. Нажатие гасится
    * всегда ровно одним `answerCallbackQuery`.
    */
   answerPress(query: TelegramCallbackQuery, text: string): Promise<void>;
   ```
   - `TelegramMessage` и `TelegramCallbackQuery` — `NonNullable<TelegramUpdate["message"]>`
     и `NonNullable<TelegramUpdate["callback_query"]>`, экспортом из этого
     файла;
   - `tryReply`:
     - условия `false` без вызова API: не `enabled()`, не
       `isTeamChat(String(message.chat.id))`, нет `message.from`;
     - иначе `api.sendMessage({ chatId, threadId: message.message_thread_id ?? null }, text, undefined, { keyboard, ephemeral: { receiverUserId: from.id, replyToEphemeralId: message.ephemeral_message_id } })`
       (без `replyToEphemeralId`, если поля нет) → `true`;
   - `answerPress` — в чате команды
     `api.sendMessage({ chatId, threadId: query.message.message_thread_id ?? null }, text, undefined, { ephemeral: { receiverUserId: query.from.id, callbackQueryId: query.id } })`,
     затем `api.answerCallbackQuery(query.id)`;
   - `TelegramApiError` с `errorCode` 400 или 403 на эфемерной отправке:
     - лог `{ module: "bot", event: "team_ephemeral_refused", method, code }`
       уровнем `warn` один раз за процесс;
     - `tryReply` → `false`, `answerPress` → `answerCallbackQuery(id, text)`;
   - удачный эфемерный ответ — строка лога
     `{ module: "bot", event: "team_ephemeral", kind: "reply" | "press" }`
     уровнем `log`: чат команды маленький, шума не будет;
   - `onSwitchChange` — `settings.onChange(changed)`, слушатель зовётся,
     если в `changed` есть `bot.formats.enabled` или
     `bot.team-ephemeral.enabled`.
6. **`bot.module.ts`** — `TeamEphemeral` в `providers` **и** `exports`.
   Без экспорта `ExportModule` и `FeedbackModule` его не получат.
7. **`bot-commands.ts`:**
   - конструктор += `@Optional() private readonly team?: TeamEphemeral`
     последним параметром (после `topics`, если T-0406 уже влит).
     Существующий `bot-commands.test.ts` проходит без правок;
   - `adminChats()` и `isAdminChat()` — через `team`, когда он есть; без
     него — прежняя реализация. Дублировать список нельзя: прежнюю
     реализацию оставить одной функцией `teamChatsOf(targets)` в
     `team-ephemeral.ts`, и звать её из обоих мест;
   - `commands` — `{ …, ephemeral: true }` у `/help`;
   - `publish()`: меню **чатов команды** при `team?.enabled()` — команды с
     `ephemeral: true` получают `is_ephemeral: true`. Меню по умолчанию,
     английское и личек администраторов — без поля: в личке эфемерность
     ни к чему;
   - `onModuleInit` — `team?.onSwitchChange(() => void this.publish().catch(…))`,
     как у `onChatsChange`;
   - `handle()`:
     ```ts
     const text = helpText(this.router.commands(), forAdmin);
     if (await this.team?.tryReply(message, text)) return true;
     await this.api.sendMessage({ chatId, threadId: message.message_thread_id ?? null }, text, this.stop.signal);
     ```
8. **`export-bot.command.ts`** — конструктор += `TeamEphemeral` последним
   параметром, **обязательным**. Комментарий в шапке файла: эфемерные ответы
   в чате команды (Р199).
   - `commands` — `{ …, ephemeral: true }`;
   - `handleCommand`:
     - нет права → `await this.team.tryReply(message, "Выгрузка — только с правом на выгрузку данных.")`,
       результат не важен: `false` — молчание, как сейчас;
     - группа → `tryReply(message, MENU_TEXT, { keyboard: MENU_KEYBOARD })`;
       `false` → прежний публичный отказ;
     - личка → меню, как сейчас.

     Текст и клавиатуру меню вынести из `sendMenu` в константы
     `MENU_TEXT` и `MENU_KEYBOARD`: одна правка текста — в обоих местах;
   - `handleCallback`:
     - `allowed` = право **и** (личка нажавшего **или**
       `team.enabled() && team.isTeamChat(String(chat.id))`);
     - `export:menu` из чата команды → `team.answerPress(query, "Меню выгрузки — по команде /export.")`.
       Таких кнопок там нет, ветка от подделки;
   - `start(query, adminId, period)` — вместо `callbackId` целый `query`:
     - подсказки «Выгрузка была только что…» и «Выгрузка уже готовится» —
       через `team.answerPress(query, text)`. В личке это тот же
       `answerCallbackQuery(id, text)`, что сейчас;
     - статус `sendMessage(adminId, …)` отправляется **до** подсказки
       «Готовлю». `TelegramApiError` 403 или 400 → `locks.release(adminId)`,
       `team.answerPress(query, "Откройте личный чат с ботом и нажмите «Старт» — архив придёт туда.")`,
       задание не ставится. Другие ошибки — бросить, сняв лок;
     - удача → `team.answerPress(query, isTeam ? "Готовлю выгрузку — пришлю в личку." : "Готовлю выгрузку")`;
     - в личке порядок «подсказка, потом статус» меняется на «статус, потом
       подсказка». Ожидания существующих тестов на состав вызовов это не
       ломает, порядок в них проверяется только у последнего вызова — сверить.
9. **`feedback-bot.command.ts`** — конструктор += `TeamEphemeral` последним
   параметром, обязательным:
   - `commands` — `{ …, ephemeral: true }`;
   - не администратор → `tryReply(message, "Отзывы выгружают только администраторы.")`;
     `false` — молчание;
   - группа → `tryReply(message, "Отзывы — файлом в личном чате с ботом: напишите там /feedback.")`;
     `false` → прежний публичный отказ.
10. **Документы:**
    - `docs/28-diagnostics.md`:
      - §6.1.2, пункт `/help` — абзац «В чате команды»: `/help`, меню
        выгрузки и отказы видит только спросивший; ключи; отказ площадки —
        прежний вид. Отдельно: на `/help`, набранный старым клиентом, бот
        отвечает эфемерно, только если он администратор чата команды;
      - §6.1.3 «Как реализовано» и §6.1.4 «Только личный чат»:
        - нажатие меню допускается и в чате команды при включённых ключах;
        - статус и архив — только в личку нажавшего;
        - нет лички с ботом — эфемерная подсказка, задание не ставится;
        - не-администратору в чате команды — эфемерный отказ, в остальных
          чатах — молчание;
    - `docs/29-admin-panel.md` §6, «Как забрать себе» — `/feedback` в чате
      команды отвечает подсказкой только набравшему.

## Чего не трогаем

- `/stats` и `daily-stats.reporter.ts` — публичные; файл в общих у T-0257.
- `/start`, `panel-login.command.ts`, `role-confirm.command.ts` — входы по
  ссылке в личке, в чате команды их не набирают.
- `/help` в чужих группах и в личке — как сейчас.
- Порт `Messenger` и модули домена: чат команды — инструмент Telegram.
- `scripts/test/layer-boundaries.test.ts`: `export` и `feedback` уже в
  `TEAM_TOOLS`, новых модулей нет.
- Сборка и отправка архива (`run()`), локи и пауза выгрузки.

## Сценарий и интерфейс

Ключи `bot.formats.enabled` и `bot.team-ephemeral.enabled` включены.
Участник чата команды:

1. В меню команд чата видит `/help`, `/export`, `/feedback`, `/stats`.
   Первые три — эфемерные: набранную команду не видит никто, кроме бота.
2. `/help` — справку видит только он.
3. `/export` с правом на выгрузку — меню периодов видит только он. Нажал
   «Сутки» → только ему «Готовлю выгрузку — пришлю в личку», в личке —
   статус и архив, как раньше.
4. `/export` без права — только ему «Выгрузка — только с правом на выгрузку
   данных.»
5. Нажал период, а лички с ботом нет — только ему «Откройте личный чат с
   ботом и нажмите «Старт» — архив придёт туда.»
6. `/feedback` — только ему подсказка «напишите там /feedback».

Состояния:
- ключ выключен — всё как до задачи: справка и отказы публичные, меню
  выгрузки в группе нет;
- старый клиент Telegram — команда видна всем; ответ эфемерный, если бот —
  администратор чата, иначе публичный, как раньше;
- эфемерное сообщение не дошло (Telegram не обещает доставку) — участник
  повторяет команду.

## Тесты

Первым коммитом.

- `backend/api/test/team-ephemeral.test.ts` (фейк API, `panelSettings`,
  `targetsOf` с `ADMIN_CHAT_ID=-1004251205331:57`):
  - `enabled()` — истина только при обоих ключах; умолчания каталога (общий
    выкл.) → `false`;
  - `tryReply` в чате команды → `sendMessage` с
    `{ chatId: "-1004251205331", threadId: 57 }`, `ephemeral.receiverUserId`
    = `from.id`; входящий с `ephemeral_message_id: 9` →
    `ephemeral.replyToEphemeralId: 9`; ответ `true`;
  - `tryReply` в чужой группе, в личке, при выключенном ключе → `false`, API
    не зван;
  - `sendMessage` бросает `TelegramApiError(…, 400, …)` → `false`; дважды —
    лог `team_ephemeral_refused` один раз; `TelegramApiError` 500 →
    бросается;
  - `answerPress` в чате команды → эфемерный `sendMessage` с
    `callbackQueryId` и `answerCallbackQuery(id)` без текста; в личке →
    только `answerCallbackQuery(id, text)`; отказ 400 →
    `answerCallbackQuery(id, text)`. Во всех случаях `answerCallbackQuery`
    зван ровно один раз;
  - `BotCommands` с `team`:
    - `publish()` при включённых ключах — в меню чата команды у `help`
      `is_ephemeral: true`, у `stats` поля нет; меню по умолчанию и личка
      администратора — без поля;
    - при выключенных — поля нет нигде;
  - `BotCommands.handle` `/help` в чате команды → один эфемерный
    `sendMessage`; отказ 400 → второй `sendMessage` публичный в ту же тему;
  - `FeedbackBotCommand`:
    - `/feedback` администратора в чате команды → эфемерная подсказка;
    - не-администратора в чате команды → эфемерный отказ;
    - не-администратора в чужой группе → вызовов нет.
- `backend/api/test/telegram-bot-api-v10.test.ts` не трогаем; разбор
  проверяется здесь же, на подменённом `fetch` по его образцу:
  - `sendMessage` с `ephemeral: { receiverUserId: 5, replyToEphemeralId: 9 }`
    → в теле `reply_parameters: { ephemeral_message_id: 9 }` и
    `ephemeral_message_parameters: { receiver_user_id: 5 }`;
  - `updateSchema` пропускает `message` с `message_id: 0` и
    `ephemeral_message_id: 9`.
- `backend/api/test/export-bot.test.ts` — `setup` передаёт `TeamEphemeral`.
  Существующие кейсы зелёные; чат `-100500` — не чат команды. Новые (в
  `setup` — `ADMIN_CHAT_ID` и `panelSettings` с включёнными ключами):
  - `/export` администратора в чате команды → эфемерный `sendMessage` с
    клавиатурой из четырёх периодов, задания нет;
  - то же при выключенном ключе → прежний публичный отказ;
  - `/export` без права в чате команды → эфемерный отказ; в чужой группе →
    вызовов нет;
  - нажатие `export:day` в чате команды → статус `sendMessage` в личку
    `adminId`, эфемерный ответ «Готовлю выгрузку — пришлю в личку.», одно
    задание с `chatId = adminId`;
  - то же, а `sendMessage` в личку бросает `TelegramApiError` 403 → задания
    нет, лок снят, эфемерный ответ «Откройте личный чат с ботом…»;
  - нажатие в чате команды при выключенном ключе → пустой
    `answerCallbackQuery`, задания нет (прежнее поведение);
  - нажатие без права в чате команды → пустой `answerCallbackQuery`,
    задания нет.

## Аналитика

Нет событий: чат команды — инструмент, игроков в нём нет (Р199, строка
«Чат команды»). Строки лога `team_ephemeral` и `team_ephemeral_refused`.

## Настройки и окружение

- `bot.team-ephemeral.enabled` — вкл., группа «Сообщения бота»; работает
  при включённом `bot.formats.enabled`.
- Переменных окружения нет. `docs/30-configuration-map.md`, строка 90, ключ
  уже называет.
- Необязательно: бот — администратор чата команды. Тогда и `/help`,
  набранный старым клиентом, уходит эфемерно.

## Документы

- `docs/28-diagnostics.md` §6.1.2–§6.1.4 — шаг 10.
- `docs/29-admin-panel.md` §6 — шаг 10.

## Критерии приёмки

- [ ] При включённых ключах `/help`, меню `/export` и отказы в чате команды
      уходят эфемерно спросившему; `/stats` — публично.
- [ ] Статус и архив выгрузки уходят только в личку нажавшего; без лички —
      эфемерная подсказка, задание не ставится, лок снят.
- [ ] Отказ площадки на эфемерную отправку → прежний вид ответа и строка
      лога один раз.
- [ ] Выключенный любой ключ — поведение как до задачи, существующие тесты
      `bot-commands.test.ts` и `export-bot.test.ts` зелёные.
- [ ] Меню чата команды помечает эфемерными `/help`, `/export`, `/feedback`
      и переставляется при смене ключей без перезапуска.
- [ ] `TeamEphemeral` экспортирован из `BotModule`; в `ExportBotCommand` и
      `FeedbackBotCommand` он обязательный параметр.
- [ ] Список чатов команды — в одном месте (`teamChatsOf`).
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Эфемерные ответы в чате команды`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздел `## Для игроков` не добавлять.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЭФЕМЕРНЫЕ ОТВЕТЫ В ЧАТЕ КОМАНДЫ**

  В чате команды бот больше не засоряет ленту: /help, меню выгрузки и отказы видит только тот, кто спросил (Р199). Архив выгрузки, как и раньше, приходит в личку.

  🛠 **Что внутри**

  • /help, /export и /feedback в меню чата команды — эфемерные: набранную команду видит только бот
  • /export в чате команды показывает меню периодов только нажавшему; статус и архив — в личку
  • /stats остаётся публичным
  • Telegram отказал в эфемерном ответе — бот отвечает по-старому

  ⚙️ **Настройки**

  • панель → «Сообщения бота»: bot.team-ephemeral.enabled (вкл.; работает при включённом bot.formats.enabled)

  ❓ **Нужно от команды**

  • @владелец — на деве включить bot.formats.enabled и попробовать /help и /export в чате команды; по желанию сделать бота администратором чата — тогда эфемерно ответит и старым клиентам
  ```
