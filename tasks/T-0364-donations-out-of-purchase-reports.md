---
id: T-0364
title: Донаты отдельно от покупок — ежедневный отчёт, цели сетей, разрез флагов
epic: E1
priority: P2
status: done
owner: claude-10 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/admin-notify/daily-stats.repository.ts
  - backend/api/src/modules/admin-notify/daily-stats.ts
  - backend/api/src/modules/ad-conversions/conversions.repository.ts
  - backend/api/src/modules/funnel/flag-split-report.ts
  - backend/api/test/daily-stats.integration.test.ts
  - backend/api/test/daily-stats.test.ts
  - backend/api/test/ad-conversions.integration.test.ts
  - backend/api/test/funnel.integration.test.ts
shared:
  - backend/api/src/modules/payments/purchase-types.ts
  - docs/22-analytics-and-metrics.md
  - docs/24-attribution-and-sharing.md
  - backend/api/test/admin-overview.test.ts
runner: any
executor: sonnet-5.5
effort: medium
release: patch
merge: lead
design: null
batch: 4
---

# T-0364. Донаты отдельно от покупок — ежедневный отчёт, цели сетей, разрез флагов

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0364.json)](README.md#значки-статуса)

## Зачем

Донат в базе — строка `purchase` с `product = "donation"` (T-0157). Воронка
уже не считает донат покупкой (Р109, `funnel-tracker.ts:44`). Три других
отчёта читают `purchase` целиком и считают донат обычной оплатой:
- ежедневный отчёт в чат команды — число покупок и звёзды;
- цели «покупка» для рекламных сетей;
- разрез по флагам.

Из-за этого флаг «поднял покупки», а сеть оптимизирует рекламу на донорах.
После задачи донаты в этих отчётах идут отдельно.

## Решения

Входящие 21.10 (после T-0157, #430). Решения `claude-lead-1` от 01.11.2026,
по Р109: донат — поддержка, а не покупка.

- **Ежедневный отчёт.** «Покупки» и звёзды покупок — без донатов. Отдельная
  строка «Донаты: N на M ⭐», только если они были за сутки. Итог дохода —
  звёзды покупок плюс донатов: деньги одни.
- **Цели рекламных сетей** (`purchase_first`, `purchase_repeat`) — без
  донатов, как в воронке. Номер покупки считается тоже без них: первая
  покупка — первая не-донатная оплата.
- **Разрез по флагам** (`flag-split-report.ts`) — покупки и звёзды без
  донатов. Флаг меняет игру, а не желание поддержать проект.
- **Одно условие** `product <> 'donation'` — константа или фрагмент рядом с
  `funnel-tracker`, а не три разных строки.

## Как сейчас

- `daily-stats.repository.ts:83–86` — звёзды и число покупок из `purchase`;
  текст отчёта — `daily-stats.ts`.
- `conversions.repository.ts:172–177` — `paid` по всем оплатам аккаунта.
- `flag-split-report.ts:108–109` — звёзды по `purchase`.
- `funnel-tracker.ts:44` — донат пропускается в `first_purchase`.

## Шаги по порядку

1. Тесты первым коммитом.
2. Общее условие «не донат».
3. Ежедневный отчёт — покупки без донатов, строка донатов, итог дохода.
4. Конверсии сетям — без донатов.
5. Разрез флагов — без донатов.

## Чего не трогаем

- Сам донат, знак «Поддержал проект», выдачу и возврат (T-0157).
- Бухгалтерию и выручку в отчётах денег (`docs/37`): там донат — доход, как
  и был.

## Тесты

- `daily-stats.integration.test.ts`: покупка 50 ⭐ и донат 100 ⭐ за сутки →
  «покупок 1, 50 ⭐», «донатов 1 на 100 ⭐», доход 150 ⭐.
- `daily-stats.test.ts`: строки донатов нет, когда их ноль.
- `ad-conversions.integration.test.ts`: донат первым, покупка вторым → цель
  `purchase_first` у покупки, у доната цели нет.
- `funnel.integration.test.ts` (разрез флагов): донат не попадает в звёзды
  группы.

## Аналитика

Нет новых событий: разрез отчётов.

## Настройки и окружение

Нет.

## Документы

- `docs/22-analytics-and-metrics.md` — «донат — не покупка» в определении
  покупки для отчётов.
- `docs/23-referral-and-partner-program.md` или `docs/24`, где описаны цели
  сетям — строка про донаты.

## Критерии приёмки

- [ ] Донаты не входят в покупки ежедневного отчёта, цели сетей и разрез
      флагов; в ежедневном отчёте — своей строкой.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(api): Донаты отдельно от покупок в отчётах`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДОНАТЫ ОТДЕЛЬНО ОТ ПОКУПОК**

  В ежедневном отчёте донаты идут своей строкой, а покупки — без них. Рекламные сети и разрез по флагам больше не принимают донат за покупку.
  ```
