import { beforeEach, describe, expect, it } from "vitest";
import type { ApiResult } from "../src/state/api-request";
import {
  claimCompensation,
  compensationLines,
  createCompensationApi,
  syncCompensation,
  useCompensation,
  type CompensationApi,
  type CompensationView,
} from "../src/state/compensation";
import { useNavigation } from "../src/state/navigation";
import { useShell } from "../src/state/shell";

// Компенсация тестеру после вайпа (docs/35-stage4-plan.md Р87, tasks/T-0043):
// окно «Спасибо за тест» приходит один раз, в лобби, и не закрывается, пока
// игрок не забрал положенное. Сеть и сервер подменены.

const FULL: CompensationView = {
  tester: true,
  level: 12,
  bonusGems: 60,
  restored: [
    { resource: "gems", amount: 150 },
    { resource: "coins", amount: 40 },
  ],
  continueGems: 12,
};

const PURCHASES_ONLY: CompensationView = {
  tester: false,
  level: 1,
  bonusGems: 0,
  restored: [{ resource: "gems", amount: 330 }],
  continueGems: 0,
};

interface FakeServer {
  api: CompensationApi;
  claims: number;
}

function server(pending: CompensationView | null, claim: { alreadyClaimed?: boolean; ok?: boolean } = {}, reachable = true): FakeServer {
  const fake: FakeServer = {
    claims: 0,
    api: {
      pending: async (): Promise<ApiResult<CompensationView | null>> =>
        reachable ? { ok: true, data: pending } : { ok: false, failure: "offline" },
      claim: async () => {
        fake.claims++;
        if (!reachable || claim.ok === false || pending === null) return { ok: false, failure: "offline" };
        return { ok: true, data: { view: pending, alreadyClaimed: claim.alreadyClaimed ?? false, balances: { gems: { coins: 0, gems: 500 } } } };
      },
    },
  };
  return fake;
}

const events: [string, unknown][] = [];

beforeEach(() => {
  events.length = 0;
  const storage = new Map<string, string>();
  useShell.setState({
    analytics: (event: string, payload: unknown) => void events.push([event, payload]),
    storage: { get: (key: string) => storage.get(key) ?? null, set: (key: string, value: string) => void storage.set(key, value), remove: (key: string) => void storage.delete(key) },
  } as never);
  useNavigation.setState({ stack: ["lobby"] });
  useCompensation.setState({ pending: null });
});

describe("строки окна «Спасибо за тест»", () => {
  it("тестер с покупками: самоцветы купленного суммой ресурса, второй шанс, бонус и знак", () => {
    expect(compensationLines(FULL)).toEqual({ restoredGems: 150, continueGems: 12, bonusGems: 60, badge: true, total: 222 });
  });

  it("только покупал: бонуса и знака нет", () => {
    expect(compensationLines(PURCHASES_ONLY)).toEqual({ restoredGems: 330, continueGems: 0, bonusGems: 0, badge: false, total: 330 });
  });

  it("монеты в «Купленном за звёзды» не считаются самоцветами", () => {
    const lines = compensationLines({ ...PURCHASES_ONLY, restored: [{ resource: "coins", amount: 90 }] });
    expect(lines.restoredGems).toBe(0);
    expect(lines.total).toBe(0);
  });
});

describe("клиент компенсации", () => {
  it("ждущая — GET, «Забрать» — POST без тела", async () => {
    const sent: { path: string; method: string; body: unknown }[] = [];
    const api = createCompensationApi(async (path, schema, init) => {
      sent.push({ path, method: init.method, body: init.body });
      return { ok: false, failure: "unavailable" } as never as ApiResult<never>;
    });
    await api.pending();
    await api.claim();
    expect(sent).toEqual([
      { path: "/api/v1/me/compensation", method: "GET", body: undefined },
      { path: "/api/v1/me/compensation/claim", method: "POST", body: undefined },
    ]);
  });
});

describe("окно компенсации после входа", () => {
  it("нечего забирать — экрана нет", async () => {
    await syncCompensation(server(null).api);
    expect(useNavigation.getState().stack).toEqual(["lobby"]);
    expect(useCompensation.getState().pending).toBeNull();
  });

  it("сервер недоступен — экрана не навязываем", async () => {
    await syncCompensation(server(FULL, {}, false).api);
    expect(useNavigation.getState().stack).toEqual(["lobby"]);
    expect(useCompensation.getState().pending).toBeNull();
  });

  it("компенсация ждёт, игрок в лобби — экран кладётся, вид запомнен", async () => {
    await syncCompensation(server(FULL).api);
    expect(useNavigation.getState().stack).toEqual(["lobby", "testerThanks"]);
    expect(useCompensation.getState().pending).toEqual(FULL);
  });

  it("игрок в забеге — экран только когда верхним снова станет лобби", async () => {
    useNavigation.setState({ stack: ["lobby", "run"] });
    await syncCompensation(server(FULL).api);
    expect(useNavigation.getState().stack).toEqual(["lobby", "run"]);

    useNavigation.getState().pop();
    expect(useNavigation.getState().stack).toEqual(["lobby", "testerThanks"]);
  });

  it("поверх лобби открыто предупреждение о тесте — окно после его закрытия", async () => {
    useNavigation.setState({ stack: ["lobby", "testNotice"] });
    await syncCompensation(server(FULL).api);
    expect(useNavigation.getState().stack).toEqual(["lobby", "testNotice"]);

    useNavigation.getState().pop();
    expect(useNavigation.getState().stack).toEqual(["lobby", "testerThanks"]);
  });
});

describe("«Забрать»", () => {
  it("успех: окно можно закрывать, событие с полями, вид убран", async () => {
    const fake = server(FULL);
    await syncCompensation(fake.api);

    expect(await claimCompensation(fake.api)).toBe(true);
    expect(events).toEqual([["compensation_claimed", { tester: true, bonusGems: 60, restoredGems: 150, continueGems: 12 }]]);
    expect(useCompensation.getState().pending).toBeNull();
  });

  it("повторный забор (уже забрано) — окно закрывается, события нет", async () => {
    const fake = server(FULL, { alreadyClaimed: true });
    await syncCompensation(fake.api);

    expect(await claimCompensation(fake.api)).toBe(true);
    expect(events).toEqual([]);
    expect(useCompensation.getState().pending).toBeNull();
  });

  it("ошибка: окно остаётся, вид на месте, события нет", async () => {
    const fake = server(FULL, { ok: false });
    await syncCompensation(fake.api);

    expect(await claimCompensation(fake.api)).toBe(false);
    expect(events).toEqual([]);
    expect(useCompensation.getState().pending).toEqual(FULL);
  });

  it("повтор после ошибки безопасен: вторая попытка проходит", async () => {
    const failing = server(FULL, { ok: false });
    await syncCompensation(failing.api);
    expect(await claimCompensation(failing.api)).toBe(false);

    expect(await claimCompensation(server(FULL).api)).toBe(true);
    expect(events).toHaveLength(1);
  });
});
