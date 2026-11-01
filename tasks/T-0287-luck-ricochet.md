---
id: T-0287
title: Навыки атаки — Удача (критические удары и крупнее сундуки) и Рикошет (снаряды отскакивают к следующему врагу)
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0286]
zones:
  - packages/core-game/src/game/sim/crit.ts
  - packages/core-game/test/passives-attack-v2.test.ts
shared:
  - packages/app-shell/src/screens/game-glyphs.tsx
  - packages/shared-types/src/index.ts
  - packages/core-game/src/content/upgrades.ts
  - packages/core-game/src/content/unlocks.ts
  - packages/core-game/src/game/progression/passives.ts
  - packages/core-game/src/game/progression/upgrade-changes.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/combat.ts
  - packages/core-game/src/game/sim/chests.ts
  - packages/core-game/src/game/sim/rng.ts
  - packages/core-game/src/game/weapons/shooting.ts
  - packages/core-game/src/game/weapons/projectile-nearest.ts
  - packages/core-game/src/game/weapons/projectile-facing.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/test/**
  - packages/app-shell/src/screens/run/upgrade-format.ts
  - packages/app-shell/src/screens/item-icons.tsx
  - packages/app-shell/src/audio/recipes.ts
  - packages/app-shell/src/i18n/ru.json
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

# T-0287. Навыки атаки — Удача (критические удары и крупнее сундуки) и Рикошет (снаряды отскакивают к следующему врагу)

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0287.json)](README.md#значки-статуса) [![T-0286](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0286.json&label=T-0286)](T-0286-vampirism-steadfast.md)

## Зачем

Навыки атаки сейчас — урон, перезарядка, площадь и число снарядов. Два
новых навыка дизайнера (Р157) меняют, как ощущается бой:
- **Удача** — часть ударов критическая (двойной урон, крупная яркая цифра),
  и сундуки чаще большие;
- **Рикошет** — снаряд после попадания отскакивает к следующему врагу.

Оба — новые механики, поэтому это код.

## Решения

Решение владельца — Р157, `design/art/meta-v2.md` §6.2: Удача — шанс крита и
сундука, Рикошет — +отскок.

Решения `claude-lead-1` от 25.10.2026 (числа стартовые):

- **Удача** `luck`:
  - категория `attack`;
  - `stat: "luck"`, `op: "add"`, `levels: [0.06, 0.12, 0.18]`.

  Даёт:
  - **крит** — шанс удара `luck`, урон ×2. Крит — у всего урона оружия,
    кроме тиков состояний.
    - Бросок — своим потоком `deriveSeed(seed, STREAM_SALT.crit)` в
      `sim/rng.ts`: `world.rng` крит не трогает, эталоны без Удачи не
      сдвигаются (как у сундуков).
    - Цифра урона крита — крупнее и тоном `accent` (`WorldRenderer.ts`, под
      выключателем `damageNumbers`).
    - Звук — короткий звонкий щелчок (`audio/recipes.ts`), не чаще раза в
      0,15 с.
  - **сундуки** — веса размеров 3 и 5 в `CHESTS.sizes` умножаются на `1 +
    luck × 2`. Открывающие сундуки `opening` не меняются. Бросок — по-прежнему
    потоком сундуков.
- **Рикошет** `ricochet`:
  - категория `attack`;
  - `stat: "ricochet"`, `op: "add"`, `levels: [1, 2, 3]` — отскоков.

  Правила:
  - только поведения со снарядами: `projectile_nearest`, `projectile_facing`;
  - снаряд, попавший во врага, летит к ближайшему другому живому врагу в
    радиусе 160 и не к тому, в кого уже попал;
  - урон каждого отскока ×0,7 к прошлому;
  - `pierce` и отскок: сначала тратится `pierce`, потом отскоки;
  - ближний враг — из сетки (`sim/grid.ts`), без случайности.
- **Карточка** — подписи в `upgrade-format.ts`:
  - «шанс крита 6 % → 12 %»;
  - «отскоки 1 → 2».
- **Открытие** — `unlocks.ts`: Удача на 21-м уровне, Рикошет — на 23-м.
- **Рецепт эволюции** — Рикошет станет рецептом «Ожерелья» Рябиновых бус
  (T-0290).
- **Тексты:**
  - `passive.luck.name` — «Удача», `.description` — «Иногда удар вдвое сильнее, а сундуки — богаче»;
  - `passive.ricochet.name` — «Рикошет», `.description` — «Снаряд отскакивает к следующему врагу».
- **Значки** — `item-icons.tsx`.

## Как сейчас

- **Навыки** — `content/upgrades.ts` (`op: "add" | "mul"`, значение уровня —
  итоговое).
- **Попадания и урон** — `sim/combat.ts`; снаряды —
  `weapons/shooting.ts`, `projectile-nearest.ts`, `projectile-facing.ts`.
- **Сундуки** — `content/chests.ts` (`sizes`, `opening`), `sim/chests.ts`; поток —
  `deriveSeed(seed, STREAM_SALT.chest)` в `sim/rng.ts`.
- **Цифры урона** — `render/WorldRenderer.ts`, выключатель `damageNumbers`.

## Шаги по порядку

1. **Тесты первым коммитом** — `passives-attack-v2.test.ts`.
2. **Параметры** `luck`, `ricochet`; поток `STREAM_SALT.crit`.
3. **`sim/crit.ts`** — бросок крита; вызов в месте урона оружия.
4. **Сундуки** — веса с Удачей.
5. **Рикошет** — в снарядах.
6. **Облик и звук** крита.
7. **Данные** — навыки, открытия, тексты, значки (готовы: `luck` и
   `ricochet` из `PLANNED_PASSIVE_GLYPHS` в `game-glyphs.tsx` переезжают в
   `PASSIVE_GLYPHS`), подписи.
8. **Эталоны** — обновить, `pnpm balance:sim` до и после.
9. **Документы:**
   - `CLAUDE.md` — новые `stat`;
   - `docs/32` — строки навыков и правило крита.

## Чего не трогаем

- Поведения без снарядов — рикошета у них нет.
- Тики состояний — без крита.

## Тесты

Первым коммитом, `passives-attack-v2.test.ts`:
- Удача 0,12 на 10 000 ударов — доля критов 0,12 ± 0,01, урон крита ×2;
- без Удачи — ни одного крита, ход забега побитно тот же (поток не тронут);
- веса сундуков с Удачей 0,12: размеры 3 и 5 — ×1,24, `opening` без изменений;
- Рикошет 2: снаряд бьёт трёх разных врагов, урон 1 → 0,7 → 0,49;
- нет врага в 160 — снаряд гаснет; в того же врага не возвращается;
- `pierce: 1` и Рикошет 1: сначала пробивает, потом отскакивает;
- снимок с летящим отскоком → восстановление → тот же ход.

## Аналитика

Нет новых событий.

## Настройки и окружение

Нет. Цифра крита — под существующим `damageNumbers`.

## Документы

По шагу 9.

## Критерии приёмки

- [ ] Удача даёт критические удары своим потоком случайности и богаче сундуки; без неё эталоны не сдвинулись.
- [ ] Рикошет уводит снаряд к следующему врагу с падением урона.
- [ ] Открытия на 21-м и 23-м уровнях; карточка и значки на месте; эталоны с Удачей и Рикошетом обновлены с замером.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Навыки Удача и Рикошет`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: навыки Удача (критические удары, богаче сундуки) и Рикошет (снаряды отскакивают)`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — УДАЧА И РИКОШЕТ**

  Два новых навыка атаки: Удача — критические удары вдвое сильнее и чаще большие сундуки, Рикошет — снаряд отскакивает к следующему врагу. Крит бросается своим потоком случайности: забеги без Удачи не изменились.
  ```
