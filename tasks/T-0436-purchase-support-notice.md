---
id: T-0436
title: Сообщение игроку о компенсации и возврате звёзд — в игре и в боте
epic: E1
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / extra
author: claude-lead-1
size: M
depends_on: [T-0435]
zones:
  - backend/api/src/modules/payments/purchase-notices.ts
  - backend/api/src/modules/payments/payment-refunds.ts
  - backend/api/test/purchase-notices.test.ts
  - backend/api/test/notifications-bot.test.ts
  - packages/app-shell/src/screens/meta/notifications.tsx
  - packages/app-shell/test/notifications.test.ts
shared:
  - backend/api/src/modules/notifications/notification-kinds.ts
  - backend/api/src/modules/notifications-bot/bot-notify-rules.ts
  - backend/api/src/modules/notifications-bot/bot-notify-texts.ts
  - backend/api/src/modules/payments/payments-hooks.ts
  - backend/api/src/modules/payments/payments.module.ts
  - packages/app-shell/src/i18n/ru-account.json
  - docs/21-diagrams.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 4
---

# T-0436. Сообщение игроку о компенсации и возврате звёзд — в игре и в боте

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0436.json)](README.md#значки-статуса) [![T-0435](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0435.json&label=T-0435)](T-0435-purchase-compensation-server.md)

## Зачем

Команда компенсирует сбой оплаты (T-0435) или возвращает звёзды, а игрок
узнаёт об этом, только если сам заглянет в счёт. После задачи игрок получает
короткое извинение с суммой — строкой в ленте уведомлений игры и сообщением
бота: за компенсацию и за возврат звёзд поддержкой или из-за товара, которого
больше нет.

## Решения

- **Р209, WP53** (`docs/35-stage4-plan.md`). Исполнитель их не пересматривает.
- **Когда пишем** (решения тимлида claude-lead-1, 11.11.2026, WP53):
  - компенсация начислена — всегда (событие `emitSupport` вида `compensate`
    от T-0435, оно приходит один раз);
  - возврат звёзд **отмечен впервые** и его причина — `manual` (поддержка)
    или `undeliverable` (товара нет в каталоге). Тестовая оплата,
    неиспользованный второй шанс, внешний возврат игрока, лишняя и чужая
    оплата — без сообщения. Возврат по сверке без покупки (T-0434) — без
    сообщения: строки покупки нет.
- **Как пишем:** новый вид уведомления `purchase_support` — строка ленты игры
  и дубль в бота тем же механизмом, что «Сообщение команды» (Р51, WP28):
  ключ игрока `bot.teamMessage`, по умолчанию включён, без потолка частоты,
  **не напоминание** — тихие часы и потолок «со звуком» (Р199) к нему не
  применяются. Выключил игрок «Сообщения команды» — видит только строку в
  игре.
- **Один раз:** ключ события ленты — `purchase_support:compensated:<покупка>`
  и `purchase_support:refunded:<покупка>`; повтор события ленту и бота не
  удваивает.
- **Сбой записи уведомления не ломает деньги:** компенсация и возврат уже
  прошли; ошибка — строка `warn` в лог, не исключение.
- **Тон** — на «ты» (Р163), извинение без давления и без зова в магазин
  (Р11): кнопка бота — только «▶ Открыть игру», у строки ленты — без
  перехода.
- **Тексты — дословно.** Дата — день и месяц оплаты по Москве (`ДД.ММ`).

  Строка ленты (заголовок → текст):
  - компенсация: «Извинение от команды» → «Прости: с твоей оплатой {stars} ⭐
    от {date} случился сбой на нашей стороне. Начислили {gems} самоцвет(а/ов)
    — они уже на счёте.»
  - возврат поддержкой: «Звёзды вернулись» → «Вернули {stars} ⭐ за покупку
    от {date} по решению поддержки. Звёзды уже на твоём счёте.»
  - возврат, товара нет: «Звёзды вернулись» → «Вернули {stars} ⭐ за покупку
    от {date}: этого товара больше нет в магазине. Прости за неудобство —
    звёзды уже на твоём счёте.»
  - если у возврата забран остаток покупки — к тексту через пробел:
    «Остаток покупки списан со счёта в игре.»

  Бот (простой текст, кнопка «▶ Открыть игру»):
  - компенсация: «Команда «Рубежа»: прости — с твоей оплатой {stars} ⭐ от
    {date} случился сбой на нашей стороне. Мы начислили тебе {gems}
    самоцвет(а/ов), они уже на счёте в игре.»
  - возврат поддержкой: «Команда «Рубежа»: вернули тебе {stars} ⭐ за покупку
    от {date} по решению поддержки. Звёзды уже на твоём счёте.»
  - возврат, товара нет: «Команда «Рубежа»: вернули тебе {stars} ⭐ за покупку
    от {date} — этого товара больше нет в магазине. Прости за неудобство,
    звёзды уже на твоём счёте.»
  - забран остаток — к тексту через пробел: «Остаток покупки списан со счёта
    в игре.»

  Склонение «самоцвет / самоцвета / самоцветов» — по числу (1, 2–4, 5+, 11–14
  — «самоцветов»).

## Как сейчас

- `backend/api/src/modules/notifications/notification-kinds.ts` —
  `NOTIFICATION_KINDS`: схема данных каждого вида; `team_message`.
- `backend/api/src/modules/notifications/notifications.service.ts:79` —
  `deliver({ accountId, kind, payload, dedupeKey, at })`: строка ленты и
  слушатели (дубль в бота — `notifications-bot`); повтор ключа — `false`.
- `backend/api/src/modules/notifications-bot/bot-notify-rules.ts` —
  `BOT_NOTIFY`: `team_message: { setting: "bot.teamMessage", byDefault: true, throttleSec: 0 }`.
- `backend/api/src/modules/notifications-bot/bot-notify-texts.ts` —
  `botMessageOf`, `textOf` по виду; кнопка «▶ Открыть игру» —
  `launch("n-<вид>")`; `GAME_DAY_TIME_ZONE` — `common/game-day.ts`.
- `backend/api/src/common/card/labels.ts:78` — `pluralRu(count, one, few, many)`.
- `backend/api/src/modules/payments/payment-refunds.ts:107–127` — `refund`:
  после возврата площадкой `markRefunded` (`RefundedRecord.firstTime`), у
  `manual` — отзыв остатка (`revocation.lines`). Конструктор — с
  необязательным `revocation` в конце.
- `backend/api/src/modules/payments/payments-hooks.ts` — образец событий
  (`onSupport`/`emitSupport`); после T-0429 у `SupportAction` есть `gems`.
- `backend/api/src/modules/notifications/notifications.module.ts` —
  импортирует только `AuthModule`, экспортирует `NotificationsService`: в
  `PaymentsModule` подключается без цикла.
- `packages/app-shell/src/screens/meta/notifications.tsx:86–123` —
  `describeNotification` по виду: `icon`, `title`, `text`, `target`;
  словарь — `i18n/ru-account.json` (лениво, `i18n/account`).
- `packages/app-shell/test/notifications.test.ts` — образец проверок
  `describeNotification`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`notification-kinds.ts`** — строкой в `NOTIFICATION_KINDS` с
   комментарием «извинение команды за сбой оплаты или возврат звёзд (Р209)»:

   ```ts
   purchase_support: z.object({
     action: z.enum(["compensated", "refunded"]),
     stars: z.number().int().nonnegative(),
     gems: z.number().int().nonnegative(),
     /** когда игрок платил — по нему дата в тексте */
     paidAt: z.iso.datetime(),
     /** у возврата — причина; у компенсации — null */
     reason: z.enum(["manual", "undeliverable"]).nullable(),
     /** у возврата забран остаток покупки */
     revoked: z.boolean(),
   }),
   ```
3. **`bot-notify-rules.ts`** — `purchase_support: { setting:
   "bot.teamMessage", byDefault: true, throttleSec: 0 }` с комментарием:
   «Извинение за сбой оплаты и возврат звёзд (Р209): о деньгах, редкое и
   адресное — как сообщение команды, не напоминание: тихие часы и потолок
   «со звуком» его не держат».
4. **`bot-notify-texts.ts`** — ветка `purchase_support` в `textOf`: разбор
   схемой вида, тексты бота из «Решений» дословно; дата — `ДД.ММ` по
   `GAME_DAY_TIME_ZONE` (`Intl.DateTimeFormat("ru-RU", { timeZone, day:
   "2-digit", month: "2-digit" })`); склонение — `pluralRu(gems, "самоцвет",
   "самоцвета", "самоцветов")`.
5. **`payments-hooks.ts`** — своим блоком:

   ```ts
   /** Звёзды вернулись по нашему заказу (Р209): покупка уже отмечена, остаток — забран, если был. */
   export interface RefundDone { purchase: StoredPurchase; revoked: boolean; at: Date }
   onRefundDone(name: string, listener: (event: RefundDone) => Promise<void>): void;
   emitRefundDone(event: RefundDone): Promise<void>;
   ```
6. **`payment-refunds.ts`** — последним параметром конструктора
   `private readonly hooks: PaymentsHooks = new PaymentsHooks()`; в `refund`
   после отзыва: `record?.firstTime === true` и причина покупки `manual` или
   `undeliverable` → `await this.hooks.emitRefundDone({ purchase:
   record.purchase, revoked: (revocation?.lines.length ?? 0) > 0, at:
   record.purchase.refundedAt ?? new Date(nowMs) })`. Повтор задания
   (`firstTime: false`) события не шлёт.
7. **`purchase-notices.ts`** — `PurchaseNotices` (`OnModuleInit`;
   зависимости: `PaymentsHooks`, `NotificationsService`):
   - `hooks.onSupport("purchase-notices", …)` — только вид `compensate` с
     `gems > 0` и оплаченной покупкой → `deliver` с `action: "compensated"`,
     `stars: purchase.chargedStars`, `gems`, `paidAt`, `reason: null`,
     `revoked: false`;
   - `hooks.onRefundDone("purchase-notices", …)` → `deliver` с `action:
     "refunded"`, `stars: chargedStars`, `gems: 0`, `reason`, `revoked`;
   - ключи события — из «Решений»; ошибка `deliver` — `logger.warn` строкой
     JSON `{ module: "payments", event: "purchase_notice_failed", purchaseId,
     action, reason }`.
   В `payments.module.ts`: `NotificationsModule` в `imports`,
   `PurchaseNotices` в `providers`.
8. **Оболочка.** `ru-account.json` — ключи:

   ```json
   "notification.purchase_support.compensated.title": "Извинение от команды",
   "notification.purchase_support.compensated": "Прости: с твоей оплатой {stars} ⭐ от {date} случился сбой на нашей стороне. Начислили {amount} {n, plural, one {самоцвет} few {самоцвета} many {самоцветов} other {самоцвета}} — они уже на счёте.",
   "notification.purchase_support.refunded.title": "Звёзды вернулись",
   "notification.purchase_support.refunded.manual": "Вернули {stars} ⭐ за покупку от {date} по решению поддержки. Звёзды уже на твоём счёте.",
   "notification.purchase_support.refunded.undeliverable": "Вернули {stars} ⭐ за покупку от {date}: этого товара больше нет в магазине. Прости за неудобство — звёзды уже на твоём счёте.",
   "notification.purchase_support.revoked": "Остаток покупки списан со счёта в игре."
   ```

   `notifications.tsx` — ветка `purchase_support` в `describeNotification`:
   значок `Gem` у компенсации и `Undo2` у возврата (lucide, размер 20),
   `title` и `text` по ключам, `target: null`; дата — `ДД.ММ` по Москве
   (`Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit",
   month: "2-digit" })`); данные не по виду (нет чисел, битая дата,
   незнакомое `action`) — `null`, строки нет.
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Правила тихих часов, потолка и звука (`bot-notify-sender.ts`, T-0394,
  T-0406) — новый вид идёт обычным путём сообщения команды.
- Тексты отказов оплаты и окно магазина.
- Компенсацию и возврат — только слушаем их события.

## Сценарий и интерфейс

Игрок открывает колокольчик — строка с заголовком «Извинение от команды»
или «Звёзды вернулись» и текстом из «Решений»; касание отмечает прочитанным
и никуда не ведёт. Длинный текст переносится, как у сообщения команды.
Загрузка, пусто, ошибка и нет сети — как у ленты сейчас. В боте — простой
текст и кнопка «▶ Открыть игру».

## Тесты

Первым коммитом, до кода.

- `backend/api/test/purchase-notices.test.ts`:
  - `emitSupport` вида `compensate` с `gems: 120` за покупку 50 ⭐ от
    11.11 → `deliver` вида `purchase_support` с `action: "compensated"`,
    `stars: 50`, `gems: 120`, ключом `purchase_support:compensated:<id>`;
  - `emitSupport` видов `refund`, `fulfill`, `retry` → `deliver` не вызван;
  - `PaymentRefunds.refund` (подставная площадка и память покупок) возврата
    `manual` с отзывом → `emitRefundDone` с `revoked: true` → `deliver` с
    `action: "refunded"`, `reason: "manual"`; повтор того же задания
    (`firstTime: false`) → второго `deliver` нет;
  - возврат `unused`, `test_mode` → события нет;
  - `deliver` бросает → в логе `purchase_notice_failed`, исключения нет.
- `backend/api/test/notifications-bot.test.ts` — `botMessageOf("purchase_support", …)`:
  компенсация 1, 3, 12 и 120 самоцветов → «самоцвет», «самоцвета»,
  «самоцветов», «самоцветов» в тексте дословно; возврат поддержкой с
  остатком и без; возврат `undeliverable`; дата 11.11 по Москве у оплаты
  22:30 UTC 10.11 → «11.11»; данные не по схеме → `null`; правило дубля —
  ключ `bot.teamMessage`, без `reminder`.
- `packages/app-shell/test/notifications.test.ts` — `describeNotification`
  трёх вариантов: заголовок и текст дословно, `target: null`; остаток —
  дописан; битые данные → `null`.

## Аналитика

Нет новых событий: переход из ленты по-прежнему — `notification_opened`
(здесь перехода нет), исход дубля в бота — колонка уведомления.

## Настройки и окружение

Нет: ключ игрока `bot.teamMessage` уже есть.

## Документы

- `docs/21-diagrams.md` §1.1, `NOTIFICATION.kind` — дописать
  `purchase_support` в перечень видов; в потоке §4.39 (компенсация, заводит
  T-0435) — шаг «уведомление purchase_support → лента и бот».

## Критерии приёмки

- [ ] После компенсации игрок видит строку в ленте и сообщение бота с
      суммой самоцветов и датой оплаты — дословно по «Решениям».
- [ ] После возврата поддержкой или из-за снятого товара — то же о звёздах;
      о забранном остатке — дописано.
- [ ] Другие возвраты и повтор события сообщений не дают.
- [ ] Выключенные «Сообщения команды» — только строка в игре.
- [ ] Сбой записи уведомления не ломает компенсацию и возврат.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(payments): Сообщение игроку о компенсации и возврате`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: если с оплатой случился сбой, команда извинится в игре и в боте и начислит самоцветы`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СООБЩЕНИЕ ИГРОКУ О КОМПЕНСАЦИИ И ВОЗВРАТЕ**

  Игрок узнаёт о компенсации за сбой оплаты и о возврате звёзд сам: строкой в ленте уведомлений и сообщением бота, коротким извинением с суммой и датой оплаты.

  🛠 **Поддержка**

  • пишем о компенсации и о возврате поддержкой или из-за снятого товара; об автоматических возвратах — нет
  • в бота — по выбору игрока «Сообщения команды», в тихие часы не задерживается
  ```
