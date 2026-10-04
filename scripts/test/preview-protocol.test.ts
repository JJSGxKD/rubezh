import { describe, expect, it } from "vitest";
import { changelogPreview } from "../../apps/admin/src/api/changelog";
import * as panel from "../../apps/admin/src/api/preview";
import { taskPreview } from "../../apps/admin/src/api/tasks";
import * as client from "../../packages/app-shell/src/preview/protocol";

/**
 * Протокол предпросмотра (docs/35-stage4-plan.md WP32): панель и страница
 * клиента знают имена сообщений каждая своей копией — оболочку панели
 * импортировать нельзя. Разошлись имена — черновик молча не доходит, и
 * предпросмотр висит на «ждём черновик».
 */
describe("протокол предпросмотра", () => {
  it("имена сообщений и виды черновиков у панели и клиента одни и те же", () => {
    expect(panel.PREVIEW_DRAFT).toBe(client.PREVIEW_DRAFT);
    expect(panel.PREVIEW_READY).toBe(client.PREVIEW_READY);
    expect(panel.PREVIEW_KINDS).toEqual(client.PREVIEW_KINDS);
  });

  it("черновик, который собирает панель, страница принимает", () => {
    const message = panel.draftMessage("home-slide", { title: "Турнир", text: "Призы", imageId: null, icon: "trophy" });
    const parsed = client.draftMessageSchema.safeParse(message);
    expect(parsed.success).toBe(true);
    expect(client.homeSlideDraftSchema.safeParse(message.draft).success).toBe(true);
  });

  it("версию журнала и задание из форм панели страница принимает своими схемами", () => {
    const version = changelogPreview({ version: "0.6.0", kind: "added", platforms: [], text: "Виджеты главной" }, null, []);
    expect(client.changelogDraftSchema.safeParse(version).success).toBe(true);
    const task = taskPreview({ taskId: "x", period: "achievement", kind: "channel", params: { url: "https://t.me/rubezh" }, target: 1, title: "Подпишись", coins: 100, gems: 0, shards: 0, passPoints: 0, sort: 0, active: true, limit: null, image: "a".repeat(64) });
    expect(client.taskDraftSchema.safeParse(task).success).toBe(true);
  });
});
