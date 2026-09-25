import { describe, expect, it } from "vitest";
import { AuthHooks, type LoginEvent } from "../src/modules/auth/auth-hooks.js";
import { FunnelTracker } from "../src/modules/funnel/funnel-tracker.js";
import type { FunnelRepository } from "../src/modules/funnel/funnel.repository.js";
import { PaymentsHooks } from "../src/modules/payments/payments-hooks.js";
import { RunsHooks, type RecordedRun } from "../src/modules/runs/runs-hooks.js";

// Кто ставит вехи воронки (docs/35-stage4-plan.md, Р30). SQL самих вех
// проверяется на живой базе — funnel.integration.test.ts.

const NOW = Date.parse("2026-09-25T12:00:00Z");

class MemoryFunnel implements FunnelRepository {
  readonly calls: string[] = [];
  async entered(accountId: string): Promise<void> {
    this.calls.push(`entered:${accountId}`);
  }
  async appOpened(accountId: string): Promise<void> {
    this.calls.push(`app_opened:${accountId}`);
  }
  async firstRunStarted(accountId: string): Promise<void> {
    this.calls.push(`run_started:${accountId}`);
  }
  async runRecorded(accountId: string): Promise<void> {
    this.calls.push(`run_recorded:${accountId}`);
  }
  async firstPurchase(accountId: string): Promise<void> {
    this.calls.push(`purchase:${accountId}`);
  }
}

function login(patch: Partial<LoginEvent>): LoginEvent {
  return {
    accountId: "a-1",
    platform: "telegram",
    place: "miniapp",
    startParam: { kind: "organic", raw: null, ref: null },
    created: false,
    at: new Date(NOW),
    ip: null,
    userAgent: null,
    client: null,
    reason: "launch",
    ...patch,
  };
}

describe("вехи воронки", () => {
  function tracked() {
    const funnel = new MemoryFunnel();
    const auth = new AuthHooks();
    const runs = new RunsHooks();
    const payments = new PaymentsHooks();
    new FunnelTracker(funnel, auth, runs, payments).onModuleInit();
    return { funnel, auth, runs, payments };
  }

  it("вход в канал — «вошёл», запуск приложения — «открыл», повторный вход посреди работы — ничего", async () => {
    const { funnel, auth } = tracked();
    await auth.emit(login({ place: "channel" }));
    await auth.emit(login({ place: "miniapp" }));
    await auth.emit(login({ place: "miniapp", reason: "reauth" }));
    expect(funnel.calls).toEqual(["entered:a-1", "app_opened:a-1"]);
  });

  it("забег: начало и запись; оплата: только настоящая, тестовая — нет", async () => {
    const { funnel, runs, payments } = tracked();
    await runs.emitStarted({ runId: "r-1", accountId: "a-1", at: new Date(NOW) });
    await runs.emit({ runId: "r-1", accountId: "a-1", finishedAt: new Date(NOW) } as RecordedRun);
    await payments.emitPaid({ purchaseId: "p-1", accountId: "a-1", mode: "test", at: new Date(NOW) });
    await payments.emitPaid({ purchaseId: "p-2", accountId: "a-1", mode: "live", at: new Date(NOW) });
    expect(funnel.calls).toEqual(["run_started:a-1", "run_recorded:a-1", "purchase:a-1"]);
  });

  it("упавшая запись вехи не роняет событие", async () => {
    const funnel = new MemoryFunnel();
    funnel.entered = async () => Promise.reject(new Error("база недоступна"));
    const auth = new AuthHooks();
    new FunnelTracker(funnel, auth, new RunsHooks(), new PaymentsHooks()).onModuleInit();
    await expect(auth.emit(login({ place: "channel" }))).resolves.toBeUndefined();
  });
});

