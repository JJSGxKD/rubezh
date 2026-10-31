---
id: T-0175
title: Лента живых событий — убитый босс и редкий сундук: счётчик редких сундуков и события
epic: E16
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0125, T-0174, T-0193, T-0195, T-0198]
zones:
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/sim/chests.ts
  - packages/core-game/src/game/run/run-result.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/test/rare-chests.test.ts
  - packages/core-game/test/run-snapshot.test.ts
  - packages/core-game/test/run-summary.test.ts
  - packages/app-shell/src/state/runs.ts
  - packages/app-shell/src/state/downed-run.ts
  - packages/app-shell/src/screens/gallery.tsx
  - packages/app-shell/test/runs.test.ts
  - packages/app-shell/test/ad-continue.test.ts
  - packages/app-shell/test/continue-purchase.test.ts
  - packages/app-shell/test/dev-mode.test.ts
  - packages/app-shell/test/meta-last-run.test.ts
  - packages/app-shell/test/second-chance.test.ts
  - backend/api/src/modules/runs/run-counters.ts
  - backend/api/src/modules/runs/run-details.ts
  - backend/api/src/modules/runs/dto/runs.dto.ts
  - backend/api/src/modules/feed/feed-rules.ts
  - backend/api/test/run-counters.test.ts
  - backend/api/test/feed.test.ts
  - backend/api/test/feed.integration.test.ts
shared:
  - packages/shared-types/src/index.ts
  - docs/39-retention-mechanics.md
  - docs/22-analytics-and-metrics.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0175. Лента живых событий — убитый босс и редкий сундук: счётчик редких сундуков и события

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0175.json)](README.md#значки-статуса) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](archive/T-0125-run-result-rank-chest-crystal-counters.md) [![T-0174](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0174.json&label=T-0174)](T-0174-live-feed-backend.md) [![T-0193](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0193.json&label=T-0193)](T-0193-longer-run-progression.md) [![T-0195](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0195.json&label=T-0195)](T-0195-player-power-pressure-engine.md) [![T-0198](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0198.json&label=T-0198)](T-0198-remove-enemy-projectile-code.md)

## Зачем

Р114 называет в ленте четыре события; сервер после T-0174 знает два.
«Убитый босс» и «редкий сундук» можно показать только по итогу забега:
отдельной записи боссов и сундуков в базе нет. T-0125 уже донесёт до сервера
`bossKills` и `chestsOpened`; не хватает счётчика **редких** сундуков. Эта
задача добавляет его и включает два вида событий в ленту.

## Решения

Р114 (19.10.2026): события ленты — «убитый босс, редкий сундук» наравне с
рекордом недели и длинным забегом; только настоящие, за последние сутки.

Уточнения `claude-lead2-1` по записанным правилам:

- **Редкий сундук — самый крупный размер из `CHESTS.sizes`** (сейчас пятерной,
  вес 3% против 87% и 10%; `content/chests.ts`, комментарий «пятерной —
  событие»). Размер определяется по данным движка в момент открытия: самый
  большой `size` среди `world.chestRules.sizes`. Новое поле в
  `content/chests.ts` не заводится — значит, `CONTENT_HASH` и golden-эталоны не
  двигаются; сдвинулись — счётчик куда-то влез, ищи ошибку, а не обновляй
  эталон.
- **Счётчики не трогают симуляцию:** ни `world.rng`, ни порядок событий
  (`CLAUDE.md`, «Как настроить сундук забега»: в `game/sim/chests.ts` нет
  обращений к `world.rng`, и тест это проверяет).
- **Проводное имя — `rareChests`** в `stats` итога забега, необязательное, как
  четыре поля T-0125; в мире — `rareChestsOpened`.
- **Боссы и сундуки — из `RecordedRun.counters` (T-0125):** неправдоподобные
  счётчики там `null`, поэтому события из них не возникают. Одно событие на
  вид на забег, независимо от числа убитых боссов и сундуков в нём.
- **Фильтр «настоящих» тот же, что у T-0174:** рейтинговый забег, вердикт `ok`,
  без читов.

Решение claude-lead-1 от 19.10.2026: редкий сундук — самый крупный размер (5), как
в первом пункте выше.

## Как сейчас

- `packages/core-game/src/game/sim/chests.ts:130–158` — `openChest(world, size)`:
  в конце `world.stats.chestsOpened++`. Размеры — `world.chestRules.sizes`
  (`ChestsDef`, `packages/shared-types/src/index.ts:1050`), сейчас 1, 3, 5.
- `packages/core-game/src/game/run/snapshot.ts:22` — `WORLD_SNAPSHOT_VERSION`
  (8 на момент разведки; T-0125 поднимет). Старая версия обязана давать
  `SnapshotError`.
- T-0125 (`tasks/T-0125-run-result-rank-chest-crystal-counters.md`) заводит
  `RunResult.bossKills/eliteKills/chestsOpened/crystalsCollected`, `stats` на
  проводе, `run-counters.ts` (`RunCounters`, `countersOf`, `countersPlausible`),
  `RecordedRun.counters`, хранение в `run.details`. Эта задача **дописывает
  рядом**, не переписывая: брать код T-0125 из `dev` на момент взятия.
- `backend/api/src/modules/feed/feed-rules.ts` (T-0174) —
  `feedEventsOf(run, rules, weekRecord)`; виды `boss` и `chest` в
  `FEED_KINDS` и в схеме уже есть, событий этих видов никто не пишет.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Движок.** `world.ts`: в `Stats` — `rareChestsOpened` (число, комментарий
   «открытые сундуки наибольшего размера из `CHESTS.sizes`»);
   `create-world.ts`: ноль. `chests.ts`, `openChest`: рядом с
   `chestsOpened++` — `if (size === largestChestSize(world.chestRules))
   world.stats.rareChestsOpened++`; `largestChestSize` — маленькая функция там
   же, без `Math.max(...)` по рою (список из трёх элементов, цикл). Тригонометрии
   и `Math.random()` нет.
3. **Снимок.** `snapshot.ts`: `WORLD_SNAPSHOT_VERSION` на единицу выше
   значения в `dev` на момент взятия (константу в тестах не хардкодить:
   тест импортирует её). Старый снимок по-прежнему даёт `SnapshotError`.
4. **Итог.** `shared-types`: в `RunResult` — `rareChestsOpened` (число,
   обязательное); `RunFinishStats` — `rareChests?: number`. `run-result.ts`:
   берёт из `world.stats`. Типизированные фикстуры `RunResult` в тестах и
   `screens/gallery.tsx` дополнить нулями; остальные места покажет
   `pnpm typecheck` из корня (`-r` тесты пропускает).
5. **Клиент.** `state/runs.ts`: в схему записи очереди `stats.rareChests` —
   `z.optional(z.number())`; `toSubmission` кладёт
   `rareChests: result.rareChestsOpened`. `state/downed-run.ts`: схему итога
   расширить так, чтобы запись прошлой сборки без поля разбиралась
   (`optional`, в коде `?? 0`).
6. **Сервер, приём.** `runs.dto.ts`: в `stats` — `rareChests`
   (`z.number().int().min(0)` с тем же потолком формы, что `chestsOpened`,
   `.optional()`). `run-counters.ts`: `RunCounters.rareChests`; `countersOf`
   читает его (нет поля — 0); правило правдоподобия **добавляется** к четырём
   из T-0125: `rareChests <= chestsOpened`. Нарушение — та же причина
   `counters_implausible`, поведение прежнее. `run-details.ts`: ключ
   `rareChests` в `details` (`count.nullable().default(null)`: строка без
   ключа читается как `null`).
7. **Лента.** `feed-rules.ts`: `feedEventsOf` получает `run.counters`:
   `counters.bossKills > 0` → событие `boss` с `seconds: null`;
   `counters.rareChests > 0` → событие `chest` с `seconds: null`. `counters ===
   null` → ни того ни другого. `id` — `<runId>:boss` и `<runId>:chest`.
   Больше в ленте менять нечего: запись, чтение, кэш и скрытые игроки уже
   работают для всех четырёх видов.
8. **Документы.** `docs/39` §3, строка «Счётчики итога забега» (T-0125): пятое
   поле `rareChests`, что значит «редкий», что из него возникает. `docs/22`:
   в разделе «Лента событий» — какие четыре вида и откуда. В
   `docs/22`, строках `run_finished`/`run_abandoned`, поле `rareChests` **не
   добавляется** (в аналитику оно не идёт: размер открытых сундуков уже есть в
   `chest_opened.size`).

## Чего не трогаем

- Данные сундуков (`content/chests.ts`, `ChestsDef`) и вес размеров.
- Балансные эталоны: `CONTENT_HASH` и golden-тесты не двигаются.
- Запись и чтение ленты, кэш, настройки (T-0174) — кроме правила
  `feedEventsOf`.
- Задания и достижения (T-0126): им редкий сундук не нужен.
- Правила правдоподобия T-0125 — кроме добавленного шестого.

## Тесты

Пишутся первым коммитом.

- `core-game/test/rare-chests.test.ts` (по образцу `run-counters.test.ts` из T-0125 и тестов сундуков):
  - открыт сундук размера 1 и 3 → `rareChestsOpened` 0, `chestsOpened` 2;
  - открыт сундук размера 5 → `rareChestsOpened` 1;
  - контент с другими размерами (подменить `chests` в опциях мира: `sizes`
    1, 2, 4) → редким считается 4, а не 5;
  - прогон сценария с сундуками даёт тот же `CONTENT_HASH` и те же итоги
    симуляции, что до счётчика (golden не двигается); в `game/sim/chests.ts`
    по-прежнему нет обращений к `world.rng` (существующий тест).
  - `run-snapshot.test.ts`: снимок старой версии → `SnapshotError`; круг
    «снять и поднять» сохраняет `rareChestsOpened`.
- `runs.test.ts` (app-shell): итог с `rareChestsOpened: 2` → тело отправки
  содержит `stats.rareChests: 2`; запись очереди прошлой сборки без поля
  разбирается, `rareChests` — отсутствует; `downed-run` прошлой сборки читается.
- `backend/api/test/run-counters.test.ts`: `countersOf` с `rareChests` → число;
  без поля → 0; `rareChests: 3` при `chestsOpened: 2` → неправдоподобно
  (`counters_implausible`, вердикт не меняется, `RecordedRun.counters` —
  `null`); `rareChests <= chestsOpened` → правдоподобно.
- `backend/api/test/feed.test.ts`:
  - `bossKills: 2`, `rareChests: 0` → одно событие `boss`;
  - `rareChests: 1`, `bossKills: 0` → одно событие `chest`;
  - оба → два события; `counters: null` → ни одного; нерейтинговый забег,
    читы, вердикт не `ok` → ни одного;
  - `id` событий различаются.
- `feed.integration.test.ts` (расширение): записанный забег с боссом и сундуком
  виден в `view`; игрок со скрытой отдельной доской — нет.

## Аналитика

Новых событий нет. `chest_opened.size` уже даёт распределение размеров;
`rareChests` — поле клиентского итога для сервера, а не событие аналитики. В
`docs/22` — только раздел ленты.

## Настройки и окружение

Нет: «редкий» определяется данными сундуков, а не ключом панели.

## Документы

Шаг 8.

## Критерии приёмки

- [ ] Движок считает открытые сундуки наибольшего размера; `CONTENT_HASH` и
  golden-эталоны не изменились.
- [ ] Итог забега несёт `rareChests`, сервер сохраняет и проверяет `rareChests
  <= chestsOpened`.
- [ ] В ленте появляются «босс» и «редкий сундук» из правдоподобных счётчиков
  рейтингового забега; из неправдоподобных, нерейтинговых и с читами — нет.
- [ ] Клиенты прошлых сборок и очередь отправки без поля работают.
- [ ] Гейт (`CLAUDE.md`) зелёный, интеграционные тесты — на живых Postgres и Redis.

## PR

- **Заголовок:** `feat(feed): Босс и редкий сундук в ленте событий`
- **Метка:** `release: minor`
- **Для игроков:** нет — события появятся в строке на главной вместе с задачей клиента
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — БОСС И РЕДКИЙ СУНДУК В ЛЕНТЕ СОБЫТИЙ**

  Движок считает открытые сундуки самого крупного размера и несёт число в итоге забега. Сервер проверяет его вместе с остальными счётчиками и добавляет в ленту события «убит босс» и «редкий сундук». Баланс и эталоны не двигаются.
  ```
