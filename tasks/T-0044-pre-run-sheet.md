---
id: T-0044
title: «Перед забегом» одним листом — два касания до боя вместо четырёх
epic: E6
priority: P1
status: done
owner: claude-5 / sonnet-5.5
size: M
depends_on: []
zones:
  - packages/app-shell/src/screens/pre-run.tsx
  - packages/app-shell/src/screens/pre-run-rules.ts
  - packages/app-shell/src/screens/pick-tile.tsx
  - packages/app-shell/src/screens/boost-picker.tsx
  - packages/app-shell/src/screens/weapon-select.tsx
  - packages/app-shell/src/screens/boosts.tsx
  - packages/app-shell/src/screens/home.tsx
  - packages/app-shell/src/app/App.tsx
  - packages/app-shell/src/app/lazy-screens.tsx
  - packages/app-shell/src/state/navigation.ts
  - packages/app-shell/test/navigation.test.ts
  - packages/app-shell/test/pre-run-rules.test.ts
shared:
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/i18n/ru-boosts.json
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/screens/pre-run.html
---

# T-0044. «Перед забегом» одним листом — два касания до боя вместо четырёх

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0044.json)](README.md#значки-статуса)

## Зачем

Сейчас до боя четыре касания и три экрана:

1. «Играть»;
2. «Бесконечный» на экране «Режим»;
3. «Дальше» на экране «Перед забегом»;
4. «В бой» на экране «Бусты на забег».

После задачи «Играть» открывает лист поверх главной: сложность, оружие и
бусты собраны вместе, и «В бой» — второе касание.

## Решения

Решение пользователя от 07.10.2026 — **Р88** в `docs/35-stage4-plan.md`. Оно
меняет Р57 в части отдельного шага бустов. Макет —
`design/screens/pre-run.html`, все шесть состояний.

- **Лист поверх главной** — `Modal placement="bottom"`:
  - закрывают крестик в шапке, тап по затемнению и «Назад» (Р81);
  - всё это `Modal` уже умеет (`useBackLayer`).
- **Экрана «Режим» нет:** «Играть» начинает бесконечный забег.
  - Забег разработчика и стресс-тест — вкладками вверху листа, только тем,
    кому они открыты (`useToolsAccess`);
  - нет ни одного — ряда вкладок нет;
  - «Кампания» не показывается.
- **Оружие — плитками 3 в ряд с описанием выбранного** под ними.
- **Бусты — в том же листе плитками 3 в ряд** с ценой и описанием последнего
  тронутого. Правила прежние:
  - не больше `maxPerRun`;
  - денег не хватает — приглушено;
  - без сети — строка вместо плиток;
  - без входа — раздела нет.
- **Кнопка одна — «В бой».** Выбраны бусты — второй строкой в ней «спишется …».
  «Без бустов» не нужна.
- **Заголовка «Сложность» нет**: подписи переключателя говорят сами. У
  переключателя остаётся `label`.
- **Последний выбор сложности и оружия запоминается, как сейчас**
  (`meta.rememberDifficulty`, `meta.rememberWeapon`).
- **Лист — своим чанком**, как сейчас выбор оружия и бусты: первой загрузке он
  не нужен, лобби подтягивает его в простое (`preloadScreens`).

## Как сейчас

- **`screens/home.tsx`:**
  - «Играть» — `navigation.push("mode")` (строка ~60);
  - «Новый забег» после подтверждения — `useSavedRun.getState().clear()` и
    тот же `push("mode")` (строки ~143–150);
  - `ModeScreen` (строки ~311–395):
    - «Бесконечный» — `useDevMode.getState().arm(false); push("weapon")`;
    - «Забег разработчика» при `access.devMode` — `arm(true); push("weapon")`;
    - «Стресс-тест» при `access.stressTest` — `push("stress")`;
    - «Кампания» — заглушка.
- **`screens/weapon-select.tsx`, `WeaponScreen`:**
  - уровень забега — `useRunLevel()`, открытое — `unlocksAt(ACCOUNT_UNLOCKS, level).weapons`;
  - порядок оружия — по уровню открытия;
  - при `devArmed` сверху карточка «Настроить режим разработчика» — открывает
    `DevSheetLazy`;
  - сложность — `SegmentedControl` и строка `difficulty.<id>.description`;
  - карточки оружия;
  - `next()`: `rememberWeapon(selected)`. Дальше — с входом
    `push("boosts")`, без входа `intend({ kind: "new" })` и `replace("run")`.
- **`screens/boosts.tsx`, `BoostsScreen`:**
  - `start(withBoosts)` → `buyBoosts(createId(), boosts, catalog)`;
  - ошибки — `boosts.error.funds`, `boosts.error.offline`, `boosts.error.generic`;
  - успех → `intend({ kind: "new", boosts: { runId, ids } })`, `pop()`,
    `replace("run")`.
- **`screens/boost-picker.tsx`, `BoostPicker`** (`selected`, `onChange`,
  `onCatalog`, `error`, `heading`):
  - сам грузит каталог — `loadBoostCatalog`;
  - считает, что по карману, — `useWallet`;
  - рисует карточки списком;
  - без сети — `boosts.offline`.
- **Маршруты:**
  - `state/navigation.ts` — `ScreenId` с `"mode" | "weapon" | "boosts"`;
  - `app/App.tsx:171-176` — их `case`;
  - `app/lazy-screens.tsx` — `loaders.weapon`, `loaders.boosts`,
    `WeaponScreen`, `BoostsScreen`, `preloadScreens()`.
- **Значки:**
  - оружия — `ItemTile` и `WEAPON_ICONS` в `screens/item-icons.tsx`, тон
    `bg-weapon/15 text-weapon`;
  - бустов — `boostIcon` в `screens/boost-icons.ts`, тон `bg-info/15 text-info`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Новый `screens/pre-run-rules.ts`** — чистые правила листа, без React:

   ```ts
   export type PreRunMode = "endless" | "dev" | "stress";

   /** Вкладки режимов: только открытые; одна «Бесконечный» — вкладок нет вовсе (`[]`). */
   export function preRunModes(access: { devMode: boolean; stressTest: boolean }): PreRunMode[];

   /** Состояние плитки буста: выбрана, приглушена (не по карману или выбрано максимум). */
   export function boostTileState(input: {
     id: string;
     selected: readonly string[];
     price: { resource: "coins" | "gems"; amount: number };
     catalog: readonly { id: string; resource: string; amount: number }[];
     balances: { coins: number; gems: number } | null;
     maxPerRun: number;
   }): { chosen: boolean; disabled: boolean };

   /** Что спишется за выбранные бусты — по валютам, нулевые не попадают. */
   export function boostCost(selected: readonly string[], catalog: readonly { id: string; resource: string; amount: number }[]): { coins?: number; gems?: number };

   /** Какой буст описывать: последний тронутый, если он ещё выбран или просто тронут; иначе — последний выбранный; иначе — никакой. */
   export function boostToDescribe(touched: string | null, selected: readonly string[]): string | null;
   ```

   Логика `boostTileState` — та же, что сейчас в `BoostPicker`:
   - `affordable = chosen || wallet - spentInThatResource >= price.amount`;
   - `full = !chosen && selected.length >= maxPerRun`;
   - `disabled = !chosen && (!affordable || full)`.

   Перенести её сюда, а не написать заново.
3. **Новый `screens/pick-tile.tsx` — плитка выбора, общая у оружия и бустов**
   (компоненты макета):

   ```ts
   export function PickTile(props: {
     icon: ReactNode;
     tone: "weapon" | "info";
     name: string;
     /** справа от значка: цена буста или замок с уровнем у закрытого оружия */
     corner?: ReactNode;
     selected: boolean;
     /** закрытое оружие — замок, нажатие ничего не делает */
     locked?: boolean;
     /** буст не по карману или выбрано максимум — приглушён до 40% */
     disabled?: boolean;
     onClick?: () => void;
   }): ReactNode;
   ```

   - **Раскладка — две строки:**
     - сверху значок 28 px в подложке своего тона и `corner` справа;
     - ниже имя `font-display` 12.5 px во всю ширину, многоточием, если не
       влезло.
   - **Выбрана:**
     - рамка `ring-2 ring-accent`, свечение;
     - галочка в квадрате акцента 16 px в правом верхнем углу (`Check` из
       lucide);
     - `aria-pressed`.
   - **Закрыта** — `opacity-55`, значок приглушён, `aria-disabled`.
   - **Приглушена** — `disabled`, `opacity-40`, как сейчас у бустов.
   - Анимация — только `transform`: `active:scale-[0.98]`, как у бустов.
4. **`screens/boost-picker.tsx`** — перейти на плитки:
   - сетка `grid grid-cols-3 gap-1.5`, плитка — `PickTile` с
     `corner` = значок валюты и цена;
   - состояние плитки — `boostTileState`;
   - под сеткой:
     - описание буста из `boostToDescribe` — подложка ниже поверхности,
       имя `font-display` и текст `descriptionKey`;
     - если описывать нечего — строка `prerun.boosts.hint`;
   - заголовок раздела — `boosts.title`, справа мелко
     `prerun.boosts.count` (`{count} из {max}`);
   - новый обязательный проп `onTouch(id: string): void` — какой буст тронули
     последним, лист хранит его у себя;
   - пропы `heading` и прежняя раскладка списком уходят: другой страницы с
     бустами нет;
   - без сети и без каталога — как сейчас.
5. **Новый `screens/pre-run.tsx`** — `PreRunSheet({ onClose }: { onClose: () => void })`:
   - `Modal placement="bottom"`, заголовок `weapon.select.screen` («Перед
     забегом»), `onDismiss={onClose}`;
   - **вкладки режимов** — `SegmentedControl`:
     - вкладки — `preRunModes(useToolsAccess())`;
     - подписи — `mode.endless`, `prerun.mode.dev`, `prerun.mode.stress`;
     - рисуется, только если вкладок больше одной;
     - при открытии листа активна «Бесконечный» и вызывается
       `useDevMode.getState().arm(false)`;
     - вкладка «Разработчика» — `arm(true)`, сверху карточка «Настроить режим
       разработчика». Перенести её из `WeaponScreen` как есть, вместе с
       `DevSheetLazy`;
     - вкладка «Стресс» — вместо выбора текст `mode.stress.description` и
       кнопка `prerun.stress.open`: `onClose()`, затем `navigation.push("stress")`.
       Бустов и «В бой» на этой вкладке нет;
   - **сложность** — `SegmentedControl` с `label={t("difficulty.title")}`, без
     `SectionTitle`, под ним описание, как сейчас;
   - **оружие:**
     - `SectionTitle` `weapon.select.title`;
     - сетка `grid grid-cols-3 gap-1.5` из `PickTile`;
     - значок — `ItemTile` в размере плитки или та же иконка из `WEAPON_ICONS`;
     - закрытое — `locked`, `corner` = `Lock` 11 px и
       `weapon.select.locked.short` («ур. {level}»);
     - под сеткой — описание выбранного: имя и `descriptionKey`;
     - уровень, открытое и порядок — как в `WeaponScreen`, перенести;
   - **бусты** — `BoostPicker`, только с входом, как сейчас
     (`capabilities.auth !== undefined`);
   - **подвал:**
     - ошибка покупки — строкой над кнопкой, `role="alert"`;
     - `Button size="l" block glow` «В бой» (`boosts.start`);
     - есть выбранные бусты — второй строкой в кнопке `prerun.cost`
       («спишется») и суммы из `boostCost` со значками валют;
   - **«В бой»:**
     1. `meta.rememberWeapon(selected)`;
     2. выбраны бусты и есть каталог → `buyBoosts(createId(), boosts, catalog)`;
        не прошло — текст ошибки по тем же правилам, что в `BoostsScreen`, лист
        остаётся открытым;
     3. иначе или после успеха — `useRun.getState().intend(...)` так же, как
        сейчас;
     4. `onClose()`, затем `navigation.push("run")`. Стек из лобби — `["lobby", "run"]`:
        назад из забега — на главную.

     Пока идёт покупка, кнопка `loading` и `disabled`.
6. **`screens/home.tsx`:**
   - состояние `preRunOpen`;
   - «Играть» и «Новый забег» после подтверждения открывают лист;
   - лист — ленивым `PreRunSheetLazy` из `lazy-screens.tsx` в `Suspense` без
     заглушки: лобби и так подгружает его заранее;
   - `ModeScreen` удалить вместе с неиспользуемыми импортами.
7. **Удалить** `screens/weapon-select.tsx` и `screens/boosts.tsx`: их части
   переехали в `pre-run.tsx`. **Маршруты:**
   - из `ScreenId` убрать `"mode" | "weapon" | "boosts"`;
   - в `App.tsx` убрать их `case`;
   - в `lazy-screens.tsx` вместо `loaders.weapon` и `loaders.boosts` —
     `loaders.prerun: () => import("../screens/pre-run")` и
     `export const PreRunSheetLazy = lazy(...)`;
   - `preloadScreens()` подгружает `prerun` вместо двух прежних.

   Если в `lazy-screens.tsx` есть комментарий про чанк выбора оружия, — он
   теперь про лист.
8. **Тексты.**
   - `ru.json`:

     ```json
     "prerun.mode.dev": "Разработчика",
     "prerun.mode.stress": "Стресс",
     "prerun.stress.open": "Открыть стресс-тест",
     "prerun.cost": "спишется",
     "weapon.select.locked.short": "ур. {level}"
     ```
   - `ru-boosts.json`:

     ```json
     "prerun.boosts.count": "{count} из {max}",
     "prerun.boosts.hint": "Действуют один забег и списываются на «В бой». Выберите буст — здесь появится, что он даёт."
     ```
   - **Ключи, которые перестали использоваться, удалить.** Каждый — после
     поиска по `packages/` и `apps/`: если ключ где-то ещё нужен (гайдбук,
     витрина компонентов), он остаётся.
     - `mode.title`, `mode.endless.description`;
     - `mode.campaign`, `mode.campaign.description`;
     - `mode.dev.badge`, `mode.dev.description`, `mode.stress.badge`;
     - `weapon.select.next`, `weapon.select.hint`, `weapon.select.start`;
     - `boosts.skip`, `boosts.hint`.

     Список удалённых — в описании PR.
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Сам стресс-тест (`screens/stress/`) и лист режима разработчика
  (`DevSheet`) — переносится только карточка, которая их открывает.
- Покупку бустов на сервере и `state/boosts-api.ts`.
- Плашки бустов в забеге (`run/RunBoosts.tsx`).
- Подтверждение «Новый забег» — его текст и кнопки.

## Сценарий и интерфейс

По макету `design/screens/pre-run.html`, ширина 360 px. Снимки на 320, 390,
768 и 1440 px снимают тимлиды при приёмке, как у T-0012. На 768 и 1440 px
лист — `Modal` с прежней шириной листа, главная видна вокруг.

1. **Обычный забег.** «Играть» → лист.
   - Выбраны последняя сложность и оружие, бусты не выбраны.
   - «В бой» → забег без покупки.
   - На 360 px лист помещается без прокрутки.
2. **Новичок, уровень 1:**
   - Очаг, Гроза и Жало — с замком и «ур. 2», «ур. 4», «ур. 6»;
   - бусты не по карману приглушены, но видны.
3. **Три буста.** Остальные приглушены. Под плитками — описание последнего
   тронутого. В кнопке — «спишется» и суммы в обеих валютах.
4. **Покупка не прошла.** Причина над кнопкой, лист открыт, выбор на месте.
   Повтор — той же кнопкой.
5. **Нет сети:**
   - вместо плиток бустов — `boosts.offline`;
   - «В бой» работает: забег идёт без сервера.

   Без входа раздела бустов нет вовсе.
6. **Команда:**
   - вкладки «Бесконечный · Разработчика · Стресс» — только открытые;
   - на 320 px тело листа может прокручиваться под шапкой и кнопкой: шапка и
     подвал `Modal` не уезжают.
7. **Закрытие** — крестик, тап по затемнению, «Назад» Telegram и Escape.
   Выбор сложности и оружия при этом запомнен, бусты — нет.

## Тесты

Первым коммитом.

- **`packages/app-shell/test/pre-run-rules.test.ts`:**
  - `preRunModes`:
    - без доступа → `[]`;
    - только разработчика → `["endless", "dev"]`;
    - оба → `["endless", "dev", "stress"]`;
    - только стресс → `["endless", "stress"]`;
  - `boostTileState`:
    - выбранная плитка не приглушается, даже если денег уже не хватает;
    - на 3 из 3 остальные приглушены;
    - буст за самоцветы при 2 самоцветах и цене 4 приглушён, за монеты — нет;
    - уже выбранный буст за монеты уменьшает доступное для следующего за
      монеты;
    - `balances: null` (кошелёк не загружен) — правило то же, что сейчас в
      `BoostPicker`: перенести его без изменений и проверить кейсом;
  - `boostCost`:
    - пусто → `{}`;
    - Ярость + Щит + Фора → `{ coins: 270, gems: 4 }`;
    - неизвестный id не ломает подсчёт;
  - `boostToDescribe`:
    - тронутый, но снятый с выбора, описывается, пока не тронут другой;
    - ничего не тронуто → последний выбранный;
    - ничего → `null`.
- **`packages/app-shell/test/navigation.test.ts`:**
  - в кейсах стека `"mode"` и `"weapon"` заменить на существующие экраны —
    `"settings"`, `"stress"`;
  - смысл кейсов тот же.
- Существующие тесты бустов (`boosts-texts.test.ts`, `run-boosts.test.ts`) —
  зелёные. Если тест текстов требует ключи, которые шаг 8 удаляет, — поправить
  тест под новые ключи и отметить это в PR.

## Аналитика

Новых событий нет. Как сейчас: старт забега и покупка бустов пишут свои
события в тех же местах кода, что и раньше. Переносом не потерять ни одного
`track(...)` из `weapon-select.tsx` и `boosts.tsx`. Если они там есть — тот
же вызов в `pre-run.tsx`, список — в описании PR.

## Настройки и окружение

Нет.

## Документы

- `docs/27-design-system-and-app-shell.md`, каталог экранов:
  - строки «Выбор режима», «Перед забегом» и «Бусты на забег» заменить одной
    — «Перед забегом», лист поверх главной, по Р88 и макету;
  - строку «Забег разработчика» поправить: вкладка листа, а не пункт экрана
    режимов;
  - в разделе о чанках (§3.4) — что лист «Перед забегом» грузится своим чанком.
- Документы с упоминанием экрана «Режим» и шага «Бусты на забег» как
  действующих — найти поиском и поправить одной строкой со ссылкой на Р88.
  Исторические разделы «Как сделано» не переписывать.

## Критерии приёмки

- [ ] «Играть» → лист «Перед забегом» → «В бой»: два касания до боя.
- [ ] Сложность, оружие плитками с описанием выбранного и бусты плитками с
  описанием тронутого — в одном листе. Правила бустов прежние.
- [ ] Сумма к списанию — в кнопке «В бой». Неудачная покупка оставляет лист
  открытым с причиной.
- [ ] Вкладки режимов — только у тех, кому они открыты. Стресс-тест и забег
  разработчика работают, как раньше.
- [ ] Экранов «Режим», отдельных «Перед забегом» и «Бусты на забег» нет; назад
  из забега — на главную.
- [ ] Лист — своим чанком; `pnpm budget` не вырос.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Окно «Перед забегом» одним листом`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: Сложность, оружие и бусты — в одном окне: «Играть» и сразу «В бой».`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — «ПЕРЕД ЗАБЕГОМ» ОДНИМ ЛИСТОМ**

  До боя теперь два касания вместо четырёх: «Играть» открывает лист со сложностью, оружием и бустами, дальше — «В бой».

  ⚔️ **Что изменилось**

  • экрана выбора режима нет; забег разработчика и стресс-тест — вкладками в листе, только тем, кому открыты
  • оружие и бусты — плитками с описанием выбранного; сумма к списанию — прямо в кнопке «В бой»
  • назад из забега — сразу на главную

  ❓ **Нужно от команды**

  • @участник1 — сыграть пару забегов с бустами и без, сказать, удобно ли
  ```
