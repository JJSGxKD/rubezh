// Сколько агентов сценария Workflow сейчас идут: started без result (T-0477).
//   node scripts/lead/workflow-running.mjs <каталог прогона>
// Каталог прогона — тот, где лежит journal.jsonl сценария.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Идущие агенты по тексту журнала: `{ count, labels }`. Битые строки пропускаются. */
export function runningAgents(journal) {
  const labels = new Map();
  const finished = new Set();
  for (const line of String(journal ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "started") labels.set(entry.key, entry.label);
    if (entry.type === "result") finished.add(entry.key);
  }
  const running = [...labels.keys()].filter((key) => !finished.has(key)).map((key) => labels.get(key));
  return { count: running.length, labels: running };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Использование: node scripts/lead/workflow-running.mjs <каталог прогона>");
    process.exit(2);
  }
  const { count, labels } = runningAgents(readFileSync(join(dir, "journal.jsonl"), "utf8"));
  console.log(`${count} :: ${labels.join(" | ")}`);
}
