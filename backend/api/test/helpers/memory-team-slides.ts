import { teamSlideGroup, type TeamSlideGroup, type TeamSlideInput, type TeamSlideRow } from "../../src/modules/home/team-slide-rules.js";
import type { TeamSlideReorderResult, TeamSlideRepository } from "../../src/modules/home/team-slide.repository.js";

/** Порядок базы: закреплённые, место, позже начатые, id. */
function byOrder(a: TeamSlideRow, b: TeamSlideRow): number {
  return Number(b.pinned) - Number(a.pinned) || a.position - b.position || b.startsAt.getTime() - a.startsAt.getTime() || a.slideId.localeCompare(b.slideId);
}

/** Слайды команды в памяти — с той же выборкой идущих и тем же порядком, что и база. */
export class MemoryTeamSlideRepository implements TeamSlideRepository {
  readonly rows: TeamSlideRow[] = [];
  /** что знает «база» об аккаунтах — для аудитории */
  readonly facts = new Map<string, { createdAt: Date; payer: boolean }>();
  /** сколько раз сервис ходил за идущими слайдами — так видно кэш */
  currentCalls = 0;

  async current(at: Date, until: Date): Promise<TeamSlideRow[]> {
    this.currentCalls++;
    return this.rows
      .filter((row) => row.archivedAt === null && row.endsAt > at && row.startsAt < until)
      .sort(byOrder)
      .map((row) => ({ ...row }));
  }

  /** Снятые — в конце, как в базе. */
  async list(limit: number): Promise<TeamSlideRow[]> {
    const live = this.rows.filter((row) => row.archivedAt === null).sort(byOrder);
    const archived = this.rows.filter((row) => row.archivedAt !== null).sort(byOrder);
    return [...live, ...archived].slice(0, limit).map((row) => ({ ...row }));
  }

  async byId(slideId: string): Promise<TeamSlideRow | null> {
    const row = this.rows.find((candidate) => candidate.slideId === slideId);
    return row === undefined ? null : { ...row };
  }

  async create(slideId: string, input: TeamSlideInput, position: number, by: string, at: Date): Promise<TeamSlideRow> {
    const row: TeamSlideRow = { slideId, ...input, position, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by, archivedAt: null, archivedBy: null };
    this.rows.push(row);
    return { ...row };
  }

  async update(slideId: string, input: TeamSlideInput, position: number | null, by: string, at: Date): Promise<TeamSlideRow | null> {
    const row = this.rows.find((candidate) => candidate.slideId === slideId && candidate.archivedAt === null);
    if (row === undefined) return null;
    Object.assign(row, input, { updatedAt: at, updatedBy: by });
    if (position !== null) row.position = position;
    return { ...row };
  }

  async archive(slideId: string, by: string, at: Date): Promise<TeamSlideRow | null> {
    const row = this.rows.find((candidate) => candidate.slideId === slideId && candidate.archivedAt === null);
    if (row === undefined) return null;
    row.archivedAt = at;
    row.archivedBy = by;
    return { ...row };
  }

  async nextPosition(pinned: boolean): Promise<number> {
    const places = this.rows.filter((row) => row.archivedAt === null && row.pinned === pinned).map((row) => row.position);
    return places.length === 0 ? 0 : Math.max(...places) + 1;
  }

  async reorder(group: TeamSlideGroup, ids: readonly string[], actorAccountId: string, at: Date): Promise<TeamSlideReorderResult> {
    const members = this.rows.filter((row) => row.archivedAt === null && teamSlideGroup(row) === group).sort(byOrder);
    const before = members.map((row) => ({ slideId: row.slideId, title: row.title }));
    const known = new Set(members.map((row) => row.slideId));
    if (ids.length !== members.length || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) return { status: "mismatch" };
    const after = ids.map((id) => ({ slideId: id, title: members.find((row) => row.slideId === id)?.title ?? "" }));
    // Равные места (после миграции или двух параллельных созданий) выравниваются, но порядок от этого не меняется — в аудит такое не идёт.
    ids.forEach((id, index) => {
      const row = members.find((candidate) => candidate.slideId === id);
      if (row === undefined || row.position === index) return;
      row.position = index;
      row.updatedAt = at;
      row.updatedBy = actorAccountId;
    });
    return { status: "ok", before, after, changed: ids.some((id, index) => before[index]?.slideId !== id) };
  }

  async audienceFacts(accountId: string): Promise<{ createdAt: Date; payer: boolean } | null> {
    return this.facts.get(accountId) ?? null;
  }
}
