import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { RequirePermission } from "../../common/access.js";
import { DEFAULT_JOURNAL_LIMIT, LedgerService, MAX_JOURNAL_LIMIT } from "../ledger/ledger.service.js";
import type { AccountBalanceView, JournalFilterInput, JournalPage } from "../ledger/ledger-view.js";
import { PermissionGuard } from "../roles/permission.guard.js";
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

/**
 * Журнал учёта в панели (docs/37-accounting.md §9, Р219, tasks/T-0457): остатки по счетам и журнал проводок
 * с фильтрами и страницами по курсору. Только чтение: проводки пишет сервер, ручные операции — волна 3.
 * Видят владелец и финансы (`ledger.view`).
 */
@Controller("admin/ledger")
@UseGuards(AdminSessionGuard, PermissionGuard)
export class AdminLedgerController {
  constructor(private readonly ledger: LedgerService) {}

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
}
