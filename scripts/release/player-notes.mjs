import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PRERELEASE_BRANCH, STABLE_BRANCH, isServicePr } from "./branches.mjs";
import { commitsSince, latestStableTag, mergedPullRequests } from "./git.mjs";
import { extractSection } from "./team-summary.mjs";

/**
 * Строки журнала обновлений из описаний PR (docs/35-stage4-plan.md WP31,
 * docs/09-ci-cd.md §8.1, «Журнал обновлений»). Автор PR пишет раздел
 * «## Для игроков» — что изменилось для игрока, одно изменение на строку:
 *
 *   ## Для игроков
 *
 *   - новое: Журнал обновлений — в меню «Что нового»
 *   - исправлено [vk]: Звук больше не пропадает после рекламы
 *
 * Вид — новое, изменено или исправлено; площадки в скобках — если строка не
 * для всех. Проверка PR (`pr-check.mjs`) ловит ошибки формата до мерджа,
 * релизный джоб собирает строки всех PR выпуска в файл релиза, выкат заводит
 * их черновиками — публикует человек в панели.
 *
 * Разбор и сборка — чистые функции ниже, их покрывают тесты; CLI в конце —
 * обвязка над `gh`.
 */

export const PLAYER_NOTES_SECTION = "Для игроков";
export const PLAYER_NOTE_KINDS = { новое: "added", изменено: "changed", исправлено: "fixed" };
export const PLAYER_NOTE_PLATFORMS = ["telegram", "max", "vk", "web"];
/** Потолок строки — тот же, что у журнала на сервере (`changelog-rules.ts`). */
export const PLAYER_NOTE_TEXT_MAX = 500;

const NOTHING = /^(нет|—|–|-)$/iu;
const LINE = /^[-*]\s+([^\s:[]+)\s*(?:\[([^\]]*)\])?\s*:\s*(.*)$/u;
/** Разметку игрок увидит как есть: журнал показывает простой текст. */
const MARKUP = /`|\*\*|\]\(/u;

function lineProblem(line) {
  return `строка «${line.length > 60 ? `${line.slice(0, 60)}…` : line}»`;
}

/**
 * Строки раздела и ошибки формата. Нет раздела, он пуст или в нём «нет» —
 * ни строк, ни ошибок: не каждый PR меняет что-то для игрока.
 */
export function parsePlayerNotes(body) {
  const section = extractSection(body, PLAYER_NOTES_SECTION);
  const notes = [];
  const errors = [];
  if (section === null) return { notes, errors };

  for (const raw of section.split("\n")) {
    const line = raw.trim();
    if (line === "" || NOTHING.test(line)) continue;
    const match = LINE.exec(line);
    if (match === null) {
      errors.push(`${lineProblem(line)}: ожидается «- новое: текст», «- изменено [vk]: текст» или «- исправлено: текст»`);
      continue;
    }
    const [, kindWord, platformList, rawText] = match;
    const kind = PLAYER_NOTE_KINDS[kindWord.toLowerCase()];
    if (kind === undefined) {
      errors.push(`${lineProblem(line)}: вид «${kindWord}» — новое, изменено или исправлено`);
      continue;
    }
    const named = (platformList ?? "")
      .toLowerCase()
      .split(/[\s,]+/u)
      .filter((name) => name !== "" && name !== "все");
    const unknown = named.filter((name) => !PLAYER_NOTE_PLATFORMS.includes(name));
    if (unknown.length > 0) {
      errors.push(`${lineProblem(line)}: площадки — ${PLAYER_NOTE_PLATFORMS.join(", ")}, а не ${unknown.join(", ")}`);
      continue;
    }
    const text = rawText.trim();
    if (text === "") {
      errors.push(`${lineProblem(line)}: после двоеточия — что изменилось для игрока`);
      continue;
    }
    if (text.length > PLAYER_NOTE_TEXT_MAX) {
      errors.push(`${lineProblem(line)}: строка длиннее ${PLAYER_NOTE_TEXT_MAX} знаков — одно изменение, а не заметка к релизу`);
      continue;
    }
    if (MARKUP.test(text)) {
      errors.push(`${lineProblem(line)}: простой текст — разметку игрок увидит как есть`);
      continue;
    }
    notes.push({ kind, platforms: PLAYER_NOTE_PLATFORMS.filter((platform) => named.includes(platform)), text });
  }
  return { notes, errors };
}

/** Версия журнала по тегу выпуска: у предрелиза — номер, которым он станет. */
export function changelogVersion(tag) {
  const match = /^v(\d+\.\d+\.\d+)(?:-rc\.\d+)?$/u.exec(tag ?? "");
  return match === null ? null : match[1];
}

/**
 * Строки всех PR выпуска: влитые, не служебные, с коммитом мерджа в
 * диапазоне после стабильной базы — тот же набор, из которого считается
 * версия. Порядок — по времени мерджа; ключ `pr-<номер>-<строка>` —
 * по нему выкат узнаёт строку в следующем предрелизе и не задваивает её.
 * Строки с ошибкой формата (описание правили после мерджа) пропускаются с
 * предупреждением.
 */
export function collectPlayerNotes(pullRequests, commitShas) {
  const seen = new Set();
  const releasePrs = pullRequests
    .filter((pr) => pr.merged_at && !isServicePr(pr.head?.ref, pr.base?.ref) && commitShas.has(pr.merge_commit_sha))
    .filter((pr) => (seen.has(pr.number) ? false : (seen.add(pr.number), true)))
    .sort((a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at) || a.number - b.number);

  const entries = [];
  const warnings = [];
  for (const pr of releasePrs) {
    const { notes, errors } = parsePlayerNotes(pr.body);
    for (const error of errors) warnings.push(`PR #${pr.number}: ${error} — пропущена`);
    notes.forEach((note, index) => entries.push({ key: `pr-${pr.number}-${index + 1}`, pr: pr.number, ...note }));
  }
  return { entries, warnings };
}

function main() {
  const out = process.argv[2];
  const tag = process.env.VERSION ?? "";
  if (!out) throw new Error("укажите файл: node scripts/release/player-notes.mjs changelog.json");
  const version = changelogVersion(tag);
  if (version === null) throw new Error(`VERSION=${tag}: ожидается тег выпуска vX.Y.Z или vX.Y.Z-rc.N`);

  let entries = [];
  try {
    // База — прежний стабильный тег: шаг идёт до того, как поставлен тег этого выпуска.
    const base = latestStableTag();
    const shas = new Set(commitsSince(base));
    const pullRequests = [...mergedPullRequests(PRERELEASE_BRANCH), ...mergedPullRequests(STABLE_BRANCH)];
    const collected = collectPlayerNotes(pullRequests, shas);
    for (const warning of collected.warnings) console.warn(`внимание  ${warning}`);
    entries = collected.entries;
    console.log(`журнал ${version}: строк для игроков — ${entries.length} из PR после ${base ?? "начала истории"}`);
  } catch (error) {
    // Журнал не стоит выпуска: файл уходит пустым, выкат ничего не заведёт,
    // строки напишут в панели. Предупреждение видно в сводке прогона.
    console.log(`::warning::строки журнала не собраны — файл релиза пустой: ${error instanceof Error ? error.message : String(error)}`);
  }
  writeFileSync(out, `${JSON.stringify({ version, release: tag, entries }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
