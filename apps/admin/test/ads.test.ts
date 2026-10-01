import { describe, expect, it } from "vitest";
import { blockProblem, coverage, fetchAds, funnelNetworkTitle, percent, priorityProblem, reachLabel, saveBlock, saveNetwork, type AdBlock, type AdBlockInput, type AdNetwork } from "../src/api/ads";
import { AdminApi } from "../src/api/client";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Реклама в панели (docs/35-stage4-plan.md §3.7, WP12): форма проверяет то
// же, что сервер, покрытие мест считается по включённым сетям и блокам,
// окно воронки уходит параметром.

const NETWORKS: AdNetwork[] = [
  { networkKey: "adsgram", name: "AdsGram", active: true, priority: 10 },
  { networkKey: "adsonar", name: "AdSonar", active: true, priority: 20 },
  { networkKey: "taddy", name: "Taddy", active: false, priority: 40 },
];

function block(patch: Partial<AdBlock> = {}): AdBlock {
  return { blockId: "b1", networkKey: "adsgram", place: "wheel_spin", externalId: "int-1", success: "view", active: true, platforms: [], devices: [], ...patch };
}

const input = (patch: Partial<AdBlockInput> = {}): AdBlockInput => ({ ...block(), blockId: null, ...patch });

describe("реклама в панели", () => {
  it("раздел, сеть и блок — по своим адресам; окно воронки — параметром, идентификатор блока обрезается", async () => {
    const view = { networks: NETWORKS, blocks: [block()], funnel: [], days: 30, places: ["wheel_spin"] };
    const { fetch, calls } = fakeFetch(json(200, { data: view }), json(200, { data: NETWORKS[0] }), json(200, { data: block() }));
    const api = new AdminApi(fetch);

    const loaded = await fetchAds(api, 30);
    expect(loaded.ok && loaded.data.days).toBe(30);
    expect(calls[0]?.url).toBe("/api/v1/admin/ads?days=30");

    await saveNetwork(api, { ...NETWORKS[0], name: "лишнее" } as AdNetwork);
    expect(calls[1]?.url).toBe("/api/v1/admin/ads/networks");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ networkKey: "adsgram", active: true, priority: 10 });

    await saveBlock(api, input({ externalId: "  int-7  " }));
    expect(calls[2]?.url).toBe("/api/v1/admin/ads/blocks");
    expect(JSON.parse(String(calls[2]?.init.body))).toMatchObject({ blockId: null, externalId: "int-7", place: "wheel_spin" });
  });

  it("форма блока не пропустит пустой идентификатор, пробелы внутри, слишком длинный и неизвестную сеть; место в круге — целое", () => {
    expect(blockProblem(input(), NETWORKS)).toBeNull();
    expect(blockProblem(input({ externalId: "   " }), NETWORKS)).toMatch(/кабинета сети/);
    expect(blockProblem(input({ externalId: "int 1" }), NETWORKS)).toMatch(/пробелов/);
    expect(blockProblem(input({ externalId: "x".repeat(129) }), NETWORKS)).toMatch(/до 128/);
    expect(blockProblem(input({ networkKey: "" }), NETWORKS)).toMatch(/сеть/);
    expect(priorityProblem(5)).toBeNull();
    expect(priorityProblem(-1)).not.toBeNull();
    expect(priorityProblem(1.5)).not.toBeNull();
  });

  it("покрытие места — только включённые сети с включёнными блоками, по кругу", () => {
    const rows = coverage({
      networks: NETWORKS,
      places: ["wheel_spin", "run_double", "task"],
      blocks: [
        block({ blockId: "1", networkKey: "adsonar" }),
        block({ blockId: "2", networkKey: "adsgram" }),
        block({ blockId: "3", networkKey: "taddy" }),
        block({ blockId: "4", networkKey: "adsgram", place: "run_double", active: false }),
        block({ blockId: "5", networkKey: "adsonar", place: "task" }),
      ],
    });
    expect(rows).toEqual([
      { place: "wheel_spin", networks: ["AdsGram", "AdSonar"] },
      { place: "run_double", networks: [] },
      { place: "task", networks: ["AdSonar"] },
    ]);
  });

  it("доли — целыми процентами, без деления на ноль; где показывается блок — словами", () => {
    expect(percent(1, 3)).toBe("33%");
    expect(percent(0, 0)).toBe("—");
    expect(reachLabel(block())).toBe("все площадки; все устройства");
    expect(reachLabel(block({ platforms: ["telegram"], devices: ["android", "ios"] }))).toBe("telegram; Android, iOS");
  });

  it("в воронке сеть — именем из каталога, награда VIP без ролика — своим названием, незнакомое — ключом", () => {
    const networks = [{ networkKey: "adsgram", name: "AdsGram" }];
    expect(funnelNetworkTitle("adsgram", networks)).toBe("AdsGram");
    expect(funnelNetworkTitle("vip", networks)).toBe("VIP без ролика");
    expect(funnelNetworkTitle("taddy", networks)).toBe("taddy");
  });

  it("раздел — под правом ads.view", () => {
    expect(SECTIONS.find((section) => section.id === "ads")?.permission).toBe("ads.view");
  });
});
