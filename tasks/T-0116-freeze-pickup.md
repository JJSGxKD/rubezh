---
id: T-0116
title: Подбор «Заморозка»: враги на поле замирают на 10 секунд
epic: E10
priority: P1
status: ready
owner:
author: claude-lead2-18
size: M
depends_on: [T-0099]
zones:
  - packages/core-game/src/content/drops.ts
  - packages/core-game/src/game/sim/freeze.ts
  - packages/core-game/src/game/sim/pickups.ts
  - packages/core-game/src/game/sim/step.ts
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/sim/events.ts
  - packages/core-game/src/game/sim/continue.ts
  - packages/core-game/src/game/run/cues.ts
  - packages/core-game/src/game/radar.ts
  - packages/core-game/src/game/render/looks.ts
  - packages/core-game/src/game/render/shapes.ts
  - packages/core-game/src/game/render/WorldRenderer.ts
  - packages/core-game/src/run-api.ts
  - packages/shared-types/src/index.ts
  - packages/app-shell/src/audio/recipes.ts
  - packages/app-shell/src/audio/sound-director.ts
  - packages/app-shell/src/state/haptics.ts
  - packages/app-shell/src/screens/sound-lab.tsx
  - packages/app-shell/src/screens/run/Radar.tsx
  - packages/app-shell/src/screens/run/DevSheet.tsx
  - packages/app-shell/src/screens/guide/GuideScreen.tsx
  - packages/app-shell/src/screens/guide/scenes.tsx
  - packages/app-shell/src/i18n/ru-guide.json
  - packages/app-shell/src/i18n/ru-team.json
  - packages/core-game/test/freeze-pickup.test.ts
  - packages/core-game/test/pickups.test.ts
  - packages/app-shell/test/audio.test.ts
  - packages/app-shell/test/haptics.test.ts
  - packages/app-shell/test/guide.test.ts
shared:
  - packages/core-game/test/radar.test.ts
  - packages/core-game/test/looks.test.ts
  - packages/core-game/test/cues.test.ts
  - packages/core-game/test/dev-mode.test.ts
  - packages/core-game/test/determinism.test.ts
  - packages/core-game/test/balance-properties.test.ts
  - docs/31-audio-and-haptics.md
  - docs/32-balance.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 2
---

# T-0116. Подбор «Заморозка»: враги на поле замирают на 10 секунд

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0116.json)](README.md#значки-статуса) [![T-0099](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0099.json&label=T-0099)](T-0099-run-chest-engine.md)

## Зачем

В забеге нет подбора, который даёт передышку без потерь: динамит убивает, магнит
собирает опыт, аптечка лечит. «Заморозка» — десять секунд, когда орда стоит и
её можно расстрелять, отойти или добежать до сундука (Р105, `docs/39` Б4).

## Решения

Р105 (`docs/35-stage4-plan.md`), `docs/39` Б4. Числа стартовые, калибрует
геймдизайнер. Исполнитель решений не пересматривает.

- **Данные — `DROPS.freeze` в `content/drops.ts`**, как у динамита; эффект — код.
- **Эффект.** Общий таймер мира `freezeTicks` (в тиках). Пока он идёт, живые
  враги не двигаются, не бьют касанием, не ведут таймеры паттернов (телеграф,
  фитиль, рывок) и не стреляют. Горение и яд тикают: заморозка не лечит.
- **Это не состояние холода.** В `step.ts:180` уже есть `cheats.freezeEnemies`
  (разработчик) и `isFrozen(world, i)` (холод у одного врага). Заморозка подбором —
  третья, общая; `elements.ts` и холод не переиспользуем.
- **Повторный подбор обновляет таймер до полного срока, не суммирует.** Больше
  одной заморозки на поле нет.
- **Босс стоит часть срока:** `bossDurationRatio` (0,5 — 5 с из 10). Рядовые и
  элита — весь срок.
- **Спавн идёт.** Новые враги и потомки делящихся рождаются замершими, до общего
  конца. Таймлайн не смещается. Вражеские снаряды в полёте не замирают.
- **Таймер тикает вместе с миром:** пауза и выбор улучшения его не съедают
  (`stepWorld` выходит по `isAwaitingChoice`). Второй шанс (`continue.ts`) его
  обнуляет.
- **Читаемость обязательна:** замершие враги холодного оттенка — сведения для боя,
  без переключателя. Волна при подборе и мигание за 2 с до конца — эффекты,
  под тем же переключателем, что магнит и динамит (`isWaveEvent`,
  `docs/27-design-system-and-app-shell.md` §7.1); без эффектов оттенок просто
  гаснет в конце.
- **Звук — `freeze` на шине `rewards`; вибрация — группа «подбор»**
  (`docs/31` §7), нового события вибрации нет. Таймера в HUD нет.

## Как сейчас

- `drops.ts`: `DROPS` — `gems`, `medkits`, `magnets`, `dynamite`; тип `DropsDef` —
  `shared-types/src/index.ts` (около 1000–1040).
- `sim/pickups.ts` (336 строк): `PICKUP_KIND` (31; после T-0099 сундуки 3–5),
  `findPickupContentProblems` (63), `rollPickups` (105; при нулевом шансе генератор
  не зовётся), `updatePickups` (182, `switch` по виду), `detonate` (281).
- `sim/step.ts`: `stepWorld` (41) тикает `invulnerableTicks`; `updateEnemies`
  (180): выход по `cheats.freezeEnemies`, тики статусов, `isFrozen`, паттерн, касание.
- `sim/events.ts`: `SIM_EVENT` до `shield: 7`; `run/cues.ts:60–70, 165–195`;
  `run-api.ts`: `RADAR_BLIP` (86; после T-0099 `chest = 5`), `RunDevPickup` (605),
  `RunCues` (620).
- Облик: `looks.ts` `PICKUP_LOOKS` (159); `shapes.ts` (173); `WorldRenderer.ts`
  волны (`"bh-dynamite"`, 142, 570) и `isWaveEvent` (582).
- Звук: `recipes.ts` (`dynamite`, 244), `sound-director.ts` (97), `haptics.ts`
  (`hapticForCues`, 70), `sound-lab.tsx:319`. Гайдбук: `GuideScreen.tsx` (125–180),
  `scenes.tsx` (158, 508), `ru-guide.json:22`. Радар: `radar.ts:22`, `Radar.tsx:97`.

## Шаги по порядку

Пункт — коммит.

1. **Тесты** (раздел «Тесты») — первым коммитом.
2. **Данные.** `DropsDef.freeze: { chance; eliteChance; maxOnField; durationSec; bossDurationRatio }`
   с комментариями «почему»; числа — таблица ниже; нейтральное умолчание с
   нулевым шансом в `create-world.ts:61`. `findPickupContentProblems`: шансы и
   `maxOnField` как у остальных, `durationSec` больше 0 и не больше 30,
   `bossDurationRatio` от 0 до 1. `DROPS` уже в хеше контента: старые записи
   диагностики дадут `content_mismatch` — штатно.
3. **Таймер.** Новый `sim/freeze.ts` (до 80 строк, без `Math.sin/cos/pow`):
   `startFreeze` (`freezeTotalTicks = Math.round(durationSec / TICK_SEC)`),
   `tickFreeze`, `isTimeFrozen(world, isBoss)` — босс стоит, пока прошло меньше
   `floor(total * ratio)` тиков. `world.ts`: поля и `stats.freezeCollected`.
   `step.ts`: `tickFreeze` рядом с `invulnerableTicks`; в `updateEnemies` после
   статусов, рядом с `isFrozen` — обнулить скорость и `continue`. Признак босса —
   из типа врага, рядом с `isElite`. `continue.ts`: сброс. Если `checksum.ts` и
   снимок забега перечисляют поля мира — добавить оба поля.
4. **Подбор.** `pickups.ts`: `PICKUP_KIND.freeze = 6` (следующий свободный после
   сундуков), проверка контента, `roll` **сразу после динамита** (порядок остальных
   не менять), `case` → `remove`, `startFreeze`, событие. `events.ts`:
   `SIM_EVENT.freeze = 8` (`radius` — как у магнита).
5. **Сигналы.** `cues.ts` и `RunCues.freeze` (сброс в `reset`); `RADAR_BLIP.freeze = 6`
   и `radar.ts`; `RunDevPickup` + `"freeze"` и обработчик `spawnPickup` (искать
   по имени); `DevSheet.tsx`.
6. **Облик.** `looks.ts`: `PICKUP_LOOKS` + `freeze` (холодный голубой, размер 1,25),
   `WORLD_COLORS.freezeWave`, `freezeTint`; `shapes.ts` — «ледяной кристалл»
   (шестилучевой, силуэт не как у аптечки, магнита, динамита); `WorldRenderer.ts` —
   волна `"bh-freeze"` (в `isWaveEvent`); оттенок замерших спрайтов меняется
   **только на переходах** (включение, выключение, мигание), не каждый кадр;
   мигание в последние 2 с — по чётности `floor(freezeTicks / 8)`. Проверить
   `run-perf.test.ts` и `bench-full-load.test.ts`. `Radar.tsx` — метка холодного тона.
7. **Звук и вибрация.** `recipes.ts`: `freeze` — `bus: "rewards"`, `level: 0.6`,
   `voices: 1`, `gap: 0.3`, `send: 0.5`, `dur: 1.6`; слои: три `bell` (2093 / 2637 /
   3136 Гц, `t` 0 / 0,06 / 0,12, `decay: 0.5`) и `hiss` (`highpass`, `f0: 7000`,
   `f1: 1500`, `glide: 0.5`, `seed: 131`); на слух довести в лаборатории.
   `sound-director.ts`: `if (cues.freeze > 0) add("freeze")` после динамита;
   `haptics.ts`: `cues.freeze > 0` — в группу «подбор»; `sound-lab.tsx` — генератор
   сигнала; `ru-team.json`: `soundLab.sound.freeze` — «Заморозка».
8. **Гайдбук.** `ru-guide.json`: `guide.pickup.freeze.name` — «Заморозка»,
   `.text` — «Враги на поле замирают на {seconds} с: не ходят и не бьют. Боссы
   стоят {bossSeconds} с. Горение продолжает жечь. Перед концом замершие
   мигают — успей отойти»; `GuideScreen.tsx` — строка с числами из `DROPS.freeze`;
   `scenes.tsx` — `PickupIcon` для `freeze`, тип расширить.
9. **Документы** (раздел «Документы»).

## Числа (стартовые, геймдизайнер калибрует)

| Что | Поле | Значение |
|---|---|---|
| Шанс с рядового | `freeze.chance` | 0,0025 |
| Шанс с элиты | `freeze.eliteChance` | 0,2 |
| Больше на поле | `freeze.maxOnField` | 1 |
| Срок, с | `freeze.durationSec` | 10 |
| Доля срока для босса | `freeze.bossDurationRatio` | 0,5 |

Шанс ниже динамита (0,003): заморозка сильнее, редкость держит её событием.
Бот подбирает её, как остальные подборы, поэтому медиана `pnpm balance:sim`
сдвинется — таблицу до и после приложить к PR.

## Чего не трогаем

- Состояние холода и стихии оружия, `cheats.freezeEnemies`.
- Директор спавна, таймлайн, вражеские паттерны, снаряды кастера.
- Сундуки и радар сундуков (T-0099, T-0100); достижения за подборы
  (T-0104…T-0107) — серверный счётчик подобранного там.
- Сервер и API: правок нет.

## Сценарий и интерфейс

Игрок видит холодный кристалл у трупа элиты, на радаре метка того же тона.
Касание: волна по экрану, звук, мягкая вибрация. Враги бледнеют и стоят, новые
у кольца тоже; за 2 секунды до конца мигают, потом идут. Вне забега строка в
гайдбуке; пауза и выбор улучшения срок не тратят.

## Тесты

Первым коммитом.

- `freeze-pickup.test.ts`: рой не меняет координат, пока таймер идёт, и идёт
  после; враг вплотную не бьёт, после — бьёт; таймеры рывка и фитиля подрывника
  не убывают; горящий враг теряет здоровье; рядовой и элита стоят весь срок,
  босс — долю; родившийся и потомок делящегося стоят; на `isAwaitingChoice`
  таймер стоит; второй шанс обнуляет; повторный подбор возвращает полный срок.
- `pickups.test.ts`: выпадение при шансе 1; `maxOnField = 1`; при `chance = 0`
  последовательность генератора как до задачи; подбор ставит
  `freezeTicks = round(durationSec / TICK_SEC)`, событие, `freezeCollected`;
  проверка контента ловит срок 0 и 31, долю −0,1 и 1,1, шанс 2.
- Детерминизм: один seed и сценарий подбора дают одинаковую контрольную сумму
  дважды; `sim-purity.test.ts` зелёный.
- `radar`, `looks`, `cues`, `dev-mode`: метка и облик у каждого вида; событие
  даёт `cues.freeze`; `spawnPickup` принимает `freeze`.
- `app-shell`: `audio.test.ts` — рецепт проходит схему лаборатории, `cues.freeze`
  даёт `freeze`; `haptics.test.ts` — «подбор», динамит сильнее; `guide.test.ts` —
  строка с числами из контента. Фикстуры `RunCues` получают `freeze: 0`.
- Golden и коридоры, сдвинутые броском, обновляются в этом же PR.

## Аналитика

Нет. Подбор внутри забега; `freezeCollected` живёт в `stats` мира рядом с
`dynamiteCollected`, новых событий и меток нет.

## Настройки и окружение

Нет. Числа — `content/drops.ts`, переключатель эффектов существующий.

## Документы

- `docs/31-audio-and-haptics.md`: §4 — «заморозки» в перечне сигналов; §7 —
  «подбор» включает заморозку.
- `docs/32-balance.md`: строка таблицы подборов и свод калибровки.
- `docs/27` §7.1 — только если появился новый пункт про эффекты.

## Вопросы к тимлиду

- Подтверждено claude-lead-1 13.10.2026 по умолчанию: спавн идёт, новые враги
  стоят до общего конца.
- Подтверждено claude-lead-1 13.10.2026 по умолчанию: вражеские снаряды в полёте
  не замирают; боссы стоят вполовину срока.
- Подтверждено claude-lead-1 13.10.2026 по умолчанию: таймера в HUD нет,
  конец показывает мигание.

## Критерии приёмки

- [ ] Подбор падает, подбирается и замораживает врагов на срок из контента (босса
  — на долю); горение идёт; новые враги стоят.
- [ ] Тест повторяемости и `sim-purity` зелёные.
- [ ] Облик, радар, звук, вибрация и гайдбук есть; эффект под переключателем.
- [ ] Эталоны и коридоры обновлены, в PR таблица `pnpm balance:sim`.
- [ ] Дифф только в зонах и в строках из «Документы»; гейт (`CLAUDE.md`),
  `pnpm budget` и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Добавить подбор «Заморозка»`
- **Метка:** `release: minor`
- **Для игроков:**
  - новое: подбор «Заморозка» — враги на поле замирают на 10 секунд
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОДБОР «ЗАМОРОЗКА»**

  С врагов выпадает новый подбор: враги на поле замирают на 10 секунд, боссы на 5. Числа стартовые.

  🛠 **Забег**

  • волна при подборе, бледные замершие враги, мигание перед концом
  • звук, вибрация, метка на радаре и строка в гайдбуке

  ❓ **Нужно от команды**

  • @владелец — прослушать звук в лаборатории и откалибровать шансы
  ```
