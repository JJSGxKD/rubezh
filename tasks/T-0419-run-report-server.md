---
id: T-0419
title: Отчёт забега для разбора и решения «Честный», «Аннулировать», «Вернуть забег» — сервер
epic: E11
priority: P2
status: in-progress
owner: claude-lead-1 / sonnet-5.5 / extra
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

# T-0419. Отчёт забега для разбора и решения «Честный», «Аннулировать», «Вернуть забег» — сервер

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0419.json)](README.md#значки-статуса)

## Зачем

Очередь «Разбор забегов» сейчас только ведёт в карточку игрока: решить что-то
про сам забег нельзя, и разобранный забег висит в очереди вечно. После задачи
у панели есть отчёт забега (итог, вердикт и причины, данные подсчёта очков) и
три решения (Р203):
- «Честный» снимает забег с очереди и возвращает его в текущие доски
  рейтинга, если забег на рейтинговой сложности, без читов и без
  ограничения игрока;
- «Аннулировать» убирает забег из досок рейтинга и сезона, не отнимая
  выданных наград;
- «Вернуть забег» отменяет аннулирование с причиной: забег возвращается в
  текущую доску.

Закрытые сезоны ни одно решение не меняет. Страницу отчёта рисует T-0420.

## Решения

- **Р203** (`docs/35-stage4-plan.md`). Исполнитель его не пересматривает.
- **Решения владельца 10.11.2026** (записаны в Р203):
  - **«Честный» возвращает в рейтинг.** Снимает забег с очереди **и**
    возвращает его в текущие доски рейтинга, если забег на рейтинговой
    сложности, без читов и без ограничения игрока. Закрытые сезоны не
    меняются;
  - **«Вернуть забег»** — отмена аннулирования, причина обязательна, запись
    в журнал действий команды. Забег возвращается в текущую доску; закрытые
    сезоны и `season_result` не меняются.
- **Решение тимлида claude-lead-1, 10.11.2026:** аннулирование не меняет
  закрытые сезоны — их итоги (`season_result`) и награды остаются как есть,
  пересчитывается только текущая доска.
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
- **Переходы состояний** (`review_outcome`):

  | Действие | Из `null` | Из `honest` | Из `annulled` |
  |---|---|---|---|
  | «Честный» | → `honest`, только при вердикте `suspicious` или `rejected`; иначе `409` «Забег не в разборе: проверка не нашла в нём вопросов» | тот же ответ, без записи в журнал | `409` «Забег аннулирован — вернуть его можно кнопкой «Вернуть забег»» |
  | «Аннулировать» | → `annulled` | → `annulled` (строже) | тот же ответ, без записи в журнал; ещё `ranked` — снять (повтор чинит недоделанное) |
  | «Вернуть забег» | `409` «Забег не аннулирован — возвращать нечего» | тот же ответ, без записи в журнал | → `honest` |

  «Вернуть забег» ставит `honest`, а не `null`: команда решила, что забег
  годен, и подозрительный забег не должен вернуться в очередь.
- **Возврат в рейтинг — «Честный» и «Вернуть забег»** (решение владельца;
  устройство — решение тимлида claude-lead-1, 10.11.2026):
  - **годен для рейтинга** (`returnableToRating`, чистое правило) — забег
    законченный, рейтинговая сложность и не раньше отсечки рейтинга
    (`isRatedRun`, `rated-runs.ts`), `cheats = false`, сдан без
    ограничения (`ratingRestricted = null`), режим не `prologue`. Вердикт
    не важен: решение команды сильнее вердикта проверки. Забег с читами,
    засчитанный владельцу в рейтинг (`countInRating`), разбор в рейтинг не
    возвращает — владелец сказал «без читов»;
  - годен и не `ranked` → после записи решения
    `RunsService.setRanked(actor, runId, true, comment)` — **тот же путь,
    что «Вернуть…» в карточке игрока**: доска сложности по лучшему забегу,
    `emitRankingChanged` (недельная таблица **текущего** сезона
    пересчитывается по базе, закрытые недели не трогаются —
    `seasons-projection.ts` `refresh` берёт `schedule.current`), запись
    `players.run.rerank`. `comment` у «Честного» необязателен — тогда в
    `setRanked` уходит «Разбор: честный забег». Своего пересчёта досок
    задача не пишет и `runs.service.ts` не трогает;
  - чтобы `setRanked` принял такой забег, условие `UNRANKED_BY_MODERATOR`
    (`runs.repository.ts`) расширяется (шаг 6): снятый модератором — это
    `ok`-забег без решения **или** любой забег с решением `honest`; в обоих
    случаях `ranked = false`, без читов, без ограничения, не пролог.
    Аннулированный под условие не попадает;
  - `RunRankingConflictError` из `setRanked` — не ошибка решения: забег уже
    в рейтинге или не годен по базе (условие в самом обновлении). Решение
    записано, ответ — отчёт с нынешним `rating.ranked`;
  - **ограничение рейтинга, действующее сейчас**, держит доску, как у
    «Вернуть…»: `setRanked` не трогает доску игрока на сроке, забег встанет
    в неё, когда срок кончится;
  - **закрытые сезоны не меняются**: забег прошлой недели возвращается в
    доску сложности, а в таблицу закрытой недели и в её `season_result` —
    нет. Награды не начисляются и не отнимаются;
  - **отметка «Рубеж удержан»** идёт по вердикту `ok` (`rubezhWinners`): у
    возвращённого подозрительного забега её нет, правило не меняем —
    правдоподобие победы и есть то, в чём проверка засомневалась;
  - повтор «Честного» или «Вернуть забег» на `honest` — тот же ответ без
    `setRanked`: если возврат в рейтинг сорвался ошибкой после записи
    решения, забег виден в «Рекордах в рейтинге» карточки игрока как снятый,
    и его возвращают там «Вернуть…».
- **«Аннулировать»** (`POST /admin/runs/:runId/annul`, тело `{ comment }`,
  причина обязательна, 1–500 знаков — та же схема `liftSchema`, что у «Не
  учитывать…»):
  - для любого законченного забега, с любым вердиктом: страницу отчёта можно
    открыть и по адресу, а не только из очереди;
  - забег в рейтинге (`ranked = true`) снимается **тем же путём, что «Не
    учитывать…»**: `RunsService.setRanked(actor, runId, false, comment)` — он
    пересчитывает доску сложности по лучшему оставшемуся забегу и отметку
    рубежа, зовёт `emitRankingChanged` и пишет в журнал
    `players.run.unrank`;
  - `RunRankingConflictError` из `setRanked` — не ошибка аннулирования: забег
    уже вне досок;
  - **награды не отнимаются**: кошелёк, сундуки, задания, сезонные награды —
    не трогаются; закрытые сезоны — решение тимлида выше.
- **«Честный»** (`POST /admin/runs/:runId/honest`, тело `{ comment? }`,
  причина необязательна, 1–500 знаков, если задана).
- **«Вернуть забег»** (`POST /admin/runs/:runId/restore`, тело `{ comment }`,
  причина обязательна, `liftSchema`).
- **Аннулированный не возвращается «Вернуть…» карточки игрока** — только
  «Вернуть забег» отчёта, с причиной: условие `UNRANKED_BY_MODERATOR` его не
  пропускает. Аннулированный пропадает и из «Рекордов в рейтинге» карточки
  (`moderationRuns` берёт то же условие). Пересборка досок
  (`rebuildLeaderboard`, `runs:rescore`) и закрытие сезона берут
  `ranked = true` и аннулированного не увидят.
- **Гонки** — каждое решение — одно условное `updateMany` по `runId` и
  допустимому прежнему состоянию; `count = 0` — перечитать строку и решить:
  нет забега → `404`, тот же исход → идемпотентный ответ, другой исход →
  `409`. `setRanked` зовёт только тот вызов, чьё обновление прошло: два
  одновременных «Аннулировать» или «Вернуть забег» дают одну запись решения
  и одну запись `players.run.unrank` / `players.run.rerank`.
- **Журнал**: `players.run.honest`, `players.run.annul`,
  `players.run.restore`; `target` — аккаунт игрока, `after: { runId, verdict,
  reasons, comment, wasRanked }` (`wasRanked` — у аннулирования),
  `before: { reviewOutcome }` у аннулирования из `honest` и у возврата
  (`"annulled"`). Подписи — в `apps/admin/src/api/audit.ts`: «Разбор:
  честный забег», «Разбор: забег аннулирован», «Разбор: аннулирование
  отменено».
- **Ответ всех ручек** — `RunReportView` (шаг 5): после решения панель
  сразу видит итог, без второго запроса.
- **Ожидаемые очки** в отчёте — `RunScorer.expectedPointsFor(axes.t)`
  (`rating/run-scorer.service.ts`), сервис подключается `@Optional()`, как в
  `RunsService`: нет его или очков — `expectedPoints: null`.

## Как сейчас

- `backend/api/prisma/schema.prisma:450–515` — `model Run`: `mode`, `ranked`,
  `ratingRestricted`, `verdict`, `verdictReasons`, `cheats`, `points`,
  `axes`, `style`, `band`, `scoreInput`, `details`, `weapons`, `continues`,
  индекс `@@index([verdict, finishedAt])` под очередь.
- `backend/api/src/modules/runs/runs.repository.ts`:
  - `review(limit)` (строки ~514–533) — `where: { verdict: { in: ["suspicious", "rejected"] } }`;
  - `setRanked(runId, ranked, since)` (строка ~504) — возврат условием
    `{ ...ratedWhere(since), runId, status: "finished", ...UNRANKED_BY_MODERATOR }`;
  - `UNRANKED_BY_MODERATOR` (строка ~560) —
    `{ ranked: false, verdict: "ok", cheats: false, ratingRestricted: null }`,
    условие «Вернуть…» и списка `moderationRuns` (строка ~483);
  - файл уже больше 500 строк — новых методов сюда не добавлять, только две
    правки условий.
- `backend/api/src/modules/runs/runs.service.ts:254–292` — `setRanked`:
  права, условное обновление, пересчёт доски (кроме игрока на сроке
  ограничения), `emitRankingChanged`, журнал `players.run.unrank` /
  `players.run.rerank`. `RunRankingConflictError` экспортирован (строка 51).
- `backend/api/src/modules/runs/rated-runs.ts` — `isRatedRun(difficulty, finishedAt, since)`;
  отсечка — `RatingRestrictions.since()` (как в `RunsService`, строка 96).
- `backend/api/src/modules/seasons/seasons-projection.ts:89–102` — `refresh`
  по изменению рейтинга правит только таблицу текущей недели.
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
   export type ReviewAction = "honest" | "annul" | "restore";
   /** Строка колонки → исход; незнакомое значение — `null` (как «не разбирался»), а не исключение. */
   export function reviewOutcomeOf(value: string | null): ReviewOutcome | null;
   /** Куда ведёт действие и из каких состояний оно разрешено (таблица переходов в «Решениях»). */
   export const TRANSITIONS: Record<ReviewAction, { to: ReviewOutcome; from: readonly (ReviewOutcome | null)[] }> = {
     honest: { to: "honest", from: [null] },
     annul: { to: "annulled", from: [null, "honest"] },
     restore: { to: "honest", from: ["annulled"] },
   };
   export function inQueue(verdict: string | null): boolean; // suspicious | rejected
   /** Что делать с действием по нынешнему состоянию строки. */
   export function decide(action: ReviewAction, run: { verdict: string | null; reviewOutcome: ReviewOutcome | null }):
     "apply" | "same" | "not_in_review" | "already_annulled" | "not_annulled";
   export function availableActions(run: { verdict: string | null; reviewOutcome: ReviewOutcome | null }): { honest: boolean; annul: boolean; restore: boolean };
   /** Вернут ли «Честный» и «Вернуть забег» забег в рейтинг — то же правило, что условие базы в шаге 6. */
   export function returnableToRating(
     run: { difficulty: Difficulty; finishedAt: Date; cheats: boolean; ratingRestricted: string | null; mode: string },
     since: Date | null,
   ): boolean;
   ```

   `decide`: «Честный» из `null` при вердикте не из очереди →
   `not_in_review`, из `annulled` → `already_annulled`; «Вернуть забег» из
   `null` → `not_annulled`; повтор того же исхода → `same` (таблица
   переходов). `availableActions`: `honest` — `null` и вердикт из очереди;
   `annul` — не `annulled`; `restore` — `annulled`.
4. **`run-review.repository.ts`** — `RUN_REVIEW_REPOSITORY`,
   `PrismaRunReviewRepository`:
   - `report(runId): Promise<RunReportRow | null>` — законченный забег со
     всеми колонками отчёта; JSON-колонки — схемами из «Как сейчас»; битое —
     `null` в своём поле, а не исключение;
   - `mark(runId, outcome, from: readonly (ReviewOutcome | null)[], actorId, at): Promise<boolean>`
     — одно `updateMany` с `status: "finished"` и `reviewOutcome` из `from`
     (`null` в Prisma — отдельным условием `OR`: `NOT` и `in` с `null` не
     работают), `true` — строка обновлена.
5. **`run-review.service.ts`** — `RunReviewService` (зависимости:
   репозиторий, `RunsService`, `RatingRestrictions`, роли, аккаунты,
   `RunScorer` `@Optional()`):
   - `report(actor, runId): Promise<RunReportView>` — `players.view`; нет —
     `RunNotFoundError`;
   - `honest(actor, runId, comment: string | null): Promise<RunReportView>`;
   - `annul(actor, runId, comment: string): Promise<RunReportView>`;
   - `restore(actor, runId, comment: string): Promise<RunReportView>`.

   Порядок решения: права → строка (`404`) → `decide` → `mark` с `from` из
   `TRANSITIONS` (проиграл гонку — перечитать и снова `decide`) → журнал
   решения → для `annul` при `ranked` — `setRanked(false)`; для `honest` и
   `restore` при `returnableToRating` и не `ranked` — `setRanked(true)` →
   отчёт. `RunRankingConflictError` ловится только вокруг `setRanked`,
   остальные ошибки летят дальше.

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
     /** `returnable` — «Честный» и «Вернуть забег» вернут забег в рейтинг (`returnableToRating`) */
     rating: { ranked: boolean; ratingRestricted: "notified" | "silent" | null; returnable: boolean };
     score: { points: number; axes: { t: number; k: number; h: number; c: number; b: number }; style: string; band: string; expectedPoints: number | null } | null;
     scoreInput: StoredScoreInput | null;
     review: { outcome: ReviewOutcome | null; reviewedAt: string | null; reviewedBy: string | null; reviewerName: string | null };
     /** что разрешает состояние забега; права панель проверяет сама */
     actions: { honest: boolean; annul: boolean; restore: boolean };
   }
   ```

   Время — ISO в UTC. Имена игрока и того, кто решил, — одним вызовом
   `accounts.displayNames([...])`. Лог — строка JSON `{ module: "runs",
   event: "run_review_honest" | "run_review_annulled" | "run_review_restored",
   runId, accountId, actor, ranked }`, как у `setRanked`.
6. **`runs.repository.ts`** — две правки:
   - `review()` — `reviewOutcome: null` в `where`;
   - `UNRANKED_BY_MODERATOR`:
     ```ts
     const UNRANKED_BY_MODERATOR = {
       ranked: false,
       cheats: false,
       ratingRestricted: null,
       mode: { not: "prologue" as const },
       OR: [{ verdict: "ok" as const, reviewOutcome: null }, { reviewOutcome: "honest" }],
     };
     ```
     Комментарий к константе — что снятый модератором теперь и забег,
     признанный честным разбором (Р203), а аннулированный сюда не попадает.
     В `moderationRuns` константа стоит элементом `OR` — вложенный `OR`
     внутри элемента Prisma принимает; проверь запрос интеграционным тестом.
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
     тело `liftSchema`, ошибка — «Нужна причина»;
   - `POST runs/:runId/restore`, `@HttpCode(200)` — `players.restrict`,
     лимит, тело `liftSchema`, ошибка — «Нужна причина».
   Контроллер — в `controllers` `admin.module.ts`.
9. **Журнал** — три подписи в `apps/admin/src/api/audit.ts` и строки в
   `apps/admin/test/audit.test.ts`.
10. **Документы** — раздел «Документы».

## Чего не трогаем

- `runs.service.ts` (`setRanked` вызывается как есть) и
  `admin-review.controller.ts` (зона T-0319).
- `rubezhWinners`: отметка рубежа — по вердикту `ok`, как сейчас.
- `seasons/*`: таблица недели пересчитывается сама по `emitRankingChanged`;
  закрытые сезоны и `season_result` не трогаются.
- Перепроверку повтором, исход повтора в отчёте и «Повторить снова» — T-0319.
- Карточку разбора в чате команды (`admin-notify/run-review-card.ts`).
- Кошелёк, награды, закрытые сезоны — по Р203 не меняются.
- Страницу отчёта в панели — T-0420.

## Тесты

Первым коммитом, до кода.

- `backend/api/test/run-review.test.ts` — правила и сервис с подставными
  репозиториями, HTTP через Nest, как `admin.test.ts`:
  - `decide` — вся таблица переходов: «Честный» из `null` при `suspicious`
    → `apply`, при `ok` → `not_in_review`, из `honest` → `same`, из
    `annulled` → `already_annulled`; «Аннулировать» из `null` и `honest` →
    `apply`, из `annulled` → `same`; «Вернуть забег» из `annulled` → `apply`,
    из `honest` → `same`, из `null` → `not_annulled`;
  - `availableActions`: подозрительный без решения →
    `{ honest: true, annul: true, restore: false }`; честный →
    `{ honest: false, annul: true, restore: false }`; аннулированный →
    `{ honest: false, annul: false, restore: true }`; `ok` без решения →
    `{ honest: false, annul: true, restore: false }`;
  - `returnableToRating`: `hard`, после отсечки, без читов, без ограничения,
    `endless` → `true`; каждое нарушение по одному (`easy`, раньше отсечки,
    `cheats`, `ratingRestricted: "silent"`, `mode: "prologue"`) → `false`;
    вердикт `rejected` при прочих годных → `true`;
  - `reviewOutcomeOf("weird")` → `null`;
  - `honest` годного подозрительного забега зовёт
    `setRanked(actor, runId, true, "Разбор: честный забег")` ровно один раз;
    с причиной — с ней; негодного (читы) — не зовёт; `setRanked` бросил
    `RunRankingConflictError` → решение успешно, `rating.ranked: false`;
    бросил другую ошибку → ошибка летит дальше, решение уже записано;
  - `restore` аннулированного годного забега → `mark` в `honest` из
    `["annulled"]`, `setRanked(…, true, comment)` один раз, журнал
    `players.run.restore` с `before: { reviewOutcome: "annulled" }`;
    повтор `restore` на `honest` → тот же ответ, без `setRanked` и без
    второй записи;
  - `annul` рейтингового забега зовёт `setRanked(actor, runId, false, comment)`
    ровно один раз; нерейтингового — не зовёт; `RunRankingConflictError` →
    аннулирование успешно;
  - повтор `annul` уже аннулированного, но ещё `ranked` забега зовёт
    `setRanked(false)` и не пишет второй `players.run.annul`;
  - повтор `honest` — тот же ответ, журнал пишется один раз, `setRanked` не
    зван;
  - журнал `players.run.annul` несёт `runId`, `verdict`, `reasons`, `comment`,
    `wasRanked`; из `honest` — ещё `before: { reviewOutcome: "honest" }`;
  - HTTP: `GET /admin/runs/<id>/report` с `players.view` → `200` и форма
    `RunReportView` с `rating.returnable` и `actions.restore`; без права →
    `403`; незнакомый `runId` → `404`; `POST …/honest`, `…/annul` и
    `…/restore` с `players.view` без `players.restrict` → `403`; `…/annul` и
    `…/restore` без `comment` или с пустым → `400` «Нужна причина»; лишнее
    поле в теле → `400`; `…/honest` на `ok`-забеге → `409`; `…/honest` на
    аннулированном → `409` с текстом про «Вернуть забег»; `…/restore` на
    неразобранном → `409` «Забег не аннулирован — возвращать нечего».
- `backend/api/test/run-review.integration.test.ts` — на живых Postgres и
  Redis, как `runs.integration.test.ts` (пропускается без адресов):
  - подозрительный рейтинговой сложности без читов и ограничения, с очками,
    в очереди (`runs.review`) → «Честный» → в очереди его нет,
    `review_outcome = 'honest'`, `reviewed_by` — актёр, `ranked = true`,
    игрок в доске Redis с очками этого забега (если он лучший), в журнале
    `players.run.honest` и `players.run.rerank`;
  - тот же забег с `cheats = true` → «Честный» → вне очереди, `ranked = false`,
    в доске нет, `players.run.rerank` нет;
  - подозрительный забег прошлой недели → «Честный» → в доске сложности
    есть, в таблице текущей недели нет, строки `season_result` закрытой
    недели до и после совпадают;
  - рейтинговый `ok`-забег — лучший у игрока на доске → «Аннулировать» →
    `ranked = false`, `review_outcome = 'annulled'`; место игрока в доске
    Redis — по следующему лучшему забегу (или игрока нет, если других нет);
    `POST /admin/runs/:id/rerank` на нём → `409`; в `moderationRuns` его
    нет;
  - он же → «Вернуть забег» с причиной → `review_outcome = 'honest'`,
    `ranked = true`, место игрока снова по нему; в `moderationRuns` он
    снова среди рекордов; журнал `players.run.restore` и
    `players.run.rerank`;
  - честный возвращённый забег → «Не учитывать…» (`/unrank`) →
    «Вернуть…» (`/rerank`) → `200`: условие `UNRANKED_BY_MODERATOR` его
    пропускает;
  - пересборка доски (`RunsService.rebuildLeaderboard`) после аннулирования
    не возвращает забег, после «Вернуть забег» — возвращает;
  - баланс кошелька игрока и строки `season_result` закрытого сезона до и
    после аннулирования и возврата совпадают;
  - два параллельных «Аннулировать» одного забега → оба `200`, запись
    `players.run.annul` в журнале одна; два параллельных «Вернуть забег» →
    оба `200`, по одной записи `players.run.restore` и `players.run.rerank`;
  - забег, записанный до миграции (колонки `null`), читается отчётом с
    `review.outcome: null` и попадает в очередь, если он подозрительный.

## Аналитика

Событий нет: игрок ничего не делает, решение команды пишется в журнал
действий (`players.run.honest`, `players.run.annul`, `players.run.restore`,
вместе с `players.run.unrank` и `players.run.rerank` при снятии и возврате).
Метрик с `run_id` в метках нет и не будет.

## Настройки и окружение

Нет.

## Документы

- `docs/21-diagrams.md` — в сущности `RUN` три строки:
  `string review_outcome "nullable: honest|annulled — решение разбора (Р203)"`,
  `datetime reviewed_at "nullable"`, `uuid reviewed_by "nullable: кто решил, без FK"`.
- `docs/29-admin-panel.md`, §9, строка этапа 4 (после «рекорды в
  рейтинге»): «**Отчёт забега для разбора** (Р203, T-0419): `GET
  /admin/runs/:runId/report` — итог, вердикт и причины, очки и данные
  подсчёта; `POST …/honest` снимает забег с очереди и возвращает в текущие
  доски, если он на рейтинговой сложности, без читов и без ограничения;
  `POST …/annul` с причиной убирает из досок рейтинга и сезона, не отнимая
  наград; `POST …/restore` с причиной отменяет аннулирование и возвращает
  забег в текущую доску. Закрытые сезоны не меняются; решения идемпотентны,
  право `players.restrict`».

## Критерии приёмки

- [ ] Очередь разбора не показывает забеги с решением.
- [ ] «Честный» снимает подозрительный или отклонённый забег с очереди и
      возвращает его в текущие доски тем же путём, что «Вернуть…», если он
      на рейтинговой сложности после отсечки, без читов, без ограничения и
      не пролог; иначе рейтинг не меняется. Повтор — без второй записи в
      журнал.
- [ ] «Аннулировать» с причиной убирает рейтинговый забег с доски и из
      текущего сезона тем же путём, что «Не учитывать…»; аннулированный не
      возвращается «Вернуть…» карточки и пересборкой.
- [ ] «Вернуть забег» с обязательной причиной переводит аннулированный в
      `honest`, пишет `players.run.restore` и возвращает годный забег в
      текущую доску; из других состояний — `409` или тот же ответ по
      таблице переходов.
- [ ] Награды, закрытые сезоны и `season_result` не меняются ни одним
      решением.
- [ ] Решения — условным обновлением, параллельные вызовы дают одну запись
      в журнале; права `players.view` и `players.restrict`.
- [ ] Миграция только добавляет три колонки `null`; ER-диаграмма обновлена.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.

## PR

- **Заголовок:** `feat(api): Отчёт забега и решения разбора забегов`
- **Метка:** `release: minor`
- **Для игроков:** нет
- **Сводка для команды:**

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ОТЧЁТ ЗАБЕГА И РЕШЕНИЯ РАЗБОРА**

  У «Разбора забегов» появился сервер для отчёта забега и трёх решений (Р203). Страницу в панели добавит T-0420.

  🛠 **Разбор**

  • «Честный» снимает забег с очереди и возвращает его в текущие доски, если он на «Сложной», без читов и без ограничения
  • «Аннулировать» с причиной убирает забег из досок рейтинга и сезона; выданные награды остаются
  • «Вернуть забег» с причиной отменяет аннулирование — забег снова в текущей доске
  • закрытые сезоны и их итоги ни одно решение не меняет; решённые забеги из очереди уходят, повтор решения безопасен
  ```
