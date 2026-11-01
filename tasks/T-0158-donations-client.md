---
id: T-0158
title: Донаты проекту — клиент: лист доната, ссылки Tribute, знак, благодарность, слайд
epic: E1
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0157, T-0161, T-0188, T-0190]
zones:
  - packages/app-shell/src/state/donations-api.ts
  - packages/app-shell/src/state/shop-purchase.ts
  - packages/app-shell/src/state/auth-api.ts
  - packages/app-shell/src/state/runs-api.ts
  - packages/app-shell/src/state/home-api.ts
  - packages/app-shell/src/screens/meta/donate-block.tsx
  - packages/app-shell/src/screens/meta/donate-sheet.tsx
  - packages/app-shell/src/screens/meta/donate-rules.ts
  - packages/app-shell/src/screens/meta/supporter-badge.tsx
  - packages/app-shell/src/screens/meta/profile.tsx
  - packages/app-shell/src/screens/meta/rating.tsx
  - packages/app-shell/src/screens/settings.tsx
  - packages/app-shell/src/screens/home-slide.tsx
  - packages/app-shell/src/screens/home-carousel.tsx
  - packages/app-shell/src/i18n/donate.ts
  - packages/app-shell/src/i18n/ru-donate.json
  - packages/app-shell/test/donations-api.test.ts
  - packages/app-shell/test/donate-rules.test.ts
  - packages/app-shell/test/home-api.test.ts
  - packages/app-shell/test/home-carousel.test.ts
  - packages/app-shell/test/session.test.ts
  - packages/app-shell/test/shop.test.ts
shared:
  - packages/app-shell/src/state/analytics.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/i18n/ru-home.json
  - packages/app-shell/src/i18n/ru-history.json
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/art/mockups/donate-v2.html
batch: 3
---

# T-0158. Донаты проекту — клиент: лист доната, ссылки Tribute, знак, благодарность, слайд

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0158.json)](README.md#значки-статуса) [![T-0157](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0157.json&label=T-0157)](archive/T-0157-donations-backend.md) [![T-0161](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0161.json&label=T-0161)](T-0161-supporter-badge-api.md) [![T-0188](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0188.json&label=T-0188)](archive/T-0188-hide-changelog-for-players.md) [![T-0190](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0190.json&label=T-0190)](T-0190-single-difficulty-shell.md)

## Зачем

Клиентская половина Р109 (`docs/35-stage4-plan.md`) поверх API T-0157 и T-0161: игрок
может поддержать проект на «Об игре» и в профиле (и со слайда главной, если его
включили), видит благодарность и знак «Меценат» в профиле и рейтинге.

## Решения

Из Р109 (19.10.2026) и контракта T-0157:

- Донат — поддержка, а не покупка. Игровых ценностей нет, об этом сказано
  прямо в тексте блока.
- Данные одним запросом `GET /api/v1/donations` → `{ stars: { min, max, presets, mode } | null,
  tribute: { url, way } | null, supporter: boolean }`. Решает сервер: клиент не
  проверяет площадку, стоп-кран оплаты и закрытые покупки сам.
- Суммы — готовые кнопки `presets` и своя сумма целым числом от `min` до
  `max`. Заказ — `POST /api/v1/donations/orders { amount }` → тот же `ShopInvoice`, что
  у магазина; окно оплаты площадки, ожидание подтверждения и события
  `purchase_*` — готовая `buy()` из `state/shop-purchase.ts` с `product: "donation"`.
- Ссылка Tribute — одна на игрока (сервер уже выбрал Telegram или веб); пустая —
  кнопки нет; открывается `openExternalLink` в том же нажатии
  (`state/external-link.ts`), как плашка Tribute в магазине
  (`screens/meta/shop.tsx:190–198`). Только `https`.
- **Оплата выключена или платить нечем** (`stars: null`): кнопки сумм и «Поддержать»
  звёздами нет; если есть ссылка Tribute — остаётся только её кнопка; если нет
  ничего — блок «Поддержать проект» не показывается вовсе (ни на «Об игре», ни в
  профиле), а слайд не приходит с сервера. Мёртвой кнопки не бывает.
- **Нет сети или ответ не разобрался** — блок не показывается, ошибки нет: поддержка не
  критична и не должна пугать красным.
- Знак — `account.supporter === true` в сессии (вход) и `entry.supporter === true` в
  рейтинге. После успешного доната знак ставится в сессию сразу, не дожидаясь
  следующего входа.
- Слайд `donate` включает панель (`donate.home-slide`), клиент рисует то, что пришло.
- Решение claude-lead-1 от 19.10.2026: экран называется «Об игре» (`about`),
  как в коде; не переименовываем, в тексте Р109 «О проекте» — то же место.
- Решение claude-lead-1 от 19.10.2026: донат — не покупка (в первую покупку
  воронки и в «платящих» не входит, T-0157); знака за донат по ссылке Tribute
  нет, поэтому игроку, который платил только через Tribute, блок не говорит,
  что знак уже у него.
- Показ знака в сессии, рейтинге и сезонах на сервере — T-0161; задача ждёт её
  вместе с T-0157.

## Ответы на открытые вопросы (31.10.2026)

Решения `claude-lead-1` (за дизайнера) от 31.10.2026, макет —
`design/art/mockups/donate-v2.html`:

1. **Макет готов**: блок на «Об игре» и в профиле во всех состояниях, лист
   доната (выбор суммы, своя сумма вне пределов, оплата идёт, ошибка, тестовая
   оплата), «Спасибо!», знак в профиле и в строке рейтинга, слайд, 768 и 1440.
   Экраны плоские, как настройки: донат — благодарность, а не награда,
   реликвии нет.
2. **Знак в строке рейтинга — только сердцем, на всех ширинах.** Строка несёт
   имя, «Тестер» и «Ты»; слово на 320 съело бы имя. Сердце — квадрат 16 px с
   рамкой, как у «Тестера», `aria-label` и `title` — «Меценат»; знаки не
   сжимаются, обрезается имя. В профиле и в «Спасибо!» — со словом.
3. **Имя знака — «Меценат»**, а не «Поддержал проект»: так статусный знак
   назван в Р149 и в каталоге знаков T-0235 (`emb_supporter`), а «Поддержал»
   несёт род игрока, что запрещает Р163. Ключ `supporter.badge` остаётся.
4. **Тексты утверждены** — таблица ниже, на «ты» и без рода игрока (Р163).

## Как сейчас

- `packages/app-shell/src/screens/settings.tsx:280–307` — `AboutScreen`: эмблема,
  версия сборки, сведения о тесте, лицензии. Точка входа — строка «Об игре»
  в настройках (`:178`).
- `screens/meta/profile.tsx:76–131` — карточка игрока; знак «Тестер» стоит в
  строке имени (`:85`); внизу заглушка «Скоро» (`:131–139`).
- `screens/meta/tester-badge.tsx` — образец знака: тон, размер `s`/`l`,
  `lucide-react`-значок; слово знака лежит в основном словаре `ru.json:135`
  (`tester.badge`), остальное — своим словарём `ru-tester.json` + `i18n/tester.ts`.
- `screens/meta/rating.tsx:158–195` — `LeaderboardRow`: имя, `TesterBadge` (`:177`),
  метка «Вы».
- `state/auth-api.ts:30,108` — `tester` в типе и в схеме аккаунта сессии;
  `state/runs-api.ts:50` — `tester` в схеме записи рейтинга.
- `state/shop-purchase.ts:22,36` — `ShopProduct = "shop_item" | "vip"` и `buy(request, deps)`:
  счёт, окно оплаты, ожидание подтверждения (опрос раз в секунду, до 45 с),
  события `purchase_initiated` / `completed` / `failed`; `BuyOutcome` —
  `done` / `cancelled` / `retry` / `refused`.
- `state/shop-api.ts` — `createShopApi()`: `purchase(purchaseId)` опрашивает
  `GET /api/v1/payments/:id`; `isDelivered`.
- `screens/meta/shop.tsx:68,105` — `useRestricted(["purchases"])` и повторная
  проверка ограничения: образец для закрытых покупок; `shop-texts.ts:26–39` —
  `noticeOf(outcome, name)` по исходам `buy()`.
- Карусель: `state/home-api.ts:38` — схема слайда канала; `screens/home-slide.tsx:26,73,194–197` —
  тон, значок и заголовок по `home.slide.<вид>.title`; `home-carousel.tsx:156–180` —
  касание по слайду, `slideEvent` (`:132`).
- Диалоги — `Modal` из `design-system/components` (`Surfaces.tsx:145`).
- История: заголовок покупки — `history.purchase.<product>`
  (`screens/meta/history.tsx:137`), для незнакомого вида — «Покупка».

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`state/donations-api.ts`** — по образцу `shop-api.ts`: Zod-схема `DonationView`
   (поля необязательные по смыслу сервера новее клиента: `stars` и `tribute`
   `nullable`, `supporter` `boolean`), `createDonationsApi(request)`:
   `view()`, `order(amount)`. Грузится вместе с блоком, в первую загрузку не
   попадает.
3. **`state/shop-purchase.ts`** — `"donation"` в `ShopProduct`. Больше ничего:
   `buy()` годится как есть.
4. **`screens/meta/donate-rules.ts`** — чистые функции:
   - `parseAmount(text: string, min, max): { ok: true; amount: number } | { ok: false }` —
     только цифры, без пробелов по краям, целое, в пределах; пусто — `{ ok: false }`;
   - `visibleWays(view): { stars: boolean; tribute: { url: string; way: string } | null }` —
     `stars` истинно, если `view.stars !== null`; `tribute` — только если `url` —
     `https`-ссылка, иначе `null`;
   - `hasAnyWay(view)` — есть хоть один способ: блок рисуется только тогда.
5. **`screens/meta/donate-block.tsx`** — `DonateBlock({ place: "about" | "profile" })`:
   загружает `view()` при монтировании; нет способов, нет сети, ошибка — `null`.
   Иначе карточка: заголовок, текст про «не покупка», кнопка «Поддержать» (если
   `stars`) — открывает лист; кнопка «Поддержать через Tribute» (если
   `tribute`) — `openExternalLink` в том же нажатии и `track("donation_link_clicked",
   { way: tribute.way, place })`. Поддержавшему игроку заголовок остаётся тем же, под ним —
   знак «Меценат» и строка `donate.already`, кнопка — `donate.again`. В профиле у
   поддержавшего абзаца `donate.text` нет — только строка и кнопка (макет, раздел 2).
   Шапка карточки — сердце в круге тоном здоровья и заголовок; отдельного
   заголовка раздела над карточкой нет. От 768 px кнопки встают в ряд, Tribute
   подписан `donate.tribute.short`.
6. **`screens/meta/donate-sheet.tsx`** — `Modal` с готовыми суммами (`presets`),
   полем «Своя сумма» (`inputMode="numeric"`, `maxLength` по числу знаков `max`),
   кнопкой «Поддержать на {n} ⭐» (неактивна, пока сумма не прошла `parseAmount`:
   нейтральная, подпись `donate.pay.idle`, причина — строкой ошибки под полем).
   Первой выбрана вторая готовая сумма, если она есть, иначе первая. «Своя» —
   последней плиткой (`donate.custom`), поле подписано `donate.custom.label`.
   Пока открыто окно оплаты и ждём подтверждения — кнопка `donate.paying` со
   спиннером, суммы не нажимаются: второе нажатие не создаёт второй счёт.
   На 320 px сердце над заголовком листа не рисуется (клавиатура).
   Нажатие вызывает `buy({ product: "donation", sku: "donation", priceStars: n,
   chargedStars: mode === "test" ? 1 : n, mode, order: () => api.order(n) }, deps)` и
   по исходу:
   - `done` — экран «Спасибо» в этом же листе, `useSession` ставит
     `account.supporter = true`;
   - `cancelled` — лист остаётся как был;
   - `retry` — сообщение `donate.retry.<reason>`, сумма не сбрасывается;
   - `refused` — `donate.refused.<code>` или общий `donate.refused`.
   Закрыт лист в процессе оплаты — не закрываем окно оплаты площадки, а ожидание
   подтверждения идёт дальше (так же, как в магазине). При `mode: "test"` — строка
   «Тестовая оплата: звезда вернётся» (как плашка магазина).
   Лист подгружается лениво — в первую загрузку не попадает; `pnpm budget` не
   должен подняться.
7. **Знак.** `screens/meta/supporter-badge.tsx` — `SupporterBadge({ size, iconOnly })` по
   образцу `TesterBadge`: подложка `bg-hp/15 ring-1 ring-hp/40`, значок `Heart`
   тоном `text-hp`, **слово — `text-text`** (розовое слово на подложке даёт 4,3:1
   при норме 4,5:1). `iconOnly` — в строке рейтинга: одно сердце, `aria-label` и
   `title` — слово знака. Слово знака — `supporter.badge` в
   `ru.json` рядом с `tester.badge`. `state/auth-api.ts` и `state/runs-api.ts` —
   `supporter` в схемах (необязательный `literal(true)`) и в типе
   `AuthAccount`/записи рейтинга (типы берутся из `@bh/shared-types`, T-0161).
   Подставить знак в `profile.tsx:85` (`size="l"`) и `rating.tsx:177` (`iconOnly`)
   после «Тестера»; оба знака сочетаются.
8. **Места блока:** `settings.tsx` — `AboutScreen`, между сведениями о сборке и
   разделом о тесте; `profile.tsx` — ниже последних забегов, выше заглушки
   «Скоро».
9. **Слайд.** `state/home-api.ts` — `z.object({ id, kind: z.literal("donate") })`;
   `home-slide.tsx` — тон `bg-hp/15 text-hp` в `TONE`, значок `Heart` из `lucide-react`, ключи
   `home.slide.donate.title/text` в `ru-home.json`; `home-carousel.tsx` — касание по слайду
   открывает `DonateSheet` (лениво) на главной; `slideEvent` менять не нужно.
10. **Словарь.** `i18n/ru-donate.json` + `i18n/donate.ts` по образцу `tester.ts`
    (тексты листа и блока); `supporter.badge` — в `ru.json`;
    `home.slide.donate.*` — в `ru-home.json`; `history.purchase.donation` —
    в `ru-history.json`.
11. **Документ.** `docs/27-design-system-and-app-shell.md` — строки «Об игре»,
    «Профиль», «Рейтинг», «Главная» в таблице экранов: блок доната, знак, слайд.

## Тексты (утверждены 31.10.2026)

На «ты» и без рода игрока (Р163); тот же список — в макете, раздел 6.

| Ключ | Текст |
|---|---|
| `donate.title` | Поддержать проект |
| `donate.text` | «Рубеж» делает небольшая команда. Донат — не покупка: игровых наград за него нет, зато у тебя появится знак «Меценат». Спасибо, что играешь. |
| `donate.cta` | Поддержать |
| `donate.again` | Поддержать ещё |
| `donate.tribute` | Поддержать через Tribute |
| `donate.tribute.short` | Через Tribute |
| `donate.already` | Спасибо за поддержку — знак уже у тебя |
| `donate.sheet.title` | Поддержать проект |
| `donate.sheet.hint` | Любая сумма в звёздах: от {min} до {max} ⭐ |
| `donate.custom` | Своя |
| `donate.custom.label` | Своя сумма |
| `donate.custom.invalid` | Сумма — целое число от {min} до {max} ⭐ |
| `donate.pay` | Поддержать на {n} ⭐ |
| `donate.pay.idle` | Поддержать |
| `donate.paying` | Ждём оплату… |
| `donate.test` | Тестовая оплата: звезда вернётся |
| `donate.thanks.title` | Спасибо! |
| `donate.thanks.text` | Поддержка «Рубежа» дошла — это правда помогает делать игру дальше. |
| `donate.thanks.badge` | Знак уже в профиле и в рейтинге |
| `donate.close` | Закрыть |
| `donate.retry.offline` | Нет связи. Звёзды не списаны — попробуй ещё раз |
| `donate.retry.payment_failed` | Оплата не прошла. Попробуй ещё раз |
| `donate.retry.slow_confirmation` | Оплата ещё подтверждается — знак появится сам, повторять не нужно |
| `donate.refused` | Не получилось оформить поддержку. Попробуй позже |
| `donate.refused.endpoint_disabled` | Оплата сейчас недоступна. Попробуй позже |
| `donate.refused.payments_unsupported` | Оплата звёздами доступна только в Telegram |
| `supporter.badge` | Меценат |
| `home.slide.donate.title` | Поддержать проект |
| `home.slide.donate.text` | Знак «Меценат» и наше спасибо |
| `history.purchase.donation` | Поддержка проекта |

`donate.retry.slow_confirmation` — плашкой тоном информации и без повторной
кнопки; остальные `retry` и `refused` — плашкой тоном опасности над кнопкой.

## Чего не трогаем

- Серверные контракты и ключи панели: T-0157; знак в ответах сервера: T-0161.
- Магазин и его плашку Tribute (`shop.tribute-url`): другая функция.
- Друзья: знак там не показываем (Р109 — профиль и рейтинг).
- Экран сезонов: клиента сезонов в приложении пока нет.
- Игровые награды за донат: их нет и не будет (Р109).

## Сценарий и интерфейс

Макет — `design/art/mockups/donate-v2.html`.

1. Игрок открывает «Об игре» или профиль. Блок появляется, когда есть способ.
2. «Поддержать» → лист с суммами. Выбрал готовую или набрал свою → «Поддержать
   на N ⭐» → окно оплаты Telegram → «Спасибо!» в листе → знак в профиле сразу.
3. «Поддержать через Tribute» → ссылка открывается площадкой; в игре ничего
   не меняется, знака за это нет.

Состояния:
- **загрузка** блока — места не занимает (блок появляется после ответа);
- **пусто** (нет способов, оплата выключена, покупки закрыты без Tribute) — блока нет;
- **ошибка** оплаты — сообщение в листе, сумма остаётся;
- **нет сети** — на блоке: блока нет; в листе при заказе: `donate.retry.offline`;
- **ограничение аккаунта** («Покупки» закрыты) — сервер вернул `stars: null`:
  остаётся только Tribute, если он есть;
- **оплата подтверждается долго** — `donate.retry.slow_confirmation`;
- **тестовая оплата** — подпись `donate.test`.

## Тесты

Пишутся первым коммитом, до кода.

- `donate-rules.test.ts`: `parseAmount("100", 1, 10000)` → `100`; `"0"`, `"10001"`, `"1.5"`,
  `" 5"`, `"-3"`, `"abc"`, `""` → `ok: false`; `"1"` и `"10000"` проходят;
  `visibleWays` — `stars: null` и пустая ссылка → ничего; `http://…` отбрасывается;
  `hasAnyWay` — только Tribute → истинно, только звёзды → истинно, ничего → ложно.
- `donations-api.test.ts` (подмена `request`): схема принимает ответ с `stars: null`,
  с `stars`, без `tribute`; отвергает `presets` не списком; `order(250)` шлёт
  `POST /api/v1/donations/orders` с телом `{ amount: 250 }`.
- `shop.test.ts`: `buy()` с `product: "donation"` шлёт события `purchase_initiated` /
  `purchase_completed` с `product: "donation"`, `sku: "donation"`, и `priceStars` равна сумме
  (подмена `track`); исход `refused` с кодом `endpoint_disabled` не повторяется.
- `session.test.ts`: вход с `supporter: true` кладёт флаг в `account`; без поля — флага нет;
  после успешного доната `account.supporter` истинно.
- `home-api.test.ts`: слайд `donate` разбирается; неизвестный вид по-прежнему отбрасывается,
  как до этого.
- `home-carousel.test.ts`: слайд `donate` в списке на своём месте, касание вызывает
  открытие листа, `home_slide_clicked` уходит со `slide: "donate"`.
- Рейтинг и профиль: запись со `supporter: true` рисует знак, без — нет;
  знаки «Тестер» и «Меценат» вместе не ломают строку (проверка по данным, не по пикселям).
- Снимки блока, листа (все состояния из «Сценария»), экрана «Спасибо», знака в
  профиле и в рейтинге, слайда — на 320, 390, 768 и 1440 px против макета.
- `i18n.test.ts` и `i18n-chunks.test.ts` остаются зелёными: новый словарь подключён своим
  чанком.

## Аналитика

- `purchase_initiated` / `purchase_completed` / `purchase_failed` — штатно из `buy()`,
  `product = "donation"`, `sku = "donation"` (событие и поля уже в словаре).
- `donation_link_clicked { way, place }` — **заводит эта задача целиком** (поправка
  `claude-lead-1` от 21.10.2026, вопрос #430: тест `scripts/test/event-dictionary.test.ts`
  требует одновременной правки словаря сервера и списка клиента): сначала строка в
  `docs/22` §3.3, затем словарь `backend/api/src/modules/events/event-dictionary.ts` и
  Zod-схема, затем `ANALYTICS_EVENTS` в `packages/app-shell/src/state/analytics.ts`, потом
  отправка: `way` — из ответа сервера (`tribute_telegram` или `tribute_web`), `place` — `about`,
  `profile` или `home`.
- Слайд — штатные `home_slide_viewed` / `home_slide_clicked` со `slide = "donate"`.

## Настройки и окружение

Нет. Ключи панели — T-0157. В настройках игрока (`docs/27` §7.1) новых
переключателей нет: блок статичный, анимаций нет; благодарность не требует
отдельного звука.

## Документы

Шаг 11. Правила не меняются: отступы только через `--app-inset-*`,
визуальные значения только из токенов, анимируются `transform` и `opacity`.

## Критерии приёмки

- [ ] Блок «Поддержать проект» есть на «Об игре» и в профиле, когда у игрока
  есть хоть один способ, и отсутствует, когда способов нет, нет сети или ответ не
  разобрался.
- [ ] При выключенной оплате остаётся только кнопка Tribute (если ссылка задана);
  кнопок сумм нет; мёртвых кнопок нет.
- [ ] Готовая сумма и своя сумма проходят проверку пределов `min`/`max` от
  сервера; вне пределов кнопка неактивна, текст ошибки по `donate.custom.invalid`.
- [ ] Успешная оплата показывает «Спасибо!» и ставит знак в профиль без
  перезахода; закрытие окна оплаты не показывает «Спасибо».
- [ ] Знак «Меценат» виден в профиле и в строке рейтинга только у
  поддержавшего.
- [ ] Кнопка Tribute открывает ссылку в том же нажатии и шлёт
  `donation_link_clicked`.
- [ ] Слайд `donate` рисуется и открывает лист.
- [ ] Разметка работает на 320, 390, 768 и 1440 px; лист и блок — без
  горизонтального скролла.
- [ ] `pnpm budget` не превышен: лист и API подгружаются лениво.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Поддержка проекта и знак «Меценат»`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: можно поддержать проект донатом — звёздами на любую сумму или через Tribute; в «Об игре» и в профиле`
  - `- новое: знак «Меценат» в профиле и рейтинге за поддержку проекта`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОДДЕРЖКА ПРОЕКТА В ИГРЕ**

  В «Об игре» и в профиле появился блок «Поддержать проект»: донат звёздами на любую сумму и кнопка Tribute. После доната — «Спасибо» и знак «Меценат» в профиле и рейтинге. Игровых наград за донат нет.

  🛠 **Как включить**

  • ссылки Tribute и слайд в карусели — в панели, группа «Донаты»
  • пока оплата звёздами выключена, остаётся только кнопка Tribute, а без ссылки блока нет

  ❓ **Нужно от команды**

  • @владелец — вписать ссылки Tribute для Telegram и веба в панель
  ```
