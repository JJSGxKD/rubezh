import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { trustedMessage } from "../src/preview";
import { draftMessageSchema, PREVIEW_DRAFT } from "../src/preview/protocol";
import { PREVIEW_REGISTRY } from "../src/preview/registry";

// Страница предпросмотра для панели (docs/35-stage4-plan.md WP32, Р83):
// черновик — только от панели и только от окна, в которое она встроена;
// реестр рисует черновик без сети тем же слайдом, что игрок.

const PANEL = "https://admin.gonet.fun";
const parent = {};
const IMAGE = "a".repeat(64);

describe("сообщения панели", () => {
  it("принимаются от адреса панели и от родительского окна — чужой адрес и чужое окно мимо", () => {
    expect(trustedMessage({ origin: PANEL, source: parent as MessageEventSource }, [PANEL], parent)).toBe(true);
    expect(trustedMessage({ origin: "https://evil.example", source: parent as MessageEventSource }, [PANEL], parent)).toBe(false);
    expect(trustedMessage({ origin: PANEL, source: {} as MessageEventSource }, [PANEL], parent)).toBe(false);
    // Адрес панели не задан — не принимается ничего.
    expect(trustedMessage({ origin: PANEL, source: parent as MessageEventSource }, [], parent)).toBe(false);
  });

  it("черновик — своим именем и известного вида; чужое сообщение на странице не похоже на него", () => {
    expect(draftMessageSchema.safeParse({ type: PREVIEW_DRAFT, kind: "home-slide", draft: {} }).success).toBe(true);
    expect(draftMessageSchema.safeParse({ type: PREVIEW_DRAFT, kind: "lottery", draft: {} }).success).toBe(false);
    expect(draftMessageSchema.safeParse({ type: "webpackOk" }).success).toBe(false);
  });
});

describe("реестр предпросмотра", () => {
  const render = (draft: unknown) => PREVIEW_REGISTRY["home-slide"].render(draft, { apiBaseUrl: "https://api.gonet.fun" });

  it("слайд главной — словами черновика, значком и картинкой с адреса API, рядом — сосед и точки", () => {
    const html = renderToStaticMarkup(render({ title: "Турнир выходного дня", text: "Призы — самоцветы", imageId: IMAGE, icon: "trophy" }));
    expect(html).toContain("Турнир выходного дня");
    expect(html).toContain("Призы — самоцветы");
    expect(html).toContain(`https://api.gonet.fun/api/v1/media/${IMAGE}.webp`);
    expect(html).toContain("Позови друзей");
    expect(html.match(/aria-current/g)).toHaveLength(2);
  });

  it("пустые поля — подписями-заготовками, без картинки — значок; битый черновик — ничего", () => {
    const html = renderToStaticMarkup(render({ title: "", text: " ", imageId: null, icon: "gift" }));
    expect(html).toContain("Заголовок");
    expect(html).toContain("Подпись");
    expect(html).not.toContain("<img");
    expect(render({ title: "т", text: "п", imageId: "../../etc/passwd", icon: "gift" })).toBeNull();
    expect(render("мусор")).toBeNull();
  });
});
