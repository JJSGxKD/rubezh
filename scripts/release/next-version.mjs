import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { isServicePr } from "./branches.mjs";
import { RELEASE_LEVELS, bumpVersion, compareReleaseLevels, formatVersion, parseStableTag } from "./semver.mjs";
import { commitsSince, latestStableTag, pullRequestsForCommit } from "./git.mjs";

/**
 * Вычисление следующей версии (docs/09-ci-cd.md §8.1, «Вычисление номера»).
 *
 * Берутся все PR, влитые после последней базы, а не только текущий — джоб
 * релиза стоит в группе `concurrency` без отмены, и если за время одного
 * прогона встали два мерджа, метка отменённого прогона не должна теряться.
 *
 * Чистая часть (эта функция) тестируется без обращения к git/GitHub; CLI в
 * конце файла подтягивает коммиты и метки PR через `scripts/release/git.mjs`.
 */
function maxLevel(levels) {
  return levels.reduce((acc, level) => (compareReleaseLevels(level, acc) > 0 ? level : acc), "none");
}

export function nextVersion(baseTagName, releaseLevels) {
  if (releaseLevels.length === 0) return null;

  const base = baseTagName ? parseStableTag(baseTagName) : { major: 0, minor: 0, patch: 0 };
  const level = maxLevel(releaseLevels);
  return level === "none" ? null : formatVersion(bumpVersion(base, level));
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

function main() {
  const baseTag = latestStableTag();
  const commits = commitsSince(baseTag);
  const releaseLevels = commits.map((sha) => releaseLevelForCommit(sha, pullRequestsForCommit(sha)));
  const version = nextVersion(baseTag, releaseLevels);

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${version ?? ""}\nprevious_tag=${baseTag ?? ""}\nhas_release=${version ? "true" : "false"}\n`,
    );
  }
  console.log(version ? `следующая версия: ${version}` : "все PR с этой базы — release: none, тега не будет");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
