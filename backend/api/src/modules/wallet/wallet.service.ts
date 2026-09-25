import { Inject, Injectable, Logger } from "@nestjs/common";
import { ForbiddenError, ValidationError } from "../../common/domain-error.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import type { AccountRef } from "../roles/roles.service.js";
import { RolesService } from "../roles/roles.service.js";
import { EXCHANGE_RESOURCES, WALLET_DAILY_CAPS, WALLET_MAX_OPERATION } from "./wallet-limits.js";
import { IdempotencyConflictError, InsufficientFundsError } from "./wallet-errors.js";
import { WALLET_REPOSITORY, type ExistingEntry, type WalletEntryRow, type WalletRepository } from "./wallet.repository.js";
import {
  ADMIN_REASON,
  isEarnReason,
  type Balances,
  type GrantReason,
  type SpendReason,
  type WalletResource,
} from "./wallet-types.js";

/**
 * Кошелёк (docs/35-stage4-plan.md, WP3): начисление, списание, балансы,
 * ручная операция из панели.
 *
 * Ключ идемпотентности собирает вызывающий из того, что делает операцию
 * единственной: `run:<runId>:coins`, `purchase:<chargeId>`. Не из суммы и не
 * из времени — два честных забега с одинаковой наградой обязаны дать две
 * строки.
 */

/**
 * Длина ключа: у списания к нему дописывается ресурс, а колонка — 160
 * символов.
 */
const MAX_KEY_LENGTH = 140;

export interface GrantInput {
  accountId: string;
  resource: WalletResource;
  amount: number;
  reason: GrantReason;
  source?: string | null;
  idempotencyKey: string;
  at?: Date;
}

export interface GrantResult {
  /** сколько легло на баланс; меньше запрошенного — упёрлись в суточный потолок */
  credited: number;
  balance: number;
  /** операция с этим ключом уже была: ничего не изменилось */
  duplicate: boolean;
}

export interface SpendInput {
  accountId: string;
  lines: readonly { resource: WalletResource; amount: number }[];
  reason: SpendReason;
  source?: string | null;
  idempotencyKey: string;
  at?: Date;
}

export interface SpendResult {
  balances: Balances;
  duplicate: boolean;
}

export interface AdjustInput {
  accountId: string;
  resource: WalletResource;
  /** со знаком: плюс — начислить, минус — списать */
  delta: number;
  /** зачем — для журнала аудита */
  note: string;
  idempotencyKey: string;
}

export interface AdjustResult {
  /** на сколько изменился баланс, со знаком */
  applied: number;
  balance: number;
  duplicate: boolean;
}

@Injectable()
export class WalletService {
  private readonly logger = new Logger("wallet");

  constructor(
    @Inject(WALLET_REPOSITORY) private readonly repository: WalletRepository,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly roles: RolesService,
  ) {}

  async balances(accountId: string): Promise<Balances> {
    return await this.repository.balances(accountId);
  }

  async recentEntries(accountId: string, limit: number): Promise<WalletEntryRow[]> {
    return await this.repository.recentEntries(accountId, limit);
  }

  async grant(input: GrantInput): Promise<GrantResult> {
    checkAmount(input.amount);
    checkKey(input.idempotencyKey);
    const outcome = await this.repository.credit({
      accountId: input.accountId,
      resource: input.resource,
      amount: input.amount,
      reason: input.reason,
      source: input.source ?? null,
      idempotencyKey: input.idempotencyKey,
      dailyCap: dailyCapOf(input.reason, input.resource),
      at: input.at ?? new Date(),
    });

    if (outcome.status === "duplicate") {
      ensureSameOperation(outcome.existing, input.accountId, input.reason, input.resource);
      return { credited: outcome.existing.amount, balance: outcome.balance, duplicate: true };
    }
    // Пишется только тот раз, когда начисление обрезалось: дальше в сутках
    // источник даёт нули молча, и лог не растёт вместе с накруткой.
    if (outcome.credited > 0 && outcome.credited < input.amount) {
      this.logger.warn(JSON.stringify({ module: "wallet", event: "daily_cap_reached", accountId: input.accountId, reason: input.reason, resource: input.resource }));
    }
    return { credited: outcome.credited, balance: outcome.balance, duplicate: false };
  }

  /** Трата. Не хватило хоть одного ресурса — не списано ничего, и бросается `InsufficientFundsError`. */
  async spend(input: SpendInput): Promise<SpendResult> {
    checkKey(input.idempotencyKey);
    return await this.debit({ ...input, source: input.source ?? null });
  }

  /**
   * Ручная операция из панели (§3.2): под правом, с причиной и записью в
   * аудит. Себе нельзя — иначе право начислять оказалось бы правом
   * начислять себе; исключение — машина разработчика, где владелец и игрок —
   * один человек.
   */
  async adjust(actor: AccountRef, input: AdjustInput): Promise<AdjustResult> {
    await this.roles.require(actor, "players.wallet.adjust");
    if (actor.accountId === input.accountId && !this.config.auth.devLogin) throw new ForbiddenError("Менять свой кошелёк нельзя");
    if (input.delta === 0) throw new ValidationError("Изменение не может быть нулевым");
    // Своё пространство ключей: ключ из панели не займёт ключ забега или покупки.
    const idempotencyKey = `adjust:${input.idempotencyKey}`;
    checkKey(idempotencyKey);

    const before = (await this.repository.balances(input.accountId))[input.resource];
    const source = `admin:${actor.accountId}`;
    const result: AdjustResult =
      input.delta > 0
        ? await this.grant({ accountId: input.accountId, resource: input.resource, amount: input.delta, reason: ADMIN_REASON, source, idempotencyKey }).then(
            (granted) => ({ applied: granted.credited, balance: granted.balance, duplicate: granted.duplicate }),
          )
        : await this.debit({
            accountId: input.accountId,
            lines: [{ resource: input.resource, amount: -input.delta }],
            reason: ADMIN_REASON,
            source,
            idempotencyKey,
          }).then((spent) => ({ applied: input.delta, balance: spent.balances[input.resource], duplicate: spent.duplicate }));

    if (!result.duplicate) {
      await this.roles.audit({
        actorAccountId: actor.accountId,
        action: "wallet.adjust",
        target: input.accountId,
        before: { resource: input.resource, balance: before },
        after: { resource: input.resource, balance: result.balance, delta: input.delta, note: input.note },
      });
    }
    return result;
  }

  private async debit(input: {
    accountId: string;
    lines: readonly { resource: WalletResource; amount: number }[];
    reason: SpendReason | typeof ADMIN_REASON;
    source: string | null;
    idempotencyKey: string;
    at?: Date;
  }): Promise<SpendResult> {
    checkLines(input.lines);
    const outcome = await this.repository.debit({ ...input, at: input.at ?? new Date() });
    if (outcome.status === "insufficient") throw new InsufficientFundsError(outcome.resource, outcome.needed, outcome.balance);
    if (outcome.status === "duplicate") {
      ensureSameOperation(outcome.existing, input.accountId, input.reason, outcome.existing.resource);
      return { balances: await this.repository.balances(input.accountId), duplicate: true };
    }
    return { balances: await this.repository.balances(input.accountId), duplicate: false };
  }
}

/**
 * Потолок источника на сутки. Источник, которому ресурс не разрешён, — ошибка
 * вызывающего кода, а не игрока: такое начисление не должно пройти ни разу.
 */
function dailyCapOf(reason: GrantReason, resource: WalletResource): number | null {
  if (reason === ADMIN_REASON) return null;
  if (isEarnReason(reason)) {
    const cap = WALLET_DAILY_CAPS[reason][resource];
    if (cap === undefined) throw new Error(`источник ${reason} не начисляет ${resource} — добавьте потолок в wallet-limits.ts`);
    return cap;
  }
  if (!EXCHANGE_RESOURCES[reason].includes(resource)) throw new Error(`обмен ${reason} не даёт ${resource}`);
  return null;
}

function ensureSameOperation(existing: ExistingEntry, accountId: string, reason: string, resource: WalletResource): void {
  if (existing.accountId !== accountId || existing.reason !== reason || existing.resource !== resource) throw new IdempotencyConflictError();
}

function checkAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ValidationError("Сумма — целое больше нуля");
  if (amount > WALLET_MAX_OPERATION) throw new ValidationError("Сумма больше предела одной операции");
}

function checkKey(key: string): void {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) throw new ValidationError("Некорректный ключ операции");
}

function checkLines(lines: readonly { resource: WalletResource; amount: number }[]): void {
  if (lines.length === 0) throw new ValidationError("Трата без строк");
  if (new Set(lines.map((line) => line.resource)).size !== lines.length) throw new ValidationError("Ресурс в трате повторяется");
  for (const line of lines) checkAmount(line.amount);
}
