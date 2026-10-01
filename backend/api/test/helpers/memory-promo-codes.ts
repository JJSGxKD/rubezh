import type { PromoCampaignRow, PromoCampaignUpdate, PromoReward } from "../../src/modules/promo-codes/promo-code-rules.js";
import type {
  CodeLookup,
  CreateOutcome,
  NewPromoCampaign,
  PromoCodeDraft,
  PromoCodesRepository,
  RedeemOutcome,
  RemoveOutcome,
  UpdateOutcome,
} from "../../src/modules/promo-codes/promo-codes.repository.js";

interface CodeRow {
  code: string;
  display: string;
  campaignId: string;
  redeemedBy: string | null;
  redeemedAt: Date | null;
}

interface RedemptionRow {
  campaignId: string;
  accountId: string;
  code: string;
  redeemedAt: Date;
  rewardedAt: Date | null;
  credited: PromoReward | null;
}

/** Промокоды в памяти — с теми же отказами, что у транзакции базы. */
export class MemoryPromoCodesRepository implements PromoCodesRepository {
  readonly campaigns = new Map<string, Omit<PromoCampaignRow, "codeSample">>();
  readonly codeRows = new Map<string, CodeRow>();
  readonly redemptions: RedemptionRow[] = [];
  /** следующая запись погашения «упадёт» после занятия кода — так проверяется доначисление */
  failMarkRewarded = false;

  async list(limit: number): Promise<PromoCampaignRow[]> {
    return [...this.campaigns.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((row) => this.withSample(row));
  }

  async byId(campaignId: string): Promise<PromoCampaignRow | null> {
    const row = this.campaigns.get(campaignId);
    return row === undefined ? null : this.withSample(row);
  }

  async codeOwner(key: string): Promise<{ display: string; title: string } | null> {
    const code = this.codeRows.get(key);
    if (code === undefined) return null;
    return { display: code.display, title: this.campaigns.get(code.campaignId)?.title ?? "" };
  }

  async create(campaign: NewPromoCampaign, codes: readonly PromoCodeDraft[], refill: ((count: number) => PromoCodeDraft[]) | null): Promise<CreateOutcome> {
    const accepted: PromoCodeDraft[] = [];
    let pending = [...codes];
    for (let round = 0; pending.length > 0; round += 1) {
      const clashed = pending.filter((draft) => this.codeRows.has(draft.code) || accepted.some((other) => other.code === draft.code));
      accepted.push(...pending.filter((draft) => !clashed.includes(draft)));
      if (clashed.length === 0) break;
      if (refill === null || round >= 5) {
        const owner = await this.codeOwner(clashed[0]?.code ?? "");
        return { status: "taken", display: owner?.display ?? "", title: owner?.title ?? "" };
      }
      pending = refill(clashed.length);
    }
    this.campaigns.set(campaign.campaignId, { ...campaign, redeemed: 0, pausedAt: null, updatedAt: campaign.createdAt });
    for (const draft of accepted) this.codeRows.set(draft.code, { ...draft, campaignId: campaign.campaignId, redeemedBy: null, redeemedAt: null });
    return { status: "created", row: this.withSample(this.campaigns.get(campaign.campaignId) as Omit<PromoCampaignRow, "codeSample">) };
  }

  async update(campaignId: string, update: PromoCampaignUpdate, at: Date, check: (current: PromoCampaignRow) => string | null): Promise<UpdateOutcome> {
    const current = this.campaigns.get(campaignId);
    if (current === undefined) return { status: "missing" };
    const before = this.withSample(current);
    const problem = check(before);
    if (problem !== null) return { status: "invalid", message: problem };
    const next = { ...current, ...update, updatedAt: at };
    this.campaigns.set(campaignId, next);
    return { status: "updated", before, after: this.withSample(next) };
  }

  async setPaused(campaignId: string, pausedAt: Date | null, at: Date): Promise<PromoCampaignRow | null> {
    const current = this.campaigns.get(campaignId);
    if (current === undefined) return null;
    const next = { ...current, pausedAt, updatedAt: at };
    this.campaigns.set(campaignId, next);
    return this.withSample(next);
  }

  async remove(campaignId: string): Promise<RemoveOutcome> {
    const current = this.campaigns.get(campaignId);
    if (current === undefined) return { status: "missing" };
    if (current.redeemed > 0) return { status: "used", redeemed: current.redeemed };
    this.campaigns.delete(campaignId);
    for (const [key, code] of this.codeRows) if (code.campaignId === campaignId) this.codeRows.delete(key);
    return { status: "removed", row: this.withSample(current) };
  }

  async codes(campaignId: string, limit: number): Promise<{ display: string; redeemedAt: Date | null }[]> {
    return [...this.codeRows.values()]
      .filter((code) => code.campaignId === campaignId)
      .sort((a, b) => a.display.localeCompare(b.display))
      .slice(0, limit)
      .map((code) => ({ display: code.display, redeemedAt: code.redeemedAt }));
  }

  async daily(campaignId: string, since: Date): Promise<{ day: string; count: number }[]> {
    const counts = new Map<string, number>();
    for (const row of this.redemptions) {
      if (row.campaignId !== campaignId || row.redeemedAt < since) continue;
      // Игровые сутки — по Москве, UTC+3.
      const day = new Date(row.redeemedAt.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
      counts.set(day, (counts.get(day) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count }));
  }

  async lookup(key: string): Promise<CodeLookup | null> {
    const code = this.codeRows.get(key);
    if (code === undefined) return null;
    const campaign = await this.byId(code.campaignId);
    return campaign === null ? null : { code: code.code, display: code.display, redeemedBy: code.redeemedBy, campaign };
  }

  async redemption(campaignId: string, accountId: string): Promise<{ rewardedAt: Date | null } | null> {
    const row = this.redemptions.find((candidate) => candidate.campaignId === campaignId && candidate.accountId === accountId);
    return row === undefined ? null : { rewardedAt: row.rewardedAt };
  }

  async redeem(input: { campaignId: string; accountId: string; code: string; batch: boolean; at: Date }): Promise<RedeemOutcome> {
    if (this.redemptions.some((row) => row.campaignId === input.campaignId && row.accountId === input.accountId)) return "already";
    const code = this.codeRows.get(input.code);
    if (input.batch && (code === undefined || code.redeemedBy !== null)) return "used";
    const campaign = this.campaigns.get(input.campaignId);
    if (campaign === undefined || (campaign.maxRedemptions !== null && campaign.redeemed >= campaign.maxRedemptions)) return "exhausted";
    if (input.batch && code !== undefined) {
      code.redeemedBy = input.accountId;
      code.redeemedAt = input.at;
    }
    campaign.redeemed += 1;
    this.redemptions.push({ campaignId: input.campaignId, accountId: input.accountId, code: input.code, redeemedAt: input.at, rewardedAt: null, credited: null });
    return "redeemed";
  }

  async markRewarded(campaignId: string, accountId: string, credited: PromoReward, at: Date): Promise<void> {
    if (this.failMarkRewarded) {
      this.failMarkRewarded = false;
      throw new Error("база недоступна");
    }
    const row = this.redemptions.find((candidate) => candidate.campaignId === campaignId && candidate.accountId === accountId);
    if (row !== undefined && row.rewardedAt === null) {
      row.rewardedAt = at;
      row.credited = credited;
    }
  }

  private withSample(row: Omit<PromoCampaignRow, "codeSample">): PromoCampaignRow {
    const first = [...this.codeRows.values()].filter((code) => code.campaignId === row.campaignId).sort((a, b) => a.code.localeCompare(b.code))[0];
    return { ...row, codeSample: first?.display ?? "" };
  }
}
