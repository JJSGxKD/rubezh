---
id: T-0310
title: Награды числами в панели — монеты и опыт за забег, награды за уровень и награда дня ключами каталога с подтверждением второго участника
epic: E7
priority: P3
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0309]
zones:
  - backend/api/src/modules/change-requests/reward-settings.ts
  - backend/api/test/reward-settings.integration.test.ts
  - apps/admin/src/screens/balance/prices/RewardSettings.tsx
shared:
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/settings/settings.service.ts
  - backend/api/src/modules/admin/admin-settings.controller.ts
  - backend/api/src/modules/progress/progress-rules.ts
  - backend/api/src/modules/progress/run-rewards.ts
  - backend/api/src/modules/daily/daily-rules.ts
  - backend/api/src/modules/daily/daily.service.ts
  - backend/api/src/modules/change-requests/**
  - apps/admin/src/screens/balance/prices/**
  - docs/19-content-admin.md
  - docs/30-configuration-map.md
  - docs/32-balance.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 7
---

# T-0310. Награды числами в панели — монеты и опыт за забег, награды за уровень и награда дня ключами каталога с подтверждением второго участника

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0310.json)](README.md#значки-статуса) [![T-0309](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0309.json&label=T-0309)](T-0309-two-person-prices.md)

## Зачем

Награды за забег, за уровень и награда дня — постоянные в коде сервера
(`progress/progress-rules.ts`, `daily/daily-rules.ts`). Правка — релиз.
Награда — та же валюта, что продаётся за звёзды, поэтому правило то же,
что у цен (`docs/19` §6): один предлагает, второй подтверждает.

После задачи эти числа — ключи каталога настроек с пометкой «деньги».
Их правка идёт только заявкой T-0309, во вкладке «Цены и награды».

## Решения

Решения владельца — 25.10.2026, опрос: цены и награды — в первой волне
редактора; `docs/19` §6.

Решения `claude-lead-1` от 25.10.2026:

- **Ключи с пометкой `money: true`** в `setting-catalog.ts`; умолчание — нынешнее число:

  | Ключ | Что | Откуда сейчас |
  |---|---|---|
  | `rewards.run-max-coins` | потолок монет за забег | `MAX_COINS_PER_RUN` (600) |
  | `rewards.run-max-xp` | потолок опыта за забег | `MAX_XP_PER_RUN` (1 500) |
  | `rewards.run-min-sec` | забег короче — без награды | `MIN_REWARDED_SEC` (30) |
  | `rewards.level-ladder` | награды за уровень аккаунта списком | правила уровня в `progress/` |
  | `rewards.daily-ladder` | ступени награды дня | `daily/daily-rules.ts` |

  Коэффициенты сложности `DIFFICULTY_REWARD_MUL` в ключи не выносятся:
  сложность одна (Р126).
- **Правка ключа `money`:**
  - обычная правка настроек (`admin-settings.controller.ts`) для него
    отвечает 409 `change_request_required`;
  - путь — заявка `kind: reward_setting` (T-0309);
  - подтверждает второй с `sku.price.edit`.

  Значение проверяется схемой ключа до заявки.
- **Применение** — значение ложится в настройки, как сейчас. Сервер читает
  ключ на каждом начислении: правка действует со следующей награды,
  начисленное не пересчитывается.
- **Потолки кошелька** (`wallet-limits.ts`) — не ключи: это защита от ошибки,
  и они остаются в коде. Правка награды выше потолка — предупреждение в
  заявке: «Выше суточного потолка — часть не начислится».
- **Панель** — во вкладке «Цены и награды» — блок «Награды»: ключи с
  текущим значением, «Предложить», заявки — общим списком T-0309.

## Как сейчас

- **Награда за забег** — `progress/progress-rules.ts` (`MIN_REWARDED_SEC`,
  `MAX_COINS_PER_RUN`, `MAX_XP_PER_RUN`), начисление — `progress/run-rewards.ts`.
- **Награда дня** — `daily/daily-rules.ts`, `daily.service.ts`.
- **Каталог настроек** — `settings/setting-catalog.ts`, правка —
  `admin-settings.controller.ts`.
- **После T-0309** — заявки и вкладка «Цены и награды».

## Шаги по порядку

1. **Тесты первым коммитом** — `reward-settings.integration.test.ts`:
   - ключ `money` обычной правкой → 409;
   - заявка → подтверждение другим → следующая награда по новому числу;
   - начисленное не пересчитано;
   - значение выше потолка кошелька — предупреждение в заявке.
2. **Ключи** — в каталоге с умолчаниями из нынешних постоянных; постоянные
   в коде — только умолчание.
3. **Чтение ключей** — в расчёте наград за забег, уровень и день.
4. **`reward-settings.ts`** — вид заявки `reward_setting`.
5. **Панель** — блок «Награды».
6. **Документы:**
   - `docs/19` §6;
   - `docs/30` — ключи;
   - `docs/32` — где теперь числа наград.

## Чего не трогаем

- Потолки кошелька.
- Цены — T-0309.

## Тесты

Первым коммитом — шаг 1. Плюс прежние тесты наград проходят на умолчаниях.

## Аналитика

Нет новых событий.

## Настройки и окружение

Ключи `rewards.*` — по шагу 2.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] Награды за забег, уровень и день — ключами каталога, правка только заявкой со вторым участником.
- [ ] Правка действует со следующей награды; потолки кошелька в коде.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Награды числами в панели`
- **Метка:** `release: minor`
- **Для игроков:** пусто.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НАГРАДЫ В ПАНЕЛИ**

  Награды за забег, за уровень и награда дня теперь числа в панели, а не в коде. Меняются как цены — заявкой и подтверждением второго участника; действуют со следующей награды.
  ```
