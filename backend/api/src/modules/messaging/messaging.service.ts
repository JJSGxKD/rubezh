import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import type { PlatformId } from "../../platforms/ports/platform.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { AuthHooks } from "../auth/auth-hooks.js";
import { MESSAGING_REPOSITORY, type MessagingReason, type MessagingRepository, type MessagingState } from "./messaging.repository.js";

/**
 * Можно ли писать игроку (docs/35-stage4-plan.md, §3.10): от этого зависят
 * рассылки и уведомления — о заявке в друзья, подарке, сезоне.
 *
 * - вошёл в канал площадки сам (`/start` бота) — можно: он начал разговор;
 * - разрешил писать из приложения — можно;
 * - заблокировал бота — нельзя, разблокировал — снова можно.
 *
 * Что именно случилось на площадке, переводит в эти причины её адаптер (у
 * Telegram — `platforms/telegram/telegram-messaging.handler.ts`).
 */
@Injectable()
export class MessagingService implements OnModuleInit {
  private readonly logger = new Logger("messaging");

  constructor(
    @Inject(MESSAGING_REPOSITORY) private readonly states: MessagingRepository,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: Pick<AccountRepository, "byPlatformUser">,
    private readonly auth: AuthHooks,
  ) {}

  onModuleInit(): void {
    this.auth.onLogin("messaging", async (login) => {
      if (login.place !== "channel") return;
      await this.save(login.accountId, "entered", login.at);
    });
  }

  /**
   * Площадка сообщила о своём: разрешение, блокировка, разблокировка. Игрока
   * без аккаунта не заводим — заблокировать бота можно и не заходя в игру, и
   * такой аккаунт никому не нужен.
   */
  async platformChanged(platform: PlatformId, platformUserId: string, reason: MessagingReason, at: Date): Promise<void> {
    const account = await this.accounts.byPlatformUser(platform, platformUserId);
    if (account === null) return;
    await this.save(account.accountId, reason, at);
  }

  async state(accountId: string): Promise<MessagingState | null> {
    return await this.states.get(accountId);
  }

  private async save(accountId: string, reason: MessagingReason, at: Date): Promise<void> {
    try {
      await this.states.set(accountId, { canMessage: reason !== "blocked", reason, changedAt: at });
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "messaging", event: "state_lost", accountId, reason, error: error instanceof Error ? error.message : "unknown" }));
    }
  }
}
