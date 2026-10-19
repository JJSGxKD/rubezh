---
id: T-0157
title: Донаты проекту — сервер: оплата любой суммой, выдача знака, ключи панели
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/*_donations/**
  - backend/api/src/modules/donations/**
  - backend/api/src/modules/payments/purchase-types.ts
  - backend/api/src/modules/payments/payments.service.ts
  - backend/api/src/modules/payments/payments-hooks.ts
  - backend/api/src/modules/payments/payment-confirmation.ts
  - backend/api/src/modules/funnel/funnel-tracker.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/home/home-slides.ts
  - backend/api/src/modules/home/home.service.ts
  - backend/api/src/modules/home/home.module.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - backend/api/src/app.module.ts
  - apps/admin/src/api/players.ts
  - apps/admin/src/api/settings.ts
  - apps/admin/src/screens/settings/SettingsScreen.tsx
  - backend/api/test/donations.test.ts
  - backend/api/test/donations.integration.test.ts
  - backend/api/test/donations.http.test.ts
  - backend/api/test/home.test.ts
  - backend/api/test/funnel.test.ts
  - backend/api/test/payment-confirmation.test.ts
  - apps/admin/test/settings.test.ts
  - apps/admin/test/players.test.ts
shared:
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/37-accounting.md
  - docs/07-monetization-and-ads.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0157. Донаты проекту — сервер: оплата любой суммой, выдача знака, ключи панели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0157.json)](README.md#значки-статуса)

## Зачем

Р109 (`docs/35-stage4-plan.md`, 19.10.2026): игрок может поддержать проект
деньгами без покупки товара и получает знак «Поддержал проект» и
благодарность. Эта задача — серверная половина: счёт на любую сумму,
выдача и снятие знака, ключи панели, слайд главной. Показ знака в ответах
входа, рейтинга и сезонов — T-0161, экраны — T-0158 по готовому API.

## Решения

Всё — из Р109. Уточнения, следующие из него и из кода:

- **Донат — не покупка.** Решение claude-lead-1 от 19.10.2026: донат не
  засчитывается в первую покупку воронки и в «платящих» для аудитории слайдов
  (`funnel-tracker.ts`); в бухгалтерии — отдельная статья дохода. Игровых
  ценностей нет: выдача — один знак. Деньги видны в таблице `purchase`
  отдельным видом `donation`.
- **Оплата площадки — через ту же цепочку, что магазин** (`PaymentsService.shopInvoice`):
  предварительная проверка, подтверждение очередью, возвраты и довыдача
  остаются прежними. Новый вид товара `donation`, `sku = "donation"`,
  не разовый: донатить можно много раз.
- **Сумма — целое число звёзд от `min` до `max` способа оплаты площадки.** Предел
  уже есть в коде: `PAYMENT_METHODS[telegram_stars]`, `minAmount "1"`,
  `maxAmount "10000"` (`payments/payment-methods.ts:12`). Ключа панели для
  предела не заводим; сервер отдаёт клиенту `min` и `max` из способа.
- **Готовые суммы — ключ панели `donate.amounts`**, по умолчанию
  `50, 100, 250, 500, 1000`. Что вне `min…max` способа — отбрасывается при
  отдаче.
- **Ссылки Tribute — два ключа**, для Telegram и для веба. Пустая — кнопки
  нет. У MAX и VK ссылки Tribute нет совсем (Р109: способы этих площадок
  придут с портированием).
- **Слайд главной — ключ `donate.home-slide`, по умолчанию выключен.**
- **Оплата выключена** (стоп-кран `payments.stars` или нет входа/чтения
  обновлений бота, `settings/feature-switches.ts:39`): звёздной части нет —
  в ответе `stars: null`, счёт не выставляется (404 `endpoint_disabled`, как у
  магазина). Ссылки Tribute от этого не зависят: оплата идёт вне игры.
- **Знак получает аккаунт, оплативший звёздами.** Решение claude-lead-1 от
  19.10.2026: донат по ссылке Tribute с аккаунтом не связан, знака за него нет.
  Ручная выдача знака из панели — не в этих задачах (тимлид заведёт пункт во
  входящих).
- **Знак ставится при любой подтверждённой оплате**, в том числе тестовой
  (решение claude-lead-1 от 19.10.2026; `mode = test` бывает только в
  разработке, `PAYMENTS_TEST_MODE`).
- **Внешний возврат снимает знак**, если других оплаченных и не
  возвращённых донатов у аккаунта нет (решение claude-lead-1 от 19.10.2026;
  спор на площадке — деньги ушли, а
  знак «Поддержал» остаться не должен). Возврат по нашей воле знак не
  трогает — как и остальные товары (`payment-confirmation.ts:168–170`: отзыв только при `refundReason === "external"`).
- **Закрытые покупки** (ограничение `purchases`) закрывают и донат звёздами:
  `stars: null`, заказ отвечает как магазин.
- **Показ знака** (`supporter: true` во входе, рейтинге и сезонах) вынесен в
  T-0161: зависит от этой задачи, зоны не пересекаются.
- **Разделение задачи** — решение claude-lead-1 от 19.10.2026.

## Как сейчас

- `backend/api/src/modules/payments/payments.service.ts:77` — `ShopOrder`
  (`product: Exclude<PurchaseProduct, "continue_run">`, `sku`, `priceStars`,
  `once`, `text`), `:162` — `shopInvoice(account, order)`: проверяет
  стоп-кран (`assertEnabled`, `:281`), способ площадки, создаёт строку
  покупки и счёт. `:257` — `charge(priceStars)`: тестовый режим списывает одну
  звезду.
- `payments/purchase-types.ts:11` — `PurchaseProduct = "continue_run" |
  "shop_item" | "vip"`; зеркало — enum `PurchaseProduct` в
  `prisma/schema.prisma:71–77`.
- `payments/payment-methods.ts:12` — `telegram_stars` с пределами 1…10000;
  `methodFor(platform)` — способ площадки или `undefined`.
- `payments/purchases.repository.ts:237` — `openShopInvoice`: у не разового
  товара (`onceKey = null`) каждый счёт — новая строка.
  Проверки базы `purchase_continue_check` и `purchase_sku_check`
  (`migrations/20260930120000_shop_purchase`, `20261012100814_purchase_run_set_null`)
  доната не мешают: у него `sku` задан, забега нет.
- `payments/purchase-fulfillment.ts` — реестр выдач: хозяин товара
  регистрирует `Fulfiller` в `onModuleInit` (образец —
  `shop/shop.service.ts:91–94`). Выдача идемпотентна. Задание
  подтверждения вызывает её и отмечает `fulfilled_at`
  (`payments-queue.ts:171–177`), а проход довыдачи подбирает зарегистрированные
  виды (`fulfillment-sweeper.ts:85`).
- `payments/purchase-revocation.ts` — реестр отзывов при внешнем
  возврате; повторная регистрация вида — ошибка.
- `payments/payments-hooks.ts:13` — `PaidPurchase` без вида товара;
  `payment-confirmation.ts:119` — `emitPaid`. Слушатель
  `funnel/funnel-tracker.ts:40–44` отмечает `first_purchase` для любой
  не тестовой оплаты.
- `settings/setting-catalog.ts` — `urlSchema` (`:88`), образцы ключей:
  `shopTributeUrl` (`:220`), `homeChannelUrl` (`:253`), `adsTestMode`
  (`boolean` без окружения). Виды настроек — `SettingKind`
  (`:21`: `chat | boolean | url | number`); панель знает их по списку в
  `apps/admin/src/api/settings.ts:19` и по `settingProblem` (`:64`),
  `SETTING_PLACEHOLDER` (`:81`).
- Карусель главной: `home/home-slides.ts:71–73` (слайд канала —
  образец), `home/home.service.ts:70–72` (чтение настроек и сбор
  источников через `source(...)` с таймаутом). Слайдов не больше
  `HOME_SLIDES_MAX = 5`.
- Закрытие покупок: `AccountRestrictions.status(accountId, "purchases")` — не
  `null`, если закрыто (`restrictions/account-restrictions.ts:56`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция** — одна, через `prisma migrate dev --create-only`, **один
   раз**; после — проверить, что новая папка `*_donations` ровно одна:
   - `ALTER TYPE "PurchaseProduct" ADD VALUE 'donation';`
   - `ALTER TABLE "account" ADD COLUMN "supporter_at" TIMESTAMPTZ(3);`
   Новое значение перечисления в этой же миграции не использовать.
   В `schema.prisma` — значение `donation` с комментарием и поле
   `supporterAt DateTime? @map("supporter_at") @db.Timestamptz(3)` с
   комментарием «знак «Поддержал проект» (Р109): когда подтверждён первый донат; снимается внешним возвратом».
3. **`payments/purchase-types.ts`** — `"donation"` в `PurchaseProduct`.
   **`payments/payments.service.ts`** — публичный `canPay(account): boolean`
   (стоп-кран включён, у площадки есть провайдер, и он принимает этого
   игрока) — то же условие, что в начале `shopInvoice`, но без исключений:
   по нему решается, показывать ли звёздную часть.
4. **Воронка.** `payments-hooks.ts` — `product: PurchaseProduct` в
   `PaidPurchase`; `payment-confirmation.ts:119` — заполнить из
   `outcome.purchase.product`. `funnel-tracker.ts` — донат пропускать
   (`purchase.product === "donation"`), с комментарием «поддержка, а не
   покупка (Р109)».
5. **Ключи каталога** (`setting-catalog.ts`), группа `const DONATE_GROUP =
   "Донаты"`:

   | Ключ | Вид | Название в панели | Умолчание |
   |---|---|---|---|
   | `donate.amounts` | `amounts` (новый) | Готовые суммы доната, ⭐ | `50, 100, 250, 500, 1000` |
   | `donate.tribute-url-telegram` | `url` | Tribute для Telegram | пусто |
   | `donate.tribute-url-web` | `url` | Tribute для веба | пусто |
   | `donate.home-slide` | `boolean` | Слайд доната в карусели главной | выключено |

   Подсказки: «Кнопки сумм на листе доната через запятую, до восьми,
   например 50, 100, 250. Суммы вне пределов способа оплаты площадки не
   показываются», «Кнопка «Поддержать через Tribute» у игроков Telegram —
   ссылка https://… Пусто — кнопки нет», «То же для игроков в вебе. Пусто —
   кнопки нет», «Слайд «Поддержать проект» в карусели главной. Показывается,
   только если у игрока есть хоть один способ поддержать».
   - `SettingKind` получает `"amounts"`. Схема значения: строка,
     разбор `parseAmounts(value): number[] | null` в
     `donations/donation-amounts.ts` — целые 1…100000, от одной до восьми,
     через запятую с пробелами или без; иначе схема отклоняет с текстом
     «от одной до восьми сумм через запятую, например 50, 100, 250».
   - Окружения у ключей нет.
6. **Панель** (`apps/admin/src/api/settings.ts`,
   `screens/settings/SettingsScreen.tsx`): `"amounts"` в `z.enum` вида;
   `settingProblem` — для `amounts` тот же текст и то же правило, что на
   сервере (копия правила, пакетов между ними нет); `SETTING_PLACEHOLDER` —
   `amounts: "50, 100, 250"`; в `SettingsScreen` вид `amounts` редактируется
   текстовым полем шириной как у `chat` (`w-56`), `maxLength` 40. Подпись
   значения в списке — как у строки.
7. **Модуль `donations/`** (`donations.module.ts`, подключить в
   `app.module.ts`; импортирует `AuthModule`, `PaymentsModule`,
   `RestrictionsModule`, `SettingsModule`; экспортирует `DonationsService`):
   - `donation-amounts.ts` — `parseAmounts`, `presetsFor(raw, min, max)`:
     разбор, отбрасывание вне `min…max`, дубликатов, сортировка по
     возрастанию;
   - `donations.repository.ts` (Prisma, все вызовы с таймаутом
     `withTimeout`, 3 с):
     - `isSupporter(accountId): Promise<boolean>`;
     - `markSupporter(accountId, at)` — `UPDATE account SET supporter_at = at
       WHERE account_id = … AND supporter_at IS NULL`: дата первого донатa не
       перезаписывается, повтор безвреден;
     - `clearSupporterUnlessOther(accountId, exceptPurchaseId)` — одной
       транзакцией: если у аккаунта нет другой оплаченной и не возвращённой
       покупки `product = 'donation'`, `supporter_at = NULL`; возвращает
       `boolean` — снят ли знак;
   - `donations.service.ts`:
     ```ts
     interface DonationView {
       /** звёздная часть; null — оплата выключена, площадка без способа, платить нечем или покупки закрыты */
       stars: { min: number; max: number; presets: number[]; mode: PaymentMode } | null;
       /** ссылка Tribute для площадки игрока и её разрез в аналитике; null — кнопки нет */
       tribute: { url: string; way: "tribute_telegram" | "tribute_web" } | null;
       /** аккаунт уже поддержал проект */
       supporter: boolean;
     }
     ```
     - `view(account)` — `stars` не `null`, если `payments.canPay(account)`,
       `methodFor(platform)` есть и `restrictions.status(accountId,
       "purchases")` — `null`; `min`/`max` — `Number(method.minAmount)` /
       `Number(method.maxAmount)`; `mode` — `payments.mode`. `tribute` —
       `{ url, way }`: `donate.tribute-url-telegram` и `tribute_telegram` для
       `telegram`, `donate.tribute-url-web` и `tribute_web` для `web`, `null`
       для остальных и для пустой строки;
     - `order(account, amount, at)`: `restrictions.ensure(accountId,
       "purchases", at)`; способа площадки нет — `PaymentsUnsupportedError`;
       сумма не целая или вне `min…max` — `ValidationError("Некорректная сумма")`;
       затем `payments.shopInvoice(account, { product: "donation", sku:
       "donation", priceStars: amount, once: false, text: { title:
       "Поддержка проекта", description: "Добровольный взнос на развитие
       «Рубежа». Игровых наград за него нет — только благодарность и знак
       «Поддержал проект»." } })`. Название — до 32 знаков (предел Telegram).
       Лог `donation_order` с `accountId`, `purchaseId`, `stars`, `status`;
     - `onModuleInit`: `fulfillment.register("donation", ...)` — `markSupporter(
       purchase.accountId, purchase.paidAt ?? new Date())`, лог
       `donation_fulfilled`; `revocation.register("donation", ...)` —
       `clearSupporterUnlessOther(...)`, строки отзыва: «знак «Поддержал
       проект» снят» или «знак остаётся: есть другой донат».
   - `donations.controller.ts`, `@Controller("donations")`, `@UseGuards(AuthGuard)`:
     - `GET /api/v1/donations` → `{ data: DonationView }`, лимит
       `{ scope: "donations:view", limit: 600, windowSec: 3600 }`;
     - `POST /api/v1/donations/orders` → `{ data: ShopInvoice }`
       (тот же вид ответа, что у `POST /shop/orders`: клиент ждёт подтверждения
       тем же `GET /api/v1/payments/:purchaseId`), тело Zod
       `z.object({ amount: z.number().int() }).strict()`, лимит
       `{ scope: "donations:order", limit: 30, windowSec: 3600 }`; ошибка тела —
       `ValidationError("Некорректная сумма")`.
   - `PaymentsModule` уже экспортирует `PaymentsService`, `PurchaseFulfillment`,
     `PurchaseRevocation` (`payments.module.ts:60`) — дописывать экспорты не нужно;
     проверить это в интеграционном тесте модуля (сервис поднимается с реальной
     выдачей, не `@Optional()`-пустышкой).
8. **Слайд главной.** `home-slides.ts` — вид `{ id: "donate"; kind: "donate" }`
   в `HomeSlide`, поле `donate: boolean` в `HomeSources`, слайд добавляется
   сразу после слайда канала (`:73`), до партнёрского задания. `home.service.ts` —
   `donate = settings.get(donateHomeSlide) && (view.stars !== null || view.tribute !== null)`,
   вид — `this.source("donations", () => this.donations.view(account), null)`;
   ответ не пришёл — слайда нет. `home.module.ts` — импорт
   `DonationsModule`.
9. **Аналитика и панель игроков.** `events/event-dictionary.ts` — событие
    `donation_link_clicked` (раздел «Аналитика»). `apps/admin/src/api/players.ts:223`
    — `purchaseLabel` для `product === "donation"` возвращает `"донат"`.
10. **Документы** (раздел «Документы»).

## Чего не трогаем

- Клиент (`packages/app-shell`): экраны, слайд, знак — T-0158.
- Каталог магазина и `ShopService`: донат — не товар витрины.
- Показ знака в ответах входа, рейтинга и сезонов, `account.repository.ts`,
  `shared-types`: T-0161.
- Друзья и уведомления: знак там не показывается, бот донатору не пишет.
- Ссылку `shop.tribute-url` («звёзды дешевле через Tribute») — другая функция.
- Бухгалтерию: модуля нет (`docs/37-accounting.md` — черновик); задача лишь
  держит донат отдельным видом покупки, чтобы статья была готова.
- Ручную выдачу знака тем, кто задонатил через Tribute: решение
  claude-lead-1 от 19.10.2026 — не в этих задачах, тимлид заведёт пункт во
  входящих.

## Тесты

Пишутся первым коммитом, до кода.

- `donations.test.ts` (подмены):
  - `parseAmounts("50, 100,250")` → `[50, 100, 250]`; `""`, `"abc"`, `"0, 5"`,
    `"1.5"`, девять сумм, `"100001"` → `null`;
  - `presetsFor("1000, 50, 50, 20000, 5", 1, 10000)` → `[5, 50, 1000]`;
  - схема `donate.tribute-url-*`: `http://…` отклоняется, `https://t.me/tribute/…` и
    пусто проходят;
  - `view` для Telegram при включённой оплате → `stars` с `min 1`, `max 10000`,
    `presets` из настройки, `mode`; `tribute` — ссылка Telegram;
  - стоп-кран выключен (`canPay` ложно) → `stars: null`, `tribute` остаётся;
  - площадка `web` → `stars: null`, `tribute` — ссылка веба; `max`, `vk` → оба
    `null`; пустая ссылка → `tribute: null`;
  - закрыты покупки → `stars: null`, `tribute` остаётся;
  - `supporter` отражает флаг аккаунта;
  - `order`: суммы `0`, `-5`, `1.5`, `10001` → `ValidationError`; `1` и `10000` →
    `shopInvoice` вызван с `product "donation"`, `sku "donation"`, `priceStars` =
    сумме, `once false`, название не длиннее 32 знаков; закрыты покупки →
    отказ ограничения до `shopInvoice`; площадка без способа →
    `PaymentsUnsupportedError`; оплата выключена → `DisabledError` из
    `shopInvoice` доходит как есть;
  - выдача: `fulfill` ставит знак; повторный вызов с другой датой дату не
    меняет; отзыв при единственном донате снимает знак, при другом оплаченном не
    возвращённом — оставляет, строка отзыва говорит, что произошло;
  - воронка: `emitPaid` с `product "donation"` не вызывает `firstPurchase`; с
    `shop_item` — вызывает (`funnel.test.ts`);
  - `payment-confirmation.test.ts`: `emitPaid` несёт `product`;
  - карусель: `pickSlides` с `donate: true` кладёт слайд сразу после канала и до
    задания; `donate: false` — слайда нет; при пяти слайдах до него, донат
    отрезается `HOME_SLIDES_MAX`; `home.test.ts` — настройка выключена или
    `view` вернул `stars: null` и `tribute: null` → слайда нет, ответ главной не упал;
- `donations.integration.test.ts` (живой Postgres, `TEST_DATABASE_URL`, как
  `shop.integration.test.ts`):
  - два счёта `donation` на сумму 50 одного аккаунта → две разные строки
    (`onceKey` пуст);
  - донат с `runId` отклоняется базой (`purchase_continue_check`);
  - 20 параллельных `markSupporter` с разными датами → знак стоит, дата — одна из
    них и не меняется после ещё одного вызова;
  - `clearSupporterUnlessOther`: единственный оплаченный донат → знак снят;
    второй оплаченный и не возвращённый → знак остаётся; второй возвращённый → снят;
  - после миграции значение `donation` есть в перечислении, колонка
    `supporter_at` есть.
- `donations.http.test.ts`:
  - `GET /api/v1/donations` и `POST /api/v1/donations/orders` без токена → 401;
  - тело без `amount`, со строкой, с лишним полем → 400;
  - превышение лимита заказов → 429;
  - оплата выключена → `POST` отвечает 404 `endpoint_disabled`, `GET` — 200 с
    `stars: null`.
- `apps/admin/test/settings.test.ts`: `settingProblem({kind: "amounts"}, …)` — те же
  случаи, что в `parseAmounts`; `apps/admin/test/players.test.ts`: `purchaseLabel`
  для `donation` → `"донат"`.

## Аналитика

- Новое событие в `event-dictionary.ts` и в Zod-схеме до кода:
  `donation_link_clicked`, версия 1 — нажатие кнопки Tribute (оплата идёт вне
  игры, и клик — всё, что видно). Поля: `way` — `tribute_telegram` или
  `tribute_web`; `place` — `about`, `profile`, `home`. Шлёт клиент (T-0158).
- Оплата звёздами идёт в существующие `purchase_initiated` /
  `purchase_completed` / `purchase_failed` с `product = "donation"`,
  `sku = "donation"`, `priceStars` — суммой (T-0158). Выручка и возвраты — по таблице
  `purchase`, `product = 'donation'`, только `mode = live`.
- Слайд — существующие `home_slide_viewed` / `home_slide_clicked` со `slide = "donate"`.
- Серверные строки лога: `donation_order`, `donation_fulfilled`, `supporter_revoked`
  (метрик Prometheus нет: счётчик по аккаунту — высокая кардинальность).

## Настройки и окружение

Четыре ключа каталога (шаг 5): `donate.amounts`, `donate.tribute-url-telegram`,
`donate.tribute-url-web`, `donate.home-slide`. Переменных окружения нет,
предел суммы — в `PAYMENT_METHODS`. Оплата по-прежнему управляется
`payments.stars` / `PAYMENTS_ENABLED`.

## Документы

- `docs/21-diagrams.md` — ER: значение `donation` у `purchase.product`,
  `account.supporter_at`; небольшая диаграмма потока «заказ → счёт → оплата → знак»
  и отзыва знака при внешнем возврате.
- `docs/22-analytics-and-metrics.md` — §3.3: `donation_link_clicked`, в строке
  `purchase_*` добавить значение `product = donation`; §5.4: донат — вид
  покупки, не входит в FTD и в «платящих» (Р109), в выручке — отдельная строка.
- `docs/30-configuration-map.md` — четыре ключа группы «Донаты», предел суммы в
  `payment-methods.ts`.
- `docs/37-accounting.md` — §3 («Выручка»): статья «Донаты, Telegram»
  отдельно от «Магазин, Telegram»; §8: проводка берёт вид покупки `donation`.
- `docs/07-monetization-and-ads.md` — абзац «Донаты» (Р109): поддержка без
  игровой ценности.
- `docs/35-stage4-plan.md` — Р109 не менять; если уточнения выше противоречат
  тексту, остановиться и спросить.

## Критерии приёмки

- [ ] Игрок Telegram с включённой оплатой получает `stars` с пределами
  способа и готовыми суммами из настройки; счёт на любую целую сумму в
  пределах выставляется, вне пределов — 400.
- [ ] Подтверждённая оплата ставит знак один раз; повтор и параллельные вызовы
  дату не меняют.
- [ ] Внешний возврат единственного доната снимает знак, при другом донате —
  нет.
- [ ] Донат не отмечает первую покупку воронки; остальные товары — как прежде.
- [ ] При выключенной оплате `stars: null`, заказ отвечает 404 `endpoint_disabled`,
  ссылки Tribute в ответе остаются.
- [ ] Ссылка веба и Telegram — по площадке, у MAX и VK ссылок нет, пустая —
  `null`.
- [ ] Слайд `donate` стоит после канала, пропадает при выключенной настройке и
  когда способов нет.
- [ ] Панель принимает и проверяет ключ-список сумм.
- [ ] Миграция одна, значение перечисления не используется в ней самой.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные, интеграционные тесты — на
  живом Postgres.

## PR

- **Заголовок:** `feat(donations): Донаты проекту на сервере`
- **Метка:** `release: minor`
- **Для игроков:** нет — кнопки и знак появятся с задачей клиента
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДОНАТЫ ПРОЕКТУ НА СЕРВЕРЕ**

  Сервер принимает донат звёздами на любую сумму от 1 до предела площадки и ставит игроку знак «Поддержал проект». Игровых наград за донат нет. Донат лежит в покупках отдельным видом и в первую покупку воронки не входит.

  🛠 **Настройки в панели, группа «Донаты»**

  • готовые суммы, ссылки Tribute для Telegram и веба, слайд в карусели главной (по умолчанию выключен)
  • оплата звёздами по-прежнему включается стоп-краном «Оплата звёздами»

  ❓ **Нужно от команды**

  • @участник1 — вписать ссылки Tribute в панель, когда они появятся
  ```
