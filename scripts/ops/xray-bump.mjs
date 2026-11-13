import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Обновление ядра Xray по версии выпуска (docs/35-stage4-plan.md Р202,
 * tasks/T-0417): помощник для `.github/workflows/xray-bump.yml`. Правит ровно
 * две строки — `FROM … AS xray` в Dockerfile спутника и `XRAY_CORE_MAX` в
 * `packages/proxy-kit/src/xray-core.ts` — и собирает описание PR. Вход
 * workflow недоверенный (его вводит человек или сервер), поэтому каждая
 * функция сама проверяет версию и digest: в файл попадёт только то, что
 * совпало со строгой формой, а любая ошибка — до записи.
 */

export const VERSION_RE = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
export const DOCKERFILE = "infra/prod/xray/Dockerfile";
export const CORE_FILE = "packages/proxy-kit/src/xray-core.ts";

const RELEASE_URL_RE = /^https:\/\/github\.com\/XTLS\/Xray-core\/releases\/[A-Za-z0-9._\/-]+$/;
const LOG_TAIL_LINES = 60;

/** Строка образа: любая, которая начинается с нашего образа; ровно одна на файл. */
const FROM_ANY = /^FROM ghcr\.io\/xtls\/xray-core/gm;
/** Её строгий вид; `\r?$` — чтобы CRLF не мешал и остался на месте. */
const FROM_STRICT = /^FROM ghcr\.io\/xtls\/xray-core:([0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4})@(sha256:[0-9a-f]{64}) AS xray(?=\r?$)/gm;
const MAX_ANY = /^export const XRAY_CORE_MAX\b/gm;
const MAX_STRICT = /^export const XRAY_CORE_MAX = "[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}";(?=\r?$)/gm;

function assertVersion(version) {
  if (typeof version !== "string" || !VERSION_RE.test(version)) {
    throw new Error("Версия должна быть тремя числами через точку, без «v», например 26.11.5");
  }
}

function assertDigest(digest) {
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) {
    throw new Error("Digest образа должен быть вида sha256:<64 строчных шестнадцатеричных знака>");
  }
}

/** Ровно одно совпадение строгого вида и ни одной «похожей» строки сверх него. */
function assertOneLine(text, loose, strict, what) {
  const found = (text.match(loose) ?? []).length;
  const exact = (text.match(strict) ?? []).length;
  if (found !== 1 || exact !== 1) {
    throw new Error(`${what}: нужна ровно одна строка известного вида, найдено ${found} (подходящих по виду — ${exact})`);
  }
}

export function branchOf(version) {
  assertVersion(version);
  return `chore/xray-core-${version}`;
}

export function titleOf(version) {
  assertVersion(version);
  return `chore(infra): Обнови ядро Xray до ${version}`;
}

/** Версия из строки `FROM … AS xray`; нет строки или их две — исключение. */
export function currentVersion(dockerfile) {
  assertOneLine(dockerfile, FROM_ANY, FROM_STRICT, "Dockerfile спутника Xray");
  const match = new RegExp(FROM_STRICT.source, "m").exec(dockerfile);
  return match?.[1] ?? "";
}

/** Новая строка `FROM`, всё остальное — как было, включая переводы строк. */
export function bumpDockerfile(text, version, digest) {
  assertVersion(version);
  assertDigest(digest);
  assertOneLine(text, FROM_ANY, FROM_STRICT, "Dockerfile спутника Xray");
  return text.replace(FROM_STRICT, () => `FROM ghcr.io/xtls/xray-core:${version}@${digest} AS xray`);
}

/** Новая строка `XRAY_CORE_MAX`; `XRAY_CORE_MIN` и блоки не трогаются. */
export function bumpCoreMax(text, version) {
  assertVersion(version);
  assertOneLine(text, MAX_ANY, MAX_STRICT, "packages/proxy-kit/src/xray-core.ts");
  return text.replace(MAX_STRICT, () => `export const XRAY_CORE_MAX = "${version}";`);
}

/** Последние строки лога; ограждение кода в нём заменено, чтобы не закрыть блок описания. */
function logTail(log) {
  const lines = String(log).replace(/\r\n/g, "\n").replace(/```/g, "'''").trimEnd().split("\n");
  return lines.slice(-LOG_TAIL_LINES).join("\n");
}

/** Описание PR по формату скилла pre-pr, без раздела «Для игроков»: игрок ядро не видит. */
export function prBody({ version, previous, digest, releaseUrl, checkOk, checkLog, number }) {
  assertVersion(version);
  assertVersion(previous);
  assertDigest(digest);
  if (typeof releaseUrl !== "string" || !RELEASE_URL_RE.test(releaseUrl)) {
    throw new Error("Адрес выпуска должен вести на https://github.com/XTLS/Xray-core/releases/…");
  }
  if (number !== null && !Number.isInteger(number)) throw new Error("Номер PR должен быть целым числом или null");

  const verdict = checkOk
    ? "✅ `check-config.sh` прошёл на новом ядре."
    : "❌ `check-config.sh` не прошёл — PR черновиком. Поправьте таблицу `F` в `packages/proxy-kit/src/xray-config.ts` и золотые конфиги или заведите блок версии в `XRAY_CORE_BLOCKS`.";
  const log = logTail(checkLog);
  const prNumber = number === null ? "<номер>" : String(number);
  const summary = checkOk
    ? `Ядро Xray обновится с ${previous} до ${version} с ближайшим выпуском; наш конфиг на новом ядре проверен check-config.sh.`
    : `Ядро Xray ${version} не принял наш конфиг: check-config.sh не прошёл, PR открыт черновиком. Нужно поправить таблицу имён полей или завести блок версии.`;

  return [
    `Обновление ядра Xray \`${previous}\` → \`${version}\`, запущено из панели («Прокси» → «Ядро Xray», Р202).`,
    "",
    `- выпуск: ${releaseUrl}`,
    `- образ: \`ghcr.io/xtls/xray-core:${version}@${digest}\``,
    `- \`XRAY_CORE_MAX\` в \`packages/proxy-kit/src/xray-core.ts\` — \`${version}\``,
    "",
    "## Проверка конфига",
    "",
    verdict,
    "",
    "```",
    log,
    "```",
    "",
    "PR открыт токеном workflow — по правилам GitHub CI на нём не запускается сам. Гейт: закрыть и снова открыть PR.",
    "",
    "## Сводка для команды",
    "",
    `📋 **СВОДКА: В DEV ВЛИТ PR #${prNumber} — ОБНОВИ ЯДРО XRAY ДО ${version}**`,
    "",
    summary,
    "",
  ].join("\n");
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readRepo(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Оба текста готовятся в памяти и пишутся после: ошибка в любом — ни один файл не тронут. */
function apply(version, digest) {
  const dockerfile = bumpDockerfile(readRepo(DOCKERFILE), version, digest);
  const core = bumpCoreMax(readRepo(CORE_FILE), version);
  writeFileSync(join(ROOT, DOCKERFILE), dockerfile);
  writeFileSync(join(ROOT, CORE_FILE), core);
}

function main(argv) {
  const [command, ...args] = argv;
  switch (command) {
    case "check-version":
      assertVersion(args[0]);
      return;
    case "check-digest":
      assertDigest(args[0]);
      return;
    case "branch":
      console.log(branchOf(args[0]));
      return;
    case "title":
      console.log(titleOf(args[0]));
      return;
    case "current":
      console.log(currentVersion(readRepo(DOCKERFILE)));
      return;
    case "apply":
      apply(args[0], args[1]);
      return;
    case "body": {
      const [version, previous, digest, releaseUrl, ok, logFile, number] = args;
      if (ok !== "true" && ok !== "false") throw new Error("Итог проверки — true или false");
      if (number !== undefined && !/^[0-9]{1,9}$/.test(number)) throw new Error("Номер PR — целое число");
      const log = logFile === undefined ? "" : readFileSync(logFile, "utf8");
      process.stdout.write(prBody({ version, previous, digest, releaseUrl, checkOk: ok === "true", checkLog: log, number: number === undefined ? null : Number(number) }));
      return;
    }
    default:
      throw new Error("Команда: check-version | check-digest | branch | title | current | apply | body");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
