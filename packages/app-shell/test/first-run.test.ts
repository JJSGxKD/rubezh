import { afterEach, describe, expect, it } from "vitest";
import { playedBefore, skipFirstRunHints } from "../src/state/first-run";
import { HINT_ORDER, useHints } from "../src/state/hints";
import { useMeta } from "../src/state/meta";
import { useRuns } from "../src/state/runs";
import { useSession } from "../src/state/session";

// Учебный забег — только новичку, а не каждому новому устройству
// (src/state/first-run.ts): согласие хранится на устройстве, забеги — на сервере.

const originalLoadProfile = useRuns.getState().loadProfile;

function serverRuns(runs: number, delayMs = 0): void {
  useRuns.setState({
    loadProfile: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      useMeta.setState({ runs: Math.max(useMeta.getState().runs, runs) });
      return null;
    },
  });
}

afterEach(() => {
  useMeta.setState({ runs: 0 });
  useSession.setState({ status: "idle" });
  useRuns.setState({ loadProfile: originalLoadProfile });
});

describe("играл ли аккаунт раньше", () => {
  it("забеги на этом устройстве — играл, сервер не спрашивается", async () => {
    useMeta.setState({ runs: 2 });
    serverRuns(0);
    expect(await playedBefore()).toBe(true);
  });

  it("новое устройство, у аккаунта есть забеги на сервере — играл", async () => {
    useSession.setState({ status: "ready" });
    serverRuns(5);
    expect(await playedBefore()).toBe(true);
  });

  it("сессия поднимается — ждёт её и спрашивает сервер", async () => {
    useSession.setState({ status: "signing" });
    serverRuns(3);
    const answer = playedBefore();
    setTimeout(() => useSession.setState({ status: "ready" }), 20);
    expect(await answer).toBe(true);
  });

  it("новичок, без сессии или сервер не успел — учебный забег", async () => {
    useSession.setState({ status: "ready" });
    serverRuns(0);
    expect(await playedBefore()).toBe(false);

    useSession.setState({ status: "failed" });
    serverRuns(5);
    expect(await playedBefore()).toBe(false);

    useSession.setState({ status: "ready" });
    serverRuns(5, 200);
    expect(await playedBefore({ timeoutMs: 50 })).toBe(false);
  });

  it("играл — подсказки первого забега отмечаются пройденными", () => {
    useHints.getState().reset();
    skipFirstRunHints();
    expect([...useHints.getState().seen].sort()).toEqual([...HINT_ORDER].sort());
  });
});
