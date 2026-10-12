---
id: T-0056
title: Вход в панель по QR и диплинку — запрос со страницей, без лишнего перехода
epic: E14
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/platforms/ports/app-links.ts
  - backend/api/src/platforms/telegram/telegram-app-links.ts
  - backend/api/src/modules/admin/panel-login.service.ts
  - backend/api/src/modules/admin/admin-session.controller.ts
  - backend/api/test/app-links.test.ts
  - backend/api/test/panel-login.test.ts
  - backend/api/test/admin-session.test.ts
  - apps/admin/src/api/session.ts
  - apps/admin/src/state/session.ts
  - apps/admin/src/screens/Login.tsx
  - apps/admin/src/ui/qr-code.tsx
  - apps/admin/test/session.test.ts
  - apps/admin/test/qr-code.test.ts
shared:
  - apps/admin/package.json
  - pnpm-lock.yaml
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
version: v0.8
---

# T-0056. Вход в панель по QR и диплинку — запрос со страницей, без лишнего перехода

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0056.json)](README.md#значки-статуса)

## Зачем

Сейчас войти в панель — три лишних шага:

1. нажать «Войти через Telegram»;
2. перейти по ссылке `https://t.me/…` — на ПК это ещё страница t.me с
   кнопкой «Открыть в Telegram»;
3. только потом бот.

С телефона в панель на ПК не войти вовсе: QR нет.

Решение пользователя от 12.10.2026 (`docs/35-stage4-plan.md` Р94):

- запрос входа открывается вместе со страницей;
- QR и кнопка ведут диплинком `tg://resolve` — сразу в приложение
  Telegram;
- подтверждение в боте не меняется.

## Решения

- **Запрос открывается сам**, когда страница входа показана анонимному
  посетителю. Кнопки «Войти через Telegram» больше нет.
- **На экране**:
  - QR с диплинком;
  - код из четырёх цифр;
  - кнопка «Открыть Telegram» — диплинк;
  - мелкая ссылка «Telegram не установлен на этом устройстве? Открыть в
    браузере» — прежний `https://t.me/…`.
- **Диплинк** — `tg://resolve?domain=<бот>&start=panel-<id>`.
  - Площадка без диплинков (MAX, VK — когда появятся) отдаёт `null`; тогда
    QR и кнопка — с обычной ссылкой.
  - Диплинк на Mini App (`tg://resolve?domain=<бот>&startapp=<параметр>`) —
    тем же методом порта, для переходника ссылок (T-0058).
- **Истёк** — открывается новый запрос сам, не больше 6 раз подряд (30
  минут). Дальше:
  - «Время вышло» и кнопка «Начать заново»;
  - забытая вкладка не плодит запросы в Redis бесконечно.
- **Отказ бота** (отклонил, нет роли, заблокирован) — прежние тексты и
  кнопка «Начать заново». Сам по себе новый запрос не открывается.
- **Подтверждение в боте — как сейчас**: тот же код, устройство и место
  запроса. QR-вход уязвим к подмене: злоумышленник показывает жертве QR
  своей сессии. От этого и защищают код и место: жертва видит чужой город и
  чужое устройство.

## Как сейчас

- **`backend/api/src/platforms/ports/app-links.ts`:**
  - `AppLinkBuilder` — `launch(startParam)`, `chat(startParam)`;
  - `AppLinks` — по площадке.
- **`backend/api/src/platforms/telegram/telegram-app-links.ts`:**
  - `launch` — `${miniAppLink}=<параметр>` (`https://t.me/<бот>?startapp=…`);
  - `chat` — `https://t.me/<бот>?start=…`;
  - имя бота — `identity.username`.
- **`backend/api/src/modules/admin/panel-login.service.ts`** —
  `open(from, nowMs)`:
  - ссылка `this.links.chat("telegram", panel-<requestId>)`;
  - `LOGIN_TTL_SEC = 300`;
  - ответ `PanelLoginOpened` (`requestId, secret, code, link, expiresAtMs`).
- **`admin-session.controller.ts`:**
  - `POST bot` → `{ data: { requestId, secret, code, link, expiresAt } }`;
  - `POST bot/poll`.
- **`apps/admin/src/api/session.ts`** — схема ответа: `link: z.string().url()`,
  `expiresAt`.
- **`apps/admin/src/state/session.ts`:**
  - `loginBot()` открывает запрос и опрашивает раз в `pollMs` (2 с);
  - по истечении — `failed` «Время вышло — начните вход заново»;
  - `cancelBot()`;
  - `BotLoginView` — `idle`, `opening`, `waiting`, `failed`;
  - время и ожидание подменяются через `timing`.
- **`apps/admin/src/screens/Login.tsx`** — кнопка «Войти через Telegram», код и
  «Открыть бота» (`target="_blank"`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Порт ссылок (`app-links.ts`):**
   - в `AppLinkBuilder` — два необязательных метода:

     ```ts
     /** Та же ссылка на приложение, но диплинком в установленный клиент: без страницы-переходника. `null` или нет метода — у площадки его нет. */
     launchDeep?(startParam: string): string | null;
     /** Чат с ботом диплинком. */
     chatDeep?(startParam: string): string | null;
     ```

   - в `AppLinks` — `launchDeep(platform, startParam)` и
     `chatDeep(platform, startParam)` → `null`, если у площадки метода нет.
3. **`telegram-app-links.ts`:**
   - `launchDeep` — `tg://resolve?domain=<бот>&startapp=<параметр>`;
   - `chatDeep` — `tg://resolve?domain=<бот>&start=<параметр>`;
   - параметр — `encodeURIComponent`, как сейчас;
   - нет имени бота — `null`.
4. **`panel-login.service.ts`** — в `PanelLoginOpened` поле `deepLink: string | null`
   из `this.links.chatDeep("telegram", …)`.
5. **`admin-session.controller.ts`** — в ответ `POST bot` поле
   `deepLink: string | null`. Ответ только дополняется: старая панель его не
   читает (`docs/09-ci-cd.md` §4).
6. **Зависимость `uqr`** в `apps/admin/package.json`:
   - точная версия `0.1.3`, лицензия MIT, без зависимостей;
   - `pnpm install` — в коммит идёт записанный им `pnpm-lock.yaml`.
7. **Новый `apps/admin/src/ui/qr-code.tsx`:**
   - чистая функция:

     ```ts
     /** Модули QR одной строкой пути SVG: квадрат 1×1 на каждый тёмный модуль. */
     export function qrPath(modules: readonly (readonly boolean[])[]): string;
     ```

   - компонент `QrCode({ value, size = 200, label })`:
     - матрица — `encode(value, …)` из `uqr`; уровень коррекции `M`, поле
       вокруг — 4 модуля (как требует сканер);
     - `<svg viewBox="0 0 n n">` с одним `<path d={qrPath(…)}>`. Без
       `dangerouslySetInnerHTML`: политика источников панели и React
       обходятся без вставки разметки строкой;
     - светлая плитка `bg-white` со скруглением, модули `#0d0c18`: тёмный
       QR на тёмном фоне сканеры читают плохо;
     - `role="img"`, `aria-label={label}`.
8. **`apps/admin/src/api/session.ts`** — в схеме ответа
   `deepLink: z.string().nullable().optional()` и разбор как раньше.
9. **`apps/admin/src/state/session.ts`:**
   - `waiting` += `deepLink: string | null`;
   - **автооткрытие** — новое действие `startBotLogin()`: открыть, если
     посетитель анонимный и вход не идёт (`bot.status` — `idle`);
   - **по истечении** — вместо `failed` открыть новый запрос, счётчик подряд
     `renewals`; на 6-м истечении — `failed` «Время вышло» без нового
     запроса;
   - **отказы** — как сейчас, без нового запроса;
   - `loginBot()` остаётся для «Начать заново», счётчик обнуляется.
10. **`Login.tsx`:**
    - при показе вызвать `startBotLogin()` (`useEffect`, один раз за
      показ);
    - `waiting`:
      - заголовок «Вход в панель»;
      - `QrCode` (`value` — `deepLink ?? link`, `label` «QR для входа через
        Telegram»);
      - под ним «Отсканируйте телефоном с Telegram или нажмите кнопку — бот
        покажет такой же код»;
      - код крупно, как сейчас;
      - кнопка-ссылка «Открыть Telegram» (`href` — `deepLink ?? link`, без
        `target`: диплинк открывает приложение, а не вкладку);
      - мелко — «Telegram не установлен на этом устройстве? Открыть в
        браузере» (`href` — `link`, `target="_blank"`, `rel="noopener noreferrer"`);
      - «Сверьте код в боте и нажмите «Войти» — панель откроется сама»;
    - `opening` — «Открываем вход…» и заглушка размера QR, чтобы экран не
      прыгал;
    - `failed` — текст и кнопка «Начать заново» (`loginBot()`);
    - кнопки «Отмена» больше нет: уходить со страницы входа некуда;
    - вход разработчика — как сейчас.
11. **Документы** — раздел «Документы».

## Чего не трогаем

- Подтверждение в боте и его тексты.
- `poll`, сессию панели, cookie.
- Ссылки `launch` и `chat` — переходник переводит T-0058.

## Тесты

Первым коммитом.

- **`backend/api/test/app-links.test.ts`:**
  - `chatDeep("telegram", "panel-abc")` →
    `tg://resolve?domain=<бот>&start=panel-abc`;
  - `launchDeep("telegram", "c-1")` → `tg://resolve?domain=<бот>&startapp=c-1`;
  - без имени бота → `null`;
  - площадка без метода → `null`.
- **`backend/api/test/panel-login.test.ts`** — `open` возвращает и `link`, и
  `deepLink`.
- **`backend/api/test/admin-session.test.ts`** — ответ `POST bot` содержит
  `deepLink`.
- **`apps/admin/test/qr-code.test.ts`** — `qrPath`:
  - `[[true,false],[false,true]]` → два квадрата `M0 0h1v1h-1z` и
    `M1 1h1v1h-1z` (порядок — по строкам);
  - пустая матрица → `""`.
- **`apps/admin/test/session.test.ts`** — на подменённом `timing`:
  - `startBotLogin()` у анонимного открывает запрос, повторный вызов — нет;
  - истёк — открыт новый, `renewals` растёт;
  - 6-е истечение подряд — `failed`, нового запроса нет;
  - `declined` — `failed` без нового запроса;
  - `loginBot()` после `failed` — новый запрос, счётчик с нуля;
  - сервер без `deepLink` — `waiting` с `deepLink: null`.

## Аналитика

Нет: вход пишется в аудит, как сейчас.

## Настройки и окружение

Нет.

## Документы

- **`docs/29-admin-panel.md` §8 (вход):**
  - запрос открывается со страницей;
  - QR и кнопка — диплинком;
  - запасная ссылка;
  - автообновление до 6 раз;
  - почему код и место в боте остаются — подмена QR.

## Критерии приёмки

- [ ] Страница входа сразу показывает QR, код и «Открыть Telegram».
  Кнопка открывает приложение Telegram без страницы t.me.
- [ ] QR сканируется телефоном и открывает бота с тем же кодом.
- [ ] Истёкший запрос заменяется новым сам, не больше 6 раз подряд.
- [ ] Отказ бота — текст и «Начать заново».
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Вход в панель по QR и диплинку`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR не пишем
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВХОД В ПАНЕЛЬ ПО QR**

  Страница входа в панель сразу показывает QR и кнопку «Открыть Telegram»: кнопка ведёт прямо в приложение, без страницы t.me, а QR можно отсканировать телефоном. Бот, как и раньше, показывает код, устройство и место — сверьте их, прежде чем нажать «Войти».
  ```
