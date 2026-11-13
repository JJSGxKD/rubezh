import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { withTimeout } from "../../common/with-timeout.js";
import { APP_CONFIG, type AppConfig } from "../../config/app-config.js";
import { REDIS } from "../../infra/redis.js";
import { PLATFORM_IDS, type PlatformId } from "../../platforms/ports/platform.js";
import { PaymentStatements, type PaymentStatement, type StatementEntry } from "../../platforms/ports/payment-statement.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";
import { SETTINGS } from "../settings/setting-catalog.js";
import { SETTINGS_READER, type SettingsReader } from "../settings/settings.service.js";
import {
  compare,
  DISCREPANCY_KINDS,
  DISCREPANCY_RESOLUTIONS,
  due,
  RECONCILE,
  settled,
  startOffset,
  windowOf,
  type DiscrepancyKind,
  type DiscrepancyResolution,
  type ReconcileTrigger,
} from "./payment-reconcile.js";
import { PAYMENT_RECONCILE_REPOSITORY, type DiscrepancyRow, type PaymentReconcileRepository } from "./payment-reconcile.repository.js";
import { PurchaseActionUnavailableError } from "./payments-errors.js";
import { PaymentsHooks } from "./payments-hooks.js";

/**
 * Сверка оплат с выпиской площадки (docs/35-stage4-plan.md, Р209, WP53,
 * tasks/T-0433): раз в сутки и по кнопке сервер читает выписку звёзд бота с
 * курсора, сравнивает её с покупками (`payment-reconcile.ts`), записывает
 * расхождения трёх видов и сообщает о новых команде. 11.11.2026 звёзды
 * списались, а покупки не записались, — и узнали об этом по сообщению о
 * брошенном задании; сверка находит такой сбой сама.
 *
 * - **Курсор — позиция в выписке.** Сверка начинает с позиции прошлой удачной
 *   минус перекрытие и читает страницы, пока страница полная и страниц меньше
 *   предела; недочитанное — со следующей сверкой. Ошибка площадки курсор не
 *   двигает, а остальные площадки идут дальше.
 * - **Одна сверка на все реплики** — лок Redis `SET NX PX`, снятие своим
 *   токеном (как `fulfillment-sweeper.ts`). Сверка не дольше лока: когда время
 *   подходит к его сроку, чтение останавливается на дочитанной странице.
 * - **Только чтение выписки и запись расхождений.** Очередь оплаты и
 *   записанные оплаты сверка не меняет; действия по расхождениям — T-0434.
 *
 * Модуль оплаты о Telegram не знает: выписку отдаёт порт площадки, а команде
 * сообщает слушатель `PaymentsHooks.onReconcileFound`.
 */

const LOCK_KEY = "payments:reconcile:lock";

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const ERROR_MAX = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const platformSchema = z.enum(PLATFORM_IDS);
const kindSchema = z.enum(DISCREPANCY_KINDS);
const resolutionSchema = z.enum(DISCREPANCY_RESOLUTIONS);

/** Итог сверки одной площадки. При ошибке `open` — 0: итог не посчитан. */
export interface ReconcileSummary {
  platform: PlatformId;
  scanned: number;
  found: number;
  matched: number;
  open: number;
  error: string | null;
}

export interface DiscrepancyView {
  discrepancyId: string;
  platform: PlatformId;
  kind: DiscrepancyKind;
  chargeId: string;
  purchaseId: string | null;
  accountId: string | null;
  displayName: string | null;
  payerId: string | null;
  amount: number;
  payload: string | null;
  occurredAt: Date;
  detectedAt: Date;
  resolution: DiscrepancyResolution | null;
  resolvedAt: Date | null;
  resolvedByName: string | null;
  note: string | null;
}

export interface ReconcileOverview {
  enabled: boolean;
  lastRuns: { platform: PlatformId; trigger: string; startedAt: Date; finishedAt: Date | null; scanned: number; found: number; error: string | null }[];
  open: DiscrepancyView[];
  resolved: DiscrepancyView[];
}

/** Разобранная строка расхождения: вид, решение и площадка — уже типы, имена игроков ещё не подставлены. */
interface ParsedRow {
  row: DiscrepancyRow;
  platform: PlatformId;
  kind: DiscrepancyKind;
  resolution: DiscrepancyResolution | null;
}

@Injectable()
export class PaymentReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger("payments");
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    // Классы, а не `Pick<…>`: метаданные декоратора превращают `Pick` в `Object`, и Nest не знает, что подставить.
    private readonly statements: PaymentStatements,
    @Inject(PAYMENT_RECONCILE_REPOSITORY) private readonly repository: PaymentReconcileRepository,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "eval">,
    @Inject(SETTINGS_READER) private readonly settings: SettingsReader,
    private readonly hooks: PaymentsHooks,
    private readonly roles: RolesService,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
  ) {}

  onApplicationBootstrap(): void {
    // Есть база для расхождений и хоть одна площадка с выпиской; иначе сверять нечем.
    if (!this.config.auth.enabled || this.statements.list().length === 0) return;
    this.timer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), RECONCILE.tickMs);
    }, RECONCILE.firstTickMs);
  }

  onModuleDestroy(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Выключатель — настройка панели: смотрится при каждом тике и нажатии, без перезапуска. */
  private enabled(): boolean {
    return this.settings.get(SETTINGS.paymentsReconcile);
  }

  /** Тик расписания: выключатель выключен — тишина; иначе сверка площадок, у которых срок вышел. `null` — не запускалась. */
  async tick(now = new Date()): Promise<ReconcileSummary[] | null> {
    if (!this.enabled()) return null;
    try {
      return await this.run("schedule", null, now);
    } catch (error: unknown) {
      this.log("warn", "reconcile_tick_failed", { reason: reasonOf(error) });
      return null;
    }
  }

  /**
   * Сверка всех площадок с выпиской под локом. `null` — лок у другой сверки;
   * Redis недоступен — исключение. По расписанию площадка, у которой удачная
   * сверка была недавно, пропускается: срок проверяется под локом, чтобы две
   * реплики, тикнувшие вместе, не сверяли одно и то же дважды подряд.
   */
  async run(trigger: ReconcileTrigger, actorAccountId: string | null, now: Date): Promise<ReconcileSummary[] | null> {
    const token = randomUUID();
    const startedMs = Date.now();
    const claimed = await this.redis.set(LOCK_KEY, token, "PX", RECONCILE.lockTtlMs, "NX");
    if (claimed === null) return null;
    // Чтение не должно пережить лок: последняя страница, начатая до этого срока, укладывается в оставшиеся секунды.
    const deadlineMs = startedMs + RECONCILE.lockTtlMs - RECONCILE.pageTimeoutMs;
    try {
      const summaries: ReconcileSummary[] = [];
      for (const statement of this.statements.list()) {
        if (summaries.length > 0 && Date.now() >= deadlineMs) break;
        const summary = await this.reconcile(statement, trigger, actorAccountId, now, deadlineMs);
        if (summary !== null) summaries.push(summary);
      }
      return summaries;
    } finally {
      await this.redis.eval(RELEASE_SCRIPT, 1, LOCK_KEY, token).catch((error: unknown) => {
        // Лок снимется сам по сроку; сверку это не отменяет.
        this.log("warn", "reconcile_unlock_failed", { reason: reasonOf(error) });
      });
    }
  }

  /** Кнопка «Сверить сейчас»: та же сверка сразу, синхронно в запросе. */
  async runNow(actor: AccountRef, now = new Date()): Promise<ReconcileSummary[]> {
    await this.roles.require(actor, "payments.support");
    if (!this.enabled()) throw new PurchaseActionUnavailableError("Сверка выключена в настройках");
    let summaries: ReconcileSummary[] | null;
    try {
      summaries = await this.run("manual", actor.accountId, now);
    } catch (error: unknown) {
      this.log("warn", "reconcile_lock_failed", { actorAccountId: actor.accountId, reason: reasonOf(error) });
      throw new PurchaseActionUnavailableError("Сверка сейчас недоступна: нет связи с Redis");
    }
    if (summaries === null) throw new PurchaseActionUnavailableError("Сверка уже идёт — подождите минуту");
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "payments.reconcile.run",
      target: null,
      after: {
        scanned: sum(summaries, (item) => item.scanned),
        found: sum(summaries, (item) => item.found),
        matched: sum(summaries, (item) => item.matched),
      },
    });
    return summaries;
  }

  /**
   * Обзор для панели: последняя сверка каждой площадки, открытые расхождения и
   * закрытые за 30 суток. Идентификатор плательщика на площадке — персональные
   * данные: без `players.pii.view` он стёрт, как в списке брошенных заданий.
   */
  async overview(actor: AccountRef, now = new Date()): Promise<ReconcileOverview> {
    await this.roles.require(actor, "payments.view");
    const rows = await this.repository.overview(now);
    const withPayer = await this.roles.can(actor, "players.pii.view");
    const open = this.parse(rows.open);
    const resolved = this.parse(rows.resolved);
    const ids = new Set<string>();
    for (const { row } of [...open, ...resolved]) {
      if (row.accountId !== null) ids.add(row.accountId);
      if (row.resolvedBy !== null) ids.add(row.resolvedBy);
    }
    const names = ids.size === 0 ? new Map<string, string>() : await this.accounts.displayNames([...ids]);
    const view = ({ row, platform, kind, resolution }: ParsedRow): DiscrepancyView => ({
      discrepancyId: row.discrepancyId,
      platform,
      kind,
      chargeId: row.chargeId,
      purchaseId: row.purchaseId,
      accountId: row.accountId,
      displayName: row.accountId === null ? null : (names.get(row.accountId) ?? null),
      payerId: withPayer ? row.payerId : null,
      amount: row.amount,
      payload: row.payload,
      occurredAt: row.occurredAt,
      detectedAt: row.detectedAt,
      resolution,
      resolvedAt: row.resolvedAt,
      resolvedByName: row.resolvedBy === null ? null : (names.get(row.resolvedBy) ?? null),
      note: row.note,
    });
    const lastRuns: ReconcileOverview["lastRuns"] = [];
    for (const run of rows.lastRuns) {
      const platform = platformSchema.safeParse(run.platform);
      if (!platform.success) {
        this.log("warn", "reconcile_row_skipped", { reason: "unknown_platform", platform: run.platform });
        continue;
      }
      lastRuns.push({ platform: platform.data, trigger: run.trigger, startedAt: run.startedAt, finishedAt: run.finishedAt, scanned: run.scanned, found: run.found, error: run.error });
    }
    return { enabled: this.enabled(), lastRuns, open: open.map(view), resolved: resolved.map(view) };
  }

  /**
   * Сверка одной площадки. `null` — по расписанию срок не вышел. Любая ошибка
   * площадки или базы заканчивается строкой сверки с ошибкой и без курсора:
   * следующая сверка начнёт с того же места, а остальные площадки не
   * страдают.
   */
  private async reconcile(statement: PaymentStatement, trigger: ReconcileTrigger, actorAccountId: string | null, now: Date, deadlineMs: number): Promise<ReconcileSummary | null> {
    const { platform } = statement;
    const startedMs = Date.now();
    const runId = randomUUID();
    const read: StatementEntry[] = [];
    let started = false;
    try {
      const last = await this.repository.lastFinished(platform);
      if (trigger === "schedule" && !due(last?.finishedAt ?? null, now)) return null;
      const fromOffset = startOffset(last?.toOffset ?? null);
      await this.repository.startRun({ runId, platform, trigger, actorAccountId, startedAt: now, fromOffset });
      started = true;

      const toOffset = await this.readPages(statement, fromOffset, deadlineMs, read);
      const entries: readonly StatementEntry[] = read;
      const statementCharges = new Set<string>();
      const statementPayments = new Set<string>();
      for (const entry of entries) {
        if (entry.kind === "other") continue;
        statementCharges.add(entry.id);
        if (entry.kind === "payment") statementPayments.add(entry.id);
      }

      // Открытые расхождения — до вставки новых: «закрылось само» относится только к прежним.
      const openRows = await this.repository.open(platform);
      const open = openRows.flatMap((row) => {
        const kind = kindSchema.safeParse(row.kind);
        return kind.success ? [{ discrepancyId: row.discrepancyId, kind: kind.data, chargeId: row.chargeId }] : [];
      });
      const purchases = await this.repository.purchasesByCharges([...new Set([...statementCharges, ...open.map((row) => row.chargeId)])]);
      const byCharge = new Map(purchases.map((purchase) => [purchase.chargeId, purchase]));
      const byPayload = await this.purchasesByPayload(entries, byCharge);
      const window = windowOf(entries);
      const paidInWindow = window === null ? [] : await this.repository.paidInWindow(platform, window.from, window.to);

      const found = compare({ entries, byCharge, byPayload, paidInWindow, now });
      const inserted = await this.repository.insertFound(runId, platform, found, now);

      const closing = settled(open, {
        recordedCharges: new Set(byCharge.keys()),
        refundedCharges: new Set(purchases.filter((purchase) => purchase.refundedAt !== null).map((purchase) => purchase.chargeId)),
        statementPayments,
      });
      const matched = closing.length === 0 ? 0 : await this.repository.resolveMatched(closing, now);

      const openAfter = openRows.length - matched + inserted.inserted;
      const covered = coverOf(entries);
      await this.repository.finishRun(runId, {
        finishedAt: finishedAt(now, startedMs),
        toOffset,
        coveredFrom: covered?.from ?? null,
        coveredTo: covered?.to ?? null,
        scanned: entries.length,
        found: inserted.inserted,
        matched,
        error: null,
      });

      this.log("log", "reconcile_finished", { platform, trigger, fromOffset, toOffset, scanned: entries.length, found: inserted.inserted, matched, open: openAfter });
      const kinds: Partial<Record<DiscrepancyKind, number>> = {};
      for (const item of inserted.items) {
        kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
        this.log("warn", "discrepancy_found", { platform, kind: item.kind, chargeId: item.chargeId, purchaseId: item.purchaseId });
      }
      if (inserted.inserted > 0) await this.hooks.emitReconcileFound({ platform, found: inserted.inserted, open: openAfter, kinds, at: now });
      return { platform, scanned: entries.length, found: inserted.inserted, matched, open: openAfter, error: null };
    } catch (error: unknown) {
      const reason = clipError(error);
      this.log("warn", "reconcile_failed", { platform, trigger, reason });
      if (started) {
        // Курсор не пишется: следующая сверка начнёт с того же места. Прочитанное — для разбора, не для курсора.
        const covered = coverOf(read);
        await this.repository
          .finishRun(runId, { finishedAt: finishedAt(now, startedMs), toOffset: null, coveredFrom: covered?.from ?? null, coveredTo: covered?.to ?? null, scanned: read.length, found: 0, matched: 0, error: reason })
          .catch((writeError: unknown) => this.log("error", "reconcile_run_unwritten", { platform, runId, reason: reasonOf(writeError) }));
      }
      return { platform, scanned: read.length, found: 0, matched: 0, open: 0, error: reason };
    }
  }

  /**
   * Страницы выписки с `fromOffset`, пока страница полная и страниц меньше
   * предела; прочитанное складывается в `into` — сбой посреди чтения не
   * теряет то, что уже пришло. Ответ — позиция, до которой дочитали.
   */
  private async readPages(statement: PaymentStatement, fromOffset: number, deadlineMs: number, into: StatementEntry[]): Promise<number> {
    // Страница площадки не бывает больше её потолка: короткая страница — это конец, а не недобор.
    const limit = Math.min(RECONCILE.pageSize, statement.pageMax);
    let offset = fromOffset;
    for (let page = 0; page < RECONCILE.maxPages; page += 1) {
      // Время вышло — недочитанное остаётся следующей сверке: курсор встанет на дочитанное.
      if (page > 0 && Date.now() >= deadlineMs) break;
      const chunk = await withTimeout(statement.page(offset, limit), RECONCILE.pageTimeoutMs, `выписка ${statement.platform}`);
      into.push(...chunk);
      offset += chunk.length;
      if (chunk.length < limit) break;
    }
    return offset;
  }

  /**
   * Покупки по `payload` оплат выписки, которых у нас нет: так расхождение
   * называет игрока. В базу идут только настоящие UUID — счёт приходит от
   * площадки, и мусор в нём не должен стать ошибкой запроса.
   */
  private async purchasesByPayload(entries: readonly StatementEntry[], byCharge: ReadonlyMap<string, unknown>): Promise<Map<string, { purchaseId: string; accountId: string }>> {
    const payloads = new Set<string>();
    for (const entry of entries) {
      if (entry.kind === "payment" && !byCharge.has(entry.id) && entry.payload !== null && UUID.test(entry.payload)) payloads.add(entry.payload);
    }
    const byPayload = new Map<string, { purchaseId: string; accountId: string }>();
    if (payloads.size === 0) return byPayload;
    const refs = new Map((await this.repository.purchasesByIds([...payloads])).map((ref) => [ref.purchaseId, ref]));
    for (const payload of payloads) {
      // База отдаёт UUID строчными, а счёт мог прийти в другом регистре.
      const ref = refs.get(payload.toLowerCase());
      if (ref !== undefined) byPayload.set(payload, ref);
    }
    return byPayload;
  }

  /** Строки базы — в типы; незнакомое значение (запись более новой версии) пропускается с предупреждением, а не роняет обзор. */
  private parse(rows: readonly DiscrepancyRow[]): ParsedRow[] {
    const parsed: ParsedRow[] = [];
    for (const row of rows) {
      const platform = platformSchema.safeParse(row.platform);
      const kind = kindSchema.safeParse(row.kind);
      const resolution = row.resolution === null ? null : resolutionSchema.safeParse(row.resolution);
      if (!platform.success || !kind.success || (resolution !== null && !resolution.success)) {
        this.log("warn", "reconcile_row_skipped", { reason: "unknown_value", discrepancyId: row.discrepancyId, chargeId: row.chargeId, platform: row.platform, kind: row.kind, resolution: row.resolution });
        continue;
      }
      parsed.push({ row, platform: platform.data, kind: kind.data, resolution: resolution === null ? null : resolution.data });
    }
    return parsed;
  }

  private log(level: "log" | "warn" | "error", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "payments", event, ...fields }));
  }
}

/** Время окончания: логическое «сейчас» сверки плюс то, сколько она шла на самом деле. */
function finishedAt(now: Date, startedMs: number): Date {
  return new Date(now.getTime() + (Date.now() - startedMs));
}

/** Время первой и последней прочитанной операции; пустая выписка — `null`. */
function coverOf(entries: readonly StatementEntry[]): { from: Date; to: Date } | null {
  let from: Date | null = null;
  let to: Date | null = null;
  for (const entry of entries) {
    if (from === null || entry.at < from) from = entry.at;
    if (to === null || entry.at > to) to = entry.at;
  }
  return from === null || to === null ? null : { from, to };
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
  return items.reduce((total, item) => total + pick(item), 0);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown";
}

/** Ошибка для строки сверки: одной строкой, первые 300 знаков по кодовым точкам. */
function clipError(error: unknown): string {
  return [...reasonOf(error).replace(/\s+/g, " ").trim()].slice(0, ERROR_MAX).join("");
}
