import { PartnerAccountTakenError, type PartnerAccountRef, type PartnerAccounts } from "../../src/modules/partners/partner-cabinet.js";
import type { MemoryAccountRepository } from "./memory-auth.js";
import type { MemoryPartnersRepository } from "./memory-partners.js";

/**
 * Связь партнёра с игровым аккаунтом в памяти (T-0217): аккаунты — из
 * `MemoryAccountRepository`, имена партнёров — из `MemoryPartnersRepository`.
 * Смысл тот же, что у базы: аккаунт связан не больше чем с одним партнёром,
 * повторная запись той же пары безвредна.
 */
export class MemoryPartnerAccounts implements PartnerAccounts {
  /** партнёр → аккаунт */
  readonly links = new Map<string, string>();

  constructor(
    private readonly accounts: MemoryAccountRepository,
    private readonly partners: MemoryPartnersRepository,
  ) {}

  async byTelegramId(telegramId: string): Promise<PartnerAccountRef | null> {
    const found = await this.accounts.byPlatformUser("telegram", telegramId);
    return found === null ? null : { accountId: found.accountId, platform: found.platform, platformUserId: found.platformUserId };
  }

  async linkedTo(partnerId: string): Promise<PartnerAccountRef | null> {
    const accountId = this.links.get(partnerId);
    const found = accountId === undefined ? null : await this.accounts.byId(accountId);
    return found === null ? null : { accountId: found.accountId, platform: found.platform, platformUserId: found.platformUserId };
  }

  async partnerOf(accountId: string): Promise<{ partnerId: string; name: string } | null> {
    for (const [partnerId, linked] of this.links) {
      if (linked === accountId) return { partnerId, name: this.partners.rows.get(partnerId)?.name ?? "" };
    }
    return null;
  }

  async link(partnerId: string, accountId: string): Promise<void> {
    const holder = await this.partnerOf(accountId);
    if (holder !== null && holder.partnerId !== partnerId) throw new PartnerAccountTakenError(holder.name);
    this.links.set(partnerId, accountId);
  }
}
