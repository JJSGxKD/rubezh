import type { DifficultyId } from "@bh/shared-types";
import type { MainSceneData } from "../MainScene";

/**
 * Данные новой сцены для «Ещё раз». «Ещё раз» — новый забег, а не повтор
 * продолженного: со своим id и без бустов. Буст — расходник на один забег, и
 * перенести его на следующий значило бы дать его даром, а сервер отклонил бы
 * такой забег как неоплаченный. Снаряжение остаётся: снимок надетого всё тот же.
 *
 * Сложность можно сменить: после обучающего забега следующий идёт на единой
 * сложности (docs/35-stage4-plan.md, Р126). Без параметра остаётся прежняя.
 * Исходный объект не меняется — он ещё принадлежит завершающейся сцене.
 */
export function restartSceneData(data: MainSceneData, seed: number, difficultyId?: DifficultyId): MainSceneData {
  const next: MainSceneData = { ...data, seed };
  delete next.resume;
  delete next.runId;
  if (next.loadout !== undefined) next.loadout = { ...next.loadout, boosts: [] };
  if (difficultyId !== undefined) next.difficultyId = difficultyId;
  return next;
}
