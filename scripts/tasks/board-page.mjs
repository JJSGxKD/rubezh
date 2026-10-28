import { PERIOD_TITLES, SIZE_POINTS } from "./contribution.mjs";
import { BADGE_CACHE_SECONDS, accountStreams, boardCounters, flowPrompt, knownAccounts, moscowDay, streamLabel, streamRows, streamsSummary } from "./board.mjs";
import { REPOSITORY } from "./task-file.mjs";

/**
 * Страница доски — README.md ветки task-board и счётчик свободных задач
 * (tasks/README.md, «Значки статуса»). Чистые функции: данные приходят
 * снаружи, тесты — scripts/test/tasks-board-page.test.ts.
 */

export { SIZE_POINTS };

const UNKNOWN_OWNER = "не указан";
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

const pad = (value) => String(value).padStart(2, "0");

export { moscowDay };

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Дата по Москве: «24.10.2026». Сдвиг на три часа, затем UTC-поля сдвинутой даты. */
function formatDate(iso) {
  const date = new Date(new Date(iso).getTime() + MOSCOW_OFFSET_MS);
  return `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.${String(date.getUTCFullYear())}`;
}

/** Дата и время по Москве: «24.10.2026 05:40». */
export function formatMoscow(date) {
  const shifted = new Date(date.getTime() + MOSCOW_OFFSET_MS);
  return `${formatDate(date.toISOString())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`;
}

const taskLink = (task) => `[${task.id}. ${task.title.replaceAll("|", "\\|")}](${TASKS_URL}/${task.path ?? task.fileName})`;
const prLink = (number) => `[#${String(number)}](${GITHUB}/pull/${String(number)})`;

function table(headers, rows) {
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function section(title, count, headers, rows) {
  return `## ${title} — ${String(count)}\n\n${rows.length === 0 ? "Пусто." : table(headers, rows)}`;
}

/**
 * Раздел «Потоки сейчас» (tasks/README.md, «Автопоток»): какие потоки — модель
 * и уровень — запускать и что ждёт. Заголовок без числа: на него ведёт ссылка
 * из epics.md (`#потоки-сейчас`). Строки те же, что у `pnpm task streams`.
 */
function streamsSection(board, credits, at) {
  const { streams } = streamsSummary(board);
  const { now, queue } = streamRows(streams);
  const link = (item) => {
    const text = `[${item.id}](${TASKS_URL}/${item.path ?? item.fileName})`;
    return item.batch === null ? text : `${text} (п.${String(item.batch)})`;
  };
  const intro =
    "Какие потоки запускать в автопоток (`tasks/README.md`, «Автопоток»): доработка раньше новых задач, п.N — пачка выпуска. Строки `local` и `owner` — задачи только для потоков на машине с Docker и на машине владельца. То же даёт `pnpm task streams`.";
  const nowRows = now.map((row) => [row.label, String(row.free), String(row.rework), row.shown.map(link).join(", ") + (row.more > 0 ? ` +${String(row.more)}` : "")]);
  const queueRows = queue.map((row) => [row.label, String(row.count), row.batch === null ? "без пачки" : String(row.batch)]);
  const nowPart = nowRows.length === 0 ? "Нечего: ни свободных задач, ни доработки." : table(["Поток", "Свободно", "Доработка", "Ближайшие задачи"], nowRows);
  const queuePart = queueRows.length === 0 ? "Ничего нет." : table(["Поток", "Ждут", "Ближайшая пачка"], queueRows);
  return `## Потоки сейчас\n\n${intro}\n\n### Запускать сейчас\n\n${nowPart}\n\n### На очереди\n\n${queuePart}\n\n${accountsPart(board, streams, credits, at)}`;
}

/**
 * «Запуск по аккаунтам»: на каждый известный аккаунт — свёрнутый список готовых промтов
 * только для потоков, которые на нём не идут. Номер аккаунта уже внутри промта.
 */
function accountsPart(board, streams, credits, now) {
  const heading = "### Запуск по аккаунтам";
  const accounts = knownAccounts(board, credits, now);
  if (accounts.length === 0) {
    return `${heading}\n\nИзвестных аккаунтов нет: промты для своего — \`pnpm task streams --account claude-N\`.`;
  }
  const blocks = accounts.map((account) => {
    const toRun = accountStreams(account, board, streams);
    if (toRun.length === 0) return `${account} — всё нужное уже работает`;
    const summary = `${account} — запустить ${String(toRun.length)}: ${toRun.map(streamLabel).join(", ")}`;
    const prompts = toRun.map((stream) => `\`\`\`\n${flowPrompt({ account, executor: stream.executor, effort: stream.effort, runner: stream.runner })}\n\`\`\``).join("\n\n");
    return `<details>\n<summary>${summary}</summary>\n\n${prompts}\n\n</details>`;
  });
  return `${heading}\n\nГотовые промты с номером аккаунта; потоки, которые на нём уже идут, не предлагаются.\n\n${blocks.join("\n\n")}`;
}

/** Строка счётчиков под заголовком; пачки нет — последнего пункта нет. */
function countersLine(counters) {
  const parts = [
    `Свободно ${String(counters.free)}`,
    `в работе ${String(counters.inProgress)}`,
    `на ревью ${String(counters.review)}`,
    `на доработке ${String(counters.rework)}`,
    `ждут тимлида ${String(counters.waitLead)}`,
    `ждут владельца ${String(counters.waitOwner)}`,
    `влито сегодня ${String(counters.mergedToday)}`,
  ];
  if (counters.batch !== null) parts.push(`пачка ${String(counters.batch.number)}: осталось ${String(counters.batch.left)}`);
  return parts.join(" · ");
}

/** «Ждут владельца»: свободные `owner` и `human`, а также PR с меткой «ждёт владельца». */
function ownerSection(board) {
  const rows = [
    ...[...board.review, ...board.rework]
      .filter((entry) => entry.waiting?.who === "owner")
      .map(({ task, pr, waiting }) => [`${taskLink(task)} · ${prLink(pr)}`, waiting.why]),
    ...board.free
      .filter(({ task }) => task.runner === "owner" || task.runner === "human")
      .map(({ task }) => [taskLink(task), task.runner === "owner" ? "машина владельца" : "нужен человек"]),
  ];
  return section("Ждут владельца", rows.length, ["Что", "Почему"], rows);
}

/** «Ждут тимлида»: черновики с вопросами и PR к приёмке; красный CI ждёт исполнителя и сюда не входит. */
function leadSection(board) {
  const entries = board.review.filter((entry) => entry.waiting?.who === "lead");
  return section(
    "Ждут тимлида",
    entries.length,
    ["PR", "Задача", "Почему"],
    entries.map(({ task, pr, waiting }) => [prLink(pr), taskLink(task), waiting.why]),
  );
}

const WAITING_WHO = { executor: "исполнителя", lead: "тимлида", owner: "владельца" };

/** «Чего ждёт»: владельца — без причины, остальные — «кого · почему»; у «В работе» ожидания нет — ждёт исполнителя. */
function waitingText(waiting) {
  if (waiting === undefined) return WAITING_WHO.executor;
  return waiting.who === "owner" ? WAITING_WHO.owner : `${WAITING_WHO[waiting.who]} · ${waiting.why}`;
}

/** «Чего ждёт» задел (Р178): созревший ждёт потока, остальной — влития зависимостей. */
function aheadWaitingText(entry) {
  return entry.ripe ? `${WAITING_WHO.executor} · задел созрел` : `зависимостей: ${(entry.waitingFor ?? []).join(", ")}`;
}

/** «Висит»: меньше суток — «сегодня», иначе «N дн», от трёх суток с «⚠️ »; даты нет — «—». */
function hangingText(days) {
  if (days === null || days === undefined) return "—";
  if (days < 1) return "сегодня";
  return `${days >= 3 ? "⚠️ " : ""}${String(days)} дн`;
}

/**
 * Общие столбцы «В работе», «На ревью» и «Доработки»: задача, поток, кто запустил,
 * сколько висит, кругов доработки, чего ждёт и (у разделов с PR) сам PR.
 */
function workSection(title, entries, owners, withPr) {
  const headers = ["Задача", "Поток", "Запустил", "Висит", "Кругов", "Чего ждёт", ...(withPr ? ["PR"] : [])];
  const rows = entries.map((entry) => [
    taskLink(entry.task),
    entry.owner || owners.get(entry.task.id) || "неизвестно",
    entry.launchedBy ?? "—",
    hangingText(entry.days),
    entry.rounds > 0 ? String(entry.rounds) : "—",
    entry.ripe === undefined ? waitingText(entry.waiting) : aheadWaitingText(entry),
    // У «В работе» PR бывает не всегда: ветка без PR — ещё не открыт.
    ...(withPr ? [entry.pr === undefined ? "—" : prLink(entry.pr)] : []),
  ]);
  return section(title, entries.length, headers, rows);
}

/** «Можно брать» тремя таблицами по месту работы; `human` здесь нет — он в «Ждут владельца». */
function freeSection(board) {
  const kinds = [
    ["В облаке", "any"],
    ["Машина с Docker", "local"],
    ["Машина владельца", "owner"],
  ];
  const headers = ["Задача", "Приоритет", "Размер", "Исполнитель", "Эпик"];
  const parts = kinds.map(([title, runner]) => {
    const entries = board.free.filter(({ task }) => task.runner === runner);
    const rows = entries.map(({ task }) => [taskLink(task), task.priority, task.size, `${task.executor} · ${task.effort}`, task.epic]);
    return `### ${title} — ${String(entries.length)}\n\n${rows.length === 0 ? "Пусто." : table(headers, rows)}`;
  });
  const total = board.free.filter(({ task }) => kinds.some(([, runner]) => runner === task.runner)).length;
  return `## Можно брать — ${String(total)}\n\n${parts.join("\n\n")}`;
}

/** «Можно заделом» (Р178): задачи, чьи зависимости ждут ревью, — их можно начать поверх веток зависимостей. */
function aheadFreeSection(board) {
  const entries = board.aheadFree ?? [];
  return section(
    "Можно заделом",
    entries.length,
    ["Задача", "Поверх", "Исполнитель", "Эпик"],
    entries.map(({ task, aheadOver }) => [taskLink(task), (aheadOver ?? []).join(", "), `${task.executor} · ${task.effort}`, task.epic]),
  );
}

/** Таблица одного периода «Вклада»; пустой — «Пусто.». */
function contributionTable(rows) {
  if (rows.length === 0) return "Пусто.";
  return table(
    ["Кто", "Задачи", "Очки", "Доработки", "Ревью и ответы", "Спецификации", "PR тимлидов"],
    rows.map((row) => [row.who, String(row.tasks), String(row.points), String(row.rework), String(row.reviews), String(row.specs), String(row.leadPrs)]),
  );
}

/** Периоды, открытые на странице; остальные свёрнуты в `<details>`. */
const OPEN_PERIODS = new Set(["today", "week"]);

/**
 * «Вклад»: по таблице на период — «Сегодня» и «Неделя» открыты, остальные в `<details>`
 * (tasks/T-0208). `rows` — результат `contributionRows` или `null` (тогда все периоды пусты).
 */
function contributionSection(rows, githubAvailable) {
  const intro = "Наглядность, а не формула выплат: доли участников проекта назначает владелец (`docs/11-revenue-split.md` §3). Время — МСК.";
  const note = githubAvailable ? "" : "\n\nНет данных GitHub: список влитых PR не получен — показаны только спецификации.";
  const blocks = ["today", "yesterday", "week", "month", "all"].map((key) => {
    const title = PERIOD_TITLES[key];
    const body = contributionTable(rows?.[key] ?? []);
    return OPEN_PERIODS.has(key) ? `### ${title}\n\n${body}` : `<details>\n<summary>${title}</summary>\n\n${body}\n\n</details>`;
  });
  return `## Вклад\n\n${intro}${note}\n\n${blocks.join("\n\n")}`;
}

/**
 * Текст страницы доски. `board` — результат `classify`; `owners` — `Map<id, owner>` задач «в работе»
 * и «на ревью»; `credits` — из `taskCredits`, `contribution` — из `contributionRows`; `now` — `Date`.
 * Даты — по Москве; `mergedPrs` — влитые PR задач для счётчика «влито сегодня». Только логины GitHub: ни почт, ни юзернеймов Telegram, ни имён.
 */
export function renderBoardPage({ board, owners, credits, contribution = null, githubAvailable, mergedPrs = [], now }) {
  const done = [...board.done].sort((a, b) => b.task.id.localeCompare(a.task.id));
  const sections = [
    ownerSection(board),
    leadSection(board),
    streamsSection(board, credits, now),
    // Доработку заканчивает любой поток с тем же исполнителем и уровнем, не только тот, кто вёл.
    workSection("Доработка", board.rework, owners, true),
    freeSection(board),
    aheadFreeSection(board),
    workSection("В работе", board.inProgress, owners, board.inProgress.some((entry) => entry.pr !== undefined)),
    workSection("На ревью", board.review, owners, true),
    workSection("Задел", board.ahead ?? [], owners, true),
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
    contributionSection(contribution, githubAvailable),
  ];
  const counters = countersLine(boardCounters(board, mergedPrs, now));
  const intro = `Обновлено ${formatMoscow(now)} МСК. Страницу пересчитывает workflow \`task-board.yml\` после захвата, PR и мерджа — руками не править. Как брать задачу — [tasks/README.md](${TASKS_URL}/README.md#как-взять-задачу).`;
  return `# Доска задач\n\n${intro}\n\n${counters}\n\n${sections.join("\n\n")}\n`;
}
