import { describe, expect, it, vi } from "vitest";
import { loadAppConfig } from "../src/config/app-config.js";
import { RateLimitedError, UnauthorizedError } from "../src/common/domain-error.js";
import { addressOf } from "../src/common/request-address.js";
import { AdsController } from "../src/modules/ads/ads.controller.js";
import { AdsgramRewardController } from "../src/modules/ads/adsgram-reward.controller.js";
import { AuthController } from "../src/modules/auth/auth.controller.js";
import type { RateLimit } from "../src/modules/ingest/rate-limiter.js";
import { RolesController } from "../src/modules/roles/roles.controller.js";
import { AdsToolsController } from "../src/modules/ads/ads-tools.controller.js";
import { ToolsController } from "../src/modules/roles/tools.controller.js";
import { RunsController } from "../src/modules/runs/runs.controller.js";
import { AUTH_ENV } from "./helpers/auth-env.js";

/**
 * Лимиты частоты на маршрутах игрока (tasks/T-0022): у каждого маршрута своя
 * область, ключ — аккаунт или адрес, а превышение — `RateLimitedError` (429)
 * до обращения к сервису. Контроллеры создаются напрямую, зависимости — подмены.
 */

class RecordingLimiter {
  readonly calls: { scope: string; key: string }[] = [];
  allow = true;
  async consume(rule: RateLimit, key: string): Promise<boolean> {
    this.calls.push({ scope: rule.scope, key });
    return this.allow;
  }
}

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000022";
const ADDRESS = "203.0.113.7";
const request = { ip: ADDRESS, headers: {}, account: { accountId: ACCOUNT_ID, platform: "telegram" as const, platformUserId: "1" } };
const config = loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV } as NodeJS.ProcessEnv);

interface RouteCase {
  name: string;
  scope: string;
  /** ключ лимита: аккаунт или адрес */
  key: string;
  /** собрать контроллер и вернуть вызов маршрута и подмену сервиса, которую нельзя трогать при отказе */
  build(limiter: RecordingLimiter): { call(): Promise<unknown>; service: ReturnType<typeof vi.fn> };
}

const ok = async () => ({});

const ROUTES: RouteCase[] = [
  {
    name: "POST /auth/logout",
    scope: "auth:logout",
    key: ADDRESS,
    build: (limiter) => {
      const logout = vi.fn(ok);
      const controller = new AuthController({ logout } as never, limiter as never, config);
      return { call: async () => await controller.logout(request, { refreshToken: "r".repeat(32) }), service: logout };
    },
  },
  {
    name: "POST /auth/logout-all",
    scope: "auth:logout-all",
    key: ACCOUNT_ID,
    build: (limiter) => {
      const logoutEverywhere = vi.fn(async () => 1);
      const controller = new AuthController({ logoutEverywhere } as never, limiter as never, config);
      return { call: async () => await controller.logoutAll(request), service: logoutEverywhere };
    },
  },
  {
    name: "GET /auth/me",
    scope: "auth:me",
    key: ACCOUNT_ID,
    // «Кто я» отвечает из токена, сервиса у маршрута нет — его роль играет проверка, что лимит стоит раньше ответа.
    build: (limiter) => {
      const controller = new AuthController({} as never, limiter as never, config);
      const reached = vi.fn();
      return {
        call: async () => {
          const response = await controller.me(request);
          reached();
          return response;
        },
        service: reached,
      };
    },
  },
  {
    name: "GET /roles/me",
    scope: "roles:me",
    key: ACCOUNT_ID,
    build: (limiter) => {
      const rolesFor = vi.fn(async () => []);
      const controller = new RolesController({ rolesFor } as never, limiter as never);
      return { call: async () => await controller.me(request), service: rolesFor };
    },
  },
  {
    name: "GET /tools/access",
    scope: "tools:access",
    key: ACCOUNT_ID,
    build: (limiter) => {
      const forAccount = vi.fn(ok);
      const controller = new ToolsController({ forAccount } as never, limiter as never);
      return { call: async () => await controller.access(request), service: forAccount };
    },
  },
  {
    name: "GET /tools/ads/catalog",
    scope: "ads_tools_catalog",
    key: ACCOUNT_ID,
    build: (limiter) => {
      const catalog = vi.fn(ok);
      const controller = new AdsToolsController({ catalog } as never, { can: async () => true } as never, limiter as never);
      return { call: async () => await controller.catalog(request), service: catalog };
    },
  },
  {
    name: "POST /tools/ads/test-results",
    scope: "ads_tools_result",
    key: ACCOUNT_ID,
    build: (limiter) => {
      const recordResult = vi.fn(ok);
      const controller = new AdsToolsController({ recordResult } as never, { can: async () => true } as never, limiter as never);
      const body = { network: "adsgram", format: "rewarded", blockId: null, live: false, outcome: "completed", ms: 100 };
      return { call: async () => await controller.testResult(request, body), service: recordResult };
    },
  },
  {
    name: "GET /runs/leaderboard",
    scope: "runs:leaderboard",
    key: ACCOUNT_ID,
    build: (limiter) => {
      const leaderboardFor = vi.fn(ok);
      const controller = new RunsController({} as never, { leaderboardFor } as never, limiter as never, {} as never);
      return { call: async () => await controller.leaderboard(request, "easy"), service: leaderboardFor };
    },
  },
  {
    name: "PUT /runs/:runId/proof",
    scope: "runs:proof",
    key: ACCOUNT_ID,
    build: (limiter) => {
      const receive = vi.fn(ok);
      const controller = new RunsController({} as never, {} as never, limiter as never, { receive } as never);
      return { call: async () => await controller.proof(request, "00000000-0000-4000-8000-000000000099", { proof: "AA==" }), service: receive };
    },
  },
  {
    name: "GET /runs/me",
    scope: "runs:profile",
    key: ACCOUNT_ID,
    build: (limiter) => {
      const profile = vi.fn(ok);
      const controller = new RunsController({} as never, { profile } as never, limiter as never, {} as never);
      return { call: async () => await controller.me(request), service: profile };
    },
  },
  {
    name: "GET /ads/networks",
    scope: "ads_networks",
    key: ACCOUNT_ID,
    build: (limiter) => {
      const launchSetup = vi.fn(async () => []);
      const controller = new AdsController({} as never, limiter as never, { launchSetup } as never, { expected: async () => false } as never);
      return { call: async () => await controller.networks(request), service: launchSetup };
    },
  },
];

describe.each(ROUTES)("$name", (route) => {
  it("лимит пропускает — одна проверка с областью и ключом из таблицы, сервис вызван", async () => {
    const limiter = new RecordingLimiter();
    const { call, service } = route.build(limiter);

    await call();

    expect(limiter.calls).toEqual([{ scope: route.scope, key: route.key }]);
    expect(service).toHaveBeenCalled();
  });

  it("лимит исчерпан — RateLimitedError, сервис не вызван", async () => {
    const limiter = new RecordingLimiter();
    limiter.allow = false;
    const { call, service } = route.build(limiter);

    await expect(call()).rejects.toBeInstanceOf(RateLimitedError);
    expect(service).not.toHaveBeenCalled();
  });
});

describe("GET /ads/adsgram/reward/:secret/:userId", () => {
  const SECRET = "adsgram-secret-value";

  function build(limiter: RecordingLimiter) {
    const confirm = vi.fn(async () => "confirmed");
    const controller = new AdsgramRewardController({ confirm } as never, { get: () => SECRET } as never, limiter as never);
    return { controller, confirm };
  }

  it("лимит адреса исчерпан, а секрет неверный — RateLimitedError: лимит стоит раньше сверки", async () => {
    const limiter = new RecordingLimiter();
    limiter.allow = false;
    const { controller, confirm } = build(limiter);

    await expect(controller.reward(request, "чужой-секрет", "777")).rejects.toBeInstanceOf(RateLimitedError);
    expect(limiter.calls).toEqual([{ scope: "ads_adsgram_reward_ip", key: ADDRESS }]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("секрет неверный, лимит адреса пропускает — UnauthorizedError, проверялся только адрес", async () => {
    const limiter = new RecordingLimiter();
    const { controller, confirm } = build(limiter);

    await expect(controller.reward(request, "чужой-секрет", "777")).rejects.toBeInstanceOf(UnauthorizedError);
    expect(limiter.calls).toEqual([{ scope: "ads_adsgram_reward_ip", key: ADDRESS }]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("секрет верный — сначала адрес, затем игрок; награда подтверждена", async () => {
    const limiter = new RecordingLimiter();
    const { controller, confirm } = build(limiter);

    expect(await controller.reward(request, SECRET, "777")).toEqual({ data: { rewarded: true } });
    expect(limiter.calls).toEqual([
      { scope: "ads_adsgram_reward_ip", key: ADDRESS },
      { scope: "ads_adsgram_reward_user", key: "777" },
    ]);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("лимит игрока исчерпан — RateLimitedError, подтверждение не зовётся", async () => {
    const limiter = new RecordingLimiter();
    const { controller, confirm } = build(limiter);
    limiter.consume = async (rule, key) => {
      limiter.calls.push({ scope: rule.scope, key });
      return rule.scope !== "ads_adsgram_reward_user";
    };

    await expect(controller.reward(request, SECRET, "777")).rejects.toBeInstanceOf(RateLimitedError);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("адрес запроса", () => {
  it("берётся из ip запроса", () => {
    expect(addressOf({ ip: "203.0.113.7" })).toBe("203.0.113.7");
  });

  it.each([{ ip: "" }, {}, null, "строка", { ip: 5 }])("без адреса — «unknown»: %j", (value) => {
    expect(addressOf(value)).toBe("unknown");
  });
});
