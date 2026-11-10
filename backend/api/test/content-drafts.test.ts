import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExport, HASH_FILE, NAMES_FILE, SCHEMA_FILE, SNAPSHOT_FILE } from "../../../scripts/content/export-snapshot";
import { CONTENT_SNAPSHOT } from "../../../packages/core-game/src/content/snapshot";
import { contentSnapshotJsonSchema, contentSnapshotSchema } from "../../../packages/core-game/src/content/snapshot-schema";
import { CONTENT_HASH } from "../../../packages/core-game/src/content/hash";
import { loadAppConfig } from "../src/config/app-config.js";
import { DomainError } from "../src/common/domain-error.js";
import { ContentCheckService } from "../src/modules/content/content-check.service.js";
import { diffSnapshots } from "../src/modules/content/content-diff.js";
import { editSnapshot } from "../src/modules/content/content-edit.js";
import { ContentCheckBusyError } from "../src/modules/content/content-errors.js";
import { snapshotHash } from "../src/modules/content/content-hash.js";
import { CONTENT_EXPORT_FILES, importContentVersion, parseContentExport, readContentExport } from "../src/modules/content/content-import.js";
import { validateJsonSchema } from "../src/modules/content/content-json-schema.js";
import { parsePath } from "../src/modules/content/content-path.js";
import { CONTENT_CHECK_QUEUE_NAME, CONTENT_CHECK_QUEUE_MAX_WAITING, CONTENT_SNAPSHOT_MAX_BYTES, type CheckJobPayload, type CheckJobState, type ContentCheckQueue } from "../src/modules/content/content-check.queue.js";
import type {
  ContentCheckRecord,
  ContentCheckStatus,
  ContentDraftRecord,
  ContentDraftSummary,
  ContentRepository,
  ContentVersionRecord,
  ContentVersionSummary,
  DraftMutation,
  NewContentVersion,
} from "../src/modules/content/content.repository.js";
import { ContentService } from "../src/modules/content/content.service.js";
import { RolesService, type AccountRef } from "../src/modules/roles/roles.service.js";
import { AUTH_ENV } from "./helpers/auth-env.js";
import { MemoryAccountRepository } from "./helpers/memory-auth.js";
import { MemoryRolesRepository } from "./helpers/memory-roles.js";

/**
 * Черновики контента на сервере (tasks/T-0303): правка по пути с проверкой
 * формы схемой снимка, разница с базой, версия 0 из выгрузки и проверка через
 * sim-worker. Сервер пакеты игры не импортирует — снимок и JSON Schema здесь
 * берутся из них только как данные теста, а проверка идёт серверным кодом.
 */

interface Snap {
  schemaVersion: number;
  enemies: { id: string; hp: number; size?: number; [key: string]: unknown }[];
  timeline: { fromSec: number; spawns: { enemy: string; perSec: number }[] }[];
  levelCurve: { baseXp: number; growth: number };
  [key: string]: unknown;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Те же данные с ключами в обратном порядке на всех уровнях: так их возвращает jsonb. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reverseKeys(inner)]));
}
const SNAPSHOT = clone(CONTENT_SNAPSHOT) as unknown as Snap;
const JSON_SCHEMA: unknown = clone(contentSnapshotJsonSchema());
const ENEMY = SNAPSHOT.enemies[0];
if (ENEMY === undefined) throw new Error("в контенте нет врагов");
const HP_PATH = `enemies[id=${ENEMY.id}].hp`;

/** Ошибка домена с кодом ответа: проверка «422», а не «что-то упало». */
async function domainError(action: () => unknown): Promise<DomainError> {
  try {
    await action();
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидалась доменная ошибка");
}

function sync(action: () => unknown): DomainError {
  try {
    action();
  } catch (error: unknown) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("ожидалась доменная ошибка");
}

describe("путь правки", () => {
  it("разбирает ключи, индексы и выбор по id", () => {
    expect(parsePath("enemies[id=swarm_rat].hp")).toEqual([
      { kind: "key", name: "enemies" },
      { kind: "find", field: "id", value: "swarm_rat" },
      { kind: "key", name: "hp" },
    ]);
    expect(parsePath("timeline[3].spawns[0].perSec")).toEqual([
      { kind: "key", name: "timeline" },
      { kind: "index", index: 3 },
      { kind: "key", name: "spawns" },
      { kind: "index", index: 0 },
      { kind: "key", name: "perSec" },
    ]);
    expect(parsePath("levelCurve.baseXp")).toHaveLength(2);
  });

  it.each(["", ".hp", "enemies.", "enemies[", "enemies[]", "enemies[id=]", "enemies[-1]", "enemies[1.5]", "a..b", "a[0]b", "__proto__.x", "enemies.constructor", "enemies[id=a]]"])("«%s» — не путь: 422 с кодом путей", (path) => {
    const error = sync(() => parsePath(path));
    expect(error.status).toBe(422);
    expect(error.code).toBe("content_path_invalid");
  });
});

describe("правка снимка по пути", () => {
  it("значение на месте, остальное не тронуто, исходный объект не изменён", () => {
    const original = clone(SNAPSHOT);
    const result = editSnapshot({ snapshot: original, jsonSchema: JSON_SCHEMA, path: HP_PATH, value: 7 });
    const next = result.next as Snap;
    expect(result.from).toBe(ENEMY.hp);
    expect(result.to).toBe(7);
    expect(next.enemies[0]?.hp).toBe(7);

    const restored = clone(next);
    const restoredEnemy = restored.enemies[0];
    if (restoredEnemy === undefined) throw new Error("враг пропал");
    restoredEnemy.hp = ENEMY.hp;
    expect(restored).toEqual(SNAPSHOT);
    expect(original).toEqual(SNAPSHOT);
  });

  it("путь по индексам: поток отрезка таймлайна", () => {
    const spawn = SNAPSHOT.timeline[3]?.spawns[0];
    if (spawn === undefined) throw new Error("в таймлайне нет четвёртого отрезка");
    const result = editSnapshot({ snapshot: clone(SNAPSHOT), jsonSchema: JSON_SCHEMA, path: "timeline[3].spawns[0].perSec", value: 4.5 });
    expect(result.from).toBe(spawn.perSec);
    expect((result.next as Snap).timeline[3]?.spawns[0]?.perSec).toBe(4.5);
  });

  it("глубокий путь по объектам: число кривой опыта", () => {
    const result = editSnapshot({ snapshot: clone(SNAPSHOT), jsonSchema: JSON_SCHEMA, path: "levelCurve.growth", value: 1.3 });
    expect((result.next as Snap).levelCurve.growth).toBe(1.3);
  });

  it("можно заменить объект целиком и добавить необязательное поле", () => {
    const added = editSnapshot({ snapshot: clone(SNAPSHOT), jsonSchema: JSON_SCHEMA, path: `enemies[id=${ENEMY.id}].size`, value: 1.5 });
    expect(added.from).toBeNull();
    expect((added.next as Snap).enemies[0]?.size).toBe(1.5);

    const replaced = editSnapshot({ snapshot: clone(SNAPSHOT), jsonSchema: JSON_SCHEMA, path: "levelCurve", value: { baseXp: 9, growth: 1.1 } });
    expect((replaced.next as Snap).levelCurve).toEqual({ baseXp: 9, growth: 1.1 });
  });

  it("враг, которого нет, — 422 с путём; снимок не меняется", () => {
    const original = clone(SNAPSHOT);
    const error = sync(() => editSnapshot({ snapshot: original, jsonSchema: JSON_SCHEMA, path: "enemies[id=no_such_enemy].hp", value: 1 }));
    expect(error.status).toBe(422);
    expect(error.code).toBe("content_path_invalid");
    expect(error.message).toContain("no_such_enemy");
    expect(original).toEqual(SNAPSHOT);
  });

  it.each(["timeline[99].spawns[0].perSec", "timeline[0].spawns[9].perSec", "noSuchSection.hp", "levelCurve.baseXp.deeper", "enemies.hp"])("несуществующий путь «%s» — 422", (path) => {
    const error = sync(() => editSnapshot({ snapshot: clone(SNAPSHOT), jsonSchema: JSON_SCHEMA, path, value: 1 }));
    expect(error.status).toBe(422);
    expect(error.code).toBe("content_path_invalid");
  });

  it("строка вместо числа — 422 с путём к полю; снимок не меняется", () => {
    const original = clone(SNAPSHOT);
    const error = sync(() => editSnapshot({ snapshot: original, jsonSchema: JSON_SCHEMA, path: HP_PATH, value: "много" }));
    expect(error.status).toBe(422);
    expect(error.code).toBe("content_value_invalid");
    expect(error.message).toContain(HP_PATH);
    expect(original).toEqual(SNAPSHOT);
  });

  it.each([
    ["число вне коридора схемы", HP_PATH, 0],
    ["отрицательное число", HP_PATH, -3],
    ["лишнее поле объекта", "levelCurve", { baseXp: 6, growth: 1.2, extra: 1 }],
    ["не хватает обязательного поля", "levelCurve", { baseXp: 6 }],
    ["значение из списка не из списка", `enemies[id=${ENEMY.id}].rank`, "king"],
    ["неизвестное поле врага", `enemies[id=${ENEMY.id}].luck`, 5],
    ["версия схемы", "schemaVersion", 2],
    ["дробное там, где целое", "maxBoostsPerRun", 1.5],
  ])("не по схеме: %s — 422", (_name, path, value) => {
    const error = sync(() => editSnapshot({ snapshot: clone(SNAPSHOT), jsonSchema: JSON_SCHEMA, path, value }));
    expect(error.status).toBe(422);
    expect(error.code).toBe("content_value_invalid");
    expect(error.message.startsWith(path.split(".")[0] ?? "")).toBe(true);
  });

  it("прототип не загрязняется ни путём, ни значением", () => {
    sync(() => editSnapshot({ snapshot: clone(SNAPSHOT), jsonSchema: JSON_SCHEMA, path: "__proto__.polluted", value: 1 }));
    sync(() => editSnapshot({ snapshot: clone(SNAPSHOT), jsonSchema: JSON_SCHEMA, path: "levelCurve", value: JSON.parse('{"__proto__":{"polluted":1},"baseXp":1,"growth":1}') as unknown }));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("проверка схемой снимка — та же, что у Zod", () => {
  const cases: [string, (snapshot: Snap) => void][] = [
    ["здоровье 0", (s) => void (s.enemies[0]!.hp = 0)],
    ["здоровье строкой", (s) => void (s.enemies[0]!.hp = "5" as unknown as number)],
    ["здоровье дробное", (s) => void (s.enemies[0]!.hp = 5.5)],
    ["лишнее поле врага", (s) => void (s.enemies[0]!.luck = 1)],
    ["нет паттерна", (s) => void delete s.enemies[0]!.pattern],
    ["чужой паттерн", (s) => void (s.enemies[0]!.pattern = "teleport")],
    ["ранг не из списка", (s) => void (s.enemies[0]!.rank = "king")],
    ["стойкость к неизвестной стихии", (s) => void (s.enemies[0]!.resist = { water: 0.5 })],
    ["стойкость не числом", (s) => void (s.enemies[0]!.resist = { fire: "много" })],
    ["версия схемы", (s) => void (s.schemaVersion = 2)],
    ["секция null", (s) => void (s.levelCurve = null as unknown as Snap["levelCurve"])],
    ["пустой id", (s) => void (s.enemies[0]!.id = "")],
    ["целое дробным", (s) => void (s.maxBoostsPerRun = 1.5)],
    ["поток отрезка строкой", (s) => void (s.timeline[3]!.spawns[0]!.perSec = "2" as unknown as number)],
    ["нет секции", (s) => void delete s.pressure],
    ["без правок", () => undefined],
  ];

  it.each(cases)("%s", (_name, mutate) => {
    const snapshot = clone(SNAPSHOT);
    mutate(snapshot);
    const mine = validateJsonSchema(JSON_SCHEMA, snapshot).length === 0;
    expect(mine).toBe(contentSnapshotSchema.safeParse(snapshot).success);
  });

  it("снимок по умолчанию схеме соответствует", () => {
    expect(validateJsonSchema(JSON_SCHEMA, SNAPSHOT)).toEqual([]);
  });

  it("незнакомое ключевое слово схемы — отказ, а не молчаливое «подходит»", () => {
    const error = sync(() => validateJsonSchema({ type: "object", unevaluatedProperties: false }, {}));
    expect(error.message).toContain("unevaluatedProperties");
  });
});

describe("хэш снимка", () => {
  it("не зависит от порядка ключей и меняется от значения", () => {
    const shuffled = JSON.parse(JSON.stringify({ b: 1, a: { d: [1, 2], c: 3 } })) as unknown;
    const same = JSON.parse(JSON.stringify({ a: { c: 3, d: [1, 2] }, b: 1 })) as unknown;
    expect(snapshotHash(shuffled)).toBe(snapshotHash(same));
    expect(snapshotHash({ a: [1, 2] })).not.toBe(snapshotHash({ a: [2, 1] }));
    expect(snapshotHash(SNAPSHOT)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("разница черновика с базой", () => {
  it("только изменённые пути, в порядке снимка", () => {
    const draft = clone(SNAPSHOT);
    draft.enemies[0]!.hp = 7;
    draft.timeline[3]!.spawns[0]!.perSec = 4.5;
    draft.levelCurve.growth = 1.3;
    expect(diffSnapshots(SNAPSHOT, draft)).toEqual({
      changes: [
        { path: HP_PATH, from: ENEMY.hp, to: 7 },
        { path: "levelCurve.growth", from: SNAPSHOT.levelCurve.growth, to: 1.3 },
        { path: "timeline[3].spawns[0].perSec", from: SNAPSHOT.timeline[3]?.spawns[0]?.perSec, to: 4.5 },
      ],
      truncated: false,
    });
  });

  it("одинаковые снимки — пусто, порядок ключей не важен", () => {
    expect(diffSnapshots(SNAPSHOT, reverseKeys(SNAPSHOT)).changes).toEqual([]);
  });

  it("добавленное и убранное поле, враг по id", () => {
    const draft = clone(SNAPSHOT);
    draft.enemies[0]!.size = 1.5;
    const removed = draft.enemies.splice(1, 1)[0];
    if (removed === undefined) throw new Error("нет второго врага");
    const { changes } = diffSnapshots(SNAPSHOT, draft);
    expect(changes).toContainEqual({ path: `enemies[id=${ENEMY.id}].size`, from: null, to: 1.5 });
    expect(changes).toContainEqual({ path: `enemies[id=${removed.id}]`, from: removed, to: null });
    expect(changes).toHaveLength(2);
  });

  it("путь из разницы принимается правкой: применив его к базе, получаем черновик", () => {
    const draft = clone(SNAPSHOT);
    draft.enemies[0]!.hp = 11;
    draft.timeline[3]!.spawns[0]!.perSec = 9;
    let rebuilt: unknown = clone(SNAPSHOT);
    for (const change of diffSnapshots(SNAPSHOT, draft).changes) {
      rebuilt = editSnapshot({ snapshot: rebuilt, jsonSchema: JSON_SCHEMA, path: change.path, value: change.to }).next;
    }
    expect(rebuilt).toEqual(draft);
  });

  it("слишком много отличий — обрезается и говорит об этом", () => {
    const draft = clone(SNAPSHOT);
    draft.timeline = draft.timeline.map((segment) => ({ ...segment, spawns: segment.spawns.map((spawn) => ({ ...spawn, perSec: spawn.perSec + 1 })) }));
    const full = diffSnapshots(SNAPSHOT, draft);
    expect(full.changes.length).toBeGreaterThan(5);
    const cut = diffSnapshots(SNAPSHOT, draft, 3);
    expect(cut.changes).toHaveLength(3);
    expect(cut.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Сервис на памяти
// ---------------------------------------------------------------------------

const T0 = new Date("2026-11-01T10:00:00Z");

class MemoryContentRepository implements ContentRepository {
  readonly versionRows: ContentVersionRecord[] = [];
  readonly draftRows = new Map<string, ContentDraftRecord>();
  readonly checkRows: ContentCheckRecord[] = [];
  private nextVersion = 1;

  private summary(row: ContentVersionRecord): ContentVersionSummary {
    return { versionNo: row.versionNo, contentHash: row.contentHash, schemaVersion: row.schemaVersion, source: row.source, createdBy: row.createdBy, createdAt: row.createdAt, publishedAt: row.publishedAt };
  }
  private draftSummary(row: ContentDraftRecord): ContentDraftSummary {
    return { draftId: row.draftId, baseVersionNo: row.baseVersionNo, title: row.title, author: row.author, updatedAt: row.updatedAt, archivedAt: row.archivedAt };
  }
  async versions(): Promise<ContentVersionSummary[]> {
    return [...this.versionRows].reverse().map((row) => this.summary(row));
  }
  async version(versionNo: number): Promise<ContentVersionRecord | null> {
    return clone(this.versionRows.find((row) => row.versionNo === versionNo) ?? null);
  }
  async versionByHash(contentHash: string): Promise<ContentVersionSummary | null> {
    const row = this.versionRows.find((candidate) => candidate.contentHash === contentHash);
    return row === undefined ? null : this.summary(row);
  }
  async latestVersion(): Promise<ContentVersionSummary | null> {
    const row = this.versionRows.at(-1);
    return row === undefined ? null : this.summary(row);
  }
  async addVersion(input: NewContentVersion): Promise<{ created: boolean; version: ContentVersionSummary }> {
    const existing = this.versionRows.find((row) => row.contentHash === input.contentHash);
    if (existing !== undefined) return { created: false, version: this.summary(existing) };
    const row: ContentVersionRecord = { ...clone(input), versionNo: this.nextVersion++, publishedAt: null };
    this.versionRows.push(row);
    return { created: true, version: this.summary(row) };
  }
  async drafts(options: { archived: boolean; limit: number }): Promise<ContentDraftSummary[]> {
    return [...this.draftRows.values()]
      .filter((row) => (row.archivedAt !== null) === options.archived)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, options.limit)
      .map((row) => this.draftSummary(row));
  }
  async activeDraftCount(): Promise<number> {
    return [...this.draftRows.values()].filter((row) => row.archivedAt === null).length;
  }
  async draft(draftId: string): Promise<ContentDraftRecord | null> {
    return clone(this.draftRows.get(draftId) ?? null);
  }
  async addDraft(record: ContentDraftRecord): Promise<void> {
    this.draftRows.set(record.draftId, clone(record));
  }
  async editDraft(draftId: string, at: Date, edit: (current: ContentDraftRecord) => unknown): Promise<DraftMutation> {
    const current = this.draftRows.get(draftId);
    if (current === undefined) return { outcome: "missing" };
    if (current.archivedAt !== null) return { outcome: "archived" };
    const before = clone(current);
    const next = edit(clone(current));
    if (next === null) return { outcome: "ok", before, after: before };
    const after: ContentDraftRecord = { ...current, snapshot: clone(next), updatedAt: at };
    this.draftRows.set(draftId, after);
    return { outcome: "ok", before, after: clone(after) };
  }
  async archiveDraft(draftId: string, at: Date): Promise<ContentDraftSummary | null> {
    const current = this.draftRows.get(draftId);
    if (current === undefined) return null;
    const archived: ContentDraftRecord = { ...current, archivedAt: current.archivedAt ?? at };
    this.draftRows.set(draftId, archived);
    return this.draftSummary(archived);
  }
  async addCheck(record: ContentCheckRecord): Promise<ContentCheckRecord> {
    const existing = await this.reusableCheck(record.draftId, record.snapshotHash);
    if (existing !== null) return existing;
    this.checkRows.push(clone(record));
    return record;
  }
  async check(checkId: string): Promise<ContentCheckRecord | null> {
    return clone(this.checkRows.find((row) => row.checkId === checkId) ?? null);
  }
  async latestCheck(draftId: string): Promise<ContentCheckRecord | null> {
    return clone([...this.checkRows].reverse().find((row) => row.draftId === draftId) ?? null);
  }
  async reusableCheck(draftId: string, hash: string): Promise<ContentCheckRecord | null> {
    const found = [...this.checkRows].reverse().find((row) => row.draftId === draftId && row.snapshotHash === hash && row.status !== "failed");
    return clone(found ?? null);
  }
  async finishCheck(checkId: string, status: Exclude<ContentCheckStatus, "queued">, report: unknown): Promise<boolean> {
    const row = this.checkRows.find((candidate) => candidate.checkId === checkId);
    if (row === undefined || row.status !== "queued") return false;
    row.status = status;
    row.report = clone(report);
    return true;
  }
  async removeCheck(checkId: string): Promise<void> {
    const index = this.checkRows.findIndex((row) => row.checkId === checkId);
    if (index >= 0) this.checkRows.splice(index, 1);
  }
}

class FakeQueue implements ContentCheckQueue {
  readonly jobs: CheckJobPayload[] = [];
  readonly cancelled: string[] = [];
  readonly states = new Map<string, CheckJobState>();
  busy = false;
  down = false;

  async submit(job: CheckJobPayload): Promise<void> {
    if (this.down) throw new Error("Redis недоступен");
    if (this.busy) throw new ContentCheckBusyError();
    this.jobs.push(clone(job));
    this.states.set(job.checkId, { state: "pending" });
  }
  async poll(checkId: string): Promise<CheckJobState> {
    if (this.down) throw new Error("Redis недоступен");
    return this.states.get(checkId) ?? { state: "missing" };
  }
  async cancel(checkId: string): Promise<void> {
    this.cancelled.push(checkId);
  }
  finish(checkId: string, partial: { timeout?: boolean; schemaProblems?: { path: string; message: string }[]; contentProblems?: { path: string; message: string }[] } = {}): void {
    this.states.set(checkId, {
      state: "finished",
      result: {
        checkId,
        schemaProblems: partial.schemaProblems ?? [],
        contentProblems: partial.contentProblems ?? [],
        report: { timeout: partial.timeout ?? false, seeds: 20, scenarios: [], corridors: [] },
        elapsedMs: 1234,
      },
    });
  }
}

const config = () => loadAppConfig({ NODE_ENV: "test", ...AUTH_ENV, ADMIN_TELEGRAM_IDS: "777000222" } as NodeJS.ProcessEnv);

interface Setup {
  accounts: MemoryAccountRepository;
  rolesRepo: MemoryRolesRepository;
  repo: MemoryContentRepository;
  queue: FakeQueue;
  content: ContentService;
  checks: ContentCheckService;
  baseNo: number;
}

async function setup(): Promise<Setup> {
  const accounts = new MemoryAccountRepository();
  const rolesRepo = new MemoryRolesRepository();
  const repo = new MemoryContentRepository();
  const queue = new FakeQueue();
  const roles = new RolesService(config(), rolesRepo, accounts);
  const added = await repo.addVersion({
    contentHash: "ab12cd34",
    schemaVersion: 1,
    snapshot: clone(SNAPSHOT),
    jsonSchema: clone(JSON_SCHEMA),
    names: { "enemy.swarm_rat.name": "Крыса" },
    source: "repo",
    createdBy: null,
    createdAt: T0,
  });
  return { accounts, rolesRepo, repo, queue, content: new ContentService(repo, roles), checks: new ContentCheckService(repo, roles, queue), baseNo: added.version.versionNo };
}

async function person(s: Setup, id: string, role: "game_designer" | "analyst" | "moderator"): Promise<AccountRef> {
  const account = await s.accounts.upsert({ platform: "telegram", platformUserId: id, displayName: `Человек ${id}`, username: null, photoUrl: null }, T0.getTime());
  await s.rolesRepo.grant(account.accountId, role, null);
  return { accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId };
}

describe("черновики в сервисе", () => {
  let s: Setup;
  let designer: AccountRef;

  beforeEach(async () => {
    s = await setup();
    designer = await person(s, "1", "game_designer");
  });

  it("черновик — копия снимка последней версии; название обрезается по краям", async () => {
    const draft = await s.content.createDraft(designer, { title: "  Крысы потолще  " }, T0);
    expect(draft.title).toBe("Крысы потолще");
    expect(draft.baseVersionNo).toBe(s.baseNo);
    expect(draft.author).toBe(designer.accountId);
    const stored = await s.repo.draft(draft.draftId);
    expect(stored?.snapshot).toEqual(SNAPSHOT);
    expect(s.rolesRepo.entries.map((entry) => entry.action)).toEqual(["content.draft.create"]);
  });

  it.each([["", "пустое"], ["   ", "из пробелов"], ["я".repeat(81), "длиннее 80"]])("название %j (%s) — 400", async (title) => {
    const error = await domainError(() => s.content.createDraft(designer, { title }, T0));
    expect(error.status).toBe(400);
  });

  it("версии, которой нет, — 404", async () => {
    const error = await domainError(() => s.content.createDraft(designer, { title: "x", baseVersionNo: 99 }, T0));
    expect(error.status).toBe(404);
  });

  it("слишком много открытых черновиков — 409; после архива место освобождается", async () => {
    for (let index = 0; index < 100; index += 1) await s.content.createDraft(designer, { title: `Ч${String(index)}` }, T0);
    const refused = await domainError(() => s.content.createDraft(designer, { title: "лишний" }, T0));
    expect(refused.status).toBe(409);
    const first = (await s.content.drafts(designer, false))[0];
    await s.content.archiveDraft(designer, first?.draftId ?? "", T0);
    await s.content.createDraft(designer, { title: "теперь можно" }, T0);
  });

  it("правка пишет черновик и аудит: путь, было → стало", async () => {
    const draft = await s.content.createDraft(designer, { title: "Правка" }, T0);
    const later = new Date(T0.getTime() + 60_000);
    const result = await s.content.patchDraft(designer, draft.draftId, { path: HP_PATH, value: 7 }, later);
    expect(result).toMatchObject({ draftId: draft.draftId, path: HP_PATH, from: ENEMY.hp, to: 7, changed: true });
    expect(result.snapshotHash).toBe(snapshotHash((await s.repo.draft(draft.draftId))?.snapshot));
    expect(result.updatedAt).toEqual(later);

    const audit = s.rolesRepo.entries.at(-1);
    expect(audit).toMatchObject({ action: "content.draft.patch", target: draft.draftId, actorAccountId: designer.accountId, before: { path: HP_PATH, value: ENEMY.hp }, after: { path: HP_PATH, value: 7 } });
  });

  it("то же значение — без записи и без аудита", async () => {
    const draft = await s.content.createDraft(designer, { title: "Ничего" }, T0);
    const before = s.rolesRepo.entries.length;
    const result = await s.content.patchDraft(designer, draft.draftId, { path: HP_PATH, value: ENEMY.hp }, new Date(T0.getTime() + 1));
    expect(result.changed).toBe(false);
    expect(s.rolesRepo.entries).toHaveLength(before);
    expect((await s.repo.draft(draft.draftId))?.updatedAt).toEqual(T0);
  });

  it("не та форма — 422, черновик и аудит не тронуты", async () => {
    const draft = await s.content.createDraft(designer, { title: "Мимо" }, T0);
    const before = s.rolesRepo.entries.length;
    const error = await domainError(() => s.content.patchDraft(designer, draft.draftId, { path: HP_PATH, value: "много" }, new Date(T0.getTime() + 1)));
    expect(error.status).toBe(422);
    expect(error.message).toContain(HP_PATH);
    const missing = await domainError(() => s.content.patchDraft(designer, draft.draftId, { path: "enemies[id=nope].hp", value: 1 }, new Date(T0.getTime() + 1)));
    expect(missing.status).toBe(422);
    expect((await s.repo.draft(draft.draftId))?.snapshot).toEqual(SNAPSHOT);
    expect(s.rolesRepo.entries).toHaveLength(before);
  });

  it("слишком большое значение — 413", async () => {
    const draft = await s.content.createDraft(designer, { title: "Много" }, T0);
    const error = await domainError(() => s.content.patchDraft(designer, draft.draftId, { path: "levelCurve", value: { baseXp: 1, growth: 1, pad: "я".repeat(40_000) } }, T0));
    expect(error.status).toBe(413);
  });

  it("чужого черновика нет — 404; в архивный писать нельзя — 409", async () => {
    const missing = await domainError(() => s.content.patchDraft(designer, "00000000-0000-4000-8000-000000000000", { path: HP_PATH, value: 7 }, T0));
    expect(missing.status).toBe(404);
    const draft = await s.content.createDraft(designer, { title: "В архив" }, T0);
    await s.content.archiveDraft(designer, draft.draftId, T0);
    expect(s.rolesRepo.entries.at(-1)?.action).toBe("content.draft.archive");
    const archived = await domainError(() => s.content.patchDraft(designer, draft.draftId, { path: HP_PATH, value: 7 }, T0));
    expect(archived.status).toBe(409);
    expect((await s.content.drafts(designer, false)).some((row) => row.draftId === draft.draftId)).toBe(false);
    expect((await s.content.drafts(designer, true)).some((row) => row.draftId === draft.draftId)).toBe(true);
  });

  it("разница: только изменённые пути против версии-основы", async () => {
    const draft = await s.content.createDraft(designer, { title: "Разница" }, T0);
    expect((await s.content.diff(designer, draft.draftId)).changes).toEqual([]);
    await s.content.patchDraft(designer, draft.draftId, { path: HP_PATH, value: 9 }, T0);
    const diff = await s.content.diff(designer, draft.draftId);
    expect(diff).toEqual({ baseVersionNo: s.baseNo, changes: [{ path: HP_PATH, from: ENEMY.hp, to: 9 }], truncated: false });
  });

  it("права: смотреть может аналитик, править — нет, без прав на контент — ничего", async () => {
    const analyst = await person(s, "2", "analyst");
    const outsider = await person(s, "3", "moderator");
    const draft = await s.content.createDraft(designer, { title: "Права" }, T0);
    expect((await s.content.drafts(analyst, false)).length).toBe(1);
    expect((await s.content.draft(analyst, draft.draftId)).draftId).toBe(draft.draftId);
    expect((await domainError(() => s.content.createDraft(analyst, { title: "x" }, T0))).status).toBe(403);
    expect((await domainError(() => s.content.patchDraft(analyst, draft.draftId, { path: HP_PATH, value: 7 }, T0))).status).toBe(403);
    expect((await domainError(() => s.content.archiveDraft(analyst, draft.draftId, T0))).status).toBe(403);
    expect((await domainError(() => s.checks.start(analyst, draft.draftId, T0))).status).toBe(403);
    expect((await domainError(() => s.content.drafts(outsider, false))).status).toBe(403);
    expect((await domainError(() => s.content.versions(outsider))).status).toBe(403);
  });

  it("версии: список без снимков и версия целиком с именами и схемой", async () => {
    const list = await s.content.versions(designer);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("snapshot");
    const full = await s.content.version(designer, s.baseNo);
    expect(full.names).toEqual({ "enemy.swarm_rat.name": "Крыса" });
    expect(full.snapshot).toEqual(SNAPSHOT);
    expect((await domainError(() => s.content.version(designer, 99))).status).toBe(404);
  });
});

describe("проверка черновика", () => {
  let s: Setup;
  let designer: AccountRef;
  let draftId: string;

  beforeEach(async () => {
    s = await setup();
    designer = await person(s, "1", "game_designer");
    draftId = (await s.content.createDraft(designer, { title: "Проверка" }, T0)).draftId;
  });

  it("ставит задание с черновиком и базой; в аудите — запуск", async () => {
    const started = await s.checks.start(designer, draftId, T0);
    expect(started.reused).toBe(false);
    expect(started.check).toMatchObject({ draftId, status: "queued", report: null });
    expect(s.queue.jobs).toHaveLength(1);
    const job = s.queue.jobs[0];
    expect(job?.checkId).toBe(started.check.checkId);
    expect(job?.snapshot).toEqual(SNAPSHOT);
    expect(job?.baseSnapshot).toEqual(SNAPSHOT);
    expect(s.rolesRepo.entries.at(-1)).toMatchObject({ action: "content.check.start", target: draftId, after: { checkId: started.check.checkId } });
  });

  it("повтор с тем же снимком — прошлая проверка, нового задания нет", async () => {
    const first = await s.checks.start(designer, draftId, T0);
    s.queue.finish(first.check.checkId);
    const second = await s.checks.start(designer, draftId, T0);
    expect(second.reused).toBe(true);
    expect(second.check.checkId).toBe(first.check.checkId);
    expect(second.check.status).toBe("done");
    expect(second.check.report).toMatchObject({ elapsedMs: 1234 });
    expect(s.queue.jobs).toHaveLength(1);
  });

  it("правка снимка — новая проверка; снимок тот же после отката правки — прошлая", async () => {
    const first = await s.checks.start(designer, draftId, T0);
    s.queue.finish(first.check.checkId);
    await s.content.patchDraft(designer, draftId, { path: HP_PATH, value: 9 }, T0);
    const second = await s.checks.start(designer, draftId, T0);
    expect(second.reused).toBe(false);
    expect(second.check.checkId).not.toBe(first.check.checkId);
    expect(second.check.snapshotHash).not.toBe(first.check.snapshotHash);
    s.queue.finish(second.check.checkId);

    await s.content.patchDraft(designer, draftId, { path: HP_PATH, value: ENEMY.hp }, T0);
    const third = await s.checks.start(designer, draftId, T0);
    expect(third.reused).toBe(true);
    expect(third.check.checkId).toBe(first.check.checkId);
  });

  it("пока считается — повтор отдаёт ту же проверку в очереди", async () => {
    const first = await s.checks.start(designer, draftId, T0);
    const second = await s.checks.start(designer, draftId, T0);
    expect(second).toMatchObject({ reused: true, check: { checkId: first.check.checkId, status: "queued" } });
    expect(s.queue.jobs).toHaveLength(1);
  });

  it("опрос забирает итог воркера: готово, с проблемами и пределом времени", async () => {
    const started = await s.checks.start(designer, draftId, T0);
    expect((await s.checks.read(designer, started.check.checkId, T0)).status).toBe("queued");

    s.queue.finish(started.check.checkId, { contentProblems: [{ path: "enemies", message: "враг без паттерна" }] });
    const done = await s.checks.read(designer, started.check.checkId, T0);
    expect(done.status).toBe("done");
    expect(done.report).toMatchObject({ contentProblems: [{ path: "enemies" }], report: { timeout: false } });
    expect((await s.repo.check(started.check.checkId))?.status).toBe("done");

    await s.content.patchDraft(designer, draftId, { path: HP_PATH, value: 3 }, T0);
    const slow = await s.checks.start(designer, draftId, T0);
    s.queue.finish(slow.check.checkId, { timeout: true });
    expect((await s.checks.read(designer, slow.check.checkId, T0)).status).toBe("timeout");
  });

  it("сбой воркера — failed с причиной; повтор запускает новую проверку", async () => {
    const first = await s.checks.start(designer, draftId, T0);
    s.queue.states.set(first.check.checkId, { state: "failed", reason: "падение прогона" });
    const failed = await s.checks.read(designer, first.check.checkId, T0);
    expect(failed.status).toBe("failed");
    expect(failed.report).toEqual({ error: "падение прогона" });

    const again = await s.checks.start(designer, draftId, T0);
    expect(again.reused).toBe(false);
    expect(again.check.checkId).not.toBe(first.check.checkId);
    expect(s.queue.jobs).toHaveLength(2);
  });

  it("отчёт неожиданной формы не принимается за готовый", async () => {
    const started = await s.checks.start(designer, draftId, T0);
    s.queue.states.set(started.check.checkId, { state: "finished", result: { not: "a report" } });
    expect((await s.checks.read(designer, started.check.checkId, T0)).status).toBe("failed");
  });

  it("задание пропало из очереди: пока свежее — ждём, старое — failed и снято с очереди", async () => {
    const started = await s.checks.start(designer, draftId, T0);
    s.queue.states.delete(started.check.checkId);
    expect((await s.checks.read(designer, started.check.checkId, new Date(T0.getTime() + 30_000))).status).toBe("queued");
    const stale = await s.checks.read(designer, started.check.checkId, new Date(T0.getTime() + 20 * 60_000));
    expect(stale.status).toBe("failed");
    expect(stale.report).toMatchObject({ error: expect.stringContaining("не ответил") });
    expect(s.queue.cancelled).toContain(started.check.checkId);
  });

  it("зависшее в очереди дольше предела — failed", async () => {
    const started = await s.checks.start(designer, draftId, T0);
    const stale = await s.checks.read(designer, started.check.checkId, new Date(T0.getTime() + 20 * 60_000));
    expect(stale.status).toBe("failed");
    expect(s.queue.cancelled).toContain(started.check.checkId);
  });

  it("очередь занята — 429 с текстом воркера, записи проверки не остаётся", async () => {
    s.queue.busy = true;
    const error = await domainError(() => s.checks.start(designer, draftId, T0));
    expect(error.status).toBe(429);
    expect(error.message).toBe("Проверка уже идёт, дождитесь");
    expect(s.repo.checkRows).toHaveLength(0);
  });

  it("Redis недоступен — 503, записи проверки не остаётся", async () => {
    s.queue.down = true;
    const error = await domainError(() => s.checks.start(designer, draftId, T0));
    expect(error.status).toBe(503);
    expect(s.repo.checkRows).toHaveLength(0);
  });

  it("чужих проверок нет — 404; архивный черновик не проверяется — 409", async () => {
    expect((await domainError(() => s.checks.read(designer, "00000000-0000-4000-8000-000000000000", T0))).status).toBe(404);
    await s.content.archiveDraft(designer, draftId, T0);
    expect((await domainError(() => s.checks.start(designer, draftId, T0))).status).toBe(409);
  });

  it("последняя проверка видна в карточке черновика", async () => {
    expect((await s.content.draft(designer, draftId)).lastCheck).toBeNull();
    const started = await s.checks.start(designer, draftId, T0);
    const detail = await s.content.draft(designer, draftId);
    expect(detail.lastCheck).toMatchObject({ checkId: started.check.checkId, status: "queued" });
    expect(detail.snapshotHash).toBe(started.check.snapshotHash);
  });
});

// ---------------------------------------------------------------------------
// Версия 0 из выгрузки
// ---------------------------------------------------------------------------

describe("версия 0 из выгрузки content:export", () => {
  let dir = "";
  const files = buildExport(CONTENT_SNAPSHOT, { "enemy.swarm_rat.name": "Крыса" }).files;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "content-import-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (overrides: Record<string, string> = {}): void => {
    for (const [name, text] of Object.entries({ ...files, ...overrides })) writeFileSync(join(dir, name), text, "utf8");
  };

  it("имена файлов совпадают с теми, что пишет выгрузка", () => {
    expect(CONTENT_EXPORT_FILES).toEqual({ snapshot: SNAPSHOT_FILE, schema: SCHEMA_FILE, names: NAMES_FILE, hash: HASH_FILE });
  });

  it("выгрузка несёт хэш движка, и для умолчания он равен CONTENT_HASH", () => {
    expect(JSON.parse(files[HASH_FILE] ?? "{}")).toEqual({ hash: CONTENT_HASH });
  });

  it("читается и по каталогу, и по файлу снимка", () => {
    write();
    const byDir = readContentExport(dir);
    const byFile = readContentExport(join(dir, SNAPSHOT_FILE));
    expect(byDir).toEqual(byFile);
    const parsed = parseContentExport(byDir);
    expect(parsed.contentHash).toBe(CONTENT_HASH);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.names).toEqual({ "enemy.swarm_rat.name": "Крыса" });
  });

  it("не хватает файла — ошибка с его именем", () => {
    write();
    rmSync(join(dir, HASH_FILE));
    expect(() => readContentExport(dir)).toThrow(HASH_FILE);
    expect(() => readContentExport(join(dir, "nope"))).toThrow();
    mkdirSync(join(dir, "empty"));
    expect(() => readContentExport(join(dir, "empty"))).toThrow(SNAPSHOT_FILE);
  });

  it.each([
    ["битый JSON снимка", { [SNAPSHOT_FILE]: "{" }, SNAPSHOT_FILE],
    ["хэш не шестнадцатеричный", { [HASH_FILE]: '{"hash":"zz"}' }, "хэш"],
    ["имена не словарь строк", { [NAMES_FILE]: '{"a":1}' }, NAMES_FILE],
  ])("%s — отказ с названием файла", (_name, override, mention) => {
    write(override);
    expect(() => parseContentExport(readContentExport(dir))).toThrow(mention);
  });

  it("снимок не по своей схеме — отказ с путём поля", () => {
    const broken = clone(SNAPSHOT);
    broken.enemies[0]!.hp = "много" as unknown as number;
    write({ [SNAPSHOT_FILE]: JSON.stringify(broken) });
    expect(() => parseContentExport(readContentExport(dir))).toThrow(HP_PATH);
  });

  it("снимок больше 2 МБ — отказ", () => {
    const fat = clone(SNAPSHOT);
    (fat as Record<string, unknown>).pad = "я".repeat(CONTENT_SNAPSHOT_MAX_BYTES);
    write({ [SNAPSHOT_FILE]: JSON.stringify(fat) });
    expect(() => parseContentExport(readContentExport(dir))).toThrow("2 МБ");
  });

  it("первый импорт заводит версию repo, повторный того же хэша — ничего не меняет", async () => {
    write();
    const repo = new MemoryContentRepository();
    const parsed = parseContentExport(readContentExport(dir));
    const first = await importContentVersion(repo, parsed, T0);
    expect(first).toEqual({ created: true, versionNo: 1, contentHash: CONTENT_HASH });
    const again = await importContentVersion(repo, parseContentExport(readContentExport(dir)), new Date(T0.getTime() + 1_000));
    expect(again).toEqual({ created: false, versionNo: 1, contentHash: CONTENT_HASH });
    expect(repo.versionRows).toHaveLength(1);
    expect(repo.versionRows[0]).toMatchObject({ source: "repo", createdBy: null, publishedAt: null, schemaVersion: 1 });
    expect(repo.versionRows[0]?.snapshot).toEqual(SNAPSHOT);
  });

  it("другой хэш — новая версия, номера идут подряд", async () => {
    write();
    const repo = new MemoryContentRepository();
    await importContentVersion(repo, parseContentExport(readContentExport(dir)), T0);
    write({ [HASH_FILE]: '{"hash":"00000001"}' });
    const second = await importContentVersion(repo, parseContentExport(readContentExport(dir)), T0);
    expect(second).toMatchObject({ created: true, versionNo: 2 });
  });
});

describe("согласованность с sim-worker", () => {
  it("имя очереди, предел ждущих и размер снимка — те же, что в воркере (сервер его кода не импортирует)", () => {
    const source = readFileSync(new URL("../../../apps/sim-worker/src/limits.ts", import.meta.url), "utf8");
    expect(source).toContain(`CONTENT_CHECK_QUEUE = "${CONTENT_CHECK_QUEUE_NAME}"`);
    expect(source).toContain(`QUEUE_MAX_WAITING = ${String(CONTENT_CHECK_QUEUE_MAX_WAITING)}`);
    expect(source).toContain(`SNAPSHOT_MAX_BYTES = ${String(CONTENT_SNAPSHOT_MAX_BYTES / (1024 * 1024))} * 1024 * 1024`);
  });
});
