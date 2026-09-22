/**
 * Ветки выпуска (docs/09-ci-cd.md §8.1, «Ветка dev»).
 *
 * В `main` выходят стабильные версии, в `dev` — предрелизы. Два PR между ними
 * служебные и метки релиза не несут по замыслу: релизный `dev` → `main`
 * выпускает номер, уже вычисленный предрелизами, а синк `main` → `dev` лишь
 * возвращает в `dev` срочные исправления и топологию релиза.
 */

export const STABLE_BRANCH = "main";
export const PRERELEASE_BRANCH = "dev";

export function isServicePr(headRef, baseRef) {
  return (
    (headRef === PRERELEASE_BRANCH && baseRef === STABLE_BRANCH) ||
    (headRef === STABLE_BRANCH && baseRef === PRERELEASE_BRANCH)
  );
}
