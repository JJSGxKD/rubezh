---
id: T-0046
title: Магазин в облике «Сумеречный рубеж» — по макету
epic: E12
priority: P2
status: ready
owner:
size: M
depends_on: [T-0013]
zones:
  - packages/app-shell/src/screens/meta/shop.tsx
  - packages/app-shell/src/screens/meta/shop-parts.tsx
  - packages/app-shell/src/screens/meta/shop-showcase.tsx
  - packages/app-shell/src/screens/meta/shop-look.ts
  - packages/app-shell/src/design-system/components/CutFrame.tsx
  - packages/app-shell/src/design-system/components/Button.tsx
  - packages/app-shell/src/design-system/tokens.css
  - packages/app-shell/test/shop-look.test.ts
shared:
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/screens/shop.html
---

# T-0046. Магазин в облике «Сумеречный рубеж» — по макету

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0046.json)](README.md#значки-статуса) [![T-0013](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0013.json&label=T-0013)](T-0013-cut-corners.md)

## Зачем

Магазин уже в новой палитре (T-0012), но у карточек прежний облик:

- VIP не отличается от наборов;
- у самоцветов одинаковый значок на любой набор;
- «Лучшая цена» на «Самоцветах» уходит за прокрутку из-за плашки Tribute.

Макет `design/screens/shop.html` переносит магазин в облик «Сумеречный рубеж»
без смены состава и правил.

## Решения

- **Состав, вкладки, правила подачи и тексты не меняются.** Состав набора —
  целиком до оплаты. Бейджи и выгоду считает сервер. Зачёркнутая цена — только
  у акции.
- **Срез — только у главной покупки экрана.** Это кнопка звёзд у карточки
  «Подобрано для вас». Срез приходит с T-0013 (`CutFrame`, `cut` у `Button`);
  эта задача добавляет ему тон звёзд.
- **VIP — в тоне элиты:**
  - подложка с оттенком `elite` и рамка `elite/45`;
  - у действующего VIP — свечение.
- **Самоцветы — горстью по размеру набора:**
  - самый малый — один значок;
  - средний — три;
  - самый большой — пять.

  «Лучшая цена» — рамка и свечение акцента вместо полосы слева.
- **Tribute на «Самоцветах» — под плитками:** наборы — то, за чем пришли.
- **Витрина снаряжения — в цвет редкости:** рамка карточки и плитка предмета
  в тоне редкости. Тоны — те же, что в арсенале (`RARITY_TONE` в
  `arsenal-parts.tsx`).
- **Загрузка — заглушками** той же высоты, что баннер, вкладки и карточки,
  вместо строки «Загружаем магазин…».

## Как сейчас

- **`screens/meta/shop.tsx`:**
  - `ShopScreen`: `PageTitle`, плашки, `ShopBanners`, `SegmentedControl` из
    трёх вкладок, содержимое вкладки, строка промокода;
  - вкладка «Самоцветы»: `TributePlaque`, затем `grid-cols-2` из
    `GemPackTile` (строки ~231–241);
  - загрузка — `<p>{t("shop.loading")}</p>` (строка ~192).
- **`screens/meta/shop-parts.tsx`:**
  - `VipCard` — `Card selected={vip.active} stripe="accent"`, корона в
    градиенте `from-elite/40 to-accent/30`;
  - `ItemCard` — `forYou` даёт подпись и `glow` у `StarsButton`;
  - `GemPackTile` — `GemIcon size={44}`, у `best` — `stripe="accent"`;
  - `StarsButton` — `Button variant="stars"`.
- **`screens/meta/shop-showcase.tsx`** — `OfferCard` (строки ~120–165), тон —
  `toneOf(offer.rarity)` из `arsenal-parts.tsx`.
- **`screens/meta/shop-banners.tsx`** — тоны и значки баннеров уже такие, как в
  макете. Файл не меняется.
- **После T-0013:**
  - `CutFrame` с тонами `card`, `card-selected`, `panel`, `primary`;
  - `Button` с `cut` только для `variant="primary"`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Новый `screens/meta/shop-look.ts`** — чистые правила облика:

   ```ts
   /** Сколько самоцветов в горсти набора: по месту среди наборов самоцветов по количеству — 1, 3, 5; больше трёх наборов — средние получают 3. */
   export function gemPileSize(gems: number, allPacks: readonly number[]): 1 | 3 | 5;
   ```

   Наименьший по `gems` → 1, наибольший → 5, остальные → 3. Один набор → 3.
3. **Срез у кнопки звёзд:**
   - `tokens.css` — тон рамки `cut-stars` (рамка `#a06e10`, заливка —
     градиент кнопки `variant="stars"`, вынесенный в `--fill-stars`, как
     `--fill-primary` в T-0013);
   - `CutFrame.tsx` — `CutTone` += `"stars"`;
   - `Button.tsx` — `cut` работает и для `variant="stars"`, с тоном `stars`.
4. **`shop-parts.tsx`:**
   - **`VipCard`:**
     - подложка `bg-linear-to-br from-elite/12 via-surface-raised to-surface`,
       рамка `border-elite/45`;
     - при `vip.active` — свечение `shadow-[0_0_28px_-10px] shadow-elite/70` и
       `ring-1 ring-elite/50`;
     - вместо `Card` — свой `div`: у `Card` нет свойства подложки тона
       (`CardProps` в `Surfaces.tsx`). Отступы — как у `Card` (`p-4`, `rounded-lg`),
       появление — `animate-rise-in` со `staggerStyle(0)`, полоса слева — та же,
       что у `stripe="accent"`;
   - **`ItemCard`** — при `forYou` у `StarsButton` проп `cut`. Пробросить его
     в `Button`;
   - **`GemPackTile`:**
     - вместо одного `GemIcon` — горсть `gemPileSize(gems, packs)`;
     - значки разной высоты: у 3 — 22, 30, 22; у 5 — 20, 26, 34, 26, 20; у 1 — 26;
     - соседние значки внахлёст на 2 px, ряд прижат к низу, высота ряда
       56 px;
     - `packs` — количества всех наборов самоцветов, проп из `shop.tsx`;
     - у `best` вместо `stripe` — `ring-1 ring-accent/55` и
       `shadow-[0_0_22px_-10px] shadow-accent`;
     - число — `font-display` 26 px.
5. **`shop.tsx`:**
   - вкладка «Самоцветы» — сначала сетка плиток, потом `TributePlaque`;
   - в `GemPackTile` — проп `packs`;
   - загрузка — заглушки высотой 160 px (баннер), 42 px (вкладки), 150 px и
     220 px (карточки). Образец — `BoardSkeleton` в `screens/meta/rating.tsx`:
     `surface-card animate-pulse rounded-lg` и `staggerStyle(index)`, `aria-hidden`.
6. **`shop-showcase.tsx`, `OfferCard`:**
   - рамка карточки — в тоне редкости (`ring-1` из `toneOf(rarity).tile`);
   - плитка 52 px с уровнем внизу, подпись редкости — `toneOf(rarity).text`;
   - кнопка цены самоцветами — `size="s"`, основная.
7. **Документы** — раздел «Документы».

## Чего не трогаем

- `shop-banners.tsx` — тоны и значки уже по макету.
- Покупку, VIP-действия, промокод, витрину на сервере и все тексты.
- Срез у других экранов — T-0013.

## Сценарий и интерфейс

По макету `design/screens/shop.html`, шесть состояний на 360 px:

- «Для вас» без VIP;
- «Для вас» с VIP, когда ждут самоцветы дня;
- «Самоцветы» с акцией на малом наборе;
- «Снаряжение»;
- площадка без оплаты;
- загрузка.

Снимки на 320, 390, 768 и 1440 px снимают тимлиды при приёмке.

## Тесты

Первым коммитом, `packages/app-shell/test/shop-look.test.ts`:

- `gemPileSize`:
  - наборы `[60, 330, 700]` → `60 → 1`, `330 → 3`, `700 → 5`;
  - один набор → 3;
  - четыре набора → крайние 1 и 5, средние 3;
  - порядок в массиве не важен.
- Тест среза из T-0013 (`cut-frame.test.ts`) — зелёный. Если он перечисляет
  тоны, добавить `stars`.

## Аналитика

Нет: события магазина не меняются.

## Настройки и окружение

Нет.

## Документы

- `docs/27-design-system-and-app-shell.md`, каталог экранов, строка «Магазин —
  Витрина»:
  - горсть самоцветов;
  - Tribute под плитками;
  - срез у главной покупки;
  - витрина в цвет редкости.
- Там же, раздел о срезе (после T-0013) — тон `stars`.

## Критерии приёмки

- [ ] Магазин совпадает с макетом во всех шести состояниях.
- [ ] Состав, правила подачи и тексты не изменились.
- [ ] Срез — только у кнопки звёзд подобранного предложения.
- [ ] Гейт (`CLAUDE.md`), `pnpm budget` и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Магазин в облике «Сумеречный рубеж»`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: Магазин в новом облике: VIP заметнее, наборы самоцветов — горстью по размеру.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — МАГАЗИН В НОВОМ ОБЛИКЕ**

  Магазин перешёл на облик «Сумеречный рубеж» по макету: состав и правила прежние, меняется подача.

  🛍 **Что изменилось**

  • VIP — в тоне элиты, у действующего — свечение
  • наборы самоцветов — горстью по размеру, «Лучшая цена» — рамкой; Tribute — под плитками
  • главная покупка экрана — кнопка звёзд со срезом; витрина снаряжения — в цвет редкости
  ```
