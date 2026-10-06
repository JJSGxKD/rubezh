import { BADGE_CACHE_SECONDS } from "./board.mjs";
import { REPOSITORY } from "./task-file.mjs";

/**
 * Страница доски — README.md ветки task-board и счётчик свободных задач
 * (tasks/README.md, «Значки статуса»). Чистые функции: данные приходят
 * снаружи, тесты — scripts/test/tasks-board-page.test.ts.
 */

/** Очки — сумма размеров сделанных задач. Наглядность, а не формула выплат: доли участников — docs/11-revenue-split.md. */
export const SIZE_POINTS = { S: 1, M: 2 };

const UNKNOWN_OWNER = "не указан";
const NO_PR_LABEL = "без PR задачи";
const GITHUB = `https://github.com/${REPOSITORY}`;
const TASKS_URL = `${GITHUB}/blob/dev/tasks`;

function plural(count, forms) {
  const last = count % 10;
  const lastTwo = count % 100;
  if (lastTwo >= 11 && lastTwo <= 14) return forms[2];
  if (last === 1) return forms[0];
  return last >= 2 && last <= 4 ? forms[1] : forms[2];
}

/** Значок «можно брать · N задач»: нет свободных — светло-серый. */
export function freeBadge(count) {
  const message = count === 0 ? "нет задач" : `${String(count)} ${plural(count, ["задача", "задачи", "задач"])}`;
  return { schemaVersion: 1, label: "можно брать", message, color: count === 0 ? "lightgrey" : "brightgreen", cacheSeconds: BADGE_CACHE_SECONDS };
}

/**
 * Кто и когда сделал каждую сделанную задачу: `Map<id, { login, pr, mergedAt, owner, points }>`.
 * Автор — автор самого позднего влитого PR ветки `task/<id>`: его ставит GitHub, а поле `owner` в файле
 * может вписать кто угодно. Нет PR или список не получен (`null`) — `login`, `pr`, `mergedAt` равны `null`.
 */
export function taskCredits(doneEntries, mergedPrs) {
  const credits = new Map();
  for (const { task } of doneEntries) {
    const latest = (mergedPrs ?? [])
      .filter((pr) => pr.headRefName === `task/${task.id}`)
      .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))[0];
    credits.set(task.id, {
      login: latest?.login ?? null,
      pr: latest?.number ?? null,
      mergedAt: latest?.mergedAt ?? null,
      owner: task.owner === "" ? UNKNOWN_OWNER : task.owner,
      points: SIZE_POINTS[task.size],
    });
  }
  return credits;
}

function byScore(label) {
  return (a, b) => b.points - a.points || b.tasks - a.tasks || compareLabels(a[label], b[label]);
}

/** Люди: без автора PR — всегда последними, как бы много очков у них ни было; остальные — по очкам. */
function byPerson(a, b) {
  if ((a.login === null) !== (b.login === null)) return a.login === null ? 1 : -1;
  return byScore("login")(a, b);
}

/** По алфавиту, пустое (`null`) — в конец. */
function compareLabels(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

/** Люди по убыванию очков, затем задач, затем логина (`null` — без автора — последним), внутри — исполнители по `owner`. */
export function contributions(credits) {
  const people = new Map();
  for (const credit of credits.values()) {
    const person = people.get(credit.login) ?? { login: credit.login, tasks: 0, points: 0, lastMergedAt: null, byOwner: new Map() };
    person.tasks += 1;
    person.points += credit.points;
    if (credit.mergedAt !== null && (person.lastMergedAt === null || credit.mergedAt > person.lastMergedAt)) person.lastMergedAt = credit.mergedAt;
    const executor = person.byOwner.get(credit.owner) ?? { owner: credit.owner, tasks: 0, points: 0 };
    executor.tasks += 1;
    executor.points += credit.points;
    person.byOwner.set(credit.owner, executor);
    people.set(credit.login, person);
  }
  return [...people.values()]
    .map(({ byOwner, ...person }) => ({ ...person, executors: [...byOwner.values()].sort(byScore("owner")) }))
    .sort(byPerson);
}

const pad = (value) => String(value).padStart(2, "0");

function formatDate(iso) {
  const date = new Date(iso);
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${String(date.getUTCFullYear())}`;
}

function formatDateTime(date) {
  return `${formatDate(date.toISOString())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

const taskLink = (task) => `[${task.id}. ${task.title.replaceAll("|", "\\|")}](${TASKS_URL}/${task.fileName})`;
const prLink = (number) => `[#${String(number)}](${GITHUB}/pull/${String(number)})`;

function table(headers, rows) {
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function section(title, count, headers, rows) {
  return `## ${title} — ${String(count)}\n\n${rows.length === 0 ? "Пусто." : table(headers, rows)}`;
}

function contributionSection(credits, people, githubAvailable) {
  const intro = "Очки — сумма размеров сделанных задач: S — 1, M — 2. Это наглядность, а не формула выплат: доли участников — `docs/11-revenue-split.md`.";
  if (!githubAvailable) return `## Вклад\n\n${intro}\n\nНет данных GitHub: список влитых PR не получен.`;
  if (people.length === 0) return `## Вклад\n\n${intro}\n\nПусто.`;
  const person = (item) => (item.login === null ? NO_PR_LABEL : `[@${item.login}](https://github.com/${item.login})`);
  const plain = (item) => (item.login === null ? NO_PR_LABEL : `@${item.login}`);
  const totals = table(
    ["GitHub", "Задач", "Очков", "Последний мердж"],
    people.map((item) => [person(item), String(item.tasks), String(item.points), item.lastMergedAt === null ? "—" : formatDate(item.lastMergedAt)]),
  );
  const executors = table(
    ["GitHub", "Исполнитель", "Задач", "Очков"],
    people.flatMap((item) => item.executors.map((executor) => [plain(item), executor.owner, String(executor.tasks), String(executor.points)])),
  );
  return `## Вклад\n\n${intro}\n\n${totals}\n\n${executors}`;
}

/**
 * Текст страницы доски. `board` — результат `classify`; `owners` — `Map<id, owner>` задач «в работе»
 * и «на ревью»; `credits` и `people` — из `taskCredits` и `contributions`; `now` — `Date`.
 * Даты — UTC. Только логины GitHub: ни почт, ни юзернеймов Telegram, ни имён.
 */
export function renderBoardPage({ board, owners, credits, people, githubAvailable, now }) {
  const done = [...board.done].sort((a, b) => b.task.id.localeCompare(a.task.id));
  const sections = [
    section(
      "Можно брать",
      board.free.length,
      ["Задача", "Приоритет", "Размер", "Исполнитель", "Эпик"],
      board.free.map(({ task }) => [taskLink(task), task.priority, task.size, `${task.executor} · ${task.effort}`, task.epic]),
    ),
    section("В работе", board.inProgress.length, ["Задача", "Взял"], board.inProgress.map(({ task }) => [taskLink(task), owners.get(task.id) || "неизвестно"])),
    section("На ревью", board.review.length, ["Задача", "PR"], board.review.map(({ task, pr }) => [taskLink(task), prLink(pr)])),
    section("Ждут", board.blocked.length, ["Задача", "Чего ждёт"], board.blocked.map(({ task, reason }) => [taskLink(task), reason])),
    section(
      "Готово",
      done.length,
      ["Задача", "Сделал", "PR"],
      done.map(({ task }) => {
        const credit = credits.get(task.id);
        const owner = credit?.owner ?? (task.owner === "" ? UNKNOWN_OWNER : task.owner);
        return [taskLink(task), credit?.login ? `@${credit.login} · ${owner}` : owner, credit?.pr ? prLink(credit.pr) : "—"];
      }),
    ),
    contributionSection(credits, people, githubAvailable),
  ];
  const intro = `Обновлено ${formatDateTime(now)} UTC. Страницу пересчитывает workflow \`task-board.yml\` после захвата, PR и мерджа — руками не править. Как брать задачу — [tasks/README.md](${TASKS_URL}/README.md#как-взять-задачу).`;
  return `# Доска задач\n\n${intro}\n\n${sections.join("\n\n")}\n`;
}
