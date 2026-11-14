import { describe, expect, it } from "vitest";
import { hrefOf, parseRoute } from "../src/routes";
import { PROXY_TABS, proxyTabOf, proxyTabRoute } from "../src/screens/proxies/proxies-tabs";

describe("вкладки раздела «Прокси»", () => {
  it("порядок и названия", () => {
    expect(PROXY_TABS.map((tab) => tab.id)).toEqual(["xray", "traffic", "core", "manual", "modes"]);
    expect(PROXY_TABS.map((tab) => tab.title)).toEqual(["Подписки Xray", "Трафик", "Ядро Xray", "Ручные прокси", "Режимы"]);
  });

  it("нет вкладки или чужая — «Подписки Xray»", () => {
    for (const value of [undefined, null, "", "nope"]) expect(proxyTabOf(value)).toBe("xray");
    expect(proxyTabOf("modes")).toBe("modes");
    expect(proxyTabOf("core")).toBe("core");
  });

  it("вкладка по умолчанию — без хвоста в адресе", () => {
    expect(hrefOf(proxyTabRoute("xray"))).toBe("#/proxies");
    expect(hrefOf(proxyTabRoute("manual"))).toBe("#/proxies/manual");
    expect(hrefOf(proxyTabRoute("core"))).toBe("#/proxies/core");
  });

  it("адрес туда и обратно", () => {
    expect(proxyTabOf(parseRoute("#/proxies/traffic")?.id)).toBe("traffic");
  });
});
