import { describe, expect, it } from "vitest";
import { FORMAT_IDS, FORMATS, formatSize } from "../src/index.js";

describe("форматы", () => {
  it("пять форматов первой волны с заданными размерами", () => {
    expect(FORMAT_IDS).toEqual(["story", "square", "portrait", "wide", "link_preview"]);
    const sizes = Object.fromEntries(FORMAT_IDS.map((id) => [id, [FORMATS[id].width, FORMATS[id].height]]));
    expect(sizes).toEqual({ story: [1080, 1920], square: [1080, 1080], portrait: [1080, 1350], wide: [1280, 720], link_preview: [1200, 630] });
  });

  it("у каждого формата есть русская подпись и совпадающий id", () => {
    for (const id of FORMAT_IDS) {
      expect(FORMATS[id].id).toBe(id);
      expect(FORMATS[id].label.length).toBeGreaterThan(0);
    }
  });

  it("formatSize отдаёт ширину и высоту", () => {
    expect(formatSize("square")).toEqual({ width: 1080, height: 1080 });
  });
});
