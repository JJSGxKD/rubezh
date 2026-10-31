import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isServicePr } from "./branches.mjs";
import { RELEASE_LEVELS, compareReleaseLevels, parseStableTag } from "./semver.mjs";
import { addLabel, latestStableTag, listComments, postComment, viewPr } from "./git.mjs";
import { PLAYER_NOTES_SECTION, parsePlayerNotes } from "./player-notes.mjs";
import { TEAM_SECTION, extractSection } from "./team-summary.mjs";
import { EFFORTS, EXECUTORS } from "../tasks/task-file.mjs";
import { STATUS_LABELS } from "../tasks/board.mjs";

/**
 * Проверка заголовка и метки релиза на PR (docs/09-ci-cd.md §8.1, «Проверка PR»).
 *
 * Логика разбора и сравнения меток — чистые функции ниже, без обращения к
 * `gh`: их покрывают тесты. CLI в конце файла — тонкая обвязка, которую
 * тестами не покрыть (она читает состояние живого PR).
 */

const COMMIT_TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "revert", "ci"];
const TITLE_RE = new RegExp(`^(${COMMIT_TYPES.join("|")})(\\(([a-z0-9-]+)\\))?(!)?: (.+)$`);
const AUTO_LABEL_MARKER = "<!-- pr-check: метка релиза подставлена автоматически -->";

/** Заголовок PR = заголовок merge-коммита (CLAUDE.md, «Коммиты»). */
export function parsePrTitle(title) {
  const trimmed = title.trim();
  const match = TITLE_RE.exec(trimmed);
  if (!match) {
    return {
      valid: false,
      errors: [
        `заголовок не соответствует формату \`type(scope): Текст на русском\` (типы: ${COMMIT_TYPES.join(", ")})`,
      ],
    };
  }

  const [, type, , scope, breakingMark, subject] = match;
  const errors = [];
  if (trimmed.length > 72) errors.push("заголовок длиннее 72 символов");
  if (subject.endsWith(".")) errors.push("текст после двоеточия не должен заканчиваться точкой");
  if (!/^\p{Lu}/u.test(subject)) errors.push("текст после двоеточия должен начинаться с заглавной буквы");

  return { valid: errors.length === 0, errors, type, scope: scope ?? null, breaking: breakingMark === "!" };
}

/**
 * Области, до игрока не доходящие: инструменты разработчика (`dev`), пайплайн
 * (`ci`) и обвязка развёртывания (`infra`). Версия всё равно поднимается —
 * монорепо выпускается одним номером, и собрать сборку из тега нужно любой, —
 * но на патч, а не на минор: иначе правка dev-сервера или workflow двигает
 * номер так же, как новая механика в игре, и минорный номер перестаёт
 * что-либо значить.
 *
 * Ломающее изменение под это послабление не попадает: `!` остаётся `!`.
 */
const TOOLING_SCOPES = ["dev", "ci", "infra"];

/**
 * Минимально допустимая метка по типу коммита и текущей базовой версии
 * (docs/09-ci-cd.md §8.1, таблица «Проверка PR», п.3). Выше можно, ниже нет.
 */
export function minimumReleaseLevel({ type, scope, breaking }, baseMajor) {
  if (breaking) return baseMajor === 0 ? "minor" : "major";
  if (type === "feat") return TOOLING_SCOPES.includes(scope) ? "patch" : "minor";
  if (["fix", "perf", "refactor", "revert"].includes(type)) return "patch";
  return "none";
}

/**
 * Метка "release: none" тоже допустима, что позволяет неявно приравнять
 * `docs`/`style`/`test`/`chore`/`ci` к любому уровню без метки — она в
 * группе, где всё разрешено (`minimumReleaseLevel` возвращает `"none"`).
 */
export function evaluateReleaseLabels(labelNames, minimum) {
  const releaseLabels = labelNames
    .filter((name) => name.startsWith("release: "))
    .map((name) => name.slice("release: ".length));

  if (releaseLabels.length === 0) return { status: "missing", suggested: minimum };
  if (releaseLabels.length > 1) return { status: "multiple", labels: releaseLabels };

  const [label] = releaseLabels;
  if (!RELEASE_LEVELS.includes(label)) return { status: "unknown", label };
  if (compareReleaseLevels(label, minimum) < 0) return { status: "too-low", label, minimum };
  return { status: "ok", label };
}

export function requiresBreakingSection({ breaking }, evaluation) {
  return breaking || evaluation.label === "major" || evaluation.suggested === "major";
}

/** Раздел «Что ломается» с оставленным плейсхолдером-комментарием считается пустым. */
export function hasBreakingSection(body) {
  if (!body) return false;
  const heading = /^##\s+Что ломается и как мигрировать\s*$/im;
  const match = heading.exec(body);
  if (!match) return false;

  const rest = body.slice(match.index + match[0].length);
  const nextHeading = /^##\s/m.exec(rest);
  const section = nextHeading ? rest.slice(0, nextHeading.index) : rest;
  const withoutComments = section.replaceAll(/<!--[\s\S]*?-->/g, "");
  return withoutComments.trim().length > 0;
}

/**
 * Сводка для команды (раздел `## Сводка для команды`): бот при мердже шлёт её в
 * чат как есть, поэтому номер PR и отсутствие блока кода проверяются до мерджа.
 */
export function checkSummary(body, number) {
  const section = extractSection(body, TEAM_SECTION);
  if (section === null) return [`сводка: нет раздела «${TEAM_SECTION}»`];
  if (section.startsWith("```")) return ["сводка: сводка в блоке кода — бот отправит её как есть"];

  const [firstLine = ""] = section.split("\n");
  if (/#(<номер>|НОМЕР)/i.test(firstLine)) return ["сводка: впишите номер PR в заголовок сводки вместо заглушки"];
  if (!new RegExp(`#${number}(?!\\d)`).test(firstLine)) {
    return [`сводка: в первой строке сводки нет номера этого PR (#${number})`];
  }
  return [];
}

/**
 * Первая строка описания ветки задачи — `Задача: tasks/T-NNNN-….md`; файл
 * лежит в `tasks/` ветки PR и принадлежит той же задаче, что и ветка.
 */
export function checkTaskLine(body, headRefName, taskFiles) {
  const branch = /^task\/(T-\d{4})$/.exec(headRefName ?? "");
  if (!branch) return [];

  const first = (body ?? "").replace(/\r\n/g, "\n").split("\n").find((line) => line.trim() !== "") ?? "";
  const match = /^Задача:\s*`?tasks\/(?:archive\/)?(T-\d{4})-[^\s`/]+\.md`?\s*$/.exec(first.trim());
  // Задача закрывается в PR на месте, в `tasks/`; путь в архив тоже принимается — файл ищется в обеих папках ветки.
  if (!match) return [`задача: первая строка описания должна быть «Задача: tasks/${branch[1]}-….md»`];
  if (match[1] !== branch[1]) return [`задача: в строке «Задача:» ${match[1]}, а ветка ${branch[1]}`];

  const file = first.trim().replace(/^Задача:\s*`?tasks\//, "").replace(/`$/, "");
  if (!taskFiles.includes(file)) return [`задача: файла tasks/${file} нет в ветке PR`];
  return [];
}

const RUNNER_LINE = /^Поток:\s*claude-\d+\s*\/\s*(\S+)\s*\/\s*(\S+)\s*$/;
const LAUNCHER_LINE = /^Запустил:\s*(владелец|помощник\s+[\p{L}\p{N}_-]{2,32})\s*$/u;

/**
 * Две строки с начала строки в описании PR ветки задачи: `Поток:` — кто
 * работал (модель и уровень из списков задач), `Запустил:` — кто запустил
 * поток. По ним доска считает вклад и по потокам, и по людям (T-0207).
 */
export function checkRunnerLines(body, headRefName) {
  if (!/^task\/T-\d{4}$/.test(headRefName ?? "")) return [];

  const lines = (body ?? "").replace(/\r\n/g, "\n").split("\n").map((line) => line.trimEnd());
  const errors = [];

  const runner = lines.map((line) => RUNNER_LINE.exec(line)).find(Boolean);
  if (!runner) {
    errors.push("поток: в описании нет строки «Поток: claude-N / <модель> / <уровень>»");
  } else if (!EXECUTORS.includes(runner[1]) || !EFFORTS.includes(runner[2])) {
    errors.push(`поток: «${runner[0]}» — модель или уровень не из списка`);
  }

  if (!lines.some((line) => LAUNCHER_LINE.test(line))) {
    errors.push("запустил: в описании нет строки «Запустил: владелец» или «Запустил: помощник <ник>»");
  }
  return errors;
}

/**
 * Метка статуса задачи на PR ветки `task/T-NNNN` (Р172): ровно одна из
 * `STATUS_LABELS`. По ней читают доска, значки и захват, поэтому без метки
 * или с двумя PR не проходит. Остальные ветки метки статуса не несут.
 */
export function checkStatusLabels(labelNames, headRefName) {
  if (!/^task\/T-\d{4}$/.test(headRefName ?? "")) return [];
  const present = STATUS_LABELS.filter((name) => labelNames.includes(name));
  if (present.length === 0) return [`статус: нет метки статуса — поставь одну из: ${STATUS_LABELS.join(", ")}`];
  if (present.length > 1) return [`статус: меток статуса несколько (${present.join(", ")}) — оставь одну`];
  return [];
}

/**
 * Трейлер `Co-Authored-By:` сразу под заголовком git склеивает с заголовком:
 * между ними нужна пустая строка.
 */
export function checkTrailers(messages) {
  const errors = [];
  for (const { sha, message } of messages) {
    const lines = message.replace(/\r\n/g, "\n").split("\n");
    const hasTrailer = lines.some((line) => /^co-authored-by:/i.test(line));
    if (hasTrailer && lines.length > 1 && lines[1].trim() !== "") {
      errors.push(`коммит ${sha.slice(0, 7)}: трейлеры нужно отделить от заголовка пустой строкой`);
    }
  }
  return errors;
}

function taskFilesAt(ref) {
  const out = execFileSync("git", ["ls-tree", "--name-only", ref, "tasks/", "tasks/archive/"], { encoding: "utf8" });
  return out.split("\n").map((line) => line.replace(/^tasks\//, "")).filter((name) => /^(?:archive\/)?T-\d{4}-.+\.md$/.test(name));
}

function prCommitMessages(base, head) {
  const out = execFileSync("git", ["log", "--format=%H%x00%B%x00", `${base}..${head}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const parts = out.split("\0");
  const messages = [];
  for (let i = 0; i + 1 < parts.length; i += 2) messages.push({ sha: parts[i].trim(), message: parts[i + 1] });
  return messages;
}

function main() {
  const number = process.env.PR_NUMBER;
  if (!number) throw new Error("PR_NUMBER не задан");

  const pr = viewPr(number);
  const labelNames = (pr.labels ?? []).map((label) => label.name);
  const errors = [];

  const title = parsePrTitle(pr.title);
  if (!title.valid) {
    for (const error of title.errors) errors.push(`заголовок: ${error}`);
  }

  // Релизный и синк-PR метку не несут по замыслу (scripts/release/branches.mjs):
  // требовать её — значит заставить поставить «none» на PR, который выпускает
  // версию, а подставлять автоматически — вводить в заблуждение ревьюера.
  const service = isServicePr(pr.headRefName, pr.baseRefName);
  if (service) console.log(`служебный PR ${pr.headRefName} → ${pr.baseRefName}: метка релиза не проверяется`);

  if (title.valid && !service) {
    const baseTag = latestStableTag();
    const baseMajor = baseTag ? parseStableTag(baseTag).major : 0;
    const minimum = minimumReleaseLevel(title, baseMajor);
    const evaluation = evaluateReleaseLabels(labelNames, minimum);

    if (evaluation.status === "missing") {
      addLabel(number, `release: ${evaluation.suggested}`);
      const marker = AUTO_LABEL_MARKER;
      const alreadyCommented = listComments(number).some((c) => c.body?.includes(marker));
      if (!alreadyCommented) {
        postComment(
          number,
          `${marker}\nАвтоматически поставлена метка \`release: ${evaluation.suggested}\` по типу заголовка ` +
            `(\`${title.type}\`). Подтвердите или замените на более старшую — ниже минимума проверка не пропустит.`,
        );
      }
    } else if (evaluation.status === "multiple") {
      errors.push(`на PR больше одной метки \`release: *\`: ${evaluation.labels.join(", ")}`);
    } else if (evaluation.status === "unknown") {
      errors.push(`неизвестная метка \`release: ${evaluation.label}\``);
    } else if (evaluation.status === "too-low") {
      errors.push(
        `метка \`release: ${evaluation.label}\` ниже минимума \`release: ${evaluation.minimum}\` для типа \`${title.type}\``,
      );
    } else if (requiresBreakingSection(title, evaluation) && !hasBreakingSection(pr.body)) {
      errors.push('раздел "Что ломается и как мигрировать" обязателен и не должен быть пустым');
    } else if (requiresBreakingSection(title, evaluation)) {
      addLabel(number, "breaking");
    }
  }

  // Строки для игроков уходят в журнал обновлений при выкате: ошибку формата
  // дешевле поймать здесь, чем пропустить строку при сборке релиза.
  if (!service) {
    for (const error of parsePlayerNotes(pr.body).errors) errors.push(`раздел «${PLAYER_NOTES_SECTION}»: ${error}`);
  }

  if (!service) {
    errors.push(...checkSummary(pr.body, Number(number)));
    const head = `origin/${pr.headRefName}`;
    errors.push(...checkTaskLine(pr.body, pr.headRefName, taskFilesAt(head)));
    errors.push(...checkRunnerLines(pr.body, pr.headRefName));
    errors.push(...checkStatusLabels(labelNames, pr.headRefName));
    errors.push(...checkTrailers(prCommitMessages(`origin/${pr.baseRefName}`, head)));
  }

  for (const error of errors) console.error(`ошибка  ${error}`);
  if (errors.length > 0) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
