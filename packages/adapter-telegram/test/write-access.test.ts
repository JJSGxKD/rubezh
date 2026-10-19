import { describe, expect, it, vi } from "vitest";
import { requestWriteAccessWith, type WriteAccessBridge } from "../src/write-access";

// Разрешение боту писать (tasks/T-0010): запрос — событие моста, ответ —
// `write_access_requested` со статусом. Нет ответа или отказ — «declined»,
// мост не принял событие — «unavailable»; подписка снимается в любом исходе.

type Handler = (status: string) => void;

function bridge(behaviour: { reply?: string; throws?: boolean }) {
  const handlers = new Set<Handler>();
  const state = { off: 0, posted: 0 };
  const api: WriteAccessBridge = {
    onRequested(handler) {
      handlers.add(handler);
      return () => {
        state.off += 1;
        handlers.delete(handler);
      };
    },
    postRequest() {
      state.posted += 1;
      if (behaviour.throws === true) throw new Error("мост не принял событие");
      if (behaviour.reply !== undefined) {
        const status = behaviour.reply;
        queueMicrotask(() => handlers.forEach((handler) => handler(status)));
      }
    },
  };
  return { api, state, handlers };
}

describe("запрос разрешения боту писать", () => {
  it("allowed — «allowed»", async () => {
    const { api, state, handlers } = bridge({ reply: "allowed" });
    await expect(requestWriteAccessWith(api, 1000)).resolves.toBe("allowed");
    expect(state.posted).toBe(1);
    expect(state.off).toBe(1);
    expect(handlers.size).toBe(0);
  });

  it("cancelled — «declined», подписка снята", async () => {
    const { api, state } = bridge({ reply: "cancelled" });
    await expect(requestWriteAccessWith(api, 1000)).resolves.toBe("declined");
    expect(state.off).toBe(1);
  });

  it("неизвестный статус — тоже «declined»: разрешением его не считаем", async () => {
    const { api } = bridge({ reply: "что-то новое" });
    await expect(requestWriteAccessWith(api, 1000)).resolves.toBe("declined");
  });

  it("нет ответа за таймаут — «declined», подписка снята", async () => {
    vi.useFakeTimers();
    try {
      const { api, state } = bridge({});
      const pending = requestWriteAccessWith(api, 60_000);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toBe("declined");
      expect(state.off).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("мост бросает при отправке — «unavailable», подписка снята", async () => {
    const { api, state, handlers } = bridge({ throws: true });
    await expect(requestWriteAccessWith(api, 1000)).resolves.toBe("unavailable");
    expect(state.off).toBe(1);
    expect(handlers.size).toBe(0);
  });
});
