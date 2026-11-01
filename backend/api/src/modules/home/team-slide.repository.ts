import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";
import { TEAM_SLIDE_AUDIENCES, TEAM_SLIDE_ICONS, TEAM_SLIDE_SCREENS, type TeamSlideGroup, type TeamSlideInput, type TeamSlideRow, type TeamSlideTarget } from "./team-slide-rules.js";

/**
 * Слайды команды в базе (`home_slide`). Их — десятки за жизнь игры, поэтому
 * идущие читаются целиком и держатся в памяти сервиса, а не спрашиваются на
 * каждого игрока. Здесь же — что главная знает об игроке для аудитории.
 */

export const TEAM_SLIDE_REPOSITORY = Symbol("TEAM_SLIDE_REPOSITORY");

/** Слайд в журнале порядка — название, а не UUID: журнал читает человек. */
export interface TeamSlideOrderEntry {
  slideId: string;
  title: string;
}

export type TeamSlideReorderResult = { status: "mismatch" } | { status: "ok"; before: TeamSlideOrderEntry[]; after: TeamSlideOrderEntry[]; changed: boolean };

export interface TeamSlideRepository {
  /** не снятые слайды, которые идут в `at` или начнутся до `until`, в порядке показа */
  current(at: Date, until: Date): Promise<TeamSlideRow[]>;
  /** все слайды для панели: сначала не снятые в порядке показа, снятые — в конце */
  list(limit: number): Promise<TeamSlideRow[]>;
  byId(slideId: string): Promise<TeamSlideRow | null>;
  create(slideId: string, input: TeamSlideInput, position: number, by: string, at: Date): Promise<TeamSlideRow>;
  /** `null` — слайда нет или он снят: снятый не правится; `position` `null` — место не меняется */
  update(slideId: string, input: TeamSlideInput, position: number | null, by: string, at: Date): Promise<TeamSlideRow | null>;
  /** `null` — слайда нет или он уже снят */
  archive(slideId: string, by: string, at: Date): Promise<TeamSlideRow | null>;
  /** место в конце группы: наибольшее среди не снятых плюс один, пустая группа — 0 */
  nextPosition(pinned: boolean): Promise<number>;
  /**
   * Новый порядок группы одной транзакцией под блокировкой: `ids` — ровно не
   * снятые слайды группы. Состав не совпал — `mismatch`, ничего не пишется.
   */
  reorder(group: TeamSlideGroup, ids: readonly string[], actorAccountId: string, at: Date): Promise<TeamSlideReorderResult>;
  /** когда зарегистрирован и платил ли — для аудитории; `null` — аккаунта нет */
  audienceFacts(accountId: string): Promise<{ createdAt: Date; payer: boolean } | null>;
}

/** Строка блокировки при перестановке: только то, что нужно для порядка. */
const orderRowSchema = z.object({ slide_id: z.string(), title: z.string(), position: z.number().int() });

/** Порядок показа: закреплённые, место, позже начатый, id. */
const DISPLAY_ORDER = [{ pinned: "desc" as const }, { position: "asc" as const }, { startsAt: "desc" as const }, { slideId: "asc" as const }];

/** Строка базы — схемой, а не приведением: панель или миграция могли записать то, чего код не ждёт. */
const rowSchema = z.object({
  slideId: z.string(),
  title: z.string(),
  text: z.string(),
  imageId: z.string().nullable(),
  icon: z.enum(TEAM_SLIDE_ICONS),
  targetKind: z.enum(["screen", "link"]),
  targetScreen: z.enum(TEAM_SLIDE_SCREENS).nullable(),
  targetUrl: z.string().nullable(),
  platforms: z.array(z.enum(PLATFORM_IDS)),
  audience: z.enum(TEAM_SLIDE_AUDIENCES),
  pinned: z.boolean(),
  position: z.number().int().min(0),
  startsAt: z.date(),
  endsAt: z.date(),
  createdAt: z.date(),
  createdBy: z.string(),
  updatedAt: z.date(),
  updatedBy: z.string(),
  archivedAt: z.date().nullable(),
  archivedBy: z.string().nullable(),
});

function toRow(raw: unknown): TeamSlideRow {
  const { targetKind, targetScreen, targetUrl, ...row } = rowSchema.parse(raw);
  let target: TeamSlideTarget;
  if (targetKind === "screen" && targetScreen !== null) target = { kind: "screen", screen: targetScreen };
  else if (targetKind === "link" && targetUrl !== null) target = { kind: "link", url: targetUrl };
  else throw new Error(`слайд ${row.slideId}: цель без экрана или ссылки`);
  return { ...row, target };
}

function fields(input: TeamSlideInput) {
  return {
    title: input.title,
    text: input.text,
    imageId: input.imageId,
    icon: input.icon,
    targetKind: input.target.kind,
    targetScreen: input.target.kind === "screen" ? input.target.screen : null,
    targetUrl: input.target.kind === "link" ? input.target.url : null,
    platforms: input.platforms,
    audience: input.audience,
    pinned: input.pinned,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
  };
}

@Injectable()
export class PrismaTeamSlideRepository implements TeamSlideRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async current(at: Date, until: Date): Promise<TeamSlideRow[]> {
    const rows = await this.prisma.homeSlide.findMany({ where: { archivedAt: null, endsAt: { gt: at }, startsAt: { lt: until } }, orderBy: DISPLAY_ORDER });
    return rows.map(toRow);
  }

  async list(limit: number): Promise<TeamSlideRow[]> {
    const rows = await this.prisma.homeSlide.findMany({ orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, ...DISPLAY_ORDER], take: limit });
    return rows.map(toRow);
  }

  async byId(slideId: string): Promise<TeamSlideRow | null> {
    const row = await this.prisma.homeSlide.findUnique({ where: { slideId } });
    return row === null ? null : toRow(row);
  }

  async create(slideId: string, input: TeamSlideInput, position: number, by: string, at: Date): Promise<TeamSlideRow> {
    return toRow(await this.prisma.homeSlide.create({ data: { slideId, ...fields(input), position, createdAt: at, createdBy: by, updatedAt: at, updatedBy: by } }));
  }

  async update(slideId: string, input: TeamSlideInput, position: number | null, by: string, at: Date): Promise<TeamSlideRow | null> {
    const { count } = await this.prisma.homeSlide.updateMany({
      where: { slideId, archivedAt: null },
      data: { ...fields(input), ...(position === null ? {} : { position }), updatedAt: at, updatedBy: by },
    });
    return count === 0 ? null : await this.byId(slideId);
  }

  async archive(slideId: string, by: string, at: Date): Promise<TeamSlideRow | null> {
    const { count } = await this.prisma.homeSlide.updateMany({ where: { slideId, archivedAt: null }, data: { archivedAt: at, archivedBy: by } });
    return count === 0 ? null : await this.byId(slideId);
  }

  async nextPosition(pinned: boolean): Promise<number> {
    const { _max } = await this.prisma.homeSlide.aggregate({ where: { pinned, archivedAt: null }, _max: { position: true } });
    return _max.position === null ? 0 : _max.position + 1;
  }

  async reorder(group: TeamSlideGroup, ids: readonly string[], actorAccountId: string, at: Date): Promise<TeamSlideReorderResult> {
    return await this.prisma.$transaction(async (tx) => {
      // Группа — под блокировкой: второй запрос на тот же список ждёт здесь и
      // читает уже новый порядок. Снятые в порядок не входят.
      const rows = await tx.$queryRaw<unknown[]>`
        SELECT slide_id::text, title, position FROM home_slide
        WHERE archived_at IS NULL AND pinned = ${group === "pinned"}
        ORDER BY position, starts_at DESC, slide_id FOR UPDATE`;
      const members = rows.map((raw) => orderRowSchema.parse(raw));
      const known = new Set(members.map((row) => row.slide_id));
      if (ids.length !== members.length || new Set(ids).size !== ids.length || !ids.every((id) => known.has(id))) return { status: "mismatch" };

      const before = members.map((row) => ({ slideId: row.slide_id, title: row.title }));
      const titles = new Map(members.map((row) => [row.slide_id, row.title]));
      const after = ids.map((id) => ({ slideId: id, title: titles.get(id) ?? "" }));
      const changed = ids.some((id, index) => before[index]?.slideId !== id);

      // Пишутся только сдвинувшиеся места. Равные места (после миграции или двух
      // параллельных заведений) выравниваются и без смены порядка — в аудит такое не идёт.
      const current = new Map(members.map((row) => [row.slide_id, row.position]));
      const moving = ids.flatMap((id, index) => (current.get(id) === index ? [] : [{ id, position: index }]));
      if (moving.length > 0) {
        await tx.$executeRaw`
          UPDATE home_slide SET position = u.position, updated_at = ${at}, updated_by = ${actorAccountId}::uuid
          FROM unnest(${moving.map((row) => row.id)}::uuid[], ${moving.map((row) => row.position)}::int[]) AS u(slide_id, position)
          WHERE home_slide.slide_id = u.slide_id`;
      }
      return { status: "ok", before, after, changed };
    });
  }

  async audienceFacts(accountId: string): Promise<{ createdAt: Date; payer: boolean } | null> {
    const account = await this.prisma.account.findUnique({ where: { accountId }, select: { createdAt: true, funnel: { select: { firstPurchaseAt: true } } } });
    return account === null ? null : { createdAt: account.createdAt, payer: account.funnel?.firstPurchaseAt != null };
  }
}
