import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import "../src/i18n/tasks";
import { FavoritesStrip } from "../src/screens/meta/achievements";
import { RungDots } from "../src/screens/meta/achievement-card";
import type { OpenAchievement } from "../src/state/achievements-api";

function item(id: string, title: string): OpenAchievement {
  return {
    id,
    category: "run",
    hidden: false,
    kind: "kills",
    title,
    target: 1,
    value: 1,
    done: true,
    claimed: true,
    reward: { coins: 0, gems: 0, shards: 0 },
    prestige: 1,
  };
}

const noop = (): void => undefined;

describe("«Любимые» без обрезки", () => {
  const html = renderToStaticMarkup(createElement(FavoritesStrip, { items: [item("a", "Последний рубеж")], busy: false, onRemove: noop }));

  it("список в один столбец, с 30 rem — в три, внутри контейнера", () => {
    expect(html).toContain("@container");
    expect(html).toContain("grid-cols-1");
    expect(html).toContain("@min-[30rem]:grid-cols-3");
  });

  it("название переносится по словам", () => {
    expect(html).toContain("break-words");
    expect(html).toContain("line-clamp-2");
  });

  it("на узкой колонке видно только первое пустое место", () => {
    // Одно избранное: пустых два, скрыто второе из них.
    expect(html.match(/hidden @min-\[30rem\]:block/g)?.length).toBe(1);
    const none = renderToStaticMarkup(createElement(FavoritesStrip, { items: [], busy: false, onRemove: noop }));
    expect(none.match(/hidden @min-\[30rem\]:block/g)?.length).toBe(2);
  });
});

describe("«Ступень N из M»", () => {
  const rungs = [item("r1", "а"), item("r2", "б")];
  const html = renderToStaticMarkup(createElement(RungDots, { rungs, current: "r2" }));

  it("подпись не переносится, обёртка переносит точки целиком", () => {
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("flex-wrap");
    expect(html).toContain("shrink-0");
  });
});
