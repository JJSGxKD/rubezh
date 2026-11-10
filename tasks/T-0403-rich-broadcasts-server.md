---
id: T-0403
title: Оформленные рассылки — сервер — ограниченный Markdown, разбор в RichDocument, запуск только после теста себе
epic: E5
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0394]
zones:
  - backend/api/src/modules/broadcasts/broadcast-rich.ts
  - backend/api/src/modules/broadcasts/broadcasts.service.ts
  - backend/api/src/modules/broadcasts/broadcast-sender.ts
  - backend/api/src/modules/broadcasts/broadcasts.repository.ts
  - backend/api/src/modules/broadcasts/broadcasts.module.ts
  - backend/api/src/modules/admin/admin-broadcasts.controller.ts
  - backend/api/prisma/migrations/*_broadcast_format/**
  - backend/api/test/broadcast-rich.test.ts
  - backend/api/test/broadcasts-rich.test.ts
  - backend/api/test/helpers/memory-broadcasts.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/test/broadcasts.integration.test.ts
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 5
---

# T-0403. Оформленные рассылки — сервер — ограниченный Markdown, разбор в RichDocument, запуск только после теста себе

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0403.json)](README.md#значки-статуса) [![T-0394](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0394.json&label=T-0394)](T-0394-rich-message-port.md)

## Зачем

Рассылки из панели сейчас — только простой текст. Новости и «Что нового»
читаются хуже, чем могли бы. После задачи у рассылки есть формат
«оформленный»:
- текст пишется ограниченным Markdown — заголовки, списки, цитаты, таблицы и
  раскрывающиеся блоки;
- сервер разбирает его в `RichDocument` (T-0394);
- Telegram показывает оформленным, MAX и VK — тот же текст без разметки
  (Р199, сценарий «Новости и «Что нового»»).

Редактор и предпросмотр в панели — WP52 № 12 (T-0404).

## Решения

- **Р199** (`docs/35-stage4-plan.md`, WP52, сценарий «Новости и «Что
  нового»», правила 1, 5, 9):
  - оформленное — только при включённых `bot.formats.enabled` и
    `bot.rich.enabled` (решает `BotMessages.compose`, T-0394); выключены —
    тот же текст без разметки;
  - аналитика — `bot_message_sent` (`kind: news`) и строки
    `broadcast_delivery`;
  - тема — «Новости» (`topic: "news"`) у оформленной рассылки; адаптер её
    учтёт после T-0406. Простой рассылке тему поставит T-0406: здесь её
    сообщение не меняется ни на поле, и `broadcasts.test.ts` проходит без
    правок.
- **Рассылки не меняют правил** (`docs/29-admin-panel.md` §7, §8): правило
  двух ключей, `skipRecentDays`, тест себе, пауза и отмена — как сейчас.
- **Решения тимлида:**
  - **Разметка — свой разбор ограниченного Markdown**, без библиотеки:
    - список того, что понимает разбор, — шаг 3;
    - всё остальное — ошибка с номером строки, а не молчаливая потеря;
    - HTML — только `<details><summary>`;
    - картинок нет: фото в рассылке — отдельное решение владельца;
    - зависимость ради десятка правил — лишняя поверхность для атак через
      текст из панели.
  - **Пределы.** Простой текст документа — до 4 000 знаков (`RICH_LIMITS.plainChars`
    T-0394: запасной текст обязан уйти обычным сообщением); блоков — до 100
    на рассылку; исходник — до 4 096 знаков, как у простой.
  - **Запуск только после теста себе той же редакции.** Оформленную
    рассылку нельзя запустить, пока автор или другой редактор не получил
    тест себе именно этого текста и кнопки, и тест ушёл оформленным:
    - без запасного текста;
    - при включённых ключах, с `rich` у сообщения.

    Правка сбрасывает отметку. Ошибка в разметке видна глазами, а не
    тестом: тысяча игроков не должна получить сломанную таблицу.
  - **Миграция** — две колонки `broadcast` с умолчаниями: старые рассылки —
    простой текст и без отметки теста.

## Как сейчас

- `prisma/schema.prisma`, `model Broadcast`, строки 1261–1290: `text`
  `VarChar(4096)`, кнопка, ссылка кампании, сегмент, статус.
- `modules/broadcasts/broadcasts.service.ts`:
  - `create`, `update` (`updateDraft` сбрасывает `approvedBy`);
  - `testSend` — строки 119–127: `messenger.send(actor.platformUserId, messageOf(broadcast))`;
  - `start` — строки 138–154: статус, бот, аудитория, правило двух ключей.
- `modules/broadcasts/broadcast-sender.ts`:
  - `messageOf(broadcast)` — `{ text, button }`;
  - `sendBatch` — пачка в темпе площадки, исходы в `broadcast_delivery`.
- `modules/broadcasts/broadcasts.repository.ts`:
  - `BroadcastRecord`, `NewBroadcast`, `DraftPatch`;
  - Prisma-реализация, `toRecord`.

  Память для тестов — `test/helpers/memory-broadcasts.ts`.
- `modules/admin/admin-broadcasts.controller.ts`:
  - `editSchema` — `text` до 4 096, строки 22–28;
  - маршруты `admin/broadcasts`, `…/:id/test`, `…/:id/start`;
  - лимиты `ADMIN_LIMITS.mutate` и `broadcastTest`.
- Тесты: `test/broadcasts.test.ts` собирает сервис и отправителя позиционно
  (строки 44–66); `test/broadcasts.integration.test.ts` — Prisma.
- После T-0394:
  - `RichDocument`, `RichText`, `plainTextOf`, `richProblems`, `RICH_LIMITS`
    — `platforms/ports/rich-message.ts`;
  - `BotMessages.compose(doc, { button, topic })`;
  - `BotMessageEvents.sent({ kind, format, outcome, topic, silent, platform })`;
  - `SendOutcome` вида `sent` с `fallback?: true`;
  - `BotMessagesModule` экспортирует оба провайдера.
- Админка (`apps/admin/src/api/broadcasts.ts`) разбирает ответы `z.object`
  без `.strict()`: новые поля ответа её не ломают.

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **Prisma** — в `model Broadcast` две строки с комментариями:
   ```prisma
   /// `plain` — простой текст; `rich` — ограниченный Markdown, разбор — `broadcasts/broadcast-rich.ts` (Р199)
   format     String  @default("plain") @db.VarChar(8)
   /// отпечаток редакции (формат, текст, кнопка), ушедшей тестом себе оформленной; правка его сбрасывает
   testedHash String? @map("tested_hash") @db.VarChar(64)
   ```
   Миграция `<UTC>_broadcast_format` — по `tasks/README.md`, «Общие файлы»,
   без базы. Новой модели нет — `wipe-plan.ts` не меняется.
3. **`broadcasts/broadcast-rich.ts`** — чистые функции:
   ```ts
   export const BROADCAST_RICH_LIMITS = { blocks: 100 } as const;
   export interface BroadcastRichParse { doc: RichDocument; problems: string[] }
   export function parseBroadcastMarkdown(source: string): BroadcastRichParse;
   export function editionHash(input: { format: string; text: string; buttonText: string | null }): string; // sha256 hex
   ```
   Разбор построчный, перевод строки — `\n` (входящий `\r\n` приводится).
   Блоки разделяет пустая строка.

   | Исходник | Блок |
   |---|---|
   | `# `, `## `, `### ` в начале строки | `heading`, уровень 1–3 |
   | строки `- ` или `* ` подряд | `list` |
   | строки `1. `, `2. ` подряд | `list` с `ordered: true` |
   | строки `> ` подряд | `quote` (строки — через перевод строки) |
   | строки `\|…\|` подряд, вторая — разделитель `\|---\|…` | `table`: первая строка — `header`, ячейки — по `\|` с обрезкой пробелов |
   | `<details>`, следующая строка `<summary>текст</summary>`, … `</details>` на своих строках | `details`, внутри — те же правила; вложенность — до 3 |
   | `---` одна в строке | `divider` |
   | прочие строки подряд | `paragraph`, строки через перевод строки |

   Внутри строки:
   - `**жирный**` → `bold`;
   - `_курсив_` → `italic`;
   - `[текст](https://…)` → `link`;
   - `\` перед `* _ [ ] ( ) # > | < \` и `-` — знак как есть.

   Вложенные `**_…_**` допустимы.

   Ошибки — строки по-русски с номером строки исходника, например
   `строка 7: незакрытый **`:
   - незакрытые `**`, `_`, `[`, `<details>`;
   - `<summary>` не сразу после `<details>`;
   - любой другой `<тег>`;
   - ссылка не `https://`;
   - таблица без строки-разделителя или с рядами разной длины;
   - `details` глубже 3;
   - пустой исходник;
   - блоков больше 100;
   - всё, что вернул `richProblems(doc)` T-0394. В нём и предел простого
     текста 4 000 знаков.
4. **`broadcasts.repository.ts`** и память для тестов:
   - `BroadcastRecord` += `format: "plain" | "rich"`, `testedHash: string | null`;
   - `NewBroadcast` и `DraftPatch` += `format`;
   - `updateDraft` пишет `testedHash: null` вместе с `approvedBy: null`;
   - новый `markTested(broadcastId, hash): Promise<boolean>` — условно
     `status = 'draft'`;
   - `toRecord` неизвестное значение `format` читает как `plain`.
5. **`broadcast-sender.ts`:**
   - `messageOf(broadcast, composer?)`:
     - `plain` или нет `composer` — ровно как сейчас, без новых полей;
     - `rich` — `composer.compose(parseBroadcastMarkdown(text).doc, { button, topic: "news" })`;
   - отправитель получает `@Optional() composer?: BotMessages` и
     `@Optional() events?: BotMessageEvents` **последними** параметрами:
     позиционные сборки тестов не ломаются;
   - после каждого окончательного исхода получателя (не `retry`) —
     `events.sent`:
     - `kind: "news"`, `topic: "news"`, `silent: false`, `platform`;
     - `format` — `rich`, если у сообщения был `rich` и исход не
       `fallback`, иначе `text`;
     - `outcome` — `fallback` при `sent` с `fallback`, иначе исход;
   - запуск с документом, где разбор нашёл ошибки, сюда не доходит (шаг 6).
     Если всё же дошёл — сообщение без `rich`, текст `plainTextOf` и лог
     `broadcast_rich_invalid` один раз на рассылку.
6. **`broadcasts.service.ts`:**
   - `BroadcastInput` += `format?: "plain" | "rich"` (нет — `plain`):
     необязательное, чтобы `INPUT` в `broadcasts.test.ts` собирался без
     правок;
   - `create` и `update`: у `rich` — `parseBroadcastMarkdown`; есть ошибки →
     `ValidationError` с первыми тремя через «; »;
   - аудит `create` и `update` пишет `format`;
   - `testSend`:
     - сообщение — `messageOf(broadcast, composer)`;
     - после отправки у `rich`: исход `sent` без `fallback` и у сообщения
       был `rich` → `markTested(id, editionHash(broadcast))`;
     - ответ — прежний `SendOutcome`;
   - `start` — до подсчёта аудитории: `format === "rich"` и
     `testedHash !== editionHash(broadcast)` →
     `BroadcastStateError("Оформленную рассылку запускают после теста себе этой же редакции")`;
   - `view` отдаёт ещё `tested: boolean` — отметка совпадает с текущей
     редакцией;
   - новый `preview(actor, text)` → `{ doc, plain: plainTextOf(doc), problems }`,
     право `broadcast.edit`;
   - конструктор — `@Optional() composer?: BotMessages` последним.
7. **`broadcasts.module.ts`** — импорт `BotMessagesModule`.
8. **`admin-broadcasts.controller.ts`:**
   - `editSchema` += `format: z.enum(["plain", "rich"]).default("plain")`;
   - новый `POST admin/broadcasts/preview` с телом
     `{ text: string (1–4096) }` → `{ data: { doc, plain, problems } }`:
     - право `broadcast.edit`;
     - лимит `ADMIN_LIMITS.mutate`;
     - маршрут объявлен **до** `:id`: иначе `preview` поймает `:id`.
9. **`docs/29-admin-panel.md` §7.2** — абзац «Оформленная рассылка»:
   - что понимает разметка — таблица шага 3 коротко;
   - пределы;
   - запуск только после теста себе этой редакции;
   - на MAX, VK и при выключенных ключах — тот же текст без разметки;
   - тема «Новости».

## Чего не трогаем

- Сегмент, оценку аудитории, правило двух ключей, `skipRecentDays`, паузу и
  отмену.
- Простые рассылки: их текст, кнопка и итог — как сейчас.
- Экран рассылок в панели — T-0404; черновик из «Что нового» — T-0405.
- Посты в каналы (§7.4).

## Сценарий и интерфейс

Сценарий в панели — T-0404. Сервер отвечает понятными ошибками:
- «строка 7: незакрытый **»;
- «Оформленную рассылку запускают после теста себе этой же редакции»;
- «таблица: ряды разной длины (строка 12)».

Игрок в Telegram получает новость заголовками, списком и таблицей. Кнопка —
ссылка кампании, как у простой рассылки. На MAX и VK — тот же текст без
разметки.

## Тесты

Первым коммитом.

- `backend/api/test/broadcast-rich.test.ts`:
  - разбор каждой строки таблицы шага 3 → ожидаемый блок (`toEqual`);
  - инлайн: `**жирный** и _курсив_ [сайт](https://t.me/x)` → три вида
    частей; `\*не жирный\*` → текст со звёздочками;
  - `details` с таблицей внутри; вложенность 4 → ошибка;
  - ошибки с номером строки: незакрытый `**`, `<b>`, ссылка `http://`,
    таблица без разделителя, ряды разной длины, `<summary>` не на месте;
  - 101 блок → ошибка про блоки; простой текст 4 001 знак → ошибка T-0394;
  - пустой исходник → ошибка;
  - `\r\n` разбирается так же, как `\n`;
  - `editionHash` меняется от формата, текста и кнопки по отдельности.
- `backend/api/test/broadcasts-rich.test.ts` (сборка как в
  `broadcasts.test.ts`, фейки `BotMessages` с включёнными ключами и
  `BotMessageEvents`):
  - `create` `rich` с ошибкой разметки → `ValidationError` с номером строки;
  - `start` `rich` без теста → `BroadcastStateError`;
  - тест себе → `sent` → `start` проходит;
  - тест ушёл с `fallback` → `start` отказывает;
  - правка текста после теста → `start` отказывает;
  - ключ `bot.rich.enabled` выключен на тесте (`compose` без `rich`) →
    отметки нет;
  - отправитель: `messenger.send` получил `rich` и `text = plainTextOf`,
    `topic: "news"`; `events.sent` на каждого получателя с `kind: "news"`;
    `retry` события не пишет;
  - простая рассылка — `messageOf` как раньше, и с `composer` тоже
    (`toEqual({ text, button })`).
- `backend/api/test/broadcasts.test.ts` — существующий, проходит без
  правок.
- `backend/api/test/broadcasts.integration.test.ts` — дописать: `format` и
  `testedHash` сохраняются, `updateDraft` сбрасывает `testedHash`,
  `markTested` не трогает запущенную.

## Аналитика

`bot_message_sent` (T-0394): `kind: "news"`, `format` `rich` или `text`,
`outcome`, `topic: "news"`, `silent: false` — на каждого получателя.
Строки `broadcast_delivery` — как сейчас. Новых событий нет.

## Настройки и окружение

Нет: `bot.formats.enabled` и `bot.rich.enabled` вводит T-0394.

## Документы

- `docs/29-admin-panel.md` §7.2 — шаг 9.

## Критерии приёмки

- [ ] Рассылка хранит формат; старые рассылки после миграции — простой
      текст.
- [ ] Разбор понимает ровно таблицу шага 3, остальное — ошибка с номером
      строки.
- [ ] Оформленную рассылку нельзя запустить без теста себе этой же редакции,
      ушедшего оформленным.
- [ ] Отправка: Telegram — оформленное сообщение с кнопкой кампании; MAX, VK
      и выключенные ключи — простой текст; на каждого получателя —
      `bot_message_sent` с `kind: news`.
- [ ] Простые рассылки ведут себя как раньше, `broadcasts.test.ts` зелёный
      без правок.
- [ ] `docs/29` §7.2 описывает оформленную рассылку.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(broadcasts): Оформленные рассылки из Markdown`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое [telegram]: новости в боте — с заголовками, списками и таблицами`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОФОРМЛЕННЫЕ РАССЫЛКИ, СЕРВЕР**

  У рассылки появился формат «оформленный»: текст пишется ограниченным Markdown — заголовки, жирный и курсив, ссылки, списки, цитаты, таблицы и раскрывающиеся блоки. Telegram показывает его оформленным, MAX и VK — тем же текстом без разметки (Р199).

  🛠 **Что внутри**

  • ошибки разметки — с номером строки, до сохранения черновика
  • оформленную рассылку запускают только после теста себе этой же редакции
  • тема «Новости» и событие bot_message_sent у каждого получателя

  ⚙️ **Настройки**

  • оформление — при включённых bot.formats.enabled и bot.rich.enabled; иначе уходит тот же текст без разметки

  ❓ **Нужно от команды**

  • редактор в панели — следующей задачей (T-0404); до неё формат задаётся только через API
  ```
