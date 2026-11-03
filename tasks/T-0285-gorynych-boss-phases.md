---
id: T-0285
title: Змей Горыныч — босс трёх голов: поле `phases` у босса (свой паттерн и стихия на каждую фазу), головы гаснут по фазам
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0284]
zones:
  - packages/core-game/src/game/run/boss-phases.ts
  - packages/core-game/test/boss-phases.test.ts
shared:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/content/enemies.ts
  - packages/core-game/src/content/waves.ts
  - packages/core-game/src/game/run/boss.ts
  - packages/core-game/src/game/patterns/index.ts
  - packages/core-game/src/game/patterns/behavior.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/step.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/src/game/render/looks.ts
  - packages/core-game/src/game/render/art-atlas.ts
  - packages/core-game/test/**
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/screens/guide/guide-data.ts
  - packages/app-shell/test/**
  - CLAUDE.md
  - docs/32-balance.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
design: design/art/meta-v2.md
batch: 6
---

# T-0285. Змей Горыныч — босс трёх голов: поле `phases` у босса (свой паттерн и стихия на каждую фазу), головы гаснут по фазам

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0285.json)](README.md#значки-статуса) [![T-0284](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0284.json&label=T-0284)](T-0284-leshy-roots.md)

## Зачем

Боссы меняют поведение по фазам (`run/boss.ts`), но в пределах одного
паттерна: кастер бьёт чаще, матрёшка сыплет детьми. Змей Горыныч (Р157) —
босс, у которого каждая голова — своя драка:
- огонь — бьёт по площади издали;
- холод — морозные круги под игроком;
- последняя голова — рывки насквозь.

Голова гаснет, когда фаза пройдена, — полоса здоровья и облик говорят
одно и то же.

После задачи у босса есть поле `phases`: на каждую фазу — свой готовый
паттерн, параметры и стихия. Новых паттернов нет: Горыныч собран из
`caster`, `roots` (T-0284) и `rush`. Следующие такие боссы — только данные.

## Решения

Решение владельца — Р157, `design/art/meta-v2.md` §6.1: Змей Горыныч —
босс, три головы — три фазы: огонь, холод, рывок.

Решения `claude-lead-1` от 25.10.2026 (числа стартовые):

- **Поле `phases`** — только у `rank: "boss"`, ровно `BOSS_PHASES` (3)
  записей:
  `phases: [{ pattern, params?, element?, statusChance? }, …]`.
  - Фаза 0 — первая запись, по `bossPhase(hpRatio)`.
  - `pattern` верхнего уровня у такого врага — паттерн фазы 0, для
    гайдбука и старых мест.
  - Проверка контента:
    - число записей;
    - паттерны — из реализованных, кроме `splitter` и `cordon`;
    - параметры — по схеме своего паттерна;
    - у не-босса `phases` нет.
- **Смена фазы** — `run/boss-phases.ts`. Фаза врага сменилась:
  - состояние паттерна сбрасывается в начальное (таймеры, метки);
  - стихия и шанс состояния — из записи фазы;
  - событие шины `bossPhaseChanged { phase }` — оболочка уже рисует деления
    полосы.

  Обратно фаза не возвращается: лечения у врагов нет.
- **Детерминизм** — паттерны берут случайность так же, как без `phases`;
  фаза — в снимке как производная здоровья, отдельного поля не нужно.
- **Змей Горыныч** `boss_gorynych`:
  - `{ hp: 2400, speed: 50, damage: 22, xp: 160, rank: "boss", size: 2.2 }`;
  - `resist: { fire: 0.5, cold: 0.3, lightning: -0.4 }` — две стойкости и
    уязвимость: огонь и холод — его головы.
  - `phases`:
    1. `caster`, `element: "fire"`, `params: { castIntervalSec: 3.5, burstCount: 10, preferredDistance: 260 }`;
    2. `roots`, `element: "cold"`, `params: { castIntervalSec: 3, rootRadius: 90, telegraphSec: 0.9, rootSec: 0.8 }` — холодный круг, урон и холод;
    3. `rush`, `params: { leadSec: 0.4, runSec: 1.2 }`.
  - Только событием:
    - в `ENDLESS_CURVE` — `{ everySegments: 9, kind: "ring", enemy: "boss_gorynych", count: 1 }`;
    - первое появление — не раньше 900 с.

  Пока жив Страж рубежа (T-0120), боссы не приходят — правило уже есть.
- **Облик:**
  - три головы на теле; фаза пройдена — голова гаснет (тускнеет и опускается);
  - тон текущей головы — стихия фазы;
  - третья фаза — тон опасности.

  Без арта — фигура босса плюс три круга-головы (`looks.ts`).
- **Кадры арта** готовы (31.10.2026): `boss_gorynych/s<фаза>/walk<k>`, фаза
  0…2, в паке `atlas-r157` (`design/art/src/creatures.mjs`, `gorynych`). У
  босса ступеней нет, поэтому номер «ступени» кадра здесь — фаза: в первой
  горят три головы, дальше пройденные гаснут и опускаются, текущая светится
  тоном стихии. В `art-atlas.ts` кадры врага с `phases` берутся по фазе
  (`enemyFrameName(id, phase, k)`), у остальных боссов — `s0`, как сейчас.
  Пак `atlas-r157` движок ещё не грузит: первая из задач T-0281…T-0285
  добавляет в `ATLASES` (`render/art-atlas.ts`) строку `art-r157` по образцу
  `art-late`, остальные её уже застают.
  Облик Горыныча — и для промо.
- **Тексты:**
  - `enemy.boss_gorynych.name` — «Змей Горыныч»;
  - гайдбук: «Три головы — три боя: огонь издали, холод под ногами, последняя
    — рывки насквозь».

## Как сейчас

- **Фазы босса** — `game/run/boss.ts`:
  - `BOSS_PHASES = 3`;
  - `bossPhase(hpRatio)` — пороги 0,66 и 0,33;
  - `bossPhaseOf`;
  - полоса — `buildBossSnapshot`.
- **Паттерны** — `patterns/caster.ts`, `patterns/rush.ts`, после T-0284 —
  `patterns/roots.ts`; реестр — `patterns/index.ts`; состояние врага —
  `patterns/behavior.ts`.
- **Боссы в контенте** — `boss_seer`, `boss_matryoshka`; события —
  `content/waves.ts:179–180`.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Тип** — `phases` в `EnemyDef`; проверка контента.
3. **`run/boss-phases.ts`** — смена паттерна и стихии по фазе; вызов в
   `step.ts`.
4. **Шина** — `bossPhaseChanged`.
5. **Облик** — головы.
6. **Данные** — Горыныч, событие, тексты, гайдбук.
7. **Эталоны** — обновить, `pnpm balance:sim` до и после.
8. **Документы:**
   - `CLAUDE.md` — абзац «Босс из фаз» в «Как добавить врага» с примером;
   - `docs/32` — строка Горыныча.

## Чего не трогаем

- Пороги фаз `bossPhase`.
- Поведение боссов без `phases`.

## Тесты

Первым коммитом, `boss-phases.test.ts`:
- здоровье ниже 0,66 → паттерн фазы 1, состояние паттерна сброшено,
  стихия — холод;
- ниже 0,33 → `rush`; обратно не возвращается;
- событие `bossPhaseChanged` — по разу на переход;
- босс без `phases` ведёт себя как раньше (эталоны боссов не сдвигаются,
  кроме сдвига от нового события в кривой);
- снимок в фазе 1 → восстановление → тот же паттерн и ход.
- Тест контента:
  - `phases` из двух записей → ошибка с именем;
  - `phases` у элиты → ошибка;
  - `splitter` в фазе → ошибка.

## Аналитика

Нет новых событий: убийство босса уже в итоге (`bossKills`, T-0125).

## Настройки и окружение

Нет.

## Документы

По шагу 8.

## Критерии приёмки

- [ ] Змей Горыныч приходит событием после 900 с: огонь издали, холодные круги, рывки; головы гаснут по фазам.
- [ ] Поле `phases` у босса — данными, из готовых паттернов, с проверкой контента.
- [ ] Детерминизм и снимок сохранены; эталоны обновлены с замером.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Змей Горыныч — босс трёх фаз`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: босс Змей Горыныч — три головы, три боя`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗМЕЙ ГОРЫНЫЧ**

  Новый босс Змей Горыныч: огонь издали, морозные круги под ногами и рывки насквозь — по голове на фазу, головы гаснут вместе с полосой. Боссы из фаз теперь собираются данными из готовых паттернов.
  ```
