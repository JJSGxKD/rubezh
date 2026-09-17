import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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
export function nextVersion(baseTagName, releaseLevels) {
  if (releaseLevels.length === 0) return null;

  const base = baseTagName ? parseStableTag(baseTagName) : { major: 0, minor: 0, patch: 0 };
  const maxLevel = releaseLevels.reduce(
    (acc, level) => (compareReleaseLevels(level, acc) > 0 ? level : acc),
    "none",
  );
  if (maxLevel === "none") return null;

  return formatVersion(bumpVersion(base, maxLevel));
}

/** Коммит без PR или без ровно одной метки `release: *` — джоб должен упасть, а не молча посчитать патчем. */
export function releaseLevelForCommit(sha, pullRequests) {
  if (pullRequests.length === 0) {
    throw new Error(`коммит ${sha} слит без PR (прямой push в main?) — версия не вычисляется`);
  }
  const pr = pullRequests[0];
  const labels = (pr.labels ?? [])
    .map((label) => label.name)
    .filter((name) => name.startsWith("release: "))
    .map((name) => name.slice("release: ".length));

  if (labels.length !== 1 || !RELEASE_LEVELS.includes(labels[0])) {
    throw new Error(`PR #${pr.number} (коммит ${sha}) без ровно одной метки release: * — версия не вычисляется`);
  }
  return labels[0];
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
