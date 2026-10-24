---
id: T-0119
title: Модификаторы забега «Спешка» и «Инверсия»: данные и движок
epic: E10
priority: P1
status: ready
owner:
author: claude-lead2-19
size: M
depends_on: [T-0108, T-0192, T-0193, T-0194, T-0195, T-0196, T-0198]
zones:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/content/modifiers.ts
  - packages/core-game/src/content/unlocks.ts
  - packages/core-game/src/content/hash.ts
  - packages/core-game/src/content/balance-targets.ts
  - packages/core-game/src/game/sim/difficulty.ts
  - packages/core-game/src/game/sim/gems.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/run-world.ts
  - packages/core-game/src/game/progression/unlocks.ts
  - packages/core-game/src/game/balance/simulate.ts
  - packages/core-game/src/game/run/run-result.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/game/diagnostics/replay.ts
  - packages/core-game/src/game/diagnostics/run-recorder.ts
  - packages/core-game/src/engine/run-engine.ts
  - packages/core-game/src/index.ts
  - packages/core-game/test/**
  - scripts/balance/balance-sim.ts
shared:
  - packages/app-shell/src/i18n/ru.json
  - docs/30-configuration-map.md
  - docs/32-balance.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0119. Модификаторы забега «Спешка» и «Инверсия»: данные и движок

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0119.json)](README.md#значки-статуса) [![T-0108](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0108.json&label=T-0108)](T-0108-unlock-ladder.md) [![T-0192](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0192.json&label=T-0192)](T-0192-pressure-after-minute-8.md) [![T-0193](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0193.json&label=T-0193)](T-0193-longer-run-progression.md) [![T-0194](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0194.json&label=T-0194)](T-0194-limit-break-offers.md) [![T-0195](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0195.json&label=T-0195)](T-0195-player-power-pressure-engine.md) [![T-0196](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0196.json&label=T-0196)](T-0196-player-power-pressure-wiring.md) [![T-0198](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0198.json&label=T-0198)](T-0198-remove-enemy-projectile-code.md)

## Зачем

Тот, кто прошёл всё оружие, видит одну и ту же карту с теми же тремя уровнями
сложности. Модификатор делает старую карту новой: игрок сам берёт на себя
условие и получает за него награду. Решение Р105, `docs/39-retention-mechanics.md`
Б8. Эта задача — данные и движок: что меняет модификатор, как он попадает в мир,
снимок и повтор, на каком уровне открывается. Проверка и награда на сервере —
T-0122, выбор в листе «Перед забегом» — T-0123; три задачи едут одной пачкой.

## Решения

**Поправка `claude-lead-1` от 20.10.2026 (Р126, единая сложность).** Модификаторы ложатся поверх единой сложности `hard`; формулы и примеры с «Лёгкой» и «Нормальной» пересчитываются от `hard`. Множители `hard` меняет T-0192 — брать их из влитого контента, а не из этой спецификации.

Исполнитель их не пересматривает. Числа стартовые, **геймдизайнер калибрует**.

1. **Один модификатор на забег** (`MAX_MODIFIERS_PER_RUN = 1`): «Спешка» и
   «Инверсия» тянут нагрузку в разные стороны, вместе они бессмысленны. В данных
   забега это массив из нуля или одного id: потолок потом поднимается без смены формата.
2. **Модификатор — данные**: `content/modifiers.ts`, список `RUN_MODIFIERS`. Множители
   ложатся поверх выбранной сложности **умножением** по тем же четырём осям, что в
   `content/difficulty.ts`, плюс новая ось `xpMul`. id — в `shared-types`
   (`RUN_MODIFIER_IDS = ["hurry", "inverse"]`), как `DIFFICULTY_IDS`.

   | Модификатор | Здоровье | Урон | Темп спавна | Потолок живых | `xpMul` | Награда за забег |
   |---|---|---|---|---|---|---|
   | `hurry` «Спешка» | ×1,0 | ×1,1 | ×1,5 | ×1,25 | ×1,5 | ×1,25 |
   | `inverse` «Инверсия» | ×2,0 | ×1,3 | ×0,6 | ×0,7 | ×1,6 | ×1,25 |

   «Спешка» — больше врагов и быстрее уровни. «Инверсия» — орда наоборот: врагов
   мало, но они крепкие и бьют больно; общий запас здоровья орды выше базы (×1,2),
   поэтому награда за неё не меньше.
3. **Два разных «опыта».** `xpMul` — опыт **внутри забега**: сумма кристаллов за
   убитого врага равна `round(xp · xpMul)`, инвариант «сумма равна xp» из `CLAUDE.md`
   сохраняется с этой поправкой. Награда **за забег** (монеты и опыт аккаунта) — отдельный
   множитель, его таблица `RUN_MODIFIER_REWARD_MUL` лежит в `shared-types`: один
   источник для сервера (T-0122) и для подписи в листе (T-0123). Движок её не читает.
4. **Открытие уровнем аккаунта:** `hurry` — 9-й уровень, `inverse` — 12-й. Это пустые
   уровни лестницы T-0108 (8→9→11→12→14→16), промежутки не больше трёх.
   `AccountUnlockDef` получает необязательное `modifiers: string[]`; каждый модификатор
   открывается ровно на одном уровне, как оружие и навыки; стартовый набор не меняется.
5. **Движок остаётся детерминированным.** Модификатор — часть `RunWorldOptions`, снимка,
   записи и повтора: разойдись они хоть в одном параметре мира, повтор честного забега
   показал бы «дефект детерминизма». В отпечаток контента (`hash.ts`) попадают
   `RUN_MODIFIERS`. Округление — `Math.round`, степеней и тригонометрии нет
   (`sim-purity.test.ts`).
6. **Тексты** (`ru.json`): `modifier.hurry.name` — «Спешка», `.description` — «Врагов на
   полтора раза больше и они чуть злее, зато опыт в бою растёт быстрее.»;
   `modifier.inverse.name` — «Инверсия», `.description` — «Врагов меньше, но они вдвое
   крепче и бьют больнее. Опыт в бою растёт быстрее.»

## Как сейчас

- `shared-types/src/index.ts:1049-1061` — `DifficultyDef`; `RunLoadout` (874),
  `AccountUnlockDef` и `RunResult` без модификаторов.
- `content/difficulty.ts` — три уровня; `game/sim/difficulty.ts` — `BASE_DIFFICULTY`
  и `findDifficultyContentProblems` (образец проверок).
- `run-world.ts:46` — `findDifficulty(options.difficultyId)`; `balance/simulate.ts:64` — то же;
  оба кладут `difficulty` в мир.
- `game/sim/gems.ts` — горсть кристаллов из `xp` убитого врага; множитель нужен здесь.
- `run/run-result.ts:39` — `difficultyId: world.difficultyLevel.id`.
- `content/hash.ts` — состав отпечатка контента; `progression/unlocks.ts` — `unlocksAt`
  и `findUnlockProblems` (T-0108 поддерживает лестницу).

## Шаги по порядку

1. Тесты — первым коммитом (раздел «Тесты»).
2. `shared-types`: `RUN_MODIFIER_IDS`, `RunModifierId`, `RunModifierDef`,
   `RUN_MODIFIER_REWARD_MUL` (с комментарием «почему здесь»), `modifiers?` у
   `AccountUnlockDef`, `modifierIds?` у `RunResult` и снимка.
3. Данные: `content/modifiers.ts` и `findModifierProblems` (id из списка, без повторов, все
   числа конечны и > 0, хотя бы одна ось ≠ 1, `здоровье · темп ≥ 1`, `xpMul ≥ 1`),
   ключи в `ru.json`, `hash.ts`, строки `hurry` на 9 и `inverse` на 12 в `unlocks.ts`.
4. Движок: `composeDifficulty(base, modifierIds)` в `sim/difficulty.ts` — умножает оси,
   `id` остаётся базовым; `gems.ts` — `xpMul`; `RunWorldOptions.modifierIds`, `create-world`,
   `simulate`, `run-engine`, снимок, запись и повтор несут его; без поля — забег без
   модификатора, старые снимки и записи читаются. `unlocksAt` отдаёт множество открытых
   модификаторов; `findUnlockProblems` их проверяет.
5. Коридор `BALANCE_TARGETS.modifierMedianRatio` (стартово `hurry` 0,5–0,95 от медианы
   «Лёгкой», `inverse` 0,6–1,3) и строки модификаторов в `balance-sim.ts`.
6. Эталоны (без модификатора не двигаются), документы, гейт.

## Чего не трогаем

- Три уровня сложности и их числа; серверную `DIFFICULTY_REWARD_MUL`.
- Сервер, миграции, вердикт, награду (T-0122) и оболочку, лист «Перед забегом» (T-0123).
- Лестницу оружия и навыков, кроме двух новых строк.

## Тесты

Первым коммитом. Новые: `modifiers.test.ts`; правки: `content.test.ts`,
`account-unlocks.test.ts`, `gem-drops.test.ts`, `determinism.test.ts`, `run-snapshot.test.ts`,
`run-recording.test.ts`, `run-summary.test.ts`, `balance-properties.test.ts`, `sim-purity.test.ts`.

- `findModifierProblems(RUN_MODIFIERS)` → `[]`; негативы на синтетических записях:
  ноль, NaN, повтор id, id вне списка, модификатор без отличий, `здоровье · темп < 1`,
  `xpMul < 1`; ключи имени и описания есть в `ru.json`.
- `composeDifficulty`: «Лёгкая» + `hurry` — оси из таблицы; «Сложная» + `inverse` —
  произведения; без модификатора значения равны базе; `id` остаётся базовым.
- `gems`: за врага с `xp: 10` и `xpMul 1,5` сумма кристаллов 15; на 50 seed инвариант
  «сумма равна round(xp · xpMul)» держится; без модификатора поведение прежнее.
- **Эталоны:** сценарные суммы без модификатора совпадают с прежними (`determinism`);
  два мира с одним seed и `hurry` дают одну сумму; снимок с модификатором
  восстанавливается с той же суммой, старый снимок без поля читается; повтор записи
  с модификатором совпадает с оригиналом; `RunResult.modifierIds` заполнен.
- Лестница: `unlocksAt` на 8 уровне без модификаторов, на 9 — `hurry`, на 12 — оба;
  каждый открыт ровно на одном уровне; промежутки между открытиями ≤ 3; на уровне 1
  множество пусто.
- Коридор: медиана уклоняющегося бота с каждым модификатором в `modifierMedianRatio`;
  вне коридора правятся множители таблицы, а не коридор; `pnpm balance:sim` печатает строки.
- `sim-purity.test.ts` проходит на изменённых файлах.

## Аналитика

Нет: движок событий не отправляет. Поле `modifier` в событиях забега заведёт T-0122
(сначала словарь), отправит T-0123.

## Настройки и окружение

Нет: ключей каталога настроек и переменных окружения не заводим. Числа
модификаторов — контент, множители награды — `shared-types`.

## Документы

- `docs/32-balance.md` — раздел «Модификаторы забега» (таблица, коридор, свод
  калибровки); `docs/30-configuration-map.md` — строки «Модификаторы (контент)» и
  «Награда модификаторов».
- `CLAUDE.md`, после «Как добавить буст» — абзац «Как добавить модификатор забега»:
  запись в `content/modifiers.ts`, id и множитель награды в `shared-types`, строка в
  `unlocks.ts`, пределы вердикта (T-0122).

## Вопросы к тимлиду

- Принято по умолчанию (подтверждено claude-lead-1 13.10.2026 по умолчанию): один
  модификатор на забег; уровни 9 и 12; награда ×1,25 у обоих.
- Принято по умолчанию (подтверждено claude-lead-1 13.10.2026 по умолчанию): задача
  режется на движок (эта), сервер (T-0122) и оболочку (T-0123): целиком выходит за размер M.

## Критерии приёмки

- [ ] `composeDifficulty` и `xpMul` дают множители из таблицы; без модификатора эталоны
  и суммы сценариев не изменились.
- [ ] Модификатор несут мир, снимок, запись, повтор и `RunResult`; старые данные читаются.
- [ ] `hurry` открыт с 9-го уровня, `inverse` — с 12-го; тест лестницы зелёный.
- [ ] Коридоры зелёные, `pnpm balance:sim` показывает модификаторы отдельными строками.
- [ ] Дифф только в зонах и в строках из «Документы»; гейт (`CLAUDE.md`) и
  `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Добавить модификаторы забега Спешка и Инверсия`
- **Метка:** `release: minor`
- **Для игроков:** нет. Лист «Перед забегом» и награду делают T-0122 и T-0123 той же
  пачкой; раздела `## Для игроков` в описании PR нет.
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — МОДИФИКАТОРЫ ЗАБЕГА: ДВИЖОК И ДАННЫЕ**

  В движке появились модификаторы «Спешка» и «Инверсия»: множители поверх сложности и ускоренный опыт в бою. Выбор в листе и награда — в следующих задачах пачки.

  🛠 **Движок**

  • модификатор несут мир, снимок, запись и повтор; старые снимки читаются
  • «Спешка» открывается на 9-м уровне аккаунта, «Инверсия» — на 12-м
  • эталоны без модификатора не изменились

  ❓ **Нужно от команды**

  • @владелец — откалибровать множители и коридор по данным теста
  ```
