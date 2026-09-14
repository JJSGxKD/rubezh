import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Проверка ссылок в документации (docs/15-engineering-standards.md §11).
 *
 * Документ, ссылающийся на переименованный или удалённый файл, хуже
 * отсутствующего: по нему ищут, а он ведёт в пустоту. Проверяются:
 *
 * - ссылки markdown `[текст](путь)` — ошибка, если файла нет;
 * - упоминания других документов вида `27-design-system-and-app-shell.md` —
 *   ошибка, если такого документа в `docs/` нет;
 * - пути к коду в обратных кавычках (`packages/...`, `backend/...`) —
 *   предупреждение: документы этапа нередко описывают ещё не написанные
 *   файлы, и отличить план от опечатки проверка не может. С `--strict`
 *   предупреждения тоже роняют проверку.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CODE_ROOTS = ["packages/", "backend/", "apps/", "scripts/", "infra/", ".github/", ".claude/"];

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const strict = process.argv.includes("--strict");
  const report = checkDocs(ROOT);
  for (const problem of report.errors) console.error(`ошибка  ${problem}`);
  for (const problem of report.warnings) console.warn(`внимание ${problem}`);
  console.log(`\nДокументов: ${report.files}, ошибок: ${report.errors.length}, предупреждений: ${report.warnings.length}`);
  if (report.errors.length > 0 || (strict && report.warnings.length > 0)) process.exit(1);
}

export function checkDocs(root) {
  const files = documentationFiles(root);
  const docNames = new Set(readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md")));
  const errors = [];
  const warnings = [];

  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const where = relative(root, file).replaceAll("\\", "/");
    for (const problem of findLinkProblems(text, dirname(file), root, docNames)) {
      (problem.severity === "error" ? errors : warnings).push(`${where}:${problem.line} ${problem.message}`);
    }
  }
  return { files: files.length, errors, warnings };
}

export function findLinkProblems(text, baseDir, root, docNames) {
  const problems = [];
  const lines = text.split("\n");
  let inFence = false;

  lines.forEach((line, index) => {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const at = index + 1;

    for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1].split("#")[0];
      if (target === "" || /^[a-z]+:/i.test(target)) continue;
      if (!existsSync(resolve(baseDir, decodeURI(target)))) {
        problems.push({ severity: "error", line: at, message: `ссылка ведёт на несуществующий файл: ${target}` });
      }
    }

    for (const match of line.matchAll(/(?<![\w.-])(\d{2}-[a-z0-9-]+\.md)/g)) {
      if (!docNames.has(match[1])) {
        problems.push({ severity: "error", line: at, message: `нет такого документа: ${match[1]}` });
      }
    }

    for (const match of line.matchAll(/`([^`\s]+)`/g)) {
      const path = codePath(match[1]);
      if (path !== null && !existsSync(join(root, path))) {
        problems.push({ severity: "warning", line: at, message: `путь не найден: ${path}` });
      }
    }
  });
  return problems;
}

/**
 * Путь к коду из содержимого обратных кавычек или `null`, если это не путь:
 * шаблоны, подстановки и «файл → ИМЯ» проверять нечем.
 */
export function codePath(raw) {
  const value = raw.split("→")[0].split(":")[0].trim().replace(/[.,;]+$/, "");
  if (!CODE_ROOTS.some((prefix) => value.startsWith(prefix))) return null;
  if (/[*<>{}…$]/.test(value)) return null;
  return value.replace(/\/$/, "");
}

function documentationFiles(root) {
  const files = [join(root, "CLAUDE.md"), join(root, "README.md")].filter((file) => existsSync(file));
  for (const name of readdirSync(join(root, "docs"))) {
    if (name.endsWith(".md")) files.push(join(root, "docs", name));
  }
  const skills = join(root, ".claude", "skills");
  if (existsSync(skills)) {
    for (const name of readdirSync(skills)) {
      const skill = join(skills, name, "SKILL.md");
      if (statSync(join(skills, name)).isDirectory() && existsSync(skill)) files.push(skill);
    }
  }
  return files;
}
