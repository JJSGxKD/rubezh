import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { UnavailableError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { AppLinks } from "../../platforms/ports/app-links.js";
import { ACCOUNT_REPOSITORY, type Account, type AccountRepository } from "../auth/account.repository.js";
import { RolesService } from "../roles/roles.service.js";
import { AdminSessionService, type AdminLogin } from "./admin-session.service.js";
import { PANEL_LOGIN_STORE, type PanelLoginStore } from "./panel-login.store.js";

/**
 * Вход в панель подтверждением в боте (docs/29-admin-panel.md §8).
 *
 * Панель открывает запрос и показывает код и ссылку на бота; администратор
 * открывает бота, сверяет код и нажимает «Войти»; панель опросом забирает
 * сессию. Виджет Telegram не годится: ему нужен домен, вписанный в BotFather,
 * и скрипты `telegram.org`, которые из российской сети открываются не у всех,
 * а бот работает уже сейчас — через тот же прокси Bot API.
 *
 * Чего боимся и что против этого:
 *
 * - **чужая ссылка** — злоумышленник открывает запрос у себя и присылает
 *   администратору ссылку: бот показывает код, браузер и сеть того, кто
 *   открыл запрос, и просит сверить код с экраном — «Это не я» отклоняет;
 * - **подсмотренная ссылка** — в ней только номер запроса, а сессию выдают по
 *   секрету, который знает лишь открывшая запрос вкладка;
 * - **повтор** — запрос подтверждается один раз, сессию по нему забирает один
 *   опрос, живёт он пять минут.
 */

const LOGIN_TTL_SEC = 300;
/** В параметре `start` Telegram пускает латиницу, цифры, `_` и `-` — до 64 знаков. */
export const PANEL_LOGIN_PREFIX = "panel-";
const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;
const STORE_TIMEOUT_MS = 2_000;

export interface PanelLoginOpened {
  requestId: string;
  /** отдаётся вкладке один раз; на сервере — только хэш */
  secret: string;
  code: string;
  /** ссылка на бота с запросом в параметре старта */
  link: string;
  expiresAtMs: number;
}

/** Что показать в боте перед подтверждением. */
export interface PanelLoginPrompt {
  code: string;
  device: string;
  place: string;
  expiresAtMs: number;
}

/** Кто подтверждает — как его назвала площадка. */
export interface PanelLoginConfirmer {
  platform: "telegram";
  platformUserId: string;
  displayName: string;
  username: string | null;
}

export type PanelLoginVerdict = "confirmed" | "declined" | "no_role" | "banned" | "expired";

export type PanelLoginPoll =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "declined"; reason: "declined" | "no_role" | "banned" }
  | { status: "confirmed"; login: AdminLogin };

@Injectable()
export class PanelLoginService {
  private readonly logger = new Logger("admin");

  constructor(
    @Inject(PANEL_LOGIN_STORE) private readonly store: PanelLoginStore,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly roles: RolesService,
    private readonly sessions: AdminSessionService,
    private readonly links: AppLinks,
  ) {}

  async open(from: { userAgent: string | null; ip: string }, nowMs = Date.now()): Promise<PanelLoginOpened> {
    this.sessions.ensureEnabled();
    const requestId = randomBytes(16).toString("base64url");
    const link = this.links.chat("telegram", `${PANEL_LOGIN_PREFIX}${requestId}`);
    // Имя бота узнаётся при старте: до этого ссылку не собрать.
    if (link === null) throw new UnavailableError("Бот ещё не представился — повторите через минуту");
    const secret = randomBytes(32).toString("base64url");
    const code = String(randomInt(1000, 10_000));
    await withTimeout(
      this.store.create(
        requestId,
        { secretHash: hashOf(secret), code, device: deviceOf(from.userAgent), place: placeOf(from.ip), createdAtMs: nowMs, status: "pending", accountId: null, reason: null },
        LOGIN_TTL_SEC,
      ),
      STORE_TIMEOUT_MS,
      "запрос входа",
    );
    return { requestId, secret, code, link, expiresAtMs: nowMs + LOGIN_TTL_SEC * 1000 };
  }

  /** Запрос, который ещё ждёт подтверждения; `null` — истёк, неизвестен или уже решён. */
  async prompt(requestId: string): Promise<PanelLoginPrompt | null> {
    if (!REQUEST_ID.test(requestId)) return null;
    const request = await this.store.get(requestId);
    if (request === null || request.status !== "pending") return null;
    return { code: request.code, device: request.device, place: request.place, expiresAtMs: request.createdAtMs + LOGIN_TTL_SEC * 1000 };
  }

  /**
   * Подтверждение из бота. Аккаунт заводится так же, как при входе в игру:
   * аварийный список владельцев в окружении действует и здесь. Без роли и с
   * блокировкой запрос отклоняется — панель узнает об этом опросом.
   */
  async confirm(requestId: string, who: PanelLoginConfirmer, nowMs = Date.now()): Promise<PanelLoginVerdict> {
    if ((await this.prompt(requestId)) === null) return "expired";
    const account = await this.accounts.upsert({ ...who, photoUrl: null }, nowMs);
    const reason = await this.refusalOf(account);
    const settled = await this.store.settle(requestId, reason === null ? "confirmed" : "declined", account.accountId, reason);
    if (!settled) return "expired";
    this.log(reason === null ? "log" : "warn", reason === null ? "panel_login_confirmed" : "panel_login_refused", { accountId: account.accountId, ...(reason === null ? {} : { reason }) });
    return reason ?? "confirmed";
  }

  /** «Это не я»: запрос открыл кто-то другой — в лог, чтобы было видно попытки. */
  async decline(requestId: string, who: PanelLoginConfirmer): Promise<boolean> {
    if (!REQUEST_ID.test(requestId)) return false;
    const settled = await this.store.settle(requestId, "declined", null, "declined");
    if (settled) this.log("warn", "panel_login_declined", { platformUserId: who.platformUserId });
    return settled;
  }

  /** Опрос вкладки: ждём, отказано или сессия — один раз. Чужой секрет неотличим от истёкшего запроса. */
  async poll(requestId: string, secret: string, nowMs = Date.now()): Promise<PanelLoginPoll> {
    this.sessions.ensureEnabled();
    if (!REQUEST_ID.test(requestId)) return { status: "expired" };
    const request = await withTimeout(this.store.get(requestId), STORE_TIMEOUT_MS, "запрос входа");
    if (request === null || !sameHash(request.secretHash, hashOf(secret))) return { status: "expired" };
    if (request.status === "pending") return { status: "pending" };
    if (request.status === "declined") return { status: "declined", reason: reasonOf(request.reason) };
    const accountId = await withTimeout(this.store.take(requestId), STORE_TIMEOUT_MS, "запрос входа");
    // Сессию уже забрал другой опрос той же вкладки.
    if (accountId === null) return { status: "expired" };
    return { status: "confirmed", login: await this.sessions.loginConfirmed(accountId, nowMs) };
  }

  /** Почему в панель нельзя; `null` — можно. */
  private async refusalOf(account: Account): Promise<"banned" | "no_role" | null> {
    if (account.bannedAt !== null) return "banned";
    const roles = await this.roles.rolesFor({ accountId: account.accountId, platform: account.platform, platformUserId: account.platformUserId });
    return roles.length === 0 ? "no_role" : null;
  }

  private log(level: "log" | "warn", event: string, fields: Record<string, unknown>): void {
    this.logger[level](JSON.stringify({ module: "admin", event, ...fields }));
  }
}

function hashOf(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function sameHash(left: string, right: string): boolean {
  return left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function reasonOf(reason: string | null): "declined" | "no_role" | "banned" {
  return reason === "no_role" || reason === "banned" ? reason : "declined";
}

/** Порядок важен: Edge и Яндекс Браузер называют себя ещё и Chrome, а Chrome — Safari. */
const BROWSERS: readonly (readonly [RegExp, string])[] = [
  [/YaBrowser\//, "Яндекс Браузер"],
  [/Edg\//, "Edge"],
  [/OPR\//, "Opera"],
  [/Firefox\//, "Firefox"],
  [/Chrome\//, "Chrome"],
  [/Safari\//, "Safari"],
];
/** Android — раньше Linux: он и есть Linux в заголовке. */
const SYSTEMS: readonly (readonly [RegExp, string])[] = [
  [/Windows/, "Windows"],
  [/Android/, "Android"],
  [/iPhone|iPad/, "iOS"],
  [/Mac OS X/, "macOS"],
  [/Linux/, "Linux"],
];

/** Браузер и система по заголовку — грубо и нарочно: сверить «это мой ноутбук», а не опознать. */
export function deviceOf(userAgent: string | null): string {
  const ua = userAgent ?? "";
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1];
  const parts = [browser, system].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? "неизвестный браузер" : parts.join(" · ");
}

/** Адрес до сети: IPv4 — две первые части, IPv6 — две первые группы. */
export function placeOf(ip: string): string {
  const v4 = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (v4 !== null) return `${v4[1]}.${v4[2]}.*.*`;
  const groups = ip.split(":").filter((group) => group !== "");
  return groups.length >= 2 ? `${groups[0]}:${groups[1]}:…` : "неизвестный адрес";
}
