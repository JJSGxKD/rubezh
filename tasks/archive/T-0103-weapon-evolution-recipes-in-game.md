---
id: T-0103
title: Рецепты эволюций в игре: подсказка на карточке, гайдбук, значок готовности
epic: E10
priority: P1
status: done
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead2-15
size: M
depends_on: [T-0102, T-0100]
zones:
  - packages/app-shell/src/screens/run/evolution-hints.ts
  - packages/app-shell/src/screens/run/overlays.tsx
  - packages/app-shell/src/screens/run/RunHud.tsx
  - packages/app-shell/src/screens/run/RunStatsSheet.tsx
  - packages/app-shell/src/screens/run/death-parts.tsx
  - packages/app-shell/src/screens/meta/run-detail.tsx
  - packages/app-shell/src/screens/item-icons.tsx
  - packages/app-shell/src/screens/guide/GuideScreen.tsx
  - packages/app-shell/src/screens/guide/guide-data.ts
  - packages/app-shell/test/**
shared:
  - packages/app-shell/src/i18n/ru-run.json
  - packages/app-shell/src/i18n/ru-guide.json
  - packages/app-shell/src/i18n/ru-account.json
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: null
batch: 2
---

# T-0103. Рецепты эволюций в игре: подсказка на карточке, гайдбук, значок готовности

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0103.json)](../README.md#значки-статуса) [![T-0102](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0102.json&label=T-0102)](T-0102-weapon-evolutions-data-and-engine.md) [![T-0100](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0100.json&label=T-0100)](T-0100-run-chest-window.md)

## Зачем

Эволюции (T-0102) работают, но игрок о них не знает: рецепт нигде не написан, а
в Telegram вики рядом нет. После задачи рецепт виден там, где игрок решает: на
карточке оружия и навыка, в паузе, в гайдбуке (в том числе закрытый уровнем
аккаунта), а готовая к эволюции сборка отмечена в HUD.

## Решения

Источники: `docs/39-retention-mechanics.md` Б2 («рецепт виден на карточке и в
гайдбуке») и К3 («рецепты эволюций видны под замком»); Р102. Только оболочка и
словари; правила эволюций, `evolutionProgress`, `weaponPowerIndex`, `BASE_WEAPONS`,
`WEAPON_EVOLUTIONS` приходят готовыми из T-0102 через `@bh/core-game`.

1. **Подсказка на карточке — не больше одной строки, и только когда есть смысл.**
   - Карточка **оружия** (`weapon_new`, `weapon_level`), у которого есть
     эволюция и она ещё не получена: «С навыком «{passive}» станет
     «{evolution}»» (`run.evolution.hintWeapon`). Если карточка доводит оружие
     до максимума, а навык уже в наборе: «Максимум! С «{passive}» сундук даст
     «{evolution}»» (`run.evolution.hintWeaponReady`).
   - Карточка **навыка** (`passive_new`, `passive_level`), входящего в рецепт,
     **при условии что базовое оружие рецепта уже в наборе**: «Нужен «{weapon}»
     на максимуме — получится «{evolution}»» (`run.evolution.hintPassive`).
     Если базового в наборе нет, подсказки нет: она была бы шумом.
   - На `weapon_evolve`, `heal` и на карточках без рецепта подсказки нет.
   - Подсказка — текст `text-xs` на `surface-sunken` под списком изменений, с
     значком `Sparkles`; цвета только токенами, без анимации.
2. **Готовность в HUD — статичный значок, не анимация.** На слоте оружия в
   `RunHud.tsx`, у которого эволюция в состоянии `ready`, в углу значок
   `Sparkles` (12 px, токен акцента) и `title` «…· готово к эволюции». HUD
   перерисовывается не чаще 10 раз в секунду (`CLAUDE.md`), расчёт — по
   `hud.weapons` и `hud.passives`, дешёвый. Пульсации нет: заметную анимацию
   добавляют вместе с переключателем настроек, а здесь его нет.
3. **Пауза и лист «Характеристики»** (`RunStatsSheet.tsx`, вкладка оружия) — под
   оружием, у которого есть эволюция, строка по состоянию: `waiting` —
   «Эволюция «{evolution}»: максимум оружия и навык «{passive}»»
   (`run.evolution.recipe`); `ready` — «Готово к эволюции «{evolution}» — нужен
   сундук» (`run.evolution.ready`); `done` и `absent` — строки нет.
4. **У эволюции вместо уровня слово «Эволюция».** Единственный уровень «1» ничего
   не говорит: в `RunHud.tsx` (`Slot`), `RunStatsSheet.tsx:108`, `death-parts.tsx:268`
   и `meta/run-detail.tsx:186` для оружия из `WEAPON_EVOLUTIONS` показывается
   «Эволюция» (`run.evolution.badge`; в истории — ключ `runDetail.weaponEvolved`
   в `ru-account.json`, там же лежит `runDetail.weaponLevel`).
5. **Гайдбук: раздел «Эволюции» во вкладке «Оружие»**, третьим заголовком после
   «Открывает уровень аккаунта». Строка на эволюцию: значки «оружие + навык →
   эволюция», описание эволюции, «Примерно в {ratio} раза сильнее максимума
   оружия» (`weaponPowerIndex` эволюции к последнему уровню базового, одна
   цифра после запятой, `formatDecimal`) и подпись открытия.
   - Рецепт открывается на уровне `max(unlockLevel(оружие), unlockLevel(навык))`.
   - Если уровень аккаунта игрока ниже, строка **под замком**: значок
     `Lock`, приглушённый вид, «Откроется на {level} уровне»
     (`guide.evolution.locked`); иначе «С {level} уровня» (`guide.unlock.level`,
     уже есть). Название и описание эволюции видны и под замком.
   - Уровень аккаунта берётся так же, как в `screens/pre-run.tsx` для замков
     оружия (переменная `level` в строке ~94: найти источник и использовать его).
6. **Значки эволюций** — в `WEAPON_ICONS` (`item-icons.tsx`), из `lucide-react`,
   уже стоящего в зависимостях: `starfall` — `Sparkles`, `tempest` — `Tornado`,
   `blade_whirl` — `Swords`, `frost_crown` — `Snowflake`, `forge` — `Anvil`,
   `viper` — `Biohazard`. Нет иконки в установленной версии — взять ближайшую и
   назвать замену в PR. Версию зависимости не менять.
7. **Новых настроек нет**: подсказки — текст, значок статичен, анимаций и звуков
   не добавляется (`CLAUDE.md`, «Настройки не отстают от игры»).
8. **Правила — чистые функции в `screens/run/evolution-hints.ts`**, чтобы их
   проверяли тесты без отрисовки (в среде тестов оболочки компоненты не рисуются).
9. **Карточка `weapon_evolve`** (награда сундука): `kindOf` в `overlays.tsx` даёт
   для неё `"weapon"`; `OfferTag` — `Badge tone="accent"` со значком `Sparkles` и
   текстом `run.levelUp.evolve` = «Эволюция» (`ru-run.json`, рядом с
   `run.levelUp.new`).

## Как сейчас

- Оружие и вид варианта: `Card` и `ChangeList` в `screens/run/overlays.tsx:222-280`
  (`kindOf` — всё, кроме двух видов оружия, «навык»; `OfferTag`); слоты HUD —
  `RunHud.tsx:129-133`, `Slot` (146-162) показывает значок и число уровня;
  `RunStatsSheet.tsx:104-110` — `run.stats.level`; итог — `death-parts.tsx:262-270`;
  история — `meta/run-detail.tsx:186`.
- `screens/item-icons.tsx` — `WEAPON_ICONS[id] ?? Sparkles`: запасной значок
  работает, но у эволюции должен быть свой.
- Гайдбук: `GuideScreen.tsx:287-302` — вкладка «Оружие» из двух списков;
  `guide-data.ts:70-85` — `unlockLevel`, `firstLevelWeapons`, `levelWeapons`
  (после T-0102 на `BASE_WEAPONS`).
- Словари: `ru-run.json` (`run.levelUp.*`), `ru-guide.json` (`guide.weapons.*`,
  `guide.unlock.level`), `ru-account.json` (`runDetail.weaponLevel`).
- Из T-0102 готово: `evolutionProgress(defs, loadout)`, `EvolutionState`,
  `weaponPowerIndex`, `WEAPON_EVOLUTIONS`, `BASE_WEAPONS`, `EVOLUTION_POWER_RATIO`.
  Сундук (T-0099) кладёт вариант `weapon_evolve` в `ChestOpening.rewards`; окно
  сундука делает T-0100: если оно уже влито, тег и значок из решения 9 проверить и
  в нём, правя минимум.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`screens/run/evolution-hints.ts`** (новый, до 120 строк, без React):
   - `hintForOffer(offer: UpgradeOption, loadout: LoadoutIds): OfferHint | null`
     где `OfferHint = { key: "run.evolution.hintWeapon" | "run.evolution.hintWeaponReady" | "run.evolution.hintPassive"; params: Record<string, string> }`
     (имена подставляются через `t(nameKey)` уже в компоненте — в правилах
     лежат id);
   - `slotEvolutionState(loadout: LoadoutIds, weaponId: string): EvolutionState`
     поверх `evolutionProgress`;
   - `isEvolutionWeapon(id: string): boolean` — `id` есть в `WEAPON_EVOLUTIONS`.
3. **Карточка:** в `overlays.tsx` вывести подсказку из `hintForOffer` и тег
   `weapon_evolve` (решение 9); набор для
   правила берётся из HUD-снимка (`hud.weapons`, `hud.passives`), который экран
   уже держит.
4. **HUD и пауза:** значок готовности на слоте, строки состояния в
   `RunStatsSheet.tsx`, «Эволюция» вместо уровня в четырёх местах (решение 4).
5. **`guide-data.ts`:** `evolutionRecipes(accountLevel: number)`:
   `{ evolution, weapon, passive, unlockLevel, locked, powerRatio }[]` в порядке
   контента; `GuideScreen.tsx` — раздел с `SectionTitle` «Эволюции»
   (`guide.weapons.evolutions`) и строкой на рецепт (карточкой `Card` как у
   `WeaponCard`, без `WeaponScene`).
6. **`item-icons.tsx`:** значки из решения 6 и `export function hasOwnWeaponIcon(id: string): boolean`.
7. **Тексты** (ключи и текст дословно):
   - `ru-run.json`: `run.evolution.hintWeapon` — «С навыком «{passive}» станет «{evolution}»»;
     `run.evolution.hintWeaponReady` — «Максимум! С «{passive}» сундук даст «{evolution}»»;
     `run.evolution.hintPassive` — «Нужен «{weapon}» на максимуме — получится «{evolution}»»;
     `run.evolution.recipe` — «Эволюция «{evolution}»: максимум оружия и навык «{passive}»»;
     `run.evolution.ready` — «Готово к эволюции «{evolution}» — нужен сундук»;
     `run.evolution.badge` — «Эволюция»; `run.evolution.slotReady` — «готово к эволюции»;
   - `ru-guide.json`: `guide.weapons.evolutions` — «Эволюции»;
     `guide.weapons.evolutionsIntro` — «Доведи оружие до максимума, возьми нужный навык — и сундук забега превратит оружие в сильную версию. Навык можно любого уровня»;
     `guide.evolution.recipe` — «{weapon} + {passive} → {evolution}»;
     `guide.evolution.power` — «Примерно в {ratio} раза сильнее максимума оружия»;
     `guide.evolution.locked` — «Откроется на {level} уровне»;
   - `ru-account.json`: `runDetail.weaponEvolved` — «Эволюция».
8. **Документы** (раздел «Документы»), затем гейт.

## Чего не трогаем

- Правила эволюций, `evolutionProgress`, контент и числа эволюций, события —
  T-0102. Движок и `core-game` вне чтения готовых экспортов не правятся.
- Сундук и его экран выдачи — T-0099; на карточках сундука подсказка берётся
  из того же `hintForOffer`, но саму карточку сундука эта задача не меняет.
- Таблицу открытий `content/unlocks.ts`: замок гайдбука читает её как есть.
- Звук, вибрацию, новые настройки, анимацию значка.
- Галерею компонентов `screens/gallery.tsx` — по желанию, в зону не входит.

## Сценарий и интерфейс

Игрок поднимает «Искру» до 7-го уровня. На карточке «Искра, уровень 8» под
строками изменений: «Максимум! С «Спешка» сундук даст «Звездопад»» (если
«Спешка» уже есть) или «С навыком «Спешка» станет «Звездопад»» (если нет). На
карточке «Спешка» при «Искре» в наборе: «Нужен «Искра» на максимуме — получится
«Звездопад»». «Искра» на 8-м и «Спешка» в наборе — на слоте в HUD значок, в паузе
«Готово к эволюции «Звездопад» — нужен сундук». После эволюции вместо цифры
уровня — «Эволюция». Загрузки, пустоты, ошибки и сети нет: всё из контента и
снимка HUD; закрытый уровнем рецепт в гайдбуке — под замком. Макета нет.

## Тесты

Первым коммитом. Новые: `app-shell/test/evolution-hints.test.ts`. Правки:
`guide.test.ts`, `i18n.test.ts` (если проверяет словари по шаблону).

`hintForOffer` (набор — простые списки `{ id, level }`):
- `weapon_new` «Искра», набор пуст → `hintWeapon`, `passive: "haste"`,
  `evolution: "starfall"`;
- `weapon_level` «Искра» до 8-го уровня, «Спешка» в наборе → `hintWeaponReady`;
- то же, «Спешки» нет → `hintWeapon`;
- `weapon_level` «Искра» до 5-го уровня, «Спешка» в наборе → `hintWeapon`;
- `passive_new` «Спешка», «Искра» в наборе → `hintPassive`, `weapon: "spark"`;
- `passive_level` «Спешка», «Искры» в наборе нет → `null`;
- `passive_new` «Мощь» (в рецептах не участвует) → `null`;
- `weapon_evolve`, `heal` → `null`;
- эволюция уже в наборе: карточка базового оружия (теоретически) → `null`.

Остальное:
- `slotEvolutionState`: «Искра» на 8-м и «Спешка» → `ready`; на 8-м без навыка
  → `waiting`; «Звездопад» в наборе → `done`; оружия без эволюции → `absent`;
- `isEvolutionWeapon("starfall")` — `true`, `("spark")` — `false`;
- `evolutionRecipes(1)`: шесть строк в порядке контента; `starfall`,
  `blade_whirl`, `frost_crown` не закрыты; `forge`, `tempest`, `viper` закрыты;
  `unlockLevel` у каждой равен `max(unlockLevel(оружие), unlockLevel(навык))`;
  `evolutionRecipes(6)` — ни одной закрытой;
- `powerRatio` каждой строки лежит в `EVOLUTION_POWER_RATIO`;
- `hasOwnWeaponIcon` — `true` для всех id из `WEAPON_EVOLUTIONS`;
- все ключи из решений 1-5 есть в словарях (`hasTranslation`), а подстановки
  `{passive}`, `{evolution}`, `{weapon}`, `{ratio}`, `{level}` в текстах
  совпадают с параметрами, которые передаёт код;
- гайдбук: у каждой эволюции есть строка рецепта (дополнить `guide.test.ts`).

## Аналитика

Нет: подсказки и значки не действия игрока, а чтение. Получение эволюции уже
пишет `evolution_unlocked` (T-0102). Если понадобится знать, кто видел рецепт в
гайдбуке, это общий `screen_viewed`.

## Настройки и окружение

Нет.

## Документы

- `docs/27-design-system-and-app-shell.md` — в разделе про экран выбора
  улучшения и HUD: подсказка рецепта на карточке, статичный значок готовности,
  «Эволюция» вместо уровня.
- Гайдбук обязан описывать то, что есть (`CLAUDE.md`): раздел «Эволюции» —
  часть этой задачи, отдельной правки документов гайдбука нет.

## Вопросы к тимлиду

Исполнитель не ждёт ответов; �Подтверждено `claude-lead-1` 13.10.2026:

- Макет подсказки и значка не заказывался: строим на существующих компонентах.
  Нужен макет от дизайнера — отдельная задача, формулировки здесь не меняются.
- Значок готовности статичный. Если хочется мигания, нужны анимация и
  переключатель настроек (`docs/27` §7.1): отдельное решение.
- Номера уровней в строке «Откроется на {level} уровне» зависят от лестницы
  открытий (К3): задача читает таблицу как есть, правки при её смене не нужны.

## Критерии приёмки

- [ ] `hintForOffer`, `slotEvolutionState`, `isEvolutionWeapon` — чистые функции
  без React; тесты из раздела «Тесты» зелёные.
- [ ] На карточках оружия и навыка рецепта показывается ровно одна строка
  подсказки по правилам решения 1, на остальных карточках её нет.
- [ ] На слоте оружия в HUD у готовой эволюции виден статичный значок; в паузе
  строка состояния по решению 3.
- [ ] У оружия-эволюции в HUD, паузе, итоге забега и истории — «Эволюция»
  вместо уровня.
- [ ] В гайдбуке вкладка «Оружие» содержит раздел «Эволюции» с шестью
  рецептами; закрытые уровнем аккаунта — под замком с уровнем.
- [ ] У каждой эволюции свой значок (`hasOwnWeaponIcon`).
- [ ] Дифф только в зонах задачи; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(app-shell): Показать рецепты эволюций в игре`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: на карточках оружия и навыков подсказка, с чем оружие эволюционирует; значок «готово к эволюции» в бою и раздел «Эволюции» в гайдбуке`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РЕЦЕПТЫ ЭВОЛЮЦИЙ В ИГРЕ**

  Игрок видит, как оружие эволюционирует: подсказка на карточках, значок готовности в бою, строки в паузе и раздел «Эволюции» в гайдбуке, где рецепты закрытого оружия лежат под замком с уровнем.

  🛠 **Что сделано**

  • правила подсказок вынесены в чистые функции с тестами
  • у оружия-эволюции вместо уровня слово «Эволюция» в HUD, паузе, итоге и истории
  • у шести эволюций свои значки
  ```
