---
id: T-0329
title: Облик в подарок другу — сервер: позиция Ярмарки за самоцветы дарящего, только другу и только то, чего у него нет; уведомление получателю
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0264, T-0247]
zones:
  - backend/api/src/modules/fair/fair-gift.service.ts
  - backend/api/src/modules/fair/fair-gift.repository.ts
  - backend/api/src/modules/fair/fair-gift-rules.ts
  - backend/api/test/fair-gift-rules.test.ts
  - backend/api/test/fair-gift.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/modules/fair/fair.controller.ts
  - backend/api/src/modules/fair/fair.module.ts
  - backend/api/src/modules/fair/fair-errors.ts
  - backend/api/src/modules/wallet/wallet-types.ts
  - backend/api/src/modules/notifications/notification-kinds.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/src/modules/wipe/wipe-runner.ts
  - backend/api/test/wipe-plan.test.ts
  - docs/07-monetization-and-ads.md
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/37-accounting.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 4
---

# T-0329. Облик в подарок другу — сервер: позиция Ярмарки за самоцветы дарящего, только другу и только то, чего у него нет; уведомление получателю

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0329.json)](README.md#значки-статуса) [![T-0264](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0264.json&label=T-0264)](T-0264-fair-server.md) [![T-0247](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0247.json&label=T-0247)](T-0247-player-card-server.md)

> **Ярмарка готова к работе** — T-0264 в `ready` с составом из шести
> позиций (31.10.2026).

## Зачем

VIP можно подарить другу (T-0249), облик — нет. После задачи игрок покупает
другу облик или окрас с Ярмарки этой недели за свои самоцветы. Друг
получает облик и уведомление «вам подарили облик». Это социальная покупка и
повод написать другу. Клиент — T-0330.

## Решения

Решения владельца — `docs/35-stage4-plan.md`:
- Р162 (25.10.2026) — облик в подарок другу: из карточки друга, за
  самоцветы, с Ярмарки, по образцу VIP в подарок;
- Р155 и поправка 24.10.2026 — дарить можно только друзьям;
- Р11 — за деньги только видное до покупки: подарок — та же позиция витрины.

Решения `claude-lead-1` от 25.10.2026:

- **Что дарится** — позиция Ярмарки **этой недели** (`fairWeek`, T-0264), по
  её цене в самоцветах. Заработанные облики не дарятся: их нет в продаже.
- **Заказ** — `POST /api/v1/fair/:appearanceId/gift { publicId }`, проверки
  по порядку:
  - Ярмарка включена (`fair.enabled`), иначе 404;
  - позиции нет на этой неделе — 409 `fair_not_on_sale`;
  - получатель есть и это друг, не сам дарящий, не заблокирован — иначе 409
    `gift_not_friend`;
  - у получателя облик уже есть — 409 `gift_owned`: подарок не должен
    сгореть;
  - не больше пяти подарков в сутки на дарящего — 429 `gift_daily_limit`;
  - мало самоцветов — 409 `insufficient_funds`.
- **Одной транзакцией:**
  - списание самоцветов дарящего — причина `fair_gift`, ключ
    `fair-gift:<giver>:<recipient>:<appearanceId>`;
  - выдача получателю — строка `appearance_grant` с источником `gift`
    (T-0245);
  - строка `appearance_gift (recipient_account_id, appearance_id,
    giver_account_id, price_gems, created_at)`, ключ `(recipient_account_id,
    appearance_id)` — от кого подарок.

  Повтор того же запроса — тот же ответ без второго списания.
- **Уведомление** получателю — вид `appearance_gift { fromName, appearance }`,
  дедуп по строке подарка. Перестали дружить после выдачи — подарок
  остаётся.
- **Возврата нет** — как у остальных трат самоцветами.
- **Учёт** — трата внутренней валюты, выручки нет; строка причины в `docs/37`.

## Как сейчас

- **После T-0264** — `fair-rules.ts` (`weekKey`, `fairWeek`), модуль `fair`,
  покупка себе (`POST /fair/:appearanceId/buy`), причина `fair_purchase`.
- **После T-0245** — `appearance_grant` с источником.
- **После T-0247** — `publicId`, `byPublicId`, проверка дружбы.
- **Образец** — VIP в подарок (T-0249): проверки получателя, лимит в сутки,
  уведомление `vip_gift`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** — `appearance_gift`, источник `gift` у `appearance_grant`;
   ER в `docs/21`; строки в `wipe-plan.ts` и `wipe-runner.ts`.
3. **`fair-gift-rules.ts`** — порядок проверок (чистые).
4. **Сервис и репозиторий** — заказ одной транзакцией.
5. **Контроллер** — маршрут, Zod на входе, лимит запросов.
6. **Кошелёк** — причина `fair_gift`; **уведомление** — вид.
7. **Событие** — `fair_gifted { appearance, price }`: сервер — в лог,
   клиент — при успехе (словарь `docs/22` §3.3 и Zod).
8. **Документы** — `docs/07`, `docs/21`, `docs/22`, `docs/37`.

## Чего не трогаем

- Покупку себе и витрину — T-0264.
- VIP в подарок — T-0249.
- Клиент — T-0330.

## Тесты

Первым коммитом.

- `fair-gift-rules.test.ts` — каждая проверка по отдельности, порядок
  отказов.
- `fair-gift.integration.test.ts` (живые Postgres и Redis):
  - подарок другу → у него облик, у дарящего списано, уведомление одно;
  - повтор → без второго списания;
  - не друг → 409 `gift_not_friend`; у друга уже есть → 409 `gift_owned`,
    ничего не списано;
  - шестой подарок за сутки → 429;
  - позиция прошлой недели → 409 `fair_not_on_sale`;
  - два запроса разом — одно списание.

## Аналитика

`fair_gifted { appearance, price }` — по шагу 7.

## Настройки и окружение

Нет: подарки живут под ключом `fair.enabled` Ярмарки.

## Документы

По шагу 8.

## Критерии приёмки

- [ ] Облик с Ярмарки этой недели дарится другу за самоцветы дарящего — один раз, только то, чего у друга нет.
- [ ] Получатель видит облик и уведомление; подарок не возвращается.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Облик в подарок другу`
- **Метка:** `release: minor`
- **Для игроков:** пусто — кнопка появится с T-0330.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОБЛИК В ПОДАРОК, СЕРВЕР**

  Облик или окрас с Ярмарки этой недели теперь можно подарить другу за свои самоцветы: только другу, только то, чего у него нет, до пяти подарков в сутки. Друг получает облик и уведомление.
  ```
