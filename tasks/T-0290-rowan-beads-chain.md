---
id: T-0290
title: Рябиновые бусы — поведение `chain`: снаряд перескакивает между врагами и травит; эволюция «Ожерелье»
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0289]
zones:
  - packages/core-game/src/game/weapons/chain.ts
  - packages/core-game/test/chain-weapon.test.ts
shared:
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
  - packages/core-game/test/**
  - packages/app-shell/src/screens/item-icons.tsx
  - packages/app-shell/src/audio/recipes.ts
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/test/**
  - backend/api/src/modules/tasks/task-rules.ts
  - CLAUDE.md
  - docs/32-balance.md
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/meta-v2.md
batch: 6
---

# T-0290. Рябиновые бусы — поведение `chain`: снаряд перескакивает между врагами и травит; эволюция «Ожерелье»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0290.json)](README.md#значки-статуса) [![T-0289](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0289.json&label=T-0289)](T-0289-gusli-cone-knockback.md)

## Зачем

Рябиновые бусы (Р157) — оберег от нечисти. Ягода летит во врага и
перескакивает к следующему, травя каждого. Против плотной толпы одна ягода
отравляет цепочку; против одиночки она слабая. Это оружие роя.

Последняя задача нового контента Р157. После неё раздел решения закрыт.

## Решения

Решение владельца — Р157, `design/art/meta-v2.md` §6.2:
- Рябиновые бусы — снаряд отскакивает между врагами, ядом;
- эволюция «Ожерелье» — больше отскоков.

Решения `claude-lead-1` от 25.10.2026 (числа стартовые):

- **Поведение `chain`:**
  - снаряд — в ближайшего врага, как `projectile_nearest`;
  - после попадания — прыжок к ближайшему другому живому врагу в
    `chainRadius` (новое поле), не к уже задетым этой цепью;
  - прыжков — `bounces` (новое поле);
  - урон каждого прыжка — без падения: ослабляет не урон, а то, что цепь
    кончается;
  - врага рядом нет — цепь гаснет.
  - Рикошет (T-0287) прибавляет прыжки цепи — `bounces + ricochet`.
- **Числа уровня** — `damage`, `cooldownSec`, `projectiles`, `projectileSpeed`,
  `chainRadius`, `bounces`, `statusChance`. Уровни 1…5:
  `{ damage: 7, cooldownSec: 0.9, projectiles: 1, projectileSpeed: 480, chainRadius: 120, bounces: 2, statusChance: 0.4 }` →
  `{ damage: 11, cooldownSec: 0.7, projectiles: 2, projectileSpeed: 520, chainRadius: 140, bounces: 4, statusChance: 0.55 }`.
- **Бусы** `rowan_beads`, стихия `poison`.
- **Эволюция** «Ожерелье» `necklace`:
  - `evolvedFrom: "rowan_beads"`, `recipe: { passive: "ricochet" }` (T-0287);
  - один уровень `{ damage: 18, cooldownSec: 0.6, projectiles: 3, projectileSpeed: 560, chainRadius: 160, bounces: 8, statusChance: 0.7 }`;
  - сила в коридоре.
- **Детерминизм** — ближний враг — из сетки (`sim/grid.ts`), при равных
  расстояниях — меньший индекс. Случайности нет.
- **Облик:**
  - красная ягода;
  - прыжок — тонкая нить от врага к врагу на 0,15 с, под `weaponEffects`;
    ягода видна всегда.
- **Звук** — короткий «тык» на каждый прыжок, не чаще раза в 0,06 с
  (`audio/recipes.ts`).
- **Открытие** — Бусы на 24-м уровне; это последний уровень лестницы: открыто
  всё, слоты равны `LOADOUT_LIMITS`.
- **Тексты:**
  - `weapon.rowan_beads.name` — «Рябиновые бусы», `.description` — «Ягода перескакивает между врагами и травит»;
  - `weapon.necklace.name` — «Ожерелье», `.description` — «Длинная цепь ягод».
- **Значок** — `item-icons.tsx`; задания с фильтром оружия — `rowan_beads`,
  если список есть.
- **`docs/35`** — у Р157 отметка «сделано: T-0281–T-0290».

## Как сейчас

- **Поведения** — `game/weapons/`; снаряды — `shooting.ts`; после T-0287 —
  рикошет у снарядов.
- **Состояния и яд** — `sim/elements.ts`, `statusChance` у уровня.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`weapons/chain.ts`**, поля `chainRadius`, `bounces`, реестр.
3. **Облик и звук.**
4. **Данные** — Бусы, «Ожерелье», открытие, тексты, значок.
5. **Эталоны** — обновить, `pnpm balance:sim` до и после.
6. **Документы:**
   - `CLAUDE.md` — строка `chain` в таблице поведений;
   - `docs/32` — строки;
   - `docs/35` — отметка у Р157.

## Чего не трогаем

- Другие поведения.

## Тесты

Первым коммитом, `chain-weapon.test.ts`:
- `bounces: 2` — три разных врага, каждому полный урон;
- уже задетого цепь не берёт; врага в `chainRadius` нет — цепь гаснет;
- с Рикошетом 1 — на один прыжок больше;
- при равных расстояниях — меньший индекс;
- то же зерно — тот же ход; снимок с летящей ягодой → восстановление → тот
  же ход;
- эволюция в коридоре силы.

## Аналитика

Нет новых событий.

## Настройки и окружение

Нет. Нить прыжка — под `weaponEffects`.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] Ягода перескакивает между врагами и травит; Рикошет добавляет прыжки.
- [ ] «Ожерелье» — длинная цепь; рецепт — Рикошет; Бусы открываются на 24-м уровне, лестница кончается полным набором.
- [ ] Детерминизм сохранён; эталоны обновлены с замером.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Рябиновые бусы — цепь по врагам`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: оружие Рябиновые бусы — ягода перескакивает между врагами и травит, эволюция «Ожерелье»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РЯБИНОВЫЕ БУСЫ**

  Новое оружие Рябиновые бусы: ягода перескакивает от врага к врагу и травит — оружие роя. Открывается на 24-м уровне, эволюция «Ожерелье», рецепт — Рикошет. Новый контент Р157 собран целиком.
  ```
