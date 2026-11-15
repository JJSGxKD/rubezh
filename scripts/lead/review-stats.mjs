// Категории замечаний ревью (T-0475, Р224, C): считает, какие замечания
// тимлиды повторяют чаще, чтобы урок попал в «Частые замечания ревью» скиллов.
//
//   node scripts/lead/review-stats.mjs --since 2026-11-10
//       → таблица «категория — сколько — три последних PR»
//
// Замечание — пункт списка в комментарии или ревью, подписанном
// `**claude-lead-…:**`; код категории — в квадратных скобках в начале пункта.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Закрытый список категорий; смысл кодов — скилл review-pr. */
export const CATEGORIES = [
  "zones",
  "gate",
  "spec",
  "tests",
  "screens",
  "texts",
  "pr-format",
  "docs",
  "security",
  "perf",
  "money",
  "migration",
  "layers",
  "other",
];

const LEAD_SIGNATURE = /^\s*\*\*claude-lead2?-\d+:\*\*/;
const BULLET = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/;
const CODE = /^\[([A-Za-z-]+)\]/;
const RECENT_PRS = 3;

export function isLeadComment(body) {
  return LEAD_SIGNATURE.test(String(body ?? ""));
}

/** Пункты замечаний комментария: `[{ code, text }]`; пункт без известного кода — `other`, отметки чек-листа пропускаются. */
export function parseFindings(body) {
  const findings = [];
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const bullet = BULLET.exec(line);
    if (bullet === null) continue;
    const text = bullet[1].trim();
    if (/^\[[ xX]\]/.test(text)) continue;
    const code = CODE.exec(text)?.[1].toLowerCase();
    findings.push({ code: code !== undefined && CATEGORIES.includes(code) ? code : "other", text });
  }
  return findings;
}

/**
 * Подсчёт по комментариям `[{ pr, body }]`: строки `{ code, count, prs }`,
 * по убыванию числа, при равенстве — по коду; `prs` — последние PR без повторов,
 * свежие (с большим номером) первыми.
 */
export function countCategories(comments) {
  const byCode = new Map();
  for (const { pr, body } of comments) {
    if (!isLeadComment(body)) continue;
    for (const { code } of parseFindings(body)) {
      const row = byCode.get(code) ?? { code, count: 0, prSet: new Set() };
      row.count += 1;
      row.prSet.add(pr);
      byCode.set(code, row);
    }
  }
  return [...byCode.values()]
    .map(({ code, count, prSet }) => ({ code, count, prs: [...prSet].sort((a, b) => b - a).slice(0, RECENT_PRS) }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

export function formatTable(rows) {
  if (rows.length === 0) return "Замечаний с кодом за период нет.";
  return rows.map((row) => `${row.code} — ${row.count} — ${row.prs.map((pr) => `#${pr}`).join(", ")}`).join("\n");
}

/** Комментарии и ревью PR, созданных с `since`: через `gh`, аргументы массивом. */
function fetchComments(since) {
  const out = execFileSync(
    "gh",
    ["pr", "list", "--state", "all", "--search", `created:>=${since}`, "--limit", "500", "--json", "number,comments,reviews"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
  );
  const prs = JSON.parse(out);
  return prs.flatMap((pr) => [...pr.comments, ...pr.reviews].map((item) => ({ pr: pr.number, body: item.body })));
}

function main(argv) {
  const at = argv.indexOf("--since");
  const since = at >= 0 ? argv[at + 1] : undefined;
  if (since === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error("Использование: node scripts/lead/review-stats.mjs --since ГГГГ-ММ-ДД");
    process.exit(2);
  }
  console.log(formatTable(countCategories(fetchComments(since))));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
