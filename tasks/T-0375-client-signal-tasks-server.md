---
id: T-0375
title: Задания по сигналу клиента — сервер и панель: главный экран и история
epic: E16
priority: P2
status: done
owner: claude-10 / sonnet-5.5 / high
author: claude-lead2-3
size: M
depends_on: []
zones:
  - backend/api/src/modules/tasks/client-signal-rules.ts
  - backend/api/src/modules/tasks/task-signals.service.ts
  - backend/api/src/modules/tasks/task-signals.controller.ts
  - backend/api/test/task-signals.test.ts
  - backend/api/test/task-signals.integration.test.ts
  - apps/admin/src/api/tasks.ts
  - apps/admin/src/screens/tasks/TasksScreen.tsx
  - apps/admin/test/tasks.test.ts
shared:
  - backend/api/src/modules/tasks/task-rules.ts
  - backend/api/src/modules/tasks/tasks.module.ts
  - backend/api/test/tasks.test.ts
  - apps/admin/src/ui/help.ts
  - docs/30-configuration-map.md
runner: any
executor: sonnet-5.5
effort: high
release: minor
merge: lead
design: null
batch: 5
---

# T-0375. Задания по сигналу клиента — сервер и панель: главный экран и история

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0375.json)](README.md#значки-статуса)

## Зачем

Владелец хочет два задания, которые сервер проверить не может: «Добавьте игру
на главный экран» и «Поделитесь историей с игрой». О них знает только клиент
площадки. После задачи такие задания заводятся в панели, клиент сообщает
серверу о действии отдельным запросом, задание становится выполненным и
забирается обычным «Забрать». Клиентскую часть делает T-0376.

## Решения

Записаны в `docs/35-stage4-plan.md` Р187 (31.10.2026) и Р18. Исполнитель их не
пересматривает.

1. **Два задания:**
   - «Добавьте игру на главный экран» — **разовое достижение**, засчитывается по
     событию площадки «добавлено»;
   - «Поделитесь историей с игрой» — **раз в неделю**, засчитывается по
     открытию редактора истории с нашей картинкой и ссылкой: вышла ли история,
     площадка не сообщает.
2. **Награда небольшая и задаётся в панели**, как у других заданий.
3. **Показывается только там, где клиент это умеет** — решает клиент (T-0376);
   минимальная версия Bot API (Р18) не меняется.
4. **Повтор ограничен самим заданием** (раз и раз в неделю) и **лимитом
   частоты**.

Решения `claude-lead2-3` по устройству (не продукт, а способ):

5. **Два новых вида цели, без `params`**: `home_screen` и `story_share`.
   Отдельный вид на каждое действие, а не общий вид с полем: `params` в
   каталоге отличает партнёрскую цель (`CHECK task_def_params_check`, лимит и
   картинка опираются на него), и общий вид с `params` сломал бы этот признак.
   Вид в базе — строка без `CHECK` на список значений, поэтому **миграции нет**.
6. **Срок вида закреплён**: `home_screen` — только `achievement`, `story_share` —
   только `weekly`. Цель — 1, ступени ротации (`tier`), фильтра, лимита, картинки
   и `params` нет: задание в игре всегда, вне ротации.
7. **`home_screen` — достижение витрины, поэтому категория обязательна**:
   витрина берёт только достижения с категорией (`tasks.service.ts:387`,
   `achievementDefs`), без неё игрок задание не увидит. Какая категория — решает
   тот, кто заводит задание в панели.
8. **Засчитывает отдельный маршрут** `POST /api/v1/tasks/signals/:kind`: клиент
   сообщает о действии, сервер отмечает выполненным текущий срок задания этого
   вида. Награда — обычным `POST /api/v1/tasks/:taskId/claim`.

## Как сейчас

- `backend/api/src/modules/tasks/task-rules.ts`:
  - `:22` `TASK_PERIODS`; `:94` `RUN_KINDS`; `:141` `STATE_KINDS`;
    `:164` `CHECKED_KINDS` (`channel | link | bot`), `:170` `TASK_KIND_IDS`;
  - `:239` `taskDefSchema` — правила строки каталога, в конце
    `:354–361` «у партнёрской цели цель — 1» и «повтор — только у подписки на
    канал»;
  - `:388` `taskGroup` — список в панели (по сроку для всего, кроме партнёрских).
- `tasks.service.ts` — 503 строки, дальше не растить. `view` (`:161`), `claim`
  (`:178`): для не-партнёрского вида невыполненное → `TaskNotDoneError`;
  выполненное платит, как любое задание. `open` (`:249`) — образец «засчитать
  действием».
- `tasks.repository.ts:285` `complete(accountId, def, at, graceSince)` —
  выполняет срок задания идемпотентно (`ON CONFLICT … DO UPDATE`), в одной
  транзакции с `task_participant`; без лимита место не держит.
- `tasks.controller.ts` — `LIMIT` 300 в час на все ручки заданий, свои лимиты у
  ручек сетей (`FEED_LIMIT`, `CHECK_LIMIT`).
- В базе (`prisma/migrations/*task*`) на вид цели `CHECK` нет; есть
  `task_def_params_check` (`kind IN ('channel','link','bot') = params IS NOT
  NULL`), `task_def_tier_period_check`, `task_def_achievement_fields_check`.
- Панель: `apps/admin/src/api/tasks.ts` — `KIND_TITLES` (`:22`), `PARTNER_KINDS`,
  `STATE_KINDS`, `withKind` (`:301`), `withPeriod` (`:276`), `taskProblem`
  (`:378`); форма — `screens/tasks/TasksScreen.tsx:110–215` (срок выключен у
  партнёрских и состояний, «Цель» скрыта у партнёрских).

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»).
2. **`tasks/client-signal-rules.ts`** (новый, без Nest и Prisma):

   ```ts
   /** Цели, о выполнении которых сообщает клиент площадки (Р187): сервер их проверить не может. */
   export const CLIENT_KINDS = { home_screen: { period: "achievement" }, story_share: { period: "weekly" } } as const;
   export type ClientKind = keyof typeof CLIENT_KINDS;
   export function isClientKind(kind: string): kind is ClientKind;
   /** Лимит маршрута сигнала: на игрока, в час. */
   export const SIGNAL_LIMIT = { scope: "tasks_signal", limit: 20, windowSec: 3600 } as const;
   ```

3. **`task-rules.ts`** — только дописать, чужие строки не трогать:
   - `TaskKind` и `TASK_KIND_IDS` включают `home_screen` и `story_share` (в
     конец списка);
   - в `taskDefSchema` — правила с текстами дословно:
     - срок вида: «главный экран — только достижение» (`home_screen` и
       `period !== "achievement"`), «история — только недельное» (`story_share` и
       `period !== "weekly"`), `path: ["period"]`;
     - «у этого задания цель — 1» (`target !== 1`), `path: ["target"]`;
     - «ступень, фильтр, лимит и картинка — не у этого задания», если что-то из
       них задано, `path` — по первому полю;
     - «у достижения «главный экран» нужна категория — без неё витрина его не
       покажет», `path: ["category"]`;
   - `params` у них `null` — уже требует правило `isCheckedKind === (params !== null)`.
4. **`task-signals.service.ts`** (новый, `@Injectable`):

   ```ts
   signal(account: AccountRef, kind: ClientKind, at = new Date()): Promise<{ tasks: TaskView[] }>;
   ```

   - берёт `TasksService.view(account, at)`; задания этого вида среди видимых
     нет → `TaskNotFoundError` (404, как у `claim`);
   - каждое видимое задание вида, ещё не `done`, выполняет
     `repository.complete(accountId, { taskId, period, target }, at, at)`;
     уже выполненное в этом сроке не трогает — ответ тот же, без записи;
   - строка лога `{ module: "tasks", event: "task_signal", accountId, taskId, kind }`
     на каждое выполнение, без данных клиента;
   - возвращает `TasksService.view(account, at)` после записи.

   В `tasks.service.ts` не дописывать: он уже длиннее 500 строк.
5. **`task-signals.controller.ts`** (новый) — `@Controller("tasks")`,
   `@UseGuards(AuthGuard)`, `@Post("signals/:kind")`, `@HttpCode(200)`:
   - `kind` не из `CLIENT_KINDS` → `ValidationError` «Неизвестное действие»;
   - тело не читается;
   - `RateLimiter.consume(SIGNAL_LIMIT, accountId)`, сверх лимита —
     `RateLimitedError` «Слишком часто — попробуй позже»;
   - ответ `{ data: { tasks: TaskView[] } }`.
6. **`tasks.module.ts`** — строка контроллера и строка провайдера.
7. **Панель** — `apps/admin/src/api/tasks.ts`:
   - `KIND_TITLES`: `home_screen: "Игра на главном экране"`,
     `story_share: "История с игрой"`;
   - `CLIENT_KINDS: ReadonlyMap<string, TaskPeriod>` — тот же срок, что у сервера;
   - `withKind`: для вида из `CLIENT_KINDS` — его срок, `target: 1`,
     `params: null`, `limit: null`, `image: null`, `filter: null`, `tier: null`;
     у `story_share` ещё `NO_ACHIEVEMENT_FIELDS`;
   - `taskProblem`: `home_screen` без категории → «Достижению «главный экран»
     нужна категория — без неё витрина его не покажет».
8. **Форма** — `TasksScreen.tsx`: у видов из `CLIENT_KINDS` поле «Срок»
   выключено, поле «Цель» скрыто, «Ступень» не показывается; под «Видом цели» —
   пояснение `HELP.tasks.clientSignal` дословно: «Засчитывается по сообщению
   игры: сервер проверить действие не может. Игрок видит задание, только если
   его клиент это умеет. Награду держите небольшой.»
9. **Документы** — раздел «Документы».

## Чего не трогаем

- Клиент, адаптеры и порт площадки — T-0376.
- `tasks.service.ts`, `tasks.controller.ts`, `tasks.repository.ts` — кроме
  того, что сказано в шагах (в этих файлах — ничего).
- Миграции: не нужны (решение 5). Нужна колонка или `CHECK` — вопрос
  тимлиду, своей миграции не заводить.
- Партнёрские цели, ротация, очки заданий: очки за `story_share` — его
  `pass_points` из панели, как у любого недельного.

## Сценарий и интерфейс

Панель → «Задания» → «Новое задание» → «Вид цели»: «Игра на главном экране»
или «История с игрой». Срок встаёт сам и не меняется, цели нет, у главного
экрана нужно выбрать категорию витрины. Ошибка схемы — текст сервера под
формой, как у других заданий.

## Тесты

Первым коммитом.

- `backend/api/test/task-signals.test.ts` (схема и правила):
  - `home_screen` с `period: "achievement"`, категорией, `target: 1` годится;
    с `weekly` → «главный экран — только достижение»; без категории → «у
    достижения «главный экран» нужна категория…»;
  - `story_share` с `weekly`, `target: 1` годится; с `daily` → «история — только
    недельное»; с `tier: "easy"` или фильтром → «ступень, фильтр, лимит и
    картинка — не у этого задания»; с `target: 3` → «у этого задания цель — 1»;
  - `params` у `home_screen` → прежняя ошибка про ссылку партнёрской цели;
  - `isClientKind("story_share")` истинно, `isClientKind("channel")` ложно;
  - контроллер: `POST /tasks/signals/teleport` → 400 «Неизвестное действие»;
    21-й сигнал за час → 429.
- `backend/api/test/task-signals.integration.test.ts` (живой Postgres):
  - сигнал `home_screen` → строка `task_progress` выполнена, `claim` платит
    наградой из каталога; второй сигнал и второй `claim` ничего не доплачивают;
  - `story_share`: сигнал в понедельник → выполнено за эту неделю; сигнал в
    следующий понедельник (время — параметром) → новая строка срока, `claim`
    платит снова; два сигнала в одну неделю — одна строка;
  - два сигнала параллельно → одна строка прогресса;
  - выключенного задания вида нет → 404; задание вида есть, но не видно
    (выключено) → 404;
  - сигнал не трогает задания других видов.
- `backend/api/test/tasks.test.ts` (дописать): `TASK_KIND_IDS` содержит оба вида;
  `taskGroup` у `home_screen` — `achievement`, у `story_share` — `weekly`.
- `apps/admin/test/tasks.test.ts` (дописать): `withKind(…, "home_screen")` даёт
  `period: "achievement"`, `target: 1`, пустые `params`, `tier`, `filter`;
  `withKind(…, "story_share")` — `weekly` и пустые поля достижения;
  `taskProblem` у `home_screen` без категории — текст из шага 7.

## Аналитика

Новых событий нет. Забор шлёт `achievement_unlocked` и `task_completed` с
`kind`, как у любого задания; открытие истории клиентом — `share_offered` и
`share_completed` (T-0376). Сигнал — строкой лога `task_signal`. Метки
Prometheus с `account_id` не заводим.

## Настройки и окружение

Нет новых переменных и ключей. Лимит маршрута — константа `SIGNAL_LIMIT` в
`client-signal-rules.ts`.

## Документы

- `docs/30-configuration-map.md`, строка «Задания и достижения» (~62): в
  конец — «виды по сигналу клиента (главный экран, история, Р187) —
  `tasks/client-signal-rules.ts` → `CLIENT_KINDS`, лимит сигнала — `SIGNAL_LIMIT`».
- `docs/21-diagrams.md` не меняется: таблиц и связей задача не добавляет, а
  схемы потока заданий там нет.

## Критерии приёмки

- [ ] В панели заводятся «Игра на главном экране» (достижение с категорией) и
  «История с игрой» (недельное); неверный срок, цель, ступень и фильтр
  отклоняются сервером и формой.
- [ ] `POST /api/v1/tasks/signals/home_screen` и `/story_share` выполняют текущий
  срок задания, повтор и параллельные запросы — одна запись; награда — обычным
  забором.
- [ ] Лимит частоты маршрута — 20 в час на игрока.
- [ ] Миграций нет; `tasks.service.ts` не вырос.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные; в PR — чек-листы
  безопасности и нагрузки (`docs/15-engineering-standards.md` §7, §8).

## PR

- **Заголовок:** `feat(api): Задания по сигналу клиента — главный экран и история`
- **Метка:** `release: minor`
- **Для игроков:** нет — задания увидят после T-0376; раздела `## Для игроков` в
  описании PR нет
- **Сводка для команды** — исполнитель переносит блок в описание PR как есть и
  вписывает номер PR:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ЗАДАНИЯ ПО СИГНАЛУ КЛИЕНТА: ГЛАВНЫЙ ЭКРАН И ИСТОРИЯ**

  В панели можно завести задания «Игра на главном экране» (разовое достижение) и «История с игрой» (раз в неделю). Их засчитывает сообщение игры, а не сервер: проверить такое действие сервер не может.

  🛠 **Что внутри**

  • два новых вида цели, срок закреплён за видом
  • у «главного экрана» нужна категория витрины
  • награда — обычным «Забрать», повтор ограничен сроком и лимитом частоты
  • игроки увидят задания с клиентской частью (T-0376)

  ❓ **Нужно от команды**

  • @владелец — завести оба задания в панели с небольшой наградой, когда влита T-0376
  ```
