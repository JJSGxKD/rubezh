import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChestSize, KeyValueStorage, PrologueDef, RunResult } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import { CHESTS } from "../src/content/chests";
import { ENEMIES } from "../src/content/enemies";
import { findPrologueProblems, PROLOGUE, PROLOGUE_DIFFICULTY_ID } from "../src/content/prologue";
import { RUBEZH } from "../src/content/rubezh";
import { CONTENT_HASH } from "../src/content/hash";
import { RunBus } from "../src/engine/run-bus";
import { RunPerfTracker } from "../src/game/diagnostics/run-perf";
import { RunRecorder } from "../src/game/diagnostics/run-recorder";
import { replayRecording } from "../src/game/diagnostics/replay";
import { addXp, chooseUpgrade, isAwaitingChoice, prepareOffers } from "../src/game/progression/levels";
import { describePrologue, isPrologueWon, WARD_COOLDOWN_SEC, WARD_COOLDOWN_TICKS } from "../src/game/run/prologue";
import { submitRunResult } from "../src/game/run/records";
import { buildRunResult } from "../src/game/run/run-result";
import { captureWorld, restoreWorld } from "../src/game/run/snapshot";
import { checksumWorld } from "../src/game/sim/checksum";
import { damageEnemy } from "../src/game/sim/combat";
import { dropChest, openChest } from "../src/game/sim/chests";
import { IDLE_CODE, inputOfCode, quantizeDirection } from "../src/game/sim/input-code";
import { SIM_EVENT } from "../src/game/sim/events";
import { tickPlayerStatuses } from "../src/game/sim/player-status";
import { stepWorld, type SimInput } from "../src/game/sim/step";
import { damagePlayer, TICK_HZ, TICK_SEC } from "../src/game/sim/world";
import { createRunWorld } from "../src/game/run-world";
import { createPrologueRun, guardDef, liveGuards, scriptedInput, stepRun, stepSeconds, wardEvents } from "./helpers/prologue-run";

// Пролог первого забега — движок (T-0278, Р151, design/art/meta-v2.md §4.2):
// таймлайн трёх минут из данных, оберег на 25% здоровья, большой первый сундук,
// «Советуем» на первом выборе и победа над настоящим Стражем рубежа.

const SCENE_SOURCE = readFileSync(fileURLToPath(new URL("../src/game/MainScene.ts", import.meta.url)), "utf8");
const API_SOURCE = readFileSync(fileURLToPath(new URL("../src/run-api.ts", import.meta.url)), "utf8");
const SNAPSHOT_SOURCE = readFileSync(fileURLToPath(new URL("../src/content/snapshot.ts", import.meta.url)), "utf8");

describe("описание пролога в контенте", () => {
  it("проходит проверку без замечаний", () => {
    expect(findPrologueProblems(PROLOGUE, ENEMIES, RUBEZH)).toEqual([]);
  });

  it("числа решения: оберег 25%, сундук на три награды, подбор 1,5; Страж откалиброван по боту", () => {
    expect(PROLOGUE.hpFloorRatio).toBe(0.25);
    expect(PROLOGUE.firstChestSize).toBe(3);
    expect(PROLOGUE.pickupRadiusMul).toBe(1.5);
    // Стартовые 0,12 давали бой в 2–10 секунд против коридора 25–50 (docs/32-balance.md «Пролог»).
    expect(PROLOGUE.guardHpMul).toBe(2);
    expect(PROLOGUE.levelCurve).toEqual({ baseXp: 3, growth: 1.18 });
    expect(PROLOGUE.recommendFirstOffer).toBe("new_weapon");
    expect(PROLOGUE_DIFFICULTY_ID).toBe("easy");
  });

  it("Страж — последнее событие таймлайна, на 160 с", () => {
    const last = PROLOGUE.timeline[PROLOGUE.timeline.length - 1];
    expect(last.fromSec).toBe(160);
    expect(last.events?.[last.events.length - 1]).toMatchObject({ kind: "ring", enemy: RUBEZH.guard, count: 1 });
  });

  it("первый отрезок начинается с нуля, секунды растут", () => {
    expect(PROLOGUE.timeline[0].fromSec).toBe(0);
    for (let i = 1; i < PROLOGUE.timeline.length; i++) {
      expect(PROLOGUE.timeline[i].fromSec).toBeGreaterThan(PROLOGUE.timeline[i - 1].fromSec);
    }
  });

  describe("негативы: одна неисправность за раз", () => {
    const check = (patch: Partial<PrologueDef>) => findPrologueProblems({ ...PROLOGUE, ...patch }, ENEMIES, RUBEZH);

    it("отрезки не по возрастанию", () => {
      const swapped = [PROLOGUE.timeline[1], PROLOGUE.timeline[0], ...PROLOGUE.timeline.slice(2)];
      expect(check({ timeline: swapped }).join("\n")).toMatch(/возраст|с нулевой/);
    });

    it("первый отрезок не с нуля", () => {
      const shifted = PROLOGUE.timeline.map((segment, i) => (i === 0 ? { ...segment, fromSec: 5 } : segment));
      expect(check({ timeline: shifted }).join("\n")).toMatch(/нулев/);
    });

    it("Страж не последним событием", () => {
      const withoutGuard = PROLOGUE.timeline.slice(0, -1);
      expect(check({ timeline: withoutGuard }).join("\n")).toMatch(/Страж/);
    });

    it("Страж дважды", () => {
      const last = PROLOGUE.timeline[PROLOGUE.timeline.length - 1];
      const doubled = [...PROLOGUE.timeline, { ...last, fromSec: last.fromSec + 10 }];
      expect(check({ timeline: doubled }).join("\n")).toMatch(/Страж/);
    });

    it("неизвестный враг в отрезке", () => {
      const broken = PROLOGUE.timeline.map((segment, i) =>
        i === 0 ? { ...segment, spawns: [{ enemy: "no_such_enemy", perSec: 1 }] } : segment,
      );
      expect(check({ timeline: broken }).join("\n")).toContain("no_such_enemy");
    });

    it("оберег вне 0,1…0,5", () => {
      expect(check({ hpFloorRatio: 0.05 }).join("\n")).toContain("hpFloorRatio");
      expect(check({ hpFloorRatio: 0.6 }).join("\n")).toContain("hpFloorRatio");
      expect(check({ hpFloorRatio: 0.1 })).toEqual([]);
      expect(check({ hpFloorRatio: 0.5 })).toEqual([]);
    });

    it("множитель здоровья Стража не больше нуля или выше четырёх", () => {
      expect(check({ guardHpMul: 0 }).join("\n")).toContain("guardHpMul");
      expect(check({ guardHpMul: 5 }).join("\n")).toContain("guardHpMul");
    });

    it("размер первого сундука не из 1, 3, 5", () => {
      expect(check({ firstChestSize: 2 as ChestSize }).join("\n")).toContain("firstChestSize");
    });

    it("кривая опыта не растёт", () => {
      expect(check({ levelCurve: { baseXp: 3, growth: 1 } }).join("\n")).toContain("levelCurve");
    });

    it("радиус подбора меньше единицы", () => {
      expect(check({ pickupRadiusMul: 0.9 }).join("\n")).toContain("pickupRadiusMul");
    });
  });
});

describe("режим пролога в мире", () => {
  it("мир пролога: режим, сложность «лёгкая», что бы ни просили", () => {
    const { world } = createPrologueRun(1);
    expect(world.mode).toBe("prologue");
    expect(world.difficultyLevel.id).toBe("easy");
  });

  it("обычный мир — endless, пролог в нём не хранится", () => {
    const { world } = createRunWorld({ seed: 1, mapId: "", difficultyId: "hard", unitScale: 1 });
    expect(world.mode).toBe("endless");
    expect(world.prologue).toBeNull();
  });

  it("кривая опыта и радиус подбора — из данных пролога", () => {
    const prologue = createPrologueRun(1).world;
    const endless = createRunWorld({ seed: 1, mapId: "", difficultyId: "easy", unitScale: 1 }).world;
    expect(prologue.progression.xpToNext).toBe(PROLOGUE.levelCurve.baseXp);
    expect(prologue.playerStats.pickupRadius).toBeCloseTo(endless.playerStats.pickupRadius * PROLOGUE.pickupRadiusMul, 6);
  });

  it("таймлайн — из данных пролога, кривая бесконечного режима не включается", () => {
    const run = createPrologueRun(2);
    // Все 5 минут: отрезков «генерируемого» вида не будет, номер отрезка остаётся в пределах данных.
    stepSeconds(run, 300, { input: scriptedInput });
    expect(run.world.difficulty.segment).toBe(PROLOGUE.timeline.length - 1);
  });
});

describe("оберег", () => {
  it("урон 1000 при полном здоровье: здоровье 25 из 100, один ward", () => {
    const { world } = createPrologueRun(1);
    const max = world.playerStats.maxHp;
    expect(world.player.hp).toBe(max);

    damagePlayer(world, 1000, -1);

    expect(world.player.alive).toBe(true);
    expect(world.player.hp).toBeCloseTo(max * PROLOGUE.hpFloorRatio, 6);
    expect(wardEvents(world)).toBe(1);
  });

  it("порог — доля от максимума: с бóльшим максимумом порог выше", () => {
    const { world } = createPrologueRun(1);
    world.playerStats = { ...world.playerStats, maxHp: 200 };
    world.player.maxHp = 200;
    world.player.hp = 200;
    damagePlayer(world, 1000, -1);
    expect(world.player.hp).toBeCloseTo(50, 6);
  });

  it("второй ward через 1 с — нет, через 2,1 с — есть; здоровье держится на пороге", () => {
    const { world } = createPrologueRun(1);
    const floor = world.playerStats.maxHp * PROLOGUE.hpFloorRatio;
    damagePlayer(world, 1000, -1);
    expect(wardEvents(world)).toBe(1);

    world.stats.tick += TICK_HZ;
    damagePlayer(world, 1000, -1);
    expect(wardEvents(world)).toBe(1);
    expect(world.player.hp).toBeCloseTo(floor, 6);

    world.stats.tick += Math.round(1.1 * TICK_HZ);
    damagePlayer(world, 1000, -1);
    expect(wardEvents(world)).toBe(2);
    expect(world.player.hp).toBeCloseTo(floor, 6);
    expect(world.player.alive).toBe(true);
  });

  it("урон, не доходящий до порога, не обрезается и ward не пишет", () => {
    const { world } = createPrologueRun(1);
    damagePlayer(world, 10, -1);
    expect(world.player.hp).toBeCloseTo(world.playerStats.maxHp - 10, 6);
    expect(wardEvents(world)).toBe(0);
  });

  it("горение и яд не убивают: тик урона тоже упирается в порог", () => {
    const { world } = createPrologueRun(1);
    world.player.burnTimer = 5;
    world.player.burnDps = 1000;
    world.player.burnSource = -1;
    tickPlayerStatuses(world, 1);
    expect(world.player.alive).toBe(true);
    expect(world.player.hp).toBeCloseTo(world.playerStats.maxHp * PROLOGUE.hpFloorRatio, 6);
  });

  it("вне пролога тот же урон убивает, как раньше", () => {
    const { world } = createRunWorld({ seed: 1, mapId: "", difficultyId: "easy", unitScale: 1 });
    damagePlayer(world, 1000, -1);
    expect(world.player.alive).toBe(false);
    expect(wardEvents(world)).toBe(0);
  });

  it("пауза оберега в тиках равна двум секундам шага мира", () => {
    expect(WARD_COOLDOWN_TICKS).toBe(WARD_COOLDOWN_SEC * TICK_HZ);
  });

  it("событие ward — новое, отдельное от щита", () => {
    expect(SIM_EVENT.ward).toBeDefined();
    expect(Object.values(SIM_EVENT).filter((kind) => kind === SIM_EVENT.ward)).toHaveLength(1);
    expect(SIM_EVENT.ward).not.toBe(SIM_EVENT.shield);
  });

  it("простоявший 190 с игрок не гибнет: смерть в прологе невозможна", { timeout: 30_000 }, () => {
    const run = createPrologueRun(5);
    stepSeconds(run, 190);
    expect(run.world.player.alive).toBe(true);
    expect(run.world.player.hp).toBeGreaterThanOrEqual(run.world.playerStats.maxHp * PROLOGUE.hpFloorRatio - 1e-6);
  });
});

describe("первый сундук", () => {
  it("первый сундук пролога — на 3 награды, второй — по opening[1]", () => {
    const { world } = createPrologueRun(3);
    dropChest(world, 100, 0, "elite");
    dropChest(world, 200, 0, "elite");
    expect(world.chests.founds.map((found) => found.size)).toEqual([PROLOGUE.firstChestSize, CHESTS.opening[1]]);

    openChest(world, world.chests.founds[0].size);
    expect(world.chests.openings[0].rewards).toHaveLength(3);
  });

  it("вне пролога первый сундук — opening[0]", () => {
    const { world } = createRunWorld({ seed: 3, mapId: "", difficultyId: "easy", unitScale: 1 });
    dropChest(world, 100, 0, "elite");
    expect(world.chests.founds[0].size).toBe(CHESTS.opening[0]);
  });

  it("поток случайности сундуков пролог не трогает: после первого сундука состояние как в обычном мире", () => {
    const prologue = createPrologueRun(9).world;
    const endless = createRunWorld({ seed: 9, mapId: "", difficultyId: "easy", unitScale: 1 }).world;
    dropChest(prologue, 100, 0, "elite");
    dropChest(endless, 100, 0, "elite");
    // Размер первого сундука задан схемой и броска не тратит ни в том, ни в другом режиме.
    expect(prologue.chests.rng.getState()).toBe(endless.chests.rng.getState());
  });
});

describe("«Советуем» на первом выборе", () => {
  function firstOffers(seed: number) {
    const { world } = createPrologueRun(seed);
    addXp(world, world.progression.xpToNext);
    return { world, offers: prepareOffers(world) };
  }

  it("новое оружие в предложении обязательно, ровно одна карточка помечена", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const { offers } = firstOffers(seed);
      const recommended = offers.filter((offer) => offer.recommended === true);
      expect(recommended, `seed ${String(seed)}`).toHaveLength(1);
      expect(recommended[0].kind).toBe("weapon_new");
      expect(new Set(offers.map((offer) => offer.id)).size).toBe(offers.length);
      expect(offers.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("второй выбор — без флага", () => {
    const { world, offers } = firstOffers(7);
    chooseUpgrade(world, offers[0].id);
    addXp(world, world.progression.xpToNext);
    const second = prepareOffers(world);
    expect(second.length).toBeGreaterThan(0);
    expect(second.some((offer) => offer.recommended !== undefined)).toBe(false);
  });

  it("те же предложения на том же зерне", () => {
    expect(firstOffers(11).offers.map((offer) => offer.id)).toEqual(firstOffers(11).offers.map((offer) => offer.id));
  });

  it("в бесконечном режиме флага нет", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const { world } = createRunWorld({ seed, mapId: "", difficultyId: "easy", unitScale: 1 });
      addXp(world, world.progression.xpToNext);
      expect(prepareOffers(world).some((offer) => "recommended" in offer)).toBe(false);
    }
  });

  it("предложение из оболочки: выбор помеченной карточки применяется как обычный", () => {
    const { world, offers } = firstOffers(4);
    const recommended = offers.find((offer) => offer.recommended === true);
    expect(recommended).toBeDefined();
    expect(chooseUpgrade(world, recommended?.id ?? "")).toBe(true);
    expect(world.loadout.weapons).toHaveLength(2);
  });
});

describe("Страж рубежа и победа", () => {
  /** Идёт, пока не придёт Страж; возвращает прогон на тике прихода. */
  function untilGuard(seed: number) {
    const run = createPrologueRun(seed);
    stepSeconds(run, 200, { until: (world) => world.rubezh.phase !== "pending" });
    return run;
  }

  it("Страж приходит на 160-й секунде, настоящий, здоровье по множителю пролога", { timeout: 30_000 }, () => {
    const { world } = untilGuard(2);
    expect(world.rubezh.phase).toBe("guard");
    expect(world.stats.elapsedSec).toBeGreaterThanOrEqual(160);
    expect(world.stats.elapsedSec).toBeLessThan(162);
    const [guard] = liveGuards(world);
    expect(world.enemies.maxHp[guard]).toBeCloseTo(guardDef().hp * PROLOGUE.guardHpMul, 3);
  });

  it("автоматический приход Стража по отметке рубежа в прологе не срабатывает: он один", { timeout: 30_000 }, () => {
    const run = untilGuard(2);
    stepSeconds(run, 5);
    expect(run.world.stats.enemiesSpawned).toBeGreaterThan(0);
    expect(liveGuards(run.world).length).toBeLessThanOrEqual(1);
  });

  it("смерть Стража: победа, итог prologue.won = true с секундой победы", { timeout: 30_000 }, () => {
    const { world } = untilGuard(3);
    const before = describePrologue(world);
    expect(before.won).toBe(false);
    expect(isPrologueWon(world)).toBe(false);

    damageEnemy(world, liveGuards(world)[0], 1e9, 0);

    expect(isPrologueWon(world)).toBe(true);
    const result = buildRunResult(world, { runId: "r", seed: 3, outcome: "abandoned", startingWeaponId: "spark", contentHash: CONTENT_HASH });
    expect(result.mode).toBe("prologue");
    expect(result.prologue).toEqual({ won: true, sec: world.rubezh.clearedSec });
    expect(result.rubezh?.clearedSec).toBe(world.rubezh.clearedSec);
  });

  it("выход до победы: prologue.won = false, секунда — где вышел", () => {
    const run = createPrologueRun(3);
    stepSeconds(run, 20, { input: scriptedInput });
    const result = buildRunResult(run.world, { runId: "r", seed: 3, outcome: "abandoned", startingWeaponId: "spark", contentHash: CONTENT_HASH });
    expect(result.prologue).toEqual({ won: false, sec: run.world.stats.elapsedSec });
    expect(result.mode).toBe("prologue");
  });

  it("в обычном итоге нет ни режима, ни поля пролога", () => {
    const { world } = createRunWorld({ seed: 3, mapId: "", difficultyId: "easy", unitScale: 1 });
    const result = buildRunResult(world, { runId: "r", seed: 3, outcome: "died", startingWeaponId: "spark", contentHash: CONTENT_HASH });
    expect("prologue" in result).toBe(false);
    expect("mode" in result).toBe(false);
  });

  it("сообщение шины prologueWon объявлено и отправляется сценой до закрытия забега", () => {
    expect(API_SOURCE).toContain("prologueWon:");
    const bus = new RunBus();
    expect(() => bus.on("prologueWon", () => undefined)).not.toThrow();
    expect(SCENE_SOURCE).toContain('emit("prologueWon"');
    expect(SCENE_SOURCE.indexOf('emit("prologueWon"')).toBeLessThan(SCENE_SOURCE.indexOf('"abandoned"', SCENE_SOURCE.indexOf('emit("prologueWon"')));
  });
});

describe("рекорд движка", () => {
  function memoryStorage(): KeyValueStorage & { values: Record<string, string> } {
    const values: Record<string, string> = {};
    return {
      values,
      get: (key) => values[key] ?? null,
      set: (key, value) => {
        values[key] = value;
      },
      remove: (key) => {
        delete values[key];
      },
    };
  }

  it("пролог не пишет рекорд, обычный забег пишет", () => {
    const storage = memoryStorage();
    const prologue = { survivalSec: 200, difficultyId: "easy", prologue: { won: true, sec: 200 } } as RunResult;
    expect(submitRunResult(storage, prologue)).toEqual({ bestSurvivalSec: 0, isNewRecord: false });
    expect(Object.keys(storage.values)).toHaveLength(0);

    const normal = { survivalSec: 200, difficultyId: "easy" } as RunResult;
    expect(submitRunResult(storage, normal).isNewRecord).toBe(true);
    expect(Object.keys(storage.values).length).toBeGreaterThan(0);
  });
});

describe("детерминизм", () => {
  it("повтор пролога тем же зерном: та же контрольная сумма и те же предложения", { timeout: 30_000 }, () => {
    const a = createPrologueRun(21);
    const b = createPrologueRun(21);
    const offersA = stepSeconds(a, 100, { input: scriptedInput });
    const offersB = stepSeconds(b, 100, { input: scriptedInput });
    expect(checksumWorld(b.world)).toBe(checksumWorld(a.world));
    expect(offersB.map((set) => set.map((offer) => offer.id))).toEqual(offersA.map((set) => set.map((offer) => offer.id)));
  });

  it("другое зерно — другой забег", { timeout: 30_000 }, () => {
    const a = createPrologueRun(21);
    const b = createPrologueRun(22);
    stepSeconds(a, 60, { input: scriptedInput });
    stepSeconds(b, 60, { input: scriptedInput });
    expect(checksumWorld(b.world)).not.toBe(checksumWorld(a.world));
  });

  it("снимок пролога на 90-й секунде: восстановление идёт тем же ходом, «Советуем» не повторяется", { timeout: 60_000 }, () => {
    const original = createPrologueRun(31);
    stepSeconds(original, 90, { input: scriptedInput });
    expect(original.world.prologue?.firstOfferMade).toBe(true);
    const saved = JSON.parse(JSON.stringify(captureWorld(original.world, original.spawner))) as unknown;

    const resumed = createPrologueRun(31);
    restoreWorld(resumed.world, resumed.spawner, saved);
    expect(resumed.world.mode).toBe("prologue");
    expect(resumed.world.prologue?.firstOfferMade).toBe(true);
    expect(checksumWorld(resumed.world)).toBe(checksumWorld(original.world));

    const seenOriginal = stepSeconds(original, 70, { input: scriptedInput });
    const seenResumed = stepSeconds(resumed, 70, { input: scriptedInput });
    expect(checksumWorld(resumed.world)).toBe(checksumWorld(original.world));
    expect(seenResumed.map((set) => set.map((offer) => offer.id))).toEqual(seenOriginal.map((set) => set.map((offer) => offer.id)));
    expect(seenResumed.flat().some((offer) => offer.recommended === true)).toBe(false);
  });

  it("снимок до первого выбора: «Советуем» после восстановления всё ещё впереди", () => {
    const original = createPrologueRun(32);
    stepRun(original, 5, { input: scriptedInput });
    expect(original.world.prologue?.firstOfferMade).toBe(false);
    const saved = JSON.parse(JSON.stringify(captureWorld(original.world, original.spawner))) as unknown;

    const resumed = createPrologueRun(32);
    restoreWorld(resumed.world, resumed.spawner, saved);
    // Скриптовый ход не собирает кристаллы целенаправленно: первый уровень приходит около 35-й секунды.
    const seen = stepSeconds(resumed, 70, { input: scriptedInput });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0].filter((offer) => offer.recommended === true)).toHaveLength(1);
  });

  it("повреждённое поле пролога в снимке не читается", () => {
    const original = createPrologueRun(33);
    const saved = JSON.parse(JSON.stringify(captureWorld(original.world, original.spawner))) as { prologue: Record<string, unknown> };
    saved.prologue.firstOfferMade = "да";
    expect(() => restoreWorld(createPrologueRun(33).world, createPrologueRun(33).spawner, saved)).toThrow();
  });

  it("снимок эндлесс-мира в пролог не загружается, а снимок пролога — в эндлесс", () => {
    const prologue = createPrologueRun(34);
    const endless = createRunWorld({ seed: 34, mapId: "", difficultyId: "easy", unitScale: 1 });
    const savedPrologue = JSON.parse(JSON.stringify(captureWorld(prologue.world, prologue.spawner))) as unknown;
    const savedEndless = JSON.parse(JSON.stringify(captureWorld(endless.world, endless.spawner))) as unknown;
    expect(() => restoreWorld(createRunWorld({ seed: 34, mapId: "", difficultyId: "easy", unitScale: 1 }).world, endless.spawner, savedPrologue)).toThrow();
    expect(() => restoreWorld(createPrologueRun(34).world, prologue.spawner, savedEndless)).toThrow();
  });

  it("сцена хранит режим в снимке забега и берёт его при продолжении", () => {
    expect(SCENE_SOURCE).toMatch(/mode:\s*world\.mode|\.\.\.\(world\.mode/);
    expect(SCENE_SOURCE).toContain("resume.mode");
    expect(API_SOURCE).toMatch(/RunOptions[\s\S]*mode:\s*RunMode/);
  });
});

describe("запись и повтор пролога", () => {
  function recordPrologue(seed: number, ticks: number, withMode: boolean) {
    const { world, spawner } = createPrologueRun(seed, { unitScale: 2 });
    const recorder = new RunRecorder({
      reportId: "00000000-0000-4000-8000-000000000002",
      runId: "run-prologue",
      startedAt: "2026-11-03T10:00:00.000Z",
      seed,
      mapId: world.mapId,
      difficultyId: world.difficultyLevel.id,
      startingWeaponId: world.weaponTypes[world.loadout.weapons[0].typeIndex].id,
      contentHash: CONTENT_HASH,
      unitScale: 2,
      replayBlocker: null,
      ...(withMode ? { mode: "prologue" as const } : {}),
    });
    const perf = new RunPerfTracker();
    const input: SimInput = { moveX: 0, moveY: 0 };
    let code = IDLE_CODE;
    while (world.stats.tick < ticks) {
      if (isAwaitingChoice(world)) {
        const optionId = world.progression.offers[0].id;
        chooseUpgrade(world, optionId);
        recorder.choice(world.stats.tick, optionId);
        continue;
      }
      const angle = (world.stats.tick / 240) * Math.PI * 2;
      code = quantizeDirection(Math.cos(angle), Math.sin(angle), code);
      spawner.update(world, TICK_SEC);
      stepWorld(world, inputOfCode(code, input));
      recorder.stepped(code, world);
    }
    const summary = perf.summary({ renderer: "webgl", renderCapFps: null, dpr: 2, canvasWidth: 780, canvasHeight: 1688, interruptions: 0 });
    return JSON.parse(JSON.stringify(recorder.finish(world, "abandoned", null, summary, null))) as import("../src/run-api").RunRecording;
  }

  it("запись несёт режим и повторяется: исход совпадает", { timeout: 30_000 }, () => {
    const recording = recordPrologue(41, 60 * TICK_HZ, true);
    expect(recording.mode).toBe("prologue");
    expect(replayRecording(recording).verdict).toBe("match");
  });

  it("запись без режима повторяется как обычный забег и расходится: режим входит в повтор", { timeout: 30_000 }, () => {
    const recording = recordPrologue(41, 60 * TICK_HZ, true);
    const stripped = { ...recording };
    delete stripped.mode;
    expect(replayRecording(stripped).verdict).not.toBe("match");
  });
});

describe("проводка в сцену и контент", () => {
  it("prologue.ts входит в хэш контента", () => {
    expect(SNAPSHOT_SOURCE).toMatch(/PROLOGUE/);
  });

  it("сцена подставляет режим из опций и ставит победу над Стражем концом забега", () => {
    expect(SCENE_SOURCE).toContain("isPrologueWon");
    expect(SCENE_SOURCE).toContain("data.mode");
  });

  it("оберег виден шине: сигналы забега несут ward", () => {
    expect(API_SOURCE).toMatch(/ward\??:\s*number/);
  });
});
