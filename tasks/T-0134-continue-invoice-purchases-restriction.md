---
id: T-0134
title: Счёт за второй шанс проверяет ограничение «Покупки»
epic: E1
priority: P2
status: done
owner: claude-3 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/modules/payments/payments.service.ts
  - backend/api/test/payments.test.ts
  - packages/app-shell/src/screens/run/PaidContinue.tsx
  - packages/app-shell/src/screens/run/paid-continue-rules.ts
  - packages/app-shell/test/paid-continue-rules.test.ts
shared:
  - packages/app-shell/src/i18n/ru.json
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 2
---

# T-0134. Счёт за второй шанс проверяет ограничение «Покупки»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0134.json)](README.md#значки-статуса)

## Зачем

После внешнего возврата звёзд покупки аккаунта закрыты (T-0024): магазин и VIP
проверяют ограничение «Покупки», а счёт за второй шанс — нет. Закрытый аккаунт
получает ссылку на оплату, а отказ — только в предварительной проверке Telegram
(«подробности в игре»). Деньги не берутся, но игрок видит непонятный отказ
(находка ревью #275, `tasks/inbox.md`).

## Решения

Решение `claude-lead-1` от 14.10.2026:

- **Сервер:** `invoice` второго шанса проверяет ограничение «Покупки» тем же
  `AccountRestrictions.ensure(accountId, "purchases", at)`, что `shop.service.ts:139`
  и `vip.service.ts:117`, **до** открытия счёта. Ограничение с уведомлением —
  `AccountRestrictedError` (403, `account_restricted`, текст ограничения); тихое
  — `RestrictionSilentError` (503, `temporarily_unavailable`). Так `ensure` уже
  устроен.
- **`quote`** (цена на каждой смерти) не меняется: без записи и лишних чтений.
  Отказ приходит только на «Оплатить».
- **Клиент:** на `account_restricted` экран второго шанса показывает текст
  сервера вместо общего «не получилось»; на `temporarily_unavailable` — уже
  существующий текст временной недоступности. Ролик за второй шанс остаётся.

## Как сейчас

- `backend/api/src/modules/payments/payments.service.ts:119–134` — `invoice`:
  `offer` → `purchases.openInvoice(...)`, ограничений не смотрит.
  Конструктор (строки 106–112) — без `AccountRestrictions`.
- `backend/api/src/modules/shop/shop.service.ts:88,139` — образец: поле
  `restrictions: AccountRestrictions` и вызов `ensure` перед покупкой.
- `backend/api/src/modules/restrictions/restrictions-errors.ts` —
  `AccountRestrictedError` (`account_restricted`, 403), `RestrictionSilentError`
  (`temporarily_unavailable`, 503).
- `packages/app-shell/src/screens/run/PaidContinue.tsx` — оплата второго шанса и
  её ошибки.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`payments.service.ts`** — последним параметром конструктора
   `private readonly restrictions?: AccountRestrictions`. Необязательный, как
   `revocation` у `PaymentRefunds`: позиционные вызовы в тестах вне зон не
   ломаются. `RestrictionsModule` уже в импортах `payments.module.ts`, и он
   экспортирует `AccountRestrictions`. В `invoice` первой строкой:
   `await this.restrictions?.ensure(account.accountId, "purchases", new Date(nowMs))`.
3. **`paid-continue-rules.ts`** (новый, чистая функция) —
   `paidErrorText(code: string | null, message: string | null): { key: string } | { text: string }`:
   - `account_restricted` с текстом → `{ text: message }`;
   - `temporarily_unavailable` → ключ уже существующего текста временной недоступности;
   - остальное → прежний ключ ошибки оплаты.
4. **`PaidContinue.tsx`** — текст ошибки через `paidErrorText`; разметку не менять.

## Чего не трогаем

- `quote`, цены второго шанса, ролик за второй шанс.
- Магазин, VIP и правила ограничений.

## Тесты

- `backend/api/test/payments.test.ts`:
  - аккаунт с ограничением «Покупки» с уведомлением → `invoice` бросает
    `AccountRestrictedError`, `openInvoice` не вызван;
  - тихое ограничение → `RestrictionSilentError`, `openInvoice` не вызван;
  - без ограничения → счёт открыт, как раньше;
  - сервис без `restrictions` (как в старых тестах) → счёт открыт.
- `packages/app-shell/test/paid-continue-rules.test.ts` — три ветки `paidErrorText`.

## Аналитика

Нет новых событий.

## Настройки и окружение

Нет.

## Документы

`docs/29-admin-panel.md` — в описании ограничения «Покупки» дописать: «закрывает
и оплату второго шанса».

## Критерии приёмки

- [ ] Закрытый аккаунт не получает ссылку на оплату второго шанса и видит текст
  ограничения.
- [ ] Открытому аккаунту всё как раньше; `quote` не изменился.
- [ ] Гейт (`CLAUDE.md`) зелёный.

## PR

- **Заголовок:** `fix(payments): Второй шанс за звёзды — с проверкой покупок`
- **Метка:** `release: patch`
- **Для игроков:** нет — касается только аккаунтов с закрытыми покупками
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВТОРОЙ ШАНС УВАЖАЕТ ЗАКРЫТЫЕ ПОКУПКИ**

  Аккаунт, которому закрыли покупки после возврата звёзд, больше не получает ссылку на оплату второго шанса: сервер отказывает сразу и показывает причину. Раньше отказ приходил только от Telegram на последнем шаге.
  ```
