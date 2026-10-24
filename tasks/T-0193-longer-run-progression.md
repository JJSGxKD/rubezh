---
id: T-0193
title: Прокачка до 15-й минуты — кривая опыта, уровни навыков, поздние сундуки, слоты
epic: E10
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0101, T-0102, T-0116, T-0118, T-0125, T-0172, T-0192]
zones:
  - packages/shared-types/src/index.ts
  - packages/core-game/src/content/upgrades.ts
  - packages/core-game/src/content/chests.ts
  - packages/core-game/src/content/unlocks.ts
  - packages/core-game/src/content/balance-targets.ts
  - packages/core-game/src/game/progression/levels.ts
  - packages/core-game/src/game/sim/chests.ts
  - packages/core-game/src/game/balance/simulate.ts
  - packages/core-game/src/game/balance/build-complete.ts
  - packages/core-game/src/game/balance/index.ts
  - scripts/balance/balance-sim.ts
  - backend/api/src/modules/runs/run-rules.ts
  - backend/api/test/run-verdict.test.ts
  - packages/core-game/test/content.test.ts
  - packages/core-game/test/chests.test.ts
  - packages/core-game/test/build-complete.test.ts
  - packages/core-game/test/upgrade-changes.test.ts
  - packages/core-game/test/inspect.test.ts
  - packages/core-game/test/account-unlocks.test.ts
  - packages/core-game/test/run-summary.test.ts
  - packages/core-game/test/determinism.test.ts
  - packages/core-game/test/balance-properties.test.ts
  - packages/app-shell/test/level-unlocks.test.ts
shared:
  - docs/05-game-design.md
  - docs/30-configuration-map.md
  - docs/32-balance.md
  - CLAUDE.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 2
---

# T-0193. Прокачка до 15-й минуты — кривая опыта, уровни навыков, поздние сундуки, слоты

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0193.json)](README.md#значки-статуса) [![T-0101](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0101.json&label=T-0101)](archive/T-0101-card-reroll-skip-banish.md) [![T-0102](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0102.json&label=T-0102)](archive/T-0102-weapon-evolutions-data-and-engine.md) [![T-0116](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0116.json&label=T-0116)](archive/T-0116-freeze-pickup.md) [![T-0118](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0118.json&label=T-0118)](archive/T-0118-seventh-weapon-meteor-and-evolution.md) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](T-0125-run-result-rank-chest-crystal-counters.md) [![T-0172](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0172.json&label=T-0172)](T-0172-remove-shooting-enemies.md) [![T-0192](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0192.json&label=T-0192)](T-0192-pressure-after-minute-8.md)

## Зачем

Опытный игрок собирает набор целиком (все слоты на максимальных уровнях) за
несколько минут, и после этого уровни в забеге не дают выбора. Задача растягивает
сборку примерно до 15-й минуты, чтобы каждый уровень до этого был настоящим
выбором: круче кривая опыта поздних уровней, у навыков больше уровней с более
мелким шагом, поздние сундуки скромнее, на высоких уровнях аккаунта больше
слотов. И даёт инструмент, которым это измеряется: счётчик «набор собран» в
симуляции баланса и коридор под него.

## Решения

Р127 и Р129 (`docs/35-stage4-plan.md`, 20.10.2026) и решения тимлида того же
дня. Исполнитель их не пересматривает.

1. **Четыре рычага сразу** (Р129): кривая опыта поздних уровней, 6–8 уровней у
   навыков, скромнее поздние сундуки, больше слотов. Эволюции (T-0102) и
   переброс (T-0101) уже заведены и идут раньше; из этой задачи их не трогаем.
2. **Слоты (рабочие):** оружие 4, атака 3, защита 2, подвижность 1
   (`LOADOUT_LIMITS`). Второй слот подвижности невозможен без нового навыка
   (навыков подвижности два, правило «навыков больше, чем слотов»), поэтому он
   остаётся одним. Слоты приходят на существующих строках лестницы, новых
   уровней не заводим (правило «промежутки не больше трёх уровней» и «последняя
   строка — не позже 20-го» не нарушаются):
   - 6-й уровень: `slots: { passives: { defense: 2 } }` (к «Броне»);
   - 11-й уровень: `slots: { weapons: 4 }` (к «Жалу»);
   - 14-й уровень: `slots: { passives: { attack: 3 } }` (к «Закалке»).
   На последней строке слоты равны `LOADOUT_LIMITS`, это держит тест контента.
3. **Кривая опыта — под цель Р127** (ответ пользователя от 20.10.2026: цель
   «набор к 15-й минуте» главнее формы кривой). Разведка показала: с лишними
   слотами и уровнями набору нужно ≈ 70 выборов вместо ≈ 41, а нынешний хвост
   (×1,22 за уровень) к 15-й минуте столько уровней не даёт — набор не
   собирался бы никогда. Поэтому первые уровни дешёвые, как сейчас, а хвост
   после `fromLevel` **подбирается под коридор Р127 — и может стать положе
   нынешнего**. Форма в данных, не в коде баланса:
   `LevelCurveDef.late?: { fromLevel: number; growth: number }` — переход с
   уровня N на N+1 дороже предыдущего в `growth` раз, если N не меньше
   `fromLevel`; иначе в основной `growth`. Рабочие числа (калибруются по
   `balance:sim` в коридоре): `fromLevel: 25`, `late.growth` — от 1,05 до 1,24,
   первым пробуется 1,12. Основной участок (`baseXp`, `growth`) не меняется.
   Уровни всё равно приходят реже, чем на `v0.9`: набор растягивается с 8 до
   15 минут.
4. **Уровни навыков (рабочие числа, калибруются по `balance:sim` в
   коридоре):** у каждого навыка 6–7 уровней, шаг мельче нынешнего. Итог
   последнего уровня не сильнее нынешнего больше чем на треть (по прибавке,
   а не по множителю: у `might` потолок ×1,8, у `lodestone` ×3,4):

   | Навык | Сейчас | Рабочие значения |
   |---|---|---|
   | `might` | 1,1 … 1,6 (5) | 1,07; 1,14; 1,22; 1,31; 1,41; 1,52; 1,65 |
   | `haste` | 0,92 … 0,68 (5) | 0,94; 0,89; 0,84; 0,79; 0,75; 0,71; 0,67 |
   | `reach` | 1,1 … 1,6 (5) | 1,07; 1,14; 1,22; 1,31; 1,41; 1,52; 1,64 |
   | `volley` | 1; 2 | **без изменений** (снаряды целые: каждый уровень — снаряд; исключение вынесено в вопрос) |
   | `swiftness` | 1,08 … 1,3 (4) | 1,05; 1,10; 1,16; 1,22; 1,28; 1,34 |
   | `vitality` | 20 … 110 (4) | 15; 32; 52; 75; 100; 130 |
   | `mending` | 0,4 … 2,2 (4) | 0,3; 0,65; 1,05; 1,5; 2,0; 2,6 |
   | `lodestone` | 1,3 … 2,8 (4) | 1,2; 1,45; 1,75; 2,1; 2,5; 2,95 |
   | `ward` | 1; 2; 3 | 0,7; 1,4; 2,1; 2,8; 3,4; 4,0 |
   | `tempering` | 0,15 … 0,6 (4) | 0,1; 0,2; 0,3; 0,4; 0,5; 0,6 |

   Значение уровня по-прежнему итоговое, а не прибавка. Предел одного навыка
   в `findPassiveContentProblems` (12 уровней) не трогаем.
5. **Поздние сундуки скромнее:** новое необязательное поле
   `ChestsDef.late?: { afterSec; sizes; bossMinSize }`. С секунды `afterSec`
   забега (не включая схему `opening`, она всегда первая) размер сундука
   бросается по таблице `late.sizes`, а босс не опускается ниже
   `late.bossMinSize`. Рабочие числа: `afterSec: 600`, `sizes` 1: 95, 3: 4,5,
   5: 0,5, `bossMinSize: 3`. Средний размер `late` обязан быть меньше среднего
   размера основной таблицы (проверка контента). Случайность — тот же отдельный
   поток `world.chests.rng`, число обращений к нему не меняется: один бросок
   на сундук, как сейчас. `world.rng` не трогается (CLAUDE.md, «Как настроить
   сундук забега»).
6. **Коридор Р127 — относительный, а не секундами.** Бот калибровки не человек:
   на нынешнем контенте бессмертный бот собирает набор за 1000–2500 с (замер
   ниже), а живой игрок — за ≈ 8 минут. Секунды бота с минутами человека не
   сравниваются, поэтому цель — **во сколько раз позже** набор собирается у
   того же бота: от ×1,6 до ×2,3 к замеру до правок (8 → 15 минут = ×1,9).
   Замер до правок снимает исполнитель первым коммитом (шаг 1) и записывает в
   `balance-targets.ts`; коридор в секундах вычисляется из него.
7. **Измеряем бессмертным ботом на единой сложности.** Единая сложность
   (Р126) в коде пока — id `hard` (переходный порядок, id не меняются), набор
   множителей и пресс после 8-й минуты — T-0192, поэтому задача идёт после неё.
   Бот не умирает (`world.cheats.godMode`), иначе на «hard» он гибнет на второй
   минуте и до сборки не доживает.
8. **Если коридор недостижим на решённых рычагах — не менять решения.**
   Остановиться и вынести черновиком PR раздел `## Вопросы` с таблицей замеров
   (уровень бота по времени, число выборов для сборки, `buildCompleteSec` по
   seed). Сначала исчерпать подстройку, она решений не меняет. Порядок
   подстройки: хвост кривой (`late`, в пределах из п. 3) → таблица `late` сундуков →
   числа уровней навыков (не меньше 6 уровней, не выше потолка «на треть») →
   слоты не уменьшать без вопроса.

## Как сейчас

- `content/upgrades.ts`: `PASSIVES` — 3–5 уровней у навыков; `LOADOUT_LIMITS =
  { weapons: 3, passives: { attack: 2, defense: 1, mobility: 1 } }`;
  `LEVEL_CURVE = { baseXp: 6, growth: 1.22 }`.
- `game/progression/levels.ts:30-37` — `xpForLevel` умножением в цикле (не
  `Math.pow`: детерминизм между движками, CLAUDE.md). Порог растёт геометрически:
  уровень 20 — 263 опыта, 30 — ≈ 1 900, 37 — ≈ 9 400.
- `shared-types/src/index.ts:1050-1065` — `ChestsDef`, `:1122-1127` —
  `LevelCurveDef`.
- `game/sim/chests.ts:40-72` — `findChestsProblems`, `:111-114` — `dropChest`
  берёт `bossMinSize`, `:125-131` — `rollSize` бросает `drawWeighted(world.chests.rng,
  rules.sizes)`. `world.stats.elapsedSec` — секунда забега.
- `content/unlocks.ts` — лестница 1, 2, 3, 4, 6, 8, 11, 14; на 14-м потолок
  слотов. Уровни 15–20 отданы оружию поездов (T-0118 ставит `meteor` на 16-й).
- `backend/api/src/modules/runs/run-rules.ts:19` — `MAX_WEAPONS = 3`, копия
  `LOADOUT_LIMITS.weapons`; `scripts/test/run-rules.test.ts` падает при
  расхождении; `run-verdict.ts:93` режет забег «оружия больше слотов».
- `game/balance/simulate.ts` — `simulateBalanceRun`, результат без счётчика
  сборки; бот (`balance/bot.ts`) выбирает карточки по приоритету
  `weapon_level > weapon_new > passive_new > passive_level > heal`.
  `world.cheats.godMode` (`sim/world.ts:328, :458`) гасит урон по игроку.
- **Замер 20.10.2026** (dev до T-0101/T-0102, `spark`, пять seed, бессмертный
  бот на `hard`, 2700 с): уровень бота — 3 на 60-й секунде, 21 на 360-й, ≈ 29 на
  660-й, 36–43 на 1500-й и дальше почти стоит (≈ 37–44): хвост кривой 1,22
  съедает весь приток опыта. Набор собран на 1039, 1080, 1716, 2513 с, у одного
  seed не собран за 2700 с; медиана ≈ 1716 с. Сейчас для сборки нужно ≈ 41
  выбор, после задачи — ≈ 70 (4 оружия × 8 + 3 × 7 + 2 × 6 + 1 × 6 минус
  стартовое), а на неизменной кривой бот выше ≈ 44-го уровня не поднимется.
  Исполнитель замер повторяет и подменяет своим.
- Тесты, где зашиты нынешние числа навыков: `inspect.test.ts:38`
  (`["might", 2, 1.2]`), `upgrade-changes.test.ts:84` (`might` 1 → 2),
  `content.test.ts:342` (навыки первого уровня), `level-unlocks.test.ts`
  (`nextUnlockAfter(4)`, `nextUnlockAfter(14)`).

## Шаги по порядку

1. **Тесты — первым коммитом** (раздел «Тесты»). Следом отдельным коммитом —
   **замер до правок**: только счётчик (шаг 2) без изменения контента; `pnpm
   balance:sim` с новым сценарием → число в `balance-targets.ts`.
2. **Счётчик сборки.**
   - `game/balance/build-complete.ts` (новый): `isBuildComplete(world): boolean` —
     занято `world.loadoutLimits.weapons` слотов оружия и по `loadoutLimits.passives[категория]`
     слотов каждой категории; у каждого оружия `level >= type.levels.length`
     (эволюция из T-0102 имеет один уровень и считается собранной), у каждого навыка
     то же. Экспорт из `balance/index.ts`.
   - `simulate.ts`: в `BalanceRunOptions` — `godMode?: boolean` (после
     `createWorld` ставит `world.cheats.godMode = true`) и `stopOnBuild?: boolean`
     (прогон кончается, когда набор собран); в `BalanceRunResult` —
     `buildCompleteSec: number` (0 — не собран за прогон, как `firstLevelUpSec`) и
     `buildPicks: number` (сколько выборов уровня сделано к этому моменту).
     Проверка раз в тик после `stepWorld`, пока не собран (≤ 10 слотов, цена
     ничтожна). `summarizeRuns` — `medianBuildCompleteSec` по собранным и
     `buildCompleteRatio` (доля собранных).
3. **Коридор.** `balance-targets.ts`: `buildCompleteBaselineSec` (замер шага 1 с
   комментарием: дата, сид, оружие, сложность) и `buildCompleteRatio: { min: 1.6,
   max: 2.3 }`; вспомогательная `buildCompleteCorridorSec()` отдаёт границы в
   секундах. Не менее 60% seed должны собрать набор до `max × 1,15` секунд.
4. **`scripts/balance/balance-sim.ts`.** Раздел «Сборка набора (Р127)»: `dodging`
   с `godMode` и `stopOnBuild` на `hard`, `maxSec = ceil(baseline × ratio.max × 1,15)`,
   10 seed на оружие `spark`; в таблице медиана, p10, p90, доля собравших; строка
   вердикта «в коридоре / вне» по образцу `corridorLines`. Число seed и оружий
   урезать можно, если свод вырос более чем на 5 минут.
5. **Кривая.** `LevelCurveDef.late` (комментарий «почему» у поля),
   `xpForLevel` (умножение в цикле, поведение при `late === undefined` прежнее),
   `findLevelCurveProblems(curve): string[]` в `levels.ts` (экспорт, вызывает
   тест контента; `late.fromLevel` — целое от 10, `late.growth` > 1 — хвост
   может быть и положе основного участка, п. 3 «Решений», `growth` > 1). `content/upgrades.ts`: `LEVEL_CURVE` с `late` из «Решений».
6. **Навыки.** `PASSIVES` — значения из таблицы «Решений», комментарий в шапке
   про шаг и предел «на треть».
7. **Сундуки.** `ChestsDef.late`, `content/chests.ts` (поле + комментарий),
   `rollSize`/`dropChest`/`findChestsProblems` в `sim/chests.ts`:
   `const table = late !== undefined && world.stats.elapsedSec >= late.afterSec ? late : rules`;
   схема `opening` приоритетнее. Проверки: `afterSec` > 0, таблица как у
   основной, `late.bossMinSize` есть в `late.sizes`, средний размер `late` меньше
   основного.
8. **Слоты.** `LOADOUT_LIMITS`, три строки `unlocks.ts` (комментарий шапки:
   «слоты приходят на 6-м, 11-м и 14-м уровнях»), `backend/.../run-rules.ts`:
   `MAX_WEAPONS = 4` (комментарий не меняется), `run-verdict.test.ts`.
9. **Калибровка.** `pnpm balance:sim` до и после. Старые коридоры
   (`dodgingMedianSec`, смерти до минуты, первый уровень, `firstChestEventSec`)
   держатся: мельчий первый шаг навыков слабит начало, и если бот на лёгкой
   выходит из коридора, поднимать **первые** значения навыков внутри потолка
   «на треть», а не сами коридоры. Подбор чисел — в порядке «Решений», п. 8.
10. **Golden и документы.** Обновить `run-summary`, `determinism`, `inspect`,
    `upgrade-changes`, `level-unlocks` с пояснением в PR, документы (раздел ниже),
    гейт.

## Чего не трогаем

- Накопленный опыт **аккаунта** (`backend/api/src/modules/progress/progress-rules.ts`,
  свой `xpForLevel`) и награды за уровень: это не кривая уровней в забеге.
- Эволюции (T-0102), переброс/пропуск/изгнание (T-0101), «Предел» (T-0194),
  выпадение сундука и число сундуков на поле (`maxOnField`), схему `opening`,
  запасную награду.
- Множители единой сложности, ступени и давление (T-0192), кольца и стражей.
- Приоритет карточек бота (`bot.ts`); бот выбирает по-прежнему.
- Тексты навыков в `ru.json`: в них нет чисел уровней.
- `volley` — число уровней и значения (см. вопрос).
- Пороги `scripts/bundle-budget.mjs`.

## Сценарий и интерфейс

Экранов нет. Игрок замечает: карточки уровней идут дальше (у навыков 6–7
уровней), в гайдбуке автоматически выросло число слотов и уровней (данные
берутся из контента), на высоких уровнях аккаунта открываются четвёртое оружие,
третий слот атаки и второй слот защиты, после 10-й минуты сундуки в основном
одиночные. Загрузки, пустого и сетевого состояний нет. Проверить на 320 и
390 px, что ряд плашек слотов (`SlotSummary`) с четырьмя оружиями не ломает
вёрстку модалки выбора (`flex-wrap` уже есть); при разрыве — вопрос.

## Тесты

Первым коммитом (до кода падают).

`core-game/test/content.test.ts`:

- кривая: `xpForLevel(LEVEL_CURVE, n)` для n ≤ `late.fromLevel` равен прежней
  формуле `ceil(6 × 1,22^(n−1))` (формула повторена в тесте умножением);
  для больших n строго растёт до уровня 80; конечное число;
  `findLevelCurveProblems` пуст и ловит `late.growth <= 1`, дробный
  `fromLevel`, `growth <= 1`;
- навыки: у всех, кроме `volley`, от 6 до 8 уровней; значения строго улучшаются;
  шаг каждого уровня не больше наибольшего прежнего шага; итог последнего уровня
  не дальше от нейтрали больше чем на треть от прежней прибавки (таблица прежних
  итогов зашита в тесте; для `haste` — по 1 − значение); `tempering` ≤ 0,75;
- слоты: `LOADOUT_LIMITS` равен `{ weapons: 4, passives: { attack: 3, defense: 2,
  mobility: 1 } }`; в каждой категории навыков больше, чем слотов; оружия больше,
  чем слотов; `findUnlockProblems` пуст; на уровнях 5, 6, 10, 11, 13, 14 слоты
  открываются ровно как в «Решениях», на последнем уровне равны потолку;
- сундуки: `findChestsProblems(CHESTS)` пуст; средний размер `late` меньше среднего
  основной таблицы.

`core-game/test/chests.test.ts`:

- до `afterSec` размеры бросаются по основной таблице, с `afterSec` — по `late`
  (мир с `world.stats.elapsedSec` на границе: 599,9 и 600); схема `opening`
  выигрывает и после `afterSec`; босс не ниже `late.bossMinSize`;
- на каждый сундук один бросок `world.chests.rng` и ни одного `world.rng`
  (сравнить состояния потоков до и после, как в существующем тесте «убийство
  элиты … не сдвигает world.rng»);
- `findChestsProblems`: `afterSec <= 0`, пустая `late.sizes`, `bossMinSize` не из
  `late.sizes`, более щедрая `late` — каждое даёт сообщение с путём поля.

`core-game/test/build-complete.test.ts` (новый):

- `isBuildComplete`: ложно на старте; ложно, если один слот оружия ниже
  максимума; ложно, если слот навыка категории не занят; ложно, если навык не на
  максимуме; истинно, когда всё заполнено и на максимуме; границы слотов берутся
  из `world.loadoutLimits`, а не из глобальных; оружие с одним уровнем
  (эволюция) считается собранным;
- `simulateBalanceRun({ godMode: true, maxSec: 120 })`: игрок жив, `hp` не падает
  ниже максимума, `timedOut: true`, `buildCompleteSec` равен 0; два прогона того
  же seed дают то же число (детерминизм);
- `stopOnBuild` останавливает прогон в секунду сборки (набор собирается через
  `givePassive`/`giveWeapon` в созданном мире и проверяется функцией; сам
  `simulateBalanceRun` для этого случая не нужен).

`core-game/test/balance-properties.test.ts`: бессмертный бот на `hard` за 300 с
жив и берёт не менее 10 уровней; прежние свойства (пассивный умирает до 90 с,
медиана 150–480 с, смерти до минуты ≤ 20%) зелёные. Тяжёлый замер сборки — только
в `balance:sim`, в гейт не входит (прогон до 4 тыс. секунд).

`backend/api/test/run-verdict.test.ts`: `weaponCount: 4` — `ok`, `5` —
`rejected` с `weapons_over_slots`. `scripts/test/run-rules.test.ts` зелёный без
правок (копия сходится).

`app-shell/test/level-unlocks.test.ts`: ожидания лестницы обновлены (6-й уровень —
«Броня» и 2-й слот «Защита»; 11-й — «Жало» и 4-й слот оружия; 14-й — «Закалка» и
3-й слот «Атака»), `nextUnlockAfter(14)` по-прежнему `null` до появления 16-го
уровня T-0118.

`run-summary.test.ts`, `determinism.test.ts`, `inspect.test.ts`,
`upgrade-changes.test.ts`, `account-unlocks.test.ts` — обновить числа, где
падают, с пояснением дельты в PR.

## Аналитика

Новых событий нет. Правка контента меняет `CONTENT_HASH`, который уезжает в
`run_finished` и отделяет забеги до и после (`docs/22-analytics-and-metrics.md`
§5.3); прерванные забеги со старым отпечатком отбрасываются проверкой
`run-save.ts`. Отдельная строка в `docs/22` не нужна.

## Настройки и окружение

Нет. Все числа — контент (`content/*`), расходящегося с ним в бэкенде только
`MAX_WEAPONS`, его держит `scripts/test/run-rules.test.ts`.

## Документы

- `CLAUDE.md`, «Как настроить сундук забега»: поле `late` и правило «поздние
  скромнее»; «Как добавить оружие или пассивку»: у навыков 6–8 уровней (кроме
  целочисленных), `LevelCurveDef.late` одной строкой.
- `docs/32-balance.md`: §1 (строка про кривую и сундуки), §2.1 (слоты 4/3/2/1),
  §3.1 (строка таблицы коридоров «Сборка набора» и пояснение, почему коридор
  относительный), §3.2 (абзац «Замер …, после T-0193»: baseline, итог,
  таблица).
- `docs/05-game-design.md` (абзац про слоты по категориям): новые числа слотов.
- `docs/30-configuration-map.md`: в строку про `upgrades.ts` — `LEVEL_CURVE.late`;
  новая строка про `content/chests.ts` → `late`; про `BALANCE_TARGETS` —
  коридор сборки.
- `docs/35-stage4-plan.md` правит тимлид, не исполнитель.

## Критерии приёмки

- [ ] `LOADOUT_LIMITS` = 4 / 3 / 2 / 1, лестница `unlocks.ts` открывает слоты
      на 6-м, 11-м, 14-м уровнях, `MAX_WEAPONS` на сервере = 4.
- [ ] У всех навыков, кроме `volley`, 6–7 уровней, итог последнего не сильнее
      прежнего больше чем на треть.
- [ ] `LEVEL_CURVE.late` задан, прежние уровни до `fromLevel` стоят столько же.
- [ ] После `late.afterSec` сундуки бросаются по скромной таблице, `world.rng`
      не тронут, схема `opening` цела.
- [ ] `simulateBalanceRun` умеет `godMode`/`stopOnBuild` и отдаёт
      `buildCompleteSec`; `balance:sim` печатает раздел «Сборка набора» с
      вердиктом.
- [ ] Медиана сборки бессмертного бота на `hard` — в коридоре ×1,6–×2,3 к замеру
      до правок, не менее 60% seed собирают набор; либо PR черновиком с вопросом
      («Решения», п. 8).
- [ ] Прежние коридоры калибровки держатся.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; golden обновлены с
      пояснением дельты.

## PR

- **Заголовок:** `feat(core-game): Растянуть сборку набора до 15-й минуты`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: у навыков стало 6–7 уровней с мелким шагом, а набор собирается дольше`
  - `- новое: четвёртый слот оружия (11-й уровень аккаунта), второй слот защиты (6-й) и третий слот атаки (14-й)`
  - `- изменено: после 10-й минуты сундуки в основном одиночные`
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РАСТЯНУТЬ СБОРКУ НАБОРА ДО 15-Й МИНУТЫ**

  Прокачка внутри забега стала длиннее: у навыков больше уровней, позднее опыт дороже, поздние сундуки скромнее, на высоких уровнях аккаунта больше слотов.

  🛠 **Баланс**

  • слоты: оружие 4, атака 3, защита 2, подвижность 1
  • у навыков 6–7 уровней, итог последнего не сильнее прежнего больше чем на треть
  • в симуляции баланса появился счётчик «набор собран» и коридор сборки
  • золотые эталоны обновлены, отпечаток контента сменился

  ❓ **Нужно от команды**

  • @владелец — посмотреть таблицу «Сборка набора» в описании PR и подтвердить числа
  ```
