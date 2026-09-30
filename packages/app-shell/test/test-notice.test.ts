import { beforeEach, describe, expect, it } from "vitest";
import type { ApiResult } from "../src/state/api-request";
import { TEST_NOTICE_VERSION, useInstall } from "../src/state/install";
import { useNavigation } from "../src/state/navigation";
import { useShell } from "../src/state/shell";
import { acceptTestNotice, createTestNoticeApi, syncTestNotice, type TestNoticeApi } from "../src/state/test-notice";

// Предупреждение об открытом тесте (docs/35-stage4-plan.md WP33): каждый
// игрок видит его до первой покупки. Новичок — на экране первого запуска,
// принятие досылается на сервер; прежний игрок — отдельным экраном в лобби,
// а не поверх забега; принятое на аккаунте второй раз не спрашивается.

interface FakeServer {
  api: TestNoticeApi;
  accepted: number[];
}

function server(acceptedVersion: number | null, reachable = true): FakeServer {
  const accepted: number[] = [];
  const answer = (version: number | null): ApiResult<{ acceptedVersion: number | null }> =>
    reachable ? { ok: true, data: { acceptedVersion: version } } : { ok: false, failure: "offline" };
  return {
    accepted,
    api: {
      view: async () => answer(acceptedVersion),
      accept: async (version) => {
        accepted.push(version);
        return answer(version);
      },
    },
  };
}

const events: [string, unknown][] = [];

beforeEach(() => {
  events.length = 0;
  const storage = new Map<string, string>();
  useShell.setState({
    analytics: (event: string, payload: unknown) => void events.push([event, payload]),
    storage: { get: (key: string) => storage.get(key) ?? null, set: (key: string, value: string) => void storage.set(key, value), remove: (key: string) => void storage.delete(key) },
  } as never);
  useInstall.setState({ accepted: true, noticeVersion: 0 });
  useNavigation.setState({ stack: ["lobby"] });
});

describe("предупреждение о тесте", () => {
  it("клиент API: принятая версия — GET, принятие — POST с версией текста", async () => {
    const sent: { path: string; method: string; body: unknown }[] = [];
    const api = createTestNoticeApi(async (path, schema, init) => {
      sent.push({ path, method: init.method, body: init.body });
      const parsed = schema.safeParse({ acceptedVersion: 1 });
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, failure: "unavailable" };
    });
    await api.view();
    await api.accept(TEST_NOTICE_VERSION);
    expect(sent).toEqual([
      { path: "/api/v1/me/test-notice", method: "GET", body: undefined },
      { path: "/api/v1/me/test-notice", method: "POST", body: { version: TEST_NOTICE_VERSION } },
    ]);
  });

  it("на аккаунте уже принято — ни экрана, ни запроса", async () => {
    const fake = server(TEST_NOTICE_VERSION);
    await syncTestNotice(fake.api);
    expect(useNavigation.getState().stack).toEqual(["lobby"]);
    expect(fake.accepted).toEqual([]);
  });

  it("принято на экране первого запуска — досылается на сервер, экрана нет, событие — после записи", async () => {
    useInstall.setState({ noticeVersion: TEST_NOTICE_VERSION });
    const fake = server(null);
    await syncTestNotice(fake.api);
    expect(fake.accepted).toEqual([TEST_NOTICE_VERSION]);
    expect(useNavigation.getState().stack).toEqual(["lobby"]);
    expect(events).toEqual([["test_notice_accepted", { version: TEST_NOTICE_VERSION }]]);
  });

  it("не принято нигде — экран в лобби, но не поверх забега", async () => {
    useNavigation.setState({ stack: ["lobby", "run"] });
    await syncTestNotice(server(null).api);
    expect(useNavigation.getState().stack).toEqual(["lobby", "run"]);

    useNavigation.getState().pop();
    expect(useNavigation.getState().stack).toEqual(["lobby", "testNotice"]);
  });

  it("экран первого запуска ещё открыт — ждём; принял на нём — досылается без второго экрана", async () => {
    useInstall.setState({ accepted: false });
    const fake = server(null);
    await syncTestNotice(fake.api);
    expect(useNavigation.getState().stack).toEqual(["lobby"]);

    useInstall.getState().accept();
    await Promise.resolve();
    expect(fake.accepted).toEqual([TEST_NOTICE_VERSION]);
    expect(useNavigation.getState().stack).toEqual(["lobby"]);
  });

  it("старая версия на аккаунте — показывается новая", async () => {
    await syncTestNotice(server(TEST_NOTICE_VERSION - 1).api);
    expect(useNavigation.getState().stack).toEqual(["lobby", "testNotice"]);
  });

  it("«Понятно» без сети — принятие запомнено на устройстве, события нет, дошлётся со следующим входом", async () => {
    const offline = server(null, false);
    expect(await acceptTestNotice(offline.api)).toBe(false);
    expect(useInstall.getState().noticeVersion).toBe(TEST_NOTICE_VERSION);
    expect(events).toEqual([]);

    const online = server(null);
    await syncTestNotice(online.api);
    expect(online.accepted).toEqual([TEST_NOTICE_VERSION]);
  });

  it("сервер недоступен при входе — экрана не навязываем", async () => {
    await syncTestNotice(server(null, false).api);
    expect(useNavigation.getState().stack).toEqual(["lobby"]);
  });
});
