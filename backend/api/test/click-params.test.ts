import { describe, expect, it } from "vitest";
import { POSTBACK_PARAMS, clickParamsOf } from "../src/modules/links/click-params.js";
import { isMacroValue, networkParamsOf } from "../src/modules/links/link-networks.js";

/**
 * Что ссылка сохраняет на клике (tasks/T-0070): метки сети — как раньше, а у ссылки с владельцем-партнёром
 * или со своим адресом постбэка — ещё и `click_id`, `sub1`…`sub5`, которые партнёр положил в адрес.
 */

const PARTNER = { partnerId: "6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f", name: "Канал" };
const ADDRESS = "https://track.example.com/pb?cid={click_id}";

type LinkShape = Parameters<typeof clickParamsOf>[0];

function link(patch: Partial<LinkShape> = {}): LinkShape {
  return { network: null, partner: null, postbackUrl: null, ...patch };
}

describe("clickParamsOf", () => {
  it("ссылка партнёра: click_id и sub1…sub5 сохраняются, лишнее и неподставленное — нет", () => {
    const query = { click_id: "abc", sub1: "x", sub9: "y", sub2: "{sub2}", utm_source: "tg" };
    expect(clickParamsOf(link({ partner: PARTNER }), query)).toEqual({ click_id: "abc", sub1: "x" });
  });

  it("обычная ссылка без сети, владельца и адреса — null: на клик ничего не пишется", () => {
    expect(clickParamsOf(link(), { click_id: "abc", sub1: "x" })).toBeNull();
  });

  it("ссылка со своим адресом без владельца сохраняет", () => {
    expect(clickParamsOf(link({ postbackUrl: ADDRESS }), { click_id: "abc", sub3: "z" })).toEqual({ click_id: "abc", sub3: "z" });
  });

  it("ссылка партнёра без параметров в запросе — null, а не пустой объект", () => {
    expect(clickParamsOf(link({ partner: PARTNER }), {})).toBeNull();
    expect(clickParamsOf(link({ partner: PARTNER }), { utm_source: "tg" })).toBeNull();
  });

  it("ссылка сети без владельца и адреса — только метки сети, как раньше", () => {
    const query = { campaign: "55", record: "rec1", click_id: "abc", sub1: "x" };
    expect(clickParamsOf(link({ network: "adsgram" }), query)).toEqual(networkParamsOf("adsgram", query));
    expect(clickParamsOf(link({ network: "adsgram" }), query)).toEqual({ campaign: "55", record: "rec1" });
  });

  it("AdsGram с владельцем и адресом — оба набора вместе", () => {
    const query = { campaign: "55", clickid: "n1", record: "rec1", click_id: "abc", sub1: "x", sub5: "v" };
    expect(clickParamsOf(link({ network: "adsgram", partner: PARTNER, postbackUrl: ADDRESS }), query)).toEqual({
      campaign: "55",
      clickid: "n1",
      record: "rec1",
      click_id: "abc",
      sub1: "x",
      sub5: "v",
    });
  });

  it("значение длиннее 256, с пробелом, с «{» и с управляющим знаком отбрасывается; крайние 256 и пробелы по краям — нет", () => {
    const query = {
      click_id: "я".repeat(3),
      sub1: "a".repeat(257),
      sub2: "a b",
      sub3: "a{b",
      sub4: "a".repeat(256),
      sub5: "  trimmed  ",
    };
    expect(clickParamsOf(link({ partner: PARTNER }), query)).toEqual({ sub4: "a".repeat(256), sub5: "trimmed" });
    expect(clickParamsOf(link({ partner: PARTNER }), { sub1: "a\u0007b" })).toBeNull();
  });

  it("правило значения одно на сеть и партнёра — isMacroValue", () => {
    expect(isMacroValue("abc-123_x.y")).toBe(true);
    expect(isMacroValue("a".repeat(256))).toBe(true);
    expect(isMacroValue("a".repeat(257))).toBe(false);
    expect(isMacroValue("")).toBe(false);
    expect(isMacroValue("a b")).toBe(false);
    expect(isMacroValue("{record_data}")).toBe(false);
    expect(isMacroValue("привет")).toBe(false);
  });

  it("ключи — ровно click_id и sub1…sub5", () => {
    expect([...POSTBACK_PARAMS]).toEqual(["click_id", "sub1", "sub2", "sub3", "sub4", "sub5"]);
  });

  it("повторный параметр в запросе сервер уже свёл к строке; необъявленный ключ в клик не попадает", () => {
    const query: Record<string, string | undefined> = { sub1: undefined, click_id: "abc", constructor: "x", toString: "y" };
    expect(clickParamsOf(link({ partner: PARTNER }), query)).toEqual({ click_id: "abc" });
  });
});
