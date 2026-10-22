import { describe, expect, it } from "vitest";
import type { ChestReward } from "@bh/shared-types";
import {
  announceText,
  CHEST_LOOKS,
  CHEST_TIMING,
  chestTier,
  chestTitleKey,
  headlineChange,
  reelStrip,
  revealTimes,
  rewardView,
  sparkVectors,
} from "../src/screens/run/chest-rules";
import { isRunActivePhase } from "../src/state/run";
import ru from "../src/i18n/ru.json";
import ruRun from "../src/i18n/ru-run.json";

// Окно сундука забега (tasks/T-0100): награды уже выданы движком, окно только
// показывает их. Вся логика — чистые функции; компонент только рисует.

const reward = (patch: Partial<ChestReward> & Pick<ChestReward, "kind">): ChestReward => ({
  id: `${patch.kind}:x:1`,
  refId: "spark",
  level: 1,
  nameKey: "weapon.spark.name",
  descriptionKey: "weapon.spark.description",
  changes: [],
  ...patch,
});

describe("заголовок по размеру", () => {
  it("1, 3 и 5 — свои ключи", () => {
    expect(chestTitleKey(1)).toBe("run.chest.title.1");
    expect(chestTitleKey(3)).toBe("run.chest.title.3");
    expect(chestTitleKey(5)).toBe("run.chest.title.5");
  });

  it("неизвестный размер — ключ для трёх", () => {
    expect(chestTitleKey(2)).toBe("run.chest.title.3");
    expect(chestTitleKey(0)).toBe("run.chest.title.3");
    expect(chestTitleKey(9)).toBe("run.chest.title.3");
  });
});

describe("вид награды", () => {
  it("новое оружие — значок оружия и метка «новое»", () => {
    expect(rewardView(reward({ kind: "weapon_new", refId: "spark" }))).toEqual({ icon: "weapon", refId: "spark", tag: { kind: "new" } });
  });

  it("новая пассивка — значок пассивки и метка «новое»", () => {
    expect(rewardView(reward({ kind: "passive_new", refId: "might" }))).toEqual({ icon: "passive", refId: "might", tag: { kind: "new" } });
  });

  it("уровень оружия и пассивки — метка с уровнем", () => {
    expect(rewardView(reward({ kind: "weapon_level", refId: "spark", level: 3 })).tag).toEqual({ kind: "level", level: 3 });
    expect(rewardView(reward({ kind: "passive_level", refId: "might", level: 4 }))).toEqual({ icon: "passive", refId: "might", tag: { kind: "level", level: 4 } });
  });

  it("лечение — значок лечения, без метки", () => {
    expect(rewardView(reward({ kind: "heal", refId: "" }))).toEqual({ icon: "heal", refId: "", tag: null });
  });

  it("опыт — значок опыта, без метки и без refId", () => {
    expect(rewardView(reward({ kind: "xp", refId: "", level: 0 }))).toEqual({ icon: "xp", refId: "", tag: null });
  });
});

describe("лента «барабана»", () => {
  const pool = ["spark", "knife", "might", "haste", "reach", "volley", "ward"];
  const won = reward({ kind: "weapon_new", refId: "storm" });

  it("шесть плиток, последняя — награда", () => {
    const strip = reelStrip(0, won, pool);
    expect(strip).toHaveLength(6);
    expect(strip[5]).toBe("storm");
  });

  it("отвлекающие не равны итоговой, даже когда награда есть в пуле", () => {
    const strip = reelStrip(2, reward({ kind: "weapon_new", refId: "knife" }), pool);
    expect(strip.slice(0, 5)).not.toContain("knife");
    expect(strip[5]).toBe("knife");
  });

  it("одни аргументы — одна лента", () => {
    expect(reelStrip(1, won, pool)).toEqual(reelStrip(1, won, pool));
  });

  it("другой номер награды — другая лента", () => {
    expect(reelStrip(0, won, pool)).not.toEqual(reelStrip(1, won, pool));
  });

  it("пул из двух id всё равно даёт шесть плиток, по кругу", () => {
    const strip = reelStrip(0, won, ["spark", "knife"]);
    expect(strip).toHaveLength(6);
    expect(strip.slice(0, 5)).toEqual(["spark", "knife", "spark", "knife", "spark"]);
  });

  it("пустой пул не падает: отвлекающие — значок опыта", () => {
    const strip = reelStrip(0, won, []);
    expect(strip).toHaveLength(6);
    expect(strip.slice(0, 5)).toEqual(["xp", "xp", "xp", "xp", "xp"]);
    expect(strip[5]).toBe("storm");
  });

  it("лечение и опыт приходят на ленту своими метками, а не пустой строкой", () => {
    expect(reelStrip(0, reward({ kind: "heal", refId: "" }), pool)[5]).toBe("heal");
    expect(reelStrip(0, reward({ kind: "xp", refId: "" }), pool)[5]).toBe("xp");
  });
});

// Сцена открытия (design/art/effects.md, «Открытие сундука»): сундук трясётся,
// крышка слетает с выбросом искр, награды выпадают по одной. Числа сцены —
// здесь, чтобы звук и анимация шли по одному расписанию.
describe("сцена открытия", () => {
  it("ярус по размеру: 1 — малый, 5 — большой, прочее — средний", () => {
    expect(chestTier(1)).toBe("small");
    expect(chestTier(3)).toBe("medium");
    expect(chestTier(5)).toBe("grand");
    expect(chestTier(2)).toBe("medium");
  });

  it("чем больше сундук, тем больше искр и дольше предвкушение — выгода видна до первой награды", () => {
    expect(CHEST_LOOKS.small.sparks).toBeLessThan(CHEST_LOOKS.medium.sparks);
    expect(CHEST_LOOKS.medium.sparks).toBeLessThan(CHEST_LOOKS.grand.sparks);
    expect(CHEST_LOOKS.small.shakeMs).toBeLessThan(CHEST_LOOKS.medium.shakeMs);
    expect(CHEST_LOOKS.medium.shakeMs).toBeLessThan(CHEST_LOOKS.grand.shakeMs);
    // Малый сундук падает с каждой элиты: тряска не дольше полсекунды.
    expect(CHEST_LOOKS.small.shakeMs).toBeLessThanOrEqual(500);
  });

  it("награды встают по одной, с равным шагом после вскрытия", () => {
    const times = revealTimes(3, false);
    expect(times).toHaveLength(3);
    expect(times[0]).toBe(CHEST_TIMING.firstRevealMs + CHEST_TIMING.reelMs);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBe(CHEST_TIMING.revealGapMs);
    expect((times[2] ?? 0) - (times[1] ?? 0)).toBe(CHEST_TIMING.revealGapMs);
  });

  it("без движения награды встают сразу — звук не отстаёт от картинки", () => {
    expect(revealTimes(3, true)).toEqual([0, 0, 0]);
  });

  it("искры: заданное число, все разлетаются наружу и одинаково при каждом показе", () => {
    const sparks = sparkVectors(12);
    expect(sparks).toHaveLength(12);
    expect(sparkVectors(12)).toEqual(sparks);
    for (const spark of sparks) expect(Math.hypot(spark.x, spark.y)).toBeGreaterThan(40);
    // Веер, а не луч: искры летят во все стороны.
    expect(sparks.some((spark) => spark.x < 0)).toBe(true);
    expect(sparks.some((spark) => spark.x > 0)).toBe(true);
  });

  it("выгода награды — первое изменение с «было»: игрок видит, на сколько выросло", () => {
    const changes = [
      { labelKey: "upgrade.stat.damage", from: 7, to: 9, format: "value" as const, lowerIsBetter: false },
      { labelKey: "upgrade.stat.projectiles", from: 1, to: 2, format: "value" as const, lowerIsBetter: false },
    ];
    expect(headlineChange(reward({ kind: "weapon_level", changes }))?.labelKey).toBe("upgrade.stat.damage");
    const fresh = [{ labelKey: "upgrade.stat.damage", from: null, to: 6, format: "value" as const, lowerIsBetter: false }];
    expect(headlineChange(reward({ kind: "weapon_new", changes: fresh }))?.to).toBe(6);
    expect(headlineChange(reward({ kind: "weapon_level", changes: [] }))).toBeNull();
    // У опыта число своё — строкой под названием, а не изменением.
    expect(headlineChange(reward({ kind: "xp", refId: "", changes: fresh }))).toBeNull();
  });
});

describe("текст для скринридера", () => {
  const dictionary = (key: string, vars?: Record<string, unknown>): string =>
    key === "run.chest.announce" ? `Получено: ${String(vars?.names)}` : key;

  it("названия — через запятую, ключ — run.chest.announce", () => {
    expect(announceText(["Искра", "Аптечка"], dictionary)).toBe("Получено: Искра, Аптечка");
  });

  it("одно название — без запятых", () => {
    expect(announceText(["Опыт"], dictionary)).toBe("Получено: Опыт");
  });
});

describe("фаза сундука", () => {
  it("забег в фазе chest считается идущим: уход с экрана сохраняет его", () => {
    expect(isRunActivePhase("chest")).toBe(true);
  });

  it("прочие фазы без изменений", () => {
    expect(isRunActivePhase("running")).toBe(true);
    expect(isRunActivePhase("paused")).toBe(true);
    expect(isRunActivePhase("levelUp")).toBe(true);
    expect(isRunActivePhase("downed")).toBe(false);
    expect(isRunActivePhase("finished")).toBe(false);
    expect(isRunActivePhase("idle")).toBe(false);
  });
});

describe("словарь", () => {
  const run = ruRun as Record<string, string>;
  const main = ru as Record<string, string>;

  it("все ключи окна сундука есть в ru-run.json", () => {
    for (const key of ["run.chest.title.1", "run.chest.title.3", "run.chest.title.5", "run.chest.subtitle", "run.chest.take", "run.chest.announce"]) {
      expect(run[key], key).toBeTypeOf("string");
    }
  });

  it("названия запасных наград, которые отдаёт движок, есть в словаре", () => {
    for (const key of ["upgrade.xp.name", "upgrade.heal.name"]) {
      expect(main[key], key).toBeTypeOf("string");
    }
  });
});
