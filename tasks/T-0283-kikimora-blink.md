---
id: T-0283
title: Кикимора — новый паттерн `blink`: исчезает и появляется рядом с игроком после метки на земле
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0282]
zones:
  - packages/core-game/src/game/patterns/blink.ts
  - packages/core-game/test/blink-pattern.test.ts
shared:
  - packages/core-game/src/game/render/art-atlas.ts
  - packages/shared-types/src/index.ts
  - packages/core-game/src/content/enemies.ts
  - packages/core-game/src/content/waves.ts
  - packages/core-game/src/game/patterns/index.ts
  - packages/core-game/src/game/patterns/behavior.ts
  - packages/core-game/src/game/patterns/enemy-types.ts
  - packages/core-game/src/game/sim/world.ts
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

# T-0283. Кикимора — новый паттерн `blink`: исчезает и появляется рядом с игроком после метки на земле

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0283.json)](README.md#значки-статуса) [![T-0282](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0282.json&label=T-0282)](T-0282-bog-lurker-puddles.md)

## Зачем

Игрок привыкает убегать по прямой: все враги догоняют его телом. Кикимора
(Р157) ломает привычку:
- подходит, исчезает;
- через миг появляется рядом с игроком — сбоку или на пути;
- на месте появления заранее светится метка.

После задачи у движка — паттерн `blink`, у контента — Кикимора.

## Решения

Решение владельца — Р157, `design/art/meta-v2.md` §6.1: новый паттерн
`blink` — исчезает и появляется рядом с телеграфом. Новый паттерн — код
(`CLAUDE.md`, «Как добавить врага»).

Решения `claude-lead-1` от 25.10.2026 (числа стартовые):

- **Паттерн `blink`** — циклом из четырёх фаз:
  1. `chase` — `blinkEverySec` (умолчание 4);
  2. `fading` — 0,25 с: тает, урона не наносит, но его можно бить;
  3. `hidden` — `telegraphSec` (0,6): врага нет на поле, его не бьют, не
     притягивают и не считают ближним для оружия. На месте появления —
     метка на земле;
  4. `appear` — встаёт в точке метки и снова `chase`.

  Касание бьёт только в `chase`.
- **Точка появления:**
  - на расстоянии `blinkDistance` (умолчание 90) от игрока;
  - направление — вперёд по движению игрока ± 60° (стоит — любое).

  Направление — `directionInArc(rng, forward…, 0.866, out)` из
  `game/sim/directions.ts` (синус 60°), без `Math.sin`, `cos` и `atan2`:
  они под запретом в `patterns/*` (`sim-purity.test.ts`). Случайность — из
  `world.rng` в момент начала `fading`, тем же потоком, что сейчас у
  поведения врагов (`patterns/behavior.ts`): детерминизм сохраняется. Точка
  за границей карты — прижимается к границе.
- **Справедливость.** Точка не ближе 60 к игроку (не появляется на нём).
  Метка видна всё `telegraphSec`, даже с выключенными телеграфами: без неё
  урон из ниоткуда.
- **Параметры** — в `EnemyPatternParams` и `PATTERN_DEFAULTS`:
  - `blinkEverySec` — 1,5…10;
  - `telegraphSec` — 0,3…1,5;
  - `blinkDistance` — 60…200.

  Проверка — тестом контента.
- **Кикимора** `kikimora`:
  - `{ hp: 30, speed: 52, damage: 9, xp: 6, threat: 6, pattern: "blink" }`;
  - `resist: { lightning: 0.5, cold: -0.4 }`.

  Таймлайн:
  - отдельный отрезок после 360 с (`perSec: 0.3`, `burst: 2`);
  - потом — пул `ENDLESS_CURVE`.
- **Облик:**
  - фигура — своя у паттерна (`looks.ts`): вытянутый ромб тоном болотной
    зелени;
  - `fading` — прозрачность к нулю;
  - метка — кольцо на земле тоном опасности, сужается к концу `telegraphSec`.
  - в режиме арта — кадры `kikimora/s<ступень>/walk<k>` в паке `atlas-r157`
    (готовы 31.10.2026); таяние — та же прозрачность поверх кадра.
    Пак `atlas-r157` движок ещё не грузит: первая из задач T-0281…T-0285
    добавляет в `ATLASES` (`render/art-atlas.ts`) строку `art-r157` по образцу
    `art-late`, остальные её уже застают.
- **Тексты:**
  - `enemy.kikimora.name` — «Кикимора»;
  - строка гайдбука по паттерну — «Исчезает и появляется рядом — следи за
    меткой на земле».

## Как сейчас

- **Паттерны:**
  - `game/patterns/` — образцы с фазами: `dash.ts` (метка и рывок),
    `exploder.ts`;
  - реестр — `patterns/index.ts`;
  - тип — `behavior.ts`;
  - умолчания — `PATTERN_DEFAULTS` в `enemy-types.ts`.
- **Цели оружия** — ближний враг ищется по сетке (`sim/grid.ts`), враг в
  `hidden` из неё должен выпасть.
- **Телеграфы** — `dash` и `exploder` рисуют метки в `WorldRenderer.ts`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`patterns/blink.ts`**, параметры и умолчания, реестр.
3. **Скрытый враг** — не в сетке целей, не притягивается, касание не бьёт.
4. **Облик** — фигура, таяние, метка.
5. **Данные** — Кикимора, таймлайн, тексты, гайдбук.
6. **Эталоны** — обновить, `pnpm balance:sim` до и после.
7. **Документы:**
   - `CLAUDE.md` — строка `blink` в таблице паттернов;
   - `docs/32` — строка Кикиморы.

## Чего не трогаем

- Другие паттерны.
- Сам `world.rng`: новых потоков нет.

## Тесты

Первым коммитом, `blink-pattern.test.ts`:
- цикл фаз по времени: `chase` 4 с → `fading` 0,25 → `hidden` 0,6 → `appear`;
- в `hidden` враг не цель оружия и касанием не бьёт;
- точка появления: расстояние `blinkDistance` от игрока, угол в ±60° от
  движения; не ближе 60;
- граница карты — точка прижата;
- то же зерно → та же точка; снимок в `hidden` → восстановление → то же
  появление.
- Тест контента: `blinkDistance: 300` → «враг kikimora: blinkDistance вне
  60…200».

## Аналитика

Нет новых событий.

## Настройки и окружение

Нет. Метка — часть чтения боя, выключатель «Телеграфы» её не прячет; решение
в PR.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Кикимора исчезает и появляется рядом с игроком после метки; скрытую не бьют и не бьёт она.
- [ ] Паттерн `blink` с параметрами и проверкой контента; детерминизм сохранён.
- [ ] Эталоны обновлены с замером; гайдбук описывает поведение.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Кикимора и паттерн blink`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: Кикимора — исчезает и появляется рядом, следите за меткой на земле`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КИКИМОРА**

  Новый враг Кикимора и паттерн blink: подходит, тает и появляется рядом с игроком — на месте появления заранее светится метка. От неё не убежать по прямой.
  ```
