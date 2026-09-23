import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Сторонние actions — только по полному SHA коммита (docs/09-ci-cd.md §12,
 * docs/16-tech-stack-decisions.md §9).
 *
 * Тег вроде `@v4` владелец action волен перевесить на любой коммит, и
 * следующий прогон выполнит этот код с токеном репозитория и секретами
 * окружения. SHA перевесить нельзя. Версия пишется комментарием в той же
 * строке, иначе сорок знаков на ревью не прочитать:
 *
 *     uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
 *
 * Проверок две:
 *
 * - по тексту всех `.yml` в `.github/` (`checkPins`) — построчно, без разбора
 *   YAML: строку с `uses:`, которую проверка не поняла, она считает ошибкой, а
 *   не пропускает — иначе `{ uses: x@v4 }` прошёл бы мимо. Её прогоняет тест
 *   в `pnpm test`, то есть гейт CI и локальный прогон перед PR;
 * - по сети (`--verify`, `verifyPins`) — SHA совпадает с тегом из
 *   комментария в самом репозитории action. Идёт в `pr-checks.yml`: тестам
 *   в сеть ходить нельзя.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SHA_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const VERSION_RE = /^v?\d+\.\d+\.\d+$/;
const REPO_RE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
// Ключ в блочном стиле: `- uses: …` или `uses: …` (вызов переиспользуемого workflow).
const USES_KEY_RE = /^\s*(?:-\s+)?uses\s*:(.*)$/;
// Значение: ссылка без пробелов, в кавычках или без, и необязательный комментарий.
const USES_VALUE_RE = /^\s*(["']?)([^\s"'#]+)\1\s*(?:#\s*(.*?))?\s*$/;
const USES_ANYWHERE_RE = /\buses["']?\s*:/;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const verify = process.argv.includes("--verify");
  const report = checkPins(ROOT);
  const errors = [...report.errors, ...(verify ? verifyPins(report.pins, resolveTagCommit) : [])];
  for (const problem of errors) console.error(`ошибка  ${problem}`);
  const verified = verify ? ", сверено с тегами" : "";
  console.log(`\nФайлов: ${report.files}, закреплённых actions: ${report.pins.length}${verified}, ошибок: ${errors.length}`);
  if (errors.length > 0) process.exit(1);
}

export function checkPins(root) {
  const files = workflowFiles(join(root, ".github"));
  const pins = [];
  const errors = [];

  for (const file of files) {
    const where = relative(root, file).replaceAll("\\", "/");
    const { found, unparsed } = findUses(readFileSync(file, "utf8"));
    for (const line of unparsed) {
      errors.push(`${where}:${line} строка с \`uses:\` не в виде \`- uses: ссылка # версия\` — проверка её не разобрала`);
    }
    for (const use of found) {
      const result = classifyUses(use.ref, use.comment);
      if (result.kind === "problem") errors.push(`${where}:${use.line} ${result.message}`);
      if (result.kind === "pinned") pins.push({ ...result, where: `${where}:${use.line}` });
    }
  }
  return { files: files.length, pins, errors };
}

/** Все `uses:` файла с номерами строк; строки, где ключ есть, а разобрать не вышло, — отдельно. */
export function findUses(text) {
  const found = [];
  const unparsed = [];

  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    const key = USES_KEY_RE.exec(line);
    const value = key ? USES_VALUE_RE.exec(key[1] ?? "") : null;
    if (value) found.push({ line: index + 1, ref: value[2], comment: value[3] ?? "" });
    else if (USES_ANYWHERE_RE.test(line)) unparsed.push(index + 1);
  });
  return { found, unparsed };
}

/**
 * Одна ссылка `uses:` → закреплённый action или текст проблемы, сразу с тем,
 * как исправить. Локальные `./…` лежат в этом же репозитории и проходят ревью
 * вместе с PR — закреплять их не от чего.
 */
export function classifyUses(ref, comment) {
  if (ref.startsWith("./")) return { kind: "local" };

  const at = ref.lastIndexOf("@");
  const path = at > 0 ? ref.slice(0, at) : ref;
  const pin = at > 0 ? ref.slice(at + 1) : "";

  if (ref.startsWith("docker://")) {
    return DIGEST_RE.test(pin)
      ? { kind: "docker" }
      : problem(`${ref} — образ по тегу: закрепите по digest, \`${path}@sha256:<64 знака>\``);
  }

  const repo = path.split("/").slice(0, 2).join("/");
  if (!REPO_RE.test(repo)) return problem(`${ref} — не похоже на \`владелец/репозиторий@SHA\``);
  if (!SHA_RE.test(pin)) {
    return problem(
      `${ref} — не закреплён по SHA: тег или ветку владелец action может перевесить на другой код. ` +
        `Нужен полный SHA коммита, 40 знаков строчными, и версия комментарием: \`uses: ${path}@<SHA> # v1.2.3\``,
    );
  }
  if (!VERSION_RE.test(comment)) {
    return problem(
      `${ref} — нет версии комментарием в той же строке (\`# v1.2.3\`, полностью, не \`# v4\`): ` +
        "без неё на ревью не понять, что закреплено и на что обновляется",
    );
  }
  return { kind: "pinned", repo, path, sha: pin, version: comment };
}

/**
 * SHA из `uses:` — ровно тот коммит, на который в репозитории action указывает
 * тег из комментария. Сорок знаков глазами не сверить, и без этой проверки
 * ревьюер верит комментарию на слово. Она же отсекает коммит из форка: GitHub
 * исполнит его и по пути исходного репозитория, а тег исходного репозитория
 * на такой коммит не укажет.
 *
 * `resolveTag(repo, version)` отдаёт SHA коммита под тегом или null, если
 * тега нет. Пара «репозиторий + версия» спрашивается один раз, сколько бы
 * шагов её ни использовали. Сбой сети — тоже ошибка проверки, а не пропуск:
 * непроверенный SHA не должен выглядеть проверенным.
 */
export function verifyPins(pins, resolveTag) {
  const resolved = new Map();
  const errors = [];

  for (const pin of pins) {
    const key = `${pin.repo}@${pin.version}`;
    if (!resolved.has(key)) {
      try {
        resolved.set(key, { commit: resolveTag(pin.repo, pin.version) });
      } catch (error) {
        resolved.set(key, { failure: error instanceof Error ? error.message : String(error) });
      }
    }

    const { commit, failure } = resolved.get(key);
    if (failure !== undefined) {
      errors.push(`${pin.where} ${pin.repo}: не удалось прочитать теги, SHA не сверен — ${failure}`);
    } else if (commit === null) {
      errors.push(`${pin.where} в ${pin.repo} нет тега ${pin.version}: версия в комментарии ничем не подтверждена`);
    } else if (commit !== pin.sha) {
      errors.push(
        `${pin.where} ${pin.repo}: тег ${pin.version} указывает на ${commit}, а закреплён ${pin.sha} — ` +
          "это другая версия или коммит не из этого репозитория",
      );
    }
  }
  return errors;
}

/**
 * Коммит под тегом из вывода `git ls-remote`. Аннотированный тег — отдельный
 * объект, и коммит за ним стоит в строке `^{}`; у лёгкого тега такой строки
 * нет, и коммит — в строке самого тега.
 */
export function tagCommitFromLsRemote(output, version) {
  const refs = new Map(
    output
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => {
        const [sha, ref] = line.split("\t");
        return [ref, sha];
      }),
  );
  return refs.get(`refs/tags/${version}^{}`) ?? refs.get(`refs/tags/${version}`) ?? null;
}

/**
 * Теги — через `git ls-remote`, а не API: репозитории actions публичные, токен
 * не нужен, лимита запросов нет. `repo` и `version` уже прошли проверку формата
 * в `classifyUses`, так что в аргументы git не попадёт ничего похожего на ключ.
 *
 * Помощник учётных данных и запрос пароля выключены: на несуществующий
 * репозиторий GitHub отвечает требованием авторизации, и без этого проверка
 * повисла бы на вводе, а не упала.
 */
export function resolveTagCommit(repo, version) {
  const ref = `refs/tags/${version}`;
  let output;
  try {
    output = execFileSync(
      "git",
      ["-c", "credential.helper=", "ls-remote", "--tags", `https://github.com/${repo}`, ref, `${ref}^{}`],
      {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
    );
  } catch (error) {
    throw new Error(describeLsRemoteFailure(error), { cause: error });
  }
  return tagCommitFromLsRemote(output, version);
}

function describeLsRemoteFailure(error) {
  if (error?.code === "ETIMEDOUT") return "git ls-remote не ответил за 30 секунд";
  const stderr = String(error?.stderr ?? "").trim();
  if (stderr.includes("could not read Username")) return "репозитория нет или он закрыт: GitHub потребовал авторизацию";
  return stderr || String(error?.message ?? error);
}

function problem(message) {
  return { kind: "problem", message };
}

function workflowFiles(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...workflowFiles(full));
    else if (/\.ya?ml$/.test(name)) files.push(full);
  }
  return files.sort();
}
