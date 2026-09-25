import { pathToFileURL } from "node:url";
import { isServicePr } from "./branches.mjs";
import { RELEASE_LEVELS, compareReleaseLevels, parseStableTag } from "./semver.mjs";
import { addLabel, latestStableTag, listComments, postComment, viewPr } from "./git.mjs";

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
