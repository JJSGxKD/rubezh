---
id: T-0005
title: Обереги и снаряды рисуются так, как бьёт симуляция
epic: E6
priority: P1
status: done
owner: claude-2 / sonnet-5.5
size: S
depends_on: []
zones:
  - packages/core-game/src/game/weapons/index.ts
  - packages/core-game/src/game/weapons/orbit.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/src/game/render/orbiter-points.ts
  - packages/core-game/src/game/render/projectile-look.ts
  - packages/core-game/test/orbiter-points.test.ts
  - packages/core-game/test/projectile-look.test.ts
  - packages/core-game/test/weapons-and-levels.test.ts
shared: []
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: null
---

# T-0005. Обереги и снаряды рисуются так, как бьёт симуляция

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0005.json)](README.md#значки-статуса)

## Зачем

Игрок жалуется: обереги «сильно режут глаз». Часть причины — ошибки рендера, а
не дизайна:

1. **Оберегов на экране меньше, а кольцо уже, чем на самом деле.** Рендер
   берёт базовые числа уровня оружия, а симуляция бьёт усиленными: «Размах»
   увеличивает площадь до ×1,6, площадь со снаряжения — тоже, «Залп» добавляет
   +1 или +2 снаряда. Игрок видит одно, а враги умирают от другого.
2. **Обереги дрожат.** Персонаж рисуется сглаженно (интерполяция между тиками
   симуляции), а обереги ставятся от несглаженной позиции персонажа. На экранах
   120 Гц они прыгают относительно героя каждый кадр.
3. **Свой снаряд в слоте, где раньше летел вражеский, остаётся повёрнутым и
   сплюснутым** (1,15 × 0,8). Плюс `setTexture` зовётся каждому снаряду
   каждый кадр.

Спокойный вид оберегов (цвет, прозрачность, след) — отдельная задача после
выбора визуального направления (эпик E9). Здесь только ошибки.

## Решения

- **Числа оружия «как в симуляции»** считает одна функция, и её зовут и
  симуляция, и рендер. Иначе они снова разойдутся.
- **Поведение симуляции не меняется ни на бит:** эталонная контрольная сумма
  `test/determinism.test.ts` и golden-эталоны остаются прежними. Изменится —
  значит, перенос сломал симуляцию.
- **Чистая логика рендера** — положения оберегов и вид снаряда — выносится в
  функции без Phaser, чтобы её можно было покрыть тестами.

## Как сейчас

- `src/game/weapons/index.ts`, `updateWeapons` (около строк 47–71): заполняет
  модульный `effective: ResolvedWeaponLevel`. Из уровня оружия и
  `world.playerStats` в нём:
  - `damageMul`, `cooldownMul`, `areaMul`, `projectileSpeedMul`, `durationMul`;
  - `extraProjectiles` — кроме поведения `aura`.

  Затем зовёт `WEAPON_BEHAVIORS[type.behavior].update(world, slot, effective, dtSec)`.
- `src/game/render/WorldRenderer.ts`:
  - `syncOrbiters()` (около строки 370) берёт `type.levels[…]` без усилений и
    зовёт `orbiterPosition(world, slot, level, k, out)`;
  - `syncProjectiles(t)` (около строки 343) на каждый снаряд зовёт `setTexture`;
    поворот и масштаб ставит только вражескому и у своего не сбрасывает;
  - интерполяция персонажа — `lerp(this.world.player.prevX, this.world.player.x, t)`
    (строка 268).
- `src/game/weapons/orbit.ts`, `orbiterPosition` (строка 141): центр —
  `world.player.x/y` без интерполяции, радиус — `level.areaRadius`;
  `orbiterCount(level)` (строка 133).
- Тест оружия — `test/weapons-and-levels.test.ts`, импорт `orbiterCount`,
  `orbiterPosition` из `../src/game/weapons`.

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»).
2. **`weapons/index.ts`.** Экспортировать

   ```ts
   effectiveWeaponLevel(world: World, slot: number, out: ResolvedWeaponLevel): ResolvedWeaponLevel
   ```

   — тот же расчёт, что сейчас внутри цикла `updateWeapons`, без
   выделения памяти: пишет в `out` и возвращает его. `updateWeapons` зовёт её с
   модульным `effective`. Порядок операций и формулы — побитово те же.
3. **`weapons/orbit.ts`.** `orbiterPosition` получает необязательный центр:

   ```ts
   orbiterPosition(world, slot, level, index, out, centerX = world.player.x, centerY = world.player.y)
   ```

   Симуляция зовёт его как раньше. Рендер передаёт сглаженный центр.
4. **Новый `render/orbiter-points.ts`.**

   ```ts
   orbiterRenderPoints(world: World, t: number, out: OrbiterPoint[]): number
   ```

   - центр — `lerp(prev, cur, t)` позиции персонажа;
   - на каждое оружие с поведением `orbit`: `effectiveWeaponLevel` в свой
     модульный буфер, `orbiterCount` от него, `orbiterPosition` с центром;
   - пишет точки в `out` (переиспользует объекты, расширяет массив только при
     нехватке) и возвращает число точек;
   - без Phaser и без выделений памяти на кадр.
5. **`WorldRenderer.syncOrbiters`.** Берёт точки из `orbiterRenderPoints(world,
   t, …)` и расставляет спрайты. Сигнатура меняется на `syncOrbiters(t)`, вызов
   в строке 184 — `this.syncOrbiters(t)`.
6. **Новый `render/projectile-look.ts`.**

   ```ts
   projectileLook(fromPlayer: boolean, vx: number, vy: number, out: { texture: string; rotation: number; scaleX: number; scaleY: number })
   ```

   - свой снаряд → `"bh-projectile"`, поворот 0, масштаб 1 × 1;
   - вражеский → `"bh-projectile-enemy"`, `Math.atan2(vy, vx)`, 1,15 × 0,8.

   Комментарий про вытянутость вражеского переносится сюда. `Math.atan2` в
   рендере разрешён: на исход забега он не влияет (`CLAUDE.md`, детерминизм).
7. **`WorldRenderer.syncProjectiles`.** Вид — из `projectileLook`. `setTexture`
   — только если `sprite.texture.key` отличается. Поворот и масштаб ставятся
   всегда, в том числе своему снаряду.
8. Гейт.

## Чего не трогаем

- Числа оружия в `content/weapons.ts`, цвет и размер оберегов
  (`render/looks.ts`, `ORBITER_RADIUS`) — визуальный стиль решается в E9.
- Логику ударов оберегов (`orbit.ts`, кроме сигнатуры `orbiterPosition`).
- Оверлей разработчика `render/debug-overlay.ts`: он уже учитывает площадь.

## Тесты

Первым коммитом.

1. `test/weapons-and-levels.test.ts`, новый кейс «`effectiveWeaponLevel` даёт
   числа, которыми бьёт симуляция»:
   - мир с оружием `wardstone`, у игрока пассивки «Размах» и «Залп»
     (`addPassive`): `areaRadius` = базовый × `areaMul`, `projectiles` =
     базовые + `extraProjectiles`;
   - для оружия с поведением `aura` прибавка снарядов не действует.
2. Новый `test/orbiter-points.test.ts`:
   - число точек = `orbiterCount` от **усиленного** уровня. С «Залпом» точек
     больше, чем `projectiles` базового уровня;
   - расстояние от центра до каждой точки = усиленный `areaRadius` (с допуском
     1e-9);
   - центр при `t = 0.5` — середина между `player.prevX/prevY` и `player.x/y`;
   - второй вызов с тем же `out` не создаёт новых объектов: ссылки на элементы
     те же.
3. Новый `test/projectile-look.test.ts`:
   - свой снаряд — поворот 0 и масштаб 1 × 1 (после вражеского в том же `out`);
   - вражеский — поворот по скорости и 1,15 × 0,8.
4. **Существующие эталоны не меняются:** контрольная сумма в
   `test/determinism.test.ts` и `test/run-summary.test.ts`. Если тест падает,
   исправлять код, а не эталон.

## Аналитика

Нет.

## Настройки и окружение

Нет.

## Документы

Нет: поведение для игрока описано верно, расходился только рендер. Если в
`docs/27-design-system-and-app-shell.md` или `docs/32-balance.md` найдётся
описание оберегов, противоречащее исправлению, — вопрос тимлидам, а не правка.

## Критерии приёмки

- [ ] Рендер и симуляция берут числа оружия из одной функции `effectiveWeaponLevel`.
- [ ] С «Залпом» и «Размахом» на экране столько оберегов и такое кольцо, как бьёт симуляция.
- [ ] Обереги ставятся от сглаженной позиции персонажа.
- [ ] Свой снаряд не наследует поворот и масштаб вражеского. Текстура меняется только при смене вида.
- [ ] Контрольные суммы детерминизма и golden-эталоны не изменились.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.
- [ ] В описании PR — снимок забега с «Залпом»: обереги до и после.

## PR

- **Заголовок:** `fix(core-game): Обереги и снаряды рисуются как в симуляции`
- **Метка:** `release: patch`
- **Для игроков:** `- исправлено: Обереги больше не дрожат, и на экране их столько, сколько на самом деле бьёт по врагам.`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОБЕРЕГИ И СНАРЯДЫ РИСУЮТСЯ ТАК, КАК БЬЁТ СИМУЛЯЦИЯ**

  Обереги рисовались по базовому уровню оружия, а били усиленным, и дрожали относительно героя. Теперь рендер и симуляция считают оружие одной функцией. Свой снаряд больше не наследует поворот и сплющивание вражеского.
  ```
