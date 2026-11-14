---
id: T-0433
title: Сверка оплат с выпиской площадки — таблицы, расписание, сообщение команде
epic: E1
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: [T-0429, T-0432]
zones:
  - backend/api/src/modules/payments/payment-reconcile.ts
  - backend/api/src/modules/payments/payment-reconcile.repository.ts
  - backend/api/src/modules/payments/payment-reconciler.ts
  - backend/api/src/modules/admin/admin-payment-reconcile.controller.ts
  - backend/api/src/modules/admin-notify/reconcile-alert-notifier.ts
  - backend/api/test/payment-reconcile.test.ts
  - backend/api/test/payment-reconciler.test.ts
  - backend/api/test/payment-reconcile.integration.test.ts
  - backend/api/test/reconcile-alert-notifier.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/wipe/wipe-plan.ts
  - backend/api/test/wipe-plan.test.ts
  - backend/api/test/player-address.test.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/payments/payments-hooks.ts
  - backend/api/src/modules/payments/payments.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - backend/api/src/modules/admin/admin-limits.ts
  - backend/api/src/modules/admin-notify/admin-notify.module.ts
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

# T-0433. Сверка оплат с выпиской площадки — таблицы, расписание, сообщение команде

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0433.json)](../README.md#значки-статуса) [![T-0429](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0429.json&label=T-0429)](T-0429-payments-feed-server.md) [![T-0432](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0432.json&label=T-0432)](T-0432-payment-statement-port.md)

## Зачем

11.11.2026 звёзды списались, а покупки не записались, — и узнали об этом по
сообщению о брошенном задании. Если бы сообщения не было, сбой нашёл бы
только игрок. После задачи сервер раз в сутки (и по кнопке) сверяет выписку
звёзд бота с покупками и записывает расхождения трёх видов; о новых
расхождениях команда узнаёт сообщением в поток «Покупки». Действия по
расхождениям — T-0434, экран — T-0438.

## Решения

- **Р209, WP53** (`docs/35-stage4-plan.md`). Исполнитель их не пересматривает.
- **Три вида расхождений** (`kind`):

  | Вид | Когда | Подпись для команды |
  |---|---|---|
  | `charged_unrecorded` | в выписке оплата игрока (`kind = payment`), а покупки с этим `telegram_charge_id` нет | «Списано, но не записано» |
  | `recorded_missing` | у нас оплаченная покупка с `telegram_charge_id`, её время оплаты внутри прочитанного отрезка выписки, а оплаты с этим id в нём нет | «Записано, но нет в выписке» |
  | `refund_unrecorded` | в выписке возврат (`kind = refund`) по оплате нашей покупки, а у покупки `refunded_at` пусто | «Возврат в Telegram, но не у нас» |

  Возврат по оплате, которой у нас нет (лишняя или чужая оплата, мы её сами
  вернули), — не расхождение. Прочие операции выписки (`other`) не
  сверяются.
- **Окно свежести** — 15 минут: оплата или возврат моложе не сверяются,
  очередь оплаты могла ещё не записать их.
- **Курсор — позиция в выписке.** Выписка идёт от старых к новым, позиции не
  сдвигаются. Сверка начинает с `to_offset` прошлой удачной сверки площадки
  минус 100 (перекрытие — запас на границе) и читает страницы по 100, пока
  страница не короче 100 или не прочитано 100 страниц (10 000 операций); с
  первого раза — с нуля, сколько успеет, дальше — со следующей сверкой.
- **«Записано, но нет в выписке» — только внутри отрезка:** время оплаты
  покупки не раньше времени первой прочитанной операции **плюс 30 минут**
  (запас: покупка у границы могла быть оплачена чуть раньше её) и не позже
  последней. Покупка, оплата которой записана повтором много позже самой
  оплаты (так было 11.11: время оплаты — время повтора), может дать ложное
  расхождение — его закрывают «Разобрано» (T-0434). Решение тимлида
  claude-lead-1, 11.11.2026: лишнее расхождение дешевле пропущенного.
- **Одно расхождение — одна строка навсегда:** уникальный ключ
  `(platform, kind, charge_id)`; повторная находка ничего не добавляет и
  сообщения не шлёт.
- **Само закрывается** (`resolution = matched`), если при следующей сверке
  условие пропало: оплата записалась, возврат отмечен, оплата нашлась в
  выписке.
- **Расписание:** тик раз в час, первый — через 5 минут после старта;
  сверка идёт, если последняя удачная по площадке была больше 23 часов
  назад. Под распределённым локом Redis `payments:reconcile:lock` (`SET NX
  PX`, 15 минут, снятие — скриптом по своему токену, как в
  `fulfillment-sweeper.ts`): при нескольких репликах сверяет одна.
- **Кнопка «Сверить сейчас»** — та же сверка сразу, синхронно в запросе;
  идёт сверка — `409` «Сверка уже идёт — подождите минуту». Лимит — 3 за 10
  минут на человека (`ADMIN_LIMITS.reconcile`).
- **Выключатель** — ключ `payments.reconcile` (булев, умолчание — включено)
  в группе «Функции сервера». Выключен — расписание молчит, кнопка отвечает
  `409` «Сверка выключена в настройках». Ключа площадки нет: это токен бота
  (Р53).
- **Права:** обзор — `payments.view`; «Сверить сейчас» — `payments.support`.
- **Сообщение команде** — одно на сверку, нашедшую **новые** расхождения;
  текст в шаге 7 дословно.
- **Модели — в плане вайпа `keep`:** это история денег.

## Как сейчас

- После T-0432: `platforms/ports/payment-statement.ts` — `PaymentStatements`,
  `StatementEntry`; провайдер в `PlatformsModule` (подключён к
  `PaymentsModule` так же, как `PaymentProviders`).
- `backend/api/src/modules/payments/fulfillment-sweeper.ts` — образец
  таймера, лока и снятия лока (`RELEASE_SCRIPT`), проверки `queue.enabled`.
- `backend/api/prisma/schema.prisma` — `model Purchase`: `telegramChargeId`
  (уникальный, 256 знаков после #731), `paidAt`, `refundedAt`; аккаунт —
  `account.platform`.
- `backend/api/src/modules/settings/setting-catalog.ts` — `feature(key,
  title, hint, env, fallback)` (строка ~191), группа `FEATURES_GROUP`;
  чтение — `settings.get(SETTINGS.<имя>)` через `SETTINGS_READER`.
- `backend/api/src/modules/admin-notify/payments-alert-notifier.ts` —
  образец отправки в поток «Покупки»: `NotifyTargets.chats().payments`,
  `TelegramBotApi.sendMessage`, проверка токена бота в `onModuleInit`.
- `backend/api/src/modules/admin/admin-limits.ts` — `ADMIN_LIMITS`.
- `backend/api/src/modules/wipe/wipe-plan.ts` — `WIPE_PLAN`, счётчик моделей в
  `test/wipe-plan.test.ts`.
- После T-0429: право `payments.view`, `PaymentFeedSources` (источник
  расхождений заводит T-0434, не эта задача).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Схема и миграция** — блоком в конце `schema.prisma` с
   комментарием-заголовком «Сверка оплат с выпиской площадки (Р209)»:

   ```prisma
   model PaymentReconcileRun {
     runId          String    @id @map("run_id") @db.Uuid
     platform       String    @db.VarChar(16)
     /// schedule — по расписанию, manual — кнопкой
     trigger        String    @db.VarChar(16)
     actorAccountId String?   @map("actor_account_id") @db.Uuid
     startedAt      DateTime  @map("started_at") @db.Timestamptz(3)
     /// `null` — сверка оборвалась, не дойдя до конца
     finishedAt     DateTime? @map("finished_at") @db.Timestamptz(3)
     /// позиция выписки, с которой читали, и та, до которой дочитали
     fromOffset     Int       @map("from_offset")
     toOffset       Int?      @map("to_offset")
     /// время первой и последней прочитанной операции
     coveredFrom    DateTime? @map("covered_from") @db.Timestamptz(3)
     coveredTo      DateTime? @map("covered_to") @db.Timestamptz(3)
     scanned        Int       @default(0)
     /// новых расхождений
     found          Int       @default(0)
     /// закрыто само (`matched`)
     matched        Int       @default(0)
     /// ошибка площадки или базы — первые 300 знаков
     error          String?   @db.VarChar(300)

     @@index([platform, finishedAt])
     @@map("payment_reconcile_run")
   }

   model PaymentDiscrepancy {
     discrepancyId String    @id @map("discrepancy_id") @db.Uuid
     platform      String    @db.VarChar(16)
     /// charged_unrecorded | recorded_missing | refund_unrecorded
     kind          String    @db.VarChar(32)
     chargeId      String    @map("charge_id") @db.VarChar(256)
     /// покупка: по payload у «списано, но не записано», по оплате — у остальных; нет — null
     purchaseId    String?   @map("purchase_id") @db.Uuid
     accountId     String?   @map("account_id") @db.Uuid
     /// игрок на площадке из выписки; у «записано, но нет» — null
     payerId       String?   @map("payer_id") @db.VarChar(64)
     amount        Int
     /// что стояло в счёте — как пришло из выписки, до 128 знаков
     payload       String?   @db.VarChar(128)
     /// когда случилась операция выписки или записана оплата
     occurredAt    DateTime  @map("occurred_at") @db.Timestamptz(3)
     detectedAt    DateTime  @map("detected_at") @db.Timestamptz(3)
     runId         String    @map("run_id") @db.Uuid
     resolvedAt    DateTime? @map("resolved_at") @db.Timestamptz(3)
     /// matched | retried | refunded | dismissed
     resolution    String?   @db.VarChar(16)
     resolvedBy    String?   @map("resolved_by") @db.Uuid
     note          String?   @db.VarChar(200)

     @@unique([platform, kind, chargeId])
     @@index([resolvedAt, detectedAt])
     @@index([purchaseId])
     @@map("payment_discrepancy")
   }
   ```

   Внешних ключей нет: покупки у «списано, но не записано» может не быть, а
   аккаунт — только для показа. Миграция — по строке «миграции» раздела
   «Общие файлы» `tasks/README.md`, имя `…_payment_reconcile`. В
   `wipe-plan.ts` — `PaymentReconcileRun: keep("сверки с выпиской площадки —
   история денег")`, `PaymentDiscrepancy: keep("расхождения сверки и их
   разбор — история денег")`, счётчик моделей в тесте +2.
3. **`payment-reconcile.ts`** — чистые правила, без Nest и Prisma:

   ```ts
   export const DISCREPANCY_KINDS = ["charged_unrecorded", "recorded_missing", "refund_unrecorded"] as const;
   export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];
   export const DISCREPANCY_RESOLUTIONS = ["matched", "retried", "refunded", "dismissed"] as const;
   export type DiscrepancyResolution = (typeof DISCREPANCY_RESOLUTIONS)[number];
   export const RECONCILE = {
     pageSize: 100, maxPages: 100, overlap: 100,
     graceMs: 15 * 60_000, edgeMs: 30 * 60_000,
     minIntervalMs: 23 * 3_600_000, tickMs: 3_600_000, firstTickMs: 5 * 60_000,
     lockTtlMs: 15 * 60_000, pageTimeoutMs: 20_000,
   } as const;
   export interface KnownPurchase { purchaseId: string; accountId: string; chargeId: string; chargedStars: number; paidAt: Date; refundedAt: Date | null }
   export interface FoundDiscrepancy {
     kind: DiscrepancyKind; chargeId: string; purchaseId: string | null; accountId: string | null;
     payerId: string | null; amount: number; payload: string | null; occurredAt: Date;
   }
   export interface CompareInput {
     /** прочитанная выписка, от старых к новым */
     entries: readonly StatementEntry[];
     /** наши покупки с оплатами из выписки — по идентификатору оплаты */
     byCharge: ReadonlyMap<string, KnownPurchase>;
     /** покупки по `payload` оплат, которых нет в `byCharge`, — чтобы назвать игрока */
     byPayload: ReadonlyMap<string, { purchaseId: string; accountId: string }>;
     /** наши оплаты площадки с `paid_at` внутри [первая операция + edgeMs, последняя операция] */
     paidInWindow: readonly KnownPurchase[];
     now: Date;
   }
   export function compare(input: CompareInput): FoundDiscrepancy[];
   /** Отрезок, внутри которого ищутся «записано, но нет»; пустая выписка — `null`. */
   export function windowOf(entries: readonly StatementEntry[]): { from: Date; to: Date } | null;
   /** С какой позиции читать: прошлой удачной нет — 0; иначе её `toOffset` минус перекрытие, не меньше 0. */
   export function startOffset(lastToOffset: number | null): number;
   /** Пора ли сверять по расписанию. */
   export function due(lastFinishedAt: Date | null, now: Date): boolean;
   /**
    * Какие открытые расхождения закрылись сами («Само закрывается»): `charged_unrecorded` —
    * id оплаты теперь у покупки; `refund_unrecorded` — у покупки отмечен возврат;
    * `recorded_missing` — оплата нашлась среди оплат прочитанной выписки. Ответ — их id.
    */
   export function settled(
     open: readonly { discrepancyId: string; kind: DiscrepancyKind; chargeId: string }[],
     seen: { recordedCharges: ReadonlySet<string>; refundedCharges: ReadonlySet<string>; statementPayments: ReadonlySet<string> },
   ): string[];
   ```

   `compare` — по таблице «Решений» с окном свежести `graceMs`; у
   `recorded_missing` — `amount = chargedStars`, `occurredAt = paidAt`,
   `payerId = null`; у остальных — `amount`, `occurredAt`, `payerId`,
   `payload` из операции выписки (payload обрезается до 128). Повтор одного
   id в выписке — одна находка.
4. **`payment-reconcile.repository.ts`** — `PAYMENT_RECONCILE_REPOSITORY`,
   `PrismaPaymentReconcileRepository`:
   - `lastFinished(platform)` — последняя сверка с `finished_at` не пусто и
     без `error`: `{ toOffset, finishedAt }` или `null`;
   - `startRun(…)`, `finishRun(runId, …)`;
   - `purchasesByCharges(ids)` — `KnownPurchase[]`; `purchasesByIds(ids)`;
   - `paidInWindow(platform, from, to)` — оплаченные покупки аккаунтов
     площадки (`account: { platform }`) с `telegram_charge_id` и `paid_at` в
     отрезке;
   - `insertFound(runId, platform, found, at)` — `createMany({ skipDuplicates: true })`,
     ответ — сколько вставлено (новые) и их виды;
   - `open(platform)` — открытые расхождения площадки;
   - `resolveMatched(ids, at)` — `updateMany` `resolvedAt: null` →
     `resolution: "matched"`; ответ — сколько закрыто;
   - `overview()` — последняя сверка каждой площадки (удачная или нет),
     открытые расхождения (все) и закрытые за 30 суток (до 100), свежие
     первыми.
5. **`payment-reconciler.ts`** — `PaymentReconciler` (`OnApplicationBootstrap`,
   `OnModuleDestroy`; зависимости: `APP_CONFIG`, `PaymentStatements`,
   репозиторий, `REDIS`, `SETTINGS_READER`, `PaymentsHooks`, `RolesService`,
   `ACCOUNT_REPOSITORY`):
   - таймер — только при `config.auth.enabled` и непустом
     `statements.list()`; первый тик через `firstTickMs`, дальше `tickMs`;
   - `tick(now)` — выключатель выключен → ничего; иначе по каждой площадке,
     для которой `due(lastFinished)`, — `run`;
   - `run(trigger, actorAccountId, now)` — лок; по каждой площадке: строка
     сверки, страницы `statement.page(offset, pageSize)` под
     `withTimeout(…, pageTimeoutMs)`, пока страница полная и страниц меньше
     `maxPages`; открытые расхождения площадки и их покупки
     (`purchasesByCharges`) — для `settled`; ошибка площадки — строка сверки с `error`, `toOffset` не
     пишется (следующая начнёт с того же места), остальные площадки
     продолжают; затем `compare`, `insertFound`, закрытие сошедшихся,
     `finishRun`; строка лога `reconcile_finished` (`platform`, `trigger`,
     `fromOffset`, `toOffset`, `scanned`, `found`, `matched`, `open`), у
     каждой новой — `discrepancy_found` (`kind`, `chargeId`, `purchaseId`);
     новые есть — `hooks.emitReconcileFound(…)`;
   - `runNow(actor, now)` — `payments.support`; выключатель выключен —
     `PurchaseActionUnavailableError` «Сверка выключена в настройках»; лок
     занят — та же ошибка «Сверка уже идёт — подождите минуту»; журнал
     `payments.reconcile.run` (`after: { scanned, found, matched }`);
     ответ — итог по площадкам;
   - `overview(actor)` — `payments.view`; имена игроков — одним
     `accounts.displayNames`.

   ```ts
   export interface ReconcileSummary { platform: PlatformId; scanned: number; found: number; matched: number; open: number; error: string | null }
   export interface DiscrepancyView {
     discrepancyId: string; platform: PlatformId; kind: DiscrepancyKind; chargeId: string;
     purchaseId: string | null; accountId: string | null; displayName: string | null;
     payerId: string | null; amount: number; payload: string | null;
     occurredAt: Date; detectedAt: Date;
     resolution: DiscrepancyResolution | null; resolvedAt: Date | null; resolvedByName: string | null; note: string | null;
   }
   export interface ReconcileOverview {
     enabled: boolean;
     lastRuns: { platform: PlatformId; trigger: string; startedAt: Date; finishedAt: Date | null; scanned: number; found: number; error: string | null }[];
     open: DiscrepancyView[];
     resolved: DiscrepancyView[];
   }
   ```

   Строки из базы (`kind`, `resolution`, `platform`) — разбор схемой Zod;
   незнакомое значение — строка пропускается с `warn`, а не падение обзора.
6. **`payments-hooks.ts`** — своим блоком:

   ```ts
   /** Сверка нашла новые расхождения (Р209). */
   export interface ReconcileFound { platform: PlatformId; found: number; open: number; kinds: Partial<Record<DiscrepancyKind, number>>; at: Date }
   onReconcileFound(name: string, listener: (event: ReconcileFound) => Promise<void>): void;
   emitReconcileFound(event: ReconcileFound): Promise<void>;
   ```
7. **`admin-notify/reconcile-alert-notifier.ts`** — `ReconcileAlertNotifier`
   по образцу `PaymentsAlertNotifier` (без токена бота — не подписывается;
   нет чата — `warn`; сбой отправки — `warn`, не исключение; без
   дедупликации — одно на сверку). Текст — функция `reconcileAlertText`,
   дословно, строки видов — только ненулевые, в этом порядке:

   ```
   🧾 Сверка с Telegram: новых расхождений — 3
   Списано, но не записано: 2
   Записано, но нет в выписке: 1
   Возврат в Telegram, но не у нас: 0
   Открытых всего: 4
   Разобрать: панель → «Платежи» → «Расхождения».
   ```

   Имя площадки: `telegram` — «Telegram», `max` — «MAX», `vk` — «VK», `web` —
   «веб». Провайдер — в `admin-notify.module.ts`.
8. **`setting-catalog.ts`** — в группу «Функции сервера»:
   `paymentsReconcile: feature("payments.reconcile", "Сверка оплат с
   площадкой", "Раз в сутки сверяет выписку звёзд бота с покупками и
   сообщает о расхождениях в поток «Покупки». Выключено — молчит расписание
   и кнопка «Сверить сейчас»", () => null, true)`.
9. **`admin-limits.ts`** — `reconcile: { scope: "admin:payments-reconcile",
   limit: 3, windowSec: 600 }` с комментарием «сверка читает выписку
   площадки страницами — три раза за десять минут хватит».
10. **`admin/admin-payment-reconcile.controller.ts`** —
    `@Controller("admin/payment-reconcile")`, гварды как у
    `AdminPurchasesController`:
    - `GET /` — `payments.view` → `ReconcileOverview`;
    - `POST run`, `@HttpCode(200)` — `payments.support`, лимит
      `ADMIN_LIMITS.reconcile` («Слишком много сверок — подождите
      несколько минут») → `{ data: ReconcileSummary[] }`.
    Контроллер — в `admin.module.ts`.
11. **`payments.module.ts`** — `PaymentReconciler` и репозиторий в
    `providers`, `PaymentReconciler` и `PAYMENT_RECONCILE_REPOSITORY` в
    `exports` (контроллер — в `AdminModule`, действия T-0434 — в этом же
    модуле); `PlatformsModule` в `imports`, если `PaymentStatements` не
    приходит туда иначе.
12. **Журнал в панели** — `apps/admin/src/api/audit.ts`:
    `"payments.reconcile.run": "Сверка оплат вручную"`; строка в тесте.
13. **Документы** — раздел «Документы».

## Чего не трогаем

- Действия по расхождениям, «Повторить учёт» по выписке, источник
  хронологии — T-0434. Экран — T-0438.
- Очередь оплаты и запись оплаты — сверка только читает и записывает
  расхождения.
- `payments-alert-notifier.ts` — своё сообщение своим классом.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/payment-reconcile.test.ts` — правила:
  - оплата из выписки без покупки, старше 15 минут, `payload` — id
    существующей неоплаченной покупки → `charged_unrecorded` с `purchaseId`
    и `accountId`; та же оплата моложе 15 минут → ничего; `payload` чужой →
    `purchaseId: null`;
  - возврат по оплате нашей покупки с пустым `refundedAt` →
    `refund_unrecorded`; с заполненным → ничего; возврат по неизвестной
    оплате → ничего;
  - оплаченная покупка внутри окна без оплаты в выписке → `recorded_missing`
    с `amount = chargedStars`; на 10 минут позже первой операции (внутри
    запаса 30 минут) → ничего; позже последней операции → ничего;
  - операции `other` → ничего; повтор одного id → одна находка;
  - `startOffset(null)` → 0; `startOffset(250)` → 150; `startOffset(40)` → 0;
  - `due`: `null` → `true`; 22 часа назад → `false`; 24 часа → `true`;
  - `settled`: записанная оплата, отмеченный возврат, найденная в выписке
    оплата — закрываются; остальные — нет.
- `backend/api/test/payment-reconciler.test.ts` — сервис с подставными
  выпиской, репозиторием и Redis:
  - выписка из 250 операций → три страницы (100, 100, 50), `toOffset = 250`;
  - прошлая удачная с `toOffset = 250` → чтение с 150;
  - вторая страница бросает → строка сверки с `error`, без `toOffset`,
    сообщения нет; следующий `run` начинает с той же позиции;
  - лок занят → `run` по расписанию — ничего, `runNow` → `409` «Сверка уже
    идёт — подождите минуту»;
  - выключатель выключен → `tick` молчит, `runNow` → `409` «Сверка выключена
    в настройках»;
  - новые расхождения → `emitReconcileFound` один раз с видами; те же при
    второй сверке → не новые, сообщения нет;
  - `runNow` без `payments.support` → `ForbiddenError`; удача — запись
    `payments.reconcile.run`;
  - `tick` за 22 часа после удачной → сверки нет.
- `backend/api/test/payment-reconcile.integration.test.ts` — живой Postgres:
  `insertFound` дважды с теми же находками → второй раз вставлено 0;
  `resolveMatched` закрывает только открытые; `paidInWindow` не берёт
  покупки аккаунтов другой площадки и без `telegram_charge_id`; `overview`
  — открытые и закрытые за 30 суток, свежие первыми.
- `backend/api/test/reconcile-alert-notifier.test.ts` — `reconcileAlertText`
  дословно по шагу 7, без строк нулевых видов; нет чата → `warn`, без
  исключения.
- `backend/api/test/wipe-plan.test.ts` — счётчик моделей.

## Аналитика

Нет событий словаря (WP53, «Аналитика»): факты — таблицы
`payment_reconcile_run` и `payment_discrepancy`, в лог — `reconcile_finished`
и `discrepancy_found`. Меток Prometheus нет.

## Настройки и окружение

- `payments.reconcile` — булев, «Функции сервера», умолчание — включено.
- Переменных окружения нет.

## Документы

- `docs/21-diagrams.md`: в §1.1 — сущности `PAYMENT_RECONCILE_RUN` и
  `PAYMENT_DISCREPANCY` в конец блока `erDiagram` (без связей: внешних ключей
  нет); новый поток **§4.38 «Сверка оплат с выпиской площадки (этап 4)»** —
  таймер → лок → страницы выписки → сравнение → расхождения → поток
  «Покупки».
- `docs/22-analytics-and-metrics.md` §5.4 — абзац: расхождения оплат с
  выпиской — таблица `payment_discrepancy`, сверки — `payment_reconcile_run`
  (Р209), событий нет.
- `docs/29-admin-panel.md` §2, строка «Платежи» — «…сверка с выпиской
  площадки раз в сутки и кнопкой, расхождения трёх видов (Р209)».
- `docs/30-configuration-map.md` — строка `payments.reconcile` в таблицу
  настроек сервера.

## Критерии приёмки

- [ ] Раз в сутки и по кнопке сервер читает выписку с курсора и записывает
      расхождения трёх видов по таблице «Решений»; повторная находка — не
      новая строка.
- [ ] Свежее 15 минут не сверяется; сошедшееся закрывается само.
- [ ] Сбой площадки не двигает курсор и не роняет другие площадки.
- [ ] Две реплики не сверяют одновременно; кнопка при идущей сверке — `409`.
- [ ] О новых расхождениях — одно сообщение в поток «Покупки» дословно по
      шагу 7.
- [ ] Миграция только добавляет две таблицы; план вайпа — `keep`.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(payments): Сверка оплат с выпиской площадки`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СВЕРКА ОПЛАТ С ВЫПИСКОЙ ПЛОЩАДКИ**

  Раз в сутки сервер сверяет выписку звёзд бота с покупками и записывает расхождения: «списано, но не записано» (как 11.11), «записано, но нет в выписке», «возврат в Telegram, но не у нас». О новых — сообщение в поток «Покупки».

  🛠 **Поддержка**

  • выключатель — «Сверка оплат с площадкой» в «Настройках» (включена)
  • разбор расхождений и кнопка «Сверить сейчас» в панели — следующими задачами (T-0434, T-0438)
  ```
