import { describe, expect, it } from "vitest";
import type { KeyValueStorage } from "@bh/shared-types";
import type { ReportFailure } from "../src/state/diagnostic-reports";
import { createReportQueue, REPORT_QUEUE_MAX_ITEMS, type QueuedReport } from "../src/state/report-queue";

// Очередь отчётов на устройстве (docs/28-diagnostics.md §3.5, §4): не
// дублирует, не теряет, вытесняет старое и честно считает вытесненное.

function memoryStorage(): KeyValueStorage & { values: Record<string, string> } {
  const values: Record<string, string> = {};
  return {
    values,
    get: (key) => values[key] ?? null,
    set: (key, value) => {
      values[key] = value;
    },
    remove: (key) => {
      delete values[key];
    },
  };
}

function setup(options: { storage?: ReturnType<typeof memoryStorage>; answers?: (ReportFailure | null)[] } = {}) {
  const storage = options.storage ?? memoryStorage();
  const answers = options.answers ?? [];
  const bodies: string[] = [];
  const dropped: QueuedReport[] = [];
  const scheduled: { delayMs: number; run: () => void }[] = [];
  let clock = 1_000;
  const queue = createReportQueue({
    storage,
    send: async (body) => {
      bodies.push(body);
      return answers.length > 0 ? (answers.shift() ?? null) : null;
    },
    onDropped: (report) => dropped.push(report),
    now: () => clock,
    schedule: (delayMs, run) => scheduled.push({ delayMs, run }),
  });
  return {
    queue,
    storage,
    bodies,
    dropped,
    scheduled,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Сколько вытесненных учтено: в конвертах, ждущих отправки, и в счётчике на устройстве. */
function accounted(app: ReturnType<typeof setup>): number {
  const carried = app.queue.state().pending.reduce((sum, item) => sum + item.carriesEvicted, 0);
  return carried + Number(app.storage.values["bh.reports.v1.evicted"] ?? 0);
}

/** Микрозадачи отправки: очередь шлёт отчёты по одному. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const report = (id: string, size = 10) => ({
  meta: { reportId: id, kind: "run" as const },
  build: (evicted: number) => JSON.stringify({ reportId: id, evicted, pad: "x".repeat(size) }),
});

describe("очередь отчётов", () => {
  it("отправляет сразу и удаляет подтверждённое, повтор того же отчёта не кладёт", async () => {
    const app = setup();
    const first = report("a");
    app.queue.enqueue(first.meta, first.build);
    app.queue.enqueue(first.meta, first.build);
    await settle();

    expect(app.bodies).toHaveLength(1);
    expect(app.queue.state().pending).toEqual([]);
    expect(app.queue.state().sent.map((item) => item.reportId)).toEqual(["a"]);
  });

  it("без сети держит отчёт, переживает перезапуск и досылает при запуске", async () => {
    const storage = memoryStorage();
    const offline = setup({ storage, answers: ["offline"] });
    const first = report("a");
    offline.queue.enqueue(first.meta, first.build);
    await settle();
    expect(offline.queue.state().pending.map((item) => item.reportId)).toEqual(["a"]);

    // Перезапуск приложения: новая очередь читает хранилище.
    const relaunched = setup({ storage });
    await relaunched.queue.flush("launch");
    expect(relaunched.bodies).toEqual(offline.bodies);
    expect(relaunched.queue.state().pending).toEqual([]);
  });

  it("после неудачи повторяет по таймеру с растущей паузой, а не сразу", async () => {
    const app = setup({ answers: ["unavailable", "limited", null] });
    const first = report("a");
    app.queue.enqueue(first.meta, first.build);
    await settle();
    expect(app.scheduled.map((item) => item.delayMs)).toEqual([15_000]);

    // Рано — повтор ничего не шлёт.
    app.scheduled.shift()?.run();
    await settle();
    expect(app.bodies).toHaveLength(1);

    app.advance(15_000);
    await app.queue.flush("retry");
    expect(app.scheduled.map((item) => item.delayMs)).toEqual([30_000]);
    app.advance(30_000);
    await app.queue.flush("retry");
    expect(app.queue.state().pending).toEqual([]);
  });

  it("отвергнутый сервером отчёт не держит очередь: выбрасывается, следующий уходит", async () => {
    const app = setup({ answers: ["rejected", null] });
    app.queue.enqueue(report("bad").meta, report("bad").build);
    app.queue.enqueue(report("good").meta, report("good").build);
    await settle();

    expect(app.dropped.map((item) => item.reportId)).toEqual(["bad"]);
    expect(app.queue.state().sent.map((item) => item.reportId)).toEqual(["good"]);
  });

  it("выключенный приёмник — до перезапуска не стучится, отчёты не теряет", async () => {
    const app = setup({ answers: ["disabled"] });
    app.queue.enqueue(report("a").meta, report("a").build);
    await settle();
    app.queue.enqueue(report("b").meta, report("b").build);
    await app.queue.flush("online");

    expect(app.bodies).toHaveLength(1);
    expect(app.queue.state().pending).toHaveLength(2);
    expect(app.scheduled).toEqual([]);
  });

  it("вытесняет самые старые сверх потолка и сообщает их число со следующим отчётом", async () => {
    const app = setup({ answers: new Array<ReportFailure>(40).fill("offline") });
    for (let i = 0; i < REPORT_QUEUE_MAX_ITEMS + 2; i++) app.queue.enqueue(report(`r${i}`).meta, report(`r${i}`).build);
    await settle();

    const pending = app.queue.state().pending;
    expect(pending.map((item) => item.reportId)).toHaveLength(REPORT_QUEUE_MAX_ITEMS);
    expect(pending[0]?.reportId).toBe("r2");
    // r10 вытеснил r0, r11 — r1. Конверт r11 сообщает о r0, о r1 скажет следующий.
    expect(pending.at(-1)?.carriesEvicted).toBe(1);
    expect(JSON.parse(app.storage.values["bh.reports.v1.queue"] ?? "[]").at(-1).body).toContain('"evicted":1');
    expect(accounted(app)).toBe(2);
  });

  it("вытесненный отчёт, сам нёсший счётчик, передаёт его дальше — потери не пропадают", () => {
    const app = setup({ answers: new Array<ReportFailure>(80).fill("offline") });
    const total = 3 * REPORT_QUEUE_MAX_ITEMS + 3;
    for (let i = 0; i < total; i++) {
      app.queue.enqueue(report(`r${i}`).meta, report(`r${i}`).build);
      // Каждый вытесненный отчёт учтён ровно один раз: в конверте или в счётчике.
      expect(accounted(app)).toBe(Math.max(0, i + 1 - REPORT_QUEUE_MAX_ITEMS));
    }
    // Вытеснялись и отчёты, которые сами несли счётчик: следующий несёт больше одного.
    expect(app.queue.state().pending.some((item) => item.carriesEvicted > 1)).toBe(true);
  });

  it("битая очередь в хранилище сбрасывается, а не роняет запуск", () => {
    const storage = memoryStorage();
    storage.values["bh.reports.v1.queue"] = "{не json";
    storage.values["bh.reports.v1.sent"] = JSON.stringify([{ reportId: 1 }]);
    const app = setup({ storage });
    expect(app.queue.state()).toEqual({ pending: [], sent: [] });
    expect(storage.values["bh.reports.v1.queue"]).toBeUndefined();
  });

  it("снимок состояния стабилен между изменениями — экран не перерисовывается впустую", async () => {
    const app = setup();
    const before = app.queue.state();
    expect(app.queue.state()).toBe(before);
    app.queue.rememberSent({ reportId: "bench-1", kind: "bench", bytes: 2048, sentAt: 5 });
    expect(app.queue.state()).not.toBe(before);
    expect(app.queue.state().sent[0]?.kind).toBe("bench");
  });
});
