---
id: T-0396
title: Живые карточки в Telegram — виджеты, загрузка и бюджет HTML, приём запросов и команды карточек
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0393, T-0395]
zones:
  - backend/api/src/platforms/telegram/telegram-live-cards.ts
  - backend/api/src/platforms/telegram/telegram-widget-html.ts
  - backend/api/src/platforms/telegram/widget-query.handler.ts
  - backend/api/src/platforms/telegram/bot-card.command.ts
  - backend/api/widgets/telegram/_probe.html
  - backend/api/test/telegram-live-cards.test.ts
  - backend/api/test/widget-query.handler.test.ts
  - backend/api/test/bot-card.command.test.ts
  - backend/api/test/widget-html-budget.test.ts
  - backend/api/test/widget-render.ts
shared:
  - backend/api/src/platforms/telegram/bot-card-commands.ts
  - backend/api/src/platforms/telegram/telegram-messenger.ts
  - backend/api/src/platforms/platforms.module.ts
  - backend/api/src/app.module.ts
  - backend/api/Dockerfile
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0396. Живые карточки в Telegram — виджеты, загрузка и бюджет HTML, приём запросов и команды карточек

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0396.json)](README.md#значки-статуса) [![T-0393](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0393.json&label=T-0393)](T-0393-bot-api-v10-layer.md) [![T-0395](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0395.json&label=T-0395)](T-0395-live-cards-core.md)

## Зачем

Ядро карточек (T-0395) говорит с площадкой через порт `LiveCardPort`. Задача
делает его реализацию в Telegram:
- карточка — виджет Bot API 10.4 с состоянием и запросами;
- HTML карточек лежит у адаптера, загружается на старте и проверяется тестом
  бюджета;
- `widget_query` получает ответ всегда;
- команды карточек (`/season`, `/reward`, `/friends`) — одним обработчиком.

Самих карточек здесь нет — только проба и правила, по которым их пишут
T-0397, T-0398, T-0399.

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52, правила 2–5):
  - **код карточки не меняется после отправки**: версия облика хранится у
    карточки, флаги «перенесена», «выключено», «устарело», «закрыта» понимает
    уже первая версия;
  - **HTML** — один файл не больше 32 768 байт и не больше 4096 байт после
    zlib-9, свой бюджет — **3 300**;
  - без сети, внешних ресурсов и навигации;
  - цвета — только переменные темы `--tg-theme-*`, шрифты — системные,
    движение — с `prefers-reduced-motion`, время — `Intl`;
  - **клиент без поддержки** показывает подпись, поэтому подпись говорит
    главное и правдива без обновлений, а кнопка «▶ Играть» стоит
    клавиатурой под сообщением;
  - ответ на запрос — всегда, в том числе ошибкой, за 15 секунд.
- Факты Bot API 10.4 (сверено тимлидом по `core.telegram.org/bots/widgets`
  09.11.2026):
  - на проде виджет шлётся только в личку с ботом и защищён от пересылки;
  - запросы — только у отправленного с `allow_queries`;
  - фоновый запрос — у оригинала в личке: один при появлении на экране,
    потом не чаще раза в 5 секунд, пока виден;
  - запрос, сделанный в первых строках скрипта, ждёт появления и уходит
    сразу;
  - `TelegramWidget.request(data)` → `Promise<{ result }>`, ошибка —
    `WidgetRequestError` с `code`;
  - состояние — `TelegramWidget.chatData`, смена — событие `chatDataChanged`
    (`TelegramWidget.onEvent`);
  - `editMessageWidgetData` без изменений отвечает 400
    `message is not modified` — T-0393 переводит это в `"unchanged"`.
- **Решения тимлида (технические):**
  - **где лежит HTML.** Файлы карточек — в `backend/api/widgets/telegram/<вид>.html`,
    вне `src`: `tsc` не копирует `.html` в `dist`. Образ копирует каталог
    отдельной строкой `Dockerfile`, загрузчик ищет его от своего файла
    (`new URL("../../../widgets/telegram/", import.meta.url)` — одна глубина в
    `src` и `dist`). Файлы, начинающиеся с `_`, — пробы для тестов: загрузчик
    их не отдаёт.
  - **кнопка «▶ Играть»** — кнопка-ссылка `url` с адресом из `AppLinks`
    (`n-<вид>_card`), как у дубля уведомлений, а не `web_app`: ссылка `t.me/…?startapp`
    работает и в старом клиенте.
  - **команды карточек в меню** появляются, только когда при старте API
    включены `bot.formats.enabled` и ключ вида. Меню публикуется на старте
    (`bot-commands.ts`): включили ключ — команда в меню после следующего
    перезапуска API, а набранная руками работает сразу.
  - **как писать карточку** — правила ниже (шаг 5), их проверяет тест
    бюджета и отрисовки.

## Как сейчас

- После T-0393:
  - `TelegramBotApi.widgets` — `sendWidget`, `editMessageWidgetData`
    (`"edited" | "unchanged"`), `answerWidgetQuery` (срок 5 с);
  - `updateSchema` разбирает `widget_query` и `shared_widget_query`, у них
    приоритет в очереди и одна попытка.
- После T-0395:
  - порт `platforms/ports/live-card.ts` — `LiveCardPort`, `LiveCards`,
    `LiveCardQuery`, `LIVE_CARD_ANSWERER`;
  - `platforms.module.ts` собирает `new LiveCards([])`;
  - домен — `BotCardsService.send({ accountId, kind, origin })` →
    `CardSendResult`; `BotCardKinds.get(kind)`; ответчик под
    `LIVE_CARD_ANSWERER` (экспорт `BotCardsModule`).
- Перевод ошибок Telegram в исходы — приватный `deliver()` в
  `platforms/telegram/telegram-messenger.ts`: 403, 429, сеть и 5xx, 400
  `NO_CHAT`.
- Образец обработчика с модулем рядом — `platforms/telegram/reminders-off.command.ts`:
  - регистрация в `BotRouter` в `onModuleInit`, только при включённых
    обновлениях и входе;
  - `@Module` в том же файле;
  - строка в `app.module.ts`, 73 и 175.
- Меню и `/help` — `platforms/telegram/bot-commands.ts`: `router.commands()`
  читается на старте (`onApplicationBootstrap`, строка 56) и на каждый `/help`.
- `bot-fallback.ts` глотает обновления без `message` — после задачи
  `widget_query` до него не дойдёт.
- В репозитории нет DOM для тестов (ни `jsdom`, ни `happy-dom`). Отрисовка
  карточки проверяется в `node:vm` с заглушками — поэтому карточки пишутся
  по узкому набору DOM (шаг 5).

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **`telegram-messenger.ts`** — рефакторинг отдельным коммитом: тело
   `catch` из `deliver()` выносится в экспортируемую
   `sendOutcomeOf(error: TelegramApiError): SendOutcome`. Поведение то же.
3. **`telegram-widget-html.ts`** — загрузчик:
   - `loadWidgets(dir?: string): ReadonlyMap<string, { html: string; version: string }>`;
   - читает `*.html` каталога синхронно на старте, кроме файлов с `_`;
   - вид — имя файла без расширения, `^[a-z_]{3,16}$`;
   - `version` — первые 8 hex sha256 содержимого;
   - больше 32 768 байт или больше 4 096 после `zlib.deflateSync(…, { level: 9 })`
     — вид не загружается, лог `widget_rejected` уровнем `error`: Telegram
     всё равно откажет;
   - каталога нет — пустая карта и одно предупреждение;
   - шапка файла — правила шага 5 коротко.
4. **`telegram-live-cards.ts`** — `TelegramLiveCards implements LiveCardPort`:
   - `supports(kind)` — вид есть в карте загрузчика;
   - `send(platformUserId, message)`:
     - не число → `failed` (`not_telegram_user`);
     - `widgets.sendWidget(platformUserId, { html, chatData: message.state, caption: message.caption, allowQueries: true, protect: true, silent: message.silent, keyboard: button ? [[{ text, url }]] : undefined })`;
     - успех → `{ status: "sent", ref: { chatId: platformUserId, messageId }, version }`;
     - ошибка — `sendOutcomeOf`;
     - `topic` пока не передаётся: темы — WP52 № 14;
   - `update(ref, state)` → `editMessageWidgetData(ref.chatId, ref.messageId, { chatData: state })`:
     - `edited` и `unchanged` — как есть;
     - 400 с `message to edit not found` или `MESSAGE_ID_INVALID` → `gone`;
     - остальное — `sendOutcomeOf`;
   - `platforms.module.ts`: `liveCardsFor(config, telegramApi)` →
     `new LiveCards([new TelegramLiveCards(telegramApi, loadWidgets(), config.telegram.botToken !== "")])`.
5. **Правила карточки** — проба `backend/api/widgets/telegram/_probe.html`
   их соблюдает, тест проверяет:
   - один корень `<div id="app"></div>`, один `<style>`, один `<script>`; без
     комментариев и мёртвого кода;
   - рисует функция `draw()` целиком через `document.getElementById("app").innerHTML`;
   - любая строка из состояния вставляется через `esc()` (`& < > " '`);
   - кнопки — `<button data-act="<действие>">`, обработчик один:
     `app.addEventListener("click", (e) => { const b = e.target.closest("[data-act]"); … })`;
   - состояние — `JSON.parse(TelegramWidget.chatData)` в `try`. Битое,
     пустое или с `v` больше известной → вид «выключено»;
   - `TelegramWidget.onEvent("chatDataChanged", draw)`;
   - фоновый запрос — первой строкой скрипта:
     `TelegramWidget.request("v1:r").then((a) => apply(a.result)).catch(() => {})`;
   - ответ с `err` рисуется короткой строкой и не стирает состояние;
   - флаги (у пробы — все четыре):
     - `moved` → «Карточка перенесена ниже»;
     - `off` → «Карточки выключены — всё то же в игре»;
     - `stale` → пометка «обновится позже» поверх данных;
     - `x` → «Карточка устарела», данные остаются;
   - цвета — только `var(--tg-theme-*)`, `currentColor`, `transparent`;
     шрифт — `system-ui`; `@media (prefers-reduced-motion: reduce)` гасит
     анимации;
   - запрещено:
     - `http://`; `https://` — кроме `https://t.me/`;
     - `fetch`, `XMLHttpRequest`, `WebSocket`, `import(`, `<script src`,
       `<link`, `@import`, `@font-face`;
     - единицы `vh`, `dvh`, `svh`;
     - `<input`, `<form`, `:has(`;
     - `#rgb`-цвета, `rgb(`, `hsl(`;
   - высота содержимого — до 600 px на ширине 320.
6. **`widget-query.handler.ts`** — `WidgetQueryHandler implements BotUpdateHandler`
   с модулем в том же файле:
   - модуль импортирует `BotModule`, `BotCardsModule`;
   - регистрация — как у `reminders-off` (`router.register` в
     `onModuleInit`). Порядок в цепочке не важен: остальные обработчики
     смотрят на `message` и `callback_query`, а на `widget_query` отвечают
     `false`;
   - `widget_query`:
     - запрос `{ platform: "telegram", platformUserId: String(from.id), ref, data }`,
       где `ref` есть при `chat` и `message_id`;
     - `answer` — из `LIVE_CARD_ANSWERER`;
     - `widgets.answerWidgetQuery(id, answer)` — **всегда**: ответчик
       бросил → `{"v":1,"err":"error"}`;
     - сбой самого `answerWidgetQuery` — лог `widget_answer_failed` с кодом,
       без данных игрока, и `true`: повтор бесполезен;
   - `shared_widget_query` → `answerWidgetQuery(id, '{"v":1,"off":1}')`:
     общие виджеты — WP52 № 16;
   - строка модуля в `app.module.ts`.
7. **`bot-card-commands.ts`** — таблица команд, строки добавят задачи
   видов. Здесь — тип и пустой список:
   `export const CARD_COMMANDS: readonly { command: string; kind: string; description: string; descriptionEn: string }[] = [];`
8. **`bot-card.command.ts`** — `BotCardCommand implements BotUpdateHandler`,
   модуль в том же файле:
   - `commands` — геттер: строки `CARD_COMMANDS`, у которых при чтении
     включены `bot.formats.enabled` и `BotCardKinds.get(kind)?.enabled`;
     `audience: "everyone"`;
   - `handle`: личный чат, текст `^/(<команда>)(@\w+)?(\s|$)` из таблицы;
     аккаунт по `from.id` (`byPlatformUser`):
     - нет аккаунта → «Открой игру — карточка появится после первого входа.»
       и кнопка «▶ Играть» (`AppLinks`, `n-<вид>_card`);
     - иначе `BotCardsService.send({ accountId, kind, origin: "reply" })`,
       ответ по исходу:
       - `sent`, `fallback`, `busy`, `deferred` — ничего больше;
       - `off` → «Карточки сейчас выключены. Всё то же самое — в игре.» и
         кнопка «▶ Играть»;
       - `not_allowed` → «Разреши боту писать в настройках игры — и карточка
         придёт.»;
       - `skipped`, `blocked`, `failed` → «Не получилось прислать карточку —
         попробуй позже.»;
   - строка модуля в `app.module.ts`.
9. **`Dockerfile`** — в стадии рантайма
   `COPY backend/api/widgets backend/api/widgets` с комментарием: HTML карточек
   читается на старте, `tsc` его не копирует.
10. **`docs/30-configuration-map.md`**, строка 90:
    - HTML карточек — `backend/api/widgets/telegram/<вид>.html`;
    - команды карточек — в меню после перезапуска.

## Чего не трогаем

- Виды карточек (`season.html`, `daily.html`, `invites.html` и их файлы в
  `modules/bot-cards/kinds/`) — T-0397, T-0398, T-0399.
- Ядро карточек (`modules/bot-cards/*`) и порт — T-0395.
- Общий виджет «Вызов недели» — WP52 № 16: `shared_widget_query` здесь
  только отвечает «выключено».
- Темы в личке — WP52 № 14.

## Тесты

Первым коммитом.

- `backend/api/test/widget-render.ts` — помощник для тестов карточек (не тест):
  - `renderWidget(html, { chatData, answer?, language? })` →
    `{ app: () => string, requests: string[], click(act: string): Promise<void>, emit(event: string): void }`;
  - выполняет `<script>` в `node:vm` с заглушками: `window`, `document.getElementById("app")`
    (`innerHTML`, `addEventListener`), `TelegramWidget` по образцу заглушки из
    справки (`chatData`, `onEvent`, `request` → `Promise<{ result }>`,
    `openTelegramLink`, `themeParams`, `colorScheme`), `setInterval` и
    `setTimeout` — записывают, не ждут; настоящий `Intl`,
    `navigator.language` (по умолчанию `"ru"`), `matchMedia` → `{ matches: false }`;
  - `click(act)` зовёт обработчик корня с событием, у которого
    `target.closest("[data-act]")` → `{ dataset: { act } }`.
- `backend/api/test/widget-html-budget.test.ts` — для **каждого** `*.html` в
  `backend/api/widgets/telegram/` (и пробы):
  - ≤ 32 768 байт и ≤ 3 300 после zlib-9;
  - запреты шага 5 (сообщение называет файл и найденное);
  - есть `prefers-reduced-motion`;
  - отрисовка через `renderWidget`:
    - `{ "v": 1 }` не бросает, `app()` не пустая;
    - с `moved: 1`, `off: 1`, `stale: 1`, `x: 1` в `app()` — свои строки;
    - `chatData` `"{bad"` и `{ "v": 2 }` → строка «выключено»;
    - первым ушёл запрос `v1:r`.
  Проба `_probe.html` проходит все проверки; тест падает, если в каталоге
  нет ни одного файла.
- `backend/api/test/telegram-live-cards.test.ts`:
  - загрузчик:
    - пропускает `_probe.html`;
    - версия — 8 hex;
    - файл 4 200 байт после сжатия (случайные символы) не загружен, лог
      `widget_rejected`;
  - `send`:
    - `sendWidget` с `allowQueries`, `protect`, `chatData`, `caption`,
      `silent` и клавиатурой из одной кнопки-ссылки;
    - итог `sent` с `ref` и `version`;
    - `platformUserId` `dev-1` → `failed`;
    - 403 → `blocked`;
  - `update`:
    - `"unchanged"` → `unchanged`;
    - 400 `message to edit not found` → `gone`;
    - 429 → `retry`;
  - `supports("season")` — `false` без файла, `true` с файлом во временном
    каталоге.
- `backend/api/test/widget-query.handler.test.ts`:
  - `widget_query` с `chat` и `message_id` → ответчик получил
    `{ platform: "telegram", platformUserId: "111", ref: { chatId: "111", messageId: 4242 }, data: "v1:r" }`,
    `answerWidgetQuery` — с его строкой;
  - без `chat` → `ref: null`;
  - ответчик бросает → ответ `{"v":1,"err":"error"}`;
  - `answerWidgetQuery` бросает → обработчик возвращает `true`, лог без
    `from.id`;
  - `shared_widget_query` → `{"v":1,"off":1}`;
  - обычное сообщение → `false`.
- `backend/api/test/bot-card.command.test.ts` (таблица подменена одной
  строкой `season`):
  - `/season` и `/season@bot` → `send` с `origin: "reply"`;
  - `/seasonx` → `false`;
  - нет аккаунта → текст с кнопкой;
  - `off` → текст про выключенные карточки;
  - `not_allowed` → текст про разрешение;
  - `commands` пуст при выключенном `bot.formats.enabled` и содержит
    `season` при включённом.
- `backend/api/test/messenger.test.ts` — существующий, проходит без правок
  после рефакторинга.

## Аналитика

Нет новых событий. `bot_card_query` и `bot_message_sent` пишет ядро
(T-0395) — адаптер только доставляет.

## Настройки и окружение

Новых ключей нет. Бюджет HTML — константа `WIDGET_ZLIB_BUDGET = 3300` в тесте
бюджета; предел Telegram — проверка загрузчика. Переменных окружения нет.

## Документы

- `docs/30-configuration-map.md`, строка 90 — шаг 10.

## Критерии приёмки

- [ ] `TelegramLiveCards` реализует `LiveCardPort`: карточка уходит
      виджетом с запросами, защитой, подписью и кнопкой «▶ Играть»
      клавиатурой; правка без изменений — не ошибка, удалённое сообщение —
      `gone`.
- [ ] HTML читается из `backend/api/widgets/telegram/` в разработке и в
      образе; версия — первые 8 hex sha256; файл сверх предела Telegram не
      загружается.
- [ ] Каждый `widget_query` получает ответ, в том числе при сбое домена;
      `shared_widget_query` — «выключено».
- [ ] Команды карточек — из одной таблицы; в меню — только включённые при
      старте; ответы на `off`, `not_allowed`, отсутствие аккаунта — по шагу 8.
- [ ] Тест бюджета обходит все файлы каталога; проба проходит все проверки
      и отрисовку пяти состояний.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(bot): Живые карточки в Telegram — виджеты`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет: видов
  карточек ещё нет.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЖИВЫЕ КАРТОЧКИ В TELEGRAM**

  Ядро карточек получило Telegram (Р199): карточка — виджет Bot API 10.4 с состоянием, правками и запросами по касанию. Сами карточки «Сезон», «Награда дня», «Приглашения» — следующие задачи.

  🛠 **Что внутри**

  • HTML карточек — backend/api/widgets/telegram/, бюджет 3 300 байт после сжатия проверяет тест, вместе с запретами и отрисовкой всех состояний
  • каждый запрос из карточки получает ответ, даже при сбое
  • команды карточек одним обработчиком; в меню — только включённые, после перезапуска API
  ```
