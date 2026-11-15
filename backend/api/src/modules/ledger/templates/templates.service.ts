import { Inject, Injectable } from "@nestjs/common";
import { formatMinor } from "@bh/ledger";
import { DomainError } from "../../../common/domain-error.js";
import { RolesService } from "../../roles/roles.service.js";
import { ChartRuleError, NAME_MAX, slugify, type ArticleView, type PlaceView } from "../ledger-chart.js";
import { LedgerChartService } from "../ledger-chart.service.js";
import { currencySpec } from "../ledger-currencies.js";
import type { BuildProblem } from "../operations/builders.js";
import { minorOf } from "../operations/builder-kit.js";
import { LedgerOperationTemplateTakenError } from "../operations/operation-errors.js";
import { OperationsService, type OperationActor } from "../operations/operations.service.js";
import { LedgerTemplateArchivedError, LedgerTemplateInvalidError, LedgerTemplateNotFoundError } from "./template-errors.js";
import type { CreateTemplateInput, UpdateTemplateInput } from "./template-input.js";
import { draftInput, eventDate, isDue, periodProblem, type TemplateSchedule } from "./schedule.js";
import { TEMPLATES_REPOSITORY, type StoredTemplate, type TemplatePatch, type TemplatesRepository } from "./templates.repository.js";

/**
 * Шаблоны повторяющихся расходов (docs/37-accounting.md §8, Р220, tasks/T-0463): сервер, CDN, ИИ-инструменты — каждый
 * месяц, домены — раз в год. Шаблон хранит статью, место, обычную сумму и график; «Расходы месяца» создаёт по нему
 * **черновик** операции, а не проводку: сумма в реальности могла измениться (курс, тариф), и человек сверяет её с
 * фактом. Право на изменение проверяет охранник маршрута (`finance.entry.create`); здесь — порядок действий и аудит
 * каждого (`ledger.template.*`).
 */

/** Сколько раз пробуем свободный идентификатор: «название», «название-2», …; больше — похоже на ошибку клиента. */
const MAX_ID_ATTEMPTS = 20;

export interface TemplateView {
  templateId: string;
  name: string;
  articleId: string;
  articleName: string;
  placeAccountId: string;
  placeName: string;
  currency: string;
  /** обычная сумма в единицах валюты места: «1500.00» */
  amount: string;
  schedule: TemplateSchedule;
  month: number | null;
  note: string | null;
  archived: boolean;
}

/** Шаблон, по которому черновик не создан, и почему: остальные шаблоны это не останавливает. */
export interface DraftFailure {
  templateId: string;
  name: string;
  reason: string;
}

export interface DraftPeriodResult {
  period: string;
  created: number;
  /** на период уже был черновик или проведённая операция — в том числе созданная параллельным вызовом */
  existing: number;
  failed: DraftFailure[];
}

function problemsText(problems: readonly BuildProblem[]): string {
  return problems.map((problem) => problem.message).join("; ");
}

function cleanName(raw: string): string {
  const name = raw.trim();
  if (name === "") throw new LedgerTemplateInvalidError("У шаблона должно быть название");
  if (name.length > NAME_MAX) throw new LedgerTemplateInvalidError(`Название шаблона длиннее ${String(NAME_MAX)} знаков`);
  return name;
}

function slugOf(name: string): string {
  try {
    return slugify(name);
  } catch (error: unknown) {
    if (error instanceof ChartRuleError) throw new LedgerTemplateInvalidError(error.message);
    throw error;
  }
}

/** Месяц годового шаблона обязателен, у месячного его нет: база держит то же правило проверкой. */
function checkSchedule(schedule: TemplateSchedule, month: number | null): void {
  if (schedule === "yearly" && (month === null || !Number.isInteger(month) || month < 1 || month > 12)) {
    throw new LedgerTemplateInvalidError("Годовому шаблону нужен месяц года — число от 1 до 12");
  }
  if (schedule === "monthly" && month !== null) throw new LedgerTemplateInvalidError("У месячного шаблона месяца нет: он создаётся каждый месяц");
}

function cleanNote(raw: string | null | undefined): string | null {
  const note = raw?.trim() ?? "";
  return note === "" ? null : note;
}

@Injectable()
export class TemplatesService {
  constructor(
    @Inject(TEMPLATES_REPOSITORY) private readonly repository: TemplatesRepository,
    private readonly operations: OperationsService,
    private readonly chart: LedgerChartService,
    private readonly roles: RolesService,
  ) {}

  /** Все шаблоны, в том числе архивные: панель прячет их сама. */
  async list(): Promise<TemplateView[]> {
    const [stored, places, articles] = await Promise.all([this.repository.list(), this.chart.places(), this.chart.articles()]);
    return stored.map((template) => this.view(template, places, articles));
  }

  async create(actor: OperationActor, input: CreateTemplateInput): Promise<TemplateView> {
    const name = cleanName(input.name);
    const slug = slugOf(name);
    const month = input.month ?? null;
    checkSchedule(input.schedule, month);
    const [places, articles] = await Promise.all([this.chart.places(), this.chart.articles()]);
    const place = this.placeOf(places, input.placeAccountId);
    this.checkArticle(articles, input.articleId);
    const amount = this.minor(input.amount, place.currency);
    const note = cleanNote(input.note);

    for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt += 1) {
      const templateId = attempt === 1 ? slug : `${slug}-${String(attempt)}`;
      const row = { templateId, name, articleId: input.articleId, placeAccountId: input.placeAccountId, amount, schedule: input.schedule, month, note, createdBy: actor.accountId };
      if (!(await this.repository.insert(row))) continue;
      const created = await this.stored(templateId);
      await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.template.create", target: templateId, after: { name, articleId: input.articleId, placeAccountId: input.placeAccountId, amount: input.amount, schedule: input.schedule, month } });
      return this.view(created, places, articles);
    }
    throw new LedgerTemplateInvalidError(`Шаблонов с названием «${name}» уже слишком много — нужно другое название`);
  }

  /** Правка шаблона: что не задано — остаётся. Архивный не правится. Уже созданные черновики не меняются. */
  async update(actor: OperationActor, templateId: string, input: UpdateTemplateInput): Promise<TemplateView> {
    const before = await this.stored(templateId);
    if (before.archivedAt !== null) throw new LedgerTemplateArchivedError(templateId);
    if (Object.values(input).every((value) => value === undefined)) throw new LedgerTemplateInvalidError("Нечего менять: не указано ни одного поля");

    const [places, articles] = await Promise.all([this.chart.places(), this.chart.articles()]);
    const patch: TemplatePatch = {};
    if (input.name !== undefined) patch.name = cleanName(input.name);
    if (input.articleId !== undefined) {
      this.checkArticle(articles, input.articleId);
      patch.articleId = input.articleId;
    }

    const oldPlace = this.placeOf(places, before.placeAccountId);
    const place = input.placeAccountId === undefined ? oldPlace : this.placeOf(places, input.placeAccountId);
    if (input.placeAccountId !== undefined) patch.placeAccountId = input.placeAccountId;
    if (input.amount !== undefined) {
      patch.amount = this.minor(input.amount, place.currency);
    } else if (place.currency !== oldPlace.currency) {
      // Сумма хранится в минимальных единицах: те же цифры в другой валюте — совсем другие деньги.
      throw new LedgerTemplateInvalidError("Место в другой валюте: сумму нужно задать заново");
    }

    if (input.schedule !== undefined || input.month !== undefined) {
      const schedule = input.schedule ?? before.schedule;
      // Переход на месячный график сбрасывает месяц; переход на годовой без месяца — отказ проверки ниже.
      const month = input.month !== undefined ? input.month : schedule === "monthly" ? null : before.month;
      checkSchedule(schedule, month);
      patch.schedule = schedule;
      patch.month = month;
    }
    if (input.note !== undefined) patch.note = cleanNote(input.note);

    if (!(await this.repository.update(templateId, patch))) throw new LedgerTemplateArchivedError(templateId);
    const after = await this.stored(templateId);
    await this.roles.audit({
      actorAccountId: actor.accountId,
      action: "ledger.template.update",
      target: templateId,
      before: { name: before.name, articleId: before.articleId, placeAccountId: before.placeAccountId, amount: formatMinor(before.amount, currencySpec(oldPlace.currency)), schedule: before.schedule, month: before.month },
      after: { name: after.name, articleId: after.articleId, placeAccountId: after.placeAccountId, amount: formatMinor(after.amount, currencySpec(place.currency)), schedule: after.schedule, month: after.month },
    });
    return this.view(after, places, articles);
  }

  /** В архив: новых черновиков нет, созданные остаются. Повтор — не ошибка и не второй аудит. */
  async archive(actor: OperationActor, templateId: string): Promise<void> {
    await this.stored(templateId);
    if (!(await this.repository.archive(templateId, new Date()))) return;
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.template.archive", target: templateId, after: { archived: true } });
  }

  /**
   * «Расходы месяца»: по каждому действующему шаблону, наступившему в периоде, — черновик расхода через
   * `OperationsService.create`. Уже созданные пропускаются, а параллельный вызов, успевший раньше, виден по отказу
   * уникального ключа периода: это «уже было», а не сбой. Сбой одного шаблона (статью или место архивировали) не
   * мешает остальным — он назван в ответе. Проводит черновики человек, не этот метод.
   */
  async draftPeriod(actor: OperationActor, period: string, now: Date = new Date()): Promise<DraftPeriodResult> {
    const problem = periodProblem(period, now);
    if (problem !== null) throw new LedgerTemplateInvalidError(problem);

    const [stored, drafted, places] = await Promise.all([this.repository.list(), this.repository.draftedTemplateIds(period), this.chart.places()]);
    const result: DraftPeriodResult = { period, created: 0, existing: 0, failed: [] };
    for (const template of stored) {
      if (template.archivedAt !== null || !isDue(template, period)) continue;
      if (drafted.has(template.templateId)) {
        result.existing += 1;
        continue;
      }
      try {
        const place = this.placeOf(places, template.placeAccountId);
        const input = { ...draftInput({ ...template, currency: place.currency }, period), at: eventDate(period, now) };
        await this.operations.create(actor, input, { templateId: template.templateId, period });
        result.created += 1;
      } catch (error: unknown) {
        if (error instanceof LedgerOperationTemplateTakenError) result.existing += 1;
        else if (error instanceof DomainError) result.failed.push({ templateId: template.templateId, name: template.name, reason: error.message });
        else throw error;
      }
    }
    // Пустой повтор журнал аудита не засоряет: действие записано, когда что-то создано.
    if (result.created > 0) {
      await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.template.draft_period", target: period, after: { created: result.created, existing: result.existing, failed: result.failed.length } });
    }
    return result;
  }

  /** Место по счёту: активный счёт места хранения, а не статьи и не архив. */
  private placeOf(places: readonly PlaceView[], accountId: string): { currency: string; name: string } {
    const place = places.find((candidate) => candidate.accounts.some((account) => account.accountId === accountId));
    const account = place?.accounts.find((candidate) => candidate.accountId === accountId);
    if (place === undefined || account === undefined) throw new LedgerTemplateInvalidError(`Места хранения «${accountId}» нет`);
    if (place.archived) throw new LedgerTemplateInvalidError(`Место «${account.name}» в архиве`);
    return { currency: place.currency, name: account.name };
  }

  /** Статья расхода и не в архиве: шаблон создаёт расходы, поступление ему не подходит. */
  private checkArticle(articles: readonly ArticleView[], articleId: string): void {
    const article = articles.find((candidate) => candidate.articleId === articleId);
    if (article === undefined) throw new LedgerTemplateInvalidError(`Статьи «${articleId}» нет`);
    if (article.kind !== "expense") throw new LedgerTemplateInvalidError(`Статья «${article.name}» — поступление, а шаблон создаёт расходы`);
    if (article.archived) throw new LedgerTemplateInvalidError(`Статья «${article.name}» в архиве`);
  }

  private minor(raw: string, currency: string): bigint {
    const problems: BuildProblem[] = [];
    const value = minorOf(raw, currency, "Сумма", problems, "positive");
    if (value === null) throw new LedgerTemplateInvalidError(problemsText(problems));
    return value;
  }

  private async stored(templateId: string): Promise<StoredTemplate> {
    const row = await this.repository.byId(templateId);
    if (row === null) throw new LedgerTemplateNotFoundError(templateId);
    return row;
  }

  private view(template: StoredTemplate, places: readonly PlaceView[], articles: readonly ArticleView[]): TemplateView {
    const place = places.find((candidate) => candidate.accounts.some((account) => account.accountId === template.placeAccountId));
    if (place === undefined) throw new Error(`У шаблона «${template.templateId}» нет места ${template.placeAccountId}`);
    const account = place.accounts.find((candidate) => candidate.accountId === template.placeAccountId);
    return {
      templateId: template.templateId,
      name: template.name,
      articleId: template.articleId,
      articleName: articles.find((article) => article.articleId === template.articleId)?.name ?? template.articleId,
      placeAccountId: template.placeAccountId,
      placeName: account?.name ?? place.name,
      currency: place.currency,
      amount: formatMinor(template.amount, currencySpec(place.currency)),
      schedule: template.schedule,
      month: template.month,
      note: template.note,
      archived: template.archivedAt !== null,
    };
  }
}
