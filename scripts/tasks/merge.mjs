import { REVIEW_LABEL, STATUS_LABELS } from "./board.mjs";
import { BASE, diffNumstat, fetchOrigin, gh, hasCommit, isAncestor, readFileAt, taskFileNameAt, toolsMatchBase } from "./git-io.mjs";
import { SELF_MERGE_MESSAGE, parseFrontmatter, parseOwner, selfMergePathProblem, selfMergeProblems } from "./task-file.mjs";
import { matches } from "./zones.mjs";

/**
 * `pnpm task merge T-NNNN` — самостоятельный мердж задачи с пометкой
 * `merge: self` (Р176, tasks/README.md, «Самостоятельный мердж»). Проверка —
 * чистая `mergeProblems`, тесты — scripts/test/tasks-merge.test.ts; остальное
 * здесь — чтение git и GitHub и сам мердж.
 *
 * Ключевое: пометку читают из `origin/dev`, а не из ветки PR, иначе поток
 * выдал бы её себе сам. Поэтому и зоны, и `effort`, и `runner`, и `merge` в
 * ветке обязаны совпадать с `dev`: расширить зоны или снять запрет можно
 * только через тимлида.
 */

const TASK_ID_RE = /^T-\d{4}$/;
const BRANCH_RE = /^task\/(T-\d{4})$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;

/** Проверки, которые не мешают мерджу: доска (`board`) сама зависит от состояния PR. */
const IGNORED_CHECKS = new Set(["board"]);
/** Проверки, без которых PR не зелёный: пустой список проверок успехом не считается. */
const REQUIRED_CHECKS = ["check", "gate"];
const GREEN_CONCLUSIONS = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);

/**
 * Сколько пунктов чек-листа «Приёмка» (tasks/README.md) должно быть отмечено в
 * самопроверке. Одна строка «- [x] ок» самопроверкой не считается.
 */
export const SELF_CHECK_MIN_ITEMS = 7;

/** Первая строка самопроверки: `**claude-1:** самопроверка по review-pr`. */
const SELF_CHECK_TITLE_RE = /^\*\*([a-z][a-z0-9]*(?:-[a-z0-9]+)+):\*\* самопроверка по review-pr$/;
const SELF_CHECK_FORMAT = "первая строка «**<кодовое имя потока>:** самопроверка по review-pr», вторая «head: <полный SHA головы PR>», дальше чек-лист «Приёмки» с отметками «- [x]»";

/**
 * Предел правок вне `zones` и `shared` задачи из `origin/dev` (Р176, поправка
 * claude-lead-1): вынужденное следствие — одна-две строки на файл.
 */
export const OUTSIDE_LINES_PER_FILE = 5;
export const OUTSIDE_LINES_TOTAL = 20;
const OVER_LIMIT = "правки вне зон больше предела — нужна приёмка тимлида";

/**
 * Разбор вывода `git diff --numstat`: `[{ path, added, deleted }]`; двоичный
 * файл (`-\t-\t…`) — `added` и `deleted` равны `null`. Строка не по формату —
 * исключение: молча пропустить файл PR нельзя.
 */
export function parseNumstat(text) {
  return String(text)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (match === null) throw new Error(`git diff --numstat: не разобралась строка «${line}»`);
      const binary = match[1] === "-" || match[2] === "-";
      return { path: match[3], added: binary ? null : Number(match[1]), deleted: binary ? null : Number(match[2]) };
    });
}

/**
 * Причины отказа по реальному диффу PR. Каждый изменённый файл — по пути, не
 * по шаблону — обязан лежать в белом списке `merge: self` и не в чёрном; файлы
 * вне `zones` и `shared` задачи из `dev` (кроме файла самой задачи) —
 * не больше `OUTSIDE_LINES_PER_FILE` строк в каждом и `OUTSIDE_LINES_TOTAL`
 * всего, двоичные вне зон не допускаются.
 */
export function diffProblems(changes, task, fileName) {
  const own = `tasks/${fileName}`;
  const held = [...(task?.zones ?? []), ...(task?.shared ?? [])];
  const problems = [];
  let total = 0;
  for (const change of changes) {
    const pathProblem = selfMergePathProblem(change.path, fileName);
    if (pathProblem !== null) {
      problems.push(`PR меняет файл вне допустимого для merge: self: ${pathProblem}`);
      continue;
    }
    if (change.path === own || matches(change.path, held)) continue;
    if (change.added === null) {
      problems.push(`файл ${change.path} вне зон задачи двоичный: ${OVER_LIMIT}`);
      continue;
    }
    const lines = change.added + change.deleted;
    total += lines;
    if (lines > OUTSIDE_LINES_PER_FILE) problems.push(`файл ${change.path} вне зон задачи: изменено ${String(lines)} строк при пределе ${String(OUTSIDE_LINES_PER_FILE)} на файл — ${OVER_LIMIT}`);
  }
  if (total > OUTSIDE_LINES_TOTAL) problems.push(`вне зон задачи изменено ${String(total)} строк при общем пределе ${String(OUTSIDE_LINES_TOTAL)} — ${OVER_LIMIT}`);
  return problems;
}

/**
 * Поля шапки, которые поток в своей ветке менять не вправе: они решают, можно
 * ли самомердж. `shared` сюда не входит: исполнитель дописывает в него
 * вынужденные файлы (tasks/README.md, «Что исполнитель решает сам»), поэтому
 * для него проверяется только запрет на путях.
 */
const PINNED_FIELDS = ["zones", "runner", "effort", "merge"];

const show = (value) => (Array.isArray(value) ? `[${[...value].sort().join(", ")}]` : String(value));

function pinnedValue(task, field) {
  if (field === "merge") return task.merge ?? "lead";
  const value = task[field];
  return Array.isArray(value) ? [...value].sort() : value;
}

/**
 * Состояние последних прогонов проверок: по каждой паре «процесс + имя» берётся
 * самый поздний прогон — отменённый прежний (новый коммит отменяет прогон
 * старого) красным не считается.
 */
function latestChecks(rollup) {
  const latest = new Map();
  rollup.forEach((raw, index) => {
    const isStatus = raw?.__typename === "StatusContext";
    const name = String(isStatus ? raw.context : raw?.name ?? "");
    const conclusion = isStatus ? raw.state : raw?.conclusion;
    const done = isStatus ? raw.state !== "PENDING" && raw.state !== "EXPECTED" : raw?.status === "COMPLETED" && typeof conclusion === "string" && conclusion !== "";
    const startedAt = Date.parse(raw?.startedAt ?? "");
    const entry = { name, done, conclusion: conclusion ?? "", startedAt: Number.isNaN(startedAt) ? -Infinity : startedAt, index };
    const key = `${raw?.workflowName ?? ""}/${name}`;
    const current = latest.get(key);
    if (current === undefined || entry.startedAt > current.startedAt || (entry.startedAt === current.startedAt && entry.index > current.index)) latest.set(key, entry);
  });
  return [...latest.values()];
}

/** Причины, по которым проверки PR не зелёные; `board` не учитывается. */
export function checkProblems(rollup) {
  if (!Array.isArray(rollup)) return ["список проверок PR не получен"];
  const entries = latestChecks(rollup).filter((entry) => !IGNORED_CHECKS.has(entry.name));
  const problems = [];
  for (const entry of entries) {
    if (!entry.done) problems.push(`проверка ${entry.name} ещё не завершена: дождись зелёного CI`);
    else if (!GREEN_CONCLUSIONS.has(entry.conclusion)) problems.push(`проверка ${entry.name} не зелёная (${entry.conclusion})`);
  }
  for (const name of REQUIRED_CHECKS) {
    if (!entries.some((entry) => entry.name === name)) problems.push(`проверки ${name} нет в списке PR: дождись её запуска`);
  }
  return problems;
}

function parseSelfCheck(comment) {
  const lines = String(comment?.body ?? "").split(/\r?\n/);
  const title = SELF_CHECK_TITLE_RE.exec(lines[0]?.trim() ?? "");
  if (title === null) return null;
  const headLine = lines.map((line) => /^head:\s*([0-9a-fA-F]{40})\s*$/.exec(line)).find((match) => match !== null);
  const checked = lines.filter((line) => /^\s*[-*]\s+\[[xXхХ]\]/.test(line)).length;
  const unchecked = lines.filter((line) => /^\s*[-*]\s+\[ \]/.test(line)).length;
  const login = comment?.author?.login;
  return { name: title[1], head: headLine === undefined ? null : headLine[1].toLowerCase(), checked, unchecked, author: typeof login === "string" ? login : null, createdAt: comment?.createdAt };
}

/**
 * Причины, по которым самопроверка не принимается. `stream` — кодовое имя
 * потока из `owner` файла задачи в ветке, `null` — не определён. Берётся
 * последний комментарий самопроверки на текущей голове: после нового коммита
 * проверку делают заново. Репозиторий публичный, поэтому комментарий обязан
 * принадлежать автору PR (`prAuthor`) и быть написан не раньше коммита головы
 * (`headCommittedAt`): отредактированный старый комментарий с новым `head:`
 * сохраняет старую дату создания и не годится.
 */
export function selfCheckProblems(comments, headSha, stream, { prAuthor, headCommittedAt } = {}) {
  const signed = (comments ?? []).map(parseSelfCheck).filter((check) => check !== null);
  if (signed.length === 0) return [`нет комментария самопроверки в PR: ${SELF_CHECK_FORMAT}`];
  const trusted = signed.filter((check) => check.author !== null && check.author === prAuthor);
  if (trusted.length === 0) {
    const authors = [...new Set(signed.map((check) => check.author ?? "автор неизвестен"))].join(", ");
    return [`самопроверку написал ${authors}, а PR открыл ${String(prAuthor)}: самопроверка — комментарий автора PR`];
  }
  const fresh = trusted.filter((check) => Date.parse(check.createdAt) >= Date.parse(headCommittedAt));
  if (fresh.length === 0) {
    return [`самопроверка написана раньше коммита головы PR (${String(headCommittedAt)}): после последнего коммита напиши новую, отредактированный старый комментарий не годится`];
  }
  const onHead = fresh.filter((check) => check.head !== null && check.head === String(headSha).toLowerCase());
  if (onHead.length === 0) {
    const last = fresh.filter((check) => check.head !== null).at(-1);
    if (last === undefined) return [`в самопроверке нет строки «head: <полный SHA головы PR>» (40 знаков): ${SELF_CHECK_FORMAT}`];
    return [`самопроверка относится к другой голове PR (head: ${last.head}), а голова сейчас ${String(headSha)}: после новых коммитов самопроверка делается заново`];
  }
  const check = onHead.at(-1);
  const problems = [];
  if (check.unchecked > 0) problems.push(`в самопроверке не отмечено пунктов: ${String(check.unchecked)} (остались «- [ ]»)`);
  if (check.checked < SELF_CHECK_MIN_ITEMS) problems.push(`в самопроверке отмечено пунктов ${String(check.checked)}, а в чек-листе «Приёмки» их не меньше ${String(SELF_CHECK_MIN_ITEMS)}`);
  if (stream === null) problems.push("самопроверку не с чем сверить: в owner файла задачи в ветке нет потока «аккаунт / модель / уровень»");
  else if (check.name !== stream) problems.push(`самопроверку написал ${check.name}, а задачу ведёт ${stream} (owner в файле задачи): подпиши её именем своего потока`);
  return problems;
}

/**
 * Все причины отказа в самомердже; пусто — вливать можно.
 *
 * - `task` — шапка задачи из `origin/dev` (`null`, если файла там нет);
 * - `branchTask` — шапка задачи в голове PR (`null`, если файла нет);
 * - `fileName` — файл задачи `T-NNNN-slug.md`: его правка в PR допустима всегда;
 * - `pr` — `{ headRefName, state, isDraft, labels, statusCheckRollup, author, commits }`;
 * - `mergeable` — `MERGEABLE`, `CONFLICTING` или `UNKNOWN` из GitHub;
 * - `comments` — комментарии PR `[{ body, createdAt, author }]`;
 * - `headSha` — SHA головы PR, прочитанный вместе с остальным;
 * - `changes` — дифф PR от общего предка с `dev` (`parseNumstat`), `null` — не получен;
 * - `upToDate` — `origin/dev` предок головы PR (ветка не отстала);
 * - `toolsMatchDev` — `scripts/tasks` в рабочей копии совпадает с `origin/dev`.
 */
export function mergeProblems({ task, branchTask, fileName, pr, mergeable, comments, headSha, changes, upToDate, toolsMatchDev }) {
  const problems = [];
  const id = BRANCH_RE.exec(pr?.headRefName ?? "")?.[1];
  if (id === undefined) problems.push(`ветка PR «${String(pr?.headRefName)}» — не task/T-NNNN: самостоятельно вливаются только PR задач`);
  const name = id ?? "задачи";

  if (task === null || task === undefined) problems.push(`файла ${name} нет в ${BASE}: пометку merge: self читают оттуда`);
  else {
    if (task.merge !== "self") problems.push(`в ${BASE} у ${name} нет «merge: self» (там ${task.merge ?? "поля нет — это lead"}): пометка — из ${BASE}, дописать её в ветке PR нельзя`);
    else {
      const forbidden = selfMergeProblems(task, fileName);
      if (forbidden.length > 0) problems.push(`${SELF_MERGE_MESSAGE}: ${forbidden.join("; ")}`);
    }
  }

  if (branchTask === null || branchTask === undefined) problems.push(`в ветке PR нет файла задачи ${name}`);
  else {
    // Дописанный в ветке `shared` обязан лежать в белом списке: иначе запрет обошли бы через него.
    const branchForbidden = selfMergeProblems(branchTask, fileName).filter((reason) => reason.startsWith("shared:"));
    if (branchForbidden.length > 0) problems.push(`${SELF_MERGE_MESSAGE}: в ветке PR ${branchForbidden.join("; ")}`);
    if (branchTask.status !== "done") problems.push(`в ветке PR файл задачи в статусе ${String(branchTask.status)}, а нужен status: done`);
    if (task !== null && task !== undefined) {
      for (const field of PINNED_FIELDS) {
        const inBranch = pinnedValue(branchTask, field);
        const inDev = pinnedValue(task, field);
        if (show(inBranch) !== show(inDev)) problems.push(`поле ${field} в ветке PR (${show(inBranch)}) отличается от ${BASE} (${show(inDev)}): зоны и пометку меняет только тимлид в ${BASE}`);
      }
    }
  }

  if (pr?.state !== undefined && pr.state !== "OPEN") problems.push(`PR не открыт (${String(pr.state)})`);
  if (pr?.isDraft === true) problems.push("PR — черновик: черновик не вливается");
  const statuses = (pr?.labels ?? []).map((label) => label?.name).filter((label) => STATUS_LABELS.includes(label));
  if (statuses.length === 0) problems.push(`нет метки статуса «${REVIEW_LABEL}»`);
  else if (statuses.length > 1) problems.push(`меток статуса несколько (${statuses.map((label) => `«${label}»`).join(", ")}): нужна одна «${REVIEW_LABEL}»`);
  else if (statuses[0] !== REVIEW_LABEL) problems.push(`метка статуса «${statuses[0]}», а нужна «${REVIEW_LABEL}»`);

  problems.push(...checkProblems(pr?.statusCheckRollup));

  if (mergeable === "CONFLICTING") problems.push("конфликт с dev: влей dev в ветку PR, дождись CI и сделай самопроверку заново");
  else if (mergeable === "UNKNOWN") problems.push("GitHub ещё не посчитал, можно ли влить PR: повтори команду через минуту");
  else if (mergeable !== "MERGEABLE") problems.push(`GitHub не подтвердил, что PR можно влить (mergeable: ${String(mergeable)})`);

  if (upToDate !== true) problems.push(upToDate === false ? `ветка отстала от ${BASE}: влей свежий dev и дождись CI, затем напиши самопроверку заново` : `не удалось проверить, что ветка не отстала от ${BASE}`);
  if (toolsMatchDev !== true) problems.push(toolsMatchDev === false ? "scripts/tasks отличаются от dev: команда исполняется кодом рабочей копии, верни его к origin/dev (влей свежий dev, свои правки в scripts/tasks убери)" : "не удалось сверить scripts/tasks с origin/dev");

  if (!Array.isArray(changes)) problems.push(`не удалось получить дифф PR (git diff --numstat ${BASE}...голова): реальные изменения проверить нечем`);
  else problems.push(...diffProblems(changes, task, fileName));

  if (typeof headSha !== "string" || !FULL_SHA_RE.test(headSha)) {
    problems.push("не получен SHA головы PR");
    return problems;
  }
  const prAuthor = pr?.author?.login;
  const headCommit = (pr?.commits ?? []).find((commit) => String(commit?.oid).toLowerCase() === headSha.toLowerCase());
  if (typeof prAuthor !== "string") problems.push("не получен автор PR");
  if (headCommit === undefined) problems.push(`коммит головы PR (${headSha}) не найден в списке коммитов PR: самопроверку не с чем сравнить по времени`);
  if (typeof prAuthor === "string" && headCommit !== undefined) {
    const stream = branchTask === null || branchTask === undefined ? null : (parseOwner(branchTask.owner)?.account ?? null);
    problems.push(...selfCheckProblems(comments, headSha, stream, { prAuthor, headCommittedAt: headCommit.committedDate }));
  }
  return problems;
}

/** Аргументы `gh` для мерджа: merge-коммит, привязанный к проверенной голове. Другого вида команды нет. */
export function mergeArgs(number, headSha) {
  const text = String(number);
  if (!/^[1-9]\d*$/.test(text)) throw new Error(`mergeArgs: номер PR должен быть целым числом, а не ${text}`);
  if (!FULL_SHA_RE.test(String(headSha))) throw new Error("mergeArgs: нужен полный SHA головы PR (40 знаков)");
  return ["pr", "merge", text, "--merge", "--match-head-commit", String(headSha)];
}

/** Раздел «## Сводка для команды» из описания PR без заголовка; `null`, если его нет или он пуст. */
export function teamSummary(body) {
  const lines = String(body ?? "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^## Сводка для команды\s*$/.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  const text = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return text === "" ? null : text;
}

const PR_FIELDS = "number,headRefName,headRefOid,state,isDraft,labels,body,mergeable,statusCheckRollup,comments,author,commits";
const UNKNOWN_RETRY_MS = 10_000;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readJson(args, what) {
  const result = gh(args);
  if (!result.ok) throw new Error(`${what}: ${result.stderr === "" ? "gh вернул ошибку" : result.stderr}`);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${what}: ответ gh не разобрался как JSON`);
  }
}

/** Единственный открытый PR ветки задачи со всеми полями; `UNKNOWN` в `mergeable` перечитывается один раз. */
function loadPr(id) {
  const list = readJson(["pr", "list", "--head", `task/${id}`, "--state", "open", "--json", "number"], "gh pr list");
  if (!Array.isArray(list) || list.length === 0) throw new Error(`Открытого PR ветки task/${id} нет: вливать нечего.`);
  if (list.length > 1) throw new Error(`Открытых PR ветки task/${id} несколько (${list.map((pr) => `#${String(pr.number)}`).join(", ")}): оставь один.`);
  const view = () => readJson(["pr", "view", String(list[0].number), "--json", PR_FIELDS], "gh pr view");
  const first = view();
  if (first.mergeable !== "UNKNOWN") return first;
  sleep(UNKNOWN_RETRY_MS);
  return view();
}

/** Читает задачу в `origin/dev` и в голове PR: `{ task, branchTask }`, `null` — файла нет. */
function readTasks(id, headSha) {
  const fileName = taskFileNameAt(BASE, id);
  const parse = (text) => (text === null ? null : parseFrontmatter(text).data);
  const task = fileName === null ? null : parse(readFileAt(BASE, `tasks/${fileName}`));
  const name = fileName ?? "";
  const branchText = name === "" ? null : (readFileAt(headSha, `tasks/${name}`) ?? readFileAt(headSha, `tasks/archive/${name}`));
  return { fileName, task, branchTask: parse(branchText) };
}

/**
 * Команда `pnpm task merge T-NNNN`: проверяет всё, что требует Р176, и вливает
 * PR merge-коммитом с `--match-head-commit`. Отказ — код 1 и список причин.
 */
export function runMerge(positional) {
  const id = positional[0];
  if (id === undefined || !TASK_ID_RE.test(id)) throw new Error("Укажи задачу: pnpm task merge T-NNNN");
  fetchOrigin();
  const pr = loadPr(id);
  const headSha = typeof pr.headRefOid === "string" ? pr.headRefOid : "";
  if (!FULL_SHA_RE.test(headSha) || !hasCommit(headSha)) {
    throw new Error(`Голова PR #${String(pr.number)} (${headSha || "SHA не получен"}) не получена локально: повтори команду, если поток только что пушил.`);
  }
  const { fileName, task, branchTask } = readTasks(id, headSha);
  const numstat = diffNumstat(BASE, headSha);
  let changes = null;
  try {
    changes = numstat === null ? null : parseNumstat(numstat);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  }
  const problems = mergeProblems({
    task,
    branchTask,
    fileName: fileName ?? "",
    pr,
    mergeable: pr.mergeable,
    comments: pr.comments,
    headSha,
    changes,
    upToDate: isAncestor(BASE, headSha),
    toolsMatchDev: toolsMatchBase(BASE),
  });
  if (problems.length > 0) {
    console.error(`Мердж ${id} (PR #${String(pr.number)}) отклонён, причин: ${String(problems.length)}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("Исправь и повтори; вливать вручную через gh pr merge в обход этой команды нельзя (tasks/README.md, «Самостоятельный мердж»).");
    process.exit(1);
  }

  const merged = gh(mergeArgs(pr.number, headSha));
  if (!merged.ok) {
    console.error(`gh pr merge отказал (голова PR могла измениться после проверки): ${merged.stderr}`);
    process.exit(1);
  }
  console.log(`PR #${String(pr.number)} влит в dev (${id}, голова ${headSha.slice(0, 8)}).`);
  const summary = teamSummary(pr.body);
  if (summary === null) console.log("В описании PR нет раздела «Сводка для команды»: отдай сводку тимлиду вручную.");
  else console.log(`\nСводка для команды:\n\n${summary}`);
}
