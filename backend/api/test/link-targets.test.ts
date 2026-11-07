import { describe, expect, it, vi } from "vitest";
import { clickDeepTarget, clickTarget, directUrl, LINK_TARGETS } from "../src/modules/links/link-targets.js";

/**
 * Цель ссылки (docs/35-stage4-plan.md Р95): куда ведёт переходник после клика
 * и какой адрес у прямой ссылки. Функции чистые: адреса Mini App и чата
 * собирает адаптер площадки, он приходит подменой.
 */

const builders = {
  // Хвост меток дописывается как есть: `{campaign_id}` кодировать нельзя, сеть ищет макрос буквально.
  launch: (param: string, rawTail?: string) => `https://t.me/rubezh_bot?startapp=${encodeURIComponent(param)}${rawTail ?? ""}`,
  chat: (param: string) => `https://t.me/rubezh_bot?start=${encodeURIComponent(param)}`,
  landingBase: "https://rubezh.example",
};
/** Бот ещё не представился: ни Mini App, ни чата не собрать. */
const notReady = { ...builders, launch: () => null, chat: () => null };

describe("цели ссылки", () => {
  it("три цели, Mini App первая", () => {
    expect(LINK_TARGETS).toEqual(["app", "bot", "landing"]);
  });
});

describe("куда ведёт переходник после клика", () => {
  it("app — Mini App с кодом клика c-<клик>", () => {
    expect(clickTarget("app", "Ab12Cd34Ef56", builders)).toBe("https://t.me/rubezh_bot?startapp=c-Ab12Cd34Ef56");
  });

  it("bot — чат с ботом, /start c-<клик>", () => {
    expect(clickTarget("bot", "Ab12Cd34Ef56", builders)).toBe("https://t.me/rubezh_bot?start=c-Ab12Cd34Ef56");
  });

  it("landing — лендинг с ?c=<клик>, параметр кодируется", () => {
    expect(clickTarget("landing", "Ab12Cd34Ef56", builders)).toBe("https://rubezh.example/?c=Ab12Cd34Ef56");
    expect(clickTarget("landing", "a b&c", builders)).toBe("https://rubezh.example/?c=a%20b%26c");
  });

  it("площадку сейчас не собрать — null; лендингу площадка не нужна", () => {
    expect(clickTarget("app", "Ab12Cd34Ef56", notReady)).toBeNull();
    expect(clickTarget("bot", "Ab12Cd34Ef56", notReady)).toBeNull();
    expect(clickTarget("landing", "Ab12Cd34Ef56", notReady)).toBe("https://rubezh.example/?c=Ab12Cd34Ef56");
  });

  it("адреса лендинга нет (домен не задан) — null, а не относительная ссылка", () => {
    expect(clickTarget("landing", "Ab12Cd34Ef56", { ...builders, landingBase: "" })).toBeNull();
  });
});

describe("прямая ссылка", () => {
  const link = (target: "app" | "bot" | "landing", network: string | null = null) => ({ code: "AbC123xyz9", target, network });

  it("app — Mini App с l-<код>", () => {
    expect(directUrl(link("app"), builders)).toBe("https://t.me/rubezh_bot?startapp=l-AbC123xyz9");
  });

  it("bot — чат с ботом с l-<код>", () => {
    expect(directUrl(link("bot"), builders)).toBe("https://t.me/rubezh_bot?start=l-AbC123xyz9");
  });

  it("landing — лендинг с ?l=<код>", () => {
    expect(directUrl(link("landing"), builders)).toBe("https://rubezh.example/?l=AbC123xyz9");
  });

  it("у ссылки сети с целью app — прямая ссылка на Mini App с кодом, метками и record последним, макросы без кодирования (T-0181)", () => {
    const url = directUrl(link("app", "adsgram"), builders);
    expect(url).toBe("https://t.me/rubezh_bot?startapp=l-AbC123xyz9_campaign-{campaign_id}_clickid-{click_id}_record-{record_data}");
    expect(url).not.toContain("%7B");
    expect(url?.endsWith("_record-{record_data}")).toBe(true);
  });

  it("у ссылки сети с целью bot или landing прямой ссылки нет: в /start метки не уложить, у лендинга параметра запуска нет", () => {
    expect(directUrl(link("bot", "adsgram"), builders)).toBeNull();
    expect(directUrl(link("landing", "adsgram"), builders)).toBeNull();
  });

  it("сеть, о которой сервер не знает, — прямой ссылки нет при любой цели", () => {
    for (const target of LINK_TARGETS) expect(directUrl(link(target, "future-net"), builders), target).toBeNull();
  });

  it("ссылка без сети: все три цели как раньше, хвост меток не передаётся", () => {
    const launch = vi.fn((param: string) => `https://t.me/rubezh_bot?startapp=${encodeURIComponent(param)}`);
    const spy = { ...builders, launch };
    expect(directUrl(link("app"), spy)).toBe("https://t.me/rubezh_bot?startapp=l-AbC123xyz9");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]).toEqual(["l-AbC123xyz9"]);
    expect(directUrl(link("bot"), spy)).toBe("https://t.me/rubezh_bot?start=l-AbC123xyz9");
    expect(directUrl(link("landing"), spy)).toBe("https://rubezh.example/?l=AbC123xyz9");
  });

  it("построитель вернул null — прямой ссылки нет", () => {
    expect(directUrl(link("app"), notReady)).toBeNull();
    expect(directUrl(link("app", "adsgram"), notReady)).toBeNull();
    expect(directUrl(link("bot"), notReady)).toBeNull();
    expect(directUrl(link("landing"), { ...builders, landingBase: "" })).toBeNull();
  });
});

describe("диплинк после клика", () => {
  const deepBuilders = {
    launchDeep: (param: string) => `tg://resolve?domain=rubezh_bot&startapp=${encodeURIComponent(param)}`,
    chatDeep: (param: string) => `tg://resolve?domain=rubezh_bot&start=${encodeURIComponent(param)}`,
  };

  it("app — диплинк Mini App с кодом клика c-<клик>", () => {
    expect(clickDeepTarget("app", "Ab12Cd34Ef56", deepBuilders)).toBe("tg://resolve?domain=rubezh_bot&startapp=c-Ab12Cd34Ef56");
  });

  it("bot — диплинк чата с c-<клик>", () => {
    expect(clickDeepTarget("bot", "Ab12Cd34Ef56", deepBuilders)).toBe("tg://resolve?domain=rubezh_bot&start=c-Ab12Cd34Ef56");
  });

  it("landing — диплинка нет: это страница, а не клиент площадки", () => {
    expect(clickDeepTarget("landing", "Ab12Cd34Ef56", deepBuilders)).toBeNull();
  });

  it("построитель вернул null (площадка без диплинков, бот не представился) — null", () => {
    const none = { launchDeep: () => null, chatDeep: () => null };
    expect(clickDeepTarget("app", "Ab12Cd34Ef56", none)).toBeNull();
    expect(clickDeepTarget("bot", "Ab12Cd34Ef56", none)).toBeNull();
  });
});
