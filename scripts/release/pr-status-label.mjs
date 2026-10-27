import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REVIEW_LABEL, REWORK_LABEL, STATUS_LABELS, WORK_LABEL } from "../tasks/board.mjs";
import { viewPr } from "./git.mjs";

/**
 * Страховка метки статуса задачи на PR (Р172, docs/35-stage4-plan.md,
 * tasks/README.md, «Метки статуса»): у PR ветки `task/T-NNNN` ровно одна метка
 * из `STATUS_LABELS`. Исполнитель и ревьюер ставят её сами; бот ловит забытое,
 * чтобы поток не висел «в работе» после отправки на ревью.
 *
 * Логика — чистая функция `planStatusLabels`: что поставить и снять по событию.
 * CLI внизу — тонкая обвязка над `gh`, тестами не покрыта (читает живой PR).
 */

const TASK_BRANCH_RE = /^task\/T-\d{4}$/;

/**
 * Что сделать с метками по событию: `{ add, remove }` — списки имён, оба могут
 * быть пустыми.
 *
 * - `headRef` — ветка PR; не `task/T-NNNN` — ничего не делаем;
 * - `eventName`, `action` — событие GitHub: `pull_request` с `opened`,
 *   `reopened`, `ready_for_review`, `labeled` или `pull_request_review` с
 *   `submitted`;
 * - `labels` — имена меток PR сейчас (свежий запрос, а не снимок события);
 * - `labelName` — поставленная метка, для `labeled`;
 * - `reviewState` — итог ревью, для `pull_request_review`.
 */
export function planStatusLabels({ headRef, eventName, action, labels, labelName, reviewState }) {
  const none = { add: [], remove: [] };
  if (!TASK_BRANCH_RE.test(headRef ?? "")) return none;
  const statuses = labels.filter((label) => STATUS_LABELS.includes(label));

  if (eventName === "pull_request_review") {
    if (action !== "submitted" || String(reviewState ?? "").toLowerCase() !== "changes_requested") return none;
    // «Доработка» вытесняет любой другой статус: «Request changes» — последнее слово ревьюера.
    return {
      add: statuses.includes(REWORK_LABEL) ? [] : [REWORK_LABEL],
      remove: statuses.filter((label) => label !== REWORK_LABEL),
    };
  }

  if (eventName !== "pull_request") return none;

  if (action === "opened" || action === "reopened") {
    return statuses.length === 0 ? { add: [REVIEW_LABEL], remove: [] } : none;
  }

  if (action === "ready_for_review") {
    // Вышел из черновика — значит отправлен. Но «доработка» и «ждёт владельца» не затираем:
    // там уже решили, чего ждёт PR, а «на ревью» поверх них дало бы две метки.
    const others = statuses.filter((label) => label !== WORK_LABEL);
    return {
      add: others.length === 0 ? [REVIEW_LABEL] : [],
      remove: statuses.includes(WORK_LABEL) ? [WORK_LABEL] : [],
    };
  }

  if (action === "labeled") {
    // Меток статуса стало несколько: последняя поставленная — решение человека, старые снимаем.
    if (!STATUS_LABELS.includes(labelName) || !statuses.includes(labelName)) return none;
    return { add: [], remove: statuses.filter((label) => label !== labelName) };
  }

  return none;
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}

function main() {
  const number = process.env.PR_NUMBER;
  if (!number) throw new Error("PR_NUMBER не задан");

  // Метки читаются свежим запросом: событие могло устареть, пока шла очередь.
  const pr = viewPr(number);
  const plan = planStatusLabels({
    headRef: pr.headRefName,
    eventName: process.env.EVENT_NAME,
    action: process.env.EVENT_ACTION,
    labels: (pr.labels ?? []).map((label) => label.name),
    labelName: process.env.LABEL_NAME || undefined,
    reviewState: process.env.REVIEW_STATE || undefined,
  });

  if (plan.add.length === 0 && plan.remove.length === 0) {
    console.log("метки статуса в порядке, менять нечего");
    return;
  }
  for (const label of plan.add) {
    gh(["pr", "edit", number, "--add-label", label]);
    console.log(`поставлена метка «${label}»`);
  }
  for (const label of plan.remove) {
    // Метку мог снять человек между чтением и записью — это не повод падать.
    try {
      gh(["pr", "edit", number, "--remove-label", label]);
      console.log(`снята метка «${label}»`);
    } catch (error) {
      console.error(`метку «${label}» снять не удалось: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
