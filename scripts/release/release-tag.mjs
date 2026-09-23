import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { deleteRelease, deleteRemoteTag, fetchBranchTip, isAncestor, pushTag, remoteTagSha } from "./git.mjs";

/**
 * Тег релиза и его откат (docs/09-ci-cd.md §8.1, «Порядок публикации»).
 *
 * Тег — первое, что джоб релиза выставляет наружу. Из всех шагов публикации
 * отказать может именно он: GitHub не даёт токену workflow создать ref на
 * коммит, чьи `.github/workflows` не совпадают ни с одной вершиной ветки. До
 * тега не должно появиться ничего с номером версии — иначе отказ оставит в
 * реестре образ под номером, которого нет в git. Образ и релиз идут после
 * тега, и если они не опубликовались, тег откатывается.
 *
 * Выпускается только вершина ветки (§8.1, «Выпускается вершина ветки»). Тот
 * самый отказ GitHub случается, когда в ветку, пока шёл релиз, влили PR с
 * правкой workflow: коммит прогона перестал быть вершиной, и токену workflow
 * ставить на него тег нельзя. Такой коммит выпустит прогон новой вершины.
 *
 * Чистая часть тестируется без git; CLI в конце файла вызывается из
 * `.github/workflows/ci.yml` командами `check`, `create` и `rollback`.
 */

/**
 * Где коммит прогона относительно вершины своей ветки сейчас.
 *
 * `current` — он и есть вершина, тег ставится. `superseded` — в ветку уже
 * влили следующий PR: отдельного предрелиза этот коммит не получает, его
 * выпустит прогон вершины, а next-version.mjs считает метки всех PR с базы,
 * так что метка этого PR в тот номер попадёт. Ветки нет или коммита в ней нет —
 * история переписана, и молча выпускать что-либо нельзя.
 */
export function tipStatus({ branch, head, tip, headInTip }) {
  if (tip === null) throw new Error(`ветки ${branch} на удалённом нет — тег не ставится`);
  if (tip === head) return "current";
  if (headInTip) return "superseded";
  throw new Error(`в ветке ${branch} (вершина ${tip}) нет коммита ${head} — история переписана? Тег не ставится`);
}

/** Отказ GitHub в ref на коммит, чьи `.github/workflows` не совпадают ни с одной вершиной ветки. */
export function isWorkflowsRefusal(message) {
  return /refusing to allow a GitHub App to create or update workflow/i.test(message);
}

function currentTip({ branch, head }, io) {
  const tip = io.fetchBranchTip(branch);
  const headInTip = tip !== null && tip !== head && io.isAncestor(head, tip);
  return { tip, status: tipStatus({ branch, head, tip, headInTip }) };
}

/**
 * Тег на коммит прогона, если тот ещё вершина ветки. `io` — git и GitHub; в
 * тестах подменяется, потому что гонку «ветка ушла между проверкой и push» на
 * настоящем git не поставить.
 */
export function createReleaseTag({ branch, head, version }, io) {
  const before = currentTip({ branch, head }, io);
  if (before.status === "superseded") return { created: false, tip: before.tip, refusal: null, message: "" };

  const push = io.pushTag(head, version);
  if (push.ok) return { created: true, tip: head, refusal: null, message: push.message };

  // Ветка ушла, пока шла сборка: GitHub отказывает в ref, если workflow
  // коммита не совпадают ни с одной вершиной ветки, — это тот же обгон, что и
  // выше, а не поломка.
  const after = currentTip({ branch, head }, io);
  if (after.status === "superseded") return { created: false, tip: after.tip, refusal: push.message, message: "" };

  const hint = isWorkflowsRefusal(push.message)
    ? "\nGitHub отказал из-за .github/workflows, хотя коммит — вершина ветки: правило GitHub поменялось? " +
      "Разбор — docs/09-ci-cd.md §8.1, «Ловушки»."
    : "";
  throw new Error(`тег ${version} не создан:\n${push.message}${hint}`);
}

/** Строка сводки прогона для коммита, который обогнала ветка. */
export function supersededNotice({ branch, head, tip, version, refusal }) {
  const why = refusal ? ", и GitHub отказал в теге на прежнюю вершину" : "";
  return (
    `${version} не выпущен из ${head.slice(0, 7)}: в ${branch} уже влит следующий PR (вершина ${tip.slice(0, 7)})${why}. ` +
    "Эти изменения выпустит прогон вершины — метка этого PR войдёт в его номер " +
    "(docs/09-ci-cd.md §8.1, «Выпускается вершина ветки»)."
  );
}

/**
 * Что делать с тегом, когда публикация после него сорвалась. Пока образа с
 * номером версии нет, тег удаляется: номер без образа не на что деплоить, а
 * следующий прогон посчитает тот же номер заново. Образ уже в реестре — тег
 * остаётся при нём: образ без тега хуже неопубликованного черновика релиза,
 * который выкладывается одной командой.
 */
export function rollbackPlan({ imagePushed }) {
  return imagePushed ? "keep" : "delete";
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} не задан — скрипт вызывается из джоба релиза`);
  return value;
}

function writeOutput(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

function writeSummary(text) {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

/** Обгон — не ошибка: заметка на странице прогона, а не красный джоб. */
function reportSuperseded(notice) {
  console.log(`::notice title=Предрелиз не нужен::${notice}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${notice}\n`);
}

const GIT_IO = { fetchBranchTip, isAncestor, pushTag };

function check() {
  const head = requireEnv("GITHUB_SHA");
  const branch = requireEnv("RELEASE_BRANCH");
  const version = requireEnv("VERSION");

  const { tip, status } = currentTip({ branch, head }, GIT_IO);
  if (status === "superseded") reportSuperseded(supersededNotice({ branch, head, tip, version, refusal: null }));
  writeOutput({ current: status === "current" ? "true" : "false" });
}

function create() {
  const head = requireEnv("GITHUB_SHA");
  const branch = requireEnv("RELEASE_BRANCH");
  const version = requireEnv("VERSION");

  const result = createReleaseTag({ branch, head, version }, GIT_IO);
  if (result.created) {
    console.log(result.message);
  } else {
    if (result.refusal) console.log(result.refusal);
    reportSuperseded(supersededNotice({ branch, head, tip: result.tip, version, refusal: result.refusal }));
  }
  writeOutput({ created: result.created ? "true" : "false" });
}

function rollback() {
  const head = requireEnv("GITHUB_SHA");
  const version = requireEnv("VERSION");

  if (rollbackPlan({ imagePushed: process.env.IMAGE_PUSHED === "true" }) === "keep") {
    writeSummary(
      `Тег ${version} и образ опубликованы, релиз — нет. Выложить черновик: \`gh release edit ${version} --draft=false\``,
    );
    return;
  }

  const releaseDeleted = deleteRelease(version);
  const tagSha = remoteTagSha(version);
  // Чужой тег не трогаем: create отдаёт created=true, только если тег встал
  // на коммит этого прогона, но между шагами его могли переставить руками.
  if (tagSha !== null && tagSha !== head) {
    throw new Error(`тег ${version} указывает на ${tagSha}, а не на ${head} — откат не трогает чужой тег`);
  }
  if (tagSha !== null) deleteRemoteTag(version);
  writeSummary(
    `Публикация сорвалась до образа: тег ${version}${releaseDeleted ? " и черновик релиза" : ""} удалены. ` +
      "Следующий прогон посчитает тот же номер заново.",
  );
}

const COMMANDS = { check, create, rollback };

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const command = COMMANDS[process.argv[2] ?? ""];
    if (!command) throw new Error(`команда: ${Object.keys(COMMANDS).join(" | ")}`);
    command();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
