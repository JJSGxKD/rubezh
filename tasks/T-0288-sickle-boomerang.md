---
id: T-0288
title: Серп — поведение `boomerang`: летит к врагу и возвращается, режет на обоих путях; эволюция «Жатва»
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0287]
zones:
  - packages/core-game/src/game/weapons/boomerang.ts
  - packages/core-game/test/boomerang.test.ts
shared:
  - packages/core-game/src/game/render/art-atlas.ts
  - packages/shared-types/src/index.ts
  - packages/core-game/src/content/weapons.ts
  - packages/core-game/src/content/unlocks.ts
  - packages/core-game/src/game/weapons/index.ts
  - packages/core-game/src/game/weapons/weapon-types.ts
  - packages/core-game/src/game/weapons/shooting.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/src/game/render/weapon-effects.ts
  - packages/core-game/src/game/render/looks.ts
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

# T-0288. Серп — поведение `boomerang`: летит к врагу и возвращается, режет на обоих путях; эволюция «Жатва»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0288.json)](README.md#значки-статуса) [![T-0287](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0287.json&label=T-0287)](T-0287-luck-ricochet.md)

## Зачем

Снаряды сейчас летят и исчезают. Серп (Р157) — бумеранг:
- летит к врагу на дальность и возвращается к игроку;
- режет всех на обоих путях.

Встань так, чтобы толпа была на линии, — и серп пройдёт по ней дважды. Это
первое оружие, которое награждает позицию, а не только наведение.

## Решения

Решение владельца — Р157, `design/art/meta-v2.md` §6.2:
- Серп — бумеранг, режет на обоих путях;
- эволюция «Жатва» — два серпа крест-накрест.

Новое поведение — код.

Решения `claude-lead-1` от 25.10.2026 (числа стартовые):

- **Поведение `boomerang`:**
  - бросок — в сторону ближайшего врага (как `projectile_nearest`), нет
    врагов — по движению;
  - путь туда — `range` за `ttlSec / 2`, с замедлением к концу;
  - путь обратно — к **текущей** позиции игрока, с разгоном; у игрока гаснет;
  - каждый враг получает урон не чаще раза за путь: туда — раз, обратно — ещё
    раз;
  - `projectiles` больше 1 — веером ±15° на снаряд.
  - Рикошета (T-0287) у бумеранга нет: он и так возвращается.
- **Числа уровня** — поле `range` (новое) и готовые `damage`, `cooldownSec`,
  `projectiles`, `projectileSpeed`, `ttlSec`.

  Уровни 1…5, стартово:
  `{ damage: 14, cooldownSec: 1.3, projectiles: 1, range: 220, ttlSec: 1.2 }` →
  `{ damage: 24, cooldownSec: 1.0, projectiles: 2, range: 260, ttlSec: 1.1 }`.
- **Серп** `sickle`, стихии нет.
- **Эволюция** «Жатва» `harvest`:
  - `evolvedFrom: "sickle"`, `recipe: { passive: "vampirism" }` (T-0286);
  - один уровень `{ damage: 40, cooldownSec: 0.9, projectiles: 4, range: 260, ttlSec: 1.1 }` —
    четыре серпа крестом: веер заменяется на четыре стороны;
  - сила в коридоре `EVOLUTION_POWER_RATIO`.
- **Детерминизм** — без случайности. Без `Math.sin`, `cos`, `atan2` в
  `weapons/*` (`sim-purity.test.ts`): веер и крест — приёмами
  `game/sim/directions.ts`.
- **Облик:**
  - серп — изогнутый клинок, вращается в полёте (вращение — только в
    рендере);
  - след — под `weaponEffects`.
- **Звук** — свист броска и тихий «вжик» возврата (`audio/recipes.ts`).
- **Открытие** — Серп на 20-м уровне (`unlocks.ts`).
- **Тексты:**
  - `weapon.sickle.name` — «Серп», `.description` — «Летит к врагу и возвращается — режет на обоих путях»;
  - `weapon.harvest.name` — «Жатва», `.description` — «Четыре серпа крестом».
- **Значок** — `item-icons.tsx`. Задания с фильтром оружия — `sickle` в
  список, если он есть (`tasks/task-rules.ts`).

## Как сейчас

- **Поведения** — `game/weapons/`:
  - реестр `WEAPON_BEHAVIORS` в `index.ts`;
  - тип `WeaponBehaviorImpl` — `behavior.ts`;
  - снаряды — `shooting.ts`, `projectile-nearest.ts`;
  - числа уровня — `weapon-types.ts`.
- **Эффекты** — `render/weapon-effects.ts`.
- **Образец новой записи оружия с эволюцией** — T-0118 «Метеор»
  (`tasks/archive/T-0118-*.md`).

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`weapons/boomerang.ts`**, поле `range`, реестр.
3. **Облик и звук.**
4. **Данные** — Серп, «Жатва», открытие, тексты, значок.
   Кадры снаряда готовы (31.10.2026, пак `atlas-r157`): `fx/proj_sickle0…1` и у «Жатвы» `fx/proj_harvest0…1` — два кадра поворота. Пак
   движок подключает строкой `art-r157` в `ATLASES`, если её ещё нет
   (`render/art-atlas.ts`).
5. **Эталоны** — обновить, `pnpm balance:sim` до и после.
6. **Документы:**
   - `CLAUDE.md` — строка `boomerang` в таблице поведений;
   - `docs/32` — строки Серпа и «Жатвы».

## Чего не трогаем

- Другие поведения.

## Тесты

Первым коммитом, `boomerang.test.ts`:
- серп долетает на `range` и возвращается к сдвинувшемуся игроку;
- враг на линии получает урон дважды: туда и обратно; не чаще раза за путь;
- нет врагов — бросок по движению;
- «Жатва» — четыре серпа по четырём сторонам;
- то же зерно — тот же ход; снимок с летящим серпом → восстановление → тот же
  ход;
- эволюция в коридоре силы.

## Аналитика

Нет новых событий.

## Настройки и окружение

Нет. След — под `weaponEffects`.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] Серп летит к врагу и возвращается, режет на обоих путях; открывается на 20-м уровне.
- [ ] «Жатва» — четыре серпа; рецепт — Вампиризм.
- [ ] Детерминизм сохранён; эталоны обновлены с замером.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Серп — оружие-бумеранг`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: оружие Серп — летит и возвращается, эволюция «Жатва»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СЕРП**

  Новое оружие Серп: бумеранг, режет на пути к врагу и обратно — награждает позицию. Открывается на 20-м уровне, эволюция «Жатва» — четыре серпа крестом, рецепт — Вампиризм.
  ```
