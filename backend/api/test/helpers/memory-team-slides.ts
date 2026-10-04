import type { TeamSlideInput, TeamSlideRow } from "../../src/modules/home/team-slide-rules.js";
import type { TeamSlideRepository } from "../../src/modules/home/team-slide.repository.js";

/** Слайды команды в памяти — с той же выборкой идущих, что и база. */
export class MemoryTeamSlideRepository implements TeamSlideRepository {
  readonly rows: TeamSlideRow[] = [];
  /** что знает «база» об аккаунтах — для аудитории */
  readonly facts = new Map<string, { createdAt: Date; payer: boolean }>();
  /** сколько раз сервис ходил за идущими слайдами — так видно кэш */
  currentCalls = 0;

  async current(at: Date, until: Date): Promise<TeamSlideRow[]> {
    this.currentCalls++;
    return this.rows.filter((row) => row.archivedAt === null && row.endsAt > at && row.startsAt < until).map((row) => ({ ...row }));
  }

  async list(limit: number): Promise<TeamSlideRow[]> {
    return [...this.rows].sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime()).slice(0, limit);
  }

  async byId(slideId: string): Promise<TeamSlideRow | null> {
    const row = this.rows.find((candidate) => candidate.slideId === slideId);
    return row === undefined ? null : { ...row };
  }

  async create(slideId: string, input: TeamSlideInput, by: string, at: Date): Promise<TeamSlideRow> {
    const row: TeamSlideRow = { slideId, ...input, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by, archivedAt: null, archivedBy: null };
    this.rows.push(row);
    return { ...row };
  }

  async update(slideId: string, input: TeamSlideInput, by: string, at: Date): Promise<TeamSlideRow | null> {
    const row = this.rows.find((candidate) => candidate.slideId === slideId && candidate.archivedAt === null);
    if (row === undefined) return null;
    Object.assign(row, input, { updatedAt: at, updatedBy: by });
    return { ...row };
  }

  async archive(slideId: string, by: string, at: Date): Promise<TeamSlideRow | null> {
    const row = this.rows.find((candidate) => candidate.slideId === slideId && candidate.archivedAt === null);
    if (row === undefined) return null;
    row.archivedAt = at;
    row.archivedBy = by;
    return { ...row };
  }

  async audienceFacts(accountId: string): Promise<{ createdAt: Date; payer: boolean } | null> {
    return this.facts.get(accountId) ?? null;
  }
}
