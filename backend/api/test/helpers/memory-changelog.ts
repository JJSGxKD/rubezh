import type { PublishedEntry } from "../../src/modules/changelog/changelog-rules.js";
import type { ChangelogEntryInput, ChangelogEntryRecord, ChangelogReleaseRecord, ChangelogRepository } from "../../src/modules/changelog/changelog.repository.js";
import type { PlatformId } from "../../src/platforms/ports/platform.js";

/**
 * Журнал обновлений в памяти — для тестов сервиса и раздачи. Смысл тот же,
 * что в базе: публикация трогает только черновики, курсор раздачи сдвигается
 * только своего поколения, отметка «открывал» только растёт.
 */
export class MemoryChangelogRepository implements ChangelogRepository {
  readonly entries = new Map<string, ChangelogEntryRecord>();
  readonly releaseRows = new Map<string, ChangelogReleaseRecord>();
  readonly seen = new Map<string, Date>();
  publishedReads = 0;

  async published(): Promise<PublishedEntry[]> {
    this.publishedReads++;
    return [...this.entries.values()].flatMap((entry) => (entry.publishedAt === null ? [] : [{ ...entry, publishedAt: entry.publishedAt }]));
  }

  async all(): Promise<ChangelogEntryRecord[]> {
    return [...this.entries.values()];
  }

  async byId(entryId: string): Promise<ChangelogEntryRecord | null> {
    return this.entries.get(entryId) ?? null;
  }

  async create(entryId: string, input: ChangelogEntryInput, by: string, at: Date): Promise<ChangelogEntryRecord> {
    const record: ChangelogEntryRecord = { entryId, ...input, platforms: [...input.platforms], publishedAt: null, createdAt: at, updatedAt: at, updatedBy: by };
    this.entries.set(entryId, record);
    return record;
  }

  async update(entryId: string, input: ChangelogEntryInput, by: string, at: Date): Promise<ChangelogEntryRecord | null> {
    const before = this.entries.get(entryId);
    if (before === undefined) return null;
    const record: ChangelogEntryRecord = { ...before, ...input, platforms: [...input.platforms], updatedAt: at, updatedBy: by };
    this.entries.set(entryId, record);
    return record;
  }

  async remove(entryId: string): Promise<boolean> {
    return this.entries.delete(entryId);
  }

  async publish(version: string, at: Date): Promise<number> {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.version !== version || entry.publishedAt !== null) continue;
      entry.publishedAt = at;
      count++;
    }
    return count;
  }

  async startRelease(version: string, platforms: readonly PlatformId[], at: Date): Promise<void> {
    this.releaseRows.set(version, { version, platforms: [...platforms], publishedAt: at, cursor: null, doneAt: null });
  }

  async releases(): Promise<ChangelogReleaseRecord[]> {
    return [...this.releaseRows.values()].map((release) => ({ ...release }));
  }

  async pendingReleases(): Promise<ChangelogReleaseRecord[]> {
    return (await this.releases()).filter((release) => release.doneAt === null).sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
  }

  async advanceRelease(version: string, generation: Date, cursor: string | null, doneAt: Date | null): Promise<boolean> {
    const release = this.releaseRows.get(version);
    if (release === undefined || release.publishedAt.getTime() !== generation.getTime() || release.doneAt !== null) return false;
    this.releaseRows.set(version, { ...release, cursor, doneAt });
    return true;
  }

  async seenAt(accountId: string): Promise<Date | null> {
    return this.seen.get(accountId) ?? null;
  }

  async markSeen(accountId: string, at: Date): Promise<void> {
    const current = this.seen.get(accountId);
    if (current === undefined || at > current) this.seen.set(accountId, at);
  }
}
