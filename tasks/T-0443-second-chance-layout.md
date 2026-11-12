---
id: T-0443
title: «Второй шанс» — подпись ролика в одну строку, самоцветы и звёзды ровной парой
epic: E6
priority: P1
status: in-progress
owner: claude-lead-1 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - packages/app-shell/src/screens/run/SecondChance.tsx
  - packages/app-shell/src/screens/run/AdContinue.tsx
  - packages/app-shell/src/screens/run/ad-continue-look.ts
  - packages/app-shell/src/screens/run/GemContinue.tsx
  - packages/app-shell/test/ad-continue-look.test.ts
  - packages/app-shell/test/gem-continue.test.ts
  - packages/app-shell/test/second-chance-layout.test.ts
shared:
  - packages/app-shell/src/i18n/ru-run.json
  - docs/27-design-system-and-app-shell.md
runner: local
executor: sonnet-5.5
effort: medium
release: patch
merge: lead
design: null
batch: 4
---

# T-0443. «Второй шанс» — подпись ролика в одну строку, самоцветы и звёзды ровной парой

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0443.json)](README.md#значки-статуса)

## Зачем

На экране смерти (снимок владельца 18.png, телефон 360 px) подпись
«Продолжить за рекламу» переносится на две строки и вылезает из оранжевой
кнопки, а пара «Продолжить за самоцветы / ⭐ 10» разъезжается: кнопка звёзд
выше соседней и наезжает на неё, цена самоцветов прячется. Это главный
момент монетизации — он обязан выглядеть аккуратно на любой ширине.

## Решения

- `docs/35-stage4-plan.md`, **Р210**, п. 3: подпись ролика — всегда в одну
  строку: полная «Продолжить за рекламу», где помещается, иначе «За рекламу» —
  по ширине кнопки (контейнерный запрос); самоцветы и звёзды — две равные
  ячейки одной высоты (`minmax(0,1fr)`), кнопки не наезжают, баланс
  самоцветов — строкой под парой.
- Порядок и состав способов не меняются (`visibleWays`, `wayOrder`, Р162):
  ролик — главный, самоцветы и звёзды — вторым рядом, у VIP одна кнопка.
- Цена видна до нажатия (Р11): у самоцветов и звёзд на кнопке — значок и
  число, полная фраза — в `aria-label`.

## Как сейчас

- `screens/run/SecondChance.tsx` (строки ~160–245): сетка способов
  `grid gap-2 grid-cols-2` (при самоцветах) — колонки `1fr` с минимумом по
  содержимому, поэтому длинная кнопка распирает свою колонку. Ролик при
  самоцветах — отдельным рядом (`adRow` → `[&>button]:col-span-full`),
  `wide={wide || adRow}` → подпись `run.continue.ad` («Продолжить за
  рекламу»), которая на 360 px не влезает в одну строку.
- `screens/run/ad-continue-look.ts`, `adButtonLook`: `labelKey` —
  `run.continue.ad` (широкая) или `run.continue.ad.short` («Реклама»).
- `screens/run/GemContinue.tsx`, `GemContinueView`: ячейка — `div.grid.gap-1`
  с кнопкой «Продолжить 💎 N» и под ней баланс «У тебя N» (`GemBalance`) —
  ячейка выше соседней, и кнопка звёзд (`PaidContinueView`, `Button block`)
  растягивается по высоте ряда.
- `i18n/ru-run.json`: `run.continue.ad`, `run.continue.ad.short`.

## Шаги по порядку

1. `i18n/ru-run.json`: новый ключ `"run.continue.ad.medium": "За рекламу"`.
2. `ad-continue-look.ts`: у `AdButtonLook` новое поле
   `compactLabelKey: string` — подпись, когда полной не хватает места:
   при `wide` — `run.continue.ad.medium` (у VIP — `run.continue.vip.short`),
   иначе равно `labelKey`.
3. `AdContinue.tsx`, `AdContinueView`: внутри кнопки две подписи —
   полная `labelKey` и короткая `compactLabelKey`, обе `whitespace-nowrap`;
   видна одна по контейнерному запросу ширины сетки способов (шаг 4):
   полная — от порога, короткая — ниже. Порог подобрать замером так, чтобы
   на 320 и 360 px и при крупном шрифте системы 130 % полная подпись не
   обрезалась и не переносилась (число порога — в rem, в описание PR).
4. `SecondChance.tsx`: у сетки способов — `@container` и колонки
   `grid-cols-[minmax(0,1fr)_minmax(0,1fr)]` вместо `grid-cols-2`, выравнивание
   ячеек по верху (`items-start`), чтобы кнопка не тянулась за соседом.
5. `GemContinue.tsx`, `GemContinueView`: новое свойство `paired: boolean`
   (рядом стоят звёзды). При `paired` на кнопке только значок и цена
   (`💎 N`, подпись «Продолжить» уходит; `aria-label` прежний — полный), а
   `GemBalance` — не внутри ячейки, а строкой сетки `order-last col-span-full`
   (как строки состояния ролика и звёзд). Без `paired` — как сейчас.
   В `SecondChance.tsx` передавать `paired={showStars}`.
6. Витрина компонентов (`gallery.tsx`, раздел второго шанса) уже показывает
   сочетания способов — снимки берутся с неё: 320, 360, 390, 768 px,
   ландшафт 640×360; сочетания «ролик + самоцветы + звёзды», «ролик +
   звёзды», «самоцветы + звёзды», «только самоцветы», VIP; нехватка самоцветов.

## Чего не трогаем

- Логику способов: `visibleWays`, `wayOrder`, `waysAnswered`,
  `continueOfferedPayload`, сторы `ad-continue`, `gem-continue`,
  `continue-purchase` и события.
- `PaidContinue.tsx` — кнопка звёзд уже «значок + число».
- Тексты отказов и строк состояния.

## Сценарий и интерфейс

- 360 px, все три способа: первая строка — оранжевая «📺 Продолжить за
  рекламу» в одну строку (или «📺 За рекламу» на 320 px); вторая — две
  кнопки равной ширины и высоты «💎 10» и «⭐ 10»; под ними — «У тебя 78».
- Нехватка самоцветов: кнопка самоцветов выключена, под парой «У тебя N» и
  «Не хватает M» столбцом.
- Только самоцветы (без звёзд): «Продолжить 💎 10» на всю ширину, баланс под
  ней — как сейчас.
- Загрузка: заглушки той же высоты (как сейчас).

## Тесты

Первым коммитом:

- `test/ad-continue-look.test.ts`: при `wide` — `labelKey` `run.continue.ad`,
  `compactLabelKey` `run.continue.ad.medium`; без `wide` — оба
  `run.continue.ad.short`; у VIP при `wide` — `run.continue.vip.wide` и
  `run.continue.vip.short`.
- `test/gem-continue.test.ts`: `GemContinueView` (`renderToStaticMarkup`) с
  `paired` — в кнопке нет текста «Продолжить», есть число цены, `aria-label`
  полный; баланс — элемент с `col-span-full`; без `paired` — «Продолжить» на
  кнопке.
- `test/second-chance-layout.test.ts`: `SecondChance` с превью всех трёх
  способов — сетка несёт `@container` и `minmax(0,1fr)`, а не `grid-cols-2`;
  в разметке есть обе подписи ролика, каждая с `whitespace-nowrap`.

## Аналитика

Нет: события `continue_offered` и нажатия кнопок (`track`) не меняются.

## Настройки и окружение

Нет.

## Документы

- `docs/27-design-system-and-app-shell.md`, раздел экрана смерти — строка:
  подписи кнопок второго шанса в одну строку, длинная подпись ролика
  сменяется короткой по ширине (Р210).

## Критерии приёмки

- [ ] На снимках матрицы подпись ролика в одну строку, пара самоцветов и
      звёзд — равной ширины и высоты, ничего не наезжает.
- [ ] Цена видна на обеих кнопках пары; `aria-label` — полная фраза.
- [ ] Тесты из раздела «Тесты» есть и зелёные.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Выровнять кнопки второго шанса`
- **Метка:** `release: patch`
- **Для игроков:** `- исправлено: кнопки «Второго шанса» не переносятся и не наезжают друг на друга`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВЫРОВНЯТЬ КНОПКИ ВТОРОГО ШАНСА**

  На экране смерти подпись ролика всегда в одну строку, а самоцветы и
  звёзды стоят ровной парой с ценой на кнопках (Р210).

  🛠 **Что сделано**

  • «Продолжить за рекламу» → «За рекламу» на узкой ширине
  • пара «💎 N / ⭐ N» равной ширины и высоты, баланс — строкой под ней
  ```
