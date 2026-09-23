import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { deleteRelease, deleteRemoteTag, pushTag, remoteTagSha } from "./git.mjs";

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
 * Чистая часть тестируется без git; CLI в конце файла вызывается из
 * `.github/workflows/ci.yml` командами `create` и `rollback`.
 */

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

function create() {
  const head = requireEnv("GITHUB_SHA");
  const version = requireEnv("VERSION");

  const push = pushTag(head, version);
  if (!push.ok) throw new Error(`тег ${version} не создан:\n${push.message}`);
  console.log(push.message);
  writeOutput({ created: "true" });
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

const COMMANDS = { create, rollback };

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
