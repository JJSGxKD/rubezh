---
id: T-0014
title: Вид боя — красная гамма по угрозе, тени и новые цвета мира
epic: E12
priority: P2
status: ready
owner:
size: M
depends_on: [T-0005, T-0012]
zones:
  - packages/core-game/src/game/render/looks.ts
  - packages/core-game/src/game/render/shapes.ts
  - packages/core-game/src/game/render/textures.ts
  - packages/core-game/src/game/render/shadow-layout.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/src/game/render/combat-feedback.ts
  - packages/core-game/test/threat-colors.test.ts
  - packages/core-game/test/looks.test.ts
  - packages/core-game/test/shadow-layout.test.ts
shared:
  - docs/27-design-system-and-app-shell.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: design/directions/directions-2026-10-c.html
---

# T-0014. Вид боя — красная гамма по угрозе, тени и новые цвета мира

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0014.json)](README.md#значки-статуса) [![T-0005](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0005.json&label=T-0005)](T-0005-orbiters-and-projectiles-render.md) [![T-0012](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0012.json&label=T-0012)](T-0012-twilight-tokens-and-fonts.md)

## Зачем

Утверждённый вид боя — вариант 3 «цвет по угрозе» (`design/README.md`, «Вид
боя»):
- враги красные;
- опасное (элита, босс) выделено каймой;
- у всех мягкая тень снизу;
- кристаллы яркие, обереги бирюзовые;
- фон — средний сумеречный тон, а не почти чёрный.

Сейчас в бою своя палитра этапа 2: враги девяти разных цветов, тёмная земля,
элита — просто светлее. Задача переводит мир забега на новые цвета.

## Решения

- **Враги — красная гамма.** У каждого поведения свой оттенок красного, но
  главное различие типа — по-прежнему **форма**: круг, квадрат, клин…
  Оттенки — таблица ниже.
- **Ранги:**
  - элита — тело смешивается с жаром очага `#ff8f3f` на 35 %, плюс золотая
    кайма `#ffd15c` толщиной 2 единицы;
  - босс — тело смешивается с малиновым `#e0245e` на 40 %, кайма той же
    золотой, 3 единицы;
  - рядовые — без каймы. Обводка у всех «странновато выглядит» (решение
    пользователя), поэтому она только у опасных.
- **Ступени** (`content/stages.ts`) — тоном и светлым ядром, как сейчас.
  Тонировка красного в оранжевый и красный стала бы не видна, поэтому:
  - ступень 2 — смешение с `#ffd15c` на 25 %, ядро `#fff1d6`;
  - ступень 3 — смешение с `#3b0a1f` на 35 % (тело темнее и «злее»), ядро `#ffd9e0`.
- **Тень запечена в текстуру.** Тёмный эллипс снизу рисуется в той же
  текстуре, что и тело, поэтому лишних спрайтов нет, — это важно для слабых
  телефонов.
  - Текстура получает поле под тень. Видимый размер тела и хитбокс **не
    меняются**: масштаб и точка привязки спрайта считаются от тела, а не от
    текстуры.
  - Тень есть у врагов, кристаллов, подборов и героя. У снарядов, оберегов и
    эффектов её нет: они «летят».
- **Цвета мира** — таблица ниже. Значения совпадают с палитрой T-0012 там, где
  роль та же: бирюза оберегов — `secondary`, опыт — `xp`, здоровье — `hp`.
- **Цифры урона** — шрифт Russo One (после T-0012 он загружен страницей),
  белые, **с тенью вместо обводки**; добивание — `#ffd15c`. У Russo One одно
  начертание, поэтому `fontStyle: "normal"`: «800» нарисовал бы поддельный
  полужирный.
- **Гайдбук** берёт формы и цвета из `looks.ts` сам (`ENEMY_LOOKS`,
  `enemyColor`, `GEM_TIERS`), поэтому дополнительной правки не требует.

**Враги по поведениям:**

| Поведение | Форма | Цвет |
|---|---|---|
| `swarm` | круг | `#ff4d5a` алый |
| `chase` | квадрат | `#e0245e` малиновый |
| `kite_and_shoot` | треугольник | `#ff6a6a` светло-красный |
| `dash` | клин | `#ff5a2e` красно-оранжевый |
| `orbit` | кольцо | `#ff7a90` розово-красный |
| `exploder` | шестиугольник | `#ff3b30` огненный |
| `splitter` | двойной | `#d93a6a` вишнёвый |
| `rush` | мошка | `#ff9a8a` коралловый |
| `caster` | глаз | `#c2185b` тёмно-малиновый |

**Мир (`WORLD_COLORS`) и кристаллы (`GEM_TIERS`):**

| Ключ | Было | Стало |
|---|---|---|
| `ground` | `0x0d0f14` | `0x2b4152` |
| `groundLine` | `0x171b24` | `0x33495b` |
| `playerEdge` | `0x1b2437` | `0x1d1c31` |
| `orbiter` | `0xffe0a3` | `0x46d9c6` |
| `hpFull` | `0x4ade80` | `0xff6f90` |
| `hpMid` | `0xffc53d` | `0xffc14d` |
| `hpLow` | `0xff4d4d` | `0xff3b5c` |
| `xpRing` | `0x7cc4ff` | `0xb6ff4a` |
| `heal` | `0x5fe3a1` | `0x8ee86b` |
| `GEM_TIERS` 1 / 3 / 8 / 20 | `5ccfff` / `5fe3a1` / `c47dff` / `ffd36b` | `b6ff4a` лайм / `a8f4ff` ледяной / `d68cff` сиреневый / `ffd15c` золото |
| Остальные ключи (`player`, `projectile`, `threat`, вспышки, подборы) | — | без изменений |

## Как сейчас

- `packages/core-game/src/game/render/looks.ts`:
  - `ENEMY_LOOKS` — форма и цвет по поведению;
  - `enemyColor(pattern, elite)` — элита светлее на 45 %;
  - `STAGE_LOOKS`, `stageColor`, `stageCore`;
  - `GEM_TIERS`;
  - `WORLD_COLORS`.

  Файл без Phaser, его читает и гайдбук оболочки.
- `render/textures.ts`, `ensureShapeTexture(scene, key, radius, color, shape,
  core)` — текстура `2·radius` на `2·radius` через `drawShape` из
  `render/shapes.ts`.
- `render/WorldRenderer.ts`, около строк 99–120: текстура на пару «тип и
  ступень», цвет — `stageColor(enemyColor(type.pattern, isElite(type)), stage)`.
  Ранг — `type.rank` (`"elite"`, `"boss"`, не задан). Земля —
  `TileSprite "bh-ground"` (около строки 547).
- `render/combat-feedback.ts`, около строк 200–225: `Phaser.Text`,
  `fontFamily` Rubik, `fontStyle: "800"`, обводка `#07090e`; добивание —
  `#ffd27a`.
- `test/threat-colors.test.ts` — проверки цветов угрозы.
- После T-0005 обереги ставятся через `render/orbiter-points.ts`; их цвет —
  `WORLD_COLORS.orbiter`.

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»).
2. **`looks.ts`:**
   - `ENEMY_LOOKS` — цвета по таблице, формы прежние. Комментарии у полей
     переписать: красная гамма, различие — формой;
   - `enemyColor(pattern, rank)` — вместо `elite: boolean` принимает
     `rank: "elite" | "boss" | undefined`; смешения — из «Решений»;
   - `enemyRim(rank)` → `{ color: number; width: number } | null`: элита —
     `0xffd15c` и 2, босс — `0xffd15c` и 3, рядовой — `null`;
   - `STAGE_LOOKS` — по «Решениям»;
   - `GEM_TIERS` и `WORLD_COLORS` — по таблице;
   - шапку файла переписать: облик «Сумеречный рубеж», ссылка на
     `design/README.md`.
3. **Новый `render/shadow-layout.ts`** — чистая функция без Phaser:

   ```ts
   export interface ShadowLayout { size: number; bodyX: number; bodyY: number; shadowX: number; shadowY: number; shadowRx: number; shadowRy: number; originX: number; originY: number }
   export function shadowLayout(radius: number): ShadowLayout
   ```

   - поле — `pad = ceil(radius * 0.4)`;
   - `size = ceil(radius * 2) + pad * 2`;
   - тело — в центре поля: `bodyX = bodyY = pad + radius`;
   - тень — эллипс в центре `(bodyX, bodyY + radius * 0.75)`, полуоси
     `radius * 0.9` и `radius * 0.38`;
   - `originX = originY = 0.5`.

   Тело в центре текстуры, поэтому точка привязки остаётся серединой и
   позиционирование спрайтов не меняется. Меняется только масштаб.
4. **`shapes.ts`:**
   - `ShapeSpec` получает необязательные `offset` (сдвиг тела в текстуре) и
     `rim: { color, width } | null`;
   - `drawShape` рисует тело со сдвигом, затем кайму `lineStyle(rim.width,
     rim.color)` по контуру той же фигуры, затем ядро. Тень сюда не входит.
5. **`textures.ts`:**
   - `ensureShapeTexture(…, options?: { core?, shadow?: boolean, rim? })`;
   - при `shadow` — размер из `shadowLayout`, сначала эллипс
     `fillStyle(0x000000, 0.35)`, затем тело со сдвигом;
   - без `shadow` — как сейчас;
   - функция возвращает `scaleFactor = size / (2 * radius)`. Его использует
     рендер, чтобы видимый размер тела не изменился.
6. **`WorldRenderer.ts`:**
   - текстуры врагов — с `shadow: true` и `rim: enemyRim(type.rank)`, цвет —
     `stageColor(enemyColor(type.pattern, type.rank), stage)`;
   - кристаллы, подборы, герой — с тенью;
   - снаряды, обереги, эффекты — без;
   - там, где спрайту задаётся размер по радиусу, учесть `scaleFactor`
     текстуры: тело на экране того же размера, что сейчас;
   - фон: `cameras.main.setBackgroundColor(WORLD_COLORS.ground)`, если цвет
     фона задаётся отдельно от тайла, — тот же цвет.
7. **`combat-feedback.ts`:**
   - `fontFamily: '"Russo One", "Segoe UI", system-ui, sans-serif'`,
     `fontStyle: "normal"`, цвет `#ffffff`. Файл шрифта приносит в бандл
     T-0012, поэтому задача ждёт её. Сейчас здесь `"Rubik Variable"`, которого
     после T-0012 в бандле нет;
   - вместо `stroke` — `setShadow(0, Math.round(1.5 * scale), "#000000", Math.round(2 * scale), false, true)`;
   - добивание — `#ffd15c`.
8. **`docs/27-design-system-and-app-shell.md`**, раздел о палитре канвы (если
   есть) или §4.1 — абзац: цвета мира в `render/looks.ts` следуют
   `design/README.md`, «Вид боя».
9. **Гейт.** Проверка в браузере в забеге с режимом разработчика (`dev`):
   - снимки на 390 px до и после — в PR: толпа рядовых, элита, босс,
     кристаллы, обереги;
   - отдельный снимок, на котором видно, что размер тела врага не изменился.

## Чего не трогаем

- Симуляцию и хитбоксы: ни одного числа вне `render/`. Контрольные суммы
  `test/determinism.test.ts` и golden-эталоны не меняются.
- Гайдбук оболочки: он берёт цвета из `looks.ts` сам.
- Телеграфы угроз (`WORLD_COLORS.threat`) — красный остаётся цветом опасности.
- Цвет героя и снарядов игрока.

## Тесты

Первым коммитом.

1. **Новый `test/looks.test.ts`:**
   - все `ENEMY_LOOKS` — в красной гамме: оттенок по HSV в пределах
     330°–20°, насыщенность ≥ 0,45 (функция перевода — в тесте);
   - формы у всех девяти поведений разные;
   - `enemyColor(p, "elite")` и `enemyColor(p, "boss")` отличаются от
     рядового и друг от друга;
   - `enemyRim(undefined) === null`, у `"elite"` толщина 2, у `"boss"` — 3;
   - `GEM_TIERS` — светлота каждого цвета по HSL ≥ 0,6 (тёмных кристаллов нет),
     цвета попарно различаются;
   - `WORLD_COLORS.orbiter === 0x46d9c6`.
2. **Новый `test/shadow-layout.test.ts`** — для радиусов 8, 12 и 30:
   - тело и тень целиком внутри текстуры;
   - тень ниже центра тела;
   - `size / (2 * radius)` больше 1, и масштаб, обратный ему, возвращает тело
     к `2·radius`.
3. **`test/threat-colors.test.ts`** — если проверки опираются на старые цвета
   врагов или угроз, перевести их на новые. Правило «угроза и свой опыт не
   совпадают по цвету» должно остаться.
4. **Контрольные суммы** `test/determinism.test.ts` и
   `test/run-summary.test.ts` не меняются.

## Аналитика

Нет.

## Настройки и окружение

Тень — часть облика и обязательна для чтения боя, под переключатель не
попадает. Кайма у элиты и босса — тоже. Если на слабых устройствах тени
окажутся дорогими, решение — в режиме слабого телефона (E10), а не здесь.

## Документы

Шаг 8.

## Критерии приёмки

- [ ] Враги в красной гамме с разными оттенками; формы прежние.
- [ ] Элита и босс — с золотой каймой; у рядовых каймы нет.
- [ ] Тень запечена в текстуры врагов, кристаллов, подборов и героя; лишних спрайтов нет.
- [ ] Видимый размер тел и хитбоксы не изменились (снимок в PR).
- [ ] Цвета мира и кристаллов — по таблице; кристаллов со светлотой по HSL ниже 0,6 нет.
- [ ] Цифры урона — Russo One, с тенью, добивание золотое.
- [ ] Контрольные суммы детерминизма и golden-эталоны не изменились.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Вид боя — красная гамма по угрозе и тени`
- **Метка:** `release: minor`
- **Для игроков:** `- изменено: Новый вид боя — враги в красной гамме, элита и босс с золотой каймой, у всего на поле мягкая тень, яркие кристаллы опыта.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВИД БОЯ ПО УГРОЗЕ**

  Бой перешёл на облик «Сумеречный рубеж»: враги в красной гамме и различаются формой, элита и босс — с золотой каймой, у всего на поле мягкая тень, кристаллы яркие, обереги бирюзовые, земля — сумеречный средний тон. Тени запечены в текстуры — лишней нагрузки на слабые телефоны нет.

  ❓ **Нужно от команды**

  • @участник1 — сыграть пару забегов и сказать, читается ли толпа и опасное; если нет — подстроим оттенки
  ```
