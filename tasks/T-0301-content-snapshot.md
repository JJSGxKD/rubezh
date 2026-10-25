---
id: T-0301
title: Снимок контента ContentSnapshot — весь контент одним объектом со схемой, проверки контента чистой функцией, движок и бот принимают снимок
epic: E7
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - packages/core-game/src/content/snapshot.ts
  - packages/core-game/src/content/snapshot-schema.ts
  - packages/core-game/src/content/problems.ts
  - packages/core-game/test/content-snapshot.test.ts
  - scripts/content/export-snapshot.ts
shared:
  - packages/core-game/src/content/hash.ts
  - packages/core-game/src/index.ts
  - packages/core-game/src/run-api.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/balance/simulate.ts
  - packages/core-game/test/content.test.ts
  - package.json
  - docs/19-content-admin.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: null
batch: 7
---

# T-0301. Снимок контента ContentSnapshot — весь контент одним объектом со схемой, проверки контента чистой функцией, движок и бот принимают снимок

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0301.json)](README.md#значки-статуса)

## Зачем

Редактор баланса в панели (`docs/19`, AD-13) правит числа контента.
Чтобы черновик можно было проверить и прогнать симуляцией, контент должен
быть **данными**, а не только импортом из `content/*`:
- один объект со схемой;
- проверки, которые сейчас живут в тесте контента, — функцией;
- движок и бот калибровки берут контент параметром.

После задачи это есть. `content/*` остаются источником по умолчанию и
эталоном golden-тестов (Р16).

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- Р16 — движок получает контент снимком (`ContentSnapshot`), а не импортом;
  `content/*` — источник по умолчанию и эталон golden;
- 25.10.2026, опрос — редактор баланса — фаза 1 `docs/19` в два шага:
  1. песочница (эта задача — её основа);
  2. публикация.

Решения `claude-lead-1` от 25.10.2026:

- **`ContentSnapshot`** — объект со всем контентом, который влияет на забег:
  - враги, ступени, таймлайн и кривая бесконечного режима;
  - оружие, навыки, кривая опыта, слоты, открытия;
  - подборы, сундуки, сложность, карты, бусты, продолжения;
  - коридоры `balance-targets.ts` — для отчёта симуляции, в хэш не входят.

  Поле `schemaVersion: 1`. Поля появляются в снимке тем же списком и
  порядком, что в `CONTENT_HASH` (`content/hash.ts`), — снимок и хэш
  сходятся.
- **`CONTENT_SNAPSHOT`** — снимок из `content/*`, по умолчанию.
  **`hashSnapshot(snapshot)`** — хэш тем же способом, что `CONTENT_HASH`;
  для умолчания он равен `CONTENT_HASH`.
- **`contentSnapshotSchema`** — Zod-схема снимка из тех же типов, что у
  `content/*`: проверка формы и коридоров полей (числа, обязательные поля).
- **`findContentProblems(snapshot)`** — все проверки, которые сейчас в
  `content.test.ts` и соседних тестах контента:
  - ссылки на врагов и оружие;
  - паттерны;
  - бюджет угрозы не убывает;
  - элиты только событием;
  - ступени;
  - открытия и слоты;
  - коридоры эволюций.

  Возвращает список `{ path, message }` по-русски, в тех же словах, что тесты
  сейчас. Тест контента вызывает её на `CONTENT_SNAPSHOT` и ждёт пустой список.
  Проверки не дублируются — тест переписывается на функцию.
- **Движок** — `RunOptions.content?: ContentSnapshot`. Нет — `CONTENT_SNAPSHOT`.
  - `createWorld` получает части из снимка: параметры у него уже есть.
  - Итог забега пишет хэш **своего** снимка.
  - Без поля забег побитно прежний: эталоны не сдвигаются.
- **Бот калибровки** — `simulate` принимает снимок.
- **Выгрузка** — `pnpm content:export` пишет в `dist/` (вне git):
  - `content-snapshot.json` — `CONTENT_SNAPSHOT`, из него сервер заводит
    версию 0 (T-0303);
  - `content-snapshot.schema.json` — `z.toJSONSchema(contentSnapshotSchema)`:
    им сервер проверяет форму правки, не импортируя пакеты игры;
  - `content-names.json` — тексты всех `nameKey` и `descriptionKey` снимка из
    словаря игры (`app-shell/src/i18n/*.json`): по ним панель показывает
    имена, а не id. Скрипт читает JSON словаря файлом — пакет `core-game`
    оболочку не импортирует.

## Как сейчас

- **Контент** — `packages/core-game/src/content/*`; хэш — `content/hash.ts`
  (`CONTENT_HASH`).
- **Проверки контента** — `packages/core-game/test/content.test.ts` и соседние;
  часть — функциями в коде (`findBoundsProblems`, `findWeaponContentProblems`).
- **Мир** — `sim/create-world.ts`: `CreateWorldOptions` уже принимает
  `enemies`, `weapons`, `passives`, `levelCurve`, `loadoutLimits`, `drops`,
  `chests`, `difficulty`, `stages`, `map`.
- **Бот** — `game/balance/simulate.ts`.

## Шаги по порядку

1. **Тесты первым коммитом** — `content-snapshot.test.ts`:
   - хэш умолчания равен `CONTENT_HASH`;
   - схема принимает умолчание;
   - испорченный снимок даёт проблему с путём;
   - забег со снимком-умолчанием побитно равен забегу без снимка.
2. **`snapshot.ts`**, `snapshot-schema.ts`.
3. **`problems.ts`** — проверки; `content.test.ts` — на неё.
4. **Движок и бот** — параметр снимка.
5. **`scripts/content/export-snapshot.ts`**, команда `content:export`.
6. **Документы:**
   - `docs/19` §3 — что такое снимок и где он;
   - `docs/30` — строка.

## Чего не трогаем

- Сервер и панель — T-0302–T-0305.
- Числа контента.

## Тесты

Первым коммитом — шаг 1. Плюс: все прежние тесты контента проходят через
`findContentProblems`; эталоны не сдвинулись.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] Весь контент — снимком со схемой и хэшем; для умолчания хэш прежний.
- [ ] Проверки контента — одной функцией, тест контента на ней.
- [ ] Движок и бот принимают снимок; без него забег побитно прежний.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `refactor(core-game): Снимок контента ContentSnapshot`
- **Метка:** `release: patch`
- **Для игроков:** пусто.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СНИМОК КОНТЕНТА**

  Весь контент игры теперь собирается в один снимок со схемой и хэшем, проверки контента — одной функцией, движок и бот калибровки берут снимок параметром. Основа редактора баланса в панели; игра не изменилась.
  ```
