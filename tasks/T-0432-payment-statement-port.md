---
id: T-0432
title: Порт выписки площадки и выписка звёзд Telegram
epic: E1
priority: P1
status: ready
owner:
author: claude-lead-1
size: S
depends_on: []
zones:
  - backend/api/src/platforms/ports/payment-statement.ts
  - backend/api/src/platforms/telegram/telegram-star-statement.ts
  - backend/api/test/telegram-star-statement.test.ts
shared:
  - backend/api/src/platforms/telegram/telegram-bot-api.ts
  - backend/api/src/platforms/platforms.module.ts
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 4
---

# T-0432. Порт выписки площадки и выписка звёзд Telegram

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0432.json)](README.md#значки-статуса)

## Зачем

Сверка оплат с площадкой (T-0433) должна читать, что площадка на самом деле
списала и вернула, — а домен не знает о Telegram. Задача заводит
платформенно-нейтральный порт **выписки площадки** и его адаптер для Telegram
на методе Bot API `getStarTransactions`. Сама сверка и расписание — T-0433.

## Решения

- **Р209, WP53** (`docs/35-stage4-plan.md`): сверка платформенно-нейтральна,
  домен видит порт, Telegram — адаптер. Модуль учёта (`37-accounting.md` §8)
  потом возьмёт тот же порт.
- **Отдельный порт, а не метод `PaymentProvider`:** выписка — чтение истории
  счёта бота, а не оплата игрока; у площадки может быть оплата без выписки
  (тогда сверки нет) — порт просто не регистрируется.
- **Bot API `getStarTransactions`** (сверено 11.11.2026 по
  `@grammyjs/types` 5.0.0 и `core.telegram.org/bots/api`): операции бота **по
  порядку времени, от старых к новым**, `offset` — сколько пропустить,
  `limit` — 1–100. У входящей оплаты `id` совпадает с
  `SuccessfulPayment.telegram_payment_charge_id`, у возврата — с `id`
  исходной оплаты. Счётчика «всего» нет: страница короче `limit` — дальше
  пусто.
- **Что адаптер переводит в выписку:**

  | Операция Telegram | `kind` | `payerId` | `payload` |
  |---|---|---|---|
  | `source.type = user`, `transaction_type = invoice_payment` | `payment` | `String(source.user.id)` | `source.invoice_payload ?? null` |
  | `receiver.type = user`, `transaction_type = invoice_payment` | `refund` | `String(receiver.user.id)` | `receiver.invoice_payload ?? null` |
  | всё остальное (вывод через Fragment, реклама Telegram, подарки, партнёрка) | `other` | `null` | `null` |

  `subscriptionPeriodSec` — `subscription_period` у оплаты, иначе `null`.
  `nanostar_amount` не нужен: наши цены целые.
- **Ответ Telegram — граница:** разбор схемой Zod; операция, которая не
  прошла схему, — `other` с её `id`, если он есть, иначе пропуск, и строка
  `warn` в лог с номером позиции. Страница целиком не падает из-за одной
  строки: тогда сверка застряла бы навсегда на одной позиции.
- **Таймаут** — как у остальных вызовов `TelegramBotApi` (`REQUEST_TIMEOUT_MS`);
  ошибка площадки — исключение, сверка повторит в следующий раз.

## Как сейчас

- `backend/api/src/platforms/ports/payment-provider.ts` — образец порта и
  реестра площадок (`PaymentProviders`, `for(platform)`).
- `backend/api/src/platforms/telegram/telegram-bot-api.ts` (больше 500
  строк): методы оплаты — `answerPreCheckoutQuery`, `refundStarPayment`
  (строка ~470), `editUserStarSubscription`; общий `call(method, timeoutMs,
  signal, run)` с таймаутом и `TelegramApiError`; схемы ответов — Zod
  (`chatInfoSchema`).
- grammY 1.46.0: `api.getStarTransactions(other?: { offset?, limit? }, signal?)`.
- `backend/api/src/platforms/telegram/telegram-stars-provider.ts` — образец
  адаптера: `StarsBotApi = Pick<TelegramBotApi, …>`, тестируется подставным
  API.
- `backend/api/src/platforms/platforms.module.ts:39–40,77,85` —
  `paymentProvidersFor(config, telegramApi)`, провайдер `PaymentProviders`
  фабрикой, `exports`.
- `scripts/test/layer-boundaries.test.ts` — модули домена бэкенда не
  импортируют `platforms/telegram/*`, только `platforms/ports/*`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`platforms/ports/payment-statement.ts`** — без импортов из
   `modules/*`:

   ```ts
   export type StatementEntryKind = "payment" | "refund" | "other";
   export interface StatementEntry {
     /** идентификатор операции: у оплаты и её возврата — идентификатор оплаты */
     id: string;
     kind: StatementEntryKind;
     /** сколько — в единицах валюты площадки, у звёзд — звёзды */
     amount: number;
     at: Date;
     /** игрок на площадке: кто платил или кому вернули; у прочих — null */
     payerId: string | null;
     /** что стояло в счёте — у нас id покупки; у прочих — null */
     payload: string | null;
     subscriptionPeriodSec: number | null;
   }
   export interface PaymentStatement {
     readonly platform: PlatformId;
     /** больше страница не бывает */
     readonly pageMax: number;
     /** Страница по времени, от старых к новым, с позиции `offset`; короче `limit` — дальше пусто. Ошибка площадки — исключение. */
     page(offset: number, limit: number): Promise<StatementEntry[]>;
   }
   /** Выписки всех площадок, у которых она есть. */
   export class PaymentStatements {
     constructor(private readonly all: readonly PaymentStatement[]) {}
     for(platform: PlatformId): PaymentStatement | null;
     list(): readonly PaymentStatement[];
   }
   ```
3. **`telegram-bot-api.ts`** — один метод рядом с `refundStarPayment`, больше
   ничего в файле не трогать:

   ```ts
   /** Выписка звёзд бота: операции по порядку времени, от старых к новым (`offset`, `limit` 1–100). */
   async getStarTransactions(offset: number, limit: number, signal?: AbortSignal): Promise<unknown>;
   ```

   Через `call("getStarTransactions", REQUEST_TIMEOUT_MS, signal, (abort) =>
   this.api.getStarTransactions({ offset, limit }, abort))`; ответ отдаётся
   как есть (`unknown`) — разбирает адаптер.
4. **`telegram/telegram-star-statement.ts`** —
   `TelegramStarStatement implements PaymentStatement`:
   `platform = "telegram"`, `pageMax = 100`; конструктор
   `(api: Pick<TelegramBotApi, "getStarTransactions">)`; `page(offset, limit)`
   — `limit` зажимается в 1–100, `offset` — не меньше 0; ответ — схемой Zod
   (`transactions` — массив; у строки `id` 1–256 знаков, `amount` и `date` —
   целые, `source`/`receiver` — `{ type, transaction_type?, user?: { id },
   invoice_payload?, subscription_period? }` с `.passthrough()`); перевод — по
   таблице «Решений»; `at` — `new Date(date * 1000)`. Ответ без
   `transactions` — исключение `Error("выписка Telegram без transactions")`.
   Битая строка — по правилу «Решений», лог — строкой JSON `{ module:
   "telegram", event: "star_statement_row_skipped", position }`.
5. **`platforms.module.ts`** — функция `paymentStatementsFor(config,
   telegramApi)`: Telegram — только если задан токен бота
   (`config.telegram.botToken !== ""`), иначе пустой реестр; провайдер
   `{ provide: PaymentStatements, inject: [APP_CONFIG, TELEGRAM_BOT_API],
   useFactory: paymentStatementsFor }` и `PaymentStatements` в `exports`.
6. **Документы** — раздел «Документы».

## Чего не трогаем

- `PaymentProvider` и `TelegramStarsProvider` — оплата игрока без изменений.
- Остальной `telegram-bot-api.ts` (его перестраивает T-0393): один метод, без
  переноса кода.
- Сверку, расписание и таблицы — T-0433.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/telegram-star-statement.test.ts` — подставной API:
  - оплата игрока `{ id: "stx…" (131 знак), amount: 50, date, source: { type:
    "user", transaction_type: "invoice_payment", user: { id: 123 },
    invoice_payload: "<uuid>" } }` → `{ kind: "payment", payerId: "123",
    payload: "<uuid>", amount: 50, at }`;
  - оплата подписки с `subscription_period: 2592000` →
    `subscriptionPeriodSec: 2592000`;
  - возврат `{ receiver: { type: "user", transaction_type: "invoice_payment",
    user: { id: 123 } } }` → `kind: "refund"`, `payerId: "123"`;
  - вывод через Fragment (`receiver: { type: "fragment" }`) → `other`,
    `payerId: null`;
  - строка без `amount` среди двух хороших → две хорошие и `other` по
    правилу «Решений», в логе `star_statement_row_skipped`;
  - ответ без `transactions` → исключение;
  - `page(-5, 500)` → в API ушло `{ offset: 0, limit: 100 }`.
- `PaymentStatements` — `for("telegram")` находит адаптер, `for("max")` —
  `null` (в том же файле).

## Аналитика

Нет: порт только читает выписку.

## Настройки и окружение

Нет: токен бота уже в окружении.

## Документы

- `docs/21-diagrams.md` §3 — у портов площадок строка «выписка площадки
  (`payment-statement.ts`) ← адаптер Telegram `getStarTransactions`».

## Критерии приёмки

- [ ] Порт выписки не знает о Telegram и не импортирует модули домена.
- [ ] Адаптер переводит оплату, возврат и прочие операции по таблице
      «Решений»; битая строка не роняет страницу.
- [ ] Без токена бота реестр выписок пуст.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(platforms): Порт выписки площадки и выписка звёзд Telegram`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОРТ ВЫПИСКИ ПЛОЩАДКИ И ВЫПИСКА ЗВЁЗД TELEGRAM**

  Сервер умеет читать выписку звёзд бота из Telegram через нейтральный порт площадки. Это основа ежедневной сверки оплат с покупками (T-0433); MAX и VK подключатся тем же портом.
  ```
