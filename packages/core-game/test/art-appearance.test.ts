import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { heroFrameNames, skinAtlasFor } from "../src/game/render/art-atlas";

// Облик героя в забеге (tasks/T-0239): только вид — кадры из атласа облика.
// Хитбокс, симуляция и CONTENT_HASH не затронуты: это проверяют golden-тесты баланса.

const KEEPER = {
  idle: ["hero/idle0", "hero/idle1"],
  walk: ["hero/walk0", "hero/walk1", "hero/walk2", "hero/walk3"],
  hurt: "hero/hurt0",
};

describe("кадры героя по облику", () => {
  const all = (): boolean => true;

  it("без облика и Хранитель — кадры hero/… атласа core, атлас облика не спрашивают", () => {
    const asked: string[] = [];
    const has = (name: string): boolean => {
      asked.push(name);
      return true;
    };
    expect(heroFrameNames(undefined, has)).toEqual(KEEPER);
    expect(heroFrameNames("keeper", has)).toEqual(KEEPER);
    expect(asked).toEqual([]);
  });

  it("облик при всех кадрах — его покой и шаг; ранение — кадр покоя", () => {
    expect(heroFrameNames("vityaz", all)).toEqual({
      idle: ["hero-vityaz/idle0", "hero-vityaz/idle1"],
      walk: ["hero-vityaz/walk0", "hero-vityaz/walk1", "hero-vityaz/walk2", "hero-vityaz/walk3"],
      hurt: "hero-vityaz/idle0",
    });
  });

  it("не хватает хоть одного кадра — Хранитель целиком, а не смесь", () => {
    expect(heroFrameNames("vityaz", (name) => name !== "hero-vityaz/walk3")).toEqual(KEEPER);
    expect(heroFrameNames("vityaz", (name) => name !== "hero-vityaz/idle1")).toEqual(KEEPER);
  });

  it("неизвестный облик — Хранитель", () => {
    expect(heroFrameNames("no_such_skin", (name) => name.startsWith("hero/"))).toEqual(KEEPER);
  });
});

describe("атласы обликов", () => {
  const outDir = new URL("../../../design/art/out/", import.meta.url);
  const ids = readdirSync(outDir)
    .map((file) => /^atlas-skin-(.+)\.json$/.exec(file)?.[1])
    .filter((id): id is string => id !== undefined);

  it("атласы лежат в design/art/out", () => {
    expect(ids.length).toBeGreaterThan(0);
  });

  it("у каждого облика есть адрес атласа, а у Хранителя и чужого id — нет", () => {
    for (const id of ids) {
      const urls = skinAtlasFor(id);
      expect(urls, id).not.toBeNull();
      expect(urls?.png).toContain(`atlas-skin-${id}`);
      expect(urls?.json).toContain(`atlas-skin-${id}`);
    }
    expect(skinAtlasFor("keeper")).toBeNull();
    expect(skinAtlasFor(undefined)).toBeNull();
    expect(skinAtlasFor("no_such_skin")).toBeNull();
  });

  it("в каждом атласе полный набор кадров, иначе облик показал бы Хранителя", () => {
    for (const id of ids) {
      const atlas = JSON.parse(readFileSync(new URL(`atlas-skin-${id}.json`, outDir), "utf8")) as { frames: Record<string, unknown> };
      expect(heroFrameNames(id, (name) => name in atlas.frames).idle[0], id).toBe(`hero-${id}/idle0`);
    }
  });
});
