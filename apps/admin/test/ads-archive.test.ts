import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { archiveBlock, fetchAds, unarchiveBlock, type AdBlock, type AdNetwork, type AdNetworkProfile, type AdsView } from "../src/api/ads";
import { AdminApi } from "../src/api/client";
import { BlocksPanel } from "../src/screens/ads/BlocksPanel";
import { BLOCKS_TABS, archiveTone, blockStateText, blockSubject, blocksOfTab, blocksTabCounts } from "../src/screens/ads/blocks-view";
import { HELP } from "../src/ui/help";
import { fakeFetch, json } from "./helpers";

// Архив рекламных блоков в панели (docs/35-stage4-plan.md Р200, tasks/T-0409):
// вкладки «Действующие» и «Архив» делят блоки по отметке, состояние блока
// называется теми же словами в таблице и в окне подтверждения, а кнопки «В
// архив» и «Вернуть» есть только у того, кто правит рекламу.

const ADSGRAM: AdNetworkProfile = {
  key: "adsgram",
  title: "AdsGram",
  cabinet: null,
  platforms: ["telegram"],
  keys: [],
  formats: [{ format: "rewarded", title: "Reward", unit: { title: "Block ID", hint: "число", example: "12345", pattern: "^[0-9]{1,12}$" }, success: ["view"] }],
  verified: true,
};

const NETWORKS: AdNetwork[] = [
  { networkKey: "adsgram", name: "AdsGram", active: true, priority: 10, keys: {}, missing: [], problem: null },
  { networkKey: "richads", name: "RichAds", active: true, priority: 30, keys: { pubId: "792361" }, missing: ["App ID (appId)"], problem: null },
  { networkKey: "taddy", name: "Taddy", active: false, priority: 40, keys: {}, missing: [], problem: null },
];

const ARCHIVED_AT = "2026-11-09T12:00:00.000Z";

function block(patch: Partial<AdBlock> = {}): AdBlock {
  return { blockId: "b1", networkKey: "adsgram", place: "wheel_spin", externalId: "123", success: "view", active: true, platforms: [], devices: [], problem: null, archivedAt: null, ...patch };
}

function view(blocks: AdBlock[]): AdsView {
  return {
    networks: NETWORKS,
    blocks,
    funnel: [],
    passes: [],
    days: 7,
    places: ["second_chance", "wheel_spin", "run_double", "task", "interstitial"],
    profiles: [ADSGRAM],
    formats: { second_chance: "rewarded", wheel_spin: "rewarded", run_double: "rewarded", task: "task", interstitial: "interstitial" },
    testMode: false,
  };
}

const CURRENT_A = block({ blockId: "a" });
const ARCHIVED_B = block({ blockId: "b", place: "run_double", externalId: "456", active: false, archivedAt: ARCHIVED_AT });
const CURRENT_C = block({ blockId: "c", place: "second_chance", externalId: "789", active: false });
const MIXED = [CURRENT_A, ARCHIVED_B, CURRENT_C];

describe("архив рекламных блоков: вкладки", () => {
  it("вкладки: «Действующие» первая, потом «Архив»", () => {
    expect(BLOCKS_TABS).toEqual([
      { id: "current", title: "Действующие" },
      { id: "archive", title: "Архив" },
    ]);
  });

  it("блоки делятся по отметке архива, порядок сервера сохраняется", () => {
    expect(blocksOfTab(MIXED, "current").map((item) => item.blockId)).toEqual(["a", "c"]);
    expect(blocksOfTab(MIXED, "archive").map((item) => item.blockId)).toEqual(["b"]);
    expect(blocksOfTab([], "archive")).toEqual([]);
  });

  it("числа на чипах: нуль показывается", () => {
    expect(blocksTabCounts(MIXED)).toEqual({ current: 2, archive: 1 });
    expect(blocksTabCounts([])).toEqual({ current: 0, archive: 0 });
    expect(blocksTabCounts([ARCHIVED_B])).toEqual({ current: 0, archive: 1 });
  });
});

describe("архив рекламных блоков: состояние словами", () => {
  it("не по правилам сети, выключен, в выдаче, ждёт сеть — те же слова, что в колонке «Состояние»", () => {
    const all = view([]);
    expect(blockStateText(all, block({ problem: "AdsGram: Block ID выглядит как «12345»" }))).toBe("не по правилам сети");
    // Правила сети важнее включённости: выключенный, но неверный блок так и назван.
    expect(blockStateText(all, block({ problem: "что-то не так", active: false }))).toBe("не по правилам сети");
    expect(blockStateText(all, block({ active: false }))).toBe("выключен");
    expect(blockStateText(all, block())).toBe("в выдаче");
    expect(blockStateText(all, block({ networkKey: "taddy" }))).toBe("ждёт сеть");
    // Сеть включена, но ключей не хватает — выдача её не возьмёт.
    expect(blockStateText(all, block({ networkKey: "richads" }))).toBe("ждёт сеть");
  });

  it("подпись блока для окна подтверждения — «место · сеть · блок»; без блока в кабинете — «по ключам сети»", () => {
    const all = view([]);
    expect(blockSubject(all, block())).toBe("Крутка колеса · AdsGram · 123");
    expect(blockSubject(all, block({ networkKey: "richads", place: "interstitial", externalId: null }))).toBe("Между забегами · RichAds · по ключам сети");
    expect(blockSubject(all, block({ networkKey: "unknown" }))).toBe("Крутка колеса · unknown · 123");
  });

  it("кнопка подтверждения красная, только когда блок сейчас в выдаче", () => {
    const all = view([]);
    expect(archiveTone(all, block())).toBe("danger");
    expect(archiveTone(all, block({ active: false }))).toBe("primary");
    expect(archiveTone(all, block({ networkKey: "taddy" }))).toBe("primary");
    expect(archiveTone(all, block({ problem: "не по правилам" }))).toBe("primary");
  });
});

describe("архив рекламных блоков: обмен с сервером", () => {
  it("«В архив» и «Вернуть» — POST по адресам блока, ответ разбирается блоком с отметкой", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: ARCHIVED_B }), json(200, { data: { ...ARCHIVED_B, archivedAt: null } }));
    const api = new AdminApi(fetch);

    const archived = await archiveBlock(api, "b");
    expect(calls[0]?.url).toBe("/api/v1/admin/ads/blocks/b/archive");
    expect(calls[0]?.init.method).toBe("POST");
    expect(archived.ok && archived.data).toMatchObject({ blockId: "b", active: false, archivedAt: ARCHIVED_AT });

    const restored = await unarchiveBlock(api, "b");
    expect(calls[1]?.url).toBe("/api/v1/admin/ads/blocks/b/unarchive");
    expect(calls[1]?.init.method).toBe("POST");
    expect(restored.ok && restored.data).toMatchObject({ blockId: "b", active: false, archivedAt: null });
  });

  it("идентификатор блока в пути экранируется", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: ARCHIVED_B }), json(200, { data: ARCHIVED_B }));
    const api = new AdminApi(fetch);
    await archiveBlock(api, "a/b?c");
    await unarchiveBlock(api, "a/b?c");
    expect(calls[0]?.url).toBe("/api/v1/admin/ads/blocks/a%2Fb%3Fc/archive");
    expect(calls[1]?.url).toBe("/api/v1/admin/ads/blocks/a%2Fb%3Fc/unarchive");
  });

  it("отказ сервера приходит ошибкой с его текстом, а не исключением", async () => {
    const { fetch } = fakeFetch(json(404, { error: { code: "ad_block_not_found", message: "Такого рекламного блока нет" } }));
    const result = await archiveBlock(new AdminApi(fetch), "gone");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.message).toBe("Такого рекламного блока нет");
  });

  it("ответ сервера до архива — без archivedAt — разбирается в archivedAt: null", async () => {
    const legacy: Partial<AdBlock> = { ...block() };
    delete legacy.archivedAt;
    const loaded = await fetchAds(new AdminApi(fakeFetch(json(200, { data: { ...view([]), blocks: [legacy] } })).fetch), 7);
    expect(loaded.ok && loaded.data.blocks[0]).toMatchObject({ blockId: "b1", archivedAt: null });

    const withMark = await fetchAds(new AdminApi(fakeFetch(json(200, { data: view([ARCHIVED_B]) })).fetch), 7);
    expect(withMark.ok && withMark.data.blocks[0]?.archivedAt).toBe(ARCHIVED_AT);
  });
});

describe("архив рекламных блоков: панель «Блоки мест»", () => {
  const render = (props: { canEdit: boolean; initialTab?: "current" | "archive"; blocks?: AdBlock[] }) =>
    renderToStaticMarkup(createElement(BlocksPanel, { view: view(props.blocks ?? MIXED), canEdit: props.canEdit, onSaved: () => undefined, ...(props.initialTab === undefined ? {} : { initialTab: props.initialTab }) }));
  const count = (html: string, text: string) => html.split(`>${text}<`).length - 1;

  it("над таблицей чипы с числами и подсказкой об архиве; по умолчанию открыты «Действующие»", () => {
    const html = render({ canEdit: true });
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Блоки"');
    expect(html).toContain("Действующие · 2");
    expect(html).toContain("Архив · 1");
    expect(html).toMatch(/aria-selected="true"[^>]*>Действующие · 2/);
    expect(HELP.ads.archive).toMatch(/Вернуть/);
    expect(HELP.ads.archive).toMatch(/выключенным/);
  });

  it("«Действующие» без прав: те же блоки, кнопок «В архив» и «Вернуть» нет", () => {
    const html = render({ canEdit: false });
    expect(html).toContain("в выдаче");
    expect(html).toContain("выключен");
    expect(count(html, "В архив")).toBe(0);
    expect(count(html, "Вернуть")).toBe(0);
  });

  it("«Действующие» с правом: «В архив» в каждой строке, блоков из архива в таблице нет", () => {
    const html = render({ canEdit: true });
    expect(count(html, "В архив")).toBe(2);
    expect(count(html, "Вернуть")).toBe(0);
    expect(html).not.toContain("456");
    expect(html).toContain("123");
    expect(html).toContain("789");
    // колонки действующих
    expect(html).toContain("Состояние");
    expect(html).not.toContain("В архиве с");
  });

  it("«Архив» с правом: колонки «Успех» и «В архиве с», «Вернуть» в каждой строке, «В архив» нет, действующих блоков нет", () => {
    const html = render({ canEdit: true, initialTab: "archive" });
    expect(count(html, "Вернуть")).toBe(1);
    expect(count(html, "В архив")).toBe(0);
    expect(html).toContain("В архиве с");
    expect(html).toContain("Успех");
    expect(html).toContain("456");
    expect(html).not.toContain("789");
    expect(html).not.toContain("Состояние");
    expect(html).toContain('aria-selected="true"');
  });

  it("«Архив» без прав: вкладка видна, блок в списке, кнопок «Вернуть» и «В архив» нет", () => {
    const html = render({ canEdit: false, initialTab: "archive" });
    expect(html).toContain("456");
    expect(count(html, "Вернуть")).toBe(0);
    expect(count(html, "В архив")).toBe(0);
  });

  it("пустые вкладки говорят разное", () => {
    expect(render({ canEdit: true, blocks: [ARCHIVED_B] })).toContain("Блоков нет — заведите блок кнопкой «Новый блок»");
    expect(render({ canEdit: true, blocks: [CURRENT_A], initialTab: "archive" })).toContain("В архиве пусто — сюда попадают блоки, убранные кнопкой «В архив»");
    expect(render({ canEdit: true, blocks: [], initialTab: "archive" })).toContain("Архив · 0");
  });
});
