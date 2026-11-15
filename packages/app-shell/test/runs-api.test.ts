import { describe, expect, it } from "vitest";
import type { ApiRequest } from "../src/state/api-request";
import { createRunsApi } from "../src/state/runs-api";

const bestBase = { survivalSec: 760, rank: 3 };

function profileWith(hard: Record<string, unknown> | null): unknown {
  return { runs: 7, totalKills: 10, totalSurvivalSec: 900, best: { easy: null, normal: null, hard }, recent: [] };
}

/** Подмена `request`: прогоняет ответ через схему, как настоящий. */
function fake(body: unknown): ApiRequest {
  return async (_path, schema) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new Error("ответ не разобран");
    return { ok: true, data: parsed.data } as never;
  };
}

describe("разбор профиля забегов", () => {
  it("очки лучшего забега разбираются", async () => {
    const answer = await createRunsApi(fake(profileWith({ ...bestBase, points: 2340 }))).profile();
    expect(answer.ok && answer.data.best.hard?.points).toBe(2340);
  });

  it("старый сервер без поля points разбирается, points не задан", async () => {
    const answer = await createRunsApi(fake(profileWith(bestBase))).profile();
    expect(answer.ok && answer.data.best.hard?.points).toBeUndefined();
  });
});
