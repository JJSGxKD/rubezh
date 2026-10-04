import { describe, expect, it } from "vitest";
import { PREVIEW_READY, draftMessage, isReady, previewOrigin } from "../src/api/preview";

// Рамка предпросмотра в панели (docs/35-stage4-plan.md WP32): черновик уходит
// только на источник страницы клиента, «готова» принимается только от него.

describe("предпросмотр в панели", () => {
  it("источник страницы — из её адреса; не задан или битый — предпросмотра нет", () => {
    expect(previewOrigin("https://tg.gonet.fun/preview/")).toBe("https://tg.gonet.fun");
    expect(previewOrigin("")).toBeNull();
    expect(previewOrigin("не адрес")).toBeNull();
  });

  it("«готова» — только со своего источника и своим именем", () => {
    const origin = "https://tg.gonet.fun";
    expect(isReady({ origin, data: { type: PREVIEW_READY } }, origin)).toBe(true);
    expect(isReady({ origin: "https://evil.example", data: { type: PREVIEW_READY } }, origin)).toBe(false);
    expect(isReady({ origin, data: { type: "другое" } }, origin)).toBe(false);
    expect(isReady({ origin, data: "rubezh:preview-ready" }, origin)).toBe(false);
    expect(isReady({ origin, data: { type: PREVIEW_READY } }, null)).toBe(false);
  });

  it("черновик — с видом и именем сообщения", () => {
    expect(draftMessage("home-slide", { title: "т" })).toEqual({ type: "rubezh:preview-draft", kind: "home-slide", draft: { title: "т" } });
  });
});
