---
id: T-0010
title: Разрешение боту писать — после первого забега и в настройках
epic: E5
priority: P1
status: ready
owner:
size: M
depends_on: []
zones:
  - backend/api/src/modules/messaging/messaging.controller.ts
  - backend/api/src/modules/messaging/messaging.module.ts
  - backend/api/test/messaging-http.test.ts
  - packages/adapter-telegram/src/index.ts
  - packages/adapter-telegram/src/write-access.ts
  - packages/adapter-telegram/test/write-access.test.ts
  - packages/app-shell/src/state/bot-access.ts
  - packages/app-shell/src/screens/home-bot-access.tsx
  - packages/app-shell/src/screens/home-live.ts
  - packages/app-shell/src/screens/home.tsx
  - packages/app-shell/src/screens/settings.tsx
  - packages/app-shell/src/i18n/ru-home.json
  - packages/app-shell/src/i18n/ru-bot.json
  - packages/app-shell/test/bot-access.test.ts
shared:
  - packages/shared-types/src/index.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/27-design-system-and-app-shell.md
  - docs/30-configuration-map.md
  - scripts/bundle-budget.mjs
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
---

# T-0010. Разрешение боту писать — после первого забега и в настройках

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0010.json)](README.md#значки-статуса)

## Зачем

Бот может писать только тем, кто сам начал с ним разговор (`/start`) или дал
разрешение. Большинство игроков открывают игру кнопкой и с ботом не говорят,
поэтому до них не доходят заявки и подарки друзей и сообщения команды. Сервер
разрешение уже понимает: служебное `write_access_allowed` обрабатывает модуль
`messaging`. Не хватает вопроса на клиенте.

## Решения

Решение пользователя от 06.10.2026.

- **Спросить после первого забега.** Когда игрок вернулся на главную после
  хотя бы одного забега, там появляется карточка «Разрешить сообщения от бота»
  с кнопками «Разрешить» и «Не сейчас». Игра уже понравилась, поэтому просьба
  не выглядит навязчивой.
- **Отказ.** После «Не сейчас» или закрытия системного окна карточка снова
  появится не раньше чем через 14 дней. Всего её показывают не больше 3 раз.
  Счёт и дата хранятся на устройстве (`adapter.storage`) под ключом
  `bot-access-asks`.
- **Всегда в настройках.** В разделе «Сообщения в боте», пока разрешения нет,
  первой строкой стоит пункт «Разрешить боту писать» с кнопкой. Если разрешение
  есть, пункта нет.
- **Две карточки сразу не показываются.** Когда видна карточка разрешения,
  карточка отзыва на главной не показывается.
- **Кто решает, что разрешение уже есть,** — сервер (`GET /api/v1/me/messaging`).
  После «Разрешить» с ответом `allowed` клиент сразу считает разрешение
  полученным: служебное сообщение до сервера может идти несколько секунд.
- **Площадка без такого запроса** (MAX, VK, браузер, старый Telegram) —
  карточки и пункта в настройках нет.
- **Telegram:**
  - запрос — событие моста `web_app_request_write_access`, ответ — событие
    `write_access_requested` со статусом `allowed` или `cancelled`;
  - поддержка — `supports("web_app_request_write_access", version)`, это Bot
    API 6.9+;
  - код — ленивым чанком по нажатию, как `invite.ts`: адаптер лежит в первой
    загрузке.

## Как сейчас

- **Сервер.**
  - `backend/api/src/modules/messaging/messaging.service.ts`:
    `state(accountId)` → `{ canMessage, reason, changedAt } | null`.
  - Своего контроллера у модуля нет.
  - Образец маршрута с лимитом —
    `backend/api/src/modules/account-settings/account-settings.controller.ts`:
    `RateLimiter.consume`, `RateLimitedError`, `@UseGuards(AuthGuard)`, `accountOf`.
- **Порт площадки** — `PlatformAdapter` в `packages/shared-types/src/index.ts`.
  Необязательные методы `inviteMethods?`, `sharePreparedMessage?`, `copyText?`
  — образец нового метода.
- **Telegram.**
  - `packages/adapter-telegram/src/invite.ts` — образец работы через мост:
    `on` и `postEvent` из `@tma.js/sdk`, функция `…With(sdk, …)` для тестов.
  - `packages/adapter-telegram/src/index.ts` — ленивый `import("./invite")` и
    `supports(…)`.
- **Главная.**
  - `packages/app-shell/src/screens/home.tsx`:
    - карточка отзыва — `shouldAskFeedback(runs, …)` и `<Card … onClick>`
      (около строк 52 и 118–130);
    - живая часть главной грузится чанком `home-live.ts` (`useHomeLive`,
      около строки 186);
    - `runs` — `useMeta((state) => state.runs)`.
  - Тексты главной — `i18n/ru-home.json`: этот словарь грузит чанк главной.
- **Настройки.** `packages/app-shell/src/screens/settings.tsx`, раздел «Сообщения
  в боте» (около строк 130–147), тексты — `i18n/ru-bot.json`.
- **Аналитика.** Образец пары событий — `share_offered` / `share_completed`
  (`backend/api/src/modules/events/event-dictionary.ts:109`,
  `docs/22-analytics-and-metrics.md` §3.3), на клиенте — `track(…)`.

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»).
2. **Аналитика — сначала словарь.**
   - В `docs/22-analytics-and-metrics.md` §3.3 строка: `bot_access_offered`,
     `bot_access_result` — запрос разрешения боту писать. Поля: `place` —
     `lobby` или `settings`; у результата `result` — `allowed`, `declined`,
     `unavailable`.
   - В `event-dictionary.ts`:

     ```ts
     bot_access_offered: { version: 1, payload: payload({ place: id }) },
     bot_access_result: { version: 1, payload: payload({ place: id, result: id }) },
     ```
3. **Сервер.** Новый `messaging/messaging.controller.ts`.

   ```
   GET /api/v1/me/messaging → { data: { canMessage: boolean } }
   ```

   - под `AuthGuard`;
   - лимит `{ scope: "messaging:read", limit: 300, windowSec: 3600 }` по аккаунту;
   - `canMessage` = `state?.canMessage ?? false`;
   - зарегистрировать в `messaging.module.ts`. Если модулю не хватает
     `AuthModule` или `IngestModule` для `RateLimiter`, импортировать их так
     же, как `account-settings.module.ts`.
4. **Порт.** В `PlatformAdapter` (`shared-types`):

   ```ts
   /** Попросить у игрока разрешение, чтобы бот мог ему писать. Нет метода — площадка так не умеет. */
   requestBotMessages?(): Promise<"allowed" | "declined" | "unavailable">;
   ```
5. **Telegram.**
   - Новый `adapter-telegram/src/write-access.ts`:
     - `requestWriteAccessWith(bridge, timeoutMs)` — подписаться на
       `write_access_requested`, отправить `web_app_request_write_access`;
     - `status: "allowed"` → `"allowed"`, иное → `"declined"`, нет ответа за
       `timeoutMs` (60 000) → `"declined"`, ошибка `postEvent` → `"unavailable"`;
     - отписка — в любом исходе.
   - Объект `bridge` — как в `invite.ts`.
   - В `index.ts`: `requestBotMessages` есть, только если
     `supports("web_app_request_write_access", version)`. Тело — ленивый
     `import("./write-access")`.
6. **Клиент, состояние.** Новый `app-shell/src/state/bot-access.ts`:
   - `loadBotAccess(api)` — `GET /api/v1/me/messaging`, ответ разбирается схемой
     `zod/mini`, как в соседних `*-api.ts`;
   - zustand-стор `{ canMessage: boolean | null; asks: { count: number; lastAt: number | null } }`;
   - чистая функция
     `shouldOfferBotAccess({ runs, canMessage, supported, asks, now })` → `true`,
     если одновременно:
     - `supported`;
     - `canMessage === false`;
     - `runs >= 1`;
     - `asks.count < 3`;
     - `asks.lastAt === null` или прошло ≥ 14 дней;
   - `requestBotAccess(place)`:
     - `track("bot_access_offered", { place })`;
     - `adapter.requestBotMessages()`;
     - `track("bot_access_result", { place, result })`;
     - `allowed` → `canMessage = true`, иначе `asks` += 1 и `lastAt = now`;
     - `asks` пишется в `adapter.storage` под ключом `bot-access-asks`;
   - «Не сейчас» → `dismissBotAccess()`: `asks` += 1 и `lastAt = now`, без
     событий площадки.
7. **Клиент, главная.** Новый `screens/home-bot-access.tsx` — `HomeBotAccess`,
   экспорт из `home-live.ts`.
   - Карточка в стиле карточки отзыва (`Card`, `stripe="accent"`), без
     `onClick` на всей карточке.
   - Тексты:
     - заголовок — `home.botAccess.title`: «Разрешить сообщения от бота»;
     - подпись — `home.botAccess.text`: «Напишем, когда друг пришлёт подарок
       или заявку, и о важных обновлениях. Без спама.»;
   - кнопки `size="m"`:
     - «Разрешить» (`home.botAccess.allow`, `variant="primary"`);
     - «Не сейчас» (`home.botAccess.later`, `variant="ghost"`).
   - Пока идёт запрос — загрузка на «Разрешить».
   - В `home.tsx` карточка стоит на месте карточки отзыва. Если
     `shouldOfferBotAccess(…)`, рендерится `live?.HomeBotAccess`, а карточка
     отзыва в этот раз не показывается. Состояние разрешения загружается вместе
     с живой частью главной.
8. **Клиент, настройки.** В разделе «Сообщения в боте» при
   `canMessage === false && supported` первой строкой — `ListItem`:
   - заголовок `settings.bot.allow`: «Разрешить боту писать»;
   - подсказка `settings.bot.allow.hint`: «Без разрешения бот не сможет прислать ничего из списка ниже»;
   - кнопка «Разрешить», которая зовёт `requestBotAccess("settings")`.

   Пока ответ сервера не пришёл (`null`), пункта нет. Текст
   `settings.bot.note` — «Всё это и так приходит в уведомления игры».
9. **Бюджет.** Карточка уходит в чанк главной, адаптер — в ленивый чанк. Если
   строка бюджета с чанком главной вырастет, порог в `scripts/bundle-budget.mjs`
   разрешено поднять **не больше чем на 0,6 КБ**:
   - с объяснением рядом с порогом;
   - строкой в таблице `docs/27-design-system-and-app-shell.md` §3.4.

   Первая загрузка расти не должна. Если выросла — вопрос тимлидам.
10. **Документы.** Строка в `docs/30-configuration-map.md`: «Запрос разрешения
    боту писать: не чаще раза в 14 дней, не больше 3 раз — константы в
    `app-shell/src/state/bot-access.ts`». Гейт.

## Чего не трогаем

- Модуль `messaging`, кроме нового контроллера и регистрации: обработку
  `write_access_allowed` и `/start`.
- Переключатели дублей в бота и их умолчания: «Новые версии игры» — отдельная
  задача E5 из «Входящих».
- Карточку отзыва: только скрывается, когда видна карточка разрешения.

## Сценарий и интерфейс

1. Новичок играет первый забег и возвращается на главную.
2. На месте карточки отзыва стоит карточка «Разрешить сообщения от бота».
3. «Разрешить» → системное окно Telegram:
   - согласие → карточка исчезает;
   - отказ → карточка исчезает, и через 14 дней появится снова (всего не больше 3 раз).
4. «Не сейчас» → карточка исчезает с тем же счётом.
5. В настройках, пока разрешения нет, есть пункт «Разрешить боту писать».

Состояния:
- `GET /me/messaging` не ответил → ни карточки, ни пункта: не знаем — не спрашиваем;
- нет сети → то же;
- гость без входа → нет;
- площадка без запроса → нет.

## Тесты

Первым коммитом.

1. **`backend/api/test/messaging-http.test.ts`** — HTTP-тест по образцу тестов
   `account-settings`:
   - без токена → 401;
   - с токеном, состояния нет → `{ canMessage: false }`;
   - состояние `canMessage: true` → `true`.
2. **`packages/adapter-telegram/test/write-access.test.ts`** — подмена моста:
   - `allowed` → `"allowed"`;
   - `cancelled` → `"declined"`;
   - нет ответа за таймаут → `"declined"`;
   - `postEvent` бросает → `"unavailable"`;
   - в каждом исходе подписка снята.
3. **`packages/app-shell/test/bot-access.test.ts`.**
   - `shouldOfferBotAccess`:
     - нет забегов → нет;
     - разрешение есть → нет;
     - `canMessage === null` → нет;
     - не поддерживается → нет;
     - 3 показа → нет;
     - последний показ 13 дней назад → нет, 14 дней → да;
     - первый раз → да.
   - `requestBotAccess("lobby")` с подменами адаптера, `track` и `storage`:
     - `allowed` → `canMessage = true`, счёт не растёт, события `offered` и `result`;
     - `declined` → счёт +1, `lastAt` = сейчас, запись в `storage`.

## Аналитика

`bot_access_offered` и `bot_access_result` — шаг 2. Доля согласий видна по
`result` в разрезе `place`.

## Настройки и окружение

Нет новых переменных. Константы 14 дней и 3 раза — в `bot-access.ts`, строка в
`docs/30` — шаг 10.

## Документы

- `docs/22-analytics-and-metrics.md` §3.3 — шаг 2.
- `docs/27-design-system-and-app-shell.md` §3.4 — только если поднят порог (шаг 9).
- `docs/30-configuration-map.md` — шаг 10.

## Критерии приёмки

- [ ] После первого забега на главной появляется карточка разрешения, и в это время нет карточки отзыва.
- [ ] Согласие убирает карточку и пункт в настройках. Отказ возвращает карточку не раньше чем через 14 дней, всего не больше 3 раз.
- [ ] Без поддержки площадки и без ответа сервера карточки и пункта нет.
- [ ] События `bot_access_offered` и `bot_access_result` есть в словаре и пишутся.
- [ ] Первая загрузка не выросла; порог чанка поднят не больше чем на 0,6 КБ, с объяснением.
- [ ] Снимки главной с карточкой и раздела настроек на 320 и 390 px — в PR.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Разрешение боту писать — после первого забега`
- **Метка:** `release: minor`
- **Для игроков:** `- новое [telegram]: Можно разрешить боту писать — о подарках и заявках друзей и важных обновлениях. Предложение появится после первого забега, а в настройках есть всегда.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РАЗРЕШЕНИЕ БОТУ ПИСАТЬ**

  Бот мог писать только тем, кто сам начал с ним разговор, — это меньшинство игроков.

  🔔 **Что появилось**

  • после первого забега на главной — предложение разрешить сообщения от бота; отказ — снова не раньше чем через 14 дней, не больше 3 раз
  • в настройках «Сообщения в боте» — пункт «Разрешить боту писать», пока разрешения нет
  • события `bot_access_offered` и `bot_access_result` — видно, сколько соглашаются
  ```
