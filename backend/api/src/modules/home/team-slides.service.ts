import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { MediaService } from "../media/media.service.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { TeamSlideNotFoundError, TeamSlidePeriodError } from "./home-errors.js";
import {
  TEAM_SLIDE_AUDIENCES,
  TEAM_SLIDE_ICONS,
  TEAM_SLIDE_LIMITS,
  TEAM_SLIDE_SCREENS,
  teamSlidePeriodProblem,
  teamSlidesFor,
  teamSlideState,
  type AudienceFacts,
  type TeamSlideInput,
  type TeamSlideRow,
  type TeamSlideState,
} from "./team-slide-rules.js";
import { TEAM_SLIDE_REPOSITORY, type TeamSlideRepository } from "./team-slide.repository.js";

/**
 * Слайды команды (docs/35-stage4-plan.md WP42, часть 2): заводит, правит и
 * снимает раздел панели «Главная» под `home.edit`, каждое действие — в
 * аудит; главная берёт отсюда идущие.
 *
 * Идущие живут в памяти реплики полминуты, как акции магазина: главную
 * открывают после каждого забега, а слайды меняются раз в дни. Слайд,
 * который начнётся в эти полминуты, попадает в выборку заранее и
 * начинается вовремя; правка на других репликах видна до полуминуты.
 */

export interface TeamSlideAdminRow extends TeamSlideRow {
  state: TeamSlideState;
}

export interface TeamSlideCatalogView {
  slides: TeamSlideAdminRow[];
  limits: typeof TEAM_SLIDE_LIMITS;
  screens: typeof TEAM_SLIDE_SCREENS;
  icons: typeof TEAM_SLIDE_ICONS;
  audiences: typeof TEAM_SLIDE_AUDIENCES;
}

const CACHE_TTL_MS = 30_000;
const DB_TIMEOUT_MS = 3_000;
/** панели хватает: слайдов команды — единицы в неделю */
const LIST_LIMIT = 200;

@Injectable()
export class TeamSlidesService {
  private readonly logger = new Logger("home");
  private cache: { slides: TeamSlideRow[]; until: number } | null = null;

  constructor(
    @Inject(TEAM_SLIDE_REPOSITORY) private readonly repository: TeamSlideRepository,
    private readonly roles: RolesService,
    private readonly media: MediaService,
  ) {}

  /** Слайды команды для игрока: идущие, его площадки и аудитории. */
  async forPlayer(facts: AudienceFacts, at = new Date()): Promise<TeamSlideRow[]> {
    return teamSlidesFor(await this.current(at), facts, at);
  }

  /** Когда зарегистрирован и платил ли — для аудитории; `null` — не узнали. */
  async audienceFacts(accountId: string): Promise<{ createdAt: Date; payer: boolean } | null> {
    return await this.db(this.repository.audienceFacts(accountId));
  }

  async catalog(actor: AccountRef, at = new Date()): Promise<TeamSlideCatalogView> {
    await this.roles.require(actor, "home.edit");
    const slides = await this.db(this.repository.list(LIST_LIMIT));
    return {
      slides: slides.map((slide) => ({ ...slide, state: teamSlideState(slide, at) })),
      limits: TEAM_SLIDE_LIMITS,
      screens: TEAM_SLIDE_SCREENS,
      icons: TEAM_SLIDE_ICONS,
      audiences: TEAM_SLIDE_AUDIENCES,
    };
  }

  async create(actor: AccountRef, input: TeamSlideInput, at = new Date()): Promise<TeamSlideAdminRow> {
    await this.roles.require(actor, "home.edit");
    const problem = teamSlidePeriodProblem(input, at, false);
    if (problem !== null) throw new TeamSlidePeriodError(problem);
    // Картинка — загруженная и того вида, что нужен слайду: квадрат.
    if (input.imageId !== null) await this.media.require(input.imageId, "home_slide");
    const row = await this.db(this.repository.create(randomUUID(), input, actor.accountId, at));
    await this.roles.audit({ actorAccountId: actor.accountId, action: "home.slide.create", target: row.slideId, after: auditOf(row) });
    this.forget();
    this.log("team_slide_created", { slideId: row.slideId, audience: row.audience, startsAt: row.startsAt, endsAt: row.endsAt, actor: actor.accountId });
    return { ...row, state: teamSlideState(row, at) };
  }

  async update(actor: AccountRef, slideId: string, input: TeamSlideInput, at = new Date()): Promise<TeamSlideAdminRow> {
    await this.roles.require(actor, "home.edit");
    const before = await this.db(this.repository.byId(slideId));
    if (before === null || before.archivedAt !== null) throw new TeamSlideNotFoundError();
    // Начало у идущего слайда уже в прошлом — правке текста это не мешает.
    const problem = teamSlidePeriodProblem(input, at, before.startsAt.getTime() <= at.getTime());
    if (problem !== null) throw new TeamSlidePeriodError(problem);
    // Прежнюю картинку не перепроверяем — она уже у игроков.
    if (input.imageId !== null && input.imageId !== before.imageId) await this.media.require(input.imageId, "home_slide");
    const row = await this.db(this.repository.update(slideId, input, actor.accountId, at));
    if (row === null) throw new TeamSlideNotFoundError();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "home.slide.update", target: slideId, before: auditOf(before), after: auditOf(row) });
    this.forget();
    this.log("team_slide_updated", { slideId, actor: actor.accountId });
    return { ...row, state: teamSlideState(row, at) };
  }

  async archive(actor: AccountRef, slideId: string, at = new Date()): Promise<TeamSlideAdminRow> {
    await this.roles.require(actor, "home.edit");
    const row = await this.db(this.repository.archive(slideId, actor.accountId, at));
    if (row === null) throw new TeamSlideNotFoundError();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "home.slide.archive", target: slideId, after: auditOf(row) });
    this.forget();
    this.log("team_slide_archived", { slideId, actor: actor.accountId });
    return { ...row, state: teamSlideState(row, at) };
  }

  private async current(at: Date): Promise<TeamSlideRow[]> {
    const now = at.getTime();
    if (this.cache === null || this.cache.until <= now) {
      const slides = await this.db(this.repository.current(at, new Date(now + CACHE_TTL_MS)));
      this.cache = { slides, until: now + CACHE_TTL_MS };
    }
    return this.cache.slides;
  }

  /** Правка из панели видна сразу на этой реплике, на остальных — через полминуты. */
  private forget(): void {
    this.cache = null;
  }

  private async db<T>(promise: Promise<T>): Promise<T> {
    return await withTimeout(promise, DB_TIMEOUT_MS, "слайды главной");
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "home", event, ...fields }));
  }
}

/** В аудит — то, что видит игрок, и кому: служебные поля строки там лишние. */
function auditOf(slide: TeamSlideRow) {
  return {
    title: slide.title,
    text: slide.text,
    imageId: slide.imageId,
    icon: slide.icon,
    target: slide.target.kind === "screen" ? `screen:${slide.target.screen}` : slide.target.url,
    platforms: slide.platforms.join(", "),
    audience: slide.audience,
    pinned: slide.pinned,
    startsAt: slide.startsAt.toISOString(),
    endsAt: slide.endsAt.toISOString(),
    archivedAt: slide.archivedAt?.toISOString() ?? null,
  };
}
