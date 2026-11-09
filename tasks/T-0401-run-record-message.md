---
id: T-0401
title: Рекорд забега в личке бота — оформленное сообщение со ссылкой друга, которое можно переслать
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0394, T-0395]
zones:
  - backend/api/src/modules/run-record/**
  - backend/api/test/run-record.test.ts
  - scripts/test/bot-build-names.test.ts
shared:
  - backend/api/src/modules/runs/runs-hooks.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/account-settings/account-settings.catalog.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/app.module.ts
  - packages/app-shell/src/state/bot-notifications.ts
  - packages/app-shell/src/state/account-settings.ts
  - packages/app-shell/src/i18n/ru-bot.json
  - packages/app-shell/test/bot-notifications.test.ts
  - scripts/test/account-settings-keys.test.ts
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: null
batch: 5
---

# T-0401. Рекорд забега в личке бота — оформленное сообщение со ссылкой друга, которое можно переслать

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0401.json)](README.md#значки-статуса) [![T-0394](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0394.json&label=T-0394)](T-0394-rich-message-port.md) [![T-0395](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0395.json&label=T-0395)](T-0395-live-cards-core.md)

## Зачем

Новый личный рекорд сейчас виден только на экране смерти. После задачи бот
без звука присылает игроку оформленное сообщение: время, очки, таблица забега
и раскрывающаяся «Сборка». Под сообщением — кнопка «▶ Играть» со ссылкой
друга игрока. Сообщение переслал — друг по кнопке приходит в игру от его
имени (Р199, сценарий «Рекорд забега»). На MAX и VK — тот же текст без
оформления.

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52, сценарий «Рекорд забега», правила
  1, 5, 6, 8, 9):
  - рекорд — без звука: его вызвал сам игрок;
  - не чаще раза в `bot.run-record.min-gap-hours` (24 часа);
  - выбор игрока — ключ аккаунта `bot.runRecord`, умолчание — вкл.;
  - только настоящие числа забега, без покупок и рекламы;
  - `bot.formats.enabled` выключен — сообщения о рекорде нет вовсе: до Р199
    его не было;
  - `bot.rich.enabled` выключен — тот же документ простым текстом.
- **Рекорд — то же, что «Новый рекорд» на экране смерти:** `isNewBest` из
  итога забега (`runs.service.ts`, `resultOf`). Решения тимлида (технические):
  - слушатель получает `isNewBest` полем `RecordedRun`, а не пересчитывает
    лучшее сам: второй подсчёт однажды разошёлся бы с экраном смерти;
  - пишем только о забеге, который вошёл в рейтинг: `ranked`, вердикт `ok`,
    без читов, сложность `hard`, не пролог;
  - первый рейтинговый забег игрока тоже рекорд, как на экране смерти.
- **Кнопка одна — ссылка друга игрока** (`FriendsService.link` → `f-<код>`
  → `AppLinks.launch`). Кнопка-ссылка (`url`, не `web_app`) переживает
  пересылку. Решение тимлида (техническое):
  - в документе кнопка блоком `buttons`, под сообщением — она же
    клавиатурой (правило T-0394 «главная кнопка дублируется»);
  - своя кнопка с `n-run_record` не нужна: пересланное сообщение несло бы
    её другу, и друг пришёл бы не по ссылке игрока;
  - автор, нажавший свою же ссылку, — обычный вход: свою ссылку дружба и
    рефералка пропускают (`referrals.service.ts`, `onLogin`:
    `ownerId === login.accountId`);
  - поэтому возврат по `n-run_record`, названный в разделе «Аналитика» WP52,
    у этого сценария не считается. Возвраты автора видны по `start_kind = friend`
    со своей ссылкой.
- **Названия оружия и навыков.** Собранный бэкенд пакеты клиента не
  импортирует (как `DIFFICULTY_NAMES` в `bot-notify-texts.ts`). Решение тимлида
  (техническое):
  - копия названий — в модуле, `build-names.ts`;
  - расхождение со словарём оболочки ловит тест `scripts/test`;
  - неизвестный id в «Сборку» не попадает.
- **Отправка — очередью дубля** (`addPaced` T-0395): сообщения о рекордах
  идут общим темпом 5 в секунду вместе с уведомлениями и карточками.

## Как сейчас

- `modules/runs/runs.service.ts`:
  - `finish()`, строки 199–227, — `resultOf(...)` даёт `placed.isNewBest`;
  - затем `void this.hooks.emit({...})` без `isNewBest` и без навыков
    (`run.passives`);
  - `resultOf` — строки 317–348.
- `modules/runs/runs-hooks.ts` — `RecordedRun`, строки 17–58. Поля:
  - `survivalSec`, `points`, `level`, `enemiesKilled`;
  - `weapons: { id, level }[]`;
  - `difficulty`, `mode`, `cheats`, `ranked`, `verdict`.

  `RunsHooks.onRecorded(name, listener)` зовёт слушателя только при первой
  записи забега. Тесты сравнивают запись `toMatchObject` (`test/runs.test.ts`,
  `test/rubezh-win.test.ts`): новое необязательное поле их не ломает.
- Ссылка друга — `modules/friends/friends.service.ts` `link(accountId)` →
  `{ code, startParam }`, строка 218 (`FriendsModule` экспортирует
  `FriendsService`). Ссылка запуска — `AppLinks.launch(platform, startParam)`
  (`platforms/ports/app-links.ts`), у Telegram —
  `https://t.me/<бот>?startapp=f-<код>`.
- Время — `common/card/labels.ts` `formatDuration` («14:05», «1:02:40»),
  склонение — `pluralRu`.
- После T-0394:
  - `BotMessages.compose(doc, { button, topic })` → `OutgoingMessage`;
  - `BotMessagePolicy.decide({ accountId, origin: "player" }, now)` → без звука;
  - `BotMessageEvents.sent({...})`;
  - группа панели `BOT_MESSAGES_GROUP`;
  - `MessageTopic`, `RichDocument` — `platforms/ports/messenger.ts`,
    `platforms/ports/rich-message.ts`.
- После T-0395 — `BotNotifyQueue.registerPaced(name, handler)` и
  `addPaced(name, data, { jobId, delayMs })` (`notifications-bot/bot-notify-queue.ts`).
- Можно ли писать — `MessagingService.state(accountId)` (`canMessage`); выбор
  игрока — `AccountSettingsService.valueOf(accountId, key)`; блокировка при
  отправке — `MessagingService.platformChanged(...)`. Образец порядка проверок —
  `notifications-bot/bot-notify-sender.ts` `deliver()`.
- Выбор игрока в клиенте — как `seasonCard` в T-0397, шаг 7:
  `app-shell/src/state/bot-notifications.ts`, `state/account-settings.ts`,
  `i18n/ru-bot.json`. Экран настроек строит переключатели по `BOT_NOTIFY_KEYS`
  сам.
- Названия в оболочке — `packages/app-shell/src/i18n/ru.json`:
  `weapon.<id>.name`, `passive.<id>.name`. Списки контента — `WEAPONS`
  (`core-game/src/content/weapons.ts`) и `PASSIVES` (`content/upgrades.ts`).

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **`runs-hooks.ts`** — два необязательных поля `RecordedRun` с
   комментариями:
   - `isNewBest?: boolean` — «новый личный рекорд, как на экране смерти;
     поля нет — не рекорд»;
   - `passives?: { id: string; level: number }[]` — «навыки к концу забега,
     со слов клиента».
3. **`runs.service.ts`**, `finish()` — в объект `hooks.emit` две строки:
   - `isNewBest: result.isNewBest`;
   - `passives: run.passives.map((passive) => ({ id: passive.id, level: passive.level }))`.

   Больше в файле ничего не меняется.
4. **`modules/run-record/run-record-rules.ts`** — чистые правила:
   - `export const RUN_RECORD_CHOICE = { setting: "bot.runRecord", byDefault: true } as const;`
   - `isRecordWorthy(run: RecordedRun): boolean` — `isNewBest === true`,
     `ranked`, `verdict === "ok"`, `!cheats`, `difficulty === "hard"`,
     `mode !== "prologue"`;
   - `recordGapKey(accountId)` → `bot-record:<аккаунт>`;
   - `RunRecordJob` — данные задания:
     `{ accountId, survivalSec, points: number | null, level, enemiesKilled, weapons, passives }`.
5. **`modules/run-record/build-names.ts`** — `WEAPON_NAMES: Record<string, string>`
   и `PASSIVE_NAMES: Record<string, string>`:
   - копия `weapon.<id>.name` и `passive.<id>.name` из `ru.json` для каждого
     id из `WEAPONS` и `PASSIVES`;
   - комментарий — почему копия: собранный бэкенд пакеты клиента не
     импортирует, сверка — `scripts/test/bot-build-names.test.ts`.
6. **`modules/run-record/run-record-rich.ts`** — чистая функция
   `runRecordDocument(job: RunRecordJob, friendUrl: string | null): RichDocument`:
   - заголовок (уровень 2) — `Новый рекорд — ${formatDuration(survivalSec)}`;
   - таблица без заголовка, два столбца:
     - «Время» — `formatDuration(survivalSec)`;
     - «Очки» — число с пробелом между тысячами (`12 480`); `points === null`
       — ряда нет;
     - «Уровень» — `level`;
     - «Врагов повержено» — `enemiesKilled` с пробелом между тысячами;
   - `details` со сводкой «Сборка» — список:
     - оружие: `Нож — ур. 7` в порядке `weapons`;
     - навыки: `Мощь — ур. 3` в порядке `passives`;
     - id без названия пропускается; список пуст — `details` нет;
   - при `friendUrl`:
     - абзац «Перешли другу — по кнопке он придёт в игру от тебя»;
     - блок `buttons` с одной кнопкой `{ text: "▶ Играть", url: friendUrl }`;
   - без `friendUrl` нет ни абзаца, ни кнопок.
7. **`modules/run-record/run-record.notifier.ts`** — `RunRecordNotifier`:
   - **слушатель** `onRecorded("run-record", …)`:
     - `isRecordWorthy` ложно → выход;
     - `bot.formats.enabled` выключен → выход;
     - `addPaced("run-record", job, { jobId: \`run-record:${runId}\`, delayMs: 0 })`;
     - сбой → лог `run_record_hook_failed` без данных игрока; запись забега
       не страдает.
   - **обработчик задания** `send(job, now)` → исход для теста, по порядку:
     1. `bot.formats.enabled` выключен → `off`;
     2. аккаунта нет или он заблокирован → `skipped`;
     3. `Messengers.for(platform)` нет → `skipped`;
     4. `MessagingService.state(...)?.canMessage !== true` → `not_allowed`;
     5. выбор `bot.runRecord`: значение не `boolean` — умолчание
        `RUN_RECORD_CHOICE.byDefault`; выключен → `opted_out`;
     6. окно рекорда — `SET bot-record:<аккаунт> <runId> EX <часы × 3600> NX`
        (`bot.run-record.min-gap-hours`): не занято, и значение не этот
        `runId` → `throttled`. Повтор того же задания своё окно узнаёт по
        `runId`, как `claim` в `bot-notify-sender.ts`;
     7. ссылка друга — `FriendsService.link(accountId)` →
        `AppLinks.launch(platform, startParam)`; сбой ссылки → `null`, лог
        `run_record_link_failed`, сообщение уходит без кнопки;
     8. `BotMessagePolicy.decide({ accountId, origin: "player" }, now)` →
        `silent`;
     9. `BotMessages.compose(runRecordDocument(job, url), { button: url === null ? null : { text: "▶ Играть", url }, topic: "rewards" })`,
        `silent` из шага 8 → `messenger.send(platformUserId, message)`;
     10. `retry` → бросить: повтор BullMQ;
     11. `blocked` → `MessagingService.platformChanged(platform, platformUserId, "blocked", now)`;
     12. `BotMessageEvents.sent`:
         - `kind: "run_record"`;
         - `format` — `rich`, если у сообщения был `rich` и исход не
           `fallback`, иначе `text`;
         - `outcome`, `topic: "rewards"`, `silent`, `platform`.
   - Каждый вызов базы и Redis — с таймаутом 3 с (`withTimeout`).
8. **`modules/run-record/run-record.module.ts`** — `RunRecordModule`:
   - импортирует `RunsModule`, `FriendsModule`, `MessagingModule`,
     `AccountSettingsModule`, `BotMessagesModule`, `NotificationsBotModule`;
   - в `onModuleInit` — `registerPaced("run-record", …)` и слушатель; без
     входа игроков (`auth.enabled` выкл.) — ничего;
   - строка модуля в `app.module.ts`.
9. **Настройки панели** — `setting-catalog.ts`, группа `BOT_MESSAGES_GROUP`:
   - ключ `botRunRecordMinGapHours`:
     `integer("bot.run-record.min-gap-hours", BOT_MESSAGES_GROUP, "Рекорд забега — не чаще раза в", "Сколько часов бот молчит о новом рекорде после прошлого сообщения о нём. Работает, когда включены сообщения нового поколения", { min: 12, max: 168, unit: ["час", "часа", "часов"] }, 24)`.
10. **Выбор игрока:**
    - `account-settings.catalog.ts` — `"bot.runRecord": { schema: z.boolean(), merge: "latest" }`
      с комментарием «сообщение о рекорде забега в боте (Р199)»;
    - `scripts/test/account-settings-keys.test.ts` — кейс по образцу дубля:
      клиентский ключ `bot.runRecord` есть в `BOT_NOTIFY_ACCOUNT_KEYS`,
      умолчание то же, что `RUN_RECORD_CHOICE.byDefault`, ключ есть на сервере;
    - клиент — переключатель `runRecord` так же, как `seasonCard` в T-0397,
      шаг 7:
      - `BOT_NOTIFY_DEFAULTS.runRecord = true`;
      - `BOT_NOTIFY_ACCOUNT_KEYS.runRecord = "bot.runRecord"`;
      - `BOT_NOTIFY_KEYS` += `runRecord` последним;
      - схема, `readStored`, `persist`;
      - ветки в `account-settings.ts`;
      - текст `"settings.bot.runRecord": "Рекорд забега в боте"`.
11. **`docs/30-configuration-map.md`**, строка 90 — ключ Redis
    `bot-record:<аккаунт>` (окно рекорда) и задание `run-record` в очереди
    `notifications-bot`.

## Чего не трогаем

- `resultOf`, лидерборд и правило «нового рекорда» — только передаём готовое
  `isNewBest` слушателям.
- Тексты и картинку «Поделиться» итогом — T-0253 и T-0400.
- Темы в личке: `topic: "rewards"` адаптер учтёт после WP52 № 14 (T-0406).
- Остальные слушатели `RunsHooks` и их тесты.

## Сценарий и интерфейс

Игрок в Telegram:

1. Побил свой рекорд на «Сложной». Бот без звука присылает сообщение:
   - заголовок «Новый рекорд — 14:05»;
   - таблица «Время 14:05 · Очки 12 480 · Уровень 23 · Врагов повержено 1 532»;
   - свёрнутая «Сборка»: «Нож — ур. 7», «Гроза — ур. 5», «Мощь — ур. 3»;
   - «Перешли другу — по кнопке он придёт в игру от тебя»;
   - кнопка «▶ Играть».
2. Переслал другу — у друга то же сообщение и та же кнопка. По кнопке друг
   входит в игру по ссылке игрока: дружба и приглашение — как у ссылки из
   раздела «Друзья».
3. Ещё рекорд в те же сутки — бот молчит (окно 24 часа).

Состояния:
- `bot.rich.enabled` выключен или Telegram отказал в оформлении — тот же
  текст без оформления и та же кнопка;
- ссылки друга нет (бот ещё не узнал имя) — сообщение без кнопки и без
  абзаца о пересылке;
- MAX и VK — простой текст; ссылка — если адаптер площадки её собирает.

В настройках игры — переключатель «Рекорд забега в боте» (по умолчанию вкл.).

## Тесты

Первым коммитом.

- `backend/api/test/run-record.test.ts` (фейки площадки, Redis, настроек,
  очереди, `FriendsService`, `AppLinks`):
  - `isRecordWorthy`:
    - рекорд на `hard`, рейтинговый, `ok` → `true`;
    - `isNewBest` нет, `ranked: false`, `verdict: "suspicious"`,
      `cheats: true`, `mode: "prologue"`, `difficulty: "easy"` — каждое →
      `false`;
  - `runRecordDocument`:
    - `plainTextOf` документа с `points: 12480`, `enemiesKilled: 1532`,
      оружием `knife` 7 и навыком `might` 3 — ровно ожидаемая строка (снимок
      строкой);
    - `points: null` — ряда «Очки» нет;
    - неизвестный id оружия в «Сборку» не попал; оружия и навыков нет —
      `details` нет;
    - `friendUrl: null` — ни абзаца о пересылке, ни кнопок;
    - `richProblems` документа пуст;
  - слушатель:
    - рекорд при включённом формате → `addPaced("run-record", …)` с
      `jobId: "run-record:<runId>"`;
    - формат выключен → в очередь не ставит;
    - очередь бросает → лог, исключение наружу не уходит;
  - `send`:
    - всё разрешено → `messenger.send` с `silent: true`, `rich` и кнопкой на
      `https://t.me/bot?startapp=f-<код>`; `events.sent` с
      `kind: "run_record"`, `format: "rich"`, `topic: "rewards"`;
    - выбор `bot.runRecord` не задан → уходит; `false` → `opted_out`;
    - `canMessage: false` → `not_allowed`;
    - второй рекорд в окне → `throttled`; повтор того же задания → уходит;
    - `blocked` → `platformChanged(…, "blocked", …)`;
    - `retry` → обработчик бросает;
    - `FriendsService.link` бросает → сообщение без кнопки, исход `sent`;
    - фейковая площадка без `capabilities` получает `rich: undefined` и
      `text = plainTextOf(документа)`.
- `backend/api/test/runs.test.ts` — существующий, проходит без правок. В
  `run-record.test.ts` — кейс на настоящем `RunsService` по образцу
  `runs.test.ts`, строка 278: первый рейтинговый забег приходит слушателю с
  `isNewBest: true` и `passives`, второй слабее — с `isNewBest: false`.
- `scripts/test/bot-build-names.test.ts`: для каждого `WEAPONS[i].id` и
  `PASSIVES[i].id` значение в `WEAPON_NAMES` / `PASSIVE_NAMES` равно строке
  `ru.json` по `nameKey`; лишних id в таблицах нет. Сообщение называет id.
- `scripts/test/account-settings-keys.test.ts` — кейс `bot.runRecord` (шаг 10).
- `packages/app-shell/test/bot-notifications.test.ts`: `runRecord` в
  `BOT_NOTIFY_KEYS`, умолчание `true`, ключ `bot.runRecord`.

## Аналитика

- `bot_message_sent` (T-0394) — `kind: "run_record"`, `format` `rich` или
  `text`, `topic: "rewards"`, `silent: true`.
- Друг по кнопке — существующие `referral_bound` и сессия с
  `start_kind = friend` (`attribution/start-param.ts`), новых событий нет.
- Выключение выбора игрока — существующий `settings_changed`
  (`setting: "bot.runRecord"`).

## Настройки и окружение

- `bot.run-record.min-gap-hours` — 24, коридор 12–168, группа «Сообщения
  бота».
- Ключ аккаунта `bot.runRecord` — умолчание вкл.
- Ключ Redis `bot-record:<аккаунт>`.

Переменных окружения нет.

## Документы

- `docs/30-configuration-map.md`, строка 90 — шаг 11; сам ключ панели и ключ
  аккаунта в строке уже названы.

## Критерии приёмки

- [ ] Слушатель пишет только о рекорде рейтингового забега на «Сложной» и
      только при включённом `bot.formats.enabled`.
- [ ] Сообщение без звука, не чаще раза в `bot.run-record.min-gap-hours`, с
      учётом выбора игрока и «можно ли писать».
- [ ] Кнопка — ссылка друга игрока (`f-<код>`), и в документе, и
      клавиатурой; без ссылки — сообщение без кнопки.
- [ ] Числа в сообщении — только из итога забега; названия — из таблицы,
      которую сверяет тест со словарём оболочки.
- [ ] Площадка без оформления получает простой текст того же документа.
- [ ] `RecordedRun` дополнен двумя необязательными полями; существующие тесты
      забегов зелёные без правок.
- [ ] Переключатель «Рекорд забега в боте» в настройках игры; умолчания
      клиента и сервера совпадают (тест ключей).
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Рекорд забега в личке со ссылкой друга`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое [telegram]: побил рекорд — бот без звука присылает его таблицей со сборкой; перешли другу, и по кнопке он придёт в игру от тебя`
  - `- новое: в настройках — переключатель «Рекорд забега в боте»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РЕКОРД ЗАБЕГА В ЛИЧКЕ БОТА**

  Новый личный рекорд на «Сложной» бот присылает без звука оформленным сообщением: время, очки, таблица забега и свёрнутая «Сборка». Кнопка «▶ Играть» — ссылка друга игрока: пересланное сообщение приводит друга в игру от его имени (Р199).

  🛠 **Что внутри**

  • не чаще раза в сутки, только рейтинговые забеги, по выбору игрока «Рекорд забега в боте»
  • на MAX и VK — тот же текст без оформления
  • названия оружия и навыков — копией на сервере, сверка со словарём игры — тестом

  ⚙️ **Настройки**

  • панель → «Сообщения бота»: bot.run-record.min-gap-hours 24 (работает при включённом bot.formats.enabled)

  ❓ **Нужно от команды**

  • @владелец — посмотреть сообщение на деве и переслать его себе с другого аккаунта
  ```
