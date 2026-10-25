---
id: T-0284
title: Леший — элита с новым паттерном `roots`: корни из земли под игроком после метки, опутывание
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0283]
zones:
  - packages/core-game/src/game/patterns/roots.ts
  - packages/core-game/test/roots-pattern.test.ts
shared:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/content/enemies.ts
  - packages/core-game/src/content/waves.ts
  - packages/core-game/src/game/patterns/index.ts
  - packages/core-game/src/game/patterns/enemy-types.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/player-status.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/src/game/render/looks.ts
  - packages/core-game/test/**
  - packages/app-shell/src/screens/run/PlayerStatuses.tsx
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/i18n/ru-run.json
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

# T-0284. Леший — элита с новым паттерном `roots`: корни из земли под игроком после метки, опутывание

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0284.json)](README.md#значки-статуса) [![T-0283](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0283.json&label=T-0283)](T-0283-kikimora-blink.md)

## Зачем

Элиты сейчас опасны телом: подходят и бьют. Леший (Р157) — элита, которая
бьёт землёй:
- раз в несколько секунд под игроком светится круг;
- через секунду из него вырываются корни: бьют и опутывают — игрок
  замедлен.

Ушёл из круга вовремя — цел. Это уворот по телеграфу, которого у элит ещё
не было.

## Решения

Решение владельца — Р157, `design/art/meta-v2.md` §6.1: Леший — элита,
новый паттерн `roots`, корни из земли под игроком, телеграф по земле,
уворот.

Решения `claude-lead-1` от 25.10.2026 (числа стартовые):

- **Паттерн `roots`:**
  - Леший медленно преследует (как `chase`);
  - каждые `castIntervalSec` (умолчание 5) — заклинание:
    1. в точке игрока на этот миг — метка-круг радиуса `rootRadius` (80);
    2. через `telegraphSec` (1,0) — удар корней.
  - Игрок в круге в миг удара (центр игрока ближе `rootRadius`):
    - урон — `damage` врага через `damagePlayer`;
    - состояние «опутан».
  - Пока идёт метка, Леший стоит: сила в заклинании, а не в погоне.
  - Касание бьёт как у `chase`.
- **Опутан** — новое состояние игрока в `sim/player-status.ts`:
  - скорость ×0,35 на `rootSec` (1,2);
  - не стихия: сопротивления на него не действуют;
  - повтор продлевает, но не складывает замедление.

  В оболочке — значок у статусов игрока (`PlayerStatuses.tsx`) и строка
  «Опутан» в `ru-run.json`.
- **Параметры** — в `EnemyPatternParams` и `PATTERN_DEFAULTS`:
  - `castIntervalSec` — 2…12;
  - `telegraphSec` — 0,5…2;
  - `rootRadius` — 40…140;
  - `rootSec` — 0,3…3.

  Проверка — тестом контента.
- **Случайности нет:** точка — позиция игрока, время — таймер врага.
- **Леший** `leshy`:
  - `{ hp: 380, speed: 30, damage: 16, xp: 30, rank: "elite", pattern: "roots", size: 1.4 }`;
  - `resist: { poison: 0.5, fire: -0.5 }`;
  - `threat` — как у `elite_grave_knight`.

  Только событием:
  - ручной отрезок после 420 с — `{ kind: "flank", enemy: "leshy", count: 1 }`;
  - в `ENDLESS_CURVE` — событие раз в 8 отрезков.

  С Лешего падает сундук, как с любой элиты.
- **Облик:**
  - фигура элиты своего паттерна (`looks.ts`) — тёмно-зелёный, крупнее
    рядовых по рангу;
  - метка — круг на земле тоном опасности, заполняется к удару;
  - удар — короткая вспышка шипов по кругу (эффекты боя, выключатель
    `weaponEffects` её не прячет: это чтение боя).

  Кадры арта — пункт 16 очереди.
- **Тексты:**
  - `enemy.leshy.name` — «Леший»;
  - гайдбук — «Корни из земли под тобой — выйди из круга до удара».

## Как сейчас

- **Паттерны с меткой** — `patterns/caster.ts` (замирает и бьёт по площади),
  `patterns/exploder.ts`.
- **Состояния игрока** — `sim/player-status.ts`; в оболочке —
  `screens/run/PlayerStatuses.tsx`.
- **Элиты** — `elite_ghoul`, `elite_grave_knight` в `content/enemies.ts`; события —
  `content/waves.ts` (строки 47, 107, 177–180).

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`patterns/roots.ts`**, параметры, умолчания, реестр.
3. **Состояние «опутан»** — движок и оболочка.
4. **Облик** — фигура, метка, удар.
5. **Данные** — Леший, события, тексты, гайдбук.
6. **Эталоны** — обновить, `pnpm balance:sim` до и после.
7. **Документы:**
   - `CLAUDE.md` — строка `roots` в таблице паттернов;
   - `docs/32` — строки Лешего и состояния.

## Чего не трогаем

- Другие паттерны и стихии.

## Тесты

Первым коммитом, `roots-pattern.test.ts`:
- заклинание каждые `castIntervalSec`; метка — в точке игрока на начало;
- игрок ушёл из круга до удара → без урона; остался → урон и «опутан»;
- «опутан» — скорость ×0,35 на 1,2 с; повтор продлевает, не складывает;
- сопротивления игрока «опутан» не гасят;
- во время метки Леший стоит;
- снимок во время метки → восстановление → тот же удар.
- Тест контента:
  - `rootRadius: 200` → ошибка с именем врага;
  - Леший в потоке, не событием → ошибка (правило элит).

## Аналитика

Нет новых событий.

## Настройки и окружение

Нет; метка и удар — чтение боя, решение — в PR.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Леший приходит событием, бьёт корнями по метке под игроком; ушёл — цел, остался — урон и замедление.
- [ ] Паттерн `roots` и состояние «опутан» с проверкой контента; детерминизм сохранён.
- [ ] Эталоны обновлены с замером; гайдбук и статус игрока на месте.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Леший и паттерн roots`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: элита Леший — корни из земли под ногами, уходите из круга`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЛЕШИЙ**

  Новая элита Леший: под игроком светится круг, через секунду бьют корни и опутывают. Уворот по телеграфу у элиты — впервые. Паттерн roots и состояние «опутан».
  ```
