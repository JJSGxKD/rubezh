---
id: T-0196
title: Подстройка под силу — калибровка, слабое устройство в оболочке, аналитика и приём на сервере
epic: E10
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0195, T-0190, T-0192, T-0193, T-0197, T-0101, T-0102, T-0125, T-0182]
zones:
  - packages/core-game/src/content/pressure.ts
  - packages/core-game/src/content/balance-targets.ts
  - packages/core-game/src/game/balance/power-profiles.ts
  - packages/core-game/src/game/balance/simulate.ts
  - packages/core-game/src/game/balance/index.ts
  - scripts/balance/balance-sim.ts
  - packages/core-game/test/power-profiles.test.ts
  - packages/core-game/test/balance-properties.test.ts
  - scripts/test/power-profiles.test.ts
  - packages/app-shell/src/state/device.ts
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/test/device-class.test.ts
  - packages/app-shell/test/run-device-class.test.ts
  - packages/app-shell/test/run-outcome.test.ts
  - backend/api/src/modules/diagnostics/dto/run-report.dto.ts
  - backend/api/src/modules/export/export.service.ts
  - backend/api/test/export.test.ts
  - scripts/test/run-report-schema.test.ts
  - scripts/test/event-dictionary.test.ts
shared:
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/32-balance.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 2
---

# T-0196. Подстройка под силу — калибровка, слабое устройство в оболочке, аналитика и приём на сервере

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0196.json)](README.md#значки-статуса) [![T-0195](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0195.json&label=T-0195)](T-0195-player-power-pressure-engine.md) [![T-0190](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0190.json&label=T-0190)](T-0190-single-difficulty-shell.md) [![T-0192](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0192.json&label=T-0192)](T-0192-pressure-after-minute-8.md) [![T-0193](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0193.json&label=T-0193)](T-0193-longer-run-progression.md) [![T-0197](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0197.json&label=T-0197)](T-0197-second-boss-no-projectiles.md) [![T-0101](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0101.json&label=T-0101)](T-0101-card-reroll-skip-banish.md) [![T-0102](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0102.json&label=T-0102)](T-0102-weapon-evolutions-data-and-engine.md) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](T-0125-run-result-rank-chest-crystal-counters.md) [![T-0182](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0182.json&label=T-0182)](T-0182-cordon-ring-analytics.md)

## Зачем

T-0195 дала движку механизм и рабочие числа. Эта задача делает его настоящим:
измеряет подстройку на трёх профилях силы («новичок», «средний», «полный
арсенал») и подгоняет числа так, чтобы бой был напряжён для каждого; учит
оболочку отличать слабый телефон и передавать это движку; отправляет силу
игрока в аналитику, чтобы после выката видеть, кому какое давление досталось;
и учит сервер принимать новое поле в записи забега.

## Решения

Р131, Р65, Р67, WP34 (`docs/35-stage4-plan.md`) и решения пользователя и
`claude-lead-1` от 21.10.2026. Исполнитель их не пересматривает. Пределы и
коридоры ниже **фиксированы**; числа контента подбираются внутри пределов.

1. **Профили силы — из реальных данных контента** (`game/balance/
   power-profiles.ts`, данные, не вычисление на лету: тест на сервере
   сверяет их с каталогом предметов):

   | Профиль | Уровень аккаунта | Снаряжение | Бусты |
   |---|---|---|---|
   | `novice` («новичок») | 1 | нет | нет |
   | `average` («средний») | 8 | шесть редких предметов 10-го уровня, броски 0,8 | нет |
   | `full` («полный арсенал») | верхняя строка `ACCOUNT_UNLOCKS` (сейчас 14) | шесть легендарных предметов на потолке уровня предмета для этого уровня аккаунта (`levelCap`, сейчас 19), броски 1,0 | `fury`, `bulwark`, `aegis` |

   Набор предметов «канонический»: по слоту из `ITEM_SLOTS` берётся главное
   свойство слота и первые `extras` свойств его пула (число — из
   `RARITY_RULES`), все с одним броском; прибавки складываются `loadoutOf`.
   Получается (проверено при написании задачи):
   `average` — `{ damage 0.1072, cooldown 0.0714, area 0.143, statusChance
   0.0893, damageFire 0.0893, damageCold 0.0893, maxHp 21.44, armor 1.0718,
   regenPerSec 0.3572, pickupRadius 0.2144, moveSpeed 0.0357 }`;
   `full` — `{ damage 0.262, cooldown 0.1748, area 0.3494, projectileSpeed
   0.4368, duration 0.3494, statusChance 0.4368, damageFire 0.2184,
   damageCold 0.2184, damageLightning 0.2184, damagePoison 0.2184, maxHp
   52.42, armor 2.6208, regenPerSec 1.3104, resistFire 0.262, resistCold
   0.262, pickupRadius 0.5242, moveSpeed 0.0874 }`. «Средний» — предположение
   о типичном игроке (вопрос 7). Вариант «слабое устройство» любого
   профиля — тот же набор с `deviceClass: "light"`.
2. **Коридоры калибровки (фиксированы)** — блок `BALANCE_TARGETS.pressure`.
   Все медианы — уклоняющегося бота на «Сложной» (`hard`), стартовые оружия
   первого уровня аккаунта, те же seed, что у остальных сценариев:

   | Коридор | Значение |
   |---|---|
   | базовая медиана `baselineMedianSec` | медиана бота **без набора** (подстройка выключена) на `hard` — замер первым коммитом |
   | `average` / базовая | 0,85–1,15 |
   | `novice` и `full` к `average` | 0,7–1,4 каждый |
   | разброс трёх профилей (наибольшая медиана / наименьшая) | не больше 1,5 |
   | `average` на слабом устройстве к `average` на обычном | 0,85–1,15 |
   | пик врагов на слабом устройстве | не больше `caps.light + 8` (запас на распад) и, если на обычном пик не ниже `1,25 × caps.light`, не больше 0,8 от него |
   | уровни давления `L` | новичок 0,76–0,85; средний 0,9–1,1; полный 1,2–1,3 |
   | бот без набора | **побитово как до задачи** (golden «Сложной» T-0192 не меняется) |

   Строка «без подстройки» (`pressure: false`) печатается рядом для
   сравнения: она показывает, насколько разброс сжат, но коридором не
   является.
3. **Что подбирается и в каких пределах** (рабочие значения T-0195 — исходная
   точка), строго в таком порядке:
   1. `buildSchedule` — из прогона: раздел «Расписание сборки» в
      `balance-sim.ts` (бессмертный бот профиля `average`, подстройка
      выключена, до 1200 с, медиана `buildScore` по seed на сетке 0, 120,
      300, 600, 900, 1200 с, округление до 0,05; расписание не убывает).
   2. `reference` — так, чтобы `L(average)` лежал в 0,9–1,1 и выполнялся
      коридор «средний к базовой». Диапазон `reference`: 1,7–2,4.
   3. `spanDown` (диапазон 3–10) и `spanUp` (6–20) — так, чтобы `L(novice)` и
      `L(full)` попали в свои коридоры уровней.
   4. `levers.hp` (0,5–1,2), `levers.damage` (0,3–1,0) — под коридор разброса.
   5. `levers.spawn` (0,3–1,0), `levers.alive` (0,2–0,6).
   6. `levers.stageShiftSec` (150–450), `levers.leadPerLevel` (3–5).
   7. Слабое устройство: `caps.light` (120–200, не меньше 60),
      `hpComp` (0,3–0,8), `damageComp` (0,2–0,6), `compensateFromSec`
      (180–330), `maxShortfall` (2–3).
   Не подбираются: `minLevel` 0,75 и `maxLevel` 1,3, `caps.standard` 360,
   `leads`, веса `power.*` (кроме `buildSchedule`), сами профили.
   Не держится коридор на краю всех допустимых диапазонов — остановиться и
   написать вопрос черновиком PR (таблица замеров по профилям, по строкам
   этого списка), бота и чужой контент не править. Если «средний» не держит
   коридор из-за своего определения (он слабее бота без набора, у которого
   открыто всё), допустимо сместить **его** вверх по фиксированному списку —
   8-й уровень → 11-й → 14-й и «редкие 10-го» → «эпические 12-го» — и
   пересчитать литерал и тест; смещение называется в описании PR.
4. **Класс устройства определяет оболочка**, один раз на старте забега, не
   сохраняя: `deviceClassOf(env)` в `state/device.ts`. Слабое — форм-фактор не
   `desktop` и (`memoryGb ≤ 2` или `cores ≤ 4`); нет сведений — обычное.
   Пороги рабочие. В набор забега кладётся `deviceClass: "light"` только для
   слабого; обычному поле не пишется (решение 2 T-0195). Забег разработчика
   идёт без уровня аккаунта и без подстройки — слабое устройство на нём не
   проверить (вопрос 5). Динамического определения по частоте кадров нет:
   класс влияет на бой и обязан быть известен до старта и записан.
5. **Аналитика (сначала словарь).** Поля плоские, необязательные, версия
   событий прежняя (сервер пропускает новые поля):

   | Событие | Новые поля |
   |---|---|
   | `run_started` | `power` — очки силы на старте (число, до сотых); `pressure` — уровень давления на старте (до сотых); `deviceClass` — `standard` или `light` |
   | `run_finished`, `run_abandoned` | `power`, `pressure` (те же, на старте), `powerEnd`, `pressureEnd` (на конец забега), `deviceClass` |

   Поля шлются, только если движок вернул `pressure` (набор с уровнем
   аккаунта); забег разработчика и прежние сборки их не несут. Источник —
   `started.pressure` и `result.pressure` из T-0195. Событие `run_started`
   теперь отправляется из обработчика `started` движка (там уже есть сила),
   а не сразу после `engine.start` — и на «Ещё раз» тоже, одно место вместо
   двух.
6. **Лимит ключей payload.** У `run_finished`/`run_abandoned` сейчас около 30
   плоских ключей, ещё четыре добавит T-0125, по одному — T-0119 и T-0120, и
   пять эта задача; общий потолок `MAX_PAYLOAD_KEYS = 40` в словаре событий
   был бы пробит. Решение: потолок поднимается до 48 с комментарием «почему»
   (перф-поля, урон по стихиям и счётчики боя растут вместе), а тест в
   оболочке собирает самый полный payload итога и требует, чтобы он был не
   длиннее `MAX_PAYLOAD_KEYS − 4`.
7. **Сервер: приём и выгрузка.** Схема записи забега принимает
   `loadout.deviceClass`; выгрузка `runs.csv` получает колонки `power`,
   `pressure`, `deviceClass`. В таблицы забегов и рейтинг сила **не пишется**
   (это очки эффективности WP35, отдельная задача).
8. **Игроку подстройка не показывается** (решение `claude-lead-1`): ни в
   оболочке, ни в гайдбуке, ни в списке «Что нового» (раздела «Для игроков» в
   PR нет).

## Как сейчас

Описано по `dev` на 21.10.2026; к началу задачи влиты T-0195 и зависимости.
Строки могли сдвинуться — искать по именам.

- Контент и движок подстройки — T-0195: `content/pressure.ts` (`PRESSURE`),
  `game/sim/player-power.ts`, `game/sim/pressure.ts`; `RunLoadout.deviceClass`;
  `RunEvents.started.pressure`; `RunResult.pressure`. Подстройка включена,
  только если у набора есть `accountLevel`.
- `game/balance/simulate.ts` после T-0192 и T-0193: умолчание сложности
  `"hard"`; опции `godMode`, `stopOnBuild`, `immortalPlayer`; результат —
  `buildCompleteSec`, `damageTakenByMinute`; мир собирается своим вызовом
  `createWorld` (не через `createRunWorld`) **без** `loadout`, `boosts` и
  `pressure`; опция `accountLevel` только открывает оружие и навыки (в набор
  не попадает, поэтому подстройки не включает). Бот без набора — это и есть
  «база» калибровки T-0192.
- `scripts/balance/balance-sim.ts`: сценарии `Scenario`, `BASE_DIFFICULTY_ID`
  (после T-0192 — `hard`), `corridorLines`, `levelLines`, разделы «Сборка
  набора» (T-0193) и «Давление после 8-й минуты» (T-0192). Стартовые оружия —
  оружие первого уровня аккаунта (`unlocksAt(ACCOUNT_UNLOCKS, 1).weapons`).
- `content/balance-targets.ts`: коридоры «Сложной», блоки `tutorial` и
  `latePressure` (T-0192), коридор сборки (T-0193).
- `test/balance-properties.test.ts`: свойства бота на «Сложной», хелперы
  `dodgingRuns()` и `tutorialRuns()` (T-0192).
- `app-shell/src/state/device.ts`: `describeDevice`, `osOf`, внутренняя
  `formFactorOf` (не экспортирована), `readEnvironment` (`cores`,
  `memoryGb` из `navigator`; `memoryGb` есть не везде — `null`).
- `app-shell/src/state/run.ts`: старт — `engine.start({ … loadout: { modifiers,
  boosts, accountLevel } })` (≈ 314–345), два вызова `track("run_started", …)`
  — после старта (≈ 370) и в `restartSession` (≈ 495); обработчик `started`
  (≈ 530) вызывает `bindLoadout` и `useRuns.getState().registerStart`;
  `outcomeFields(result, isNewRecord)` (≈ 719) собирает плоские поля итога.
- `backend/api/src/modules/diagnostics/dto/run-report.dto.ts`: `loadoutSchema`
  (≈ 92) — `modifiers`, `boosts`, `accountLevel`; `z.object` без `strict`:
  неизвестное поле молча срезается, поэтому без правки повтор у команды
  потерял бы класс устройства, а тест `toEqual(recording)` это поймает.
- `backend/api/src/modules/events/event-dictionary.ts`: `run_started`
  (≈ 118), общий `runOutcome` (≈ 52), `MAX_PAYLOAD_KEYS = 40`.
- `backend/api/src/modules/export/export.service.ts`: `RUN_COLUMNS` (≈ 50)
  для `runs.csv`.
- Каталог предметов — `backend/api/src/modules/items/item-catalog.ts`,
  правила — `item-rules.ts` (`loadoutOf`, `levelCap`, `statValue`).

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»). Отдельным вторым коммитом —
   **замер до правок**: профили и опции симуляции (шаги 2–3) без изменения
   чисел контента; `pnpm balance:sim` → `baselineMedianSec` (медиана бота без
   набора на `hard`) в `balance-targets.ts` с комментарием (дата, seed,
   оружие). Таблицу замера сохранить.
2. **`game/balance/power-profiles.ts`** (новый): `POWER_PROFILES` — три
   профиля решения 1 (`id`, `titleRu`, `loadout: RunLoadout`) и
   `withDevice(profile, deviceClass)`. Уровень `full` берётся из
   `ACCOUNT_UNLOCKS` (максимум `level`), а не литералом. Комментарий «почему»:
   профили — данные, их проверяет тест на сервере. Экспорт в
   `balance/index.ts`.
3. **`game/balance/simulate.ts`.**
   - Опции: `loadout?: RunLoadout` (в мир; уровень аккаунта для открытого
     берётся из него, иначе из `accountLevel`), `pressure?: boolean`
     (по умолчанию `true`; `false` — подстройка выключена, для строки «без
     подстройки»).
   - Мир получает `pressure: PRESSURE` (кроме `pressure: false`), `boosts:
     BOOSTS`, `maxBoostsPerRun: MAX_BOOSTS_PER_RUN`, `loadout`.
   - Результат: `startPower`, `startPressure`, `endPressure` (при выключенной
     подстройке — 0, 1 и 1) и `buildScoreByMinute: number[]` — значение
     `buildScoreOf(world)` на каждой полной минуте, как `damageTakenByMinute`
     (поле для раздела «Расписание сборки»).
   - Бот без `loadout` идёт ровно как раньше: тест решения 2 «бот без
     набора — побитово» это держит.
4. **`content/balance-targets.ts`:** блок `pressure` с коридорами решения 2
   (`as const`, комментарий «зафиксированы до калибровки»), в нём
   `baselineMedianSec` из замера.
5. **`scripts/balance/balance-sim.ts`:**
   - Раздел «Подстройка под силу (Р131)»: профили × (подстройка включена,
     выключена) × устройство (обычное; слабое — только `average`), все
     стартовые оружия, 10 seed. Таблица: медиана, p10, p90, пик врагов,
     `L` в начале и в конце. Ниже вердикты по коридорам решения 2 в формате
     `verdict(...)` скрипта, в конце — строка «разброс без подстройки / с
     подстройкой».
   - Раздел «Расписание сборки»: бессмертный бот (`godMode` и `maxSec: 1200`
     из T-0193), профиль `average`, `pressure: false`; таблица медиан
     `buildScoreByMinute` на сетке из решения 3.1.
   - Сам скрипт ничего не утверждает и не падает (как раньше).
6. **Калибровка** по порядку решения 3. После каждой группы чисел —
   `pnpm balance:sim` (раздел «Подстройка под силу»), сохранить таблицу.
   Правится только `content/pressure.ts`.
7. **Словарь событий — сначала документ.** `docs/22` §3.3: поля решения 5 у
   `run_started` и `run_finished`/`run_abandoned`, абзац в «Уточнениях
   существующих событий» (что такое `power` и `pressure`, что без набора
   полей нет, что по ним можно резать распределения длины забега). Затем
   `event-dictionary.ts`: необязательные `power: amount`, `pressure: amount`,
   `powerEnd: amount`, `pressureEnd: amount`, `deviceClass: id`; потолок
   `MAX_PAYLOAD_KEYS` — 48 с комментарием.
8. **Определение слабого устройства.** `state/device.ts`: экспортировать
   `formFactorOf`, добавить `deviceClassOf(env: DeviceEnvironment =
   readEnvironment()): DeviceClass` по решению 4 (константы порогов —
   именованные, с комментарием «почему»: `deviceMemory` Chromium округляет
   до 0,25…8 ГБ, у Safari его нет, а ядер на старых iPhone и дешёвых Android
   четыре и меньше).
9. **Старт и события в оболочке (`state/run.ts`).**
   - В набор забега (`loadout` в `engine.start`) — `...(deviceClassOf() ===
     "light" ? { deviceClass: "light" as const } : {})`; для забега
     разработчика (нет уровня аккаунта) поле тоже не нужно — оно ничего не
     делает.
   - Убрать оба вызова `track("run_started", …)`; в обработчике `started`
     после `registerStart` вызвать `track("run_started", { seed, weapon:
     started.startingWeaponId, map, difficulty: started.difficultyId,
     screenMode, orientation, devMode, ...pressureFields(started.pressure) })`.
     `seed`, карта, режим и ориентация берутся там же, откуда брались у
     удалённых вызовов (`startOptions`, `get()`); для «Ещё раз» сид — новый
     (`get().seed`).
   - `outcomeFields`: `...(result.pressure === undefined ? {} : { power,
     pressure, powerEnd, pressureEnd, deviceClass })` (имена из решения 5,
     числа из `result.pressure`).
10. **Сервер.** `run-report.dto.ts`: в `loadoutSchema` — `deviceClass:
    z.enum(["standard", "light"]).optional()` с комментарием «почему»
    (повтор без него разошёлся бы с забегом тестера). `export.service.ts`:
    колонки `power`, `pressure`, `deviceClass` в `RUN_COLUMNS` и в строку
    (пусто, если поля нет).
11. **Документы** (раздел «Документы») и гейт (`CLAUDE.md`).

## Чего не трогаем

- Механизм подстройки: формулы, структура `PressureDef`, `player-power.ts`,
  `pressure.ts`, директор, таймлайн, ступени (T-0195). Правится только
  **значение** чисел в `content/pressure.ts` и расписание сборки.
- Веса очков, `minLevel`, `maxLevel`, `caps.standard`, `leads` — не
  подбираются.
- Бота калибровки (`game/balance/bot.ts`), его параметры, прежние коридоры
  («Сложная», `tutorial`, `latePressure`, сборка набора) и golden «Сложной»
  T-0192.
- Контент врагов, ступеней, таймлайна и кривой (T-0192, T-0197), прокачку
  (T-0193, T-0194).
- Очки эффективности и рейтинг (WP35): в таблицы забегов силу не пишем.
- Запись забега и повтор в движке (`RunRecorder`, `replay.ts`): класс
  устройства уже едет внутри набора.
- Экраны и тексты: ни настроек «слабое устройство», ни подсказок, ни строк в
  гайдбуке. Переключатель для тестеров — вопрос 5.
- Пороги `scripts/bundle-budget.mjs`.

## Сценарий и интерфейс

Экранов нет. Игрок ничего не замечает, кроме того, как играется бой; слабый
телефон получает меньше врагов, но они крепче. Загрузки, пустого, ошибки и
сети у задачи нет.

## Тесты

Первым коммитом, до кода.

`packages/core-game/test/power-profiles.test.ts` (новый, на реальном
контенте):

- **профили:** `novice` — `{ modifiers: {}, boosts: [], accountLevel: 1 }`;
  `average.accountLevel` — 8; `full.accountLevel` — максимум `level` в
  `ACCOUNT_UNLOCKS`; `full.boosts` — `fury`, `bulwark`, `aegis`, и все они есть
  в `BOOSTS`; `sanitizeLoadout(profile.loadout)` равен самому набору (ничего не
  срезается пределами); `withDevice(profile, "light")` меняет только
  `deviceClass`;
- **уровни давления на реальном контенте** (`createRunWorld` с набором
  профиля): `L(novice)` 0,76–0,85, `L(average)` 0,9–1,1, `L(full)`
  1,2–1,3, порядок строгий; очки растут от новичка к полному;
- **слабое устройство:** мир `average` с `deviceClass: "light"` имеет
  `difficulty.maxAlive` не больше `PRESSURE.devices.caps.light` на отрезке с
  желаемым потолком выше него, а без `deviceClass` — больше;
- **бот без набора не меняется:** `simulateBalanceRun({ seed: 3, skill:
  "dodging", maxSec: 240 })` равен тому же вызову с `pressure: false` и тому
  же вызову с `accountLevel: 14` (открытие без набора подстройки не
  включает);
- **профиль включает подстройку:** с `loadout: POWER_PROFILES.novice.loadout`
  результат отличается от `pressure: false`, `startPressure` меньше 1;
  детерминизм: два одинаковых вызова дают равный результат;
- `buildScoreByMinute` — длина `floor(survivalSec / 60)`, значения от 0 до 1.

`packages/core-game/test/balance-properties.test.ts`: свойства по коридорам
решения 2 на тех же seed и оружии, что у `dodgingRuns()` (хелпер
`profileRuns(profile, device?, pressure?)`): `average` к базовой медиане
0,85–1,15; `novice` и `full` к `average` 0,7–1,4; разброс не больше 1,5;
`average` на слабом устройстве к обычному 0,85–1,15; пик врагов на слабом
устройстве — по решению 2. Тест идёт в обычном гейте: добавленное время
файла не больше 40 секунд — иначе число оружий в хелпере урезается до одного
(`spark`) и это называется в PR. Прежние свойства («Сложная», `tutorial`,
`latePressure`) зелёные без правок.

`scripts/test/power-profiles.test.ts` (новый): канонический набор из
`backend/api/src/modules/items/item-rules.js` и `item-catalog.js` (по
слоту: главное свойство и первые `extras` свойств пула, один бросок) для
`average` (`rare`, 10-й уровень, бросок 0,8) и `full` (`legendary`,
`levelCap(topLevel)`, бросок 1) даёт `loadoutOf(...)`, совпадающий с
`POWER_PROFILES` по каждому параметру (`toBeCloseTo(…, 4)`); уровень
предмета профиля не выше `levelCap(accountLevel)`; при расхождении сообщение
печатает вычисленные числа, чтобы вставить их в литерал.

`packages/app-shell/test/device-class.test.ts` (новый): таблица окружений
(`DeviceEnvironment` с `userAgent`, `maxTouchPoints`, экран, `cores`,
`memoryGb`): Android, 8 ядер, 4 ГБ — обычное; Android, 8 ядер, 2 ГБ — слабое;
Android, 4 ядра, память неизвестна — слабое; Android, 6 ядер, память
неизвестна — обычное; iPhone, 6 ядер — обычное; iPhone, 2 ядра — слабое;
iPad, 8 ядер — обычное; Windows с мышью, 2 ядра, 2 ГБ — обычное (десктоп не
слабый); пустые сведения — обычное.

`packages/app-shell/test/run-device-class.test.ts` (новый, по образцу
`run-boosts.test.ts`, `deviceClassOf` подменён моком модуля): слабое устройство
— `loadout.deviceClass === "light"` вместе с `accountLevel`; обычное — ключа
`deviceClass` в наборе нет; продолженный забег набор не передаёт (как сейчас).

`packages/app-shell/test/run-outcome.test.ts`: событие `started` с
`pressure { power: 2.01, level: 1, deviceClass: "standard" }` порождает один
`run_started` с полями `power`, `pressure`, `deviceClass` и прежними
(`seed`, `weapon`, `map`, `difficulty`, `screenMode`, `orientation`,
`devMode`); `started` без `pressure` — `run_started` без новых полей; итог с
`pressure` несёт `power`, `pressure`, `powerEnd`, `pressureEnd`, `deviceClass`,
итог без него — не несёт; на «Ещё раз» (второе `started`) событие уходит
второй раз; **самый полный payload итога** (`outcomeFields` + `perfFields` +
`recovered` + `interrupted`) длиннее `MAX_PAYLOAD_KEYS − 4` не бывает.

`scripts/test/run-report-schema.test.ts`: запись с `loadout { modifiers: {},
boosts: [], accountLevel: 8, deviceClass: "light" }` разбирается схемой и
равна исходной; неизвестный класс отвергается.

`scripts/test/event-dictionary.test.ts`: `run_started` принимает `power`,
`pressure`, `deviceClass`; `run_finished` — все пять полей; отрицательное
`power` и нечисловое `pressure` отвергаются; новые поля необязательны
(старый payload принимается); `MAX_PAYLOAD_KEYS` не меньше 48.

`backend/api/test/export.test.ts`: заголовок `runs.csv` содержит `power`,
`pressure`, `deviceClass`; строка итога с полями несёт значения, без полей —
пустые ячейки.

Остальные тесты (в том числе golden «Сложной», сценарные эталоны,
`sim-purity`, `perf-budget`) зелёные без правок эталонов.

## Аналитика

Событий новых нет; к существующим добавлены необязательные поля (решение 5):

- `run_started` — `power`, `pressure`, `deviceClass`;
- `run_finished`, `run_abandoned` — `power`, `pressure`, `powerEnd`,
  `pressureEnd`, `deviceClass`.

Имена и смысл — сначала в `docs/22-analytics-and-metrics.md` §3.3, потом в
`event-dictionary.ts` и код (шаг 7). Запись событий не блокирует ответ
игроку — очередь клиента, как у всех. Меток Prometheus нет: `power` и
`deviceClass` в метки не идут (кардинальность). Разрез по ним для
геймдизайнера — запросы по `events`, отдельной витрины не заводим.

## Настройки и окружение

Нет. Числа — контент (`content/pressure.ts`), коридоры —
`content/balance-targets.ts`. Новых переменных окружения и ключей
`setting-catalog.ts` нет; `MAX_PAYLOAD_KEYS` — константа словаря, не
настройка.

## Документы

- `docs/32-balance.md`: §2.7 (T-0195) — итоговые числа и ссылка на профили;
  §3.1 — таблица коридоров профилей силы и слабого устройства; §3.2 — абзац
  «Замер …, после T-0196» с таблицей «до / после», строкой «без подстройки» и
  расписанием сборки; §3.3 — пояснение: golden и сценарные эталоны идут без
  набора, подстройка в них выключена.
- `docs/30-configuration-map.md`: строка про `content/pressure.ts` из T-0195
  дополняется профилями силы (`power-profiles.ts`), коридорами
  (`balance-targets.ts` → `pressure`) и порогами слабого устройства
  (`app-shell/src/state/device.ts` → `deviceClassOf`); строка про выгрузку
  `runs.csv` — три новые колонки.
- `docs/22-analytics-and-metrics.md`: шаг 7.
- `docs/35-stage4-plan.md` (Р131, WP34) правит тимлид.
- `docs/21-diagrams.md` не затрагивается (схем БД, пакетов, сервисов нет).

## Вопросы к тимлиду

Принято по умолчанию; `claude-lead-1` подтверждает или правит при слиянии
спецификации:

1. **Лимит ключей payload поднят с 40 до 48.** Без этого `run_finished` с
   полями T-0125, T-0119, T-0120 и этой задачи не проходит словарь целиком.
   Если лимит принципиален — часть перф-полей уходит в `run_report`.
2. **Силу не пишем в таблицы забегов и рейтинг** (WP35): только в события и
   выгрузку. Очки эффективности будут считать из записи.
3. **Расписание сборки выведено из бота**, а не из людей, как и вся
   калибровка (`docs/32-balance.md` §3.1). После выката сверить с живыми
   забегами; для этого нужен `buildScore` по отрезкам — в аналитику он не
   шлётся.
4. **«Для игроков» нет**, потому что подстройка не показывается (решение
   `claude-lead-1`); если журнал «Что нового» должен о ней говорить — строка
   `- изменено: …` добавляется при слиянии.
5. **Слабое устройство нельзя проверить на устройстве разработчика**: забег
   разработчика идёт без уровня аккаунта, а значит, без подстройки. Нужен ли
   переключатель в панели разработчика («играть как слабое устройство»),
   решает тимлид; пока слабое устройство ловится по аналитике `deviceClass`.
6. **Определение слабого телефона** (`memoryGb ≤ 2` или `cores ≤ 4`) —
   предложение; настоящую долю слабых покажет `deviceClass` в
   `run_started` после выката.
7. **Профиль «средний» (8-й уровень, редкие предметы 10-го)** — предположение.
   Настоящее распределение уровня аккаунта и снаряжения даёт аналитика после
   выката; профили тогда пересматриваются данными.
8. **Модификаторы забега T-0119 («Спешка» и «Инверсия»)** и испытание дня
   (T-0129) работают поверх подстройки; порядок множителей определит
   вторая из этих задач, добавив `depends_on: [T-0195]`.

## Критерии приёмки

- [ ] Профили силы в `power-profiles.ts` совпадают с каталогом предметов
  (тест на сервере) и лестницей `unlocks.ts`.
- [ ] `balance:sim` печатает разделы «Подстройка под силу (Р131)» и
  «Расписание сборки»; коридоры решения 2 выполнены на профилях
  (медиана среднего к базовой 0,85–1,15, разброс не больше 1,5, слабое
  устройство 0,85–1,15, уровни давления в диапазонах), таблица до и после — в
  описании PR и в `docs/32-balance.md` §3.2; либо PR черновиком с вопросом.
- [ ] Числа `content/pressure.ts` внутри пределов решения 3; `minLevel`,
  `maxLevel`, `caps.standard`, `leads` и веса очков не тронуты.
- [ ] Бот без набора и golden «Сложной» побитово прежние.
- [ ] Оболочка определяет слабое устройство и кладёт `deviceClass: "light"`
  в набор; обычному устройству поле не пишется.
- [ ] `run_started` уходит из обработчика `started` (и на «Ещё раз»), с силой;
  итоги несут силу на старте и в конце; словарь, документ и клиент сходятся
  (`scripts/test/event-dictionary.test.ts` зелёный), потолок ключей 48.
- [ ] Сервер принимает `loadout.deviceClass`; `runs.csv` — с тремя новыми
  колонками.
- [ ] Игроку подстройка нигде не показывается.
- [ ] Документы описывают то, что есть; дифф только в зонах; гейт
  (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Откалибровать подстройку под силу игрока`
- **Метка:** `release: minor`
- **Для игроков:** нет — подстройка игроку не показывается (раздела
  `## Для игроков` в описании PR нет)
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ПОДСТРОЙКА ПОД СИЛУ: КАЛИБРОВКА И АНАЛИТИКА**

  Подстройка давления под силу игрока откалибрована по трём профилям (новичок, средний, полный арсенал) и по слабому устройству. Оболочка определяет слабый телефон, в аналитике появились сила и уровень давления, сервер принимает класс устройства в записи забега.

  🛠 **Баланс и аналитика**

  • в balance:sim — разделы «Подстройка под силу» и «Расписание сборки»
  • run_started и итоги забега несут power, pressure и deviceClass
  • runs.csv получил колонки power, pressure, deviceClass
  • лимит ключей payload событий поднят до 48

  ❓ **Нужно от команды**

  • @владелец — сверить таблицу balance:sim до и после и коридоры профилей
  • @владелец — подтвердить вопросы 1, 4 и 5 из спецификации
  ```
