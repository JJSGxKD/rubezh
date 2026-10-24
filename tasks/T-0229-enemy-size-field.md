---
id: T-0229
title: Поле `size` у врага — радиус крупнее или мельче паттерна
epic: E10
priority: P1
status: in-progress
owner: claude-13 / sonnet-5.5 / high
author: claude-lead-1
size: S
depends_on: []
zones:
  - packages/core-game/src/game/patterns/enemy-types.ts
  - packages/core-game/test/enemy-size.test.ts
shared:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - CLAUDE.md
  - docs/32-balance.md
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0229. Поле `size` у врага — радиус крупнее или мельче паттерна

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0229.json)](README.md#значки-статуса)

## Зачем

Радиус врага сейчас — радиус паттерна × ранг, и контент его не выбирает.
Из-за этого Страж рубежа (T-0120, босс на `rush`) выходит радиусом
6 × 2,4 = 14 единиц — меньше героя, а увалень мал для своего рисунка
(`design/art/registry.md`, A-03 и A-09). После задачи у врага в контенте
есть необязательное поле `size` — множитель радиуса, и геймдизайнер задаёт
размер данными.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р144: радиус =
радиус паттерна × ранг × `size`, коридор 0,7–2,5, не задан — 1; правило
«свободного размера нет» снимается.

Решения `claude-lead-1` от 24.10.2026:

- **`size` — только данными**: эта задача добавляет поле, проверку и учёт в
  движке и рендере, но **ни одному врагу его не ставит** — golden-тесты не
  меняются. Размер Стража задаёт T-0120.
- **Запас запросов к сетке** (`MAX_PATTERN_RADIUS` — его берут шаг снарядов,
  орбита, аура и удар по площади) считается с верхом коридора: радиус
  крупнейшего паттерна × `BOSS_RADIUS_MUL` × 2,5. Запас только расширяет
  выборку кандидатов, попадание по-прежнему решает точное расстояние,
  поэтому исход забегов не меняется — это проверяют golden-тесты.
- **Рендер:** в режиме фигур текстура врага строится по его радиусу —
  `size` учтётся сам. В режиме «Черновой арт» кадр рисуется постоянным
  масштабом атласа — его масштаб умножается на `size` врага, иначе хитбокс
  и рисунок разойдутся.
- **Ошибка в данных** — сообщение теста контента называет врага и поле:
  «враг X: size вне 0,7…2,5».

## Как сейчас

- `packages/shared-types/src/index.ts:590–…` — `EnemyDef`: `threat`, `rank`
  с комментарием «Ранг, а не свободный размер», `resist`, `element`.
- `packages/core-game/src/game/patterns/enemy-types.ts:44–67` —
  `ELITE_RADIUS_MUL`, `BOSS_RADIUS_MUL`, `rankRadiusMul`,
  `MAX_PATTERN_RADIUS`; `:416` — `radius: traits.radius *
  rankRadiusMul(def.rank ?? "normal") * unitScale`; `:244–…` —
  `findEnemyContentProblems` и `findBaseProblems`.
- `MAX_PATTERN_RADIUS` используют `game/sim/step.ts:312`,
  `game/weapons/orbit.ts:106`, `aura.ts:22`, `area-strike.ts:63`.
- `packages/core-game/src/game/render/WorldRenderer.ts:138` — текстура врага
  по `type.radius`; кадры арта — `ArtMode` (`render/art-atlas.ts`) с
  масштабом `art.scale`.
- `CLAUDE.md`, «Как добавить нового врага»: «Свободного размера в контенте
  нет: радиус — свойство поведения, ранг лишь умножает его».

## Шаги по порядку

1. `shared-types` — `size?: number` у `EnemyDef` с комментарием вместо
   абзаца «Ранг, а не свободный размер»: размер — ранг × `size`, коридор, зачем.
2. `enemy-types.ts` — `ENEMY_SIZE_MIN = 0.7`, `ENEMY_SIZE_MAX = 2.5`;
   радиус × `def.size ?? 1`; `MAX_PATTERN_RADIUS` × `ENEMY_SIZE_MAX`;
   проверка коридора в `findBaseProblems`.
3. `WorldRenderer.ts` — масштаб кадра арта врага × `size` типа (множитель
   храни в типе при сборке, а не считай в кадре).
4. Документы: `CLAUDE.md` — абзац о размере («`size` — множитель радиуса,
   0,7–2,5; крупнее — дольше бить и труднее обойти, мельче — легче
   промахнуться») и пример в блоке кода; `docs/32-balance.md` — строка про
   размер в правилах чисел врага; `docs/30-configuration-map.md` — строка
   «Размер врага».

## Чего не трогаем

- Числа врагов в `content/enemies.ts` — `size` никому не ставим.
- Радиусы паттернов и множители рангов.
- Раскладку кольца спавна: проверку `findBoundsProblems` задача не меняет.

## Тесты

Первым коммитом, `packages/core-game/test/enemy-size.test.ts`:

- `size` не задан → радиус как раньше (обычный, элита, босс);
- `size: 2` у босса на `rush` → радиус 6 × 2,4 × 2 × `unitScale`;
- `size: 0.69` и `size: 2.51` → сообщение с id врага и полем;
- `MAX_PATTERN_RADIUS` не меньше радиуса любого врага с `size` из коридора;
- golden-тесты баланса и `content.test.ts` зелёные **без обновления эталона**.

## Аналитика

Не нужна: размер — данные контента, видны в `contentHash`.

## Настройки и окружение

Нет.

## Документы

По шагу 4.

## Критерии приёмки

- [ ] `size` в контенте меняет хитбокс, рисунок фигуры и кадр арта одинаково.
- [ ] Вне коридора — понятная ошибка теста контента.
- [ ] Golden-эталон не менялся.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Поле size у врага`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОЛЕ SIZE У ВРАГА**

  У врага в контенте появилось поле size — множитель радиуса от 0,7 до 2,5: геймдизайнер задаёт размер данными. Ни одному врагу его пока не поставили, баланс не изменился; первым крупнее станет Страж рубежа.
  ```
