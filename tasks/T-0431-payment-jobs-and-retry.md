---
id: T-0431
title: Брошенные задания оплаты и «Повторить учёт» — сервер
epic: E1
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0429]
zones:
  - backend/api/src/modules/payments/payments-queue.ts
  - backend/api/src/modules/payments/payment-jobs.ts
  - backend/api/src/modules/payments/payment-retry.ts
  - backend/api/src/modules/admin/admin-payment-jobs.controller.ts
  - backend/api/test/payments-queue.test.ts
  - backend/api/test/payment-jobs.test.ts
  - backend/api/test/payment-retry.test.ts
shared:
  - backend/api/src/modules/payments/payments-errors.ts
  - backend/api/src/modules/payments/payments.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - apps/admin/src/api/audit.ts
  - apps/admin/test/audit.test.ts
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 4
---

# T-0431. Брошенные задания оплаты и «Повторить учёт» — сервер

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0431.json)](README.md#значки-статуса) [![T-0429](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0429.json&label=T-0429)](archive/T-0429-payments-feed-server.md)

## Зачем

11.11.2026 задания очереди оплаты бросились после десяти попыток, и повторить
их можно было только командой на сервере (`cli/payments-retry-failed.ts`,
#731). После задачи панель видит брошенные задания очереди `payments` и
повторяет их кнопкой — целиком или все задания одной покупки («Повторить
учёт» в карточке платежа). Карточка платежа (T-0429) показывает брошенное
задание строкой хронологии и пометкой в ленте. Экран — T-0437 и T-0438.

## Решения

- **Р209, WP53** (`docs/35-stage4-plan.md`). Исполнитель их не пересматривает.
- **Повтор — тем же, что делает команда:** `job.retry("failed")` целиком.
  Запись оплаты идемпотентна по идентификатору оплаты, выдача — по ключу
  покупки, возврат — по идентификатору оплаты: повтор ничего не удваивает.
- **Свежая серия попыток.** Повтор сбрасывает счётчики попыток
  (`{ resetAttemptsMade: true, resetAttemptsStarted: true }`, BullMQ 6.3.6):
  иначе первая же неудача снова «последняя», и команда получит второе
  сообщение о брошенном задании после одной попытки.
- **Права:** список — `payments.view`; повтор — `payments.support`. Своя
  покупка — отказ «Повторять учёт своей покупки нельзя», кроме входа
  разработчика (`config.auth.devLogin`), как у «Вернуть звёзды».
- **Задание по покупке** — то, у которого:
  `kind = confirm` и `payment.payload` — id покупки; `kind = refund` и
  `order.purchaseId` — id покупки; `kind = refunded` и `chargeId` —
  `telegram_charge_id` покупки (у внешнего возврата покупки в задании нет).
- **Маршруты** — под `admin/payment-jobs` и `POST admin/payments/:id/retry`:
  `GET admin/payments/:purchaseId` (T-0429) перехватил бы `GET
  admin/payments/jobs`.
- **Сверка (T-0434) расширит «Повторить учёт»:** без брошенного задания —
  запись оплаты по выписке площадки. Здесь — только задания; отказ без
  задания говорит, что делать дальше (текст в шаге 4).
- **Сообщение в поток «Покупки»** — `emitSupport` с видом `retry` и `detail`;
  текст готовит T-0429.

## Как сейчас

- `backend/api/src/modules/payments/payments-queue.ts`:
  - `queue: Queue<PaymentsJob> | null` (строка ~74) — `null`, если очередь
    выключена (`enabled`) или ещё не поднята;
  - `JOB_OPTIONS` — `attempts: 10`, `removeOnFail: 1000`;
  - `PaymentsJob` — `confirm` (`payment: ConfirmedPayment`), `refund`
    (`order: RefundOrder`), `refunded` (`chargeId`, `at`);
  - `identify(job)` и `describeJob(job)` в конце файла; `reasonOf`.
- `origin/main` → `backend/api/src/cli/payments-retry-failed.ts` (#731,
  приходит в `dev` синком #732): разбор данных задания Zod-схемой `jobData`
  и первая непустая строка `failedReason` до 120 знаков — образец; файл не
  трогать.
- `backend/api/src/modules/payments/payments-hooks.ts` — `AbandonedJob`,
  `emitSupport` (после T-0429 — с `detail`).
- `backend/api/src/modules/payments/purchase-support.ts` — образец проверки
  своей покупки и ошибок `PurchaseNotFoundError`,
  `PurchaseActionUnavailableError` (`payments-errors.ts`, `409`).
- После T-0429: `PaymentFeedSources.register`, `TimelineEntry` вида
  `job_abandoned`, пометка `job_abandoned`, действие `retry`.
- `backend/api/test/payments-queue.test.ts:44–53` — подмена очереди через
  `Object.assign(queue, { queue: fake })` — тем же приёмом подменяются
  `getFailed` и `getJob`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`payments-queue.ts`** — два метода и тип, остальное не трогать:

   ```ts
   export interface FailedPaymentJob {
     jobId: string;
     kind: "confirm" | "refund" | "refunded" | "unknown";
     chargeId: string | null;
     purchaseId: string | null;
     payerId: string | null;
     /** у подтверждения — сумма оплаты; у возвратов — null */
     amount: number | null;
     /** первая непустая строка причины, до 200 знаков */
     reason: string;
     attempts: number;
     /** когда задание бросилось (`finishedOn`); нет — null */
     failedAt: Date | null;
   }
   /** Брошенные задания, свежие первыми. Очереди нет — `null`. */
   async failedJobs(limit: number): Promise<FailedPaymentJob[] | null>;
   /** Повторить брошенное задание со свежей серией попыток. */
   async retryFailed(jobId: string): Promise<"retried" | "not_found" | "not_failed">;
   ```

   `failedJobs` — `queue.getFailed(0, limit - 1)` под `withTimeout(…, 5_000,
   "брошенные задания оплаты")`; данные задания из Redis — граница: разбор
   Zod-схемой с `.catch`, как `jobData` в команде, незнакомое — `kind:
   "unknown"` и `null` в полях. `retryFailed` — `queue.getJob(jobId)`: нет —
   `not_found`; `await job.getState()` не `failed` — `not_failed`;
   `job.retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true })`,
   ошибка BullMQ (задание успели повторить) — `not_failed`. Оба — с
   таймаутом 5 с.
3. **`payment-jobs.ts`** — `PaymentJobs` (`@Injectable()`, `OnModuleInit`;
   зависимости: `APP_CONFIG`, `PaymentsQueue`, `PURCHASES_REPOSITORY`,
   `RolesService`, `ACCOUNT_REPOSITORY`, `PaymentsHooks`,
   `PaymentFeedSources`):
   - `list(actor): Promise<{ available: boolean; jobs: FailedPaymentJob[] }>`
     — `payments.view`, до 200 заданий; очереди нет — `available: false`,
     пустой список;
   - `retryJob(actor, jobId, note, now = new Date()): Promise<{ jobId: string; purchaseId: string | null }>`
     — `payments.support`; очереди нет — `PurchaseActionUnavailableError`
     «Очередь оплаты недоступна: Redis не отвечает или оплата выключена»;
     задание с покупкой — проверка своей покупки; `not_found` — новая ошибка
     `PaymentJobNotFoundError` (`payments-errors.ts`, классом в конце файла:
     код `payment_job_not_found`, `404`, текст «Задание не найдено: очередь
     хранит последние 1000 брошенных»);
     `not_failed` — `PurchaseActionUnavailableError` (`409`) «Задание уже не
     брошено: его повторили или оно выполнилось»; удача — журнал `payments.job.retry` (`target` — аккаунт
     покупки или `null`, `after: { jobId, kind, chargeId, purchaseId, note }`),
     при покупке — `emitSupport({ kind: "retry", …, detail: "повторено
     задание: <вид>" })` (вид: `confirm` «подтверждение оплаты», `refund`
     «возврат», `refunded` «внешний возврат»), строка лога
     `payment_job_retried`;
   - `onModuleInit` — источник `sources.register("jobs", …)`:
     `timeline` — каждое брошенное задание покупки строкой вида
     `job_abandoned` во время `failedAt` (без времени — пропустить), текст
     «Задание оплаты брошено: <вид> — <reason>»; `marks` — `job_abandoned` у
     покупок с брошенным заданием; `actions` — `["retry"]`, если такое
     задание есть. Брошенные задания читаются одним вызовом
     `failedJobs(1000)` на вызов источника.
   - Сопоставление «задание → покупка» — экспортируемая чистая функция
     `jobBelongsTo(job: FailedPaymentJob, purchase: Pick<StoredPurchase, "purchaseId" | "telegramChargeId">): boolean`
     по правилу из «Решений».
4. **`payment-retry.ts`** — `PaymentRetry`:
   `retry(actor, purchaseId, note, now = new Date()): Promise<{ retried: string[] }>`
   — `payments.support`; покупки нет — `PurchaseNotFoundError`; своя —
   `ForbiddenError` «Повторять учёт своей покупки нельзя» (кроме
   `devLogin`); брошенные задания покупки (`jobBelongsTo`) — каждое через
   `retryFailed`; заданий нет — `PurchaseActionUnavailableError` «Повторять
   нечего: брошенных заданий по этой покупке нет. Если звёзды списаны, а
   оплаты нет — запустите сверку с Telegram»; задания были, но ни одно не
   повторилось (`not_failed`) — тот же класс ошибки с текстом «Задание уже
   повторяется»; удача — журнал `payments.retry` (`target` — аккаунт,
   `after: { purchaseId, jobs, note }`), `emitSupport({ kind: "retry", …,
   detail: "повторено заданий: N" })`, лог `payment_retried`. Метод устроен
   так, чтобы T-0434 дописала вторую ветку («нет задания — запись по
   выписке») перед отказом: поиск заданий и отказ — отдельными приватными
   методами.
5. **`admin/admin-payment-jobs.controller.ts`** — `@Controller("admin")`,
   гварды и лимит `ADMIN_LIMITS.mutate` — как у `AdminPurchasesController`:
   - `GET payment-jobs` — `payments.view`;
   - `POST payment-jobs/:jobId/retry`, `@HttpCode(200)` — `payments.support`;
     `jobId` — `z.string().regex(/^[a-z0-9-]{3,120}$/)`, ошибка —
     «Некорректный идентификатор задания»; тело — `purchaseSupportSchema`
     (`dto/admin.dto.ts`), ошибка — «Укажите причину: от 3 до 200 символов»;
   - `POST payments/:purchaseId/retry`, `@HttpCode(200)` — `payments.support`;
     `purchaseIdSchema`, тело — то же.
   Контроллер — в `controllers` `admin.module.ts`.
6. **`payments.module.ts`** — `PaymentJobs`, `PaymentRetry` в `providers` и
   `exports` (контроллер живёт в `AdminModule`).
7. **Журнал в панели** — `apps/admin/src/api/audit.ts`: `"payments.retry":
   "Повтор учёта покупки"`, `"payments.job.retry": "Повтор брошенного задания
   оплаты"`; строки в `apps/admin/test/audit.test.ts`.
8. **Документы** — раздел «Документы».

## Чего не трогаем

- `cli/payments-retry-failed.ts` — остаётся запасным путём.
- Обработку заданий (`process`, `jobFailed`, `JOB_OPTIONS`) — повтор идёт
  тем же путём, что первая попытка.
- Запись оплаты по выписке площадки — T-0434; экран — T-0437, T-0438.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/payments-queue.test.ts`:
  - `failedJobs` с подменённым `getFailed`: три задания разных видов и одно с
    битыми данными → четыре строки, у битого `kind: "unknown"`; многострочная
    причина → первая непустая строка; без очереди → `null`;
  - `retryFailed`: нет задания → `not_found`; `getState` = `completed` →
    `not_failed`; `failed` → `retry` вызван с `"failed"` и обоими сбросами,
    ответ `retried`; `retry` бросает → `not_failed`.
- `backend/api/test/payment-jobs.test.ts`:
  - `jobBelongsTo`: подтверждение по `payload`, возврат по
    `order.purchaseId`, внешний возврат по `chargeId`; чужая покупка — `false`;
    покупка без `telegramChargeId` и внешний возврат — `false`;
  - `list` без `payments.view` → `ForbiddenError`; очереди нет →
    `available: false`;
  - `retryJob`: `not_found` → `404` с текстом из шага 3; `not_failed` →
    `409`; удача → запись журнала `payments.job.retry` с причиной и
    `emitSupport` с `detail` «повторено задание: подтверждение оплаты»;
    задание своей покупки → `ForbiddenError`, со входом разработчика — проходит;
  - источник: `marks` помечает только покупки с брошенным заданием;
    `actions` — `["retry"]` у такой покупки и пусто у остальных.
- `backend/api/test/payment-retry.test.ts`:
  - у покупки два брошенных задания (подтверждение и возврат) → оба
    повторены, журнал `payments.retry` с `jobs` из двух id, `detail`
    «повторено заданий: 2»;
  - заданий нет → `409` с текстом из шага 4 дословно;
  - двойное нажатие: второй вызов видит `not_failed` у всех → `409` «Задание
    уже повторяется», журнал и сообщение — один раз;
  - чужой аккаунт без права → `ForbiddenError`; своя покупка → отказ.
- `apps/admin/test/audit.test.ts` — подписи двух новых действий.

## Аналитика

Нет событий словаря (WP53, «Аналитика»): действия команды — журнал действий
и строки лога `payment_job_retried`, `payment_retried`.

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md` §2, строка «Платежи» (её заводит T-0429): «…вкладка
  «Брошенные задания» — повтор задания очереди оплаты кнопкой, «Повторить
  учёт» в карточке платежа (Р209)».
- `docs/21-diagrams.md` §3: у модуля платежей — связь «панель → очередь
  `payments`: брошенные задания и повтор» строкой.

## Критерии приёмки

- [ ] `GET /admin/payment-jobs` отдаёт брошенные задания очереди оплаты с
      видом, оплатой, покупкой, причиной и временем; без Redis —
      `available: false`, не ошибка.
- [ ] Повтор задания и «Повторить учёт» по покупке запускают задания со
      свежей серией попыток; повтор уже повторенного — `409`, без второй
      записи в журнал.
- [ ] Своя покупка не повторяется (кроме входа разработчика).
- [ ] Карточка платежа показывает брошенное задание строкой хронологии и
      кнопкой `retry`, лента — пометкой.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(payments): Брошенные задания оплаты и повтор учёта`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — БРОШЕННЫЕ ЗАДАНИЯ ОПЛАТЫ И ПОВТОР УЧЁТА**

  Брошенные задания очереди оплаты видны серверу панели и повторяются кнопкой — по одному или все задания покупки сразу («Повторить учёт»). Команда на сервере больше не нужна; экран — T-0437 и T-0438.

  🛠 **Поддержка**

  • повтор идёт со свежей серией попыток и ничего не удваивает: оплата пишется по идентификатору один раз, выдача — по ключу покупки
  • каждый повтор — в журнале действий и сообщением в поток «Покупки»
  ```
