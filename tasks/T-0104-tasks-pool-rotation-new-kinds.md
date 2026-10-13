---
id: T-0104
title: Задания: пул с ротацией по дням и недели и шесть новых видов цели
epic: E16
priority: P1
status: ready
owner:
author: claude-lead2-16
size: M
depends_on: []
zones:
  - backend/api/src/modules/tasks/task-rules.ts
  - backend/api/src/modules/tasks/task-pool.ts
  - backend/api/src/modules/tasks/tasks.service.ts
  - backend/api/src/modules/tasks/tasks.repository.ts
  - backend/api/src/modules/runs/runs-hooks.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/test/task-pool.test.ts
  - backend/api/test/tasks.test.ts
  - backend/api/test/tasks.integration.test.ts
  - backend/api/test/runs.test.ts
  - apps/admin/src/api/tasks.ts
  - apps/admin/src/screens/tasks/TasksScreen.tsx
  - apps/admin/src/ui/help.ts
  - apps/admin/test/tasks.test.ts
  - packages/app-shell/src/state/tasks-api.ts
  - packages/app-shell/src/screens/meta/task-row.tsx
  - packages/app-shell/src/i18n/ru-tasks.json
  - packages/app-shell/test/tasks-api.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/39-retention-mechanics.md
runner: local
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 1
---

# T-0104. Задания: пул с ротацией по дням и недели и шесть новых видов цели

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0104.json)](README.md#значки-статуса)

## Зачем

Ежедневных заданий в каталоге четыре, недельных три: тестер выполняет их за пару дней, и заходить за заданиями больше незачем. После задачи в каталоге пул из 20 дневных и 12 недельных заданий, игрок каждый день видит пять из пула, каждую неделю шесть, набор у всех одинаков и зависит только от даты. Появляются задания про оружие, стихию, сложность, буст и собранный опыт. Основа линии удержания (`docs/39-retention-mechanics.md` П1, решение Р102).

## Решения

- **Ротация считается кодом от даты, без записи в базу.** Набор дня и недели выбирает чистая функция из `(период, начало срока, строки пула)`: одинаково на всех репликах и у всех игроков, без крона и без таблицы «выбранное сегодня». Начало срока — игровые сутки по Москве (`common/game-day.ts`), неделя с понедельника: ровно как `periodStartSql` в `tasks.repository.ts`.
- **Что в пуле.** Строка `daily` или `weekly` со ступенью `tier` (`easy`, `medium`, `hard`). Строка без `tier` (партнёрские цели, достижения, строки, добавленные руками) показывается всегда, как сейчас.
- **Сколько в набор** (старт, геймдизайнер калибрует): день — 2 лёгких, 2 средних, 1 сложное (5); неделя — 2 лёгких, 3 средних, 1 сложное (6). Не хватает строк ступени (выключили в панели) — добираем из остальных пула.
- **Фильтр цели лежит в новой колонке `filter` (jsonb), а не в `params`.** `params` остаётся только у партнёрских целей: по нему `category` решает, что цель партнёрская, и правило `isCheckedKind(kind) === (params !== null)` не меняется.
- **Шесть новых видов, все считаются по итогу забега, который уже приходит на сервер** (`runFinishSchema`, `runs/dto/runs.dto.ts`):

  | Вид | Действие | Фильтр | Берётся из итога |
  |---|---|---|---|
  | `xp_collected` | сумма | нет | `stats.xpCollected` (нет — 0) |
  | `weapon_runs` | сумма | `weapon` | `weapons[].id`: оружие в наборе к концу забега |
  | `element_runs` | сумма | `element` (`fire`, `cold`, `lightning`, `poison`) | стихия оружия из набора |
  | `difficulty_runs` | сумма | `difficulty` | `difficultyId` |
  | `difficulty_survive_sec` | максимум | `difficulty` | `survivalSec` забега на этой сложности |
  | `boost_runs` | сумма | нет (любой буст) | `boosts`, только оплаченные |

  **Боссы, элиты и «кристаллов штук» из итога взять нельзя:** в нём нет ни счётчика убитых по рангам (`topKills` — пять самых частых врагов, босс туда не попадает), ни числа подобранных кристаллов (только сумма опыта). Сундуки и эволюции — после T-0099 и T-0102. Это отдельная задача на счётчики в итоге, здесь её нет.
- **Стихия оружия и список оружия — на сервере таблицей** в `task-rules.ts` (`WEAPON_ELEMENTS`: `wardstone` — `cold`, `hearth` — `fire`, `storm` — `lightning`, `sting` — `poison`; `spark` и `knife` без стихии) с тестом сверки с `packages/core-game/src/content/weapons.ts`, как у цен бустов (`boosts.test.ts`). Новое оружие со стихией в контенте роняет тест, пока строку не добавили.
- **Оружие и бусты в итоге — со слов клиента, как и весь итог.** Забег засчитывается теми же правилами, что награда (`countsForTasks`: читы и отклонённые разбором не двигают задания). Бусты сервер считает только при статусе `paid` (оплачены на этот забег); иначе в `RecordedRun.boosts` пусто. Награды малы, суточные потолки кошелька есть.
- **Награды новых строк по ступени** (старт, геймдизайнер калибрует): день — лёгкое 70, среднее 110, сложное 160 монет (набор ≈ 520, как сегодняшние ≈ 500); неделя — 300 / 550 / 900 монет, у сложного ещё 5 осколков. Очки (`pass_points`) здесь не трогаем: их ставит T-0105.
- **Старые строки** получают только `tier` (награды не меняются): `daily_runs` — easy, `daily_kills` — medium, `daily_survive` — medium, `daily_level` — hard; `weekly_runs` — easy, `weekly_kills` — medium, `weekly_survive` — medium.
- **Правка пула из панели в течение суток меняет сегодняшний набор у всех.** Панель показывает «Сегодня в ротации» и предупреждение; правят пул вечером.

Стартовый пул (текст задания строится у клиента по виду цели, `title` — `null`):

| Дневные id (kind, фильтр, цель) | Ступень |
|---|---|
| `daily_runs` (старый) | easy |
| `daily_kills_300` (`kills`, 300) · `daily_best_120` (`best_survival_sec`, 120) · `daily_level_10` (`run_level`, 10) · `daily_xp_500` (`xp_collected`, 500) · `daily_weapon_spark` (`weapon_runs`, spark, 2) · `daily_weapon_knife` (`weapon_runs`, knife, 2) · `daily_boost` (`boost_runs`, 1) | easy |
| `daily_kills`, `daily_survive` (старые) | medium |
| `daily_best_240` (`best_survival_sec`, 240) · `daily_xp_1500` (`xp_collected`, 1500) · `daily_element_fire` (`element_runs`, fire, 2) · `daily_element_cold` (`element_runs`, cold, 2) · `daily_normal_runs` (`difficulty_runs`, normal, 2) · `daily_hard_run` (`difficulty_runs`, hard, 1) | medium |
| `daily_level` (старый) | hard |
| `daily_best_420` (`best_survival_sec`, 420) · `daily_hard_180` (`difficulty_survive_sec`, hard, 180) · `daily_kills_3000` (`kills`, 3000) | hard |

| Недельные id (kind, фильтр, цель) | Ступень |
|---|---|
| `weekly_runs` (старый) · `weekly_boost` (`boost_runs`, 3) · `weekly_weapon_storm` (`weapon_runs`, storm, 5) · `weekly_weapon_wardstone` (`weapon_runs`, wardstone, 5) | easy |
| `weekly_kills`, `weekly_survive` (старые) · `weekly_xp` (`xp_collected`, 15000) · `weekly_element_lightning` (`element_runs`, lightning, 6) · `weekly_element_poison` (`element_runs`, poison, 6) | medium |
| `weekly_best_540` (`best_survival_sec`, 540) · `weekly_hard_240` (`difficulty_survive_sec`, hard, 240) · `weekly_level_30` (`run_level`, 30) | hard |

Итого дневных 20 (8 / 8 / 4), недельных 12 (4 / 5 / 3). **Цели `xp_collected` — наугад:** масштаб опыта за забег неизвестен, геймдизайнер калибрует по `run.details->>'xpCollected'` с дева (см. «Вопросы»).

## Как сейчас

- `backend/api/src/modules/tasks/task-rules.ts`: `RUN_KINDS` (стр. 29) — пять видов, у каждого `measure: (run: TaskRun) => number`; `TaskRun` (стр. 112) — `Pick<RecordedRun, "difficulty" | "survivalSec" | "enemiesKilled" | "level" | "cheats" | "verdict">`; `taskDefSchema` (стр. 139) — `.strict()` с `refine`; правило «`params` — у партнёрской цели и только у неё» — стр. 168.
- `backend/api/src/modules/tasks/tasks.service.ts`: `onRun` (стр. 286) берёт `this.active()` и делает `kind.measure(run)`; `visible(account)` (стр. 303) и `active()` (стр. 307) отдают весь каталог включённых целей, кеш 30 с; `badge()` (стр. 245) считает `done && !claimed` по всему прогрессу; `viewOf`, стр. 346: `category: def.params === null ? def.period : "partner"` — **новый фильтр не должен делать цель «партнёрской»**; `catalog()` (стр. 251) отдаёт панели каталог.
- `backend/api/src/modules/tasks/tasks.repository.ts`: сырой SQL — `catalog()` (стр. 113, `SELECT task_id, period::text, kind, …`), `insert` (стр. 191) и `update` (стр. 201) перечисляют колонки руками; `defSchema` (стр. 80) разбирает строку; `periodStartSql` — граница суток и недели.
- `backend/api/src/modules/runs/runs-hooks.ts`: `RecordedRun` (стр. 15) без оружия, бустов и опыта. `runs.service.ts`: `Promise.all([…checkBoosts…])` (стр. 88) возвращает статус бустов `none`/`paid`/`unpaid`; `hooks.emit` (стр. 146) собирает `RecordedRun`.
- `packages/app-shell/src/screens/meta/task-row.tsx:170` — `const key = \`task.kind.${task.kind}\``: текст цели по виду; ключи — в `i18n/ru-tasks.json`. `state/tasks-api.ts` — Zod-схема `taskSchema` клиента (поля, которых старый сервер не отдавал, `z.optional`).
- Каталог в базе сеется миграциями: `20260930095851_tasks` (четыре дневные, три недельные, девять достижений).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Миграция** (после перебазирования на свежий `dev`, `prisma migrate dev --create-only` один раз, проверить, что папка одна). Только добавление:
   - `ALTER TABLE "task_def" ADD COLUMN "tier" VARCHAR(8), ADD COLUMN "filter" JSONB;`
   - `CHECK (tier IS NULL OR tier IN ('easy','medium','hard'))` и `CHECK (tier IS NULL OR period IN ('daily','weekly'))`;
   - `UPDATE task_def SET tier = … WHERE task_id = …` для семи старых строк;
   - `INSERT … ON CONFLICT (task_id) DO NOTHING` для 25 новых строк (`title` — `NULL`, `active` — `true`, `sort`: 100+ для easy, 200+ для medium, 300+ для hard, внутри ступени по алфавиту id).
   Модель `TaskDef` в `schema.prisma` — два поля со своими комментариями (на что они). Диаграмма в `docs/21-diagrams.md` — колонки `tier`, `filter` у `task_def`.
3. **`task-rules.ts`:**
   - `export const RUN_FILTER_KEYS = { weapon_runs: "weapon", element_runs: "element", difficulty_runs: "difficulty", difficulty_survive_sec: "difficulty" } as const`;
   - `runFilterSchema = z.object({ weapon: z.string().regex(/^[a-z][a-z0-9_]{1,47}$/).optional(), element: z.enum(["fire","cold","lightning","poison"]).optional(), difficulty: z.enum(DIFFICULTIES).optional() }).strict()` (`DIFFICULTIES` — из `runs/run-rules.ts`);
   - `POOL_TIERS = ["easy","medium","hard"] as const`, `WEAPON_ELEMENTS`;
   - `measure(run, filter)` получает второй аргумент `filter: RunFilter | null`; шесть видов в `RUN_KINDS` по таблице выше; `weapon_runs`: `run.weapons.some((w) => w.id === filter?.weapon) ? 1 : 0`; `element_runs`: `run.weapons.some((w) => WEAPON_ELEMENTS[w.id] === filter?.element)`; `boost_runs`: `run.boosts.length > 0 ? 1 : 0`; `difficulty_survive_sec`: `Math.floor(run.survivalSec)` на своей сложности, иначе 0;
   - `TaskRun` дополняется `weapons`, `boosts`, `xpCollected`;
   - `taskDefSchema`: поля `tier: z.enum(POOL_TIERS).nullable().default(null)` и `filter: runFilterSchema.nullable().default(null)` + `refine`: у видов из `RUN_FILTER_KEYS` фильтр обязателен и в нём ровно один ключ из таблицы; у остальных видов фильтра нет; `tier` — только у `daily`/`weekly` и не у партнёрской цели. Сообщения на русском («у этого вида нужен фильтр: оружие», «ступень — только у дневных и недельных заданий»).
4. **Новый `task-pool.ts`** (чистые функции, без Nest и базы):
   - `gameDayOf(at: Date): string` и `gameWeekStartOf(at: Date): string` (`YYYY-MM-DD`, `Intl.DateTimeFormat("en-CA", { timeZone: GAME_DAY_TIME_ZONE })`, неделя с понедельника);
   - `POOL_QUOTA = { daily: { easy: 2, medium: 2, hard: 1 }, weekly: { easy: 2, medium: 3, hard: 1 } }`;
   - `pickPool(defs, period, periodStart): ReadonlySet<string>` — из включённых строк периода со `tier`: по каждой ступени строки в порядке `taskId`, перемешивание Фишера — Йейтса на генераторе mulberry32 с зерном из хэша FNV-1a (32 бита, на `Math.imul`, без `Math.random()`) от строки «период:начало срока:ступень», первые `quota[tier]`; нехватка добирается тем же приёмом из остатка пула (зерно с суффиксом `:fill`);
   - `inPlay(defs, at): TaskDef[]` — строки без `tier` и вне `daily`/`weekly` плюс выбранные.
5. **`tasks.service.ts`:** `onRun` берёт `inPlay(await this.active(), run.finishedAt)`, `measure(run, def.filter)`; `visible(account, at)` и `view`/`claim`/`open` — только то, что в игре на `at` (вчерашнее задание нельзя забрать по прямому запросу); `badge()` считает только строки заданий «в игре»; `viewOf`: `category: isCheckedKind(def.kind) ? "partner" : def.period`, в `TaskView` добавляются `tier: PoolTier | null` и `filter: RunFilter | null`; `catalog()` возвращает ещё `rotation: { daily: string[]; weekly: string[] }` на сейчас. Кеша набора нет: перемешать два десятка строк дешевле, чем держать кеш.
6. **`tasks.repository.ts`:** `catalog()`, `insert`, `update` и `defSchema` — две колонки (`tier`, `filter` как `::jsonb`); `TaskDef` в `update` меняет `tier` и `filter`, вид и срок по-прежнему нет.
7. **Забег → задания:** `RecordedRun` получает `weapons: { id: string; level: number }[]`, `boosts: string[]` (оплаченные: из `run.boosts`, если статус `paid`, иначе `[]`), `xpCollected: number | null` (из `run.stats?.xpCollected ?? null`); `runs.service.ts` заполняет их в `hooks.emit`. Остальные слушатели `onRecorded` их игнорируют.
8. **Панель (`apps/admin`):** `api/tasks.ts` — те же два поля в схеме и проверка формы (зеркало серверной); `TasksScreen.tsx` — у дневных и недельных поле «Ступень» («Не в ротации (всегда)», «Лёгкое», «Среднее», «Сложное»), у видов с фильтром выбор оружия, стихии или сложности (подписи из русских имён), столбец «Ступень» в списке, над списком блок «Сегодня в ротации» из `rotation` и строка «Правка пула в течение суток меняет сегодняшний набор у всех игроков». `ui/help.ts` — подсказки к двум полям.
9. **Клиент (`app-shell`):** `tasks-api.ts` — в `taskSchema` `tier` и `filter` необязательные (`z.optional`, сервер до ротации их не отдавал); `task-row.tsx` — для видов с фильтром в аргументы текста идут `weapon` (`t("weapon.<id>.name")`), `element` (`t("task.element.<id>")`), `difficulty` (`t("difficulty.<id>.name")`); нет фильтра — текст по `title` из каталога, экран не падает.
10. **Тексты в `i18n/ru-tasks.json`, дословно:**
    - `"task.kind.xp_collected": "Собери {count} опыта в сумме за забеги"`
    - `"task.kind.weapon_runs": "Сыграй {count} {target, plural, one {забег} few {забега} many {забегов} other {забега}} с оружием «{weapon}»"`
    - `"task.kind.element_runs": "Сыграй {count} {target, plural, one {забег} few {забега} many {забегов} other {забега}} с оружием стихии «{element}»"`
    - `"task.kind.difficulty_runs": "Сыграй {count} {target, plural, one {забег} few {забега} many {забегов} other {забега}} на сложности «{difficulty}»"`
    - `"task.kind.difficulty_survive_sec": "Продержись {time} в одном забеге на сложности «{difficulty}»"`
    - `"task.kind.boost_runs": "Сыграй {count} {target, plural, one {забег} few {забега} many {забегов} other {забега}} с бустом"`
    - `"task.element.fire": "Огонь"`, `"task.element.cold": "Холод"`, `"task.element.lightning": "Молния"`, `"task.element.poison": "Яд"`
11. **Документы:** `docs/22` (строка `task_completed`, `achievement_unlocked`: в перечне `kind` — шесть новых видов), `docs/21` (колонки), `docs/30-configuration-map.md` (строка «Ротация заданий: квоты `POOL_QUOTA` в `task-pool.ts`, ступень и фильтр — в каталоге из панели»).

## Чего не трогаем

- Очки заданий, ступени очков и награды за них: T-0105. Колонку `pass_points` не читаем и не пишем.
- Достижения (`achievement`): ротации у них нет, новые виды цели им доступны, но строк мы не добавляем: T-0106.
- Экран заданий `tasks.tsx` и `tasks-rules.ts` (T-0098): здесь только текст строки и схема.
- Виды про сундуки, эволюции, боссов, элиты, кристаллы штуками: нужны счётчики в итоге забега.
- Вердикт забега, сверка снаряжения (`run-loadouts.ts`), `core-game`: итог забега не меняем.
- Партнёрские цели и задания рекламных сетей.

## Сценарий и интерфейс

- **Игрок:** экран тот же, строк в «День» пять, в «Неделе» шесть плюс всегда видимые; новые строки читаются по виду («Сыграй 2 забега с оружием «Искра»»). После полуночи по Москве «День» показывает другой набор, прогресс вчерашнего остаётся у вчерашних строк.
- **Старый клиент:** `tier` и `filter` игнорирует. Новый вид, которого в его словаре нет, он нарисует без текста (`title` в каталоге `null`), поэтому новые клиент и сервер выходят в одном поезде, а ключи текста выше обязательны.
- **Панель:** загрузка, пусто, ошибка — как у экрана сейчас; «Сегодня в ротации» перечисляет id набора дня и недели.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/task-pool.test.ts` (чистые функции):
  - `gameDayOf(2026-10-13T20:59:59Z)` → `2026-10-13`; `…T21:00:00Z` → `2026-10-14`; `gameWeekStartOf(2026-10-18T20:59:59Z)` → `2026-10-12` (понедельник), `2026-10-18T21:00:00Z` → `2026-10-19`;
  - `pickPool` на пуле 20 дневных: ровно 5, по ступеням 2/2/1; два вызова с теми же данными равны; порядок входного массива на результат не влияет;
  - на 90 подряд идущих днях: каждая из 20 строк попала хотя бы раз, и подряд идущие дни хоть раз различаются;
  - недельный пул 12 → 6 по 2/3/1;
  - в ступени «сложные» ни одной включённой строки → набор всё равно из 5, добор из остальных; выключенные и без `tier` строки в набор не попадают;
  - `inPlay`: строки без `tier`, достижения и партнёрские видны всегда, невыбранные пула — нет.
- `backend/api/test/tasks.test.ts`:
  - шесть видов: `measure` на забеге с `weapons: [{ id: "storm" }]`, `boosts: ["fury"]`, `xpCollected: 700`, сложность `hard`: `xp_collected` → 700; `xpCollected: null` → 0; `weapon_runs` с `storm` → 1, с `spark` → 0; `element_runs` `lightning` → 1, `fire` → 0; `difficulty_runs` `hard` → 1, `easy` → 0; `difficulty_survive_sec` `hard` на 200,9 с → 200, на другой сложности → 0; `boost_runs` с пустым `boosts` → 0;
  - `taskDefSchema`: `weapon_runs` без `filter` — отказ; `runs` с `filter` — отказ; `element_runs` со стихией `water` — отказ; `tier` у `achievement` — отказ; `tier` у партнёрской цели — отказ; верная строка проходит;
  - `viewOf`: у цели с `filter` `category` равна периоду, не `partner`;
  - сверка `WEAPON_ELEMENTS` с `packages/core-game/src/content/weapons.ts`: оружие со стихией есть в таблице с той же стихией, оружия без стихии в таблице нет.
- `backend/api/test/runs.test.ts`: `hooks.emit` получает `weapons`, `boosts: []` при статусе бустов `unpaid` и `["fury"]` при `paid`, `xpCollected: null` без `stats`.
- `backend/api/test/tasks.integration.test.ts` (живые Postgres и Redis): после миграции дневных строк пула 20 (8/8/4), недельных 12 (4/5/3), у семи старых строк `tier` задан, награды не изменились; забег игрока двигает только выбранные на этот день дневные задания, невыбранные остаются без строки прогресса; забор невыбранного — `TaskNotFoundError`; два игрока видят один набор; тот же игрок на следующих сутках — другой набор (при фиксированном `at`); `badge()` не считает невыбранные; границы суток: `gameDayOf` совпадает с `periodStartSql` на `20:59:59Z`/`21:00:00Z` и на воскресенье/понедельник.
- `apps/admin/test/tasks.test.ts`: форма отклоняет вид с фильтром без фильтра, `tier` у достижения; принимает верную строку.
- `packages/app-shell/test/tasks-api.test.ts`: ответ без `tier` и `filter` разбирается; ответ с ними — тоже; все ключи `task.kind.*` и `task.element.*` из таблицы есть в `ru-tasks.json`, а для каждого оружия и сложности из стартового пула есть `weapon.<id>.name` и `difficulty.<id>.name`.

## Аналитика

События не меняются: `task_completed` шлёт клиент как раньше, `kind` — любой из словаря видов. В `docs/22-analytics-and-metrics.md` §3.3 в строке `task_completed`, `achievement_unlocked` дополнить перечень `kind` шестью новыми.

## Настройки и окружение

Новых ключей и переменных нет. Квоты `POOL_QUOTA` — константа кода, строки и ступени — каталог из панели.

## Документы

`docs/21-diagrams.md` (колонки `task_def`), `docs/22` (перечень видов), `docs/30-configuration-map.md` (строка про ротацию), `docs/39-retention-mechanics.md` §3 (строка «Задания» — пул и 11 видов цели).

## Вопросы к тимлиду

- �Подтверждено `claude-lead-1` 13.10.2026: боссы, элиты, кристаллы штуками и «забег без урона» не в этой задаче; нужна отдельная задача «счётчики в итоге забега» (`stats.bossKills`, `stats.eliteKills`, `stats.crystals`) в `core-game`, `runFinishSchema` и `RecordedRun`.
- Проверено по зонам T-0099–T-0103: линия сундуков и эволюций `backend/api/src/modules/runs/` не меняет, пересечения с `runs.service.ts` и `runs-hooks.ts` нет.
- Геймдизайнеру: цели `xp_collected` (500 / 1500 / 15000) подобраны без данных; снять медиану `xpCollected` забега на деве.
- Ступень «в ротации» у партнёрских рекламных заданий не нужна и не предусмотрена.

## Критерии приёмки

- [ ] Все тесты из раздела «Тесты» зелёные; миграция только добавляет колонки и строки, папка миграции одна.
- [ ] На деве у двух аккаунтов один набор из 5 дневных и 6 недельных; после смены суток по Москве набор другой.
- [ ] Шесть новых видов двигаются забегом; цель с фильтром не попадает на вкладку «Партнёры».
- [ ] Невыбранное задание нельзя забрать запросом; знак меню считает только выбранные.
- [ ] Панель показывает «Сегодня в ротации», сохраняет `tier` и `filter`.
- [ ] Дифф только в зонах задачи; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Ротация заданий и новые виды цели`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: ежедневные и недельные задания меняются каждый день и каждую неделю, новые цели про оружие, стихии, сложность и бусты`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РОТАЦИЯ ЗАДАНИЙ И НОВЫЕ ВИДЫ ЦЕЛИ**

  В каталоге заданий появился пул: 20 дневных и 12 недельных, игрок каждый день видит пять, каждую неделю шесть, набор одинаков у всех и считается от даты. Добавлены шесть видов цели по итогу забега: опыт, оружие, стихия, сложность, буст.

  🛠 **Задания и панель**

  • ступени «лёгкое / среднее / сложное» и фильтр цели в каталоге; в панели блок «Сегодня в ротации»
  • правка пула в течение суток меняет сегодняшний набор у всех

  ❓ **Нужно от команды**

  • @участник1 — геймдизайнеру откалибровать цели и награды пула (стартовые числа в спецификации)
  ```
