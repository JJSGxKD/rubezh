import { randomUUID } from "node:crypto";
import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDENTITY_SOURCES, PublicIdentity, markOf, type PublicMark } from "../src/common/public-identity.js";
import {
  APPEARANCES,
  DEFAULT_APPEARANCE,
  ELITE_ACHIEVEMENT_ID,
  NAVI_MAX_PLACE,
  type AppearanceSource,
} from "../src/modules/appearance/appearance-catalog.js";
import { appearanceChoiceSchema, effectiveAppearance, heldAppearances, type AppearanceState } from "../src/modules/appearance/appearance-rules.js";

/**
 * Облики-архетипы, правила без базы (docs/35-stage4-plan.md Р150, tasks/T-0237):
 * какими обликами владеет игрок и какой из них действует. Владение вычисляется при
 * чтении по состоянию аккаунта — ничего не хранится и не снимается.
 */

const NOBODY: AppearanceState = { level: 1, vipActive: false, bestSeasonPlace: null, doneAchievements: new Set<string>(), weeklyTopClaimed: false };
const held = (patch: Partial<AppearanceState>) => [...heldAppearances({ ...NOBODY, ...patch })].sort();

describe("каталог обликов", () => {
  it("десять обликов с уникальными id, порядок как в задаче", () => {
    expect(APPEARANCES.map((def) => def.id)).toEqual(["keeper", "frost", "herbalist", "gilded", "vityaz", "vedunya", "ohotnitsa", "skomoroh", "knyaz", "navi"]);
    expect(new Set(APPEARANCES.map((def) => def.id)).size).toBe(10);
  });

  it("архетип и редкость по таблице", () => {
    const row = (id: string) => APPEARANCES.find((def) => def.id === id);
    expect(row("keeper")).toMatchObject({ archetype: "keeper", rarity: "common" });
    expect(row("frost")).toMatchObject({ archetype: "keeper", rarity: "common" });
    expect(row("herbalist")).toMatchObject({ archetype: "keeper", rarity: "uncommon" });
    expect(row("gilded")).toMatchObject({ archetype: "keeper", rarity: "uncommon" });
    expect(row("vityaz")).toMatchObject({ archetype: "vityaz", rarity: "rare" });
    expect(row("vedunya")).toMatchObject({ archetype: "vedunya", rarity: "rare" });
    expect(row("ohotnitsa")).toMatchObject({ archetype: "ohotnitsa", rarity: "epic" });
    expect(row("skomoroh")).toMatchObject({ archetype: "skomoroh", rarity: "epic" });
    expect(row("knyaz")).toMatchObject({ archetype: "knyaz", rarity: "legendary" });
    expect(row("navi")).toMatchObject({ archetype: "navi", rarity: "mythic" });
  });

  it("источники по таблице: уровни 5, 10, 15, 20, достижение «Гроза элит», топ-3 сезона", () => {
    const source = (id: string): AppearanceSource | undefined => APPEARANCES.find((def) => def.id === id)?.source;
    expect(source("keeper")).toEqual({ kind: "start" });
    expect(source("frost")).toEqual({ kind: "level", level: 5 });
    expect(source("herbalist")).toEqual({ kind: "level", level: 10 });
    expect(source("gilded")).toEqual({ kind: "level", level: 15 });
    expect(source("vityaz")).toEqual({ kind: "level", level: 20 });
    expect(source("vedunya")).toEqual({ kind: "weekly_points" });
    expect(source("ohotnitsa")).toEqual({ kind: "achievement", achievementId: "ach_elite_50" });
    expect(source("skomoroh")).toEqual({ kind: "event" });
    expect(source("knyaz")).toEqual({ kind: "vip" });
    expect(source("navi")).toEqual({ kind: "season", maxPlace: 3 });
    expect(ELITE_ACHIEVEMENT_ID).toBe("ach_elite_50");
    expect(NAVI_MAX_PLACE).toBe(3);
    expect(DEFAULT_APPEARANCE).toBe("keeper");
  });
});

describe("heldAppearances", () => {
  it("новичок (уровень 1) держит только Хранителя", () => {
    expect(held({})).toEqual(["keeper"]);
  });

  it("уровень 4 — ещё только Хранитель, 5 — иней", () => {
    expect(held({ level: 4 })).toEqual(["keeper"]);
    expect(held({ level: 5 })).toEqual(["frost", "keeper"]);
  });

  it("уровень 15 — три окраса Хранителя; 19 — без Витязя, 20 — с ним", () => {
    expect(held({ level: 15 })).toEqual(["frost", "gilded", "herbalist", "keeper"]);
    expect(held({ level: 19 })).not.toContain("vityaz");
    expect(held({ level: 20 })).toEqual(["frost", "gilded", "herbalist", "keeper", "vityaz"]);
  });

  it("VIP активен — Князь; истёк — нет", () => {
    expect(held({ vipActive: true })).toContain("knyaz");
    expect(held({ vipActive: false })).not.toContain("knyaz");
  });

  it("место 1–3 — Навий страж; 4 и «нет места» — нет", () => {
    for (const place of [1, 2, 3]) expect(held({ bestSeasonPlace: place }), `место ${place}`).toContain("navi");
    expect(held({ bestSeasonPlace: 4 })).not.toContain("navi");
    expect(held({ bestSeasonPlace: null })).not.toContain("navi");
  });

  it("место, которого не бывает, облика не даёт", () => {
    for (const place of [0, -1, 1.5, Number.NaN]) expect(held({ bestSeasonPlace: place }), `место ${place}`).not.toContain("navi");
  });

  it("«Гроза элит» выполнена — Охотница; другое достижение — нет", () => {
    expect(held({ doneAchievements: new Set(["ach_elite_50"]) })).toContain("ohotnitsa");
    expect(held({ doneAchievements: new Set(["ach_elite_200", "ach_kills_100k"]) })).not.toContain("ohotnitsa");
  });

  it("верхняя ступень очков недели забрана — Ведунья", () => {
    expect(held({ weeklyTopClaimed: true })).toContain("vedunya");
    expect(held({ weeklyTopClaimed: false })).not.toContain("vedunya");
  });

  it("Скоморох не держится ни при каком состоянии", () => {
    const everything: AppearanceState = { level: 100, vipActive: true, bestSeasonPlace: 1, doneAchievements: new Set(["ach_elite_50"]), weeklyTopClaimed: true };
    expect(held(everything)).not.toContain("skomoroh");
    expect(held(everything)).toHaveLength(9);
  });

  it("уровень не число (битая строка базы) — как новичок, а не падение", () => {
    expect(held({ level: Number.NaN })).toEqual(["keeper"]);
  });
});

describe("effectiveAppearance", () => {
  const owned = new Set(["keeper", "frost"]);

  it("выбранный и держится — он", () => {
    expect(effectiveAppearance("frost", owned)).toBe("frost");
  });

  it("выбранный, но не держится, — Хранитель", () => {
    expect(effectiveAppearance("knyaz", owned)).toBe("keeper");
  });

  it("не выбран (пусто) — Хранитель", () => {
    expect(effectiveAppearance(null, owned)).toBe("keeper");
    expect(effectiveAppearance(undefined, owned)).toBe("keeper");
  });

  it("id вне каталога (облик убрали из кода) — Хранитель", () => {
    expect(effectiveAppearance("no_such", new Set(["keeper", "no_such"]))).toBe("keeper");
  });
});

describe("appearanceChoiceSchema", () => {
  it("принимает id, avatarPhoto или оба", () => {
    expect(appearanceChoiceSchema.safeParse({ id: "vityaz" }).success).toBe(true);
    expect(appearanceChoiceSchema.safeParse({ avatarPhoto: true }).success).toBe(true);
    expect(appearanceChoiceSchema.safeParse({ id: "keeper", avatarPhoto: false }).success).toBe(true);
  });

  it("пустое тело, не объект и неверные типы — отказ", () => {
    for (const body of [{}, null, "keeper", [], { id: 5 }, { id: "" }, { id: "x".repeat(25) }, { avatarPhoto: "yes" }, { id: null }]) {
      expect(appearanceChoiceSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe("порт PublicIdentity с двумя источниками: знак и облик", () => {
  const EMBLEM: PublicMark = { emblem: { id: "emb_tester", title: "Тестер", tier: "rare", category: "status" } };

  beforeEach(() => {
    for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const fixed = (mark: PublicMark) => ({ of: async (ids: readonly string[]) => new Map(ids.map((id) => [id, mark] as const)) });
  const broken = {
    async of(): Promise<Map<string, PublicMark>> {
      throw new Error("сбой источника");
    },
  };

  it("метки двух источников склеиваются в одну запись игрока", async () => {
    const id = randomUUID();
    const identity = new PublicIdentity();
    identity.provide(fixed(EMBLEM), IDENTITY_SOURCES.emblem);
    identity.provide(fixed({ appearance: "vityaz", avatarPhoto: true }), IDENTITY_SOURCES.appearance);

    const marks = await identity.of([id]);

    expect(marks.get(id)).toEqual({ ...EMBLEM, appearance: "vityaz", avatarPhoto: true });
  });

  it("сбой источника обликов не стирает знак, сбой источника знаков не стирает облик", async () => {
    const id = randomUUID();
    const identity = new PublicIdentity();
    identity.provide(fixed(EMBLEM), IDENTITY_SOURCES.emblem);
    identity.provide(broken, IDENTITY_SOURCES.appearance);
    expect((await identity.of([id])).get(id)).toEqual(EMBLEM);

    identity.provide(fixed({ appearance: "navi" }), IDENTITY_SOURCES.appearance);
    identity.provide(broken, IDENTITY_SOURCES.emblem);
    expect((await identity.of([id])).get(id)).toEqual({ appearance: "navi" });
  });

  it("повторное подключение под тем же именем заменяет источник, а не добавляет второй", async () => {
    const id = randomUUID();
    const identity = new PublicIdentity();
    identity.provide(fixed({ appearance: "vityaz" }), IDENTITY_SOURCES.appearance);
    identity.provide(fixed({ appearance: "navi" }), IDENTITY_SOURCES.appearance);

    expect((await identity.of([id])).get(id)).toEqual({ appearance: "navi" });
  });

  it("лишние поля и неверные значения облика отброшены: avatarPhoto — только true, облик — строка", async () => {
    const id = randomUUID();
    const identity = new PublicIdentity();
    identity.provide(fixed({ appearance: "vityaz", avatarPhoto: false, extra: 1 } as unknown as PublicMark), IDENTITY_SOURCES.appearance);
    expect((await identity.of([id])).get(id)).toEqual({ appearance: "vityaz" });

    identity.provide(fixed({ appearance: 7, avatarPhoto: true } as unknown as PublicMark), IDENTITY_SOURCES.appearance);
    expect((await identity.of([id])).get(id)).toEqual({ avatarPhoto: true });
  });

  it("markOf кладёт в строку только то, что есть", () => {
    expect(markOf(undefined)).toEqual({});
    expect(markOf({})).toEqual({});
    expect(markOf({ appearance: "keeper" })).toEqual({ appearance: "keeper" });
    expect(markOf({ ...EMBLEM, appearance: "navi", avatarPhoto: true })).toEqual({ ...EMBLEM, appearance: "navi", avatarPhoto: true });
  });
});
