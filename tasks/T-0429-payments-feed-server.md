---
id: T-0429
title: Лента и карточка платежа в панели — сервер, права и источники хронологии
epic: E1
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/payments/payments-feed.service.ts
  - backend/api/src/modules/payments/payments-feed.repository.ts
  - backend/api/src/modules/payments/payment-feed-sources.ts
  - backend/api/src/modules/payments/payment-timeline.ts
  - backend/api/src/modules/payments/purchase-types.ts
  - backend/api/src/modules/admin-notify/payments-alert-notifier.ts
  - backend/api/src/modules/admin/admin-payments.controller.ts
  - backend/api/src/modules/admin/dto/admin-payments.dto.ts
  - backend/api/test/payments-feed.test.ts
  - backend/api/test/payments-feed.integration.test.ts
  - backend/api/test/payments-alert-notifier.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/roles/permissions.ts
  - backend/api/test/roles.test.ts
  - backend/api/src/modules/payments/payments-hooks.ts
  - backend/api/src/modules/payments/payments.module.ts
  - backend/api/src/modules/admin/admin.module.ts
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

# T-0429. Лента и карточка платежа в панели — сервер, права и источники хронологии

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0429.json)](README.md#значки-статуса)

## Зачем

11.11.2026 оплаты Telegram не записались в базу (идентификатор оплаты не влез
в колонку), а команда узнала о сбое из сообщения о брошенном задании и
разбиралась командой на сервере. Покупки видны только в карточке одного
игрока. После задачи у панели есть сервер **ленты платежей** — все покупки
всех игроков с фильтрами и поиском — и **карточки платежа** с хронологией и
списком того, что с платежом можно сделать сейчас. Задача закладывает
реестр источников хронологии: брошенные задания (T-0431), сверка (T-0433),
компенсация (T-0434) и предварительная проверка (T-0430) добавят в карточку
свои строки, не трогая ленту. Экран — T-0436.

## Решения

- **Р209, WP53** (`docs/35-stage4-plan.md`). Исполнитель их не пересматривает.
- **Права** (решение тимлида claude-lead-1, 11.11.2026, записано в WP53):
  - `payments.view` — лента и карточка; у ролей `owner` и `admin`;
  - `payments.compensate` — компенсация (её делает T-0434); только `owner`;
  - `payments.support` — как сейчас (`owner`, `admin`); теперь это ещё
    «Повторить учёт» и действия сверки — меняется только комментарий.
  Проверка — гвардом (`@RequirePermission`) и в сервисе (`roles.require`).
- **Площадка покупки — площадка аккаунта** (`account.platform`): у строки
  `purchase` своей площадки нет, а аккаунт живёт на одной площадке. Новой
  колонки не заводим.
- **Порядок ленты** — `invoiced_at` по убыванию, при равенстве — `purchase_id`
  по убыванию; страница — по курсору (keyset), без `OFFSET`. Новый индекс
  `@@index([invoicedAt, purchaseId])` — миграция только добавляет индекс.
- **Состояния фильтра** (`status`), ровно пять:

  | Значение | Условие |
  |---|---|
  | `pending` | `status = pending` (счёт без оплаты) |
  | `paid` | `paid_at` не пусто, `refund_requested_at` и `refunded_at` пусты |
  | `undelivered` | как `paid`, и `fulfilled_at` пусто, и товар из `PurchaseFulfillment.products()` |
  | `refund_requested` | `refund_requested_at` не пусто, `refunded_at` пусто |
  | `refunded` | `refunded_at` не пусто |

- **Поиск** `q`: UUID — покупка с этим `purchase_id` **или** продления с этим
  `renewal_of`; иначе — точное совпадение `telegram_charge_id` (8–256 знаков,
  без пробелов по краям). Частичного поиска нет: идентификатор копируют из
  сообщения в потоке «Покупки» или из выписки, а `LIKE` по уникальному
  индексу не идёт.
- **Персональные данные.** Идентификатор игрока на площадке и юзернейм — в
  карточке платежа только с `players.pii.view`, и тогда — запись
  `players.pii.view` в журнал действий (как карточка игрока,
  `admin-players.service.ts` `card`). В ленте их нет вовсе.
- **Действия карточки** решает сервер: `PurchaseSupport.actionsFor` (вернуть,
  выдать) плюс действия источников (повторить учёт, компенсировать), каждое —
  только при праве актёра (`ACTION_PERMISSION` ниже). Порядок — сначала то,
  что не стоит денег: `fulfill`, `retry`, `refund`, `compensate`.
- **Сбой источника не ломает карточку.** Каждый источник — в `try` и с
  таймаутом 3 с; упал — его строк нет, в лог `feed_source_failed`.
- **Журнал действий в хронологии** — записи `payments.*` над аккаунтом
  игрока, у которых `after.purchaseId` — эта покупка; читаются через
  `RolesService.auditPage` (оно требует `audit.view` — у владельца и админа
  оно есть; нет права — хронология без строк команды, не ошибка).
- **Сообщение команде о новых действиях** — `SupportAction` и
  `supportActionText` готовятся здесь сразу для четырёх видов, чтобы T-0431 и
  T-0434 только вызывали `emitSupport`.

## Как сейчас

- `backend/api/prisma/schema.prisma:613–673` — `model Purchase`; индексы
  `[accountId, createdAt]`, `[mode, paidAt]`, `[refundRequestedAt]`,
  `[product, fulfilledAt, paidAt]`. Индекса по `invoiced_at` нет.
- `backend/api/src/modules/payments/purchases.repository.ts` — 476 строк,
  `SELECT` (строка ~167) — поля `StoredPurchase`; `byAccount` (строка ~441).
  **Новых методов в этот файл не добавлять** — лента живёт в своём
  репозитории.
- `backend/api/src/modules/payments/purchase-types.ts` — `StoredPurchase`,
  `PurchaseAction = "refund" | "fulfill"`, `PurchaseProduct`.
- `backend/api/src/modules/payments/purchase-support.ts` — `actionsFor`,
  `refund`, `fulfill`; экспортирован из `PaymentsModule`.
- `backend/api/src/modules/payments/purchase-fulfillment.ts` — `products()`:
  товары, у которых есть выдача.
- `backend/api/src/modules/payments/payments-hooks.ts:79–86` — `SupportAction`
  `{ kind, purchase, actorName, note, at }`; `emitSupport`.
- `backend/api/src/modules/admin-notify/payments-alert-notifier.ts:173–184` —
  `supportActionText` знает только `refund` и `fulfill`.
- `backend/api/src/modules/admin/admin-purchases.controller.ts` — образец
  ручек: гварды `AdminSessionGuard, PermissionGuard`, `RateLimiter` с
  `ADMIN_LIMITS.mutate`, разбор через `parse` из `admin-parse.ts`.
- `backend/api/src/modules/admin/admin-players.service.ts:126–160` — карточка
  игрока: права параллельно через `roles.can`, PII и запись
  `players.pii.view`.
- `backend/api/src/modules/player-list/player-list-query.ts:49,79` — образец
  курсора: строка `base64url`.
- `backend/api/src/modules/roles/roles.service.ts:131` — `auditPage(actor,
  query)`; `AuditQuery` — `roles.repository.ts:37`.
- `backend/api/src/modules/auth/account.repository.ts` — `byId`,
  `displayNames(ids)`.
- `backend/api/test/roles.test.ts:53–57` — проверка состава ролей для
  `payments.support`; рядом — образец для новых прав.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Права** — `permissions.ts`, своим блоком сразу после `payments.support`:

   ```ts
   // Лента платежей (Р209, WP53): все покупки всех игроков и карточка платежа — только чтение
   "payments.view",
   // Компенсация за сбой оплаты самоцветами (Р209): начисление валюты — только владельцу,
   // как `players.wallet.adjust`
   "payments.compensate",
   ```

   Комментарий у `payments.support` дополнить: «…и повторить учёт, сверка с
   площадкой и действия по расхождениям (Р209)». В роль `admin` — строка
   `"payments.view"` после `"payments.support"`. Владелец получает всё
   перечнем `PERMISSIONS` сам.
3. **Схема и миграция.** В `model Purchase` после `@@index([refundRequestedAt])`
   с комментарием «Лента платежей в панели (Р209): свежие счета первыми,
   страница — по курсору» — `@@index([invoicedAt, purchaseId])`. Миграция —
   по строке «миграции» раздела «Общие файлы» `tasks/README.md` (`prisma
   migrate diff` без базы, один раз, после влития свежего `dev`), имя
   `…_purchase_feed_index`. Новых моделей нет — `wipe-plan.ts` не трогается.
4. **`purchase-types.ts`:**

   ```ts
   /** Что команда может сделать с покупкой: вернуть звёзды, повторить выдачу, повторить учёт (Р209), компенсировать (Р209). */
   export type PurchaseAction = "refund" | "fulfill" | "retry" | "compensate";
   ```

   `PurchaseSupport.actionsFor` по-прежнему отдаёт только `refund` и
   `fulfill` — его не трогать.
5. **`payment-timeline.ts`** — чистые типы и правила, без Nest и Prisma:

   ```ts
   export const TIMELINE_KINDS = ["invoice", "checkout", "paid", "renewal", "fulfilled", "refund_requested", "refunded",
     "compensated", "job_abandoned", "discrepancy", "team"] as const;
   export type TimelineKind = (typeof TIMELINE_KINDS)[number];
   export interface TimelineEntry {
     at: Date;
     kind: TimelineKind;
     /** строка для человека, по-русски, до 200 знаков */
     text: string;
     /** имя того, кто сделал; у системы и площадки — null */
     actorName: string | null;
   }
   export const FEED_MARKS = ["compensated", "job_abandoned", "discrepancy"] as const;
   export type FeedMark = (typeof FEED_MARKS)[number];
   /** Право на действие — проверяет сервис карточки, панель только прячет кнопки. */
   export const ACTION_PERMISSION: Record<PurchaseAction, Permission> = {
     refund: "payments.support", fulfill: "payments.support", retry: "payments.support", compensate: "payments.compensate",
   };
   export const ACTION_ORDER: readonly PurchaseAction[] = ["fulfill", "retry", "refund", "compensate"];
   /** Строки хронологии из самой покупки и её продлений. */
   export function purchaseTimeline(purchase: StoredPurchase, renewals: readonly StoredPurchase[]): TimelineEntry[];
   /** Строки журнала действий по этой покупке: `after.purchaseId` равен её id; остальные отбрасываются. */
   export function teamTimeline(purchaseId: string, records: readonly AuditRecord[], names: ReadonlyMap<string, string>): TimelineEntry[];
   /** Всё вместе: по времени, при равном времени — в порядке TIMELINE_KINDS. */
   export function mergeTimeline(parts: readonly (readonly TimelineEntry[])[]): TimelineEntry[];
   ```

   Тексты `purchaseTimeline` (дословно; `N` — число, `R` — подпись причины):
   - `invoice` — «Счёт выставлен: N ⭐»;
   - `paid` — «Оплата записана: списано N ⭐» (время — `paidAt`);
   - `renewal` — у каждого продления: «Продление оплачено: N ⭐»;
   - `fulfilled` — «Товар выдан»;
   - `refund_requested` — «Возврат заказан: R»;
   - `refunded` — «Звёзды возвращены: R».
   Подписи причин — как в панели (`apps/admin/src/api/players.ts`
   `REFUND_REASONS`): `test_mode` «тестовая оплата», `unused` «второй шанс не
   использован», `external` «вернули вне игры», `undeliverable` «товара нет в
   каталоге», `manual` «вручную, поддержка».
   Тексты `teamTimeline` по действию журнала, затем « — » и `after.note`, если
   он строка: `payments.refund` «Возврат звёзд вручную», `payments.fulfill`
   «Повторная выдача», `payments.retry` «Повтор учёта», `payments.compensate`
   «Компенсация», `payments.discrepancy.retry` «Повтор учёта по сверке»,
   `payments.discrepancy.refund` «Возврат звёзд по сверке»,
   `payments.discrepancy.dismiss` «Расхождение разобрано»,
   `payments.job.retry` «Повтор брошенного задания». Незнакомое действие
   `payments.*` — его имя как есть. `after` читается схемой Zod
   (`z.object({ purchaseId: z.string(), note: z.string().optional() }).passthrough()`),
   не приведением.
6. **`payment-feed-sources.ts`** — реестр источников (`@Injectable()`):

   ```ts
   export interface PaymentFeedSource {
     /** строки хронологии по покупке */
     timeline(purchase: StoredPurchase): Promise<TimelineEntry[]>;
     /** пометки строк ленты — одним вызовом на страницу */
     marks(purchaseIds: readonly string[]): Promise<ReadonlyMap<string, readonly FeedMark[]>>;
     /** что источник открывает по покупке сейчас (`retry`, `compensate`); право проверяет сервис */
     actions(purchase: StoredPurchase): Promise<PurchaseAction[]>;
   }
   @Injectable()
   export class PaymentFeedSources {
     register(name: string, source: PaymentFeedSource): void; // повтор имени — замена, не второй источник
     timeline(purchase: StoredPurchase): Promise<TimelineEntry[]>;
     marks(purchaseIds: readonly string[]): Promise<Map<string, FeedMark[]>>;
     actions(purchase: StoredPurchase): Promise<PurchaseAction[]>;
   }
   ```

   Каждый вызов источника — `withTimeout(…, 3_000, "источник ленты <имя>")` в
   `try`; ошибка — `logger.warn` строкой JSON `{ module: "payments", event:
   "feed_source_failed", source, reason }` и пустой вклад. Пометки и действия
   без повторов.
7. **`payments-feed.repository.ts`** — `PAYMENTS_FEED_REPOSITORY`,
   `PrismaPaymentsFeedRepository`:
   - `page(query: FeedQuery): Promise<FeedRowRecord[]>` — `findMany` с
     условиями фильтров из «Решений», отношением `account: { platform }` для
     площадки, курсором `OR: [{ invoicedAt: { lt } }, { invoicedAt, purchaseId: { lt } }]`,
     `orderBy: [{ invoicedAt: "desc" }, { purchaseId: "desc" }]`,
     `take: limit + 1` (лишняя строка — признак следующей страницы), `select`
     — поля `StoredPurchase` и `account: { select: { displayName, platform } }`;
   - `byId(purchaseId)` — покупка с аккаунтом (`displayName`, `platform`,
     `platformUserId`, `username`);
   - `renewals(firstId)` — продления по `renewal_of`, по `paid_at`, не больше 60.

   ```ts
   export interface FeedQuery {
     status: FeedStatus | null; product: PurchaseProduct | null; from: Date | null; to: Date | null;
     accountId: string | null; platform: PlatformId | null; mode: PaymentMode | null;
     search: { purchaseId: string } | { chargeId: string } | null;
     fulfillable: readonly PurchaseProduct[]; // для `undelivered`
     cursor: { invoicedAt: Date; purchaseId: string } | null; limit: number;
   }
   ```

   `from` — включительно, `to` — исключительно, по `invoiced_at`.
8. **`payments-feed.service.ts`** — `PaymentsFeed` (зависимости: репозиторий,
   `PaymentFeedSources`, `PurchaseSupport`, `PurchaseFulfillment`,
   `RolesService`, `ACCOUNT_REPOSITORY`):
   - `page(actor, filters, cursor: string | null, limit): Promise<FeedPage>` —
     `payments.view`; курсор — `base64url` строки
     `<invoicedAt ISO>|<purchaseId>`, битый — `ValidationError` «Ссылка на
     страницу устарела — откройте ленту заново»; пометки — одним вызовом
     `sources.marks` на страницу;
   - `card(actor, purchaseId): Promise<PaymentCard>` — `payments.view`; нет
     покупки — `PurchaseNotFoundError`; права `players.pii.view`,
     `payments.support`, `payments.compensate`, `audit.view` — параллельно
     `roles.can`; `renewalOf` — первая покупка (если эта — продление),
     `renewals` — продления (если эта — первая подписки); хронология —
     `mergeTimeline([purchaseTimeline, teamTimeline, await sources.timeline])`;
     журнал — `roles.auditPage(actor, { limit: 100, before: null, actions:
     ["payments."], actorAccountId: null, target: accountId })`, имена актёров —
     `accounts.displayNames`; действия — `support.actionsFor` + `sources.actions`,
     отфильтрованы по `ACTION_PERMISSION` и упорядочены `ACTION_ORDER`.

   ```ts
   export interface FeedRow { purchase: StoredPurchase; account: { accountId: string; displayName: string; platform: PlatformId }; marks: FeedMark[] }
   export interface FeedPage { rows: FeedRow[]; next: string | null }
   export interface PaymentCard {
     purchase: StoredPurchase;
     account: { accountId: string; displayName: string; platform: PlatformId; pii: { platformUserId: string; username: string | null } | null };
     renewalOf: StoredPurchase | null;
     renewals: StoredPurchase[];
     timeline: TimelineEntry[];
     actions: PurchaseAction[];
     marks: FeedMark[];
   }
   ```
9. **`dto/admin-payments.dto.ts`** — `paymentsFeedQuerySchema` (`z.strictObject`):
   `status`, `product`, `platform` (`PLATFORM_IDS`), `mode` — перечисления,
   необязательны; `from`, `to` — `z.iso.datetime({ offset: true })`
   необязательны, `to` позже `from`; `account` — UUID; `q` — строка 8–256
   после `trim`; `cursor` — 1–300 знаков; `limit` — `z.coerce.number().int()`
   1–100, умолчание 50. `q` разбирается в `search`: UUID → `{ purchaseId }`,
   иначе → `{ chargeId }`.
10. **`admin/admin-payments.controller.ts`** — `@Controller("admin/payments")`,
    гварды как у `AdminPurchasesController`:
    - `GET /` — `payments.view`; ошибка разбора — «Неверный фильтр ленты платежей»;
    - `GET /:purchaseId` — `payments.view`; `purchaseIdSchema`, ошибка —
      «Некорректный идентификатор покупки».
    Ответ — `{ data: … }`. Контроллер — в `controllers` `admin.module.ts`.
    Других маршрутов на `admin/payments/*` с методом `GET` в других
    контроллерах быть не должно: `:purchaseId` перехватит их. Задачи
    T-0431 и T-0433 поэтому живут под `admin/payment-jobs` и
    `admin/payment-reconcile`.
11. **`payments.module.ts`** — в `providers`: `PaymentsFeed`,
    `PaymentFeedSources`, `{ provide: PAYMENTS_FEED_REPOSITORY, useClass:
    PrismaPaymentsFeedRepository }`; в `exports`: `PaymentsFeed`,
    `PaymentFeedSources` (иначе контроллер в `AdminModule` и источники
    T-0431, T-0433, T-0434 их не получат). Комментарий над `exports` —
    строкой про ленту.
12. **`payments-hooks.ts`** — `SupportAction` дописать двумя необязательными
    полями (своим блоком, остальное не трогать):

    ```ts
    /** самоцветы компенсации (Р209) — только у `compensate` */
    gems?: number;
    /** что именно сделано — строкой для сообщения команде, например «повторено заданий: 2» (Р209) */
    detail?: string;
    ```
13. **`payments-alert-notifier.ts`** — `supportActionText` для четырёх видов
    (дословно; общие строки «Товар», «Аккаунт», «Кто», «Причина» — как
    сейчас):
    - `refund` — без изменений;
    - `fulfill` — без изменений;
    - `retry` — заголовок «🔁 Учёт оплаты повторён вручную», после «Причина» —
      строка `detail`, если он задан;
    - `compensate` — заголовок «🎁 Компенсация за сбой оплаты», после «Причина»
      — «Начислено самоцветов: N» (`gems`).
    Ключ дедупликации и поток — как у `deliverSupport` сейчас.
14. **Документы** — раздел «Документы».

## Чего не трогаем

- `purchases.repository.ts` (больше 470 строк — лента в своём репозитории),
  `purchase-support.ts`, `admin-purchases.controller.ts`: «Вернуть звёзды» и
  «Выдать» остаются там, лента их только показывает.
- Карточку игрока и её покупки (`admin-players.service.ts`): право там
  остаётся `analytics.revenue.view`.
- «Повторить учёт», брошенные задания — T-0431; сверку — T-0432, T-0433;
  компенсацию — T-0434; предварительную проверку в хронологии — T-0430;
  экран — T-0436.
- Словарь событий: новых событий нет (WP53, «Аналитика»).

## Тесты

Первым коммитом, до кода.

- `backend/api/test/payments-feed.test.ts` — правила и сервис с подставными
  репозиторием, ролями и источниками:
  - `purchaseTimeline`: оплаченная, выданная и возвращённая вручную покупка
    → пять строк в порядке времени с текстами из шага 5; у неоплаченной —
    одна строка `invoice`;
  - `teamTimeline`: запись `payments.refund` с `after.purchaseId` этой
    покупки и `note` → «Возврат звёзд вручную — <note>», имя актёра из
    карты; запись по другой покупке и запись с битым `after` → отброшены;
  - `mergeTimeline`: две строки с одним временем идут в порядке
    `TIMELINE_KINDS`;
  - `PaymentFeedSources`: источник, который бросает, и источник, который не
    отвечает 3 с (поддельные таймеры), → карточка собирается без их строк,
    в логе `feed_source_failed`; повторная регистрация того же имени не
    удваивает строки;
  - `card`: без `payments.view` — `ForbiddenError`; у актёра без
    `payments.compensate` действие `compensate` от источника не попадает в
    `actions`; без `players.pii.view` — `pii: null` и нет записи
    `players.pii.view`; с правом — запись есть; без `audit.view` — карточка
    без строк `team`, не ошибка; порядок действий — `fulfill`, `retry`,
    `refund`, `compensate`;
  - `page`: битый курсор → `ValidationError` с текстом из шага 8.
- `backend/api/test/payments-feed.integration.test.ts` — живой Postgres:
  - восемь покупок двух аккаунтов разных площадок с разными состояниями →
    каждый из пяти `status` отдаёт ровно свои строки; `undelivered` не
    отдаёт второй шанс;
  - `limit: 3` → три страницы по курсору без пропусков и повторов, у двух
    покупок одинаковый `invoiced_at` — обе на месте;
  - `q` = UUID первой покупки VIP → она и её продление; `q` =
    идентификатор оплаты длиной 131 знак → ровно эта покупка;
  - `from`/`to`, `product`, `platform`, `mode`, `account` — по одному кейсу
    на фильтр.
- `backend/api/test/payments-alert-notifier.test.ts` — `supportActionText`
  для `retry` с `detail` и для `compensate` с `gems: 120` → тексты из шага 13
  дословно; `refund` и `fulfill` — прежние тексты.
- `backend/api/test/roles.test.ts` — `payments.view` у `owner` и `admin`, у
  остальных нет; `payments.compensate` только у `owner`.

## Аналитика

Нет: лента только читает. Новых событий словаря нет — WP53, «Аналитика».

## Настройки и окружение

Нет.

## Документы

- `docs/29-admin-panel.md`: в §2 строка модуля **«Платежи»** (для кого —
  владелец, админ; что делает — лента всех покупок с фильтрами и поиском,
  карточка платежа с хронологией и действиями, Р209; этап 4); в §3.3 строки
  «Платежи: лента и карточка» (`owner` Ч, `admin` Ч) и «Платежи: компенсация»
  (`owner` И), строку «Игроки: возврат звёзд и повторная выдача покупки»
  дополнить «и повтор учёта, действия сверки».
- `docs/21-diagrams.md` §1.1: у `PURCHASE` — индекс не рисуется, сущность не
  меняется; в §3 (модули бэкенда) — у модуля платежей связь «лента платежей
  → панель» строкой, если там перечислены потребители `PaymentsModule`.

## Критерии приёмки

- [ ] `GET /admin/payments` отдаёт все покупки всех игроков свежими
      сверху; пять состояний, товар, период, игрок, площадка, режим и поиск
      работают по таблице «Решений»; страницы по курсору без пропусков.
- [ ] `GET /admin/payments/:id` отдаёт покупку, игрока (PII — только с
      правом и с записью в журнал), продления, хронологию и действия по
      правам актёра.
- [ ] Источник, который упал или завис, не ломает карточку.
- [ ] `payments.view` — у владельца и админа; `payments.compensate` — только
      у владельца.
- [ ] `supportActionText` знает `retry` и `compensate` дословно по шагу 13.
- [ ] Миграция только добавляет индекс.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(payments): Лента и карточка платежа — сервер`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЛЕНТА И КАРТОЧКА ПЛАТЕЖА — СЕРВЕР**

  У панели появился сервер ленты платежей: все покупки всех игроков с фильтрами и поиском по номеру покупки и идентификатору оплаты, и карточка платежа с хронологией и действиями. Экран — следующей задачей (T-0436).

  🛠 **Права**

  • payments.view — лента и карточка, у владельца и администратора
  • payments.compensate — компенсация, только у владельца (кнопка появится с T-0434)
  ```
