// Пути конвейера тимлида (T-0477, Р224): корень репозитория, состояние в
// игнорируемой `.lead/` и рабочая копия поезда. Тот же расчёт, что в paths.sh.
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const slashes = (path) => String(path).replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * Корень, где живёт состояние конвейера. Из связанной рабочей копии (поток,
 * поезд) это основной клон: состояние одно на всех, а не по копии на каждого.
 * `LEAD_ROOT` из окружения сильнее всего; общий каталог git не `.git`
 * (bare-раскладка) — корень текущей рабочей копии.
 */
export function resolveLeadRoot({ env, commonDir, toplevel }) {
  if (env && env.LEAD_ROOT) return slashes(env.LEAD_ROOT);
  const common = commonDir ? slashes(commonDir) : "";
  if (common.endsWith("/.git")) return common.slice(0, -"/.git".length);
  return toplevel ? slashes(toplevel) : "";
}

/** Все пути конвейера от корня; `LEAD_DIR` и `TRAIN_WT` переопределяют умолчания. */
export function leadPaths(root, env = {}) {
  const dir = slashes(env.LEAD_DIR || `${root}/.lead`);
  return {
    root,
    dir,
    queue: `${dir}/train-queue.txt`,
    done: `${dir}/train-done.txt`,
    failed: `${dir}/train-failed.txt`,
    log: `${dir}/train.log`,
    trainWorktree: slashes(env.TRAIN_WT || `${root}/.claude/worktrees/train`),
  };
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Пути для скриптов, которым нужен git: корень определяется от каталога этого файла. */
export function currentLeadPaths(env = process.env) {
  const here = dirname(fileURLToPath(import.meta.url));
  let commonDir = "";
  let toplevel = "";
  try {
    commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], here);
    toplevel = git(["rev-parse", "--show-toplevel"], here);
  } catch {
    // вне git корень задаёт только LEAD_ROOT
  }
  const root = resolveLeadRoot({ env, commonDir, toplevel });
  if (!root) throw new Error("Корень репозитория не определён: запустите внутри репозитория или задайте LEAD_ROOT");
  return leadPaths(root, env);
}
