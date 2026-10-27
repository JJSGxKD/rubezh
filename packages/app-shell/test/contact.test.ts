import { beforeEach, describe, expect, it } from "vitest";
import { createNoopPlatformUi, type PlatformAdapter } from "@bh/shared-types";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createBadgesApi, loadBadges } from "../src/state/badges-api";
import { contactHref, openContact, useContact } from "../src/state/contact";
import { useNavigation } from "../src/state/navigation";
import { initShell } from "../src/state/shell";

// Кнопка «Связаться с разработчиком» (tasks/T-0344, Р173): ссылку выбирает
// сервер, клиент проверяет https ещё раз и открывает её средствами площадки.

let events: { event: string; payload: Record<string, unknown> }[] = [];
let opened: string[] = [];

beforeEach(() => {
  events = [];
  opened = [];
  initShell({
    adapter: { ui: createNoopPlatformUi(), haptic: () => undefined, openLink: (url: string) => void opened.push(url) } as unknown as PlatformAdapter,
    capabilities: { platformAvailable: true, botUrl: "", diagnosticsByDefault: false },
    storage: undefined,
    analytics: (event, payload) => events.push({ event, payload }),
    build: { version: "test", contentHash: "", platform: "web" },
  });
  useNavigation.setState({ stack: ["shop"] });
  useContact.setState({ url: null });
});

describe("contactHref", () => {
  it("https-ссылка возвращается как есть", () => {
    useContact.getState().set("https://t.me/dev?direct");
    expect(contactHref()).toBe("https://t.me/dev?direct");
  });

  it.each([[null], [""], ["http://t.me/dev"], ["javascript:alert(1)"]])("%s — ссылки нет", (url) => {
    useContact.getState().set(url);
    expect(contactHref()).toBeNull();
  });
});

describe("openContact", () => {
  it("открывает ссылку адаптером и шлёт ui_clicked с control contact", () => {
    useContact.getState().set("https://t.me/dev?direct");
    openContact();
    expect(opened).toEqual(["https://t.me/dev?direct"]);
    expect(events).toEqual([{ event: "ui_clicked", payload: { screen: "shop", control: "contact" } }]);
  });

  it("без ссылки не делает ничего", () => {
    openContact();
    expect(opened).toEqual([]);
    expect(events).toEqual([]);
  });
});

describe("знаки меню и ссылка", () => {
  const answer = (data: unknown): ApiRequest =>
    (async <T,>(_path: string, schema: object): Promise<ApiResult<T>> => {
      const { z } = await import("zod/mini");
      const parsed = z.object({ data: schema as never }).safeParse({ data });
      return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
    }) as ApiRequest;

  const BASE = { arsenal: 0, friends: 0, notifications: 0 };

  it("ссылка из ответа попадает в стор", async () => {
    await loadBadges(createBadgesApi(answer({ ...BASE, contactUrl: "https://t.me/dev?direct" })));
    expect(useContact.getState().url).toBe("https://t.me/dev?direct");
  });

  it("старый сервер без contactUrl разбирается без ошибки; ссылки нет", async () => {
    useContact.getState().set("https://t.me/old");
    await loadBadges(createBadgesApi(answer(BASE)));
    expect(useContact.getState().url).toBeNull();
  });

  it("null с сервера — ссылки нет", async () => {
    useContact.getState().set("https://t.me/old");
    await loadBadges(createBadgesApi(answer({ ...BASE, contactUrl: null })));
    expect(useContact.getState().url).toBeNull();
  });
});
