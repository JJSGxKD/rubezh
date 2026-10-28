---
id: T-0126
title: Задания и достижения: боссы, элиты, сундуки, кристаллы, эволюции
epic: E16
priority: P1
status: ready
owner:
author: claude-lead2-20
size: M
depends_on:
  - T-0125
  - T-0104
  - T-0106
  - T-0102
zones:
  - backend/api/src/modules/tasks/task-rules.ts
  - backend/api/test/tasks.test.ts
  - backend/api/test/tasks.integration.test.ts
  - backend/api/test/achievements.integration.test.ts
  - apps/admin/src/api/tasks.ts
  - apps/admin/src/screens/tasks/TasksScreen.tsx
  - apps/admin/test/tasks.test.ts
  - packages/app-shell/src/screens/meta/task-row.tsx
  - packages/app-shell/src/i18n/ru-tasks.json
  - packages/app-shell/test/tasks-api.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - docs/22-analytics-and-metrics.md
  - docs/39-retention-mechanics.md
  - backend/api/prisma/migrations/**
  - apps/admin/src/ui/help.ts
runner: any
executor: sonnet-5.5
effort: high
release: minor
design: null
batch: 3
---

# T-0126. Задания и достижения: боссы, элиты, сундуки, кристаллы, эволюции

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0126.json)](README.md#значки-статуса) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](archive/T-0125-run-result-rank-chest-crystal-counters.md) [![T-0104](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0104.json&label=T-0104)](archive/T-0104-tasks-pool-rotation-new-kinds.md) [![T-0106](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0106.json&label=T-0106)](T-0106-achievements-prestige-server.md) [![T-0102](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0102.json&label=T-0102)](archive/T-0102-weapon-evolutions-data-and-engine.md)

## Зачем

Сундуки, эволюции, элиты и боссы появились в забеге, а заданий и достижений про них нет: игроку не за что вернуться к этим механикам, а геймдизайнеру нечем ими управлять. После задачи в каталоге пять новых видов цели и стартовый набор строк на них: 15 заданий в пул дня и недели и 17 достижений в лестницах (`docs/39-retention-mechanics.md` П1, К1, решение Р102).

## Решения

Исполнитель их не пересматривает. Основа: T-0104 (пул, ступени, виды цели по итогу забега), T-0106 (достижения с категориями, лестницами и престижем), T-0125 (счётчики в итоге забега), T-0102 (эволюции оружия).

- **Пять новых видов, все считаются по итогу забега, действие «сумма», фильтра нет:**

  | Вид | Что считает | Берётся из |
  |---|---|---|
  | `boss_kills` | убитые боссы | `counters.bossKills` |
  | `elite_kills` | убитые элиты | `counters.eliteKills` |
  | `chests_opened` | открытые сундуки | `counters.chestsOpened` |
  | `crystals_collected` | подобранные кристаллы | `counters.crystals` |
  | `evolution_runs` | забеги, где к концу есть эволюция | 1, если среди `weapons[]` есть эволюция, иначе 0 |

  `counters` — поле `RecordedRun` из T-0125: объект с четырьмя числами или `null` (старый клиент, нет `stats`, счётчики неправдоподобны). `null` даёт 0 по всем четырём видам, а сам забег остаётся забегом для видов `runs`, `kills` и прочих.
- **Эволюция читается из итога, а не из события.** Событие `evolution_unlocked` клиентское: оно идёт в аналитику, до сервера не доходит (серверные события отложены, `docs/22` §3). Эволюция занимает слот базового оружия (T-0102, решение 4), поэтому id эволюции стоит в `weapons[]` итога к концу забега; специального счётчика не нужно, и вид работает и у клиента без T-0125.
- **Эволюция считается своим базовым оружием.** Пара «оружие — эволюция» (T-0102, решение 8): `spark` — `starfall`, `storm` — `tempest`, `knife` — `blade_whirl`, `wardstone` — `frost_crown`, `hearth` — `forge`, `sting` — `viper`. Виды `weapon_runs` и `element_runs` из T-0104 сверяли id в итоге напрямую, и забег с эволюцией не считался бы ни «с Грозой», ни «со стихией молнии». Здесь это исправляется таблицей `WEAPON_EVOLUTIONS` (id эволюции → id базового) в `task-rules.ts` и функцией `baseWeaponOf(id)`; сверка таблицы с `core-game` — тестом, как `WEAPON_ELEMENTS`.
- **Стихия эволюции — стихия базового** (T-0102, решение 2), отдельных строк в `WEAPON_ELEMENTS` не заводим.
- **Награды и ступени новых заданий — по ступени, как в T-0104:** день — лёгкое 70, среднее 110, сложное 160 монет; неделя — 300 / 550 / 900, у сложного ещё 5 осколков. Очки заданий (`pass_points`) — те же, что у других строк той же ступени и срока: опорные строки `daily_runs` / `daily_kills` / `daily_level` и `weekly_runs` / `weekly_kills` / `weekly_best_540`, значение берётся подзапросом в `INSERT … SELECT`, своих чисел не придумываем (как они заданы, видно в миграции T-0105).
- **Награды и престиж новых достижений — по лестницам из T-0106:** монеты 100 / 200 / 400 / 800 и престиж 5 / 10 / 20 / 40 для четырёх ступеней, 100 / 200 / 400 и 5 / 10 / 20 для трёх; у «боссов» и «эволюций» вдвое больше (200 / 400 / 800 и 10 / 20 / 40), потому что их труднее получить.
- **Цели — стартовые, геймдизайнер калибрует.** Масштаб `crystals` за забег неизвестен, боссы приходят в бесконечной кривой не раньше середины забега (`ENDLESS_CURVE`, каждый пятый отрезок; первую элиту T-0099 ставит на 90-ю секунду): цели сняты с потолка, см. «Вопросы».

Стартовые задания (текст строится у клиента по виду, `title` — `NULL`, `filter` — `NULL`, `active` — `true`):

| Срок | Ступень | id (вид, цель) |
|---|---|---|
| день | лёгкое | `daily_elite_1` (`elite_kills`, 1) · `daily_chest_1` (`chests_opened`, 1) · `daily_crystals_300` (`crystals_collected`, 300) |
| день | среднее | `daily_elite_3` (`elite_kills`, 3) · `daily_chest_3` (`chests_opened`, 3) · `daily_crystals_1000` (`crystals_collected`, 1000) |
| день | сложное | `daily_boss_1` (`boss_kills`, 1) · `daily_evolution` (`evolution_runs`, 1) |
| неделя | лёгкое | `weekly_elite_5` (`elite_kills`, 5) · `weekly_chest_5` (`chests_opened`, 5) |
| неделя | среднее | `weekly_elite_15` (`elite_kills`, 15) · `weekly_chest_12` (`chests_opened`, 12) · `weekly_crystals_5000` (`crystals_collected`, 5000) |
| неделя | сложное | `weekly_boss_3` (`boss_kills`, 3) · `weekly_evolution_2` (`evolution_runs`, 2) |

Пул дня после задачи — 28 строк (11 / 11 / 6 по ступеням), недели — 19 (6 / 8 / 5). Квоты ротации `POOL_QUOTA` (5 в день, 6 в неделю) не меняются: ротацию не трогаем.

Стартовые достижения (лестница — общее `ladder`, `rung` с 1; категория, престиж и монеты — по правилам выше; `sort` — с 600 шагом 10 по порядку таблицы):

| Категория | Лестница, вид | Ступени: id — цель — «название» |
|---|---|---|
| `combat` | `elite`, `elite_kills` | `ach_elite_1` 1 «Первая элита»; `ach_elite_10` 10 «Охотник на элит»; `ach_elite_50` 50 «Гроза элит»; `ach_elite_200` 200 «Погибель элит» |
| `combat` | `boss`, `boss_kills` | `ach_boss_1` 1 «Первый босс»; `ach_boss_5` 5 «Истребитель боссов»; `ach_boss_25` 25 «Гроза боссов» |
| `collection` | `chest`, `chests_opened` | `ach_chest_1` 1 «Первая находка»; `ach_chest_10` 10 «Кладоискатель»; `ach_chest_50` 50 «Хозяин сундуков»; `ach_chest_200` 200 «Король сундуков» |
| `collection` | `crystal`, `crystals_collected` | `ach_crystal_1k` 1 000 «Горсть кристаллов»; `ach_crystal_10k` 10 000 «Мешок кристаллов»; `ach_crystal_100k` 100 000 «Кристальная гора» |
| `collection` | `evolution`, `evolution_runs` | `ach_evolution_1` 1 «Превращение»; `ach_evolution_5` 5 «Эволюционист»; `ach_evolution_25` 25 «Мастер превращений» |

Итого 17 достижений (4 + 3 + 4 + 3 + 3); скрытых среди них нет, подсказок нет.

## Как сейчас

(после T-0104, T-0106, T-0125; к моменту взятия задачи они в `dev`)

- `backend/api/src/modules/tasks/task-rules.ts`: `RUN_KINDS` — одиннадцать видов по итогу забега (пять старых и шесть из T-0104), у каждого `measure(run, filter)`; `RUN_FILTER_KEYS` — виды с фильтром; `WEAPON_ELEMENTS` — оружие → стихия; `TaskRun` — `Pick<RecordedRun, …>` с `weapons`, `boosts`, `xpCollected`; `taskDefSchema` — `.strict()`, виды берёт из `TASK_KIND_IDS`; `STATE_KINDS` (`friends`, `account_level`) из T-0106 забегом не двигаются.
- `RecordedRun` после T-0125 несёт `counters: RunCounters | null` (`runs-hooks.ts`); `TaskRun` его пока не выбирает.
- Каталог засеян миграциями: `20260930095851_tasks` (старые строки), T-0104 (пул 20 + 12, ступень `tier`, колонка `filter`), T-0105 (очки `pass_points`), T-0106 (49 достижений, колонки `category`, `ladder`, `rung`, `hidden`, `hint`, `prestige`, названия в `title`).
- `packages/app-shell/src/screens/meta/task-row.tsx`: текст цели — ключ `task.kind.<вид>` из `i18n/ru-tasks.json`; для достижения название — `title` из каталога. `state/tasks-api.ts` вид не перечисляет (`kind` — строка).
- В панели (`apps/admin/src/api/tasks.ts`, `TasksScreen.tsx`) виды перечислены списком для выбора в форме и зеркалят серверную проверку.
- Эволюции в контенте (T-0102): записи `WEAPONS` с `evolvedFrom`; `WEAPON_EVOLUTIONS` в `content/weapons.ts`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`task-rules.ts`.**
   - `export const WEAPON_EVOLUTIONS = { starfall: "spark", tempest: "storm", blade_whirl: "knife", frost_crown: "wardstone", forge: "hearth", viper: "sting" } as const` и `baseWeaponOf(id: string): string` (`WEAPON_EVOLUTIONS[id] ?? id`).
   - `TaskRun` дополняется полем `counters` (выбирается из `RecordedRun`).
   - Пять видов в `RUN_KINDS`: `boss_kills` → `run.counters?.bossKills ?? 0`; `elite_kills` → `eliteKills`; `chests_opened` → `chestsOpened`; `crystals_collected` → `crystals`; `evolution_runs` → `run.weapons.some((w) => w.id in WEAPON_EVOLUTIONS) ? 1 : 0`. Фильтра у них нет: `taskDefSchema` уже отказывает фильтру у видов не из `RUN_FILTER_KEYS`.
   - `weapon_runs` и `element_runs` (T-0104): сверка через `baseWeaponOf(w.id)`, то есть эволюция считается своим базовым оружием (`WEAPON_ELEMENTS[baseWeaponOf(w.id)]`).
3. **Миграция** (после перебазирования на свежий `dev`, `prisma migrate dev --create-only` один раз, проверить, что папка одна; только добавление, без `UPDATE` и `DELETE` существующих строк):
   - 15 строк заданий по таблице: `INSERT … ON CONFLICT (task_id) DO NOTHING`; `period` `daily` или `weekly`, `tier` по таблице, `title` — `NULL`, `filter` — `NULL`, `active` — `true`, награда по ступени из «Решений», `pass_points` — подзапросом из опорной строки ступени и срока, `sort` 150+ для лёгких, 250+ для средних, 350+ для сложных (внутри ступени по алфавиту id);
   - 17 строк достижений: `period` `achievement`, `kind` и цель по таблице, `title` — название, `category`, `ladder`, `rung`, `prestige`, награда монетами, `hidden` — `false`; остальные колонки и форму `INSERT` взять у строк достижений из миграции T-0106 (скопировать порядок колонок оттуда, не придумывать).
   Новых колонок и таблиц нет: `schema.prisma` не меняется (если Prisma попросит «обновить» файл, это не нужно).
4. **Панель (`apps/admin`).** `api/tasks.ts`: пять видов в списке видов и в проверке формы (фильтра у них нет); `TasksScreen.tsx`: русские подписи видов («Боссы», «Элиты», «Сундуки», «Кристаллы», «Эволюции»); `ui/help.ts`: одна строка подсказки про то, что эти виды считаются по итогу забега и у забега без счётчиков дают 0.
5. **Клиент (`app-shell`).** `i18n/ru-tasks.json` — пять ключей дословно:
   - `"task.kind.boss_kills": "Убей {count} {target, plural, one {босса} few {босса} many {боссов} other {босса}}"`
   - `"task.kind.elite_kills": "Убей {count} {target, plural, one {элиту} few {элиты} many {элит} other {элиты}}"`
   - `"task.kind.chests_opened": "Открой {count} {target, plural, one {сундук} few {сундука} many {сундуков} other {сундука}}"`
   - `"task.kind.crystals_collected": "Подбери {count} {target, plural, one {кристалл} few {кристалла} many {кристаллов} other {кристалла}}"`
   - `"task.kind.evolution_runs": "Получи эволюцию оружия в {count} {target, plural, one {забеге} few {забегах} many {забегах} other {забегах}}"`
   `task-row.tsx`: вид без фильтра идёт тем же путём, что `xp_collected` и `boost_runs`, правок в коде, скорее всего, нет; если тест покажет, что число цели подставляется иначе, поправить там.
6. **Документы.** `docs/22` §3.3: в строке `task_completed`, `achievement_unlocked` перечень `kind` — пять новых видов; `docs/39` §3: строки «Задания» (пул 28 + 19, 16 видов цели) и «Достижения» (66 штук, 5 новых лестниц).

## Чего не трогаем

- Ротацию, квоты, очки и пасс (T-0104, T-0105): только строки данных.
- Витрину достижений, избранное, редкость (T-0106, T-0107), серверные события.
- Счётчики и итог забега (`core-game`, `runs`): T-0125; здесь только читаем `counters`.
- Вид «забег без урона» и фильтры по врагам («убей босса `boss_matryoshka`»): нужны данные, которых в итоге нет.
- Колонки `task_def`, схему базы, `tasks.service.ts` (его `onRun` отдаёт `run` целиком в `measure`; правка нужна, только если тест покажет, что `counters` не доходит).
- Имена и описания механик в гайдбуке.

## Сценарий и интерфейс

- **Игрок:** в «Дне» и «Неделе» иногда попадаются новые строки («Убей 3 элиты», «Открой 5 сундуков»); в «Достижениях» новые лестницы в категориях «Бой» и «Коллекция». Экраны те же. Забег старой сборки без счётчиков эти цели не двигает, остальные цели двигает как раньше.
- **Панель:** в форме задания новые виды в списке видов; загрузка, пусто, ошибка — как у экрана сейчас.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/tasks.test.ts`:
  - счётчики: `counters { bossKills: 2, eliteKills: 3, chestsOpened: 4, crystals: 500 }` → `measure` пяти видов даёт 2 / 3 / 4 / 500 / (эволюция по оружию, ниже); `counters: null` → 0 по четырём;
  - `evolution_runs`: `weapons: [{ id: "tempest" }]` → 1; `[{ id: "storm" }]` → 0; `[]` → 0; два оружия, одно эволюция → 1 (не 2);
  - эволюция как базовое: `weapon_runs` с фильтром `storm` на забеге с `tempest` → 1; `element_runs` `lightning` с `tempest` → 1, `fire` → 0; `baseWeaponOf("spark")` → `spark`, `baseWeaponOf("starfall")` → `spark`;
  - `taskDefSchema`: `boss_kills` с `filter` → отказ; `evolution_runs` без `filter` проходит; `tier` у достижения — отказ (правило T-0104 не сломано);
  - сверка с `packages/core-game/src/content/weapons.ts` (относительный импорт, как у цен бустов): каждая запись контента с `evolvedFrom` есть в `WEAPON_EVOLUTIONS` с тем же базовым, лишних строк нет; стихия эволюции в контенте равна `WEAPON_ELEMENTS[базовое]`.
- `backend/api/test/tasks.integration.test.ts` (живые Postgres и Redis):
  - после миграции дневных строк пула 28 (11 / 11 / 6), недельных 19 (6 / 8 / 5), у каждой новой `tier` задан, `title` и `filter` пусты; награды по ступени равны таблице решений; `pass_points` равны очкам опорной строки той же ступени и срока;
  - `pickPool`: дневной набор по-прежнему ровно 5 (2 / 2 / 1), недельный 6 (2 / 3 / 1);
  - забег с `counters { eliteKills: 3 }` двигает выбранное на этот день `daily_elite_3` до цели; забег с `counters: null` не двигает ни одно из новых; забег с читами — не двигает; повтор того же `runId` прогресс не удваивает.
  Прежние ожидания «20 / 12» из T-0104 заменить на 28 / 19 в том же файле.
- `backend/api/test/achievements.integration.test.ts`: прежние границы «от 40 до 50 достижений» заменить на ровно 66 (49 + 17); ступени каждой лестницы идут 1…n без пропусков, цель и престиж растут; у новых категория `combat` или `collection`, `prestige > 0`, `hidden = false`; забег с `counters { bossKills: 1 }` выполняет `ach_boss_1`, а `ach_boss_5` двигает на 1; забор `ach_boss_1`: монеты на балансе один раз, причина `achievement_reward`; забег с эволюцией `viper` в `weapons[]` выполняет `ach_evolution_1`, а `ach_weapon_sting` (T-0106) считает тот же забег за оружие «Жало».
- `apps/admin/test/tasks.test.ts`: форма принимает пять новых видов, отклоняет у них фильтр.
- `packages/app-shell/test/tasks-api.test.ts`: пять ключей `task.kind.*` из таблицы есть в `ru-tasks.json`; через тот же `t(ключ, { count, target })`, что в `task-row.tsx`, получаются строки: «Убей 1 босса» / «Убей 2 босса» / «Убей 5 боссов»; «Убей 1 элиту» / «Убей 2 элиты» / «Убей 5 элит»; «Открой 1 сундук» / «Открой 2 сундука» / «Открой 5 сундуков»; «Подбери 1 кристалл» / «Подбери 2 кристалла» / «Подбери 5 кристаллов»; «Получи эволюцию оружия в 1 забеге» / «… в 2 забегах» / «… в 5 забегах».

## Аналитика

События не меняются: `task_completed` и `achievement_unlocked` шлёт клиент как раньше, `kind` — любой из словаря видов. В `docs/22-analytics-and-metrics.md` §3.3 в строке `task_completed`, `achievement_unlocked` дополнить перечень `kind` пятью новыми. Новых событий нет: данные для калибровки целей даёт `run_finished` с полями из T-0125.

## Настройки и окружение

Нет. Награды и цели строк — каталог из панели (правятся без релиза), квоты ротации — константа T-0104.

## Документы

`docs/22-analytics-and-metrics.md` (перечень `kind`), `docs/39-retention-mechanics.md` §3 (строки «Задания» и «Достижения»).

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: эволюция читается из `weapons[]` итога, а не из события `evolution_unlocked` (оно до сервера не доходит); счётчика эволюций в T-0125 нет.
- Подтверждено `claude-lead-1` 14.10.2026 по умолчанию: эволюция считается своим базовым оружием в `weapon_runs` и `element_runs` (иначе «Мастер Грозы» не засчитал бы забег с эволюцией Грозы); исправление лежит здесь, потому что эволюции появляются в T-0102 позже T-0104.
- Геймдизайнеру: цели `crystals_collected` (300 / 1000 / 5000 и лестница 1 000 / 10 000 / 100 000) подобраны без данных; снять медиану `run.details->>'crystals'` с дева. Цели `elite_kills` и `chests_opened` исходят из того, что первая элита приходит около 90-й секунды, а сундук падает с каждой.
- Боссы в бесконечной кривой приходят не раньше середины забега (в таймлайне до 330 с боссов нет), а медиана бота умирает раньше: `daily_boss_1`, `weekly_boss_3`, `ach_boss_*` могут оказаться недостижимы для большинства. Решение за тимлидами и геймдизайнером после теста: поставить босса раньше (контент `waves.ts`, вне задачи) или убрать строки; исполнитель ничего не подгоняет.
- Точка разреза, если задача не влезет в M: достижения (17 строк и их тесты) выносятся отдельной задачей, задания остаются.

## Критерии приёмки

- [ ] Тесты из раздела «Тесты» зелёные; миграция только добавляет строки, папка миграции одна.
- [ ] Пять новых видов двигаются забегом по счётчикам T-0125 и по `weapons[]`; забег без счётчиков или с неправдоподобными их не двигает.
- [ ] Забег с эволюцией считается и своим базовым оружием, и своей стихией.
- [ ] В каталоге пул дня 28, недели 19, достижений 66; ротация по-прежнему 5 в день и 6 в неделю.
- [ ] Тексты новых видов склоняются верно для 1, 2 и 5.
- [ ] Дифф только в зонах задачи; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Задания про боссов, элит и сундуки`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: задания и достижения про боссов, элит, сундуки, кристаллы и эволюции оружия`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАДАНИЯ И ДОСТИЖЕНИЯ ПРО БОССОВ, ЭЛИТ И СУНДУКИ**

  Появились пять видов цели по счётчикам забега: боссы, элиты, сундуки, кристаллы и эволюции оружия. В пул заданий добавлено 15 строк (день 28, неделя 19), в каталог достижений 17 (всего 66). Забег с эволюцией теперь считается и своим базовым оружием.

  🛠 **Задания и достижения**

  • цели и награды новых строк стартовые, правятся из панели
  • боссы приходят в бесконечной кривой не раньше середины забега: задания на боссов могут быть недостижимы

  ❓ **Нужно от команды**

  • @владелец — геймдизайнеру откалибровать цели кристаллов и решить, оставлять ли задания на боссов, пока босс не приходит раньше
  ```
