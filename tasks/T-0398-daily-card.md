---
id: T-0398
title: Карточка «Награда дня» — забрать награду и готовые задания дня одним касанием в боте
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0395, T-0396, T-0255]
zones:
  - backend/api/widgets/telegram/daily.html
  - backend/api/src/modules/bot-cards/kinds/daily-card.ts
  - backend/api/src/modules/bot-cards/kinds/daily-card.module.ts
  - backend/api/src/modules/notifications-bot/bot-notify-routes.ts
  - backend/api/test/daily-card.test.ts
  - backend/api/test/daily-card.integration.test.ts
shared:
  - backend/api/src/modules/bot-cards/bot-card-choices.ts
  - backend/api/src/platforms/telegram/bot-card-commands.ts
  - backend/api/src/modules/notifications-bot/bot-notify-sender.ts
  - backend/api/src/modules/notifications-bot/notifications-bot.module.ts
  - backend/api/src/modules/daily/daily.controller.ts
  - backend/api/src/modules/tasks/tasks.controller.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - backend/api/src/app.module.ts
  - scripts/test/event-dictionary.test.ts
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

# T-0398. Карточка «Награда дня» — забрать награду и готовые задания дня одним касанием в боте

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0398.json)](README.md#значки-статуса) [![T-0395](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0395.json&label=T-0395)](T-0395-live-cards-core.md) [![T-0396](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0396.json&label=T-0396)](T-0396-live-cards-telegram.md) [![T-0255](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0255.json&label=T-0255)](T-0255-reminders-with-images.md)

## Зачем

Напоминание «награда дня ждёт» зовёт открыть игру ради одного касания.
Карточка «Награда дня» даёт забрать награду дня и готовые задания дня прямо в
личке бота, видеть итог сразу на карточке и завтрашнюю награду. Начисляет
сервер теми же сервисами и ключами, что кнопка в игре (Р199, сценарий
«Карточка „Награда дня“»).

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52):
  - сценарий «Карточка „Награда дня“» — награда дня и готовые задания дня,
    «Забрать» одним касанием, итог сразу на карточке, завтрашняя награда
    видна;
  - на MAX и VK — прежнее текстовое напоминание;
  - аналитика — `daily_reward_claimed` и `task_completed` с `via: bot`,
    `bot_card_query`, возврат — `n-daily_card`;
  - ключ панели — `bot.widget.daily.enabled`, выбор игрока — прежний
    `bot.reminders`.
- **Правило 7 (деньги):**
  - «Забрать» начисляет `DailyService.claim` и `TasksService.claim` — тем же
    кодом, что игра, с теми же проверками (аккаунт, блокировка, пролог Р151)
    и ключами идемпотентности кошелька;
  - одновременное касание в боте и в игре не удваивает награду;
  - кто нажал — `from` обновления, аккаунт — по идентификатору площадки
    (ядро T-0395);
  - за касание — не больше 5 заданий;
  - наград сверх игровых нет.
- **Правило 8 (честность):**
  - без «сгорит», «последний шанс» и вины;
  - одна спокойная строка: «Пропуск дня не сбрасывает неделю — следующая
    награда по порядку». Это правда: неделя награды дня без сброса (Р45,
    `daily/daily.service.ts`).
- **Правило 6:** карточку присылает напоминание `daily_reward_ready` — под
  всеми правилами T-0128 (одно напоминание в сутки, тихие часы, «Не
  напоминать»). Звук решает дубль уведомлений; ядро его не пересчитывает
  (`send` с `silent`, T-0395).
- **Решения тимлида (подтвердить владельцу):**
  - **задания — числом и суммой, а не списком названий**: «Готово заданий:
    3 — 450 монет». Названия заданий сервер не знает: у `TaskView.title`
    `null`, текст строит клиент из своего словаря по виду цели и фильтру.
    Копировать его в бэкенд — двойная правка на каждое новое задание;
  - **лимит частоты** — тот же, что у кнопки в игре:
    - `RateLimiter` `{ scope: "daily", limit: 120, windowSec: 3600 }` на
      награду дня;
    - `{ scope: "tasks", limit: 300, windowSec: 3600 }` на задания, одно
      списание за касание;
    - константы экспортируются из контроллеров, а не копируются.

## Как сейчас

- Награда дня — `modules/daily/daily.service.ts`:
  - `claim(accountId, at)`, строки 71–88: пролог (`prologue.requireOpen` →
    `PrologueRequiredError`), уже забрано → `claimed: false`;
  - монеты и осколки — `wallet.grant` с ключом `daily_reward:<аккаунт>:<день>`;
  - `view(accountId, at)` → `DailyView` (`week`, `days[]` с `today`,
    `claimed`, `coins`, `shards`; `canClaim`; `next`).
  Лимит — `daily/daily.controller.ts`, строка 12, константа не экспортирована.
- Задания — `modules/tasks/tasks.service.ts`:
  - `view(account, at)` → `TaskView[]` (`period`, `category`, `done`,
    `claimed`, `reward { coins, gems, shards }`, `kind`, `tier`, `title`
    обычно `null`);
  - `claim(account: AccountRef, taskId, at)` → `TaskClaimResult`
    (`claimed`, `credited`); ключ кошелька
    `task:<аккаунт>:<задание>:<начало периода>:<ресурс>`;
  - лимит — `tasks/tasks.controller.ts`, строка 20.
  `TasksModule` экспортирует `TasksService`, `DailyModule` — `DailyService`.
- `AccountRef` — `{ accountId, platform, platformUserId }` (`roles/roles.service.ts`).
- Напоминание «награда дня ждёт»:
  - вид `daily_reward_ready`, отправитель
    `notifications-bot/bot-notify-sender.ts`;
  - после T-0255 уходит картинкой, после T-0394 — по правилам звука
    (`policy.decide`, `message.silent`).
- После T-0395 и T-0396:
  - контракт вида (`act` → `ok | already | locked | limited`);
  - `BotCardsService.send({ …, silent })`;
  - ответ ядра на действие — `{ v: 1, res, …result }`;
  - HTML — `backend/api/widgets/telegram/`, кнопки — `data-act`,
    помощник `test/widget-render.ts` с `click(act)`;
  - таблицы `CARD_COMMANDS` и `BOT_CARD_CHOICES`.
- События `daily_reward_claimed` (`day`, `week`) и `task_completed` (`task`,
  `period`, `kind`, `tier?`) шлёт клиент после ответа сервера
  (`event-dictionary.ts`, строки 289 и 319). Серверная запись — по образцу
  `rating/run-scorer.service.ts` `announce()`.

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **Словарь событий** — сначала `docs/22` §3.3: у `daily_reward_claimed` и
   `task_completed` — необязательное `via: bot` (серверная запись забора
   через карточку бота; клиент поля не шлёт; конверт `install_id = 'server'`).
   Потом `event-dictionary.ts`: `via: z.enum(["bot"]).optional()` у обоих,
   версия не меняется.
3. **Константы лимитов** — `export const DAILY_LIMIT` в `daily.controller.ts`
   и `export const TASKS_LIMIT` в `tasks.controller.ts` (переименование
   локальной `LIMIT`, поведение то же).
4. **`modules/bot-cards/kinds/daily-card.ts`** — `createDailyCard(deps): BotCardKind`:
   - `kind: "daily"`, `startRef: "n-daily_card"`,
     `actions: ["claim_daily", "claim_tasks"]`;
   - `enabled: SETTINGS.botWidgetDailyEnabled`;
   - `choice: { setting: "bot.reminders", byDefault: true }`;
   - `periodKey(at)` — игровые сутки по Москве (`YYYY-MM-DD`): в полночь ядро
     закрывает вчерашнюю карточку.
   - `state(accountId, at)`:
     ```ts
     { d: <день недели 1–7 сегодняшней награды>, w: view.week,
       c: <монеты сегодня>, s: <осколки сегодня>, cl: <забрано сегодня 0|1>,
       nc: view.next.coins, ns: view.next.shards,
       tr: <готовых дневных заданий>, tc, tg, ts: <сумма их наград>,
       lk: <пролог не пройден 0|1> }
     ```
     - готовые — `period === "daily"`, `category === "daily"`, `done && !claimed`;
     - `lk` — `PrologueService.isDone`;
     - состояние укладывается в 1024 байта.
   - `act(account, "claim_daily", null, at)`:
     - лимит `DAILY_LIMIT` исчерпан → `limited`;
     - `DailyService.claim`: `PrologueRequiredError` → `locked`,
       `claimed: false` → `already`, иначе `ok`;
     - `result` — свежее `state` и `g: { c: coins, s: shards }` (начислено);
     - на `ok` — событие `daily_reward_claimed` `{ day, week, via: "bot" }`.
   - `act(account, "claim_tasks", null, at)`:
     - лимит `TASKS_LIMIT` (одно списание) исчерпан → `limited`;
     - пролог не пройден → `locked`;
     - готовые дневные задания — до 5, по порядку списка `view`;
     - каждое — `TasksService.claim` **по очереди**, не параллельно:
       `claimed` → событие `task_completed`
       `{ task, period: "daily", kind, tier?, via: "bot" }`;
     - новое задание не начинается, если с начала действия прошло 6 секунд:
       ответ частичный, остальное — следующим касанием;
     - доменная ошибка задания (`TaskNotDoneError` и др.) пропускает задание
       и не роняет остальные;
     - ни одного нового → `already`, иначе `ok`;
     - `result` — свежее `state` и `g: { k: <сколько забрано>, c, gm, s }`.
   - `caption(state)` — «Награда дня · день {d} из 7». Без чисел наград:
     подпись остаётся правдой и после забора.
   - `fallback(state)` — `RichDocument`:
     - заголовок «Награда дня»;
     - абзац «День {d} из 7: {c} монет» (+ осколки);
     - абзац про готовые задания, если они есть;
     - абзац «Забрать — в игре».
5. **`daily.html`** — по правилам T-0396, шаг 5, бюджет 3 300 байт. На
   карточке:
   - строка «День {d} из 7 · неделя {w}»;
   - крупно — «{c} монет» (+ «{s} осколка»; слова — `Intl.PluralRules("ru")`);
   - кнопка `data-act="claim_daily"` «Забрать»; после забора — «Забрано ✓» и
     строка «Завтра: {nc} монет»;
   - готовых заданий больше нуля — строка «Готово заданий: {tr} — {tc}
     монет» (+ самоцветы и осколки, если есть) и кнопка
     `data-act="claim_tasks"` «Забрать задания»;
   - `lk` → вместо кнопок «Награда откроется после пролога — пройди его в
     игре»;
   - касание:
     - кнопка блокируется с «…» до ответа, `TelegramWidget.request("v1:<действие>")`;
     - `res: "ok"` → «+{начислено}» на 3 секунды и перерисовка из `result`;
     - `already` → «Уже забрано»;
     - `locked` → строка про пролог;
     - `limited` или `err` → «Слишком часто — попробуй через минуту» /
       «Не получилось — попробуй ещё раз»;
     - отказ `request` (`RATE_LIMITED`, `TIMEOUT`) → «Не получилось —
       попробуй ещё раз», кнопка снова доступна;
   - мелко внизу — «Пропуск дня не сбрасывает неделю — следующая награда по
     порядку»;
   - флаги `moved`, `off`, `stale`, `x` — как у пробы; при `off` и `x`
     кнопок нет;
   - фоновый запрос `v1:r` первой строкой;
   - покупок и предложений нет.
6. **`notifications-bot/bot-notify-routes.ts`** — маршрут вида уведомления в
   другой способ доставки, без импорта карточек в дубль:
   ```ts
   export type BotNotifyRoute = (input: { accountId: string; platform: PlatformId; silent: boolean }) => Promise<SendOutcome | null>;
   @Injectable() export class BotNotifyRoutes { register(kind: string, route: BotNotifyRoute): void; get(kind: string): BotNotifyRoute | undefined }
   ```
   - `notifications-bot.module.ts` — провайдер и `exports`;
   - `bot-notify-sender.ts` — `@Optional() routes?: BotNotifyRoutes`
     последним параметром;
   - после `claim` и решения о звуке, до `messenger.send`: маршрут есть и
     вернул исход → он и идёт в ленту и в `bot_message_sent`; вернул `null` →
     прежняя отправка T-0255.
   - Повтор задания маршрут не удваивает: карточка вида у игрока одна (ядро).
7. **`daily-card.module.ts`** — `DailyCardModule`:
   - импортирует `BotCardsModule`, `DailyModule`, `TasksModule`,
     `RunsModule` (пролог), `NotificationsBotModule`;
   - `onModuleInit`:
     - `BotCardKinds.register(createDailyCard(…))`;
     - `BotNotifyRoutes.register("daily_reward_ready", …)`: включены
       `bot.formats.enabled` и `bot.widget.daily.enabled` и площадка
       поддерживает вид → `BotCardsService.send({ accountId, kind: "daily", origin: "bot", silent })`;
       `sent` и `fallback` → `{ status: "sent" }`, `blocked` и `failed` — как
       есть, остальное → `null`;
   - события `daily_reward_claimed` и `task_completed` — через
     `EVENTS_SINK` по образцу `run-scorer` (`installId: "server"`, без
     игрока), сбой записи не роняет забор;
   - строка в `app.module.ts`.
8. **Таблицы:**
   - `bot-card-choices.ts` — `daily: { setting: "bot.reminders", byDefault: true }`;
   - `bot-card-commands.ts` — `{ command: "reward", kind: "daily", description: "Награда дня", descriptionEn: "Daily reward" }`.
9. **Настройка** — `setting-catalog.ts`, группа «Сообщения бота»:
   `botWidgetDailyEnabled` — `{ ...feature("bot.widget.daily.enabled", "Карточка «Награда дня»", "Напоминание о награде дня приходит карточкой, где награду и готовые задания дня можно забрать одним касанием. Работает, когда включены сообщения нового поколения; выключено — прежнее напоминание", () => null, true), group: BOT_MESSAGES_GROUP }`.

## Чего не трогаем

- `DailyService`, `TasksService`, `WalletService` — только вызывать. Своих
  начислений, ключей и проверок у карточки нет.
- Правила напоминаний T-0128 и картинки T-0255: окно, тихие часы, «Не
  напоминать», картинка на площадках без карточек.
- Партнёрские задания и задания недели — карточка забирает только дневные
  (`category === "daily"`).
- Ядро карточек и адаптер (T-0395, T-0396).

## Сценарий и интерфейс

1. **Утром, после 10:00 МСК**, игрок, который вчера заходил, получает
   напоминание. При включённой карточке это карточка «Награда дня»:
   - «День 3 из 7 · неделя 2», крупно «120 монет», кнопка «Забрать»;
   - строка «Готово заданий: 2 — 300 монет» и кнопка «Забрать задания»;
   - под сообщением — «▶ Играть» и «🔕 Не напоминать».
2. **«Забрать»** — кнопка «…», через секунду «+120 монет», затем «Забрано ✓ ·
   Завтра: 150 монет».
3. **Забрал в игре раньше** — касание в боте даёт «Уже забрано», вторая
   выплата не приходит.
4. **Пролог не пройден** — кнопок нет, строка «Награда откроется после
   пролога — пройди его в игре».
5. **В полночь по Москве** карточка закрывается («Карточка устарела»).
   `/reward` — новая карточка на сегодня.

Остальные состояния — флаги `moved`, `off`, `stale`, `x`, ошибка и лимит.
Старый клиент — подпись «Награда дня · день 3 из 7» и «▶ Играть».

## Тесты

Первым коммитом.

- `backend/api/test/daily-card.test.ts` (фейки сервисов, лимитера, часов,
  событий):
  - `state` на день 3 недели 2, не забрано, два готовых дневных задания и
    одно недельное → `d: 3, w: 2, cl: 0, tr: 2` и суммы только дневных;
    укладывается в 1024 байта;
  - `claim_daily`:
    - `ok` → результат с `g.c` и `cl: 1`, событие `daily_reward_claimed`
      `{ day: 3, week: 2, via: "bot" }`;
    - повтор → `already`, события нет;
    - `PrologueRequiredError` → `locked`;
    - лимит `daily` исчерпан → `limited`, `DailyService.claim` не вызван;
  - `claim_tasks`:
    - 7 готовых → забраны первые 5 по порядку и последовательно (следующий
      `claim` начинается после окончания предыдущего), 5 событий
      `task_completed` с `via: "bot"`;
    - второе касание → оставшиеся 2;
    - задание бросает `TaskNotDoneError` → пропущено, остальные забраны;
    - часы перешли 6 секунд после второго → забрано 2, ответ `ok` с `k: 2`;
    - ни одного → `already`;
  - маршрут `daily_reward_ready`:
    - включено и вид поддерживается → `send` с `kind: "daily"`,
      `origin: "bot"`, `silent` от отправителя, исход `sent`;
    - выключен `bot.widget.daily.enabled` → `null` (прежнее напоминание);
    - `send` → `off` → `null`;
  - `caption` и `plainTextOf(fallback(state))` — ровно ожидаемые строки,
    без слов «сгорит» и «последний»;
  - отрисовка `daily.html` (`renderWidget`):
    - «День 3 из 7», «120 монет», кнопка «Забрать», «Готово заданий: 2»;
    - `cl: 1` → «Забрано» и «Завтра»;
    - `lk: 1` → строка про пролог, кнопок `data-act` нет;
    - `click("claim_daily")` → запрос `v1:claim_daily`, ответ `res: "ok"` →
      «+120»;
    - ответ `already` → «Уже забрано»;
    - отказ `request` → «Не получилось»;
    - формы слов: 1 монета, 2 монеты, 5 монет;
    - в HTML нет «сгорит» и «последний шанс».
- `backend/api/test/daily-card.integration.test.ts` (живые Postgres и Redis,
  настоящие `DailyService`, `TasksService`, `WalletService`):
  - касание в боте и `POST /daily/claim` одновременно (`Promise.all`) — в
    журнале кошелька одна запись с ключом `daily_reward:<аккаунт>:<день>`,
    баланс вырос один раз;
  - два касания `claim_tasks` одновременно — каждое задание начислено один
    раз;
  - повтор касания — `already`;
  - пролог не пройден — `locked`, журнал кошелька пуст;
  - заблокированный аккаунт — ответ ядра `err: "auth"`, журнал пуст.
- `scripts/test/event-dictionary.test.ts` — `daily_reward_claimed` с
  `via: "bot"` и без него проходит, с `via: "game"` — нет; то же для
  `task_completed`.
- Существующие тесты награды дня, заданий и `notifications-bot.test.ts`
  проходят без правок.

## Аналитика

- `daily_reward_claimed` `{ day, week, via: "bot" }` и `task_completed`
  `{ task, period, kind, tier?, via: "bot" }` — серверные записи забора через
  карточку (новое необязательное поле `via`). Сначала `docs/22`, потом код.
- `bot_card_query` (`card: "daily"`, `action`: `refresh`, `claim_daily`,
  `claim_tasks`) и `bot_message_sent` (`kind: "daily_card"`) пишет ядро.
- Возврат — сессии со `start_ref = n-daily_card`.

## Настройки и окружение

- `bot.widget.daily.enabled` — вкл., группа «Сообщения бота»; действует при
  включённом `bot.formats.enabled`.
- Выбор игрока — `bot.reminders`, нового ключа нет.
- `docs/30-configuration-map.md`, строка 90: дописать, что лимиты карточки
  «Награда дня» — общие с игрой (`rl:daily:*`, `rl:tasks:*`).

## Документы

- `docs/22-analytics-and-metrics.md` §3.3 — шаг 2.
- `docs/30-configuration-map.md`, строка 90 — лимиты.

## Критерии приёмки

- [ ] «Забрать» в карточке начисляет `DailyService.claim` и
      `TasksService.claim` с их проверками и ключами; одновременный забор в
      боте и в игре даёт одну выплату (интеграционный тест).
- [ ] За касание — не больше 5 заданий, по очереди; после 6 секунд — ответ
      частичный.
- [ ] Лимиты частоты — общие с игрой; сверх лимита — `limited`, сервисы не
      вызваны.
- [ ] Напоминание «награда дня ждёт» при включённых ключах приходит
      карточкой; выключено или площадка без карточек — прежнее напоминание
      T-0255.
- [ ] Серверные `daily_reward_claimed` и `task_completed` несут `via: "bot"`;
      словарь, документ и клиентский список сходятся.
- [ ] В карточке нет покупок, «сгорит» и «последнего шанса»; `daily.html`
      проходит тест бюджета и отрисовки.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Карточка «Награда дня» — забрать в одно касание`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое [telegram]: напоминание о награде дня — карточкой, где награду и готовые задания дня можно забрать прямо в боте; прислать заново — /reward`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАРТОЧКА «НАГРАДА ДНЯ»**

  Напоминание о награде дня приходит живой карточкой: «Забрать» начисляет награду дня и до 5 готовых заданий дня прямо в боте — теми же сервисами и ключами, что в игре (Р199). Одновременный забор в боте и в игре даёт одну выплату.

  🛠 **Что внутри**

  • карточка показывает день недели, сегодняшнюю и завтрашнюю награду, число готовых заданий и их сумму
  • лимиты частоты — общие с игрой; пролог закрывает кнопки, как в игре
  • события daily_reward_claimed и task_completed с via: bot; команда /reward

  ⚙️ **Настройки**

  • панель → «Сообщения бота»: bot.widget.daily.enabled (вкл.; работает при включённом bot.formats.enabled)

  ❓ **Нужно от команды**

  • @владелец — подтвердить: задания на карточке — числом и суммой («Готово заданий: 3 — 450 монет»), без названий
  ```
