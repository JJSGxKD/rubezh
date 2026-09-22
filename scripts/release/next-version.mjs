import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isServicePr } from "./branches.mjs";
import {
  RELEASE_LEVELS,
  bumpVersion,
  compareReleaseLevels,
  formatVersion,
  latestPrereleaseTag,
  nextPrereleaseNumber,
  parseStableTag,
} from "./semver.mjs";
import { commitsSince, latestStableTag, listAllTags, pullRequestsForCommit } from "./git.mjs";

/**
 * Вычисление следующей версии (docs/09-ci-cd.md §8.1, «Вычисление номера»).
 *
 * Берутся все PR, влитые после последней базы, а не только текущий — джоб
 * релиза стоит в группе `concurrency` без отмены, и если за время одного
 * прогона встали два мерджа, метка отменённого прогона не должна теряться.
 *
 * База — максимальный стабильный тег по номеру, а не ближайший достижимый из
 * коммита. Это существенно для `dev`: тег релиза стоит на merge-коммите в
 * `main`, из `dev` он недостижим, и «достижимая» база откатилась бы к
 * предыдущему релизу — предрелиз получил бы номер уже вышедшей версии. А
 * `база..HEAD` сам отсекает выпущенное: те коммиты достижимы из тега через
 * второго родителя merge-коммита.
 *
 * Чистая часть тестируется без git и GitHub; CLI в конце файла подтягивает
 * коммиты и PR через `scripts/release/git.mjs`.
 */

export const CHANNELS = ["stable", "prerelease"];

function maxLevel(levels) {
  return levels.reduce((acc, level) => (compareReleaseLevels(level, acc) > 0 ? level : acc), "none");
}

function nextStableVersion(baseTagName, releaseLevels) {
  if (releaseLevels.length === 0) return null;
  const base = baseTagName ? parseStableTag(baseTagName) : { major: 0, minor: 0, patch: 0 };
  const level = maxLevel(releaseLevels);
  return level === "none" ? null : bumpVersion(base, level);
}

export function nextVersion(baseTagName, releaseLevels) {
  const version = nextStableVersion(baseTagName, releaseLevels);
  return version ? formatVersion(version) : null;
}

/**
 * Предрелиз из `dev`: `X.Y.Z` считается так же, как стабильный номер, а `rc.N`
 * — счётчик предрелизов этого номера. Поэтому стабильный релиз после мерджа
 * `dev` → `main` получает ровно номер последнего предрелиза без суффикса.
 */
export function nextPrereleaseVersion(baseTagName, releaseLevels, tags) {
  const version = nextStableVersion(baseTagName, releaseLevels);
  if (!version) return null;
  return `${formatVersion(version)}-rc.${nextPrereleaseNumber(version, tags)}`;
}

/** Заметки предрелиза — от предыдущего предрелиза того же номера, иначе от стабильной базы. */
export function prereleaseNotesStart(baseTagName, releaseLevels, tags) {
  const version = nextStableVersion(baseTagName, releaseLevels);
  if (!version) return baseTagName;
  return latestPrereleaseTag(version, tags) ?? baseTagName;
}

function releaseLevelOfPr(sha, pr) {
  const labels = (pr.labels ?? [])
    .map((label) => label.name)
    .filter((name) => name.startsWith("release: "))
    .map((name) => name.slice("release: ".length));

  if (labels.length !== 1 || !RELEASE_LEVELS.includes(labels[0])) {
    throw new Error(`PR #${pr.number} (коммит ${sha}) без ровно одной метки release: * — версия не вычисляется`);
  }
  return labels[0];
}

/**
 * Уровень релиза, который принёс коммит.
 *
 * GitHub связывает коммит со всеми PR, где он есть: с его собственным, со
 * стековым поверх него, с релизным `dev` → `main`. Поэтому учитываются только
 * смерженные — открытый стековый PR не должен влиять на версию того, что под
 * ним, — и не служебные: у релизного и синк-PR метки нет по замыслу. Если
 * настоящих PR несколько, берётся максимум: он не завышает итог, потому что
 * каждый из этих PR и так попадает в диапазон.
 *
 * Коммит, связанный только со служебным PR, — это сам его merge-коммит. Коммит
 * без смерженного PR — прямой push; джоб должен упасть, а не молча посчитать
 * его патчем.
 */
export function releaseLevelForCommit(sha, pullRequests) {
  const merged = pullRequests.filter((pr) => pr.merged_at);
  const real = merged.filter((pr) => !isServicePr(pr.head?.ref, pr.base?.ref));

  if (real.length === 0) {
    if (merged.length > 0) return "none";
    throw new Error(`коммит ${sha} слит без PR (прямой push?) — версия не вычисляется`);
  }
  return maxLevel(real.map((pr) => releaseLevelOfPr(sha, pr)));
}

/**
 * Строка для лога релизного джоба. «Новых коммитов нет» и «все PR с меткой
 * none» — разные ситуации: первая означает, что ветка стоит на теге, вторая —
 * что в неё что-то влили, но выпускать нечего. По одной строке лога их надо
 * различать.
 */
export function releaseSummary(baseTagName, commitCount, version) {
  if (version) return `следующая версия: ${version}`;
  const base = baseTagName ?? "начала истории";
  if (commitCount === 0) return `новых коммитов после ${base} нет — тега не будет`;
  return `все PR после ${base} — release: none, тега не будет`;
}

function main() {
  const channel = process.env.RELEASE_CHANNEL ?? "stable";
  if (!CHANNELS.includes(channel)) {
    throw new Error(`RELEASE_CHANNEL=${channel}: допустимо ${CHANNELS.join(" или ")}`);
  }

  const baseTag = latestStableTag();
  const commits = commitsSince(baseTag);
  const releaseLevels = commits.map((sha) => releaseLevelForCommit(sha, pullRequestsForCommit(sha)));

  const prerelease = channel === "prerelease";
  const tags = prerelease ? listAllTags() : [];
  const version = prerelease ? nextPrereleaseVersion(baseTag, releaseLevels, tags) : nextVersion(baseTag, releaseLevels);
  const notesStart = prerelease ? prereleaseNotesStart(baseTag, releaseLevels, tags) : baseTag;

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `version=${version ?? ""}`,
        `previous_tag=${notesStart ?? ""}`,
        `has_release=${version ? "true" : "false"}`,
        `prerelease=${prerelease ? "true" : "false"}`,
        "",
      ].join("\n"),
    );
  }
  console.log(releaseSummary(baseTag, commits.length, version));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
