import { CONTENT_SNAPSHOT } from "@bh/core-game";
import { describe, expect, it, vi } from "vitest";
import { QUEUE_BUSY_MESSAGE, QUEUE_MAX_WAITING, SNAPSHOT_MAX_BYTES } from "../src/limits";
import { CheckQueueBusyError, SnapshotTooLargeError, submitCheck, type CheckQueueLike } from "../src/queue";

// Очередь проверок (tasks/T-0302): не больше пяти ждущих — шестое задание
// отклоняется с причиной; снимок больше 2 МБ в очередь не ставится.

const SNAPSHOT: unknown = JSON.parse(JSON.stringify(CONTENT_SNAPSHOT));
const job = (checkId = "c-1") => ({ checkId, snapshot: SNAPSHOT, baseSnapshot: SNAPSHOT, scenarios: [] });

function fakeQueue(waiting: number): CheckQueueLike & { added: { name: string; data: unknown; opts: unknown }[] } {
  const added: { name: string; data: unknown; opts: unknown }[] = [];
  return {
    added,
    getWaitingCount: async () => waiting,
    add: async (name, data, opts) => {
      added.push({ name, data, opts });
      return { id: String((opts as { jobId?: string } | undefined)?.jobId ?? "") };
    },
  };
}

describe("постановка задания в очередь", () => {
  it("пятое ждущее — ещё можно, шестое отклоняется с причиной «Проверка уже идёт, дождитесь»", async () => {
    expect(QUEUE_MAX_WAITING).toBe(5);
    const accepting = fakeQueue(4);
    await expect(submitCheck(accepting, job())).resolves.toBe("c-1");
    expect(accepting.added).toHaveLength(1);

    const full = fakeQueue(5);
    await expect(submitCheck(full, job("c-6"))).rejects.toBeInstanceOf(CheckQueueBusyError);
    await expect(submitCheck(full, job("c-6"))).rejects.toThrow(QUEUE_BUSY_MESSAGE);
    expect(QUEUE_BUSY_MESSAGE).toBe("Проверка уже идёт, дождитесь");
    expect(full.added).toHaveLength(0);
  });

  it("задание получает идентификатор проверки как идентификатор в очереди: повтор того же задания не задваивается", async () => {
    const queue = fakeQueue(0);
    await submitCheck(queue, job("c-42"));
    expect(queue.added[0]?.name).toBe("check");
    expect(queue.added[0]?.opts).toMatchObject({ jobId: "c-42", attempts: 1 });
  });

  it("результат и неудача хранятся недолго: очередь не копит снимки в Redis", async () => {
    const queue = fakeQueue(0);
    await submitCheck(queue, job());
    const opts = queue.added[0]?.opts as { removeOnComplete: { age: number }; removeOnFail: { age: number } };
    expect(opts.removeOnComplete.age).toBeGreaterThan(0);
    expect(opts.removeOnComplete.age).toBeLessThanOrEqual(24 * 3600);
    expect(opts.removeOnFail.age).toBeLessThanOrEqual(7 * 24 * 3600);
  });

  it("снимок больше 2 МБ не ставится: ни черновик, ни база", async () => {
    const big = { padding: "я".repeat(SNAPSHOT_MAX_BYTES) };
    const queue = fakeQueue(0);
    await expect(submitCheck(queue, { ...job(), snapshot: big })).rejects.toBeInstanceOf(SnapshotTooLargeError);
    await expect(submitCheck(queue, { ...job(), baseSnapshot: big })).rejects.toThrow("Снимок больше 2 МБ");
    expect(queue.added).toHaveLength(0);
  });

  it("идентификатор с двоеточием или пустой отклоняется до очереди: BullMQ не принимает такие id", async () => {
    const queue = fakeQueue(0);
    await expect(submitCheck(queue, job("a:b"))).rejects.toThrow();
    await expect(submitCheck(queue, job(""))).rejects.toThrow();
    expect(queue.added).toHaveLength(0);
  });

  it("очередь не ответила — исключение наверх, задание не считается принятым", async () => {
    const queue: CheckQueueLike = { getWaitingCount: () => Promise.reject(new Error("redis лежит")), add: vi.fn() };
    await expect(submitCheck(queue, job())).rejects.toThrow("redis лежит");
    expect(queue.add).not.toHaveBeenCalled();
  });
});
