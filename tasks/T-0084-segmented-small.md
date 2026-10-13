---
id: T-0084
title: Тесный `SegmentedControl`: подписи сжимаются на узком экране, без обёрток снаружи
epic: E6
priority: P2
status: ready
owner:
author: claude-lead2-7
size: S
depends_on: [T-0044, T-0094]
zones:
  - packages/app-shell/src/design-system/components/Layout.tsx
  - packages/app-shell/src/design-system/components/segmented-rules.ts
  - packages/app-shell/test/segmented-rules.test.ts
  - packages/app-shell/src/screens/pre-run.tsx
  - packages/app-shell/src/screens/gallery.tsx
  - packages/app-shell/src/i18n/ru-gallery.json
shared:
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
version: v0.8
---

# T-0084. Тесный `SegmentedControl`: подписи сжимаются на узком экране, без обёрток снаружи

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0084.json)](README.md#значки-статуса) [![T-0044](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0044.json&label=T-0044)](T-0044-pre-run-sheet.md) [![T-0094](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0094.json&label=T-0094)](T-0094-prerun-no-sideways-scroll.md)

## Зачем

В листе «Перед забегом» (T-0044) подписи «Лёгкая / Нормальная / Сложная» и вкладок
режимов на 320 и 360 px не помещаются. T-0044 обошёл это снаружи: обернул компонент
в `div` с селектором `[&_[role=tab]]`. Другое узкое место так не починить, не
скопировав хитрость. После задачи `SegmentedControl` сам умеет тесный размер, а
обёртка в листе уходит. Для игрока вид листа тот же. Источник: приёмка PR #253, 11.10.

## Решения

- **Опция существующего компонента, не новый компонент:** `size?: "m" | "s"`,
  по умолчанию `"m"` (как сейчас).
- **`s` шире 384 px не отличается от `m`.** Уже — ступени по ширине *экрана*, как в
  `NARROW_SEGMENTS` из T-0044: до 384 px включительно поля `px-1` и шрифт `text-xs`;
  до 360 px включительно поля `px-0.5` и `tracking-tighter`.
- **Только токены** (`docs/27` §3.3): `text-xs` — токен `--text-xs`, `px-*` — шкала
  отступов, `tracking-tighter` — стандартная тема Tailwind (`tracking-widest` в
  `SectionTitle` оттуда же). Одиннадцатый пиксель из T-0044 (`text-[0.6875rem]`) —
  произвольное значение, здесь его нет.
- **Правила «строка или сетка» и классы размера — чистые функции** в
  `segmented-rules.ts` (рядом `tab-labels.ts`, `swipe-strip.ts`): DOM-тестов у
  оболочки нет.
- Сетка 2×2 при четырёх сегментах и больше не меняется (`docs/27`, абзац «Подписи
  вкладок не обрезаются»).
- **На `s` переводим только лист «Перед забегом»** — как указано во входящих.

## Как сейчас

- `packages/app-shell/src/design-system/components/Layout.tsx`: строка 214 —
  `const SEGMENTS_IN_ROW = 3;`; строка 228 — `SegmentedControl(props: { items;
  activeId; label; onSelect })`; строка 252 — `props.items.length > SEGMENTS_IN_ROW
  ? "grid grid-cols-2" : "flex overflow-x-auto [scrollbar-width:none]"`; строка 269 —
  класс сегмента `"relative inline-flex min-h-11 flex-1 shrink-0 items-center
  justify-center rounded-md px-2 font-display text-sm font-semibold whitespace-nowrap"`.
- `packages/app-shell/src/screens/pre-run.tsx` (создан T-0044, смотри влитый файл):
  константа `NARROW_SEGMENTS` с пояснением над ней и два места
  `<div className={NARROW_SEGMENTS}> <SegmentedControl … /> </div>`: вкладки режимов
  (`label={t("weapon.select.screen")}`) и сложность (`label={t("difficulty.title")}`).
- `packages/app-shell/src/screens/gallery.tsx`: состояние `segment` (строка 57), блок
  `<SectionTitle>{t("gallery.segmented")}</SectionTitle>` и `SegmentedControl` из
  трёх сегментов под ним (строки 161-171).
- Другие потребители: `GuideScreen.tsx`, `meta/rating.tsx`, `meta/shop.tsx`,
  `meta/tasks.tsx`, `run/DevSheet.tsx`, `run/RunStatsSheet.tsx`, `sound-lab.tsx`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»). Они падают: модуля ещё нет.
2. **Новый файл `design-system/components/segmented-rules.ts`:**

   ```ts
   export type SegmentedSize = "m" | "s";
   export type SegmentedLayout = "row" | "grid";

   /** Сколько сегментов помещается строкой; больше — сетка в два столбца. */
   export const SEGMENTS_IN_ROW = 3;

   export function segmentedLayout(itemCount: number): SegmentedLayout {
     return itemCount > SEGMENTS_IN_ROW ? "grid" : "row";
   }

   /**
    * Поля и шрифт сегмента. `s` шире 384 px не отличается от `m`; уже — сжимается
    * ступенями, чтобы три русские подписи («Нормальная») не уходили за край.
    * Размеры — токены, произвольных значений нет.
    */
   export function segmentFitClass(size: SegmentedSize): string {
     return size === "s"
       ? "px-2 text-sm max-[24rem]:px-1 max-[24rem]:text-xs max-[22.5rem]:px-0.5 max-[22.5rem]:tracking-tighter"
       : "px-2 text-sm";
   }
   ```

   Комментарии на русском, про «почему». Tailwind 4 сам сканирует исходники, класс
   из `.ts` подхватится.
3. **`Layout.tsx`:** удалить `SEGMENTS_IN_ROW` и пояснение над ним, импортировать
   `segmentFitClass`, `segmentedLayout`, тип `SegmentedSize` из `./segmented-rules`.
   В `props` добавить

   ```ts
   /** "s" — для тесных мест: на узком экране подписи сжимаются (segmented-rules.ts). */
   size?: SegmentedSize;
   ```

   Строка 252 → `segmentedLayout(props.items.length) === "grid" ? "grid grid-cols-2" : "flex overflow-x-auto [scrollbar-width:none]"`.
   В классе сегмента убрать `px-2` и `text-sm`, добавить `segmentFitClass(props.size ?? "m")`.
   Остальное не менять: прокрутку к выбранному, знак-счётчик, звук. Абзац над
   компонентом дополнить фразой про `size="s"`.
4. **`pre-run.tsx`:** удалить `NARROW_SEGMENTS` с пояснением и обе `div`-обёртки, в сами
   `SegmentedControl` добавить `size="s"`. Условие `modes.length > 0 ? … : null` у
   вкладок режимов остаётся. Если на ревью T-0044 схему поменяли, найди обёртки по
   `[role=tab]` и сделай то же.
5. **`gallery.tsx` и `ru-gallery.json`:** под существующим переключателем второй, `s`:

   ```tsx
   <p className="mt-3 mb-1 text-xs text-text-muted">{t("gallery.segmented.smallHint")}</p>
   <SegmentedControl
     size="s"
     label={t("gallery.segmented.small")}
     activeId={difficultySegment}
     onSelect={setDifficultySegment}
     items={["easy", "normal", "hard"].map((id) => ({ id, label: t(`difficulty.${id}.name`) }))}
   />
   ```

   Рядом со `segment`: `const [difficultySegment, setDifficultySegment] = useState("normal");`.
   Ключи после `gallery.segmented`:
   - `"gallery.segmented.small": "Тесный переключатель"`
   - `"gallery.segmented.smallHint": "Тот же переключатель с size=\"s\": на экране уже 384 px подписи сжимаются, чтобы «Нормальная» и «Сложная» не уходили за край."`
6. **Проверка глазами** на 320, 360 и 390 px (оболочка в dev-режиме; лист — «Играть»
   на главной, витрина — экран диагностики). В консоли у сложности и у вкладок режимов
   игрока со стресс-тестом (2 вкладки) `scrollWidth === clientWidth` у `[role=tablist]`.
   Если на 320 px «Нормальная» не помещается, **не вводи произвольный размер шрифта**:
   оставь и напиши в PR замер и вопрос тимлиду (нужен токен меньше `--text-xs`, решение
   дизайнера). Три вкладки с «Разработчика» есть только у команды, там прокрутка
   допустима. Нет браузера — напиши об этом в PR, критерий приёмки не отмечай.
7. **`docs/27-design-system-and-app-shell.md`**, абзац «**Подписи вкладок не
   обрезаются**» (около строки 1122): после «Проверено в браузере на 320, 360 и 390
   px.» добавить: «Для тесных мест — `size="s"`: шире 384 px он как обычный, уже —
   подпись 12 px, а на экране не шире 360 px ещё и поля с межбуквенным интервалом
   плотнее (так сделан лист «Перед забегом»).»

## Чего не трогаем

- Остальных потребителей (список выше): они на `m`, вид не меняется.
- Сетку 2×2, прокрутку ленты вбок, знак `badge`, звук «select».
- Раскладку листа «Перед забегом» кроме обёрток и константы: ограничение высоты тела
  и подвал — задача T-0083, она идёт следом.
- Токены и `design-tokens`: нового размера шрифта не заводим (шаг 6).

## Сценарий и интерфейс

Меняется только ширина экрана, состояний данных у компонента нет:

- **шире 384 px** — лист и витрина как до задачи;
- **до 384 px** — подписи 12 px, сложность целиком в одну строку; **до 360 px** — поля
  и буквы плотнее;
- загрузка, пусто, ошибка, нет сети, ограничения аккаунта — не применимо.

## Тесты

Первым коммитом, `packages/app-shell/test/segmented-rules.test.ts`:

- `segmentedLayout(0)`, `(1)`, `(3)` → `"row"`;
- `segmentedLayout(4)`, `(6)` → `"grid"` (граница на трёх, как сейчас);
- `segmentFitClass("m")` → ровно `"px-2 text-sm"`: обычный размер не изменился;
- `segmentFitClass("s")` начинается с `segmentFitClass("m")` и содержит
  `max-[24rem]:text-xs` и `max-[22.5rem]:tracking-tighter`;
- `segmentFitClass("s")` не содержит произвольных размеров
  (`/(?:^|[\s:])(?:text|px|py|p|tracking|leading)-\[/`): токены, не числа от руки.

## Аналитика

Нет: вёрстка общего компонента, событий у неё нет.

## Настройки и окружение

Нет.

## Документы

- `docs/27-design-system-and-app-shell.md` — абзац про подписи вкладок (шаг 7).

## Вопросы к тимлиду

Подтверждено `claude-lead-1` 13.10.2026:

- ступени считаются по ширине экрана (как в T-0044), а не контейнера;
- `text-[0.6875rem]` из T-0044 заменён на `tracking-tighter`, потому что §3.3
  требует токены; если на 320 px не хватит, нужен токен меньше `--text-xs`;
- на `size="s"` переводится только лист «Перед забегом».

Исполнитель не ждёт ответа.

## Критерии приёмки

- [ ] `SegmentedControl` принимает `size?: "m" | "s"`; без пропа вёрстка прежняя
  (`segmentFitClass("m") === "px-2 text-sm"`).
- [ ] `NARROW_SEGMENTS` и обе обёртки в `pre-run.tsx` удалены, оба переключателя
  листа с `size="s"`; `grep "role=tab" packages/app-shell/src/screens` пуст.
- [ ] На 320, 360 и 390 px сложность в листе помещается без прокрутки или в PR записан
  замер и вопрос (шаг 6).
- [ ] В витрине виден второй переключатель с `size="s"`; тест из «Тестов» зелёный.
- [ ] Дифф только в зонах задачи и в одном абзаце `docs/27`.
- [ ] Гейт (`CLAUDE.md`), `pnpm budget` и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `refactor(app-shell): Тесный размер переключателя видов`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ТЕСНЫЙ ПЕРЕКЛЮЧАТЕЛЬ ВИДОВ**

  У переключателя видов появился размер для узких экранов: на 360 px и уже подписи сжимаются и помещаются. Лист «Перед забегом» перешёл на него и больше не сжимает подписи обёрткой снаружи. Для игрока вид листа тот же.

  🛠 **Дизайн-система**

  • `SegmentedControl` принимает `size="s"`, правила размера вынесены в чистые функции с тестами
  • в витрине компонентов добавлен тесный переключатель
  ```
