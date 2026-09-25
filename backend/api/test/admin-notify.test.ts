import { describe, expect, it } from "vitest";
import { UnrecoverableError } from "bullmq";
import { loadAppConfig } from "../src/config/app-config.js";
import { ReportNotifier, type NotifierBotApi } from "../src/modules/admin-notify/report-notifier.js";
import { renderRunCardPng, renderRunCardSvg, runCaption, type RunCardInput } from "../src/modules/admin-notify/run-card.js";
import { renderStressCardPng, renderStressCardSvg, stressCaption, type StressCardInput } from "../src/modules/admin-notify/stress-card.js";
import { DiagnosticsHooks, type ReceivedReport } from "../src/modules/diagnostics/diagnostics-hooks.js";
import { benchSummaryOf, runSummaryOf } from "../src/modules/diagnostics/diagnostics-summary.js";
import type { DiagnosticsRepository, StoredBenchReport, StoredRunReport } from "../src/modules/diagnostics/diagnostics.repository.js";
import { submitBenchReportSchema } from "../src/modules/diagnostics/dto/bench-report.dto.js";
import { submitRunReportSchema } from "../src/modules/diagnostics/dto/run-report.dto.js";
import { chatTargetOf } from "../src/platforms/telegram/chat-target.js";
import { TelegramApiError } from "../src/platforms/telegram/telegram-bot-api.js";
import { benchSubmission, DEVICE, REPORT_ID } from "./helpers/bench-report.js";
import { runBucket, runSubmission, RUN_REPORT_ID, type RunPatch } from "./helpers/run-report.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { reviewCardText, type ReviewCardRun } from "../src/modules/admin-notify/run-review-card.js";
import type { ReviewThrottle } from "../src/modules/admin-notify/review-throttle.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";

// Уведомления об отчётах диагностики в чат администраторов (docs/28-diagnostics.md §6.2).

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

function storedRun(patch: RunPatch = {}): StoredRunReport {
  return { reportId: RUN_REPORT_ID, appVersion: "0.4.0", device: DEVICE, payload: submitRunReportSchema.parse(runSubmission(RUN_REPORT_ID, patch)) };
}

function runCardInput(patch: RunPatch = {}): RunCardInput {
  const report = storedRun(patch);
  return { ...report, summary: runSummaryOf(report.payload) };
}

describe("карточка проблемного забега", () => {
  it("называет причины, подсвечивает их числа и рисует таймлайн с полосой догоняния", () => {
    const timeline = Array.from({ length: 12 }, (_, index) => runBucket(index, index > 6 ? { catchUpFrames: 40, maxSteps: 4, avgFps: 41 } : {}));
    const input = runCardInput({ timeline, over33Ratio: 0.09, clientErrors: 3 });
    const svg = renderRunCardSvg(input);
    expect(input.summary.problems).toEqual(["frame_drops", "catch_up", "client_errors"]);
    expect(svg).toContain("рывки кадров");
    expect(svg).toContain("игра замедлялась");
    expect(svg).toContain("ошибки клиента");
    expect(svg).toContain("красная полоса у оси — игра догоняла время");
    expect(svg).toContain("нормальная, погиб от swarm_rat");
    expect(svg).toMatch(/fill-opacity="[\d.]+"\/>/);
    expect(renderRunCardPng(input).subarray(1, 4).toString()).toBe("PNG");
  });

  it("подпись даёт команду повтора, а неповторимую запись так и называет", () => {
    const input = runCardInput({ clientErrors: 1 });
    expect(runCaption(input)).toContain(`pnpm replay ${RUN_REPORT_ID} --from diagnostic_reports.ndjson`);
    const resumed = runCardInput({ clientErrors: 1 });
    resumed.payload.recording.replayBlocker = "resumed";
    resumed.summary = runSummaryOf(resumed.payload);
    expect(runCaption(resumed)).toContain("не повторить: продолжен из снимка");
    expect(runCaption(resumed).length).toBeLessThanOrEqual(1024);
  });
});

class Reports implements DiagnosticsRepository {
  report: StoredBenchReport | null = stored();
  run: StoredRunReport | null = storedRun({ clientErrors: 2 });
  async insert(): Promise<boolean> {
    return true;
  }
  async findBench(): Promise<StoredBenchReport | null> {
    return this.report;
  }
  async list(): Promise<[]> {
    return [];
  }
  async find(): Promise<null> {
    return null;
  }
  async findRun(): Promise<StoredRunReport | null> {
    return this.run;
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
    async sendPhoto(chat, _photo, caption) {
      if (failure !== null) throw failure;
      sent.push({ chatId: chatTargetOf(chat).chatId, caption });
      return { messageId: 1, fileId: null };
    },
    async sendMessage(chat, text) {
      if (failure !== null) throw failure;
      sent.push({ chatId: chatTargetOf(chat).chatId, caption: text });
      return 1;
    },
  };
  const accounts = new MemoryAccountRepository();
  const throttle = new MemoryThrottle();
  const instance = new ReportNotifier(config, hooks, reports, api, new RunsHooks(), accounts, throttle);
  return { instance, reports, sent, accounts, throttle, fail: (error: Error) => (failure = error) };
}

/** Окно карточек разбора без Redis: занятый аккаунт отвечает «уже было». */
class MemoryThrottle implements ReviewThrottle {
  private readonly claimed = new Set<string>();

  async claim(accountId: string): Promise<boolean> {
    if (this.claimed.has(accountId)) return false;
    this.claimed.add(accountId);
    return true;
  }
}

/** Очередь BullMQ поднимается на старте приложения; в тестах — её место. */
function captureQueue(instance: ReportNotifier): { data: unknown; jobId: string }[] {
  const added: { data: unknown; jobId: string }[] = [];
  (instance as unknown as { queue: { add: (name: string, data: unknown, options: { jobId: string }) => Promise<void> } }).queue = {
    add: async (_name, data, options) => void added.push({ data, jobId: options.jobId }),
  };
  return added;
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

  it("шлёт каждый вид отчёта в свой чат и тему", async () => {
    const split = notifier({ ADMIN_CHAT_STRESS: "-1001111111111:5", ADMIN_CHAT_RUNS: "-1002222222222" });
    await split.instance.process({ data: { reportId: REPORT_ID, kind: "bench" } });
    await split.instance.process({ data: { reportId: RUN_REPORT_ID, kind: "run" } });
    expect(split.sent.map((item) => item.chatId)).toEqual(["-1001111111111", "-1002222222222"]);

    // Поток без своего адреса берёт общий; выключенный поток — не enabled.
    expect(notifier({ ADMIN_CHAT_ID: "" }).instance.enabled).toBe(false);
    expect(notifier({ ADMIN_CHAT_ID: "", ADMIN_CHAT_RUNS: "-100" }).instance.enabled).toBe(true);
  });

  it("шлёт карточку проблемного забега по записи из базы", async () => {
    const { instance, sent } = notifier();
    await instance.process({ data: { reportId: RUN_REPORT_ID, kind: "run" } });
    expect(sent).toEqual([{ chatId: CHAT, caption: expect.stringContaining("Забег · ошибки клиента") }]);
  });

  it("в очередь ставит каждый стресс-тест, а запись забега — только проблемную", async () => {
    const { instance } = notifier();
    const added = captureQueue(instance);
    const base = { appVersion: "0.4.0", installId: "install", platformUserId: null, device: DEVICE, receivedAt: new Date() };
    const bench = stored();
    const calm = storedRun();
    const troubled = storedRun({ over33Ratio: 0.2 });
    const reports: ReceivedReport[] = [
      { ...base, kind: "bench", reportId: bench.reportId, payload: bench.payload, summary: benchSummaryOf(bench.payload) },
      { ...base, kind: "run", reportId: "calm-run", payload: calm.payload, summary: runSummaryOf(calm.payload) },
      { ...base, kind: "run", reportId: "troubled-run", payload: troubled.payload, summary: runSummaryOf(troubled.payload) },
    ];
    for (const report of reports) await instance.enqueue(report);

    expect(added).toEqual([
      { data: { reportId: REPORT_ID, kind: "bench" }, jobId: `report-${REPORT_ID}` },
      { data: { reportId: "troubled-run", kind: "run" }, jobId: "report-troubled-run" },
    ]);
  });

  it("задание прошлой сборки без вида — стресс-тест", async () => {
    const { instance, sent } = notifier();
    await instance.process({ data: { reportId: REPORT_ID } });
    expect(sent[0]?.caption).toContain("Стресс-тест");
  });
});

// Забеги на разбор антифрода (docs/34-stage3-plan.md, WP4): карточка зовёт
// администратора посмотреть, очередь целиком — GET /runs/review.

const REVIEW_ENV = {
  AUTH_ENABLED: "true",
  JWT_ACCESS_SECRET: "a".repeat(64),
  DATABASE_URL: "postgresql://unused",
};

function recorded(patch: Partial<RecordedRun> = {}): RecordedRun {
  return {
    runId: "3502c9bc-fd1c-47e8-aa63-d7af145ee9df",
    accountId: "1b6a2c8e-df0c-491f-8b4a-6802a9058be6",
    difficulty: "normal",
    outcome: "died",
    survivalSec: 754,
    level: 18,
    enemiesKilled: 34_000,
    startingWeaponId: "knife",
    deathCause: "swarm_rat",
    cheats: false,
    continues: 0,
    ranked: false,
    verdict: "suspicious",
    reasons: ["kill_rate"],
    finishedAt: new Date(),
    ...patch,
  };
}

describe("карточка забега на разбор", () => {
  const run: ReviewCardRun = { ...recorded(), verdict: "rejected", reasons: ["longer_than_wall_clock", "unverified_time"] };

  it("называет вердикт, игрока, числа забега и каждую причину словами", () => {
    const text = reviewCardText(run, { displayName: "Иван", username: "ivan" });

    expect(text).toContain("Забег на разбор · отклонён");
    expect(text).toContain("Иван (@ivan) · аккаунт 1b6a2c8e");
    expect(text).toContain("Нормальная · 12:34 · уровень 18 · убийств 34000 · погиб от swarm_rat");
    expect(text).toContain("забег дольше, чем прошло по часам сервера; старт не дошёл");
    expect(text).toContain(`Забег ${run.runId}`);
  });

  it("без аккаунта — полный идентификатор: по нему его ещё можно найти", () => {
    expect(reviewCardText(run, null)).toContain(`аккаунт ${run.accountId}`);
  });
});

describe("отправка забега на разбор", () => {
  it("в очередь идёт только подозрительный и отклонённый, без читов", async () => {
    const { instance } = notifier(REVIEW_ENV);
    const added = captureQueue(instance);

    await instance.enqueueReview(recorded({ verdict: "ok", reasons: [] }));
    await instance.enqueueReview(recorded({ cheats: true, accountId: "с-читами" }));
    await instance.enqueueReview(recorded());

    expect(added).toHaveLength(1);
    expect(added[0]?.jobId).toBe("review-3502c9bc-fd1c-47e8-aa63-d7af145ee9df");
  });

  it("читер не засыпает чат: одна карточка на аккаунт за окно", async () => {
    const { instance } = notifier(REVIEW_ENV);
    const added = captureQueue(instance);

    await instance.enqueueReview(recorded({ runId: "первый" }));
    await instance.enqueueReview(recorded({ runId: "второй" }));
    await instance.enqueueReview(recorded({ runId: "чужой", accountId: "другой-аккаунт" }));

    expect(added.map((job) => job.jobId)).toEqual(["review-первый", "review-чужой"]);
  });

  it("шлёт текст в свой поток с именем на момент отправки", async () => {
    const { instance, sent, accounts } = notifier({ ...REVIEW_ENV, ADMIN_CHAT_RUN_REVIEW: "-1003333333333:9" });
    const account = await accounts.upsert({ platform: "telegram", platformUserId: "555", displayName: "Иван", username: null, photoUrl: null }, Date.now());
    const run: ReviewCardRun = { ...recorded({ accountId: account.accountId }), verdict: "suspicious" };

    await instance.process({ data: { kind: "review", run } });

    expect(sent).toEqual([{ chatId: "-1003333333333", caption: expect.stringContaining("Иван · аккаунт") }]);
  });

  it("включается адресом и авторизацией, а не флагом отчётов диагностики", () => {
    expect(notifier(REVIEW_ENV).instance.reviewEnabled).toBe(true);
    expect(notifier({ ...REVIEW_ENV, ADMIN_NOTIFY_REPORTS: "false" }).instance.reviewEnabled).toBe(true);
    expect(notifier({ ...REVIEW_ENV, ADMIN_CHAT_ID: "" }).instance.reviewEnabled).toBe(false);
    // Без авторизации забегов под аккаунтом нет — и разбирать нечего.
    expect(notifier().instance.reviewEnabled).toBe(false);
  });
});
