---
id: T-0408
title: Общая карточка «Вызов недели» для пересылки — за выключателем, пока Telegram не откроет её на проде
epic: E5
priority: P3
status: draft
owner:
author: claude-lead-1
size: M
depends_on: [T-0395, T-0396, T-0397]
zones:
  - backend/api/widgets/telegram/challenge.html
  - backend/api/src/modules/bot-cards/kinds/challenge-card.ts
  - backend/api/src/modules/bot-cards/kinds/challenge-card.module.ts
  - backend/api/test/challenge-card.test.ts
shared:
  - backend/api/src/platforms/ports/live-card.ts
  - backend/api/src/modules/bot-cards/bot-card-kinds.ts
  - backend/api/src/modules/bot-cards/bot-cards.service.ts
  - backend/api/src/modules/bot-cards/bot-cards.repository.ts
  - backend/api/src/platforms/telegram/telegram-live-cards.ts
  - backend/api/src/platforms/telegram/bot-card-commands.ts
  - backend/api/test/widget-render.ts
  - backend/api/test/widget-html-budget.test.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/app.module.ts
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
---

# T-0408. Общая карточка «Вызов недели» для пересылки — за выключателем, пока Telegram не откроет её на проде

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0408.json)](README.md#значки-статуса) [![T-0395](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0395.json&label=T-0395)](T-0395-live-cards-core.md) [![T-0396](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0396.json&label=T-0396)](T-0396-live-cards-telegram.md) [![T-0397](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0397.json&label=T-0397)](T-0397-season-card.md)

## Зачем

Карточки WP52 живут только в личке игрока: на проде Telegram защищает
отправленные виджеты от пересылки. Общий виджет (`is_shared`) — один объект
на сервере Telegram, как опрос. Его пересланные копии показывают одно живое
состояние. Карточка «Вызов недели» показывает:
- лучший результат игрока за неделю;
- верхушку недели;
- кнопку «Принять вызов»: друг по ней приходит в игру по ссылке друга игрока.

Код пишется заранее, за выключателем `bot.widget.shared.enabled` (умолчание —
выкл.). Владелец включает его, когда Telegram объявит пересылку виджетов на
проде (Р199, «Приглашения: что можно сейчас и что потом»).

**Статус `draft`, без пачки.** В `ready` задачу переводит тимлид, когда
Telegram откроет общие виджеты и их пересылку на проде (раздел «Если что-то
неясно»).

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52, «Приглашения: что можно сейчас и
  что потом»; задача № 16):
  - пересланная карточка показывает лучший результат пригласившего и живую
    верхушку недели;
  - касание «Принять вызов» приводит друга в игру по ссылке друга;
  - ключ `bot.widget.shared.enabled` — умолчание **выкл.**; действует, только
    когда включён `bot.formats.enabled`;
  - правило 8 — без покупок и предложений; отсчёт — только до настоящего
    конца недели;
  - правило 5 — подпись правдива без обновлений.
- **Факты Bot API 10.4** (`core.telegram.org/bots/widgets`, сверено тимлидом
  09.11.2026):
  - общий виджет создаёт первый `sendWidget` с `is_shared`. Код, размер и
    флаг запросов у всех копий общие. `public_data` — одно на все сообщения
    и пересылки;
  - менять `public_data` можно `editMessageWidgetData` по координатам
    оригинала **или** `editSharedWidgetData` по `widget_id`;
  - срок опроса (`cache_time`, 5–3600 с, при создании 30 с) задаёт только
    `editSharedWidgetData`;
  - открытая карточка получает новое общее состояние, только если вызвала
    `TelegramWidget.watchPublicData()`; событие — `publicDataChanged`;
  - **одно касание — один вызов**: `request`, `openLink`, `openTelegramLink`
    и `copyText` делят одно касание. Ссылку, полученную ответом на запрос,
    тем же касанием не открыть;
  - без `allow_queries` у карточки нет `viewer` и запросов;
  - на проде общие виджеты и пересылка виджетов пока не работают —
    только на тестовом сервере Telegram.
- **Решения тимлида (технические, отступления от плана WP52 № 16):**
  - **без запросов.** План предполагал «Принять вызов» через
    `shared_widget_query` и ответ ссылкой. По правилу «одно касание — один
    вызов» это стоило бы другу двух касаний. Ссылка друга — публичная
    по смыслу: та же, что под пересылаемым рекордом (T-0401). Поэтому она
    лежит в `public_data`, а «Принять вызов» сразу зовёт
    `openTelegramLink`. Карточка шлётся **без** `allow_queries`.
    `shared_widget_query` по-прежнему отвечается `{"v":1,"off":1}`
    (`widget-query.handler.ts`, T-0396) и не правится;
  - **ссылка — ссылка друга игры**, `AppLinks.launch(platform, f-<код>)`
    (`https://t.me/<бот>?startapp=f-<код>`), как у рекорда (T-0401), а не
    `?start=` бота: атрибуция `start_kind = friend` та же;
  - **ревизии в состоянии нет.** Ядро (T-0395) пропускает правку, если
    хэш состояния не изменился. Растущий счётчик делал бы новой каждую
    правку. Без запросов старое состояние приходит только опросом
    Telegram — мигание редкое и безвредное;
  - **верхушка недели** — первые три строки общей таблицы «Сложной», как на
    экране рейтинга: имя и число. Имена игроков рейтинга видны в игре всем;
  - **живая верхушка** — проход раз в 30 минут правит живые карточки вызова
    текущей недели через `touch` ядра. Правку прореживает ядро
    (`bot.widget.edit-min-minutes`), темп — общая очередь (5 в секунду).
    Свой забег игрока тоже правит его карточку;
  - **`cache_time` — 300 с**: сразу после отправки один вызов
    `editSharedWidgetData(widgetId, состояние, 300)`. Сбой — строка лога,
    карточка уже отправлена;
  - **выбора игрока нет**: карточка приходит только по команде `/challenge`,
    сама бот её не шлёт;
  - **«перенесена» и «закрыта» у общей карточки** видят и друзья. Карточка
    показывает «Этот вызов заменён новым» и «Неделя закрыта». Данные
    остаются, «Принять вызов» работает всегда: ссылка друга не истекает.

## Как сейчас

- После T-0395 (`modules/bot-cards/*`, `platforms/ports/live-card.ts`):
  - `LiveCardMessage { kind, state, caption, button, silent, topic? }`,
    `LiveCardPort.update(ref, state)`;
  - `BotCardKind` — `kind`, `enabled`, `choice`, `startRef`, `periodKey`,
    `state`, `finalState?`, `caption`, `fallback`, `act?`, `actions`;
  - `BotCardsService`:
    - `send` (кнопка — «▶ Играть» по `startRef`);
    - `touch` (правка через `card-edit` с прореживанием);
    - обработчики `card-edit`, `card-moved`, `card-final` зовут
      `port.update(ref, state)`;
  - `bot-cards.repository.ts` — `live`, `byMessage`, `openReplacing`,
    `touched`, `close`, `dueForFinal`; списка живых карточек вида и периода
    нет;
  - обычный образец лока прохода — `bot-cards.finalizer.ts`.
- После T-0396:
  - `TelegramLiveCards.send` — `sendWidget` с `chatData`,
    `allowQueries: true`, `protect: true`;
  - `update` — `editMessageWidgetData(…, { chatData })`;
  - тест бюджета обходит каталог `backend/api/widgets/telegram/` и требует у
    каждой карточки `chatData` и первым запрос `v1:r`;
  - помощник `test/widget-render.ts` — заглушка `TelegramWidget` без
    `publicData` и `watchPublicData`;
  - команды — строки `CARD_COMMANDS` (`bot-card-commands.ts`).
- После T-0393 — `TelegramWidgetApi`:
  - `sendWidget` → `{ messageId, widgetId }`, `WidgetSend.isShared`,
    `publicData`;
  - `editSharedWidgetData(widgetId, publicData, cacheTimeSec?)`.
- После T-0397:
  - `kinds/season-card.ts` — `rangeLabel(season)` («9–15 ноября»), образец
    вида и модуля с `RunsHooks.onRecorded`;
  - `SeasonsModule` экспортирует `SeasonSchedule` и `SeasonsViewService`;
  - `board(accountId, { difficulty: "hard", scope: "all" }, at)` →
    `BoardView` (`dto/seasons.dto.ts`, строки 82–113):
    - `entries[]` с `rank`, `name`, `points`, `survivalSec`;
    - `me: { rank, points, survivalSec } | null`;
    - `scoring`, `total`.
- Ссылка друга — `friends/friends.service.ts` `link(accountId)` →
  `{ code, startParam }`, строка 218 (`FriendsModule` экспортирует
  `FriendsService`). Ссылка запуска — `AppLinks.launch(platform, startParam)`.
- Имя игрока — `AccountRepository.byId(accountId).displayName`
  (`auth/account.repository.ts`, строка 196; `ACCOUNT_REPOSITORY`
  экспортирует `AuthModule`).

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **Порт и ядро — общая карточка** (по одному месту в файлах T-0395):
   - `live-card.ts`:
     - `LiveCardMessage` += `shared?: boolean` с комментарием «одно
       состояние на все копии и пересылки (общий виджет); без запросов»;
     - `update(ref, state, options?: { shared?: boolean })`;
   - `bot-card-kinds.ts` — `BotCardKind` += два необязательных поля:
     ```ts
     /** общая карточка: состояние видят все копии и пересылки */
     shared?: boolean;
     /** своя кнопка под карточкой вместо «▶ Играть» по `startRef`; `null` — без кнопки */
     buttonFor?(accountId: string, platform: PlatformId): Promise<{ text: string; url: string } | null>;
     ```
   - `bot-cards.service.ts`:
     - `send` кладёт `shared: kind.shared === true` в `LiveCardMessage`;
     - кнопку берёт из `kind.buttonFor`, если он задан. Он бросил →
       `null` и лог `card_button_failed` без данных игрока. Та же кнопка
       идёт в запасное сообщение;
     - обработчики `card-edit`, `card-moved`, `card-final` передают
       `{ shared: true }`, когда у вида `shared`;
     - `liveAccounts(kind, periodKey, limit)` → `string[]` — из репозитория;
   - `bot-cards.repository.ts` — `liveOf(kind, periodKey, limit)` →
     `{ accountId }[]`: живые (`closed_at IS NULL`) карточки вида с этим
     `period_key`, порядок по `updated_at`, таймаут 3 с.

   Остальные виды не меняются: поля необязательные.
3. **`telegram-live-cards.ts`:**
   - `send` при `message.shared`:
     - `sendWidget` с `isShared: true`, `publicData: message.state`, без
       `chatData`, `allowQueries: false`, `protect: false`; остальное — как
       у обычной;
     - после успеха, если `widgetId` не `null` —
       `editSharedWidgetData(widgetId, message.state, 300)`. Ошибка — лог
       `shared_cache_time_failed` с кодом, итог `sent` не меняется;
   - `update(ref, state, options)` при `options?.shared` —
     `editMessageWidgetData(ref.chatId, ref.messageId, { publicData: state })`;
     исходы те же.
4. **`kinds/challenge-card.ts`** — `createChallengeCard(deps): BotCardKind`.
   `deps`: `SeasonSchedule`, `Pick<SeasonsViewService, "board">`,
   `Pick<FriendsService, "link">`, `Pick<AccountRepository, "byId">`,
   `AppLinks`.
   - `kind: "challenge"`, `shared: true`, `startRef: "n-challenge_card"`,
     `actions: []`, `choice: null`;
   - `enabled: SETTINGS.botWidgetSharedEnabled`;
   - `periodKey(at)` → `schedule.current(at)?.key ?? null`;
   - `state(accountId, at)`:
     - сезона нет → `{ none: 1 }`;
     - иначе — состояние ниже. Ключи короткие: предел 1024 байта, а имена
       кириллицей — по 2 байта на знак.
       ```ts
       {
         k: season.key,
         r: rangeLabel(season),                     // из season-card.ts
         sc: board.scoring,                         // "points" | "time"
         nm: cut(displayName, 24),                  // имя игрока, как в игре
         p: board.me?.rank ?? null,
         n: board.total,
         b: valueOf(board.me),                      // очки или секунды по sc
         t: board.entries.slice(0, 3).map((e) => ({ n: cut(e.name, 16), b: valueOf(e) })),
         e: Math.floor(season.endsAt.getTime() / 1000),
         u: friendUrl,                              // ссылка друга или null
       }
       ```
     - `cut(s, max)` — до `max` знаков с «…»;
     - `valueOf` — `points` при `sc === "points"`, иначе `survivalSec`;
     - `friendUrl`: `link(accountId)` → `AppLinks.launch("telegram", startParam)`;
       бросил или `null` → `null`, лог `challenge_link_failed`;
   - `buttonFor(accountId, platform)` — `{ text: "▶ Принять вызов", url }`,
     где `url` — `AppLinks.launch(platform, (await link(accountId)).startParam)`;
     нет ссылки — `null`;
   - `caption(state)`:
     - `Вызов недели ${r} от ${nm} · неделя до пн, 03:00 по Москве`;
     - `none` → «Сезон рейтинга ещё не начался»;
   - `fallback(state)` — `RichDocument` для площадки без карточек:
     - заголовок `Вызов недели от ${nm}`;
     - абзац `Место ${p} из ${n} · очки ${b}` (или `· лучшее ${м:сс}`); без
       места — «Пока без места на «Сложной»»;
     - список «Верхушка недели» — до трёх строк `${n} — ${b}`;
     - абзац «Неделя закончится » и `dateTime`
       (`unix: e`, `format: "wDT"`, `fallback: "в понедельник, 03:00 по Москве"`).
5. **`challenge.html`** — правила T-0396 (шаг 5) с отличиями общей
   карточки. Бюджет — 3 300 байт после сжатия.
   - Состояние:
     - `JSON.parse(TelegramWidget.publicData)` в `try`;
     - первой строкой скрипта — `TelegramWidget.watchPublicData()`;
     - `TelegramWidget.onEvent("publicDataChanged", draw)`;
     - **запросов нет**: `request` не вызывается.
   - Что на карточке:
     - сверху мелко — «Вызов недели · {r}»;
     - крупно — «{nm}», под ним «место {p} из {n}» и «очки 1 240» или
       «лучшее 7:42»; без места — «пока без места»;
     - «Верхушка недели» — до трёх строк «1. {n} — {b}»;
     - отсчёт «до конца недели 2 д 5 ч» (`setInterval` раз в 60 000 мс) и
       «закончится {день}, {чч:мм}» в языке и поясе читателя — как у
       `season.html`;
     - кнопка `<button data-act="accept">Принять вызов</button>` →
       `TelegramWidget.openTelegramLink(u)`, только если `u` — строка,
       начинающаяся с `https://t.me/`. Иначе кнопки нет.
   - Флаги:
     - `moved` → строка «Этот вызов заменён новым», данные и кнопка
       остаются;
     - `x` или `e` в прошлом → «Неделя закрыта: {nm} — место {p} из {n}»,
       кнопка остаётся;
     - `off` и `stale` — как у пробы;
     - `none` → «Сезон рейтинга ещё не начался».
   - Числа — с пробелом между тысячами (`toLocaleString(navigator.language)`).
   - Тона — `--tg-theme-accent-text-color` для места,
     `--tg-theme-button-color` и `--tg-theme-button-text-color` для кнопки.
6. **`widget-render.ts` и `widget-html-budget.test.ts`:**
   - `renderWidget(html, { chatData?, publicData?, … })` → += `watched: () => boolean`
     (вызывался ли `watchPublicData`) и `opened: string[]` (адреса
     `openTelegramLink`). В заглушке — `publicData`, `watchPublicData`,
     `unwatchPublicData`;
   - тест бюджета — `SHARED_CARDS = new Set(["challenge"])` с комментарием
     «общая карточка: состояние в publicData, без запросов (T-0408)». Для
     них:
     - состояния подаются через `publicData`;
     - вместо «первым ушёл `v1:r`» — `requests` пуст и `watched()` истинно;
     - остальные проверки — те же.
7. **`challenge-card.module.ts`** — `ChallengeCardModule`:
   - импортирует `BotCardsModule`, `SeasonsModule`, `RunsModule`,
     `FriendsModule`, `AuthModule`;
   - `onModuleInit` — `BotCardKinds.register(createChallengeCard(…))` и
     `RunsHooks.onRecorded("challenge-card", …)`. Забег засчитан по тем же
     условиям, что у `season-card` → `touch(accountId, "challenge")`.
     Сбой — лог `challenge_card_hook_failed`. Без входа игроков
     (`auth.enabled` выкл.) — ничего;
   - `onApplicationBootstrap` — проход раз в 30 минут
     (`REFRESH_MS = 1_800_000`):
     - ничего, если выключен `bot.formats.enabled` или ключ вида;
     - лок `bot-cards:challenge:refresh:lock` (`SET NX PX 600000` с
       токеном, снятие скриптом — как у финализатора T-0395);
     - `liveAccounts("challenge", periodKey(now), 500)` → `touch` каждому.
       `touch` сам решает, нужна ли правка;
   - `onModuleDestroy` — снять таймер;
   - строка модуля в `app.module.ts`.
8. **`bot-card-commands.ts`** — строка
   `{ command: "challenge", kind: "challenge", description: "Вызов недели для друзей", descriptionEn: "Weekly challenge for friends" }`.
   В меню она появляется только при включённых ключах (T-0396).
9. **`setting-catalog.ts`**, группа `BOT_MESSAGES_GROUP`:
   `botWidgetSharedEnabled` —
   `{ ...feature("bot.widget.shared.enabled", "Общая карточка «Вызов недели»", "Карточку, которую игрок пересылает друзьям: его результат недели, верхушка недели и «Принять вызов». Включать, когда Telegram откроет пересылку виджетов на проде. Работает, когда включены сообщения нового поколения", () => null, false), group: BOT_MESSAGES_GROUP }`.
10. **`docs/30-configuration-map.md`**, строка 90 — лок
    `bot-cards:challenge:refresh:lock`, проход раз в 30 минут,
    `cache_time` общей карточки 300 с, команда `/challenge`.

## Чего не трогаем

- `widget-query.handler.ts` — `shared_widget_query` остаётся
  `{"v":1,"off":1}`.
- Карточки «Сезон», «Награда дня», «Приглашения» и их HTML.
- `sendSharedWidget` и инлайн-режим — сценариев нет.
- Рефералка и ссылка друга: только чтение `FriendsService.link`.
- Перевод задачи в `ready` и пачку — решает тимлид по факту открытия на
  проде.

## Сценарий и интерфейс

Ключи `bot.formats.enabled` и `bot.widget.shared.enabled` включены, Telegram
разрешает пересылку виджетов.

1. Игрок пишет боту `/challenge` — приходит карточка «Вызов недели · 9–15
   ноября»:
   - его имя, место и очки;
   - верхушка недели;
   - отсчёт до конца недели;
   - «Принять вызов».

   Под карточкой — кнопка «▶ Принять вызов».
2. Игрок пересылает карточку другу. У друга — та же живая карточка: место
   игрока и верхушка меняются вместе с оригиналом.
3. Друг нажимает «Принять вызов» — открывается игра по ссылке друга игрока.
4. Игрок сыграл лучше — карточка у него и у всех друзей обновилась (не
   чаще раза в 10 минут, опрос Telegram — раз в 5 минут).
5. Понедельник 03:00 МСК — «Неделя закрыта: {имя} — место 14 из 230»,
   кнопка работает.
6. Повторная `/challenge` — новая карточка; старая и её пересылки — «Этот
   вызов заменён новым».

Состояния:
- ключ выключен — `/challenge` нет в меню, набранная — «Карточки сейчас
  выключены…» (T-0396);
- сезона нет — «Сезон рейтинга ещё не начался»;
- без места — «пока без места»;
- нет ссылки друга — кнопки нет ни в карточке, ни под ней;
- клиент без виджетов — подпись и кнопка «▶ Принять вызов»;
- MAX и VK — оформленное сообщение с той же кнопкой, без обновлений.

## Тесты

Первым коммитом.

- `backend/api/test/challenge-card.test.ts`:
  - `state`:
    - доска `me: { rank: 14 }`, `total: 230`, три строки → поля `nm`, `p`,
      `n`, `b`, `t` из трёх, `u` = `https://t.me/bot?startapp=f-ABC`;
    - имя из 40 знаков → 24 с «…», имена верхушки → 16;
    - имена по 32 знака кириллицей у всех → `encodeState` не бросает
      (≤ 1024 байт);
    - сезона нет → `{ none: 1 }`;
    - `link` бросает → `u: null`;
  - `buttonFor` → `{ text: "▶ Принять вызов", url: "https://t.me/bot?startapp=f-ABC" }`;
    `link` бросает → `null`;
  - `caption` — «Вызов недели 9–15 ноября от Аня · неделя до пн, 03:00 по
    Москве»;
  - `plainTextOf(fallback(state))` содержит имя, «Место 14 из 230» и три
    строки верхушки;
  - ядро:
    - `BotCardsService.send` вида `challenge` → `port.send` с
      `shared: true` и кнопкой из `buttonFor`; `buttonFor` бросил → кнопка
      `null`, итог `sent`;
    - `card-edit` → `port.update(ref, state, { shared: true })`;
    - вид без `shared` → `update` без опций (обычные карточки не меняются);
  - `TelegramLiveCards`:
    - `send` с `shared` → `sendWidget` с `isShared: true`,
      `publicData = state`, без `chatData`, `allowQueries: false`,
      `protect: false`; затем `editSharedWidgetData("w1", state, 300)`;
    - `editSharedWidgetData` бросает → итог `sent`, лог
      `shared_cache_time_failed`;
    - `update(…, { shared: true })` → `editMessageWidgetData` с
      `publicData`;
  - проход:
    - лок занят → `touch` не зван;
    - две живые карточки → `touch` дважды;
    - ключ выключен → `liveAccounts` не зван;
  - слушатель забега: рейтинговый на «Сложной» → `touch`; пролог → нет.
- `backend/api/test/widget-html-budget.test.ts` — `challenge.html` проходит
  все проверки общей карточки (шаг 6). Существующие карточки — как были.
- В `challenge-card.test.ts` через `renderWidget` с `publicData`:
  - `click("accept")` → `opened` = `["https://t.me/bot?startapp=f-ABC"]`;
  - `u: "https://evil.example/"` → кнопки нет, `opened` пуст;
  - `u: null` → кнопки нет;
  - `x: 1` → «Неделя закрыта», кнопка есть;
  - `moved: 1` → «Этот вызов заменён новым»;
  - имя `<img src=x onerror=1>` выводится текстом.
- `backend/api/test/telegram-live-cards.test.ts`,
  `backend/api/test/bot-cards.test.ts` — существующие, зелёные без правок.

## Аналитика

- `bot_message_sent` (T-0394) — `kind: "challenge_card"`, `format: "card"`
  или запасной `rich` / `text`: пишет ядро.
- Друг по кнопке — существующие `referral_bound` и сессия с
  `start_kind = friend`. Новых событий нет: касание «Принять вызов» бот не
  видит, запросов у карточки нет.
- `bot_card_query` у этой карточки не бывает.

## Настройки и окружение

- `bot.widget.shared.enabled` — выкл., группа «Сообщения бота»; работает при
  включённом `bot.formats.enabled`.
- Лок Redis `bot-cards:challenge:refresh:lock` (10 минут).
- Переменных окружения нет.

## Документы

- `docs/30-configuration-map.md`, строка 90 — шаг 10.

## Критерии приёмки

- [ ] `/challenge` при включённых ключах присылает общую карточку: имя,
      место, очки, верхушка недели, отсчёт, «Принять вызов».
- [ ] Карточка уходит с `is_shared`, состоянием в `public_data`, без
      `allow_queries` и защиты; `cache_time` — 300 с.
- [ ] «Принять вызов» открывает только `https://t.me/…` из состояния; кнопка
      под сообщением — та же ссылка друга.
- [ ] Свой забег и проход раз в 30 минут правят карточку через ядро, с
      прореживанием; финал недели и «заменён новым» видны и в пересылках.
- [ ] Обычные карточки ведут себя как до задачи: новые поля порта и вида
      необязательные.
- [ ] На MAX и VK — оформленное сообщение с той же кнопкой.
- [ ] Ключ выключен по умолчанию; гейт (`CLAUDE.md`) и `pnpm docs:check`
      зелёные.

## PR

- **Заголовок:** `feat(bot): Общая карточка «Вызов недели»`
- **Метка:** `release: minor`
- **Для игроков:** пока ключ выключен — ничего. Строку добавить в журнал при
  включении: `- новое [telegram]: /challenge — карточка «Вызов недели»: перешли её друзьям, и по «Принять вызов» они придут в игру от тебя`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОБЩАЯ КАРТОЧКА «ВЫЗОВ НЕДЕЛИ»**

  Заранее написана карточка, которую игрок пересылает друзьям: его место и очки недели, верхушка недели, отсчёт до конца недели и «Принять вызов» — друг приходит в игру по ссылке друга игрока (Р199). Пересланные копии живые: бот правит одну карточку, меняются все.

  🛠 **Что внутри**

  • общий виджет Telegram без запросов: ссылка друга лежит в карточке, «Принять вызов» открывает её одним касанием
  • правки — со своим забегом и раз в 30 минут, не чаще раза в 10 минут на карточку
  • на MAX и VK — оформленное сообщение с той же кнопкой

  ⚙️ **Настройки**

  • панель → «Сообщения бота»: bot.widget.shared.enabled (выкл.) — включать, когда Telegram откроет пересылку виджетов на проде

  ❓ **Нужно от команды**

  • @владелец — когда Telegram объявит пересылку виджетов на проде: включить ключ на деве, прислать себе /challenge, переслать с другого аккаунта и нажать «Принять вызов»
  ```
