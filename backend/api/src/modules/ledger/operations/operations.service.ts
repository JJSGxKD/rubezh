import { randomUUID } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { MissingRateError, fromMinorUnits, isCurrencyCode, payoutUsdPerUnit, type RatesSnapshot } from "@bh/fx";
import { toMinor } from "@bh/ledger";
import { ForbiddenError, ValidationError } from "../../../common/domain-error.js";
import { withTimeout } from "../../../common/with-timeout.js";
import { FxService } from "../../fx/fx.service.js";
import { RolesService, type AccountRef } from "../../roles/roles.service.js";
import type { FeeTemplate, FeeView } from "../ledger-chart.js";
import { LedgerChartService } from "../ledger-chart.service.js";
import { currencySpec } from "../ledger-currencies.js";
import { decodeCursor, encodeCursor } from "../ledger-cursor.js";
import { DEFAULT_JOURNAL_LIMIT, LedgerService, MAX_JOURNAL_LIMIT } from "../ledger.service.js";
import {
  applyFeeTemplate,
  buildOperation,
  commonProblems,
  operationSourceKey,
  roundUsd,
  type BuildProblem,
  type BuiltOperation,
  type ChartPlace,
  type EstimateBasis,
  type OperationsChart,
} from "./builders.js";
import { LedgerOperationInvalidError, LedgerOperationNotDraftError, LedgerOperationNotFoundError, LedgerOperationTemplateTakenError, LedgerOperationVanishedError } from "./operation-errors.js";
import { operationInputSchema, splitInput, type OperationInput } from "./operation-input.js";
import { inputOf, operationView, type OperationPage, type OperationView } from "./operation-view.js";
import { OPERATIONS_REPOSITORY, type OperationFilter, type OperationsRepository, type StoredOperation } from "./operations.repository.js";

/**
 * Ручные операции учёта (docs/37-accounting.md §4, Р220, tasks/T-0461): человек описывает событие понятными
 * полями, сервер собирает из него проводку двойной записи, проверяет и пишет в журнал. Черновик правится и
 * удаляется, проведённая операция не меняется — исправление только сторно. Проводка идёт под ключом `op:<id>`,
 * поэтому повторное проведение — та же проводка, а не вторая. Право на изменение проверяет охранник маршрута
 * (`finance.entry.create`); здесь — кто может править чужой черновик и аудит каждого действия.
 */

export type OperationActor = AccountRef;

/** Из какого шаблона повторяющегося расхода создан черновик (tasks/T-0463) и за какой месяц. */
export interface OperationTemplateRef {
  templateId: string;
  period: string;
}

const FX_TIMEOUT_MS = 5_000;
/** Сколько проблем показываем в одном отказе: остальные видны после исправления этих. */
const MAX_PROBLEMS_SHOWN = 5;

const NO_FEE: FeeTemplate = { percentBp: null, fixed: null, fixedCurrency: null };

/** Шаблон комиссии из вида места: фикса в виде — десятичной строкой, для сборщика нужны минимальные единицы. */
function feeTemplateOf(fee: FeeView | null): FeeTemplate {
  if (fee === null) return NO_FEE;
  const fixedCurrency = fee.fixedCurrency;
  return {
    percentBp: fee.percentBp,
    fixed: fee.fixed === null || fixedCurrency === null ? null : toMinor(fee.fixed, currencySpec(fixedCurrency)),
    fixedCurrency,
  };
}

function invalid(problems: readonly BuildProblem[]): LedgerOperationInvalidError {
  const shown = problems.slice(0, MAX_PROBLEMS_SHOWN).map((problem) => problem.message);
  const more = problems.length > MAX_PROBLEMS_SHOWN ? ` (и ещё ${String(problems.length - MAX_PROBLEMS_SHOWN)})` : "";
  return new LedgerOperationInvalidError(`${shown.join("; ")}${more}`);
}

@Injectable()
export class OperationsService {
  private readonly logger = new Logger("ledger-operations");

  constructor(
    @Inject(OPERATIONS_REPOSITORY) private readonly repository: OperationsRepository,
    private readonly ledger: LedgerService,
    private readonly chart: LedgerChartService,
    private readonly fx: FxService,
    private readonly roles: RolesService,
  ) {}

  /**
   * Черновик: поля проверены, сборка проходит, размер оценён по курсам на сейчас. Комиссия перевода и обмена не
   * задана — подставляется шаблон места списания. `template` — черновик из шаблона расхода: на период он один.
   */
  async create(actor: OperationActor, raw: OperationInput, template?: OperationTemplateRef): Promise<OperationView> {
    const operationId = randomUUID();
    const prepared = await this.prepare(operationId, raw);
    const { fields, note, link } = splitInput(prepared.input);
    const outcome = await this.repository.insert({
      operationId,
      kind: prepared.input.kind,
      input: fields,
      note,
      link,
      amountUsd: prepared.amountUsd,
      createdBy: actor.accountId,
      templateId: template?.templateId ?? null,
      templatePeriod: template?.period ?? null,
    });
    if (outcome === "template_taken") {
      // Уникальным остаётся только шаблон с периодом: без шаблона такого исхода быть не может.
      throw template === undefined ? new Error("Операция не записана: уникальный ключ уже занят") : new LedgerOperationTemplateTakenError(template.templateId, template.period);
    }
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.operation.create", target: operationId, after: { kind: prepared.input.kind, note, amountUsd: prepared.amountUsd } });
    return await this.get(operationId);
  }

  /** Правка черновика целиком: тело заменяет ввод. Автор или владелец; проведённая операция и черновик с уже записанной проводкой не правятся. */
  async update(actor: OperationActor, operationId: string, raw: OperationInput): Promise<OperationView> {
    const stored = await this.stored(operationId);
    if (stored.status !== "draft") throw new LedgerOperationNotDraftError(operationId, stored.status);
    if (stored.createdBy !== actor.accountId && !(await this.isOwner(actor))) throw new ForbiddenError("Править черновик может его автор или владелец");
    // Проводка уже записана, отметки ещё нет (сбой между ними): ввод теперь описывает проводку в журнале. Другой ввод
    // под тем же ключом `op:<id>` вышел бы «ключ занят другими строками», и операция застряла бы навсегда.
    if (await this.repository.entryExists(operationSourceKey(operationId))) throw new LedgerOperationNotDraftError(operationId, "posted");

    const prepared = await this.prepare(operationId, raw);
    const { fields, note, link } = splitInput(prepared.input);
    const updated = await this.repository.updateDraft(operationId, { kind: prepared.input.kind, input: fields, note, link, amountUsd: prepared.amountUsd });
    // Между чтением и записью черновик успели провести или удалить.
    if (!updated) throw new LedgerOperationNotDraftError(operationId, (await this.repository.byId(operationId))?.status ?? "posted");
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.operation.update", target: operationId, before: { kind: stored.kind }, after: { kind: prepared.input.kind, amountUsd: prepared.amountUsd } });
    return await this.get(operationId);
  }

  /**
   * Провести черновик: сборка, проводка `op:<id>` и отметка «проведена». Повтор проведённой операции отдаёт её же
   * без второй проводки; сбой между проводкой и отметкой лечится повтором — проводка с теми же строками это та же
   * проводка. Для займа условия записываются в той же транзакции, что и отметка.
   */
  async submit(actor: OperationActor, operationId: string): Promise<OperationView> {
    const stored = await this.stored(operationId);
    if (stored.status === "posted") return await this.view(stored);
    if (stored.status !== "draft") throw new LedgerOperationNotDraftError(operationId, stored.status);

    const input = inputOf(stored);
    const sourceKey = operationSourceKey(operationId);
    const ledgerActor = { accountId: actor.accountId };
    let built: BuiltOperation | null = null;
    let entryId: string;
    if (input.kind === "reversal") {
      const problems = commonProblems(input, new Date());
      if (problems.length > 0) throw invalid(problems);
      entryId = (await this.ledger.reverse(input.sourceKey, sourceKey, new Date(input.at), input.note, ledgerActor)).entryId;
    } else {
      const result = buildOperation(operationId, input, await this.loadChart(), new Date());
      if (!result.ok) throw invalid(result.problems);
      built = result.built;
      await this.ensureAccounts(built);
      entryId = (await this.ledger.post(built.draft, ledgerActor)).entryId;
    }

    const loan = built?.loan ?? null;
    const outcome = await this.repository.markPosted(operationId, sourceKey, loan === null ? null : { loanId: randomUUID(), ...loan });
    if (outcome === "missing") {
      this.logger.error(`Операцию ${operationId} удалили в момент проведения: проводка ${sourceKey} (${entryId}) записана без операции`);
      throw new LedgerOperationVanishedError(sourceKey);
    }
    if (outcome === "posted") {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.operation.submit", target: operationId, after: { kind: stored.kind, entryId, sourceKey } });
    }
    return await this.get(operationId);
  }

  /** Убрать черновик. Проведённую операцию и ту, что проводится прямо сейчас, не убрать. */
  async discard(actor: OperationActor, operationId: string): Promise<void> {
    const stored = await this.stored(operationId);
    if (stored.status !== "draft") throw new LedgerOperationNotDraftError(operationId, stored.status);
    // Проводка уже записана, отметка ещё нет: удаление оставило бы в журнале проводку без операции.
    if (await this.repository.entryExists(operationSourceKey(operationId))) throw new LedgerOperationNotDraftError(operationId, "posted");
    if (!(await this.repository.deleteDraft(operationId))) throw new LedgerOperationNotDraftError(operationId, "posted");
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.operation.discard", target: operationId, before: { kind: stored.kind, note: stored.note } });
  }

  async get(operationId: string): Promise<OperationView> {
    return await this.view(await this.stored(operationId));
  }

  /** Страница операций: новые сверху, с проводкой и условиями займа; `next` — курсор следующей страницы или `null`. */
  async list(filter: OperationFilter, cursor: string | null, limit: number = DEFAULT_JOURNAL_LIMIT): Promise<OperationPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JOURNAL_LIMIT) {
      throw new ValidationError(`Страница операций — от 1 до ${String(MAX_JOURNAL_LIMIT)} записей`);
    }
    const position = cursor === null ? null : decodeCursor(cursor);
    // Одна лишняя запись говорит, есть ли следующая страница, и не требует отдельного запроса «сколько всего».
    const rows = await this.repository.list(filter, position, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      operations: await this.views(page),
      next: rows.length > limit && last !== undefined ? encodeCursor({ at: last.createdAt, entryId: last.operationId }) : null,
    };
  }

  /** Ввод, готовый к записи: разобран схемой, с шаблоном комиссии, проверен сборщиком, с оценкой в долларах. */
  private async prepare(operationId: string, raw: OperationInput): Promise<{ input: OperationInput; amountUsd: string | null }> {
    // Серверные вызовы (шаблоны расходов) приходят мимо HTTP-схемы: схема нужна и им.
    const parsed = operationInputSchema.safeParse(raw);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join(".") ?? "";
      throw new LedgerOperationInvalidError(field === "" ? "Операция заполнена неверно" : `Поле «${field}» заполнено неверно`);
    }
    const chart = await this.loadChart();
    const input = applyFeeTemplate(parsed.data, chart);
    const now = new Date();
    if (input.kind === "reversal") {
      const problems = commonProblems(input, now);
      if (!(await this.repository.entryExists(input.sourceKey))) problems.push({ message: `Исходной проводки «${input.sourceKey}» в журнале нет` });
      if (problems.length > 0) throw invalid(problems);
      // Сторно меняет уже проведённое, и размер у него не оценить без строк исходной проводки: пусто — «не мелочь».
      return { input, amountUsd: null };
    }
    const result = buildOperation(operationId, input, chart, now);
    if (!result.ok) throw invalid(result.problems);
    return { input, amountUsd: await this.estimateUsd(result.built.estimate, now) };
  }

  /**
   * Размер в долларах: первая валюта операции с известным курсом. Звезда — по курсу выплаты, а не цене игрока
   * (docs/37 О46). Нет курса или курсы недоступны — `null`: неизвестное оценкой не притворяется.
   */
  private async estimateUsd(basis: readonly EstimateBasis[], now: Date): Promise<string | null> {
    if (basis.length === 0) return null;
    let snapshot: RatesSnapshot;
    try {
      snapshot = { id: "peek", ...(await withTimeout(this.fx.peek(now), FX_TIMEOUT_MS, "курсы валют")) };
    } catch (error: unknown) {
      this.logger.warn(`Курсы недоступны, размер операции не оценён: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    for (const { currency, minor } of basis) {
      if (!isCurrencyCode(currency)) continue;
      try {
        return roundUsd(fromMinorUnits(minor, currency).mul(payoutUsdPerUnit(snapshot, currency)));
      } catch (error: unknown) {
        if (!(error instanceof MissingRateError)) throw error;
      }
    }
    return null;
  }

  /** Счета, которых проводке ещё не хватает: статьи в валютах и служебные (транзит обмена, обязательство по займу). */
  private async ensureAccounts(built: BuiltOperation): Promise<void> {
    for (const need of built.articleAccounts) await this.chart.ensureArticleAccount(need.articleId, need.currency);
    let created = false;
    for (const account of built.serviceAccounts) created = (await this.repository.ensureAccount(account)) || created;
    if (created) this.ledger.forgetAccounts();
  }

  /** Места и статьи в виде для сборщика: по строке на счёт места, чтобы операция называла счёт (`stars.bot.available`). */
  private async loadChart(): Promise<OperationsChart> {
    const [places, articles] = await Promise.all([this.chart.places(), this.chart.articles()]);
    const placeMap = new Map<string, ChartPlace>();
    for (const place of places) {
      const fee = feeTemplateOf(place.fee);
      for (const account of place.accounts) {
        placeMap.set(account.accountId, { accountId: account.accountId, name: account.name, currency: place.currency, place: place.placeId, archived: place.archived, fee });
      }
    }
    return {
      places: placeMap,
      articles: new Map(articles.map((article) => [article.articleId, { articleId: article.articleId, name: article.name, kind: article.kind, archived: article.archived }])),
    };
  }

  private async stored(operationId: string): Promise<StoredOperation> {
    const row = await this.repository.byId(operationId);
    if (row === null) throw new LedgerOperationNotFoundError(operationId);
    return row;
  }

  private async view(row: StoredOperation): Promise<OperationView> {
    const [view] = await this.views([row]);
    if (view === undefined) throw new Error("Пустой ответ представления операции");
    return view;
  }

  private async views(rows: readonly StoredOperation[]): Promise<OperationView[]> {
    if (rows.length === 0) return [];
    const chart = await this.loadChart();
    const [entries, loans] = await Promise.all([
      this.repository.entriesBySource(rows.flatMap((row) => (row.sourceKey === null ? [] : [row.sourceKey]))),
      this.repository.loansOf(rows.filter((row) => row.kind === "loan" && row.status === "posted").map((row) => row.operationId)),
    ]);
    return rows.map((row) => operationView(row, chart, entries, loans));
  }

  private async isOwner(actor: OperationActor): Promise<boolean> {
    return (await this.roles.rolesFor(actor)).includes("owner");
  }
}
