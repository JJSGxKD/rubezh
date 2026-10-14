import { Inject, Injectable } from "@nestjs/common";
import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { CHECKER_REFERER_HOSTS } from "./availability-checkers.js";
import { isLinkNetwork, type LinkNetwork } from "./link-networks.js";
import { isLinkTarget, type LinkTarget } from "./link-targets.js";

/** Ссылки кампаний и клики по ним (docs/24-attribution-and-sharing.md §3). */

/** Когда регистрация уходит в сеть: после первого засчитанного забега или при первом запуске (О39). */
export type RegistrationOn = "first_run" | "launch";

export interface LinkInput {
  code: string;
  platform: PlatformId;
  campaign: string;
  source: string | null;
  medium: string | null;
  note: string | null;
  createdBy: string | null;
  /** сеть, где куплена реклама; `null` — обычная ссылка */
  network: LinkNetwork | null;
  registrationOn: RegistrationOn;
  /** куда ведёт ссылка; не задана — Mini App, как у всех ссылок до целей */
  target?: LinkTarget;
}

export interface LinkRecord extends Omit<LinkInput, "target"> {
  target: LinkTarget;
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
  /** макросы сети ссылки, подставленные сетью; `null` — обычная ссылка или сеть ничего не подставила */
  networkParams: Record<string, string> | null;
}

/** Клики по классу устройства; без класса (`NULL`) и любой незнакомый — в `unknown`. */
export interface DeviceCounts {
  mobile: number;
  desktop: number;
  web: number;
  unknown: number;
}

export interface LinkStats extends LinkRecord {
  clicks: number;
  clicks30d: number;
  /** сколько аккаунтов запустили игру по кликам этой ссылки — сессии с `start_ref` клика */
  launches: number;
  /** сколько аккаунтов запустили игру по прямой ссылке `l-<код>` — сессии вида `link` с кодом ссылки */
  directLaunches: number;
  devices: DeviceCounts;
}

export const LINKS_REPOSITORY = Symbol("LINKS_REPOSITORY");

export interface LinksRepository {
  create(link: LinkInput): Promise<LinkRecord>;
  byCode(code: string): Promise<LinkRecord | null>;
  recordClick(click: ClickInput): Promise<void>;
  list(limit: number): Promise<LinkStats[]>;
  /** Сменить цель; прошлые клики остаются. `null` — ссылки с таким кодом нет. */
  retarget(code: string, target: LinkTarget): Promise<LinkRecord | null>;
}

@Injectable()
export class PrismaLinksRepository implements LinksRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async create(link: LinkInput): Promise<LinkRecord> {
    return recordOf(await this.prisma.link.create({ data: link }));
  }

  async byCode(code: string): Promise<LinkRecord | null> {
    const row = await this.prisma.link.findUnique({ where: { code } });
    return row === null ? null : recordOf(row);
  }

  async retarget(code: string, target: LinkTarget): Promise<LinkRecord | null> {
    try {
      return recordOf(await this.prisma.link.update({ where: { code }, data: { target } }));
    } catch (error: unknown) {
      // Ссылки с таким кодом нет: Prisma сообщает об этом кодом P2025.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") return null;
      throw error;
    }
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
        networkParams: click.networkParams ?? Prisma.DbNull,
      },
    });
  }

  async list(limit: number): Promise<LinkStats[]> {
    const links = await this.prisma.link.findMany({ orderBy: { createdAt: "desc" }, take: limit });
    if (links.length === 0) return [];
    const codes = links.map((link) => link.code);
    // Запуски — по сессиям с кодом клика этой ссылки: связь клика с игроком
    // уже пишет атрибуция (`start_kind = click`, `start_ref = click_id`).
    // Клики проверок доступности, записанные до T-0073, в базе остаются, но не
    // считаются. У клика без Referer хост `NULL`, а `NULL NOT IN (...)` даёт
    // `NULL`, поэтому условие явно пропускает `IS NULL`.
    const stats = await this.prisma.$queryRaw<
      { link_code: string; clicks: number; clicks_30d: number; mobile_clicks: number; desktop_clicks: number; web_clicks: number; unknown_clicks: number; launches: number }[]
    >`
      SELECT c.link_code,
             count(*)::int AS clicks,
             count(*) FILTER (WHERE c.at > now() - interval '30 days')::int AS clicks_30d,
             count(*) FILTER (WHERE c.device_class = 'mobile')::int AS mobile_clicks,
             count(*) FILTER (WHERE c.device_class = 'desktop')::int AS desktop_clicks,
             count(*) FILTER (WHERE c.device_class = 'web')::int AS web_clicks,
             count(*) FILTER (WHERE c.device_class IS NULL OR c.device_class NOT IN ('mobile', 'desktop', 'web'))::int AS unknown_clicks,
             (SELECT count(DISTINCT s.account_id)::int FROM account_session s
               JOIN link_click lc ON lc.click_id = s.start_ref
               WHERE s.start_kind = 'click' AND lc.link_code = c.link_code) AS launches
      FROM link_click c
      WHERE c.link_code IN (${Prisma.join(codes)})
        AND (c.referer_host IS NULL OR c.referer_host NOT IN (${Prisma.join(CHECKER_REFERER_HOSTS)}))
      GROUP BY c.link_code`;
    // Прямые запуски — сессии вида `link`, где `start_ref` — сам код ссылки, без кликов;
    // у ссылки, по которой не кликали ни разу, они всё равно есть.
    const direct = await this.prisma.$queryRaw<{ link_code: string; direct_launches: number }[]>`
      SELECT s.start_ref AS link_code, count(DISTINCT s.account_id)::int AS direct_launches
      FROM account_session s
      WHERE s.start_kind = 'link' AND s.start_ref IN (${Prisma.join(codes)})
      GROUP BY s.start_ref`;
    const byCode = new Map(stats.map((row) => [row.link_code, row]));
    const directByCode = new Map(direct.map((row) => [row.link_code, row.direct_launches]));
    return links.map((link) => {
      const row = byCode.get(link.code);
      return {
        ...recordOf(link),
        clicks: row?.clicks ?? 0,
        clicks30d: row?.clicks_30d ?? 0,
        launches: row?.launches ?? 0,
        directLaunches: directByCode.get(link.code) ?? 0,
        devices: { mobile: row?.mobile_clicks ?? 0, desktop: row?.desktop_clicks ?? 0, web: row?.web_clicks ?? 0, unknown: row?.unknown_clicks ?? 0 },
      };
    });
  }
}

/**
 * Строка базы — в запись: сеть и момент регистрации держит `CHECK`, здесь только сужение типа.
 * Цель, которой код не знает (строка из будущей версии), читается как Mini App — ссылка работает.
 */
function recordOf(row: Omit<LinkRecord, "network" | "registrationOn" | "target"> & { network: string | null; registrationOn: string; target: string }): LinkRecord {
  return {
    ...row,
    network: row.network === null || !isLinkNetwork(row.network) ? null : row.network,
    registrationOn: row.registrationOn === "launch" ? "launch" : "first_run",
    target: isLinkTarget(row.target) ? row.target : "app",
  };
}
