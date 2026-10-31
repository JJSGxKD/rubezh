---
id: T-0353
title: Герой в четыре стороны в забеге — спереди при ходе вниз, спиной при ходе вверх
epic: E12
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0239]
zones:
  - packages/core-game/test/art-hero-view.test.ts
shared:
  - packages/core-game/src/game/render/art-atlas.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - design/art/characters.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
merge: lead
design: design/art/characters.md
batch: 4
---

# T-0353. Герой в четыре стороны в забеге — спереди при ходе вниз, спиной при ходе вверх

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0353.json)](README.md#значки-статуса) [![T-0239](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0239.json&label=T-0239)](T-0239-appearance-in-run.md)

Строку значков и ячейку эпика ставит `pnpm task fix`.

## Зачем

В режиме арта герой всегда повёрнут боком: идёт вниз по экрану — а смотрит
вправо. Кадры спереди и спиной уже нарисованы для героя и всех обликов
(`design/art/backlog.md` п. 1). После задачи герой, идущий вниз, повёрнут
лицом к игроку, а идущий вверх — спиной. Бок с зеркалом остаётся для хода
вправо, влево и по диагонали.

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р143: «враги — сбоку с
зеркалом, герой — в 4 стороны». Правила выбора вида — `design/art/characters.md`
§4.1 (`claude-lead-1`, 31.10.2026). Исполнитель их не пересматривает:

- **Только рендер.** Вид выбирается в `art-atlas.ts` по `faceX`/`faceY`
  игрока — единичному вектору последнего движения: он остаётся и на
  остановке, поэтому «стоит — смотрит туда же» получается само. Симуляция,
  снимок забега, хитбокс, `CONTENT_HASH` и golden-эталоны не меняются.
- **Три вида:** `"side" | "front" | "back"`. Ось `y` экрана смотрит вниз:
  `faceY > 0` — ход вниз, вид `front`; `faceY < 0` — ход вверх, вид `back`.
- **Бок — основной вид, вход и выход с гистерезисом по углу:**
  - из `side` в `front`/`back` — когда `|faceY| > 1,5 · |faceX|` (в пределах
    34° от вертикали);
  - из `front`/`back` обратно в `side` — когда `|faceY| ≤ 1,2 · |faceX|`;
  - из `front` в `back` и обратно — по знаку `faceY`, когда вертикальный
    вид остаётся.
- **Без дрожания по времени:** новый вид включается, когда желаемый вид
  держится `HERO_VIEW_HOLD_TICKS = 9` тиков подряд (0,15 с при 60 Гц).
  Желаемый вид сменился раньше — счёт заново. Первый кадр забега — `side`
  без ожидания.
- **Кадры вида** — по `characters.md` §4.1:
  - Хранитель: `hero/front/idle0…1`, `hero/front/walk0…3`, `hero/front/hurt0`;
    так же `hero/back/…`;
  - облик (T-0239): `hero-<id>/front/idle0…1`, `hero-<id>/front/walk0…3`;
    ранения у облика нет — ранение берётся из `hero-<id>/front/idle0`, как
    у бокового вида в T-0239; так же `back`.
- **Неполный вид — бок того же облика**, а не смесь: не хватает хоть одного
  кадра покоя или шага вида — этот вид рисуется боком. Облик посреди забега
  не меняется.
- **Зеркала у `front` и `back` нет:** предмет в руке нарисован на своей
  стороне. Вид `front`/`back` ставит `flipX = false`; при возврате в `side`
  отражение снова считает `faceLeft`, как сейчас.
- **Смерть** — прежние кадры `hero/death*` бока в любом виде.

## Как сейчас

- `packages/core-game/src/game/render/art-atlas.ts`:
  - `buildFrames` (около строки 233) собирает `heroFrames` = `{ idle, walk,
    hurt }` из `hero/idle*`, `hero/walk*`, `hero/hurt0`; после T-0239 имена
    даёт `heroFrameNames(appearance, has)`;
  - `applyHero(sprite, tick, vx, vy, faceX, hurt)` (около строки 334)
    выбирает позу через `heroPose`, кадр шага — `walkFrame(tick, 0)`, кадр
    покоя — `Math.floor(tick / 40)`, отражение — `faceLeft(faceX, 1,
    this.heroLeft)`;
  - чистые функции `isMoving`, `heroPose`, `faceLeft` экспортируются и
    проверяются в `test/art-atlas.test.ts`.
- `WorldRenderer.ts:240` вызывает `this.art.applyHero(this.player, tick,
  hero.vx, hero.vy, hero.faceX, hurt)`; `faceY` у игрока есть
  (`game/sim/world.ts`, `PlayerState.faceY`), но в рендер не передаётся.
- Кадры уже лежат в атласах: `design/art/out/atlas-core.json` —
  `hero/front/*`, `hero/back/*`; `atlas-skin-<id>.json` —
  `hero-<id>/front/*`, `hero-<id>/back/*`. Лист — `design/art/out/sheet-hero.png`.

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **`art-atlas.ts`, чистые функции** (экспорт, рядом с `faceLeft`):
   - `export type HeroView = "side" | "front" | "back";`
   - константы `HERO_VIEW_ENTER = 1.5`, `HERO_VIEW_LEAVE = 1.2`,
     `HERO_VIEW_HOLD_TICKS = 9` с комментарием «почему» по §4.1;
   - `heroViewTarget(faceX: number, faceY: number, current: HeroView): HeroView` — гистерезис по углу из «Решений»;
   - `stepHeroView(state: { view: HeroView; pending: HeroView; held: number }, target: HeroView): void` — счёт тиков: `target === state.view` → `pending = view, held = 0`; иначе копит `held` для `pending` и на `HERO_VIEW_HOLD_TICKS` переключает `view`;
   - `heroViewFrameNames(appearance: string | undefined, view: HeroView, has: (name: string) => boolean)` — имена покоя, шага и ранения вида по правилам «Решений»; неполный вид → имена бока того же облика (вызывает `heroFrameNames` из T-0239).
3. **`art-atlas.ts`, класс:**
   - `heroFrames` — по виду: `Record<HeroView, { idle; walk; hurt }>`, собирается в `buildFrames` через `heroViewFrameNames`;
   - состояние вида — одно поле `heroViewState`, сбрасывается в `side` там же, где `shown`/`lastFrame` (смена режима);
   - `applyHero(…, faceX, faceY, hurt)` — шаг `stepHeroView` раз на вызов, кадры текущего вида, `flipX`: `side` — `faceLeft`, иначе `false`.
4. **`WorldRenderer.ts`** — передать `hero.faceY` в `applyHero`. Больше в
   файле ничего не меняется.
5. **`design/art/characters.md`** §4.1 — в конце строка: «В движке —
   `heroViewTarget` и `stepHeroView` в `render/art-atlas.ts` (T-0353)».

## Чего не трогаем

- Кадры, атласы и `design/art/src/*` — дизайнер.
- Врагов: у них по-прежнему бок с зеркалом (Р143).
- Режим фигур: там героя рисует фигура, вида нет.
- Загрузку атласа облика — это T-0239.
- Симуляцию и `faceX`/`faceY` в `step.ts`.

## Тесты

Первым коммитом, `packages/core-game/test/art-hero-view.test.ts`:

- `heroViewTarget(1, 0, "side")` → `side`; `(0, 1, "side")` → `front`;
  `(0, -1, "side")` → `back`;
- диагональ `(0.707, 0.707, "side")` → `side`;
- порог входа: `(0.5, 0.86, "side")` → `front` (отношение 1,72);
  `(0.6, 0.8, "side")` → `side` (1,33 < 1,5);
- гистерезис: `(0.6, 0.8, "front")` → `front` (1,33 > 1,2);
  `(0.7, 0.71, "front")` → `side` (1,01 ≤ 1,2);
- смена по знаку: `(0, -1, "front")` → `back`;
- `stepHeroView`: желаемый `front` 8 тиков — вид `side`; на 9-м — `front`;
  желаемый `front` 5 тиков, затем `side` 1 тик, затем `front` 8 тиков —
  вид всё ещё `side` (счёт сброшен);
- `heroViewFrameNames(undefined, "front", has)` при всех кадрах →
  `hero/front/idle0…1`, `hero/front/walk0…3`, ранение `hero/front/hurt0`;
- `("vityaz", "back", has)` → `hero-vityaz/back/idle0…1`,
  `hero-vityaz/back/walk0…3`, ранение `hero-vityaz/back/idle0`;
- `("vityaz", "front", has)` без `hero-vityaz/front/walk3` → кадры бока
  Витязя (`hero-vityaz/idle0…`), не Хранителя;
- имена из реального `design/art/out/atlas-core.json`: все
  `hero/front/*` и `hero/back/*` из `heroViewFrameNames` в нём есть
  (так же, как `art-atlas.test.ts` проверяет `hero/idle0`);
- golden-тесты баланса зелёные **без обновления эталона**.

Ручная проверка в режиме арта (`VITE_DEV_TOOLS=1 pnpm dev:telegram`, лист
разработчика → «Вид» → черновой арт): ход вниз — лицом, вверх — спиной,
по диагонали и вбок — боком; остановка держит вид; дёрганье джойстика у
диагонали не мигает видами. Снимок четырёх сторон — в PR.

## Аналитика

Нет: только вид, игрок ничего нового не делает; режим арта уже пишется в
`run_ended.art` (T-0230).

## Настройки и окружение

Нет. Числа порогов — константы рендера рядом с `faceLeft`, в контент не
выносятся: геймдизайнер их не крутит.

## Документы

`design/art/characters.md` §4.1 — по шагу 5.

## Критерии приёмки

- [ ] В режиме арта герой идёт вниз лицом, вверх — спиной, вбок и по
      диагонали — боком с зеркалом; у обликов так же.
- [ ] Вид не мигает у границы 34° и держится на остановке.
- [ ] Неполный вид облика — бок этого облика.
- [ ] Golden-эталон не менялся.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Повернуть героя по направлению хода`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: в новом облике боя герой поворачивается лицом и спиной, когда идёт вниз и вверх`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ГЕРОЙ В ЧЕТЫРЕ СТОРОНЫ**

  В режиме арта герой поворачивается по ходу: вниз — лицом, вверх — спиной, вбок и по диагонали — боком. У обликов так же; баланс и хитбокс прежние.

  🛠 **Где смотреть**

  • выбор вида — `heroViewTarget` и `stepHeroView` в `core-game/src/game/render/art-atlas.ts`
  • правила — `design/art/characters.md` §4.1
  ```
