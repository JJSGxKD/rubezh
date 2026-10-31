---
id: T-0267
title: Дружина — неделя: босс дружины из забегов участников, рейтинг дружин, награда и подарки внутри
epic: E16
priority: P3
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0266, T-0125]
zones:
  - backend/api/src/modules/clans/clan-week.service.ts
  - backend/api/src/modules/clans/clan-week.job.ts
  - backend/api/src/modules/clans/clan-week-rules.ts
  - backend/api/test/clan-week-rules.test.ts
  - backend/api/test/clan-week.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/clans/clans.module.ts
  - backend/api/src/modules/clans/clans.controller.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/friends/friends.service.ts
  - backend/api/src/modules/wallet/wallet-types.ts
  - backend/api/src/modules/wallet/wallet-limits.ts
  - backend/api/src/modules/notifications/notification-kinds.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 5
---

# T-0267. Дружина — неделя: босс дружины из забегов участников, рейтинг дружин, награда и подарки внутри

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0267.json)](README.md#значки-статуса) [![T-0266](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0266.json&label=T-0266)](T-0266-clans-core-server.md) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](archive/T-0125-run-result-rank-chest-crystal-counters.md)

## Зачем

Дружина без общего дела — просто список. После задачи у каждой дружины
есть босс недели с общим запасом здоровья:
- его «бьют» боссы и элиты, которых участники убивают в обычных забегах;
- рейтинг дружин недели — по урону боссу;
- победили босса — награда каждому, кто бил;
- участники могут дарить друг другу подарки, как друзьям.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- **Р154** — общий рейтинг, босс дружины раз в неделю, подарки;
- **поправка от 24.10.2026** — босс — общий запас здоровья на неделю,
  его тают боссы и элиты, убитые участниками в обычных забегах. Нового
  режима нет.

Решения `claude-lead-1` от 24.10.2026:

- **Урон боссу** из записанного забега участника, считающегося по правилам
  наград (`countsForTasks`):
  - `bossKills × 100 + eliteKills × 10` (счётчики T-0125);
  - урон за забег не больше 1 000.

  Пишется в `clan_week_damage (clan_id, week_key, account_id, damage)` —
  суммой за неделю, в той же транзакции, что запись забега, или очередью
  после неё.
- **Здоровье босса** = `clan.boss-hp-per-member` (ключ панели, старт 800) ×
  число участников на начало недели, не меньше 3 участников по расчёту.
  Неделя — та же, что у сезона (понедельник UTC).
- **Рейтинг дружин недели** — по суммарному урону; `GET /api/v1/clans/rating`
  — первые 50 и место своей дружины.
- **Закрытие недели** — задание под локом Redis, по образцу закрытия сезона
  (`seasons-close.service.ts`), идемпотентно по `(clan_id, week_key)` в
  `clan_week`:
  - победили — каждому, кто нанёс хоть 1 урона, начисление: 500 монет и 10 самоцветов, ключи `clan.boss-reward-coins`, `clan.boss-reward-gems`;
  - причина `clan_reward`, ключ идемпотентности — `clan:<clan>:<week>:<account>`;
  - уведомление `clan_boss_defeated`.

  Ушедшие до закрытия награды не получают. Пауза 24 ч на вступление (T-0266)
  мешает перескоку.
- **Подарки** — те же правила и лимиты, что у подарков друзьям
  (`GIFT_RULES`), получатель — участник своей дружины. Правка — в проверке
  «можно ли дарить» у друзей, без второго механизма.
- **Ответ** `GET /api/v1/clans/me` получает `boss: { hp, damage, myDamage,
  endsAt, defeated }`.

## Как сейчас

- После T-0266 — модуль `clans`. После T-0125 — `bossKills`, `eliteKills` в
  итоге забега.
- Закрытие недели — образец `seasons/seasons-close.service.ts`, лок и
  идемпотентность.
- Подарки друзьям — `friends/friends.service.ts` (`GIFT_RULES`, причина
  `friend_gift`).

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция:**
   - `clan_week_damage`;
   - `clan_week (clan_id, week_key, boss_hp, defeated, closed_at)`;
   - ER в `docs/21`.
3. **`clan-week-rules.ts`** — урон забега, здоровье, победа (чистые).
4. **Запись урона** — из записи забега (`runs.service.ts`), сбой не мешает
   записи забега.
5. **Закрытие** — `clan-week.job.ts`, `clan-week.service.ts`; причина
   кошелька `clan_reward` с потолком.
6. **Рейтинг** — маршрут.
7. **Подарки** — правило «участник дружины».
8. **Ключи панели** — `clan.boss-hp-per-member`, `clan.boss-reward-coins`,
   `clan.boss-reward-gems`; строки в `docs/30`.
9. **Очистка** — новые таблицы в `wipe-plan.ts`.

## Чего не трогаем

- Ядро — T-0266. Экран — T-0268.

## Тесты

Первым коммитом.

- `clan-week-rules.test.ts`:
  - урон: 2 босса и 15 элит → 350;
  - потолок 1 000;
  - здоровье при 2 участниках считается как при 3.
- `clan-week.integration.test.ts`:
  - забег участника → урон боссу;
  - забег вне правил наград → нет;
  - урон ≥ здоровья → победа; закрытие → награда каждому, кто бил; повтор закрытия — без второй награды;
  - не победили → наград нет;
  - ушедший до закрытия — без награды;
  - две реплики закрытия — одна выдача;
  - рейтинг — порядок по урону;
  - подарок участнику — проходит по правилам друзей.

## Аналитика

Клиентские события — T-0268. Сервер — лог `clan_week_closed` с числом дружин
и побед.

## Настройки и окружение

Ключи — по шагу 8.

## Документы

`docs/21`, `docs/30`.

## Критерии приёмки

- [ ] Боссы и элиты участников тают общее здоровье босса недели; рейтинг дружин — по урону.
- [ ] Победа — награда каждому, кто бил, ровно один раз; ушедшие — без награды.
- [ ] Подарки участникам дружины — по правилам подарков друзьям.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Дружина — босс недели и рейтинг`
- **Метка:** `release: minor`
- **Для игроков:** пусто — экран с T-0268.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — БОСС ДРУЖИНЫ**

  У каждой дружины — босс недели: боссы и элиты, убитые участниками в обычных забегах, тают его общее здоровье. Рейтинг дружин — по урону; победили — каждому, кто бил, монеты и самоцветы. Участники дарят друг другу подарки, как друзья. Числа — ключи clan.* в панели.
  ```
