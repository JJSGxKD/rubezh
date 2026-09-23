import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Docker-образы — только точным тегом и digest (docs/09-ci-cd.md §12,
 * docs/16-tech-stack-decisions.md §9.4).
 *
 * Тег `postgres:17-alpine` перевешивают на каждый патч Postgres и Alpine, и CI,
 * машина разработчика и прод работают на разных образах, не зная об этом.
 * Если в ссылке есть digest, Docker берёт образ по нему, а тег остаётся
 * подписью для человека, поэтому тег — полная версия:
 *
 *     image: postgres:17.11-alpine3.24@sha256:<digest индекса, 64 знака>
 *
 * Проверяются `image:` в compose и workflow, `container:` в workflow и `FROM`
 * в Dockerfile, построчно и без разбора YAML. Строку с `image:`, которую
 * проверка не поняла, она считает ошибкой, а не пропускает, иначе
 * `{ image: postgres }` прошёл бы мимо. Сверх формы проверяется одно: у образа
 * во всём репозитории одна версия, иначе CI проверяет не ту базу, на которой
 * идёт разработка.
 *
 * Сверки с реестром по сети нет намеренно. Официальные образы пересобирают
 * под тем же тегом, когда выходит патч базовой системы, так что digest
 * `17.11-alpine3.24` со временем законно расходится с закреплённым. Проверка
 * на равенство падала бы в случайный день без правки в репозитории. Digest
 * ищется только в репозитории образа, чужой код под именем `postgres` он не
 * подставит.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
// Полная версия в начале тега: `17.11`, `7.4.11`, `22.22.3`, `v1.2.3`.
// Отсекает `latest`, `17`, `17-alpine`, `alpine`, `lts-slim`.
const VERSION_TAG_RE = /^v?\d+\.\d+/;
// Alpine в теге — только с версией: `-alpine` без неё перевешивают на новый
// Alpine, и по тегу уже не видно, на какой системе образ.
const BARE_ALPINE_RE = /(?:^|-)alpine(?!\d+\.\d+)/;
// Ключ в блочном стиле: `image: …` или `- image: …`.
const IMAGE_KEY_RE = /^\s*(?:-\s+)?image\s*:(.*)$/;
// `container: образ` — короткая форма в workflow; без значения это начало блока.
const CONTAINER_KEY_RE = /^\s*container\s*:\s*([^\s#].*)$/;
// Значение: ссылка без пробелов, в кавычках или без, и необязательный комментарий.
const VALUE_RE = /^\s*(["']?)([^\s"'#]+)\1\s*(?:#.*)?$/;
const IMAGE_ANYWHERE_RE = /\bimage["']?\s*:/;
const FROM_RE = /^\s*FROM\b(.*)$/i;

// Зависимости и результаты сборки: своих образов там нет, а обход дорог или
// находит чужие Dockerfile из пакетов. Скрытые каталоги — отдельно, в `imageFiles`.
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "var", "generated"]);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const report = checkImagePins(ROOT);
  for (const problem of report.errors) console.error(`ошибка  ${problem}`);
  console.log(`\nФайлов: ${report.files}, закреплённых образов: ${report.pins.length}, ошибок: ${report.errors.length}`);
  if (report.errors.length > 0) process.exit(1);
}

export function checkImagePins(root) {
  const files = imageFiles(root);
  const pins = [];
  const errors = [];

  for (const { path, where, kind } of files) {
    const text = readFileSync(path, "utf8");
    const { found, unparsed } = kind === "dockerfile" ? findFromImages(text) : findYamlImages(text, kind === "workflow");

    for (const line of unparsed) {
      errors.push(
        kind === "dockerfile"
          ? `${where}:${line} строка с FROM не в виде \`FROM [--ключ] образ [AS имя]\` — проверка её не разобрала`
          : `${where}:${line} строка с образом не в виде \`image: имя:версия@sha256:…\` — проверка её не разобрала`,
      );
    }
    for (const image of found) {
      const result = classifyImage(image.ref);
      if (result.kind === "problem") errors.push(`${where}:${image.line} ${result.message}`);
      if (result.kind === "pinned") pins.push({ ...result, where: `${where}:${image.line}` });
    }
  }
  return { files: files.length, pins, errors: [...errors, ...findVersionDrift(pins)] };
}

/**
 * `image:` из compose и workflow, в workflow — ещё короткая `container: образ`.
 * Строки, где ключ `image` есть, а разобрать не вышло, — отдельно.
 */
export function findYamlImages(text, isWorkflow) {
  const found = [];
  const unparsed = [];

  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    const key = IMAGE_KEY_RE.exec(line) ?? (isWorkflow ? CONTAINER_KEY_RE.exec(line) : null);
    const value = key ? VALUE_RE.exec(key[1] ?? "") : null;
    if (value) found.push({ line: index + 1, ref: value[2] });
    else if (key || IMAGE_ANYWHERE_RE.test(line)) unparsed.push(index + 1);
  });
  return { found, unparsed };
}

/**
 * Образы из `FROM` Dockerfile. Имя этапа многоэтапной сборки (`FROM base AS
 * deps`) и `scratch` — не образы из реестра, закреплять их не от чего.
 */
export function findFromImages(text) {
  const found = [];
  const unparsed = [];
  const stages = new Set();

  text.split(/\r?\n/).forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    const from = FROM_RE.exec(line);
    if (!from) return;

    const tokens = (from[1] ?? "").trim().split(/\s+/).filter(Boolean);
    // Ключи вроде `--platform=` стоят до образа.
    const imageAt = tokens.findIndex((token) => !token.startsWith("--"));
    const [ref, as, stage, ...rest] = imageAt === -1 ? [] : tokens.slice(imageAt);
    const withStage = as !== undefined && as.toLowerCase() === "as" && stage !== undefined;
    if (ref === undefined || rest.length > 0 || (as !== undefined && !withStage)) {
      unparsed.push(index + 1);
      return;
    }

    if (ref.toLowerCase() !== "scratch" && !stages.has(ref.toLowerCase())) found.push({ line: index + 1, ref });
    if (withStage) stages.add(stage.toLowerCase());
  });
  return { found, unparsed };
}

/**
 * Одна ссылка на образ → закреплённый образ или текст проблемы, сразу с тем,
 * как исправить.
 */
export function classifyImage(ref) {
  if (ref.includes("$")) {
    return problem(
      `${ref} — образ задан переменной: по файлу не видно, какой образ запустится. ` +
        "Нужна ссылка целиком: `имя:версия@sha256:<64 знака>`",
    );
  }

  const at = ref.indexOf("@");
  const named = at === -1 ? ref : ref.slice(0, at);
  const digest = at === -1 ? "" : ref.slice(at + 1);
  const colon = named.lastIndexOf(":");
  const hasTag = colon > named.lastIndexOf("/");
  const name = hasTag ? named.slice(0, colon) : named;
  const tag = hasTag ? named.slice(colon + 1) : "";

  if (!DIGEST_RE.test(digest)) {
    return problem(
      `${ref} — не закреплён по digest: тег перевешивают на каждый патч, и CI, машина разработчика и прод ` +
        `получают разные образы. Нужен digest индекса, 64 знака строчными: \`${name}:<версия>@sha256:<digest>\``,
    );
  }
  if (tag === "") {
    return problem(`${ref} — только digest, без тега: на ревью не видно, какая это версия. Нужно \`${name}:<версия>@${digest}\``);
  }
  if (!VERSION_TAG_RE.test(tag)) {
    return problem(
      `${ref} — тег \`${tag}\` плавающий: он не говорит, что закреплено. ` +
        "Нужна полная версия, как её пишет образ, например `17.11-alpine3.24`",
    );
  }
  if (BARE_ALPINE_RE.test(tag)) {
    return problem(`${ref} — у варианта alpine нет версии Alpine: нужно \`-alpine3.21\`, а не \`-alpine\``);
  }
  return { kind: "pinned", name: canonicalName(name), tag, digest, ref };
}

/**
 * Один образ — одна версия во всём репозитории. Обновили Postgres в
 * `docker-compose.yml` и забыли `ci.yml` — тесты зелёные на базе, на которой
 * никто не разрабатывает.
 */
export function findVersionDrift(pins) {
  const byName = new Map();
  for (const pin of pins) byName.set(pin.name, [...(byName.get(pin.name) ?? []), pin]);

  const errors = [];
  for (const [name, group] of byName) {
    const versions = new Set(group.map((pin) => `${pin.tag}@${pin.digest}`));
    if (versions.size < 2) continue;
    const places = group.map((pin) => `${pin.where} ${pin.tag}@${pin.digest.slice(0, 19)}…`).join(", ");
    errors.push(`${name} — разные версии в разных местах (${places}): обновляются все места разом`);
  }
  return errors;
}

/** `docker.io/library/postgres` и `postgres` — один образ. */
export function canonicalName(name) {
  return name.replace(/^(?:index\.)?docker\.io\//, "").replace(/^library\//, "");
}

function problem(message) {
  return { kind: "problem", message };
}

/**
 * Где искать образы: workflow, compose-файлы и Dockerfile по всему
 * репозиторию. Скрытые каталоги, кроме `.github`, пропускаются: в
 * `.claude/worktrees` лежат целые копии репозитория.
 */
function imageFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) {
        if (SKIP_DIRS.has(name) || (name.startsWith(".") && name !== ".github")) continue;
        walk(full);
        continue;
      }
      const where = relative(root, full).replaceAll("\\", "/");
      const kind = fileKind(where, name);
      if (kind !== null) files.push({ path: full, where, kind });
    }
  };
  walk(root);
  return files.sort((a, b) => (a.where < b.where ? -1 : a.where > b.where ? 1 : 0));
}

function fileKind(path, name) {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) return "workflow";
  if (/^(?:docker-)?compose(?:\.[\w-]+)*\.ya?ml$/.test(name)) return "compose";
  if (/^(?:Dockerfile|Containerfile)(?:\..+)?$/.test(name) || /\.(?:Dockerfile|Containerfile)$/.test(name)) return "dockerfile";
  return null;
}
