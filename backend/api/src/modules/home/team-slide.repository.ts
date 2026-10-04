import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";
import { TEAM_SLIDE_AUDIENCES, TEAM_SLIDE_ICONS, TEAM_SLIDE_SCREENS, type TeamSlideInput, type TeamSlideRow, type TeamSlideTarget } from "./team-slide-rules.js";

/**
 * Слайды команды в базе (`home_slide`). Их — десятки за жизнь игры, поэтому
 * идущие читаются целиком и держатся в памяти сервиса, а не спрашиваются на
 * каждого игрока. Здесь же — что главная знает об игроке для аудитории.
 */

export const TEAM_SLIDE_REPOSITORY = Symbol("TEAM_SLIDE_REPOSITORY");

export interface TeamSlideRepository {
  /** не снятые слайды, которые идут в `at` или начнутся до `until` */
  current(at: Date, until: Date): Promise<TeamSlideRow[]>;
  /** все слайды для панели, поздние первыми */
  list(limit: number): Promise<TeamSlideRow[]>;
  byId(slideId: string): Promise<TeamSlideRow | null>;
  create(slideId: string, input: TeamSlideInput, by: string, at: Date): Promise<TeamSlideRow>;
  /** `null` — слайда нет или он снят: снятый не правится */
  update(slideId: string, input: TeamSlideInput, by: string, at: Date): Promise<TeamSlideRow | null>;
  /** `null` — слайда нет или он уже снят */
  archive(slideId: string, by: string, at: Date): Promise<TeamSlideRow | null>;
  /** когда зарегистрирован и платил ли — для аудитории; `null` — аккаунта нет */
  audienceFacts(accountId: string): Promise<{ createdAt: Date; payer: boolean } | null>;
}

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
    const rows = await this.prisma.homeSlide.findMany({ where: { archivedAt: null, endsAt: { gt: at }, startsAt: { lt: until } }, orderBy: { startsAt: "desc" } });
    return rows.map(toRow);
  }

  async list(limit: number): Promise<TeamSlideRow[]> {
    const rows = await this.prisma.homeSlide.findMany({ orderBy: { startsAt: "desc" }, take: limit });
    return rows.map(toRow);
  }

  async byId(slideId: string): Promise<TeamSlideRow | null> {
    const row = await this.prisma.homeSlide.findUnique({ where: { slideId } });
    return row === null ? null : toRow(row);
  }

  async create(slideId: string, input: TeamSlideInput, by: string, at: Date): Promise<TeamSlideRow> {
    return toRow(await this.prisma.homeSlide.create({ data: { slideId, ...fields(input), createdAt: at, createdBy: by, updatedAt: at, updatedBy: by } }));
  }

  async update(slideId: string, input: TeamSlideInput, by: string, at: Date): Promise<TeamSlideRow | null> {
    const { count } = await this.prisma.homeSlide.updateMany({ where: { slideId, archivedAt: null }, data: { ...fields(input), updatedAt: at, updatedBy: by } });
    return count === 0 ? null : await this.byId(slideId);
  }

  async archive(slideId: string, by: string, at: Date): Promise<TeamSlideRow | null> {
    const { count } = await this.prisma.homeSlide.updateMany({ where: { slideId, archivedAt: null }, data: { archivedAt: at, archivedBy: by } });
    return count === 0 ? null : await this.byId(slideId);
  }

  async audienceFacts(accountId: string): Promise<{ createdAt: Date; payer: boolean } | null> {
    const account = await this.prisma.account.findUnique({ where: { accountId }, select: { createdAt: true, funnel: { select: { firstPurchaseAt: true } } } });
    return account === null ? null : { createdAt: account.createdAt, payer: account.funnel?.firstPurchaseAt != null };
  }
}
