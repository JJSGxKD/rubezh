---
id: T-0212
title: Сцена эффекта по адресу — `?fx=<сцена>` на dev-сервере, шаг по тикам для снимков
epic: E0
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0145]
zones:
  - packages/app-shell/src/dev/fx-scenes.ts
  - packages/app-shell/src/dev/fx-stand.ts
  - packages/app-shell/src/state/dev-url.ts
  - packages/app-shell/test/dev-url.test.ts
  - packages/app-shell/test/fx-scenes.test.ts
  - packages/app-shell/src/state/shell.ts
  - packages/app-shell/src/index.tsx
  - apps/web-telegram/src/main.tsx
  - packages/core-game/src/game/render/WorldRenderer.ts
shared:
  - packages/core-game/src/run-api.ts
  - packages/app-shell/src/state/dev-mode.ts
  - docs/31-audio-and-haptics.md
  - docs/17-testing-strategy.md
runner: local
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 3
---

# T-0212. Сцена эффекта по адресу — `?fx=<сцена>` на dev-сервере, шаг по тикам для снимков

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0212.json)](README.md#значки-статуса) [![T-0145](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0145.json&label=T-0145)](T-0145-screens-one-command.md)

## Зачем

Агент не видит, как выглядит вспышка грозы или взрыв динамита: эффект
живёт доли секунды посреди забега, и поймать его снимком нельзя. После
задачи адрес `http://localhost:5173/?fx=storm` открывает забег-стенд, где
уже стоит нужное оружие, враги и подборы, забег на паузе, а скрипт может
шагать симуляцию по тикам и снимать кадр после каждого шага. Это первый шаг
среды проверки эффектов: раскадровку и замеры строит T-0213.

## Решения

Решение владельца от 24.10.2026 — `docs/35-stage4-plan.md` Р142: эффект
проверяется раскадровкой с шагом 50 мс на светлом и тёмном участке карты;
порядок — снимки экранов (T-0144, T-0145) → сцена эффекта по адресу → рендер
звука → отчёт.

Решения `claude-lead-1` от 24.10.2026:

- **Адрес — тем же разбором, что `?screen=`** (T-0145): только
  `import.meta.env.DEV` и хост `localhost`/`127.0.0.1`. Параметры: `fx` —
  id сцены, `ground` — `map` (по умолчанию) или `light`. Неизвестная сцена
  — `null` и `console.warn("неизвестная сцена эффекта: <значение>")`.
- **Сцены — данные в оболочке**, `packages/app-shell/src/dev/fx-scenes.ts`:
  ```ts
  export interface FxScene {
    id: string;
    /** что смотреть на раскадровке — одна фраза для агента и человека */
    note: string;
    startingWeaponId: string;
    /** команды разработчика на старте, после выдачи оружия */
    commands: RunDevCommand[];
    /** сколько тиков снимать; кадр — каждые 3 тика (50 мс при 60 Гц) */
    ticks: number;
  }
  ```
  Каталог собирается из контента, а не руками: **на каждое оружие из
  `WEAPONS`** (базовые и эволюции) — сцена `<id оружия>` с оружием
  последнего уровня и десятью `swarm_rat` вокруг, 90 тиков. Плюс сцены
  событий: `dynamite` (подбор динамита среди двадцати рядовых), `magnet`
  (магнит и сорок кристаллов), `elite_death` (элита `tank_ghoul` и
  `oneHitKill`), по 60 тиков. Новое оружие получает сцену само — тест это
  проверяет.
- **Стенд — забег разработчика без экрана выбора**: `godMode`,
  `spawnPaused`, `freezeEnemies` включены, `autoPickUpgrades` включён,
  настройки разработчика на устройстве **не меняются** (стенд передаёт свои
  `RunDevOptions` одним заходом, сохранённые `bh.dev.v1` не трогает). В
  рейтинг и рекорд стенд не идёт — как любой забег с читами.
- **Шаг для скрипта** — объект `window.__fxStand` только на dev-сервере:
  ```ts
  interface FxStand {
    /** сцена загружена, оружие выдано, забег на паузе на нулевом тике сцены */
    ready: Promise<void>;
    scene: FxScene;
    /** шаг симуляции на паузе и ожидание отрисовки кадра */
    step(ticks: number): Promise<void>;
  }
  ```
  `step` — `devCommand({ kind: "stepTicks", ticks })` и ожидание двух
  `requestAnimationFrame`: кадр после шага уже нарисован. В сборке объекта
  нет — `fx-stand.ts` подключается только при `import.meta.env.DEV`.
- **Светлая подложка** — dev-настройка отображения `lightGround` в
  `RunDevVisuals`: земля карты заливается проверочным светлым цветом
  `0xc8c4b8`. Это не цвет игры, поэтому не токен: константа рядом с
  подложкой в `WorldRenderer.ts` с комментарием «только для стенда эффектов».
  У обычного забега флаг выключен.

## Как сейчас

- После T-0145: `packages/app-shell/src/state/dev-url.ts` — `readDevUrl(href,
  isDev)` → `{ screen, devUser }`; `ShellCapabilities.devStartScreen`;
  `apps/web-telegram/src/main.tsx` читает адрес.
- `packages/core-game/src/run-api.ts`:
  - `RunDevOptions` (609–622): `visuals`, `cheats`, `timeScale`, `start`;
  - `RunDevVisuals` (624–…): флаги отображения;
  - `RunDevCommand` (659–670): `giveWeapon`, `spawnEnemy`, `spawnPickup`,
    `spawnGems`, `stepTicks` и другие;
  - `RunSession.devCommand`, `pause`, `inspect`.
- `packages/core-game/src/game/sim/world.ts:31` — `TICK_HZ = 60`.
- `packages/app-shell/src/state/dev-mode.ts` — настройки разработчика и
  `toRunDev(settings)` (122–129); схема `visualsSchema`.
- `packages/app-shell/src/state/run.ts` — `start(options)`; забег
  разработчика решает `devModeAllowed()` и `armed` (296–348).
- `packages/core-game/src/game/render/WorldRenderer.ts:127–128` — подложка
  `bh-ground`, текстура — строки 548–555 (`WORLD_COLORS.ground`).

## Шаги по порядку

1. **`run-api.ts`** — `lightGround: boolean` в `RunDevVisuals` с
   комментарием. **`WorldRenderer.ts`** — при `lightGround` подложка
   перекрашивается (`setTint` не годится: он только затемняет — заменить
   текстуру на светлую того же размера). **`dev-mode.ts`** — поле в
   `visualsSchema` и умолчание `false`; сохранённые настройки без поля
   читаются с `false`.
2. **`fx-scenes.ts`** — тип `FxScene`, `FX_SCENES` по правилам «Решений»,
   `fxScene(id)` → сцена или `null`.
3. **`dev-url.ts`** — `fx` и `ground` в `DevUrlOptions` и `readDevUrl`.
4. **`fx-stand.ts`** — `startFxStand(scene, ground)`: проверяет право
   `tools.dev` (`devModeAllowed()`), запускает забег через `useRun`
   с `dev` из сцены (`visuals.lightGround` по `ground`), ставит паузу на
   первом тике, заводит `window.__fxStand`. Права нет — `console.warn("стенд
   эффектов: нужно право tools.dev")`, ничего не запускается.
5. **`shell.ts`** — `devFxScene?: { id: string; ground: "map" | "light" }`
   в `ShellCapabilities`; **`index.tsx`** — после монтирования и входа, если
   поле задано, динамический импорт `./dev/fx-stand` и запуск;
   **`main.tsx`** — поле из `readDevUrl`.
6. **Документы:**
   - `docs/17-testing-strategy.md` — абзац «Стенд эффектов» рядом со
     снимками экранов: адрес, сцены, `window.__fxStand`, что это только
     dev-сервер;
   - `docs/31-audio-and-haptics.md` §6 — строка: эффекты смотрят на стенде
     `?fx=<сцена>`, звук — в лаборатории (до T-0214).

## Чего не трогаем

- Сохранённые настройки разработчика `bh.dev.v1`, кроме нового поля.
- Раскадровку и замеры — T-0213; звук — T-0214.
- `apps/web-max`, `apps/web-vk`.
- Поведение забега без `lightGround` и без стенда.

## Тесты

Первым коммитом.

- `dev-url.test.ts`: `?fx=storm` на localhost, dev → `fx: "storm"`, `ground:
  "map"`; `?fx=storm&ground=light` → `ground: "light"`; `?fx=nope` → `fx:
  null` и предупреждение; не dev или чужой хост → `fx: null`.
- `fx-scenes.test.ts`:
  - у каждого оружия из `WEAPONS` есть сцена с тем же id;
  - id сцен уникальны; `ticks` кратно 3 и не больше 180;
  - сцены событий `dynamite`, `magnet`, `elite_death` есть;
  - все `commands` — известные виды `RunDevCommand`, id врагов — из
    `ENEMIES`.
- `dev-mode` — настройки без `lightGround` читаются с `false`.
- Ручной прогон: `pnpm dev`, `http://localhost:5173/?fx=storm`, в консоли
  `await __fxStand.ready; await __fxStand.step(3)` — кадр сдвинулся на три
  тика; `?fx=storm&ground=light` — светлая земля. Два снимка — в PR.

## Аналитика

Нет: инструмент разработчика.

## Настройки и окружение

Нет.

## Документы

По шагу 6.

## Критерии приёмки

- [ ] `?fx=<id>` на dev-сервере открывает стенд с оружием и врагами сцены,
  на паузе; в сборке и через туннель адрес не действует.
- [ ] `__fxStand.step(n)` шагает симуляцию и ждёт отрисовки.
- [ ] Новое оружие получает сцену без правки каталога.
- [ ] Сохранённые настройки разработчика стенд не меняет.
- [ ] Гейт (`CLAUDE.md`), `pnpm budget` и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(dev): Стенд эффектов по адресу ?fx=`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СТЕНД ЭФФЕКТОВ ПО АДРЕСУ**

  На dev-сервере адрес `?fx=<сцена>` открывает забег-стенд: нужное оружие или событие, враги вокруг, пауза и шаг по тикам через `window.__fxStand`. Сцена есть у каждого оружия и у динамита, магнита и гибели элиты; `&ground=light` даёт светлую землю. Это основа раскадровки эффектов для ИИ (Р142).
  ```
