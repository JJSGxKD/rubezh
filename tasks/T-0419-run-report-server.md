---
id: T-0419
title: Отчёт забега для разбора и решения «Честный» и «Аннулировать» — сервер
epic: E11
priority: P2
status: ready
owner:
author: claude-lead-1
size: M
depends_on: []
zones:
  - backend/api/src/modules/runs/run-review.service.ts
  - backend/api/src/modules/runs/run-review.repository.ts
  - backend/api/src/modules/runs/run-review-rules.ts
  - backend/api/src/modules/runs/runs.repository.ts
  - backend/api/src/modules/admin/admin-run-review.controller.ts
  - backend/api/test/run-review.test.ts
  - backend/api/test/run-review.integration.test.ts
shared:
  - backend/api/prisma/schema.prisma
  - backend/api/prisma/migrations/
  - backend/api/src/modules/runs/runs.module.ts
  - backend/api/src/modules/admin/admin.module.ts
  - apps/admin/src/api/audit.ts
  - apps/admin/test/audit.test.ts
  - docs/21-diagrams.md
  - docs/29-admin-panel.md
runner: any
executor: sonnet-5.5
effort: extra
release: minor
merge: lead
design: null
batch: 5
---

# T-0419. Отчёт забега для разбора и решения «Честный» и «Аннулировать» — сервер

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0419.json)](README.md#значки-статуса)

## Зачем

Очередь «Разбор забегов» сейчас только ведёт в карточку игрока: решить что-то
про сам забег нельзя, и разобранный забег висит в очереди вечно. После задачи
у панели есть отчёт забега (итог, вердикт и причины, данные подсчёта очков) и
два решения: «Честный» снимает забег с очереди, «Аннулировать» убирает его из
досок рейтинга и сезона навсегда, не отнимая выданных наград (Р203). Страницу
отчёта рисует T-0420.

## Решения

- **Р203** (`docs/35-stage4-plan.md`). Исполнитель его не пересматривает.
- **Решение разбора — колонки забега**, а не отдельная таблица: его читают
  очередь и правило «Вернуть…», а колонки в `run` дешевле соединения:
  - `review_outcome varchar(16) null` — `honest` или `annulled`; `null` — не
    разбирался;
  - `reviewed_at timestamptz(3) null`;
  - `reviewed_by uuid null` — аккаунт команды, без внешнего ключа: удалённый
    аккаунт не должен ронять историю забега.
  Миграция только расширяющая (`ADD COLUMN … NULL` — без переписывания
  таблицы).
- **Очередь** — подозрительные и отклонённые **без решения**:
  `verdict in (suspicious, rejected) and review_outcome is null`.
- **Права**: отчёт — `players.view` (как очередь); решения — `players.restrict`
  (как «Не учитывать…» и «Вернуть…», WP44 3б; есть у модератора). Проверка
  — и гвардом, и в сервисе (`roles.require`).
- **«Честный»** (`POST /admin/runs/:runId/honest`, тело `{ comment? }`,
  причина необязательна, 1–500 знаков, если задана):
  - только для законченного забега с вердиктом `suspicious` или `rejected`;
    иначе `409` «Забег не в разборе: проверка не нашла в нём вопросов»;
  - рейтинг **не меняет**: подозрительный и отклонённый забег в рейтинг не
    шли и не пойдут (решение тимлида в Р203 — подтвердить владельцу);
  - уже `honest` — тот же ответ, без второй записи в журнал (идемпотентно);
  - уже `annulled` — `409` «Забег уже аннулирован — решение не меняется».
- **«Аннулировать»** (`POST /admin/runs/:runId/annul`, тело `{ comment }`,
  причина обязательна, 1–500 знаков — та же схема `liftSchema`, что у «Не
  учитывать…»):
  - для любого законченного забега, с любым вердиктом: страницу отчёта можно
    открыть и по адресу, а не только из очереди;
  - разрешено из `null` и из `honest` (строже) — в `annulled`;
  - забег в рейтинге (`ranked = true`) снимается **тем же путём, что «Не
    учитывать…»**: `RunsService.setRanked(actor, runId, false, comment)` — он
    пересчитывает доску сложности по лучшему оставшемуся забегу и отметку
    рубежа, зовёт `emitRankingChanged` (недельная таблица сезона
    пересчитывается по базе) и пишет в журнал `players.run.unrank`. Своего
    пересчёта досок задача не пишет и `runs.service.ts` не трогает;
  - `RunRankingConflictError` из `setRanked` (забег успели снять или он
    раньше отсечки рейтинга) — не ошибка аннулирования: забег уже вне досок;
  - уже `annulled` — тот же ответ без второй записи в журнал; но если забег
    всё ещё `ranked` (прошлый вызов упал между пометкой и снятием) — снять
    его с рейтинга сейчас: повтор чинит недоделанное;
  - **награды не отнимаются**: кошелёк, сундуки, задания, сезонные награды —
    не трогаются;
  - **закрытые сезоны не меняются**: их итоги (`season_result`) и награды
    остаются как есть; пересчитывается только текущая доска.
- **Аннулированный не возвращается** «Вернуть…»: в `UNRANKED_BY_MODERATOR`
  (`runs.repository.ts`) добавляется `reviewOutcome: null`. Заодно
  аннулированный пропадает из списка «Рекорды в рейтинге» карточки игрока
  (`moderationRuns` берёт то же условие) — это верно: он больше не «снят
  модератором», а аннулирован. Пересборка досок (`rebuildLeaderboard`,
  `runs:rescore`) и закрытие сезона берут `ranked = true` и аннулированного
  не увидят: у него `ranked = false`.
- **Гонки** — каждое решение — одно условное `updateMany` по `runId` и
  допустимому прежнему состоянию; `count = 0` — перечитать строку и решить:
  нет забега → `404`, тот же исход → идемпотентный ответ, другой исход →
  `409`. Два одновременных «Аннулировать» дают одну запись `players.run.annul`.
- **Журнал**: `players.run.honest` и `players.run.annul`, `target` —
  аккаунт игрока, `after: { runId, verdict, reasons, comment, wasRanked }`
  (`wasRanked` — только у аннулирования), `before: { reviewOutcome }` у
  аннулирования из `honest`. Подписи — в `apps/admin/src/api/audit.ts`:
  «Разбор: честный забег», «Разбор: забег аннулирован».
- **Ответ всех трёх ручек** — `RunReportView` (шаг 4): после решения панель
  сразу видит итог, без второго запроса.
- **Ожидаемые очки** в отчёте — `RunScorer.expectedPointsFor(axes.t)`
  (`rating/run-scorer.service.ts`), сервис подключается `@Optional()`, как в
  `RunsService`: нет его или очков — `expectedPoints: null`.

## Как сейчас

- `backend/api/prisma/schema.prisma:450–515` — `model Run`: `ranked`,
  `ratingRestricted`, `verdict`, `verdictReasons`, `points`, `axes`, `style`,
  `band`, `scoreInput`, `details`, `weapons`, `continues`, индекс
  `@@index([verdict, finishedAt])` под очередь.
- `backend/api/src/modules/runs/runs.repository.ts`:
  - `review(limit)` (строки ~511–528) — `where: { verdict: { in: ["suspicious", "rejected"] } }`;
  - `UNRANKED_BY_MODERATOR` (строка ~556) — условие «Вернуть…» и списка
    `moderationRuns` (строка ~482);
  - файл уже больше 500 строк — новых методов сюда не добавлять, только две
    правки условий.
- `backend/api/src/modules/runs/runs.service.ts:254–285` — `setRanked`:
  права, условное обновление, пересчёт доски, `emitRankingChanged`, журнал.
  `RunRankingConflictError` экспортирован (строка 51).
- `backend/api/src/modules/runs/runs-view.service.ts` — `RunNotFoundError`
  (`404`, «Забег не найден»).
- `backend/api/src/modules/admin/admin-runs.controller.ts` — образец ручек
  решений: `RateLimiter` с `ADMIN_LIMITS.mutate`, `runIdSchema`
  (`z.string().min(8).max(64)`), `liftSchema`.
- `backend/api/src/modules/admin/admin-review.controller.ts` — очередь
  (`GET /admin/runs/review`), имена через `accounts.displayNames`. Этот файл
  в зоне T-0319 — **не трогать**, ручки отчёта — новым контроллером.
- `backend/api/src/modules/runs/run-details.ts` — `storedDetailsSchema`,
  `storedWeaponsSchema`; `rating/score-types.ts` — `storedScoreOf`,
  `storedScoreInputSchema`. JSON-колонки читаются ими, без `as`.
- `backend/api/src/modules/runs/runs.module.ts` — провайдеры и `exports`;
  `AdminModule` уже импортирует `RunsModule`.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **Схема и миграция.** В `model Run` после `scoreInput` три поля с
   комментариями `///` (смысл — из решения «Решение разбора»):
   `reviewOutcome String? @map("review_outcome") @db.VarChar(16)`,
   `reviewedAt DateTime? @map("reviewed_at") @db.Timestamptz(3)`,
   `reviewedBy String? @map("reviewed_by") @db.Uuid`. Индексы не меняются.
   Миграция — по строке «миграции» раздела «Общие файлы» `tasks/README.md`
   (`prisma migrate diff` без базы, один раз, после влития свежего `dev`).
   Модель новая не появляется — `wipe-plan.ts` не трогается.
3. **`run-review-rules.ts`** — чистые правила без Nest и Prisma:

   ```ts
   export const REVIEW_OUTCOMES = ["honest", "annulled"] as const;
   export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];
   /** Строка колонки → исход; незнакомое значение — `null` (как «не разбирался»), а не исключение. */
   export function reviewOutcomeOf(value: string | null): ReviewOutcome | null;
   /** Из каких состояний разрешено решение. */
   export const ALLOWED_FROM: Record<ReviewOutcome, readonly (ReviewOutcome | null)[]> = { honest: [null], annulled: [null, "honest"] };
   export function inQueue(verdict: string | null): boolean; // suspicious | rejected
   /** Что делать с решением по нынешнему состоянию строки. */
   export function decide(target: ReviewOutcome, run: { verdict: string | null; reviewOutcome: ReviewOutcome | null }):
     "apply" | "same" | "not_in_review" | "already_annulled";
   export function availableActions(run: { verdict: string | null; reviewOutcome: ReviewOutcome | null }): { honest: boolean; annul: boolean };
   ```

4. **`run-review.repository.ts`** — `RUN_REVIEW_REPOSITORY`,
   `PrismaRunReviewRepository`:
   - `report(runId): Promise<RunReportRow | null>` — законченный забег со
     всеми колонками отчёта; JSON-колонки — схемами из «Как сейчас»; битое —
     `null` в своём поле, а не исключение;
   - `mark(runId, outcome, from: readonly (ReviewOutcome | null)[], actorId, at): Promise<boolean>`
     — одно `updateMany` с `status: "finished"` и `reviewOutcome` из `from`
     (`null` в Prisma — отдельным условием `OR`: `NOT` и `in` с `null` не
     работают), `true` — строка обновлена.
5. **`run-review.service.ts`** — `RunReviewService`:
   - `report(actor, runId): Promise<RunReportView>` — `players.view`; нет —
     `RunNotFoundError`;
   - `honest(actor, runId, comment: string | null): Promise<RunReportView>`;
   - `annul(actor, runId, comment: string): Promise<RunReportView>`.

   ```ts
   export interface RunReportView {
     runId: string;
     accountId: string;
     displayName: string | null;
     difficulty: string;
     mode: string;
     startedAt: string | null;
     finishedAt: string;
     outcome: "died" | "abandoned" | null;
     survivalSec: number | null;
     level: number | null;
     enemiesKilled: number | null;
     deathCause: string | null;
     weapons: { id: string; level: number; damage: number | null }[];
     details: StoredDetails | null;
     continues: number[];
     cheats: boolean;
     contentHash: string;
     rubezh: { reached: boolean; clearedSec: number | null };
     verdict: "ok" | "suspicious" | "rejected" | null;
     verdictReasons: string[];
     rating: { ranked: boolean; ratingRestricted: "notified" | "silent" | null };
     score: { points: number; axes: { t: number; k: number; h: number; c: number; b: number }; style: string; band: string; expectedPoints: number | null } | null;
     scoreInput: StoredScoreInput | null;
     review: { outcome: ReviewOutcome | null; reviewedAt: string | null; reviewedBy: string | null; reviewerName: string | null };
     /** что разрешает состояние забега; права панель проверяет сама */
     actions: { honest: boolean; annul: boolean };
   }
   ```

   Время — ISO в UTC. Имена игрока и того, кто решил, — одним вызовом
   `accounts.displayNames([...])`. Лог — строка JSON `{ module: "runs",
   event: "run_review_honest" | "run_review_annulled", runId, accountId,
   actor }`, как у `setRanked`.
6. **`runs.repository.ts`** — две правки: `review()` — `reviewOutcome: null`
   в `where`; `UNRANKED_BY_MODERATOR` — `reviewOutcome: null`. Комментарий к
   константе — одна строка: «аннулированный разбором (Р203) не возвращается».
7. **`runs.module.ts`** — `RunReviewService` и
   `{ provide: RUN_REVIEW_REPOSITORY, useClass: PrismaRunReviewRepository }` в
   `providers`, `RunReviewService` в `exports` (иначе контроллер в
   `AdminModule` его не получит).
8. **`admin/admin-run-review.controller.ts`** — `@Controller("admin")`,
   гварды как у `AdminRunsController`:
   - `GET runs/:runId/report` — `players.view`;
   - `POST runs/:runId/honest`, `@HttpCode(200)` — `players.restrict`, лимит
     `ADMIN_LIMITS.mutate` («Слишком много действий — подождите минуту»),
     тело `z.strictObject({ comment: z.string().trim().min(1).max(500).optional() })`,
     ошибка — «Причина — от 1 до 500 знаков»;
   - `POST runs/:runId/annul`, `@HttpCode(200)` — `players.restrict`, лимит,
     тело `liftSchema`, ошибка — «Нужна причина».
   Контроллер — в `controllers` `admin.module.ts`.
9. **Журнал** — две подписи в `apps/admin/src/api/audit.ts` и строки в
   `apps/admin/test/audit.test.ts`.
10. **Документы** — раздел «Документы».

## Чего не трогаем

- `runs.service.ts` (`setRanked` вызывается как есть) и
  `admin-review.controller.ts` (зона T-0319).
- Перепроверку повтором, исход повтора в отчёте и «Повторить снова» — T-0319.
- Карточку разбора в чате команды (`admin-notify/run-review-card.ts`).
- Кошелёк, награды, закрытые сезоны — по Р203 не меняются.
- Страницу отчёта в панели — T-0420.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/run-review.test.ts` — правила и сервис с подставными
  репозиториями, HTTP через Nest, как `admin.test.ts`:
  - `decide`: `honest` из `null` при `suspicious` → `apply`; при `ok` →
    `not_in_review`; из `honest` → `same`; из `annulled` → `already_annulled`;
    `annulled` из `null` и из `honest` → `apply`, из `annulled` → `same`;
  - `availableActions`: подозрительный без решения → обе; честный →
    `{ honest: false, annul: true }`; аннулированный → обе `false`; `ok` без
    решения → `{ honest: false, annul: true }`;
  - `reviewOutcomeOf("weird")` → `null`;
  - `annul` рейтингового забега зовёт `RunsService.setRanked(actor, runId, false, comment)`
    ровно один раз; нерейтингового — не зовёт; `setRanked` бросил
    `RunRankingConflictError` → аннулирование успешно;
  - повтор `annul` уже аннулированного, но ещё `ranked` забега зовёт
    `setRanked` и не пишет второй `players.run.annul`;
  - повтор `honest` — тот же ответ, журнал пишется один раз;
  - журнал `players.run.annul` несёт `runId`, `verdict`, `reasons`, `comment`,
    `wasRanked`; из `honest` — ещё `before: { reviewOutcome: "honest" }`;
  - HTTP: `GET /admin/runs/<id>/report` с `players.view` → `200` и форма
    `RunReportView`; без права → `403`; незнакомый `runId` → `404`;
    `POST …/honest` и `…/annul` с `players.view` без `players.restrict` →
    `403`; `…/annul` без `comment` или с пустым → `400` «Нужна причина»;
    лишнее поле в теле → `400`; `…/honest` на `ok`-забеге → `409`;
    `…/honest` на аннулированном → `409`.
- `backend/api/test/run-review.integration.test.ts` — на живых Postgres и
  Redis, как `runs.integration.test.ts` (пропускается без адресов):
  - подозрительный забег в очереди (`runs.review`) → «Честный» → в очереди
    его нет, `review_outcome = 'honest'`, `reviewed_by` — актёр, `ranked`
    прежний;
  - рейтинговый `ok`-забег — лучший у игрока на доске → «Аннулировать» →
    `ranked = false`, `review_outcome = 'annulled'`; место игрока в доске
    Redis — по следующему лучшему забегу (или игрока нет, если других нет);
    `POST /admin/runs/:id/rerank` на нём → `409`; в
    `moderationRuns` его нет;
  - пересборка доски (`RunsService.rebuildLeaderboard`) после аннулирования
    не возвращает забег;
  - баланс кошелька игрока и строки `season_result` закрытого сезона до и
    после аннулирования совпадают;
  - два параллельных «Аннулировать» одного забега → оба `200`, запись
    `players.run.annul` в журнале одна;
  - забег, записанный до миграции (колонки `null`), читается отчётом с
    `review.outcome: null` и попадает в очередь, если он подозрительный.

## Аналитика

Событий нет: игрок ничего не делает, решение команды пишется в журнал
действий (`players.run.honest`, `players.run.annul`, вместе с
`players.run.unrank` при снятии с рейтинга). Метрик с `run_id` в метках
нет и не будет.

## Настройки и окружение

Нет.

## Документы

- `docs/21-diagrams.md` — в сущности `RUN` три строки:
  `string review_outcome "nullable: honest|annulled — решение разбора (Р203)"`,
  `datetime reviewed_at "nullable"`, `uuid reviewed_by "nullable: кто решил, без FK"`.
- `docs/29-admin-panel.md`, §9, строка этапа 4 (после «рекорды в
  рейтинге»): «**Отчёт забега для разбора** (Р203, T-0419): `GET
  /admin/runs/:runId/report` — итог, вердикт и причины, очки и данные
  подсчёта; `POST …/honest` снимает забег с очереди, `POST …/annul` с
  причиной убирает из досок рейтинга и сезона навсегда, не отнимая наград и
  не меняя закрытых сезонов; оба идемпотентны, право `players.restrict`».

## Критерии приёмки

- [ ] Очередь разбора не показывает забеги с решением.
- [ ] «Честный» снимает подозрительный или отклонённый забег с очереди, не
      меняя рейтинга; повтор — без второй записи в журнал.
- [ ] «Аннулировать» с причиной убирает рейтинговый забег с доски и из
      текущего сезона тем же путём, что «Не учитывать…»; аннулированный не
      возвращается «Вернуть…» и пересборкой; награды и закрытые сезоны не
      меняются.
- [ ] Решения — условным обновлением, параллельные вызовы дают одну запись
      в журнале; права `players.view` и `players.restrict`.
- [ ] Миграция только добавляет три колонки `null`; ER-диаграмма обновлена.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Отчёт забега и решения разбора «Честный» и «Аннулировать»`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОТЧЁТ ЗАБЕГА И РЕШЕНИЯ РАЗБОРА «ЧЕСТНЫЙ» И «АННУЛИРОВАТЬ»**

  У «Разбора забегов» появился сервер для отчёта забега и двух решений (Р203). Страницу в панели добавит T-0420.

  🛠 **Разбор**

  • «Честный» снимает забег с очереди, рейтинг не меняет
  • «Аннулировать» с причиной убирает забег из досок рейтинга и сезона навсегда; выданные награды и закрытые сезоны не трогаются
  • решённые забеги из очереди уходят; повтор решения безопасен
  ```
