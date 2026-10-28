---
id: T-0321
title: Итог забега — самая долгая серия без попаданий и без убийств, убийства по стихиям; приём и проверка правдоподобия на сервере
epic: E16
priority: P2
status: in-progress
owner: claude-13 / sonnet-5.5 / high
author: claude-lead-1
size: M
depends_on: [T-0125]
zones:
  - packages/core-game/test/run-streaks.test.ts
  - backend/api/test/run-streaks.test.ts
shared:
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/sim/combat.ts
  - packages/core-game/src/game/sim/player-status.ts
  - packages/core-game/src/game/run/run-result.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/test/**
  - packages/shared-types/src/index.ts
  - packages/app-shell/src/state/runs.ts
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/state/downed-run.ts
  - packages/app-shell/src/screens/gallery.tsx
  - packages/app-shell/test/**
  - backend/api/src/modules/runs/run-counters.ts
  - backend/api/src/modules/runs/run-details.ts
  - backend/api/src/modules/runs/runs-hooks.ts
  - backend/api/src/modules/runs/dto/runs.dto.ts
  - backend/api/test/run-counters.test.ts
  - backend/api/test/runs.test.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/22-analytics-and-metrics.md
  - docs/39-retention-mechanics.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 4
---

# T-0321. Итог забега — самая долгая серия без попаданий и без убийств, убийства по стихиям; приём и проверка правдоподобия на сервере

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0321.json)](README.md#значки-статуса) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](archive/T-0125-run-result-rank-chest-crystal-counters.md)

## Зачем

Новым достижениям (Р161) нечем считать:
- «Без единой царапины» — нужны десять минут подряд без попадания;
- «Пацифист» — минута подряд без убийства;
- стихийники — убийства огнём, холодом, молнией и ядом.

В итоге забега сейчас есть урон по стихиям (`damageByElement`), но нет ни
серий, ни убийств по стихиям. После задачи движок считает три новых числа,
итог несёт их на сервер, сервер принимает их и проверяет правдоподобие тем
же приёмом, что счётчики T-0125. Виды цели и сами достижения — T-0322.

## Решения

Решение владельца — `docs/35-stage4-plan.md` Р161 (25.10.2026).

Решения `claude-lead-1` от 25.10.2026:

- **Три числа в итоге** (`RunResult`, `shared-types`), обязательные:
  - `noHitSec` — самая долгая серия без попадания, целые секунды вниз;
  - `noKillSec` — самая долгая серия без убийства, целые секунды вниз;
  - `killsByElement: Partial<Record<ElementId, number>>` — убийства по
    стихии добивающего удара. Физических нет, стихии без убийств не
    попадают — как в `damageByElement`.
- **Попадание** — любой урон, который дошёл до игрока сквозь неуязвимость:
  - удар касанием, взрывом, снарядом (`damagePlayer`, `world.ts`);
  - тик горения и яда (`inflictPlayerDot`, `player-status.ts`);
  - **попадание в щит буста** тоже считается: купленный щит не должен
    облегчать «Без единой царапины».

  Броня, сопротивление и бессмертие разработчика серию не спасают: счёт —
  до них. Неуязвимость после попадания или второго шанса гасит удар до
  счёта — такого попадания нет.
- **Серия без попаданий:**
  - начинается с первого тика забега и с каждого попадания;
  - в итог идёт максимум из закрытых серий и **текущей** на конец забега:
    игрок, который выстоял 10 минут и сдался, свою серию прошёл.
- **Серия без убийств** — «и выжил» (Р161):
  - начинается с первого тика забега и с каждого убийства;
  - в счёт идут **только закрытые убийством** серии: игрок жив, раз снова
    убил. Хвост от последнего убийства до смерти или сдачи не считается —
    иначе «отбежать минуту и сдаться» давало бы достижение.
  - Убийство — всё, что идёт через `killEnemy` (оружие, стихия, динамит).
    Враги, снятые вторым шансом, не убиты: продолжение их убирает без
    `killEnemy`.
- **Убийство по стихии** — стихия удара, который довёл здоровье до нуля
  (`inflictDamage`, `combat.ts`: стихия у него в параметре). Динамит и
  прочее без стихии — физическое, в `killsByElement` не попадает.
- **Счёт в тиках, а не в секундах.** Мир хранит `stats.lastHitTick`,
  `stats.longestNoHitTicks`, `stats.lastKillTick`, `stats.longestNoKillTicks`
  и `stats.killsByElement` (`Float64Array` по индексу стихии, как
  `damageByElement`). Секунды — только в `run-result.ts`:
  `Math.floor(ticks / TICK_HZ)`.
  - Пауза и ожидание решения о втором шансе тиков не двигают — серия по
    ним не растёт.
  - Счётчики не трогают `world.rng` и порядок событий: golden **не
    двигаются**. Сдвинулись — ищи ошибку, а не обновляй эталон.
- **Снимок** — `stats` кодируется целиком, поэтому новые поля переживают
  продолжение после перезагрузки. `WORLD_SNAPSHOT_VERSION` +1.
- **Сервер — тем же приёмом, что T-0125:**
  - поля в `stats` итога необязательные (старые сборки и очередь их не
    знают): `noHitSec`, `noKillSec`, `killsByElement`;
  - хранение — в `run.details` (jsonb), без миграции;
  - `RunCounters` получает три поля, отсутствующее — 0 и `{}`;
  - правдоподобие: `noHitSec ≤ survivalSec`, `noKillSec ≤ survivalSec`,
    сумма `killsByElement ≤ enemiesKilled`. Нарушение — та же причина
    `counters_implausible` T-0125: вердикт не меняется, счётчики не идут в
    задания и достижения.

## Как сейчас

- **После T-0125** — `Stats` с `bossKills`, `eliteKills`,
  `crystalsCollected`; `run-counters.ts` с `RunCounters`, `countersOf`,
  `countersPlausible`; `RecordedRun.counters`.
- **Попадание по игроку** — `damagePlayer` (`game/sim/world.ts:458`): ранний
  выход по неуязвимости, потом щит (`shieldHits--`), потом урон в
  `stats.damageTaken`. Тик горения и яда — `inflictPlayerDot`
  (`game/sim/player-status.ts:140`).
- **Убийство** — `inflictDamage` → `killEnemy` (`game/sim/combat.ts:57, 90`);
  стихия удара — параметр `element`, индексы — `ELEMENT_*` в `sim/elements.ts`.
- **Урон по стихиям** в итоге — `damageByElement` (`run-result.ts:78`):
  образец для `killsByElement`.
- **Тики** — `TICK_HZ = 60`, `world.stats.tick`.
- **Отправка итога** — `state/runs.ts` (`toSubmission`, схема очереди);
  событие `run_finished` — `state/run.ts`, словарь — `runOutcome` в
  `event-dictionary.ts:54`.

## Шаги по порядку

1. **Тесты первым коммитом** — раздел «Тесты».
2. **Движок:**
   - `world.ts`: поля в `Stats` с комментарием «что считает»; в
     `damagePlayer` — после проверки неуязвимости, **до** щита — закрыть
     серию без попаданий;
   - `player-status.ts`: то же в `inflictPlayerDot` после проверки
     неуязвимости;
   - `combat.ts`: в `inflictDamage` перед `killEnemy` — убийство по стихии;
     в `killEnemy` — закрыть серию без убийств;
   - `create-world.ts`: нули;
   - grep `damageTaken +=` и `killEnemy(` — других мест быть не должно.
3. **Снимок** — `WORLD_SNAPSHOT_VERSION` +1 (константу в тестах не
   хардкодить).
4. **Итог** — `shared-types` и `run-result.ts`; типизированные фикстуры и
   `screens/gallery.tsx` — нулями.
5. **Клиент:**
   - `state/runs.ts` — поля в схеме очереди (`optional`) и в `toSubmission`;
   - `state/downed-run.ts` — запись прошлой сборки разбирается (`?? 0`);
   - `state/run.ts` — `noHitSec` и `noKillSec` в `run_finished` и
     `run_abandoned`.
6. **Сервер** — `runs.dto.ts` (`z.number().int().min(0).max(86_400)`,
   стихии — `z.record` по четырём именам), `run-details.ts`,
   `run-counters.ts`, `runs-hooks.ts`.
7. **Документы:**
   - `docs/22` §3.3 — сначала поля `noHitSec`, `noKillSec`, потом Zod
     `runOutcome`;
   - `docs/39` §3 — строка про новые счётчики.

## Чего не трогаем

- Виды цели и достижения — T-0322.
- Рейтинг и очки (T-0293): серии на очки не влияют.
- Правила неуязвимости, щита и стихий.

## Тесты

Первым коммитом.

- `packages/core-game/test/run-streaks.test.ts` (мир — `createWorld` на
  фикстурах):
  - без попаданий 600 с → `noHitSec` 600; попадание на 300-й секунде →
    закрытая 300, текущая до конца;
  - попадание в щит буста закрывает серию; удар в неуязвимость — нет;
  - тик горения закрывает серию;
  - убийство на 10-й и 75-й секунде → `noKillSec` 65; хвост 200 с до
    смерти — не считается;
  - убийство огнём → `killsByElement.fire` 1; динамитом — физическое, ключа
    нет;
  - снимок на середине серии → продолжение → та же серия;
  - golden баланса не сдвинулись (прогон существующего набора).
- `backend/api/test/run-streaks.test.ts` (чистые функции T-0125):
  - `countersOf` без новых полей → 0 и `{}`;
  - `noHitSec` больше `survivalSec` → неправдоподобно; ровно равно — да;
  - сумма `killsByElement` больше `enemiesKilled` → неправдоподобно;
  - `runFinishSchema` без новых полей — разбирается; отрицательное — отказ.

## Аналитика

`run_finished` и `run_abandoned` получают необязательные `noHitSec` и
`noKillSec` (целые секунды): сначала `docs/22` §3.3, потом Zod. По ним
геймдизайнер увидит, насколько трудны новые испытания.

## Настройки и окружение

Нет.

## Документы

По шагу 7.

## Критерии приёмки

- [ ] Итог забега несёт серии без попаданий и без убийств и убийства по стихиям; продолжение из снимка их сохраняет.
- [ ] Щит буста и тик стихии рвут серию; хвост без убийств до смерти не считается.
- [ ] Сервер принимает поля, неправдоподобные — `counters_implausible` без смены вердикта; golden не сдвинулись.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Серии без урона и убийства по стихиям`
- **Метка:** `release: minor`
- **Для игроков:** пусто — видно станет с достижениями T-0322.
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СЕРИИ И СТИХИИ В ИТОГЕ ЗАБЕГА**

  Итог забега теперь знает самую долгую серию без попаданий, самую долгую серию без убийств и убийства по стихиям. Попадание в щит буста тоже рвёт серию. Сервер проверяет числа на правдоподобие. Это основа для «Без единой царапины», «Пацифиста» и стихийников.
  ```
