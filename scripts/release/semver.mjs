/**
 * SemVer-примитивы для скриптов релиза (docs/09-ci-cd.md §8.1).
 *
 * Разбор и сравнение — чистые функции, без обращения к git или GitHub API:
 * это единственная точка правды про формат тега `vX.Y.Z`, которую используют
 * и вычисление версии, и проверка PR.
 */

const STABLE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)$/;
const PRERELEASE_TAG_RE = /^v(\d+)\.(\d+)\.(\d+)-rc\.(\d+)$/;

export const RELEASE_LEVELS = ["none", "patch", "minor", "major"];

export function parseStableTag(tag) {
  const match = STABLE_TAG_RE.exec(tag);
  if (!match) return null;
  const [, major, minor, patch] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch) };
}

export function parsePrereleaseTag(tag) {
  const match = PRERELEASE_TAG_RE.exec(tag);
  if (!match) return null;
  const [, major, minor, patch, rc] = match;
  return { version: { major: Number(major), minor: Number(minor), patch: Number(patch) }, rc: Number(rc) };
}

export function formatVersion(version) {
  return `v${version.major}.${version.minor}.${version.patch}`;
}

function sameVersion(a, b) {
  return a.major === b.major && a.minor === b.minor && a.patch === b.patch;
}

/**
 * Следующий номер предрелиза того же `X.Y.Z` — от максимального, а не от числа
 * тегов: удалённый руками `rc.2` не должен заставить следующий прогон выпустить
 * `rc.3` второй раз.
 */
export function nextPrereleaseNumber(version, tags) {
  let max = 0;
  for (const tag of tags) {
    const parsed = parsePrereleaseTag(tag);
    if (parsed && sameVersion(parsed.version, version) && parsed.rc > max) max = parsed.rc;
  }
  return max + 1;
}

/** Последний предрелиз того же `X.Y.Z` — от него строятся заметки следующего. */
export function latestPrereleaseTag(version, tags) {
  const rc = nextPrereleaseNumber(version, tags) - 1;
  return rc === 0 ? null : `${formatVersion(version)}-rc.${rc}`;
}

export function compareReleaseLevels(a, b) {
  return RELEASE_LEVELS.indexOf(a) - RELEASE_LEVELS.indexOf(b);
}

/** Ломающее изменение до `1.0.0` — метка `minor` с `!` в заголовке, не `major` (docs/09-ci-cd.md §8.1). */
export function bumpVersion(base, level) {
  if (level === "major" && base.major === 0) {
    throw new Error(`release: major запрещена до 1.0.0 (текущая база v${base.major}.${base.minor}.${base.patch})`);
  }
  if (level === "major") return { major: base.major + 1, minor: 0, patch: 0 };
  if (level === "minor") return { major: base.major, minor: base.minor + 1, patch: 0 };
  if (level === "patch") return { major: base.major, minor: base.minor, patch: base.patch + 1 };
  return null;
}
