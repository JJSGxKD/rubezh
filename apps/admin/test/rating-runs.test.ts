import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { fetchRatingRuns, firstDifficulty, holderOf, RATING_RUNS_SHOWN, rankingEffect, setRunRanked, type RatingRun, type RatingRuns } from "../src/api/rating-runs";
import { fakeFetch, json } from "./helpers";

/**
 * Рекорды в рейтинге (docs/35-stage4-plan.md WP44, часть 3б): до нажатия
 * модератор видит словами, что станет с местом игрока, — рекорд, следующий
 * забег, уход из доски или «не изменится»; при закрытом рейтинге — что
 * случится по сроку.
 */

const ACCOUNT = "3c8f3a52-2d4e-4c55-9d0e-6f3b2a1c0d9e";

function run(runId: string, survivalSec: number, ranked = true): RatingRun {
  return { runId, survivalSec, level: 10, enemiesKilled: 400, startingWeaponId: "knife", finishedAt: "2026-10-03T12:00:00.000Z", ranked };
}

describe("рекорды в рейтинге", () => {
  it("открывается сложность, где есть забеги; рекорд — лучший рейтинговый, а не снятый", () => {
    const empty: RatingRuns = { easy: [], normal: [], hard: [] };
    expect(firstDifficulty(empty)).toBe("normal");
    expect(firstDifficulty({ ...empty, hard: [run("h", 100)] })).toBe("hard");
    expect(holderOf([run("a", 500, false), run("b", 300)])?.runId).toBe("b");
    expect(holderOf([run("a", 500, false)])).toBeNull();
  });

  it("не учитывать: рекорд — место по следующему; не рекорд — место то же; последний — уход из доски", () => {
    const rows = [run("a", 500), run("b", 300, false), run("c", 200)];
    expect(rankingEffect(rows, run("a", 500), false)).toBe("Рекордом в доске станет следующий забег — 3:20; место пересчитается сразу.");
    expect(rankingEffect(rows, run("c", 200), false)).toBe("Рекорд в доске — другой забег, 8:20: место игрока не изменится.");
    expect(rankingEffect([run("a", 500)], run("a", 500), false)).toMatch(/уйдёт из доски, пока не сдаст новый/);
    // Список обрезан сервером — следующий может быть за его краем.
    const full = [run("a", 500), ...Array.from({ length: RATING_RUNS_SHOWN - 1 }, (_, index) => run(`x${String(index)}`, 400 - index, false))];
    expect(rankingEffect(full, run("a", 500), false)).toBe("Рекордом в доске станет следующий лучший забег; место пересчитается сразу.");
  });

  it("вернуть: лучше рекорда — станет рекордом; хуже — место то же; рекорда нет — вернётся в доску", () => {
    const rows = [run("a", 500, false), run("b", 300)];
    expect(rankingEffect(rows, run("a", 500, false), false)).toBe("Забег снова станет рекордом в доске: 8:20 вместо 5:00.");
    expect(rankingEffect([run("b", 300), run("c", 200, false)], run("c", 200, false), false)).toBe("Рекорд в доске лучше — 5:00: место игрока не изменится.");
    expect(rankingEffect([run("a", 500, false)], run("a", 500, false), false)).toBe("Игрок вернётся в доску с этим забегом — 8:20.");
  });

  it("рейтинг закрыт ограничением — доску не трогаем, говорим, что будет по сроку", () => {
    expect(rankingEffect([run("a", 500)], run("a", 500), true)).toMatch(/По сроку он вернётся уже без этого забега/);
    expect(rankingEffect([run("a", 500, false)], run("a", 500, false), true)).toMatch(/учтётся, когда игрок вернётся в доску по сроку/);
  });

  it("по API: список по сложностям, снять и вернуть — своими адресами, с причиной", async () => {
    const { fetch, calls } = fakeFetch(
      json(200, { data: { runs: { easy: [], normal: [run("r1", 500)], hard: [] } } }),
      json(201, { data: { accountId: ACCOUNT, ranked: false } }),
      json(201, { data: { accountId: ACCOUNT, ranked: true } }),
    );
    const api = new AdminApi(fetch);

    const list = await fetchRatingRuns(api, ACCOUNT);
    expect(list.ok && list.data.normal[0]?.runId).toBe("r1");
    expect((await setRunRanked(api, "r1", false, "без урона")).ok).toBe(true);
    expect((await setRunRanked(api, "r1", true, "проверили")).ok).toBe(true);

    expect(calls.map((call) => [call.init.method, call.url])).toEqual([
      ["GET", `/api/v1/admin/players/${ACCOUNT}/runs/rating`],
      ["POST", "/api/v1/admin/runs/r1/unrank"],
      ["POST", "/api/v1/admin/runs/r1/rerank"],
    ]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ comment: "без урона" });
  });
});
