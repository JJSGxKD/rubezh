import { describe, expect, it } from "vitest";
import * as panel from "../../apps/admin/src/api/preview";
import * as client from "../../packages/app-shell/src/preview/protocol";

/**
 * Протокол предпросмотра (docs/35-stage4-plan.md WP32): панель и страница
 * клиента знают имена сообщений каждая своей копией — оболочку панели
 * импортировать нельзя. Разошлись имена — черновик молча не доходит, и
 * предпросмотр висит на «ждём черновик».
 */
describe("протокол предпросмотра", () => {
  it("имена сообщений у панели и клиента одни и те же", () => {
    expect(panel.PREVIEW_DRAFT).toBe(client.PREVIEW_DRAFT);
    expect(panel.PREVIEW_READY).toBe(client.PREVIEW_READY);
  });

  it("черновик, который собирает панель, страница принимает", () => {
    const message = panel.draftMessage("home-slide", { title: "Турнир", text: "Призы", imageId: null, icon: "trophy" });
    const parsed = client.draftMessageSchema.safeParse(message);
    expect(parsed.success).toBe(true);
    expect(client.homeSlideDraftSchema.safeParse(message.draft).success).toBe(true);
  });
});
