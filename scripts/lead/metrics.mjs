// Метрики конвейера тимлида (T-0478, Р224, F): сколько PR принято с первого
// ревью, сколько кругов доработки, сколько идёт до мерджа и почему падает поезд.
//
//   node scripts/lead/metrics.mjs [--since 2026-11-13]   — Markdown для чата команды
//
// PR и метки берутся из GitHub (`gh`), провалы и пачки — из `.lead/train.log`
// (строки с датой UTC: по ним период и режется). Вывод только печатается:
// в чат команды его отправляет человек.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { currentLeadPaths } from "./paths.mjs";

const DAY_MS = 24 * 3600 * 1000;
const REWORK_LABEL = "доработка";
// Комментарий тимлида с доработкой: «**claude-lead-1:** …» или «**claude-lead2-3:** …»
const LEAD_COMMENT = /^\s*\*\*claude-lead\d*-?\d*:\*\*/;
const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\s+(.*)$/;
const TOP_FILES = 5;

export function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Начало периода в мс: дата `ГГГГ-ММ-ДД` (UTC) или сутки назад. */
export function parseSince(value, now = Date.now()) {
  if (value === undefined || value === "") return now - DAY_MS;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`--since: ожидалась дата ГГГГ-ММ-ДД, получено «${value}»`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`--since: нет такой даты «${value}»`);
  return ms;
}

/** Причина провала поезда по тексту строки: conflict | ci | batch | network | other. */
export function classifyFailure(reason) {
  const text = String(reason ?? "").trim();
  if (text.startsWith("конфликт с dev:")) {
    return { kind: "conflict", files: text.slice("конфликт с dev:".length).trim().split(/\s+/).filter(Boolean) };
  }
  if (text.startsWith("свой CI красный") || text.startsWith("CI после влития dev")) return { kind: "ci", files: [] };
  if (text.startsWith("красный gate вместе")) return { kind: "batch", files: [] };
  if (text.startsWith("сеть")) return { kind: "network", files: [] };
  return { kind: "other", files: [] };
}

/** Лог поезда с даты `sinceMs`: не влитые PR, сетевые сбои и пачки. */
export function parseTrainLog(text, sinceMs) {
  const failures = [];
  const batches = [];
  let network = 0;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const m = LOG_LINE.exec(raw);
    if (!m || Date.parse(m[1]) < sinceMs) continue;
    const body = m[2];
    const failed = /^не влит #(\d+): (.*)$/.exec(body);
    if (failed) {
      failures.push({ pr: Number(failed[1]), ...classifyFailure(failed[2]) });
      continue;
    }
    if (body.startsWith("сеть")) {
      network += 1;
      continue;
    }
    const start = /^пачка ([\d ]+): проверка в #/.exec(body);
    if (start) {
      const list = start[1].trim();
      batches.push({ list, size: list.split(/\s+/).length, green: true });
      continue;
    }
    const split = /^пачка ([\d ]+): gate /.exec(body);
    if (split) {
      const open = [...batches].reverse().find((b) => b.list === split[1].trim());
      if (open) open.green = false;
    }
  }
  return { failures, network, batches: batches.map(({ size, green }) => ({ size, green })) };
}

/** Показатели PR: каждый — { number, createdAt, mergedAt, reworkLabels, reworkComments }. */
export function prStats(prs) {
  const rounds = prs.map((p) => Math.max(p.reworkLabels, p.reworkComments));
  const hours = prs.map((p) => (Date.parse(p.mergedAt) - Date.parse(p.createdAt)) / 3600000);
  const firstReview = rounds.filter((r) => r === 0).length;
  return {
    total: prs.length,
    firstReview,
    firstReviewPct: prs.length ? Math.round((firstReview / prs.length) * 100) : 0,
    roundsMedian: median(rounds),
    roundsMax: rounds.length ? Math.max(...rounds) : 0,
    mergeMedianHours: median(hours),
  };
}

const fmt = (n) => String(Math.round(n * 10) / 10).replace(".", ",");

export function renderReport({ pr, train, since }) {
  const count = (kind) => train.failures.filter((f) => f.kind === kind);
  const byFile = new Map();
  for (const f of count("conflict")) for (const file of f.files) byFile.set(file, (byFile.get(file) ?? 0) + 1);
  const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_FILES);
  const conflicts = count("conflict").length;
  const conflictText = top.length ? `конфликт — ${conflicts} (${top.map(([f, n]) => `${f} — ${n}`).join(", ")})` : `конфликт — ${conflicts}`;
  const batches = train.batches;
  const greenPct = batches.length ? Math.round((batches.filter((b) => b.green).length / batches.length) * 100) : 0;
  const avg = batches.length ? batches.reduce((s, b) => s + b.size, 0) / batches.length : 0;
  return [
    `**Метрики конвейера с ${since}**`,
    "",
    `- PR влито: ${pr.total}`,
    `- С первого ревью — ${pr.firstReviewPct} % (${pr.firstReview} из ${pr.total})`,
    `- Кругов доработки — медиана ${fmt(pr.roundsMedian)}, максимум ${pr.roundsMax}`,
    `- Время до мерджа — медиана ${fmt(pr.mergeMedianHours)} ч`,
    `- Провалы поезда: ${conflictText}, красный CI — ${count("ci").length}, красная пачка — ${count("batch").length}, сеть — ${train.network}, прочее — ${count("other").length}`,
    `- Пачек — ${batches.length}, средний размер ${fmt(avg)}, зелёных ${greenPct} %`,
    "",
  ].join("\n");
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
}

/** Влитые в dev PR задач с даты `sinceMs`, с числом кругов доработки. */
function collectPrs(sinceMs) {
  const day = new Date(sinceMs).toISOString().slice(0, 10);
  const list = JSON.parse(
    gh(["pr", "list", "--state", "merged", "--base", "dev", "--limit", "500", "--search", `merged:>=${day}`, "--json", "number,createdAt,mergedAt,headRefName,comments"]),
  );
  const repo = JSON.parse(gh(["repo", "view", "--json", "nameWithOwner"])).nameWithOwner;
  return list
    .filter((p) => p.headRefName.startsWith("task/") && Date.parse(p.mergedAt) >= sinceMs)
    .map((p) => {
      const events = JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/issues/${p.number}/timeline`])).flat();
      const reworkLabels = events.filter((e) => e.event === "labeled" && e.label?.name === REWORK_LABEL).length;
      const reworkComments = p.comments.filter((c) => LEAD_COMMENT.test(c.body ?? "") && /доработ/i.test(c.body)).length;
      return { number: p.number, createdAt: p.createdAt, mergedAt: p.mergedAt, reworkLabels, reworkComments };
    });
}

function main(argv) {
  const at = argv.indexOf("--since");
  const sinceArg = at >= 0 ? argv[at + 1] : undefined;
  const sinceMs = parseSince(sinceArg);
  const paths = currentLeadPaths();
  const train = parseTrainLog(existsSync(paths.log) ? readFileSync(paths.log, "utf8") : "", sinceMs);
  const pr = prStats(collectPrs(sinceMs));
  process.stdout.write(renderReport({ pr, train, since: new Date(sinceMs).toISOString().slice(0, 10) }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`metrics: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
