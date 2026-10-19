import { describe, expect, it } from "vitest";
import { countryOfName } from "../src/country.js";

describe("страна по названию узла", () => {
  it("пара региональных индикаторов — ISO-код", () => {
    expect(countryOfName("🇩🇪 Берлин #3")).toBe("DE");
    expect(countryOfName("Узел 🇳🇱")).toBe("NL");
  });

  it("[DE] или (DE) в начале — регистр не важен", () => {
    expect(countryOfName("[nl] Amsterdam")).toBe("NL");
    expect(countryOfName("(Fr) Paris")).toBe("FR");
  });

  it("нет признака — null; код в середине строки и длинные слова не считаются", () => {
    expect(countryOfName("Frankfurt")).toBeNull();
    expect(countryOfName("Server [DE]")).toBeNull();
    expect(countryOfName("[DEU] Berlin")).toBeNull();
    expect(countryOfName("")).toBeNull();
  });

  it("существование страны не проверяется", () => {
    expect(countryOfName("[ZZ] Nowhere")).toBe("ZZ");
  });
});
