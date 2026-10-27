---
id: T-0269
title: Застава — сервер: кузня, капище и сторожевая башня за монеты, прибавки в силе игрока, доход башни вне игры
epic: E16
priority: P3
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0247]
zones:
  - backend/api/src/modules/outpost/**
  - backend/api/test/outpost-rules.test.ts
  - backend/api/test/outpost.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/app.module.ts
  - backend/api/src/modules/items/items.service.ts
  - backend/api/src/modules/items/item-loadout.ts
  - backend/api/src/modules/wallet/wallet-types.ts
  - backend/api/src/modules/wallet/wallet-limits.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/src/modules/wipe/wipe-runner.ts
  - packages/core-game/src/game/progression/run-loadout.ts
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - docs/32-balance.md
  - docs/37-accounting.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 5
---

# T-0269. Застава — сервер: кузня, капище и сторожевая башня за монеты, прибавки в силе игрока, доход башни вне игры

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0269.json)](README.md#значки-статуса) [![T-0247](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0247.json&label=T-0247)](T-0247-player-card-server.md)

## Зачем

Монеты копятся, а постоянных трат у них мало. Вне забега у игрока нет
своего места. После задачи у игрока есть Застава — три постройки с
уровнями, которые строят и улучшают за монеты:
- кузня даёт небольшую постоянную прибавку к урону;
- капище — к здоровью;
- сторожевая башня копит монеты, пока игрок не в игре.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- **Р154** — Застава: постройки дают малые постоянные прибавки и копят
  ресурс вне игры. Прибавки Заставы входят в силу игрока для подстройки
  забега (Р65) и очков (Р152);
- **поправка от 24.10.2026** — **копятся монеты, строят за монеты**, новой
  валюты нет.

Решения `claude-lead-1` от 24.10.2026:

- **Постройки и уровни** — данные `outpost-catalog.ts`:

  | Постройка | Уровень → эффект | Цена уровней 1…5, монет |
  |---|---|---|
  | Кузня | урон +1 % за уровень, до +5 % | 1 000 · 3 000 · 6 000 · 10 000 · 15 000 |
  | Капище | здоровье +2 % за уровень, до +10 % | 1 000 · 3 000 · 6 000 · 10 000 · 15 000 |
  | Сторожевая башня | 20 монет в час за уровень, копит до 8 часов | 800 · 2 400 · 5 000 · 8 000 · 12 000 |

  Числа стартовые, геймдизайнер калибрует. Строится сразу, без таймера
  стройки.
- **Прибавки в силе игрока:** кузня и капище добавляются в модификаторы
  подписанного снимка снаряжения (`items/item-loadout.ts`, тот же снимок, что
  сверяет забег). Вместе со снаряжением и бустами они упираются в
  `LOADOUT_BOUNDS`. Так прибавки сами попадают в подстройку забега (Р65) и в
  проверку итога; второго канала нет.
- **Башня:**
  - копит с последнего забора: `min(8 ч, прошло) × ставка уровня`;
  - `POST /api/v1/outpost/collect` начисляет с причиной `outpost_income`;
  - потолок кошелька — `8 × 100` монет за забор, суммарно в сутки — 3 000.

  Ключ идемпотентности — `outpost:<accountId>:<collectedAt>`. Время — только
  сервера.
- **Таблица** `outpost (account_id PK, forge smallint, shrine smallint,
  tower smallint, tower_collected_at timestamptz)`, уровни 0…5 с CHECK.
- **Стройка** — `POST /api/v1/outpost/:building/upgrade`:
  - списание цены причиной `outpost_build` и повышение уровня — одной транзакцией с условием «уровень всё ещё N»;
  - двойное нажатие — одно списание;
  - не хватает — 409 `insufficient_funds`; уровень 5 — 409 `outpost_max_level`.
- **`GET /api/v1/outpost`** → уровни, эффекты, цены следующего уровня,
  накоплено в башне сейчас.
- **Golden** не меняются: прибавки приходят снимком снаряжения, как
  предметы, и в golden-прогонах снимка нет.

## Как сейчас

- `items/item-loadout.ts`, `items/items.service.ts` — снимок снаряжения с
  подписью; проверка — `runs/run-loadouts.ts`.
- `core-game/src/game/progression/run-loadout.ts` — `LOADOUT_BOUNDS`,
  `modifiers`.
- Траты и начисления — `wallet` (причины в `wallet-types.ts`, потолки в
  `wallet-limits.ts`).

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — `outpost`, ER в `docs/21`.
3. **`outpost-catalog.ts`, `outpost-rules.ts`** — уровни, цены, эффекты,
   накопление башни (чистые).
4. **Модуль `outpost`** — маршруты, транзакции, лимиты запросов.
5. **Снимок снаряжения** — модификаторы Заставы.
6. **Кошелёк** — причины `outpost_build` (трата), `outpost_income` (с
   потолком).
7. **Очистка** — `outpost` в `wipe-plan.ts`, `wipe-runner.ts`.
8. **Документы:**
   - `docs/30` — строка `outpost-catalog.ts`;
   - `docs/32` — прибавки Заставы в своде силы игрока;
   - `docs/37` — новые причины;
   - `docs/21` — ER.

## Чего не трогаем

- Клиент — T-0270.
- Подстройку забега и `LOADOUT_BOUNDS` — числа не меняем.

## Тесты

Первым коммитом.

- `outpost-rules.test.ts`:
  - кузня 3 → урон +3 %;
  - башня 2 за 3 часа → 120; за 12 часов → 320 (потолок 8 ч);
  - цены уровней растут.
- `outpost.integration.test.ts`:
  - стройка кузни 1 за 1 000 → уровень 1, монеты списаны; два запроса разом — одно списание;
  - не хватает монет → 409, ничего не списано; уровень 5 → 409;
  - снимок снаряжения несёт урон +3 % при кузне 3; с предметами — не выше `LOADOUT_BOUNDS`;
  - забор башни: накоплено → начислено, повтор сразу → 0.

## Аналитика

Клиентские `outpost_built { building, level }`, `outpost_collected { coins }` —
словарь в T-0270.

## Настройки и окружение

Нет: числа — в каталоге.

## Документы

По шагу 8.

## Критерии приёмки

- [ ] Три постройки по пять уровней за монеты; кузня и капище — в силе игрока через снимок снаряжения.
- [ ] Башня копит монеты до 8 часов; забор без двойных начислений.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Застава — сервер`
- **Метка:** `release: minor`
- **Для игроков:** пусто — экран с T-0270.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАСТАВА, СЕРВЕР**

  У игрока — Застава: кузня (+урон), капище (+здоровье) и сторожевая башня (копит монеты до 8 часов вне игры), по пять уровней за монеты. Прибавки входят в силу игрока через снимок снаряжения, в пределах LOADOUT_BOUNDS.
  ```
