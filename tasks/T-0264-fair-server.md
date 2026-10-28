---
id: T-0264
title: Ярмарка — сервер: облики и окрасы за самоцветы на неделю по кругу
epic: E1
priority: P3
status: draft
owner:
author: claude-lead-1
size: M
depends_on: [T-0245]
zones:
  - backend/api/src/modules/fair/**
  - backend/api/test/fair-rules.test.ts
  - backend/api/test/fair.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/app.module.ts
  - backend/api/src/modules/appearance/appearance-catalog.ts
  - backend/api/src/modules/appearance/appearance-grants.repository.ts
  - backend/api/src/modules/wallet/wallet-types.ts
  - backend/api/src/modules/wallet/wallet-limits.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/07-monetization-and-ads.md
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/37-accounting.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/meta-v2.md
batch: 4
---

# T-0264. Ярмарка — сервер: облики и окрасы за самоцветы на неделю по кругу

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0264.json)](README.md#значки-статуса) [![T-0245](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0245.json&label=T-0245)](T-0245-keeper-set-server.md)

> **Черновик до обликов.** Ярмарка продаёт только своё: Скомороха и окрасы
> «с Ярмарки», которые нарисует дизайнер (`design/art/backlog.md`, п. 13).
> За деньги — только видное до покупки (Р11). В `ready` — с кадрами и
> портретами хотя бы шести позиций.

## Зачем

Самоцветам нечем заинтересовать, кроме бустов и второго шанса, а облики
пока только зарабатываются. После задачи в магазине есть Ярмарка: три
позиции в неделю — Скоморох и ярмарочные окрасы архетипов — за самоцветы.
Каждую неделю витрина меняется по кругу, и видно «уйдёт через 2 дня».

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- **Р154** — Ярмарка: облики и окрасы на неделю по кругу, видно до покупки;
- **поправка от 24.10.2026** — **только своё**: Скоморох и окрасы с
  Ярмарки. Заработанные облики (уровень, VIP, достижение, сезон) не
  продаются.

Решения `claude-lead-1` от 24.10.2026:

- **Позиции** — в каталоге обликов T-0237:
  - новый источник `{ kind: "fair" }`;
  - цена в самоцветах — у облика: Скоморох — 600, окрас — 250, геймдизайнер калибрует;
  - Скоморох меняет источник с `event` на `fair`.
- **Витрина недели** — 3 позиции. Неделя — календарная, как у сезона
  (`seasons-schedule.ts`, понедельник UTC).
  - Порядок — круг по каталогу: позиции недели `w` — индексы `(3w … 3w+2) mod N`.
  - Детерминированно и без таблицы: одна и та же неделя у всех одна.
  - Купленное игроком в витрине помечено «Куплено».
- **Покупка** — `POST /api/v1/fair/:appearanceId/buy`:
  - позиции нет на этой неделе — 409 `fair_not_on_sale`;
  - уже есть — 409 `fair_owned`;
  - не хватает самоцветов — 409 `insufficient_funds`, как в кошельке.

  Списание — новая причина траты `fair_purchase`, ключ идемпотентности —
  `fair:<accountId>:<appearanceId>`. Выдача — строка `appearance_grant` с
  источником `fair` (T-0245). Списание и выдача — одной транзакцией.
- **Возврата за самоцветы нет**, как у остальных трат самоцветами.
- **Ключ панели** `fair.enabled` (по умолчанию выкл.): включает Ярмарку после
  просмотра обликов на деве.

## Как сейчас

- После T-0237 и T-0245 — каталог обликов, `appearance_grant`. Траты
  самоцветами — `wallet` (`spend`), причины — `wallet-types.ts`.
- Неделя сезона — `seasons/seasons-schedule.ts`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Каталог** — источник `fair`, цены, Скоморох.
3. **`fair-rules.ts`** — `weekKey(at)`, `fairWeek(catalog, weekKey)`.
4. **Модуль `fair`** — `GET /api/v1/fair` → `{ data: { weekKey, endsAt, items: [{ id, price, owned }] } }`, покупка.
5. **Кошелёк** — причина `fair_purchase`.
6. **Ключ панели** `fair.enabled`.
7. **Событие** `fair_purchased { appearance, price }` — серверное в лог и
   клиентское при успехе (словарь `docs/22`).
8. **Документы:** `docs/07`, `docs/30`, `docs/37` (траты самоцветов), `docs/21`.

## Чего не трогаем

- Покупку за звёзды. Подарок облика — позже.

## Тесты

Первым коммитом.

- `fair-rules.test.ts`: три разные позиции в неделю; через N/3 недель круг
  повторяется; неделя на стыке года — по понедельнику UTC.
- `fair.integration.test.ts`:
  - покупка позиции недели → облик держится, самоцветы списаны;
  - повтор → 409 `fair_owned`, второго списания нет;
  - не на этой неделе → 409; не хватает → 409, ничего не списано;
  - `fair.enabled = false` → `GET` и покупка 404.

## Аналитика

По шагу 7.

## Настройки и окружение

`fair.enabled` — по шагу 6.

## Документы

По шагу 8.

## Критерии приёмки

- [ ] Три позиции в неделю по кругу; покупка за самоцветы выдаёт облик.
- [ ] Заработанные облики не продаются; повтор и нехватка — без списаний.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(backend): Ярмарка обликов — сервер`
- **Метка:** `release: minor`
- **Для игроков:** пусто — витрина с T-0265.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЯРМАРКА, СЕРВЕР**

  Ярмарка: три облика или окраса в неделю по кругу за самоцветы — Скоморох и ярмарочные окрасы; заработанные облики не продаются. Включается ключом fair.enabled в панели.
  ```
