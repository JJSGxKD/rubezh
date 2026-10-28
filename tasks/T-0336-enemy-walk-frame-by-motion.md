---
id: T-0336
title: Стоящий враг не шагает — кадр шага по движению, как у героя
epic: E10
priority: P2
status: in-progress
owner: claude-12 / sonnet-5.5 / medium
author: claude-lead-1
size: S
depends_on: []
zones:
  - packages/core-game/src/game/render/art-atlas.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/test/art-atlas.test.ts
shared: []
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 3
---

# T-0336. Стоящий враг не шагает — кадр шага по движению, как у героя

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0336.json)](README.md#значки-статуса)

## Зачем

Владелец заметил на тесте: замороженный враг стоит на месте, но анимация бега
у него идёт. Так же «бегут на месте» страж в строю, подрывник на фитиле и враг
в телеграфе рывка. После задачи кадр шага зависит от движения: двигается —
шагает, стоит — держит кадр, на котором остановился.

## Решения

- **Р169** (`docs/35-stage4-plan.md`): кадр шага врага — по движению, как у
  героя, а не по времени. Замерший от «Заморозки» или холода, страж в строю,
  подрывник на фитиле стоят на одном кадре. Кадр, на котором враг остановился,
  сохраняется — без рывка на нулевой.
- Звук, вибрация и симуляция не меняются. Режим работает только при чёрновом
  арте (флаг `art.sprites`, режим разработчика): в выключенном режиме рисуются
  фигуры, и их задача не касается.
- Нового переключателя настроек не нужно: анимация не добавляется, а убирается
  там, где она была лишней (`CLAUDE.md`, «Настройки не отстают от игры»).

## Как сейчас

- `packages/core-game/src/game/render/art-atlas.ts`:
  - `walkFrame(tick, slot)` (стр. 66) — `floor((tick + slot * 7) / TICKS_PER_FRAME) % ART_WALK_FRAMES`;
    идёт по времени. `TICKS_PER_FRAME = 8` (стр. 33), `ART_WALK_FRAMES = 4` (стр. 30).
  - `ArtMode.applyEnemy(sprite, slot, textureIndex, tick)` (стр. 264) берёт
    `index = textureIndex * ART_WALK_FRAMES + walkFrame(tick, slot)`; хранит
    показанный индекс в `this.shown[slot]` (`Int16Array`, `-1` — слот рисуется
    фигурой). Кадров покоя у врага в атласе нет — только `id/sN/walkK`
    (`enemyFrameName`).
  - `ArtMode.applyHero(...)` (стр. 304) уже делает правильно:
    `moving = Math.abs(vx) + Math.abs(vy) > 1e-3`.
  - `this.shown.fill(-1)` при смене режима (метод `update`, стр. 206).
- `packages/core-game/src/game/render/WorldRenderer.ts`:
  - стр. 387: `this.art.applyEnemy(sprite, i, texture, tick)`; `enemies.vx[i]`,
    `enemies.vy[i]` рядом уже читаются (стр. 435, `faceEnemy`).
  - стр. 376–380: мёртвый слот скрывается (`sprite.setVisible(false)`).
- Симуляция (`game/sim/step.ts:213`, `:220`) обнуляет `vx`, `vy` у замороженного
  врага (холод и заморозка подбором). Это и есть признак «стоит»: отдельный флаг
  от симуляции не нужен, рендер остаётся от неё независимым.

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»); они падают, пока кода нет.
2. **`art-atlas.ts`, константа и правило движения.** Рядом с `ART_WALK_FRAMES`
   добавь `export const ART_MOVING_EPSILON = 1e-3;` с комментарием «ниже —
   стоит; тот же порог, что у героя». Рядом с `walkFrame` добавь:
   ```ts
   /** Движется ли враг: скорость ниже порога — стоит. */
   export function isMoving(vx: number, vy: number): boolean {
     return Math.abs(vx) + Math.abs(vy) > ART_MOVING_EPSILON;
   }

   /**
    * Кадр шага врага. Идёт — по времени, как `walkFrame`; стоит — держит
    * последний показанный кадр. `lastFrame < 0` — слот ещё ничего не показывал
    * (только появился): кадр 0.
    */
   export function frameForEnemy(tick: number, slot: number, moving: boolean, lastFrame: number): number {
     if (moving) return walkFrame(tick, slot);
     return lastFrame >= 0 ? lastFrame : 0;
   }
   ```
3. **`applyHero`**: вместо литерала `1e-3` вызови `isMoving(vx, vy)` (поведение
   героя не меняется, только порог в одном месте).
4. **`ArtMode`, хранение кадра.** Новое поле
   `private readonly lastFrame: Int8Array;` — «последний кадр шага у слота; −1 —
   слот свободен». В конструкторе:
   `this.lastFrame = new Int8Array(world.config.maxEnemies).fill(-1);`.
   В `update` рядом с `this.shown.fill(-1)` — `this.lastFrame.fill(-1)`.
   Отдельный массив, а не `this.shown`: `shown` хранит индекс текстуры×кадр и
   сбрасывается в `-1`, когда арта у врага нет, а «где остановился» должно
   пережить и это.
5. **`applyEnemy`**: новая сигнатура
   `applyEnemy(sprite, slot, textureIndex, tick, vx, vy): boolean`. Внутри:
   ```ts
   const frameNo = frameForEnemy(tick, slot, isMoving(vx, vy), this.lastFrame[slot]);
   this.lastFrame[slot] = frameNo;
   const index = this.enabled ? textureIndex * ART_WALK_FRAMES + frameNo : -1;
   ```
   Остальное тело — как есть (поиск кадра, `setTexture` только при смене).
6. **`ArtMode.releaseEnemy(slot: number): void`** — `this.lastFrame[slot] = -1`:
   слот освободился, следующий враг в нём начнёт с кадра 0, а не унаследует
   чужой.
7. **`WorldRenderer.ts`**:
   - стр. 387: `this.art.applyEnemy(sprite, i, texture, tick, enemies.vx[i], enemies.vy[i])`;
   - в ветке мёртвого слота (стр. 376–380) перед `continue` вызови
     `this.art.releaseEnemy(i)` (вызов дешёвый, условие `sprite.visible` для
     него не нужно: слот может быть скрыт, а кадр остаться).
   Больше в этом файле ничего не меняется.
8. **Комментарии** — на русском, про «почему»: в `frameForEnemy` — «стоящий враг
   (заморозка, строй, фитиль, телеграф) не шагает на месте»; никакой истории
   изменений.
9. Проверка глазами: `pnpm dev`, режим разработчика, флаг `art.sprites`; подбор
   «Заморозка» — враги встали на кадре и не листают шаг; после срока — идут.
   Результат одной строкой в описание PR. Если запустить нельзя — «не
   запускалось, проверено тестами».

## Чего не трогаем

- `game/sim/*`: признак «стоит» берётся из уже обнулённых `vx`, `vy`; симуляция,
  заморозка (`freeze.ts`, `elements.ts`) и баланс остаются как есть.
- Вид замерзшего врага (заливка `LOOK.frozen`, мигание) и окраска холода врага —
  отдельный вопрос, не эта задача.
- `applyHero`, кадры покоя героя и сам арт (`design/art/**`, атласы).
- Отражение `faceEnemy`, глубина, масштаб, `shows(slot)`.
- Врагов-фигур (режим арта выключен): их рендер без изменений.
- Нового кадра покоя в атласе не заводим: «стоит» = последний кадр шага.

## Тесты

Пишутся первым коммитом, `packages/core-game/test/art-atlas.test.ts`
(импорт `frameForEnemy`, `isMoving`, `ART_MOVING_EPSILON`, `walkFrame`). Рендер
вне `sim-purity`, но `Math.random()` и `Date.now()` не используются.

- «движется — листает, как раньше»: для тиков `0, 8, 16, 24, 32` и слота 0
  `frameForEnemy(tick, 0, true, 3)` равно `walkFrame(tick, 0)` (то есть
  `[0, 1, 2, 3, 0]`), последний кадр на результат не влияет.
- «стоит — держит последний кадр»: `frameForEnemy(100, 5, false, 2) === 2` и то
  же для тиков 101, 130, 999 (кадр не зависит от времени).
- «первый кадр спавна — нулевой»: `frameForEnemy(57, 3, false, -1) === 0`
  (враг появился с `vx = vy = 0`).
- «замерший подбором держит кадр»: последовательность тиков 0…40 шагом 4 для
  слота 2, `lastFrame` протаскивается: первые 8 вызовов с `moving = true`,
  затем 8 вызовов с `moving = false` — все кадры второй половины равны
  последнему кадру первой.
- «после разморозки идёт снова»: после участка со `moving = false` вызов с
  `moving = true` возвращает `walkFrame(tick, slot)`.
- `isMoving`: `isMoving(0, 0) === false`, `isMoving(ART_MOVING_EPSILON, 0) ===
  false` (порог строгий), `isMoving(0.002, 0) === true`, `isMoving(-0.002, 0.0001)
  === true`, `isMoving(0.0004, -0.0004) === false`.
- «кадр всегда в пределах атласа»: цикл по тикам и слотам, `moving` перебором
  true/false, `lastFrame` из `-1…3` — результат в `0…ART_WALK_FRAMES − 1`.
- «рендер передаёт скорость» (чтением исходника, как другие тесты слоя): в
  `src/game/render/WorldRenderer.ts` есть вызов
  `applyEnemy(sprite, i, texture, tick, enemies.vx[i], enemies.vy[i])` и вызов
  `releaseEnemy(i)`.
- Существующие тесты `art-atlas.test.ts` (кадры шага, имена, покрытие контента)
  проходят без изменений.

## Аналитика

Нет: чисто визуальная правка рендера, событий и метрик не порождает.

## Настройки и окружение

Нет. Новых ключей, переменных и переключателей нет (см. «Решения»).

## Документы

- Правка `docs/` не нужна: решение уже записано в Р169 (`docs/35-stage4-plan.md`).
- Комментарий у `walkFrame` в `art-atlas.ts` поправь, если он утверждает, что
  кадр зависит только от тика.

## Критерии приёмки

- [ ] `frameForEnemy`, `isMoving`, `ART_MOVING_EPSILON` экспортируются из `art-atlas.ts`, `applyHero` пользуется `isMoving`.
- [ ] `applyEnemy` принимает `vx`, `vy`; стоящий враг держит последний показанный кадр, первый кадр спавна — нулевой.
- [ ] Освободившийся слот сбрасывается (`releaseEnemy`), следующий враг начинает с кадра 0.
- [ ] `game/sim/*`, арт и `applyHero`-поведение не изменены.
- [ ] Тесты из раздела «Тесты» есть, первый коммит — тесты.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `fix(core-game): Остановить шаг у стоящих врагов`
- **Метка:** `release: patch`
- **Для игроков:** нет (черновой арт виден только в режиме разработчика и у тестеров по флагу; раздела `## Для игроков` в описании PR нет)
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОСТАНОВИТЬ ШАГ У СТОЯЩИХ ВРАГОВ**

  В черновом арте кадр шага врага теперь зависит от движения, как у героя:
  замороженный, страж в строю и подрывник на фитиле стоят на одном кадре, а не
  бегут на месте.

  🛠 **Рендер боя**

  • кадр шага: идёт — листает, стоит — держит последний кадр
  • первый кадр появившегося врага — нулевой, слот сбрасывается при гибели
  • симуляция, звук и вибрация не менялись
  ```
