---
id: T-0125
title: Итог забега: счётчики боссов, элит, сундуков и кристаллов
epic: E16
priority: P1
status: ready
owner:
author: claude-lead2-20
size: M
depends_on:
  - T-0099
zones:
  - packages/core-game/src/game/sim/world.ts
  - packages/core-game/src/game/sim/create-world.ts
  - packages/core-game/src/game/sim/combat.ts
  - packages/core-game/src/game/sim/gems.ts
  - packages/core-game/src/game/run/run-result.ts
  - packages/core-game/src/game/run/snapshot.ts
  - packages/core-game/test/run-counters.test.ts
  - packages/core-game/test/run-summary.test.ts
  - packages/core-game/test/run-snapshot.test.ts
  - packages/app-shell/src/state/runs.ts
  - packages/app-shell/src/state/run.ts
  - packages/app-shell/src/state/downed-run.ts
  - packages/app-shell/src/screens/gallery.tsx
  - packages/app-shell/test/runs.test.ts
  - packages/app-shell/test/ad-continue.test.ts
  - packages/app-shell/test/continue-purchase.test.ts
  - packages/app-shell/test/dev-mode.test.ts
  - packages/app-shell/test/meta-last-run.test.ts
  - packages/app-shell/test/second-chance.test.ts
  - backend/api/src/modules/runs/run-counters.ts
  - backend/api/src/modules/runs/run-verdict.ts
  - backend/api/src/modules/runs/run-details.ts
  - backend/api/src/modules/runs/runs-hooks.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/runs/dto/runs.dto.ts
  - backend/api/src/modules/admin-notify/run-review-card.ts
  - backend/api/test/run-counters.test.ts
  - backend/api/test/run-verdict.test.ts
  - backend/api/test/runs.test.ts
  - backend/api/test/runs.integration.test.ts
  - apps/admin/src/api/review.ts
  - apps/admin/test/help.test.ts
shared:
  - packages/shared-types/src/index.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - backend/api/prisma/schema.prisma
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/39-retention-mechanics.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 2
---

# T-0125. Итог забега: счётчики боссов, элит, сундуков и кристаллов

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json)](README.md#значки-статуса) [![T-0099](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0099.json&label=T-0099)](archive/T-0099-run-chest-engine.md)

## Зачем

Задания и достижения «убей босса», «убей элиту», «открой сундук», «подбери кристаллы» нечем считать: в итоге забега на сервере есть сумма убийств, сумма опыта и пятёрка самых частых врагов (`topKills`; босс и элита туда не попадают), а числа открытых сундуков и подобранных кристаллов нет вовсе (находка T-0104, строка `tasks/inbox.md` от 13.10). После задачи движок считает четыре числа за забег, итог несёт их на сервер, сервер сохраняет и проверяет правдоподобие. Виды цели по этим числам делает T-0126.

## Решения

Р102 (`docs/35-stage4-plan.md`), `docs/39-retention-mechanics.md` §3. Исполнитель их не пересматривает.

- **Четыре счётчика, имена по проводу фиксированы** (подтверждено `claude-lead-1` 13.10.2026): `bossKills`, `eliteKills`, `chestsOpened`, `crystals`; в `stats` итога забега, все необязательные (старые сборки и очередь клиента их не знают).
  - `bossKills`, `eliteKills` — убийства игроком врага ранга `boss` и `elite`. Считаются в `killEnemy` (`game/sim/combat.ts`), единственном месте, где растёт `enemiesKilled`: потомки делящегося босса — рядовые и в счёт не идут.
  - `chestsOpened` — уже есть: `stats.chestsOpened` из T-0099. Здесь только доносим до итога.
  - `crystals` — сколько кристаллов опыта **подобрано** (а не выпало): слитый с соседним (`mergeIntoExisting`) считается одним, улетевший за радиус удержания и запасной опыт сундука — нет. В мире поле зовётся `crystalsCollected` (как `medkitsCollected`), на проводе — `crystals`.
- **Счётчики не трогают симуляцию:** ни `world.rng`, ни порядок событий. Эталоны баланса (golden) в этой задаче **не двигаются**; сдвинулись — значит, счётчик куда-то влез, ищи ошибку, а не обновляй эталон.
- **Хранение — в существующем `run.details` (jsonb), без миграции.** Там уже лежат `xpCollected`, `waveReached`, `topKills`; новые колонки ради четырёх чисел не нужны, запрос `details->>'bossKills'` их заменяет. Миграции нет, значит и правило «только добавление» соблюдено. Строки прошлых сборок без ключей читаются как `null`.
- **Проверка правдоподобия нейтральная, пороги не публикуются** (Р7: число в тексте подсказывает читеру предел). Правила структурные, чисел для настройки нет:
  1. `bossKills + eliteKills ≤ enemiesKilled`;
  2. `bossKills` и `eliteKills` не больше, чем элит и боссов приходит по таймлайну к секунде `survivalSec` (бюджет рангов, шаг 6);
  3. `chestsOpened ≤ bossKills + eliteKills`: сундук падает только с убитой элиты или босса (T-0099);
  4. `crystals ≤ enemiesKilled · MAX_GEMS_PER_KILL` (потолок горсти из `game/sim/gems.ts`).
  Нарушение даёт причину вердикта `counters_implausible`, которая **вердикт не меняет** (как `unverified_time`): забег остаётся в рейтинге, но счётчики из него **не доходят до заданий и достижений** (в `RecordedRun` они `null`), а в `details` сохраняются как пришли, для разбора. Рейтинг строится не на них, и ложное срабатывание не должно выбивать честный забег из рейтинга.
- **Серверу нужен бюджет рангов, а `core-game` он не импортирует.** Поэтому таблица событий элит и боссов лежит в `run-counters.ts`, а тест сверяет её с `TIMELINE` и `ENDLESS_CURVE` из `core-game` (тот же приём, что цены бустов в `boosts.test.ts`: относительный импорт в тесте). Поменялся таймлайн — тест падает, пока таблицу не обновили.

## Как сейчас

- `packages/core-game/src/game/sim/world.ts`: `Stats` (стр. ~140–176) — `enemiesKilled`, `killsByType`, `xpCollected`, `medkitsCollected` и т. д.; `create-world.ts` (стр. ~302–320) заводит нули. Ранг врага — `world.enemyTypes[typeIndex].rank` (`"normal" | "elite" | "boss"`, `game/patterns/enemy-types.ts`, есть `isElite` и `isBoss`).
- `game/sim/combat.ts`, `killEnemy` (стр. 89): `enemiesKilled++`, `killsByType[typeIndex]++`, дальше кристаллы и подборы. `game/sim/gems.ts`: подбор — функция `collect(world, i)` (вызов в `updateGems`, стр. ~206).
- `game/run/run-result.ts`, `buildRunResult` собирает `RunResult` (тип — `packages/shared-types/src/index.ts`, рядом `xpCollected`, стр. ~1195). `game/run/snapshot.ts`: `stats` кодируется целиком (`encodeRecord(world.stats, …)`), версия `WORLD_SNAPSHOT_VERSION` (после T-0099 — 8).
- `packages/app-shell/src/state/runs.ts`: схема записи очереди (стр. ~50–75, поля после `contentHash` необязательные), `toSubmission` (стр. 251) собирает `stats` для сервера. `state/downed-run.ts` (стр. ~30) хранит итог забега, ожидающего решения о втором шансе.
- `backend/api/src/modules/runs/dto/runs.dto.ts`, `runFinishSchema.stats` (стр. 78): `damageTaken`, `xpCollected`, `waveReached`, `topKills`. `run-details.ts`: `storedDetailsSchema`, `detailsOf`. `runs-hooks.ts`: `RecordedRun` (после T-0104 уже несёт `weapons`, `boosts`, `xpCollected`). `run-verdict.ts`: `judgeRun`, причины делятся на отказные, подозрительные и «сведения» (`unverified_time` — в обоих списках отсутствует).
- События забега: `runOutcome` в `event-dictionary.ts` (стр. 54) общий для `run_finished` и `run_abandoned`.
- Подписи причин вердикта: `admin-notify/run-review-card.ts` (стр. ~40–54) и `apps/admin/src/api/review.ts` (стр. ~35–48).
- Таймлайн: `content/waves.ts` — события `TIMELINE[].events` и `ENDLESS_CURVE.events` (`everySegments`, `count`); элиты и боссы приходят только событиями. Момент срабатывания события кривой — в `game/sim/` по `everySegments` (найти grep): таблица сервера обязана повторять именно это правило.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Движок.** `world.ts`: в `Stats` добавить `bossKills`, `eliteKills`, `crystalsCollected` (числа, комментарий «что считает»); `create-world.ts`: нули. `combat.ts`, `killEnemy`: рядом с `enemiesKilled++` — `type.rank === "boss"` → `bossKills++`, `"elite"` → `eliteKills++`. `gems.ts`, `collect`: `crystalsCollected++`. Сначала grep `enemiesKilled++`: второго места быть не должно, иначе счётчики разойдутся с общим числом. Тригонометрии и `Math.random()` нет.
3. **Снимок.** `snapshot.ts`: `WORLD_SNAPSHOT_VERSION` на единицу выше значения в `dev` на момент взятия задачи (константу в тестах не хардкодить: тест импортирует её). Прочитать `decodeRecord`: как он ведёт себя на снимке без нового поля; старая версия обязана давать `SnapshotError`.
4. **Итог.** `shared-types`: в `RunResult` — `bossKills`, `eliteKills`, `chestsOpened`, `crystalsCollected` (числа, обязательные). `run-result.ts`: берёт из `world.stats`. Типизированные фикстуры `RunResult` в тестах и `screens/gallery.tsx` дополнить нулями; список файлов в зонах, остальные покажет `pnpm typecheck` из корня (нужен корневой, `-r` тесты пропускает).
5. **Клиент.** `state/runs.ts`: в схему записи очереди `stats` — четыре поля `z.optional(z.number())`; `toSubmission`: `stats.bossKills`, `eliteKills`, `chestsOpened`, `crystals: Math.round(result.crystalsCollected)`. `state/downed-run.ts`: схему итога расширить так, чтобы запись прошлой сборки без новых полей разбиралась (`optional`, в коде — `?? 0`). `state/run.ts` (место, где собирается payload `run_finished` и `run_abandoned`, grep по именам событий): добавить поля в payload.
6. **Сервер, приём.**
   - `runs.dto.ts`: в `stats` четыре поля `z.number().int().min(0).max(…)` с `.optional()` (потолки формы: убийства — как `enemiesKilled`, кристаллы — 10 000 000; правилами игры не являются).
   - `run-counters.ts` (новый, чистые функции, без Nest и базы): `RunCounters = { bossKills; eliteKills; chestsOpened; crystals }`; `countersOf(stats): RunCounters | null` (`null`, если `stats` не прислан или нет ни одного поля; отсутствующее поле — 0); `rankBudget(survivalSec): { elite: number; boss: number }` по таблице событий (ручные отрезки: секунда и `count`; кривая: `fromSec`, `segmentSec`, `everySegments`, `count`; считаются события с моментом ≤ `survivalSec`, без запаса: честный забег не убьёт ещё не пришедшего); `GEMS_PER_KILL_CEILING` (число из `core-game`, сверяется тестом); `countersPlausible(counters, { survivalSec, enemiesKilled }): boolean` по четырём правилам из «Решений».
   - `run-verdict.ts`: `VerdictInput.counters: RunCounters | null`; `VerdictReason` получает `"counters_implausible"` (в обоих списках — отказных и подозрительных — **не** состоит); `judgeRun` добавляет причину, если счётчики есть и неправдоподобны.
7. **Сервер, хранение и слушатели.** `run-details.ts`: `storedDetailsSchema` и `FinishDetailsInput.stats` получают четыре поля (`count.nullable().default(null)`: строка без ключей читается как `null`), `detailsOf` кладёт пришедшее. `runs-hooks.ts`: `RecordedRun.counters: RunCounters | null`. `runs.service.ts`: считает `countersOf(run.stats)`, подаёт в `judgeRun`, в `hooks.emit` передаёт `counters` только если среди причин нет `counters_implausible`, иначе `null`. В `schema.prisma` — только комментарий у `details` (какие ключи в нём лежат), в `docs/21-diagrams.md` — то же у `run.details`, если там перечислены ключи.
8. **Подписи причины.** `run-review-card.ts` и `apps/admin/src/api/review.ts`: `counters_implausible: "счётчики забега не сходятся с ходом боя"` (без чисел). Тест подписи — в `apps/admin/test/help.test.ts`.
9. **Словарь событий — сначала документ.** `docs/22` §3.3, строка `run_finished`/`run_abandoned`: необязательные `bossKills`, `eliteKills`, `chestsOpened`, `crystals` (целые). Потом `event-dictionary.ts`: те же поля в `runOutcome` как необязательные `count`; версия остаётся 1. Потом код шага 5.
10. **Документы.** `docs/39` §3: строка «Счётчики итога забега» (какие четыре, где считаются, что пробный забег с читами и неправдоподобные счётчики в задания не идут).

## Чего не трогаем

- Виды цели заданий и достижений, новые строки каталога: T-0126.
- Лист забега в профиле (`runs-view.service.ts`, `RunDetail`) и гайдбук: счётчики пока не показываем.
- Эволюции: счётчика нет, они читаются из `weapons[]` итога (T-0126).
- Колонки таблицы `run`, миграции, `core-game/src/content/*`, golden-эталоны и коридоры баланса.
- Бот баланса и `pnpm balance:sim` (колонки «боссов»/«элит» не добавляем).
- Пороги и ключи настроек: чисел для настройки у проверки нет.

## Тесты

Первым коммитом, до кода.

- `packages/core-game/test/run-counters.test.ts` (мир — `createWorld` на фикстурах, враги — `spawnEnemy` и убийство):
  - рядовой → `enemiesKilled` 1, `bossKills` 0, `eliteKills` 0; элита → `eliteKills` 1; босс → `bossKills` 1; потомок делящегося босса (рядовой) в счёт не идёт;
  - прогон бота на нескольких seed «Лёгкой»: `bossKills + eliteKills ≤ enemiesKilled`, `chestsOpened ≤ bossKills + eliteKills`, ни один счётчик не убывает между тиками;
  - кристалл: подобран → `crystalsCollected` +1; два слитых в один → +1 за подбор; за радиусом удержания → +0; запасной опыт сундука (`addXp` без счёта) кристаллом не считается;
  - детерминизм: два мира с одним seed дают равные счётчики; `world.rng.getState()` с кодом счётчиков и без (контроль: убийства и подборы те же) равны;
  - `sim-purity.test.ts` зелёный.
- `run-summary.test.ts`: `buildRunResult` несёт `bossKills`, `eliteKills`, `chestsOpened`, `crystalsCollected` из мира.
- `run-snapshot.test.ts`: снимок восстанавливает счётчики; снимок прошлой версии → `SnapshotError`.
- `backend/api/test/run-counters.test.ts` (чистые функции):
  - `countersOf`: без `stats` → `null`; без новых полей → `null`; часть полей → остальные 0;
  - `rankBudget`: в нуле 0/0; не убывает по времени на сетке 0…7200 с; на 86 400 с конечен;
  - `countersPlausible`: нули — правдоподобно; ровно на бюджете рангов — правдоподобно, на единицу выше — нет; `bossKills + eliteKills > enemiesKilled` — нет; `chestsOpened` больше убитых элит и боссов — нет; `crystals` больше `enemiesKilled · GEMS_PER_KILL_CEILING` — нет, ровно на границе — да;
  - **сверка с контентом** (относительный импорт `packages/core-game/src/content/*`): события элит и боссов таблицы совпадают с `TIMELINE` и `ENDLESS_CURVE` с учётом ранга врага из `ENEMIES` (если в `core-game` есть функция расписания событий — зовёт её, а не повторяет правило); `GEMS_PER_KILL_CEILING === MAX_GEMS_PER_KILL`; ни у одного `splitter` в `children` нет элиты и босса (иначе бюджет считается иначе).
- `run-verdict.test.ts`: неправдоподобные счётчики → причина `counters_implausible`, вердикт остаётся прежним (`ok` не становится `suspicious`); `counters: null` → причины нет; причина не входит ни в отказные, ни в подозрительные.
- `runs.test.ts`: `runFinishSchema` без новых полей разбирается (старый клиент); с ними — тоже; отрицательное и дробное — отказ; `detailsOf` кладёт поля; `storedDetailsSchema` на строке без ключей даёт `null`; `hooks.emit` получает `counters` для правдоподобных и `null` для неправдоподобных и без `stats`.
- `runs.integration.test.ts` (живые Postgres и Redis): итог со счётчиками → в `run.details` ключи на месте; повтор того же итога из очереди не удваивает слушателей (`counters` в хук приходит один раз); запись `details` прошлой сборки читается без ошибки.
- `packages/app-shell/test/runs.test.ts`: `toSubmission` кладёт четыре поля, `crystals` округлено; запись очереди без новых полей разбирается; итог прошлой сборки в `downed-run` разбирается.
- `apps/admin/test/help.test.ts`: `reasonTitle("counters_implausible")` — подпись без цифр.
- `scripts/test/event-dictionary.test.ts` зелёный: сервер, клиент и документ согласованы.

## Аналитика

Сначала словарь. `run_finished` и `run_abandoned` (общий `runOutcome`) получают необязательные целые `bossKills`, `eliteKills`, `chestsOpened`, `crystals`; версия 1, смысл прежних полей не меняется. Из них считаются «боссов за забег» и «сундуков за забег» в дашбордах. В Prometheus ничего с `account_id` и `run_id` в метках.

## Настройки и окружение

Нет. Правила проверки структурные, чисел для настройки нет; ключей `setting-catalog.ts` и переменных окружения не заводим.

## Документы

`docs/22-analytics-and-metrics.md` (поля двух событий), `docs/21-diagrams.md` (комментарий у `run.details`, если там перечислены ключи), `docs/39-retention-mechanics.md` §3 (строка про счётчики).

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: хранение в `run.details` без миграции; отдельные колонки заведём, когда понадобятся индексы под аналитику.
- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: `counters_implausible` вердикт не меняет, счётчики неправдоподобного забега в задания не идут, в `details` лежат как пришли.
- Версия снимка забега растёт ещё раз (T-0099 довёл до 8): сохранённые незавершённые забеги тестеров при выкате этой пачки пропадут, как и в T-0099. Если T-0099 и эта задача уйдут в одну пачку, достаточно одного повышения: исполнитель смотрит значение в `dev`.
- Если T-0119 (модификаторы забега, пачка 3) добавит события элит и боссов в таймлайн, таблицу бюджета рангов придётся обновить в той же задаче: тест сверки укажет на расхождение сам.

## Критерии приёмки

- [ ] Четыре счётчика считаются в движке, не двигают `world.rng` и golden-эталоны; снимок новой версии их восстанавливает.
- [ ] Итог забега несёт их, клиент отправляет в `stats`, сервер принимает старый и новый вид, сохраняет в `run.details`; миграции нет.
- [ ] Неправдоподобные счётчики дают `counters_implausible` без смены вердикта и не попадают в `RecordedRun`; таблица бюджета рангов сверена с контентом тестом.
- [ ] События `run_finished` и `run_abandoned` расширены в документе, словаре и клиенте.
- [ ] Дифф только в зонах задачи; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(core-game): Счётчики итога забега`
- **Метка:** `release: minor`
- **Для игроков:** нет — счётчики используют задания и достижения T-0126.
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — СЧЁТЧИКИ ИТОГА ЗАБЕГА**

  Движок считает за забег убитых боссов и элит, открытые сундуки и подобранные кристаллы; итог несёт их на сервер, сервер сохраняет и проверяет правдоподобие. Игрок ничего нового не видит: счётчики нужны заданиям и достижениям (T-0126).

  🛠 **Забеги и сервер**

  • числа лежат в подробностях забега, миграции нет
  • неправдоподобные счётчики не попадают в задания; на рейтинг они не влияют
  • версия снимка забега выросла: сохранённые незавершённые забеги при выкате пропадут

  ❓ **Нужно от команды**

  • @владелец — подтвердить, что потеря сохранённых незавершённых забегов при выкате допустима
  ```
