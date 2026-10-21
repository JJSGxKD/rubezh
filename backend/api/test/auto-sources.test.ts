import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutoSourcesService } from "../src/modules/links/auto-sources.service.js";
import { UNKNOWN_KEYS_MAX, type AutoSourceInput, type AutoSourceOutcome, type AutoSourcesRepository } from "../src/modules/links/auto-sources.repository.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Автоисточники по ссылкам с метками (Р116, docs/24-attribution-and-sharing.md §3.6).
 * Подмена репозитория повторяет его правила — уже заведённый ключ, потолок за скользящие сутки,
 * потолок числа незнакомых ключей, — чтобы проверить сервис: что он разбирает, что и с какими
 * числами просит у репозитория и что пишет в лог. Сами правила на настоящем SQL и под гонкой
 * сессий — в `auto-sources.integration.test.ts`.
 */

const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 9, 20, 12, 0, 0));

interface SourceRow {
  autoKey: string;
  source: string | null;
  campaign: string;
  medium: string | null;
  partnerTag: string | null;
  platform: string;
  createdAt: Date;
  hiddenAt: Date | null;
}

interface KeyRow {
  hits: number;
  firstAt: Date;
  lastAt: Date;
}

class MemoryAutoSources implements AutoSourcesRepository {
  readonly sources = new Map<string, SourceRow>();
  readonly keys = new Map<string, KeyRow>();
  readonly ensured: AutoSourceInput[] = [];
  failing = false;

  async ensure(input: AutoSourceInput): Promise<AutoSourceOutcome> {
    this.ensured.push(input);
    if (this.failing) throw new Error("база недоступна");
    // Нуль — выключатель: базы такая сессия не касается. Скрытый источник — такой же заведённый.
    if (input.cap <= 0) return "capped";
    if (this.sources.has(input.autoKey)) return "existing";
    const since = input.now.getTime() - DAY;
    const recent = [...this.sources.values()].filter((row) => row.createdAt.getTime() > since).length;
    if (recent >= input.cap) return "capped";
    this.sources.set(input.autoKey, {
      autoKey: input.autoKey,
      source: input.source,
      campaign: input.campaign,
      medium: input.medium,
      partnerTag: input.partnerTag,
      platform: input.platform,
      createdAt: input.now,
      hiddenAt: null,
    });
    return "created";
  }

  async noteUnknownKeys(keys: string[], now: Date): Promise<void> {
    for (const key of keys) {
      const row = this.keys.get(key);
      if (row !== undefined) {
        row.hits += 1;
        row.lastAt = now;
      } else if (this.keys.size < UNKNOWN_KEYS_MAX) {
        this.keys.set(key, { hits: 1, firstAt: now, lastAt: now });
      }
    }
  }
}

let repository: MemoryAutoSources;
const settings = panelSettings();
let service: AutoSourcesService;

function session(startParam: string | null, patch: { platform?: "telegram" | "max" | "vk" | "web"; at?: Date } = {}) {
  return { startParam, platform: patch.platform ?? "telegram", startedAt: (patch.at ?? NOW).toISOString() };
}

beforeEach(() => {
  // Строки исхода — предмет одного теста; остальным они только шумят в отчёте.
  vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
  repository = new MemoryAutoSources();
  settings.set("links.auto-daily-cap", 20);
  service = new AutoSourcesService(repository, settings);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("автоисточник по первой сессии", () => {
  it("четыре ключа ложатся в поля источника, он помечен автоматическим и привязан к набору пар", async () => {
    await expect(service.onSession(session("src-tgads_cmp-oct_plc-post_prt-ivan"))).resolves.toBe("created");

    expect([...repository.sources.values()]).toEqual([
      { autoKey: "src-tgads_cmp-oct_plc-post_prt-ivan", source: "tgads", campaign: "oct", medium: "post", partnerTag: "ivan", platform: "telegram", createdAt: NOW, hiddenAt: null },
    ]);
    expect(repository.ensured[0]).toMatchObject({ autoKey: "src-tgads_cmp-oct_plc-post_prt-ivan", cap: 20, now: NOW });
  });

  it("без cmp кампания — «auto»; остальные незаданные поля пусты", async () => {
    await service.onSession(session("src-tgads"));
    await service.onSession(session("plc-post"));

    expect(repository.sources.get("src-tgads")).toMatchObject({ source: "tgads", campaign: "auto", medium: null, partnerTag: null });
    expect(repository.sources.get("plc-post")).toMatchObject({ source: null, campaign: "auto", medium: "post" });
  });

  it("тот же набор в другом порядке и регистре — тот же источник, строка одна", async () => {
    await expect(service.onSession(session("src-tgads_cmp-oct"))).resolves.toBe("created");
    await expect(service.onSession(session("CMP-Oct_SRC-TGads"))).resolves.toBe("existing");
    await expect(service.onSession(session("cmp-oct_src-tgads"))).resolves.toBe("existing");

    expect(repository.sources.size).toBe(1);
  });

  it("другой набор — другой источник: src-a_cmp-b и src-a_cmp-c", async () => {
    await service.onSession(session("src-a_cmp-b"));
    await service.onSession(session("src-a_cmp-c"));

    expect([...repository.sources.keys()].sort()).toEqual(["src-a_cmp-b", "src-a_cmp-c"]);
  });

  it("незнакомые ключи в наборе источник не меняют: он привязан к известным парам", async () => {
    await service.onSession(session("src-a_cmp-b"));
    await expect(service.onSession(session("src-a_cmp-b_zzz-1"))).resolves.toBe("existing");

    expect(repository.sources.size).toBe(1);
  });

  it("платформа источника — платформа сессии; неизвестная читается как Telegram", async () => {
    await service.onSession(session("src-a_cmp-vk", { platform: "vk" }));
    await service.onSession(session("src-a_cmp-max", { platform: "max" }));
    await service.onSession({ startParam: "src-a_cmp-new", platform: "icq" as never, startedAt: NOW.toISOString() });

    expect(repository.sources.get("src-a_cmp-vk")?.platform).toBe("vk");
    expect(repository.sources.get("src-a_cmp-max")?.platform).toBe("max");
    expect(repository.sources.get("src-a_cmp-new")?.platform).toBe("telegram");
  });

  it("сессии других видов источников и счётчиков не касаются", async () => {
    for (const startParam of [null, "", "c-AbCdEf123456", "l-AbCdEf1234", "f-AbCdEf1234", "n-friend_request", "invite", "_tgr_123", "src-a_src-b", "panel-x1", "c-<script>"]) {
      await expect(service.onSession(session(startParam)), String(startParam)).resolves.toBeNull();
    }

    expect(repository.ensured).toEqual([]);
    expect(repository.sources.size).toBe(0);
    expect(repository.keys.size).toBe(0);
  });
});

describe("потолок новых автоисточников", () => {
  it("потолок 2: третий разный ключ — «capped», строки нет", async () => {
    settings.set("links.auto-daily-cap", 2);

    await expect(service.onSession(session("src-a"))).resolves.toBe("created");
    await expect(service.onSession(session("src-b"))).resolves.toBe("created");
    await expect(service.onSession(session("src-c"))).resolves.toBe("capped");

    expect([...repository.sources.keys()]).toEqual(["src-a", "src-b"]);
    expect(repository.ensured.at(-1)?.cap).toBe(2);
  });

  it("уже заведённый ключ при полном потолке — «existing», а не «capped»", async () => {
    settings.set("links.auto-daily-cap", 1);
    await service.onSession(session("src-a"));

    await expect(service.onSession(session("src-a"))).resolves.toBe("existing");
    await expect(service.onSession(session("src-b"))).resolves.toBe("capped");
  });

  it("потолок 0 — автосоздание выключено: «capped» для первого же", async () => {
    settings.set("links.auto-daily-cap", 0);

    await expect(service.onSession(session("src-a"))).resolves.toBe("capped");

    expect(repository.sources.size).toBe(0);
  });

  it("потолок считается за скользящие сутки: источник старше суток место не занимает", async () => {
    settings.set("links.auto-daily-cap", 1);
    await service.onSession(session("src-a", { at: new Date(NOW.getTime() - 25 * 3_600_000) }));

    await expect(service.onSession(session("src-b"))).resolves.toBe("created");
    await expect(service.onSession(session("src-c"))).resolves.toBe("capped");
  });

  it("источник моложе суток место занимает", async () => {
    settings.set("links.auto-daily-cap", 1);
    await service.onSession(session("src-a", { at: new Date(NOW.getTime() - 23 * 3_600_000) }));

    await expect(service.onSession(session("src-b"))).resolves.toBe("capped");
  });

  it("потолок читается из настроек на каждой сессии: правка в панели действует сразу", async () => {
    settings.set("links.auto-daily-cap", 0);
    await service.onSession(session("src-a"));
    settings.set("links.auto-daily-cap", 5);

    await expect(service.onSession(session("src-a"))).resolves.toBe("created");
  });

  it("ключ каталога: 0–500, умолчание 20", () => {
    expect(SETTINGS.linksAutoDailyCap.key).toBe("links.auto-daily-cap");
    expect(SETTINGS.linksAutoDailyCap.fallback).toBe(20);
    expect(SETTINGS.linksAutoDailyCap.range).toMatchObject({ min: 0, max: 500 });
    expect(SETTINGS.linksAutoDailyCap.schema.safeParse(0).success).toBe(true);
    expect(SETTINGS.linksAutoDailyCap.schema.safeParse(500).success).toBe(true);
    expect(SETTINGS.linksAutoDailyCap.schema.safeParse(501).success).toBe(false);
    expect(SETTINGS.linksAutoDailyCap.schema.safeParse(-1).success).toBe(false);
    expect(SETTINGS.linksAutoDailyCap.schema.safeParse(2.5).success).toBe(false);
  });
});

describe("скрытый источник", () => {
  it("повторный запуск не создаёт нового и не снимает скрытие", async () => {
    await service.onSession(session("src-a_cmp-b"));
    const hiddenAt = new Date(NOW.getTime() + 1_000);
    const row = repository.sources.get("src-a_cmp-b");
    if (row === undefined) throw new Error("источник не заведён");
    row.hiddenAt = hiddenAt;

    await expect(service.onSession(session("CMP-b_src-a"))).resolves.toBe("existing");

    expect(repository.sources.size).toBe(1);
    expect(repository.sources.get("src-a_cmp-b")?.hiddenAt).toEqual(hiddenAt);
  });

  it("скрытый источник место под потолком занимает так же, как видимый", async () => {
    settings.set("links.auto-daily-cap", 1);
    await service.onSession(session("src-a"));
    const row = repository.sources.get("src-a");
    if (row === undefined) throw new Error("источник не заведён");
    row.hiddenAt = NOW;

    await expect(service.onSession(session("src-b"))).resolves.toBe("capped");
  });
});

describe("сводка незнакомых ключей", () => {
  it("счётчик растёт, последний раз обновляется, первый остаётся", async () => {
    const later = new Date(NOW.getTime() + 3_600_000);
    await service.onSession(session("cmp-a_zzz-1"));
    await service.onSession(session("cmp-a_zzz-2_yyy-3", { at: later }));

    expect(repository.keys.get("zzz")).toEqual({ hits: 2, firstAt: NOW, lastAt: later });
    expect(repository.keys.get("yyy")).toEqual({ hits: 1, firstAt: later, lastAt: later });
  });

  it("только незнакомые ключи: источника нет, сводка пополняется", async () => {
    await expect(service.onSession(session("zzz-1_yyy-2"))).resolves.toBeNull();

    expect(repository.sources.size).toBe(0);
    expect([...repository.keys.keys()].sort()).toEqual(["yyy", "zzz"]);
  });

  it("значения в сводку не попадают: только ключи", async () => {
    await service.onSession(session("cmp-a_zzz-secret123"));

    expect(JSON.stringify([...repository.keys.entries()])).not.toContain("secret123");
  });

  it("201-й ключ не добавляется, а уже известный и в полной сводке считается", async () => {
    for (let index = 0; index < UNKNOWN_KEYS_MAX; index++) await service.onSession(session(`k${String(index).padStart(3, "0")}-1`));
    expect(repository.keys.size).toBe(200);

    await service.onSession(session("overflow-1"));
    await service.onSession(session("k000-9"));

    expect(repository.keys.has("overflow")).toBe(false);
    expect(repository.keys.size).toBe(200);
    expect(repository.keys.get("k000")?.hits).toBe(2);
  });

  it("потолок сводки — 200", () => {
    expect(UNKNOWN_KEYS_MAX).toBe(200);
  });
});

describe("лог исхода", () => {
  it("«created» — уровнем log, «existing» и «capped» — debug; значения пар в лог не пишутся", async () => {
    const log = vi.mocked(Logger.prototype.log);
    const debug = vi.mocked(Logger.prototype.debug);
    settings.set("links.auto-daily-cap", 1);

    await service.onSession(session("src-tgads_cmp-oct"));
    await service.onSession(session("src-tgads_cmp-oct"));
    await service.onSession(session("src-other_cmp-secretvalue"));

    expect(log).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({ module: "links", event: "auto_source", result: "created" });
    expect(debug.mock.calls.map((call) => JSON.parse(String(call[0])).result)).toEqual(["existing", "capped"]);
    const written = JSON.stringify([...log.mock.calls, ...debug.mock.calls]);
    for (const value of ["tgads", "oct", "secretvalue"]) expect(written).not.toContain(value);
  });
});
