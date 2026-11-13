// Состояние поезда мерджей тимлида (T-0477, Р224): разбор очереди, итогов и
// провалов без подсчётов вручную, и итог проверок PR для самого поезда.
//
//   node scripts/lead/train-status.mjs            — JSON {queued, approved, failed}:
//       queued — PR, которые поезд ещё повезёт (не трогать);
//       approved — все когда-либо одобренные (не ревьюить заново);
//       failed — открытые провалы: последняя строка провала PR, если после
//                неё PR не вернули в очередь.
//   gh pr checks N --json name,state,startedAt | node scripts/lead/train-status.mjs ci
//       — «GATE CHECK»: GREEN | RED | PENDING | NONE по последнему прогону каждого имени.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { currentLeadPaths } from "./paths.mjs";

const PR_NUMBER = /^[1-9]\d*$/;
const RED = new Set(["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

const rows = (text) => String(text ?? "").split(/\r?\n/);
const firstWord = (line) => line.trim().split(/\s+/)[0];
const prNumbers = (text) => rows(text).map(firstWord).filter((word) => PR_NUMBER.test(word));
const countOf = (list, word) => list.filter((item) => item === word).length;

/**
 * Состояние поезда по содержимому трёх файлов. PR ждёт, пока в очереди строк
 * больше, чем итогов (в «итогах» и «провалах» вместе): доработанный после
 * провала PR линия дописывает в очередь снова, и он едет ещё раз. Строки «0 …» в
 * провалах — устаревшие записи без PR, они не считаются, но занимают номер строки.
 */
export function trainStatus({ queue, done, failed }) {
  const queueNums = prNumbers(queue);
  const doneNums = prNumbers(done);
  const failedLines = rows(failed);
  const failedNums = failedLines.map(firstWord);
  const approved = [...new Set(queueNums)].map(Number);
  const queued = approved.filter((n) => countOf(queueNums, String(n)) > countOf(doneNums, String(n)) + countOf(failedNums, String(n)));
  const lastFail = new Map();
  failedLines.forEach((line, index) => {
    const word = firstWord(line);
    if (PR_NUMBER.test(word)) lastFail.set(word, { line: index + 1, pr: Number(word), reason: line.trim().slice(word.length).trim() });
  });
  // Провал открыт, пока PR не вернули в очередь и не влили: влитому провал после
  // доработки уже не нужен. По номеру строки: линия берёт первым самый давний.
  const open = [...lastFail.values()]
    .filter((f) => !queued.includes(f.pr) && !doneNums.includes(String(f.pr)))
    .sort((a, b) => a.line - b.line);
  return { queued, approved, failed: open };
}

/**
 * Итог проверок PR по последнему прогону каждого имени: в сводке GitHub
 * остаются и старые прогоны (отменённые, до правки описания) — по ним судить
 * нельзя. Возвращает «gate check», каждое — GREEN | RED | PENDING | NONE.
 */
export function ciOf(checks) {
  const last = {};
  for (const run of checks ?? []) {
    if (!last[run.name] || String(run.startedAt) > String(last[run.name].startedAt)) last[run.name] = run;
  }
  const of = (name) => {
    const run = last[name];
    if (!run) return "NONE";
    if (run.state === "SUCCESS") return "GREEN";
    return RED.has(run.state) ? "RED" : "PENDING";
  };
  return `${of("gate")} ${of("check")}`;
}

function readFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv[2] === "ci") {
    let checks = [];
    try {
      checks = JSON.parse(readStdin() || "[]");
    } catch {
      checks = [];
    }
    console.log(ciOf(checks));
  } else {
    const paths = currentLeadPaths();
    console.log(JSON.stringify(trainStatus({ queue: readFile(paths.queue), done: readFile(paths.done), failed: readFile(paths.failed) })));
  }
}
