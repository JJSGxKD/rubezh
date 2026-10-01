import { campaignState } from "../../src/modules/promo-codes/promo-code-rules.js";
import type { PartnerInput, PartnerRow, PartnerStats } from "../../src/modules/partners/partner-rules.js";
import type { PartnerBindingView, PartnerCampaignRow, PartnersRepository } from "../../src/modules/partners/partners.repository.js";
import type { MemoryPromoCodesRepository } from "./memory-promo-codes.js";

/**
 * Партнёры в памяти поверх промокодов в памяти: коды и привязки берутся
 * оттуда, как в базе — из `promo_campaign` и `partner_binding`. Сыгравшие,
 * платящие и звёзды задаются тестом: в памяти нет воронки и оплат.
 */
export class MemoryPartnersRepository implements PartnersRepository {
  readonly rows = new Map<string, PartnerRow>();
  /** сыгравшие, платящие и звёзды по партнёру — то, что в базе дали бы воронка и оплаты */
  readonly outcomes = new Map<string, Pick<PartnerStats, "played" | "payers" | "stars">>();

  constructor(private readonly promo: MemoryPromoCodesRepository) {}

  async list(limit: number, at: Date): Promise<(PartnerRow & { stats: PartnerStats })[]> {
    return [...this.rows.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((row) => ({ ...row, stats: this.stats(row.partnerId, at) }));
  }

  async byId(partnerId: string, at: Date): Promise<(PartnerRow & { stats: PartnerStats }) | null> {
    const row = this.rows.get(partnerId);
    return row === undefined ? null : { ...row, stats: this.stats(partnerId, at) };
  }

  async daily(partnerId: string, since: Date): Promise<{ day: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const binding of this.promo.partnerBindings.values()) {
      if (binding.partnerId !== partnerId || binding.boundAt < since) continue;
      const day = new Date(binding.boundAt.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count }));
  }

  async campaigns(partnerId: string): Promise<PartnerCampaignRow[]> {
    const rows = await this.promo.list(500);
    return rows
      .filter((row) => row.partnerId === partnerId)
      .map((row) => ({
        campaignId: row.campaignId,
        title: row.title,
        kind: row.kind,
        codeSample: row.codeSample,
        redeemed: row.redeemed,
        maxRedemptions: row.maxRedemptions,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        pausedAt: row.pausedAt,
        bound: [...this.promo.partnerBindings.values()].filter((binding) => binding.campaignId === row.campaignId).length,
      }));
  }

  async create(partner: PartnerRow): Promise<void> {
    this.rows.set(partner.partnerId, partner);
    this.promo.partnerNames.set(partner.partnerId, partner.name);
  }

  async update(partnerId: string, input: PartnerInput, at: Date): Promise<{ before: PartnerRow; after: PartnerRow } | null> {
    const before = this.rows.get(partnerId);
    if (before === undefined) return null;
    const after = { ...before, ...input, updatedAt: at };
    this.rows.set(partnerId, after);
    this.promo.partnerNames.set(partnerId, after.name);
    return { before, after };
  }

  async names(): Promise<{ partnerId: string; name: string }[]> {
    return [...this.rows.values()].map((row) => ({ partnerId: row.partnerId, name: row.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async bindingOf(accountId: string): Promise<PartnerBindingView | null> {
    const binding = this.promo.partnerBindings.get(accountId);
    if (binding === undefined) return null;
    const campaign = this.promo.campaigns.get(binding.campaignId);
    return { partnerId: binding.partnerId, name: this.rows.get(binding.partnerId)?.name ?? "", boundAt: binding.boundAt, campaignTitle: campaign?.title ?? null, code: null };
  }

  private stats(partnerId: string, at: Date): PartnerStats {
    const campaigns = [...this.promo.campaigns.values()].filter((row) => row.partnerId === partnerId);
    const outcomes = this.outcomes.get(partnerId) ?? { played: 0, payers: 0, stars: 0 };
    return {
      codes: campaigns.length,
      activeCodes: campaigns.filter((row) => campaignState(row, at) === "active").length,
      redeemed: campaigns.reduce((sum, row) => sum + row.redeemed, 0),
      bound: [...this.promo.partnerBindings.values()].filter((binding) => binding.partnerId === partnerId).length,
      ...outcomes,
    };
  }
}
