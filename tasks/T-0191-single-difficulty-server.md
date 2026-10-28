---
id: T-0191
title: Одна сложность на сервере — рейтинг с чистого листа
epic: E10
priority: P1
status: ready
owner:
author: claude-lead-1
size: M
depends_on: [T-0107, T-0112, T-0113, T-0114, T-0125]
zones:
  - backend/api/src/modules/runs/run-rules.ts
  - backend/api/src/modules/runs/rated-runs.ts
  - backend/api/src/modules/runs/runs.service.ts
  - backend/api/src/modules/runs/runs.repository.ts
  - backend/api/src/modules/runs/runs-view.service.ts
  - backend/api/src/modules/runs/leaderboard-rebuild.ts
  - backend/api/src/modules/runs/rating-restrictions.ts
  - backend/api/src/modules/seasons/seasons-schedule.ts
  - backend/api/src/modules/seasons/seasons.repository.ts
  - backend/api/src/modules/seasons/seasons-close.repository.ts
  - backend/api/src/modules/seasons/seasons-close.service.ts
  - backend/api/src/modules/seasons/seasons-projection.ts
  - backend/api/src/modules/seasons/seasons-view.service.ts
  - backend/api/src/cli/runs-rebuild-leaderboard.ts
  - backend/api/src/cli/seasons-rebuild.ts
  - backend/api/src/modules/admin-notify/run-card.ts
  - backend/api/src/modules/admin-notify/run-review-card.ts
  - backend/api/src/platforms/telegram/welcome-progress.ts
  - backend/api/src/platforms/telegram/welcome-texts.ts
  - backend/api/src/platforms/telegram/welcome-card.ts
  - backend/api/src/platforms/telegram/bot-profile-texts.ts
  - backend/api/test/helpers/memory-runs.ts
  - backend/api/test/runs.test.ts
  - backend/api/test/runs.integration.test.ts
  - backend/api/test/seasons.test.ts
  - backend/api/test/seasons.integration.test.ts
  - backend/api/test/rating-restrictions.test.ts
  - backend/api/test/welcome-progress.test.ts
  - backend/api/test/welcome.test.ts
  - backend/api/test/admin-notify.test.ts
  - backend/api/test/bot-profile.test.ts
  - backend/api/test/single-difficulty.test.ts
  - backend/api/test/single-difficulty.integration.test.ts
  - scripts/test/run-rules.test.ts
shared:
  - backend/api/src/modules/settings/setting-catalog.ts
  - backend/api/prisma/migrations/**
  - backend/api/test/settings.test.ts
  - docs/30-configuration-map.md
runner: local
executor: sonnet-5.5
effort: extra
release: minor
design: null
batch: 3
---

# T-0191. Одна сложность на сервере — рейтинг с чистого листа

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0191.json)](README.md#значки-статуса) [![T-0107](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0107.json&label=T-0107)](T-0107-achievements-showcase-shell.md) [![T-0112](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0112.json&label=T-0112)](archive/T-0112-separate-board-restriction.md) [![T-0113](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0113.json&label=T-0113)](T-0113-boards-by-viewer.md) [![T-0114](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0114.json&label=T-0114)](T-0114-season-rewards-by-viewer-board.md) [![T-0125](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0125.json&label=T-0125)](archive/T-0125-run-result-rank-chest-crystal-counters.md)

## Зачем

Решение Р126: сложность одна, а рейтинг считается с чистого листа с момента
её выката. Игроки заметно сильнее, чем в первые недели теста, и единая
сложность тяжелее нынешней «Сложной», поэтому старые рекорды с ней
несравнимы. После задачи общий рейтинг всех времён и сезонные доски берут
только забеги единой сложности, сыгранные с даты выката; обучающий забег
(`easy`) и забеги старых клиентов на `normal` в рейтинг не идут, награда за них
прежняя; задания пула больше не просят «нормальную» сложность. История
забегов в базе остаётся целой. Клиентская половина — T-0190.

## Решения

Р126 (`docs/35-stage4-plan.md`, 20.10.2026; уточняет Р65 и WP34), порядок
перехода и решения ниже — `claude-lead-1`, 20.10.2026:

- **Первый шаг expand.** Внутренние id, ключи Redis (`runs:leaderboard:<id>`,
  `seasons:<ключ>:<id>`), колонки и enum `Difficulty` остаются; единая
  сложность занимает место `"hard"`, обучающий забег — `"easy"`, `"normal"`
  сервер принимает от старых клиентов, как сейчас (клиенты живут днями из-за
  модерации площадок). Сведение id в одно значение — отдельной задачей позже.
  **Enum и схему БД не трогаем.**
- **Рейтинговые сложности — список в коде:** `RATED_DIFFICULTIES = ["hard"]`.
  Забег другой сложности принимается, оценивается антифродом, даёт награду по
  прежним множителям (`DIFFICULTY_REWARD_MUL`, бонус уровня предметов не
  меняются) и пишется в историю, но `ranked = false` и в доски не попадает.
- **Отсечка рейтинга — ключ настроек `rating.since-date`** (число ГГГГММДД по
  UTC, как `seasons.start-date`; `0` — отсечки нет). Забег идёт в рейтинг,
  только если он рейтинговой сложности и **закончен** не раньше 00:00 UTC этой
  даты. Выбрано, потому что:
  - «выкат» — событие среды, а не кода: константа с датой в исходниках
    заставила бы угадывать день выката заранее, а при дате в будущем сломала
    бы все тесты, которые заканчивают забег «сейчас»;
  - значение лежит в базе, поэтому **пересборка рейтинга из базы даёт то же
    самое**, что живая проекция (CLI уже читает настройки из базы, как
    `seasons-rebuild`), а тимлид может сдвинуть дату из панели без релиза,
    например на момент выката T-0192;
  - отсечка выставляется **самой миграцией** (см. шаг 8) днём применения на
    среде, то есть днём выката: никого не надо помнить об этом;
  - не перезаписывать `run.ranked = false` у старых забегов миграцией:
    `ranked = false` при чистом вердикте означает «снят модератором»
    (`UNRANKED_BY_MODERATOR` в `runs.repository.ts`), и модераторы получили бы
    тысячи старых забегов в списке «вернуть в рейтинг», а откатить это нельзя.
  Забег, начатый до отсечки и законченный после, считается: отсечка по
  `finished_at`, как окно недели сезона. Граница — сутки: забеги выкатного дня
  до самого выката старой «Сложной» тоже попадают; хочется строже — тимлид
  ставит завтрашнюю дату в панели.
- **Сезоны.** Недельные таблицы и закрытие недели считают только
  рейтинговые сложности и тоже с отсечки (окно недели —
  `[max(начало недели, отсечка), конец недели)`). Прошлые закрытые сезоны,
  строки `season_result` и `season_reward` не меняются. Пороги и множители
  сезона (`THRESHOLD_SEC`, `DIFFICULTY_MUL`) не трогаем — их пересматривают
  вместе с числами T-0192.
- **Задания.** Строки пула с фильтром сложности `easy`/`normal` **выключаются**
  (`active = false`), а не переводятся на `hard`: после перехода «сыграй на
  hard» равно «сыграй забег», и перевод дал бы дубль `daily_hard_run`.
  Выключенные строки остаются в базе (панель может вернуть или удалить);
  ротация сама добирает набор из остатка ступени (`pickPool`). Задания с
  фильтром `hard` остаются как есть. Схема фильтра (`runFilterSchema`) и вид
  `difficulty_*` не меняются.
- **Ответы API сохраняют форму** `Record<Difficulty, …>` для старых клиентов:
  у нерейтинговых сложностей — `null`, пустая доска, пустой список.
- **Пересборка и стухшие доски.** После выката нужна одна пересборка
  (`runs:rebuild-leaderboard`, `seasons:rebuild`): она выставит доску `hard` по
  новой отсечке и **очистит** доски `easy`/`normal`. Чтение нерейтинговой
  доски до пересборки всё равно возвращает пустую доску без обращения к Redis.

## Как сейчас

- `modules/runs/run-rules.ts:15-16` — `DIFFICULTIES = ["easy","normal","hard"]`.
- `modules/runs/runs.service.ts:96-145` `finish`: `rankable` — вердикт `ok` и
  читы; `ranked = rankable && held === null`; `resultOf` (стр. 217-250)
  пишет в Redis-доску **любой** сложности и отвечает местом.
  `setRanked` (стр. 180-205) пересчитывает доску сложности забега.
- `modules/runs/runs.repository.ts` — запросы доски: `bestRuns` (стр. ~290),
  `bestTimes` (~313), `bestRunOf` (~321), `moderationRuns` (~342), `setRanked`
  (~364); все фильтруют по `difficulty` и `ranked`, но не по рейтинговой
  сложности и не по времени.
- `modules/runs/runs-view.service.ts` — `leaderboardFor` (стр. 111),
  `profile` (стр. 187: `best` по `DIFFICULTIES`), `boardSize`, `moderationRuns`
  (стр. 216-221, три списка).
- `modules/runs/leaderboard-rebuild.ts:20-23` — цикл по `DIFFICULTIES`;
  CLI `cli/runs-rebuild-leaderboard.ts` собирает репозиторий вручную.
- `modules/runs/rating-restrictions.ts:139-143` — возврат в доски по
  `DIFFICULTIES` после снятия ограничения.
- `modules/seasons/seasons.repository.ts` — `weekBests` (стр. 65), `bestRun`
  (74), `boardRuns` (83), `windowOf` (стр. 148); `seasons-close.repository.ts:63-90`
  — SQL закрытия недели по всем сложностям; `seasons-projection.ts:59-101`
  (`recorded`, `refresh`, `rebuild`, `settled` — циклы по `DIFFICULTIES`);
  `seasons-view.service.ts:138-150` (`mine` по трём сложностям);
  `seasons-schedule.ts` читает `seasons.start-date` через `SettingsReader` —
  образец чтения настройки; `cli/seasons-rebuild.ts` уже поднимает
  `SettingsService` из базы.
- `modules/settings/setting-catalog.ts:352-372` — `seasonsStartDate`: образец
  числового ключа-даты ГГГГММДД с `range` и `saveCheck`; `SETTING_LIST`
  собирается из `SETTINGS` (стр. 448).
- Задания: миграция `20261014074456_task_pool_rotation` — строки
  `daily_hard_run`, `daily_normal_runs`, `daily_hard_180` (фильтр `hard`
  и `normal`), `weekly_hard_240`; `task_def.active` уже есть.
- Подписи: `modules/admin-notify/run-card.ts:29` и `run-review-card.ts:34` —
  «лёгкая/нормальная/сложная»; `platforms/telegram/welcome-progress.ts:9`
  (`HARDEST_FIRST`), `welcome-texts.ts:41-70` (`recordLabel(difficulty)`),
  `welcome-card.ts:24,60,94`; `bot-profile-texts.ts:31,45` («рекорды на
  каждой сложности»).
- Тестовый помощник `test/helpers/memory-runs.ts` повторяет запросы
  репозитория в памяти: должен повторять и новые условия.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`run-rules.ts`:** `export const RATED_DIFFICULTIES = ["hard"] as const
   satisfies readonly Difficulty[]`, `isRatedDifficulty(difficulty)`; `DIFFICULTIES`
   и `Difficulty` не менять (комментарий: «единая сложность — `hard`, обучающий
   забег — `easy`; `normal` приходит только от старых клиентов, Р126»).
3. **`modules/runs/rated-runs.ts` (новый файл, без Nest и Prisma-клиента):**
   - `ratingSinceOf(value: number): Date | null` — ГГГГММДД → 00:00 UTC;
     `0`, нецелое, несуществующая дата (`20261340`) → `null`;
   - `isRatedRun(difficulty, finishedAt: Date, since: Date | null): boolean` —
     рейтинговая сложность и (`since === null` или `finishedAt >= since`);
   - `ratedWhere(since: Date | null)` — условие для Prisma `where`:
     `{ difficulty: { in: [...RATED_DIFFICULTIES] }, ...(since === null ? {} :
     { finishedAt: { gte: since } }) }`.
4. **Ключ настроек** `ratingSinceDate` в `setting-catalog.ts`: ключ
   `rating.since-date`, группа «Рейтинг» (новая константа), название «Рейтинг
   считается с даты», подсказка «Дата выката единой сложности числом ГГГГММДД,
   например 20261026. Забеги, законченные раньше, в рейтинг и в сезоны не идут;
   они остаются в истории. 0 — без отсечки», `kind: "number"`, схема — целое
   0…20991231 и `value === 0 || ratingSinceOf(value) !== null`, `range` с
   единицей «(ГГГГММДД)», `fromEnv: () => null`, `fallback: 0`. `saveCheck` не
   нужен: дату в прошлом ставить можно. В `SeasonSchedule` добавить метод
   `ratingSince(): Date | null` (читает настройку через уже внедрённый
   `SettingsReader`) — им пользуются сезонные сервисы.
5. **`RunsService`:**
   - внедрить `SETTINGS_READER`; `since = ratingSinceOf(settings.get(SETTINGS.ratingSinceDate))`;
   - в `finish`: `const rated = isRatedRun(run.difficultyId, new Date(nowMs),
     since)`; `rankable = rated && judged.verdict === "ok" && (…читы…)`;
     нерейтинговый забег `held` не вычисляет (`null`) и получает `ranked =
     false`; остальное — вердикт, запись в базу, хуки, награда — как сейчас;
   - `resultOf`: для нерейтинговой сложности ответ `{ recorded: false, verdict,
     bestSurvivalSec: 0, isNewBest: false, rank: null }` **без обращения к
     Redis**; на повторе итога — тот же ответ (по записанной сложности);
   - `setRanked`: сложность забега нерейтинговая или забег раньше отсечки →
     `RunRankingConflictError` (менять нечего).
6. **`RunsRepository` (интерфейс, Prisma-класс, `memory-runs.ts`):** методы
   рейтинга получают последним параметром `since: Date | null` —
   `bestRuns`, `bestTimes`, `bestRunOf`, `moderationRuns`, `setRanked`; условие
   — `ratedWhere(since)` к существующему `where`; для нерейтинговой сложности
   метод сразу возвращает пусто/`null` без запроса. Вызывающие
   (`RunsService`, `RunsViewService`, `RatingRestrictions`,
   `leaderboard-rebuild`) передают `since`. Остальные методы (`recent`,
   `stats`, `detail`, `review`) **не трогаем**: история остаётся полной.
7. **Чтение (`RunsViewService`), с учётом того, что T-0113 уже сделал:**
   - `leaderboardFor` для нерейтинговой сложности — пустая доска той же формы
     (`entries: []`, `me: null`, `totalPlayers: 0`) без Redis и базы;
   - `profile.best` и `boardSize`: рейтинговая сложность — как сейчас,
     остальные — `null` и `0`;
   - `moderationRuns`: списки `easy`/`normal` пусты, форма ответа прежняя.
   - `RatingRestrictions.settled` и `leaderboard-rebuild` ходят по
     `RATED_DIFFICULTIES`. Пересборка для остальных сложностей записывает
     **пустую** доску (`replace(difficulty, [])`) и возвращает для них `0`.
   - CLI `runs-rebuild-leaderboard.ts` поднимает `SettingsService` из базы
     (как `cli/seasons-rebuild.ts`), `await settings.refresh()` и передаёт
     `since` в `rebuildLeaderboard`.
8. **Сезоны.** `seasons.repository.ts`: `windowOf(season, since)` берёт
   нижнюю границу `max(season.startsAt, since)`; `weekBests`, `bestRun`,
   `boardRuns` — `ratedWhere`-условие, нерейтинговая сложность → пусто.
   `seasons-close.repository.ts` `close(season, excluded, now, since)`: в SQL
   `r.difficulty::text = ANY(${[...RATED_DIFFICULTIES]}::text[])` и нижняя
   граница `GREATEST(season.startsAt, since)`; `summary` по-прежнему отдаёт
   `boardSize` по всем трём ключам (нули у нерейтинговых).
   `seasons-close.service.ts`, `seasons-projection.ts` (`recorded` не пишет
   нерейтинговую сложность, `refresh`, `rebuild`, `settled` — по
   `RATED_DIFFICULTIES`; `rebuild` очищает доски остальных сложностей),
   `seasons-view.service.ts` (`mine`, стендинги — `null`/пусто у
   нерейтинговых) берут `since` из `schedule.ratingSince()`. CLI
   `seasons-rebuild.ts` менять нечего, если `SeasonSchedule` уже даёт
   `ratingSince()` — проверить и убедиться тестом.
9. **Миграция данных** (`prisma migrate dev --create-only --name
   single_difficulty` один раз, на свежем `dev`, проверить `ls
   backend/api/prisma/migrations | tail`: папка одна, метка новее
   `20261014082616_seasons`; схема не меняется, это ручной SQL):
   ```sql
   -- Единая сложность (Р126): рейтинг и сезоны считают забеги с даты применения
   -- миграции на этой среде, то есть с выката. Уже заданное в панели не трогаем.
   INSERT INTO "app_setting" ("key", "value", "updated_at")
   VALUES ('rating.since-date', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD')::int), now())
   ON CONFLICT ("key") DO NOTHING;

   -- Задания пула с фильтром easy/normal: после перехода выбор сложности
   -- исчез, а «сыграй на hard» не отличается от «сыграй забег». Строки
   -- выключены, не удалены: панель может вернуть или убрать.
   UPDATE "task_def" SET "active" = false, "updated_at" = now()
   WHERE "kind" IN ('difficulty_runs', 'difficulty_survive_sec')
     AND "filter" ->> 'difficulty' IN ('easy', 'normal');
   ```
   Миграция не создаёт, не удаляет и не переименовывает колонки и значения
   enum. Повторный запуск безопасен (`ON CONFLICT`, `UPDATE` по условию).
10. **Подписи (без «сложная» там, где сложность одна):**
    - `run-card.ts` `DIFFICULTY_LABELS`: `easy` → «обучающий», `normal` →
      «прежняя нормальная», `hard` → «основная»; строки карточки читаются
      «основная, умер» / «на сложности …» → «основная» без слова «сложности»
      (`на сложности ${…}` заменить на `${…}`, строка 154);
    - `run-review-card.ts` `DIFFICULTY_LABELS`: «Обучающий», «Прежняя
      нормальная», «Основной» (в строке «Основной · 5:12 · уровень …»);
    - `welcome-progress.ts`: `HARDEST_FIRST` уходит, берётся
      `profile.best.hard`; в `WelcomeProgress.best` поле `difficulty` удаляется;
      `welcome-texts.ts`: `recordLabel()` без аргумента — «рекорд» и «best»,
      тип `Difficulty` и таблицы `RU_DIFFICULTIES`/`EN_DIFFICULTIES` удалить;
      `welcome-card.ts` — ключ кеша карточки без сложности;
    - `bot-profile-texts.ts`: «• стихии, боссы и рекорды на каждой сложности»
      → «• стихии, боссы и общий рейтинг», «• elements, bosses and records on
      every difficulty» → «• elements, bosses and a global leaderboard».
11. **Документы:** `docs/30-configuration-map.md` — строка ключа
    `rating.since-date` в таблице настроек (кто меняет — тимлид в панели, чем
    пользуется — рейтинг и сезоны). В PR — раздел «После выката» (ниже).

## Чего не трогаем

- `enum Difficulty`, колонки `run.difficulty`, `season_result.difficulty`,
  `season_reward.difficulty`, любые индексы и `schema.prisma`. Новых таблиц
  нет. Данные забегов, сезонов и наград не изменяются и не удаляются.
- Клиент (`packages/app-shell`) и движок — T-0190, T-0192.
- `DIFFICULTY_REWARD_MUL`, `DIFFICULTY_LEVEL_BONUS`, `THRESHOLD_SEC`,
  `DIFFICULTY_MUL`, лестницы наград — числа не меняются.
- Схемы запросов (`runStartSchema`, `runFinishSchema`, `difficultyQuerySchema`,
  `z.enum(DIFFICULTIES)` в DTO сезонов и заданий): старый клиент по-прежнему
  присылает `normal` и `easy`.
- Панель (`apps/admin`): колонка «Сложность» в истории, списке разбора и
  карточке игрока остаётся — это история. Вкладки «Рейтинг игрока» с
  `easy`/`normal` просто пусты (форма ответа прежняя).
- Остальные пулы заданий и достижения; сами задания `hard` (T-0106 переписывает
  лестницы достижений отдельно).
- Журнал «Что нового», аналитика: событий и полей не добавляется.
- Файл `test/tasks.integration.test.ts` (его правят T-0126 и T-0167): проверки
  заданий — в новом `single-difficulty.integration.test.ts`.

## Тесты

Пишутся первым коммитом, до кода. Интеграционные — на живых Postgres и Redis
(`docs/17-testing-strategy.md` §4.2), схема тестовой базы у каждого потока
своя.

- `scripts/test/run-rules.test.ts` — каждая из `RATED_DIFFICULTIES` есть среди
  сложностей контента.
- `backend/api/test/single-difficulty.test.ts` (юнит, память):
  - `ratingSinceOf`: `20261026` → `2026-10-26T00:00:00.000Z`; `0`, `-1`,
    `1.5`, `20261340`, `20260229` → `null`; ключ настроек: схема принимает `0` и
    `20261026`, отвергает `20261340`;
  - `isRatedRun`: `hard` после отсечки → да; `hard` за секунду до → нет;
    `easy` и `normal` → нет; `since = null` → `hard` да;
  - `finish`: `hard` → `recorded: true`, место, в доске; `easy` и `normal`
    → `recorded: false`, `rank: null`, `bestSurvivalSec: 0`, в доске нет,
    награда начислена по множителям (как до задачи); `hard`, законченный до
    отсечки → не в рейтинге; повтор итога нерейтингового забега — тот же ответ;
  - `setRanked` для забега `easy` и для `hard` раньше отсечки →
    `RunRankingConflictError`;
  - пересборка: один и тот же набор забегов (рейтинговые `hard` до и после
    отсечки, `easy`, `normal`, чужие ограничения) даёт доску, **равную живой
    проекции** после тех же `finish`; доски `easy`/`normal` после пересборки
    пусты, даже если в них заранее лежали старые записи; второй запуск
    ничего не меняет;
  - `leaderboardFor("easy")` и `("normal")` → пустая доска формы
    `LeaderboardView`, Redis не вызывается; `profile.best.easy/normal` →
    `null`; `moderationRuns` → списки `easy`/`normal` пусты;
  - `RatingRestrictions.settled` возвращает в доску только `hard`.
- `backend/api/test/seasons.test.ts` — `weekBests`/`boardRuns`/`bestRun`
  не берут забеги до отсечки и нерейтинговых сложностей; окно недели,
  начавшейся до отсечки, — от отсечки; `recorded` для `easy` ничего не пишет;
  `rebuild` очищает доски `easy`/`normal`; итог сезона по трём ключам
  сохраняет форму.
- `backend/api/test/seasons.integration.test.ts` — закрытие недели на живой
  базе: в `season_result` попадают только `hard` с отсечки; прошлые строки
  закрытых сезонов не изменены; награды считаются как раньше для `hard`.
- `backend/api/test/single-difficulty.integration.test.ts`:
  - после применения миграций в `app_setting` есть `rating.since-date`,
    число в формате ГГГГММДД, равное сегодняшней дате UTC; значение,
    заданное заранее, миграция не перезаписывает (прогон SQL миграции вторым
    разом на копии строки);
  - `task_def`: `daily_normal_runs` выключено, `daily_hard_run`,
    `daily_hard_180`, `weekly_hard_240` включены; строки без фильтра
    сложности не затронуты; набор дня (`pickPool`) на каждую из 30 дат подряд
    — ровно квота (2 + 2 + 1), без выключенной строки;
  - `GET /leaderboard?difficulty=normal` и `easy` — 200 и пустая доска;
    `difficulty=hard` — доска из забегов после отсечки;
  - миграция не меняет схему: `prisma migrate diff` пуст (или проверка
    `pnpm --filter backend-api prisma validate` в гейте).
- `rating-restrictions.test.ts`, `welcome-progress.test.ts`, `welcome.test.ts`,
  `admin-notify.test.ts`, `bot-profile.test.ts` — новые подписи и форма
  `WelcomeProgress`; тексты бота укладываются в лимиты Telegram, которые тест
  уже проверяет.
- `test/settings.test.ts` — если тест перечисляет ключи каталога, дописать
  `rating.since-date` (файл общий, правка — строка).

## Аналитика

Новых событий и полей нет. `ranked` в записи забега уже есть; доля
нерейтинговых забегов видна по `difficulty` и `ranked` в существующих
событиях (`docs/22-analytics-and-metrics.md` §3.3). Лог: при отсечке, равной
`0`, в журнал запуска сервера не пишем ничего (это допустимое состояние);
значение отсечки видно в панели настроек.

## Настройки и окружение

Новый ключ `rating.since-date` (`setting-catalog.ts`, группа «Рейтинг»): число
ГГГГММДД по UTC, умолчание `0`; задаётся миграцией на каждой среде датой её
применения, дальше меняется в панели без релиза. Переменных окружения и
секретов нет, `.env.example` не меняется.

## Документы

`docs/30-configuration-map.md` — строка ключа (шаг 11). `docs/38-release-plan.md`
и `docs/35-stage4-plan.md` правит тимлид (раздел «После выката» ниже уходит в
чек-лист пачки). `docs/21-diagrams.md` не затрагивается: схема БД не меняется.

## Критерии приёмки

- [ ] Забег `easy`/`normal` принимается, оценивается, награждается по
  прежним множителям, но не попадает ни в общую доску, ни в сезонные; ответ —
  `recorded: false`, `rank: null`.
- [ ] Забег `hard`, законченный до отсечки, в рейтинг не идёт; после — идёт.
- [ ] Пересборка рейтинга и сезонов из базы даёт ровно то, что дала бы живая
  проекция; доски `easy`/`normal` после неё пусты.
- [ ] Миграция выставляет `rating.since-date` один раз, не перезаписывает
  заданное, выключает задания `easy`/`normal`, не меняет схему и данные забегов.
- [ ] Старый клиент (`normal`, `easy` в теле запроса и в `?difficulty=`)
  работает: ответы той же формы, без ошибок.
- [ ] Модератор не может вернуть в рейтинг старый или нерейтинговый забег.
- [ ] Карточки в чате команды и карточка приветствия бота не называют
  «сложная», «нормальная» и «лёгкая» как выбор игрока.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; чек-листы безопасности
  и нагрузки (`docs/15-engineering-standards.md` §7–8) пройдены и отмечены в
  PR (миграция с данными, чтение настройки на каждом `finish` — из памяти
  `SettingsReader`, без запроса).

## PR

- **Заголовок:** `feat(runs): Одна сложность на сервере, рейтинг с чистого листа`
- **Метка:** `release: minor`
- **Для игроков:**
  - `- новое: рейтинг и недельные сезоны начинаются заново — в них идут забеги единой сложности, начиная с выката; прежние забеги остаются в истории`
- **Сводка для команды** — готовый блок, исполнитель переносит его в описание PR
  как есть и вписывает номер PR в заголовок:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РЕЙТИНГ ЕДИНОЙ СЛОЖНОСТИ С ЧИСТОГО ЛИСТА**

  Сервер считает рейтинг и сезоны только по единой сложности и только с даты выката; обучающий забег и забеги старых клиентов на других сложностях в рейтинг не идут.

  🛠 **Что изменилось**

  • новый ключ в панели «Рейтинг считается с даты» (`rating.since-date`), миграция ставит его днём применения
  • доски лёгкой и нормальной сложности пусты, история забегов и закрытые сезоны не тронуты
  • задания пула «на нормальной/лёгкой» выключены, задания «на сложной» работают
  • подписи в карточках забегов и приветствии бота без выбора сложности

  ❓ **Нужно от команды**

  • @владелец — после выката пачки выполнить `runs:rebuild-leaderboard` и `seasons:rebuild`, при необходимости сдвинуть дату отсечки в панели «Настройки → Рейтинг»
  ```

## После выката (для чек-листа пачки, правит тимлид)

1. Миграция применилась: в панели «Настройки → Рейтинг» дата отсечки равна дню
   выката.
2. `docker compose exec -T api node dist/cli/runs-rebuild-leaderboard.js` и
   `node dist/cli/seasons-rebuild.js` — очистят старые доски и соберут новые.
3. Если выкат T-0192 (новые множители) идёт позже, сдвинуть дату на его день.
