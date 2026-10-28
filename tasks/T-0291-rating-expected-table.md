---
id: T-0291
title: Рейтинг эффективности — таблица ожидаемого E(S, t): новый выход balance:sim по полосам силы и минутам забега
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0196, T-0292]
zones:
  - packages/core-game/src/game/balance/expected.ts
  - packages/core-game/test/expected-table.test.ts
  - backend/api/src/modules/rating/expected-runs.json
  - scripts/balance/expected-table.ts
shared:
  - packages/core-game/src/game/balance/simulate.ts
  - packages/core-game/src/game/balance/index.ts
  - scripts/balance/balance-sim.ts
  - package.json
  - docs/32-balance.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: design/art/meta-v2.md
batch: 7
---

# T-0291. Рейтинг эффективности — таблица ожидаемого E(S, t): новый выход balance:sim по полосам силы и минутам забега

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0291.json)](README.md#значки-статуса) [![T-0196](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0196.json&label=T-0196)](T-0196-player-power-pressure-wiring.md) [![T-0292](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0292.json&label=T-0292)](T-0292-run-result-hunt-and-build.md)

## Зачем

Очки забега (Р152) — пять осей. Каждая ось — «во сколько раз лучше
ожидаемого для силы игрока на этой минуте». Ожидаемое — медиана прогонов
бота калибровки: сервер не гоняет симуляцию на каждый забег, а берёт число
из таблицы.

После задачи `pnpm balance:expected` строит таблицу `E(S, t)` и кладёт её
файлом, который читает сервер (T-0293).

## Решения

Решение владельца — `docs/35-stage4-plan.md`:
- Р152 — пять осей против ожидаемого для силы игрока и минуты забега;
- ожидаемое — таблица из `balance:sim`.

Подробности — `design/art/meta-v2.md` §2.2.

Решения `claude-lead-1` от 25.10.2026:

- **Полосы силы** — по очкам силы `power` из движка (T-0195), пять полос по
  профилям T-0196:
  1. `novice`;
  2. середина между `novice` и `average`;
  3. `average`;
  4. середина между `average` и `full`;
  5. `full`.

  Граница полосы — середина между соседними профилями по `power`. Забег
  берёт свою полосу по `pressure.power` итога. Нет поля (подстройки не
  было) — полоса `average`.
- **Минуты** — 1…20. Дальше — значение 20-й минуты: столько не живёт и
  верх.
- **Что в строке** `(полоса, минута)` — медианы прогонов уклоняющегося бота
  на `hard` по тем же зёрнам, что у `balance:sim`:
  - `killsPerMin` — убийств в минуту к этой минуте;
  - `huntPerMin` — ценность убитых элит и боссов в минуту (`xp` убитого,
    T-0292);
  - `huntKillSec` — медиана времени жизни элиты и босса до смерти
    (по `huntLog` T-0292), отдельно `elite` и `boss`;
  - `damageTakenPerMin` — полученного урона в минуту;
  - `buildScore` — оценка сборки к этой минуте (T-0292).

  Строка без данных (бот до этой минуты не дожил) — значение последней
  минуты с данными у той же полосы.
- **Файл** — `backend/api/src/modules/rating/expected-runs.json`:
  - схема: `{ version, contentHash, generatedAt, bands: [{ id, fromPower, toPower }], rows: [...] }`;
  - сервер не импортирует пакеты игры, поэтому таблица едет файлом.

  `contentHash` — `CONTENT_HASH` на момент сборки: сервер видит, что таблица
  отстала от контента (T-0293 пишет предупреждение в лог).
- **Команда** — `pnpm balance:expected`, отдельно от `balance:sim`.
  - в гейт не входит: прогон долгий;
  - правка контента, сдвигающая баланс, обновляет таблицу в том же PR —
    правило в `docs/32`.

## Как сейчас

- **`balance:sim`** — `package.json` (`vitest run --config vitest.balance.config.ts`),
  `scripts/balance/balance-sim.ts`; боты и прогон — `core-game/src/game/balance/`
  (`bot.ts`, `simulate.ts`).
- **Сила игрока:**
  - после T-0195 — `power` в `RunResult.pressure`;
  - после T-0196 — профили силы `game/balance/power-profiles.ts`.
- **Счётчики итога** — после T-0292: `huntLog` и `buildScore`.

## Шаги по порядку

1. **Тесты первым коммитом** — `expected-table.test.ts` на маленьком прогоне
   (2 зерна, 3 минуты): форма строк, полосы по возрастанию, заполнение
   пустых строк последней минутой.
2. **`game/balance/expected.ts`** — сборка таблицы из прогонов (чистая
   функция от результатов).
3. **`scripts/balance/expected-table.ts`** — прогон по пяти полосам, запись
   JSON; команда `balance:expected` в `package.json`.
4. **Файл таблицы** — первая сборка в этом PR.
5. **Документы:**
   - `docs/32` — раздел «Ожидаемое для рейтинга»: что в таблице и когда
     пересобирать;
   - `docs/30` — строка файла.

## Чего не трогаем

- Формулу очков — T-0293.
- Профили силы и подстройку — T-0195, T-0196.

## Тесты

Первым коммитом — шаг 1. Плюс: таблица из файла проходит свою схему; у
пяти полос `fromPower` растёт.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

По шагу 5.

## Критерии приёмки

- [ ] `pnpm balance:expected` строит таблицу E(S, t) по пяти полосам силы и 20 минутам.
- [ ] Таблица лежит файлом у сервера с хэшем контента.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(dev): Таблица ожидаемого для рейтинга`
- **Метка:** `release: patch`
- **Для игроков:** пусто.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ТАБЛИЦА ОЖИДАЕМОГО**

  pnpm balance:expected строит таблицу ожидаемого забега по пяти полосам силы и 20 минутам: убийства, охота на элиту и боссов, полученный урон, сборка. Её читает сервер для очков эффективности. Правка баланса — пересобрать в том же PR.
  ```
