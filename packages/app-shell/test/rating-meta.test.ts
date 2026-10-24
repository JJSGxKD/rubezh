import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RatingMeta } from "../src/screens/meta/rating";

// Подпись строки рейтинга (design/art/ui-ux.md, U-14): на узком экране она
// резалась на полуслове — «убит…». Теперь поля — отдельными кусками в одну
// строку высотой: не влезло поле — оно уходит целиком, вместе со своей точкой.

const html = renderToStaticMarkup(createElement(RatingMeta, { weaponId: "spark", level: 3, kills: 1234 }));

describe("подпись строки рейтинга", () => {
  it("три поля отдельными кусками, разделитель — у следующего поля", () => {
    expect(html).toContain(">Искра<");
    expect(html).toMatch(/>· ур\.\s3</);
    expect(html).toMatch(/>· убито\s1\s?234</);
  });

  it("строка одной высоты: лишнее поле переносится в скрытую строку, а не режется многоточием", () => {
    const row = /<p class="([^"]*)"/.exec(html)?.[1]?.split(" ") ?? [];
    expect(row).toEqual(expect.arrayContaining(["flex-wrap", "h-lh", "overflow-hidden"]));
    expect(html).not.toContain("truncate");
  });
});
