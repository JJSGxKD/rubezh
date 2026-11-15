import { describe, expect, it } from "vitest";
import type { KeyValueStorage } from "@bh/shared-types";
import type { ApiFailure } from "../src/state/api-request";
import {
  createRunProofQueue,
  RUN_PROOF_MAX_AGE_MS,
  RUN_PROOF_QUEUE_KEY,
  RUN_PROOF_QUEUE_MAX_ITEMS,
  type ProofSendResult,
} from "../src/state/run-proof-queue";

// Очередь записей для проверки на устройстве (tasks/T-0316): запись уходит на
// сервер после того, как сервер записал забег, переживает обрыв сети и
// перезапуск и не копится без края. Игрок ничего не ждёт: забег уже записан.

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

const OK: ProofSendResult = { ok: true };
const fail = (failure: ApiFailure, code?: string): ProofSendResult => ({ ok: false, failure, ...(code === undefined ? {} : { code }) });

function setup(options: { storage?: KeyValueStorage; answers?: ProofSendResult[]; start?: number } = {}) {
  const storage = options.storage ?? memoryStorage();
  const answers = options.answers ?? [];
  const sent: { runId: string; payload: string }[] = [];
  const dropped: { runId: string; reason: string }[] = [];
  let clock = options.start ?? 1_000_000;
  const queue = createRunProofQueue({
    storage,
    send: async (runId, payload) => {
      sent.push({ runId, payload });
      return answers.shift() ?? OK;
    },
    onDropped: (runId, reason) => dropped.push({ runId, reason }),
    now: () => clock,
  });
  return { queue, storage, sent, dropped, advance: (ms: number) => void (clock += ms), clock: () => clock };
}

/** Микрозадачи отправки: очередь шлёт записи по одной. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("очередь записей для проверки", () => {
  it("отправляет после ответа сервера на забег, а не раньше", async () => {
    const app = setup();

    app.queue.enqueue("run-1", "H4sIAAAA");
    await settle();
    expect(app.sent).toEqual([]);
    expect(app.queue.state().pending).toEqual([{ runId: "run-1", recorded: false, queuedAtMs: app.clock() }]);

    app.queue.recorded("run-1");
    await settle();
    expect(app.sent).toEqual([{ runId: "run-1", payload: "H4sIAAAA" }]);
    expect(app.queue.state().pending).toEqual([]);
  });

  it("ответ сервера пришёл раньше, чем запись сжалась: запись уходит сразу, как встала в очередь", async () => {
    const app = setup();

    app.queue.recorded("run-1");
    app.queue.enqueue("run-1", "AAAA");
    await settle();

    expect(app.sent).toEqual([{ runId: "run-1", payload: "AAAA" }]);
  });

  it("запись чужого забега ждёт своего: ответ по другому забегу её не выпускает", async () => {
    const app = setup();

    app.queue.enqueue("run-1", "AAAA");
    app.queue.recorded("run-2");
    await settle();

    expect(app.sent).toEqual([]);
    expect(app.queue.state().pending.map((item) => item.runId)).toEqual(["run-1"]);
  });

  it("нет сети — запись остаётся в очереди, на устройстве, и уходит позже", async () => {
    const app = setup({ answers: [fail("offline")] });

    app.queue.enqueue("run-1", "AAAA");
    app.queue.recorded("run-1");
    await settle();
    expect(app.sent).toHaveLength(1);
    expect(app.queue.state().pending).toEqual([{ runId: "run-1", recorded: true, queuedAtMs: app.clock() }]);
    expect(app.storage.get(RUN_PROOF_QUEUE_KEY)).toContain("AAAA");

    app.advance(60_000);
    await app.queue.flush();
    expect(app.sent).toHaveLength(2);
    expect(app.queue.state().pending).toEqual([]);
    expect(JSON.parse(app.storage.get(RUN_PROOF_QUEUE_KEY) ?? "null")).toEqual([]);
  });

  it("после перезапуска приложения запись из хранилища уходит: подтверждение сервера помнится", async () => {
    const storage = memoryStorage();
    const first = setup({ storage, answers: [fail("offline")] });
    first.queue.enqueue("run-1", "AAAA");
    first.queue.recorded("run-1");
    await settle();

    const second = setup({ storage });
    expect(second.queue.state().pending.map((item) => item.runId)).toEqual(["run-1"]);
    await second.queue.flush();
    expect(second.sent).toEqual([{ runId: "run-1", payload: "AAAA" }]);
  });

  it("сеть, сессия и сервер не ответили — запись ждёт; сервер отверг её — выбрасывается", async () => {
    const waiting: ApiFailure[] = ["offline", "unavailable", "unauthorized", "no_identity", "disabled"];
    for (const failure of waiting) {
      const app = setup({ answers: [fail(failure)] });
      app.queue.enqueue("run-1", "AAAA");
      app.queue.recorded("run-1");
      await settle();
      expect(app.queue.state().pending, failure).toHaveLength(1);
      expect(app.dropped).toEqual([]);
    }

    const rejected = setup({ answers: [fail("rejected")] });
    rejected.queue.enqueue("run-1", "AAAA");
    rejected.queue.recorded("run-1");
    await settle();
    expect(rejected.queue.state().pending).toEqual([]);
    expect(rejected.dropped).toEqual([{ runId: "run-1", reason: "rejected" }]);
  });

  it("другая запись к тому же забегу уже принята (409) — повтор не поможет, запись выбрасывается", async () => {
    const app = setup({ answers: [fail("unavailable", "run_proof_conflict")] });

    app.queue.enqueue("run-1", "AAAA");
    app.queue.recorded("run-1");
    await settle();

    expect(app.queue.state().pending).toEqual([]);
    expect(app.dropped).toEqual([{ runId: "run-1", reason: "conflict" }]);
  });

  it("застрявшая первой запись не держит остальные: уходит каждая, подтверждённая сервером", async () => {
    const app = setup({ answers: [fail("rejected"), OK] });

    app.queue.enqueue("run-1", "AAAA");
    app.queue.enqueue("run-2", "BBBB");
    app.queue.recorded("run-1");
    app.queue.recorded("run-2");
    await settle();

    expect(app.sent.map((item) => item.runId)).toEqual(["run-1", "run-2"]);
    expect(app.queue.state().pending).toEqual([]);
  });

  it(`четвёртая запись вытесняет старую: в очереди не больше ${RUN_PROOF_QUEUE_MAX_ITEMS}`, async () => {
    const app = setup();

    for (const runId of ["run-1", "run-2", "run-3", "run-4"]) {
      app.queue.enqueue(runId, `payload-${runId}`);
      app.advance(10);
    }

    expect(RUN_PROOF_QUEUE_MAX_ITEMS).toBe(3);
    expect(app.queue.state().pending.map((item) => item.runId)).toEqual(["run-2", "run-3", "run-4"]);
    expect(app.storage.get(RUN_PROOF_QUEUE_KEY)).not.toContain("payload-run-1");
    // Вытесненную не отправляет и подтверждение сервера: её нет.
    app.queue.recorded("run-1");
    await settle();
    expect(app.sent).toEqual([]);
  });

  it("повторная запись того же забега заменяет прежнюю, а не занимает второе место", () => {
    const app = setup();

    app.queue.enqueue("run-1", "AAAA");
    app.queue.enqueue("run-1", "BBBB");

    expect(app.queue.state().pending).toHaveLength(1);
    expect(app.storage.get(RUN_PROOF_QUEUE_KEY)).toContain("BBBB");
  });

  it("старше трёх суток — выбрасывается и не отправляется", async () => {
    const storage = memoryStorage();
    const first = setup({ storage, answers: [fail("offline")] });
    first.queue.enqueue("run-old", "AAAA");
    first.queue.recorded("run-old");
    await settle();

    // Свежая запись рядом с просроченной: просроченная уходит, свежая остаётся.
    const later = setup({ storage, start: 1_000_000 + RUN_PROOF_MAX_AGE_MS + 1 });
    later.queue.enqueue("run-new", "BBBB");
    later.queue.recorded("run-new");
    await settle();

    expect(later.sent.map((item) => item.runId)).toEqual(["run-new"]);
    expect(later.queue.state().pending).toEqual([]);
    expect(later.dropped).toEqual([{ runId: "run-old", reason: "expired" }]);
  });

  it("ровно трое суток ещё живёт", async () => {
    const storage = memoryStorage();
    const first = setup({ storage, answers: [fail("offline")] });
    first.queue.enqueue("run-1", "AAAA");
    first.queue.recorded("run-1");
    await settle();

    const later = setup({ storage, start: 1_000_000 + RUN_PROOF_MAX_AGE_MS });
    await later.queue.flush();

    expect(later.sent.map((item) => item.runId)).toEqual(["run-1"]);
  });

  it("хранилище бросает — забег всё равно записан, а запись уходит из памяти", async () => {
    const broken: KeyValueStorage = {
      get: () => {
        throw new Error("хранилище недоступно");
      },
      set: () => {
        throw new Error("хранилище недоступно");
      },
      remove: () => {
        throw new Error("хранилище недоступно");
      },
    };
    const app = setup({ storage: broken });

    expect(() => app.queue.enqueue("run-1", "AAAA")).not.toThrow();
    expect(() => app.queue.recorded("run-1")).not.toThrow();
    await settle();

    expect(app.sent).toEqual([{ runId: "run-1", payload: "AAAA" }]);
    expect(app.queue.state().pending).toEqual([]);
  });

  it("битое значение в хранилище не роняет очередь: она начинается пустой", () => {
    const storage = memoryStorage();
    storage.set(RUN_PROOF_QUEUE_KEY, "{не json");

    expect(setup({ storage }).queue.state().pending).toEqual([]);

    storage.set(RUN_PROOF_QUEUE_KEY, JSON.stringify([{ runId: 5 }]));
    expect(setup({ storage }).queue.state().pending).toEqual([]);
  });

  it("две отправки сразу не уходят параллельно: одну запись не шлют дважды", async () => {
    const app = setup();
    app.queue.enqueue("run-1", "AAAA");
    app.queue.recorded("run-1");

    await Promise.all([app.queue.flush(), app.queue.flush()]);

    expect(app.sent).toHaveLength(1);
  });
});
