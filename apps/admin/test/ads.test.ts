import { describe, expect, it } from "vitest";
import {
  adPlatforms,
  blockFormOf,
  blockFormSchema,
  blockInputOf,
  blockReaches,
  coverage,
  emptyBlockForm,
  fetchAds,
  funnelNetworkTitle,
  networkFormOf,
  networkFormSchema,
  networkPlatforms,
  percent,
  placeOptions,
  reachLabel,
  saveBlock,
  saveNetwork,
  type AdBlock,
  type AdNetwork,
  type AdNetworkProfile,
  type AdsView,
  type BlockForm,
} from "../src/api/ads";
import { AdminApi } from "../src/api/client";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Реклама в панели (docs/35-stage4-plan.md WP12, части 2 и 5): формы
// строятся по профилям сетей с сервера и не пропускают то, что сервер
// отвергнет, — задание AdsGram на крутку колеса, блок у сети, которая
// показывает по ключам, сеть без ключей включённой.

const PROFILES: AdNetworkProfile[] = [
  {
    key: "adsgram",
    title: "AdsGram",
    cabinet: "https://partner.adsgram.ai",
    platforms: ["telegram"],
    keys: [],
    formats: [
      { format: "rewarded", title: "Reward", unit: { title: "Block ID", hint: "число", example: "12345", pattern: "^[0-9]{1,12}$" }, success: ["view"] },
      { format: "interstitial", title: "Interstitial", unit: { title: "Block ID", hint: "int-", example: "int-12345", pattern: "^int-[0-9]{1,12}$" }, success: ["view"] },
      { format: "task", title: "Task", unit: { title: "Block ID", hint: "task-", example: "task-12345", pattern: "^task-[0-9]{1,12}$" }, success: ["cpa"], maxActive: 1 },
    ],
    verified: true,
  },
  {
    key: "richads",
    title: "RichAds",
    cabinet: null,
    platforms: ["telegram"],
    keys: [
      { key: "pubId", title: "Publisher ID (pubId)", hint: "число", example: "792361", pattern: "^[0-9]{1,12}$" },
      { key: "appId", title: "App ID (appId)", hint: "число", example: "1396", pattern: "^[0-9]{1,12}$" },
    ],
    formats: [
      { format: "rewarded", title: "Video", unit: null, success: ["view"] },
      { format: "interstitial", title: "Banner", unit: null, success: ["view"] },
    ],
    verified: true,
  },
  {
    key: "taddy",
    title: "Taddy",
    cabinet: null,
    platforms: ["telegram"],
    keys: [{ key: "pubId", title: "pubId", hint: "32 hex", example: "14cbeb980853dd416003462ca4db7c12", pattern: "^[0-9a-f]{32}$" }],
    formats: [
      {
        format: "task",
        title: "Задания",
        unit: {
          title: "Источник заданий",
          hint: "два пути",
          example: "exchange",
          pattern: "^(?:exchange|app-task)$",
          options: [
            { value: "exchange", title: "Обмен", hint: "проверка" },
            { value: "app-task", title: "Рекламные", hint: "лиды" },
          ],
        },
        success: ["cpa"],
      },
    ],
    verified: true,
  },
];

const NETWORKS: AdNetwork[] = [
  { networkKey: "adsgram", name: "AdsGram", active: true, priority: 10, keys: {}, missing: [], problem: null },
  { networkKey: "richads", name: "RichAds", active: true, priority: 30, keys: { pubId: "792361" }, missing: ["App ID (appId)"], problem: null },
  { networkKey: "taddy", name: "Taddy", active: false, priority: 40, keys: {}, missing: ["pubId"], problem: null },
];

const FORMATS = { second_chance: "rewarded", wheel_spin: "rewarded", run_double: "rewarded", task: "task", interstitial: "interstitial" };

function block(patch: Partial<AdBlock> = {}): AdBlock {
  return { blockId: "b1", networkKey: "adsgram", place: "wheel_spin", externalId: "123", success: "view", active: true, platforms: [], devices: [], problem: null, ...patch };
}

function view(patch: Partial<AdsView> = {}): AdsView {
  return { networks: NETWORKS, blocks: [], funnel: [], days: 7, places: ["second_chance", "wheel_spin", "run_double", "task", "interstitial"], profiles: PROFILES, formats: FORMATS, testMode: false, ...patch };
}

function form(patch: Partial<BlockForm> = {}): BlockForm {
  return { ...emptyBlockForm("adsgram"), place: "wheel_spin", externalId: "123", success: "view", ...patch };
}

function blockErrors(values: BlockForm, current: AdsView = view(), editing: string | null = null): Record<string, string> {
  const result = blockFormSchema(current, editing).safeParse(values);
  return result.success ? {} : Object.fromEntries(result.error.issues.map((issue) => [issue.path.join("."), issue.message]));
}

describe("реклама в панели: обмен с сервером", () => {
  it("раздел, сеть и блок — по своим адресам; ключи сети обрезаются, пустой блок уходит как «блока нет»", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: view({ days: 30 }) }), json(200, { data: NETWORKS[1] }), json(200, { data: block() }));
    const api = new AdminApi(fetch);

    const loaded = await fetchAds(api, 30);
    expect(loaded.ok && loaded.data.profiles.map((profile) => profile.key)).toEqual(["adsgram", "richads", "taddy"]);
    expect(calls[0]?.url).toBe("/api/v1/admin/ads?days=30");

    await saveNetwork(api, "richads", { active: false, priority: 30, keys: { pubId: " 792361 ", appId: "" } });
    expect(calls[1]?.url).toBe("/api/v1/admin/ads/networks");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ networkKey: "richads", active: false, priority: 30, keys: { pubId: "792361", appId: "" } });

    await saveBlock(api, { blockId: null, networkKey: "richads", place: "interstitial", externalId: "  ", success: "view", active: true, platforms: [], devices: [] });
    expect(calls[2]?.url).toBe("/api/v1/admin/ads/blocks");
    expect(JSON.parse(String(calls[2]?.init.body))).toMatchObject({ blockId: null, networkKey: "richads", externalId: null });
  });

  it("ответ сервера до профилей сетей — без ключей и профилей — читается, а не роняет раздел", async () => {
    const old = { networks: [{ networkKey: "adsgram", name: "AdsGram", active: true, priority: 10 }], blocks: [{ ...block(), problem: undefined }], funnel: [], days: 7, places: ["wheel_spin"] };
    const loaded = await fetchAds(new AdminApi(fakeFetch(json(200, { data: old })).fetch), 7);
    expect(loaded.ok && loaded.data.networks[0]).toMatchObject({ keys: {}, missing: [], problem: null });
    expect(loaded.ok && loaded.data.profiles).toEqual([]);
  });
});

describe("реклама в панели: форма блока по профилю сети", () => {
  it("места — по форматам сети; недоступные — с причиной словами", () => {
    const richads = placeOptions(view(), "richads");
    expect(richads.filter((option) => option.support !== null).map((option) => option.place)).toEqual(["second_chance", "wheel_spin", "run_double", "interstitial"]);
    expect(richads.find((option) => option.place === "task")?.reason).toBe("месту нужен формат «задание сети», у RichAds его нет");
    expect(placeOptions(view(), "monetag")[0]?.reason).toBe("сети нет в коде");
  });

  it("задание AdsGram на крутку колеса не встаёт; межстраничная — только int-, задание — только task-", () => {
    expect(blockErrors(form())).toEqual({});
    expect(blockErrors(form({ externalId: "task-1" }))).toEqual({ externalId: "Block ID для этого места выглядит как «12345»" });
    expect(blockErrors(form({ place: "interstitial", externalId: "123" }))).toMatchObject({ externalId: expect.stringMatching(/int-12345/) });
    expect(blockErrors(form({ place: "task", externalId: "task-1", success: "cpa" }))).toEqual({});
    expect(blockErrors(form({ externalId: "" }))).toEqual({ externalId: "Нужен Block ID — пример «12345»" });
    expect(blockErrors(form({ success: "cpa" }))).toEqual({ success: "Здесь успех — показ" });
    expect(blockErrors(form({ place: "" }))).toEqual({ place: "Выберите место" });
    expect(blockErrors(form({ networkKey: "" }))).toEqual({ networkKey: "Выберите сеть" });
  });

  it("сеть, что показывает по ключам, блока не принимает; источник заданий Taddy — из списка", () => {
    expect(blockErrors(form({ networkKey: "richads", externalId: "" }))).toEqual({});
    expect(blockErrors(form({ networkKey: "richads", externalId: "123" }))).toEqual({ externalId: "У формата нет блока в кабинете — показ по ключам сети" });
    expect(blockErrors(form({ networkKey: "richads", place: "task", externalId: "" }))).toEqual({ place: "RichAds не показывает в этом месте" });
    expect(blockErrors(form({ networkKey: "taddy", place: "task", externalId: "exchange", success: "cpa" }))).toEqual({});
    expect(blockErrors(form({ networkKey: "taddy", place: "task", externalId: "", success: "cpa" }))).toEqual({ externalId: "Выберите: источник заданий" });
    expect(blockErrors(form({ networkKey: "taddy", place: "task", externalId: "feed", success: "cpa" }))).toMatchObject({ externalId: expect.any(String) });
  });

  it("Task-блок AdsGram — один включённый; правка его самого лимит не трогает", () => {
    const current = view({ blocks: [block({ blockId: "task-on", place: "task", externalId: "task-1", success: "cpa" })] });
    const second = form({ place: "task", externalId: "task-2", success: "cpa" });
    expect(blockErrors(second, current)).toEqual({ active: "AdsGram держит 1 включённый блок этого формата — выключите прежний" });
    expect(blockErrors({ ...second, active: false }, current)).toEqual({});
    expect(blockErrors(second, current, "task-on")).toEqual({});
  });

  it("блок для сервера: пустой идентификатор — «блока нет», условие не выбрано — по формату", () => {
    expect(blockInputOf(view(), form({ networkKey: "richads", externalId: " ", success: "" }), null)).toMatchObject({ externalId: null, success: "view" });
    expect(blockInputOf(view(), form({ place: "task", externalId: " task-9 ", success: "" }), "b9")).toMatchObject({ blockId: "b9", externalId: "task-9", success: "cpa" });
    expect(blockInputOf(view(), form({ place: "" }), null)).toBeNull();
  });
});

describe("реклама в панели: сети", () => {
  it("ключи сети — по виду; включить без всех ключей нельзя, выключенной — задавать по одному", () => {
    const profile = PROFILES[1];
    const errors = (values: { active: boolean; keys: Record<string, string> }) => {
      const result = networkFormSchema(profile).safeParse({ priority: 30, ...values });
      return result.success ? {} : Object.fromEntries(result.error.issues.map((issue) => [issue.path.join("."), issue.message]));
    };
    expect(errors({ active: false, keys: { pubId: "792361", appId: "" } })).toEqual({});
    expect(errors({ active: true, keys: { pubId: "792361", appId: "" } })).toEqual({ "keys.appId": "Без этого ключа сеть не включить" });
    expect(errors({ active: false, keys: { pubId: "pub-1", appId: "" } })).toEqual({ "keys.pubId": "Не похоже на значение из кабинета — пример «792361»" });
    expect(errors({ active: true, keys: { pubId: "792361", appId: "1396" } })).toEqual({});
    expect(networkFormSchema(undefined).safeParse({ active: true, priority: 1, keys: {} }).success).toBe(false);
    expect(networkFormSchema(profile).safeParse({ active: false, priority: 1.5, keys: {} }).success).toBe(false);
  });

  it("форма сети берёт ключи профиля — заданные и пустые; лишнего ключа из базы в форме нет", () => {
    expect(networkFormOf({ ...NETWORKS[1], keys: { pubId: "792361", legacy: "x" } } as AdNetwork, PROFILES[1])).toEqual({ active: true, priority: 30, keys: { pubId: "792361", appId: "" } });
  });

  it("покрытие места — только сети, что реально показывают: включённая, с ключами, блок по правилам", () => {
    const rows = coverage(
      view({
        blocks: [
          block({ blockId: "1" }),
          block({ blockId: "2", networkKey: "richads", externalId: null }),
          block({ blockId: "3", networkKey: "adsgram", place: "run_double", problem: "не по правилам" }),
        ],
      }),
    );
    // RichAds без appId не показывает — в покрытие не попадает.
    expect(rows.find((row) => row.place === "wheel_spin")?.platforms).toEqual([{ platform: "telegram", networks: ["AdsGram"], possible: true }]);
    expect(rows.find((row) => row.place === "run_double")?.platforms).toEqual([{ platform: "telegram", networks: [], possible: true }]);
  });

  it("покрытие — по площадкам: блок «везде» сети Telegram не покрывает VK, площадок без сетей в таблице нет", () => {
    const adsgram = PROFILES[0] as AdNetworkProfile;
    const withVk: AdNetworkProfile = { ...adsgram, key: "vknet", title: "VK Ads", platforms: ["vk"], formats: adsgram.formats.filter((support) => support.format === "rewarded") };
    const shown = view({
      profiles: [...PROFILES, withVk],
      networks: [...NETWORKS, { networkKey: "vknet", name: "VK Ads", active: true, priority: 50, keys: {}, missing: [], problem: null }],
      blocks: [block({ blockId: "1" }), block({ blockId: "2", networkKey: "vknet" })],
    });
    expect(adPlatforms(shown)).toEqual(["telegram", "vk"]);
    expect(coverage(shown).find((row) => row.place === "wheel_spin")?.platforms).toEqual([
      { platform: "telegram", networks: ["AdsGram"], possible: true },
      { platform: "vk", networks: ["VK Ads"], possible: true },
    ]);
    // Заданий у сетей VK нет — пустота там не ошибка настройки, предупреждать не о чем.
    expect(coverage(shown).find((row) => row.place === "task")?.platforms.find((cell) => cell.platform === "vk")).toEqual({ platform: "vk", networks: [], possible: false });
    expect(adPlatforms(view())).toEqual(["telegram"]);
    expect(blockReaches(shown, block(), "vk")).toBe(false);
    expect(blockReaches(shown, block({ platforms: ["telegram"] }), "telegram")).toBe(true);
  });

  it("форма блока: чужие площадки не уходят на сервер, все площадки сети — то же, что «везде»", () => {
    const form = { ...blockFormOf(block({ platforms: ["telegram", "vk"] })) };
    expect(blockInputOf(view(), form, "1")?.platforms).toEqual([]);
    expect(networkPlatforms(view(), "adsgram")).toEqual(["telegram"]);
    expect(networkPlatforms(view(), "monetag")).toEqual([]);
  });

  it("сервер без площадок в профиле — сеть везде, как было; незнакомая площадка отбрасывается", async () => {
    // Профиль сервера до площадок — без поля вовсе.
    const legacy: Partial<AdNetworkProfile> = { ...PROFILES[0] };
    delete legacy.platforms;
    const { fetch } = fakeFetch(
      json(200, { data: { ...view({ profiles: [] }), profiles: [legacy, { ...PROFILES[1], platforms: ["telegram", "ok"] }] } }),
    );
    const result = await fetchAds(new AdminApi(fetch), 7);
    expect(result.ok && result.data.profiles.map((profile) => profile.platforms)).toEqual([["telegram", "max", "vk", "web"], ["telegram"]]);
  });
});

describe("реклама в панели: мелочи", () => {
  it("раздел — под правом просмотра рекламы; доли и подписи", () => {
    expect(SECTIONS.find((section) => section.id === "ads")?.permission).toBe("ads.view");
    expect(percent(1, 3)).toBe("33%");
    expect(percent(0, 0)).toBe("—");
    expect(reachLabel(view(), block({ platforms: ["telegram"], devices: ["android", "ios"] }))).toBe("Telegram; Android, iOS");
    // Пустой список площадок — там, где работает сеть, а не «все площадки».
    expect(reachLabel(view(), block())).toBe("Telegram; все устройства");
    expect(funnelNetworkTitle("vip", NETWORKS)).toBe("VIP без ролика");
    expect(funnelNetworkTitle("adsgram", NETWORKS)).toBe("AdsGram");
    expect(funnelNetworkTitle("monetag", NETWORKS)).toBe("monetag");
  });
});
