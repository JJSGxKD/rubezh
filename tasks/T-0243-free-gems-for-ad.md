---
id: T-0243
title: Самоцветы за ролик раз в день — новое место рекламы free_gems в магазине, сервер
epic: E1
priority: P1
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0242]
zones:
  - backend/api/src/modules/shop/free-gems.service.ts
  - backend/api/src/modules/shop/free-gems.repository.ts
  - backend/api/test/free-gems.test.ts
  - backend/api/test/free-gems.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/ads/ads-rules.ts
  - backend/api/src/modules/ads/ad-networks.ts
  - backend/api/src/modules/ads/ads.service.ts
  - backend/api/src/modules/shop/shop.controller.ts
  - backend/api/src/modules/shop/shop.module.ts
  - backend/api/src/modules/shop/shop-errors.ts
  - backend/api/src/modules/wallet/wallet-limits.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/src/modules/wipe/wipe-runner.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - backend/api/test/ads.test.ts
  - backend/api/test/ads-catalog.test.ts
  - apps/admin/src/api/ads.ts
  - apps/admin/src/ui/help.ts
  - apps/admin/test/ads.test.ts
  - packages/app-shell/src/state/ads-api.ts
  - docs/07-monetization-and-ads.md
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0243. Самоцветы за ролик раз в день — новое место рекламы free_gems в магазине, сервер

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0243.json)](README.md#значки-статуса) [![T-0242](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0242.json&label=T-0242)](T-0242-daily-double-for-ad.md)

## Зачем

Самоцветы сейчас только покупают за звёзды, и игрок без денег не пробует,
на что их тратить. После задачи в магазине раз в игровые сутки можно взять
несколько самоцветов за ролик. Это новое место наградной рекламы под общим
капом (T-0241). Число самоцветов меняется в панели. Клиент — T-0244.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р155: самоцветы
за ролик раз в день — новое место наградной рекламы под общим дневным
капом, числа — в панели.

Решения `claude-lead-1` от 24.10.2026:

- **Место `free_gems`** («Самоцветы за ролик»):
  - формат `rewarded`, `pass: true` — VIP берёт без ролика;
  - `cooldown: null` — раз в сутки держит хозяин места, магазин.
- **Сколько:** ключ панели `ads.free-gems.amount`, целое от 1 до 20, по
  умолчанию **5**. Для сравнения: пакет 60 самоцветов стоит 50 звёзд.
  Геймдизайнер калибрует.
- **Кошелёк:** причина `ad_reward`. В `WALLET_DAILY_CAPS.ad_reward`
  добавляются `gems: 20` — верх ключа. Без этого кошелёк самоцветы по
  этой причине не начислит. Ключ идемпотентности — `free_gems:<accountId>:<игровые сутки>`.
- **Хранение:** таблица `free_gems_claim (account_id, game_day date,
  session_id, gems, created_at)`, ключ `(account_id, game_day)`, уникальный
  `session_id`. Порядок, повтор и исходы — как у второго шанса и T-0242:
  проверка → забор сессии → запись → начисление.
- **Ответ магазина** (`GET` витрины, `shop.controller.ts`) получает
  `freeGems`:
  - `{ status: "available", gems, ad: { available, readyAt, pass, capped } }`;
  - `{ status: "claimed", gems }` — сегодня уже взято;
  - `{ status: "unavailable" }` — нет рекламы для площадки.
- **Списки мест — везде**, как в T-0242: Prisma `enum AdPlace`, сервер,
  клиент, панель (название «Самоцветы за ролик»), `ad-networks.ts`, тесты
  мест.

## Как сейчас

- `shop/shop.controller.ts`, `shop.service.ts`, `showcase.service.ts` —
  витрина и покупки; `shop-catalog.ts:78` — пакет `gems_60` за 50 звёзд.
- `wallet/wallet-limits.ts:18–45` — `WALLET_DAILY_CAPS`, `ad_reward: { coins:
  10_000 }`. Ресурса нет в потолке — кошелёк его по этой причине не
  начисляет.
- После T-0242 — хозяин места по образцу `daily-double.service.ts`. Списки
  мест — те же файлы.
- Ключи `ads.*` — `settings/setting-catalog.ts`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** (`--create-only` один раз): `ALTER TYPE "AdPlace" ADD VALUE
   'free_gems'`, таблица `free_gems_claim`, модель с комментариями, ER — в
   `docs/21`.
3. **Места рекламы** — по образцу T-0242.
4. **`wallet-limits.ts`** — `gems: 20` у `ad_reward` с комментарием, откуда
   число.
5. **Ключ панели** `ads.free-gems.amount` и подсказка в `help.ts`: «Сколько
   самоцветов игрок берёт в магазине за ролик раз в игровые сутки».
6. **`free-gems.repository.ts`, `free-gems.service.ts`:** `view(player, at)`,
   `claim(player, sessionId, at)`; ошибка `FreeGemsClaimedError` (409,
   `free_gems_claimed`) в `shop-errors.ts`; лог `free_gems_claimed`.
7. **Контроллер** — `POST /shop/free-gems`, тело `{ sessionId }` (Zod),
   ответ `{ data: { credited, view } }`; `freeGems` в ответе витрины. Лимит —
   как у покупок.
8. **Очистка** — `free_gems_claim` в `wipe-plan.ts` и `wipe-runner.ts`.
9. **Событие** `ad_reward_claimed` принимает `place: free_gems` — `docs/22` и
   Zod.
10. **Документы:** `docs/07` (место), `docs/30` (ключ), `docs/21` (ER).

## Чего не трогаем

- Покупки и витрину.
- Кап — T-0241. Клиент — T-0244.

## Тесты

Первым коммитом.

- `backend/api/test/free-gems.test.ts`:
  - `view`: сегодня не взято → `available` с числом из ключа; взято → `claimed`;
  - ключ 0 или 21 отклоняется схемой каталога.
- `backend/api/test/free-gems.integration.test.ts` (живые Postgres и Redis):
  - ролик → `POST /shop/free-gems` → +5 самоцветов, причина `ad_reward`;
  - повтор той же сессией → тот же ответ, без второго начисления;
  - второй раз в те же сутки → 409 `free_gems_claimed`; следующие сутки — снова можно;
  - VIP с пропуском — без ролика;
  - ключ 10 → +10;
  - кап T-0241 → `ad.capped: true`;
  - тесты мест зелёные.

## Аналитика

`ad_reward_claimed` с `place: free_gems` — по шагу 9.

## Настройки и окружение

Ключ `ads.free-gems.amount` — по шагу 5, строка в `docs/30`.

## Документы

По шагу 10.

## Критерии приёмки

- [ ] Раз в игровые сутки игрок берёт N самоцветов за ролик; VIP — без ролика.
- [ ] N меняется в панели; повтор и обрыв не дают двойного начисления.
- [ ] Место `free_gems` есть в базе, на сервере, у клиента и в панели.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(shop): Самоцветы за ролик — сервер`
- **Метка:** `release: minor`
- **Для игроков:** пусто — карточка придёт с клиентом (T-0244).
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — САМОЦВЕТЫ ЗА РОЛИК, СЕРВЕР**

  Новое место наградной рекламы free_gems: раз в игровые сутки в магазине — самоцветы за ролик, VIP — без ролика. Сколько — ключ ads.free-gems.amount в панели, по умолчанию 5. Место под общим капом роликов.

  ❓ **Нужно от команды**

  • @владелец — завести блоки сетей для места «Самоцветы за ролик» в панели «Реклама»
  ```
