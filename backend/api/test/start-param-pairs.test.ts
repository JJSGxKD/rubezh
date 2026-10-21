import { describe, expect, it } from "vitest";
import { parseStartParam } from "../src/modules/attribution/start-param.js";
import { AUTO_KEYS, RESERVED_KEYS, parsePairs } from "../src/modules/attribution/start-param-pairs.js";

// Параметр запуска из пар «ключ-значение» (Р116, docs/24-attribution-and-sharing.md §3.6):
// чистый разбор. Проверяется то, на чём формат ломается: порядок и регистр, склейка с
// занятыми приставками (`c-`, `l-`, `f-`, `n-`), зарезервированные ключи входа в панель и
// границы, за которыми строка уже не пары, а мусор.

describe("разбор пар ключ-значение", () => {
  it("известные ключи — четыре, в каноническом порядке; зарезервированы вход в панель и роль", () => {
    expect(AUTO_KEYS).toEqual(["src", "cmp", "plc", "prt"]);
    expect(RESERVED_KEYS).toEqual(["panel", "role"]);
  });

  it("известные пары раскладываются по ключам, канонический набор — в порядке ключей", () => {
    expect(parsePairs("src-tgads_cmp-oct")).toEqual({ known: { src: "tgads", cmp: "oct" }, canonical: "src-tgads_cmp-oct", unknownKeys: [] });
    expect(parsePairs("src-tgads_cmp-oct_plc-post_prt-ivan")).toEqual({
      known: { src: "tgads", cmp: "oct", plc: "post", prt: "ivan" },
      canonical: "src-tgads_cmp-oct_plc-post_prt-ivan",
      unknownKeys: [],
    });
  });

  it("порядок пар и регистр на набор не влияют: всё в нижнем регистре, ключи по порядку", () => {
    expect(parsePairs("CMP-Oct_SRC-TGads")?.canonical).toBe("src-tgads_cmp-oct");
    expect(parsePairs("prt-Ivan_plc-Post_cmp-OCT_src-TgAds")?.canonical).toBe("src-tgads_cmp-oct_plc-post_prt-ivan");
    expect(parsePairs("cmp-oct_src-tgads")).toEqual(parsePairs("src-tgads_cmp-oct"));
  });

  it("одна известная пара — тоже набор", () => {
    expect(parsePairs("cmp-oct")).toEqual({ known: { cmp: "oct" }, canonical: "cmp-oct", unknownKeys: [] });
    expect(parsePairs("prt-ivan")).toEqual({ known: { prt: "ivan" }, canonical: "prt-ivan", unknownKeys: [] });
  });

  it("незнакомые ключи не входят в набор, а перечисляются по алфавиту", () => {
    expect(parsePairs("cmp-oct_zzz-1")).toEqual({ known: { cmp: "oct" }, canonical: "cmp-oct", unknownKeys: ["zzz"] });
    expect(parsePairs("zzz-1_cmp-oct_aaa-2")).toEqual({ known: { cmp: "oct" }, canonical: "cmp-oct", unknownKeys: ["aaa", "zzz"] });
  });

  it("ключ в нижнем регистре и у незнакомых", () => {
    expect(parsePairs("src-a_ZzZ-1")?.unknownKeys).toEqual(["zzz"]);
  });

  it("только незнакомые ключи: набора нет, ключи перечислены", () => {
    expect(parsePairs("zzz-1_yyy-2")).toEqual({ known: {}, canonical: null, unknownKeys: ["yyy", "zzz"] });
  });

  it("границы длины: ключ 2–16 знаков, значение 1–24", () => {
    expect(parsePairs("ab-1")).not.toBeNull();
    expect(parsePairs(`${"k".repeat(16)}-1`)).not.toBeNull();
    expect(parsePairs(`src-${"v".repeat(24)}`)?.known.src).toBe("v".repeat(24));
    expect(parsePairs(`${"k".repeat(17)}-1`)).toBeNull();
    expect(parsePairs(`src-${"v".repeat(25)}`)).toBeNull();
  });

  it("не пары — null: повтор ключа, пустые части, ключ в один знак, дефис в значении", () => {
    const notPairs = [
      "src-a_src-b",
      "src-a_SRC-b",
      "src-a_",
      "_src-a",
      "src-a__cmp-b",
      "src-",
      "-a",
      "src-a-b",
      "s-1",
      "1a-b",
      "src_a",
      "src",
      "",
      "src-a_cmp",
    ];
    for (const value of notPairs) expect(parsePairs(value), value).toBeNull();
  });

  it("зарезервированные ключи — не пары: вход в панель и подтверждение роли остаются за ботом", () => {
    for (const value of ["panel-x1", "role-x1", "src-a_panel-x1", "PANEL-x1", "role-x1_cmp-oct"]) expect(parsePairs(value), value).toBeNull();
  });

  it("значение в 25 знаков и семь пар — не пары", () => {
    expect(parsePairs(`src-${"v".repeat(25)}`)).toBeNull();
    expect(parsePairs("src-a_cmp-b_plc-c_prt-d_aa-1_bb-2_cc-3")).toBeNull();
    // Шесть — предел.
    expect(parsePairs("src-a_cmp-b_plc-c_prt-d_aa-1_bb-2")).not.toBeNull();
  });
});

describe("пары в разборе параметра запуска", () => {
  it("известные пары — вид «tagged»: сырая строка как пришла, ref — канонический набор", () => {
    expect(parseStartParam("src-tgads_cmp-oct")).toEqual({ kind: "tagged", raw: "src-tgads_cmp-oct", ref: "src-tgads_cmp-oct", unknownKeys: [] });
  });

  it("порядок и регистр не плодят наборов: ref один, сырая строка сохраняется как была", () => {
    expect(parseStartParam("CMP-Oct_SRC-TGads")).toEqual({ kind: "tagged", raw: "CMP-Oct_SRC-TGads", ref: "src-tgads_cmp-oct", unknownKeys: [] });
  });

  it("известные вместе с незнакомыми — tagged, а незнакомые ключи несёт результат", () => {
    expect(parseStartParam("cmp-oct_zzz-1")).toEqual({ kind: "tagged", raw: "cmp-oct_zzz-1", ref: "cmp-oct", unknownKeys: ["zzz"] });
  });

  it("только незнакомые ключи — «unknown» с сырой строкой и списком ключей", () => {
    expect(parseStartParam("zzz-1_yyy-2")).toEqual({ kind: "unknown", raw: "zzz-1_yyy-2", ref: null, unknownKeys: ["yyy", "zzz"] });
  });

  it("не пары — «unknown» с сырой строкой и без поля unknownKeys", () => {
    for (const value of ["src-a_src-b", "src-a_", "_src-a", "src-", "src-a-b", "s-1", "panel-x1", "role-x1", `src-${"v".repeat(25)}`, "src-a_cmp-b_plc-c_prt-d_aa-1_bb-2_cc-3"]) {
      const parsed = parseStartParam(value);
      expect(parsed, value).toEqual({ kind: "unknown", raw: value, ref: null });
      expect(parsed, value).not.toHaveProperty("unknownKeys");
    }
  });

  it("то, чего Telegram не пропускает, по-прежнему не хранится даже сырым", () => {
    expect(parseStartParam("src-а_cmp-b")).toEqual({ kind: "unknown", raw: null, ref: null });
    expect(parseStartParam(`src-${"a".repeat(61)}`)).toEqual({ kind: "unknown", raw: null, ref: null });
  });

  it("старые форматы разбираются до пар и пар не касаются", () => {
    expect(parseStartParam("c-AbCdEf123456")).toEqual({ kind: "click", raw: "c-AbCdEf123456", ref: "AbCdEf123456" });
    expect(parseStartParam("l-AbCdEf1234")).toEqual({ kind: "link", raw: "l-AbCdEf1234", ref: "AbCdEf1234" });
    expect(parseStartParam("f-AbCdEf1234")).toEqual({ kind: "friend", raw: "f-AbCdEf1234", ref: "AbCdEf1234" });
    expect(parseStartParam("n-friend_request")).toEqual({ kind: "notification", raw: "n-friend_request", ref: "friend_request" });
    expect(parseStartParam("invite")).toEqual({ kind: "invite", raw: "invite", ref: null });
    expect(parseStartParam("_tgr_123")).toEqual({ kind: "telegram_affiliate", raw: "_tgr_123", ref: "123" });
  });

  it("клик, прямая ссылка и дружба со склейкой пар остаются неузнанными, а не становятся tagged", () => {
    // Однобуквенная приставка — не ключ пары; значение с дефисом внутри — не пара.
    for (const value of ["c-abc", "l-abc-defgh", "f-abc-defgh", "n-Friend1"]) expect(parseStartParam(value), value).toEqual({ kind: "unknown", raw: value, ref: null });
  });
});
