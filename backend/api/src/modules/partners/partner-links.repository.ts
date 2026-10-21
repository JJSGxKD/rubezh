import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { LinkNetwork } from "../links/link-networks.js";
import type { LinkTarget } from "../links/link-targets.js";
import { LINKS_REPOSITORY, type LinksRepository } from "../links/links.repository.js";

/**
 * Ссылки партнёра для его карточки в панели (T-0067). Клики и запуски берутся у
 * репозитория ссылок, а не пересчитываются здесь: числа в карточке партнёра и в
 * списке ссылок обязаны совпадать. Свое здесь — сколько игроков привязала каждая
 * ссылка: привязка живёт у партнёров.
 */

/** Ссылок в карточке: столько же, сколько в списке ссылок панели. */
const LINKS_LIMIT = 200;

export interface PartnerLinkStats {
  code: string;
  campaign: string;
  source: string | null;
  target: LinkTarget;
  network: LinkNetwork | null;
  createdAt: Date;
  clicks: number;
  clicks30d: number;
  /** запуски по кликам через переходник */
  launches: number;
  /** запуски по прямой ссылке `l-<код>` */
  directLaunches: number;
  /** сколько игроков привязала эта ссылка */
  bound: number;
}

export interface PartnerLinks {
  links: PartnerLinkStats[];
  /** игроков, привязанных по ссылкам партнёра: привязки кодами сюда не входят */
  bound: number;
}

export const PARTNER_LINKS = Symbol("PARTNER_LINKS");

export interface PartnerLinksSource {
  forPartner(partnerId: string): Promise<PartnerLinks>;
}

const boundRow = z.object({ link_code: z.string(), bound: z.number().int() });

@Injectable()
export class PrismaPartnerLinksSource implements PartnerLinksSource {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(LINKS_REPOSITORY) private readonly links: LinksRepository,
  ) {}

  async forPartner(partnerId: string): Promise<PartnerLinks> {
    const [stats, rows] = await Promise.all([
      this.links.list(LINKS_LIMIT, { partnerId }),
      this.prisma.$queryRaw<unknown[]>`
        SELECT link_code, count(*)::int AS bound
        FROM partner_binding
        WHERE partner_id = ${partnerId}::uuid AND link_code IS NOT NULL
        GROUP BY link_code`,
    ]);
    const boundByCode = new Map(rows.map((raw) => boundRow.parse(raw)).map((row) => [row.link_code, row.bound]));
    return {
      links: stats.map((link) => ({
        code: link.code,
        campaign: link.campaign,
        source: link.source,
        target: link.target,
        network: link.network,
        createdAt: link.createdAt,
        clicks: link.clicks,
        clicks30d: link.clicks30d,
        launches: link.launches,
        directLaunches: link.directLaunches,
        bound: boundByCode.get(link.code) ?? 0,
      })),
      bound: [...boundByCode.values()].reduce((sum, count) => sum + count, 0),
    };
  }
}
