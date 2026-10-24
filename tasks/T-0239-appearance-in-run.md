---
id: T-0239
title: Облик в забеге — герой кадрами выбранного облика из атласа skins в режиме арта
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: S
depends_on: [T-0238, T-0229, T-0230]
zones:
  - packages/core-game/test/art-appearance.test.ts
shared:
  - packages/core-game/src/run-api.ts
  - packages/core-game/src/game/render/art-atlas.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/app-shell/src/state/graphics.ts
  - packages/app-shell/src/state/run.ts
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: medium
release: minor
design: design/art/characters.md
batch: 4
---

# T-0239. Облик в забеге — герой кадрами выбранного облика из атласа skins в режиме арта

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0239.json)](README.md#значки-статуса) [![T-0238](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0238.json&label=T-0238)](T-0238-appearance-shell.md) [![T-0229](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0229.json&label=T-0229)](archive/T-0229-enemy-size-field.md) [![T-0230](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0230.json&label=T-0230)](T-0230-draft-art-testers-flag.md)

## Зачем

Игрок надел Витязя (T-0238), а в забеге с артом бежит прежний Хранитель:
кадры остальных обликов лежат в атласе `skins`, но движок их не грузит.
После задачи в режиме арта герой в забеге — выбранный облик. Атлас `skins`
качается, только когда облик не Хранитель.

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р150: облик — архетип целиком,
пропорции и хитбокс у всех одни; облик виден и в забеге.

Решения `claude-lead-1` от 24.10.2026:

- **Только вид:** облик передаётся в забег опцией рендера, а не опцией
  симуляции. Хитбокс, числа и `CONTENT_HASH` не меняются, golden-тесты — без
  обновления эталона.
- **`RunGraphicsOptions.appearance?: string`** — id облика (T-0237). Пусто,
  `keeper` или неизвестный id — кадры `hero/…` атласа `core`, как сейчас.
- **Атлас `skins`** (`design/art/out/atlas-skins.png/json`) — в `ATLASES` с
  отдельным ключом, но грузится **по требованию**: при включении арта и
  облике не `keeper`. Хранитель его не качает.
- **Кадры:** `hero-<id>/idle0…1` и `hero-<id>/walk0…3`. Кадра ранения у
  обликов нет, поэтому ранение — кадр покоя облика с той же вспышкой, что у
  Хранителя. Не хватает хоть одного кадра — весь облик Хранителя, а не смесь.
- **Фигуры не меняются:** в режиме фигур облика нет — герой прежний.
- **Оболочка** передаёт действующий облик (`effective` из
  `appearance-api`, T-0238) в `runGraphics()`.

## Как сейчас

- `packages/core-game/src/game/render/art-atlas.ts:35–50` — `ATLASES`:
  `art-core`, `art-late`, `ART_ENV_KEY`; `:205–222` — `buildFrames` берёт
  `hero/idle*`, `hero/walk*`, `hero/hurt0`.
- `run-api.ts` — `RunGraphicsOptions`; после T-0230 там `art: boolean`.
- `WorldRenderer.ts` — `this.art.setWanted(…)`.
- `state/graphics.ts` — `runGraphics()` (T-0230: `art`).
- Кадры обликов: `frost`, `gilded`, `herbalist`, `knyaz`, `navi`,
  `ohotnitsa`, `skomoroh`, `vedunya`, `vityaz` — по шесть на облик.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **`run-api.ts`** — `appearance?: string` в `RunGraphicsOptions` с
   комментарием «только вид».
3. **`art-atlas.ts`:**
   - атлас `skins` с загрузкой по требованию;
   - чистая функция `heroFrameNames(appearance, has: (name) => boolean)` → имена кадров покоя, шага и ранения или кадры `hero/…`, если облика нет целиком;
   - `buildFrames` берёт кадры по ней.
4. **`WorldRenderer.ts`** — облик из опций рендера в `art-atlas.ts`.
5. **`graphics.ts` и `run.ts`** — `appearance` из `appearance-api` в опции
   забега.
6. **`docs/27`** §3.5 — строка про пак `skins`: грузится только при облике.

## Чего не трогаем

- Кадры и атлас — дизайнер (`design/art/backlog.md`, пп. 1 и 7: герой в 4
  стороны, финальные облики).
- Хитбокс, симуляцию, контент.
- Режим фигур.

## Тесты

Первым коммитом, `packages/core-game/test/art-appearance.test.ts`:

- `heroFrameNames(undefined)` и `("keeper")` → `hero/idle0…`;
- `("vityaz")` при всех кадрах → `hero-vityaz/idle0…1`, `walk0…3`; ранение — `hero-vityaz/idle0`;
- `("vityaz")` без `walk3` → кадры Хранителя целиком;
- неизвестный id → кадры Хранителя;
- golden-тесты баланса зелёные **без обновления эталона**.

Ручная проверка: тестер с артом надел Витязя → забег → герой — Витязь.
Хранитель → атлас `skins` в сети не запрашивается. Снимок — в PR.

## Аналитика

Нет: облик уже пишет `appearance_changed` (T-0238), а `run_ended` несёт `art`
(T-0230).

## Настройки и окружение

Нет.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] В режиме арта герой — выбранный облик; у Хранителя атлас `skins` не грузится.
- [ ] Неполный или неизвестный облик — Хранитель целиком.
- [ ] Golden-эталон не менялся.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Облик героя в забеге`
- **Метка:** `release: minor`
- **Для игроков:** `- новое: в новом облике боя герой бежит в выбранном облике`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОБЛИК В ЗАБЕГЕ**

  В режиме арта герой в забеге — выбранный облик: Витязь, Ведунья, Князь и другие. Атлас обликов качается, только когда надет не Хранитель; хитбокс и баланс прежние.
  ```
