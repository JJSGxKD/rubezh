---
id: T-0106
title: Достижения с престижем: сервер, 49 определений, редкость «есть у N%»
epic: E16
priority: P1
status: ready
owner:
author: claude-lead2-16
size: M
depends_on:
  - T-0105
  - T-0210
zones:
  - backend/api/src/modules/achievements/**
  - backend/api/src/modules/tasks/task-rules.ts
  - backend/api/src/modules/tasks/tasks.service.ts
  - backend/api/src/modules/tasks/tasks.repository.ts
  - backend/api/src/modules/friends/friends.repository.ts
  - backend/api/src/modules/friends/friends.service.ts
  - backend/api/test/achievements.test.ts
  - backend/api/test/achievements.integration.test.ts
  - backend/api/test/tasks.test.ts
  - apps/admin/src/api/tasks.ts
  - apps/admin/src/screens/tasks/TasksScreen.tsx
  - apps/admin/src/ui/help.ts
  - packages/app-shell/src/screens/meta/task-row.tsx
  - packages/app-shell/test/tasks-api.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/**
  - backend/api/src/app.module.ts
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/src/modules/events/event-dictionary.ts
  - docs/21-diagrams.md
  - docs/22-analytics-and-metrics.md
  - docs/30-configuration-map.md
  - docs/39-retention-mechanics.md
  - backend/api/src/modules/wipe/wipe-plan.ts
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 2
---

# T-0106. Достижения с престижем: сервер, 49 определений, редкость «есть у N%»

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0106.json)](README.md#значки-статуса) [![T-0105](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0105.json&label=T-0105)](T-0105-task-points-and-rewards.md) [![T-0210](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0210.json&label=T-0210)](T-0210-notifications-read-by-action.md)

## Зачем

Достижений десять, это числа без лица: нет категорий, лестниц, скрытых, редкости и очков престижа. После задачи на сервере 49 достижений в четырёх категориях с очками престижа, у каждого видно «есть у N% игроков», у игрока три любимых и сумма престижа. Цель, которая не влияет на баланс (`docs/39-retention-mechanics.md` К1, Р102: награды — престиж и немного мягкой валюты, без боевой силы). Витрину рисует T-0107.

## Решения

**Поправка `claude-lead-1` от 20.10.2026 (Р126, единая сложность).** «Нормальная» новым клиентом не выдаётся, «Лёгкая» — только обучающий первый забег. Лестницы с фильтром `normal` или `easy` (`ach_normal_5` и подобные) переводятся на `hard` с теми же числами, если лестница `hard` с ними не совпадает, иначе — убираются; скрытые на `hard` — как были.

- **Достижения остаются в `task_def` с периодом `achievement`, отдельных таблиц определений нет.** Причина по коду: прогресс по забегу (`onRun`), защита от повтора по `run_id` (`task_run`), забор с идемпотентным начислением, причина `achievement_reward` со своим потолком кошелька, знак меню и редактирование из панели (`tasks.edit`) уже работают на этих таблицах. Вторая пара таблиц дублировала бы всё это. Новое — колонки определения и две таблицы: редкость и избранное, и отдельный модуль `achievements` с витриной, редкостью и избранным.
- **Лестница — несколько строк с общим `ladder` и номером ступени `rung`.** Каждая ступень считает с нуля независимо (значение строки не больше её цели), как сейчас `ach_survive_*`. Престиж у каждой ступени свой.
- **Категории:** `combat` («Бой»), `collection` («Коллекция»), `mastery` («Мастерство»), `friends` («Друзья»).
- **Скрытое:** `hidden = true`, пока не открыто. Сервер до открытия не отдаёт ни название, ни вид, ни цель, ни награду: только `id`, `category`, `hidden`, `done: false`, а подсказку `hint` отдаёт (она нужна игроку). Открытое показывается как обычное. И `GET /tasks`, и новая витрина скрывают закрытые скрытые.
- **Тексты — в каталоге, а не в словаре клиента:** название — `title`, подсказка — новая колонка `hint`. Для девяти старых достижений `title` проставляет миграция теми же словами, что в `ru-tasks.json` (`achievement.<id>.name`). Клиент показывает `title`, если он задан (шаг 10).
- **Престиж считается по выполненному** (`completed_at` не пуст), забирать награду не обязательно, и включает отключённые в панели достижения (выключили — престиж не пропадает).
- **Редкость «есть у N%».** Знаменатель — игроки, у которых есть хотя бы один записанный забег (`run.status = 'finished'`), числитель — те из них, у кого достижение выполнено. Считает фоновая задача по расписанию под распределённым локом Redis (образец — `fx/fx.refresher.ts`: `setInterval`, `SET … NX PX` с токеном, снятие скриптом), результат — таблица `achievement_rarity`. Процент показывается только при населении не меньше порога (`achievements.rarity_min_players`, старт 100): иначе у трёх игроков будет «100%». Округление до десятой доли.
- **Числа геймдизайна — стартовые, геймдизайнер калибрует:** цели, очки престижа и награды в таблице ниже. Очки престижа ступеней лестницы из пяти ступеней — 5 / 10 / 20 / 40 / 80, из четырёх — 5 / 10 / 20 / 40, из трёх — 5 / 10 / 20; одиночные («мастер оружия», «повелитель стихии») — 10; скрытые — 40. Награда новых достижений — монеты, без самоцветов; у старых награды не меняются (часть из них самоцветы, игроки их могли уже забрать).
- **Состояния «друзья» и «уровень аккаунта»** не двигает забег. Два новых вида цели, `friends` и `account_level` (действие `max`), обновляются при открытии витрины: сервер читает число друзей и уровень аккаунта и дописывает прогресс (значение не убывает). Хук в модуль друзей не ставим.
- **Событие.** `achievement_unlocked` уже есть в словаре (v1, шлёт клиент при получении награды). Серверные события отложены (`docs/22`, §3), новое серверное не заводим: расширяем клиентское необязательными `category` и `prestige`. Клиент их отправит в T-0107.
- **Нейтральная сторона антифрода:** итог забега считается теми же правилами, что и награда (`countsForTasks`); отдельной проверки достижений нет.

Определения (текст цели строит клиент по виду; `title` — название; монеты — награда нового достижения, «—» у существующего):

| Лестница / вид | Ступени: id — цель — «название» | Престиж | Монеты |
|---|---|---|---|
| Бой, `kills` | `ach_kills_100` 100 «Первая сотня»; `ach_kills_1k` 1 000 «Тысячник»; `ach_kills_10k` 10 000 «Косарь»; `ach_kills_50k` 50 000 «Гроза орды» (есть); `ach_kills_100k` 100 000 «Погибель орды» | 5/10/20/40/80 | 100/200/400/—/1 500 |
| Бой, `xp_collected` (лестница `xp`) | `ach_xp_5k` 5 000 «Искатель кристаллов»; `ach_xp_50k` 50 000 «Собиратель»; `ach_xp_500k` 500 000 «Кристальный магнат» | 5/10/20 | 100/200/400 |
| Бой, `survive_sec` (лестница `time`) | `ach_time_1h` 3 600 «Час на рубеже»; `ach_time_10h` 36 000 «Десять часов в бою»; `ach_time_100h` 360 000 «Сто часов на посту» | 5/10/20 | 100/200/400 |
| Коллекция, `boost_runs` (лестница `boost`) | `ach_boost_1` 1 «Подготовка»; `ach_boost_10` 10 «Запасливый»; `ach_boost_50` 50 «Снаряжён до зубов» | 5/10/20 | 100/200/400 |
| Коллекция, `weapon_runs`, цель 5, без лестницы | `ach_weapon_spark` «Мастер Искры»; `ach_weapon_knife` «Мастер Ножа»; `ach_weapon_wardstone` «Мастер Оберега»; `ach_weapon_hearth` «Мастер Очага»; `ach_weapon_storm` «Мастер Грозы»; `ach_weapon_sting` «Мастер Жала» (фильтр `weapon` — по id) | 10 | 150 |
| Коллекция, `element_runs`, цель 10 | `ach_element_fire` «Повелитель огня»; `ach_element_cold` «Повелитель холода»; `ach_element_lightning` «Повелитель молний»; `ach_element_poison` «Повелитель яда» | 10 | 150 |
| Мастерство, `best_survival_sec` (лестница `survive`) | `ach_survive_1` 60 «Первая минута»; `ach_survive_5` 300 «Держи рубеж»; `ach_survive_10` 600 «Несокрушимый»; `ach_survive_20` 1 200 «Последний рубеж» (все есть) | 5/10/20/40 | — |
| Мастерство, `run_level` (лестница `level`) | `ach_level_10` 10 «Разгон»; `ach_level_20` 20 «Закалка»; `ach_level_30` 30 «Опытный боец»; `ach_level_40` 40 «Мастер забега» (есть) | 5/10/20/40 | 100/200/400/— |
| Мастерство, `runs` (лестница `runs`) | `ach_runs_1` 1 «Первый забег»; `ach_runs_10` 10 «Бывалый»; `ach_runs_50` 50 «Ветеран»; `ach_runs_200` 200 «Старожил» (три последних есть) | 5/10/20/40 | 50/—/—/— |
| Мастерство, `difficulty_survive_sec` | `ach_hard_3` hard 180 «Закалённый»; `ach_hard_5` hard 300 «Несгибаемый» (лестница `hard`); `ach_normal_5` normal 300 «Середина пути» (без лестницы) | 20/40; 20 | 400/800; 400 |
| Мастерство, `account_level` (лестница `account`) | `ach_account_10` 10 «Десятый уровень»; `ach_account_25` 25 «Четверть сотни»; `ach_account_50` 50 «Полсотни» | 10/20/40 | 200/400/800 |
| Мастерство, скрытые | `ach_hidden_hard_7` (`difficulty_survive_sec`, hard, 420) «Выстоявший», подсказка «Выстоять там, где почти никто не выстаивает»; `ach_hidden_marathon` (`best_survival_sec`, 1 800) «Марафонец», «Продержаться очень, очень долго»; `ach_hidden_level_60` (`run_level`, 60) «Предел роста», «Расти, пока растёшь» | 40 | 500 |
| Друзья, `friends` (лестница `friends`) | `ach_friends_1` 1 «Не один»; `ach_friends_5` 5 «Свои люди»; `ach_friends_10` 10 «Отряд»; `ach_friends_25` 25 «Целый рубеж» | 5/10/20/40 | 100/200/400/800 |

Итого 49 (11 + 13 + 21 + 4), из них девять существующих. Виды `xp_collected`, `weapon_runs`, `element_runs`, `boost_runs`, `difficulty_survive_sec` и фильтры (`filter`) — из T-0104.

Решение `claude-lead-1` от 24.10.2026: задача ждёт T-0210 — обе правят
`friends.service.ts`, параллельно их не берут.

## Как сейчас

- Достижения — строки `task_def` с `period = 'achievement'`, девять штук (миграция `20260930095851_tasks`), одна строка прогресса на игрока и цель с началом срока `2000-01-01` (`ACHIEVEMENT_PERIOD_START`, `tasks.repository.ts`). Забор — `POST /tasks/:id/claim`, причина кошелька `achievement_reward` (`rewardReason`, `task-rules.ts`).
- После T-0104/T-0105 в `task_def` есть `tier`, `filter`, `pass_points`; в `TaskView` — `tier`, `filter`.
- Названия девяти — в клиентском словаре: `achievement.<id>.name` в `ru-tasks.json`; `task-row.tsx` (около стр. 160) строит ключ `achievement.${task.id}.name`.
- Число друзей и уровень аккаунта: модули `friends` (`friends.service.ts`, `friends.repository.ts`) и `progress` (`progress.service.ts`, тип `ProgressView`); готового «считать друзей» для этой задачи в них может не быть, тогда добавить минимальный метод.
- Фоновая задача с распределённым локом — `fx/fx.refresher.ts` (стр. 70–115): `onApplicationBootstrap` запускает `setInterval(() => void this.tick(), TICK_MS)`, `tick()` берёт ключ `SET LOCK_KEY token PX ttl NX`, работает, снимает скриптом `RELEASE_SCRIPT`, любой сбой — в лог.
- Рейтинг и профиль (`runs/runs-view.service.ts`) престижа не знают; их T-0107.

## Шаги по порядку

1. **Тесты первым коммитом.**
2. **Миграция** (только добавление; `--create-only` один раз; папка одна):
   - `task_def`: `category VARCHAR(16)`, `ladder VARCHAR(32)`, `rung SMALLINT`, `hidden BOOLEAN NOT NULL DEFAULT false`, `hint VARCHAR(120)`, `prestige INT NOT NULL DEFAULT 0`;
   - `CHECK`: `category IS NULL OR category IN ('combat','collection','mastery','friends')`; `(ladder IS NULL) = (rung IS NULL)`; `rung IS NULL OR rung > 0`; `prestige >= 0`; `hidden = false OR hint IS NOT NULL`; все новые колонки пусты, а `prestige = 0` и не `hidden`, если `period <> 'achievement'`;
   - `achievement_rarity (task_id varchar(48) PRIMARY KEY REFERENCES task_def, holders int NOT NULL, population int NOT NULL, computed_at timestamptz(3) NOT NULL)`;
   - `achievement_favorite (account_id uuid REFERENCES account ON DELETE CASCADE, slot smallint CHECK (slot BETWEEN 1 AND 3), task_id varchar(48) REFERENCES task_def, PRIMARY KEY (account_id, slot), UNIQUE (account_id, task_id))`;
   - `UPDATE` девяти существующих (категория, лестница, ступень, престиж, `title`) и `INSERT … ON CONFLICT (task_id) DO NOTHING` сорока новых по таблице выше (`active = true`, `sort` — по порядку таблицы с шагом 10, начиная с 100 после девяти существующих).
   Модели в `schema.prisma` блоком в конце, поля `TaskDef` со своими комментариями. ER в `docs/21`.
3. **`task-rules.ts`:** `friends` и `account_level` забег не двигает, поэтому в `RUN_KINDS` их не добавлять: завести `STATE_KINDS = { friends: { op: "max" }, account_level: { op: "max" } }`, включить в `TASK_KIND_IDS`; `isRunKind` для них ложно, `onRun` их пропускает. `taskDefSchema` получает `category`, `ladder`, `rung`, `hidden`, `hint`, `prestige` с теми же правилами, что `CHECK` (поля только у достижений, скрытому нужна подсказка).
4. **`tasks.repository.ts` и `tasks.service.ts`:** колонки в `catalog()`, `insert`, `update`, `defSchema`; `applyState(accountId, deltas, at)` — прогресс с действием «максимум» без записи в `task_run` (общий запрос с `applyRun` вынести в приватную функцию, не копировать); `TasksService.view` не отдаёт закрытые скрытые достижения; `TaskView` получает `category`, `ladder`, `rung`, `prestige`, `hidden`.
5. **Модуль `achievements`** (`achievement-rules.ts`, `achievements.repository.ts`, `achievements.service.ts`, `achievements.controller.ts`, `achievement-errors.ts`, `achievements.module.ts`; строка в `app.module.ts`):
   - `GET /api/v1/achievements` → `{ data: { prestige, favorites: string[], rarity: { population, shown: boolean, computedAt: string | null }, items } }`; перед ответом `syncState`: число друзей и уровень аккаунта → `applyState`; закрытое скрытое — `{ id, category, hidden: true, done: false, hint }`, остальное — `{ id, category, ladder, rung, hidden, kind, filter, title, hint, target, value, done, claimed, reward, prestige, percent }`, где `percent` = `percentOf(holders, population, minPlayers)`;
   - `GET /api/v1/achievements/summary` → `{ data: { prestige, favorites: [{ id, title, category }] } }` (для профиля, без списка);
   - `PUT /api/v1/achievements/favorites` с телом `{ ids: string[] }` (Zod: не больше трёх, без повторов, `id` — как у каталога): каждое достижение должно быть выполнено игроком, иначе `AchievementNotUnlockedError` (409, `achievement_not_unlocked`); замена одной транзакцией (порядок массива — слоты 1…3), пустой список очищает; повтор того же запроса ничего не меняет;
   - `prestigeOf(accountIds: readonly string[]): Promise<Map<string, number>>` — публичный метод сервиса, один запрос с `GROUP BY` (для рейтинга, T-0107);
   - лимит запросов тем же приёмом, что `tasks.controller.ts` (`this.limit(accountId)`); все обращения к базе и Redis — с таймаутом.
   - `percentOf(holders, population, minPlayers): number | null` — чистая функция: `null`, если `population < minPlayers`; иначе `Math.min(100, Math.round((holders / population) * 1000) / 10)`.
6. **Фоновая задача `achievement-rarity.job.ts`** по образцу `fx.refresher.ts`: тик раз в 10 минут, пересчёт, если таблица пуста или последнее `computed_at` старше `achievements.rarity_refresh_min` (старт 360); лок `achievements:rarity:lock` (ttl 5 минут, токен, снятие скриптом); один запрос считает население (`SELECT count(*) FROM account a WHERE EXISTS (SELECT 1 FROM run r WHERE r.account_id = a.account_id AND r.status = 'finished')`) и держателей по каждому достижению среди этого населения; запись в `achievement_rarity` одной транзакцией (замена), `statement_timeout` на запрос; сбой — в лог (`rarity_failed`), старые числа остаются. В лог успешного прохода: число строк и население.
7. **Настройки** в `setting-catalog.ts` (по образцу соседних числовых ключей): `achievements.rarity_min_players` (по умолчанию 100, от 1) и `achievements.rarity_refresh_min` (по умолчанию 360, от 10). Строка в `docs/30-configuration-map.md`.
8. **Друзья:** метод «сколько у игрока друзей» (если нет — добавить в `friends.repository.ts` и `friends.service.ts` один запрос на количество, без загрузки списка).
9. **Очистка (вайп):** открыть `wipe/wipe-plan.ts`, посмотреть, как учтён `task_progress`, и так же учесть `achievement_favorite` (таблица с `account_id`); `achievement_rarity` — общая, не очищается.
10. **Панель и клиент (совместимость):** в форме и списке достижений панели — поля «Категория», «Лестница», «Ступень», «Скрытое», «Подсказка», «Престиж» (только когда срок «достижение»), подсказки в `help.ts`; в `task-row.tsx` название достижения — `task.title`, если оно задано, иначе ключ `achievement.<id>.name`, иначе `id` (тест в `tasks-api.test.ts` или рядом).
11. **События и документы:** сначала `docs/22` §3.3 (у `achievement_unlocked` необязательные `category`, `prestige`), потом Zod в `event-dictionary.ts`; `docs/21` (ER, связь модуля), `docs/30`, `docs/39` §3 (строка «Достижения»).

## Чего не трогаем

- Витрину, профиль и рейтинг в оболочке: T-0107. Престиж в строках рейтинга — там же, через `prestigeOf`.
- Ротацию и очки заданий (T-0104, T-0105); сам механизм забора и кошелёк.
- Достижения про сундуки, эволюции, боссов: нужны данные, которых в итоге забега нет.
- Серверные события (отложены), сезон рейтинга, награды за места.
- `core-game`, `runs`: итог забега не меняем.

## Сценарий и интерфейс

Экранов нет (витрина — T-0107). В панели, на форме достижения: загрузка, пусто, ошибка — как у списка заданий. Старый клиент (до T-0107) видит достижения в обычной вкладке с названиями из `title`.

## Тесты

Первым коммитом.

- `backend/api/test/achievements.test.ts` (чистые функции): `percentOf`: население 99 при пороге 100 → `null`; 100 при 100 → число; 1 из 3 → `33.3`; 0 → `0`; держателей больше населения → `100`; `taskDefSchema`: `hint` без `hidden` допустим, `hidden` без `hint` — отказ; `category` у ежедневного — отказ; `rung` без `ladder` — отказ; вид `friends` с фильтром — отказ.
- `backend/api/test/achievements.integration.test.ts` (живые Postgres и Redis, Redis тестов — 13):
  - каталог после миграции: от 40 до 50 достижений; id уникальны; у каждого категория из четырёх, `prestige > 0`; ступени каждой лестницы идут 1…n без пропусков, цель и престиж растут; скрытых не меньше трёх и у каждого подсказка; девять старых сохранили награды и цели;
  - витрина: закрытое скрытое отдаёт только `id`, `category`, `hidden`, `done: false`, `hint` (нет `title`, `kind`, `target`, `reward`); открытое — полностью; `GET /tasks` закрытых скрытых не возвращает;
  - престиж: сумма по выполненным; невыполненные не считаются; выключенное достижение считается; `prestigeOf` для трёх аккаунтов (один без достижений → 0);
  - состояние: у игрока 5 друзей → выполнены `ach_friends_1` и `ach_friends_5`, остальные нет; друзей стало меньше → прогресс не убывает; уровень аккаунта 12 → `ach_account_10` выполнено;
  - избранное: три выполненных → сохраняются, порядок слотов; четыре → отказ валидации; невыполненное → `achievement_not_unlocked`; чужое избранное не меняется; повторный запрос тот же результат; пустой список очищает; удаление аккаунта убирает строки;
  - редкость: игрок без единого забега, но с достижением, ни в числитель, ни в знаменатель не входит; два одновременных `tick()` — пересчёт делает один (второй возвращает `null`); `computed_at` обновляется; при населении ниже порога `shown: false`, `percent: null`, после снижения порога настройкой — число;
  - забор достижения: монеты на балансе один раз, причина `achievement_reward`.
- `backend/api/test/tasks.test.ts`: `friends` и `account_level` не двигаются `onRun`; `applyState` берёт максимум.
- `packages/app-shell/test/tasks-api.test.ts`: название достижения — `title`, иначе словарь, иначе `id`.

## Аналитика

`achievement_unlocked` (клиентское, v1): необязательные `category` (`combat`, `collection`, `mastery`, `friends`) и `prestige` (целое). Сначала `docs/22` §3.3 и Zod в словаре. Редкость и население — строки `achievement_rarity` и лог прохода, в Prometheus ничего с игроком в метках.

## Настройки и окружение

Два ключа `setting-catalog.ts`: `achievements.rarity_min_players` (100), `achievements.rarity_refresh_min` (360). Переменных окружения нет; ключ лока — константа.

## Документы

`docs/21-diagrams.md`, `docs/22-analytics-and-metrics.md`, `docs/30-configuration-map.md`, `docs/39-retention-mechanics.md` §3.

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 13.10.2026: достижения остаются в `task_def`; названия и подсказки лежат в базе (правятся из панели), а не в словаре клиента.
- Подтверждено `claude-lead-1` 13.10.2026: `achievement_unlocked` не меняет смысл (после забора), расширяется полями; серверное событие «открыто» не заводим.
- Точка разреза, если задача не влезет в M: редкость (шаги 6–7, таблица `achievement_rarity`) выносится отдельной задачей; витрина T-0107 тогда показывает достижения без процента.
- T-0110 (сезон рейтинга) тоже дописывает `friends.repository.ts` (у него он в `shared`); оба добавляют методы, конфликт решается сохранением обеих сторон.
- Порог показа процента 100 игроков — на закрытом тесте его не достичь; владелец может поставить в панели меньше.
- Геймдизайнеру: цели лестниц и награды таблицы стартовые.

## Критерии приёмки

- [ ] Тесты из раздела «Тесты» зелёные; миграция только добавляет, девять старых достижений сохранили прогресс и награды.
- [ ] В каталоге 49 достижений в четырёх категориях, три скрытых; закрытые скрытые не утекают ни в `/achievements`, ни в `/tasks`.
- [ ] Редкость пересчитывается одной репликой за раз; без порога населения процент не показывается.
- [ ] Избранное — не более трёх, только открытые; престиж суммируется по выполненным.
- [ ] Дифф только в зонах задачи; гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Достижения с престижем и редкостью`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: ещё 40 достижений в четырёх категориях, очки престижа и скрытые достижения`
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ДОСТИЖЕНИЯ С ПРЕСТИЖЕМ НА СЕРВЕРЕ**

  В каталоге 49 достижений: бой, коллекция, мастерство, друзья; лестницы, три скрытых, очки престижа. Редкость «есть у N% игроков» считается по расписанию среди игроков с хотя бы одним забегом и показывается с порога числа игроков. Три любимых достижения хранятся на сервере.

  🛠 **Достижения**

  • остаются в каталоге заданий (период «достижение»), в панели новые поля
  • новые ключи настроек: порог показа процента и период пересчёта

  ❓ **Нужно от команды**

  • @владелец — геймдизайнеру откалибровать цели, престиж и награды; решить порог показа процента для закрытого теста
  ```
