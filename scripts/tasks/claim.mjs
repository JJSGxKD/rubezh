import { AHEAD_LABEL, aheadCheck, prStatus } from "./board.mjs";
import { attemptOf, attemptsMap, currentBranchOf, currentBranchTaskId, parseTaskBranch, taskBranch } from "./branch.mjs";
import { parseFrontmatter, validateTask, withRestartedHeader } from "./task-file.mjs";
import { zonesOverlap } from "./zones.mjs";

/**
 * Проверка захвата для CI (tasks/README.md, «Значки статуса»): PR ветки
 * `task/T-NNNN` проходит, только если задачу можно было взять по тем же
 * правилам, что в `pnpm task claim`. Чистая функция — состояние git и GitHub
 * приходит снаружи, тесты — scripts/test/tasks-claim.test.ts.
 */

/**
 * Сколько часов ветка с одним лишь захватом держит задачу (T-0371). Лимит
 * аккаунта сбрасывается за 5 часов, так что тишина дольше — не пауза, а уход
 * потока; сутки — запас на ночь и выходной человека, чтобы не перехватить
 * захват у того, кто просто спит.
 */
export const ABANDONED_CLAIM_HOURS = 24;

const HOUR_MS = 3_600_000;

/**
 * Брошен ли захват задачи (T-0371): ветка текущей попытки без открытого PR, в
 * которой изменён только файл самой задачи (то есть один захват), а последний
 * коммит старше `ABANDONED_CLAIM_HOURS`. Чистая функция — данные git приходят снаружи.
 * Нет файлов диффа, времени коммита или оно не разбирается — захват живой: брать
 * чужую задачу по догадке нельзя. Файл задачи в архиве (`tasks/archive/…`) — тоже файл задачи.
 */
export function isAbandonedClaim({ changedFiles, lastCommitAt, hasOpenPr, taskFileName, now }) {
  if (hasOpenPr === true || !Array.isArray(changedFiles) || typeof taskFileName !== "string") return false;
  const last = typeof lastCommitAt === "string" ? Date.parse(lastCommitAt) : Number.NaN;
  const nowMs = new Date(now).getTime();
  if (Number.isNaN(last) || Number.isNaN(nowMs)) return false;
  const name = taskFileName.replace(/^archive\//, "");
  const own = [`tasks/${name}`, `tasks/archive/${name}`];
  if (!changedFiles.every((path) => own.includes(path))) return false;
  return nowMs - last > ABANDONED_CLAIM_HOURS * HOUR_MS;
}

/**
 * Есть ли в ветке работа кроме захвата (Р195): изменён хотя бы один файл, кроме файла
 * самой задачи. Дифф не получен (`null`) — «нет»: по догадке работу не обещаем.
 */
export function hasWorkBeyondClaim(changedFiles, taskFileName) {
  if (!Array.isArray(changedFiles)) return false;
  const name = taskFileName.replace(/^archive\//, "");
  const own = [`tasks/${name}`, `tasks/archive/${name}`];
  return changedFiles.some((path) => !own.includes(path));
}

/**
 * Какие задачи из `taken` держат брошенный захват (T-0371) и когда в их ветках был последний коммит:
 * `{ abandoned: Set<id>, lastCommits: { [id]: ISO | null } }`. Смотрится ветка **текущей** попытки
 * (Р195), а открытый PR прежней попытки захват не оживляет. Список PR неизвестен (`prs === null`) —
 * считаем, что открытого PR нет: иначе без `gh` брошенный захват не отличить вовсе, а его признак
 * (в ветке один захват, суток тишины) жёсткий и сам по себе. Данные git приходят из `readBranch(task)`
 * → `{ changedFiles, lastCommitAt }`: два вызова git на ветку, веток десятки.
 */
export function findAbandonedClaims({ taken, tasks, prs, now, readBranch }) {
  const attempts = attemptsMap(tasks);
  const withPr = new Set((prs ?? []).map((pr) => currentBranchTaskId(pr.headRefName, attempts)));
  const abandoned = new Set();
  const lastCommits = {};
  for (const id of taken) {
    const task = tasks.find((candidate) => candidate.id === id);
    if (task === undefined || (task.status !== "ready" && task.status !== "in-progress")) continue;
    const { changedFiles, lastCommitAt } = readBranch(task);
    lastCommits[id] = lastCommitAt;
    if (isAbandonedClaim({ changedFiles, lastCommitAt, hasOpenPr: withPr.has(id), taskFileName: task.fileName, now })) abandoned.add(id);
  }
  return { abandoned, lastCommits };
}

/**
 * Перехват брошенного захвата (T-0371, решение 6) в текущем репозитории: локальная
 * ветка от `origin/<ветка>`, в неё влит `origin/dev`, в файле задачи новый
 * `owner`, коммит «Перехватить …» и push **без `--force`**. Ветку прежнего владельца
 * не удаляем: перехват — коммит сверху. Если он успел запушить работу, push
 * отклонится — захват ожил, и вызывающий берёт другую задачу.
 *
 * Git и файлы приходят снаружи (тесты подставляют свои): `git` бросает при ошибке,
 * `tryGit` возвращает `{ ok, stdout, stderr }`; `readFile`/`writeFile` работают по
 * имени файла задачи; `rewrite(text, owner)` возвращает `{ text, problems }` — новый
 * текст файла и ошибки проверки шапки. Ответ — `{ ok: true }` или `{ ok: false,
 * message }`; убрать локальную ветку после отказа — дело вызывающего.
 */
export function takeOverClaim({ id, fileName, owner, git, tryGit, readFile, writeFile, rewrite, branch = taskBranch(id) }) {
  const remote = `origin/${branch}`;
  const fetched = tryGit(["fetch", "origin", branch]);
  if (!fetched.ok) return { ok: false, message: `Не удалось получить ветку ${branch} с origin: ${fetched.stderr}` };
  const lastCommit = git(["log", "-1", "--format=%cI", remote]);
  const switched = tryGit(["switch", "-c", branch, remote]);
  if (!switched.ok) return { ok: false, message: `Не удалось создать локальную ветку ${branch} от ${remote}: ${switched.stderr}` };

  const merged = tryGit(["merge", "--no-edit", "origin/dev"]);
  if (!merged.ok) {
    tryGit(["merge", "--abort"]);
    return { ok: false, message: `origin/dev не влился в ${branch}: ${merged.stderr || merged.stdout}` };
  }

  const text = readFile(fileName);
  const previousOwner = /^owner:[ \t]*(.*)$/m.exec(text)?.[1]?.trim() || "неизвестен";
  const rewritten = rewrite(text, owner);
  if (rewritten.problems.length > 0) {
    return { ok: false, message: `Файл задачи после перехвата не прошёл бы проверку (owner с кавычками или пустой?):\n${rewritten.problems.join("\n")}` };
  }
  writeFile(fileName, rewritten.text);
  git(["commit", "--quiet", "-m", `chore(tasks): Перехватить ${id} — захват брошен`, "-m", `Прежний владелец: ${previousOwner}\nПоследний коммит ветки: ${lastCommit}`, "--", `tasks/${fileName}`]);

  const pushed = tryGit(["push", "origin", `HEAD:refs/heads/${branch}`]);
  if (!pushed.ok) {
    if (/rejected|non-fast-forward|fetch first/i.test(pushed.stderr)) {
      return { ok: false, message: `Захват ожил: прежний владелец успел запушить в ${branch}. Выбери другую задачу — pnpm task next.` };
    }
    return { ok: false, message: `Push не удался:\n${pushed.stderr}` };
  }
  return { ok: true };
}

/**
 * Снятие застрявшего захвата тимлидом (Р195, `pnpm task restart`) в текущем репозитории: в файле
 * задачи попытка + 1, `status: ready`, пустой `owner`, один коммит и **без push** — снятие вступает
 * в силу с влитием PR тимлида в `dev`, как любая правка реестра. Чужие ветки не трогаем: ни удаления,
 * ни push.
 *
 * - `task` — задача на базе (`origin/dev`), `reason` — причина для тела коммита;
 * - `headBranch` — рабочая ветка тимлида, не `task/*`;
 * - `git` бросает при ошибке, `tryGit` возвращает `{ ok, stdout, stderr }`; `readFile`/`writeFile` работают
 *   по имени файла задачи.
 *
 * Ответ — `{ ok: true, attempt, branch, previousBranch, previousOwner }` или `{ ok: false, message }`.
 */
export function restartClaim({ task, reason, headBranch, git, tryGit, readFile, writeFile }) {
  const refuse = (message) => ({ ok: false, message });
  const why = typeof reason === "string" ? reason.trim() : "";
  if (why === "") return refuse(`Укажи причину снятия: pnpm task restart ${task.id} --reason "…" — она попадёт в коммит`);
  if (String(headBranch).startsWith("task/")) return refuse(`Захват снимает тимлид в своей рабочей ветке, не task/*: сейчас ветка «${headBranch}»`);
  if (task.status !== "ready" && task.status !== "in-progress") {
    return refuse(`${task.id} на базе в статусе ${task.status}: попытки бывают только у задач в работе (ready или in-progress)`);
  }
  if (git(["status", "--porcelain"]) !== "") return refuse("Рабочая копия не чистая: закоммить или убери изменения, потом снимай захват.");

  const previousBranch = currentBranchOf(task);
  if (!tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${previousBranch}`]).ok) {
    return refuse(`Ветки ${previousBranch} на origin нет: снимать нечего, задача свободна.`);
  }

  const text = readFile(task.fileName);
  const written = parseFrontmatter(text);
  if (attemptOf(written.data) !== attemptOf(task)) {
    return refuse(`В рабочей копии у ${task.id} попытка ${String(attemptOf(written.data))}, а в origin/dev — ${String(attemptOf(task))}: влей origin/dev в рабочую ветку и повтори.`);
  }
  const attempt = attemptOf(task) + 1;
  const updated = withRestartedHeader(text, attempt);
  const parsed = parseFrontmatter(updated);
  const problems = [...parsed.errors, ...validateTask(task.fileName, parsed.data)];
  if (problems.length > 0) return refuse(`Файл задачи после снятия захвата не прошёл бы проверку:\n${problems.join("\n")}`);

  const shown = tryGit(["show", `origin/${previousBranch}:tasks/${task.fileName}`]);
  const previousOwner = (shown.ok && parseFrontmatter(shown.stdout).data.owner) || "неизвестен";
  const last = tryGit(["log", "-1", "--format=%cI", `origin/${previousBranch}`]);
  const lastCommit = last.ok && last.stdout !== "" ? last.stdout : "неизвестно";

  writeFile(task.fileName, updated);
  git(["commit", "--quiet", "-m", `chore(tasks): Снять захват ${task.id} — попытка ${String(attempt)}`, "-m", `Причина: ${why}\nПрежняя ветка: ${previousBranch}\nПрежний owner: ${previousOwner}\nПоследний коммит ветки: ${lastCommit}`, "--", `tasks/${task.fileName}`]);
  return { ok: true, attempt, branch: taskBranch(task.id, attempt), previousBranch, previousOwner };
}

/**
 * Что не так с `--from <ветка>` у `pnpm task claim` (Р195): текст отказа или `null`. Берётся только ветка
 * прежней попытки этой же задачи (`parseTaskBranch` даёт тот же id и меньшую попытку), и она есть на
 * `origin` (`exists`). Ветка текущей и будущей попытки, чужой задачи и не ветка задачи — отказ.
 */
export function fromBranchProblem(task, from, { exists }) {
  const parsed = parseTaskBranch(from);
  if (parsed === null || parsed.id !== task.id || parsed.attempt >= attemptOf(task) || exists !== true) {
    return `--from берёт только ветку прежней попытки ${task.id}`;
  }
  return null;
}

/**
 * Влить работу прежней попытки в ветку новой (`pnpm task claim --from`, Р195): в текущей ветке — она уже
 * создана от `base` — `git fetch` и `git merge --no-edit origin/<from>`. Конфликт **только** в файле самой
 * задачи разрешается версией с базы (`git checkout <base> -- tasks/<файл>`), и слияние коммитится;
 * конфликт в любом другом файле — `git merge --abort` и отказ со списком файлов. Убрать локальную ветку
 * после отказа — дело вызывающего. Ответ — `{ ok: true }` или `{ ok: false, message, conflicts? }`.
 */
export function mergePreviousAttempt({ from, fileName, base, tryGit }) {
  const fetched = tryGit(["fetch", "origin", from]);
  if (!fetched.ok) return { ok: false, message: `Не удалось получить ветку ${from} с origin: ${fetched.stderr}` };
  const merged = tryGit(["merge", "--no-edit", `origin/${from}`]);
  if (merged.ok) return { ok: true };

  const conflicts = tryGit(["diff", "--name-only", "--diff-filter=U"]).stdout.split("\n").filter((line) => line !== "");
  const own = [`tasks/${fileName}`, `tasks/archive/${fileName}`];
  if (conflicts.length > 0 && conflicts.every((path) => own.includes(path))) {
    if (tryGit(["checkout", base, "--", ...conflicts]).ok && tryGit(["commit", "--no-edit"]).ok) return { ok: true };
  }
  tryGit(["merge", "--abort"]);
  if (conflicts.length > 0) {
    return { ok: false, conflicts, message: `Работа ${from} конфликтует с ${base} в файлах, кроме файла задачи — влить её нельзя:\n${conflicts.map((path) => `  ${path}`).join("\n")}` };
  }
  return { ok: false, conflicts, message: `${from} не влилась в новую ветку: ${merged.stderr || merged.stdout}` };
}

const TASK_FILE_PATH_RE = /^tasks\/(?:archive\/)?(T-\d{4})-[^/]+\.md$/;

/**
 * Ветка задачи не меняет попытку (Р195, `diff-check`): у файлов задач из `changed` поле `attempt` в ветке
 * то же, что на базе. Снимает захват только тимлид, иначе поток открыл бы себе попытку сам. Файл ищется и
 * наверху, и в архиве: перенос закрытой задачи в архив попытку не меняет. `readBase(path)` и
 * `readHead(path)` возвращают текст файла или `null`; нет файла — попытка 1.
 */
export function attemptChangeProblems({ changed, readBase, readHead }) {
  const problems = [];
  const seen = new Set();
  for (const path of changed) {
    const id = TASK_FILE_PATH_RE.exec(path)?.[1];
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const alternative = path.includes("/archive/") ? path.replace("tasks/archive/", "tasks/") : path.replace("tasks/", "tasks/archive/");
    const attemptIn = (read) => {
      const text = read(path) ?? read(alternative);
      return text === null ? 1 : attemptOf(parseFrontmatter(text).data);
    };
    if (attemptIn(readBase) !== attemptIn(readHead)) problems.push(`ветка задачи меняет попытку ${id}: снимает захват только тимлид (pnpm task restart)`);
  }
  return problems;
}

/**
 * Что не так с захватом задачи `id`: список ошибок, пустой — всё в порядке.
 *
 * - `tasks` — задачи **на базе** PR (`origin/dev`), а не из ветки: иначе PR
 *   мог бы сам поставить себе нужный статус;
 * - `taken` — id задач, у которых на `origin` есть ветка текущей попытки (`takenIdsOf`): ветка прежней
 *   попытки задачу не занимает и зоны не держит (Р195);
 * - `prs` — открытые PR `{ headRefName, isDraft, labels }` или `null`, если список не получить;
 *   PR из ветки не текущей попытки — не PR задачи;
 * - `repoFiles` — файлы репозитория для пересечения зон;
 * - `claims` — время коммита захвата по id задачи (ISO), если известно;
 * - `abandoned` — id задач с брошенным захватом (`isAbandonedClaim`): ветка без работы
 *   дольше суток зон не держит, как PR на ревью;
 * - `branchAttempt` — попытка в имени ветки PR (`parseTaskBranch`); не равна попытке задачи на базе —
 *   отказ: захват снят тимлидом (Р195) или такой попытки у задачи нет. Не передана — не проверяется;
 * - `ahead` — задача взята заделом (Р178): у PR метка «задел». Тогда незакрытые
 *   зависимости допустимы, если у каждой открыт PR и сама она не задел (`aheadCheck`, в CI
 *   без требования «на ревью»: зависимость могли вернуть в работу уже после захвата);
 *   без `ahead` любая не `done` — отказ.
 *
 * Пересечение зон держит захват, только если соседняя задача взята раньше и
 * ещё в работе: ветка без PR, PR со статусом «в работе» или «доработка» (Р171,
 * Р172, docs/35-stage4-plan.md; статус — метка PR, `prStatus`). PR «на ревью»
 * и «ждёт владельца» соседей не держат, черновик тоже, если он помечен «на
 * ревью» — кто вливается вторым, перебазируется, конфликт правит тимлид.
 * Время захвата неизвестно — держит, как раньше.
 */
export function checkClaim(id, { tasks, taken, prs, repoFiles, claims = {}, ahead = false, abandoned = new Set(), branchAttempt }) {
  const task = tasks.find((candidate) => candidate.id === id);
  if (task === undefined) return [`задачи ${id} нет в реестре на базе PR: ветку ${taskBranch(id)} заводят под существующую задачу`];

  const problems = [];
  if (branchAttempt !== undefined && branchAttempt !== attemptOf(task)) problems.push(wrongAttemptMessage(task, branchAttempt));
  if (task.status !== "ready" && task.status !== "in-progress") {
    problems.push(`задача ${id} на базе в статусе ${task.status}: брать можно только ready`);
  }

  if (ahead) problems.push(...aheadCheck(task, tasks, prs, { atClaim: false }).problems);
  else {
    const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    for (const dependencyId of task.depends_on) {
      const dependency = byId.get(dependencyId);
      if (dependency === undefined) problems.push(`зависимости ${dependencyId} нет в реестре`);
      else if (dependency.status !== "done") problems.push(`зависимость ${dependencyId} не сделана (статус ${dependency.status})`);
    }
  }

  // Занята задача, у которой есть ветка или открытый PR. Сделанные и отменённые задачи, у которых ветка не удалена,
  // заняты не считаются: так же считает доска (classify). Свои зависимости — не помеха по определению.
  // PR прежней или будущей попытки — не PR задачи (Р195): `currentBranchTaskId` его отсеивает.
  const attempts = attemptsMap(tasks);
  const taskIdOf = (pr) => currentBranchTaskId(pr.headRefName, attempts);
  const withBranch = new Set([...taken, ...(prs ?? []).map(taskIdOf).filter((value) => value !== undefined)]);
  const prOf = new Map((prs ?? []).map((pr) => [taskIdOf(pr), pr]));
  const mine = claimTime(claims[id], Infinity);
  for (const other of tasks) {
    if (other.id === id || task.depends_on.includes(other.id) || !withBranch.has(other.id)) continue;
    if (other.status !== "ready" && other.status !== "in-progress") continue;
    if (waitsForReview(prOf.get(other.id)) || abandoned.has(other.id)) continue;
    if (claimTime(claims[other.id], -Infinity) > mine) continue;
    if (zonesOverlap(task.zones, other.zones, repoFiles)) {
      problems.push(`зоны пересекаются с ${other.id}: она взята раньше и ещё в работе (ветка без PR, PR «в работе» или «доработка»)`);
    }
  }
  return problems;
}

/** Отказ `claim-check` для ветки не той попытки (Р195): прежняя — захват снят, будущей у задачи нет. */
function wrongAttemptMessage(task, branchAttempt) {
  const branch = taskBranch(task.id, branchAttempt);
  const current = attemptOf(task);
  if (branchAttempt < current) {
    return `ветка ${branch} — попытка ${String(branchAttempt)}, а у ${task.id} действует попытка ${String(current)}: захват снят тимлидом (Р195). Продолжай веткой ${currentBranchOf(task)}: pnpm task claim ${task.id} --from ${branch}`;
  }
  return `ветка ${branch} — попытка ${String(branchAttempt)}, а у ${task.id} действует попытка ${String(current)}: такой попытки у задачи нет. Работай веткой ${currentBranchOf(task)}`;
}

/** PR ждёт ревью или владельца либо это задел: код в нём не пишут (или пишут поверх чужих веток), зоны свободны. */
function waitsForReview(pr) {
  if (pr === undefined) return false;
  const status = prStatus(pr);
  return status === "review" || status === "owner" || status === "ahead";
}

/**
 * Что не так с PR задела для CI (Р178, п. 5): пока у задачи есть незакрытые
 * зависимости (не `done` на базе), её PR обязан быть черновиком с меткой
 * «задел» — иначе его можно снять с черновика и влить раньше зависимостей.
 * Все зависимости `done` — PR любого вида. `pr` — PR ветки задачи или
 * `undefined`, если среди открытых его не нашли; `tasks` — реестр с базы.
 */
export function checkAheadPr(pr, task, tasks) {
  const done = new Set(tasks.filter((candidate) => candidate.status === "done").map((candidate) => candidate.id));
  const unclosed = task.depends_on.filter((id) => !done.has(id));
  if (unclosed.length === 0) return [];
  const list = unclosed.join(", ");
  if (pr === undefined) {
    return [`не найден открытый PR ветки задачи, а зависимости не влиты (${list}): без PR с меткой «${AHEAD_LABEL}» проверить задел нечем`];
  }
  const problems = [];
  if (pr.isDraft !== true) {
    problems.push(`PR — не черновик, а зависимости не влиты (${list}): пока они не влиты, PR остаётся черновиком с меткой «${AHEAD_LABEL}»`);
  }
  if (!(pr.labels ?? []).some((label) => label?.name === AHEAD_LABEL)) {
    problems.push(`у PR нет метки «${AHEAD_LABEL}», а зависимости не влиты (${list}): задачу с невлитыми зависимостями берут заделом (pnpm task claim --ahead)`);
  }
  return problems;
}

/**
 * Незакрытые зависимости задачи `id` по реестру **базы** (`tasks` — задачи с `origin/dev`),
 * в порядке `depends_on`. Список зависимостей берётся с базы, как в `claim-check`: иначе PR
 * дописал бы себе в ветке чужую задачу, `diff-check` вычел бы её файлы, а `claim-check` не
 * потребовал бы черновика задела. Задачи нет на базе — вычитать нечего.
 */
export function unclosedDependenciesOnBase(id, tasks) {
  const task = tasks.find((candidate) => candidate.id === id);
  if (task === undefined) return [];
  return task.depends_on.filter((dependencyId) => tasks.find((candidate) => candidate.id === dependencyId)?.status !== "done");
}

/**
 * Дифф задела без файлов его незакрытых зависимостей (Р178, п. 6): их меняют
 * PR самих зависимостей, и зоны проверяются там. `dependencyFiles` — файлы,
 * изменённые ветками зависимостей относительно базы.
 */
export function withoutDependencyFiles(changed, dependencyFiles) {
  const own = new Set(dependencyFiles);
  return changed.filter((path) => !own.has(path));
}

/** Время захвата в миллисекундах; нет или не разобрать — `fallback`. */
function claimTime(iso, fallback) {
  const ms = iso === undefined || iso === null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(ms) ? fallback : ms;
}
