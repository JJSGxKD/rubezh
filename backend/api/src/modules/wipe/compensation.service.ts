import { Inject, Injectable, Logger } from "@nestjs/common";
import { DomainError } from "../../common/domain-error.js";
import { WALLET_RESOURCES, type Balances, type WalletResource } from "../wallet/wallet-types.js";
import { WalletService } from "../wallet/wallet.service.js";
import { COMPENSATION_REPOSITORY, type CompensationRepository, type CompensationRow } from "./compensation.repository.js";
import { compensationGrantsSchema, continueGems, type CompensationGrant } from "./compensation-rules.js";

/**
 * Выдача компенсации после вайпа (docs/35-stage4-plan.md, Р87, WP33,
 * tasks/T-0042): что положено игроку и выдача по кнопке «Забрать», один раз.
 * Строку компенсации писал снимок перед вайпом (T-0040); здесь она только
 * читается и отмечается.
 */

/** Строки компенсации нет: игрок не был тестером до вайпа, или снимок не писался. */
export class CompensationNotFoundError extends DomainError {
  constructor() {
    super("compensation_not_found", "Компенсации нет", 404);
  }
}

export interface CompensationView {
  tester: boolean;
  level: number;
  bonusGems: number;
  /** что вернулось из купленного — суммой по ресурсу, в порядке WALLET_RESOURCES */
  restored: { resource: WalletResource; amount: number }[];
  /** самоцветы за второй шанс, купленный за звёзды: `continueGems(continueStars)` */
  continueGems: number;
}

export interface ClaimResult {
  view: CompensationView;
  /** `true` — уже забирал раньше: этим вызовом ничего не начислено */
  alreadyClaimed: boolean;
  balances: Balances;
}

@Injectable()
export class CompensationService {
  private readonly logger = new Logger("wipe");

  constructor(
    @Inject(COMPENSATION_REPOSITORY) private readonly repository: CompensationRepository,
    private readonly wallet: WalletService,
  ) {}

  /** Что положено, пока не забрано; нет строки или уже забрано — `null`. */
  async pending(accountId: string): Promise<CompensationView | null> {
    const row = await this.repository.find(accountId);
    if (row === null || row.claimedAt !== null) return null;
    return viewOf(row, grantsOf(row));
  }

  /**
   * Выдать компенсацию. **Начисления — до отметки «забрано»**: сбой между ними
   * безопасен, потому что повтор найдёт строки журнала по ключам и не начислит
   * дважды, а отметка раньше начислений потеряла бы выдачу навсегда.
   *
   * **Купленное возвращается прежним ключом** `purchase:<purchaseId>:<ресурс>`
   * и причиной `purchase`: после вайпа этих строк в журнале нет, ключ свободен,
   * а если за покупку потом вернут звёзды, отзыв остатка (T-0023) найдёт
   * начисление по тому же ключу и заберёт его как обычно. Бонус и самоцветы за
   * второй шанс — причина `wipe_compensation`, свои ключи на аккаунт.
   *
   * Повтор после отметки отвечает тем же результатом, а не ошибкой. Два нажатия
   * одновременно начислят один раз (ключи), а отметку поставит только одно.
   */
  async claim(accountId: string, now = new Date()): Promise<ClaimResult> {
    const row = await this.repository.find(accountId);
    if (row === null) throw new CompensationNotFoundError();
    const grants = grantsOf(row);
    const view = viewOf(row, grants);
    if (row.claimedAt !== null) return { view, alreadyClaimed: true, balances: await this.wallet.balances(accountId) };

    for (const grant of grants) {
      await this.wallet.grant({
        accountId,
        resource: grant.resource,
        amount: grant.amount,
        reason: "purchase",
        source: "wipe:restore",
        idempotencyKey: `purchase:${grant.purchaseId}:${grant.resource}`,
      });
    }
    if (row.bonusGems > 0) {
      await this.wallet.grant({ accountId, resource: "gems", amount: row.bonusGems, reason: "wipe_compensation", source: "wipe:tester_bonus", idempotencyKey: `wipe:${accountId}:bonus` });
    }
    if (view.continueGems > 0) {
      await this.wallet.grant({ accountId, resource: "gems", amount: view.continueGems, reason: "wipe_compensation", source: "wipe:continue", idempotencyKey: `wipe:${accountId}:continue` });
    }

    const marked = await this.repository.markClaimed(accountId, now);
    const balances = await this.wallet.balances(accountId);
    // Пишется только тот раз, когда отметку поставили мы: повторы и проигравший гонку лог не растят.
    if (marked) {
      const restoredGems = view.restored.find((item) => item.resource === "gems")?.amount ?? 0;
      this.logger.log(
        JSON.stringify({ module: "wipe", event: "compensation_claimed", accountId, tester: row.tester, bonusGems: row.bonusGems, restoredGems, continueGems: view.continueGems }),
      );
    }
    return { view, alreadyClaimed: !marked, balances };
  }
}

/**
 * `grants` пишет наш снимок, поэтому строка, что не разобралась, — ошибка в
 * коде, а не в данных игрока: падаем с аккаунтом, не пытаясь выдать часть.
 */
function grantsOf(row: CompensationRow): CompensationGrant[] {
  const parsed = compensationGrantsSchema.safeParse(row.grants);
  if (!parsed.success) throw new Error(`компенсация аккаунта ${row.accountId}: grants не разобрались — ${parsed.error.message}`);
  return parsed.data;
}

function viewOf(row: CompensationRow, grants: readonly CompensationGrant[]): CompensationView {
  const totals = new Map<WalletResource, number>();
  for (const grant of grants) totals.set(grant.resource, (totals.get(grant.resource) ?? 0) + grant.amount);
  return {
    tester: row.tester,
    level: row.level,
    bonusGems: row.bonusGems,
    restored: WALLET_RESOURCES.flatMap((resource) => {
      const amount = totals.get(resource);
      return amount === undefined ? [] : [{ resource, amount }];
    }),
    continueGems: continueGems(row.continueStars),
  };
}
