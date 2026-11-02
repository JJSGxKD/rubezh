---
id: T-0370
title: «Предел» в снимке контента и отпечатке; после изгнания последнего предмета — «Предел», а не лечение
epic: E10
priority: P2
status: done
owner: claude-10 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: [T-0194]
zones:
  - packages/core-game/src/content/snapshot.ts
  - packages/core-game/src/content/snapshot-schema.ts
  - packages/core-game/src/game/content-problems.ts
  - packages/core-game/src/game/run-world.ts
  - packages/core-game/src/game/progression/card-tools.ts
  - packages/core-game/test/content-snapshot.test.ts
  - packages/core-game/test/card-tools.test.ts
shared:
  - packages/core-game/src/game/balance/simulate.ts
  - packages/core-game/test/content.test.ts
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
merge: lead
design: null
batch: 3
---

# T-0370. «Предел» в снимке контента и отпечатке; после изгнания последнего предмета — «Предел», а не лечение

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0370.json)](README.md#значки-статуса) [![T-0194](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0194.json&label=T-0194)](T-0194-limit-break-offers.md)

## Зачем

T-0194 добавила «Предел» — малые прибавки, когда прокачивать нечего. Записи
`LIMITS` (`content/upgrades.ts`) влияют на бой, но в снимок контента
`ContentSnapshot` и в его отпечаток `CONTENT_HASH` не попали. Правка шага
«Предела» поэтому не меняет версию баланса: запись забега со старыми шагами
проверялась бы с новыми под тем же отпечатком, а sim-worker и редактор баланса
этих чисел не видят. Вторая дыра — изгнание: если игрок изгнал последний
предмет из выбора, остаётся одна карточка лечения, хотя по T-0194 вместо неё
должен быть «Предел».

## Решения

Ответы `claude-lead-1` на вопросы PR #628 (T-0194), 02.11.2026. Исполнитель их
не пересматривает.

1. **Поле снимка `limits: readonly LimitDef[]`** — в `ContentSnapshot` сразу
   после `cardToolRules` (перед `balanceTargets`), в `CONTENT_SNAPSHOT` —
   `limits: LIMITS`, в `hashSnapshot` — последним элементом массива, после
   `snapshot.cardToolRules`. Порядок полей снимка и хэша один (правило шапки
   `snapshot.ts`). `CONTENT_HASH` поменяется — это ожидаемо и правильно: шаги
   «Предела» стали частью версии баланса. `schemaVersion` остаётся `1`: поле
   добавлено, смысл прежних не менялся.
2. **Схема снимка** (`snapshot-schema.ts`): `limits` — массив `strictObject`
   записей `LimitDef` (те же поля и типы, что в `shared-types`: `id`,
   `nameKey`, `descriptionKey`, `stat`, `step`, необязательный `weight`),
   поле обязательное. Проверки смысла (шаг больше нуля, не больше 5% предела,
   известный параметр, повтор id) — не в схеме, а в `findContentProblems`
   (правило шапки `snapshot-schema.ts`).
3. **`findContentProblems`** (`content-problems.ts`): раздел `limits` —
   `add("limits", findLimitProblems(content.limits))`, по образцу раздела
   `secrets`.
4. **Мир берёт записи из снимка, а не импортом.** `run-world.ts`:
   `limits: content.limits` вместо `limits: LIMITS`; импорт `LIMITS` из
   `content/upgrades` уходит. Так же `balance/simulate.ts`, если он передаёт
   `LIMITS` напрямую: из снимка, который ему передан.
5. **Изгнание последнего предмета** (`card-tools.ts`, ветка `pool.length ===
   0`): когда после изгнания карточек не осталось, вместо `[healOption()]` —
   `buildLimitOffers(world, world.cardRng)` из `levels.ts`. Генератор —
   `world.cardRng` (поток инструментов карточек), а не `world.rng`: иначе
   изгнание сдвигало бы все следующие броски забега. `buildLimitOffers` сам
   вернёт одно лечение, если записей «Предела» не осталось, — запасной
   вариант сохраняется.
6. **`content-snapshot.json`.** Если `scripts/content/export-snapshot.ts`
   кладёт снимок в отслеживаемый файл, он пересобирается той же командой, что
   и раньше (см. шапку скрипта); руками JSON не правится.

## Как сейчас

- `content/snapshot.ts` — `ContentSnapshot`, `CONTENT_SNAPSHOT`,
  `hashSnapshot`: поля от `enemies` до `cardToolRules` и `balanceTargets`;
  `limits` нет.
- `game/run-world.ts:4` — `import { LIMITS } from "../content/upgrades"`,
  `:68` — `limits: LIMITS`.
- `game/progression/card-tools.ts:≈138` — `if (progression.offers.length ===
  0) progression.offers = [healOption()];`.
- `game/progression/limit.ts` — `findLimitProblems`, `limitCandidates`;
  `levels.ts` — `buildLimitOffers(world, rng)`.
- `game/content-problems.ts:≈74` — разделы по образцу `add("secrets", …)`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. `snapshot.ts` и `snapshot-schema.ts` — решения 1–2.
3. `content-problems.ts` — решение 3.
4. `run-world.ts` (и `simulate.ts`, если нужно) — решение 4.
5. `card-tools.ts` — решение 5.
6. Golden: `CONTENT_HASH` в эталонах, где он записан, обновить из прогона;
   других сдвигов быть не должно (поведение забега не меняется, кроме
   изгнания последнего предмета).
7. Документы и гейт.

## Чего не трогаем

- Сами числа `LIMITS` и правила «Предела» (T-0194).
- Сундук: «Предел» он по-прежнему не выдаёт.
- Переброс и пропуск карточек.

## Тесты

Первым коммитом.

`packages/core-game/test/content-snapshot.test.ts`:

- `CONTENT_SNAPSHOT.limits` — тот же массив, что `LIMITS` (`toBe`);
- поле `limits` есть в списке полей снимка в том же месте, что в хэше (по
  образцу проверки `secrets`);
- `hashSnapshot` меняется, если поменять `step` одной записи в копии снимка;
- `contentSnapshotSchema` разбирает `CONTENT_SNAPSHOT` и отвергает запись
  `limits` с лишним полем и снимок без `limits`.

`packages/core-game/test/content.test.ts`: `findContentProblems` на копии
снимка с записью `limits`, у которой `step: 0`, возвращает ошибку раздела
`limits` с id записи.

`packages/core-game/test/card-tools.test.ts`:

- мир, где после изгнания единственной карточки предмета кандидатов не
  осталось, а записи «Предела» есть, — `progression.offers` состоит из
  карточек `kind: "limit"` (сколько — по правилам `buildLimitOffers`: при
  здоровье ниже половины последняя — лечение);
- тот же сценарий без записей «Предела» в мире — одна карточка лечения, как
  раньше;
- изгнание не трогает `world.rng`: состояние генератора до и после равно.

## Аналитика

Нет новых событий. `CONTENT_HASH` уезжает в итог забега и аналитику как
раньше — он просто начинает учитывать «Предел».

## Настройки и окружение

Нет.

## Документы

- `docs/30-configuration-map.md`, строка «Предела» (её добавила T-0194):
  «входит в снимок контента и `CONTENT_HASH`».

## Критерии приёмки

- [ ] Правка шага записи `LIMITS` меняет `CONTENT_HASH`.
- [ ] Мир забега берёт записи «Предела» из снимка контента.
- [ ] После изгнания последнего предмета — карточки «Предела», а не одно
      лечение (если записи остались).
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(core-game): Внести «Предел» в снимок контента`
- **Метка:** `release: patch`
- **Для игроков:** `- исправлено: после изгнания последнего предмета выбор предлагает «Предел», а не одно лечение`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — «ПРЕДЕЛ» В ВЕРСИИ БАЛАНСА**

  Шаги «Предела» вошли в снимок контента и его отпечаток: правка этих чисел теперь меняет версию баланса, как и любые другие числа боя. После изгнания последнего предмета выбор предлагает «Предел», а не одно лечение.
  ```
