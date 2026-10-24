---
id: T-0099
title: Сундук забега: падает с элиты и босса, открывает 1, 3 или 5 улучшений
epic: E10
priority: P1
status: done
owner: claude-5 / sonnet-5.5 / high
author: claude-lead2-14
size: M
depends_on: []
zones:
  - packages/core-game/src/content/chests.ts
  - packages/core-game/src/content/waves.ts
  - packages/core-game/src/content/balance-targets.ts
  - packages/core-game/src/content/hash.ts
  - packages/core-game/src/game/sim/rng.ts
  - packages/core-game/src/game/sim/chests.ts
  - packages/core-game/src/game/sim/pickups.ts
  - packages/core-game/src/game/sim/combat.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/progression/levels.ts
  - packages/core-game/src/game/run-world.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/MainScene.ts
  - packages/core-game/src/game/radar.ts
  - packages/core-game/src/game/render/looks.ts
  - packages/core-game/src/game/render/shapes.ts
  - packages/core-game/src/game/render/textures.ts
  - packages/core-game/src/game/balance/**
  - packages/core-game/src/run-api.ts
  - packages/core-game/src/engine/run-bus.ts
  - packages/core-game/src/engine/run-engine.ts
  - scripts/balance/balance-sim.ts
  - packages/core-game/test/**
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/i18n/ru.json
shared:
  - packages/shared-types/src/index.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - packages/app-shell/src/state/analytics.ts
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/32-balance.md
  - docs/27-design-system-and-app-shell.md
  - scripts/bundle-budget.mjs
  - CLAUDE.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 1
---

# T-0099. Сундук забега: падает с элиты и босса, открывает 1, 3 или 5 улучшений

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0099.json)](../README.md#значки-статуса)

## Зачем

Внутри забега нет сюрпризов: случайность одна, выбор из трёх карточек. Тестеры после
1–2 забегов не находят, чем заняться (`docs/39-retention-mechanics.md` §1). Сундук —
цель «дожить до элиты» и азарт: подошёл, коснулся, получил сразу несколько улучшений.
Эта задача — симуляция и данные; окно открытия с «барабаном» — T-0100.

## Решения

Р102 (`docs/35-stage4-plan.md`), Р69, `docs/39` Б1 (§4.1), §5. Исполнитель их не пересматривает.

- **Откуда:** по сундуку с каждой убитой элиты и босса (`rank` не `normal`). Элита и
  босс приходят событиями таймлайна, других источников нет.
- **Что внутри:** улучшения выдаются сами, выбора нет. Число — размер сундука (1, 3, 5),
  каждое берётся из тех же кандидатов, что и карточки уровня (`collectCandidates`), так
  что сундук **не выдаёт то, что нельзя взять** (WP37).
- **Нечего улучшать:** аптечка, если здоровье ниже порога, иначе опыт.
- **Случайность — отдельный поток от seed** (`deriveSeed`, целочисленное перемешивание).
  `world.rng` сундуки не трогают ни разу: иначе сдвинутся все golden и все предложения.
- **Сундук не притягивается**, как кристаллы: к нему идут. За радиусом удержания он
  исчезает, как любой подбор.
- **Остановка забега — по флагу `pauseOnChest`**, выключен по умолчанию: без окна
  (T-0100) забег не замирает. Эволюции (Б2) встанут первой наградой сундука позже.

Числа стартовые, **геймдизайнер калибрует** (`content/chests.ts`):

| Параметр | Поле | Старт |
|---|---|---|
| Размеры первых сундуков по порядку выпадения | `opening` | 1, 3, 1, 5 |
| Дальше: вес размера 1 / 3 / 5 | `sizes` | 87 / 10 / 3 |
| Сундук с босса не меньше | `bossMinSize` | 3 |
| Вес улучшения уже взятого предмета во столько раз больше веса нового | `ownedWeightMul` | 3 |
| Ниже этой доли здоровья запасная награда — аптечка | `lowHpRatio` | 0,7 |
| Запасной опыт — доля пути до следующего уровня | `xpRatio` | 0,5 |
| Сундуков на поле одновременно | `maxOnField` | 2 |
| Первое событие элиты, секунда (коридор 60–120) | `waves.ts` | 90 |

Элита сейчас приходит на 300 с, а коридор медианы бота — 150–480 с: большинство
бот-забегов умирает до первого сундука (`docs/39` §3). Первый должен выпасть около 2:00.

## Как сейчас

- `game/sim/pickups.ts`: `PICKUP_KIND` (31–35) — аптечка, магнит, динамит; `MAX_PICKUPS = 16`
  (40); `rollPickups` (105) бросает `world.rng`; `updatePickups` (182), `switch` 204–218.
- `game/sim/combat.ts`, `killEnemy`: `rollPickups(world, x, y, isElite(type))` (105).
- `game/progression/levels.ts`: `collectCandidates` (84), `pickWeighted` (172), `healOption`
  (200) приватные; `chooseUpgrade` (217) совмещает применение с очисткой `offers`;
  `addXp` (40) пишет в `stats.xpCollected`.
- `game/sim/rng.ts`: только `createRng` (mulberry32). `create-world.ts`: `rng` (229),
  `progression` (245), `stats` (302), заглушки `FALLBACK_*`.
- `game/run/snapshot.ts`: `WORLD_SNAPSHOT_VERSION = 7` (26). `MainScene.ts`: `enterChoice`,
  `emitLevelUp` (~598–615), циклы шагов с `isAwaitingChoice` (~284, ~503).
- `content/waves.ts`: отрезок 90 без событий. `game/radar.ts`: неизвестный подбор
  рисуется аптечкой (`?? RADAR_BLIP.medkit`).
- `game/balance/bot.ts`: бот подбор не ищет.

## Шаги по порядку

Пункт — коммит; рефакторинг (2) отдельно от поведения.

1. **Тесты** (раздел «Тесты») — первым коммитом.
2. **Рефакторинг без изменения поведения**, `levels.ts`: `export function applyUpgrade(world,
   option)` — `switch` из `chooseUpgrade` плюс `refreshPlayerStats` (`chooseUpgrade` = поиск +
   `applyUpgrade` + очистка `offers` и счётчика); экспорт `collectCandidates`, `Candidate`,
   `healOption`; `export function drawWeighted(rng: Rng, pool: readonly { weight: number }[]): number`
   — индекс по весам (цикл из 180–189), `pickWeighted` зовёт его с `world.rng`;
   `addXp(world, amount, counted = true)` — при `false` не пишет в `stats.xpCollected`.
3. **Поток и состояние.**
   - `rng.ts`: `STREAM_SALT = { chest: 0x43485354, cards: 0x43415244 } as const` и

     ```ts
     export function deriveSeed(seed: number, salt: number): number {
       let h = (seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
       h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
       h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
       return (h ^ (h >>> 16)) >>> 0;
     }
     ```
   - `shared-types`: `ChestSize = 1 | 3 | 5`, `ChestSource = "elite" | "boss"`, `ChestsDef`
     (поля из таблицы), `ChestReward = Omit<UpgradeOption, "kind"> & { kind: UpgradeOptionKind | "xp" }`.
   - `world.ts`: `World.chests: ChestState { rng; dropped; opened; founds: ChestFound[];
     openings: ChestOpening[] }`, `World.chestRules: ChestsDef`, `stats.chestsFound`,
     `stats.chestsOpened`. `ChestFound { index; size; source; elapsedSec }`,
     `ChestOpening { index; size; rewards: ChestReward[]; fallbacks: number; elapsedSec }`.
   - `create-world.ts`: опция `chests?: ChestsDef`, заглушка с `maxOnField: 0` (как
     `FALLBACK_DROPS`: тесты паттернов не меняются), `chests.rng = createRng(deriveSeed(seed, STREAM_SALT.chest))`.
   - `snapshot.ts`: `chest: { rng, dropped, opened }` (`founds` и `openings` — выход для
     сцены, не состояние), `WORLD_SNAPSHOT_VERSION = 8`.
4. **Выпадение и открытие.**
   - `pickups.ts`: `PICKUP_KIND.chestOne = 3`, `chestThree = 4`, `chestFive = 5`; в
     `updatePickups` сундук не тянется (`continue` до подтягивания), касание — `remove` и
     `openChest`; `default` заменить явным `case PICKUP_KIND.dynamite`.
   - `sim/chests.ts` (новый; лежит в `game/sim`, подпадает под `sim-purity.test.ts`):
     - `dropChest(world, x, y, rank)` — из `killEnemy` после `rollPickups`, только при
       `lootEnabled` и `progressionEnabled`. `rank === "normal"` или сундуков на поле уже
       `maxOnField` → выход. Размер: `opening[dropped]`, дальше бросок `chests.rng` по `sizes`;
       босс — не меньше `bossMinSize`. Позиция — разброс как у подборов, но направление и
       расстояние из `chests.rng`. `spawnPickup` вернул `false` → счётчики не трогать; успех:
       `dropped++`, `founds.push`, `stats.chestsFound++`.
     - `openChest(world, size)` — `size` раз: `collectCandidates`; пусто → запасная награда;
       иначе вес `weight * ownedWeightMul` у `weapon_level` и `passive_level`, индекс
       `drawWeighted(chests.rng, …)`, `applyUpgrade`, запись в `rewards`. В конце `opened++`,
       `stats.chestsOpened++`, `openings.push`. `offers` и `pendingLevelUps` не трогает.
     - Запасная награда: `hp < maxHp * lowHpRatio` → `healOption()` через `applyUpgrade`;
       иначе `addXp(world, Math.ceil(xpToNext * xpRatio), false)` и награда `{ id: "xp",
       kind: "xp", refId: "", level: 0, nameKey: "upgrade.xp.name", descriptionKey:
       "upgrade.xp.description", changes: [{ labelKey: "upgrade.xp.label", from: null, to: <опыт>,
       format: "plus" }] }` (поля `UpgradeChange` — в shared-types).
     - `takeChestEvents(world, cursor)` — новые `founds` и `openings` и сдвиг курсора
       `{ found, opened }`; чистая функция.
     - Ни одного вызова `world.rng`.
   - Облик: `looks.ts` — `PICKUP_LOOKS` + `chest_one`, `chest_three`, `chest_five` (размер
     1.3 / 1.5 / 1.7, золотой оттенок крепнет с размером; тип `id` расширить); `shapes.ts` —
     форма `chest` (корпус, крышка, замок; силуэт не как у аптечки); `textures.ts` — как у аптечки.
   - Радар: `run-api.ts` `RADAR_BLIP.chest = 5`; `radar.ts` — три вида в `BLIP_BY_PICKUP`.
5. **Данные.** `content/chests.ts` — `CHESTS: ChestsDef` с таблицей и «почему» к каждому числу;
   `findChestsProblems(def)`: размеры из {1,3,5}, веса > 0, `bossMinSize` есть среди `sizes`,
   `ownedWeightMul ≥ 1`, `lowHpRatio` и `xpRatio` в (0, 1], `maxOnField` — целое от 0 до
   `MAX_PICKUPS_OF_KIND`. `hash.ts`: `CHESTS` в хеш (как `DROPS`; старые записи диагностики
   дадут `content_mismatch` — штатно). `run-world.ts`, `balance/simulate.ts`: `chests: CHESTS`.
   `waves.ts`: в отрезок `fromSec: 90` — `events: [{ kind: "ring", enemy: "elite_ghoul", count: 1 }]`.
   `balance-targets.ts`: `firstChestEventSec: { min: 60, max: 120 }`.
6. **Бот** (`balance/bot.ts`): ветка «угрозы рядом нет» (после `length >= 1e-3`, перед
   «идём к ближайшему врагу»): сундук ближе `CHEST_SEEK_RADIUS_UNITS = 520` — идти к
   ближайшему (`Math.sqrt`, без тригонометрии). `BalanceRunResult.chestsFound`,
   `BalanceRunResult.chestsOpened` и колонка
   «сундуков» в таблице `pnpm balance:sim` (скрипт искать по `balance:sim` в `package.json`).
7. **Сцена и API.**
   - `run-api.ts`: `RunOptions.pauseOnChest?: boolean`; `RunEvents.chestFound { index; size;
     source; elapsedSec }` и `chestOpened { index; size; rewards: ChestReward[]; fallbacks;
     elapsedSec }`; `RunSession.closeChest()`.
   - `MainScene.ts`: курсор `chestCursor`; после каждого `stepWorld` (там, где проверяется
     `isAwaitingChoice`) — `takeChestEvents` и два `emit`; при `pauseOnChest` и новом открытии
     цикл шагов прерывается, фаза `chest` (джойстик скрыт, как в `enterChoice`). `closeChest()`:
     не в фазе `chest` — ничего; ждёт выбор уровня → `enterChoice()`, иначе `running` и
     `emit("resumed")`. `pause()` и `resume()` в фазе `chest` — как в `choosing`. После
     восстановления курсор нулевой.
   - `state/run.ts` — только `track("chest_found", { index, size, source, elapsedSec:
     Math.round(elapsedSec) })` и `track("chest_opened", { index, size, rewards: rewards.length,
     fallbacks, elapsedSec: Math.round(elapsedSec) })`; `pauseOnChest` оболочка пока не передаёт.
   - `ru.json`: `upgrade.xp.name` «Опыт», `upgrade.xp.description` «Часть опыта до следующего
     уровня», `upgrade.xp.label` «Опыт» — рядом с `upgrade.heal.*`.
8. **Golden и документы** — отдельными коммитами: дифф golden показывает, как сундук и
   элита на 90 с сдвинули длину забега (`docs/17-testing-strategy.md` §3.2).

## Чего не трогаем

- Окно, «барабан», звук, значок радара в оболочке, гайдбук — T-0100. Новый звук не добавляем.
- Переброс, пропуск, изгнание — T-0101 (он же отфильтрует изгнанное в `collectCandidates`).
- Выпадение аптечки, магнита, динамита (`drops.ts`), остальные отрезки `waves.ts`,
  `ENDLESS_CURVE`. Упадёт «бюджет угрозы не убывает» от события на 90 с — вопрос тимлидам.
- Окно сундука в снимке: свёрнутый на окне забег вернётся на обычную паузу, награды выданы.
- Возврат ушедшего за радиус удержания сундука: он пропадает, как любой подбор.

## Тесты

Первым коммитом, `packages/core-game/test/`. Мир — `createWorld` на фикстурах, элита и
босс — `spawnEnemy` + убийство, контент — `CHESTS`.

- `chests.test.ts`:
  - `deriveSeed`: повторяется; `chest` ≠ `cards`; целое из [0, 2^32);
  - 5 элит подряд → размеры сундуков 1, 3, 1, 5, пятый по весам; сундук с босса после
    схемы — не меньше 3;
  - **`world.rng` не сдвигается:** два мира с одним seed, у одного `maxOnField: 0`;
    после убийства элиты `rng.getState()` равны;
  - размер 3 → ровно 3 допустимые награды (слоты и уровни не нарушены), набор изменился;
    два мира с одним seed — одинаковые id;
  - всё на потолке, здоровье 50% → все `heal`; здоровье полное → `xp`, `progression.xp`
    вырос на `ceil(xpToNext * xpRatio)`, `stats.xpCollected` не изменился;
  - `ownedWeightMul: 1000000` → все награды `*_level`, пока есть что качать (20 seed);
  - `offers` и `pendingLevelUps` после открытия те же (кроме запасного опыта);
  - сундук в радиусе сбора не сдвигается за 30 тиков, касание открывает; `maxOnField: 1`
    и две элиты → один на поле, `dropped == 1`; `progressionEnabled: false` не роняет;
  - `takeChestEvents`: первый вызов отдаёт, второй — пусто.
- `run-snapshot.test.ts`: после выпадения и открытия снимок восстанавливает `dropped`,
  `opened`, поток; следующий сундук совпадает с прогоном без перерыва; версия 7 → `SnapshotError`.
- `content.test.ts`: `findChestsProblems(CHESTS)` пуст, на каждую проверку шага 5 — кейс
  на испорченную копию; первое событие элиты или босса в `TIMELINE` лежит в
  `firstChestEventSec`; сумма `maxOnField` всех подборов не больше `MAX_PICKUPS`.
- `radar.test.ts`: сундук → `RADAR_BLIP.chest`. `looks.test.ts`: у каждого `PICKUP_KIND` есть облик.
- `balance-properties.test.ts`, забеги уклоняющегося бота — тот же набор `dodgingRuns()`, что
  у соседних свойств (ответ claude-lead-1, 17.10.2026, в «Вопросах к тимлиду»):
  - из забегов дольше 240 с сундук **выпал** (`chestsFound ≥ 1`) не меньше чем в половине;
  - хотя бы в одном забеге набора бот сундук **открыл** (`chestsOpened ≥ 1`).

  Не проходит — вопрос тимлидам, порог не подгонять.
- `scripts/test/event-dictionary.test.ts` зелёный (сервер, клиент, документ согласованы).

## Аналитика

Сначала словарь (`docs/22` §3.3: группа «Забеги» и таблица последнего этапа), потом Zod
в `event-dictionary.ts` и список клиента в `analytics.ts`, потом код. Версия — 1.

| Событие | Когда | Поля |
|---|---|---|
| `chest_found` | сундук выпал | `index` (с нуля), `size` (1/3/5), `source` (`elite`/`boss`), `elapsedSec` |
| `chest_opened` | игрок коснулся сундука | `index`, `size`, `rewards`, `fallbacks` (аптечек и опыта среди них), `elapsedSec` |

Схемы: `payload({ index: count, size: count, source: id, elapsedSec: seconds })` и
`payload({ index: count, size: count, rewards: count, fallbacks: count, elapsedSec: seconds })`.

## Настройки и окружение

Нет. Числа сундука — контент, не ключи каталога настроек.

## Документы

- `docs/22-analytics-and-metrics.md` — два события; `docs/30-configuration-map.md` — строка
  «Сундуки забега: `content/chests.ts`».
- `docs/32-balance.md` — коридоры: первый сундук и событие элиты на 90 с.
- `CLAUDE.md` — раздел «Как настроить сундук забега» после раздела про бусты: поля `CHESTS`,
  откуда падает, что внутри, почему поток случайности отдельный.

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 13.10.2026: первое событие элиты на 90 с, первый сундук размера 1;
  бот умирает до 2:00 — сдвинуть на 120 с (одна строка).
- Подтверждено `claude-lead-1` 13.10.2026: версия снимка 8 отбрасывает сохранённые незавершённые
  забеги тестеров при выкате.
- Ответы claude-lead2-1 на вопросы PR #366, 17.10.2026:
  - В зонах — `engine/run-bus.ts` и `engine/run-engine.ts`: шаг 7 вводит события
    `chestFound`, `chestOpened` и `RunSession.closeChest()`, а шина и реализация
    сессии живут там. `scripts/balance/balance-sim.ts` — колонка «сундуков» из шага 6,
    `docs/32-balance.md` — коридоры из раздела «Документы».
  - Запасная награда выбирается на каждую награду сундука, как в шаге 4: после
    аптечки здоровье выше `lowHpRatio`, и следующая — опыт. Тест «все `heal`»
    ставит здоровье так, чтобы порог не был пройден ни после одной аптечки;
    алгоритм не меняется.
  - `CIRCLING_SEED` в `run-recording.test.ts` подбирается заново, как велит
    комментарий теста: элита на 90 с меняет судьбу прежнего seed.
  - Порог `balance-properties` («сундук открыт не меньше чем в половине забегов
    дольше 240 с», замер 0,4) — решение `claude-lead-1` и геймдизайнера, ждёт ответа.
- Ответ claude-lead-1 на вопрос PR #366, 17.10.2026: свойство меряло не то. Порог не
  ослабляем, бот и элиту не трогаем, а проверяем то, что обещает решение: дожившему до
  4 минут элита роняет сундук.
  - Свойство «сундук открыт в половине долгих забегов» заменено двумя: сундук **выпал** в
    половине забегов дольше 240 с (замер 9 из 10) и бот **открыл** хотя бы один сундук
    за набор (замер 4 забега). Раздел «Тесты» поправлен. `BalanceRunResult.chestsFound`
    — рядом с `chestsOpened`, из `stats.chestsFound`.
  - Приоритет сундука у бота не поднимаем. Бот — прибор для замера выживания, а не модель
    игрока, который идёт за добычей. Пойди он к сундуку сквозь рой — стал бы умирать раньше,
    и сдвинулись бы медианы, golden и коридоры всех таблиц, а не только сундука.
  - Элиту раньше 90 с не сдвигаем: первый сундук у бота падает на 134–299 с не из-за
    секунды события, а из-за того, как долго убивают `elite_ghoul`. Это калибровка
    геймдизайнера, пункт во входящих. T-0099 он не блокирует.
  - Доля открытых сундуков остаётся видна в `pnpm balance:sim` — колонка «сундуков».
- Ответ claude-lead-1 на вопрос PR #366, 17.10.2026 — первая загрузка +0,18 КБ
  (перебор 93 байта на `dev` после #363). В первую загрузку через общие чанки
  попадают данные сундука, его вид на радаре и события: этого требуют шаги 4–7
  (сундук входит в хеш контента, у радара новая точка). Порог поднимается в
  этом PR, поэтому `scripts/bundle-budget.mjs` и `docs/27` — в `shared`.

  Правило подъёма для всех трёх задач у порога — T-0109, T-0099, T-0010:
  - **порядок влива** — T-0109 (#359), затем T-0099 (#366), затем T-0010
    (#353): от меньшего прироста к большему. Следующий PR вливает `dev`
    только после мерджа предыдущего, метку «доработка» на него ставит
    тимлид, который влил предыдущий;
  - **новый порог** — замер первой загрузки на ветке после слияния с `dev`,
    округлённый вверх до 0,1 КБ. Если до порога остаётся меньше 50 байт —
    ещё +0,1: такой запас съела бы сборка с другими именами чанков (как у
    порога 151,1);
  - **в `scripts/bundle-budget.mjs`** — строка в конец комментария над
    порогом «Оболочка, первая загрузка», по образцу соседних: «<порог> —
    <что выросло> (T-NNNN, +X КБ): <почему это в первой загрузке>»;
  - **в `docs/27` §3.4** — в строке «JS оболочки, первая загрузка» новый
    порог и замер.

  T-0099 вливается второй, после #359.

## Критерии приёмки

- [ ] Элита и босс роняют сундук; касание выдаёт 1, 3 или 5 допустимых улучшений; первые
  сундуки — 1, 3, 1, 5.
- [ ] В `chests.ts` нет вызовов `world.rng`; тест на неподвижный генератор зелёный.
- [ ] Нечего улучшать — аптечка или опыт, `xpCollected` не искажён.
- [ ] Снимок версии 8 восстанавливает поток сундуков; повтор забега сходится.
- [ ] В забегах бота дольше 240 с сундук выпадает не меньше чем в половине, бот открывает
  хотя бы один; golden и коридоры обновлены отдельным коммитом.
- [ ] `chest_found` и `chest_opened` в словаре, схеме, клиенте и документе.
- [ ] Дифф только в зонах и в строках из «Документы»; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Добавить сундук забега`
- **Метка:** `release: minor`
- **Для игроков:** нет — запись в журнал «Что нового» делает T-0100, когда у сундука появится окно.
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СУНДУК ЗАБЕГА (ДВИЖОК)**

  С элиты и босса падает сундук: коснулся — получил сразу 1, 3 или 5 улучшений. Окно открытия — в T-0100, до него сундук открывается без остановки забега.

  🛠 **Бой**

  • первое событие элиты — на 90-й секунде, первый сундук около 2:00
  • числа сундука — в content/chests.ts, геймдизайнер калибрует
  • golden и коридоры обновлены: в диффе видно, как сундук сдвинул длину забега

  ❓ **Нужно от команды**

  • @участник1 — подтвердить: версия снимка забега выросла, сохранённые незавершённые забеги тестеров при выкате пропадут
  ```
