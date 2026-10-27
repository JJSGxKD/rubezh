---
id: T-0194
title: «Предел» — бесконечные малые прибавки, когда прокачивать нечего
epic: E10
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0193, T-0101, T-0102, T-0103, T-0116, T-0182]
zones:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/content/upgrades.ts
  - packages/core-game/src/game/progression/levels.ts
  - packages/core-game/src/game/progression/limit.ts
  - packages/core-game/src/game/progression/upgrade-changes.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/balance/bot.ts
  - packages/core-game/src/index.ts
  - packages/core-game/test/limit.test.ts
  - packages/core-game/test/weapons-and-levels.test.ts
  - packages/core-game/test/chests.test.ts
  - packages/core-game/test/content.test.ts
  - packages/core-game/test/run-snapshot.test.ts
  - packages/core-game/test/upgrade-changes.test.ts
  - packages/app-shell/src/screens/run/overlays.tsx
  - packages/app-shell/src/screens/item-icons.tsx
  - packages/app-shell/src/screens/gallery.tsx
  - packages/app-shell/src/screens/guide/GuideScreen.tsx
  - packages/app-shell/src/i18n/ru-guide.json
  - packages/app-shell/test/limit-card.test.ts
  - packages/app-shell/test/guide.test.ts
shared:
  - backend/api/src/modules/events/event-dictionary.ts
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/i18n/ru-run.json
  - docs/05-game-design.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/32-balance.md
  - CLAUDE.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0194. «Предел» — бесконечные малые прибавки, когда прокачивать нечего

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0194.json)](README.md#значки-статуса) [![T-0193](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0193.json&label=T-0193)](T-0193-longer-run-progression.md) [![T-0101](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0101.json&label=T-0101)](archive/T-0101-card-reroll-skip-banish.md) [![T-0102](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0102.json&label=T-0102)](archive/T-0102-weapon-evolutions-data-and-engine.md) [![T-0103](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0103.json&label=T-0103)](archive/T-0103-weapon-evolution-recipes-in-game.md) [![T-0116](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0116.json&label=T-0116)](archive/T-0116-freeze-pickup.md) [![T-0182](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0182.json&label=T-0182)](archive/T-0182-cordon-ring-analytics.md)

## Зачем

Когда набор собран и прокачан, выбор уровня сводится к одной карточке лечения:
игрок нажимает её, не читая, и растущий дальше забег ничего не даёт. С T-0193
сборка длится дольше, и забег после неё должен оставаться живым. «Предел» даёт
три карточки малых прибавок, которые копятся без счёта, но упираются в пределы
движка, а лечение остаётся, пока здоровье просело.

## Решения

Р130 (`docs/35-stage4-plan.md`, 20.10.2026) и решения тимлида того же дня.
Исполнитель их не пересматривает.

1. **Когда.** Только когда список кандидатов `collectCandidates` пуст (всё
   взято и на максимуме). Пока есть что улучшать, карточки уровня прежние.
2. **Что предлагается.** Три карточки (плюс `world.boosts.extraOffers`) из пула
   «Предела», без повторов. Если здоровье **ниже половины** максимума, одна из
   карточек — лечение на 30% (`HEAL_RATIO`, прежний вариант `heal`), оно идёт
   последним, а «Предела» тогда на одну меньше. Здоровье не ниже половины —
   лечения среди карточек нет.
3. **Пул — данные** (`content/upgrades.ts`, список `LIMITS`), рабочие числа,
   калибруются по `balance:sim` в коридоре:

   | id | Параметр (`LoadoutStat`) | Шаг за карточку | Название | Описание |
   |---|---|---|---|---|
   | `damage` | `damage` | +0,03 | Предел: урон | Урон всего оружия растёт ещё на 3%. Прибавки копятся без конца. |
   | `cooldown` | `cooldown` | −0,02 | Предел: перезарядка | Оружие перезаряжается на 2% быстрее. |
   | `area` | `area` | +0,03 | Предел: площадь | Зоны и радиусы шире на 3%. |
   | `maxHp` | `maxHp` | +10 | Предел: здоровье | Здоровья больше на 10, и столько же восстанавливается сразу. |
   | `regen` | `regenPerSec` | +0,1 | Предел: восстановление | Здоровье восстанавливается быстрее на 0,1 в секунду. |
   | `speed` | `moveSpeed` | +0,02 | Предел: скорость | Бегаешь быстрее на 2%. |
   | `pull` | `pickupRadius` | +0,05 | Предел: притяжение | Кристаллы и подборы притягиваются с большего расстояния: радиус больше на 5%. |

   Вес у всех 1 (поле `weight`, как у навыков).
4. **Куда ложится прибавка.** Копится в состоянии забега как число нажатий по
   каждой записи (`progression.limitStacks: number[]` в порядке `LIMITS`) и
   складывается с прибавками снаряжения и бустов тем же `combineModifiers`
   (`progression/boosts.ts`): сумма упирается в `LOADOUT_BOUNDS`
   (`progression/run-loadout.ts`). Навыки применяются сверху, как к снаряжению
   (+3% «Предела» усиливается «Силой»). Здоровье лечится на прибавленное уже
   существующим расчётом `refreshPlayerStats` (`gained`).
5. **Упёрлось в предел — карточки нет.** Запись, у которой параметр уже на
   `LOADOUT_BOUNDS` (снаряжение + бусты + «Предел»), в пул не попадает; карточек
   меньше трёх — предлагается сколько есть; пул пуст — остаётся лечение
   (одна карточка, как раньше).
6. **Карточка показывает «было → стало» и сколько набрано всего**
   (`upgrade-changes.ts`): строка с подписью параметра навыка
   (`upgrade.stat.passive.<параметр>`), `from` — набрано до нажатия, `to` — после;
   проценты для урона, площади, скорости и притяжения как «+0% → +3%»
   (формат `percent`, множитель 1 → 1,03), для перезарядки «0% → −2%»
   (`lowerIsBetter`), для здоровья и восстановления «+0 → +10» и «0 → +0,1»
   (формат `plus`). Лишней строки «всего» нет: накопленное — это и есть `to`.
7. **Случайность.** Тот же поток, что у карточек уровня: `world.rng`
   (`drawWeighted` из `levels.ts`), без повторов, ничего нового не заводим.
   Число обращений зависит только от состояния мира (здоровье, стопки),
   поэтому реплей сходится. Лечение генератора не трогает.
8. **Сундук без прокачки не меняется.** Нечего улучшать — аптечка или опыт, как
   в CLAUDE.md, «Как настроить сундук», «Что внутри»; «Предел» из сундука не
   выдаётся. Поэтому `ChestReward["kind"]` не включает `limit` (тип сужается,
   код сундука и окно наград не правятся).
9. **Идентификатор карточки** `limit:<id>` (например `limit:damage`),
   `kind: "limit"`, `refId` — `id` записи, `level` — стопок после нажатия.
10. **Оболочка.** Карточка «Предела» — своя плитка: значок `ChevronsUp`
    (lucide), тон `info` (плитка `bg-info/15 text-info`, полоса карточки уже
    `info`), метка «Предел» и счёт нажатий. Новых анимаций и звука нет —
    нового переключателя настроек нет (`CLAUDE.md`, «Настройки не отстают от
    игры»). Гайдбук: текст темы «Когда брать нечего» (`guide.upgrades.heal.*`)
    переписывается, отдельной главы нет.
11. **Изгнание и переброс (T-0101).** Карточки «Предела» переброс заменяет
    как обычные (через общий конструктор карточек, шаг 3); изгнать «Предел»
    нельзя — изгонять нечего, кнопки на такой карточке нет. Если T-0101 уже
    устроил иначе, исполнитель следует его коду и пишет в PR одну строку.

## Как сейчас

- `game/progression/levels.ts`: `OFFERS_PER_LEVEL = 3` (`:14`), `HEAL_RATIO = 0.3`
  (`:17`), `HEAL_OPTION_ID` (`:19`); `prepareOffers` (`:68-80`) при пустом списке
  кандидатов кладёт одну `healOption()` (`:78`), `healOption()` — `:211-219`,
  `applyUpgrade` (`:240-268`) обрабатывает `heal` веткой `default` (`:263-266`),
  `refreshPlayerStats` (`:275-292`) пересчитывает характеристики с
  `world.loadoutModifiers`.
- `shared-types/src/index.ts:1129-1134` — `UpgradeOptionKind`; `:1068` —
  `ChestReward` (`Omit<UpgradeOption, "kind"> & { kind: UpgradeOptionKind | "xp" }`).
- `game/progression/boosts.ts` — `combineModifiers` (сумма с упором в
  `LOADOUT_BOUNDS`); `run-loadout.ts:24-44` — сами пределы.
- `game/sim/world.ts:225-236` — `ProgressionState`; `create-world.ts:243-244` —
  сборка `loadoutModifiers` и `playerStats`; `run/snapshot.ts:161-172` —
  `restoreProgression` читает поля одно за другим (новое поле без правки здесь
  потеряется при возобновлении забега).
- `game/balance/bot.ts:60-66` — `DODGING_PRIORITY` без «Предела»: карточка
  неизвестного вида ушла бы в `offers[0]`.
- Тест, который придётся переписать: `weapons-and-levels.test.ts:357-376` («не
  предлагает того, чего нельзя взять» ожидает одну карточку `heal`).
- Оболочка: `screens/run/overlays.tsx:180-290` — карточки выбора, `kindOf`
  (`:251`), `OfferTag` (`:260`); `screens/item-icons.tsx:54-75` — `ItemKind`,
  значок, плитка; `gallery.tsx:510-522` — пример карточки лечения;
  `GuideScreen.tsx:396` — тема «Когда брать нечего»; словарь —
  `ru.json:136-139` (`upgrade.heal.*`), `ru-guide.json:104-105`.
- Аналитика: `upgrade_chosen` уже пишет `option` — id карточки
  (`docs/22-analytics-and-metrics.md:181`, `event-dictionary.ts:135`); id вида
  `weapon_new:spark:1` с двоеточиями проходит, `limit:damage` тоже.

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»).
2. **Типы.** `shared-types`: `UpgradeOptionKind` + `"limit"`; `LimitDef { id;
   nameKey; descriptionKey; stat: LoadoutStat; step: number; weight?: number }`;
   `ChestReward` — `Omit<UpgradeOption, "kind"> & { kind: Exclude<UpgradeOptionKind, "limit"> | "xp" }`.
3. **Контент.** `content/upgrades.ts`: `LIMITS: LimitDef[]` из таблицы
   «Решений» с комментарием «почему» (шаг мал, пределы держит движок). Ключи
   текстов: `upgrade.limit.<id>.name` и `.description`.
4. **Движок.** `progression/limit.ts` (новый, без Phaser и случайности):
   - `limitModifiers(stacks, defs): Partial<Record<LoadoutStat, number>>`;
   - `limitCandidates(world): Candidate[]` — записи, у которых после ещё одной
     стопки параметр не выше `LOADOUT_BOUNDS` с учётом уже набранного снаряжения
     и бустов; опция строится `limitOption(def, stacksBefore)` с `changes`
     из `upgrade-changes.ts` (`limitChanges`: формат и подпись из «Решений», п. 6);
   - `findLimitProblems(defs)`: шаг > 0, параметр из `LOADOUT_BOUNDS`, шаг не
     больше 5% предела параметра, id без повторов.
   `levels.ts`: `prepareOffers` при пустых кандидатах вызывает конструктор
     `buildLimitOffers(world)` (три карточки, лечение последней при
     `hp < maxHp / 2`; пул пуст — лечение одно); `applyUpgrade` — ветка
     `limit` (+1 к `limitStacks[i]`, затем `refreshPlayerStats`), `heal` вынести
     в явную ветку; `refreshPlayerStats` берёт `combineModifiers(world.loadoutModifiers,
     limitModifiers(...))`. Если T-0101 вынес сбор карточек в общую функцию
     (переброс), «Предел» подключается там же, а не копией.
   `world.ts`/`create-world.ts`: `ProgressionState.limitStacks`, нулевой массив
     длиной `LIMITS.length` (`createWorld` получает `limits` в опциях, по
     умолчанию пусто; `run-world.ts` и `simulate.ts` передают `LIMITS`;
     если `run-world.ts` не в зонах — только через общий список опций, который
     уже собирает `createWorld`). `snapshot.ts`: чтение и проверка массива
     (длина совпадает с `LIMITS`, числа целые не меньше 0, иначе отказ как у
     прочих полей).
   `bot.ts`: `"limit"` в `DODGING_PRIORITY` перед `"heal"`.
   `index.ts`: экспорт `LIMITS`, `LimitDef` не нужен (тип из shared-types).
5. **Оболочка.** `item-icons.tsx`: `ItemKind` + `"limit"` (значок, плитка);
   `overlays.tsx`: `kindOf`, `OfferTag` — метка «Предел» и «× N» (счёт нажатий
   берётся из `offer.level`); ключи — в тот же словарь, что `run.levelUp.new`
   (`run.levelUp.limit`); тексты карточек из «Решений» — рядом с `upgrade.heal.*`
   в `ru.json`; `gallery.tsx`: пример карточки «Предела» для снимков;
   `GuideScreen.tsx`/`ru-guide.json`: текст темы — «Когда всё взято и прокачано до
   предела, уровень даёт малые прибавки без конца: урон, перезарядку, площадь,
   здоровье, восстановление, скорость и притяжение. Когда здоровья меньше половины,
   одна из карточек — лечение.»
6. **Документы** и гейт.

## Чего не трогаем

- Выбор уровня, пока есть что улучшать, карточки навыков и оружия, веса.
- Сундук: `openChest`, `fallbackReward`, окно наград, `chest-rules.ts`.
- Пределы движка (`LOADOUT_BOUNDS`) и снаряжение/бусты: «Предел» складывается с
  ними, не меняет их.
- Эволюции (T-0102), переброс/изгнание (T-0101) — кроме подключения к общему
  конструктору карточек.
- Сервер: забег по-прежнему шлёт `option` одним id, новых полей итога нет.
- Звук, вибрацию, настройки.

## Сценарий и интерфейс

Игрок с собранным набором на новом уровне видит модалку выбора: три карточки
«Предел: …» с числами «+0% → +3%» (на следующем нажатии того же параметра «+3% →
+6%»). Ниже половины здоровья одна из карточек — «Лечение» (30%).

- загрузки нет; пустого состояния нет (всегда хотя бы лечение);
- упёрся предел по всем параметрам — одна карточка лечения (как раньше);
- сети и ограничений аккаунта в бою нет;
- макета нет: плитка и полоса — существующие токены (`info`), подписи — как у
  навыков. Снимки карточек на 320, 390, 768 и 1440 px (портрет и ландшафт), три
  карточки «Предела» и «Предел» с лечением.

## Тесты

Первым коммитом.

`core-game/test/limit.test.ts` (новый):

- нечего улучшать, здоровье полное: три карточки `kind: "limit"`, id разные,
  `limit:<id>`, все из `LIMITS`;
- здоровье ниже половины: две «Предела» и последней `heal` с лечением 30%;
  ровно половина — лечения нет;
- `extraOffers: 1` — четыре карточки; пул из двух записей (остальные на пределе) —
  две карточки;
- выбор `limit:damage` трижды: `limitStacks[...] == 3`, `playerStats.damageMul` на
  1,09 выше (с учётом навыков), карточка после третьего показывает `from = 1,06`,
  `to = 1,09`; `maxHp`: максимум +10 за нажатие, текущее здоровье тоже +10;
- набор снаряжения и бустов складывается с «Пределом» и упирается в
  `LOADOUT_BOUNDS`: стопки на тысячу нажатий не дают `damage` > 3, запись на
  пределе в предложения не попадает; все семь на пределе — одна карточка `heal`;
- детерминизм: два мира одного seed с одинаковыми действиями дают одинаковые
  карточки, `world.rng` после ветки «Предела» продвигается ровно на число
  вытянутых карточек, лечение генератор не трогает;
- сундук: набор собран — `openChest` выдаёт аптечку или опыт, ни одной награды
  `limit`; `findLimitProblems(LIMITS)` пуст и ловит нулевой шаг, неизвестный
  параметр, шаг больше 5% предела, повтор id.

`core-game/test/weapons-and-levels.test.ts`: тест «не предлагает того, чего нельзя
взять» переписан: при полном здоровье три карточки «Предела», при `hp = 40 из 100` —
две и лечение; выбор лечения повышает здоровье.

`core-game/test/run-snapshot.test.ts`: снимок с `limitStacks` восстанавливается
один в один; повреждённый (отрицательное число, не та длина) отвергается.

`core-game/test/upgrade-changes.test.ts`: `limitChanges` для процента, перезарядки
(`lowerIsBetter`), здоровья и восстановления.

`core-game/test/content.test.ts`: `findLimitProblems(LIMITS)` пуст; у каждой записи
есть ключи в `ru.json` (проверяется в оболочке, ниже).

`app-shell/test/limit-card.test.ts` (новый): для каждой записи `LIMITS` есть
`upgrade.limit.<id>.name` и `.description` в `ru.json`; `formatChange` печатает
«+3%», «−2%», «+10», «+0,1»; `kindOf` отдаёт `limit` для `kind: "limit"`.
`guide.test.ts`: тема «Когда брать нечего» не упоминает «вместо улучшения
предлагается лечение».

## Аналитика

Новых событий нет: `upgrade_chosen` уже пишет `option`, в `docs/22` §3.3 в строке
`upgrade_chosen` дописать, что `option` бывает `limit:<id>` (а не только
`weapon_*`, `passive_*`, `heal`). Словарь `event-dictionary.ts` не меняется
(`option` — тип `id`); по формату убедиться тестом словаря, что строка
`limit:damage` проходит схему. Если не проходит, сначала правится схема (словарь и
Zod), потом код.

## Настройки и окружение

Нет. Числа — контент (`content/upgrades.ts`, `LIMITS`), правит геймдизайнер.

## Документы

- `CLAUDE.md`, «Как добавить оружие или пассивку»: абзац про `LIMITS` (когда
  предлагается, шаг мал, пределы держит `LOADOUT_BOUNDS`, новая запись — данные
  плюс ключи текстов).
- `docs/05-game-design.md`: «Когда прокачивать больше нечего, вместо улучшений
  предлагается лечение» → «Предел» и лечение ниже половины здоровья.
- `docs/32-balance.md` §1: строка про `LIMITS` в таблице слоёв и §2.1 абзац.
- `docs/30-configuration-map.md`: строка «Предел: список, шаги, вес» →
  `content/upgrades.ts` → `LIMITS`.
- `docs/22-analytics-and-metrics.md`: строка `upgrade_chosen`.
- `docs/35-stage4-plan.md` правит тимлид.

## Критерии приёмки

- [ ] Всё взято и на максимуме: выбор уровня даёт три карточки «Предела»; ниже
      половины здоровья вместо одной — лечение 30%.
- [ ] Карточка показывает «было → стало» с накопленным значением.
- [ ] Прибавки складываются со снаряжением и бустами и не выходят за
      `LOADOUT_BOUNDS`; запись на пределе не предлагается.
- [ ] Случайность — только `world.rng`, реплей и снимок возобновления сходятся.
- [ ] Сундук без прокачки по-прежнему даёт аптечку или опыт.
- [ ] Бот калибровки выбирает «Предел» перед лечением.
- [ ] Гайдбук и документы описывают «Предел»; настройки не затронуты.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; golden обновлены, если
      пустой список кандидатов встречается в эталонных прогонах.

## PR

- **Заголовок:** `feat(core-game): Добавить «Предел» вместо лечения при полной прокачке`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: когда всё взято и прокачано, уровень даёт «Предел» — малые прибавки к урону, перезарядке, площади, здоровью, восстановлению, скорости и притяжению`
  - `- изменено: лечение на 30% остаётся одной из карточек, когда здоровья меньше половины`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — «ПРЕДЕЛ» ВМЕСТО ЛЕЧЕНИЯ ПРИ ПОЛНОЙ ПРОКАЧКЕ**

  Когда прокачивать нечего, выбор уровня теперь даёт три малые бесконечные прибавки, а не одну карточку лечения.

  🛠 **Бой**

  • семь прибавок: урон, перезарядка, площадь, здоровье, восстановление, скорость, притяжение
  • они складываются с снаряжением и бустами и упираются в пределы движка
  • ниже половины здоровья одна из карточек — лечение 30%
  • сундук без прокачки по-прежнему даёт аптечку или опыт

  ❓ **Нужно от команды**

  • @владелец — посмотреть шаги прибавок в `content/upgrades.ts` на плейтесте
  ```
