---
id: T-0282
title: Болотник — враг, оставляющий ядовитые лужи: поле `trail` у врага, лужи в мире, облик на земле
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0281]
zones:
  - packages/core-game/src/game/sim/hazards.ts
  - packages/core-game/test/hazards.test.ts
shared:
  - packages/core-game/src/game/render/art-atlas.ts
  - packages/shared-types/src/index.ts
  - packages/core-game/src/content/enemies.ts
  - packages/core-game/src/content/waves.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/step.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/patterns/enemy-types.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/src/game/render/looks.ts
  - packages/core-game/test/**
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/screens/guide/guide-data.ts
  - packages/app-shell/test/**
  - CLAUDE.md
  - docs/32-balance.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/meta-v2.md
batch: 6
---

# T-0282. Болотник — враг, оставляющий ядовитые лужи: поле `trail` у врага, лужи в мире, облик на земле

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0282.json)](README.md#значки-статуса) [![T-0281](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0281.json&label=T-0281)](T-0281-ice-spirit-and-flail.md)

## Зачем

Сейчас игрок может кружить на одном месте: враги идут к нему, и поле
одинаково безопасно везде. Болотник (Р157) зонирует поле: он преследует и
оставляет за собой лужи яда. Стоять в них больно, поэтому приходится
двигаться и выбирать путь.

После задачи у врага есть необязательное поле `trail` — след из луж. Мир
держит лужи, бьёт игрока в них и рисует их на земле. Болотник — первый враг
с этим полем.

## Решения

Решение владельца — Р157, `design/art/meta-v2.md` §6.1: Болотник — `chase`,
оставляет лужи яда.

Решения `claude-lead-1` от 25.10.2026 (числа стартовые, геймдизайнер
калибрует):

- **Поле врага** `trail` — данными, у любого паттерна:
  `trail: { everySec, radius, lifeSec, damagePerSec }`.
  - Коридоры (тест контента называет врага и поле):
    - `everySec` 0,5…5;
    - `radius` 12…60;
    - `lifeSec` 1…8;
    - `damagePerSec` 1…20.
  - Стихия луж — `element` врага, шанс состояния — его `statusChance`.

  Новый код не нужен следующим врагам со следом — только данные.
- **Лужи в мире** — `sim/hazards.ts`:
  - пул на 64 лужи; переполнение — заменяется самая старая;
  - лужа ставится в точке врага каждые `everySec` его жизни, первая — через
    `everySec` после появления;
  - умер враг — его лужи доживают свой срок.
- **Урон** — игрок в луже (расстояние центра до игрока меньше `radius` +
  радиус игрока) получает урон тиками по 0,5 с:
  - урон тика — `damagePerSec × 0,5`;
  - одна лужа на тик: перекрытые лужи не складываются;
  - урон идёт через `damagePlayer` — броня, сопротивление и щит работают как
    обычно;
  - состояние стихии — с `statusChance` за тик.
- **Детерминизм** — без случайности: место и время лужи — из движения врага.
  Лужи — в снимке забега.
- **Облик:**
  - полупрозрачный круг на земле тоном стихии (`render/status-tones.ts`);
  - слой земли — под врагами;
  - последние 0,8 с жизни — гаснет;
  - в режиме арта — тот же круг до кадров лужи (пункт 16 очереди). Кадры
    самого Болотника готовы: `bog_lurker/s<ступень>/walk<k>` в паке `atlas-r157`.
    Пак `atlas-r157` движок ещё не грузит: первая из задач T-0281…T-0285
    добавляет в `ATLASES` (`render/art-atlas.ts`) строку `art-r157` по образцу
    `art-late`, остальные её уже застают.
  - кадры лужи готовы: `fx/puddle_bog0…2` в паке `atlas-r157` — свежая,
    подсохшая, гаснущая; рендер растягивает до `trail.radius` и в последние
    0,8 с берёт кадр 2.

  Лужи **обязательны для чтения боя**: выключатель «Телеграфы» их не прячет.
- **Болотник** `bog_lurker`:
  - `{ hp: 40, speed: 34, damage: 8, xp: 6, threat: 6, pattern: "chase" }`;
  - `element: "poison"`, `statusChance: 0.5`;
  - `resist: { poison: 0.6, fire: -0.4 }`;
  - `trail: { everySec: 1.5, radius: 26, lifeSec: 4, damagePerSec: 5 }`.

  Таймлайн:
  - отдельный отрезок после 300 с (`perSec: 0.4`, `burst: 3`);
  - потом — пул `ENDLESS_CURVE`.
- **Тексты:**
  - `enemy.bog_lurker.name` — «Болотник»;
  - в гайдбуке у Болотника строка «Оставляет ядовитые лужи — не стой в них».
    Её даёт `guide-data.ts` по полю `trail` у любого врага.
- **`CLAUDE.md`** — в «Как добавить врага» абзац про `trail` с примером.

## Как сейчас

- **Враги и параметры** — `content/enemies.ts`; тип `EnemyDef` и
  `EnemyPatternParams` — `shared-types`; умолчания — `PATTERN_DEFAULTS`
  (`patterns/enemy-types.ts`).
- **Урон игроку** — `sim/world.ts:459` (`damagePlayer`).
- **Состояния игрока** — `sim/player-status.ts`; тона — `render/status-tones.ts`.
- **Снимок** — `run/snapshot.ts`.
- **Гайдбук** — собирает врагов из контента (`screens/guide/guide-data.ts`).

## Шаги по порядку

1. **Тесты первым коммитом** — `hazards.test.ts` и строки теста контента.
2. **Тип** — `trail` в `EnemyDef`; проверка контента.
3. **`sim/hazards.ts`** — пул, постановка, урон тиками; вызов в `step.ts`;
   место в мире и снимке.
4. **Облик** — круг в `WorldRenderer.ts`, тон — `looks.ts`.
5. **Данные** — Болотник, таймлайн, тексты.
6. **Эталоны** — обновить в том же PR, `pnpm balance:sim` до и после.
7. **Документы** — `CLAUDE.md`; `docs/32` — строка Болотника и правило луж.

## Чего не трогаем

- Код паттерна `chase`.
- Другие новые враги — T-0283–T-0285.

## Тесты

Первым коммитом.

- `hazards.test.ts`:
  - враг с `trail.everySec = 1.5` за 4,6 с жизни ставит 3 лужи;
  - игрок в луже 1 с → два тика по `damagePerSec × 0,5`;
  - в двух перекрытых лужах — тот же урон, что в одной;
  - лужа живёт `lifeSec` и исчезает; умер враг — лужи остаются;
  - 65-я лужа вытесняет самую старую;
  - снимок с лужами → восстановление → тот же ход.
- Тест контента:
  - `trail.radius = 70` → «враг bog_lurker: trail.radius вне 12…60»;
  - враг со следом без стихии — допустим, урон без состояния.

## Аналитика

Нет новых событий.

## Настройки и окружение

Нет. Лужи — часть чтения боя, под выключатель не попадают
(`docs/27-design-system-and-app-shell.md` §7.1); решение записать в PR.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Болотник оставляет лужи яда; игрок в луже получает урон тиками и травится.
- [ ] Поле `trail` — данными у любого врага, с проверкой коридоров.
- [ ] Детерминизм и снимок сохраняются; эталоны обновлены с замером.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Болотник и ядовитые лужи`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: Болотник — оставляет ядовитые лужи, в них лучше не стоять`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — БОЛОТНИК**

  Новый враг Болотник оставляет за собой ядовитые лужи: поле больше не одинаково безопасно, приходится двигаться. След — поле trail у врага, новые враги со следом — только данными.
  ```
