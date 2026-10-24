---
id: T-0242
title: Награда дня ×2 за ролик — новое место рекламы daily_double, сервер
epic: E1
priority: P1
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0241]
zones:
  - backend/api/src/modules/daily/daily-double.service.ts
  - backend/api/src/modules/daily/daily-double-errors.ts
  - backend/api/test/daily-double.test.ts
  - backend/api/test/daily-double.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/ads/ads-rules.ts
  - backend/api/src/modules/ads/ad-networks.ts
  - backend/api/src/modules/ads/ads.service.ts
  - backend/api/src/modules/daily/daily.controller.ts
  - backend/api/src/modules/daily/daily.module.ts
  - backend/api/src/modules/daily/daily.repository.ts
  - backend/api/src/modules/daily/daily.service.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/src/modules/wipe/wipe-runner.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - backend/api/test/ads.test.ts
  - backend/api/test/ads-catalog.test.ts
  - apps/admin/src/api/ads.ts
  - apps/admin/test/ads.test.ts
  - packages/app-shell/src/state/ads-api.ts
  - docs/07-monetization-and-ads.md
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0242. Награда дня ×2 за ролик — новое место рекламы daily_double, сервер

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0242.json)](README.md#значки-статуса) [![T-0241](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0241.json&label=T-0241)](T-0241-ads-daily-cap.md)

## Зачем

Награду дня игрок забирает раз в сутки и уходит. После задачи сразу после
забора он может удвоить её за ролик: те же монеты и осколки ещё раз, раз в
игровые сутки. Это новое место наградной рекламы под общим капом (T-0241).
Клиент — T-0244.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р155: награда дня
×2 за ролик раз в день — новое место наградной рекламы под общим дневным
капом.

Решения `claude-lead-1` от 24.10.2026:

- **Место `daily_double`** («Награда дня ×2»):
  - формат `rewarded`, `pass: true` — VIP удваивает без ролика, как в других местах;
  - `cooldown: null` — раз в сутки держит хозяин места, модуль награды дня.
- **Удвоить можно только сегодняшнюю забранную награду и один раз.** Не
  забрал — нечего удваивать. Сутки прошли — удвоение того дня сгорело,
  копить нельзя.
- **Начисление** — столько же монет и осколков, сколько даёт сегодняшний
  день по тем же правилам (`dailyReward(день, уровень)`):
  - день — номер последнего забора (`daily_reward.claimed_days`);
  - причина кошелька `daily_reward`, источник `daily:<день>:double`, ключ идемпотентности `daily:<accountId>:<день>:double`;
  - потолок причины `daily_reward` (5 000 монет, 100 осколков) двойной самый щедрый день выдерживает: около 2 900 монет и 32 осколков.
- **Порядок** — как у второго шанса (`runs/run-ad-continue.service.ts`): проверка → забор сессии → запись → начисление.
  - Проверка идёт до забора: досмотренная сессия не тратится на день, который удвоить нельзя.
  - Повтор той же сессией после обрыва отдаёт тот же ответ и дожимает начисление тем же ключом.
- **Где хранится, что удвоено:** таблица `daily_double (account_id,
  game_day date, day_number int, session_id, coins, shards, created_at)` с
  ключом `(account_id, game_day)` и уникальным `session_id`. В
  `daily_reward` одна строка на игрока, отдельной строки забора дня нет.
  Запись — `ON CONFLICT DO NOTHING`, исходы `granted | repeat | taken`.
- **Ответ награды дня** (`GET /daily`) получает `double`:
  - `{ status: "available", coins, shards, ad: { available, readyAt, pass, capped } }`;
  - `{ status: "doubled", coins, shards }`;
  - `{ status: "unavailable" }` — сегодня не забрано или нет рекламы.
- **Список мест — везде:** Prisma `enum AdPlace`, `AD_PLACES` сервера,
  клиента (`state/ads-api.ts`) и панели (`apps/admin/src/api/ads.ts`,
  название «Награда дня ×2»), `PLACE_FORMAT` и `PLACE_TITLES` в
  `ad-networks.ts`. Перечень мест в тестах — по образцу T-0199.
- **Кап (T-0241)** считает новое место сам: оно `rewarded` и не `task`.

## Как сейчас

- `daily_reward (account_id PK, claimed_days, last_claim_day, updated_at)` —
  `schema.prisma:1333`: одна строка на игрока; «забрал сегодня» —
  `last_claim_day` равен игровым суткам.
- `daily/daily.service.ts:68–82` — `claim`:
  - `wallet.grant` монет и осколков с причиной `daily_reward`, источник `daily:<день>`, ключ `key`;
  - `repository.advance`;
  - лог `daily_claimed`.
- `daily/daily.controller.ts:22,29` — `GET /daily`, `POST /daily/claim`.
- Хозяин места по образцу — `runs/run-ad-continue.service.ts`,
  `run-ad-continues.repository.ts`, ошибки `run-continue-errors.ts`;
  удвоение за забег — `progress/run-double.service.ts`.
- Где упоминаются места рекламы — список в T-0199, раздел «Как сейчас»
  («Реклама», «Панель»).

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** (`--create-only` один раз):
   - `ALTER TYPE "AdPlace" ADD VALUE 'daily_double'`;
   - таблица `daily_double` по «Решениям», внешний ключ на `account` с `ON DELETE CASCADE`;
   - модель — с комментариями полей, ER — в `docs/21`.
3. **Места рекламы:** `ads-rules.ts`, `ad-networks.ts`, `ads.service.ts`
   (`RESTRICTED_BY`: тот же вид ограничения, что у удвоения за забег), списки
   клиента и панели.
4. **`daily-double.service.ts`:**
   - `view(player, at)` и `double(player, sessionId, at)` по «Решениям»;
   - ошибки в `daily-double-errors.ts`: `DailyNotClaimedError` (409, `daily_not_claimed`), `DailyAlreadyDoubledError` (409, `daily_already_doubled`);
   - чужая или чужого места сессия — ошибка модуля рекламы, как у второго шанса;
   - лог `daily_doubled` с днём и начисленным.
5. **Контроллер** — `POST /daily/double`, тело `{ sessionId }` (Zod), ответ
   `{ data: { credited: { coins, shards }, view } }`. `GET /daily` получает
   `double`. Лимит — как у `claim`.
6. **Очистка:** `daily_double` — в `wipe-plan.ts` и `wipe-runner.ts` рядом с
   `daily_reward`.
7. **Событие:** `ad_reward_claimed` принимает `place: daily_double` — `docs/22`
   и Zod в `event-dictionary.ts`.
8. **Документы:** `docs/07` — место в таблице мест, `docs/21` — ER.

## Чего не трогаем

- Сам забор награды дня и её числа (`daily-rules.ts`).
- Кап — T-0241. Клиент — T-0244.

## Тесты

Первым коммитом.

- `backend/api/test/daily-double.test.ts`:
  - `view`: сегодня не забрано → `unavailable`; забрано → `available` с числами забора; удвоено → `doubled`;
  - вчерашний забор сегодня не удваивается.
- `backend/api/test/daily-double.integration.test.ts` (живые Postgres и Redis):
  - забор 7-го дня (300 монет и 10 осколков на уровне 1) → ролик → `POST /daily/double` → ещё столько же;
  - повтор той же сессией → тот же ответ, второго начисления нет;
  - вторая сессия в тот же день → 409 `daily_already_doubled`;
  - до забора → 409 `daily_not_claimed`, сессия не потрачена;
  - VIP с пропуском — без ролика;
  - кап T-0241 достигнут → `ad.capped: true`;
  - место есть в списках сервера, клиента и панели (тесты мест зелёные).

## Аналитика

`ad_reward_claimed` с `place: daily_double` — по шагу 7. Сравнение «удваивают
или нет» — по `ad_session` места в «Рекламе» панели.

## Настройки и окружение

Нет: блоки места заводятся в панели «Реклама», как у других мест.

## Документы

По шагу 8.

## Критерии приёмки

- [ ] После забора награды дня её можно удвоить за ролик один раз в сутки; VIP — без ролика.
- [ ] Повтор и обрыв не дают двойного начисления.
- [ ] Место `daily_double` есть в базе, на сервере, у клиента и в панели.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(daily): Награда дня ×2 за ролик — сервер`
- **Метка:** `release: minor`
- **Для игроков:** пусто — кнопка придёт с клиентом (T-0244).
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — НАГРАДА ДНЯ ×2, СЕРВЕР**

  Новое место наградной рекламы daily_double: после забора награды дня её можно удвоить за ролик раз в сутки, VIP — без ролика. Место под общим капом роликов. Блоки для него заводятся в панели «Реклама».

  ❓ **Нужно от команды**

  • @владелец — завести блоки сетей для места «Награда дня ×2» в панели «Реклама»
  ```
