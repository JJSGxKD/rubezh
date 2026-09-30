import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createWheelApi } from "../src/state/wheel-api";

// Клиент колеса (docs/35-stage4-plan.md WP13): сектора и крутка — с сервера,
// схемой; в теле крутки — только чем крутят, что выпало, решает сервер.

interface Sent {
  method: string;
  path: string;
  body: unknown;
}

function server(sent: Sent[], answer: unknown): ApiRequest {
  return async <T,>(path: string, schema: object, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> => {
    sent.push({ method: init?.method ?? "GET", path, body: init?.body });
    const { z } = await import("zod/mini");
    const parsed = z.object({ data: schema as never }).safeParse({ data: answer });
    return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
  };
}

const VIEW = {
  sectors: [
    { resource: "coins", amount: 50, odds: 0.24 },
    { resource: "shard_common", amount: 3, odds: 0.16 },
    { resource: "coins", amount: 1000, odds: 0.02 },
    { resource: "boost_fury", amount: 1, odds: 0.58 },
  ],
  free: true,
};

describe("клиент колеса", () => {
  it("колесо — GET, крутка — POST с видом крутки; незнакомый ресурс сервера новее клиента принимается", async () => {
    const sent: Sent[] = [];
    const view = await createWheelApi(server(sent, VIEW)).view();
    expect(view.ok && view.data.sectors.map((sector) => sector.resource)).toEqual(["coins", "shard_common", "coins", "boost_fury"]);

    const spin = await createWheelApi(server(sent, { sector: 2, resource: "coins", amount: 1000, credited: 1000, view: { ...VIEW, free: false } })).spin();
    expect(spin.ok && spin.data).toMatchObject({ sector: 2, credited: 1000, view: { free: false } });
    expect(sent).toEqual([
      { method: "GET", path: "/api/v1/wheel", body: undefined },
      { method: "POST", path: "/api/v1/wheel/spin", body: { source: "free" } },
    ]);
  });

  it("ответ не по схеме — отказ, а не колесо без секторов", async () => {
    const broken = await createWheelApi(server([], { sectors: [{ resource: "coins" }], free: true })).view();
    expect(broken.ok).toBe(false);
  });

});
