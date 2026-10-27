import { launchedBy, reworkRounds } from "./board.mjs";

/**
 * «Вклад» на доске (tasks/T-0208): пять видов работы по участникам за пять
 * периодов. Чистые функции — данные GitHub и git приходят снаружи, страница
 * только рисует. Тесты — scripts/test/tasks-contribution.test.ts.
 */

/** Очки — сумма размеров сделанных задач. Наглядность, а не формула выплат: доли участников — docs/11-revenue-split.md. */
export const SIZE_POINTS = { S: 1, M: 2 };

const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const PERIOD_TITLES = { today: "Сегодня", yesterday: "Вчера", week: "Неделя", month: "Месяц", all: "Всё время" };

/**
 * Периоды по Москве (UTC+3, без перехода на летнее время): сутки с 00:00 МСК,
 * неделя с понедельника, месяц с первого числа. `from` и `to` — ISO-строки UTC,
 * `to` не входит в период; у «всего времени» верхней границы нет.
 */
export function periodsAt(now) {
  const shifted = new Date(now.getTime() + MOSCOW_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  const dayStart = Date.UTC(year, month, shifted.getUTCDate()) - MOSCOW_OFFSET_MS;
  const weekStart = dayStart - ((shifted.getUTCDay() + 6) % 7) * DAY_MS;
  const monthStart = Date.UTC(year, month, 1) - MOSCOW_OFFSET_MS;
  const nextMonthStart = Date.UTC(year, month + 1, 1) - MOSCOW_OFFSET_MS;
  const iso = (time) => new Date(time).toISOString();
  const bounds = {
    today: [dayStart, dayStart + DAY_MS],
    yesterday: [dayStart - DAY_MS, dayStart],
    week: [weekStart, weekStart + 7 * DAY_MS],
    month: [monthStart, nextMonthStart],
    all: [0, null],
  };
  return Object.entries(bounds).map(([key, [from, to]]) => ({ key, title: PERIOD_TITLES[key], from: iso(from), to: to === null ? null : iso(to) }));
}

// Формат строки тот же, что в scripts/release/pr-check.mjs (T-0207), но с номером аккаунта;
// `contribution.mjs` оттуда не импортирует, поэтому регулярка повторена, а тест сверяет их на одних примерах.
const RUNNER_LINE = /^Поток:\s*(claude-\d+)\s*\/\s*(\S+)\s*\/\s*(\S+)\s*$/;
const SIGNATURE = /^\*\*(claude-[a-z0-9-]+):\*\*/;
const STREAM_ACCOUNT = /^claude-\d+$/;

/** Номер аккаунта из строки `Поток:` описания PR или `null`. */
export function parseRunnerLine(body) {
  for (const line of (body ?? "").replace(/\r\n/g, "\n").split("\n")) {
    const match = RUNNER_LINE.exec(line.trimEnd());
    if (match) return match[1];
  }
  return null;
}

const accountOfOwner = (owner) => /^(claude-\d+)(?:\s|\/|$)/.exec(owner ?? "")?.[1] ?? null;

/** Кодовое имя из подписи в начале текста («**claude-lead-1:** …») или `null`. */
const signedBy = (text) => SIGNATURE.exec((text ?? "").trimStart())?.[1] ?? null;

/** Первая непустая строка описания. */
const firstLine = (body) => (body ?? "").replace(/\r\n/g, "\n").split("\n").find((line) => line.trim() !== "") ?? "";

/** «Кто» для подписи: у потока человек не известен по подписи, у ролей его нет совсем. */
const signerLabel = (code) => `${code} · ${STREAM_ACCOUNT.test(code) ? "не указан" : "—"}`;

const emptyRow = (who) => ({ who, tasks: 0, points: 0, rework: 0, reviews: 0, specs: 0, leadPrs: 0 });

/**
 * Строки «Вклада» по периодам: `{ today, yesterday, week, month, all }`, в каждом
 * `[{ who, tasks, points, rework, reviews, specs, leadPrs }]` по убыванию очков, затем ревью,
 * затем по имени.
 *
 * - `tasks` — поля задач реестра (`id`, `size`, `owner`);
 * - `mergedPrs` — влитые в dev PR `{ number, headRefName, mergedAt, body, commits, reviews, comments }`
 *   или `null`, если GitHub недоступен: тогда считаются только спецификации;
 * - `specs` — `[{ id, author, addedAt }]`: задачи, добавленные в dev; без `author` не считаются;
 * - `now` — `Date`.
 */
export function contributionRows({ tasks, mergedPrs, specs, now }) {
  const periods = periodsAt(now).map((period) => ({ ...period, fromTime: Date.parse(period.from), toTime: period.to === null ? Infinity : Date.parse(period.to), rows: new Map() }));
  const taskById = new Map(tasks.map((task) => [task.id, task]));

  const add = (when, who, field, amount) => {
    const time = Date.parse(when ?? "");
    if (Number.isNaN(time)) return;
    for (const period of periods) {
      if (time < period.fromTime || time >= period.toTime) continue;
      const row = period.rows.get(who) ?? emptyRow(who);
      row[field] += amount;
      period.rows.set(who, row);
    }
  };

  for (const spec of specs ?? []) {
    if (typeof spec.author === "string" && spec.author !== "") add(spec.addedAt, signerLabel(spec.author), "specs", 1);
  }

  for (const pr of mergedPrs ?? []) {
    const taskId = /^task\/(T-\d{4})$/.exec(pr.headRefName ?? "")?.[1];
    if (taskId !== undefined) {
      const task = taskById.get(taskId);
      const account = parseRunnerLine(pr.body) ?? accountOfOwner(task?.owner) ?? "не указан";
      const who = `${account} · ${launchedBy(pr.body) ?? "не указан"}`;
      add(pr.mergedAt, who, "tasks", 1);
      add(pr.mergedAt, who, "points", SIZE_POINTS[task?.size] ?? 1);
      add(pr.mergedAt, who, "rework", reworkRounds(pr, taskId));
    } else if (pr.headRefName !== "main") {
      // Синк main → dev возвращает уже выпущенное и PR тимлида не является.
      const lead = signedBy(firstLine(pr.body));
      if (lead !== null) add(pr.mergedAt, signerLabel(lead), "leadPrs", 1);
    }
    for (const item of [...(pr.reviews ?? []), ...(pr.comments ?? [])]) {
      const code = signedBy(item?.body);
      if (code !== null) add(item.createdAt ?? item.submittedAt, signerLabel(code), "reviews", 1);
    }
  }

  const order = (a, b) => b.points - a.points || b.reviews - a.reviews || a.who.localeCompare(b.who);
  return Object.fromEntries(periods.map((period) => [period.key, [...period.rows.values()].sort(order)]));
}

export { PERIOD_TITLES };
