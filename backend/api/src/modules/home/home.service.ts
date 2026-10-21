import { Inject, Injectable, Logger } from "@nestjs/common";
import { withTimeout } from "../../common/with-timeout.js";
import { ChangelogService } from "../changelog/changelog.service.js";
import { DailyService } from "../daily/daily.service.js";
import { DonationsService } from "../donations/donations.service.js";
import { AccountRestrictions } from "../restrictions/account-restrictions.js";
import type { AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import { ShopService } from "../shop/shop.service.js";
import { TasksService } from "../tasks/tasks.service.js";
import { VipService } from "../vip/vip.service.js";
import { WheelService } from "../wheel/wheel.service.js";
import { pickSlides, type HomeSlide } from "./home-slides.js";
import { dailyWidget, tasksWidget, wheelWidget, type HomeWidgets } from "./home-widgets.js";
import { TeamSlidesService } from "./team-slides.service.js";

/**
 * Главная одним ответом (docs/35-stage4-plan.md WP42): карусель — слайды по
 * ценности для игрока (`home-slides.ts`). Он собирает витрину, VIP, журнал
 * обновлений и задания соседей, способы поддержать проект (`donations`) и слайды
 * команды (`team-slides.service.ts`). Там же виджеты — награда дня, колесо и задания (`home-widgets.ts`): одним
 * запросом с каруселью, а не тремя запросами их экранов.
 *
 * Источник, который не ответил, теряет свой слайд или подробности своего
 * виджета, а не всю главную: это первый экран игры, и пустое место хуже
 * неполной полосы.
 */

const SOURCE_TIMEOUT_MS = 2_000;

export interface HomeView {
  slides: HomeSlide[];
  widgets: HomeWidgets;
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
    private readonly daily: DailyService,
    private readonly wheel: WheelService,
    private readonly donations: DonationsService,
  ) {}

  async view(account: AccountRef, at = new Date()): Promise<HomeView> {
    const { accountId } = account;
    const [shop, vip, freshVersions, tasks, referral, partner, facts, daily, wheel, donate] = await Promise.all([
      this.source("shop", () => this.shop.view(account, at), null),
      this.source("vip", () => this.vip.view(account, at), null),
      this.source("changelog", () => this.changelog.badge(account, at), 0),
      // Не ответили задания — нет ни слайда задания, ни кольца: «0 из 0» было бы неправдой.
      this.source("tasks", () => this.tasks.view(account, at), null),
      // Не узнали — считаем закрытым: обещать награду, которой может не быть, хуже, чем промолчать.
      this.source("restrictions", async () => (await this.restrictions.status(accountId, "referral_rewards", at)) === null, false),
      this.source("restrictions", async () => (await this.restrictions.status(accountId, "partner_tasks", at)) === null, false),
      this.source("audience", () => this.teamSlides.audienceFacts(accountId), null),
      this.source("daily", () => this.daily.view(accountId, at), null),
      this.source("wheel", () => this.wheel.view({ accountId, platform: account.platform }, at), null),
      this.donateSlide(account, at),
    ]);
    // Аудитория — после VIP: «только VIP» без ответа VIP не показывается.
    const audience = { platform: account.platform, createdAt: facts?.createdAt ?? null, payer: facts?.payer ?? null, vip: vip?.active ?? null };
    const team = await this.source("team", () => this.teamSlides.forPlayer(audience, at), []);
    const channelUrl = this.settings.get(SETTINGS.homeChannelUrl);
    return {
      slides: pickSlides({ shop, vip, freshVersions, invite: referral, channelUrl, donate, tasks: partner ? (tasks ?? []) : [], team }, at),
      widgets: {
        daily: daily === null ? null : dailyWidget(daily),
        wheel: wheel === null ? null : wheelWidget(wheel),
        tasks: tasks === null ? null : tasksWidget(tasks),
      },
    };
  }

  /**
   * Слайд «Поддержать проект» (Р109): включён в панели и у игрока есть хоть
   * один способ поддержать — звёзды или ссылка Tribute. Выключенный (умолчание)
   * не ходит в донаты вовсе: главная — первый экран, и лишнего чтения на ней
   * быть не должно. Не ответили донаты — слайда нет.
   */
  private async donateSlide(account: AccountRef, at: Date): Promise<boolean> {
    if (!this.settings.get(SETTINGS.donateHomeSlide)) return false;
    const view = await this.source("donations", () => this.donations.view(account, at), null);
    return view !== null && (view.stars !== null || view.tribute !== null);
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
