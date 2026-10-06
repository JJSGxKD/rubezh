import { Inject, Injectable, Logger } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { AppLinks } from "../../platforms/ports/app-links.js";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { classifyClient } from "../attribution/client-class.js";
import { ipPrefix } from "../attribution/ip-prefix.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { isCrawler } from "./crawler.js";
import { newClickId, newLinkCode } from "./link-code.js";
import { macroQuery, networkParamsOf, type LinkNetwork } from "./link-networks.js";
import { LINKS_REPOSITORY, type LinkRecord, type LinksRepository, type LinkStats, type RegistrationOn } from "./links.repository.js";

/**
 * Редирект-ссылки (docs/24-attribution-and-sharing.md §3, WP16): команда
 * заводит ссылку кампании, `/r/<код>` ведёт в приложение площадки, а каждый
 * клик получает свой код в параметре запуска — атрибуция уже умеет связать
 * его с сессией и касанием игрока.
 *
 * Клик пишется мимо ответа: редирект не ждёт базы — на медленной сети каждая
 * лишняя сотня миллисекунд теряет переходы (§3.2). Не записался — лог, а
 * игрок всё равно попадает в игру.
 */

export interface VisitorInfo {
  userAgent: string | null;
  referer: string | null;
  acceptLanguage: string | null;
  ip: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null; content: string | null; term: string | null };
  /** параметры запроса, которые могут быть макросами сети ссылки; разбирает профиль сети */
  query: Readonly<Record<string, string | undefined>>;
}

/** Что сделать с посетителем: краулеру — страница превью, человеку — переход в приложение. */
export type Visit =
  | { kind: "not_found" }
  | { kind: "preview"; url: string | null }
  | { kind: "redirect"; target: string }
  | { kind: "unavailable"; url: string | null };

export interface NewLink {
  campaign: string;
  source: string | null;
  medium: string | null;
  note: string | null;
  platform: PlatformId;
  /** сеть, где куплена реклама; не задана — обычная ссылка */
  network?: LinkNetwork | null;
  /** когда регистрация уходит в сеть; не задано — после первого засчитанного забега (О39) */
  registrationOn?: RegistrationOn;
}

/** Ссылка для панели: адрес и, у ссылки сети, адрес с макросами — его вставляют в кабинет сети. */
export type LinkView<T extends LinkRecord = LinkRecord> = T & { url: string; networkUrl: string | null };

@Injectable()
export class LinksService {
  private readonly logger = new Logger("links");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LINKS_REPOSITORY) private readonly links: LinksRepository,
    private readonly appLinks: AppLinks,
    private readonly roles: RolesService,
  ) {}

  async visit(code: string, visitor: VisitorInfo, now = new Date()): Promise<Visit> {
    const link = await this.links.byCode(code);
    if (link === null) return { kind: "not_found" };
    const url = this.publicUrl(link.code);
    if (isCrawler(visitor.userAgent)) return { kind: "preview", url };

    const clickId = newClickId();
    const target = this.appLinks.launch(link.platform, `c-${clickId}`);
    if (target === null) return { kind: "unavailable", url };

    void this.links
      .recordClick({
        clickId,
        linkCode: link.code,
        at: now,
        utm: visitor.utm,
        refererHost: hostOf(visitor.referer),
        deviceClass: classifyClient(null, visitor.userAgent).deviceClass,
        ipPrefix: ipPrefix(visitor.ip),
        language: languageOf(visitor.acceptLanguage),
        networkParams: link.network === null ? null : networkParamsOf(link.network, visitor.query),
      })
      .catch((error: unknown) => {
        this.logger.warn(JSON.stringify({ module: "links", event: "click_record_failed", link: link.code, reason: error instanceof Error ? error.message : "unknown" }));
      });
    return { kind: "redirect", target };
  }

  async create(actor: AccountRef, input: NewLink): Promise<LinkView> {
    await this.roles.require(actor, "links.manage");
    const link = await this.links.create({ ...input, network: input.network ?? null, registrationOn: input.registrationOn ?? "first_run", code: newLinkCode(), createdBy: actor.accountId });
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "links.create",
      target: link.code,
      after: { campaign: link.campaign, source: link.source, platform: link.platform, network: link.network, registrationOn: link.network === null ? null : link.registrationOn },
    });
    return this.view(link);
  }

  async list(actor: AccountRef): Promise<LinkView<LinkStats>[]> {
    await this.roles.require(actor, "links.manage");
    return (await this.links.list(200)).map((link) => this.view(link));
  }

  async byCode(code: string): Promise<LinkRecord | null> {
    return await this.links.byCode(code);
  }

  private view<T extends LinkRecord>(link: T): LinkView<T> {
    const url = this.publicUrl(link.code) ?? `/r/${link.code}`;
    // Макросы — как есть, без кодирования: сеть ищет в адресе `{campaign_id}`
    // буквально, а `%7Bcampaign_id%7D` не подставит.
    return { ...link, url, networkUrl: link.network === null ? null : `${url}?${macroQuery(link.network)}` };
  }

  /** Адрес ссылки на домене клиента: Caddy отдаёт `/r/*` бэкенду (docs/20-env-and-ports.md §2.1). */
  private publicUrl(code: string): string | null {
    const base = this.config.telegram.webAppUrl;
    if (base === "") return null;
    try {
      return new URL(`/r/${code}`, base).toString();
    } catch {
      return null;
    }
  }
}

/** Хост `Referer`, а не адрес целиком: путь и параметры чужой страницы нам ни к чему. */
export function hostOf(referer: string | null): string | null {
  if (referer === null || referer === "") return null;
  try {
    return new URL(referer).host.slice(0, 255) || null;
  } catch {
    return null;
  }
}

/** Первый язык из `Accept-Language`: `ru-RU,ru;q=0.9` → `ru-RU`. */
export function languageOf(header: string | null): string | null {
  const first = header?.split(",")[0]?.split(";")[0]?.trim() ?? "";
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(first) ? first : null;
}
