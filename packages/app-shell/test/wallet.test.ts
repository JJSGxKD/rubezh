import { describe, expect, it } from "vitest";
import type { ApiRequest } from "../src/state/api-request";
import { createWalletApi, useWallet } from "../src/state/wallet";

/**
 * Кошелёк в шапке (docs/35-stage4-plan.md, WP3). Ответ сервера — граница:
 * новые ресурсы в нём не должны ломать разбор у клиента, который ещё не
 * обновился, а неудача не должна стирать показанный баланс.
 */

function answering(body: unknown): ApiRequest {
  return async (_path, schema) => {
    const parsed = schema.safeParse(body);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, failure: "unavailable" };
  };
}

describe("кошелёк клиента", () => {
  it("показывает монеты и самоцветы и пропускает ресурсы, которых клиент не знает", async () => {
    const api = createWalletApi(answering({ balances: { coins: 120, gems: 7, shard_rare: 3 } }));

    expect(await useWallet.getState().load(api)).toBeNull();
    expect(useWallet.getState().balances).toEqual({ coins: 120, gems: 7 });
  });

  it("неудача оставляет показанный баланс и называет причину", async () => {
    useWallet.setState({ balances: { coins: 5, gems: 1 } });
    const offline = createWalletApi(async () => ({ ok: false, failure: "offline" }));

    expect(await useWallet.getState().load(offline)).toBe("offline");
    expect(useWallet.getState().balances).toEqual({ coins: 5, gems: 1 });
  });

  it("ответ без баланса не разбирается — и в шапку не попадает", async () => {
    useWallet.setState({ balances: null });
    const broken = createWalletApi(answering({ balances: { coins: "много" } }));

    expect(await useWallet.getState().load(broken)).toBe("unavailable");
    expect(useWallet.getState().balances).toBeNull();
  });
});
