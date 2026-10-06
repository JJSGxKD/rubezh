import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import {
  actOnBroadcast,
  broadcastProblem,
  createBroadcast,
  deliveredShare,
  EMPTY_SEGMENT,
  estimateAudience,
  fetchBroadcast,
  outcomeText,
  segmentProblem,
  segmentSummary,
  testBroadcast,
  updateBroadcast,
  type BroadcastInput,
} from "../src/api/broadcasts";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

const ROW = {
  broadcastId: "0b7d6f64-2a8e-4d0c-9d44-0b1e5a1f2c3d",
  title: "Новый враг",
  platform: "telegram",
  text: "Загляни",
  buttonText: "Играть",
  buttonUrl: "https://rubezh.example/r/Ab12Cd34Ef",
  linkCode: "Ab12Cd34Ef",
  segment: { startKinds: [], reached: ["app_opened"], notReached: [], skipRecentDays: 3 },
  status: "sending",
  audience: 40,
  createdBy: "a",
  approvedBy: null,
  startedBy: "a",
  createdAt: "2026-09-26T10:00:00.000Z",
  updatedAt: "2026-09-26T10:00:00.000Z",
  startedAt: "2026-09-26T10:05:00.000Z",
  finishedAt: null,
};

const INPUT: BroadcastInput = { title: " Новый враг ", text: "Загляни", buttonText: "  ", segment: EMPTY_SEGMENT };

describe("рассылки в панели", () => {
  it("черновик уходит без пустой кнопки, правка — по адресу рассылки, итог читается схемой", async () => {
    const stats = { queued: 10, sent: 28, blocked: 1, failed: 1, blockedAfter: 0 };
    const { fetch, calls } = fakeFetch(
      json(200, { data: ROW }),
      json(200, { data: ROW }),
      json(200, { data: { ...ROW, stats, approvalAudience: 1000 } }),
      json(200, { data: { audience: 42 } }),
      json(200, { data: { status: "retry", afterSec: 5 } }),
      json(200, { data: { ...ROW, status: "paused" } }),
    );
    const api = new AdminApi(fetch);

    await createBroadcast(api, INPUT);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: "Новый враг", text: "Загляни", buttonText: null, segment: EMPTY_SEGMENT, platform: "telegram" });
    await updateBroadcast(api, ROW.broadcastId, { ...INPUT, buttonText: "Играть" });
    expect(calls[1]?.url).toBe(`/api/v1/admin/broadcasts/${ROW.broadcastId}`);

    const view = await fetchBroadcast(api, ROW.broadcastId);
    expect(view.ok && view.data.stats).toEqual(stats);
    const estimate = await estimateAudience(api, EMPTY_SEGMENT);
    expect(estimate.ok && estimate.data.audience).toBe(42);
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ platform: "telegram", segment: EMPTY_SEGMENT });

    const test = await testBroadcast(api, ROW.broadcastId);
    expect(test.ok && outcomeText(test.data)).toBe("Telegram просит подождать 5 с");
    const paused = await actOnBroadcast(api, ROW.broadcastId, "pause");
    expect(paused.ok && paused.data.status).toBe("paused");
    expect(calls[5]?.url).toBe(`/api/v1/admin/broadcasts/${ROW.broadcastId}/pause`);
  });

  it("форма проверяет то же, что сервер", () => {
    expect(broadcastProblem(INPUT)).toBeNull();
    expect(broadcastProblem({ ...INPUT, title: "   " })).not.toBeNull();
    expect(broadcastProblem({ ...INPUT, text: "x".repeat(4097) })).not.toBeNull();
    expect(broadcastProblem({ ...INPUT, buttonText: "x".repeat(65) })).not.toBeNull();
    expect(segmentProblem({ ...EMPTY_SEGMENT, reached: ["runs_2"], notReached: ["runs_2"] })).not.toBeNull();
    expect(segmentProblem({ ...EMPTY_SEGMENT, activeWithinDays: 7, inactiveForDays: 14 })).not.toBeNull();
    expect(segmentProblem({ ...EMPTY_SEGMENT, registeredWithinDays: 0 })).not.toBeNull();
    expect(segmentProblem({ ...EMPTY_SEGMENT, skipRecentDays: 91 })).not.toBeNull();
    expect(segmentProblem({ ...EMPTY_SEGMENT, campaign: "Канал" })).not.toBeNull();
  });

  it("аудитория словами, доля доставленных, раздел — за правом broadcast.edit", () => {
    expect(segmentSummary({ ...EMPTY_SEGMENT, skipRecentDays: 0 })).toEqual(["все, кому можно писать"]);
    expect(segmentSummary({ ...EMPTY_SEGMENT, reached: ["app_opened"], notReached: ["runs_2"], startKinds: ["click"], campaign: "launch", inactiveForDays: 7 })).toEqual([
      "прошли: открыл приложение",
      "не прошли: сыграл второй забег",
      "пришли: ссылка кампании",
      "кампания первого касания: launch",
      "не заходят 7 дн. и дольше",
      "без получавших рассылку за 3 дн.",
    ]);
    expect(deliveredShare({ queued: 0, sent: 3, blocked: 1, failed: 0, blockedAfter: 0 })).toBe(75);
    expect(deliveredShare({ queued: 0, sent: 0, blocked: 0, failed: 0, blockedAfter: 0 })).toBeNull();
    expect(outcomeText({ status: "blocked" })).toMatch(/Старт/);
    expect(SECTIONS.find((section) => section.id === "broadcasts")?.permission).toBe("broadcast.edit");
  });
});
