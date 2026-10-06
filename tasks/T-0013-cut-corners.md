---
id: T-0013
title: Срезанный угол с рамкой по срезу у главного на экране
epic: E12
priority: P2
status: ready
owner:
size: M
depends_on: [T-0012, T-0008, T-0010]
zones:
  - packages/app-shell/src/design-system/components/CutFrame.tsx
  - packages/app-shell/src/design-system/components/Surfaces.tsx
  - packages/app-shell/src/design-system/components/Button.tsx
  - packages/app-shell/src/design-system/components/index.ts
  - packages/app-shell/src/design-system/tokens.css
  - packages/app-shell/src/screens/home.tsx
  - packages/app-shell/src/screens/home-widgets.tsx
  - packages/app-shell/src/screens/run/overlays.tsx
  - packages/app-shell/src/screens/run/DeathOverlay.tsx
  - packages/app-shell/test/cut-frame.test.ts
shared:
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/directions/directions-2026-10-c.html
---

# T-0013. Срезанный угол с рамкой по срезу у главного на экране

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0013.json)](README.md#значки-статуса) [![T-0012](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0012.json&label=T-0012)](T-0012-twilight-tokens-and-fonts.md) [![T-0008](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0008.json&label=T-0008)](T-0008-glow-behind-not-over.md) [![T-0010](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0010.json&label=T-0010)](T-0010-bot-write-access.md)

## Зачем

Срезанный угол — «подпись» направления «Сумеречный рубеж» (`design/README.md`,
«Срезанный угол»). Он выделяет главное на экране. Утверждённый вид — рамка идёт
по срезу так же, как по остальному краю. Образец — первый блок
`design/directions/directions-2026-10-c.html`.

## Решения

- **Один компонент `CutFrame`** в дизайн-системе. Экраны не повторяют приём
  руками, а включают его свойством `cut` у `Card`, `Button` и `Modal`.
- **Как устроен.** Два слоя, оба обрезаны многоугольником
  `clip-path: polygon(…)`:
  - внешний — цвета рамки;
  - внутренний — с отступом на толщину рамки (1 px) и заливкой поверхности.

  Срезаны левый верхний и правый нижний углы. Внутренний многоугольник
  сдвинут на `0.4px` (толщина × (√2 − 1)), чтобы рамка на диагонали была той
  же толщины, что на прямых краях.
- **Размер среза** — токены T-0012: `--cut-md` (10 px) у карточек и окон,
  `--cut-sm` (8 px) у кнопок.
- **Внешнее свечение у срезанного элемента не рисуется:** `clip-path`
  обрезает `box-shadow`. Выбранная карточка отличается рамкой акцента, тёплой
  подложкой и значком-галочкой — свечение для этого не нужно.
- **Где срез включается** — ровно эти места, больше нигде:
  1. кнопка «Играть» / «Продолжить» на главной;
  2. карточка награды дня на главной, когда награду можно забрать;
  3. окно выбора улучшения и выбранная в нём карточка;
  4. окно экрана смерти.

## Как сейчас

- `packages/app-shell/src/design-system/components/Surfaces.tsx`:
  - `Card` — классы `surface-card` или `surface-card-selected`,
    `rounded-lg`, полоса `stripe`, галочка при `selected`;
  - `Modal` — панель `surface-panel … rounded-xl`, свойство `placement`.
- `packages/app-shell/src/design-system/components/Button.tsx` — варианты
  `btn-primary` и др. После T-0008 свечение — соседний слой в обёртке.
- `packages/app-shell/src/design-system/tokens.css`:
  - `@utility surface-card`, `surface-card-selected`, `surface-panel` —
    градиент фона, `border`, `box-shadow`;
  - `@utility btn-primary` — градиент и внутренние тени.
- **Места:**
  - кнопка «Играть» — `screens/home.tsx`, `footer` экрана лобби
    (`<Button size="l" block glow …>`);
  - карточка награды дня — `screens/home-widgets.tsx`, виджет `daily` в
    состоянии `ready`;
  - окно выбора улучшения — `screens/run/overlays.tsx`, `LevelUpOverlay`:
    `Modal` и `Card` вариантов;
  - экран смерти — `screens/run/DeathOverlay.tsx`, `Modal`.
- Образец теста разметки — `packages/app-shell/test/preview.test.ts`
  (`renderToStaticMarkup`). Тест — `.ts`, элементы — через `createElement`
  (тесты `.tsx` не входят в `vitest.config.ts`).

## Шаги по порядку

1. **Тест — первым коммитом** (раздел «Тесты»).
2. **`tokens.css`** — утилиты среза рядом с поверхностями:

   ```css
   /* Срез с рамкой по срезу (design/README.md): два слоя одного многоугольника. */
   @utility cut-frame {
     position: relative;
     isolation: isolate;
     clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
   }
   @utility cut-fill {
     position: absolute;
     inset: 1px;
     z-index: -1;
     clip-path: polygon(calc(var(--cut) - 0.4px) 0, 100% 0, 100% calc(100% - var(--cut) + 0.4px), calc(100% - var(--cut) + 0.4px) 100%, 0 100%, 0 calc(var(--cut) - 0.4px));
   }
   ```

   Для каждой поверхности, которую срезают, — пара «цвет рамки + заливка без
   рамки и тени»:
   - `cut-card` — рамка `--color-border`, заливка как у `surface-card`;
   - `cut-card-selected` — рамка `--color-accent`, заливка как у `surface-card-selected`;
   - `cut-panel` — рамка `--color-border-strong`, заливка как у `surface-panel`;
   - `cut-primary` — рамка `--color-accent-edge`, заливка — градиент `btn-primary`.

   Градиенты не копировать: вынести их в переменные (`--fill-card`,
   `--fill-card-selected`, `--fill-panel`, `--fill-primary`). Ими пользуются и
   прежние утилиты, и новые — значение одно.
3. **Новый `components/CutFrame.tsx`:**

   ```tsx
   export type CutTone = "card" | "card-selected" | "panel" | "primary";
   export function CutFrame(props: { tone: CutTone; size: "sm" | "md"; className?: string; children: ReactNode }): ReactNode
   ```

   - внешний элемент: `cut-frame` + класс рамки тона, `--cut` — из
     `var(--cut-sm)` или `var(--cut-md)` через `style`;
   - первый ребёнок — `<span aria-hidden className="cut-fill …" />` с заливкой
     тона;
   - дальше — `children`.

   Экспорт — из `components/index.ts`.
4. **`Card`** получает `cut?: boolean`. При `cut` вместо `surface-card` /
   `surface-card-selected` и `rounded-lg` содержимое оборачивается в
   `CutFrame` с тоном `card` или `card-selected` и размером `md`. Остальное
   поведение (`onClick`, `stripe`, галочка, анимация появления) — как было.
5. **`Modal`** получает `cut?: boolean`: панель — `CutFrame` с тоном `panel`
   и размером `md` вместо `surface-panel rounded-xl`.
6. **`Button`** получает `cut?: boolean`, только для `variant="primary"`:
   - кнопка — внутри `CutFrame` с тоном `primary` и размером `sm`;
   - свечение (`glow`) — соседним слоем позади, как после T-0008. Обрезанное
     свечение не нужно — оно остаётся прямоугольным ореолом за кнопкой;
   - для других вариантов `cut` игнорируется, в разработке — с
     предупреждением в консоли.
7. **Включить в местах из «Решений»:**
   - `home.tsx` — `cut` у кнопки «Играть» / «Продолжить»;
   - `home-widgets.tsx` — у карточки награды дня в состоянии `ready`. Если
     это не `Card`, а своя разметка, — обернуть её в `CutFrame` с тоном
     `card-selected`;
   - `overlays.tsx`:
     - у `Modal` окна выбора улучшения — `cut`;
     - у `Card` вариантов — `cut` только у выбранной. У невыбранных обычное
       скругление: срез отмечает выбор;
   - `DeathOverlay.tsx` — `cut` у `Modal`.
8. **`docs/27-design-system-and-app-shell.md` §4.6** (компоненты) — строка о
   `CutFrame` и свойстве `cut` со ссылкой на `design/README.md`: где срез
   уместен.
9. **Гейт и снимки** на 320 и 390 px до и после — в PR:
   - главная с наградой дня, которую можно забрать;
   - окно выбора улучшения;
   - экран смерти.

   На снимке в увеличении должно быть видно, что рамка идёт по срезу.

## Чего не трогаем

- Остальные карточки, кнопки и модалки: срез — только у мест из «Решений».
- Цвета и радиусы: их задаёт T-0012.
- Свечение кнопок — порядок слоёв после T-0008 не меняется.

## Тесты

Новый `packages/app-shell/test/cut-frame.test.ts`, `renderToStaticMarkup` и
`createElement`:

- **`CutFrame` с тоном `card` и размером `md`:**
  - внешний элемент с `cut-frame`, `style` содержит `var(--cut-md)`;
  - первый ребёнок — `cut-fill` с `aria-hidden`.
- **`Card` с `cut`:**
  - разметка содержит `cut-frame` и не содержит `surface-card`;
  - `Card` без `cut` — как раньше: `surface-card`, `rounded-lg`, без `cut-frame`.
- **`Card` с `cut` и `selected`** — тон `card-selected` (класс рамки
  акцента), галочка на месте.
- **`Button` с `cut` и `variant="primary"`** — внутри `CutFrame` с размером
  `sm`.
- **`Button` с `cut` и `variant="secondary"`** — без `cut-frame`.
- **`Modal` с `cut`** — панель с `cut-frame` и тоном `panel`.

## Аналитика

Нет.

## Настройки и окружение

Нет. Срез — часть облика и под переключатель «движения» не попадает: он
статичен.

## Документы

Шаг 8.

## Критерии приёмки

- [ ] Срез с рамкой по срезу есть ровно в четырёх местах из «Решений», больше нигде.
- [ ] Рамка на диагонали той же толщины и цвета, что на прямых краях; на снимке в увеличении это видно.
- [ ] Градиенты поверхностей и кнопки не скопированы, а вынесены в переменные.
- [ ] `Card`, `Button` и `Modal` без `cut` — без изменений в разметке.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Срезанный угол у главного на экране`
- **Метка:** `release: minor`
- **Для игроков:** `- изменено: Главные кнопки и окна получили срезанный угол — фирменный знак нового облика.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СРЕЗАННЫЙ УГОЛ**

  У главного на экране — кнопки «Играть», награды дня, окна выбора улучшения и экрана смерти — срезанный угол с рамкой по срезу, фирменный знак направления «Сумеречный рубеж». Компонент CutFrame в дизайн-системе: срез включается свойством cut, а не вёрсткой экрана.
  ```
