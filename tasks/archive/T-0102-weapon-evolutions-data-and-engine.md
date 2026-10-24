---
id: T-0102
title: Эволюции оружия: рецепты в контенте и выдача сундуком
epic: E10
priority: P1
status: done
owner: claude-13 / sonnet-5.5 / high
author: claude-lead2-15
size: M
depends_on: [T-0099, T-0101]
zones:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/content/weapons.ts
  - packages/core-game/src/content/balance-targets.ts
  - packages/core-game/src/game/weapons/weapon-types.ts
  - packages/core-game/src/game/progression/evolutions.ts
  - packages/core-game/src/game/progression/levels.ts
  - packages/core-game/src/game/progression/upgrade-changes.ts
  - packages/core-game/src/game/progression/unlocks.ts
  - packages/core-game/src/game/sim/chests.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/run-world.ts
  - packages/core-game/src/game/balance/simulate.ts
  - packages/core-game/src/game/run/cues.ts
  - packages/core-game/src/index.ts
  - packages/core-game/test/**
  - scripts/balance/balance-sim.ts
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/state/analytics.ts
  - packages/app-shell/src/state/dev-mode.ts
  - packages/app-shell/src/screens/pre-run.tsx
  - packages/app-shell/src/screens/meta/level.tsx
  - packages/app-shell/src/screens/guide/guide-data.ts
  - packages/app-shell/test/**
  - packages/app-shell/src/screens/run/chest-rules.ts
  - backend/api/src/modules/tasks/task-rules.ts
shared:
  - backend/api/src/modules/events/event-dictionary.ts
  - packages/app-shell/src/i18n/ru.json
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/32-balance.md
  - CLAUDE.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 2
---

# T-0102. Эволюции оружия: рецепты в контенте и выдача сундуком

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0102.json)](../README.md#значки-статуса) [![T-0099](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0099.json&label=T-0099)](T-0099-run-chest-engine.md) [![T-0101](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0101.json&label=T-0101)](T-0101-card-reroll-skip-banish.md)
[![T-0095](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0095.json&label=T-0095)](T-0095-hearth-no-tick-sound.md) [![T-0099](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0099.json&label=T-0099)](T-0099-run-chest-engine.md) [![T-0100](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0100.json&label=T-0100)](T-0100-run-chest-window.md) [![T-0101](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0101.json&label=T-0101)](T-0101-card-reroll-skip-banish.md) [![T-0102](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0102.json&label=T-0102)](T-0102-weapon-evolutions-data-and-engine.md) [![T-0103](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0103.json&label=T-0103)](T-0103-weapon-evolution-recipes-in-game.md) [![T-0108](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0108.json&label=T-0108)](T-0108-unlock-ladder.md)

## Зачем

Оружие доводят до восьмого уровня, и дальше хотеть нечего: у сборки нет цели.
Эволюция даёт её: оружие на максимуме плюс нужный навык превращаются в одну
сильную версию, и выдаёт её сундук забега (T-0099). Задача делает данные,
правила и движок; подсказки игроку, гайдбук и значки — T-0103.

## Решения

Источники: `docs/39-retention-mechanics.md` Б2 и §6 п.1; Р102
(`docs/35-stage4-plan.md`). Исполнитель их не пересматривает.

1. **Эволюцию выдаёт только сундук.** В карточках набора уровня её нет.
2. **Эволюция — запись в `WEAPONS`** после всех базовых, с `evolvedFrom` (id
   базового) и `recipe: { passive }`. Один уровень; то же поведение и та же
   стихия, что у базового.
3. **Рецепт:** базовое на максимальном уровне (`levels.length`, сейчас 8) и
   навык рецепта в наборе, **любого уровня** (забеги короткие).
4. **Эволюция занимает слот базового:** меняются `typeIndex` и `level` (на 1),
   перезарядка и направление остаются; слоты и пассивки не трогаются. Урон
   `damageByWeapon` копится по слоту и в итоге забега считается целиком.
5. **Генератор не используется.** Готовых рецептов несколько — берётся первый
   по порядку в `WEAPONS`. Эталоны забегов без эволюции не двигаются.
6. **В `content/unlocks.ts` эволюции не вносятся:** открыты вместе с базовым.
   Правило «каждое оружие открывается ровно на одном уровне» относится к
   базовым; тест передаёт в `findUnlockProblems` только их.
7. **Одна пассивка — один рецепт; у базового одна эволюция.** Новое оружие
   приходит сразу с эволюцией (`docs/39` К4). Эволюция не бывает стартовым оружием.
8. **Пары и числа — стартовые; геймдизайнер калибрует и утверждает.** Пары
   разведены по категориям (2 атаки, 2 мобильности, 2 защиты): слотов атаки 2,
   защиты 1, мобильности 1.

| Базовое, последний уровень | Навык | Эволюция | Единственный уровень |
|---|---|---|---|
| `spark`: 16, 0,15 с, 3 сн., пробив 2 | `haste` | `starfall` | урон 26, пауза 0,13, снарядов 4, пробив 3, скорость 700, жизнь 2,0 |
| `storm`: 30, 1,3 с, 4 удара, радиус 120, шанс 0,6 | `volley` | `tempest` | урон 42, пауза 1,05, ударов 6, радиус 135, шанс 0,75 |
| `knife`: 15, 0,24 с, 6 сн., пробив 4 | `swiftness` | `blade_whirl` | урон 22, пауза 0,2, снарядов 8, пробив 6, скорость 800, жизнь 1,6 |
| `wardstone`: 24, 0,28 с, 6 кам., радиус 98, шанс 0,35 | `lodestone` | `frost_crown` | урон 48, пауза 0,2, камней 6, радиус 124, скорость 560, шанс 0,6 |
| `hearth`: 13, 0,28 с, радиус 140, шанс 0,3 | `mending` | `forge` | урон 28, пауза 0,22, радиус 175, шанс 0,5 |
| `sting`: 11, 0,27 с, 3 сн., пробив 4, шанс 1 | `tempering` | `viper` | урон 18, пауза 0,22, снарядов 4, пробив 6, скорость 600, жизнь 2,0, шанс 1 |

   Сила — `damage · max(projectiles, 1) / cooldownSec`: по таблице эволюция
   сильнее максимума базового в 2,35–2,8 раза. Коридор теста —
   `EVOLUTION_POWER_RATIO = { min: 1.8, max: 3.5 }` в `balance-targets.ts`.
9. **Тексты** (ключи `weapon.<id>.name` и `weapon.<id>.description` в `ru.json`,
   рядом с `sting`): `starfall` — «Звездопад», «Искры сыплются градом: снарядов
   больше, летят быстрее и прошивают нескольких врагов.»; `tempest` — «Буря»,
   «Гроза без передышки: молнии бьют чаще, по большей площади, и шок передаётся
   дальше.»; `blade_whirl` — «Вихрь клинков», «Клинки разлетаются широким веером
   и прошивают целый строй.»; `frost_crown` — «Ледяной венец», «Шесть камней
   кружат широким венцом, бьют сильнее и холодят чаще.»; `forge` — «Горн»,
   «Очаг раздули до горна: зона шире, огонь жжёт сильнее и поджигает чаще.»;
   `viper` — «Гадюка», «Игла бьёт чаще, прошивает весь строй, и яд ложится
   слоями на каждого.»
10. **Звук, облик, настройки.** Звук эволюции — звук базового (`cues.ts` шлёт
    сигнал под id базового); облик снарядов — по поведению и стихии. Новых
    анимаций и звуков нет, поэтому нового переключателя настроек нет
    (`CLAUDE.md`, «Настройки не отстают от игры»).

## Как сейчас

- `shared-types/src/index.ts:819-832` — `WeaponDef` без `evolvedFrom`/`recipe`;
  `:1096-1102` — `UpgradeOptionKind` из пяти видов.
- `game/weapons/weapon-types.ts`: `WeaponType` (22-29), `findWeaponContentProblems`
  (72-91), `resolveWeaponTypes` (127-141), `MAX_PROJECTILES_PER_SHOT = 24` (65);
  `weapons/orbit.ts:16` — `MAX_ORBITERS = 6`.
- `game/progression/levels.ts`: `collectCandidates` (84-121) обходит **все**
  `world.weaponTypes`, эволюция попала бы в карточки как `weapon_new`. T-0099
  выносит из `chooseUpgrade` (217-252) `applyUpgrade(world, option)` с `switch` по
  виду варианта и экспортирует `collectCandidates`.
- **T-0099:** `game/sim/chests.ts` — `openChest(world, size)` `size` раз зовёт
  `collectCandidates`, тянет награду потоком `chests.rng`, сразу применяет её
  через `applyUpgrade` и копит в `ChestOpening.rewards`; событие `chestOpened`
  и `track("chest_opened")` в `state/run.ts` уже есть.
- `game/sim/create-world.ts:354-360` — `findStartingWeapon` берёт любой тип.
- `run-world.ts:49-55` и `balance/simulate.ts:65-70` фильтруют оружие по
  `open.weapons.has(weapon.id)`: эволюцию, которой нет в таблице, отрезало бы.
- `progression/upgrade-changes.ts:50-97` — `weaponChanges` сравнивает два уровня
  **одного** типа. `run/cues.ts:115` — звук по `weaponTypes[typeIndex].id`.
- Оболочка берёт весь `WEAPONS` для выбора и счёта: `screens/pre-run.tsx:98`,
  `meta/level.tsx:49,54`, `guide/guide-data.ts:79,84,137` (`unlockLevel` даёт
  `?? 1`: эволюция попала бы в «с первого уровня»), `state/dev-mode.ts:125`.
- `event-dictionary.ts:127-129` — события `upgrade_*`; `state/analytics.ts:24-26` —
  список имён. Бэкенд хранит оружие забега как `{ id: string; … }`: id эволюций
  проходят без правок.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»); падают, пока кода нет.
2. **Рефакторинг отдельным коммитом, поведение то же:** вынести из
   `weaponChanges` общую `diffWeaponLevels(type, previous, next, unitScale)`;
   `upgrade-changes.test.ts` зелёный без правок.
3. **Типы.** `shared-types`: `interface WeaponRecipe { passive: string }`; в
   `WeaponDef` — `evolvedFrom?: string`, `recipe?: WeaponRecipe`; в
   `UpgradeOptionKind` — `"weapon_evolve"`. В `WeaponType` — `evolvedFrom?`,
   `recipePassive?` (условным спредом: `exactOptionalPropertyTypes`). В
   `findWeaponContentProblems` одно правило: `evolvedFrom` и `recipe` — вместе.
4. **`game/progression/evolutions.ts`** (новый, до 150 строк):
   - `EvolutionState = "absent" | "waiting" | "ready" | "done"`; `LoadoutIds`
     `{ weapons, passives: readonly { id: string; level: number }[] }` (совместим
     с `RunSlotState[]`);
   - `evolutionProgress(defs, loadout): EvolutionProgress[]` — по записи на
     эволюцию в порядке контента: `{ evolutionId, weaponId, passiveId,
     weaponLevel: number | null, weaponMaxLevel, hasPassive, state }`. `done` —
     эволюция в наборе; `ready` — базовое на максимуме и навык в наборе;
     `waiting` — базовое в наборе, но не хватает уровня или навыка; `absent` —
     базового нет;
   - `readyEvolutionOption(world): UpgradeOption | null` — первый `ready`:
     `id: "weapon_evolve:<evolutionId>:1"`, `kind: "weapon_evolve"`, `refId` — id
     эволюции, `level: 1`, имя и описание эволюции, `changes` из `evolutionChanges`;
   - `applyEvolution(world, evolutionId): boolean` — решение 4 и
     `refreshPlayerStats`; `false`, если рецепт уже не выполнен;
   - `isWeaponOfferable(world, typeIndex)` — `false` для эволюции и для базового,
     чья эволюция уже в наборе; `weaponPowerIndex(level: WeaponLevel)` — формула
     решения 8; `describeEvolution(defs, id): { weaponId, passiveId } | null`;
     `findEvolutionProblems(defs, passiveIds): string[]`.
5. **`upgrade-changes.ts`:** `evolutionChanges(base, evolved, unitScale)` —
   «было → стало» между **последним уровнем базового и единственным уровнем
   эволюции** через `diffWeaponLevels`.
6. **`levels.ts`:** `collectCandidates` пропускает тип при `!isWeaponOfferable`;
   в `applyUpgrade` (T-0099) — `case "weapon_evolve"` → `applyEvolution(world,
   option.refId)`. Обращения к `world.rng` в существующих путях не меняются.
7. **Крючок в `sim/chests.ts`.** В начале `openChest`: `const evolution =
   readyEvolutionOption(world)`; не `null` — `applyUpgrade(world, evolution)`,
   запись в `rewards` **первой**, дальше цикл на `size − 1` наград (сундук из
   одной награды отдаёт только эволюцию). Генератор сундука на эволюцию не
   тратится. Остальное в `openChest` не трогать.
8. **Выбор оружия.** В `content/weapons.ts` после `WEAPONS`: `BASE_WEAPONS` и
   `WEAPON_EVOLUTIONS` (фильтры по `evolvedFrom`). В `progression/unlocks.ts`:
   `weaponsOpenAt(defs, open: AccountUnlocks): WeaponDef[]` — базовые из
   `open.weapons` и их эволюции; подставить в `run-world.ts:55` и
   `simulate.ts:70`. `findStartingWeapon` пропускает эволюции. В оболочке
   `BASE_WEAPONS` вместо `WEAPONS` в местах из «Как сейчас». Экспорт из
   `core-game/src/index.ts`.
9. **Контент:** шесть записей по таблице решения 8 после базовых;
   `EVOLUTION_POWER_RATIO`; тексты решения 9 в `ru.json`. `cues.ts`:
   `type.evolvedFrom ?? type.id`. В `balance/simulate.ts` и
   `scripts/balance/balance-sim.ts` колонка «эволюций» рядом с «сундуков»
   (T-0099): сколько слотов к концу забега заняли эволюции.
10. **Событие** `evolution_unlocked`: в обработчике `chestOpened` в
    `state/run.ts` — по награде с `kind === "weapon_evolve"`; `weapon` и
    `passive` из `describeEvolution(WEAPONS, reward.refId)`.
11. **Эталоны и баланс.** Эталоны, сдвинутые эволюциями (прогоны с сундуком),
    обновить отдельным коммитом и показать в PR. Сдвиг эталона **без** эволюции
    в прогоне — утечка генератора: искать, а не обновлять. Таблицу
    `pnpm balance:sim` приложить к PR. Затем документы и гейт.

## Чего не трогаем

- Сундук, его схему, шансы, облик, окно выдачи — T-0099 и T-0100; переброс, пропуск,
  изгнание — T-0101.
- Карточку `weapon_evolve`, подсказки, гайдбук, значки в HUD и значок эволюции
  в `item-icons.tsx` — T-0103 (до него эволюция рисуется запасным значком).
- `content/unlocks.ts` и `findUnlockProblems`: правила прежние. Лестница
  открытий — T-0108.
- `game/bench/full-load.ts` и его тест: 12 типов в полной загрузке — лишь тяжелее.
- Бэкенд, рендер, новые поведения оружия, объединения (Б5).

## Сценарий и интерфейс

Игрок собрал `spark` на 8-м уровне и взял «Спешку»; подобранный сундук первой
наградой превращает «Искру» в «Звездопад» (слот тот же), остальные награды
выдаются как обычно. Как это показать — окно сундука (T-0100) и T-0103; здесь
интерфейс не меняется, кроме выбора оружия на старте (эволюций в нём нет).

## Тесты

Первым коммитом. Новые: `core-game/test/evolutions.test.ts`,
`evolutions-content.test.ts`, `app-shell/test/weapon-lists.test.ts`. Правки:
`content.test.ts`, `account-unlocks.test.ts`, `cues.test.ts`,
`upgrade-changes.test.ts`, `run-snapshot.test.ts`, `chests.test.ts` (T-0099),
`telemetry.test.ts`, тест словаря событий бэкенда.

Контент (негативы — на синтетических `WeaponDef`, сообщение называет оружие и поле):
- `findEvolutionProblems(WEAPONS, id навыков)` и `findWeaponContentProblems(WEAPONS)` → `[]`;
- у каждого базового ровно одна эволюция, она стоит после всех базовых, уровень
  один, сила в `EVOLUTION_POWER_RATIO`; ключи имени и описания есть в `ru.json`;
- негативы: `evolvedFrom` без `recipe` и наоборот; базовое не найдено; цепочка;
  две эволюции одного базового; один навык в двух рецептах; навыка нет в
  `PASSIVES`; поведение или стихия не как у базового; сила вне коридора;
- `ACCOUNT_UNLOCKS` не называет эволюций, `findUnlockProblems` на базовых → `[]`,
  `unlocksAt(…, 1).weapons.size` остаётся 3; `weaponsOpenAt` на уровне 1 — три
  базовых и три их эволюции, на последнем — все 12.

Движок:
- `evolutionProgress`: 7-й уровень и навык → `waiting`; 8-й без навыка →
  `waiting`; 8-й и навык 1-го уровня → `ready`; эволюция в наборе → `done`;
  оружия нет → `absent`;
- `readyEvolutionOption`: ничего не готово → `null`; готово `spark` → вариант
  `weapon_evolve:starfall:1` с `level: 1` и строкой «урон 16 → 26»; готовы две →
  первая по порядку в `WEAPONS`;
- `applyEvolution`: номер слота тот же, `typeIndex` эволюции, `level` 1,
  `cooldown`/`dirX`/`dirY` сохранены, число оружий и пассивок прежнее; повтор и
  отсутствие навыка → `false`;
- `prepareOffers` на 50 seed не предлагает эволюцию и базовое после его эволюции;
  `startingWeaponId: "starfall"` → стартует первый базовый;
- `openChest` размера 3 при готовой эволюции: `rewards[0]` — она, всего 3
  награды; размера 1 — одна; без готовой — как в T-0099;
- **генератор:** два мира с одним seed, на одном вызвать `readyEvolutionOption` и
  `applyEvolution`; следующий `world.rng.nextFloat()` равен у обоих;
- **эталон:** сумма сценарного забега с `weapons: WEAPONS` равна сумме с
  `weapons: BASE_WEAPONS`; слепок с эволюцией в слоте восстанавливается с той же суммой;
- `cues.test.ts`: срабатывание `starfall` идёт в `cues.weapons["spark"]`;
  `evolutionChanges(hearth, forge)`: радиус 140 → 175, шанс 30 → 50, пауза 0,28 → 0,22.

Оболочка: `weapon-lists.test.ts` — в `pre-run.tsx`, `meta/level.tsx`,
`guide-data.ts`, `state/dev-mode.ts` нет слова `WEAPONS` без префикса `BASE_`
(чтение исходников, как `scripts/test/layer-boundaries.test.ts`);
`evolution_unlocked` с полным набором полей проходит схему, без `evolution` или
с отрицательным `chest` — нет.

## Аналитика

Новое событие забега **`evolution_unlocked`** — сундук выдал эволюцию. Сначала
строка в `docs/22-analytics-and-metrics.md` §3.3 (рядом с `chest_opened` из
T-0099) и в перечень «Забеги», затем Zod в `event-dictionary.ts`, затем код:

```ts
evolution_unlocked: {
  version: 1,
  payload: payload({ evolution: id, weapon: id, passive: id, chest: count, level: count, elapsedSec: seconds }),
},
```

`evolution` — результат, `weapon` — базовое, `passive` — навык рецепта, `chest` —
номер сундука забега (`index` из `chestOpened`), `level` — уровень игрока,
`elapsedSec` — секунда. Из события считается «доля забегов с эволюцией»
(знаменатель `run_started`, `docs/39` §4.6). Отправка через тот же `track(...)`,
ответ игроку не блокируется. Меток Prometheus нет.

## Настройки и окружение

Нет: ключей `setting-catalog.ts` и переменных окружения нет. Числа — контент,
коридор силы — `EVOLUTION_POWER_RATIO`.

## Документы

- `docs/22-analytics-and-metrics.md` — событие; `docs/32-balance.md` — эволюции
  (коридор силы, таблица пар, эталоны с сундуком включают их);
  `docs/30-configuration-map.md` — строка «Эволюции оружия».
- `CLAUDE.md`, «Как добавить оружие или пассивку» — абзац: «**У каждого
  базового оружия есть эволюция** — запись в `content/weapons.ts` после всех
  базовых с `evolvedFrom` и `recipe: { passive }`, один уровень, то же
  поведение и стихия, сила в коридоре `EVOLUTION_POWER_RATIO`. В `unlocks.ts`
  её не вносят: она открыта вместе с базовым. Выдаёт её сундук забега (Р102).»

## Вопросы к тимлиду

Исполнитель не ждёт ответов; Подтверждено `claude-lead-1` 13.10.2026:

- Рецепт готов, а сундуков больше не будет: эволюция не получена; ничего не
  добавляем, решение — по доле `evolution_unlocked` после теста.
- Готовность проверяется один раз, в начале открытия сундука: если награды того
  же сундука довели оружие до максимума, эволюция придёт со следующим.
- Пары и числа — стартовые, утверждает геймдизайнер.
- T-0101 в `depends_on` по линии движка; его файла на момент записи нет, строку
  значков поправит `pnpm task fix`.

## Критерии приёмки

- [x] В `WEAPONS` шесть эволюций после базовых; `findEvolutionProblems` и
  `findWeaponContentProblems` дают `[]`; сила каждой в `EVOLUTION_POWER_RATIO`.
- [x] Карточки уровня и сундук не предлагают эволюции и эволюционировавшее
  базовое; стартовым оружием эволюция стать не может.
- [x] `readyEvolutionOption` и `applyEvolution` не берут чисел из `world.rng`;
  контрольная сумма забега без эволюции не изменилась.
- [x] Сундук первой наградой применяет готовую эволюцию; слот базового занят
  ею, число оружий не выросло.
- [x] `evolution_unlocked` в словаре, Zod-схеме и `docs/22`, приходит с полным
  набором полей.
- [x] В выборе и счёте оружия оболочка использует `BASE_WEAPONS`.
- [x] Эталоны обновлены только там, где в прогоне есть эволюция; таблица
  `pnpm balance:sim` приложена к PR.
- [x] Дифф только в зонах задачи; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Добавить эволюции оружия`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: эволюции оружия — доведи оружие до максимума, возьми нужный навык, и сундук превратит его в сильную версию`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЭВОЛЮЦИИ ОРУЖИЯ**

  Шесть видов оружия получили эволюции: оружие на максимуме плюс нужный навык, и сундук забега заменяет его сильной версией в том же слоте. Подсказок для игрока пока нет, они в T-0103.

  🛠 **Что сделано**

  • рецепты и числа шести эволюций в `content/weapons.ts`, коридор силы в `balance-targets.ts`
  • эволюция не попадает в карточки уровня и в стартовый выбор
  • событие `evolution_unlocked` для доли забегов с эволюцией

  ❓ **Нужно от команды**

  • @участник1 — геймдизайнеру утвердить пары «оружие → навык» и числа эволюций
  ```
