import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { ChangelogService } from "../changelog/changelog.service.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import type { AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { ShopService } from "../shop/shop.service.js";
import { TasksService } from "../tasks/tasks.service.js";
import { VipService } from "../vip/vip.service.js";
import { pickSlides, type HomeSlide } from "./home-slides.js";
import { TeamSlidesService } from "./team-slides.service.js";

/**
 * Главная одним ответом (docs/35-stage4-plan.md WP42): карусель — слайды по
 * ценности для игрока (`home-slides.ts`). Он собирает витрину, VIP, журнал
 * обновлений и задания соседей и слайды команды (`team-slides.service.ts`).
 *
 * Источник, который не ответил, теряет свой слайд, а не всю карусель:
 * главная — первый экран игры, и пустое место хуже неполной полосы.
 */

const SOURCE_TIMEOUT_MS = 2_000;

export interface HomeView {
  slides: HomeSlide[];
}

@Injectable()
export class HomeService {
  private readonly logger = new Logger("home");

  constructor(
    private readonly shop: ShopService,
    private readonly vip: VipService,
    private readonly changelog: ChangelogService,
    private readonly tasks: TasksService,
    private readonly restrictions: AccountRestrictions,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly teamSlides: TeamSlidesService,
  ) {}

  async view(account: AccountRef, at = new Date()): Promise<HomeView> {
    const { accountId } = account;
    const [shop, vip, freshVersions, tasks, referral, partner, facts] = await Promise.all([
      this.source("shop", () => this.shop.view(account, at), null),
      this.source("vip", () => this.vip.view(account, at), null),
      this.source("changelog", () => this.changelog.badge(account, at), 0),
      this.source("tasks", () => this.tasks.view(account, at), []),
      // Не узнали — считаем закрытым: обещать награду, которой может не быть, хуже, чем промолчать.
      this.source("restrictions", async () => (await this.restrictions.status(accountId, "referral_rewards", at)) === null, false),
      this.source("restrictions", async () => (await this.restrictions.status(accountId, "partner_tasks", at)) === null, false),
      this.source("audience", () => this.teamSlides.audienceFacts(accountId), null),
    ]);
    // Аудитория — после VIP: «только VIP» без ответа VIP не показывается.
    const audience = { platform: account.platform, createdAt: facts?.createdAt ?? null, payer: facts?.payer ?? null, vip: vip?.active ?? null };
    const team = await this.source("team", () => this.teamSlides.forPlayer(audience, at), []);
    const channelUrl = this.settings.get(SETTINGS.homeChannelUrl);
    return { slides: pickSlides({ shop, vip, freshVersions, invite: referral, channelUrl, tasks: partner ? tasks : [], team }, at) };
  }

  private async source<T>(name: string, read: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await withTimeout(read(), SOURCE_TIMEOUT_MS, `главная: ${name}`);
    } catch (error) {
      this.logger.warn(JSON.stringify({ module: "home", event: "home_source_failed", source: name, reason: error instanceof Error ? error.message : "unknown" }));
      return fallback;
    }
  }
}
