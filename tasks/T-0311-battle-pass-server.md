---
id: T-0311
title: Батл-пасс — сервер: месяц по Москве, очки пасса за задания, 30 ступеней в двух лентах, забор награды, VIP-лента и пройденное до покупки VIP
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0105]
zones:
  - backend/api/src/modules/battle-pass/**
  - backend/api/test/battle-pass-rules.test.ts
  - backend/api/test/battle-pass.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/app.module.ts
  - backend/api/src/modules/tasks/tasks.service.ts
  - backend/api/src/modules/vip/vip.service.ts
  - backend/api/src/modules/wallet/wallet-types.ts
  - backend/api/src/modules/wallet/wallet-limits.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - docs/37-accounting.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: design/art/meta-v2.md
batch: 8
---

# T-0311. Батл-пасс — сервер: месяц по Москве, очки пасса за задания, 30 ступеней в двух лентах, забор награды, VIP-лента и пройденное до покупки VIP

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0311.json)](README.md#значки-статуса) [![T-0105](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0105.json&label=T-0105)](T-0105-task-points-and-rewards.md)

## Зачем

У заданий уже есть очки пасса (`passPoints`), а самого пасса нет. После
задачи у игрока есть месяц, ради которого стоит заходить каждый день:
- задания приносят очки пасса;
- очки поднимают по 30 ступеням двух лент — бесплатной и VIP;
- награду ступени игрок забирает сам.

VIP открывает свою ленту целиком, включая ступени, пройденные до покупки.
Закрытие месяца — T-0312, ленты в панели — T-0313, экран — T-0314.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- Р46:
  - сезон — календарный месяц по Москве;
  - две ленты — бесплатная и VIP, отдельного пропуска нет;
  - VIP посреди месяца открывает пройденные VIP-награды;
  - очки — за задания, не за деньги;
- §3.15 — хранение прогресса и журнал забранного;
- Р11 — без случайного содержимого;
- 25.10.2026, опрос:
  - **30 ступеней**;
  - бесплатная лента — монеты, осколки, бусты и окрасы на 10-й и 20-й;
  - VIP — самоцветы, редкие осколки, окрасы и облик сезона на 30-й;
  - незабранное выдаётся само при закрытии.

Решения `claude-lead-1` от 25.10.2026:

- **Месяц** — по Москве (UTC+3 без перехода на летнее время):
  - ключ `YYYY-MM`;
  - граница — 1-е число 00:00 МСК = последний день прошлого месяца 21:00 UTC;
  - в базе — UTC.

  Сезон рейтинга — недельный (Р102), пасс от него отдельно: «сезон пасса и
  ладдера — один месяц» из Р46 устарел с недельным рейтингом.
- **Очки:**
  - забор задания с `passPoints > 0` прибавляет их пассу текущего месяца;
  - ключ — тот же, что у награды задания: повтор забора очков не удвоит.

  Таблица `pass_progress (account_id, month_key, points)`, `points` растёт
  под `UPDATE … SET points = points + $n`.
- **Ступень** — `floor(points / pass.points-per-tier)`, не больше 30:
  - ключ панели `pass.points-per-tier`, умолчание 100;
  - очки сверх 30-й копятся, но ступени не дают.

  Числа `passPoints` у заданий калибруются под «примерно ступень в день у
  того, кто делает задания дня и недели» — правка данных заданий в панели.
- **Ленты** — `pass_season (month_key, tiers jsonb, published_at)`:
  - `tiers` — 30 записей `{ tier, free: Reward, vip: Reward }`;
  - нет строки на месяц — **лента по умолчанию** из кода (`pass-defaults.ts`),
    без обликов: пасс работает, даже если ленту месяца не завели.
  - Схема награды — `{ coins?, gems?, shards?: { [rarity]: n }, boost?: { id, count } }`,
    поля `appearance` нет до T-0315. Случайного нет (Р11).
- **Лента по умолчанию** — стартовые числа. Бесплатная:
  - монеты 100…600 растущей лесенкой;
  - обычные и добротные осколки;
  - бусты на 5-й, 15-й и 25-й.

  VIP:
  - самоцветы 10…40;
  - редкие и эпические осколки;
  - эпический осколок на 30-й.

  Геймдизайнер калибрует.
- **Забор** — `POST /api/v1/pass/claim { tier, lane }`:
  - ступень достигнута;
  - лента `vip` — VIP активен **сейчас** (`vip.service.ts`);
  - журнал `pass_claim (account_id, month_key, tier, lane)` с уникальным ключом
    — повтор ничего не удвоит.

  Выдача:
  - через кошелёк, причина `pass_reward`, ключ `pass:<month>:<tier>:<lane>:<account>`;
  - бусты — подарком: `boost_credit (account_id, boost_id, count)` получает
    `+count`. Тратит подарки включение буста на забег — T-0312.

  Всё — одной транзакцией.
- **VIP посреди месяца** — VIP-ступени до текущей забираются сразу после
  покупки: условие — VIP активен в момент забора, а не в момент ступени.
- **Ответ** `GET /api/v1/pass`:
  - `{ monthKey, endsAt, points, tier, pointsPerTier, vip, tiers: [{ tier, free, vip, claimed: { free, vip } }] }`;
  - `endsAt` — граница месяца в UTC.
- **Потолок кошелька** — `pass_reward`: суммарно за 30 ступеней обеих лент с
  запасом (числа — из ленты по умолчанию × 2).

## Как сейчас

- **Очки у заданий** — `task_def.pass_points` (`tasks/task-rules.ts`,
  `passPoints`), в ответах заданий — `tasks.service.ts:81, 374`. Пасса нет.
- **VIP** — `vip/vip.service.ts`, периоды — `VipPeriod` (`endsAt`).
- **Кошелёк** — `wallet-types.ts` (`WALLET_RESOURCES`: монеты, самоцветы,
  осколки по редкостям), потолки — `wallet-limits.ts`.
- **После T-0105** — очки заданий и награды.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция:**
   - `pass_progress`, `pass_season`, `pass_claim`, `boost_credit`;
   - ER в `docs/21`;
   - строки в `wipe-plan.ts`: прогресс и журнал — данные игроков, ленты — `keep`.
3. **`battle-pass/pass-rules.ts`** — месяц по Москве, ступень, проверка
   ленты (чистые); `pass-defaults.ts` — лента по умолчанию.
4. **Модуль** — очки при заборе задания, `GET /pass`, `POST /pass/claim`.
5. **Кошелёк** — причина `pass_reward` и потолок; ключ `pass.points-per-tier`.
6. **Документы:**
   - `docs/30` — ключ;
   - `docs/37` — причина;
   - `docs/21`.

## Чего не трогаем

- Закрытие месяца и трату бустов-подарков — T-0312.
- Облики в наградах — T-0315.
- Экран — T-0314.

## Тесты

Первым коммитом.

- `battle-pass-rules.test.ts`:
  - 31 октября 20:59 UTC — октябрь, 21:00 UTC — ноябрь;
  - 250 очков при 100 на ступень → ступень 2;
  - 4 000 очков → 30;
  - лента по умолчанию проходит схему, обликов нет.
- `battle-pass.integration.test.ts`:
  - забор задания с 40 очками пасса → `points` +40; повтор забора — без удвоения;
  - забор ступени 2 бесплатной → монеты; повтор → 409, без второго начисления;
  - забор ступени с бустом → `boost_credit` +1;
  - ступень выше достигнутой → 409;
  - VIP-лента без VIP → 409;
  - купил VIP на 12-й ступени → VIP-награды 1…12 забираются;
  - два запроса забора разом → одно начисление.

## Аналитика

`pass_tier_reached { tier }` и `pass_reward_claimed { tier, lane }` — в
словарь `docs/22` §3.3 (WP26): сервер пишет `pass_tier_reached` при переходе
ступени, клиент — забор (T-0314).

## Настройки и окружение

Ключ `pass.points-per-tier`.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] Месяц по Москве, очки за задания, 30 ступеней двух лент; лента по умолчанию работает без настройки.
- [ ] Забор — ровно один раз; VIP-лента — при активном VIP, включая пройденное до покупки.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Батл-пасс — сервер`
- **Метка:** `release: minor`
- **Для игроков:** пусто — экран — T-0314.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — БАТЛ-ПАСС, СЕРВЕР**

  Батл-пасс на месяц по Москве: задания приносят очки пасса, 30 ступеней в бесплатной и VIP-ленте, награды забираются по одной. VIP открывает свою ленту целиком, включая пройденное до покупки. Шаг ступени — ключ pass.points-per-tier.
  ```
