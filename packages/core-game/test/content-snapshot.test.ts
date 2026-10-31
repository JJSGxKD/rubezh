import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnemyDef, WeaponDef } from "@bh/shared-types";
import { describe, expect, it } from "vitest";
import {
  buildExport,
  collectNameKeys,
  NAMES_FILE,
  readDictionary,
  SCHEMA_FILE,
  SNAPSHOT_FILE,
  writeExport,
} from "../../../scripts/content/export-snapshot";
import { DEFAULT_DIFFICULTY_ID } from "../src/content/difficulty";
import { CONTENT_HASH } from "../src/content/hash";
import { CONTENT_SNAPSHOT, hashSnapshot, type ContentSnapshot } from "../src/content/snapshot";
import { contentSnapshotSchema } from "../src/content/snapshot-schema";
import { BALANCE_TARGETS, EVOLUTION_POWER_RATIO } from "../src/content/balance-targets";
import { ENEMIES } from "../src/content/enemies";
import { SECRETS } from "../src/content/secrets";
import { TIMELINE } from "../src/content/waves";
import { WEAPONS } from "../src/content/weapons";
import { simulateBalanceRun } from "../src/game/balance";
import { findContentProblems } from "../src/game/content-problems";
import { createRunWorld } from "../src/game/run-world";
import { checksumWorld } from "../src/game/sim/checksum";
import { stepWorld } from "../src/game/sim/step";
import { createTimelineDirector } from "../src/game/sim/director";
import { TICK_SEC } from "../src/game/sim/world";

// Снимок контента (docs/19-content-admin.md §3, tasks/T-0301): весь контент
// одним объектом со схемой и хэшем. Редактор баланса в панели правит копию
// снимка, проверяет её `findContentProblems` и гоняет движком и ботом.

/** Копия снимка через JSON: ровно то, что сервер хранит, а панель получает. */
function viaJson(snapshot: ContentSnapshot): unknown {
  return JSON.parse(JSON.stringify(snapshot));
}

/** Тот же забег на `ticks` шагов: движение по кругу, чтобы мир не стоял на месте. */
function runChecksum(content: ContentSnapshot | undefined, ticks: number): number {
  const { world, spawner } = createRunWorld({
    seed: 11,
    mapId: "",
    difficultyId: "normal",
    unitScale: 2,
    ...(content === undefined ? {} : { content }),
  });
  for (let tick = 0; tick < ticks; tick++) {
    const angle = tick / 40;
    spawner.update(world, TICK_SEC);
    stepWorld(world, { moveX: Math.sign(Math.round(Math.cos(angle) * 2)), moveY: Math.sign(Math.round(Math.sin(angle) * 2)) });
  }
  return checksumWorld(world);
}

describe("снимок контента: состав и хэш", () => {
  it("держит версию схемы 1 и все поля контента, которые влияют на забег", () => {
    expect(CONTENT_SNAPSHOT.schemaVersion).toBe(1);
    expect(Object.keys(CONTENT_SNAPSHOT)).toEqual([
      "schemaVersion",
      "enemies",
      "stages",
      "weapons",
      "passives",
      "levelCurve",
      "loadoutLimits",
      "accountUnlocks",
      "timeline",
      "endlessCurve",
      "maps",
      "drops",
      "chests",
      "secrets",
      "difficulties",
      "continueRules",
      "boosts",
      "maxBoostsPerRun",
      "cardToolUnlocks",
      "cardToolRules",
      "balanceTargets",
    ]);
  });

  it("собирает снимок из тех же массивов, что читает движок, а не из копий", () => {
    expect(CONTENT_SNAPSHOT.enemies).toBe(ENEMIES);
    expect(CONTENT_SNAPSHOT.timeline).toBe(TIMELINE);
    expect(CONTENT_SNAPSHOT.weapons).toBe(WEAPONS);
  });

  it("кладёт коридоры калибровки в снимок для отчёта симуляции", () => {
    expect(CONTENT_SNAPSHOT.balanceTargets).toEqual({ ...BALANCE_TARGETS, evolutionPowerRatio: EVOLUTION_POWER_RATIO });
  });

  it("хэш умолчания равен CONTENT_HASH", () => {
    expect(hashSnapshot(CONTENT_SNAPSHOT)).toBe(CONTENT_HASH);
    expect(CONTENT_HASH).toMatch(/^[0-9a-f]{8}$/);
  });

  it("не считает в хэш ни версию схемы, ни коридоры калибровки", () => {
    const retargeted = { ...CONTENT_SNAPSHOT, balanceTargets: { ...CONTENT_SNAPSHOT.balanceTargets, passiveDeathBeforeSec: 1 } };
    expect(hashSnapshot(retargeted)).toBe(CONTENT_HASH);
  });

  it("меняет хэш от любой правки числа, которое влияет на забег", () => {
    const harder = { ...CONTENT_SNAPSHOT, enemies: ENEMIES.map((enemy, index) => (index === 0 ? { ...enemy, hp: enemy.hp + 1 } : enemy)) };
    expect(hashSnapshot(harder)).not.toBe(CONTENT_HASH);
    expect(hashSnapshot({ ...CONTENT_SNAPSHOT, maxBoostsPerRun: CONTENT_SNAPSHOT.maxBoostsPerRun + 1 })).not.toBe(CONTENT_HASH);
  });

  it("тайники входят в хэш: правка числа тайника — новая версия баланса", () => {
    expect(CONTENT_SNAPSHOT.secrets).toBe(SECRETS);
    const longer = { ...CONTENT_SNAPSHOT, secrets: { ...SECRETS, shrine: { ...SECRETS.shrine, holdSec: SECRETS.shrine.holdSec + 1 } } };
    expect(hashSnapshot(longer)).not.toBe(CONTENT_HASH);
    const blessed = { ...CONTENT_SNAPSHOT, secrets: { ...SECRETS, blessings: SECRETS.blessings.slice(1) } };
    expect(hashSnapshot(blessed)).not.toBe(CONTENT_HASH);
  });

  it("меняет хэш от порядка врагов: от него зависят индексы типов и обращения к генератору", () => {
    expect(hashSnapshot({ ...CONTENT_SNAPSHOT, enemies: [...ENEMIES].reverse() })).not.toBe(CONTENT_HASH);
  });
});

describe("схема снимка", () => {
  it("принимает умолчание", () => {
    const parsed = contentSnapshotSchema.safeParse(CONTENT_SNAPSHOT);
    expect(parsed.success, JSON.stringify(parsed.error?.issues.slice(0, 3))).toBe(true);
  });

  it("не теряет полей: снимок после JSON и разбора равен исходному", () => {
    const parsed = contentSnapshotSchema.parse(viaJson(CONTENT_SNAPSHOT));
    expect(parsed).toEqual(CONTENT_SNAPSHOT);
  });

  it("не меняет хэш от копии через JSON: порядок ключей при записи сохраняется", () => {
    expect(hashSnapshot(viaJson(CONTENT_SNAPSHOT) as ContentSnapshot)).toBe(CONTENT_HASH);
  });

  it("ловит число вне границ с путём до поля", () => {
    const broken = viaJson({ ...CONTENT_SNAPSHOT, enemies: [{ ...ENEMIES[0], hp: 0 }, ...ENEMIES.slice(1)] });
    const parsed = contentSnapshotSchema.safeParse(broken);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("enemies.0.hp");
  });

  it("тайники в схеме: принимает умолчание, ловит число вне границ и лишнее поле с путём до него", () => {
    expect(contentSnapshotSchema.safeParse(viaJson(CONTENT_SNAPSHOT)).success).toBe(true);
    // Правка из панели приходит JSON-ом, а не типизированным объектом: поля могут быть чем угодно.
    const raw = (secrets: Record<string, unknown>): unknown => JSON.parse(JSON.stringify({ ...CONTENT_SNAPSHOT, secrets }));
    const brokenShrine = raw({ ...SECRETS, shrine: { ...SECRETS.shrine, holdSec: "долго" } });
    const parsed = contentSnapshotSchema.safeParse(brokenShrine);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toContain("secrets.shrine.holdSec");

    const extra = raw({ ...SECRETS, lootbox: true });
    expect(contentSnapshotSchema.safeParse(extra).success).toBe(false);
    const { secrets: _secrets, ...withoutSecrets } = CONTENT_SNAPSHOT;
    void _secrets;
    expect(contentSnapshotSchema.safeParse(withoutSecrets).success).toBe(false);
    // Вид тайника в весах кольца — только из мест: огонёк в кольцо не бросается.
    const wispRing = raw({ ...SECRETS, rings: [{ ...SECRETS.rings[0], kinds: [{ kind: "wisp", weight: 1 }] }, ...SECRETS.rings.slice(1)] });
    expect(contentSnapshotSchema.safeParse(wispRing).success).toBe(false);
  });

  it("ловит пропавшее обязательное поле и чужую версию схемы", () => {
    const { timeline: _timeline, ...withoutTimeline } = CONTENT_SNAPSHOT;
    void _timeline;
    expect(contentSnapshotSchema.safeParse(withoutTimeline).success).toBe(false);
    expect(contentSnapshotSchema.safeParse({ ...CONTENT_SNAPSHOT, schemaVersion: 2 }).success).toBe(false);
  });

  it("ловит неизвестные паттерн врага и поведение оружия", () => {
    const enemy = { ...ENEMIES[0], pattern: "teleport" } as unknown as EnemyDef;
    const weapon = { ...WEAPONS[0], behavior: "laser" } as unknown as WeaponDef;
    expect(contentSnapshotSchema.safeParse(viaJson({ ...CONTENT_SNAPSHOT, enemies: [enemy] })).success).toBe(false);
    expect(contentSnapshotSchema.safeParse(viaJson({ ...CONTENT_SNAPSHOT, weapons: [weapon] })).success).toBe(false);
  });

  it("не принимает NaN и бесконечность, которые JSON превратил бы в null", () => {
    const broken = { ...CONTENT_SNAPSHOT, levelCurve: { ...CONTENT_SNAPSHOT.levelCurve, growth: Number.NaN } };
    expect(contentSnapshotSchema.safeParse(broken).success).toBe(false);
  });

  it("описывается JSON-схемой для сервера: он проверяет форму правки, не импортируя пакеты игры", async () => {
    const { z } = await import("zod");
    const json = z.toJSONSchema(contentSnapshotSchema) as { type?: string; required?: string[]; properties?: Record<string, unknown> };
    expect(json.type).toBe("object");
    expect(json.required).toEqual(expect.arrayContaining(["schemaVersion", "enemies", "timeline", "weapons"]));
    expect(Object.keys(json.properties ?? {})).toContain("balanceTargets");
  });
});

describe("проверки контента одной функцией", () => {
  it("находят в боевом контенте ноль проблем", () => {
    expect(findContentProblems(CONTENT_SNAPSHOT)).toEqual([]);
  });

  it("называют раздел снимка и пишут по-русски теми же словами, что проверки контента", () => {
    const broken = { ...CONTENT_SNAPSHOT, enemies: ENEMIES.map((enemy, index) => (index === 0 ? { ...enemy, pattern: "dash" as const, params: { dashSpeed: -1 } } : enemy)) };
    const problems = findContentProblems(broken);
    expect(problems).toContainEqual({ path: "enemies", message: expect.stringContaining("dashSpeed") });
    expect(problems.every((problem) => problem.path.length > 0 && problem.message.length > 0)).toBe(true);
  });

  it("ловит таймлайн, который ссылается на несуществующего врага", () => {
    const timeline = TIMELINE.map((segment, index) =>
      index === 0 ? { ...segment, spawns: [...segment.spawns, { enemy: "ghost_of_nobody", perSec: 1 }] } : segment,
    );
    const problems = findContentProblems({ ...CONTENT_SNAPSHOT, timeline });
    expect(problems.filter((problem) => problem.path === "timeline").map((problem) => problem.message).join("\n")).toContain("ghost_of_nobody");
  });

  it("ловит оружие, которое не открывается ни на одном уровне аккаунта", () => {
    const weapons = [...WEAPONS, { ...WEAPONS[0], id: "orphan", nameKey: "weapon.orphan.name", descriptionKey: "weapon.orphan.description" }];
    const problems = findContentProblems({ ...CONTENT_SNAPSHOT, weapons });
    expect(problems.some((problem) => problem.path === "accountUnlocks" && problem.message.includes("orphan"))).toBe(true);
  });

  it("ловит дубль id врага и дубль id оружия", () => {
    const enemies = [...ENEMIES, ENEMIES[0]];
    const weapons = [...WEAPONS, WEAPONS[0]];
    const problems = findContentProblems({ ...CONTENT_SNAPSHOT, enemies, weapons });
    expect(problems.some((problem) => problem.path === "enemies" && problem.message.includes(ENEMIES[0].id))).toBe(true);
    expect(problems.some((problem) => problem.path === "weapons" && problem.message.includes(WEAPONS[0].id))).toBe(true);
  });

  it("сверяет первое событие элиты с коридором первого сундука из снимка", () => {
    const tight = { ...CONTENT_SNAPSHOT, balanceTargets: { ...CONTENT_SNAPSHOT.balanceTargets, firstChestEventSec: { min: 1000, max: 2000 } } };
    const problems = findContentProblems(tight);
    expect(problems.some((problem) => problem.path === "timeline" && problem.message.includes("сундук"))).toBe(true);
  });

  it("ловит слотов не меньше, чем кандидатов: игроку нечего выбирать", () => {
    const limits = { ...CONTENT_SNAPSHOT.loadoutLimits, weapons: 99, passives: { ...CONTENT_SNAPSHOT.loadoutLimits.passives, defense: 99 } };
    const messages = findContentProblems({ ...CONTENT_SNAPSHOT, loadoutLimits: limits })
      .filter((problem) => problem.path === "loadoutLimits")
      .map((problem) => problem.message);
    expect(messages.some((message) => message.includes("оружия"))).toBe(true);
    expect(messages.some((message) => message.includes("«defense»"))).toBe(true);
  });

  it("ловит кривую опыта, где первый уровень слишком дорог или кривая не растёт", () => {
    const dear = findContentProblems({ ...CONTENT_SNAPSHOT, levelCurve: { baseXp: 50, growth: 1.2 } });
    expect(dear).toContainEqual({ path: "levelCurve", message: expect.stringContaining("первый уровень") });
    const flat = findContentProblems({ ...CONTENT_SNAPSHOT, levelCurve: { baseXp: 5, growth: 1 } });
    expect(flat).toContainEqual({ path: "levelCurve", message: expect.stringContaining("должна расти") });
  });

  it("ловит битые тайники: раздел secrets и сообщение движка тайников", () => {
    const overlapping = { ...SECRETS, rings: [SECRETS.rings[0], { ...SECRETS.rings[1], minRadius: SECRETS.rings[0].minRadius }, ...SECRETS.rings.slice(2)] };
    const problems = findContentProblems({ ...CONTENT_SNAPSHOT, secrets: overlapping });
    expect(problems.some((problem) => problem.path === "secrets")).toBe(true);
    expect(problems.filter((problem) => problem.path === "secrets").every((problem) => problem.message.length > 0)).toBe(true);

    const noBlessings = findContentProblems({ ...CONTENT_SNAPSHOT, secrets: { ...SECRETS, blessings: [] } });
    expect(noBlessings.some((problem) => problem.path === "secrets")).toBe(true);
  });

  it("ловит потолки подборов, которые не влезают в пул", () => {
    const drops = { ...CONTENT_SNAPSHOT.drops, medkits: { ...CONTENT_SNAPSHOT.drops.medkits, maxOnField: 8 }, magnets: { ...CONTENT_SNAPSHOT.drops.magnets, maxOnField: 8 } };
    expect(findContentProblems({ ...CONTENT_SNAPSHOT, drops })).toContainEqual({
      path: "chests",
      message: expect.stringContaining("пул"),
    });
  });

  it("ловит таймлайн без элиты и босса: первый сундук не выпадет никогда", () => {
    const timeline = TIMELINE.map((segment) => ({ ...segment, events: (segment.events ?? []).filter((event) => !CONTENT_SNAPSHOT.enemies.some((enemy) => enemy.id === event.enemy && enemy.rank !== undefined)) }));
    const problems = findContentProblems({ ...CONTENT_SNAPSHOT, timeline });
    expect(problems.some((problem) => problem.path === "timeline" && problem.message.includes("первый сундук"))).toBe(true);
  });

  it("ловит снимок без уровня сложности по умолчанию: забег пошёл бы без сложности", () => {
    const difficulties = CONTENT_SNAPSHOT.difficulties.filter((level) => level.id !== DEFAULT_DIFFICULTY_ID);
    expect(findContentProblems({ ...CONTENT_SNAPSHOT, difficulties })).toContainEqual({
      path: "difficulties",
      message: expect.stringContaining(`«${DEFAULT_DIFFICULTY_ID}»`),
    });
  });

  it("ловит уровни сложности не в порядке DIFFICULTY_IDS: от порядка зависят выбор и рейтинг", () => {
    const reversed = [...CONTENT_SNAPSHOT.difficulties].reverse();
    const problems = findContentProblems({ ...CONTENT_SNAPSHOT, difficulties: reversed });
    expect(problems).toContainEqual({ path: "difficulties", message: expect.stringContaining("порядок") });
    const lost = findContentProblems({ ...CONTENT_SNAPSHOT, difficulties: CONTENT_SNAPSHOT.difficulties.slice(0, 2) });
    expect(lost).toContainEqual({ path: "difficulties", message: expect.stringContaining("порядок") });
  });

  it("не бросает исключение на пустом снимке, а возвращает проблемы", () => {
    const empty: ContentSnapshot = { ...CONTENT_SNAPSHOT, enemies: [], weapons: [], timeline: [], passives: [] };
    expect(() => findContentProblems(empty)).not.toThrow();
    expect(findContentProblems(empty).length).toBeGreaterThan(0);
  });
});

describe("движок и бот принимают снимок", () => {
  it("забег со снимком-умолчанием побитно равен забегу без снимка", () => {
    expect(runChecksum(CONTENT_SNAPSHOT, 900)).toBe(runChecksum(undefined, 900));
  });

  it("забег на снимке, прошедшем JSON и схему, побитно равен забегу на умолчании", () => {
    const roundTripped = contentSnapshotSchema.parse(viaJson(CONTENT_SNAPSHOT));
    expect(runChecksum(roundTripped, 900)).toBe(runChecksum(undefined, 900));
  });

  it("правка снимка меняет забег: движок читает контент оттуда, а не из импортов", () => {
    const tougher = { ...CONTENT_SNAPSHOT, enemies: ENEMIES.map((enemy) => ({ ...enemy, hp: enemy.hp * 5 })) };
    expect(runChecksum(tougher, 900)).not.toBe(runChecksum(undefined, 900));
  });

  it("таймлайн берётся из снимка: без спавна первые полминуты поле пусто", () => {
    const silent = { ...CONTENT_SNAPSHOT, timeline: TIMELINE.map((segment) => ({ ...segment, spawns: [], events: [] })) };
    const { world, spawner } = createRunWorld({ seed: 3, mapId: "", difficultyId: "easy", unitScale: 2, content: silent });
    for (let tick = 0; tick < 600; tick++) {
      spawner.update(world, TICK_SEC);
      stepWorld(world, { moveX: 0, moveY: 0 });
    }
    expect(world.stats.peakEnemies).toBe(0);
  });

  it("берёт кривую бесконечного режима из того же снимка, что и таймлайн", () => {
    expect(createTimelineDirector(CONTENT_SNAPSHOT.timeline, CONTENT_SNAPSHOT.endlessCurve)).toBeDefined();
  });

  it("бот калибровки: без снимка и со снимком-умолчанием результат один", () => {
    const options = { seed: 5, skill: "dodging" as const, maxSec: 60 };
    expect(simulateBalanceRun({ ...options, content: CONTENT_SNAPSHOT })).toEqual(simulateBalanceRun(options));
  });

  it("бот калибровки: правка снимка меняет результат", () => {
    const options = { seed: 5, skill: "passive" as const, maxSec: 120 };
    const deadly = { ...CONTENT_SNAPSHOT, enemies: ENEMIES.map((enemy) => ({ ...enemy, damage: enemy.damage * 50 })) };
    expect(simulateBalanceRun({ ...options, content: deadly }).survivalSec).toBeLessThan(simulateBalanceRun(options).survivalSec);
  });
});

describe("выгрузка снимка: pnpm content:export", () => {
  const dictionary = readDictionary();

  it("собирает ключи имён из снимка: враги по соглашению оболочки, остальное — из полей", () => {
    const keys = collectNameKeys(CONTENT_SNAPSHOT);
    expect(keys).toContain(`enemy.${ENEMIES[0].id}.name`);
    expect(keys).toContain(WEAPONS[0].nameKey);
    expect(keys).toContain(WEAPONS[0].descriptionKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("находит в словаре игры тексты для всех врагов, оружия, навыков, бустов и сложностей", () => {
    const { missingNames } = buildExport(CONTENT_SNAPSHOT, dictionary);
    // Карта в интерфейсе не показывается, имени у неё может не быть.
    expect(missingNames.filter((key) => !key.startsWith("map."))).toEqual([]);
  });

  it("пишет снимок так, что хэш файла равен CONTENT_HASH: сервер заводит по нему версию 0", () => {
    const { files } = buildExport(CONTENT_SNAPSHOT, dictionary);
    const stored = JSON.parse(files[SNAPSHOT_FILE]) as ContentSnapshot;
    expect(hashSnapshot(stored)).toBe(CONTENT_HASH);
    expect(contentSnapshotSchema.safeParse(stored).success).toBe(true);
  });

  it("кладёт в файл схемы JSON-схему снимка, а в файл имён — только строки", () => {
    const { files } = buildExport(CONTENT_SNAPSHOT, dictionary);
    const schema = JSON.parse(files[SCHEMA_FILE]) as { type: string; required: string[] };
    expect(schema.type).toBe("object");
    expect(schema.required).toContain("schemaVersion");
    const names = JSON.parse(files[NAMES_FILE]) as Record<string, unknown>;
    expect(Object.values(names).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
    expect(names[`enemy.${ENEMIES[0].id}.name`]).toBeTypeOf("string");
  });

  it("не считает отсутствующий текст ошибкой, а называет ключ в списке", () => {
    const { files, missingNames } = buildExport(CONTENT_SNAPSHOT, {});
    expect(missingNames).toEqual(collectNameKeys(CONTENT_SNAPSHOT));
    expect(JSON.parse(files[NAMES_FILE])).toEqual({});
  });

  it("пишет три файла в каталог, создавая его", () => {
    const dir = mkdtempSync(join(tmpdir(), "content-export-"));
    try {
      const target = join(dir, "nested", "dist");
      writeExport(target);
      for (const name of [SNAPSHOT_FILE, SCHEMA_FILE, NAMES_FILE]) {
        expect(() => JSON.parse(readFileSync(join(target, name), "utf8")), name).not.toThrow();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
