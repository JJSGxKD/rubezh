---
id: T-0198
title: Уборка кода вражеских снарядов — снаряд врага уходит из пула, отрисовки и сигналов
epic: E10
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0172, T-0197, T-0102, T-0116, T-0118, T-0125, T-0182, T-0195]
zones:
  - packages/core-game/src/game/sim/pools.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/step.ts
  - packages/core-game/src/game/sim/continue.ts
  - packages/core-game/src/game/weapons/shooting.ts
  - packages/core-game/src/game/patterns/enemy-types.ts
  - packages/core-game/src/game/render/projectile-look.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/src/game/render/shapes.ts
  - packages/core-game/src/game/render/looks.ts
  - packages/core-game/src/game/run/cues.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/src/run-api.ts
  - packages/core-game/test/projectile-look.test.ts
  - packages/core-game/test/no-enemy-projectiles.test.ts
  - packages/core-game/test/continue.test.ts
  - packages/core-game/test/endless-world.test.ts
  - packages/core-game/test/threat-colors.test.ts
  - packages/core-game/test/run-snapshot.test.ts
  - packages/core-game/test/cues.test.ts
  - packages/app-shell/src/screens/guide/scenes.tsx
  - packages/app-shell/src/screens/sound-lab.tsx
  - packages/app-shell/test/audio.test.ts
  - packages/app-shell/test/haptics.test.ts
shared:
  - CLAUDE.md
  - docs/21-diagrams.md
  - docs/30-configuration-map.md
  - docs/31-audio-and-haptics.md
  - packages/shared-types/src/index.ts
runner: any
executor: sonnet-5.5
effort: medium
release: patch
design: null
batch: 3
---

# T-0198. Уборка кода вражеских снарядов

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0198.json)](README.md#значки-статуса) [![T-0172](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0172.json&label=T-0172)](archive/T-0172-remove-shooting-enemies.md) [![T-0197](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0197.json&label=T-0197)](T-0197-second-boss-no-projectiles.md) [![T-0102](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0102.json&label=T-0102)](archive/T-0102-weapon-evolutions-data-and-engine.md) [![T-0116](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0116.json&label=T-0116)](archive/T-0116-freeze-pickup.md) [![T-0118](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0118.json&label=T-0118)](archive/T-0118-seventh-weapon-meteor-and-evolution.md) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](archive/T-0125-run-result-rank-chest-crystal-counters.md) [![T-0182](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0182.json&label=T-0182)](archive/T-0182-cordon-ring-analytics.md) [![T-0195](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0195.json&label=T-0195)](T-0195-player-power-pressure-engine.md)

## Зачем

После T-0172 (огонёк и кастер ушли) и T-0197 (второй босс без снарядов)
снаряды врагов в контенте не встречаются, но в движке остался весь путь
такого снаряда: поле «чей снаряд» в пуле, ветка попадания по игроку в шаге
симуляции, вражеский вид снаряда на канве, сигнал `enemyShots` звука и
вибрации. Это мёртвый код, который читается как живая возможность, платит
памятью в пуле и снимке забега и мешает следующему, кто будет добавлять
оружие. После задачи пул снарядов — только снаряды игрока, и это видно в
типах. Поведение игры не меняется.

## Решения

Р132 (`docs/35-stage4-plan.md`, 21.10.2026): «с вторым боссом снаряды врагов
в контенте не возвращаются, и код вражеских снарядов уходит». Решения ниже
приняты пользователем и тимлидом 21.10.2026, исполнитель их не пересматривает.

1. **Рефакторинг без изменения поведения.** Golden-эталоны, сценарные
   эталоны (`determinism`, `run-summary`), эталонный забег бота и
   калибровочные коридоры **не меняются**. Упали — задето лишнее: остановиться
   и разобраться, а не обновлять эталон.
2. **`CONTENT_HASH` не меняется.** Он считается от литералов контента
   (`content/hash.ts`: враги, ступени, оружие, таймлайн, кривая…), а эта
   задача контента не трогает. Исполнитель проверяет это руками до и после
   (шаг 9) и пишет оба значения в описание PR; числом в тест оно не
   вписывается (его меняют соседние задачи).
3. **Снимок забега меняется, версии поднимаются.** Пул снарядов теряет
   поля `fromPlayer` и `ownerType`, а `encodeRecord` кладёт в снимок все
   типизированные массивы пула по именам. Поэтому
   `WORLD_SNAPSHOT_VERSION` (`game/run/snapshot.ts`) и `RUN_SNAPSHOT_FORMAT`
   (`run-api.ts`) поднимаются **каждая на единицу выше значения в `dev` на
   момент взятия задачи** (константы соседних задач сдвигаются, число в
   спецификации не называется).
   - Оболочка решает «продолжать ли сохранение» по формату и отпечатку
     контента (`app-shell/src/state/run-save.ts`, `isResumable`), а версию
     мира видит только `restoreWorld`. Если поднять только мировую версию,
     сохранение пройдёт проверку оболочки, упадёт в `restoreWorld` и забег
     будет потерян молча. Поэтому поднимаются **обе**: сохранение на
     старом формате оболочка признаёт несовместимым, стирает и отдаёт на
     засчитывание (T-0163: забег засчитывается как `abandoned` с временем и
     уровнем из сохранения).
   - Вражеских снарядов в сохранениях, снятых после T-0172, нет, так что
     терять нечего, кроме самого факта «версия другая»; сохранение игрока,
     открывшего приложение между выкатом и этой сборкой, засчитывается так
     же, как при любой смене формата.
4. **Что остаётся.** Снаряды игрока, `spawnProjectile`, пул снарядов целиком,
   `projectileLook` для снаряда игрока (если он остаётся нужен, см. шаг 5),
   `NO_OWNER_TYPE`, `damagePlayer` с причиной смерти (нужна касанию и
   взрыву), `WORLD_COLORS.threat` и телеграфы рывка и взрыва.
5. **Звук и вибрация.** Сигнал `enemyShots` из `RunCues` уходит. Звуки атак
   врагов и так не играют (`docs/31-audio-and-haptics.md` §1, Р57: слышно
   только попадание по игроку), поэтому «Настройки не отстают от игры»
   (`CLAUDE.md`): переключателей это не меняет, новых не требуется.

## Как сейчас

(Описано по `dev` на 21.10.2026 до T-0172; T-0172 уже убирает у себя то, что
отмечено «уходит в T-0172». Строки сдвигаются, искать по именам.)

- `game/sim/pools.ts`: `ProjectilePool` (строка 92) содержит `fromPlayer`
  (1 — снаряд игрока, 0 — врага, строка 102) и `ownerType` (индекс типа врага,
  выпустившего снаряд, строка 104; `NO_OWNER_TYPE` у снаряда игрока);
  `createProjectilePool` (строка 240) заводит оба массива.
- `game/sim/world.ts`: `spawnProjectile(…, fromPlayer: boolean)` (строка 480)
  пишет `fromPlayer` и сбрасывает `ownerType` в `NO_OWNER_TYPE`; единственный
  вызов в живом коде — `game/weapons/shooting.ts:50` (с `true`); вражеские
  вызовы были в `patterns/kite-and-shoot.ts` и `patterns/caster.ts` (уходят в
  T-0172).
- `game/sim/step.ts`: `updateProjectiles` (строка 239). После срока жизни и
  потери (`isLost`) идёт `if (fromPlayer === 1) { hitEnemies; continue }`, а
  дальше — ветка вражеского снаряда: проверка касания с игроком, `damagePlayer`
  с причиной из `ownerType`, `despawnProjectile`. Константы `playerRadius`,
  `NO_OWNER_TYPE` в этом файле нужны только этой ветке (проверить).
- `game/sim/continue.ts:30–33` (`applyContinue`): при втором шансе снимает все
  живые снаряды с `fromPlayer === 0`.
- `game/render/projectile-look.ts` (28 строк): вид снаряда по принадлежности;
  вражеский — текстура `bh-projectile-enemy`, поворот по полёту, сплющивание
  1,15 × 0,8. `WorldRenderer.ts`: импорт и `lookScratch` (13, 24), текстура
  `bh-projectile-enemy` с формой `bolt` (строки 135–137), `syncProjectiles`
  (349–367) с `setTexture`, `setRotation`, `setScale` на каждый снаряд.
- `game/render/looks.ts`: `ShapeKind` содержит `"bolt"` (строка 35),
  `WORLD_COLORS.enemyProjectile` и `enemyProjectileCore`. `render/shapes.ts`:
  ветка `case "bolt"` (строки 124–133), использует `enemyProjectileCore`.
  `app-shell/src/screens/guide/scenes.tsx:120–126`: ветка `case "bolt"`;
  там же сцена прицела стрелка (`enemyProjectile`, строки 332–343) уходит в
  T-0172.
- `game/run/cues.ts`: поле `enemyShots` (строки 100, 183, 203), счёт выстрелов
  по `kite_and_shoot` (154; уходит в T-0172) и массив `enemyCooldown`
  (32, 39, 161): он нужен только этому счёту, после T-0172 он пишется и не
  читается. `run-api.ts:669` — поле `enemyShots` в `RunCues` с комментарием
  «стрелок выстрелил» (строка 664).
- Оболочка: `screens/sound-lab.tsx:330` (`enemyShots: chance(1.2 * density)`
  в генераторе сигналов лаборатории); `test/audio.test.ts:31, 94` (фикстура и
  проверка «атаки врагов не звучат» с `enemyShots: 1`); `test/haptics.test.ts:28`.
  Реальных читателей поля в `src` оболочки нет: `planCueSounds` его не смотрит.
- `game/patterns/enemy-types.ts`: T-0172 убирает из `PATTERN_TRAITS`,
  `PATTERN_DEFAULTS`, `ALLOWED_PARAMS` записи двух паттернов, но поля
  `ResolvedPatternParams` и `NEUTRAL_PARAMS` (`preferredDistance`,
  `shotIntervalSec`, `projectileSpeed`, `castIntervalSec`, `burstCount`) и
  элементы `SCALED_PARAMS` (`preferredDistance`, `projectileSpeed`) остаются
  без читателей. Проверить поиском: `WorldRenderer.ts:337` (`preferredDistance`
  в телеграфе кастера) уходит в T-0172.
- Тесты, которые строят вражеский снаряд руками: `test/continue.test.ts:40–47`
  (`spawnProjectile(w, 50, 0, -1, 0, 5, 3, false)`, проверка «вражеский снаряд
  снят, свой остался»), `test/endless-world.test.ts:105` (вызов с `true`),
  `test/threat-colors.test.ts:21` (`enemyProjectile` красный),
  `test/projectile-look.test.ts` (весь файл про вид вражеского снаряда).
- Диагностика и стенд считают **все** снаряды вместе (`run-probe.ts`,
  `bench/metrics.ts`, `BenchScene.ts`, `run-timeline.ts`, `debug-overlay.ts`):
  это снаряды игрока, они остаются как есть.
- Документы: `docs/31-audio-and-haptics.md:19` («выстрел» среди атак врагов,
  которые не звучат) и `:133` («выстрел огонька» в перечне сигналов
  `RunCues`); `docs/30-configuration-map.md:109` (снаряды в строке про формы и
  цвета), `:122` (строка про кастера — уходит в T-0172), `:132` («прицел
  стрелка» в строке про телеграфы); `docs/21-diagrams.md` (раздел про радиус
  удержания: «снаряды: таймер жизни и дистанция» — это про снаряды игрока и
  остаётся).

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»). `no-enemy-projectiles.test.ts`
   (создан в T-0172) дополняется проверками исходников и пула; тесты, которые
   строят вражеский снаряд, переписываются под новую сигнатуру.
2. **Пул и мир (`sim/`).**
   - `pools.ts`: убрать `fromPlayer` и `ownerType` из `ProjectilePool` и
     `createProjectilePool`; комментарий у `ownerWeapon`: «индекс оружия
     игрока — по нему считается урон по оружиям для итогов»; `NO_OWNER_TYPE`
     остаётся (его читают враги и `ownerWeapon`), комментарий над ним — про
     эти случаи;
   - `world.ts`: `spawnProjectile` без параметра `fromPlayer`; убрать
     запись `fromPlayer` и сброс `ownerType`; комментарий над сбросом
     «Владельца и пробивание…» оставить только про оружие и пробивание;
   - `step.ts`, `updateProjectiles`: после срока жизни идёт сразу
     `hitEnemies(world, p, projectileRadius)`; ветку попадания по игроку
     убрать целиком, вместе с неиспользуемыми `playerRadius` и `player`,
     а также импортами, которые остались без читателей (`NO_OWNER_TYPE`,
     `damagePlayer` — проверить, `damagePlayer` нужен касанию врага,
     строка 233);
   - `continue.ts`: убрать цикл по снарядам с `fromPlayer === 0` и импорт
     `despawnProjectile`, если он больше нигде не нужен. Свои снаряды второй
     шанс не снимает, как и раньше.
   - `weapons/shooting.ts`: убрать последний аргумент `true` из
     `spawnProjectile`.
3. **Снимок.** `snapshot.ts`: `WORLD_SNAPSHOT_VERSION` и в `run-api.ts`
   `RUN_SNAPSHOT_FORMAT` — каждая на единицу выше значения в `dev` (решение
   3). Комментарии у констант не переписывать, историю версий в них не
   вести. Формат и мир теперь не содержат массивов `fromPlayer` и
   `ownerType`; чтение старого снимка по-прежнему отказывает по версии.
4. **Отрисовка снаряда.** `projectile-look.ts` удалить: единственный вид
   снаряда игрока — текстура `bh-projectile` без поворота и масштаба.
   `WorldRenderer.ts`: убрать импорт, `lookScratch`, текстуру
   `bh-projectile-enemy` и комментарий к ней, в `syncProjectiles` — вызов
   `projectileLook`, `setTexture`, `setRotation`, `setScale`: спрайту снаряда
   в слоте больше нечего менять, кроме положения. Заведение спрайтов
   (`createHiddenSprite("bh-projectile")`) остаётся.
5. **Форма и цвета.** `looks.ts`: убрать `"bolt"` из `ShapeKind` вместе с
   комментарием; `WORLD_COLORS.enemyProjectile` и `enemyProjectileCore`;
   `shapes.ts` — ветку `case "bolt"`; `scenes.tsx` — ветку `case "bolt"`.
   Проверить поиском по пакетам, что ни `bolt`, ни оба цвета больше нигде
   не читаются (после T-0172 и шагов выше читателей быть не должно);
   исполнитель, нашедший читателя, не оставляет цвет «на всякий случай», а
   пишет вопрос.
6. **Сигнал.** `cues.ts`: убрать поле `enemyShots` (создание, сброс,
   строка `any = true`) и массив `enemyCooldown` вместе с его записью, если
   после T-0172 он нигде не читается; `run-api.ts`: убрать поле `enemyShots`
   в `RunCues` и поправить комментарий `fuses/dashWarns/dashes` («начала
   угроз: подрывник поджёг фитиль, волк замер перед рывком и рванул»).
   Оболочка: `sound-lab.tsx` — строка `enemyShots`; `audio.test.ts` и
   `haptics.test.ts` — поле в фикстуре и в проверке «атаки врагов не звучат»
   (тест остаётся, меняется только набор полей).
7. **Остатки параметров паттернов.** `enemy-types.ts`: убрать из
   `ResolvedPatternParams`, `NEUTRAL_PARAMS` и `SCALED_PARAMS` те поля, у
   которых после T-0172 нет читателей: `shotIntervalSec`, `projectileSpeed`,
   `castIntervalSec`, `burstCount`, `preferredDistance` — по поиску по
   `src/` и `test/` каждого, а не списком. Если T-0172 оставил что-то из этого в
   `shared-types` (`EnemyPatternParams`), убрать и там — это единственная
   правка `packages/shared-types`, остальное в нём не трогать.
8. **Эталоны и перф.** `pnpm test` целиком: сценарные и golden-эталоны,
   `perf-budget.test.ts` и `bench-*.test.ts` зелёные без правок. Размер
   снимка забега уменьшился на два байтовых массива пула — число до и после
   (длина base64 снимка на 5 минутах забега, `seed: 1`) в описание PR.
9. **Отпечаток контента.** До правок и после: `CONTENT_HASH` (например,
   одноразовым вызовом `pnpm vitest` с `console.log` или запуском
   `tsx -e` в `packages/core-game`; в коммит не попадает) — значения совпали;
   оба в описание PR.
10. **Документы** (раздел «Документы») и гейт (`CLAUDE.md`).

## Чего не трогаем

- Снаряды игрока: `spawnProjectile`, пул, `hitEnemies`, пробивание, оружие
  (`game/weapons/*`), текстура `bh-projectile`, подсчёты `projectiles` в
  диагностике и стенде.
- Контент (`content/*`), сложности, баланс, бота: `CONTENT_HASH` не меняется.
- Паттерны врагов (`patterns/*`) — кроме `enemy-types.ts`, где остаются только
  таблицы параметров: поведение живых паттернов не меняется.
- Звуки и вибрация сверх удаления поля `enemyShots` (рецепты, режиссёр,
  переключатели настроек, `docs/31` кроме двух строк).
- `damagePlayer`, причину смерти, итог забега (`deathCauseType`): касание и
  взрыв их по-прежнему заполняют.
- Серверную часть: `backend/` о вражеских снарядах не знает (проверено
  поиском).
- Версию формата ответа сервера и схемы БД: снимок забега хранится на
  устройстве.

## Сценарий и интерфейс

Игрок ничего не видит: бой, звук и вибрация те же. Изменение видно только
команде: пул снарядов без поля «чей», в типах нет вражеского снаряда, в
лаборатории звука нет строки выстрелов. Единственное, что почувствует игрок, —
если он закрыл приложение посреди забега на прежней сборке, то после
обновления забег будет засчитан как оборванный (механика T-0163), а не
продолжится. Загрузки, пустого и сетевого состояний нет. Макета нет.

## Тесты

Первым коммитом.

`packages/core-game/test/no-enemy-projectiles.test.ts` (дополняется):

- **«в пуле снарядов нет понятия вражеского»:** `createProjectilePool(4)` не
  имеет полей `fromPlayer` и `ownerType`; `spawnProjectile` принимает
  семь аргументов (`spawnProjectile.length === 7`).
- **«шаг не бьёт игрока снарядом»:** мир с игроком, в упор к которому
  выпущен снаряд (`spawnProjectile` в точке игрока, скорость 0, урон 5):
  за 30 тиков `world.stats.damageTaken === 0` и игрок цел, снаряд исчез по
  сроку жизни. Раньше такой снаряд был бы вражеским.
- **«в исходниках нет вражеских снарядов»** (по исходникам, как
  `sim-purity.test.ts`; комментарии отбрасываются): ни в `src/game`, ни в
  `src/run-api.ts`, ни в `app-shell/src` нет слов `enemyShots`,
  `enemyProjectile`, `projectile-enemy`, `fromPlayer`; в `ShapeKind` нет
  `"bolt"`.
- прежние проверки T-0172 (нет `spawnProjectile` в `patterns/`, нет
  `projectileSpeed` и `shotIntervalSec` в контенте, восемь паттернов) —
  без правок.

`packages/core-game/test/continue.test.ts`: вражеский снаряд `hostile`
убирается из теста «второй шанс снимает снаряды врагов, свои оставляет»;
тест переименован в «второй шанс не трогает снаряды игрока»: свой снаряд
после `applyContinue` жив, враги сняты.

`packages/core-game/test/endless-world.test.ts`: вызов `spawnProjectile`
без последнего аргумента, остальное прежнее.

`packages/core-game/test/projectile-look.test.ts`: файл удалить вместе с
модулем.

`packages/core-game/test/threat-colors.test.ts`: из теста «телеграфы и снаряды
врагов — красные» убирается проверка `enemyProjectile`; тест называется
«телеграфы врагов — красные».

`packages/core-game/test/run-snapshot.test.ts`:

- литералы версий (`toBe(8)`, `toBe(7)` и им подобные) заменить на
  константы: «снимок заявляет текущую версию» —
  `saved.version === WORLD_SNAPSHOT_VERSION`; «прежняя версия не читается» —
  `{ ...saved, version: WORLD_SNAPSHOT_VERSION - 1 }` бросает `SnapshotError`;
- **«в снимке нет массивов вражеского снаряда»:** у закодированного пула
  `projectiles.arrays` нет ключей `fromPlayer` и `ownerType`;
- **«снимок продолжается без расхождения»:** прежние проверки «продолженный
  забег идёт ровно так же» зелёные без правок (контрольная сумма мира после
  50 секунд совпадает).

`packages/app-shell/test/run-save.test.ts` (в зоне не меняется, но обязан
остаться зелёным): сохранение с `format: RUN_SNAPSHOT_FORMAT - 1` несовместимо
(`isResumable` ложно, `takeIncompatibleRun` стирает и отдаёт его); тест
использует константу, а не число — если в нём остался литерал, это
поправка в той же задаче (добавить файл в зоны только в этом случае, с
отметкой в PR).

`packages/core-game/test/cues.test.ts`: если в нём строятся `RunCues` с
`enemyShots`, убрать поле; в остальном зелёный.

`packages/app-shell/test/audio.test.ts` и `haptics.test.ts`: без поля
`enemyShots`; «атаки врагов не звучат» — тот же набор остальных сигналов.

Остальные тесты движка, `sim-purity.test.ts`, `perf-budget.test.ts`,
`bench-*.test.ts`, `determinism.test.ts`, `run-summary.test.ts` и
`balance-properties.test.ts` зелёные без правок, эталоны не меняются.

## Аналитика

Нет. Аналитика о вражеских снарядах никогда не писалась (`damageTaken` и
причина смерти идут из касания и взрыва); новых событий, полей и меток
Prometheus нет.

## Настройки и окружение

Нет. Переключателей звука и вибрации это не меняет: атаки врагов не звучали и
до задачи (`docs/31-audio-and-haptics.md` §1).

## Документы

- `CLAUDE.md`: в таблице паттернов («Как добавить нового врага») строки
  `kite_and_shoot` и `caster` убирает T-0172; здесь проверить хвосты: в
  абзаце про `element` у врага «касание, взрыв или снаряд» → «касание или
  взрыв», упоминаний «снарядов врага», «стрелка» и «кастера» по тексту быть не
  должно (поиск); в «Как добавить оружие» и «Границах слоёв» ничего про
  вражеский снаряд нет.
- `docs/31-audio-and-haptics.md`: §1, пункт 1 — «фитиль, рывок, выстрел,
  взрыв подрывника» → «фитиль, рывок, взрыв подрывника»; §«Движок отдаёт
  `RunCues`» (около строки 133) — убрать «выстрел огонька» и поправить
  перечень сигналов («…начала угроз — фитиль, телеграф и рывок волка — и
  срабатывания каждого оружия»).
- `docs/30-configuration-map.md`: строка 109 — «снаряды» из «Формы и цвета
  мира» → «снаряды игрока»; строка про кастера (122) убирает T-0172; строка
  про телеграфы (132) — «за сколько до выстрела виден прицел стрелка»
  убрать вместе с `AIM_TELEGRAPH_SEC`, если T-0172 его удалил.
- `docs/35-stage4-plan.md`, WP36: строка «код вражеских снарядов убран
  (T-0198)» — правит тимлид.
- `docs/21-diagrams.md`: схем БД, пакетов и сервисов эта задача не меняет;
  схема потока снаряда (если есть в разделе про движок) уже описывает только
  снаряд игрока. Проверить поиском по «снаряд» и отметить в PR «схемы
  проверены».
- Документы, где `enemyShots` или «вражеский снаряд» встречаются в
  исторических описаниях этапов 1–2 (`docs/25`, `docs/26`), не переписываются.

## Вопросы к тимлиду

Принято по умолчанию; `claude-lead-1` подтверждает или правит при слиянии
спецификации:

1. **Версии снимка поднимаются обе** (мир и формат), а не одна: иначе
   сохранение пройдёт проверку оболочки и упадёт в `restoreWorld`. Если нужно
   сохранить сохранения прошлой сборки живыми, задачу пришлось бы делать
   иначе (оставить поля в пуле), и смысл уборки пропадает.
2. **Порядок выката.** Если эта задача выйдет в одной пачке с T-0172, T-0192 и
   T-0197, отпечаток контента всё равно изменится и сохранения прошлой
   сборки засчитываются T-0163 как оборванные без разницы; поднятые версии
   нужны на случай, когда задача выходит отдельным релизом без правок
   контента.
3. **Задачи пачки 3 с общими файлами** (`snapshot.ts`, `world.ts`, `step.ts`,
   `run-api.ts`: T-0119, T-0120, T-0129, T-0175): они должны идти после этой
   задачи или разбирать версии снимка при слиянии; предлагается
   `depends_on: [T-0198]` им. Правит тимлид.

## Критерии приёмки

- [ ] В пуле снарядов нет `fromPlayer` и `ownerType`; `spawnProjectile` без
  признака принадлежности; в `updateProjectiles` нет ветки попадания по игроку;
  `applyContinue` не знает о вражеских снарядах.
- [ ] Нет `projectile-look.ts`, текстуры `bh-projectile-enemy`, формы `bolt`,
  цветов `enemyProjectile` и `enemyProjectileCore`, поля `enemyShots`,
  массива `enemyCooldown` и лишних полей `ResolvedPatternParams`; тест по
  исходникам это проверяет.
- [ ] Эталоны (golden, сценарные, бота) и коридоры не изменились; перф-тесты и
  `pnpm budget` не хуже; `CONTENT_HASH` до и после совпал (оба значения в
  описании PR).
- [ ] `WORLD_SNAPSHOT_VERSION` и `RUN_SNAPSHOT_FORMAT` подняты, тесты на
  константах, старый снимок не читается, сохранение прежнего формата
  оболочка признаёт несовместимым.
- [ ] Документы и `CLAUDE.md` описывают то, что есть; поиск по `enemyShots`,
  `enemyProjectile`, `kite_and_shoot`, `caster` по репозиторию без `docs/`
  этапов 1–2 пуст.
- [ ] Дифф только в зонах; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `refactor(core-game): Убрать код вражеских снарядов`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — УБОРКА КОДА ВРАЖЕСКИХ СНАРЯДОВ**

  Движок больше не знает о снарядах врагов: после ухода огонька, кастера и второго босса без стрельбы они не встречались в контенте. Бой, звук и вибрация те же, эталоны не изменились.

  🛠 **Движок**

  • пул снарядов — только снаряды игрока, ветка попадания по игроку убрана
  • убраны вражеский вид снаряда, форма bolt и сигнал enemyShots
  • версии снимка забега подняты: сохранение прошлой сборки засчитывается как оборванный забег
  ```
