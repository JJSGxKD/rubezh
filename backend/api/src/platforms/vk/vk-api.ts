import { randomInt } from "node:crypto";
import { z } from "zod";
import { VK_API_URL, VK_API_VERSION } from "../../modules/secrets/secret-catalog.js";
import { parseVkCommunity } from "../../modules/settings/setting-catalog.js";
import { MembershipRejectedError, MembershipUnavailableError } from "../ports/channel-membership.js";
import type { VkCommunity } from "./vk-community.js";

/**
 * Методы API VK ключом сообщества (docs/35-stage4-plan.md Р188,
 * tasks/T-0378): проверка вступления, ответ игроку, числовой id сообщества.
 *
 * - **Ключ — в теле запроса**, не в адресе: адрес попадает в журналы по
 *   дороге. В тексты ошибок он тоже не попадает.
 * - **VK отвечает 200 и на отказ**: ошибка лежит в теле (`error.error_code`).
 *   Поэтому «не получилось» разбирается по коду, а не по статусу.
 * - Ответ — граница системы: разбирается схемой, а не приводится.
 */

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Ошибки VK, после которых повтор не поможет, пока человек не поправит
 * настройку: ключ неверный, у него нет права или метод ему недоступен,
 * сообщество не найдено. Коды — по описанию ошибок API VK (dev.vk.com,
 * «Ошибки»). Остальные — лимиты (6, 9, 29), сбои (1, 10) и любой незнакомый
 * код: он трактуется как «позже», потому что принять незнакомую ошибку за
 * неверную настройку задания хуже, чем попросить игрока повторить.
 */
export const VK_ACCESS_ERRORS: ReadonlyMap<number, string> = new Map([
  [5, "ключ доступа не принят"],
  [7, "у ключа нет права на это действие"],
  [15, "доступ запрещён"],
  [27, "метод недоступен с ключом сообщества"],
  [28, "ключ приложения не принят"],
  [100, "неверный параметр: сообщество не найдено"],
  [125, "неверный id сообщества"],
  [203, "доступ к сообществу запрещён"],
]);

/** VK не знает такого игрока: он не состоит нигде. Это ответ «нет», а не ошибка настройки. */
const UNKNOWN_USER = 113;

/** Сообщество не включило возможности ботов: кнопок под сообщением быть не может, а текст дойдёт. */
const BOT_FEATURES_OFF = 912;

/** Как долго помнится числовой id сообщества: он не меняется, но имя в настройке может смениться. */
const GROUP_ID_MEMORY_MS = 60 * 60_000;

export type VkFailure = "access" | "transient";

/** VK не выполнил запрос. `access` — нужна рука человека, `transient` — повтор может помочь. */
export class VkApiError extends Error {
  override readonly name = "VkApiError";

  constructor(
    message: string,
    readonly kind: VkFailure,
    readonly code: number | null = null,
  ) {
    super(message);
  }
}

/** Кнопка-ссылка под сообщением сообщества. */
export interface VkKeyboard {
  readonly inline: true;
  readonly buttons: readonly (readonly VkLinkButton[])[];
}

export interface VkLinkButton {
  readonly action: { readonly type: "open_link"; readonly link: string; readonly label: string };
}

const errorBodySchema = z.object({ error: z.object({ error_code: z.number().int(), error_msg: z.string().optional() }) });
const memberSchema = z.union([z.literal(1), z.literal(0), z.boolean()]);
const groupSchema = z.object({ id: z.number().int().positive() });
// До версии 5.139 ответ — массив, позже — объект с `groups`.
const groupsSchema = z.union([z.array(groupSchema).min(1), z.object({ groups: z.array(groupSchema).min(1) })]);

export class VkApi {
  private readonly groupIds = new Map<string, { id: string; at: number }>();

  /**
   * @param fetchImpl `fetch` клиента исходящих запросов (`vk.api`) — у него журнал и прокси
   * @param randomId источник `random_id`: подменяется в тестах
   */
  constructor(
    private readonly community: Pick<VkCommunity, "token">,
    private readonly fetchImpl: typeof fetch,
    private readonly randomId: () => number = () => randomInt(1, 2 ** 31),
  ) {}

  /**
   * Состоит ли игрок в сообществе (`groups.isMember`).
   * @throws MembershipUnavailableError VK не ответил или ответил сбоем — повтор может помочь
   * @throws MembershipRejectedError ключ, права или сообщество в настройке задания неверны
   */
  async isMember(group: string, userId: string): Promise<boolean> {
    const community = parseVkCommunity(group);
    if (community === null) throw new MembershipRejectedError(`сообщество «${group}» записано не так, как его понимает VK`);
    try {
      const result = await this.call("groups.isMember", { group_id: community.id ?? community.screenName, user_id: userId });
      const answer = memberSchema.safeParse(result);
      if (!answer.success) throw new VkApiError("VK ответил на groups.isMember непонятно", "transient");
      return answer.data === 1 || answer.data === true;
    } catch (error: unknown) {
      if (!(error instanceof VkApiError)) throw error;
      if (error.code === UNKNOWN_USER) return false;
      if (error.kind === "access") throw new MembershipRejectedError(error.message);
      throw new MembershipUnavailableError(error.message);
    }
  }

  /**
   * Сообщение игроку от имени сообщества (`messages.send`). Не получилось
   * с кнопкой, потому что у сообщества не включены возможности ботов, —
   * то же сообщение уходит без неё: ссылка в тексте всё равно есть.
   */
  async sendMessage(userId: string, text: string, keyboard?: VkKeyboard): Promise<void> {
    if (keyboard !== undefined) {
      try {
        await this.call("messages.send", { user_id: userId, random_id: String(this.randomId()), message: text, keyboard: JSON.stringify(keyboard) });
        return;
      } catch (error: unknown) {
        if (!(error instanceof VkApiError) || error.code !== BOT_FEATURES_OFF) throw error;
      }
    }
    await this.call("messages.send", { user_id: userId, random_id: String(this.randomId()), message: text });
  }

  /** Числовой id сообщества по короткому имени (`groups.getById`): id в событиях VK — число. */
  async groupId(screenName: string): Promise<string> {
    const known = this.groupIds.get(screenName);
    if (known !== undefined && Date.now() - known.at < GROUP_ID_MEMORY_MS) return known.id;
    const answer = groupsSchema.safeParse(await this.call("groups.getById", { group_id: screenName }));
    if (!answer.success) throw new VkApiError("VK ответил на groups.getById непонятно", "transient");
    const first = Array.isArray(answer.data) ? answer.data[0] : answer.data.groups[0];
    if (first === undefined) throw new VkApiError("VK не назвал сообщество", "transient");
    const id = String(first.id);
    this.groupIds.set(screenName, { id, at: Date.now() });
    return id;
  }

  /** Один вызов метода. Возвращает `response` или бросает `VkApiError`. */
  private async call(method: string, params: Record<string, string>): Promise<unknown> {
    const token = this.community.token();
    if (token === null) throw new VkApiError("ключ доступа сообщества VK не задан", "transient");
    let response: Response;
    try {
      response = await this.fetchImpl(`${VK_API_URL}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ ...params, v: VK_API_VERSION, access_token: token }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      const timeout = error instanceof Error && error.name === "TimeoutError";
      throw new VkApiError(timeout ? `VK не ответил на ${method} за ${String(REQUEST_TIMEOUT_MS / 1000)} с` : `VK недоступен (${method})`, "transient");
    }
    if (!response.ok) throw new VkApiError(`VK ответил на ${method} статусом ${String(response.status)}`, "transient");
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new VkApiError(`VK ответил на ${method} не JSON`, "transient");
    }
    const failure = errorBodySchema.safeParse(body);
    if (failure.success) {
      const { error_code: code, error_msg: message } = failure.data.error;
      const reason = VK_ACCESS_ERRORS.get(code) ?? message ?? "ошибка VK";
      throw new VkApiError(`VK отклонил ${method} (код ${String(code)}): ${reason}`.replaceAll(token, "***"), VK_ACCESS_ERRORS.has(code) ? "access" : "transient", code);
    }
    if (typeof body !== "object" || body === null || !("response" in body)) throw new VkApiError(`VK ответил на ${method} непонятно`, "transient");
    return body.response;
  }
}
