---
id: T-0262
title: Серия дней — сервер: +5 % к награде дня за каждый день подряд до +50 %, пропуск — минус две ступени
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0242]
zones:
  - backend/api/src/modules/daily/daily-streak.ts
  - backend/api/test/daily-streak.test.ts
  - backend/api/test/daily-streak.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/daily/daily-rules.ts
  - backend/api/src/modules/daily/daily.service.ts
  - backend/api/src/modules/daily/daily.repository.ts
  - backend/api/src/modules/daily/daily-double.service.ts
  - backend/api/src/modules/wallet/wallet-limits.ts
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - docs/39-retention-mechanics.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 4
---

# T-0262. Серия дней — сервер: +5 % к награде дня за каждый день подряд до +50 %, пропуск — минус две ступени

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0262.json)](README.md#значки-статуса) [![T-0242](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0242.json&label=T-0242)](T-0242-daily-double-for-ad.md)

## Зачем

Награда дня растёт неделями (Р45), но не замечает, что игрок заходит каждый
день подряд. После задачи у игрока есть серия дней: каждый день подряд даёт
+5 % к награде дня, до +50 % на десятый день. Пропущенный день не обнуляет
серию, а снимает две ступени.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- **Р154** — серия дней: множитель награды дня, без сброса в ноль (Р45);
- **поправка от 24.10.2026** — +5 % за день подряд, потолок +50 % на
  десятый день; **пропущенный день — минус две ступени**.

Решения `claude-lead-1` от 24.10.2026:

- **Ступень серии** `streak` — целое 0…10, хранится в `daily_reward`
  (новая колонка, по умолчанию 0).
- **При заборе** — по игровым суткам (`common/game-day.ts`):
  - вчера был забор → `streak + 1`;
  - пропущено `d ≥ 1` дней → `max(0, streak − 2·d) + 1`;
  - потолок — 10.
- **Множитель** — `1 + 0,05 × streak` к монетам и осколкам награды дня
  поверх нынешней формулы (база × ступень недели × уровень). Округление —
  как у формулы.
  - Удвоение за ролик (T-0242) удваивает уже умноженное.
  - Потолок кошелька `daily_reward`: двойной 7-й день с +50 % — около
    4 300 монет и 48 осколков, в потолке 5 000 и 100 есть запас.
- **Ответ награды дня** получает `streak: { days, bonusPercent, next }`,
  где `next` — ступень после завтрашнего забора.

## Как сейчас

- `daily/daily-rules.ts` — `DAILY_BASE`, `WEEK_STEP_MUL`, `LEVEL_MUL_PER_LEVEL`,
  `dailyReward(dayNumber, level)`.
- `daily_reward (account_id, claimed_days, last_claim_day, updated_at)` —
  `schema.prisma:1333`; забор — `daily.service.ts:68–82`, `repository.advance`.
- После T-0242 — удвоение за ролик `daily-double.service.ts` (пересчёт по
  `dailyReward`).

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — `daily_reward.streak SMALLINT NOT NULL DEFAULT 0` с `CHECK
   (streak BETWEEN 0 AND 10)`; ER в `docs/21`.
3. **`daily-streak.ts`** — чистые `nextStreak(streak, lastClaimDay, today)`
   и `streakMul(streak)`; константы `STREAK_STEP = 0.05`, `STREAK_MAX = 10`,
   `STREAK_MISS_PENALTY = 2`.
4. **Забор и удвоение** — множитель серии; `advance` пишет новую ступень той
   же строкой.
5. **Ответ** — `streak`.
6. **Документы:**
   - `docs/30` — строка «Серия дней» → `daily-streak.ts`;
   - `docs/39` — серия дней в механиках удержания.

## Чего не трогаем

- Ступени недель и формулу Р45.
- Клиент — T-0263.

## Тесты

Первым коммитом.

- `daily-streak.test.ts`:
  - подряд 0 → 1 → 2;
  - на 10 — остаётся 10;
  - пропуск 1 дня с 7 → 6, с 1 → 1;
  - пропуск 3 дней с 10 → 5;
  - пропуск 10 дней с 10 → 1;
  - `streakMul(10)` = 1,5.
- `daily-streak.integration.test.ts`:
  - три дня подряд → награда третьего ×1,15;
  - пропуск дня — ступень по правилу, без обнуления;
  - удвоение за ролик удваивает умноженное;
  - кошелёк начисляет без упора в потолок на 7-м дне с +50 % и удвоением.

## Аналитика

`daily_reward_claimed` (клиентское) получает необязательное `streak` — в T-0263.

## Настройки и окружение

Нет: числа — константы рядом с формулой награды дня.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] Каждый день подряд +5 % к награде дня, до +50 %; пропуск снимает две ступени за день, но не обнуляет.
- [ ] Ответ награды дня несёт серию.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(daily): Серия дней — сервер`
- **Метка:** `release: minor`
- **Для игроков:** пусто — огонёк серии придёт с T-0263.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СЕРИЯ ДНЕЙ, СЕРВЕР**

  Награда дня получила серию: каждый день подряд +5 %, до +50 % на десятый день. Пропущенный день снимает две ступени, но не обнуляет. Удвоение за ролик удваивает уже умноженное.
  ```
