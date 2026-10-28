---
id: T-0195
title: Сила игрока и подстройка директора — движок и контент
epic: E10
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0101, T-0102, T-0116, T-0125, T-0170, T-0182, T-0190, T-0192, T-0193, T-0194, T-0197]
zones:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/content/pressure.ts
  - packages/core-game/src/content/hash.ts
  - packages/core-game/src/game/sim/player-power.ts
  - packages/core-game/src/game/sim/pressure.ts
  - packages/core-game/src/game/sim/director.ts
  - packages/core-game/src/game/sim/timeline.ts
  - packages/core-game/src/game/sim/stages.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/run-world.ts
  - packages/core-game/src/game/progression/run-loadout.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/run/run-result.ts
  - packages/core-game/src/game/MainScene.ts
  - packages/core-game/src/run-api.ts
  - packages/core-game/test/helpers/pressure-fixture.ts
  - packages/core-game/test/player-power.test.ts
  - packages/core-game/test/pressure.test.ts
  - packages/core-game/test/pressure-replay.test.ts
  - packages/core-game/test/run-loadout.test.ts
  - packages/core-game/test/run-snapshot.test.ts
  - packages/core-game/test/run-summary.test.ts
  - packages/core-game/test/content.test.ts
shared:
  - CLAUDE.md
  - docs/05-game-design.md
  - docs/28-diagnostics.md
  - docs/30-configuration-map.md
  - docs/32-balance.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0195. Сила игрока и подстройка директора — движок и контент

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0195.json)](README.md#значки-статуса) [![T-0101](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0101.json&label=T-0101)](archive/T-0101-card-reroll-skip-banish.md) [![T-0102](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0102.json&label=T-0102)](archive/T-0102-weapon-evolutions-data-and-engine.md) [![T-0116](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0116.json&label=T-0116)](archive/T-0116-freeze-pickup.md) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](archive/T-0125-run-result-rank-chest-crystal-counters.md) [![T-0170](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0170.json&label=T-0170)](archive/T-0170-cordon-ring-engine.md) [![T-0182](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0182.json&label=T-0182)](archive/T-0182-cordon-ring-analytics.md) [![T-0190](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0190.json&label=T-0190)](T-0190-single-difficulty-shell.md) [![T-0192](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0192.json&label=T-0192)](T-0192-pressure-after-minute-8.md) [![T-0193](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0193.json&label=T-0193)](T-0193-longer-run-progression.md) [![T-0194](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0194.json&label=T-0194)](T-0194-limit-break-offers.md) [![T-0197](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0197.json&label=T-0197)](T-0197-second-boss-no-projectiles.md)

## Зачем

После T-0192 у единой сложности одни числа на всех, и они подобраны под игрока
средней силы. Новичок без снаряжения с двумя слотами оружия умирает на них
раньше, чем успеет понять игру, а прокачанный игрок с полным арсеналом и тремя
бустами скучает. Задача учит движок считать силу игрока из того, что он уже
знает, и подстраивать по ней давление директора спавна по трём рычагам
(здоровье и урон врагов; темп спавна и потолок живых; ступени и события), а
на слабом телефоне упирать число врагов в потолок устройства и добирать
здоровьем и уроном. Числа калибрует следующая задача, T-0196; эта даёт
механизм и рабочие числа в контенте.

## Решения

Р131, Р65, Р67, WP34 (`docs/35-stage4-plan.md`) и решения пользователя и
`claude-lead-1` от 21.10.2026. Исполнитель их не пересматривает. Числа,
помеченные «рабочие», калибрует T-0196 по `pnpm balance:sim` в фиксированных
коридорах; в этой задаче они остаются такими, как в таблицах ниже.

1. **Сила считается внутри движка, чистой функцией от мира, без новых
   входов забега.** Всё, что нужно, мир уже хранит: уровень аккаунта в
   `world.runLoadout.accountLevel` и открытые им слоты в `world.loadoutLimits`;
   прибавки снаряжения, дерева и бустов вместе — в `world.loadoutModifiers`;
   не-параметрические эффекты бустов — в `world.boosts` (`shieldHits`,
   `startLevels`, `extraOffers`); собранное в забеге — в `world.loadout`
   (оружие и навыки с уровнями). Повтор забега по записи (`replayRecording`)
   и продолжение из снимка получают тот же набор (`recording.loadout`,
   `snapshot.loadout`), поэтому дают тот же бой.
2. **Единственный новый вход — класс устройства, и он едет внутри
   `RunLoadout`.** `RunLoadout.deviceClass?: "standard" | "light"` — по образцу
   `accountLevel`: поле необязательное, нет поля — обычное устройство, значение
   `"standard"` в набор не пишется. Так оно без единой правки попадает в
   запись забега (`recording.loadout`), в снимок прерванного забега
   (`snapshot.loadout`), в повтор и в серверную схему записи (её правит
   T-0196). Отдельное поле в `RunOptions`, `RunRecording` и `RunSnapshot` —
   отвергнуто: три места и три формата вместо нуля. Кто и как определяет
   «слабое» — оболочка, T-0196.
3. **Подстройка включена, только когда у набора есть `accountLevel` и в мир
   передан контент `PRESSURE`.** Нет уровня (стенд, тесты движка, забег
   разработчика, запись и снимок прошлых сборок) или нет контента
   (`createWorld` без `pressure`) — подстройки нет вовсе: все множители ровно
   единицы, сдвиги нули, и забег побитово равен забегу без этой задачи. Боты
   `balance:sim` без набора, сценарные эталоны `determinism` и `run-summary` и
   golden «Сложной» из T-0192 поэтому **не меняются**.
4. **Сила — сумма очков из четырёх слагаемых (Р65).** Очки — условная шкала,
   на которой «опорный» игрок (`reference`) получает давление T-0192 без
   поправок:

   | Слагаемое | Откуда | Формула |
   |---|---|---|
   | слоты | `world.loadoutLimits` (уровень аккаунта открывает слоты) | `slotPoints × (weapons + attack + defense + mobility)` |
   | снаряжение | `world.loadoutModifiers` (предметы, дерево, модификаторы бустов вместе) | сумма `gear[stat] × modifiers[stat]` по `LOADOUT_STATS` в порядке перечня |
   | эффекты бустов | `world.boosts` | `shieldPoints × shieldHits + startLevelPoints × startLevels + offerPoints × extraOffers` |
   | собранное в забеге | `world.loadout`, `world.stats.elapsedSec` | `clamp(buildPoints × (buildScore − expectedBuild(elapsedSec)), −buildCap, +buildCap)` |

   `buildScore` — доля собранного набора от ёмкости: `min(1, суммарный
   уровень оружия и навыков / (слотов оружия × средний максимальный уровень
   открытого оружия + слотов навыков × средний максимальный уровень
   открытых навыков))`; средние считаются по `world.weaponTypes` и
   `world.passiveTypes` (`levels.length`), пустой список — единица.
   `expectedBuild` — ломаная по таблице `buildSchedule` (секунда → ожидаемая
   доля): до первой точки — её значение, после последней — последнее.
   Так считается не «сколько собрано», а «впереди или позади расписания»:
   игрок, собравший набор раньше обычного, получает давление выше, отставший —
   ниже, и рост набора со временем сам по себе давление не поднимает.
5. **Из очков — уровень давления `L` в пределах.**
   `delta = total − reference`; `raw = 1 + delta / spanUp`, если `delta ≥ 0`,
   иначе `1 + delta / spanDown`; `L = min(maxLevel, max(minLevel, raw))`.
   `L = 1` — опорный игрок, `L < 1` — мягче, `L > 1` — жёстче. **Разброс
   ограничен** пределами `minLevel 0,75` и `maxLevel 1,3` (рабочие).
6. **Три рычага — все линейные по `d = L − 1`, без степеней** (детерминизм
   между JS-движками, `CLAUDE.md`):

   | Рычаг | Что меняется | Формула |
   |---|---|---|
   | 1. Здоровье и урон | `world.difficulty.hpMul`, `damageMul` | множитель отрезка × `(1 + levers.hp × d)` и `(1 + levers.damage × d)` |
   | 2. Темп и потолок | `world.difficulty.spawnMul`, `maxAlive` | `spawnMul = 1 + levers.spawn × d`; `desiredAlive = round(plan.maxAlive × difficultyLevel.maxAliveMul × (1 + levers.alive × d))` |
   | 3. Состав и события | `stageShiftSec`, `eliteLead`, `bossLead` | `stageShiftSec = round(levers.stageShiftSec × d)` — ступени открываются на столько секунд раньше (минус — позже); `lead = clamp(round(levers.leadPerLevel × d), leads[ранг].min, leads[ранг].max)` — события элит и боссов кривой приходят на столько отрезков раньше |

   Сдвиг ступеней: `pickStage` сравнивает `fromSec` ступени с
   `max(0, elapsedSec + stageShiftSec)`. Сдвиг событий: только у **событий
   кривой** `ENDLESS_CURVE.events` (генерируемые отрезки), только у врагов с
   рангом `elite` и `boss`; расписанные руками отрезки первых 5:30 и события
   обычных врагов не двигаются — первая минута и первая элита на 90-й
   секунде одинаковы у всех (коридор `firstChestEventSec`). Событие срабатывает
   на отрезке `step`, если `n = step + 1 + lead` положительно и делится на
   `everySegments` (при `lead = 0` это прежнее правило `(step + 1) %
   everySegments === 0`). **Боссы сдвигаются только вперёд** (`leads.boss`
   от 0 до +1): события боссов привязаны к минутам, рубеж на 10:00 (T-0120)
   на них опирается, и «позже» для босса новичку не нужно — Р131 говорит
   «раньше». Элиты — в обе стороны (от −1 до +1).
7. **Слабое устройство (Р67).** Класс устройства — из `world.runLoadout`.
   Потолок живых отрезка: `deviceLimited = min(desiredAlive, caps[класс])`,
   `maxAlive = min(world.config.maxEnemies, deviceLimited)`. Если потолок
   устройства урезал число врагов (`desiredAlive > caps[класс]`) и забег
   дошёл до `compensateFromSec` (сравнение — по секунде забега на входе в
   отрезок), потерянное добирают здоровье и урон:
   `shortfall = min(maxShortfall, desiredAlive / deviceLimited)`, затем
   `hpMul *= 1 + hpComp × (shortfall − 1)`, `damageMul *= 1 + damageComp ×
   (shortfall − 1)`. До `compensateFromSec` `shortfall = 1` (поле ещё не
   упёрлось в потолок). Обычное устройство тоже имеет потолок
   (`caps.standard = 360` = `240 × 1,5`, верхний предел потолка живых T-0192),
   поэтому «полному арсеналу» потолок живых выше 360 не достаётся — сверх
   него жёстче становятся здоровье и урон. Рычаг «враги быстрее» из Р67 в
   задачу не входит (вопрос 5): слабое устройство добирает здоровьем и
   уроном, как решено.
8. **Когда пересчёт.** Один раз при создании мира (`startPower`, нужен
   событию `started` и аналитике) и на входе в каждый отрезок таймлайна
   (раз в 30–60 секунд) — в `enterSegment` директора. В тик пересчёта нет.
   Враг, уже вышедший, не меняется: хп и урон фиксируются при спавне
   (`spawnEnemy`), как и ступень.
9. **Детерминизм.** Функции подстройки — чистые, **не трогают `world.rng`**
   (ни одного броска: тест сравнивает состояние генератора до и после),
   используют только `+ − × /`, `Math.round`, `Math.min`, `Math.max`,
   `Math.floor`; никаких `Math.pow`, оператора `**`, `Math.random`,
   `Date.now`. Цикл по `LOADOUT_STATS` идёт в порядке перечня, а множители
   перемножаются слева направо в том порядке, в каком записаны в решениях 6–7
   (множитель отрезка, уровень сложности, масштаб подстройки, добавка
   устройства): порядок сложения и умножения дробных чисел — часть
   результата. `-0` после `Math.round`
   нормализуется (`|| 0`): в снимок и в запись он не попадает.
10. **Состояние — числа в `world.difficulty`.** Они переживают снимок
    прерванного забега и повтор без отдельного хранилища: `power`,
    `pressureLevel`, `startPower`, `startPressure`, `spawnMul`,
    `stageShiftSec`, `eliteLead`, `bossLead`. Формат мира в снимке растёт
    (см. шаг 9).
11. **Игроку подстройка не показывается** (решение `claude-lead-1`): ни
    значка, ни строки в листе «Характеристики», ни слова в гайдбуке. В
    аналитику уходит только сила и уровень давления (T-0196).
12. **Рабочие числа контента** (`content/pressure.ts`), каждое с комментарием
    «почему»:

    | Поле | Значение |
    |---|---|
    | `power.slotPoints` | 0,15 |
    | `power.gear` | `damage` 1; `cooldown` 1; `area` 0,4; `projectileSpeed` 0,15; `duration` 0,25; `moveSpeed` 0,5; `pickupRadius` 0,05; `maxHp` 0,01; `regenPerSec` 0,5; `armor` 0,1; `resistFire`, `resistCold`, `resistLightning`, `resistPoison` по 0,35; `damageFire`, `damageCold`, `damageLightning`, `damagePoison` по 0,2; `statusChance` 0,15 |
    | `power.shieldPoints`, `startLevelPoints`, `offerPoints` | 0,2; 0,1; 0,15 |
    | `power.buildPoints`, `buildCap` | 4; 1,5 |
    | `power.buildSchedule` | `[[0, 0.02], [120, 0.12], [300, 0.32], [600, 0.6], [900, 0.85], [1200, 1]]` (T-0196 выведет расписание из прогона бота) |
    | `reference`, `spanUp`, `spanDown` | 2,0; 11; 6 |
    | `minLevel`, `maxLevel` | 0,75; 1,3 |
    | `levers.hp`, `damage`, `spawn`, `alive` | 0,8; 0,6; 0,6; 0,4 |
    | `levers.stageShiftSec`, `leadPerLevel` | 300; 3,5 |
    | `leads.elite`, `leads.boss` | `{ min: -1, max: 1 }`; `{ min: 0, max: 1 }` |
    | `devices.caps` | `standard: 360`, `light: 160` |
    | `devices.compensateFromSec`, `hpComp`, `damageComp`, `maxShortfall` | 300; 0,5; 0,35; 2,5 |

    Ориентиры (посчитаны по `item-rules.ts` и лестнице `unlocks.ts`):
    новичок (1-й уровень, без снаряжения) — около 0,75 очка, `L ≈ 0,79`;
    средний (8-й уровень аккаунта, шесть редких предметов 10-го уровня) —
    около 2,0, `L ≈ 1`; полный арсенал (14-й уровень, шесть легендарных 19-го,
    три буста) — около 4,8, `L ≈ 1,25`.

## Как сейчас

Описано по `dev` на 21.10.2026; к началу задачи влиты T-0192–T-0194,
T-0197 и задачи пачки, от которых она зависит. Строки могли сдвинуться —
искать по именам.

- `game/sim/director.ts`: `enterSegment` (≈ строки 44–70) считает план
  отрезка (`planSegment`) и кладёт в `world.difficulty` множители
  `plan.hpMul × level.enemyHpMul`, `plan.damageMul × level.enemyDamageMul` и
  `min(world.config.maxEnemies, round(plan.maxAlive × level.maxAliveMul))`;
  темп спавна читается в `update` каждый тик: `world.difficultyLevel.spawnRateMul`
  (≈ строка 97). Состояние директора — `saveState`/`loadState` (план целиком
  и долг), его снимок уже есть.
- `game/sim/timeline.ts`: `planGeneratedSegment` (≈ 126–169) выбирает события
  кривой так: `curve.events.filter((event) => (step + 1) % Math.max(1,
  event.everySegments) === 0)`, затем `resolveEvents`. Ранг врага — в
  `world.enemyTypes[i].rank` (`"normal" | "elite" | "boss"`).
- `game/sim/stages.ts`: `pickStage` (≈ 57–85) берёт `world.stats.elapsedSec`,
  открывает ступени с `fromSec ≤ elapsed`; пока открыта одна, генератор не
  трогается вовсе — это важно сохранить.
- `game/sim/world.ts`: `DifficultyState` (≈ 244–252): `segment`,
  `segmentStartedSec`, `hpMul`, `damageMul`, `maxAlive`. `spawnEnemy` берёт
  хп и урон из `world.difficulty.hpMul`/`damageMul` и ступени.
- `game/sim/create-world.ts`: `CreateWorldOptions` (≈ 136–166), литерал
  `difficulty` (≈ 287–293), мир возвращается одним литералом (≈ 250–366).
  Любое необязательное содержание мира имеет заглушку «для тестов» (`FALLBACK_*`);
  `PRESSURE` заглушки не имеет: нет контента — нет подстройки.
- `game/run-world.ts`: `createRunWorld` — единая сборка мира для сцены и
  повтора; открытое уровнем фильтруется там же (`unlocksAt`).
- `game/progression/run-loadout.ts`: `sanitizeLoadout` (≈ 49–70, два
  `return`), `isEmptyLoadout` (≈ 79): пустой набор в запись и снимок не
  пишется; `accountLevel` — образец необязательного поля набора.
- `game/run/snapshot.ts`: `WORLD_SNAPSHOT_VERSION` (≈ 22), `difficulty`
  переносится целиком (`{ ...world.difficulty }` при съёмке и
  `assignNumbers` при восстановлении: **бросает ошибку, если в снимке нет
  числового поля, которое есть в мире**, — поэтому новые поля требуют подъёма
  версии). `run-api.ts`: `RUN_SNAPSHOT_FORMAT` (≈ 187), `RunEvents.started`
  (≈ 323: `runId`, `difficultyId`, `startingWeaponId`).
- `game/run/run-result.ts`: `buildRunResult`; `RunResult` — в
  `shared-types` (≈ 1203), необязательные поля добавляются по образцу `boosts?`.
- `game/MainScene.ts`: `started` эмитится один раз после сборки сцены
  (≈ 243–249), запись забега собирает `world.runLoadout` целиком
  (≈ 223 и 495), «Ещё раз» сохраняет набор и обнуляет бусты (≈ 430).
- `content/hash.ts`: `CONTENT_HASH` по списку таблиц контента; новая таблица
  добавляется в конец списка.
- Боты `balance:sim` и сценарные тесты создают мир через `createWorld`/
  `createRunWorld` **без** `accountLevel` — подстройка для них выключена
  (решение 3).

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»), включая помощник
   `test/helpers/pressure-fixture.ts`. До кода они не компилируются, это
   ожидаемо.
2. **`shared-types/src/index.ts`.**
   - `export const DEVICE_CLASSES = ["standard", "light"] as const;` и
     `export type DeviceClass`.
   - `RunLoadout.deviceClass?: DeviceClass` с комментарием «почему»: класс
     устройства влияет на бой, значит обязан попасть в запись и снимок, а
     набор туда уже попадает; нет поля — обычное устройство.
   - `PressureDef` (форма — решение 12: `power { slotPoints, gear:
     Partial<Record<LoadoutStat, number>>, shieldPoints, startLevelPoints,
     offerPoints, buildPoints, buildCap, buildSchedule: [number, number][] }`,
     `reference`, `spanUp`, `spanDown`, `minLevel`, `maxLevel`, `levers {
     hp, damage, spawn, alive, stageShiftSec, leadPerLevel }`, `leads {
     elite, boss: { min, max } }`, `devices { caps: Record<DeviceClass,
     number>, compensateFromSec, hpComp, damageComp, maxShortfall }`).
   - `RunPressureStart { power: number; level: number; deviceClass:
     DeviceClass }`, `RunPressureResult extends RunPressureStart {
     powerEnd: number; levelEnd: number }`, `RunResult.pressure?:
     RunPressureResult` (комментарий: нет поля — подстройки не было).
3. **`content/pressure.ts`** (новый): `export const PRESSURE: PressureDef` с
   числами решения 12. Шапка: что такое очки, что `reference` — давление
   T-0192, что числа рабочие и калибруются по `pnpm balance:sim`
   (`docs/32-balance.md` §3). Комментарий у каждого числа, у которого есть
   «почему» (не пересказ имени поля). `content/hash.ts`: `PRESSURE` — в конец
   списка отпечатка.
4. **`game/sim/player-power.ts`** (новый, чистый):
   - `buildScoreOf(world: World): number` — решение 4;
   - `expectedBuildScore(schedule, sec): number`;
   - `interface PlayerPower { slots; gear; boosts; build; total }`;
   - `computePlayerPower(world: World, rules: PressureDef): PlayerPower` —
     слагаемые решения 4; цикл по `LOADOUT_STATS` в порядке перечня,
     неизвестные веса — ноль; аллокация одного результата на вызов
     допустима (вызов раз в отрезок), в цикле — никаких.
5. **`game/sim/pressure.ts`** (новый, чистый):
   - `isPressureActive(world): boolean` — `world.pressureRules !== null &&
     world.runLoadout.accountLevel !== undefined`;
   - `pressureLevelOf(rules, total): number` — решение 5;
   - `leversOf(rules, level): PressureLevers` — решение 6
     (`hpScale`, `damageScale`, `spawnScale`, `aliveScale`, `stageShiftSec`,
     `eliteLead`, `bossLead`);
   - `refreshPressure(world): void` — считает силу и уровень, пишет в
     `world.difficulty` поля `power`, `pressureLevel`, `spawnMul`,
     `stageShiftSec`, `eliteLead`, `bossLead`;
   - `applySegmentPressure(world, plan: { maxAlive: number; hpMul: number;
     damageMul: number }): void` — решения 6–7: `hpMul`, `damageMul`,
     `maxAlive` с потолком устройства и добавкой за урезанное;
   - `initPressure(world): void` — `refreshPressure` и запись `startPower`,
     `startPressure`;
   - `describePressureStart(world): RunPressureStart | undefined` и
     `describePressureResult(world): RunPressureResult | undefined`
     (`undefined`, если подстройка выключена; числа округлены до сотых);
   - `findPressureProblems(def: PressureDef): string[]` — проверки контента
     (раздел «Тесты», `content.test.ts`): сообщения по-русски, с путём поля,
     в формате `findChestsProblems`.
6. **`game/sim/world.ts`, `game/sim/create-world.ts`.**
   - `DifficultyState` + `power`, `pressureLevel`, `startPower`,
     `startPressure`, `spawnMul`, `stageShiftSec`, `eliteLead`, `bossLead`
     (комментарий у каждого: что это и чему равно без подстройки).
   - `World.pressureRules: PressureDef | null`;
     `CreateWorldOptions.pressure?: PressureDef`; значение по умолчанию —
     `null`, без заглушки. Если контент передан — `findPressureProblems`, при
     проблемах `throw new Error("Некорректная подстройка давления:\n…")` (как
     у сундуков).
   - Литерал `difficulty`: `power 0`, `pressureLevel 1`, `startPower 0`,
     `startPressure 1`, `spawnMul 1`, `stageShiftSec 0`, `eliteLead 0`,
     `bossLead 0`. Мир собирается в переменную; после сборки, если
     `isPressureActive(world)`, вызывается `initPressure(world)`.
7. **Директор, таймлайн, ступени.**
   - `director.ts`, `enterSegment`: сначала, если `isPressureActive(world)`,
     `refreshPressure(world)` (ведущие сдвиги нужны плану); затем
     `planSegment`; затем множители: при активной подстройке —
     `applySegmentPressure(world, plan)`, иначе **прежние строки без единой
     правки** (побитовое равенство, решение 3). `update`: `const
     spawnRateMul = world.difficultyLevel.spawnRateMul * world.difficulty.spawnMul;`
     (при `spawnMul = 1` результат тот же бит в бит).
   - `timeline.ts`, `planGeneratedSegment`: выбор событий — через помощник
     `eventsDue(world, curve.events, step)`: для события с рангом врага
     `elite` берётся `world.difficulty.eliteLead`, с рангом `boss` —
     `bossLead`, иначе 0; срабатывает, если `n = step + 1 + lead > 0` и
     `n % max(1, everySegments) === 0`. Расписанные руками отрезки
     (`planManualSegment`) не меняются.
   - `stages.ts`, `pickStage`: `const elapsed = Math.max(0,
     world.stats.elapsedSec + world.difficulty.stageShiftSec);`. Правило «одна
     открытая ступень — генератор не трогается» остаётся.
8. **Набор и сборка мира.** `run-loadout.ts`: `sanitizeLoadout` сохраняет
   `deviceClass` только значения `"light"` (всё остальное, включая `"standard"`
   и мусор, отбрасывается — отсутствие поля и есть «обычное»), в обоих
   `return`; `isEmptyLoadout` не считает пустым набор с `deviceClass`.
   `run-world.ts`: в `createWorld` — `pressure: PRESSURE`.
9. **Снимок.** `snapshot.ts`: `WORLD_SNAPSHOT_VERSION` +1 от значения в
   `dev` на момент задачи; `run-api.ts`: `RUN_SNAPSHOT_FORMAT` +1 (комментарий
   поля не переписывать; тесты формата сравнивают с константами). Новые поля
   `difficulty` переносятся сами (`{ ...world.difficulty }` и
   `assignNumbers`). Если параллельная задача уже подняла версию — поднять
   ещё раз, а не выравнивать.
10. **Итог и событие старта.** `run-result.ts`: в `buildRunResult` —
    `...(pressure === undefined ? {} : { pressure })`, где `pressure =
    describePressureResult(world)`. `run-api.ts`: `RunEvents.started` +
    `pressure?: RunPressureStart` (комментарий: нет поля — подстройки не было).
    `MainScene.ts`: в `bus.emit("started", …)` добавить `pressure` из
    `describePressureStart(this.world)` тем же условным спредом.
    Продолженный забег `started` не присылает — как сейчас.
11. **Документы** (раздел «Документы») и гейт (`CLAUDE.md`).

## Чего не трогаем

- Калибровку чисел, профили силы, `simulate.ts`, `balance-sim.ts`,
  `balance-targets.ts`: это T-0196. Числа `PRESSURE` здесь — рабочие.
- Оболочку (`app-shell`), определение слабого устройства, аналитику, серверную
  схему записи: T-0196. Эта задача добавляет в движок только данные и поля.
- Множители единой сложности, ступени, события и кривую T-0192, прокачку
  T-0193, «Предел» T-0194, второго босса T-0197.
- Бота калибровки (`game/balance/bot.ts`) и его параметры.
- Контрольную сумму мира (`checksumWorld`): подстройка меняет исход через
  хп врагов и число спавнов, которые в ней уже есть; добавление поля сдвинуло
  бы все эталоны.
- Запись забега (`RunRecording`, `RunRecorder`) и повтор (`replay.ts`): они
  уже передают `loadout` целиком; правок не нужно, и тест повтора это
  доказывает.
- Расписанные руками отрезки первых 5:30 и события обычных врагов.
- Лист «Характеристики» (`RunInspection`), гайдбук, тексты `ru.json`:
  подстройка игроку не показывается.
- Скорость врагов и профиль частоты кадров: см. вопросы.

## Сценарий и интерфейс

Экранов нет. Игрок не видит ни подстройки, ни её следа в интерфейсе (решение
11); меняется только то, насколько плотный и крепкий бой.

## Тесты

Первым коммитом, до кода.

`packages/core-game/test/helpers/pressure-fixture.ts` (новый): `TEST_PRESSURE:
PressureDef` с двоично-точными числами, чтобы ожидания считались без
округлений: `slotPoints 0.25`; `gear { damage 1, maxHp 0.0625 }`;
`shieldPoints 0.25`, `startLevelPoints 0.125`, `offerPoints 0.125`;
`buildPoints 1`, `buildCap 0.5`, `buildSchedule [[0,0],[100,0.5],[200,1]]`;
`reference 1.25`, `spanUp 2`, `spanDown 1`, `minLevel 0.75`, `maxLevel 1.5`;
`levers { hp 1, damage 0.5, spawn 0.5, alive 0.5, stageShiftSec 100,
leadPerLevel 4 }`; `leads { elite {-1, 1}, boss {0, 1} }`; `devices { caps {
standard 400, light 100 }, compensateFromSec 60, hpComp 0.5, damageComp 0.5,
maxShortfall 2 }`. Там же помощник, собирающий мир с `loadoutLimits`,
`loadout { modifiers, boosts, accountLevel }`, `pressure` и стартовым
оружием.

`packages/core-game/test/player-power.test.ts` (новый):

- **слоты:** лимиты `{ weapons 2, attack 1, defense 1, mobility 1 }` дают
  `0,25 × 5 = 1,25`, лимиты `4 / 3 / 2 / 1` — `2,5`;
- **снаряжение:** модификаторы `{ damage: 0.1, maxHp: 16 }` дают `0,1 + 1 =
  1,1`; нулевые и неизвестные параметры в сумму не входят; прибавка буста
  (`fury`) идёт через `world.loadoutModifiers` и тоже считается;
- **эффекты бустов:** `shieldHits 1` — `+0,25`, `startLevels 2` — `+0,25`,
  `extraOffers 1` — `+0,125`;
- **собранное:** стартовый мир на 0-й секунде (ожидаемое 0): `build =
  buildPoints × buildScoreOf(world)`, то есть не отрицательно и не больше
  `buildCap`; мир с полностью заполненным набором (все слоты заняты, все
  уровни на максимуме, `buildScoreOf = 1`) на 50-й секунде (ожидаемое 0,25) —
  `build = +0,5` (потолок, не 0,75); мир с одним оружием первого уровня на
  200-й секунде (ожидаемое 1) — `-0,5` (потолок); ломаная
  `expectedBuildScore`: до первой точки, ровно на точке, между точками
  (100 → 150 = 0,75), после последней; пустой список типов оружия и навыков
  не даёт деления на ноль;
- **не трогает генератор:** `world.rng.getState()` до и после
  `computePlayerPower` один и тот же; два вызова подряд дают равные числа;
- **выключено:** набор без `accountLevel` и мир без `pressure` — `isPressureActive`
  ложно, `describePressureStart` и `describePressureResult` — `undefined`.

`packages/core-game/test/pressure.test.ts` (новый):

- **уровень давления:** `total = reference` → `L = 1` ровно; `total =
  reference + 1` → `1 + 1/2 = 1,5` (потолок `maxLevel`); `total = reference −
  0,5` → `0,5` → зажато `0,75`; промежуточные значения линейны;
- **рычаги:** при `L = 1,5` (`d = 0,5`): `hpScale 1,5`, `damageScale 1,25`,
  `spawnScale 1,25`, `aliveScale 1,25`, `stageShiftSec 50`, `eliteLead 1`
  (`round(2)` зажато до 1), `bossLead 1`; при `L = 0,75` (`d = −0,25`):
  `0,75 / 0,875 / 0,875 / 0,875`, `stageShiftSec −25`, `eliteLead −1`,
  `bossLead 0` (зажат нижним пределом босса); `L = 1` — единицы и нули, без
  `-0`;
- **директор, множители отрезка:** на мире с активной подстройкой первый
  `director.update` ставит `world.difficulty.hpMul/damageMul/maxAlive/spawnMul`
  по формулам решений 6–7 (план — фикстура с `maxAlive 200`); спавн-темп в
  `update` умножается на `spawnMul`;
- **слабое устройство:** `deviceClass: "light"` при `desiredAlive 200`,
  `caps.light 100` и секунде 0 — `maxAlive 100`, `hpMul` и `damageMul` без
  добавки (`compensateFromSec 60`); на секунде 60 — `shortfall = min(2,
  200 / 100) = 2`, `hpMul × 1,5`, `damageMul × 1,5`; `desiredAlive 150`
  (`shortfall 1,5`) — `× 1,25`; обычное устройство при `desiredAlive 200` и
  `caps.standard 400` — добавки нет; потолок пула `maxEnemies 64` режет
  `maxAlive`, но добавку за устройство не даёт;
- **сдвиг ступеней:** две ступени `fromSec 0` и `100`; `stageShiftSec 50` на
  секунде 60 открывает вторую (генератор бросает), `0` — нет (состояние
  генератора не меняется); `−50` на секунде 120 — вторая закрыта; результат
  `max(0, …)` не уходит в минус;
- **сдвиг событий:** кривая из событий `elite_ghoul` (`everySegments 3`),
  `boss_matryoshka` (`3`) и `swarm_rat` (`3`, фланг); элитные события на
  шагах 2, 5, 8 при `eliteLead 0`; на шагах 1, 4, 7 при `+1`; на шагах 3, 6
  при `−1` (шаг 0 не срабатывает: `n = 0`); боссовые — по `bossLead`
  независимо от элитного; события обычного врага — на шагах 2, 5, 8 при любом
  сдвиге; расписанные руками отрезки не двигаются;
- **ровно ничего, когда сила опорная:** два мира одного зерна — без
  `pressure` и с `TEST_PRESSURE` (с `buildPoints 0`, пять слотов,
  `reference 1,25`, обычное устройство, потолок 400 выше желаемого) —
  идут 150 секунд под одним и тем же директором и вводом: равны
  `checksumWorld`, `enemiesSpawned`, состояние `world.rng.getState()`;
- **включение:** мир без `accountLevel` с активным контентом идёт так же, как
  без контента (те же числа);
- **ориентиры контента:** мир на лимитах 1-го уровня (`unlocksAt(ACCOUNT_UNLOCKS,
  1).limits`) без снаряжения даёт `L` от 0,7 до 0,9; мир 8-го уровня с набором
  «средний» (литерал из `item-rules`: `{ damage 0.1072, cooldown 0.0714,
  area 0.143, statusChance 0.0893, damageFire 0.0893, damageCold 0.0893,
  maxHp 21.44, armor 1.0718, regenPerSec 0.3572, pickupRadius 0.2144,
  moveSpeed 0.0357 }`) — от 0,95 до 1,05; мир 14-го уровня с набором «полный»
  (`{ damage 0.262, cooldown 0.1748, area 0.3494, projectileSpeed 0.4368,
  duration 0.3494, statusChance 0.4368, damageFire 0.2184, damageCold 0.2184,
  damageLightning 0.2184, damagePoison 0.2184, maxHp 52.42, armor 2.6208,
  regenPerSec 1.3104, resistFire 0.262, resistCold 0.262, pickupRadius 0.5242,
  moveSpeed 0.0874 }`, буст `fury`, `bulwark`, `aegis`) — от 1,15 до 1,3;
  порядок `L(новичок) < L(средний) < L(полный)`; на реальном контенте
  `PRESSURE` и `createRunWorld`.
- **детерминизм при замене движка:** тест чистоты `sim-purity.test.ts`
  остаётся зелёным без правок (новые файлы лежат в `game/sim/`).

`packages/core-game/test/pressure-replay.test.ts` (новый):

- **повтор забега с подстройкой даёт тот же бой:** `recordHeadlessRun({ seed:
  7, maxTicks: 24_000, difficultyId: "hard", steer: circling(200), loadout: {
  modifiers: { damage: 0.1, maxHp: 20 }, boosts: ["fury"], accountLevel: 8,
  deviceClass: "light" } })`; `replayRecording` — `match`; в записи
  `loadout.deviceClass === "light"` и `accountLevel === 8`;
- **то же для обычного устройства** (без `deviceClass`): `match`, в записи
  поля нет;
- **снимок посреди забега:** мир с набором, 200 секунд, `captureWorld`, новый
  мир тем же набором, `restoreWorld`, ещё 200 секунд — `checksumWorld` равен
  непрерывному забегу, поля `world.difficulty` (все новые) равны;
- **итог несёт силу:** `buildRunResult` мира с подстройкой содержит
  `pressure { power, level, powerEnd, levelEnd, deviceClass }` с числами до
  сотых; без `accountLevel` поля `pressure` нет.

`packages/core-game/test/run-loadout.test.ts`: `sanitizeLoadout` сохраняет
`deviceClass: "light"`, отбрасывает `"standard"`, `"weird"` и нестроку,
сохраняет вместе с `accountLevel`; `isEmptyLoadout({ modifiers: {}, boosts:
[], deviceClass: "light" })` ложно.

`packages/core-game/test/run-snapshot.test.ts`: версия мира и формат растут на
единицу; снимок прежней версии отвергается `SnapshotError` с понятным
сообщением; новые поля `difficulty` переносятся.

`packages/core-game/test/run-summary.test.ts`: сценарные эталоны не
меняются; `result.pressure` у сценария без набора — `undefined`.

`packages/core-game/test/content.test.ts`: `findPressureProblems(PRESSURE)`
пуст; `findPressureProblems` ловит каждую ошибку по отдельности: `reference
<= 0`, `spanUp <= 0`, `spanDown <= 0`, `minLevel > 1` или `maxLevel < 1`,
`minLevel <= 0`, отрицательный наклон рычага, множитель рычага на предельном
уровне `<= 0,25` (`1 + slope × (minLevel − 1)`), вес снаряжения для
неизвестного параметра или отрицательный, пустое или убывающее расписание
(секунды строго растут и начинаются с 0; доли не убывают и в пределах 0–1),
не целый или перевёрнутый `leads`, `caps.light > caps.standard` или меньше 60,
`maxShortfall < 1`, отрицательные `hpComp`/`damageComp`/`compensateFromSec`,
`buildCap < 0`; сообщения называют поле. Сверх того: `PRESSURE.devices.caps.standard`
не меньше `round(ENDLESS_CURVE.maxAlive × findDifficulty("hard").maxAliveMul)`
(потолок обычного устройства не режет «Сложную» на опорной силе) и не больше
пула `DEFAULT_SIM_CONFIG.maxEnemies`; `caps.light` ниже `caps.standard`;
`reference` лежит между очками новичка и полного арсенала из теста
ориентиров. Прежние тесты контента зелёные без правок.

Остальные тесты движка, `sim-purity`, `layer-boundaries`, `perf-budget`,
`determinism` и `run-summary` — зелёные без правок эталонов.

## Аналитика

Движок отдаёт силу и уровень давления: `RunEvents.started.pressure` и
`RunResult.pressure` (поля выше). Отправка событиями `run_started`,
`run_finished`, `run_abandoned` и запись в словарь
(`docs/22-analytics-and-metrics.md` §3.3 и Zod-схема) — T-0196: сначала словарь,
потом код, поэтому поля пока никуда не уходят. Меток Prometheus нет.

## Настройки и окружение

Нет. Числа — контент (`content/pressure.ts`), как у сложностей и ступеней;
в панель настроек они не выносятся: правка баланса идёт релизом вместе с
калибровкой. Новых переменных окружения нет.

## Документы

- `docs/32-balance.md`: новый §2.7 «Подстройка под силу игрока (Р131)» — что
  такое очки, четыре слагаемых, `L`, три рычага с формулами, слабое
  устройство, что включает подстройку (уровень аккаунта и контент), где лежат
  числа и чем калибруются (T-0196). Одной строкой — в §1 «Из чего состоит
  баланс».
- `docs/30-configuration-map.md`: строка «Подстройка давления под силу
  игрока и под слабое устройство» → `content/pressure.ts` → `PRESSURE`
  (сила, уровни, рычаги, потолки устройств), проверка — тест контента,
  калибровка — `pnpm balance:sim`.
- `docs/05-game-design.md` (раздел про сложность): «сложность одна, давление
  подстраивается под силу игрока и не показывается ему».
- `docs/28-diagnostics.md`, строка про `loadout` записи (≈ 224): добавить
  `deviceClass`.
- `CLAUDE.md`, «Как добавить отрезок таймлайна спавна»: после абзаца про
  уровни сложности — абзац «Подстройка под силу игрока (Р131) — `content/
  pressure.ts`: очки силы из слотов, снаряжения, бустов и собранного набора
  относительно расписания; уровень давления в пределах 0,75–1,3; три рычага
  — здоровье и урон, темп и потолок живых, ступени и события элит и боссов;
  на слабом устройстве потолок живых ниже, а добавку берут здоровье и урон.
  Работает, только если у набора есть `accountLevel`: стенд, боты и забег
  разработчика идут без неё. Числа калибрует `pnpm balance:sim`
  (профили силы), игроку подстройка не показывается».
- `docs/21-diagrams.md` не затрагивается (схем БД, пакетов, сервисов нет).
- `docs/35-stage4-plan.md` (Р131, WP34) правит тимлид.

## Вопросы к тимлиду

Принято по умолчанию; `claude-lead-1` подтверждает или правит при слиянии
спецификации:

1. **Боссы сдвигаются только вперёд**, элиты — в обе стороны. Р131 говорит
   «раньше открываются ступени, элиты и боссы»; «позже» для босса новичку не
   дано из-за рубежа T-0120 на 10:00 и правила T-0192 «боссы не ближе минуты
   к 10:00». Пределы — данные `leads`, снять запрет — одна строка контента.
2. **Расписание сборки** (`buildSchedule`) выведет T-0196 из бота, а не из
   людей. После выката сверить с живыми забегами по `power` в аналитике.
3. **Формат снимка поднят** (мир +1, забег +1): прерванные забеги прежней
   сборки не продолжатся. Они и так не продолжились бы — `CONTENT_HASH`
   меняют T-0192 и T-0193.
4. **`deviceClass` лежит в `RunLoadout`** (по образцу `accountLevel`), а не
   отдельным полем в `RunOptions`, записи и снимке. Если по смыслу
   «устройство — не набор» мешает, цена переноса — три места и три формата.
5. **Рычага «враги быстрее» из Р67 нет**: скорость врага хранится в типе, а не
   в пуле, и её множитель потребовал бы нового поля в пуле и в снимке. Слабое
   устройство добирает здоровьем и уроном (формулировка задания). Если нужен
   и третий добор — отдельная задача.
6. **Пределы `L` (0,75–1,3), наклоны рычагов и пороги слабого устройства**
   — предложение, не расчёт: проверяются коридорами T-0196.
7. **Подстройка по ходу забега зависит только от собранного набора и времени**,
   не от здоровья игрока и не от того, как он играет сейчас. «Динамическая
   сложность по смертям» в Р131 не заказана и в задачу не входит.

## Критерии приёмки

- [ ] `PRESSURE` в контенте, `PressureDef`, `DEVICE_CLASSES`,
  `RunLoadout.deviceClass`, `RunResult.pressure`, `started.pressure` в типах;
  `PRESSURE` входит в `CONTENT_HASH`.
- [ ] Сила и уровень давления считаются чистыми функциями от мира; генератор
  `world.rng` не тронут; в `sim` нет `Math.pow`, `**`, `Math.random`,
  `Date.now`.
- [ ] Три рычага работают по формулам решений 6–7; у боссов сдвиг только
  вперёд; расписанные руками отрезки не двигаются.
- [ ] Слабое устройство: потолок живых ниже, до `compensateFromSec` без
  добавки, после — добавка здоровья и урона в пределе `maxShortfall`.
- [ ] Без `accountLevel` или без контента забег побитово равен прежнему:
  боты, сценарные эталоны `determinism` и `run-summary`, golden «Сложной»
  не изменились.
- [ ] Повтор по записи с подстройкой и со слабым устройством даёт `match`;
  снимок посреди забега продолжается в тот же бой; формат снимка поднят.
- [ ] `sanitizeLoadout` и `isEmptyLoadout` знают `deviceClass`.
- [ ] Игроку подстройка нигде не показывается.
- [ ] Документы и `CLAUDE.md` описывают то, что есть; дифф только в зонах;
  гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Считать силу игрока и подстраивать давление`
- **Метка:** `release: minor`
- **Для игроков:** нет — механизм без калибровки, игроку ничего не
  показывается (раздела `## Для игроков` в описании PR нет)
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СИЛА ИГРОКА И ПОДСТРОЙКА ДАВЛЕНИЯ**

  Движок научился считать силу игрока (уровень аккаунта, снаряжение, бусты, собранное в забеге) и подстраивать по ней давление: здоровье и урон врагов, темп спавна и потолок живых, ступени и события элит и боссов. На слабом устройстве потолок живых ниже, а недостающее добирают здоровье и урон.

  🛠 **Движок и контент**

  • новый контент content/pressure.ts, рабочие числа калибрует следующая задача
  • класс устройства едет в наборе забега, поэтому попадает в запись и снимок
  • боты, стенд и забег разработчика идут без подстройки, эталоны не менялись
  • формат снимка забега поднят

  ❓ **Нужно от команды**

  • @владелец — подтвердить вопросы 1, 4 и 5 из спецификации
  ```
