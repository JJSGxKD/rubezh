---
id: T-0289
title: Гусли — поведение `cone`: волна звука конусом по ходу, отталкивает врагов; эволюция «Песнь Баяна» — волна вокруг
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0288]
zones:
  - packages/core-game/src/game/weapons/cone.ts
  - packages/core-game/src/game/sim/knockback.ts
  - packages/core-game/test/cone-weapon.test.ts
shared:
  - packages/app-shell/src/screens/game-glyphs.tsx
  - packages/shared-types/src/index.ts
  - packages/core-game/src/content/weapons.ts
  - packages/core-game/src/content/unlocks.ts
  - packages/core-game/src/game/weapons/index.ts
  - packages/core-game/src/game/weapons/weapon-types.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/step.ts
  - packages/core-game/src/game/patterns/steering.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/src/game/render/weapon-effects.ts
  - packages/core-game/test/**
  - packages/app-shell/src/screens/item-icons.tsx
  - packages/app-shell/src/audio/recipes.ts
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/test/**
  - backend/api/src/modules/tasks/task-rules.ts
  - CLAUDE.md
  - docs/32-balance.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/meta-v2.md
batch: 6
---

# T-0289. Гусли — поведение `cone`: волна звука конусом по ходу, отталкивает врагов; эволюция «Песнь Баяна» — волна вокруг

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0289.json)](README.md#значки-статуса) [![T-0288](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0288.json&label=T-0288)](T-0288-sickle-boomerang.md)

## Зачем

Оружие сейчас только наносит урон: враги, пережившие удар, продолжают идти.
Гусли (Р157) — волна звука конусом по ходу игрока: она бьёт и отталкивает.
Прижали к стене — сыграй, и толпа отлетит. Это первое оружие, которое
управляет пространством.

## Решения

Решение владельца — Р157, `design/art/meta-v2.md` §6.2:
- Гусли — волна звука конусом, отталкивает;
- эволюция «Песнь Баяна» — волна вокруг.

Решения `claude-lead-1` от 25.10.2026 (числа стартовые):

- **Поведение `cone`:**
  - каждые `cooldownSec` — волна из игрока по направлению движения (стоит —
    по последнему направлению);
  - раствор `coneDeg` (новое поле, 30…360, кратно 15), длина `areaRadius`;
  - бьёт всех врагов в секторе раз за волну;
  - попадание в сектор — скалярное произведение направления на врага с
    направлением волны против косинуса половины раствора. Косинус — из
    таблицы `CONE_COS` готовых чисел на каждые 15°, без `Math.cos`:
    тригонометрия в `weapons/*` под запретом (`sim-purity.test.ts`). Раствор
    не кратно 15 — ошибка теста контента с именем оружия.
- **Отталкивание** — `sim/knockback.ts`, новое поле уровня `knockback`
  (единиц):
  - врагу — импульс от игрока, гаснет за 0,25 с;
  - пока импульс жив, рулёжка паттерна (`patterns/steering.ts`) складывается
    с ним;
  - элиты — импульс ×0,5, боссы и стражи кольца — ×0.
- **Числа уровня** — `damage`, `cooldownSec`, `areaRadius`, `coneDeg`,
  `knockback`. Уровни 1…5:
  `{ damage: 10, cooldownSec: 1.4, areaRadius: 150, coneDeg: 60, knockback: 70 }` →
  `{ damage: 18, cooldownSec: 1.0, areaRadius: 190, coneDeg: 90, knockback: 110 }`.
- **Гусли** `gusli`, стихия — `lightning` (звон струн), `statusChance: 0.15`.
- **Эволюция** «Песнь Баяна» `bayan_song`:
  - `evolvedFrom: "gusli"`, `recipe: { passive: "ward" }` («Броня»);
  - один уровень `{ damage: 30, cooldownSec: 0.9, areaRadius: 210, coneDeg: 360, knockback: 140, statusChance: 0.3 }`;
  - сила в коридоре.
- **Облик:**
  - дуга волны расходится и гаснет за 0,3 с, тоном молнии;
  - под `weaponEffects` — только яркость и след. Сама дуга остаётся: по
    ней видно, куда толкнуло.
- **Звук** — аккорд струн, у эволюции — длиннее (`audio/recipes.ts`); не
  чаще срабатывания.
- **Открытие** — Гусли на 22-м уровне.
- **Тексты:**
  - `weapon.gusli.name` — «Гусли», `.description` — «Волна звука по ходу — бьёт и отталкивает»;
  - `weapon.bayan_song.name` — «Песнь Баяна», `.description` — «Волна во все стороны».
- **Значок** готов: `gusli` и `bayan_song` из `PLANNED_WEAPON_GLYPHS`
  (`screens/game-glyphs.tsx`) переезжают в `WEAPON_GLYPHS`; задания с фильтром оружия — `gusli`, если
  список есть.

## Как сейчас

- **Поведения** — `game/weapons/`: `aura.ts` (площадь вокруг),
  `area-strike.ts`; реестр — `index.ts`.
- **Рулёжка врагов** — `patterns/steering.ts`.
- **Направление движения игрока** — в мире (`sim/world.ts`), им пользуется
  `projectile_facing`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`weapons/cone.ts`**, поля `coneDeg`, `knockback`, реестр.
3. **`sim/knockback.ts`** — импульс и его затухание, в снимке.
4. **Облик и звук.**
5. **Данные** — Гусли, «Песнь Баяна», открытие, тексты, значок.
6. **Эталоны** — обновить, `pnpm balance:sim` до и после.
7. **Документы:**
   - `CLAUDE.md` — строка `cone` в таблице поведений;
   - `docs/32` — строки и правило отталкивания.

## Чего не трогаем

- Другие поведения — отталкивания у них нет.

## Тесты

Первым коммитом, `cone-weapon.test.ts`:
- враг в секторе 60° по ходу — урон, за сектором — нет;
- `coneDeg: 360` — все в радиусе;
- отталкивание: рядовой сдвинут на ~`knockback` за 0,25 с, элита — вдвое меньше, босс — нет;
- игрок стоит — волна по последнему направлению;
- то же зерно — тот же ход; снимок с живым импульсом → восстановление → тот
  же ход;
- эволюция в коридоре силы.

## Аналитика

Нет новых событий.

## Настройки и окружение

Нет. Дуга волны — чтение боя; след — под `weaponEffects`.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Гусли бьют конусом по ходу и отталкивают; элиты слабее, боссы не двигаются.
- [ ] «Песнь Баяна» — волна вокруг; рецепт — Броня; открытие на 22-м уровне.
- [ ] Детерминизм сохранён; эталоны обновлены с замером.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Гусли — волна, которая отталкивает`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: оружие Гусли — волна звука отталкивает врагов, эволюция «Песнь Баяна»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ГУСЛИ**

  Новое оружие Гусли: волна звука конусом по ходу бьёт и отталкивает — первое оружие, которое управляет пространством. Открывается на 22-м уровне, эволюция «Песнь Баяна» — волна во все стороны, рецепт — Броня.
  ```
