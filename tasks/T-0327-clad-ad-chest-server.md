---
id: T-0327
title: Второй сундук в кладе за ролик — сервер: место показа `clad_chest`, раз за забег, книга показов и сверка итога
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0199, T-0241, T-0125]
zones:
  - backend/api/src/modules/runs/run-ad-chest.service.ts
  - backend/api/src/modules/runs/run-ad-chest.controller.ts
  - backend/api/src/modules/runs/run-ad-chests.repository.ts
  - backend/api/src/modules/runs/run-chest-errors.ts
  - backend/api/test/run-ad-chest.test.ts
  - backend/api/test/run-ad-chest.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/ads/ads-rules.ts
  - backend/api/src/modules/ads/ad-networks.ts
  - backend/api/src/modules/ads/ads.service.ts
  - backend/api/src/modules/runs/runs.module.ts
  - backend/api/src/modules/runs/runs-limits.ts
  - backend/api/src/modules/runs/run-verdict.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/runs/dto/runs.dto.ts
  - backend/api/src/modules/admin-notify/run-review-card.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/src/modules/wipe/wipe-runner.ts
  - backend/api/test/run-verdict.test.ts
  - backend/api/test/ads.test.ts
  - backend/api/test/ads-catalog.test.ts
  - backend/api/test/wipe-plan.test.ts
  - apps/admin/src/api/ads.ts
  - apps/admin/src/api/review.ts
  - apps/admin/test/ads.test.ts
  - docs/07-monetization-and-ads.md
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0327. Второй сундук в кладе за ролик — сервер: место показа `clad_chest`, раз за забег, книга показов и сверка итога

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0327.json)](README.md#значки-статуса) [![T-0199](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0199.json&label=T-0199)](T-0199-reroll-for-ad.md) [![T-0241](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0241.json&label=T-0241)](T-0241-ads-daily-cap.md) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](archive/T-0125-run-result-rank-chest-crystal-counters.md)

## Зачем

Клад (тайник T-0258) даёт сундук. Дизайнер предлагает «ключ к кладу»: после
открытия — ещё один сундук за ролик. Игрок сам хочет посмотреть рекламу в
момент, когда видит награду. После задачи сервер умеет выдать этот второй
сундук по досмотренному показу, раз за забег, и сверяет итог забега с
книгой показов. Кнопку в окне сундука и сам сундук делает T-0328.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- Р162 (25.10.2026) — второй сундук в кладе за ролик: новое место наградной
  рекламы в общий дневной кап роликов;
- Р155 — общий кап роликов на все места (T-0241);
- §3.6 — VIP без ролика.

Решения `claude-lead-1` от 25.10.2026 — **всё по образцу рекламного
переброса T-0199**, отличия перечислены:

- **Место показа** `clad_chest` («Второй сундук клада»), формат `rewarded`,
  `pass: true` (VIP — без ролика), без кулдауна. Входит в общий дневной кап
  T-0241 как любое наградное место. Блоки места заводит команда в панели;
  пока блоков нет — реклама для места недоступна, кнопки нет.
- **Раз за забег** — таблица `run_ad_chest`:
  - `run_id` — первичный ключ;
  - `account_id`, `session_id` (уникален), `network_key`, `granted_at`;
  - каскад с забегом и аккаунтом.

  Сервер не знает, был ли в забеге клад: это проверит повтор забега (WP5,
  T-0318). Здесь сервер ручается только за показ.
- **Маршруты** — `GET` и `POST /api/v1/runs/:runId/chests/ad`:
  - `GET` → `{ status: "available", pass } | { status: "unavailable", reason: "unverified" | "finished" | "used_up" | "no_ads" | "daily_cap" }`;
  - `POST { sessionId }` — порядок как у переброса: сессия уже потрачена на
    этот забег — тот же ответ; чужой и незнакомый забег — одинаково
    `run_unverified`; закончен или сундук уже взят — `chest_unavailable`;
    потом `ads.claim(…, "clad_chest", …)`, потом запись.
  - Лимит — `runs:chest-ad`, 120 в час.
- **Итог забега** — `adChests: z.number().int().min(0).max(1).default(0)`.
  Причина вердикта `unpaid_ad_chest` («второй сундук не подтверждён
  показом») — в `REJECTING`, условие `!cheats && adChests > paidAdChests`,
  как у `unpaid_ad_reroll`. Подпись причины — в карточке разбора и панели.
- **Вайп** — модель `RunAdChest` в `wipe-plan.ts` и `wipe-runner.ts`, как
  `RunAdReroll`.

## Как сейчас

- **После T-0199** — место `card_reroll`, `run-ad-reroll.service.ts`,
  `run-ad-rerolls.repository.ts`, `run-ad-reroll.controller.ts`, таблица
  `run_ad_reroll`, причина `unpaid_ad_reroll`: точный образец для каждого
  файла этой задачи.
- **После T-0241** — общий кап роликов, ключ `ads.rewarded.daily-cap`; отказ
  по капу — `daily_cap`.
- **Места показа** — `AD_PLACES`, `PLACE_RULES` (`ads/ads-rules.ts:15`),
  `PLACE_FORMAT`, `PLACE_TITLES` (`ad-networks.ts`), `RESTRICTED_BY`
  (`ads.service.ts`); остальные `Record<AdPlace, …>` покажет `pnpm typecheck`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — значение `clad_chest` в `enum AdPlace`, таблица
   `run_ad_chest`; ER в `docs/21`.
3. **Реклама** — место во всех списках сервера и панели.
4. **Хозяин места** — репозиторий, сервис, контроллер, ошибки, лимит.
5. **Итог** — `adChests`, причина вердикта, подписи.
6. **Вайп** — модель в плане.
7. **`docs/07`** — строка места в таблице рекламных мест.

## Чего не трогаем

- Движок, окно сундука и кнопку — T-0328.
- Правила общего капа — T-0241.

## Тесты

Первым коммитом.

- `run-ad-chest.test.ts` — вердикт: `adChests` 1 без показа → `unpaid_ad_chest`,
  забег отклонён; с читами разработчика — нет причины; 0 — в базу не ходим.
- `run-ad-chest.integration.test.ts` (живые Postgres и Redis):
  - показ досмотрен → сундук записан, повтор той же сессией — тот же ответ;
  - второй раз за забег → `chest_unavailable`;
  - сессия другого забега → отказ;
  - VIP — без показа, с пропуском;
  - общий кап исчерпан → `daily_cap`;
  - итог с `adChests` 1 и записью → вердикт без причины.
- `ads.test.ts`, `ads-catalog.test.ts` — новое место в каталоге и в панели.

## Аналитика

Существующие `ad_shown`, `ad_failed`, `ad_reward_claimed` с местом
`clad_chest` — через общие функции клиента (T-0328). Сервер пишет лог
`run_ad_chest_granted` (модуль, аккаунт, забег, сеть).

## Настройки и окружение

Нет: блоки места — в панели рекламы, кап — ключ T-0241.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Место `clad_chest` в каталоге рекламы; второй сундук — раз за забег, по досмотренному показу или пропуску VIP.
- [ ] Итог с неподтверждённым вторым сундуком отклоняется нейтральной причиной.
- [ ] Место входит в общий дневной кап роликов.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Второй сундук клада за ролик`
- **Метка:** `release: minor`
- **Для игроков:** пусто — кнопка появится с T-0328.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВТОРОЙ СУНДУК КЛАДА, СЕРВЕР**

  Новое место наградной рекламы «Второй сундук клада» (clad_chest): раз за забег, VIP — без ролика, в общем дневном капе роликов. Итог забега с неподтверждённым сундуком отклоняется.

  ❓ **Нужно от команды**

  • @владелец — завести блоки рекламы для места «Второй сундук клада» в панели, иначе кнопки не будет
  ```
