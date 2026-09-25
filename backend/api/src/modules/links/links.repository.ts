import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { PlatformId } from "../../platforms/ports/platform.js";

/** Ссылки кампаний и клики по ним (docs/24-attribution-and-sharing.md §3). */

export interface LinkInput {
  code: string;
  platform: PlatformId;
  campaign: string;
  source: string | null;
  medium: string | null;
  note: string | null;
  createdBy: string | null;
}

export interface LinkRecord extends LinkInput {
  createdAt: Date;
}

export interface ClickInput {
  clickId: string;
  linkCode: string;
  at: Date;
  utm: { source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null };
  refererHost: string | null;
  deviceClass: string | null;
  ipPrefix: string | null;
  language: string | null;
}

export interface LinkStats extends LinkRecord {
  clicks: number;
  clicks30d: number;
  /** сколько аккаунтов запустили игру по кликам этой ссылки — сессии с `start_ref` клика */
  launches: number;
}

export const LINKS_REPOSITORY = Symbol("LINKS_REPOSITORY");

export interface LinksRepository {
  create(link: LinkInput): Promise<LinkRecord>;
  byCode(code: string): Promise<LinkRecord | null>;
  recordClick(click: ClickInput): Promise<void>;
  list(limit: number): Promise<LinkStats[]>;
}

@Injectable()
export class PrismaLinksRepository implements LinksRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async create(link: LinkInput): Promise<LinkRecord> {
    return await this.prisma.link.create({ data: link });
  }

  async byCode(code: string): Promise<LinkRecord | null> {
    return await this.prisma.link.findUnique({ where: { code } });
  }

  async recordClick(click: ClickInput): Promise<void> {
    await this.prisma.linkClick.create({
      data: {
        clickId: click.clickId,
        linkCode: click.linkCode,
        at: click.at,
        utmSource: click.utm.source,
        utmMedium: click.utm.medium,
        utmCampaign: click.utm.campaign,
        utmContent: click.utm.content,
        utmTerm: click.utm.term,
        refererHost: click.refererHost,
        deviceClass: click.deviceClass,
        ipPrefix: click.ipPrefix,
        language: click.language,
      },
    });
  }

  async list(limit: number): Promise<LinkStats[]> {
    const links = await this.prisma.link.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    if (links.length === 0) return [];
    const codes = links.map((link) => link.code);
    // Запуски — по сессиям с кодом клика этой ссылки: связь клика с игроком
    // уже пишет атрибуция (`start_kind = click`, `start_ref = click_id`).
    const stats = await this.prisma.$queryRaw<{ link_code: string; clicks: number; clicks_30d: number; launches: number }[]>`
      SELECT c.link_code,
             count(*)::int AS clicks,
             count(*) FILTER (WHERE c.at > now() - interval '30 days')::int AS clicks_30d,
             (SELECT count(DISTINCT s.account_id)::int FROM account_session s
               JOIN link_click lc ON lc.click_id = s.start_ref
               WHERE s.start_kind = 'click' AND lc.link_code = c.link_code) AS launches
      FROM link_click c
      WHERE c.link_code IN (${Prisma.join(codes)})
      GROUP BY c.link_code`;
    const byCode = new Map(stats.map((row) => [row.link_code, row]));
    return links.map((link) => {
      const row = byCode.get(link.code);
      return { ...link, clicks: row?.clicks ?? 0, clicks30d: row?.clicks_30d ?? 0, launches: row?.launches ?? 0 };
    });
  }
}
