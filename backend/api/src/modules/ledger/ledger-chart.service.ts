import { Inject, Injectable } from "@nestjs/common";
import { formatMinor, toMinor } from "@bh/ledger";
import { isCurrencyCode } from "@bh/fx";
import { RolesService } from "../roles/roles.service.js";
import {
  ChartRuleError,
  LedgerArticleArchivedError,
  LedgerArticleNotFoundError,
  LedgerArticleSystemError,
  LedgerChartInvalidError,
  LedgerPlaceNotEmptyError,
  LedgerPlaceNotFoundError,
  NAME_MAX,
  articleAccountId,
  currencyKind,
  feeTemplateProblem,
  placeAccountId,
  slugify,
  type ArticleView,
  type CreateArticleInput,
  type CreatePlaceInput,
  type FeeInput,
  type FeeTemplate,
  type FeeView,
  type PlaceView,
  type UpdatePlaceInput,
} from "./ledger-chart.js";
import { LEDGER_CHART_REPOSITORY, type LedgerChartRepository, type StoredArticle, type StoredPlaceAccount } from "./ledger-chart.repository.js";
import { currencySpec } from "./ledger-currencies.js";
import { LedgerService, type LedgerActor } from "./ledger.service.js";

/**
 * Места хранения и статьи учёта из панели (docs/37-accounting.md §3, Р220, tasks/T-0460): завести, переименовать,
 * архивировать — без правки кода на каждую новую статью. Права проверяет охранник маршрута (`finance.entry.create`
 * на изменение, `ledger.view` на чтение); каждое изменение — в журнал аудита. Счёт статьи в нужной валюте
 * заводится при первой проводке (`ensureArticleAccount`) — её зовут операции учёта.
 */

/** Сколько раз пробуем свободный идентификатор: «название», «название-2», …; больше — похоже на ошибку клиента. */
const MAX_ID_ATTEMPTS = 20;

const NO_FEE: FeeTemplate = { percentBp: null, fixed: null, fixedCurrency: null };

/** Название в справочнике: без краёв из пробелов, не пустое, влезает в базу. */
function cleanName(raw: string, what: string): string {
  const name = raw.trim();
  if (name === "") throw new LedgerChartInvalidError(`У ${what} должно быть название`);
  if (name.length > NAME_MAX) throw new LedgerChartInvalidError(`Название ${what} длиннее ${String(NAME_MAX)} знаков`);
  return name;
}

/** Слаг названия; исключение правил превращается в отказ с тем же текстом. */
function slugOf(name: string): string {
  try {
    return slugify(name);
  } catch (error: unknown) {
    if (error instanceof ChartRuleError) throw new LedgerChartInvalidError(error.message);
    throw error;
  }
}

function assertCurrency(code: string): void {
  if (!isCurrencyCode(code)) throw new LedgerChartInvalidError(`Валюта «${code}» не входит в справочник валют`);
}

/** Шаблон из тела запроса: фикса — десятичной строкой в единицах её валюты, в базе — в минимальных единицах. */
function parseFee(input: FeeInput | null | undefined): FeeTemplate {
  if (input === null || input === undefined) return NO_FEE;
  const percentBp = input.percentBp ?? null;
  const fixedCurrency = input.fixedCurrency ?? null;
  let fixed: bigint | null = null;
  if (input.fixed !== null && input.fixed !== undefined) {
    if (fixedCurrency === null) throw new LedgerChartInvalidError("Фикса комиссии задаётся вместе с её валютой");
    assertCurrency(fixedCurrency);
    try {
      fixed = toMinor(input.fixed, currencySpec(fixedCurrency));
    } catch (error: unknown) {
      if (error instanceof SyntaxError || error instanceof RangeError) throw new LedgerChartInvalidError(`Фикса комиссии: ${error.message}`);
      throw error;
    }
  }
  const template: FeeTemplate = { percentBp, fixed, fixedCurrency };
  const problem = feeTemplateProblem(template);
  if (problem !== null) throw new LedgerChartInvalidError(problem);
  return template;
}

function feeView(fee: FeeTemplate): FeeView | null {
  if (fee.percentBp === null && fee.fixed === null) return null;
  return {
    percentBp: fee.percentBp,
    fixed: fee.fixed === null || fee.fixedCurrency === null ? null : formatMinor(fee.fixed, currencySpec(fee.fixedCurrency)),
    fixedCurrency: fee.fixedCurrency,
  };
}

/** Название группы: у звёзд бота счета «Звёзды бота — в холде» и «… — доступно», у места — общая часть до « — ». */
function placeName(accounts: readonly StoredPlaceAccount[]): string {
  const [first] = accounts;
  if (first === undefined) return "";
  if (accounts.length === 1) return first.name;
  const heads = new Set(accounts.map((account) => account.name.split(" — ")[0]));
  return heads.size === 1 ? (first.name.split(" — ")[0] ?? first.name) : first.name;
}

function placeView(accounts: readonly StoredPlaceAccount[]): PlaceView {
  const [first] = accounts;
  if (first === undefined) throw new Error("Место хранения без счетов");
  const spec = currencySpec(first.currency);
  const total = accounts.reduce((sum, account) => sum + account.balance, 0n);
  return {
    placeId: first.place,
    name: placeName(accounts),
    currency: first.currency,
    archived: accounts.every((account) => account.archivedAt !== null),
    balance: formatMinor(total, spec),
    fee: feeView(first.fee),
    accounts: accounts.map((account) => ({ accountId: account.accountId, name: account.name, balance: formatMinor(account.balance, spec) })),
  };
}

function articleView(article: StoredArticle): ArticleView {
  return { articleId: article.articleId, kind: article.kind, name: article.name, system: article.system, archived: article.archivedAt !== null };
}

@Injectable()
export class LedgerChartService {
  constructor(
    @Inject(LEDGER_CHART_REPOSITORY) private readonly repository: LedgerChartRepository,
    private readonly ledger: LedgerService,
    private readonly roles: RolesService,
  ) {}

  /** Места хранения с остатками и шаблонами комиссии, в том числе архивные: панель прячет их сама. */
  async places(): Promise<PlaceView[]> {
    const groups = new Map<string, StoredPlaceAccount[]>();
    for (const account of await this.repository.placeAccounts()) {
      groups.set(account.place, [...(groups.get(account.place) ?? []), account]);
    }
    return [...groups.values()].map(placeView);
  }

  /**
   * Новое место: идентификатор из названия с первым сегментом по виду валюты — `bank.karta-t-banka` для рублей,
   * `wallet.…` для криптовалют. Занят — «-2», «-3», …
   */
  async createPlace(actor: LedgerActor, input: CreatePlaceInput): Promise<PlaceView> {
    const name = cleanName(input.name, "места хранения");
    assertCurrency(input.currency);
    const fee = parseFee(input.fee);
    const slug = slugOf(name);
    const kind = currencyKind(input.currency);

    for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt += 1) {
      const accountId = placeAccountId(attempt === 1 ? slug : `${slug}-${String(attempt)}`, kind);
      if (!(await this.repository.insertPlaceAccount({ accountId, name, currency: input.currency, fee }))) continue;
      this.ledger.forgetAccounts();
      const created = placeView(await this.repository.placeAccountsOf(accountId));
      await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.place.create", target: accountId, after: { name, currency: input.currency, fee: created.fee } });
      return created;
    }
    throw new LedgerChartInvalidError(`Мест с названием «${name}» уже слишком много — нужно другое название`);
  }

  /** Название и шаблон комиссии; `fee: null` снимает шаблон. Составное место (звёзды бота) не переименовывается. */
  async updatePlace(actor: LedgerActor, placeId: string, input: UpdatePlaceInput): Promise<PlaceView> {
    const accounts = await this.repository.placeAccountsOf(placeId);
    if (accounts.length === 0 || accounts.every((account) => account.archivedAt !== null)) throw new LedgerPlaceNotFoundError(placeId);
    const before = placeView(accounts);

    const patch: { name?: string; fee?: FeeTemplate } = {};
    if (input.name !== undefined) {
      if (accounts.length > 1) throw new LedgerChartInvalidError(`Место «${before.name}» состоит из нескольких счетов — переименовать его нельзя`);
      patch.name = cleanName(input.name, "места хранения");
    }
    if (input.fee !== undefined) patch.fee = parseFee(input.fee);
    if (patch.name === undefined && patch.fee === undefined) return before;

    await this.repository.updatePlace(placeId, patch);
    this.ledger.forgetAccounts();
    const after = placeView(await this.repository.placeAccountsOf(placeId));
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.place.update", target: placeId, before: { name: before.name, fee: before.fee }, after: { name: after.name, fee: after.fee } });
    return after;
  }

  /** Архив — только при нулевом остатке на всех счетах места. Повтор — не ошибка и не второй аудит. */
  async archivePlace(actor: LedgerActor, placeId: string): Promise<void> {
    const result = await this.repository.archivePlace(placeId, new Date());
    if (result === "missing") throw new LedgerPlaceNotFoundError(placeId);
    if (result === "not_empty") throw new LedgerPlaceNotEmptyError(placeId);
    if (result === "already") return;
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.place.archive", target: placeId, after: { archived: true } });
  }

  async articles(): Promise<ArticleView[]> {
    return (await this.repository.articles()).map(articleView);
  }

  /** Новая статья: идентификатор из названия, занят — «-2», «-3», …; счета в валютах появятся с первой проводкой. */
  async createArticle(actor: LedgerActor, input: CreateArticleInput): Promise<ArticleView> {
    const name = cleanName(input.name, "статьи");
    const slug = slugOf(name);

    for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt += 1) {
      const articleId = attempt === 1 ? slug : `${slug}-${String(attempt)}`;
      if (!(await this.repository.insertArticle({ articleId, kind: input.kind, name }))) continue;
      await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.article.create", target: articleId, after: { name, kind: input.kind } });
      return { articleId, kind: input.kind, name, system: false, archived: false };
    }
    throw new LedgerChartInvalidError(`Статей с названием «${name}» уже слишком много — нужно другое название`);
  }

  /** Новое название — и у статьи, и у названий её счетов в журнале. */
  async renameArticle(actor: LedgerActor, articleId: string, rawName: string): Promise<ArticleView> {
    const article = await this.repository.articleById(articleId);
    if (article === null) throw new LedgerArticleNotFoundError(articleId);
    const name = cleanName(rawName, "статьи");
    if (name === article.name) return articleView(article);

    if (!(await this.repository.renameArticle(articleId, name))) throw new LedgerArticleNotFoundError(articleId);
    this.ledger.forgetAccounts();
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.article.rename", target: articleId, before: { name: article.name }, after: { name } });
    return articleView({ ...article, name });
  }

  /** Служебные статьи не архивируются; повторный архив обычной — не ошибка и не второй аудит. */
  async archiveArticle(actor: LedgerActor, articleId: string): Promise<void> {
    const article = await this.repository.articleById(articleId);
    if (article === null) throw new LedgerArticleNotFoundError(articleId);
    if (article.system) throw new LedgerArticleSystemError(articleId);
    if (!(await this.repository.archiveArticle(articleId, new Date()))) return;
    await this.roles.audit({ actorAccountId: actor.accountId, action: "ledger.article.archive", target: articleId, after: { archived: true } });
  }

  /**
   * Счёт статьи в валюте: `expense.<статья>.<валюта>` для расхода, `income.<статья>.<валюта>` для поступления.
   * Создаётся при первой проводке; параллельные вызовы создают его один раз (`ON CONFLICT DO NOTHING`), а справочник
   * проводок после создания перечитывается, не дожидаясь минуты кэша. Архивной статье новых счетов не заводим.
   */
  async ensureArticleAccount(articleId: string, currency: string): Promise<string> {
    assertCurrency(currency);
    const article = await this.repository.articleById(articleId);
    if (article === null) throw new LedgerArticleNotFoundError(articleId);
    if (article.archivedAt !== null) throw new LedgerArticleArchivedError(articleId);

    const accountId = articleAccountId(article.articleId, article.kind, currency);
    const created = await this.repository.insertArticleAccount({
      accountId,
      type: article.kind === "expense" ? "expense" : "revenue",
      currency,
      name: `${article.name}, ${currency}`,
      articleId: article.articleId,
    });
    if (created) this.ledger.forgetAccounts();
    return accountId;
  }
}
