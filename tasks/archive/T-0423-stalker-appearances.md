---
id: T-0423
title: Появления Карачуна — предвестие, погоня, растворение, свой поток случайности
epic: E10
priority: P1
status: done
owner: claude-lead-1 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: [T-0421]
zones:
  - packages/core-game/src/game/sim/stalker.ts
  - packages/core-game/src/content/stalker.ts
  - packages/core-game/test/stalker.test.ts
shared:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/game/sim/stalker-body.ts
  - packages/core-game/src/game/patterns/stalker.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/sim/step.ts
  - packages/core-game/src/game/sim/rng.ts
  - packages/core-game/src/game/sim/events.ts
  - packages/core-game/src/game/sim/checksum.ts
  - packages/core-game/src/game/sim/continue.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/content-problems.ts
  - packages/core-game/src/content/snapshot.ts
  - packages/core-game/src/content/snapshot-schema.ts
  - packages/core-game/src/content/hash.ts
  - packages/core-game/test/**
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: design/art/concepts/stalker/README.md
batch: 4
---

# T-0423. Появления Карачуна — предвестие, погоня, растворение, свой поток случайности

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0423.json)](../README.md#значки-статуса) [![T-0421](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0421.json&label=T-0421)](T-0421-stalker-pattern.md)

## Зачем

Тело Карачуна есть (T-0421), но выйти на поле ему некому. Эта задача — его
директор: с 4-й минуты в случайный момент и с случайной стороны на земле
проступает иней, через полторы секунды выходит Карачун, преследует 10–20
секунд и растворяется, а к поздним минутам приходит чаще (Р205). Здесь же —
правила, когда он не приходит: новичок, босс, строй стражей, разлом. В
забег директор подключает T-0424.

## Решения

- **Р205** (`docs/35-stage4-plan.md`, 10.11.2026), в том числе решения
  тимлида в той же строке: порог новичка, боссы, строй, тайники.
- **Случайность — свой поток** `deriveSeed(seed, STREAM_SALT.stalker)`.
  `world.rng` директор не трогает ни разу — как сундуки, тайники и рубеж.
- **Поток тратится одинаково при любой игре:** первая отметка бросается при
  создании мира; направление и длина погони — в начале предвестия;
  пауза — в конце появления. Блокировка (босс, строй) бросков не добавляет:
  директор просто ждёт.
- **Предвестие обязательно** — и перед первым выходом, и перед «возник
  ближе»: игрок всегда видит, откуда он выйдет (решение тимлида).
- **Точка выхода — на виду**: на расстоянии `appearDistance` от игрока,
  которое помещается в половину короткой стороны видимой области стоящей
  камеры на самом узком экране. Иначе предвестие ушло бы за край.
- **Отсчёт погони идёт и во время повторного предвестия**: убежать от
  Карачуна нельзя, но можно дотянуть до конца его времени (решение тимлида).
- **Растворение** (`fadeSec`): он стоит, не бьёт и не толкается, потом
  исчезает. Так конец погони виден, а не «пропал на месте».
- **Второй шанс** убирает его вместе со всеми, следующее предвестие — не
  раньше обычной паузы от момента продолжения.
- Числа — стартовые, калибровка — T-0424.

## Как сейчас

- Тело: `game/sim/stalker-body.ts` (T-0421) — `spawnStalker`,
  `despawnStalker`, `world.stalkerBody.slot`, `pushStalker`, `stalkerTouch`.
  Правила — `STALKER` в `content/stalker.ts`, тип `StalkerDef` в
  `shared-types`.
- Образец поэтапного состояния со своим потоком — рубеж:
  `game/sim/rubezh.ts` (`createRubezhState`, `stepRubezh`), соль —
  `STREAM_SALT` в `game/sim/rng.ts`, поток создаётся в
  `create-world.ts` (строка ~374).
- Образец журнала для оболочки — `world.cordon.ended` (`game/sim/cordon.ts`):
  сцена раздаёт его в шину, `MainScene.ts` строка ~813.
- Направление — `randomDirection(rng, out)` в `game/sim/directions.ts`.
- Строй стражей — `world.cordon.active`; осада стоящего (T-0392) ставит тот
  же строй.
- Разлом — `site.kind === "rift" && site.opened` в `game/sim/secrets.ts`
  (строка ~90); `closeOpenRifts` — там же.
- Боссы — `isBoss(type)`; Страж рубежа — тоже `rank: "boss"`.
- Второй шанс — `applyContinue` в `game/sim/continue.ts`.
- Признаки новичка, которые видит движок: пролог — `world.prologue !== null`;
  обучающий забег — сложность `easy` (`world.difficultyLevel.id`,
  `app-shell/src/state/difficulty.ts` → `difficultyForNextRun`); уровень
  аккаунта — `world.runLoadout.accountLevel` (тот же признак включает
  подстройку, `isPressureActive` в `game/sim/pressure.ts`).
- Видимая область: `viewAreaIdle` и `maxAspect` камеры карты
  (`content/maps.ts`); радиус кольца спавна — `spawnRadiusUnits` в
  `game/sim/map-types.ts`.

## Шаги по порядку

1. Тесты первым коммитом (раздел «Тесты»).
2. **Данные.** В `StalkerDef` — поле `appear`, в `content/stalker.ts`:

   ```ts
   appear: {
     fromSec: 240,                         // с 4-й минуты
     firstDelaySec: { min: 0, max: 60 },   // первое предвестие — в случайный момент 4-й минуты
     gapSec: { min: 70, max: 110 },        // пауза от конца появления до следующего предвестия — на fromSec
     lateGapSec: { min: 35, max: 55 },     // она же на lateAtSec и дальше; между — линейно
     lateAtSec: 900,
     chaseSec: { min: 10, max: 20 },
     omenSec: 1.5,
     fadeSec: 0.6,
     appearDistance: 150,                  // от игрока, единиц: на виду и у узкого экрана
     farDistance: 340,                     // дальше — растворяется и возникает ближе
     minAccountLevel: 4,                   // ниже — новичок, Карачуна нет
   },
   ```

3. **Проверка** — в `findStalkerProblems` (сообщение называет поле):
   - `fromSec ≥ 0`; у пар `min ≤ max`; `firstDelaySec.min ≥ 0`;
   - `gapSec` и `lateGapSec` от 10 до 600; `lateGapSec.min ≤ gapSec.min` и
     `lateGapSec.max ≤ gapSec.max` (позже — не реже); `lateAtSec > fromSec`;
   - `chaseSec` от 3 до 60; `omenSec` от 0,5 до 3; `fadeSec` от 0,2 до 2;
   - `appearDistance ≥ 100` и `appearDistance + радиус тела ≤
     0,5 × √(viewAreaIdle / maxAspect)` у каждой карты контента (проверка в
     `content-problems.ts`, где карты под рукой);
   - `farDistance ≥ appearDistance + 100` и не больше радиуса кольца спавна;
   - `minAccountLevel` — целое от 1 до максимального уровня аккаунта.
4. **Соль** `STREAM_SALT.stalker` в `game/sim/rng.ts` — новое 32-битное
   число, не совпадающее с прежними (например, `0x5354414c`, «STAL»).
5. **Состояние** `world.stalker` в `game/sim/stalker.ts`:

   ```ts
   export type StalkerPhase = "off" | "waiting" | "omen" | "chase" | "fading";
   export interface StalkerState {
     rng: Rng;
     phase: StalkerPhase;
     /** тик, с которого можно начинать предвестие (в фазе waiting) */
     nextOmenTick: number;
     /** точка выхода и тики до конца фазы omen или fading */
     x: number; y: number;
     phaseTicks: number;
     /** тики погони, оставшиеся у этого появления; идут и в повторном предвестии */
     chaseTicks: number;
     /** номер появления в забеге с нуля и счётчики текущего — для аналитики */
     index: number; hits: number; pushes: number; relocations: number; appearedTick: number;
     /** журнал законченных появлений для сцены; в снимок не входит */
     ended: StalkerEnd[];
   }
   export interface StalkerEnd {
     index: number; outcome: "faded" | "cut" | "died";
     hits: number; pushes: number; relocations: number; lifeSec: number; elapsedSec: number;
   }
   ```

   Счётчики `hits` и `pushes` прибавляют `stalkerTouch` и `pushStalker`
   (правка `stalker-body.ts`: касание, дошедшее до игрока, и толчок с
   ненулевым сдвигом).
6. **Создание.** `createWorld` создаёт `world.stalker` из правил
   (`stalker?: StalkerDef`, T-0421). Фаза `off`, если правил нет, или
   `world.prologue !== null`, или сложность `easy`, или `accountLevel`
   задан и меньше `minAccountLevel`. Иначе — `waiting`, `nextOmenTick` =
   `(fromSec + rng.nextRange(firstDelaySec))` в тиках. Забег без уровня
   (стенд, боты, разработчик) идёт с Карачуном.
7. **Шаг** `stepStalker(world)` — из `stepWorld` после `updateCordon` и до
   перестроения сетки (вышедший Карачун попадает в сетку того же тика):
   - **waiting:** тик дошёл до `nextOmenTick`, игрок жив, нет живого босса,
     `world.cordon.active` ложно, нет открытого разлома — бросок направления
     и `chaseSec`; точка = игрок + направление × `appearDistance × unitScale`,
     зажатая в границы карты; фаза `omen` на `omenSec`; событие
     `SIM_EVENT.stalkerOmen` (`x`, `y`, в `radius` — `omenSec`). Нельзя
     начать — ждёт следующего тика, ничего не бросая;
   - **omen:** тики вниз; `chaseTicks` тоже идут вниз, если это повторное
     предвестие; кончилось — `spawnStalker` в точке (пул полон — повтор на
     следующем тике), фаза `chase`, `appearedTick` при первом выходе,
     событие `SIM_EVENT.stalkerAppear`. Если у повторного предвестия
     `chaseTicks` дошли до нуля — появление кончается исходом `faded` без
     выхода;
   - **chase:** `chaseTicks` вниз; Карачун дальше `farDistance` —
     `despawnStalker`, новая точка на `appearDistance` по тому же лучу от
     игрока, где он был, фаза `omen`, `relocations++`, событие `stalkerOmen`
     (бросков нет); `chaseTicks` кончились — фаза `fading` на `fadeSec`,
     событие `SIM_EVENT.stalkerFade`;
   - **fading:** Карачун стоит (`patterns/stalker.ts` читает фазу), касания и толчков нет;
     конец — `despawnStalker`, запись в `ended` исходом `faded`, пауза
     `gap` (линейно между `gapSec` и `lateGapSec` по секунде забега, бросок
     `nextRange`), фаза `waiting`;
   - **строй встал** при `omen`, `chase` или `fading` — сразу `despawnStalker`,
     исход `cut`, пауза и `waiting`;
   - **игрок погиб** при `omen`, `chase` или `fading` — исход `died`, фаза
     `waiting` с паузой от этого тика; тело убирает второй шанс или конец
     забега.
   Во время `omen` и до выхода тела директор не мешает толпе: точка — только
   координаты.
8. **Второй шанс** — в `applyContinue`: `despawnStalker`, если появление шло
   — оно уже записано как `died`; `nextOmenTick` не раньше
   `тик продолжения + gap`.
9. **Снимок и контрольная сумма.** В `game/run/snapshot.ts` — поле
   `stalker` (поток, фаза, все числа шага 5, кроме `ended`); у старого снимка
   поля нет — фаза по правилам шага 6 от секунды снимка, как у нового мира с
   уже прошедшей первой отметкой: `nextOmenTick` — текущий тик плюс пауза
   (решение тимлида: старые снимки не должны вываливать Карачуна сразу).
   Контрольная сумма (`checksum.ts`) складывает фазу, тики, точку, счётчики и
   состояние потока.
10. **События мира** — в `game/sim/events.ts`: `stalkerOmen: 11`,
    `stalkerAppear: 12`, `stalkerFade: 13`, с комментариями, что несёт
    `radius`. Номера проверить по текущему файлу — если 11–13 заняты
    осадой (T-0392), взять следующие свободные.
11. В `createRunWorld` **не подключать** — T-0424.

## Чего не трогаем

- Тело, толчки и касание — T-0421 (только счётчики в `stalker-body.ts`).
- `createRunWorld`, шину сцены (`MainScene.ts`, `run-api.ts`), боты,
  коридоры, golden, `CLAUDE.md`, `docs/32` — T-0424.
- Облик, предвестие на канве — T-0425; звук — T-0426; аналитика — T-0427.

## Тесты

`packages/core-game/test/stalker.test.ts`. Мир — `createWorld` с правилами
`STALKER`, директора спавна нет (враги ставятся руками там, где нужны):

- до `fromSec` — ни предвестия, ни Карачуна, сколько ни идёт забег;
- первое предвестие — между `fromSec` и `fromSec + firstDelaySec.max`; через
  `omenSec` выходит Карачун в точке предвестия, на расстоянии
  `appearDistance` (± 1) от игрока;
- погоня длится от `chaseSec.min` до `chaseSec.max`, потом `fadeSec`
  растворения, потом его нет;
- на 1000 seed: направление первого выхода покрывает все четыре четверти
  круга (с каждой стороны), средняя пауза на 5-й минуте больше средней на
  15-й;
- одновременно — не больше одного Карачуна за 20 минут забега;
- **оттолкнули далеко:** Карачун переставлен на `farDistance + 10` — он
  исчез, предвестие на `appearDistance` по тому же лучу, `relocations = 1`,
  отсчёт погони не сбросился;
- **босс:** живой босс в отметку — предвестия нет, пока он жив; убит —
  предвестие на следующем тике; босс, вышедший во время погони, её не
  обрывает;
- **строй:** `world.cordon.active` в отметку — предвестия нет; строй встал во
  время погони — Карачуна нет на этом же тике, в журнале исход `cut`;
- **разлом:** открытый разлом не даёт начать появление;
- **новичок:** фаза `off` в прологе, на сложности `easy`, при `accountLevel`
  3; при `accountLevel` 4 и без уровня — `waiting`;
- **поток:** два мира с одним seed, у одного правила преследователя, у
  другого нет, без директора спавна и без оружия — состояние `world.rng`
  одинаково через 20 минут; поток преследователя не зависит от того,
  блокировал ли его босс (броски те же, сдвинуты только моменты);
- **журнал:** исходы `faded`, `cut`, `died` с верными `hits`, `pushes`,
  `relocations`, `lifeSec`;
- **второй шанс:** смерть во время погони — исход `died`; после
  `applyContinue` Карачуна нет, следующее предвестие не раньше паузы от
  продолжения;
- **снимок:** снимок в каждой фазе (`waiting`, `omen`, `chase`, `fading`)
  восстанавливается, контрольная сумма совпадает через 600 тиков; снимок без
  поля `stalker` читается, Карачун не выходит раньше паузы;
- `findStalkerProblems` — каждое правило шага 3; на нынешней карте
  `appearDistance` 160 с телом 16 не проходит, 150 — проходит;
- `sim-purity` — `game/sim/stalker.ts` без запрещённых функций и без
  обращений к `world.rng` (по образцу проверки `chests.ts` и `secrets.ts`).

## Аналитика

Журнал `world.stalker.ended` — основа события `stalker_ended`; словарь и
отправка — T-0427, шина — T-0424.

## Настройки и окружение

Нет.

## Документы

Нет — правила в `CLAUDE.md` и `docs/32` пишет T-0424, когда Карачун приходит
в забег.

## Критерии приёмки

- [ ] С 4-й минуты Карачун приходит в случайный момент с случайной стороны,
      за `omenSec` до выхода — предвестие в точке выхода; погоня 10–20 с,
      растворение; к поздним минутам паузы короче.
- [ ] Оттолкнутый далеко — растворяется и после предвестия возникает ближе.
- [ ] Не начинает появление при живом боссе, стоящем строе и открытом
      разломе; строй, вставший в погоне, растворяет его.
- [ ] Нет в прологе, на «Лёгкой» и ниже `minAccountLevel`.
- [ ] Свой поток случайности, `world.rng` не тронут; снимок и контрольная
      сумма держат все фазы; второй шанс убирает его.
- [ ] Гейт (`CLAUDE.md`), `pnpm docs:check` и `pnpm task check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Появления Карачуна — предвестие и погоня`
- **Метка:** `release: minor`
- **Для игроков:** нет — в забег Карачун приходит в T-0424.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОЯВЛЕНИЯ КАРАЧУНА**

  У неубиваемого преследователя появился свой директор: с 4-й минуты в случайный момент и с случайной стороны — предвестие, через полторы секунды Карачун, погоня 10–20 секунд и растворение; к поздним минутам — чаще. Не приходит новичку, при живом боссе, в строю стражей и при открытом разломе. Случайность — свой поток, снимок забега его хранит. В забег подключается следующей задачей.
  ```
