---
id: T-0281
title: Новый контент, данные — враг Ледяной дух и оружие Кистень с эволюцией «Круговерть» на готовых паттерне и поведении
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0120]
zones:
  - packages/core-game/test/new-content-wave1.test.ts
shared:
  - packages/app-shell/src/screens/game-glyphs.tsx
  - packages/core-game/src/game/render/art-atlas.ts
  - packages/core-game/src/content/enemies.ts
  - packages/core-game/src/content/waves.ts
  - packages/core-game/src/content/weapons.ts
  - packages/core-game/src/content/unlocks.ts
  - packages/core-game/src/game/render/looks.ts
  - packages/core-game/test/**
  - packages/app-shell/src/i18n/ru.json
  - packages/app-shell/src/screens/item-icons.tsx
  - packages/app-shell/src/audio/recipes.ts
  - packages/app-shell/test/**
  - backend/api/src/modules/tasks/task-rules.ts
  - docs/32-balance.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/art/meta-v2.md
batch: 6
---

# T-0281. Новый контент, данные — враг Ледяной дух и оружие Кистень с эволюцией «Круговерть» на готовых паттерне и поведении

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0281.json)](README.md#значки-статуса) [![T-0120](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0120.json&label=T-0120)](T-0120-rubezh-guard-engine.md)

## Зачем

Новый контент дизайнера (Р157) по мотивам славянской нечисти. Двум из
новинок не нужен новый код:
- **Ледяной дух** — враг на готовом паттерне `orbit` с холодом в касании;
- **Кистень** — оружие на готовом поведении `orbit`: один тяжёлый груз на
  цепи бьёт сильно и редко.

После задачи они в игре, в гайдбуке и в лестнице открытий. Остальные
новинки — T-0282–T-0290.

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р157,
`design/art/meta-v2.md` §6.1–6.2: числа и тексты — данные геймдизайнера,
врагов-стрелков нет (Р69).

Решения `claude-lead-1` от 25.10.2026 (числа стартовые, геймдизайнер
калибрует):

- **Ледяной дух** `ice_spirit`:
  - `{ hp: 22, speed: 90, damage: 6, xp: 4, threat: 4, pattern: "orbit" }`;
  - `element: "cold"`, `statusChance: 0.35`;
  - `resist: { cold: 0.5, fire: -0.5 }` — пара по правилу `docs/32` §2.5;
  - `params: { orbitRadius: 150, shrinkPerSec: 10 }`.

  Отличается от ворон (`circler_crow`): медленнее, крепче, кольцо шире и
  сужается мягко, каждое касание морозит.
- **Таймлайн** — `waves.ts`:
  - в первом ручном отрезке после 240 с — один отрезок, где дух идёт отдельно
    (`perSec: 0.5`, `burst: 4`);
  - потом — в пул `ENDLESS_CURVE`.

  Бюджет угрозы не убывает; если отрезка с местом нет — новый отрезок с
  числами, проходящими тест контента.
- **Кистень** `flail`, поведение `orbit`, стихии нет:
  - уровни 1…5:
    `{ damage: 34, cooldownSec: 1.6, projectiles: 1, areaRadius: 72, projectileSpeed: 260 }` →
    `{ damage: 60, cooldownSec: 1.2, projectiles: 1, areaRadius: 88, projectileSpeed: 300 }`;
  - числа между — по возрастанию, у каждого уровня меняется хотя бы одно
    заметное число.

  Карточка покажет «урон 34 → 40».
- **Эволюция** «Круговерть» `whirl` — у дизайнера «Вихрь», но «Вихрь клинков»
  уже есть, два «вихря» на карточках спутаются:
  - `evolvedFrom: "flail"`, `recipe: { passive: "might" }` — «Мощь» (`might`) ещё не
    рецепт ни одной эволюции, а навыки рецептов не повторяются
    (`evolutions-content.test.ts`); счётчик пар по категориям в тесте
    обновляется;
  - один уровень `{ damage: 90, cooldownSec: 1.0, projectiles: 2, areaRadius: 100, projectileSpeed: 340 }`;
  - сила в коридоре `EVOLUTION_POWER_RATIO`. Не прошла — числа правятся до коридора, в PR — замер.
- **Открытие** — `unlocks.ts`: Кистень на уровне 18 (новая строка). Последний
  уровень лестницы — тот, где открыто всё, слоты равны `LOADOUT_LIMITS`.
- **Тексты** `ru.json`:
  - `enemy.ice_spirit.name` — «Ледяной дух»;
  - `weapon.flail.name` — «Кистень»;
  - `weapon.flail.description` — «Груз на цепи кружит рядом и бьёт редко, но тяжело»;
  - `weapon.whirl.name` — «Круговерть»;
  - `weapon.whirl.description` — «Два кистеня крест-накрест».
- **Облик на канве** — без арта:
  - дух — форма и цвет по `looks.ts` в тоне холода;
  - кистень — объект орбиты крупнее камня-оберега.

  Кадры арта готовы (31.10.2026): `ice_spirit/s<ступень>/walk<k>` в паке
  `atlas-r157`, рисунок — `design/art/src/creatures.mjs` (`iceSpirit`). Движок
  берёт их сам по `id`, как у остальных врагов. Кадры кистеня — следующим
  PR дизайнера (пункт 16 очереди).
  Пак `atlas-r157` движок ещё не грузит: первая из задач T-0281…T-0285
  добавляет в `ATLASES` (`render/art-atlas.ts`) строку `art-r157` по образцу
  `art-late`, остальные её уже застают.
- **Значок оружия** готов (п. 5 очереди дизайнера): `flail` и `whirl` из
  `PLANNED_WEAPON_GLYPHS` (`screens/game-glyphs.tsx`) переезжают в
  `WEAPON_GLYPHS` — тест значков требует этого, как только оружие в контенте.
- **Звук** — удар кистеня: рецепт в `audio/recipes.ts` — глухой тяжёлый
  удар, не громче удара оберега (`docs/31`).
- **Задания** — если у задания с фильтром оружия есть список id
  (`tasks/task-rules.ts`), туда — `flail`.

## Как сейчас

- **Враги** — `content/enemies.ts`: образец — `circler_crow` (орбита) и
  `dasher_wolf` (холод, `resist`).
- **Оружие** — `content/weapons.ts`:
  - `wardstone` (`orbit`, строки 67–77);
  - эволюция `frost_crown` (207–216).
- **Открытия** — `content/unlocks.ts`, строки 30–38; последняя — уровень 16.
- **Процедура** — `CLAUDE.md`, «Как добавить врага», «Как добавить оружие»;
  скилл `add-content`.

## Шаги по порядку

1. **Тест первым коммитом** — `new-content-wave1.test.ts`:
   - дух и кистень в контенте;
   - эволюция в коридоре;
   - кистень открыт на 18.
2. **Данные** — враг, таймлайн, оружие, эволюция, открытие.
3. **Тексты, значок, облик, звук.**
4. **Эталоны** — golden-тесты обновляются в том же PR; в описании —
   `pnpm balance:sim` до и после.
5. **`docs/32`** — строки духа и кистеня в своде.

## Чего не трогаем

- Код паттернов и поведений.
- Остальной новый контент — T-0282–T-0290.

## Тесты

Первым коммитом — шаг 1. Плюс существующие тесты контента и гайдбука
должны пройти с новыми записями.

## Аналитика

Нет новых событий: убийства и оружие уже в итоге забега.

## Настройки и окружение

Нет.

## Документы

`docs/32` — по шагу 5.

## Критерии приёмки

- [ ] Ледяной дух приходит отдельно, потом в смеси; касание морозит.
- [ ] Кистень открывается на 18-м уровне, эволюционирует в «Круговерть».
- [ ] Гайдбук, значок, звук и тексты на месте; эталоны обновлены с замером.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Ледяной дух и Кистень`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: враг Ледяной дух и оружие Кистень с эволюцией «Круговерть»`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЛЕДЯНОЙ ДУХ И КИСТЕНЬ**

  Новый контент: Ледяной дух — кружит широким кольцом и морозит касанием; Кистень — тяжёлый груз на цепи, открывается на 18-м уровне, эволюция «Круговерть». Числа стартовые, геймдизайнер калибрует.
  ```
