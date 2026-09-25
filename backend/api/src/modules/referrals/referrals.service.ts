import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { ipPrefix } from "../attribution/ip-prefix.js";
import { SESSIONS_REPOSITORY, type SessionsRepository } from "../attribution/sessions.repository.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { AuthHooks, type LoginEvent } from "../auth/auth-hooks.js";
import { FRIENDS_REPOSITORY, type FriendsRepository } from "../friends/friends.repository.js";
import { RUNS_REPOSITORY, type RunsRepository } from "../runs/runs.repository.js";
import { RunsHooks, type RecordedRun } from "../runs/runs-hooks.js";
import { WalletService } from "../wallet/wallet.service.js";
import { REFERRAL_RULES } from "./referral-rules.js";
import { REFERRALS_REPOSITORY, type ReferralRow, type ReferralsRepository } from "./referrals.repository.js";

/**
 * Рефералка (docs/23-referral-and-partner-program.md §2, docs/35-stage4-plan.md
 * §3.8). Приглашение — та же ссылка дружбы `f-<код>`: новичок по ней ещё и
 * реферал владельца ссылки.
 *
 * - **привязка** — при входе по ссылке, одна и навсегда и только к аккаунту
 *   моложе окна: старый игрок, открывший чужую ссылку, приведённым не
 *   считается. Приглашённому сразу — стартовые монеты: приглашение, которое
 *   ничего не даёт получателю, работает хуже (§2.3);
 * - **антифрод на привязке** — новичок из той же подсети, что пригласивший,
 *   скорее тот же человек: привязка остаётся, но отклонённой, и ни одна
 *   сторона ничего не получает (§2.4);
 * - **активация** — после нескольких записанных забегов без читов, не больше
 *   потолка в сутки на пригласившего: сверх потолка активация ждёт следующего
 *   забега. Награда пригласившему — ключом кошелька по приглашённому.
 *
 * Оба слушателя работают после ответа игроку; упавший пишет в лог и не мешает
 * ни входу, ни забегу.
 */
@Injectable()
export class ReferralsService implements OnModuleInit {
  private readonly logger = new Logger("referrals");

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REFERRALS_REPOSITORY) private readonly referrals: ReferralsRepository,
    @Inject(FRIENDS_REPOSITORY) private readonly friends: FriendsRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(SESSIONS_REPOSITORY) private readonly sessions: SessionsRepository,
    @Inject(RUNS_REPOSITORY) private readonly runs: RunsRepository,
    private readonly wallet: WalletService,
    private readonly auth: AuthHooks,
    private readonly runHooks: RunsHooks,
  ) {}

  onModuleInit(): void {
    if (!this.config.auth.enabled) return;
    this.auth.onLogin("referrals", (login) => this.onLogin(login));
    this.runHooks.onRecorded("referrals", (run) => this.onRun(run));
  }

  async mine(referrerId: string): Promise<{ referrals: ReferralRow[]; activated: number; rewardCoins: number }> {
    const referrals = await this.referrals.byReferrer(referrerId, 200);
    return { referrals, activated: referrals.filter((row) => row.status === "activated").length, rewardCoins: REFERRAL_RULES.referrerCoins };
  }

  async onLogin(login: LoginEvent): Promise<void> {
    const { startParam } = login;
    if (startParam.kind !== "friend" || startParam.ref === null || login.reason !== "launch") return;
    const referrerId = await this.friends.ownerOf(startParam.ref);
    if (referrerId === null || referrerId === login.accountId) return;
    if ((await this.referrals.binding(login.accountId)) !== null) return;

    const [referred, referrer] = await Promise.all([this.accounts.byId(login.accountId), this.accounts.byId(referrerId)]);
    if (referred === null || referrer === null || referrer.bannedAt !== null || referrer.platform !== referred.platform) return;
    const ageMs = login.at.getTime() - referred.createdAt.getTime();
    if (ageMs > REFERRAL_RULES.bindWindowDays * 86_400_000) return;

    const network = ipPrefix(login.ip);
    const referrerNetworks = network === null ? [] : await this.sessions.recentIpPrefixes(referrerId, REFERRAL_RULES.networkLookback);
    if (network !== null && referrerNetworks.includes(network)) {
      if (await this.referrals.bind(login.accountId, referrerId, "rejected", "same_network")) this.log("referral_rejected", { referredId: login.accountId, referrerId, reason: "same_network" });
      return;
    }

    if (!(await this.referrals.bind(login.accountId, referrerId, "bound", null))) return;
    this.log("referral_bound", { referredId: login.accountId, referrerId });
    await this.wallet.grant({
      accountId: login.accountId,
      resource: "coins",
      amount: REFERRAL_RULES.welcomeCoins,
      reason: "referral_reward",
      source: `referral_welcome:${referrerId}`,
      idempotencyKey: `referral_welcome:${login.accountId}`,
    });
  }

  async onRun(run: RecordedRun): Promise<void> {
    if (run.cheats || run.verdict === "rejected") return;
    const binding = await this.referrals.binding(run.accountId);
    if (binding === null || binding.status !== "bound") return;
    const { runs } = await this.runs.stats(run.accountId);
    if (runs < REFERRAL_RULES.activationRuns) return;
    // Сверх суточного потолка активация не пропадает — дождётся следующего забега.
    if ((await this.referrals.activatedToday(binding.referrerId)) >= REFERRAL_RULES.maxActivationsPerDay) return;
    if (!(await this.referrals.activate(run.accountId, run.finishedAt))) return;

    this.log("referral_activated", { referredId: run.accountId, referrerId: binding.referrerId });
    await this.wallet.grant({
      accountId: binding.referrerId,
      resource: "coins",
      amount: REFERRAL_RULES.referrerCoins,
      reason: "referral_reward",
      source: `referral:${run.accountId}`,
      idempotencyKey: `referral:${run.accountId}`,
    });
  }

  private log(event: string, fields: Record<string, unknown>): void {
    this.logger.log(JSON.stringify({ module: "referrals", event, ...fields }));
  }
}
