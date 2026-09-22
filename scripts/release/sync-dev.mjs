import { pathToFileURL } from "node:url";
import { PRERELEASE_BRANCH, STABLE_BRANCH } from "./branches.mjs";
import { createPullRequest, isAncestor, openPullRequestExists, pushRef, remoteBranchExists } from "./git.mjs";

/**
 * Возврат `main` в `dev` после каждого push в `main` (docs/09-ci-cd.md §8.1,
 * «Ветка dev»).
 *
 * Без него срочное исправление, выпущенное прямо в `main`, не попадёт в `dev`,
 * и следующий релиз `dev` → `main` либо потеряет его, либо принесёт конфликт.
 *
 * Чаще всего `dev` за время релиза вперёд не ушёл — тогда он просто
 * перематывается на `main`, без PR: в `main` нет ничего, чего не видел `dev`,
 * кроме самого merge-коммита релиза. Если ушёл — открывается PR, потому что
 * слияние двух веток с разным кодом должен увидеть человек.
 */
export function syncAction({ devExists, mainInDev, devInMain }) {
  if (!devExists) return "none";
  if (mainInDev) return "none";
  if (devInMain) return "fast-forward";
  return "pull-request";
}

const PR_TITLE = "chore(release): Вернуть изменения main в dev";
const PR_BODY = [
  "Служебный PR: в `main` есть коммиты, которых нет в `dev`, — чаще всего",
  "срочное исправление. Метка релиза не нужна: изменения уже выпущены в `main`.",
  "",
  "Вливается **merge-коммитом**, как любой PR (`docs/09-ci-cd.md` §8).",
  "",
  "PR открыт токеном workflow, а такие PR по правилам GitHub не запускают CI.",
  "Гейт на нём запускается вручную: закрыть и снова открыть PR.",
].join("\n");

function main() {
  const devExists = remoteBranchExists(PRERELEASE_BRANCH);
  const dev = `origin/${PRERELEASE_BRANCH}`;
  const action = syncAction({
    devExists,
    mainInDev: devExists && isAncestor("HEAD", dev),
    devInMain: devExists && isAncestor(dev, "HEAD"),
  });

  if (action === "none") {
    console.log(devExists ? "dev уже содержит main — синк не нужен" : "ветки dev нет — синк не нужен");
    return;
  }
  if (action === "fast-forward") {
    pushRef("HEAD", PRERELEASE_BRANCH);
    console.log("dev перемотан на main");
    return;
  }
  if (openPullRequestExists(STABLE_BRANCH, PRERELEASE_BRANCH)) {
    console.log("PR main → dev уже открыт");
    return;
  }
  console.log(createPullRequest({ head: STABLE_BRANCH, base: PRERELEASE_BRANCH, title: PR_TITLE, body: PR_BODY }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
