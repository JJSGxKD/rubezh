---
id: T-0088
title: Внешняя проверка прода без ложных тревог и без записи развёртывания на каждый прогон
epic: E3
priority: P2
status: in-progress
owner: claude-5 / sonnet-5.5 / high
author: claude-lead2-8
size: M
depends_on: []
zones:
  - .github/workflows/uptime.yml
  - scripts/ops/uptime-check.mjs
  - scripts/test/uptime-check.test.ts
  - scripts/test/uptime-workflow.test.ts
shared:
  - docs/09-ci-cd.md
  - docs/20-env-and-ports.md
runner: any
executor: sonnet-5.5
effort: high
release: patch
design: null
batch: 1
---

# T-0088. Внешняя проверка прода без ложных тревог и записей развёртывания

[![статус](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/JJSGxKD/rubezh/task-board/status/T-0088.json)](README.md#значки-статуса)

## Зачем

Внешняя проверка `uptime.yml` (T-0034) раз в 5 минут пишет в чат команды при
смене состояния. Две беды из приёмки PR #259 (11.10):

1. Джоб стоит в окружении `telegram` ради токена бота, и GitHub заводит запись
   развёртывания на каждый прогон: 288 в сутки, история окружения тонет.
2. «Прежнее состояние» берётся из итога последнего завершённого прогона.
   Отменённый по таймауту прогон состояния не несёт, и следующий шлёт второе «🔴»
   при продолжающемся падении. Прогон, упавший сам (checkout, setup-node),
   заканчивается `failure`, и следующий принимает его за «прод лежал» и шлёт
   ложное «🟢 снова доступен».

После задачи записей развёртывания нет, а прежнее состояние берётся из ближайшего
прогона, который действительно сказал что-то про прод.

## Решения

- **`environment: { name: telegram, deployment: false }`.** Секрет бота остаётся
  в окружении `telegram`, открытом только веткам `main` и `dev`
  (`team-summary.yml:28-33`). Секрет на уровне репозитория отклонён: он стал бы
  виден каждой ветке.
- **Прод упал ≠ прогон упал.** Результат проверки скрипт отдаёт не кодом выхода,
  а выводом шага `state=up|down`; отдельный шаг «Прод недоступен» падает, только
  если `state == down`. Упал он — прод лежит; упало что-то другое — прогон
  про прод не сказал ничего.
- **Правило (`stateOfRun`):** итог `success` → `up`; итог `failure` и упал шаг
  «Прод недоступен» → `down`; всё остальное (`cancelled`, `timed_out`, `failure`
  по другому шагу, старый прогон без нового шага) → ответа нет, смотрим более
  старый прогон. Глубина — 10 завершённых прогонов (около 50 минут), бюджет
  времени на обход — 60 с (у джоба `timeout-minutes: 3`). Нет ответа нигде — `null`.
- Шаги прогона нужны только при итоге `failure`: `gh run view` зовём только тогда.
- Прогоны до этой правки (`failure` без шага «Прод недоступен») ответа не дают:
  худший случай — один лишний «🔴», если прод лежал в момент выката правки.

## Как сейчас

- `.github/workflows/uptime.yml`: строка 26 `environment: telegram`; единственный
  шаг после checkout и setup-node — «Проверить прод» (35-41), запускает
  `node scripts/ops/uptime-check.mjs`; права `contents: read`, `actions: read`.
- `scripts/ops/uptime-check.mjs`: `previousState()` (73-87) берёт
  `gh run list --workflow uptime.yml --status completed --limit 1 --json
  conclusion` (`success` → `up`, `failure` → `down`, иначе `null`);
  `decide(previous, results)` (56-71) не меняется; `main()` (89-118) заканчивается
  `if (state === "down") process.exit(1)` (117).
- `scripts/test/uptime-check.test.ts`: `describe("checkUrl")`, `describe("decide")`;
  импорт `checkUrl, decide` с `@ts-expect-error` (утилита на чистом JS).
- `docs/09-ci-cd.md:148` — строка `uptime.yml` в таблице workflow;
  `docs/20-env-and-ports.md:648` — «Внешняя проверка — `uptime.yml`…».
- Репозиторий публичный: токены и адреса чатов в файлы не пишем.

## Шаги по порядку

1. **Тесты первым коммитом** (раздел «Тесты»), красные до кода.
2. **`scripts/ops/uptime-check.mjs`:** добавить `import { appendFileSync } from
   "node:fs";`, рядом с `ATTEMPTS` — константы и чистую функцию (экспорт):

   ```js
   /** Имена шагов uptime.yml: по ним следующий прогон отличает «прод лежит» от «упал сам прогон». */
   export const CHECK_STEP = "Проверить прод";
   export const DOWN_STEP = "Прод недоступен";

   /** Состояние по итогу завершённого прогона: "up" | "down" | null — про прод прогон ничего не сказал. */
   export function stateOfRun(conclusion, steps) {
     if (conclusion === "success") return "up";
     if (conclusion !== "failure") return null;
     return steps.some((step) => step.name === DOWN_STEP && step.conclusion === "failure") ? "down" : null;
   }
   ```

   `previousState` переписать (экспорт; `runGh(args)` возвращает разобранный JSON
   и подставляется в тестах):

   ```js
   const RUNS_SCANNED = 10;
   const PREVIOUS_BUDGET_MS = 60_000;

   function ghJson(args) {
     return JSON.parse(execFileSync("gh", args, { encoding: "utf8", timeout: GH_TIMEOUT_MS }));
   }

   /** Прежнее состояние: ближайший прогон, давший ответ; отменённые и упавшие сами пропускаются. */
   export function previousState(runGh = ghJson, { now = Date.now, budgetMs = PREVIOUS_BUDGET_MS } = {}) {
     const startedAt = now();
     try {
       const runs = runGh(["run", "list", "--workflow", "uptime.yml", "--status", "completed", "--limit", String(RUNS_SCANNED), "--json", "databaseId,conclusion"]);
       for (const run of runs) {
         const jobs = run.conclusion === "failure" ? (runGh(["run", "view", String(run.databaseId), "--json", "jobs"]).jobs ?? []) : [];
         const state = stateOfRun(run.conclusion, jobs.flatMap((job) => job.steps ?? []));
         if (state !== null) return state;
         // Долгий обход не должен съесть саму проверку.
         if (now() - startedAt > budgetMs) break;
       }
     } catch (error) {
       console.error(`прежнее состояние не получено: ${error instanceof Error ? error.message : error}`);
     }
     return null;
   }

   /** Вывод шага для workflow: по нему срабатывает шаг «Прод недоступен». */
   export function writeStateOutput(state, file) {
     appendFileSync(file, `state=${state}\n`);
   }
   ```

   В `main()` последние строки (комментарий и `if (state === "down")
   process.exit(1);`) заменить на

   ```js
   // Результат — выводом шага, а не кодом выхода: падает следующий шаг workflow,
   // и по нему следующий прогон отличает «прод лежит» от «упал сам прогон».
   // Без workflow (ручной запуск) вывода нет — тогда код выхода, как раньше.
   const outputFile = process.env.GITHUB_OUTPUT ?? "";
   if (outputFile !== "") writeStateOutput(state, outputFile);
   else if (state === "down") process.exit(1);
   ```

   В комментарии вверху файла фразу «прежнее состояние — итог прошлого
   завершённого прогона этого же workflow» заменить на «прежнее состояние — итог
   ближайшего прогона, давшего ответ про прод (`stateOfRun`)».
3. **`.github/workflows/uptime.yml`:**
   - шапка: «прежнее состояние — итог прошлого завершённого прогона» →
     «прежнее состояние — итог ближайшего прогона, давшего ответ
     (`scripts/ops/uptime-check.mjs`)»;
   - вместо `environment: telegram`:

     ```yaml
         # Секрет бота — в окружении `telegram`; `deployment: false` — без записи
         # развёртывания на каждый прогон (288 в сутки тонули бы в истории).
         environment:
           name: telegram
           deployment: false
     ```

   - шаг «Проверить прод» получает `id: check` строкой сразу под `name`; после
     него — новый шаг, имя ровно как `DOWN_STEP`:

     ```yaml
           - name: Прод недоступен
             if: steps.check.outputs.state == 'down'
             run: exit 1
     ```

     `continue-on-error` в джобе не появляется.
4. **Документы.** `docs/09-ci-cd.md`, строка `uptime.yml`: после «…«🟢 снова
   доступен»» добавить: «Прежнее состояние — итог ближайшего прогона, давшего
   ответ про прод: отменённые и упавшие сами (checkout, setup) пропускаются;
   «прод лежит» — упавший шаг «Прод недоступен». Джоб читает секрет бота из
   окружения `telegram` без записи развёртывания (`deployment: false`).»
   `docs/20-env-and-ports.md`, строка 648: дописать «Падение прода отличается от
   падения самого прогона шагом «Прод недоступен» (`09-ci-cd.md`, таблица
   workflow).»

## Чего не трогаем

- `decide`, `checkUrl`, `attempt`, тексты «🔴»/«🟢», расписание, `concurrency`.
- `team-summary.yml`: тот же `environment: telegram`, но прогонов мало.
- Секреты и переменные Actions (`TEAM_TELEGRAM_BOT_TOKEN`, `TEAM_TELEGRAM_CHAT`,
  `UPTIME_URLS`): менять их исполнителю нельзя.
- Хук 5xx в `http-app.ts` и его проверка: T-0086.

## Сценарий и интерфейс

Для команды в чате: прод упал — одно «🔴»; пока лежит — тишина, даже если один
из прогонов отменили; поднялся — одно «🟢». Упавший checkout или отменённый
прогон не дают ни повтора «🔴», ни ложного «🟢». В Actions упавший из-за прода
прогон виден по красному шагу «Прод недоступен».

## Тесты

Первым коммитом. Workflow читается текстом (YAML-парсера в зависимостях нет),
по образцу `scripts/test/task-board-workflow.test.ts` (CRLF → LF).

`scripts/test/uptime-check.test.ts`: расширить импорт (`stateOfRun`,
`previousState`, `writeStateOutput`, `CHECK_STEP`, `DOWN_STEP`); помощник
`gh(runs)` — поддельный `runGh`: для `run list` отдаёт `{ databaseId,
conclusion }`, для `run view` — `{ jobs: [{ steps }] }` нужного прогона.

- `stateOfRun("success", [])` → `"up"`;
- `stateOfRun("failure", [CHECK_STEP success, DOWN_STEP failure])` → `"down"`;
- `stateOfRun("failure", [шаг checkout failure])` → `null`;
- `stateOfRun("failure", [CHECK_STEP failure])` → `null` (упал сам скрипт или
  старый прогон без нового шага);
- `stateOfRun("cancelled", …)` и `stateOfRun("timed_out", …)` → `null`;
- `previousState`: нет прогонов → `null`; `[success]` → `"up"`;
  `[cancelled, прогон с упавшим DOWN_STEP]` → `"down"`, и
  `decide("down", прод упал).message === null` (нет второго «🔴»);
  `[failure по checkout, success]` → `"up"`, и `decide("up", прод в порядке).message
  === null` (нет ложного «🟢»); `[cancelled, failure по CHECK_STEP, cancelled]` → `null`;
- `run list` вызван с `--limit 10` и `--json databaseId,conclusion`, `run view` —
  только для прогонов с итогом `failure` (счёт вызовов);
- поддельные часы (`now` прибавляет 70 с на вызов), список из упавших по другим
  шагам прогонов и `success` в конце: обход останавливается после первого же
  прогона без ответа, `run view` вызван один раз, результат `null`;
- `runGh` бросает → `null`, ошибка в `console.error` (шпион);
- `writeStateOutput("down", f)`, затем `("up", f)` во временном файле
  (`mkdtemp` в `os.tmpdir()`, удалить в `afterEach`) → `state=down\nstate=up\n`.

`scripts/test/uptime-workflow.test.ts` (новый):

- текст содержит `/^ {4}environment:\n {6}name: telegram\n {6}deployment: false$/m`;
- `- name: ${CHECK_STEP}` и строкой ниже `id: check`;
- шаг `DOWN_STEP` стоит после шага проверки, с
  `if: steps.check.outputs.state == 'down'` и `run: exit 1`;
- `continue-on-error` в файле нет (иначе шаг не ронял бы прогон).

## Аналитика

Нет: внешняя проверка из Actions событий игрока не пишет, сообщения в чат те же.

## Настройки и окружение

Нет: новых переменных, секретов и ключей каталога нет.

## Документы

- `docs/09-ci-cd.md` — строка `uptime.yml` (шаг 4).
- `docs/20-env-and-ports.md` — абзац про внешнюю проверку (шаг 4).

## Вопросы к тимлиду

- Подтверждено `claude-lead-1` 13.10.2026: GitHub принимает `deployment: false` в
  `environment` джоба. Синтаксис известен по документации GitHub, в этом
  репозитории он не применялся, и проверить его можно только на настоящем
  прогоне (окружение `telegram` открыто веткам `main` и `dev`). Если ключ не
  принимается, файл невалиден и проверка не стартует: поэтому проверка после
  мерджа в `dev` обязательна (последний пункт приёмки). Запасной путь — секрет
  бота на уровне репозитория и убрать `environment` (делает человек, `@участник1`).
- Подтверждено `claude-lead-1` 13.10.2026: глубина 10 прогонов и бюджет 60 секунд.

## Критерии приёмки

- [ ] Тесты из раздела «Тесты» были красными до кода и зелёные после.
- [ ] Результат уходит выводом шага `state`; в workflow код выхода при падении
  прода не используется, ручной запуск без `GITHUB_OUTPUT` по-прежнему
  завершается кодом 1.
- [ ] `uptime.yml`: `deployment: false`, шаги «Проверить прод» (`id: check`) и
  «Прод недоступен» с именами, совпадающими с `CHECK_STEP` и `DOWN_STEP`.
- [ ] `decide` и тексты сообщений не изменены; дифф только в зонах и двух
  строках документов.
- [ ] Гейт (`CLAUDE.md`) и `pnpm docs:check` зелёные.
- [ ] После мерджа в `dev` тимлид запускает `gh workflow run uptime.yml --ref dev`
  и проверяет, что прогон прошёл, а новой записи развёртывания нет
  (`gh api "repos/{owner}/{repo}/deployments?environment=telegram&per_page=3"`).

## PR

- **Заголовок:** `fix(ci): Внешняя проверка без ложных тревог`
- **Метка:** `release: patch`
- **Для игроков:** нет
- **Сводка для команды** — перенести в PR как есть, вписав номер:

  ```
  📋 **СВОДКА: В DEV ВЛИТ PR #<номер> — ВНЕШНЯЯ ПРОВЕРКА ПРОДА БЕЗ ЛОЖНЫХ ТРЕВОГ**

  Проверка прода раз в 5 минут больше не шлёт повторное «🔴» после отменённого прогона и ложное «🟢» после прогона, упавшего сам. Записи развёртывания на каждый прогон больше не заводятся.

  🛠 **Внешняя проверка**

  • прежнее состояние берётся из ближайшего прогона с ответом про прод
  • прод лежит — красный шаг «Прод недоступен», остальные падения прогона состояние не меняют
  • окружение telegram подключено без записи развёртывания

  ❓ **Нужно от команды**

  • @участник1 — после мерджа проверить, что новых записей в Environments → telegram нет
  ```
