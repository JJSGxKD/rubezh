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
  - packages/app-shell/src/state/continue-purchase.ts
  - packages/app-shell/test/continue-purchase.test.ts
  - packages/app-shell/src/i18n/ru-payments.json
shared:
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
- **Клиент:** на `account_restricted` экран второго шанса показывает, что
  покупки закрыты, и плашку ограничения со сроком и причиной от сервера —
  так же, как удвоение награды и магазин (WP44 ч.4). Тихое ограничение
  (`temporarily_unavailable`) выглядит как сбой: строка «Нет связи с
  сервером» и «Повторить», как сейчас (О40). Ролик за второй шанс остаётся.

Ответ claude-lead-1 на вопрос PR #363, 17.10.2026: шаги 3–5 переписаны.
Текст ограничения не тянется из тела ошибки: `api-request.ts` разбирает
только `code`, а срок и причину словами сервера уже отдаёт
`/me/restrictions` — их показывает `RestrictedPlaque`. Поэтому
`api-request.ts` и `payments-api.ts` не трогаем, причина отказа становится
состоянием стора покупки, а `paidErrorText` не нужен.

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
  её ошибки: `lineOf` берёт текст по ключу `run.continue.unavailable.<причина>`.
- `packages/app-shell/src/state/continue-purchase.ts`, `settleFailure` (96–107):
  403 разбирается как `failure: "disabled"` (`failureOf` в `api-request.ts`),
  поэтому `account_restricted` сейчас уходит в `markPaymentsOff()` и
  `unavailable("not_offered")` — «Сейчас второй шанс не купить» без причины.
  503 — `failure: "unavailable"` → `retry("offline")`.
- Образец плашки на экране итогов — `screens/run/RunDouble.tsx:123`
  (`RestrictedPlaque … compact`); список ограничений — `state/restrictions.ts`
  (`loadRestrictions`, `RESTRICTED_CODE`); вид ограничения покупок —
  `PURCHASES_RESTRICTION = ["purchases"]` в `screens/meta/shop.tsx:47`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`payments.service.ts`** — последним параметром конструктора
   `private readonly restrictions?: AccountRestrictions`. Необязательный, как
   `revocation` у `PaymentRefunds`: позиционные вызовы в тестах вне зон не
   ломаются. `RestrictionsModule` уже в импортах `payments.module.ts`, и он
   экспортирует `AccountRestrictions`. В `invoice` первой строкой:
   `await this.restrictions?.ensure(account.accountId, "purchases", new Date(nowMs))`.
3. **`state/continue-purchase.ts`.**
   - `UnavailableReason` += `"restricted"`, в комментарии к типу: «покупки
     аккаунта закрыты ограничением, о котором игроку сообщили».
   - В `settleFailure` **первой** веткой, до проверки `disabled`:
     `answer.code === RESTRICTED_CODE` (из `state/restrictions.ts`) →
     `markPaymentsOff()`, `void loadRestrictions(true)`,
     `unavailable("restricted")`. `markPaymentsOff` — как и сейчас при 403:
     дальше в этом запуске второй шанс за звёзды этому аккаунту не
     предлагается; `loadRestrictions(true)` — чтобы плашка встала со свежим
     списком.
   - `temporarily_unavailable` не трогать: он уже уходит в `retry("offline")`.
4. **`PaidContinue.tsx`.**
   - `PaidContinueView` не меняется: он остаётся без стора и сети, его рисует
     витрина. Строку под кнопкой `lineOf` возьмёт сам по ключу
     `run.continue.unavailable.restricted`.
   - В `PaidContinue` после `<PaidContinueView … />`: при
     `stage.kind === "unavailable" && stage.reason === "restricted"` —
     `<RestrictedPlaque kinds={PURCHASES_RESTRICTION} compact className="order-last col-span-full" />`,
     `const PURCHASES_RESTRICTION = ["purchases"]` — в этом файле, как в
     `shop.tsx:47`. `compact` — без «Написать нам»: с экрана смерти уходить
     некуда, кнопка есть в профиле.
   - `i18n/ru-payments.json`: `"run.continue.unavailable.restricted": "Покупки для аккаунта закрыты"`.
5. **Убрать из ветки** `screens/run/paid-continue-rules.ts` и
   `test/paid-continue-rules.test.ts`: причина теперь в состоянии стора, а
   текст сервера — в плашке. Отдельным коммитом.

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
- `packages/app-shell/test/continue-purchase.test.ts`, по образцу соседних
  кейсов с подменой `PaymentsApi`:
  - `invoice` → `{ ok: false, failure: "disabled", code: "account_restricted" }` →
    `stage` = `{ kind: "unavailable", reason: "restricted" }`,
    `canOfferPaidContinue()` → `false`;
  - `invoice` → `{ ok: false, failure: "unavailable", code: "temporarily_unavailable" }` →
    `stage` = `retry` с причиной `offline`, как раньше;
  - прочий 403 без кода (`failure: "disabled"`) → `unavailable("not_offered")`, как раньше.

## Аналитика

Нет новых событий.

## Настройки и окружение

Нет.

## Документы

`docs/29-admin-panel.md` — в описании ограничения «Покупки» дописать: «закрывает
и оплату второго шанса».

## Критерии приёмки

- [ ] Закрытый аккаунт не получает ссылку на оплату второго шанса, под кнопкой
  видит «Покупки для аккаунта закрыты» и плашку ограничения со сроком и
  причиной.
- [ ] Тихое ограничение выглядит как сбой: «Нет связи с сервером» и «Повторить».
- [ ] `paid-continue-rules.ts` и его теста в диффе PR нет.
- [ ] Открытому аккаунту всё как раньше; `quote` не изменился.
- [ ] Гейт (`CLAUDE.md`) зелёный.

## PR

- **Заголовок:** `fix(payments): Второй шанс за звёзды — с проверкой покупок`
- **Метка:** `release: patch`
- **Для игроков:** нет — касается только аккаунтов с закрытыми покупками
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВТОРОЙ ШАНС УВАЖАЕТ ЗАКРЫТЫЕ ПОКУПКИ**

  Аккаунт, которому закрыли покупки после возврата звёзд, больше не получает ссылку на оплату второго шанса: сервер отказывает сразу, а на экране смерти — плашка ограничения со сроком и причиной. Раньше отказ приходил только от Telegram на последнем шаге.
  ```
