---
id: T-0292
title: Итог забега для очков — журнал охоты (сколько жила каждая элита и босс) и оценка сборки
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0125, T-0195]
zones:
  - packages/core-game/src/game/run/hunt-log.ts
  - packages/core-game/test/hunt-log.test.ts
shared:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/game/run/run-result.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/combat.ts
  - packages/core-game/src/game/sim/spawner.ts
  - packages/core-game/test/**
  - backend/api/src/modules/runs/dto/runs.dto.ts
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/art/meta-v2.md
batch: 7
---

# T-0292. Итог забега для очков — журнал охоты (сколько жила каждая элита и босс) и оценка сборки

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0292.json)](README.md#значки-статуса) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](T-0125-run-result-rank-chest-crystal-counters.md) [![T-0195](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0195.json&label=T-0195)](T-0195-player-power-pressure-engine.md)

## Зачем

Две оси очков эффективности (Р152) меряют то, чего нет в итоге забега:
- **Охота** — не только сколько элит и боссов убито, но и как быстро;
- **Сборка** — что игрок собрал к концу: эволюции, оружие на максимуме.

После задачи итог забега несёт журнал охоты и оценку сборки. Из них сервер
считает оси (T-0293), а бот — ожидаемое (T-0291).

## Решения

Решение владельца — Р152; формулы осей — `design/art/meta-v2.md` §2.2.

Решения `claude-lead-1` от 25.10.2026:

- **Журнал охоты** `RunResult.huntLog?: { rank: "elite" | "boss"; value: number; aliveSec: number }[]`:
  - запись на каждую **убитую** элиту и босса;
  - `value` — `xp` врага из контента;
  - `aliveSec` — от появления до смерти, с точностью шага симуляции;
  - не убитые в журнал не попадают;
  - до 64 записей — дальше не пишется: столько элит за забег не бывает.
- **Оценка сборки** `RunResult.buildScore?: number` — в конце забега:

  `эволюции × 2 + оружие на максимальном уровне + навыки на максимальном уровне`.

  «Синергии» дизайнера — это и есть эволюции (оружие + навык рецепта);
  отдельного счёта нет.
- Поля **необязательные** — старые итоги без них. В схеме записи забега на
  сервере (`runs.dto.ts`):
  - `huntLog` — до 64 строк, `value` 0…10 000, `aliveSec` 0…7 200;
  - `buildScore` — 0…64.
- **Детерминизм** — время появления врага уже в мире; журнал — в снимке
  забега. Случайности нет.

## Как сейчас

- **Итог** — `game/run/run-result.ts` (`buildRunResult`), тип `RunResult` в
  `shared-types`; после T-0125 — `bossKills`, `eliteKills`.
- **Смерть врага** — `sim/combat.ts`; появление — `sim/spawner.ts`.
- **Эволюции** — `progression/evolutions.ts`; уровни оружия и навыков — в
  `world.loadout`.
- **Схема записи на сервере** — `backend/api/src/modules/runs/dto/runs.dto.ts`
  (строки 62–80).

## Шаги по порядку

1. **Тесты первым коммитом** — `hunt-log.test.ts`.
2. **Время появления** — у элит и боссов, если его ещё нет в мире.
3. **`game/run/hunt-log.ts`** — запись при смерти; в снимке.
4. **`buildScore`** — в `buildRunResult`.
5. **Типы и схема сервера** — необязательные поля.

## Чего не трогаем

- Очки и таблицу ожидаемого — T-0293, T-0291.

## Тесты

Первым коммитом, `hunt-log.test.ts`:
- элита убита через 12,4 с после появления → строка `{ rank: "elite", value, aliveSec: 12.4 }`;
- не убитая элита — без строки;
- 65-я убитая элита — не пишется;
- снимок с живой элитой → восстановление → то же `aliveSec`;
- `buildScore`: 1 эволюция, 2 оружия и 1 навык на максимуме → 5.
- Схема сервера: итог без полей — принят; `huntLog` из 65 строк — отказ.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

Нет.

## Критерии приёмки

- [ ] Итог несёт журнал охоты и оценку сборки; старые итоги принимаются.
- [ ] Детерминизм и снимок сохранены.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Журнал охоты и оценка сборки в итоге`
- **Метка:** `release: minor`
- **Для игроков:** пусто.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ИТОГ ДЛЯ ОЧКОВ**

  Итог забега несёт журнал охоты — сколько жила каждая убитая элита и босс — и оценку сборки: эволюции, оружие и навыки на максимуме. Из них считаются оси Охоты и Сборки в очках эффективности.
  ```
