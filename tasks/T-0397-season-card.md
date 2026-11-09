---
id: T-0397
title: Карточка «Сезон» в личке бота — место, очки и отсчёт до конца недели
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0395, T-0396]
zones:
  - backend/api/widgets/telegram/season.html
  - backend/api/src/modules/bot-cards/kinds/season-card.ts
  - backend/api/src/modules/bot-cards/kinds/season-card.module.ts
  - backend/api/test/season-card.test.ts
shared:
  - backend/api/src/modules/bot-cards/bot-card-choices.ts
  - backend/api/src/platforms/telegram/bot-card-commands.ts
  - backend/api/src/modules/seasons/seasons.module.ts
  - backend/api/src/modules/account-settings/account-settings.catalog.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/app.module.ts
  - packages/app-shell/src/state/bot-notifications.ts
  - packages/app-shell/src/state/account-settings.ts
  - packages/app-shell/src/i18n/ru-bot.json
  - packages/app-shell/test/bot-notifications.test.ts
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0397. Карточка «Сезон» в личке бота — место, очки и отсчёт до конца недели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0397.json)](README.md#значки-статуса) [![T-0395](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0395.json&label=T-0395)](T-0395-live-cards-core.md) [![T-0396](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0396.json&label=T-0396)](T-0396-live-cards-telegram.md)

## Зачем

Игрок, сыгравший на неделе, получает в личке бота живую карточку сезона:
- своё место «из скольких»;
- очки (или лучшее время, если неделя по времени);
- отсчёт до настоящего конца недели и кнопка «▶ Играть» под ней.

Карточка обновляется сама и закрывается с концом недели. Цель — вернуть в
игру того, кого обогнали, без лишних сообщений (Р199, сценарий
«Карточка „Сезон“»).

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52):
  - сценарий «Карточка „Сезон“» — место, очки, отсчёт до конца недели,
    обновляется сама, «▶ Играть» под ней;
  - на MAX и VK — сообщение с местом на момент отправки, без обновлений;
  - аналитика — `bot_message_sent` (`kind: season_card`), `bot_card_query`,
    возврат — `n-season_card`;
  - ключ панели — `bot.widget.season.enabled`, выбор игрока — `bot.seasonCard`.
- **Правила WP52:**
  - правило 6 — карточку по первому забегу недели вызвал сам игрок, поэтому
    без звука; повторная `/season` переводит прежнюю в «перенесена ниже»;
  - правило 5 — подпись правдива без обновлений: «Сезон 9–15 ноября ·
    неделя до пн, 03:00 по Москве»;
  - правило 8 — в карточке нет покупок и предложений; отсчёт — только до
    настоящего конца недели.
- **Решения тимлида (по Р199, технические):**
  - **номера сезона нет** (`seasons/season-rules.ts`: ключ — дата
    понедельника), поэтому сезон называется датами, как в игре:
    `seasonRangeLabel` клиента — «9–15 ноября», на стыке месяцев —
    «28 декабря – 3 января»;
  - **доска — «Сложная»** (единственная рейтинговая, Р126), общая таблица
    (`scope: "all"`): место и размер — из `SeasonsViewService.board`, как на
    экране рейтинга;
  - **автоматически карточка приходит один раз в неделю** — с первым
    засчитанным забегом недели на «Сложной». Дальше забеги только правят её.
    Удалённую игрок вернёт командой `/season`;
  - выбор игрока по умолчанию **включён**, как у напоминаний: писать можно
    только тому, кто разрешил боту, и карточка одна в неделю.

## Как сейчас

- После T-0395:
  - контракт вида `BotCardKind` и реестр `BotCardKinds` —
    `modules/bot-cards/bot-card-kinds.ts`;
  - `BotCardsService.sendLater` и `touch`;
  - выбор игрока — `bot-card-choices.ts`;
  - финал периода — ядро: последнее состояние с `x: 1`.
- После T-0396:
  - HTML карточек — `backend/api/widgets/telegram/<вид>.html`, правила
    карточки — T-0396, шаг 5;
  - помощник отрисовки `test/widget-render.ts`, тест бюджета обходит каталог
    сам;
  - команды — строки `CARD_COMMANDS` в `platforms/telegram/bot-card-commands.ts`.
- Сезон:
  - `seasons/seasons-schedule.ts` `SeasonSchedule.current(at)` → `Season | null`
    (`key`, `startsAt`, `endsAt`);
  - `seasons/seasons-view.service.ts` `board(accountId, { difficulty, scope }, at)`
    → `BoardView`: `scoring`, `total`, `me: { rank, points, survivalSec } | null`
    (`dto/seasons.dto.ts`, строки 103–111);
  - `SeasonsModule` экспортирует `SeasonSchedule`, но не
    `SeasonsViewService` (`seasons.module.ts`, строка 45);
  - неделя — по UTC, конец — понедельник 00:00 UTC (03:00 МСК).
- Забег записан — `runs/runs-hooks.ts` `RunsHooks.onRecorded(name, listener)`:
  `RecordedRun` с `ranked`, `difficulty`, `mode`, `cheats`, `verdict`; только
  первая запись забега.
- Выбор игрока в боте:
  - сервер — `account-settings/account-settings.catalog.ts` (`bot.reminders` —
    образец);
  - клиент — `app-shell/src/state/bot-notifications.ts` (`BOT_NOTIFY_DEFAULTS`,
    `BOT_NOTIFY_ACCOUNT_KEYS`, `BOT_NOTIFY_KEYS`, схема, `readStored`,
    `persist`), `state/account-settings.ts` (две ветки `switch`, строки
    203–210 и 231–238), тексты — `i18n/ru-bot.json`;
  - экран настроек (`screens/settings.tsx`, строка 192) рисует переключатели
    по `BOT_NOTIFY_KEYS` сам.
- Даты сезона на клиенте — `app-shell/src/screens/meta/rating-rules.ts`
  `seasonRangeLabel` (строки 56–68). Бэкенд пакеты клиента не импортирует.

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **`modules/bot-cards/kinds/season-card.ts`** — `createSeasonCard(deps): BotCardKind`,
   где `deps` — `SeasonSchedule`, `Pick<SeasonsViewService, "board">` и
   настройки.
   - `kind: "season"`, `startRef: "n-season_card"`, `actions: []`.
   - `enabled: SETTINGS.botWidgetSeasonEnabled`.
   - `choice: { setting: "bot.seasonCard", byDefault: true }`.
   - `periodKey(at)` → `schedule.current(at)?.key ?? null`.
   - `state(accountId, at)`:
     - сезона нет → `{ none: 1 }`;
     - иначе `board(accountId, { difficulty: "hard", scope: "all" }, at)` →
       `{ k: season.key, r: rangeLabel(season), sc: board.scoring, p: me?.rank ?? null, n: board.total, b: sc === "points" ? me?.points ?? null : me?.survivalSec ?? null, e: endsAt в секундах }`.
     Состояние короткое: ключи в одну букву, предел 1024 байта.
   - `rangeLabel(season)` — копия правила `seasonRangeLabel` клиента: даты
     по UTC, конец — сутками раньше `endsAt`, месяц в родительном падеже
     (`Intl.DateTimeFormat("ru", { day: "numeric", month: "long", timeZone: "UTC" })`).
     Комментарий — откуда правило: бэкенд пакеты клиента не импортирует.
   - `caption(state)`:
     - есть сезон → `Сезон ${r} · неделя до пн, 03:00 по Москве`;
     - `none` → «Сезон рейтинга ещё не начался».
   - `fallback(state)` — `RichDocument`:
     - заголовок `Сезон ${r}`;
     - абзац — `Ты на ${p}-м месте из ${n} · очки ${b}` (или
       `· лучшее ${м:сс}`), без места — «Пока без места — сыграй на
       «Сложной», и место появится»;
     - абзац — «Неделя закончится » и `dateTime` (`unix: e`,
       `format: "wDT"`, `fallback: "в понедельник, 03:00 по Москве"`).
     Числа — с пробелом между тысячами.
3. **`season.html`** — по правилам T-0396, шаг 5, бюджет 3 300 байт после
   сжатия. Что на карточке:
   - сверху мелко — «Сезон {r}»;
   - крупно — место «14», рядом «из 230»; без места — «Пока без места» и
     строка «Сыграй на «Сложной» — и место появится»;
   - строка «очки 1 240» или «лучшее 7:42» (по `sc`);
   - отсчёт «до конца недели 2 д 5 ч», меньше суток — «5 ч 12 мин»;
     обновляется `setInterval` раз в 60 000 мс;
   - строка «закончится {день недели}, {чч:мм}» в поясе и языке читателя
     (`toLocaleString(navigator.language, { weekday: "short", hour: "2-digit", minute: "2-digit" })`);
   - `e` в прошлом или флаг `x` → «Неделя закрыта: место {p} из {n}. Итог —
     в игре»;
   - `none` → «Сезон рейтинга ещё не начался»;
   - флаги `moved`, `off`, `stale` — как у пробы;
   - кнопок внутри нет: «▶ Играть» — клавиатура под сообщением;
   - фоновый запрос `v1:r` первой строкой; ответ рисуется поверх
     состояния, ответ с `err` — не стирает его;
   - тона — `--tg-theme-accent-text-color` для места, `--tg-theme-hint-color`
     для подписей; без анимаций, кроме короткого появления, которое гасит
     `prefers-reduced-motion`.
4. **`season-card.module.ts`** — `SeasonCardModule`:
   - импортирует `BotCardsModule`, `SeasonsModule`, `RunsModule`;
   - в `onModuleInit` — `BotCardKinds.register(createSeasonCard(…))` и
     `RunsHooks.onRecorded("season-card", …)`. Без входа игроков
     (`auth.enabled` выкл.) — ничего;
   - слушатель:
     - забег засчитан, если `ranked`, `difficulty === "hard"`,
       `mode !== "prologue"`, нет `cheats` и `verdict !== "rejected"`;
     - `SET NX EX 691200` ключа `bot-card:season:auto:<аккаунт>:<ключ сезона>`
       занял → `sendLater({ origin: "player" })`, иначе `touch(accountId, "season")`;
     - сбой — лог `season_card_hook_failed` без данных игрока; запись забега
       не страдает;
   - строка модуля в `app.module.ts`.
   - `seasons.module.ts` — `SeasonsViewService` в `exports`.
5. **Регистрация вида в общих таблицах:**
   - `bot-card-choices.ts` — `season: { setting: "bot.seasonCard", byDefault: true }`;
   - `bot-card-commands.ts` — `{ command: "season", kind: "season", description: "Карточка сезона", descriptionEn: "Season card" }`;
   - `account-settings.catalog.ts` — `"bot.seasonCard": { schema: z.boolean(), merge: "latest" }`
     с комментарием «живая карточка сезона в боте (Р199)».
6. **Настройка панели** — `setting-catalog.ts`, группа «Сообщения бота»:
   `botWidgetSeasonEnabled` — `{ ...feature("bot.widget.season.enabled", "Карточка «Сезон»", "Живая карточка недели в личке бота: место, очки, отсчёт. Работает, когда включены сообщения нового поколения", () => null, true), group: BOT_MESSAGES_GROUP }`.
7. **Клиент** — переключатель «Карточка сезона»:
   - `bot-notifications.ts`:
     - `BOT_NOTIFY_DEFAULTS.seasonCard = true`;
     - `BOT_NOTIFY_ACCOUNT_KEYS.seasonCard = "bot.seasonCard"`;
     - `BOT_NOTIFY_KEYS` += `seasonCard` (после `reminders`);
     - схема — `seasonCard: z.optional(z.boolean())`;
     - `readStored` и `persist` — с умолчанием, как у `reminders`;
   - `account-settings.ts` — ветки `bot.seasonCard` в обоих `switch`;
   - `ru-bot.json` — `"settings.bot.seasonCard": "Карточка сезона в боте"`.
   Экран настроек правки не требует: список строится по `BOT_NOTIFY_KEYS`.

## Чего не трогаем

- `seasons/seasons-close.service.ts` и итог сезона — T-0256 и WP52 № 10.
- Напоминания «тебя обогнали» и «сезон закрывается» (T-0128, T-0255): карточка
  их не заменяет и не отключает.
- Ядро карточек и адаптер (T-0395, T-0396) — только регистрация вида и строки
  таблиц.
- `screens/settings.tsx` — не нужен (шаг 7).

## Сценарий и интерфейс

Игрок в Telegram:
1. **Первый засчитанный забег недели** на «Сложной». Бот без звука присылает
   карточку:
   - «Сезон 9–15 ноября», крупно «14 из 230», «очки 1 240»;
   - «до конца недели 2 д 5 ч», «закончится пн, 03:00» в его поясе;
   - под ней кнопка «▶ Играть».
2. **Открыл чат** — карточка сама спросила бота и показала свежее место.
3. **Следующие забеги** правят карточку не чаще раза в 10 минут.
4. **`/season`** — новая карточка, прежняя показывает «Карточка перенесена
   ниже».
5. **Понедельник 03:00 МСК** — карточка показывает «Неделя закрыта: место 14
   из 230. Итог — в игре» и больше не меняется.

Состояния:
- нет места;
- сезонов нет;
- выключено (`off`);
- устарело (`stale`, сверх лимита);
- перенесена (`moved`);
- закрыта (`x`);
- старый клиент — подпись «Сезон 9–15 ноября · неделя до пн, 03:00 по
  Москве» и кнопка «▶ Играть».

На MAX и VK — сообщение простым текстом с местом на момент отправки.

## Тесты

Первым коммитом.

- `backend/api/test/season-card.test.ts`:
  - `state`, сезон по очкам (фейковая доска: `me.rank` 14, `total` 230,
    `points` 1240) → `{ k: "2026-11-09", r: "9–15 ноября", sc: "points", p: 14, n: 230, b: 1240, e: <секунды 2026-11-16T00:00Z> }`;
  - сезон по времени → `b` равно `survivalSec`; без `me` → `p: null, b: null`;
    без сезона → `{ none: 1 }`;
  - `encodeState(state)` укладывается в 1024 байта;
  - `rangeLabel`: 2026-11-09 → «9–15 ноября»; 2026-12-28 → «28 декабря –
    3 января»;
  - `caption` — ровно «Сезон 9–15 ноября · неделя до пн, 03:00 по Москве»;
  - `plainTextOf(fallback(state))` — ровно ожидаемая строка с местом,
    очками и «в понедельник, 03:00 по Москве»;
  - слушатель забегов (фейки `BotCardsService`, Redis):
    - первый засчитанный забег недели → `sendLater` с `origin: "player"` один
      раз;
    - второй → `touch`;
    - пролог, `easy`, не `ranked`, `cheats`, `verdict: "rejected"` → ничего;
    - следующая неделя → снова `sendLater`;
    - `sendLater` бросает → лог, исключения наружу нет;
  - регистрация:
    - `BotCardKinds.get("season")` есть после `onModuleInit`;
    - `CARD_COMMANDS` содержит `season`;
    - `BOT_CARD_CHOICES.season` — `{ setting: "bot.seasonCard", byDefault: true }`;
    - `SeasonsModule` экспортирует `SeasonsViewService`;
  - отрисовка `season.html` через `renderWidget`:
    - состояние выше → в `app()` есть «14», «из 230», «1 240», «до конца
      недели»;
    - `sc: "time"`, `b: 462` → «7:42»;
    - `p: null` → «Пока без места»;
    - `e` в прошлом → «Неделя закрыта»;
    - `none` → «ещё не начался»;
    - `setInterval` зарегистрирован с 60 000;
    - первый запрос — `v1:r`;
    - ответ `{ "v": 1, "err": "limited" }` не стирает место.
  - Бюджет и запреты `season.html` проверяет `widget-html-budget.test.ts`
    (T-0396) без правок.
- `packages/app-shell/test/bot-notifications.test.ts`:
  - список `BOT_NOTIFY_KEYS` с `seasonCard` в конце;
  - умолчание `true`, ключ `bot.seasonCard`;
  - сохранённый до задачи выбор без поля → умолчание.
- `scripts/test/account-settings-keys.test.ts` (кейс T-0395 по
  `BOT_CARD_CHOICES`) проходит со строкой `season`.

## Аналитика

Новых событий нет. Пишет ядро:
- `bot_message_sent` с `kind: "season_card"`, `format: "card"` (на MAX и VK —
  `rich` или `text`);
- `bot_card_query` с `card: "season"`, `action: "refresh"`.

Возврат — сессии со `start_ref = n-season_card`. Выключение выбора игрока —
`settings_changed` (`setting: "bot.seasonCard"`) — шлёт клиент сам.

## Настройки и окружение

- `bot.widget.season.enabled` — вкл., группа «Сообщения бота»; действует при
  включённом `bot.formats.enabled`. Строка 90 `docs/30-configuration-map.md`
  его уже называет.
- Ключ аккаунта `bot.seasonCard` (умолчание — вкл.).
- Ключ Redis `bot-card:season:auto:<аккаунт>:<сезон>` (8 суток).

## Документы

- `docs/30-configuration-map.md`, строка 90 — ключ Redis
  `bot-card:season:auto:*`. Файл — в `shared` по правилу «Общие файлы»,
  одна вставка в строку.

## Критерии приёмки

- [ ] Первый засчитанный забег недели на «Сложной» присылает карточку без
      звука один раз в неделю; следующие забеги правят её через ядро.
- [ ] `/season` присылает карточку, прежняя становится «перенесена ниже».
- [ ] Карточка показывает место, размер доски, очки или время, отсчёт до
      понедельника 00:00 UTC и время конца в поясе читателя; после конца
      недели — «Неделя закрыта».
- [ ] Подпись — «Сезон … · неделя до пн, 03:00 по Москве»; на MAX и VK —
      простой текст с местом.
- [ ] Переключатель «Карточка сезона в боте» в настройках игры, ключ
      `bot.seasonCard`, умолчания клиента и сервера совпадают.
- [ ] `season.html` проходит тест бюджета и отрисовки.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Карточка «Сезон» в личке бота`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое [telegram]: живая карточка сезона в личке бота — место, очки и время до конца недели; прислать заново — /season`
  - `- новое: в настройках — переключатель «Карточка сезона в боте»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАРТОЧКА «СЕЗОН» В БОТЕ**

  С первым засчитанным забегом недели бот без звука присылает живую карточку сезона: место из скольких, очки, отсчёт до конца недели. Карточка обновляется сама и закрывается в понедельник в 03:00 по Москве (Р199).

  🛠 **Что внутри**

  • команда /season — карточка заново, прежняя «перенесена ниже»
  • в настройках игры — переключатель «Карточка сезона в боте» (по умолчанию вкл.)
  • на MAX и VK — сообщение простым текстом

  ⚙️ **Настройки**

  • панель → «Сообщения бота»: bot.widget.season.enabled (вкл.; работает при включённом bot.formats.enabled)

  ❓ **Нужно от команды**

  • @владелец — посмотреть карточку на деве в светлой и тёмной теме и в старом клиенте, потом включать bot.formats.enabled
  ```
