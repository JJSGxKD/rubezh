import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { entryProblem, fetchChangelog, groupByVersion, publishAudience, publishVersion, releaseState, removeEntry, saveEntry, type ChangelogEntry, type EntryInput } from "../src/api/changelog";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

// Журнал обновлений в панели (docs/35-stage4-plan.md WP31): строки по
// версиям с метками площадок, форма проверяет то же, что сервер, публикация —
// отдельным запросом.

function entry(patch: Partial<ChangelogEntry> = {}): ChangelogEntry {
  return {
    entryId: "0b8f0b3e-4c7a-4d1e-9f7a-000000000001",
    version: "0.6.0",
    platforms: [],
    kind: "added",
    text: "Журнал обновлений",
    publishedAt: null,
    createdAt: "2026-09-30T10:00:00.000Z",
    updatedAt: "2026-09-30T10:00:00.000Z",
    updatedBy: null,
    ...patch,
  };
}

const INPUT: EntryInput = { version: "0.6.0", kind: "added", platforms: ["telegram"], text: "Журнал обновлений" };

describe("журнал обновлений в панели", () => {
  it("список, сохранение с обрезкой, удаление и публикация — по своим адресам", async () => {
    const release = { version: "0.6.0", platforms: ["telegram"], publishedAt: "2026-09-30T11:00:00.000Z", cursor: null, doneAt: null };
    const { fetch, calls } = fakeFetch(
      json(200, { data: { entries: [entry()], releases: [release] } }),
      json(200, { data: entry() }),
      json(200, { data: { removed: true } }),
      json(200, { data: { published: 2, release } }),
    );
    const api = new AdminApi(fetch);

    const list = await fetchChangelog(api);
    expect(list.ok && list.data.releases[0]?.platforms).toEqual(["telegram"]);

    await saveEntry(api, { ...INPUT, version: " 0.6.0 ", text: "  Журнал  " });
    expect(calls[1]?.url).toBe("/api/v1/admin/changelog");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ version: "0.6.0", kind: "added", platforms: ["telegram"], text: "Журнал" });

    await removeEntry(api, "abc");
    expect(calls[2]?.url).toBe("/api/v1/admin/changelog/abc/remove");

    const published = await publishVersion(api, "0.6.0");
    expect(published.ok && published.data.published).toBe(2);
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ version: "0.6.0" });
    expect(SECTIONS.find((section) => section.id === "changelog")?.permission).toBe("changelog.edit");
  });

  it("форма проверяет то же, что сервер; у опубликованной — только текст и вид", () => {
    expect(entryProblem(INPUT)).toBeNull();
    for (const version of ["0.6", "0.06.0", "0.6.0-rc.1", "v0.6.0"]) expect(entryProblem({ ...INPUT, version }), version).not.toBeNull();
    expect(entryProblem({ ...INPUT, text: "   " })).not.toBeNull();
    expect(entryProblem({ ...INPUT, text: "x".repeat(501) })).not.toBeNull();

    const published = entry({ platforms: ["telegram"], publishedAt: "2026-09-30T11:00:00.000Z" });
    expect(entryProblem({ ...INPUT, kind: "fixed", text: "Правка" }, published)).toBeNull();
    expect(entryProblem({ ...INPUT, version: "0.6.1" }, published)).not.toBeNull();
    expect(entryProblem({ ...INPUT, platforms: ["telegram", "vk"] }, published)).not.toBeNull();
    expect(entryProblem({ ...INPUT, version: "0.6.1" }, entry())).toBeNull();
  });

  it("версии — новыми сверху по числам, черновики посчитаны, кому уйдёт уведомление", () => {
    const groups = groupByVersion(
      [entry({ version: "0.9.0" }), entry({ version: "0.10.0", publishedAt: "2026-09-30T11:00:00.000Z" }), entry({ version: "0.10.0" })],
      [{ version: "0.10.0", platforms: ["telegram"], publishedAt: "2026-09-30T11:00:00.000Z", cursor: null, doneAt: "2026-09-30T11:01:00.000Z" }],
    );
    expect(groups.map((group) => [group.version, group.entries.length, group.drafts])).toEqual([
      ["0.10.0", 2, 1],
      ["0.9.0", 1, 1],
    ]);
    expect(releaseState(groups[0]?.release ?? null)).toBe("уведомление разослано");
    expect(releaseState(null)).toBe("не публиковалась");

    expect(publishAudience([{ platforms: ["vk"] }, { platforms: ["telegram"] }])).toBe("telegram, vk");
    expect(publishAudience([{ platforms: ["vk"] }, { platforms: [] }])).toBe("все площадки");
  });
});
