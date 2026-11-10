---
id: T-0380
title: Рейтинг в панели — сервер: доски, архив сезонов, места игрока
epic: E11
priority: P2
status: in-progress
owner: claude-10 / sonnet-5.5 / high
author: claude-lead2-3
size: M
depends_on: []
zones:
  - backend/api/src/modules/seasons/seasons-admin.service.ts
  - backend/api/src/modules/seasons/seasons-admin.repository.ts
  - backend/api/src/modules/seasons/dto/seasons-admin.dto.ts
  - backend/api/src/modules/admin/admin-rating.controller.ts
  - backend/api/test/admin-rating.test.ts
  - backend/api/test/admin-rating.integration.test.ts
shared:
  - backend/api/src/modules/seasons/seasons.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0380. Рейтинг в панели — сервер: доски, архив сезонов, места игрока

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0380.json)](README.md#значки-статуса)

## Зачем

Команда не видит рейтинг иначе как глазами игрока: доски по сложностям, кто
занял какие места в прошлые недели и какие награды получил, — только запросом к
базе. После задачи у панели есть ручки для раздела «Рейтинг» (T-0381): текущие
доски, архив недельных сезонов с местами, дивизионами и наградами и места
одного игрока по неделям.

## Решения

Записаны в `docs/35-stage4-plan.md` Р189 (02.11.2026). Исполнитель их не
пересматривает.

1. **Три вида данных:** текущие доски по сложностям; архив недельных сезонов с
   местами, дивизионами и наградами; места игрока по неделям.
2. **Только накопленные итоги** — `season`, `season_result`, `season_reward`;
   **новых таблиц нет**, дневных срезов мест не заводим.

Решения `claude-lead2-3` по коду (не продукт, а способ):

3. **«Текущие доски» — те же, что видит игрок на экране «Рейтинг»:** доска
   недели (идущий сезон, проекция `SEASON_BOARD_STORE`) и доска всех времён
   (`LEADERBOARD_STORE`), по сложностям. Числа — как у игрока: неделя по
   времени или очкам по `SeasonSchedule.scoringOf`, всё время — очки.
4. **Право — `players.view`.** Доски и итоги — это игроки и их места, ссылка
   ведёт в карточку игрока под тем же правом; рейтинговые забеги игрока в
   панели уже читаются под ним (`admin-runs.controller.ts:36`). Аналитику
   (`analytics.gameplay.view`) не берём: аналитик не открывает карточки
   игроков. Право есть у владельца, админа, геймдизайнера и модератора.
5. **Отдельная доска (скрытое ограничение, Р104) — только держателю
   `players.board.restrict`.** Без него: доски читаются `common`, строки
   итогов с `board = 'full'` не отдаются, параметр `board=full` → 403. Так же
   отчёты панели прячут метку (`admin/board-mark.reader.ts`,
   `restrictions/restriction-visibility.ts`).
6. **Только чтение** — аудита нет, как у остальных отчётов панели.

## Как сейчас

- `backend/api/prisma/schema.prisma:2474–2545` — `Season` (`season_key` —
  понедельник, `starts_at`, `ends_at`, `closed_at`, `players`, `rewarded`),
  `SeasonResult` (`best_sec`, `place`, `board_size`, `board`, `division`; индексы
  `(season_key, difficulty, place)` и `(account_id, season_key)`), `SeasonReward`
  (`coins`, `prestige`, `difficulty`, `place`, `kind` `place|threshold`, `status`
  `pending|claimed`, `claimed_at`).
- `modules/seasons/`: `seasons-view.service.ts` — доска недели для игрока
  (`board`, `:110–140`), `seasons.repository.ts` — `boardRuns` (подписи строк:
  имя, время, очки), `history` (`:162`); `seasons-schedule.ts` — `current`,
  `scoringOf`, `boardSeason` (ключ доски по очкам), `pointsFrom`;
  `season-board.store.ts` — `top`, `count`.
- `modules/runs/leaderboard.store.ts` — доска всех времён, очки, `top(difficulty,
  limit, board)`; `runs-view.service.ts:152` — `leaderboardFor`: проекция плюс
  подписи из базы одним запросом (`bestRuns`).
- `modules/rating/division-rules.ts:30` — `divisionOf(rank, boardSize)`.
- `rating/rating-switch.ts` — `scoringOfSeason(startsAt, pointsFrom)`: в архиве
  `best_sec` — секунды или очки, по сезону.
- Образец ручки панели — `admin/admin-runs.controller.ts` (`AdminSessionGuard`,
  `PermissionGuard`, `@RequirePermission`, `parse` из `admin-parse.ts`).
- `SeasonsModule` (`seasons.module.ts`) импортирует `RunsModule` и
  экспортирует `SeasonsProjection`, `SeasonSchedule`, `SEASON_BOARD_STORE`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`seasons/dto/seasons-admin.dto.ts`** — Zod-схемы запросов и ответов (ответ
   сервис проверяет перед отдачей, как `seasons.dto.ts`):

   ```ts
   boardsQuery = { difficulty: enum(DIFFICULTIES), period: enum(["week", "all"]).default("week"),
                   board: enum(["common", "full"]).default("common"), limit: coerce int 1..200 default 100 }
   seasonsQuery = { before: seasonKey (понедельник) optional, limit: 1..52 default 20 }
   seasonQuery = { difficulty, board: common|full default common, offset: 0..100000 default 0, limit: 1..200 default 100 }

   BoardsView = { period, difficulty, board, scoring: "time" | "points", seasonKey: string | null, total: number,
                  entries: { place, accountId, name, score, survivalSec, division: Division | null }[] }
   SeasonsPage = { seasons: { key, startsAt, endsAt, closedAt, players, rewarded, scoring }[], next: string | null }
   SeasonView = { season: { key, startsAt, endsAt, closedAt, players, rewarded, scoring }, difficulty, board, total,
                  rows: { place, accountId, name, best, boardSize, division, reward: SeasonRewardView | null }[] }
   SeasonRewardView = { kind: "place" | "threshold", coins, prestige, status: "pending" | "claimed", claimedAt: string | null }
   PlayerSeasons = { seasons: { key, startsAt, scoring, results: { difficulty, best, place, boardSize, division,
                     board?: "common" | "full" }[], reward: SeasonRewardView & { difficulty, place } | null }[] }
   ```

   `division` у недели — `divisionOf(place, total)`; у всего времени — `null`.
3. **`seasons/seasons-admin.repository.ts`** — запросы Prisma `$queryRaw` с
   разбором Zod:
   - `seasons(before, limit)` — `season` по убыванию `season_key`, `limit + 1`
     строк, лишняя даёт `next`;
   - `season(key)`;
   - `results(key, difficulty, board, offset, limit)` — `season_result`
     `JOIN account` (имя) `LEFT JOIN season_reward` по `(season_key, account_id)`,
     `ORDER BY place`; `count(*)` для `total` по тому же условию. Награда
     ставится в строку, если `kind = 'threshold'` или `difficulty` награды равна
     сложности строки;
   - `playerSeasons(accountId, limit = 52)` — итоги аккаунта по индексу
     `(account_id, season_key)`, новые сверху, с наградой.
4. **`seasons/seasons-admin.service.ts`**:
   - `boards(actor, query, at)`: `week` — `schedule.current(at)`; сезона нет →
     `seasonKey: null`, пустые `entries`; иначе `SEASON_BOARD_STORE.top/count`
     по ключу `boardSeason(season).key`, подписи — `repository.boardRuns`
     (`SEASONS_REPOSITORY`); `all` — `LEADERBOARD_STORE.top/count`, подписи —
     `RUNS_REPOSITORY.bestRuns`. Строка, у которой нет подписи (проекция
     разошлась с базой), не отдаётся — как у игрока;
   - `seasons`, `season`, `playerSeasons` — по шагу 3, `scoring` сезона —
     `scoringOfSeason(startsAt, schedule.pointsFrom())`;
   - доска `full` и строки `board = 'full'` — по решению 5: право проверяет
     `RolesService.can(actor, "players.board.restrict")`;
   - каждый `await` базы и Redis — с `withTimeout` (5 с, как в
     `seasons-view.service.ts`).
5. **`admin/admin-rating.controller.ts`** — `@Controller("admin")`,
   `@UseGuards(AdminSessionGuard, PermissionGuard)`, все ручки
   `@RequirePermission("players.view")`:
   - `GET /admin/rating/boards`;
   - `GET /admin/rating/seasons`;
   - `GET /admin/rating/seasons/:key` — ключ — `seasonKeyParamSchema`
     (`seasons/dto/seasons.dto.ts`); сезона нет → 404 «Сезон не найден»;
   - `GET /admin/players/:accountId/seasons` — `accountIdSchema`.
   Ошибки разбора — `ValidationError` с текстами: «Некорректная сложность,
   период или доска», «Некорректный сезон», «Некорректный идентификатор
   аккаунта».
6. **Модули**: `seasons.module.ts` — провайдеры `SeasonsAdminService` и
   репозитория, `SeasonsAdminService` в `exports`; `admin.module.ts` —
   `SeasonsModule` в `imports`, контроллер в `controllers`. Без `exports`
   сервис не доедет до `AdminModule` — проверить тестом модуля.
7. **Документы** — раздел «Документы».

## Чего не трогаем

- Закрытие сезона, награды и их забор, проекции досок, пересборку.
- Ручки игрока `/api/v1/seasons` и `/runs/leaderboard`.
- Схему БД: новых таблиц и индексов нет (Р189); нужна — вопрос тимлиду.
- Экран панели — T-0381.

## Тесты

Первым коммитом.

- `backend/api/test/admin-rating.test.ts` (сервис на подменённых хранилищах):
  - `boards` `week` без идущего сезона → `seasonKey: null`, `entries: []`;
  - `week` по очкам читает ключ `pts:<сезон>`, по времени — `<сезон>`;
  - строка проекции без подписи из базы не отдаётся, места не сдвигаются;
  - `division` у недели по `divisionOf`, у `all` — `null`;
  - `board=full` без `players.board.restrict` → 403; с правом — читается `full`;
  - разбор: `difficulty=nightmare` → 400 «Некорректная сложность, период или
    доска»; `limit=500` → 400; ключ сезона не понедельник → 400 «Некорректный
    сезон»;
  - без `players.view` → 403 на всех четырёх ручках.
- `backend/api/test/admin-rating.integration.test.ts` (живой Postgres):
  - три закрытых сезона, `limit=2` → два новых и `next`; `before=next` → третий;
  - итоги сезона по сложности: порядок по месту, `total`, имя из `account`;
  - награда за место — только в строке своей сложности; за порог — в каждой
    строке аккаунта; `status` и `claimedAt` как в базе;
  - строки `board = 'full'` без права не отдаются ни в сезоне, ни в местах
    игрока; с правом — отдаются, с полем `board`;
  - места игрока: сезоны по убыванию ключа, `scoring` по `rating.points-from`;
  - несуществующий сезон → 404 «Сезон не найден».

## Аналитика

Нет: отчёт панели только читает. Событий и меток Prometheus не заводим.

## Настройки и окружение

Нет. Пределы `limit` — в схемах `seasons-admin.dto.ts`.

## Документы

- `docs/29-admin-panel.md`, таблица модулей (§2): строка «Рейтинг» — что в
  разделе, ручки `GET /api/v1/admin/rating/boards`, `/rating/seasons`,
  `/rating/seasons/:key`, `/players/:accountId/seasons`, право `players.view`,
  отдельная доска — только с `players.board.restrict`. Экран допишет T-0381.

## Критерии приёмки

- [ ] Четыре ручки под `players.view` отдают доски недели и всех времён,
  страницы архива, итоги сезона с наградами и места игрока по неделям.
- [ ] Отдельная доска видна только держателю `players.board.restrict`.
- [ ] Новых таблиц, индексов и миграций нет.
- [ ] `SeasonsAdminService` экспортирован, `AdminModule` его получает.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; в PR — чек-листы
  безопасности и нагрузки (`docs/15-engineering-standards.md` §7, §8).

## PR

- **Заголовок:** `feat(api): Рейтинг в панели — доски, архив сезонов и места игрока`
- **Метка:** `release: minor`
- **Для игроков:** нет — раздела `## Для игроков` в описании PR нет
- **Сводка для команды** — исполнитель переносит блок в описание PR как есть и
  вписывает номер PR:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — РЕЙТИНГ В ПАНЕЛИ: СЕРВЕР**

  У панели появились ручки рейтинга: текущие доски по сложностям (неделя и всё время), архив недельных сезонов с местами, дивизионами и наградами и места игрока по неделям. Экран — следующей задачей (T-0381).

  🛠 **Что внутри**

  • доступ — с правом «Игроки: смотреть»
  • отдельная доска видна только тем, кто ведёт скрытое ограничение
  • только уже записанные итоги сезонов, новых таблиц нет
  ```
