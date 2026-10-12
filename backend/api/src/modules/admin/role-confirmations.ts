import { randomBytes } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";
import { z } from "zod";
import { ForbiddenError, UnavailableError } from "../../common/domain-error.js";
import { withTimeout } from "../../common/with-timeout.js";
import { REDIS } from "../../infra/redis.js";
import { AppLinks } from "../../platforms/ports/app-links.js";
import { ACCOUNT_REPOSITORY, type AccountRepository } from "../auth/account.repository.js";
import { ROLES, type Role } from "../roles/permissions.js";
import { RolesService, type AccountRef } from "../roles/roles.service.js";

/**
 * Выдача ролей владельца и администратора с подтверждением в Telegram
 * (docs/29-admin-panel.md §3.4, правило двух ключей; решение 06.10.2026).
 *
 * Панель открывает запрос и получает ссылку на бота; подтверждает тот, кто
 * выдаёт, в личном чате с ботом. Забытая открытой сессия панели роль не
 * выдаст: без доступа к Telegram выдающего запрос не подтвердить. Устройство
 * такое же, как у входа в панель через бота (`panel-login.service.ts`).
 *
 * Права выдающего проверяются в момент подтверждения, а не открытия: за десять
 * минут их могли отозвать.
 */

/** В параметре `start` Telegram пускает латиницу, цифры, `_` и `-` — до 64 знаков. */
export const ROLE_CONFIRM_PREFIX = "role-";
export const ROLE_CONFIRM_TTL_SEC = 600;
/** Остальные роли выдаются сразу, снятие любой роли подтверждения не требует: оно убирает доступ, а не даёт его. */
export const CONFIRMED_ROLES: readonly Role[] = ["owner", "admin"];

const REQUEST_ID = /^[A-Za-z0-9_-]{22}$/;
const STORE_TIMEOUT_MS = 2_000;

/** Имена ролей в сообщении бота — те же, что в списке ролей панели. */
const ROLE_TITLES: Readonly<Partial<Record<Role, string>>> = {
  owner: "Владелец",
  admin: "Администратор",
};

/** Строки из Redis — граница: всё, что не разбирается, считается отсутствующим запросом. */
const requestSchema = z.object({
  actorAccountId: z.string(),
  actorPlatformUserId: z.string(),
  targetAccountId: z.string(),
  role: z.enum(ROLES),
  createdAtMs: z.number().int(),
});

type StoredRequest = z.infer<typeof requestSchema>;

export interface RoleConfirmOpened {
  link: string;
  expiresAtMs: number;
}

/** Что показать в боте перед подтверждением. */
export interface RoleConfirmPrompt {
  roleTitle: string;
  targetName: string;
  targetPlatformUserId: string;
  expiresAtMs: number;
}

export type RoleConfirmVerdict = "granted" | "already" | "expired" | "foreign" | "no_right";

@Injectable()
export class RoleConfirmations {
  private readonly logger = new Logger("admin");

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    private readonly roles: RolesService,
    private readonly links: AppLinks,
  ) {}

  async open(actor: AccountRef, targetAccountId: string, role: Role, nowMs = Date.now()): Promise<RoleConfirmOpened> {
    if (actor.platform !== "telegram") throw new ForbiddenError("Подтвердить выдачу можно только через Telegram — войдите в панель через бота");
    const requestId = randomBytes(16).toString("base64url");
    const link = this.links.chat("telegram", `${ROLE_CONFIRM_PREFIX}${requestId}`);
    // Имя бота узнаётся при старте: до этого ссылку не собрать.
    if (link === null) throw new UnavailableError("Бот ещё не представился — повторите через минуту");
    const request: StoredRequest = { actorAccountId: actor.accountId, actorPlatformUserId: actor.platformUserId, targetAccountId, role, createdAtMs: nowMs };
    await withTimeout(this.redis.set(keyOf(requestId), JSON.stringify(request), "EX", ROLE_CONFIRM_TTL_SEC), STORE_TIMEOUT_MS, "запрос выдачи роли");
    return { link, expiresAtMs: nowMs + ROLE_CONFIRM_TTL_SEC * 1000 };
  }

  /** Что показать в боте; просмотр запрос не расходует. */
  async prompt(requestId: string, fromPlatformUserId: string): Promise<RoleConfirmPrompt | "expired" | "foreign"> {
    if (!REQUEST_ID.test(requestId)) return "expired";
    const raw = await withTimeout(this.redis.get(keyOf(requestId)), STORE_TIMEOUT_MS, "запрос выдачи роли");
    const request = parse(raw);
    if (request === null) return "expired";
    if (request.actorPlatformUserId !== fromPlatformUserId) return "foreign";
    const target = await this.accounts.byId(request.targetAccountId);
    if (target === null) return "expired";
    return {
      roleTitle: ROLE_TITLES[request.role] ?? request.role,
      targetName: target.displayName,
      targetPlatformUserId: target.platformUserId,
      expiresAtMs: request.createdAtMs + ROLE_CONFIRM_TTL_SEC * 1000,
    };
  }

  async confirm(requestId: string, fromPlatformUserId: string, nowMs = Date.now()): Promise<RoleConfirmVerdict> {
    const taken = await this.take(requestId, fromPlatformUserId, nowMs);
    if (taken === "expired" || taken === "foreign") return taken;
    const actor: AccountRef = { accountId: taken.actorAccountId, platform: "telegram", platformUserId: taken.actorPlatformUserId };
    try {
      const granted = await this.roles.grant(actor, taken.targetAccountId, taken.role);
      if (granted) this.logger.log(JSON.stringify({ module: "admin", event: "role_grant_confirmed", actorAccountId: taken.actorAccountId, targetAccountId: taken.targetAccountId, role: taken.role }));
      return granted ? "granted" : "already";
    } catch (error: unknown) {
      if (error instanceof ForbiddenError) return "no_right";
      throw error;
    }
  }

  /** Отмена своего запроса; чужой остаётся как был. */
  async decline(requestId: string, fromPlatformUserId: string, nowMs = Date.now()): Promise<boolean> {
    const taken = await this.take(requestId, fromPlatformUserId, nowMs);
    return taken !== "expired" && taken !== "foreign";
  }

  /**
   * Забрать запрос атомарно (`GETDEL`): подтвердить его можно один раз, даже
   * при двух одновременных нажатиях. Чужое нажатие запрос не сжигает — он
   * возвращается с оставшимся сроком, а не с новым.
   */
  private async take(requestId: string, fromPlatformUserId: string, nowMs: number): Promise<StoredRequest | "expired" | "foreign"> {
    if (!REQUEST_ID.test(requestId)) return "expired";
    const key = keyOf(requestId);
    const raw = await withTimeout(this.redis.getdel(key), STORE_TIMEOUT_MS, "запрос выдачи роли");
    const request = parse(raw);
    if (request === null) return "expired";
    const remainingMs = request.createdAtMs + ROLE_CONFIRM_TTL_SEC * 1000 - nowMs;
    if (remainingMs <= 0) return "expired";
    if (request.actorPlatformUserId !== fromPlatformUserId) {
      await withTimeout(this.redis.set(key, JSON.stringify(request), "PX", remainingMs, "NX"), STORE_TIMEOUT_MS, "запрос выдачи роли");
      this.logger.warn(JSON.stringify({ module: "admin", event: "role_confirm_foreign", fromPlatformUserId }));
      return "foreign";
    }
    return request;
  }
}

function keyOf(requestId: string): string {
  return `admin:role-confirm:${requestId}`;
}

function parse(raw: string | null): StoredRequest | null {
  if (raw === null) return null;
  try {
    const parsed = requestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
