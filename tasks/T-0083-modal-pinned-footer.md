---
id: T-0083
title: `Modal`: закреплённый подвал при прокручиваемом теле
epic: E6
priority: P2
status: done
owner: claude-3 / sonnet-5.5 / medium
author: claude-lead2-7
size: S
depends_on: [T-0044, T-0084, T-0013]
zones:
  - packages/app-shell/src/design-system/components/Surfaces.tsx
  - packages/app-shell/src/design-system/components/modal-rules.ts
  - packages/app-shell/test/modal-rules.test.ts
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
batch: 2
---

# T-0083. `Modal`: закреплённый подвал при прокручиваемом теле

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0083.json)](README.md#значки-статуса) [![T-0044](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0044.json&label=T-0044)](T-0044-pre-run-sheet.md) [![T-0084](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0084.json&label=T-0084)](T-0084-segmented-small.md) [![T-0013](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0013.json&label=T-0013)](T-0013-cut-corners.md)

## Зачем

У `Modal` подвал (`footer`, обычно кнопка) лежит внутри прокручиваемого блока: на
длинном листе его нужно домотать до конца. Лист «Перед забегом» (T-0044) хочет,
чтобы «В бой» была под пальцем всегда, и обошёл это константой `20rem`, подобранной
на глаз, на теле листа в `pre-run.tsx`. После задачи у `Modal` есть опция «подвал
закреплён», лист пользуется ею, константа уходит. Для игрока вид листа тот же.
Источник: приёмка PR #253, 11.10.

## Решения

- **Опция существующего компонента, не новый компонент:** `pinFooter?: boolean` в
  `ModalProps`.
- **Выключена по умолчанию.** Остальные модалки (пауза, уровень, смерть, магазин,
  друзья…) не меняются: в ландшафте и на невысоком экране закреплённый подвал
  отнял бы высоту у тела, а карточки выбора и «Ещё раз» и так тесные (`docs/27`
  §5.3). Переводить их на опцию — отдельное решение.
- **Без `footer` опция ничего не делает:** нижний отступ тела остаётся.
- **Короткое содержимое выглядит как раньше:** отступ до подвала прежний (`mt-5` →
  `pt-5` закреплённого блока), боковые и нижний отступы подвала те же, что были у тела.
- **Линии над закреплённым подвалом нет:** тело обрезается по краю, ниже 20 px
  панели и кнопка. Линия — решение дизайнера.
- **Выбор места подвала — чистая функция** `modalFooterPlacement` в `modal-rules.ts`
  (рядом `tab-labels.ts`): DOM-тестов у оболочки нет.

## Как сейчас

- `packages/app-shell/src/design-system/components/Surfaces.tsx`: `ModalProps` —
  строки 104-120; панель, строка 161 —
  `"surface-panel relative flex max-h-full w-full flex-col overflow-hidden rounded-xl"`;
  шапка с крестиком — `<header className="flex shrink-0 …">`, не прокручивается;
  блок прокрутки, строки 177-181 —
  `"min-h-0 overflow-y-auto overscroll-contain px-5 pb-5 short:px-4 short:pb-4 landscape:px-4 landscape:pb-4"`
  плюс `closable ? "" : "pt-5 short:pt-4 landscape:pt-4"`; подвал внутри блока,
  строка 201 —
  `{props.footer === undefined ? null : <div className="mt-5 grid gap-2">{props.footer}</div>}`.
  T-0013 добавит `Modal` свойство `cut` и обернёт панель в `CutFrame`, строки
  сдвинутся: искать по этим фрагментам.
- `packages/app-shell/src/screens/pre-run.tsx` (создан T-0044, смотри влитый файл):
  `<Modal title={t("weapon.select.screen")} placement="bottom" …>` с `footer`
  («В бой» и ошибка покупки; в режиме «Стресс» подвала нет). Тело обёрнуто в
  `<div className="grid max-h-[max(10rem,calc(100dvh-20rem-var(--app-inset-top)-var(--app-inset-bottom)))] grid-cols-1 gap-1.5 overflow-y-auto overscroll-contain">`
  с пояснением про «запас — высота шапки Modal, подвала и нижней панели».
- `packages/app-shell/src/screens/gallery.tsx`: `sheet` — строка 57
  (`useState(false)`), пункт «Длинный лист» — строка 90, `{sheet ? <ModalsPreview … />}` —
  строка 217, сам `ModalsPreview` — строки 253-282 (подвал-кнопка «Открыть модалку поверх»).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»). Они падают: модуля ещё нет.
2. **Новый файл `design-system/components/modal-rules.ts`:**

   ```ts
   export type ModalFooterPlacement = "none" | "scroll" | "pinned";

   /**
    * Где живёт подвал модалки. Закреплять нечего без подвала, поэтому опция без
    * `footer` не снимает у тела нижний отступ. `scroll` — как у всех модалок
    * забега и листов: подвал прокручивается вместе с телом.
    */
   export function modalFooterPlacement(input: { hasFooter: boolean; pinFooter: boolean }): ModalFooterPlacement {
     if (!input.hasFooter) return "none";
     return input.pinFooter ? "pinned" : "scroll";
   }
   ```
3. **`Surfaces.tsx`, `ModalProps`:** после `footer` добавить

   ```ts
   /**
    * Подвал не прокручивается с телом, а закреплён под ним: на длинном листе
    * прокручивается только середина, шапка и подвал на месте. Без `footer` не
    * действует. Выключено по умолчанию — модалки забега тесные (§5.3).
    */
   pinFooter?: boolean;
   ```
4. **`Modal`:** импортировать `modalFooterPlacement` и перед `return` посчитать

   ```ts
   const footerPlacement = modalFooterPlacement({ hasFooter: props.footer !== undefined, pinFooter: props.pinFooter === true });
   ```
5. **Блок прокрутки:** нижний отступ только когда подвал не закреплён.

   ```tsx
   className={[
     "min-h-0 overflow-y-auto overscroll-contain px-5 short:px-4 landscape:px-4",
     footerPlacement === "pinned" ? "" : "pb-5 short:pb-4 landscape:pb-4",
     closable ? "" : "pt-5 short:pt-4 landscape:pt-4",
   ].join(" ")}
   ```

   Подвал внутри блока — только при `"scroll"`:
   `{footerPlacement === "scroll" ? <div className="mt-5 grid gap-2">{props.footer}</div> : null}`.
6. **Закреплённый подвал** — сразу за блоком прокрутки, **ребёнком той же flex-колонки
   панели**:

   ```tsx
   {footerPlacement === "pinned" ? (
     <div className="grid shrink-0 gap-2 px-5 pt-5 pb-5 short:px-4 short:pb-4 landscape:px-4 landscape:pb-4">{props.footer}</div>
   ) : null}
   ```

   Классы литералом, не из кусков: Tailwind иначе их не найдёт. Если после T-0013
   панель внутри `CutFrame`, подвал остаётся ребёнком колонки, где лежат шапка и
   блок прокрутки; у колонки должны остаться `max-h-full` и `flex-col`, у блока
   прокрутки `min-h-0`, иначе тело не сожмётся и подвал уедет.
7. **`pre-run.tsx`:** в `<Modal …>` добавить `pinFooter`. Обёртку тела упростить до
   `<div className="grid grid-cols-1 gap-1.5">`: убрать `max-h-[…20rem…]`,
   `overflow-y-auto`, `overscroll-contain`. Пояснение над ней переписать: тело
   листа прокручивает `Modal`, шапка и «В бой» закреплены (`pinFooter`). Комментарий
   на русском, про «почему», без истории правок.
8. **`gallery.tsx` и `ru-gallery.json`:**
   - `sheet` → `useState<"long" | "pinned" | null>(null)`; «Длинный лист» делает
     `setSheet("long")`, под ним новый пункт:
     `<ListItem title={t("gallery.modal.pinned")} hint={t("gallery.modal.pinnedHint")} onClick={() => setSheet("pinned")} />`;
   - `{sheet !== null ? <ModalsPreview pinFooter={sheet === "pinned"} onClose={() => setSheet(null)} /> : null}`;
   - `ModalsPreview(props: { pinFooter: boolean; onClose(): void })` передаёт
     `pinFooter={props.pinFooter}` длинному листу, остальное не менять;
   - ключи после `gallery.modal.longHint`:
     - `"gallery.modal.pinned": "Длинный лист, подвал закреплён"`
     - `"gallery.modal.pinnedHint": "Прокручивается только середина: крестик сверху и кнопка снизу всегда на месте."`
9. **Проверка глазами** на 320×568, 360×640, 390×844: лист «Перед забегом» с открытым
   списком бустов (нужен вход) — прокручивается середина, «В бой» и крестик на месте;
   в витрине оба длинных листа. Нет браузера — напиши об этом в PR, критерий
   приёмки не отмечай.
10. **`docs/27-design-system-and-app-shell.md`**, строка `Modal` таблицы компонентов
    (ищется по «`Modal` | центральная или снизу»): во втором столбце после
    «…в ландшафте» добавить «; подвал можно закрепить (`pinFooter`) — прокручивается
    только тело», в третьем после ««сдаться?»» добавить «, лист «Перед забегом»».

## Чего не трогаем

- Остальные `Modal` с `footer` (`home.tsx`, `friends.tsx`, `shop.tsx`, `overlays.tsx`,
  `DeathOverlay.tsx`…): опция у них не включается.
- Шапку, крестик, звуки листа, `useBackLayer`, анимации, ширины `m` и `l`.
- Свойство `cut` (T-0013) и размер переключателей листа (T-0084).
- Раскладку листа: вкладки, оружие, бусты, кнопка «В бой» как были.

## Сценарий и интерфейс

Лист «Перед забегом»:

- содержимое длиннее листа — прокручивается середина, крестик и «В бой» не двигаются;
- короче — лист ровно по содержимому, кнопка под ним, как до задачи;
- режим «Стресс» — подвала нет, прокручивается тело;
- ошибка покупки бустов — строка над кнопкой, внутри закреплённого подвала;
- загрузка, нет сети, ограничения аккаунта — состояния листа из T-0044, не меняются.

## Тесты

Первым коммитом, `packages/app-shell/test/modal-rules.test.ts`, `modalFooterPlacement`:

- `{ hasFooter: false, pinFooter: false }` → `"none"`;
- `{ hasFooter: false, pinFooter: true }` → `"none"`: закреплять нечего, тело не
  теряет нижний отступ;
- `{ hasFooter: true, pinFooter: false }` → `"scroll"`: поведение всех существующих
  модалок;
- `{ hasFooter: true, pinFooter: true }` → `"pinned"`.

## Аналитика

Нет: общий компонент, событий у него нет.

## Настройки и окружение

Нет.

## Документы

- `docs/27-design-system-and-app-shell.md` — строка `Modal` таблицы компонентов (шаг 10).

## Вопросы к тимлиду

Подтверждено `claude-lead-1` 13.10.2026:

- закрепление — опция, а не поведение всех модалок: «закреплять всем» меняет ландшафт
  и экран смерти, это отдельный разговор с дизайнером;
- линии над закреплённым подвалом нет;
- задача после T-0084 (общие `pre-run.tsx`, `gallery.tsx`, `ru-gallery.json`) и после
  T-0013 (общий `Surfaces.tsx`), поэтому версия v0.9.

Исполнитель не ждёт ответа.

## Критерии приёмки

- [ ] `ModalProps.pinFooter` есть; без него и без `footer` разметка `Modal` не
  меняется (`modalFooterPlacement` даёт `"scroll"` и `"none"`).
- [ ] В `pre-run.tsx` нет `20rem` и `overflow-y-auto` на теле, `Modal` с `pinFooter`.
- [ ] На 320×568, 360×640, 390×844 середина листа прокручивается, «В бой» и крестик
  на месте, лист не заходит под шапку приложения (или запись в PR, шаг 9).
- [ ] В витрине два длинных листа: обычный и с закреплённым подвалом.
- [ ] Тест из «Тестов» зелёный; остальные модалки не изменены.
- [ ] Дифф только в зонах задачи и в одной строке таблицы `docs/27`.
- [ ] Гейт (`CLAUDE.md`), `pnpm budget` и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `refactor(app-shell): Закрепить подвал модалки под телом`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАКРЕПЛЁННЫЙ ПОДВАЛ МОДАЛКИ**

  У модалки появилась опция «подвал закреплён»: на длинном листе прокручивается только середина, кнопка внизу и крестик сверху остаются на месте. Лист «Перед забегом» перешёл на неё и лишился высоты, подобранной на глаз. Остальные модалки не изменились.

  🛠 **Дизайн-система**

  • `Modal` принимает `pinFooter`, выбор места подвала вынесен в чистую функцию с тестом
  • в витрине компонентов два длинных листа: обычный и с закреплённым подвалом
  ```
