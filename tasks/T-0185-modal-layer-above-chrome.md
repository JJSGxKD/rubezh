---
id: T-0185
title: Модалки и листы — поверх шапки и нижней панели
epic: E6
priority: P1
status: done
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - packages/app-shell/src/design-system/components/Surfaces.tsx
  - packages/app-shell/src/design-system/components/modal-host.tsx
  - packages/app-shell/src/design-system/components/modal-rules.ts
  - packages/app-shell/src/design-system/components/index.ts
  - packages/app-shell/src/app/App.tsx
  - packages/app-shell/test/modal-rules.test.ts
  - packages/app-shell/test/modal-host.test.ts
shared:
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 2
---

# T-0185. Модалки и листы — поверх шапки и нижней панели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0185.json)](README.md#значки-статуса)

## Зачем

Лист предмета в арсенале открывается под шапкой приложения: аватар, валюты и
меню лежат поверх затемнения и закрывают верх листа, а нижняя панель разделов
не затемнена вовсе (жалоба участника 1 со скриншотом, 20.10.2026). Так же ведёт
себя любая модалка, открытая из раздела нижней панели. После задачи окна и
листы лежат выше шапки, нижней панели и главного меню и затемняют их.

## Решения

Р119 (`docs/35-stage4-plan.md`, 20.10.2026):

- любая модалка и любой лист снизу лежат **выше** шапки, нижней панели и
  главного меню и затемняют их целиком;
- способ — **слой модалок в корне приложения**: узел-хост в `App.tsx` после
  нижней панели и главного меню; `Modal` рисуется в него через
  `createPortal`. Без хоста (витрина компонентов, предпросмотр, тесты на
  `renderToStaticMarkup`) `Modal` остаётся на месте, как сейчас;
- порядок слоёв не меняется: `--z-modal` (30) выше `--z-header` (15); тосты
  (`--z-toast`) и диагностика (`--z-diagnostics`) выше модалок; креатив
  рекламы (`ads/ad-creative.tsx`, `calc(var(--z-modal) + 5)`) выше модалок;
- вид модалок, токены цвета, `pinFooter` не меняются;
- «Назад» площадки и Esc (`useBackLayer`), звуки листа, `aria-modal`, имя
  диалога — как были.

## Как сейчас

Причина проверена по коду:

- `packages/app-shell/src/design-system/components/Surfaces.tsx`, `Modal`
  (~строки 152-196): корень — `absolute inset-0` с `zIndex: var(--z-modal)`,
  отступы по `--app-inset-*`. Он лежит **внутри** `<main>` экрана, поэтому
  (а) покрывает только область `main`, нижняя панель за его пределами и
  не затемняется; (б) его `z-index` живёт внутри контекста наложения экрана.
- `packages/app-shell/src/design-system/components/Layout.tsx:314`
  `ScreenTransition` оборачивает экран в `div.h-full.animate-screen-in`;
  анимация `screen-in` (`tokens.css:41,80`) идёт с `both` и меняет
  `opacity` и `transform`, то есть создаёт контекст наложения. Модалка
  внутри него, при `z-index: 30`, всё равно лежит в слое экрана ниже шапки.
- `packages/app-shell/src/app/App.tsx:95-148`: порядок детей корня —
  `AppHeader` (`AppHeader.tsx:45`, `absolute … z-(--z-header)`), `<main
  className="relative min-h-0 flex-1">` с экраном, `CompactOverlay`,
  `TabBar` (`Layout.tsx:128`, без позиционирования), `MainMenu` (сам `Modal`
  снизу, `app/MainMenu.tsx`). Хоста слоя нет.
- Где открывается `Modal` (рендерится в месте вызова): `app/MainMenu.tsx`,
  `screens/home.tsx`, `screens/pre-run.tsx`, `screens/meta/{arsenal-item,
  friends,run-detail,run-interrupted,shop,shop-showcase,tester-thanks}.tsx`,
  `screens/run/{ChestOverlay,DeathOverlay,DevSheet,RunStatsSheet,overlays}.tsx`,
  `screens/stress/StressScreen.tsx`, `screens/sound-lab.tsx`, `screens/gallery.tsx`.
- Не `Modal`, но тоже `--z-modal`: `screens/gates.tsx:105`,
  `screens/run/RunScreen.tsx:193`, `screens/stress/StressScreen.tsx:121` —
  полноэкранные заслонки внутри экрана без шапки. Не трогаем.
- Тесты `Modal` без DOM: `test/modal-label.test.ts` и `test/modal-rules.test.ts`
  (`renderToStaticMarkup`, окружение `node`). `createPortal` в серверном
  рендере не поддерживается, поэтому без провайдера `Modal` обязан рисовать
  себя на месте.
- Стек «Назад»: `state/back-stack.ts`, `useBackLayer` вызывается в `Modal`
  (строка ~169) и не зависит от того, где в дереве DOM лежит узел.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»). Они падают: функции и
   модуля ещё нет.
2. **`design-system/components/modal-rules.ts`:** добавить чистую функцию

   ```ts
   export type ModalMount = "inline" | "wait" | "portal";

   /**
    * Куда рисовать модалку. `undefined` — слоя модалок в дереве нет (витрина,
    * предпросмотр, серверный рендер тестов): рисуем на месте. `null` — слой
    * есть, но его узел ещё не создан: рисовать на месте нельзя, иначе окно
    * смонтируется дважды и проиграет анимацию и звук листа заново, поэтому
    * ждём. Узел есть — рисуем в него.
    */
   export function modalMount<T extends object>(host: T | null | undefined): ModalMount {
     if (host === undefined) return "inline";
     return host === null ? "wait" : "portal";
   }
   ```
3. **Новый файл `design-system/components/modal-host.tsx`:**
   - `const ModalHostContext = createContext<HTMLElement | null | undefined>(undefined)`;
   - `export const ModalHostProvider = ModalHostContext.Provider`;
   - `export function useModalHost(): HTMLElement | null | undefined` —
     `useContext`;
   - комментарий на русском: зачем слой (контекст наложения экрана и
     границы `main`, см. «Как сейчас»), что `undefined` и `null` — разные
     состояния.
   Экспортировать из `components/index.ts` вместе с остальными компонентами.
4. **`Surfaces.tsx`, `Modal`:**
   - `const host = useModalHost()`; `const mount = modalMount(host)`;
   - всю нынешнюю разметку диалога собрать в переменную `dialog`, к классам
     корня добавить `pointer-events-auto` (хост слоя `pointer-events-none`,
     иначе пустой хост перекрыл бы приложение; на месте класс безвреден);
   - в конце: `mount === "wait" ? null : mount === "portal" && host ? createPortal(dialog, host) : dialog`.
     Хуки (`useEffect` со звуком листа, `useBackLayer`) остаются выше и
     выполняются до этого ветвления — порядок хуков не меняется;
   - `createPortal` из `react-dom`. Остальное в `Modal` не менять: классы
     панели, шапку, `pinFooter`, `style={{ zIndex: "var(--z-modal)" }}` на
     корне окна (внутри хоста он не мешает, на месте нужен как был).
5. **`app/App.tsx`:**
   - до ранних `return` (рядом с остальными хуками) —
     `const [modalLayer, setModalLayer] = useState<HTMLElement | null>(null)`;
   - обернуть возвращаемое дерево корня в `<ModalHostProvider value={modalLayer}>`
     (оборачивается только основной `return`, экраны «вне площадки», «устарел»
     и первого запуска без провайдера — модалок на них нет);
   - **последним ребёнком** корневого `div`, после `TabBar` и блока
     `MainMenu`, добавить
     `<div ref={setModalLayer} data-modal-layer="" className="pointer-events-none absolute inset-0" style={{ zIndex: "var(--z-modal)" }} />`.
     Комментарий над ним: слой модалок поверх шапки и нижней панели (Р119),
     пустой — пока окон нет;
   - ничего другого в `App.tsx` не менять (порядок шапки, `main`, `TabBar`,
     `showTabs`, `runUnderneath`).
6. **Обход мест вызова.** Просмотреть каждый файл из списка «Как сейчас» и
   убедиться, что ничему рядом не нужен `Modal` «на месте»: нет кода, который
   ищет окно как потомка `main` или экрана (`closest`, `querySelector`,
   `contains` по ref экрана). Нашёл такой — вопрос в PR, не правка.
7. **Проверка глазами** (браузер, `pnpm dev`, вход обязателен): на 320×568,
   390×844, 768×1024 и 1440×900 —
   - лист предмета в арсенале (`Modal placement="bottom"`): шапка и нижняя
     панель затемнены, лист закрывает их, крестик нажимается;
   - главное меню из шапки, лист «Перед забегом», окно друга и магазина;
   - модалка в модалке (витрина компонентов, пункт «Модалка поверх»);
   - забег: пауза, выбор улучшения, смерть — выглядят как до задачи;
   - «Назад» площадки (в браузере — Esc) закрывает верхнюю модалку, экран под
     ней остаётся.
   Снимки четырёх ширин для листа предмета с шапкой приложить к PR. Нет
   браузера — написать об этом в PR, критерий приёмки не отмечать.
8. **`docs/27-design-system-and-app-shell.md`:**
   - строка «Слои» (~917, ищется по «`modal` 30, `toast` 40»): дописать, что
     модалки и листы рисуются в слой в корне приложения (`ModalHostProvider`,
     `App.tsx`) и поэтому лежат выше шапки и нижней панели; без слоя
     (витрина, предпросмотр) — на месте;
   - строка `Modal` таблицы компонентов (ищется по «`Modal` | центральная или
     снизу»): одна фраза про то же;
   - раздел «Стек «Назад»» не менять.

## Чего не трогаем

- Вид модалок: размеры, отступы, анимации, шапку, крестик, `pinFooter`,
  `cut`, токены цвета и слоёв (`tokens.css`).
- Экран смерти и его раскладку — отдельная задача T-0186. Строки свойств
  листа предмета (адаптив характеристик улучшения) — T-0187.
- Полноэкранные заслонки `gates.tsx`, `RunScreen.tsx`, `StressScreen.tsx`
  (не `Modal`).
- Креатив рекламы (`ads/ad-creative.tsx`): остаётся отдельным корнем в
  `document.body` выше модалок.
- Шапку, нижнюю панель, `ScreenTransition` и анимацию `screen-in`.
- `useBackLayer`, `back-stack.ts`, звуки листа.
- `screens/gallery.tsx`: витрине хост не нужен, она показывает режим «на
  месте».

## Сценарий и интерфейс

Игрок в разделе нижней панели открывает лист или окно (предмет арсенала,
меню, друг, магазин, лист «Перед забегом»):

- весь экран, включая шапку и нижнюю панель, затемнён; лист или окно лежат
  выше всего; тап по затемнению и крестик закрывают (как были);
- лист снизу прижат к нижнему краю экрана с отступом `--app-inset-bottom`,
  над нижней панелью, а не над её верхом;
- модалка в модалке — вторая выше первой;
- в забеге (шапки и панели нет) окна выглядят и ведут себя как раньше;
- тосты и диагностика видны поверх окна; рекламный креатив выше окна;
- загрузка, пусто, ошибка, нет сети, ограничения аккаунта — состояния
  экранов под окнами не меняются.

## Тесты

Первым коммитом, без DOM (окружение `node`).

- `packages/app-shell/test/modal-rules.test.ts`, `modalMount`:
  - `undefined` → `"inline"`: слоя нет;
  - `null` → `"wait"`: слой есть, узла нет, на месте не рисуем;
  - объект (`{}`) → `"portal"`.
- `packages/app-shell/test/modal-host.test.ts`:
  - `Modal` без провайдера через `renderToStaticMarkup`: разметка содержит
    `role="dialog"` — на месте (то же держит `modal-label.test.ts`, он не
    меняется и остаётся зелёным);
  - `Modal` внутри `ModalHostProvider value={null}`: разметка пустая — окно
    ждёт узел слоя и не рисуется на месте;
  - у корня окна есть `pointer-events-auto`;
  - исходник `src/app/App.tsx` (чтение файла, как в `scripts/test/layer-boundaries.test.ts`):
    `data-modal-layer` встречается **после** `<TabBar` и после `<MainMenu`,
    а `ModalHostProvider` оборачивает возвращаемое дерево — защита от
    возврата слоя под нижнюю панель.
- `modal-label.test.ts` и остальные тесты `Modal` — без правок.

## Аналитика

Нет: общий компонент интерфейса, событий у него нет.

## Настройки и окружение

Нет. Переключателя настроек не нужно: слой невидим, анимаций и звуков не
добавляется.

## Документы

- `docs/27-design-system-and-app-shell.md` — строки «Слои» и `Modal` (шаг 8).

## Критерии приёмки

- [ ] Лист предмета в арсенале на 320, 390, 768 и 1440 px лежит выше шапки;
  шапка и нижняя панель затемнены (снимки в PR или запись, что браузера нет).
- [ ] Главное меню, лист «Перед забегом», окна магазина и друзей — так же.
- [ ] `App.tsx`: слой модалок — последний ребёнок корня, после `TabBar` и
  `MainMenu`; `Modal` рисуется в него через `createPortal`, а без провайдера
  остаётся на месте.
- [ ] Окно не монтируется дважды при первом показе: звук листа и анимация
  играют один раз (`modalMount` даёт `"wait"`, пока узла нет).
- [ ] «Назад» площадки и Esc закрывают верхнюю модалку; модалка в модалке
  закрывается по одной.
- [ ] Модалки забега (пауза, уровень, смерть) выглядят и работают как раньше.
- [ ] Тосты, диагностика и креатив рекламы выше окна; порядок слоёв в
  `tokens.css` не изменён.
- [ ] Тесты из раздела «Тесты» зелёные; `modal-label.test.ts` не менялся.
- [ ] Дифф только в зонах задачи и в двух строках `docs/27`.
- [ ] Гейт (`CLAUDE.md`), `pnpm budget` и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(app-shell): Поднять модалки и листы над шапкой и панелью`
- **Метка:** `release: patch`
- **Для игроков:**
  - исправлено: окна и листы больше не прячутся под верхней панелью
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — МОДАЛКИ И ЛИСТЫ ПОВЕРХ ШАПКИ И ПАНЕЛИ**

  Лист предмета в арсенале и другие окна из разделов больше не закрыты шапкой приложения, а нижняя панель под ними затемняется. Окна забега выглядят как раньше.

  🛠 **Оболочка**

  • модалки рисуются в слой в корне приложения (Р119), без слоя — на месте, как в витрине
  • вид окон, звуки и «Назад» не менялись
  ```
