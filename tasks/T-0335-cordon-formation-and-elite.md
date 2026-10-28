---
id: T-0335
title: Кольцо стражей — строй сразу со вспышкой, элита и босс внутри (движок)
epic: E10
priority: P1
status: in-progress
owner: claude-13 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: [T-0172]
zones:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/game/sim/cordon.ts
  - packages/core-game/src/game/sim/checksum.ts
  - packages/core-game/src/game/sim/step.ts
  - packages/core-game/src/game/sim/timeline-content.ts
  - packages/core-game/src/game/patterns/cordon.ts
  - packages/core-game/src/game/patterns/index.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/src/game/render/telegraphs.ts
  - packages/core-game/test/cordon.test.ts
  - packages/core-game/test/cordon-player.test.ts
  - packages/core-game/test/cordon-content.test.ts
  - packages/core-game/test/cordon-formation.test.ts
  - packages/core-game/test/cordon-inner.test.ts
  - packages/core-game/test/run-snapshot.test.ts
  - packages/core-game/test/determinism.test.ts
  - packages/core-game/test/helpers/scripted-run.ts
shared:
  - docs/35-stage4-plan.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0335. Кольцо стражей — строй сразу со вспышкой, элита и босс внутри (движок)

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0335.json)](README.md#значки-статуса) [![T-0172](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0172.json&label=T-0172)](archive/T-0172-remove-shooting-enemies.md)

## Зачем

Сейчас стражи кольца появляются на краю экрана и идут к строю 12–14 секунд, а
кольцо за это время уже сжимается: строй выходит редким, а элита и босс не
успевают попасть внутрь. Игрок, по замеру владельца, видит не «плотное кольцо»,
а ручеёк стражей. После задачи стражи встают на радиусе кольца **сразу**, со
вспышкой-телеграфом, а внутри строя может появиться элита или босс. Числа
кольца и здоровье стража — отдельная задача T-0342.

## Решения

- **Р166** (`docs/35-stage4-plan.md`, строка Р166): стражи встают сразу на кольце
  со вспышкой-телеграфом; вместе с кольцом — элита внутри строя, на поздних
  кольцах — босс, с телеграфом. «Движок кольца — код участника 1, числа —
  данные»: в этой задаче только движок, проверки и тесты, **контент
  (`content/*`) не меняется**.
- **Р112** — само кольцо (события, сжатие, исходы) остаётся как есть.
- **Р164 / Р171:** `depends_on: [T-0172]` — после него список боссов без
  `boss_seer`, остаётся `boss_matryoshka`. Пересечение зон с PR на ревью (T-0192
  правит `content.test.ts`, `waves.ts`) захват не блокирует: кто вливается
  вторым, перебазируется.
- Решения тимлида по деталям (исполнитель их не пересматривает):
  - формирование строя — **0,8 с**, появление внутренних — **1,0 с** после
    старта кольца;
  - внутренние враги не считаются стражами: кольцо кончается по стражам, как
    раньше; пережившие кольцо элита и босс остаются на поле;
  - «босс на поздних кольцах» задаётся **данными**: у записи `inner` есть
    необязательное `fromSec` — с какой секунды забега запись действует.

## Как сейчас

- `packages/core-game/src/game/sim/cordon.ts`
  - `startCordon(world, typeIndex, count, ring)` (стр. ~90): берёт случайный
    поворот `randomRingOffset(world.rng)`, для каждого `k` берёт направление
    `ringDirection(offset, k, count, direction)` и ставит стража через
    `spawnOnRing(...)` — то есть на **радиусе спавна** (`world.config.view.spawnRadius`
    ≈ 566 + разброс 0–48 из `world.rng`), вне экрана. Фаза `CORDON_PHASE.arriving`,
    `enemies.dirX/dirY` = направление.
  - `CordonState` (стр. ~35): `active, centerX, centerY, radius, minRadius,
    shrinkPerSec, timeLeftSec, ringsStarted, startedAtSec, guards, ended`.
  - `updateCordon` сжимает радиус и кончает кольцо (`endCordon`: `broken` когда
    живых стражей нет, `held` по времени — оставшиеся стражи исчезают
    `despawnEnemy`). Стражи определяются как `type.anchored`.
  - `pushPlayerOutOfGuards` выталкивает игрока из тел с `type.solid`.
- `game/patterns/cordon.ts`: `CORDON_PHASE = { arriving: 0, holding: 1 }`;
  `update` ведёт стража к месту `centerX + dirX·radius` на его скорости; фаза
  `holding` ближе 4 единиц к месту.
- `game/sim/step.ts` (стр. ~195–245): общий цикл врагов; после `applyPattern`
  идёт `if (!type.contactDamage) continue;` и удар касанием.
- `shared-types/src/index.ts` (стр. ~744): `CordonRingDef { radius, minRadius,
  shrinkPerSec, lifeSec }`; комментарий к `radius` говорит «меньше расстояния
  спавна, чтобы приходили снаружи экрана».
- `game/sim/timeline-content.ts`: `findRingProblems` (стр. ~132) — проверка
  границ кольца; `CORDON_MAX_RADIUS = 420` с сообщением «стражи обязаны
  приходить снаружи экрана».
- `game/sim/checksum.ts` (стр. ~51): в контрольную сумму активного кольца входят
  `centerX/Y, radius, timeLeftSec` (смотри, что ещё).
- `game/run/snapshot.ts`: `capturedCordon` / `restoreCordon` (стр. ~147–185):
  отсутствие поля в старом снимке читается как «значение по умолчанию» (версию
  формата не поднимали).
- Телеграфы: `game/render/telegraphs.ts` (`ring(x, y, radius, progress)`,
  `lane`, `aim`; спрайты раздаются каждый кадр между `begin()` и `end()`),
  вызываются из цикла по врагам в `WorldRenderer.ts` (стр. ~445–465) под
  `telegraphsOn`.
- Тесты, описывающие приход «снаружи»: `test/cordon.test.ts` («приход стражей»,
  `arrivalSec`), `cordon-content.test.ts`, `helpers/scripted-run.ts`
  (`CORDON_RING`, `GUARD`, `createCordonRun`).

## Шаги по порядку

Тесты — первым коммитом (раздел «Тесты»), дальше по шагам. Весь код — без
`Math.random`, `Date.now` и запрещённых `Math.*` (`sim-purity.test.ts`):
расстояния через `vectorLength`, направления через `ringDirection`.

1. **Тип** — `packages/shared-types/src/index.ts`. В `CordonRingDef` добавь:
   ```ts
   /** Кто появляется внутри строя с телеграфом: элита и босс, не стражи. */
   inner?: CordonInnerDef[];
   ```
   и новый тип рядом:
   ```ts
   export interface CordonInnerDef {
     /** id элиты или босса из контента */
     enemy: string;
     /** сколько их, от 1 до 4 */
     count: number;
     /** с какой секунды забега запись действует; не задано — с любой */
     fromSec?: number;
   }
   ```
   Поправь комментарий к `radius`: теперь это «на каком расстоянии от центра
   стражи встают в строй сразу».

2. **Фаза формирования** — `game/patterns/cordon.ts`.
   - `CORDON_PHASE = { arriving: 0, holding: 1, forming: 2 }`.
   - Экспортируй `CORDON_FORM_SEC = 0.8` (секунды вспышки) рядом с `CORDON_PHASE`.
   - В `update`: если `enemies.phase[index] === CORDON_PHASE.forming` — стоит
     (`stopEnemy`), `enemies.phaseTimer[index] -= dtSec`; когда таймер ≤ 0,
     фаза переходит в `holding` (дальше обычный путь с расчётом места). Кольцо
     неактивно — как раньше, страховка `stopEnemy`.
   - `CORDON_FORM_SEC` реэкспортируй через `patterns/index.ts` рядом с
     `CORDON_PHASE`.

3. **Строй сразу** — `game/sim/cordon.ts`, `startCordon`.
   - Радиус кольца в состоянии: `state.radius = ring.radius * scale` (как
     сейчас) — задай до расстановки.
   - Стража ставь **не** `spawnOnRing`, а `spawnEnemy(world, typeIndex, x, y)`
     (импорт из `./world`), где `x = clampToBounds(world.player.x + direction.x * radius, bounds.halfWidth - type.radius)`,
     `y` — по оси Y так же. Центр кольца — позиция игрока в этот тик, как и
     сейчас. Направление — `ringDirection(offset, k, count, direction)`.
   - Фаза `CORDON_PHASE.forming`, `enemies.phaseTimer[slot] = CORDON_FORM_SEC`,
     `dirX/dirY` — направление (место в строю то же, что и раньше).
   - Убери ставший ненужным импорт `spawnOnRing`. Разброс радиуса
     (`SPAWN_JITTER_UNITS`) для строя не нужен: строй ровный.
   - Порядок вызовов `world.rng` для стражей: только `randomRingOffset` — один
     вызов, как сейчас. Дальше, **только если** у кольца есть годные `inner`,
     второй `randomRingOffset(world.rng)` для внутренних (шаг 5).
   - Если стражей не поместилось ни одного — кольца нет, как сейчас.

4. **Формирующийся страж не бьёт и не толкает.**
   - `game/sim/step.ts`: перед ударом касанием добавь
     `if (type.anchored && enemies.phase[i] === CORDON_PHASE.forming) continue;`
     (импорт `CORDON_PHASE` из `../patterns`). Тело не толкает и не кусает, пока
     вспышка не погасла.
   - `pushPlayerOutOfGuards` (`sim/cordon.ts`): `if (enemies.phase[i] === CORDON_PHASE.forming) continue;`
     сразу после проверки `type.solid`.
   - Заморозка (`isFrozen`, `isTimeFrozen`) стоит над паттерном: таймер
     формирования во время заморозки не идёт — это нормально, не обходи.

5. **Внутри строя** — `game/sim/cordon.ts`.
   - В `CordonState` добавь:
     ```ts
     /** внутренние враги, ждущие своего появления: место уже выбрано, тип известен */
     pending: CordonPending[];
     /** сколько секунд до их появления */
     pendingLeftSec: number;
     ```
     `export interface CordonPending { typeIndex: number; x: number; y: number }`.
     `createCordonState()` — `pending: []`, `pendingLeftSec: 0`.
   - Константы в файле: `CORDON_INNER_SEC = 1` (телеграф до появления) и
     `CORDON_INNER_RADIUS_MUL = 0.5` (место — на половине радиуса кольца от
     центра).
   - В `startCordon` после расстановки стражей (и только если `spawned > 0`):
     отбери записи `ring.inner`, у которых `fromSec === undefined ||
     world.stats.elapsedSec >= fromSec`; id → `typeIndex` через
     `world.enemyTypes.findIndex((t) => t.id === id)` (нет в мире — запись
     пропускается, без исключения). Если записи остались: один
     `randomRingOffset(world.rng)`; все враги всех записей считаются одним
     списком по порядку записей, `n` — их общее число; k-му даётся
     `ringDirection(offset, k, n, direction)` и место
     `player.x + direction.x * radius * CORDON_INNER_RADIUS_MUL` (то же по Y,
     с `clampToBounds` как у стражей). Положи в `state.pending`;
     `state.pendingLeftSec = CORDON_INNER_SEC`.
   - Назначь `state.pending = []` и `pendingLeftSec = 0` на каждом старте
     кольца до заполнения (не оставляй хвост от прошлого).
   - В `updateCordon` после `settleCordonDeath` (до сжатия): если
     `state.pending.length > 0` — `state.pendingLeftSec -= dtSec`; при ≤ 0
     каждый элемент появляется через `spawnEnemy(world, p.typeIndex, p.x, p.y)`
     (слот не нашёлся — молча пропустить), список очищается.
   - `endCordon` очищает `pending` (кольцо кончилось — невышедшие не появятся)
     и `pendingLeftSec = 0`.
   - Вышедшие внутренние враги **не** стражи (`anchored: false`), кольцо их не
     считает; `held` их не убирает.
   - Внутренний появляется со своим обычным поведением и ступенью (`spawnEnemy`
     сам решает ступень: элите она не выдаётся).

6. **Контрольная сумма** — `game/sim/checksum.ts`: в блок активного кольца
   добавь `pending.length`, а для каждого элемента `typeIndex`, `x`, `y`, и
   `pendingLeftSec`. Не добавляй ничего вне `if (world.cordon.active)`.

7. **Снимок** — `game/run/snapshot.ts`.
   - `capturedCordon` — добавь `pending` (копия массива объектов) и
     `pendingLeftSec`.
   - `restoreCordon`: `pendingLeftSec` — `raw.pendingLeftSec === undefined ? 0 : asNumber(...)`;
     `pending` — `raw.pending === undefined ? [] : asArray(raw.pending, "cordon.pending").map(...)`,
     у элемента `typeIndex` через `asIndex(value, world.enemyTypes.length, ...)`
     и числа `x`, `y` через `asNumber`. Версию формата **не поднимать**:
     снимок без поля читается как «никого не ждём».
   - Формирующийся страж в снимке — обычный враг с фазой `2` и `phaseTimer`;
     проверь, что `phase`/`phaseTimer` уже сохраняются (если нет — добавь).

8. **Проверка контента** — `game/sim/timeline-content.ts`.
   - `findRingProblems(ring, where, guard)` — добавь аргумент перечня врагов
     (`enemyById`) и проверь `ring.inner` (если задан):
     - массив длиной 1–4;
     - `enemy` есть в контенте и у него `rank` `"elite"` или `"boss"`, и
       паттерн не `cordon`;
     - `count` — целое 1–4; суммарно по записи кольца не больше 6;
     - `fromSec`, если задан, — число не меньше 0.
     Сообщения — по образцу соседних, с `where`: `«отрезок на 60s: ring.inner[0]
     — враг elite_x не элита и не босс»`.
   - Сообщение к `CORDON_MAX_RADIUS`: вместо «стражи обязаны приходить снаружи
     экрана» — «строй должен целиком помещаться в карту». Число 420 не менять.
   - Пройди и `findCurveProblems`: событие кривой проверяется той же функцией.

9. **Телеграф** — `game/render/telegraphs.ts` и `WorldRenderer.ts`.
   - В `Telegraphs` добавь метод `flash(x, y, radius, progress)`: один спрайт
     из `RING_KEY`, масштаб растёт от 0,4 до 1 от `radius`, `alpha` падает с
     0,9 до 0 по `progress` (`clamp01`). Один спрайт на вспышку — в строю
     десятки стражей, три спрайта на каждого раздули бы пул.
   - В цикле по врагам `WorldRenderer.ts` под `telegraphsOn`: если
     `type.anchored && enemies.phase[i] === CORDON_PHASE.forming` —
     `this.telegraphs.flash(x, y, type.radius * 2.4, 1 - enemies.phaseTimer[i] / CORDON_FORM_SEC)`.
   - После цикла, до `this.telegraphs.end()`: для каждого элемента
     `world.cordon.pending` (если `world.cordon.active`) —
     `this.telegraphs.ring(p.x, p.y, radiusOf(p.typeIndex) * 2.2, 1 - world.cordon.pendingLeftSec / CORDON_INNER_SEC)`,
     где радиус — `world.enemyTypes[p.typeIndex].radius`. Константы импортируй
     из `sim/cordon.ts` и `patterns`.
   - Рендер на исход забега не влияет; обе вспышки идут под существующий
     переключатель телеграфов — новый не заводить («Настройки не отстают»,
     `CLAUDE.md`): вспышки — часть чтения боя, при выключенных телеграфах
     стражи те же, только без кольца.

10. **Эталоны.** Расстановка стражей изменилась (нет разброса спавна, другой
    набор вызовов `world.rng`), поэтому сдвинулись эталоны, где в прогоне есть
    кольцо (прогон ≥ 180 с). Запусти `pnpm --filter @bh/core-game test` и
    обнови эталоны **только** там, где расхождение объясняется кольцом
    (`determinism.test.ts` и golden-проверки; ожидаемо также `balance-bot`,
    `spawn-director`). В описании PR перечисли, какие эталоны и насколько
    сдвинулись.

11. **Документация.** `docs/35-stage4-plan.md` — в строке Р166 в конце добавь
    «Движок: T-0335 (строй сразу, `ring.inner`), числа: T-0342». Больше
    документов эта задача не трогает: гайдбук — T-0342.

## Чего не трогаем

- Числа кольца в `content/waves.ts`, здоровье стража в `content/enemies.ts`,
  `content.test.ts`, гайдбук (`ru-guide.json`) — это **T-0342**. В этой задаче
  `ring.inner` в контент не добавляется: проверки и тесты идут на фикстурах.
- `content/stages.ts`, `content/difficulty.ts`, `balance-targets.ts` — T-0192.
- Поведение стражей после формирования (`holding`, сжатие, исходы
  `broken/held/died`), аналитика `ring_ended` — как есть.
- Звуки и вибрация кольца — отдельно, не добавлять.
- Версия формата снимка — не поднимается.
- Столкновения «враг—враг» не вводим: стражи по-прежнему не толкают других
  врагов.
- Пропускать или не пропускать внутренних врагов сквозь строй — не меняем:
  внутренний появляется уже внутри.

## Тесты

Пишутся первым коммитом, до кода. Хелперы: `createCordonRun`, `stepRun`,
`advanceRun`, `aliveGuards`, `CORDON_RING` (`test/helpers/scripted-run.ts`).
Для внутренних врагов в `helpers/scripted-run.ts` добавь `ELITE: EnemyDef`
(`id: "elite_test", rank: "elite", pattern: "chase", hp: 50, speed: 30,
damage: 1, xp: 1, threat: 1`) и `BOSS` с `rank: "boss"`; в `createCordonRun`
опция `enemies` для добавления в мир.

- `test/cordon-formation.test.ts` (новый):
  - после одного шага все 40 стражей на расстоянии `radius ± 1` от центра, не
    на радиусе спавна;
  - сразу после старта фаза `forming`, `phaseTimer` ≈ `CORDON_FORM_SEC`;
  - игрок, стоящий на расстоянии `radius` от центра (ставится руками на тот
    самый радиус перед стартом), за время формирования не выталкивается и не
    получает урон; после `CORDON_FORM_SEC + 0.1` с страж уже `holding`, и
    выталкивание работает (`cordon-player.test.ts` — те же кейсы без ожидания
    прихода, поправь);
  - через `CORDON_FORM_SEC + 0.1` с все 40 в фазе `holding`;
  - замороженный на старте страж остаётся `forming`, пока заморожен;
  - карта с границами (`map` с `halfWidth`) и игрок у стены: ни NaN, все
    стражи внутри карты;
  - один seed — одна контрольная сумма (дважды), другой seed — другая.
- `test/cordon.test.ts` — поправить «приход стражей»: «снаружи» заменить на
  «на радиусе кольца», `arrivalSec` удалить; «все стражи доходят» заменить на
  «стражи стоят на местах сразу»; остальное (сжатие, конец, одно кольцо за раз,
  потолок пула, заморозка, карта с границей) не должно ломаться.
- `test/cordon-inner.test.ts` (новый):
  - кольцо с `inner: [{ enemy: "elite_test", count: 1 }]`: сразу после старта
    `world.cordon.pending` длины 1, элиты в мире нет; через `CORDON_INNER_SEC`
    плюс тик элита есть, на расстоянии `radius * 0.5 ± 1` от центра; `pending`
    пуст;
  - `count: 3` — три элиты на разных направлениях (попарные расстояния между
    ними больше нуля);
  - `fromSec: 600` при `elapsedSec = 0` — запись пропущена, `pending` пуст,
    второго `randomRingOffset` нет (контрольная сумма кольца без `inner`
    совпадает с суммой кольца с `inner`, пропущенным по `fromSec`); при
    `elapsedSec = 600` — действует;
  - кольцо кончилось (`held`) до появления внутренних: `pending` очищен,
    элита не появилась;
  - появившаяся элита не считается стражем: убиты все стражи — кольцо
    `broken`, элита жива;
  - `held` по времени: стражи исчезли, внутренние выжили;
  - слотов нет (пул на число стражей): внутренний не появляется, исключения
    нет;
  - `inner` с неизвестным id — пропущен без ошибки.
- `test/cordon-content.test.ts` — к существующим добавить кейсы `ring.inner`:
  годное — без замечаний; пустой массив; пять записей; враг без ранга; враг
  паттерна `cordon`; неизвестный id; `count: 0`, `count: 5`; суммарно больше
  шести; отрицательное `fromSec`; сообщение содержит `inner`, отрезок и поле.
  Кейс «radius не больше 420» ищет новую формулировку «помещаться в карту».
- `test/run-snapshot.test.ts` — снимок посреди формирования (через 0,3 с после
  старта) и посреди ожидания внутренних (через 0,5 с): восстановленный мир
  через 5 с совпадает по контрольной сумме с невосстановленным; снимок без
  полей `pending`/`pendingLeftSec` (как до задачи) читается, `pending` пуст.
- `test/determinism.test.ts` — эталоны с кольцом обновлены (шаг 10).
- `sim-purity.test.ts` остаётся зелёным без правок.

## Аналитика

Нет. `ring_ended` (`docs/22-analytics-and-metrics.md` §3.3) не меняется: исходы
и поля те же; внутренние враги в `guards` и `killed` не входят.

## Настройки и окружение

Нет. Константы формирования (`CORDON_FORM_SEC`, `CORDON_INNER_SEC`,
`CORDON_INNER_RADIUS_MUL`) — в коде, как и остальные константы кольца;
калибровка числа кольца — T-0342.

## Документы

- `docs/35-stage4-plan.md`, строка Р166 — отметка о задачах (шаг 11).

## Критерии приёмки

- [ ] Страж сразу после старта кольца стоит на радиусе кольца, фаза `forming`
      на `CORDON_FORM_SEC`; в это время не бьёт и не толкает игрока.
- [ ] `spawnOnRing` в `sim/cordon.ts` не используется; случайность — только из
      `world.rng`, без `Math.random`/`Date.now`/запрещённой математики
      (`sim-purity.test.ts` зелёный).
- [ ] `ring.inner` проверяется в `findTimelineProblems`, сообщения называют
      отрезок и поле.
- [ ] Внутренние враги появляются через `CORDON_INNER_SEC` на `0.5·radius`,
      не считаются стражами, переживают конец кольца; `fromSec` работает.
- [ ] Снимок посреди формирования и ожидания восстанавливается; старый снимок
      читается.
- [ ] Две вспышки (`flash`, `ring`) рисуются под переключателем телеграфов,
      спрайтов — по одному на стража.
- [ ] Эталоны сдвинуты только там, где в прогоне есть кольцо; список — в PR.
- [ ] Контент (`content/*`) и гайдбук не тронуты.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Кольцо стражей встаёт сразу, внутри элита`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: кольцо стражей смыкается сразу со вспышкой, а не подходит с края экрана`
- **Сводка для команды** — перенеси блок в описание PR как есть и впиши номер PR:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — КОЛЬЦО СТРАЖЕЙ ВСТАЁТ СРАЗУ, ВНУТРИ ЭЛИТА**

  Стражи кольца появляются сразу на радиусе кольца со вспышкой, а не идут с края экрана; в кольце может появиться элита или босс. Числа кольца и здоровье стража — следующей задачей T-0342.

  🛠 **Движок**

  • строй: фаза «формируется» 0,8 с, без урона и выталкивания
  • поле `ring.inner` в событии кольца: элита и босс внутри, с телеграфом, `fromSec` — с какой секунды
  • снимок забега читает старые сохранения без новых полей

  🧪 **Эталоны**

  • сдвинулись golden-прогоны с кольцом (список — в описании PR)
  ```
