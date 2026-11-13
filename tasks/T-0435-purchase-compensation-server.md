---
id: T-0435
title: Компенсация самоцветами за сбой оплаты — сервер
epic: E1
priority: P1
status: in-progress
owner: claude-lead-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: [T-0429]
zones:
  - backend/api/src/modules/payments/purchase-compensation.ts
  - backend/api/src/modules/payments/purchase-compensation-rules.ts
  - backend/api/src/modules/payments/purchase-compensation.repository.ts
  - backend/api/src/modules/admin/admin-payment-compensation.controller.ts
  - backend/api/src/modules/wallet/wallet-types.ts
  - backend/api/src/modules/wallet/wallet-limits.ts
  - backend/api/test/purchase-compensation.test.ts
  - backend/api/test/purchase-compensation.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/test/player-address.test.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/payments/payments-errors.ts
  - backend/api/src/modules/payments/payments.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - packages/app-shell/src/i18n/ru-history.json
  - apps/admin/src/api/audit.ts
  - apps/admin/test/audit.test.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/29-admin-panel.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 4
---

# T-0435. Компенсация самоцветами за сбой оплаты — сервер

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0435.json)](README.md#значки-статуса) [![T-0429](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0429.json&label=T-0429)](T-0429-payments-feed-server.md)

## Зачем

11.11.2026 игроки заплатили звёздами и какое-то время оставались без товара
по нашей вине. Владелец хочет извиняться внутренней валютой — из карточки
платежа, одной кнопкой, без риска начислить дважды. Сейчас для этого есть
только «Кошелёк ±» в карточке игрока: он не знает о покупке и не помешает
второй компенсации. После задачи у сервера есть предложение суммы и
компенсация, привязанная к покупке, — одна на покупку. Окно в панели —
T-0438, сообщение игроку — T-0436.

## Решения

- **Р209, WP53** (`docs/35-stage4-plan.md`). Исполнитель их не пересматривает.
- **Предложение** — эквивалент покупки × множитель, не больше потолка:
  - второй шанс и VIP — `starsToGems(charged_stars)` (курс второго шанса
    `CONTINUE_RATE`, 6 самоцветов за 5 ⭐; `payments/continue-price.ts`);
  - набор магазина — его содержимое, `skuById(sku).contents.gems`
    (`shop/shop-catalog.ts`); товара уже нет в каталоге — `starsToGems(charged_stars)`;
  - донат — эквивалента нет, компенсация недоступна (решение тимлида, подтверждено владельцем 12.11.2026, WP53).
  Множитель — ключ `payments.compensation.multiplier` (умолчание 2),
  потолок — `payments.compensation.max-gems` (умолчание 2000). Пример: набор
  `gems_330` → 330 × 2 = 660; VIP за 700 ⭐ → 840 × 2 = 1680.
- **Сумму можно поправить** — от 1 до потолка; больше потолка — отказ.
- **Только самоцветы** (Р2): ресурс один — `gems`.
- **Когда нельзя** (решения тимлида claude-lead-1, WP53), тексты дословно:
  - оплата не записана (`paid_at` пусто) — «Оплата не записана — сначала
    «Повторить учёт»»;
  - донат — «Донат не компенсируется: у него нет игровой ценности. Повторите
    учёт — знак мецената встанет сам»;
  - тестовая оплата (`mode = test`), кроме входа разработчика — «Тестовая
    оплата — компенсировать нечего»;
  - своя покупка, кроме входа разработчика — «Компенсировать свою покупку
    нельзя»;
  - уже начислена — «За эту покупку компенсация уже начислена».
  Возвращённая покупка компенсироваться **может**.
- **Одна на покупку — ключом в базе:** таблица `purchase_compensation` с
  первичным ключом `purchase_id`. Начисление — `WalletService.grant` с
  ключом идемпотентности `compensation:<purchaseId>` и новой причиной
  обмена `payment_compensation`: тот же журнал кошелька, что у «Кошелёк ±»,
  без суточного потолка (ограничивают право, потолок суммы и одна строка на
  покупку) и без надбавки VIP (надбавка — только у причин заработка).
- **Порядок записи — строка, затем кошелёк, затем отметка:** вставка строки
  (занял покупку) → `grant` → `credited_at`. Упало между — строка есть,
  `credited_at` пусто: повтор действия доначисляет **ту же** сумму из строки
  (ключ кошелька не даст начислить дважды), новая сумма из запроса
  игнорируется. Журнал действий, сообщение команде и игроку — один раз, тем
  вызовом, который поставил `credited_at` (условный `updateMany`).
- **Право** — `payments.compensate` (только владелец; заводит T-0429): и
  предложение, и начисление. Проверка — гвардом и в сервисе.
- **Ручные начисления рядом.** Предложение показывает начисления игроку
  через «Кошелёк ±» (`admin_adjust`, плюс) за 30 суток: владелец мог
  компенсировать 11.11 вручную до этой задачи (WP53).
- **Сообщение в поток «Покупки»** — `emitSupport({ kind: "compensate", gems })`,
  текст готовит T-0429. Сообщение игроку — T-0436 слушает то же событие.

## Как сейчас

- `backend/api/src/modules/wallet/wallet.service.ts:108` — `grant(input:
  GrantInput)`: `accountId`, `resource`, `amount`, `reason`, `source`,
  `idempotencyKey`, `at`; ответ `{ credited, balance, duplicate }`;
  `adjust` (строка ~170) — образец ручной операции с аудитом;
  `recentEntries(accountId, limit)` — `WalletEntryRow` (`reason`, `amount`,
  `resource`, `createdAt`).
- `backend/api/src/modules/wallet/wallet-types.ts:51` — `EXCHANGE_REASONS`;
  `wallet-limits.ts:60–68` — `EXCHANGE_RESOURCES` (у `wipe_compensation` —
  `["gems"]`). Колонка `wallet_entry.reason` — `VARCHAR(32)`.
- `backend/api/src/modules/wallet/wallet.module.ts` — импортирует только
  `AuthModule`, экспортирует `WalletService`: в `PaymentsModule` его можно
  подключить без цикла.
- `backend/api/src/modules/payments/continue-price.ts:41` — `starsToGems`.
- `backend/api/src/modules/shop/shop-catalog.ts:113` — `skuById(id)`, чистый
  файл без Nest.
- `backend/api/src/modules/settings/setting-catalog.ts:177` —
  `integer(key, group, title, hint, range, fallback)`; чтение —
  `settings.get(SETTINGS.<имя>)` через `SETTINGS_READER`.
- `packages/app-shell/src/i18n/ru-history.json` — подписи причин журнала
  кошелька в истории игрока (`history.reason.<причина>`); без подписи
  история покажет «Другое».
- После T-0429: `payment-feed-sources.ts` (`register`), вид хронологии
  `compensated`, пометка `compensated`, действие `compensate`,
  `SupportAction.gems`, право `payments.compensate`.
- Образец ручек — `admin/admin-purchases.controller.ts`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Кошелёк.** `wallet-types.ts`: в `EXCHANGE_REASONS` — `"payment_compensation"`,
   в комментарии над списком — «…и компенсация за сбой оплаты (Р209): ценность
   — уплаченные звёзды, сумму ограничивают право, потолок и одна строка на
   покупку». `wallet-limits.ts`: `payment_compensation: ["gems"]` с
   комментарием «только самоцветы (Р2)».
3. **Схема и миграция** — блоком в конце `schema.prisma` с заголовком
   «Компенсация за сбой оплаты (Р209)», связь в `model Purchase` — одной
   строкой `compensation PurchaseCompensation?`:

   ```prisma
   model PurchaseCompensation {
     /// одна компенсация на покупку — первичным ключом
     purchaseId     String    @id @map("purchase_id") @db.Uuid
     accountId      String    @map("account_id") @db.Uuid
     /// пока только gems (Р2)
     resource       String    @db.VarChar(32)
     amount         Int
     /// что предложила панель: по разнице видно, правили ли сумму
     suggested      Int?
     note           String    @db.VarChar(200)
     actorAccountId String    @map("actor_account_id") @db.Uuid
     createdAt      DateTime  @map("created_at") @db.Timestamptz(3)
     /// когда легло в кошелёк; `null` — начисление не прошло, повтор доделает
     creditedAt     DateTime? @map("credited_at") @db.Timestamptz(3)

     purchase Purchase @relation(fields: [purchaseId], references: [purchaseId], onDelete: Restrict)

     @@index([createdAt])
     @@map("purchase_compensation")
   }
   ```

   Миграция — по строке «миграции» раздела «Общие файлы» `tasks/README.md`,
   имя `…_purchase_compensation`. `wipe-plan.ts`: `PurchaseCompensation:
   keep("компенсации за сбой оплаты — история денег, как покупки")`, счётчик
   моделей в тесте +1.
4. **`setting-catalog.ts`** — новая группа `const PAYMENTS_GROUP = "Платежи";`
   и два ключа:
   - `paymentsCompensationMultiplier: integer("payments.compensation.multiplier",
     PAYMENTS_GROUP, "Множитель компенсации", "Во сколько раз панель
     предлагает больше эквивалента покупки при компенсации за сбой оплаты.
     Сумму в окне можно поправить", { min: 1, max: 5, unit: ["раз", "раза",
     "раз"] }, 2)`;
   - `paymentsCompensationMaxGems: integer("payments.compensation.max-gems",
     PAYMENTS_GROUP, "Потолок компенсации, самоцветы", "Больше за одну
     покупку начислить нельзя — ни предложением, ни вручную в окне", { min: 1,
     max: 20_000, unit: ["самоцвет", "самоцвета", "самоцветов"] }, 2_000)`.
5. **`purchase-compensation-rules.ts`** — чистые правила:

   ```ts
   export const COMPENSATION_RESOURCE = "gems" satisfies WalletResource;
   export const COMPENSATION_REASON = "payment_compensation" satisfies ExchangeReason;
   export const MANUAL_LOOKBACK_DAYS = 30;
   /** Эквивалент покупки в самоцветах; донат — null. */
   export function equivalentGems(purchase: Pick<StoredPurchase, "product" | "sku" | "chargedStars">): number | null;
   /** min(эквивалент × множитель, потолок); эквивалента нет — null. */
   export function suggestedGems(equivalent: number | null, multiplier: number, maxGems: number): number | null;
   /** Почему компенсировать нельзя — текст из «Решений»; `null` — можно. Порядок проверок — как в списке «Решений». */
   export function compensationBlock(
     purchase: Pick<StoredPurchase, "paidAt" | "product" | "mode" | "accountId">,
     context: { devLogin: boolean; actorAccountId: string | null; credited: boolean },
   ): string | null;
   /** Ключ кошелька: одна компенсация на покупку. */
   export function compensationKey(purchaseId: string): string; // `compensation:${purchaseId}`
   ```

   `actorAccountId: null` — проверка своей покупки пропускается (источник
   ленты зовёт без актёра, сервис — с ним).
6. **`purchase-compensation.repository.ts`** — `PURCHASE_COMPENSATION_REPOSITORY`,
   `PrismaPurchaseCompensationRepository`:
   - `insert(row): Promise<"inserted" | "exists">` — нарушение уникальности
     → `exists`;
   - `byPurchase(id)`, `byPurchases(ids)`;
   - `markCredited(purchaseId, at): Promise<boolean>` — `updateMany` с
     `creditedAt: null`.
7. **`purchase-compensation.ts`** — `PurchaseCompensations` (`OnModuleInit`;
   зависимости: `APP_CONFIG`, `PURCHASES_REPOSITORY`, репозиторий
   компенсаций, `WalletService`, `SETTINGS_READER`, `RolesService`,
   `ACCOUNT_REPOSITORY`, `PaymentsHooks`, `PaymentFeedSources`):
   - `preview(actor, purchaseId, now): Promise<CompensationPreview>` —
     `payments.compensate`; покупки нет — `PurchaseNotFoundError`;
   - `compensate(actor, purchaseId, input: { gems: number; note: string }, now): Promise<CompensationResult>`
     — `payments.compensate` → покупка → строка (если есть) →
     `compensationBlock` (отказ — `PurchaseActionUnavailableError` с текстом;
     своя покупка — `ForbiddenError`) → строки нет: `gems` больше потолка —
     `ValidationError` «Больше потолка: N самоцветов — его меняют в
     «Настройках», ключ «Потолок компенсации»»; вставка строки (`exists` —
     перечитать и идти как «строка есть») → строка есть и `creditedAt` пусто
     — доначисление её суммы → `wallet.grant({ accountId, resource: "gems",
     amount: row.amount, reason: "payment_compensation", source:
     "admin:<actorId>", idempotencyKey: compensationKey(id), at: now })` →
     `markCredited`; поставил отметку этот вызов — журнал
     `payments.compensate` (`target` — аккаунт, `after: { purchaseId, gems,
     suggested, note }`), `emitSupport({ kind: "compensate", purchase,
     actorName, note, at, gems })`, строка лога `purchase_compensated`
     (`purchaseId`, `accountId`, `gems`, `suggested`, `actorAccountId`).
   - `onModuleInit` — `sources.register("compensation", …)`: `timeline` —
     начисленная: строка `compensated` во время `creditedAt` «Компенсация: N
     самоцветов — <note>» с именем актёра; записанная без начисления — во
     время `createdAt` «Компенсация записана, но не начислена — нажмите
     «Компенсировать» ещё раз»; `marks` — `compensated` у начисленных;
     `actions` — `["compensate"]`, если `compensationBlock(purchase,
     { devLogin, actorAccountId: null, credited })` пуст.

   ```ts
   export interface CompensationPreview {
     purchaseId: string;
     /** `null` — можно; иначе — почему нельзя, текстом из «Решений» */
     blockedReason: string | null;
     chargedStars: number;
     equivalentGems: number | null;
     multiplier: number;
     suggestedGems: number | null;
     maxGems: number;
     existing: { gems: number; suggested: number | null; note: string; actorName: string | null; createdAt: Date; credited: boolean } | null;
     /** «Кошелёк ±» игроку в плюс за 30 суток — чтобы не начислить дважды */
     recentManual: { at: Date; resource: WalletResource; amount: number }[];
   }
   export interface CompensationResult { purchaseId: string; gems: number; balance: number; repaired: boolean }
   ```

   `repaired: true` — доначислена ранее записанная строка (сумма из неё).
   `recentManual` — `wallet.recentEntries(accountId, 100)`, причина
   `admin_adjust`, `amount > 0`, не старше 30 суток.
8. **`admin/admin-payment-compensation.controller.ts`** —
   `@Controller("admin/payments")`, гварды как у `AdminPurchasesController`:
   - `GET :purchaseId/compensation` — `payments.compensate`;
   - `POST :purchaseId/compensate`, `@HttpCode(200)` — `payments.compensate`,
     лимит `ADMIN_LIMITS.mutate`; тело — `z.strictObject({ gems:
     z.number().int().min(1).max(20_000), note: z.string().trim().min(3).max(200) })`,
     ошибка — «Укажите сумму от 1 самоцвета и причину от 3 до 200 символов».
   Контроллер — в `admin.module.ts`.
9. **`payments.module.ts`** — `WalletModule` в `imports`;
   `PurchaseCompensations` и репозиторий в `providers`,
   `PurchaseCompensations` в `exports`.
10. **История игрока** — `ru-history.json`: `"history.reason.payment_compensation":
    "Компенсация за сбой оплаты"`.
11. **Журнал в панели** — `apps/admin/src/api/audit.ts`:
    `"payments.compensate": "Компенсация за сбой оплаты"`; строка в тесте.
12. **Документы** — раздел «Документы».

## Чего не трогаем

- `WalletService.adjust` и «Кошелёк ±» — остаются как есть.
- `purchase-support.ts` и возврат звёзд.
- Сообщение игроку — T-0436; окно в панели — T-0438.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/purchase-compensation.test.ts` — правила и сервис с
  подставными репозиториями, кошельком и ролями:
  - `equivalentGems`: второй шанс 10 ⭐ → 12; VIP 700 ⭐ → 840; `gems_330` →
    330; набор, которого нет в каталоге, за 50 ⭐ → 60; донат → `null`;
  - `suggestedGems(840, 2, 2000)` → 1680; `(1400, 2, 2000)` → 2000;
    `(null, 2, 2000)` → `null`;
  - `compensationBlock` — каждый текст из «Решений» дословно и порядок
    проверок; тестовая оплата и своя покупка с `devLogin: true` → `null`;
    возвращённая покупка → `null`;
  - `compensate`: удача → `grant` с ключом `compensation:<id>`, причиной
    `payment_compensation`, ресурсом `gems`; журнал `payments.compensate`;
    `emitSupport` с `gems`;
  - вторая компенсация после начисленной → `409` «За эту покупку
    компенсация уже начислена», `grant` не вызван;
  - `grant` бросил → строка есть без `creditedAt`; повтор с другой суммой →
    `grant` с **суммой строки**, `repaired: true`, журнал и `emitSupport` —
    один раз за обе попытки;
  - `gems` больше потолка → `ValidationError` с текстом из шага 7; ровно
    потолок — проходит;
  - без `payments.compensate` → `ForbiddenError`; своя покупка →
    `ForbiddenError` «Компенсировать свою покупку нельзя»;
  - `preview`: множитель и потолок из настроек; `recentManual` берёт
    `admin_adjust` в плюс за 30 суток и не берёт списания и старые;
  - источник ленты: пометка `compensated` только у начисленных; действие
    `compensate` пропадает после начисления.
- `backend/api/test/purchase-compensation.integration.test.ts` — живой
  Postgres: две одновременные компенсации одной покупки → одна строка,
  одна строка журнала кошелька, баланс вырос один раз; `insert` второй
  строки → `exists`.
- `backend/api/test/wipe-plan.test.ts` — счётчик моделей.
- `apps/admin/test/audit.test.ts` — подпись `payments.compensate`.

## Аналитика

Нет событий словаря (WP53, «Аналитика»): факт — строка
`purchase_compensation` и журнал кошелька с причиной `payment_compensation`,
в лог — `purchase_compensated`.

## Настройки и окружение

- `payments.compensation.multiplier` — 1–5, умолчание 2.
- `payments.compensation.max-gems` — 1–20 000, умолчание 2000.
- Переменных окружения нет.

## Документы

- `docs/21-diagrams.md`: в §1.1 — `PURCHASE_COMPENSATION` в конец блока
  `erDiagram` и связь `PURCHASE ||--o| PURCHASE_COMPENSATION`; новый поток
  **§4.39 «Компенсация за сбой оплаты (этап 4)»** — панель → право →
  строка → кошелёк → отметка → журнал, поток «Покупки», сообщение игроку.
- `docs/22-analytics-and-metrics.md` §5.4 — абзац: компенсации — таблица
  `purchase_compensation` и журнал кошелька с причиной `payment_compensation`
  (Р209); в выручку не входят, событий нет.
- `docs/29-admin-panel.md` §2, строка «Платежи» — «…«Компенсировать»
  самоцветами: предложение — эквивалент × множитель, одна на покупку (Р209)».
- `docs/30-configuration-map.md` — два ключа группы «Платежи».

## Критерии приёмки

- [ ] Предложение — эквивалент × множитель, не больше потолка, по правилам
      «Решений»; донат и незаписанная оплата — недоступны с текстом.
- [ ] Компенсация начисляет самоцветы один раз на покупку — и при двойном
      нажатии, и при повторе после сбоя кошелька.
- [ ] Журнал действий, поток «Покупки» и история игрока («Компенсация за
      сбой оплаты») — по одному разу.
- [ ] Право — только `payments.compensate`; своя покупка — отказ.
- [ ] Миграция только добавляет таблицу; план вайпа — `keep`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(payments): Компенсация самоцветами за сбой оплаты`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КОМПЕНСАЦИЯ САМОЦВЕТАМИ ЗА СБОЙ ОПЛАТЫ**

  Сервер умеет компенсировать сбой оплаты самоцветами из карточки платежа: предлагает эквивалент покупки × 2, сумму можно поправить, одна компенсация на покупку. Окно в панели — T-0438.

  🛠 **Настройки**

  • «Множитель компенсации» (2) и «Потолок компенсации» (2000 самоцветов) — в «Настройках», группа «Платежи»
  • право компенсировать — только у владельца
  ```
