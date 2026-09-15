import { describe, expect, it } from "vitest";
import { UnrecoverableError } from "bullmq";
import { loadAppConfig } from "../src/config/app-config.js";
import { ReportNotifier, type NotifierBotApi } from "../src/modules/admin-notify/report-notifier.js";
import { renderStressCardPng, renderStressCardSvg, stressCaption, type StressCardInput } from "../src/modules/admin-notify/stress-card.js";
import { DiagnosticsHooks } from "../src/modules/diagnostics/diagnostics-hooks.js";
import { benchSummaryOf } from "../src/modules/diagnostics/diagnostics-summary.js";
import type { DiagnosticsRepository, StoredBenchReport } from "../src/modules/diagnostics/diagnostics.repository.js";
import { submitBenchReportSchema } from "../src/modules/diagnostics/dto/bench-report.dto.js";
import { TelegramApiError } from "../src/modules/telegram/telegram-bot-api.js";
import { benchSubmission, DEVICE, REPORT_ID } from "./helpers/bench-report.js";

// Уведомления о стресс-тестах в чат администраторов.

const CHAT = "-1001234567890";

function stored(patch: Partial<StoredBenchReport> = {}): StoredBenchReport {
  return { reportId: REPORT_ID, appVersion: "0.4.0", device: DEVICE, payload: submitBenchReportSchema.parse(benchSubmission()), ...patch };
}

function cardInput(patch: Partial<StoredBenchReport> = {}): StressCardInput {
  const report = stored(patch);
  return { ...report, summary: benchSummaryOf(report.payload) };
}

describe("карточка стресс-теста", () => {
  it("показывает исход, устройство, пик и предел и рисует график таймлайна", () => {
    const svg = renderStressCardSvg(cardInput());
    expect(svg).toContain("предел найден");
    expect(svg).toContain("Android · Телефон · TG Android 8.0 · 412×915 ×2.63 · 8 ядер · 8 ГБ");
    expect(svg).toContain(">1211<");
    expect(svg).toContain("просадка на 660 врагах");
    expect(svg).toMatch(/<polyline points="[\d., ]+"/);
    expect(renderStressCardPng(cardInput()).subarray(1, 4).toString()).toBe("PNG");
  });

  it("экранирует то, что прислал клиент, и честно пишет про короткий таймлайн", () => {
    const payload = submitBenchReportSchema.parse(benchSubmission());
    payload.report.timeline = payload.report.timeline.slice(0, 1);
    const svg = renderStressCardSvg(cardInput({ payload, device: { ...DEVICE, clientPlatform: "<script>" } }));
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("таймлайн слишком короткий");
  });

  it("дублирует главное подписью и предупреждает о сворачивании", () => {
    const payload = submitBenchReportSchema.parse(benchSubmission());
    payload.report.interruptions = 2;
    const caption = stressCaption(cardInput({ payload }));
    expect(caption).toContain("Стресс-тест · предел найден · сборка 0.4.0");
    expect(caption).toContain("сворачивали 2 раза");
    expect(caption.length).toBeLessThanOrEqual(1024);
  });
});

class Reports implements DiagnosticsRepository {
  report: StoredBenchReport | null = stored();
  async insert(): Promise<boolean> {
    return true;
  }
  async findBench(): Promise<StoredBenchReport | null> {
    return this.report;
  }  async findRun(): Promise<null> {
    return null;
  }

}

function notifier(env: Record<string, string> = {}) {
  const config = loadAppConfig({
    NODE_ENV: "test",
    TELEGRAM_BOT_TOKEN: "123:TEST",
    ADMIN_CHAT_ID: CHAT,
    DIAGNOSTICS_INGEST_ENABLED: "true",
    DATABASE_URL: "postgresql://unused",
    ...env,
  });
  const reports = new Reports();
  const hooks = new DiagnosticsHooks();
  const sent: { chatId: string; caption: string }[] = [];
  let failure: Error | null = null;
  const api: NotifierBotApi = {
    async sendPhoto(chatId, _photo, caption) {
      if (failure !== null) throw failure;
      sent.push({ chatId, caption });
      return { messageId: 1, fileId: null };
    },
  };
  return { instance: new ReportNotifier(config, hooks, reports, api), reports, sent, fail: (error: Error) => (failure = error) };
}

describe("отправка уведомления", () => {
  it("шлёт карточку в чат администраторов", async () => {
    const { instance, sent } = notifier();
    await instance.process({ data: { reportId: REPORT_ID } });
    expect(sent).toEqual([{ chatId: CHAT, caption: expect.stringContaining("Стресс-тест") }]);
  });

  it("не повторяет то, что повтором не лечится: отчёта нет или чат недоступен", async () => {
    const missing = notifier();
    missing.reports.report = null;
    await expect(missing.instance.process({ data: { reportId: REPORT_ID } })).rejects.toBeInstanceOf(UnrecoverableError);

    const kicked = notifier();
    kicked.fail(new TelegramApiError("sendPhoto", 403, "Forbidden: bot was kicked", null));
    await expect(kicked.instance.process({ data: { reportId: REPORT_ID } })).rejects.toBeInstanceOf(UnrecoverableError);

    const offline = notifier();
    offline.fail(new TelegramApiError("sendPhoto", 0, "сеть недоступна", null));
    await expect(offline.instance.process({ data: { reportId: REPORT_ID } })).rejects.not.toBeInstanceOf(UnrecoverableError);
  });

  it("молчит без чата, без приёмника отчётов и когда уведомления выключены", () => {
    expect(notifier().instance.enabled).toBe(true);
    expect(notifier({ ADMIN_CHAT_ID: "" }).instance.enabled).toBe(false);
    expect(notifier({ DIAGNOSTICS_INGEST_ENABLED: "false" }).instance.enabled).toBe(false);
    expect(notifier({ ADMIN_NOTIFY_REPORTS: "false" }).instance.enabled).toBe(false);
  });
});
