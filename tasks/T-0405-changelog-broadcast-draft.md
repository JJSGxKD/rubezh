---
id: T-0405
title: «Что нового» — черновик оформленной рассылки из опубликованной версии журнала одной кнопкой
epic: E5
priority: P3
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0403, T-0404, T-0356]
zones:
  - backend/api/src/modules/changelog/changelog-broadcast.ts
  - backend/api/src/modules/admin/admin-changelog-broadcast.service.ts
  - backend/api/test/changelog-broadcast.test.ts
  - apps/admin/src/api/changelog.ts
  - apps/admin/src/screens/changelog/ChangelogScreen.tsx
  - apps/admin/test/changelog-broadcast.test.ts
shared:
  - backend/api/src/modules/admin/admin-changelog.controller.ts
  - backend/api/src/modules/admin/admin.module.ts
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: null
batch: 5
---

# T-0405. «Что нового» — черновик оформленной рассылки из опубликованной версии журнала одной кнопкой

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0405.json)](README.md#значки-статуса) [![T-0403](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0403.json&label=T-0403)](T-0403-rich-broadcasts-server.md) [![T-0404](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0404.json&label=T-0404)](T-0404-rich-broadcasts-panel.md) [![T-0356](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0356.json&label=T-0356)](T-0356-admin-list-first-form-in-dialog.md)

## Зачем

Чтобы рассказать игрокам о версии, команда сейчас переписывает строки
журнала в рассылку руками. После задачи у опубликованной версии в разделе
«Журнал обновлений» панели есть кнопка «Черновик рассылки». Она собирает
оформленную рассылку:
- заголовок «Что нового в vX.Y.Z»;
- список «Новое» и список «Изменилось»;
- раскрывающийся блок «Исправлено».

Затем кнопка открывает черновик. Аудиторию, тест себе и запуск человек
делает сам (Р199, сценарий «Новости и «Что нового»»).

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52, сценарий «Новости и «Что
  нового»»): запись журнала одной кнопкой панели становится черновиком
  оформленной рассылки.
- **Решение 06.10.2026** (`notifications-bot/bot-notify-rules.ts`, шапка):
  автосообщения о каждой версии нет. Кнопка только создаёт черновик, ничего
  не отправляет и не запускает. Дальше — правила рассылок как есть: тест
  себе той же редакции (T-0403), правило двух ключей, `skipRecentDays`.
- **Решения тимлида:**
  - черновик — для одной площадки (по умолчанию `telegram`), из строк,
    видимых на ней (`visibleOn`): игроки MAX не должны читать о том, чего у
    них нет;
  - только опубликованные строки версии: черновики журнала игрокам ещё не
    объявлены;
  - кнопка рассылки — «▶ Играть», ссылкой кампании, как у любой рассылки с
    кнопкой (`BroadcastsService.create`);
  - не влезло в предел — последние строки сворачиваются в «…и ещё N
    изменений», а не обрезаются посередине;
  - журнал скрыт у игроков (`CHANGELOG_FOR_PLAYERS = false`, Р125), поэтому
    рассылка не ссылается на раздел журнала в игре.

## Как сейчас

- Журнал:
  - `modules/changelog/changelog.service.ts`:
    - `list(actor)` → `{ entries, releases }`, право `changelog.edit`;
    - у строки — `version`, `platforms`, `kind` (`added`, `changed`,
      `fixed`), `text` до 500 знаков, `publishedAt`;
  - `changelog-rules.ts`: `visibleOn(entry, platform)`, `VERSION_PATTERN`,
    `CHANGELOG_FOR_PLAYERS`.
- Панель журнала:
  - `modules/admin/admin-changelog.controller.ts` — `admin/changelog`:
    список, сохранение, `publish`, `:entryId/remove`; лимит
    `ADMIN_LIMITS.mutate`;
  - экран — `apps/admin/src/screens/changelog/ChangelogScreen.tsx`
    (переделывает T-0356: список первым, форма в окне); группы версий,
    публикация;
  - API — `apps/admin/src/api/changelog.ts`.
- Рассылки:
  - `modules/broadcasts/broadcasts.service.ts` `create(actor, input)` —
    право `broadcast.edit`; кнопка заводит ссылку кампании через
    `LinksService` (право `links.manage`);
  - после T-0403 — `format: "rich"` и разбор `parseBroadcastMarkdown`
    (ошибки → `ValidationError`); экранирование `\` перед
    `* _ [ ] ( ) # > | < \` и `-`;
  - экран рассылки в панели — `#/broadcasts/<id>`, переход —
    `navigate({ section: "broadcasts", id })` (`apps/admin/src/ui/router`).
- `AdminModule` (`modules/admin/admin.module.ts`) уже подключает и
  `ChangelogService`, и `BroadcastsService`.

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **`modules/changelog/changelog-broadcast.ts`** — чистая функция без
   импортов рассылок:
   ```ts
   export const DRAFT_SOURCE_MAX = 3_800;
   export function changelogDraft(version: string, entries: readonly { kind: ChangelogKind; text: string }[]): { title: string; markdown: string };
   ```
   - `title` — `Что нового в v${version}`;
   - `markdown` по порядку:
     - `# Что нового в v${version}`;
     - `## Новое` и список строк `added`;
     - `## Изменилось` и список строк `changed`;
     - `<details>`, `<summary>Исправлено</summary>`, список строк `fixed`,
       `</details>`;
     - раздел без строк не выводится;
   - текст строки:
     - переводы строк → пробел;
     - знаки разметки экранируются `\` по правилам T-0403;
   - строки добавляются по порядку разделов, пока исходник не длиннее
     `DRAFT_SOURCE_MAX`. Остальные — последней строкой в последнем
     выведенном разделе: `…и ещё ${n} ${pluralRu(n, "изменение", "изменения", "изменений")}`.
3. **`modules/admin/admin-changelog-broadcast.service.ts`** —
   `ChangelogBroadcastDrafts.create(actor, version, platform)` →
   `BroadcastRecord`:
   - `ChangelogService.list(actor)` → строки этой версии с `publishedAt` и
     `visibleOn(entry, platform)`; порядок — как в журнале (`createdAt`);
   - строк нет → `ValidationError("У версии нет опубликованных строк для этой площадки")`;
   - `changelogDraft` → `BroadcastsService.create(actor, { title, platform, text: markdown, format: "rich", buttonText: "▶ Играть", segment: segmentSchema.parse({}) })`;
   - ошибки прав и разбора — как есть: их тексты уже понятны;
   - провайдер в `admin.module.ts`.
4. **`admin-changelog.controller.ts`** — `POST admin/changelog/broadcast-draft`:
   - тело `{ version (VERSION_PATTERN), platform: z.enum(PLATFORM_IDS).default("telegram") }`;
   - право маршрута — `changelog.edit`; `broadcast.edit` проверяет
     `BroadcastsService.create`;
   - лимит `ADMIN_LIMITS.mutate`;
   - ответ — `{ data: { broadcastId } }`;
   - маршрут объявлен **до** `:entryId/remove`.
5. **`apps/admin/src/api/changelog.ts`** — `draftBroadcast(api, version)` →
   `ApiResult<{ broadcastId: string }>`.
6. **`ChangelogScreen.tsx`** — у группы версии с опубликованными строками,
   если у входа есть права `changelog.edit` и `broadcast.edit`:
   - кнопка «Черновик рассылки»;
   - нажатие → `draftBroadcast`;
   - успех → `navigate({ section: "broadcasts", id: broadcastId })`;
   - ошибка → `Notice` с текстом сервера на месте прежних сообщений экрана;
   - пока запрос идёт — кнопка `disabled`.
   Подпись-подсказка у кнопки: «Соберёт оформленную рассылку из
   опубликованных строк версии. Ничего не отправит: аудитория, тест себе и
   запуск — на экране рассылки».
7. **`docs/29-admin-panel.md` §7.2** — строка: черновик оформленной рассылки
   из опубликованной версии журнала, кнопкой в журнале; автоотправки нет.

## Чего не трогаем

- Публикацию журнала, раздачу `app_update` и `CHANGELOG_FOR_PLAYERS`.
- Правила рассылок и экран рассылки — T-0403, T-0404.
- Раскладку экрана журнала — T-0356: только кнопка в группе версии.

## Сценарий и интерфейс

Редактор журнала с правом рассылок:

1. Опубликовал версию 0.9.0 → у её группы кнопка «Черновик рассылки».
2. Нажал → открылся экран рассылки «Что нового в v0.9.0»:
   - черновик, формат «оформленный»;
   - кнопка «▶ Играть»;
   - аудитория — все, кому можно писать, кроме получавших рассылку за 3 дня.
3. Дальше — как с любой рассылкой: правка, «Тест себе», одобрение, запуск.

Состояния:
- нет опубликованных строк для Telegram — «У версии нет опубликованных
  строк для этой площадки»;
- нет права `broadcast.edit` — кнопки нет;
- нет права `links.manage` — ошибка сервера о правах (кнопке рассылки нужна
  ссылка кампании);
- ошибка сети — текст ошибки, кнопка снова доступна.

Снимок экрана журнала с кнопкой на 390 и 1440 px — при приёмке, тимлид.

## Тесты

Первым коммитом.

- `backend/api/test/changelog-broadcast.test.ts`:
  - `changelogDraft` версии с двумя `added`, одной `changed` и двумя `fixed`
    → ровно ожидаемый Markdown (снимок строкой); `parseBroadcastMarkdown` (T-0403)
    разбирает его без ошибок: заголовок, два списка, `details`;
  - только `fixed` — нет разделов «Новое» и «Изменилось»;
  - текст со `*`, `_`, `[x](y)`, `|` и переводом строки → после разбора
    T-0403 те же знаки текстом, без разметки;
  - 40 строк по 200 знаков → исходник ≤ `DRAFT_SOURCE_MAX`, последняя
    строка — «…и ещё N изменений» с верным N;
  - `ChangelogBroadcastDrafts.create` (фейки журнала и рассылок):
    - зовёт `create` с `format: "rich"`, `buttonText: "▶ Играть"` и
      строками только опубликованными и видимыми на `telegram`;
    - строк нет → `ValidationError`;
    - отказ прав `create` уходит наружу как есть.
- `apps/admin/test/changelog-broadcast.test.ts`: `draftBroadcast` шлёт
  `POST /changelog/broadcast-draft` с `{ version }` и разбирает
  `{ broadcastId }` (`fakeFetch`).

## Аналитика

Нет: черновик пишет аудит `broadcast.create` (как любая рассылка); события
доставки — при запуске рассылки (T-0403).

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md` §7.2 — шаг 7.

## Критерии приёмки

- [ ] У опубликованной версии в журнале панели — «Черновик рассылки»; она
      создаёт черновик оформленной рассылки и открывает его.
- [ ] В черновике — только опубликованные строки площадки, разделы «Новое»,
      «Изменилось» и раскрывающееся «Исправлено»; знаки разметки из текста
      строк не ломают разбор.
- [ ] Ничего не отправляется и не запускается само.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(admin): Черновик рассылки из версии журнала`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЧЕРНОВИК РАССЫЛКИ ИЗ «ЧТО НОВОГО»**

  У опубликованной версии в журнале панели — кнопка «Черновик рассылки»: она собирает оформленную рассылку «Что нового в vX.Y.Z» из строк версии — «Новое», «Изменилось» и раскрывающееся «Исправлено» — и открывает её (Р199).

  🛠 **Что внутри**

  • только опубликованные строки площадки рассылки
  • ничего не уходит само: аудитория, тест себе и запуск — как у любой рассылки
  • не влезло в предел — последние строки свёрнуты в «…и ещё N изменений»
  ```
