---
id: T-0271
title: Картинка партнёрского задания — аватар канала, бота или Mini App берётся с источника сам
epic: E14
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0167, T-0222]
zones:
  - backend/api/src/platforms/ports/source-avatar.ts
  - backend/api/src/platforms/telegram/telegram-source-avatar.ts
  - backend/api/test/telegram-source-avatar.test.ts
  - backend/api/test/admin-source-avatar.test.ts
  - apps/admin/src/api/source-avatar.ts
  - apps/admin/src/ui/source-image.ts
  - apps/admin/test/source-avatar.test.ts
shared:
  - backend/api/src/platforms/telegram/telegram-bot-api.ts
  - backend/api/src/platforms/platforms.module.ts
  - backend/api/src/infra/outbound/outbound-services.ts
  - backend/api/src/modules/admin/admin-tasks.controller.ts
  - backend/api/src/modules/admin/admin-limits.ts
  - apps/admin/src/ui/image-field.tsx
  - apps/admin/src/screens/tasks/TasksScreen.tsx
  - apps/admin/src/ui/help.ts
  - docs/29-admin-panel.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0271. Картинка партнёрского задания — аватар канала, бота или Mini App берётся с источника сам

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0271.json)](README.md#значки-статуса) [![T-0167](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0167.json&label=T-0167)](T-0167-admin-sortable-list-tasks-order.md) [![T-0222](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0222.json&label=T-0222)](T-0222-task-customer-and-pay-model.md)

## Зачем

У партнёрского задания есть квадратная картинка (Р82), но её надо найти,
скачать и загрузить руками. Чаще всего это аватарка того самого канала или
бота, на который ведёт задание. Без картинки игрок видит безликий значок
вида, а со своей — сразу узнаёт канал.

После задачи панель сама берёт аватарку источника: администратор вводит
`@канал` или ссылку на бота или Mini App, и картинка появляется в поле.
Своя загруженная картинка сильнее: панель её не заменяет.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р158: у
задания-подписки на канал, бота или Mini App картинка — аватарка источника,
автоматически.

Решения `claude-lead-1` от 25.10.2026:

- **Какие виды.**
  - `channel` — аватарка канала или чата;
  - `bot` — аватарка бота, а у ссылки на Mini App (`t.me/<бот>/<приложение>`)
    — картинка самого приложения.

  У `link` источника нет: ссылка ведёт на чужой сайт, и картинку с него не
  берём.
- **Кто перекодирует.** Сервер картинки не перекодирует (`media/image-rules.ts`,
  Р82): квадрат и WebP делает панель. Поэтому:
  - сервер скачивает аватарку как есть и отдаёт панели байтами;
  - панель кадрирует по центру (`CENTERED` из `ui/image-crop.ts`),
    сжимает в WebP тем же `encodeWithin` и загружает обычной загрузкой
    `media` с профилем `task`.

  Новой зависимости для перекодирования на сервере нет.
- **Порт площадки** `platforms/ports/source-avatar.ts`. Домен не знает, как
  площадка отдаёт аватарку (`CLAUDE.md`, «Границы слоёв»):
  - `SourceAvatar { platform; fetch(source, signal): Promise<SourceImage | null> }`;
  - `source` — `{ kind: "channel", chat }` или `{ kind: "bot", url }`;
  - `SourceImage` — `{ bytes: Uint8Array, contentType }`, где `contentType` —
    `image/jpeg`, `image/png` или `image/webp`;
  - `SourceAvatars.for(platform)` — по образцу `ChannelMemberships`;
  - `null` — у источника нет картинки;
  - `SourceAvatarUnavailableError` — площадка не ответила, повтор поможет.

  Адаптер есть только у Telegram (первая платформа). У MAX и VK адаптера нет:
  `for("max")` → `null`, и панель пишет, что эта площадка картинку не отдаёт.
- **Telegram, канал** — Bot API, бот уже администратор канала (иначе не
  работает проверка подписки):
  1. `getChat(chat)` → `photo.big_file_id` (640×640 JPEG);
  2. `getFile` → `downloadFile`;
  3. нет фото у чата → `null`.

  Ошибка 400 или 403 при `@имени` — бота в канале нет. Тогда — публичная
  страница, как у бота (ниже).
- **Telegram, бот и Mini App** — Bot API чужих ботов не видит. Источник —
  публичная страница `https://<telegram.link-host>/<имя>[/<приложение>]`:
  1. из неё берётся `<meta property="og:image">`;
  2. картинка скачивается, только если адрес `https:` и хост вида
     `cdn<N>.telesco.pe` или `cdn<N>.cdn-telegram.org`.

  Любой другой хост — `null`: так у Telegram выглядит заглушка «нет
  картинки» (`telegram.org/img/…`), и так закрыт запрос сервера на
  произвольный адрес.
- **Разбор ссылки** — в адаптере, чистой функцией
  `parseBotLink(url, linkHost)`:
  - хост — `t.me` или `telegram.link-host`;
  - путь `/<имя>` или `/<имя>/<приложение>`, имя `^[A-Za-z][A-Za-z0-9_]{3,31}$`;
  - query (`?start=…`, `?startapp=…`) отбрасывается;
  - другое → `null`.
- **Пределы и защита:**
  - запрос — 5 с;
  - страница — до 512 КБ, картинка — до 2 МБ;
  - перенаправления не следуем (`redirect: "manual"` → `null`);
  - тип картинки проверяется по сигнатуре байтов, а не по заголовку;
  - сеть — `Outbound.forService`:
    - Bot API — меткой `telegram.bot`;
    - страница и CDN — новой меткой `telegram.web`.

    Токен бота в пути файла журнал уже прячет (`safePath`).
- **Маршрут панели** `POST /api/v1/admin/tasks/source-avatar`:
  - тело `{ kind: "channel" | "bot", platform, chat?, url? }`, Zod;
  - право `tasks.edit`;
  - лимит — новый `ADMIN_LIMITS.sourceAvatar`: 30 за 10 минут;
  - ответ:
    - 200 — байты с `Content-Type` источника и `Cache-Control: no-store`;
    - 404 `source_avatar_missing` — картинки нет или площадка не отдаёт;
    - 422 — источник не разобран;
    - 503 `source_avatar_unavailable` — площадка не ответила.
- **Панель — сама.** В форме задания вида `channel` или `bot`, когда:
  - поле «Картинка» пусто,
  - канал или ссылка прошли проверку формы,
  - ввод затих на 800 мс,

  панель берёт аватарку, кадрирует, сжимает и ставит в поле — без окна
  кадрирования. Под превью — «Картинка канала» или «Картинка бота» и кнопка
  «Обновить с источника».
  - Своя загруженная картинка — не трогается.
  - Убрали картинку руками («Убрать») — сама больше не подставляется, пока
    не нажмут «Обновить с источника».
- **Уже заведённые задания** — кнопка «Картинки источников» над списком
  заданий:
  - идёт по активным `channel` и `bot` без картинки — по одному, не
    параллельно;
  - сохраняет каждое тем же сохранением, что форма;
  - итог тостом: «Обновлено N, без картинки M».
- **Картинка не обновляется сама**, если канал сменил аватарку. Аватарки
  меняют редко, а сохранённая картинка — по хэшу содержимого, навсегда. Для
  этого кнопка «Обновить с источника».

## Как сейчас

- **Виды и параметры** — `backend/api/src/modules/tasks/task-rules.ts`:
  - `CHECKED_KINDS = ["channel", "link", "bot"]`;
  - `taskParamsSchema` — `chat` у канала, `url` у всех;
  - `image` у `taskDefSchema` — id из `media`, только у партнёрской цели.
- **Медиа:**
  - `media/image-rules.ts` — профиль `task`: квадрат 96…512, WebP до 200 КБ;
  - сервер не перекодирует.
- **Проверка подписки:**
  - порт `platforms/ports/channel-membership.ts`, `ChannelMemberships`;
  - адаптер `platforms/telegram/telegram-channel-membership.ts`;
  - сборка — `platforms/platforms.module.ts` (`channelMembershipsFor`).
- **Bot API** — `platforms/telegram/telegram-bot-api.ts`: `getChat(chatId: number)`
  отдаёт имя и bio. Фото чата и `getFile` в обёртке нет.
- **Исходящие запросы** — `infra/outbound/outbound.ts` (`Outbound.forService`),
  метки — `outbound-services.ts`, маска токена — `outbound-path.ts`.
- **Домен ссылок Telegram** — настройка `telegram.link-host`
  (`platforms/telegram/settings-link-origin.ts`).
- **Панель:**
  - `apps/admin/src/ui/image-field.tsx` — поле картинки с кадрированием и
    загрузкой;
  - `ui/image-crop.ts` — `CENTERED`, `cropOf`, `encodeWithin`;
  - `screens/tasks/TasksScreen.tsx` — форма задания, поле канала — строка 219.
    Форму до этой задачи меняют T-0167 (порядок списка) и T-0222 (заказчик
    и модель оплаты) — брать после них.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Порт** `platforms/ports/source-avatar.ts` — по «Решениям».
3. **Bot API** — в `telegram-bot-api.ts` два метода:
   - `getChatPhoto(chat: string)` → `big_file_id | null`;
   - `downloadFile(fileId, maxBytes, signal)` → байты.

   Таймауты — как у соседних вызовов.
4. **Адаптер** `telegram-source-avatar.ts`. Чистые функции рядом и экспортом
   для тестов:
   - `parseBotLink`;
   - `ogImageOf(html)`;
   - `isTelegramCdn(url)`;
   - `imageTypeOf(bytes)` — сигнатуры JPEG, PNG, WebP.
5. **Сборка** — `SourceAvatars` в `platforms.module.ts`, экспорт рядом с
   `ChannelMemberships`. Метка `telegram.web` — в `OUTBOUND_SERVICES`, с
   комментарием.
6. **Маршрут** — в `admin-tasks.controller.ts`; лимит — в `admin-limits.ts`.
7. **Панель:**
   - `api/source-avatar.ts` — вызов и коды ошибок;
   - `ui/source-image.ts` — блоб → кадр по центру → WebP → загрузка, без DOM
     в правилах;
   - `ImageField` — необязательное свойство `source`, автоподстановка и
     «Обновить с источника»;
   - `TasksScreen.tsx` — передать источник, кнопка «Картинки источников».
8. **Подсказки** — `ui/help.ts`, `HELP.tasks.image`: «Пусто — возьмём картинку
   канала или бота сами».
9. **`docs/29`** — абзац о картинке источника в разделе заданий панели.

## Чего не трогаем

- `media/image-rules.ts` и профиль `task` — без изменений.
- Вид `link` — без источника.
- Адаптеры MAX и VK — при их портировании.
- Клиент игры — картинка задания у него уже есть (Р82).

## Сценарий и интерфейс

«Задания» → «Новое» → вид «Подписка на канал», площадка Telegram, канал
`@rubezh_game` → через секунду в поле «Картинка» — аватарка канала, под ней
«Картинка канала · Обновить с источника» → «Сохранить». В игре у задания —
аватарка канала.

Вид «Запустить бота», ссылка `https://t.me/some_bot/app` → картинка Mini App.

Состояния поля:
- идёт загрузка — «Берём картинку…»;
- нет картинки у источника — «У источника нет картинки — загрузите свою»;
- MAX или VK — «Эта площадка картинку не отдаёт — загрузите свою»;
- сбой сети — «Не удалось взять картинку» с «Повторить».

## Тесты

Первым коммитом.

- `telegram-source-avatar.test.ts` — чистые функции и адаптер с подставным
  Bot API и `fetch`:
  - `parseBotLink`:
    - `https://t.me/some_bot` → имя;
    - `https://t.me/some_bot/app?startapp=x` → имя и приложение;
    - `http://t.me/x`, `https://evil.example/some_bot`, `https://t.me/` →
      `null`;
    - домен из `telegram.link-host` разбирается так же, как `t.me`.
  - `ogImageOf` — находит `og:image` при любом порядке атрибутов; нет мета →
    `null`.
  - `isTelegramCdn`:
    - `https://cdn4.telesco.pe/file/…` → да;
    - `https://telegram.org/img/t_logo.png`, `https://cdn4.telesco.pe.evil.io/…`,
      `http://cdn4.telesco.pe/…` → нет.
  - Канал:
    - есть фото → байты JPEG;
    - фото нет → `null`;
    - 400 с `@именем` → идёт на страницу;
    - 5xx → `SourceAvatarUnavailableError`.
  - Бот:
    - страница с `og:image` на CDN → байты;
    - на `telegram.org` → `null`;
    - перенаправление → `null`;
    - картинка 3 МБ → `null` (больше не читается);
    - байты не картинка → `null`.
- `admin-source-avatar.test.ts` — маршрут:
  - без `tasks.edit` → 403;
  - канал → 200 с типом и `no-store`;
  - нет картинки → 404 `source_avatar_missing`;
  - площадка `max` → 404;
  - кривая ссылка → 422;
  - 31-й запрос за 10 минут → 429.
- `apps/admin/test/source-avatar.test.ts` — правила автоподстановки:
  - пусто и источник валиден → брать;
  - своя картинка → не брать;
  - убрали руками → не брать до «Обновить»;
  - вид `link` → не брать.

Снимки формы с картинкой канала и состояния «нет картинки» — в PR.

## Аналитика

Новых событий нет: правка задания уже в журнале действий панели.

## Настройки и окружение

Нет новых переменных. Сервер ходит на `t.me` (или `telegram.link-host`),
`cdn*.telesco.pe` и `api.telegram.org/file`. Если на проде исходящие
закрыты списком — эти хосты в него.

## Документы

`docs/29` — по шагу 9.

## Критерии приёмки

- [ ] В форме задания-подписки на канал Telegram картинка канала появляется сама.
- [ ] Для бота и Mini App — тоже.
- [ ] Своя загруженная картинка не заменяется.
- [ ] Кнопка «Картинки источников» заполняет уже заведённые задания без картинки.
- [ ] Сервер ходит только на хосты Telegram: чужой адрес и перенаправление дают «нет картинки».
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Картинка задания с канала или бота`
- **Метка:** `release: minor`
- **Для игроков:** пусто — картинки появятся, когда команда заведёт задания.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КАРТИНКА ЗАДАНИЯ С ИСТОЧНИКА**

  У партнёрского задания картинка теперь подставляется сама: введите @канал или ссылку на бота или Mini App — панель возьмёт их аватарку. Своя картинка сильнее. Для уже заведённых заданий — кнопка «Картинки источников» над списком.
  ```
