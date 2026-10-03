import { describe, expect, it } from "vitest";
import { resolveTaskLink, type TaskLinkFetch } from "../src/ads/task-links";

/**
 * Переход по заданию ленты Taddy (docs/35-stage4-plan.md WP13, часть 6):
 * адрес перехода спрашиваем у Taddy так же, как SDK, — POST на ссылку из
 * ленты; открывается только https.
 */

const LINK = "https://t.tadly.pro/v1/exchange/open/abc";

function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: TaskLinkFetch = async (url, init) => {
    calls.push({ url, init });
    return await respond();
  };
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("переход по заданию ленты", () => {
  it("POST на ссылку из ленты с пустым списком полей, как у SDK Taddy; адрес перехода — из result", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ result: "https://t.me/cat_farm_bot?start=tdy_42" }));
    expect(await resolveTaskLink({ network: "taddy", link: LINK }, fetchImpl)).toBe("https://t.me/cat_farm_bot?start=tdy_42");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(LINK);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ fields: [] });
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("небезопасный адрес не открывается ни на входе, ни на выходе", async () => {
    const { calls, fetchImpl } = fakeFetch(() => json({ result: "javascript:alert(1)" }));
    expect(await resolveTaskLink({ network: "taddy", link: LINK }, fetchImpl)).toBeNull();
    expect(await resolveTaskLink({ network: "taddy", link: "http://t.tadly.pro/open" }, fetchImpl)).toBeNull();
    expect(await resolveTaskLink({ network: "taddy", link: "не адрес" }, fetchImpl)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("сеть незнакома — запроса нет; ошибка, мусор и обрыв — перехода нет, без исключения", async () => {
    const unknown = fakeFetch(() => json({ result: "https://t.me/x" }));
    expect(await resolveTaskLink({ network: "adsgram", link: LINK }, unknown.fetchImpl)).toBeNull();
    expect(unknown.calls).toEqual([]);

    for (const respond of [
      () => json({ error: "task expired" }, 410),
      () => json({ error: "task expired" }),
      () => json({ result: 42 }),
      () => json(null),
      () => new Response("<html>", { status: 200 }),
      () => Promise.reject(new TypeError("Failed to fetch")),
    ]) {
      expect(await resolveTaskLink({ network: "taddy", link: LINK }, fakeFetch(respond).fetchImpl)).toBeNull();
    }
  });
});
