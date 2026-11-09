import type { RunFinish } from "../runs/dto/runs.dto.js";
import type { RunScoreInput, ScoredRun } from "./run-scorer.service.js";
import type { StoredScore, StoredScoreInput } from "./score-types.js";

/**
 * Из итога забега — то, что нужно подсчёту очков (tasks/T-0293), и то, что
 * кладётся в строку для пересчёта. Клиент прошлой сборки поля не присылает:
 * отсутствие — это `null` («неизвестно», ось считается единицей), а не нуль
 * («не охотился»).
 */

export function scoreInputOf(run: RunFinish): RunScoreInput {
  return {
    survivalSec: run.survivalSec,
    enemiesKilled: run.enemiesKilled,
    damageTaken: run.stats?.damageTaken ?? null,
    huntLog: run.stats?.huntLog ?? null,
    buildScore: run.stats?.buildScore ?? null,
    power: run.stats?.power ?? null,
    contentHash: run.contentHash,
  };
}

export function storedInputOf(run: RunFinish): StoredScoreInput {
  return {
    power: run.stats?.power ?? null,
    huntLog: run.stats?.huntLog ?? null,
    buildScore: run.stats?.buildScore ?? null,
  };
}

export function storedScoreOf(scored: ScoredRun): StoredScore {
  return { points: scored.points, axes: scored.axes, style: scored.style, band: scored.band };
}
