---
id: T-0434
title: Действия по расхождениям сверки и «Повторить учёт» по выписке площадки
epic: E1
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: [T-0431, T-0433]
zones:
  - backend/api/src/modules/payments/payment-discrepancies.ts
  - backend/api/src/modules/payments/payment-reconcile.repository.ts
  - backend/api/src/modules/payments/payment-retry.ts
  - backend/api/src/modules/payments/payments-queue.ts
  - backend/api/src/modules/admin/admin-payment-reconcile.controller.ts
  - backend/api/test/payment-discrepancies.test.ts
  - backend/api/test/payment-retry.test.ts
  - backend/api/test/payments-queue.test.ts
  - backend/api/test/payment-reconcile.integration.test.ts
shared:
  - backend/api/src/modules/payments/payments-errors.ts
  - backend/api/src/modules/payments/payments.module.ts
  - backend/api/src/modules/admin/admin-payment-jobs.controller.ts
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

# T-0434. Действия по расхождениям сверки и «Повторить учёт» по выписке площадки

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0434.json)](README.md#значки-статуса) [![T-0431](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0431.json&label=T-0431)](T-0431-payment-jobs-and-retry.md) [![T-0433](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0433.json&label=T-0433)](T-0433-payment-reconcile-core.md)

## Зачем

Сверка (T-0433) находит расхождения, но сделать с ними пока ничего нельзя.
После задачи у расхождения есть действия: «Повторить учёт» записывает оплату
или возврат по данным выписки тем же путём, что обновление от бота,
«Вернуть звёзды» возвращает оплату, которую мы так и не записали, «Разобрано»
закрывает расхождение с причиной. «Повторить учёт» в карточке платежа
(T-0431) без брошенного задания тоже идёт по выписке. Карточка платежа
показывает расхождение строкой хронологии и пометкой. Экран — T-0438.

## Решения

- **Р209, WP53** (`docs/35-stage4-plan.md`). Исполнитель их не пересматривает.
- **Действия по виду:**

  | Вид | «Повторить учёт» | «Вернуть звёзды» | «Разобрано» |
  |---|---|---|---|
  | `charged_unrecorded` | задание `confirm` по выписке | возврат оплаты без покупки | да |
  | `refund_unrecorded` | задание `refunded` по выписке | нет | да |
  | `recorded_missing` | нет — `409` | нет | да |

- **Запись по выписке — тем же заданием очереди,** что подтверждение от бота
  (`PaymentsQueue`): запись идемпотентна по идентификатору оплаты, выдача —
  по ключу покупки, неизвестный `payload` вернёт звёзды сам (`unmatched`,
  `payment-refunds.ts`). У задания свой `jobId` с меткой `reconcile`:
  прежнее задание с тем же отпечатком могло остаться в очереди выполненным
  или брошенным, и BullMQ молча не добавил бы второе с тем же id.
- **Время оплаты — время операции площадки,** а не время повтора: в задание
  `confirm` добавляется `at`, и `PaymentConfirmation.confirm` получает его.
  Заодно обычное подтверждение от бота несёт время прихода обновления — при
  повторе брошенного задания оплата записывается временем оплаты, а не
  временем повтора. Старые задания без `at` — как сейчас (время обработки).
  Решение тимлида claude-lead-1, 11.11.2026: по времени оплаты считаются
  холд (`37-accounting.md` §5) и срок VIP, совпадающий с продлением площадки;
  дни VIP, прошедшие до повтора, покрывает компенсация (T-0435).
- **«Вернуть звёзды» у «списано, но не записано»** — заказ возврата без
  покупки (`purchaseId: null`, причина `manual`), как возврат лишней оплаты:
  покупка остаётся неоплаченной, остатка забирать нечего. Сообщения игроку
  нет (T-0436 пишет о возвратах покупок; строки покупки с этой оплатой нет).
- **Гонки.** Действие сначала **занимает** расхождение условным
  `updateMany` (`resolvedAt: null` → решение, кто, причина, время); занял не
  он (`count = 0`) — `409` «Расхождение уже разобрано», и задание не
  ставится. Двойное нажатие даёт одно задание и одну запись в журнал.
- **Права:** все действия — `payments.support`; своя оплата (аккаунт
  расхождения — актёр) — отказ «Разбирать свою оплату нельзя», кроме входа
  разработчика.
- **Причина** обязательна у всех трёх: 3–200 знаков.

## Как сейчас

- После T-0433: `payment-reconcile.repository.ts` (`open`, `resolveMatched`,
  `overview`), `payment-reconcile.ts` (`DiscrepancyKind`,
  `DiscrepancyResolution`), `admin-payment-reconcile.controller.ts`
  (`GET /`, `POST run`), таблица `payment_discrepancy`.
- После T-0431: `payment-retry.ts` — `PaymentRetry.retry` ищет брошенные
  задания покупки и без них отказывает «Повторять нечего…»; поиск и отказ —
  отдельными приватными методами.
- `backend/api/src/modules/payments/payments-queue.ts`:
  - `confirm(payment)` → `run({ kind: "confirm", payment }, "confirm-<отпечаток>")`;
  - `refunded(chargeId, nowMs)` → `run({ kind: "refunded", chargeId, at }, "refunded-<отпечаток>")`;
  - `process` зовёт `confirmation.confirm(data.payment)` без времени;
  - `dispatchRefunds(orders)` — заказ возвратов заданиями.
- `backend/api/src/modules/payments/payment-confirmation.ts` —
  `confirm(payment, nowMs = Date.now())`.
- `backend/api/src/modules/payments/payment-refunds.ts:107–127` — возврат без
  покупки (`purchaseId: null`) не отмечает покупку и ничего не забирает.
- `PaymentProviders.for(platform)?.currency` — валюта площадки (`XTR`).
- После T-0429: `PaymentFeedSources.register`, вид хронологии `discrepancy`,
  пометка `discrepancy`, действие `retry`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`payments-queue.ts`:**
   - у варианта `confirm` в `PaymentsJob` — `at?: number` (когда пришло
     обновление); `confirm(payment, atMs = Date.now())` кладёт его в
     задание; `process` — `this.confirmation.confirm(data.payment, data.at)`;
   - новый метод:

     ```ts
     /**
      * Повтор по выписке площадки (Р209): задание с меткой в jobId — прежнее задание той же оплаты
      * могло остаться в очереди выполненным или брошенным, и BullMQ не добавил бы второе с тем же id.
      */
     async replay(job: { kind: "confirm"; payment: ConfirmedPayment; at: number } | { kind: "refunded"; chargeId: string; at: number }, tag: string): Promise<void>;
     ```

     `jobId` — `${kind}-${fingerprint(chargeId)}-${tag}`; дальше — тот же
     `run` (очередь или сразу).
3. **`payment-reconcile.repository.ts`** — дописать:
   - `byId(discrepancyId)`; `byPurchase(purchaseId)` — все расхождения
     покупки; `openByPurchases(ids)` — открытые по списку покупок;
   - `claim(discrepancyId, resolution, actorAccountId, note, at): Promise<boolean>`
     — условный `updateMany` с `resolvedAt: null`.
4. **`payment-discrepancies.ts`** — `PaymentDiscrepancies` (`OnModuleInit`;
   зависимости: `APP_CONFIG`, репозиторий сверки, `PaymentsQueue`,
   `PaymentProviders`, `PURCHASES_REPOSITORY`, `RolesService`,
   `ACCOUNT_REPOSITORY`, `PaymentsHooks`, `PaymentFeedSources`):
   - `retry(actor, discrepancyId, note, now)`;
   - `refund(actor, discrepancyId, note, now)`;
   - `dismiss(actor, discrepancyId, note, now)`.

   Общий порядок: `payments.support` → расхождение (нет —
   `DiscrepancyNotFoundError`, `payments-errors.ts`, классом в конце файла:
   код `discrepancy_not_found`, `404`, «Расхождение не найдено») → закрыто —
   `PurchaseActionUnavailableError` «Расхождение уже разобрано» → своя
   оплата — `ForbiddenError` «Разбирать свою оплату нельзя» (кроме
   `devLogin`) → действие недоступно по таблице — `409` с текстом:
   «Повторять нечего: оплаты нет в выписке площадки. Не появится — нажмите
   «Разобрано» с причиной» (повтор `recorded_missing`); «Вернуть звёзды можно
   только у оплаты, которую мы не записали; у записанной — кнопкой в
   карточке платежа» (возврат не у `charged_unrecorded`); «В выписке нет
   игрока — вернуть или записать оплату нельзя» (`payerId` пуст) → `claim`
   (не занял — «Расхождение уже разобрано») → действие:
   - повтор `charged_unrecorded` — `queue.replay({ kind: "confirm", payment:
     { platform, chargeId, payload: payload ?? "", payerId, currency, totalAmount: amount }, at: occurredAt }, "reconcile")`;
   - повтор `refund_unrecorded` — `queue.replay({ kind: "refunded", chargeId, at: occurredAt }, "reconcile")`;
   - возврат — `queue.dispatchRefunds(Promise.resolve([{ purchaseId: null, platform, chargeId, payerId, reason: "manual" }]))`;
   → журнал `payments.discrepancy.retry` | `.refund` | `.dismiss` (`target` —
   аккаунт или `null`, `after: { discrepancyId, kind, chargeId, purchaseId, note }`)
   → при найденной покупке — `emitSupport`: у повтора `kind: "retry"`,
   `detail: "запись по выписке площадки"`; у возврата `kind: "refund"`,
   `detail: "оплата не была записана — возврат по выписке"`; у «Разобрано» —
   без сообщения → строка лога `discrepancy_resolved` (`discrepancyId`,
   `kind`, `resolution`). Ответ — `DiscrepancyView` расхождения после
   действия.
   - `onModuleInit` — `sources.register("reconcile", …)`: `timeline` —
     каждое расхождение покупки: строка `discrepancy` во время `detectedAt`
     «Сверка: <подпись вида>» (подписи — таблица «Решений» T-0433) и, если
     закрыто, строка во время `resolvedAt` «Расхождение закрыто: <подпись>»
     (`matched` «сошлось само», `retried` «учёт повторён», `refunded` «звёзды
     возвращены», `dismissed` «разобрано») с именем того, кто закрыл;
     `marks` — `discrepancy` у покупок с открытым расхождением; `actions` —
     `["retry"]` при открытом `charged_unrecorded` или `refund_unrecorded`.
5. **`payment-retry.ts`** — вторая ветка перед отказом: брошенных заданий
   нет → открытое расхождение покупки вида `charged_unrecorded` или
   `refund_unrecorded` → `PaymentDiscrepancies.retry(actor, id, note, now)`;
   ответ `retry` — `{ retried: string[]; replayed: string | null }`
   (`replayed` — id расхождения). Нет и его — прежний отказ, текст не
   меняется.
6. **`admin-payment-reconcile.controller.ts`** — три маршрута,
   `@HttpCode(200)`, `payments.support`, лимит `ADMIN_LIMITS.mutate`:
   `POST :discrepancyId/retry`, `POST :discrepancyId/refund`,
   `POST :discrepancyId/dismiss`; id — UUID («Некорректный идентификатор
   расхождения»); тело — `purchaseSupportSchema` («Укажите причину: от 3 до
   200 символов»).
7. **`payments.module.ts`** — `PaymentDiscrepancies` в `providers` и `exports`.
8. **Журнал в панели** — `apps/admin/src/api/audit.ts`:
   `"payments.discrepancy.retry": "Повтор учёта по сверке"`,
   `"payments.discrepancy.refund": "Возврат звёзд по сверке"`,
   `"payments.discrepancy.dismiss": "Расхождение сверки разобрано"`; строки в
   тесте.
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Правила сверки и расписание (T-0433) — только чтение и `claim`.
- `PaymentConfirmation`, `PaymentRefunds` — вызываются как есть.
- `cli/payments-retry-failed.ts`.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/payments-queue.test.ts`:
  - `confirm(payment, at)` кладёт `at` в задание; `process` с `at` зовёт
    `confirmation.confirm(payment, at)`; задание без `at` — `confirm(payment, undefined)`;
  - `replay` подтверждения → `jobId` `confirm-<отпечаток>-reconcile`;
    возврата → `refunded-<отпечаток>-reconcile`.
- `backend/api/test/payment-discrepancies.test.ts` — подставные репозиторий,
  очередь и роли:
  - повтор `charged_unrecorded` → `replay` с `at = occurredAt`,
    `totalAmount = amount`, `payload`; журнал `payments.discrepancy.retry`;
    `emitSupport` с `detail` при найденной покупке;
  - повтор `refund_unrecorded` → `replay` вида `refunded`;
  - повтор `recorded_missing` → `409` с текстом из шага 4, без `claim`;
  - возврат `charged_unrecorded` → заказ без покупки с причиной `manual`;
    возврат `refund_unrecorded` → `409`;
  - «Разобрано» → решение `dismissed`, без сообщения команде;
  - двойное нажатие: второй `claim` → `false` → `409` «Расхождение уже
    разобрано», `replay` вызван один раз;
  - закрытое → `409`; нет → `404`; своя оплата → `ForbiddenError`, со
    входом разработчика — проходит; без `payments.support` — `ForbiddenError`;
  - источник: строки хронологии открытого и закрытого расхождения с
    текстами из шага 4; `actions` — `retry` только у открытых
    `charged_unrecorded`/`refund_unrecorded`.
- `backend/api/test/payment-retry.test.ts` — брошенных заданий нет, есть
  открытое `charged_unrecorded` покупки → `replayed` = его id, задание
  поставлено; нет ни того ни другого → прежний отказ дословно.
- `backend/api/test/payment-reconcile.integration.test.ts` — два
  одновременных `claim` одного расхождения → ровно один `true`.
- `apps/admin/test/audit.test.ts` — подписи трёх действий.

## Аналитика

Нет событий словаря (WP53, «Аналитика»): решения — колонки
`payment_discrepancy` и журнал действий, в лог — `discrepancy_resolved`.

## Настройки и окружение

Нет.

## Документы

- `docs/21-diagrams.md` §4.38 (поток сверки, его заводит T-0433) — ветка
  «действие команды → claim → задание очереди по выписке».
- `docs/29-admin-panel.md` §2, строка «Платежи» — «…по расхождению:
  «Повторить учёт», «Вернуть звёзды», «Разобрано» с причиной (Р209)».

## Критерии приёмки

- [ ] «Повторить учёт» у расхождения ставит задание по выписке со временем
      операции площадки; оплата записывается и выдаётся один раз.
- [ ] «Повторить учёт» в карточке платежа без брошенного задания идёт по
      открытому расхождению.
- [ ] «Вернуть звёзды» доступен только у «списано, но не записано».
- [ ] Двойное нажатие — одно задание и одна запись в журнал.
- [ ] Подтверждение от бота записывает оплату временем прихода обновления,
      и при повторе брошенного задания тоже.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(payments): Действия по расхождениям сверки`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДЕЙСТВИЯ ПО РАСХОЖДЕНИЯМ СВЕРКИ**

  У расхождений сверки с Telegram появились действия: «Повторить учёт» записывает оплату или возврат по выписке, «Вернуть звёзды» возвращает оплату, которую мы не записали, «Разобрано» закрывает с причиной. «Повторить учёт» в карточке платежа без брошенного задания тоже идёт по выписке.

  🛠 **Учёт**

  • оплата теперь записывается временем самой оплаты, а не временем повтора — для холда и срока VIP
  ```
