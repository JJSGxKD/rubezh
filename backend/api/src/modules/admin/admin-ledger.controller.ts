import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { isCurrencyCode } from "@bh/fx";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { RateLimitedError, ValidationError } from "../../common/domain-error.js";
import { accountOf } from "../auth/auth.guard.js";
import type { AccessTokenClaims } from "../auth/access-token.js";
import { RateLimiter } from "../ingest/rate-limiter.js";
import { FEE_PERCENT_BP_MAX, NAME_MAX, type ArticleView, type CreateArticleInput, type CreatePlaceInput, type PlaceView, type UpdatePlaceInput } from "../ledger/ledger-chart.js";
import { LedgerChartService } from "../ledger/ledger-chart.service.js";
import { DEFAULT_JOURNAL_LIMIT, LedgerService, MAX_JOURNAL_LIMIT } from "../ledger/ledger.service.js";
import type { AccountBalanceView, JournalFilterInput, JournalPage } from "../ledger/ledger-view.js";
import { OPERATION_KINDS, OPERATION_STATUSES, operationInputSchema, type OperationInput } from "../ledger/operations/operation-input.js";
import type { OperationPage, OperationView } from "../ledger/operations/operation-view.js";
import type { OperationFilter } from "../ledger/operations/operations.repository.js";
import { OperationsService } from "../ledger/operations/operations.service.js";
import { PermissionGuard } from "../roles/permission.guard.js";
import { ADMIN_LIMITS } from "./admin-limits.js";
import { parse } from "./admin-parse.js";
import { AdminSessionGuard } from "./admin-session.guard.js";

/** Пустой параметр формы («account=») — всё равно что нет параметра. */
const blankIsAbsent = (value: unknown): unknown => (value === "" ? undefined : value);

/** «ГГГГ-ММ»: месяц от 01 до 12, как период проводки. */
const monthSchema = z.preprocess(blankIsAbsent, z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).optional());

const textSchema = (max: number) => z.preprocess(blankIsAbsent, z.string().min(1).max(max).optional());

const journalQuerySchema = z
  .object({
    account: textSchema(64),
    currency: z.preprocess(blankIsAbsent, z.string().regex(/^[A-Z0-9]{2,16}$/u).optional()),
    from: monthSchema,
    to: monthSchema,
    // префикс ключа источника: «purchase:» — все платежи
    source: textSchema(128),
    // курсор — непрозрачная строка base64url; разбирает сервис
    cursor: z.preprocess(blankIsAbsent, z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u).optional()),
    limit: z.preprocess(blankIsAbsent, z.coerce.number().int().min(1).max(MAX_JOURNAL_LIMIT).default(DEFAULT_JOURNAL_LIMIT)),
  })
  .strict()
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, { message: "from позже to" });

/** Остатки читаются без параметров: лишний параметр — опечатка клиента, а не «молчаливо проигнорировать». */
const noQuerySchema = z.object({}).strict();

const nameSchema = z.string().trim().min(1).max(NAME_MAX);
/** Валюта — только из справочника ядра курсов: «ABC» и «rub» отсекаются здесь, а не в базе. */
const currencySchema = z.string().refine(isCurrencyCode);
/** Идентификаторы мест и статей: строчные латиница и цифры, точка, дефис, подчёркивание (`bank.rub`, `ads_taddy`). */
const idSchema = z.string().regex(/^[a-z0-9._-]{1,64}$/u);

/** Шаблон комиссии: процент — сотые доли процента; фикса — десятичной строкой в единицах её валюты. */
const feeSchema = z.strictObject({
  percentBp: z.number().int().min(0).max(FEE_PERCENT_BP_MAX).nullable().optional(),
  fixed: z.string().regex(/^\d{1,18}(\.\d{1,18})?$/u).nullable().optional(),
  fixedCurrency: currencySchema.nullable().optional(),
});

const createPlaceSchema = z.strictObject({ name: nameSchema, currency: currencySchema, fee: feeSchema.optional() });
const updatePlaceSchema = z
  .strictObject({ name: nameSchema.optional(), fee: feeSchema.nullable().optional() })
  .refine((body) => body.name !== undefined || body.fee !== undefined);
const createArticleSchema = z.strictObject({ name: nameSchema, kind: z.enum(["expense", "income"]) });
const renameArticleSchema = z.strictObject({ name: nameSchema });

const PLACE_PROBLEM = "Некорректное место хранения: название до 128 знаков, валюта из справочника, процент комиссии от 0 до 10 000 сотых процента, фикса — числом со своей валютой";
const ARTICLE_PROBLEM = "Некорректная статья: название до 128 знаков, вид — расход или поступление";
const ID_PROBLEM = "Некорректный идентификатор";

const operationIdSchema = z.string().uuid();
const OPERATION_ID_PROBLEM = "Некорректный идентификатор операции";

/** Список операций: статус и вид необязательны, страница — по курсору, как у журнала. */
const operationsQuerySchema = z
  .object({
    status: z.preprocess(blankIsAbsent, z.enum(OPERATION_STATUSES).optional()),
    kind: z.preprocess(blankIsAbsent, z.enum(OPERATION_KINDS).optional()),
    cursor: z.preprocess(blankIsAbsent, z.string().regex(/^[A-Za-z0-9_-]{1,256}$/u).optional()),
    limit: z.preprocess(blankIsAbsent, z.coerce.number().int().min(1).max(MAX_JOURNAL_LIMIT).default(DEFAULT_JOURNAL_LIMIT)),
  })
  .strict();

/** Тело операции: ошибка схемы называет поле, а не просто «некорректно» — форма операции длинная. */
function parseOperation(body: unknown): OperationInput {
  const parsed = operationInputSchema.safeParse(body);
  if (parsed.success) return parsed.data;
  const field = parsed.error.issues[0]?.path.join(".") ?? "";
  throw new ValidationError(field === "" ? "Некорректная операция: нужен вид (kind) и его поля" : `Некорректная операция: проверьте поле «${field}»`);
}

/**
 * Журнал учёта в панели (docs/37-accounting.md §9, Р219, tasks/T-0457): остатки по счетам и журнал проводок
 * с фильтрами и страницами по курсору. Проводки журнала по HTTP не пишутся: их пишет сервер, а человек вносит
 * операции (ниже). Видят владелец и финансы (`ledger.view`).
 *
 * Места хранения и статьи (Р220, tasks/T-0460): справочник правится отсюда без релиза. Читает тот, кто видит
 * журнал (`ledger.view`), менять — `finance.entry.create`; порядок и аудит — `LedgerChartService`.
 *
 * Ручные операции (Р220, tasks/T-0461): перевод, обмен, расход, поступление, заём и исправление. Человек
 * описывает событие, сервер собирает проводку; черновик правится, проведённая операция — нет. Список и показ —
 * `ledger.view`, внесение, правка, проведение и удаление черновика — `finance.entry.create`.
 */
@Controller("admin/ledger")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminLedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly chart: LedgerChartService,
    private readonly operations: OperationsService,
    private readonly limiter: RateLimiter,
  ) {}

  @Get("balances")
  @RequirePermission("ledger.view")
  async balances(@Query() query: unknown): Promise<{ data: { accounts: AccountBalanceView[] } }> {
    parse(() => noQuerySchema.parse(query ?? {}), "Остатки не принимают параметров");
    return { data: { accounts: await this.ledger.balances() } };
  }

  @Get("journal")
  @RequirePermission("ledger.view")
  async journal(@Query() query: unknown): Promise<{ data: JournalPage }> {
    const input = parse(() => journalQuerySchema.parse(query ?? {}), "Некорректные параметры журнала: период — ГГГГ-ММ, начало не позже конца, страница — от 1 до 100 проводок");
    const filter: JournalFilterInput = {
      ...(input.account === undefined ? {} : { accountId: input.account }),
      ...(input.currency === undefined ? {} : { currency: input.currency }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      ...(input.source === undefined ? {} : { sourcePrefix: input.source }),
    };
    return { data: await this.ledger.journal(filter, input.cursor ?? null, input.limit) };
  }

  @Get("places")
  @RequirePermission("ledger.view")
  async places(): Promise<{ data: { places: PlaceView[] } }> {
    return { data: { places: await this.chart.places() } };
  }

  @Post("places")
  @HttpCode(200)
  @RequirePermission("finance.entry.create")
  async createPlace(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { place: PlaceView } }> {
    const actor = await this.mutator(request);
    const input: CreatePlaceInput = parse(() => createPlaceSchema.parse(body), PLACE_PROBLEM);
    return { data: { place: await this.chart.createPlace(actor, input) } };
  }

  @Patch("places/:id")
  @HttpCode(200)
  @RequirePermission("finance.entry.create")
  async updatePlace(@Req() request: unknown, @Param("id") id: string, @Body() body: unknown): Promise<{ data: { place: PlaceView } }> {
    const actor = await this.mutator(request);
    const placeId = parse(() => idSchema.parse(id), ID_PROBLEM);
    const input: UpdatePlaceInput = parse(() => updatePlaceSchema.parse(body), PLACE_PROBLEM);
    return { data: { place: await this.chart.updatePlace(actor, placeId, input) } };
  }

  @Post("places/:id/archive")
  @HttpCode(200)
  @RequirePermission("finance.entry.create")
  async archivePlace(@Req() request: unknown, @Param("id") id: string): Promise<{ data: { ok: true } }> {
    const actor = await this.mutator(request);
    await this.chart.archivePlace(actor, parse(() => idSchema.parse(id), ID_PROBLEM));
    return { data: { ok: true } };
  }

  @Get("articles")
  @RequirePermission("ledger.view")
  async articles(): Promise<{ data: { articles: ArticleView[] } }> {
    return { data: { articles: await this.chart.articles() } };
  }

  @Post("articles")
  @HttpCode(200)
  @RequirePermission("finance.entry.create")
  async createArticle(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { article: ArticleView } }> {
    const actor = await this.mutator(request);
    const input: CreateArticleInput = parse(() => createArticleSchema.parse(body), ARTICLE_PROBLEM);
    return { data: { article: await this.chart.createArticle(actor, input) } };
  }

  @Patch("articles/:id")
  @HttpCode(200)
  @RequirePermission("finance.entry.create")
  async renameArticle(@Req() request: unknown, @Param("id") id: string, @Body() body: unknown): Promise<{ data: { article: ArticleView } }> {
    const actor = await this.mutator(request);
    const articleId = parse(() => idSchema.parse(id), ID_PROBLEM);
    const input = parse(() => renameArticleSchema.parse(body), ARTICLE_PROBLEM);
    return { data: { article: await this.chart.renameArticle(actor, articleId, input.name) } };
  }

  @Post("articles/:id/archive")
  @HttpCode(200)
  @RequirePermission("finance.entry.create")
  async archiveArticle(@Req() request: unknown, @Param("id") id: string): Promise<{ data: { ok: true } }> {
    const actor = await this.mutator(request);
    await this.chart.archiveArticle(actor, parse(() => idSchema.parse(id), ID_PROBLEM));
    return { data: { ok: true } };
  }

  @Get("operations")
  @RequirePermission("ledger.view")
  async listOperations(@Query() query: unknown): Promise<{ data: OperationPage }> {
    const input = parse(() => operationsQuerySchema.parse(query ?? {}), "Некорректные параметры списка операций: статус и вид — из списка, страница — от 1 до 100 записей");
    const filter: OperationFilter = { status: input.status, kind: input.kind };
    return { data: await this.operations.list(filter, input.cursor ?? null, input.limit) };
  }

  @Get("operations/:id")
  @RequirePermission("ledger.view")
  async operation(@Param("id") id: string): Promise<{ data: { operation: OperationView } }> {
    const operationId = parse(() => operationIdSchema.parse(id), OPERATION_ID_PROBLEM);
    return { data: { operation: await this.operations.get(operationId) } };
  }

  @Post("operations")
  @HttpCode(200)
  @RequirePermission("finance.entry.create")
  async createOperation(@Req() request: unknown, @Body() body: unknown): Promise<{ data: { operation: OperationView } }> {
    const actor = await this.mutator(request);
    return { data: { operation: await this.operations.create(actor, parseOperation(body)) } };
  }

  @Patch("operations/:id")
  @HttpCode(200)
  @RequirePermission("finance.entry.create")
  async updateOperation(@Req() request: unknown, @Param("id") id: string, @Body() body: unknown): Promise<{ data: { operation: OperationView } }> {
    const actor = await this.mutator(request);
    const operationId = parse(() => operationIdSchema.parse(id), OPERATION_ID_PROBLEM);
    return { data: { operation: await this.operations.update(actor, operationId, parseOperation(body)) } };
  }

  @Post("operations/:id/submit")
  @HttpCode(200)
  @RequirePermission("finance.entry.create")
  async submitOperation(@Req() request: unknown, @Param("id") id: string): Promise<{ data: { operation: OperationView } }> {
    const actor = await this.mutator(request);
    const operationId = parse(() => operationIdSchema.parse(id), OPERATION_ID_PROBLEM);
    return { data: { operation: await this.operations.submit(actor, operationId) } };
  }

  @Post("operations/:id/discard")
  @HttpCode(200)
  @RequirePermission("finance.entry.create")
  async discardOperation(@Req() request: unknown, @Param("id") id: string): Promise<{ data: { ok: true } }> {
    const actor = await this.mutator(request);
    await this.operations.discard(actor, parse(() => operationIdSchema.parse(id), OPERATION_ID_PROBLEM));
    return { data: { ok: true } };
  }

  /** Автор изменения; частота — как у прочих действий панели, по аккаунту. */
  private async mutator(request: unknown): Promise<AccessTokenClaims> {
    const actor = accountOf(request);
    if (!(await this.limiter.consume(ADMIN_LIMITS.mutate, actor.accountId))) throw new RateLimitedError("Слишком много действий — подождите минуту");
    return actor;
  }
}
