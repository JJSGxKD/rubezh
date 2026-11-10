---
id: T-0421
title: Паттерн неубиваемого преследователя — толчки вместо урона, тяжёлое касание
epic: E10
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - packages/core-game/src/game/patterns/stalker.ts
  - packages/core-game/src/game/sim/stalker-body.ts
  - packages/core-game/src/content/stalker.ts
  - packages/core-game/test/stalker-body.test.ts
shared:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/game/patterns/enemy-types.ts
  - packages/core-game/src/game/patterns/index.ts
  - packages/core-game/src/game/sim/combat.ts
  - packages/core-game/src/game/sim/step.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/sim/pickups.ts
  - packages/core-game/src/game/sim/elements.ts
  - packages/core-game/src/game/sim/director.ts
  - packages/core-game/src/game/sim/spawner.ts
  - packages/core-game/src/game/sim/timeline-content.ts
  - packages/core-game/src/game/sim/checksum.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/render/looks.ts
  - packages/core-game/src/game/content-problems.ts
  - packages/core-game/src/content/enemies.ts
  - packages/core-game/src/content/snapshot.ts
  - packages/core-game/src/content/snapshot-schema.ts
  - packages/core-game/src/content/hash.ts
  - packages/core-game/test/**
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/i18n/ru-guide.json
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: design/art/concepts/stalker/README.md
batch: 5
---

# T-0421. Паттерн неубиваемого преследователя — толчки вместо урона, тяжёлое касание

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0421.json)](README.md#значки-статуса)

Строку значков и ячейку эпика ставит `pnpm task fix`.

## Зачем

Игра сейчас слишком лёгкая, и сильный игрок стоит на месте (Р197). Владелец
решил добавить Карачуна — врага, которого нельзя убить: он идёт за игроком,
бьёт касанием на треть здоровья, а оружие его только отталкивает (Р205). Эта
задача — тело врага: как он ходит, что с ним делают удары и что делает его
касание. Когда и где он появляется, решает следующая задача (T-0423). В
забег он попадает в T-0424.

## Решения

- **Р205** (`docs/35-stage4-plan.md`, 10.11.2026) — все правила Карачуна.
  Решения тимлида в той же строке исполнитель не пересматривает.
- **Механика в коде — «неубиваемый преследователь»**, паттерн `stalker`.
  Карачун — первый враг на нём (`id: "karachun"`). Ни одного
  `if (id === "karachun")` в движке: всё через признак паттерна
  `unkillable` и числа `STALKER`.
- **Числа — в `content/stalker.ts`, а не в `params` врага**, как числа кольца
  у события `cordon`: `EnemyPatternParams.stalker` — `Record<string, never>`.
  Почему: правила преследователя целиком (тело здесь, появления в T-0423)
  должны лежать в одном месте у геймдизайнера.
- **Толчок направлен от игрока**, а не по ходу снаряда: так он всегда
  отодвигает угрозу, а не швыряет врага вбок.
- **Удар — доля максимума здоровья мимо брони и сопротивлений.** Щит буста
  гасит его, неуязвимость после второго шанса защищает, бессмертие
  разработчика не даёт урона — как у любого попадания.
- **Ступени, подстройка, множители сложности и отрезка его не меняют**:
  здоровье и урон не читаются, скорость — как в контенте.
- **Состояния его не берут:** горение, холод, шок, яд и динамит. Заморозка
  подбором держит его как босса (`isTimeFrozen(world, true)`).
- **Автоприцел целится в него**, если он ближе всех: отталкивать его —
  значит не бить толпу. Это сознательно.
- Числа ниже — стартовые; калибровка — в T-0424.

## Как сейчас

- Паттерны — `packages/core-game/src/game/patterns/`: реестр `PATTERNS` в
  `index.ts`, признаки `PATTERN_TRAITS`, умолчания `PATTERN_DEFAULTS` и
  допустимые параметры `ALLOWED_PARAMS` в `enemy-types.ts`. Тип
  `EnemyPatternParams` — `packages/shared-types/src/index.ts` (около строки
  460); `EnemyPattern = keyof EnemyPatternParams`.
- Урон врагу — одна точка входа: `damageEnemy` и `inflictDamage` в
  `game/sim/combat.ts`. Смерть и счётчики — `killEnemy` там же.
- Касание — `updateEnemies` в `game/sim/step.ts`: `damagePlayer(world,
  enemies.damage[i], typeIndex)` и `MELEE_INTERVAL_SEC`.
- `damagePlayer` — `game/sim/world.ts` (около строки 631): щит, сопротивление,
  броня `MIN_DAMAGE_RATIO`, оберег пролога, событие `playerHit`.
- Неуязвимость после второго шанса — `player.invulnerableTicks`, тикает в
  начале `stepWorld`. Образец для новых тиков игрока.
- Перенос отставших вперёд — `recycleLostEnemies` в `step.ts`: пропускает
  `anchored`.
- Потолок живых — `atCap` в `game/sim/director.ts` (`aliveCount`); пик —
  `peakEnemies` в конце `stepWorld`; ещё `spawner.ts`, строка с `aliveCount`.
- Динамит — `detonate` в `game/sim/pickups.ts`: рядовых убивает
  `killEnemy`, элите снимает долю.
- Состояния — `tryApplyStatus` в `game/sim/elements.ts` бросает `world.rng`;
  перескок молнии — `chainTargets` там же.
- Страж кольца исключён из потока, смеси и событий проверками
  `game/sim/timeline-content.ts` (строки 72, 102, 170, 211) — образец для
  запрета Карачуна в таймлайне.
- Облик — `ENEMY_LOOKS: Record<EnemyPattern, ShapeLook>` в
  `game/render/looks.ts`; без записи не соберётся.
- Гайдбук проверяет, что у каждого врага есть `enemy.<id>.name` в
  `app-shell/src/i18n/ru.json`, а у каждого паттерна — `guide.pattern.<p>.*`
  в `ru-guide.json` (`packages/app-shell/test/guide.test.ts`).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Типы** (`packages/shared-types/src/index.ts`):
   - в `EnemyPatternParams` — `stalker: Record<string, never>` с комментарием
     «числа преследователя — `content/stalker.ts`, а не у врага»;
   - тип правил тела:

   ```ts
   /** Тело неубиваемого преследователя (docs/35-stage4-plan.md, Р205). Расстояния — игровые единицы. */
   export interface StalkerBodyDef {
     /** доля максимума здоровья игрока за одно касание, мимо брони и сопротивлений */
     touchMaxHpShare: number;
     /** отброс игрока после касания: на сколько единиц и за сколько секунд */
     knockback: { distance: number; sec: number };
     /** сколько после касания он не бьёт снова */
     touchCooldownSec: number;
     /** сколько после касания он стоит на месте */
     recoverSec: number;
     push: {
       /** первый толчок серии, единиц */
       first: number;
       /** каждый следующий толчок серии — предыдущий, умноженный на это */
       decay: number;
       /** столько секунд без попаданий — серия сначала */
       seriesResetSec: number;
       /** за любые 60 тиков подряд — не дальше этого, единиц */
       maxPerSec: number;
     };
   }
   export interface StalkerDef { enemy: string; body: StalkerBodyDef }
   ```

   T-0423 допишет в `StalkerDef` поля появлений — оставь тип расширяемым.
3. **Данные** — новый `packages/core-game/src/content/stalker.ts`:

   ```ts
   export const STALKER: StalkerDef = {
     enemy: "karachun",
     body: {
       touchMaxHpShare: 0.33,
       knockback: { distance: 90, sec: 0.2 },
       touchCooldownSec: 2.5,
       recoverSec: 0.8,
       push: { first: 22, decay: 0.6, seriesResetSec: 0.6, maxPerSec: 60 },
     },
   };
   ```

   и в `content/enemies.ts` — запись после стража кольца:

   ```ts
   // Карачун (Р205): убить нельзя, числа — в content/stalker.ts. hp и damage не читаются.
   { id: "karachun", hp: 1, speed: 110, damage: 0, xp: 0, pattern: "stalker" },
   ```

   Скорость 110 при скорости игрока 190: убежать можно, стоять — нет.
4. **Проверка `findStalkerProblems(def, enemies)`** в `game/sim/stalker-body.ts`,
   вызов из `game/content-problems.ts` разделом `stalker`. Сообщение
   называет поле:
   - `stalker.enemy` есть в контенте и его паттерн `stalker`;
   - у врага: `xp` 0, `damage` 0, `rank`, `resist`, `element`, `size` не
     заданы;
   - `touchMaxHpShare` от 0,1 до 0,6;
   - `knockback.distance` от 0 до 200, `knockback.sec` от 0,05 до 0,5;
   - `touchCooldownSec` от 0,5 до 10, `recoverSec` от 0 до `touchCooldownSec`;
   - `push.first` больше 0 и не больше 80; `push.decay` больше 0 и меньше 1;
     `push.seriesResetSec` от 0,1 до 3;
   - **`push.maxPerSec` больше 0 и не больше 0,6 скорости врага.** Это и есть
     «не переборщить»: даже под огнём всего арсенала он подходит со
     скоростью не меньше 0,4 своей.

   В `timeline-content.ts` — по образцу стража кольца: враг паттерна
   `stalker` не может быть в потоке, в выбросе, в событиях `ring`, `flank`,
   `cordon`, внутри строя и в смеси кривой. Сообщение: «преследователь X не
   приходит таймлайном: его выпускает директор преследователя».
5. **Паттерн** `game/patterns/stalker.ts`:
   - `PATTERN_TRAITS.stalker = { radius: 16, contactDamage: true, solid: false,
     anchored: false, unkillable: true }`; новое поле `unkillable: boolean` в
     `PatternTraits` — у остальных `false`. Признак переносится в
     `EnemyType` так же, как `anchored`;
   - `PATTERN_DEFAULTS.stalker = {}`, `ALLOWED_PARAMS.stalker = []`;
   - `update`: идёт прямо на игрока со скоростью типа (как `swarm`); пока
     `recoverTicks > 0` — стоит (`vx = vy = 0`);
   - регистрация в `PATTERNS`.
6. **Тело** — `game/sim/stalker-body.ts`, состояние в мире
   `world.stalkerBody`:

   ```ts
   export interface StalkerBodyState {
     /** слот живого преследователя; −1 — его нет */
     slot: number;
     /** толчки последних TICK_HZ тиков: кольцевой буфер, сумма — бюджет секунды */
     pushWindow: Float64Array;
     pushCursor: number;
     pushWindowSum: number;
     /** множитель следующего толчка серии: 1, decay, decay², … — умножением, без Math.pow */
     seriesFactor: number;
     /** тик последнего толчка; серия сначала через seriesResetSec */
     lastPushTick: number;
     touchCooldownTicks: number;
     recoverTicks: number;
   }
   ```

   - `spawnStalker(world, typeIndex, x, y): number` — ставит врага в точку
     через `spawnEnemy`, но ступень всегда 0 и множители здоровья и урона не
     применяются; заполняет `slot`, сбрасывает серию, окно и таймеры. Второго
     не ставит: если `slot >= 0` — возвращает −1. Зовёт T-0423, а здесь —
     тесты;
   - `despawnStalker(world)` — `despawnEnemy` и `slot = -1`;
   - `pushStalker(world)` — один толчок: размер `first × seriesFactor`,
     урезанный до `maxPerSec − pushWindowSum`, сдвигает тело от игрока на
     столько единиц (`× unitScale`), с зажимом в границы карты;
     `seriesFactor *= decay`. Окно сдвигается раз в тик в начале
     `stepWorld` — до оружия;
   - `stalkerTouch(world, i)` — касание: урон
     `playerStats.maxHp × touchMaxHpShare` через `damagePlayer` с новым
     необязательным аргументом «мимо брони и сопротивлений» (щит,
     неуязвимость и бессмертие работают как прежде); отброс; затем
     `touchCooldownTicks` и `recoverTicks`.
7. **Отброс игрока.** В `PlayerState` — `knockbackTicks`, `knockbackVx`,
   `knockbackVy`. Пока `knockbackTicks > 0`, `movePlayer` берёт скорость
   отброса вместо ввода (`distance / sec` от преследователя), с теми же
   зажимом в границы и выталкиванием из стражей; после — скорость игрока
   ноль, разгон заново. Снимок игрока в `game/run/snapshot.ts` копирует поля
   целиком; у старого снимка полей нет — ноль, а не ошибка.
8. **Где проходит удар:**
   - `damageEnemy` и `inflictDamage`: у `unkillable` — `pushStalker`, возврат
     0, **до** броска состояния и до перескока молнии. Здоровье не меняется,
     `damageDealt`, `damageByElement`, `damageByWeapon`, журнал охоты не
     растут; `hitTick` ставится — вспышка попадания нужна рендеру;
   - `chainTargets` его пропускает;
   - `detonate` его пропускает;
   - `killEnemy` до него не доходит ни разу — тест;
   - заморозка подбором — как босса.
9. **Касание в `updateEnemies`**: у `unkillable` вместо общей ветки —
   `stalkerTouch`; пока `touchCooldownTicks > 0`, не бьёт; таймеры тела
   тикают раз в тик в `stalker-body.ts`, а не в общем `attackCooldown`.
10. **Потолок, перенос, пик:**
    - `atCap` и цикл в `spawner.ts` считают живых без преследователя
      (`aliveCount − (stalkerBody.slot >= 0 ? 1 : 0)`), пик — тоже;
    - `recycleLostEnemies` его не переносит: дальнее расстояние решает T-0423.
11. **Состояние тела** — в контрольной сумме (`checksum.ts`) и в снимке
    забега (`snapshot.ts`, поле `stalkerBody`, необязательное: у старого
    снимка — пустое состояние). Буфер окна — массивом чисел.
12. **Снимок контента:** `STALKER` входит в `ContentSnapshot` (поле
    `stalker`), в схему `snapshot-schema.ts` и в `CONTENT_HASH`.
    `createWorld` принимает `stalker?: StalkerDef` и кладёт тип врага в
    `world.stalkerBody`; без поля — правил тела нет, `spawnStalker` вернёт −1.
    В `createRunWorld` **не подключать** — это T-0424.
13. **Облик-заглушка:** `ENEMY_LOOKS.stalker = { shape: "triangle", color:
    0x14101c }` с комментарием «временно, облик — T-0425».
14. **Тексты** (ключи нужны тесту гайдбука):
    - `ru.json`: `"enemy.karachun.name": "Карачун"`;
    - `ru-guide.json`:
      - `"guide.pattern.stalker.name": "Неубиваемый"`;
      - `"guide.pattern.stalker.text": "Идёт за тобой ровным шагом. Убить его нельзя: удары только отталкивают, и каждый следующий подряд слабее. Касание снимает треть здоровья и отбрасывает."`;
      - `"guide.pattern.stalker.tip": "Не стой — уходи. Отталкивай, только чтобы выиграть шаг."`.
15. Если сдвинулись golden-эталоны (новый враг меняет `CONTENT_HASH` и длину
    `killsByType`) — обновить в этом же PR и объяснить в описании: в забег
    Карачун ещё не приходит, поэтому длина забегов сдвинуться не должна.

## Чего не трогаем

- Расписание, предвестие, растворение, дальнее расстояние, поток
  случайности, правила боссов и новичка — T-0423.
- `createRunWorld`, боты, коридоры, CLAUDE.md, `docs/32` — T-0424 и T-0422.
- Облик на канве — T-0425; звук и вибрация — T-0426; гайдбук, кодекс и
  аналитика — T-0427.
- Остальные паттерны и их числа.

## Тесты

Первым коммитом. `packages/core-game/test/stalker-body.test.ts` (мир через
`createWorld` с `stalker: STALKER` и врагом из контента, Карачун ставится
`spawnStalker`):

- `spawnStalker` ставит одного; второй вызов при живом — −1; без правил — −1;
- **неубиваемость:** 10 000 урона снарядом, аурой, ударом по площади,
  оберегом и молнией с перескоком — здоровье не изменилось, жив,
  `enemiesKilled`, `killsByType`, `damageDealt`, `xpCollected` — ноль, ни
  кристалла, ни подбора, ни сундука;
- **толчок:** первый удар отодвигает его от игрока на `first` единиц (± 0,01),
  второй подряд — на `first × decay`; после `seriesResetSec` без ударов —
  снова `first`;
- **предел:** 60 тиков ударов каждый тик — суммарный сдвиг не больше
  `maxPerSec` единиц;
- **подходит под огнём:** стоящий игрок, Карачун в 160 единицах, по нему бьют
  каждый тик — касание случилось не позже 6 секунд;
- **касание:** у игрока с бронёй 10 и сопротивлениями 0,5 касание снимает
  `maxHp × 0,33` (± 0,01); отброс — игрок сместился от Карачуна на
  `knockback.distance` (± 2) за `knockback.sec`; ввод в это время не
  действует; в течение `touchCooldownSec` второго касания нет, хотя тела
  касаются; `recoverSec` он стоит;
- щит буста гасит касание целиком; при `invulnerableTicks > 0` урона нет;
- смерть от касания — `deathCauseType` равен индексу типа Карачуна;
- динамит рядом его не трогает; горение и яд не накладываются, бросков
  `world.rng` при ударе стихийным оружием по нему нет (состояние `rng` до и
  после одинаково);
- заморозка подбором держит его столько же, сколько босса;
- потолок живых: при `aliveCount = maxAlive` с живым Карачуном директор
  выпускает ещё одного рядового;
- он не переносится вперёд, как отставший;
- снимок забега с живым Карачуном посреди серии толчков и отброса игрока
  восстанавливается: контрольная сумма совпадает через 300 тиков;
- `findStalkerProblems` ловит каждое правило шага 4, в том числе
  `maxPerSec` больше 0,6 скорости;
- тест контента: враг `stalker` в потоке, в событии `ring` и в смеси кривой —
  ошибка с именем;
- `sim-purity`: новые файлы в `patterns/` и `sim/` без запрещённых функций
  (тест уже обходит каталоги — убедиться, что файлы в списке).

## Аналитика

Нет: событие появления — T-0427 после T-0423.

## Настройки и окружение

Нет.

## Документы

Нет — таблица паттернов в `CLAUDE.md` и `docs/32` дополняются в T-0424,
когда Карачун приходит в забег.

## Критерии приёмки

- [ ] Карачуна нельзя убить ничем: ни одно оружие, перескок, горение, яд и
      динамит не снимают здоровье и не дают убийства, опыта или добычи.
- [ ] Удары отталкивают его от игрока, каждый следующий подряд слабее, за
      60 тиков — не дальше `maxPerSec`; стоящего игрока он достаёт под
      огнём.
- [ ] Касание снимает треть максимума здоровья мимо брони и отбрасывает;
      очередью не бьёт.
- [ ] Числа — в `content/stalker.ts`, проверка называет поле; Карачун не
      может попасть в таймлайн.
- [ ] Снимок и контрольная сумма держат тело и отброс; `world.rng` при ударах
      по нему не тронут.
- [ ] В `createRunWorld` не подключён.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и `pnpm task check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Паттерн неубиваемого преследователя`
- **Метка:** `release: minor`
- **Для игроков:** нет — в забег Карачун приходит в T-0424.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПАТТЕРН НЕУБИВАЕМОГО ПРЕСЛЕДОВАТЕЛЯ**

  В движке появился враг, которого нельзя убить: удары оружия его только отталкивают, каждый следующий слабее и не дальше предела в секунду, а касание снимает треть здоровья и отбрасывает. Это тело Карачуна (Р205); в забег он придёт следующими задачами.
  ```
