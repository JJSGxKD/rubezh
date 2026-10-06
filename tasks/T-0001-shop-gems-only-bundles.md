---
id: T-0001
title: Наборы магазина только из самоцветов
epic: E1
priority: P0
status: done
owner: claude-2 / sonnet-5.5
size: S
depends_on: []
zones:
  - backend/api/src/modules/shop/shop-catalog.ts
  - backend/api/test/shop.test.ts
  - backend/api/test/shop-wallet.integration.test.ts
  - packages/app-shell/src/i18n/ru-shop.json
shared:
  - docs/35-stage4-plan.md
  - docs/30-configuration-map.md
runner: any
release: patch
design: null
---

# T-0001. Наборы магазина только из самоцветов

## Зачем

Стартовый набор (50 ⭐) и «Набор кузнеца» (150 ⭐) после оплаты **не
выдаются**: в них монеты и осколки, а кошелёк при покупке разрешает начислять
только самоцветы. Задание выдачи падает, повторяется 10 раз и бросается: игрок
заплатил и не получил ничего. Оплата звёздами сейчас выключена в панели
(`payments.stars`) до этого исправления.

## Решения

- **Р2 этапа 4 остаётся строгим** (решение пользователя 06.10.2026): монеты и
  осколки за звёзды не продаются, **в том числе внутри наборов**. Ими
  оплачивается случайное (перековка, улучшение, добыча — Р11, правило 2), и
  набор с монетами за деньги покупал бы случайное через шаг. Правило кошелька
  `EXCHANGE_RESOURCES.purchase = ["gems"]` верное — менять его **нельзя**.
- Каталог продаёт только самоцветы. Состав товара схема ограничивает
  самоцветами: монеты и осколки в каталог не записать, а ошибку ловит тест, а не
  ревью.
- **Стартовый набор:** 150 самоцветов за 50 ⭐, один раз на аккаунт. Это в 2,5
  раза выгоднее малого набора (60 самоцветов за 50 ⭐). Число рабочее (Р31), его
  можно поменять позже.
- **«Набор кузнеца» снимается с витрины целиком:** весь его смысл — материалы
  для случайного.
- Вид товара `bundle` в схеме остаётся. Он понадобится для наборов с заранее
  известным содержимым (бусты, конкретный предмет), когда такие товары появятся.

## Как сейчас

- `backend/api/src/modules/shop/shop-catalog.ts`:
  - `SHOP_RESOURCES` — `["coins", "gems", "shard_common", "shard_uncommon"]`;
  - `contentsSchema` допускает все четыре;
  - в `SHOP_SKUS` у `starter` состав `{ coins: 3_000, gems: 60, shard_common: 20 }`;
  - у `upgrade_kit` — `{ coins: 8_000, shard_common: 40, shard_uncommon: 10 }`.
- `backend/api/src/modules/shop/shop.service.ts`, `fulfill`: на каждый ресурс
  `contentsOf(sku)` вызывает `wallet.grant({ reason: "purchase", … })`.
- `backend/api/src/modules/wallet/wallet.service.ts`, `dailyCapOf` (около
  строки 212): бросает `обмен purchase не даёт coins`, потому что
  `backend/api/src/modules/wallet/wallet-limits.ts:54` — `purchase: ["gems"]`.
- `backend/api/test/shop.test.ts` подменяет кошелёк классом `FakeWallet` (строка
  57). Поэтому расхождение каталога и кошелька тестами не ловилось.
- `backend/api/test/shop.test.ts:296` ожидает, что игроку со снаряжением
  рекомендуется `upgrade_kit` (`recommendedSku` в
  `backend/api/src/modules/shop/shop-marketing.ts`).
- Тексты товаров у игрока берутся из словаря по `id`:
  `packages/app-shell/src/i18n/ru-shop.json`, ключи `shop.sku.<id>.name` и
  `shop.sku.<id>.text` (строки 64–70).
- Образец интеграционного теста кошелька на живом Postgres —
  `backend/api/test/wallet.integration.test.ts`.

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»). Они должны упасть на текущем
   каталоге.
2. `shop-catalog.ts`:
   - `SHOP_RESOURCES` → `["gems"] as const satisfies readonly WalletResource[]`;
   - `contentsSchema` → объект `.strict()` с единственным полем
     `gems: z.number().int().positive()`, обязательным. Проверка «пустой состав»
     при обязательном поле уже не нужна — убрать.
3. `shop-catalog.ts`, `SHOP_SKUS`:
   - `starter` → `contents: { gems: 150 }`, `description: "150 самоцветов — один раз на аккаунт, в 2,5 раза выгоднее малого набора."`;
     цена, `once`, `sort` и `baseRub` — без изменений;
   - запись `upgrade_kit` удалить целиком.
4. `shop-catalog.ts`, комментарий в начале файла: дописать абзац про Р2. Монеты
   и осколки за звёзды не продаются и внутри наборов: ими оплачивается
   случайное, а схема состава это держит. Без истории правок («было — стало»).
5. `packages/app-shell/src/i18n/ru-shop.json`:
   - `shop.sku.starter.text` → `"Один раз на аккаунт — самый выгодный набор самоцветов."`;
   - удалить ключи `shop.sku.upgrade_kit.name` и `shop.sku.upgrade_kit.text`.
6. Документы (раздел «Документы»).
7. Гейт.

## Чего не трогаем

- `backend/api/src/modules/wallet/wallet-limits.ts` и `wallet.service.ts`:
  правило кошелька верное.
- `shop-marketing.ts`: ветка `bundle` в `recommendedSku` остаётся, без наборов
  она просто не срабатывает.
- Довыдача или возврат уже оплаченных и не выданных покупок, в том числе по
  снятому `upgrade_kit` — это отдельная задача эпика E1 (проход по зависшим
  покупкам). Здесь их не ищем и не правим.
- Включение оплаты в панели — делает пользователь после влития.

## Тесты

Первым коммитом, до правки каталога:

1. `backend/api/test/shop.test.ts`, новый кейс «каждый товар каталога — только то,
   что кошелёк разрешает покупке (Р2)»:
   - для каждого `sku` из `SHOP_SKUS` каждый `resource` из `contentsOf(sku)`
     входит в `EXCHANGE_RESOURCES.purchase` (импорт из
     `../src/modules/wallet/wallet-limits.js`);
   - каждый элемент `SHOP_RESOURCES` тоже входит туда.

   Сейчас падает на `starter`.
2. `backend/api/test/shop.test.ts`, новый кейс «схема не пропустит монеты и
   осколки в составе»:
   - `shopSkuSchema.safeParse` у копии `starter` с `contents: { gems: 10, coins: 100 }`
     и с `contents: { shard_common: 5 }` → `success: false`;
   - с `contents: { gems: 10 }` → `success: true`.

   Сейчас первые два варианта проходят, поэтому кейс падает.
3. `backend/api/test/shop.test.ts:296`: ожидание для `{ owned: new Set(["starter"]), equipped: 2 }`
   → `"gems_700"` (лучшая цена). Остальные ожидания кейса не меняются.
4. Новый файл `backend/api/test/shop-wallet.integration.test.ts` на живом
   Postgres, `describe.skipIf(DATABASE_URL === "")` по образцу
   `wallet.integration.test.ts`. Кейс «каждый товар каталога выдаётся настоящим
   кошельком, и повтор не удваивает»:
   - завести аккаунт;
   - для каждого `sku` из `SHOP_SKUS` и каждого ресурса `contentsOf(sku)` вызвать
     настоящий `WalletService.grant`:
     ```ts
     { accountId, resource, amount, reason: "purchase", source: `shop:${sku.id}`, idempotencyKey: `purchase:${purchaseId}:${resource}` }
     ```
     `purchaseId` — `randomUUID()` на товар;
   - баланс самоцветов вырос ровно на сумму составов;
   - повтор тех же вызовов возвращает `duplicate: true`, и баланс не меняется.

   Сейчас падает на `starter`.

## Аналитика

Нет: события магазина не меняются.

## Настройки и окружение

Нет.

## Документы

- `docs/35-stage4-plan.md`:
  - строка решения **Р2** в таблице решений (около строки 159): дописать
    предложение «Монеты и осколки за звёзды не продаются и внутри наборов: ими
    оплачивается случайное (06.10.2026).»;
  - раздел «Как сделано» WP10, абзац «Каталог» (около строк 1777–1781): убрать
    набор кузнеца; стартовый — «150 самоцветов за 50 ⭐».
- `docs/30-configuration-map.md`, строка «Магазин: товары, состав каждого…»
  (около строки 330): если там перечислены составы или набор кузнеца — привести
  к новому каталогу.

## Критерии приёмки

- [ ] Ни у одного товара в `SHOP_SKUS` нет монет и осколков; схема состава их не пропускает.
- [ ] Стартовый набор — 150 самоцветов за 50 ⭐, один раз на аккаунт.
- [ ] «Набора кузнеца» нет ни в каталоге, ни в словаре `ru-shop.json`.
- [ ] `wallet-limits.ts` и `wallet.service.ts` не изменены.
- [ ] Новые кейсы `shop.test.ts` и `shop-wallet.integration.test.ts` зелёные. Интеграционный — в CI PR.
- [ ] Документы обновлены.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(shop): Наборы магазина только из самоцветов`
- **Метка:** `release: patch`
- **Для игроков:** `- изменено [telegram]: Стартовый набор теперь — 150 самоцветов, набор кузнеца убран из магазина.`
- **Сводка для команды:** стартовый и кузнечный наборы после оплаты не
  выдавались: в них были монеты, а монеты за звёзды не продаются (Р2). Теперь
  магазин продаёт только самоцветы: стартовый — 150 за 50 ⭐, кузнечный снят.
  `@участник1` — после выката включить `payments.stars` в панели.
