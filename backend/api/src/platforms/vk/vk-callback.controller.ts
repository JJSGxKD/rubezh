import { createHash, timingSafeEqual } from "node:crypto";
import { Body, Controller, HttpCode, Logger, Post } from "@nestjs/common";
import { Public } from "../../common/access.js";
import { DisabledError, UnauthorizedError, UnavailableError, ValidationError } from "../../common/domain-error.js";
import { VkApi } from "./vk-api.js";
import { VkCommunity } from "./vk-community.js";
import { callbackBodySchema, messageEventOf } from "./vk-events.js";
import { VkEventQueue } from "./vk-event-queue.js";

/**
 * Вебхук Callback API сообщества VK (docs/35-stage4-plan.md Р188,
 * tasks/T-0378). VK шлёт сюда события сообщества: подтверждение сервера и
 * сообщения игроков.
 *
 * - **Секрет** из поля `secret` тела — единственная защита, неугадываемый
 *   адрес ею не считается. Сверка — за постоянное время, до разбора тела:
 *   неверный секрет — 401, и дальше запрос не идёт.
 * - **Сначала очередь, потом `ok`**, как у вебхука Telegram: событие записано
 *   в Redis до ответа, иначе перезапуск процесса его терял бы. Повтор доставки
 *   отсекает id задания (`event_id`). Redis недоступен — 503, и VK повторит.
 * - **Ответ — текст, а не `{ data }`**: Callback API требует строку `ok` (на
 *   подтверждение — строку подтверждения), иначе VK считает доставку
 *   неудавшейся и повторяет её. Это осознанное исключение из формата ответов
 *   API.
 * - Метрика `vk_callback_total{type,result}` — строкой лога, пока в бэкенде
 *   нет Prometheus (docs/22 §3.3); тип — из закрытого списка, чужие — `other`.
 */

const OK = "ok";

/** Типы событий, которые различает метрика: остальные — `other`, чтобы чужой текст не стал меткой. */
const KNOWN_TYPES: ReadonlySet<string> = new Set(["confirmation", "message_new"]);

@Controller("vk")
export class VkCallbackController {
  private readonly logger = new Logger("vk");

  constructor(
    private readonly community: VkCommunity,
    private readonly queue: VkEventQueue,
    private readonly api: VkApi,
  ) {}

  // Открыт наружу по замыслу: события шлёт VK, а не игрок. Защита — секрет в
  // теле, её делает сам обработчик.
  @Public()
  @Post("callback")
  @HttpCode(200)
  async receive(@Body() body: unknown): Promise<string> {
    const expected = this.community.callbackSecret();
    // Бота нет — для внешнего мира нет и ручки.
    if (this.community.token() === null || expected === null) throw new DisabledError("Бот сообщества VK выключен");
    if (!sameSecret(secretOf(body), expected)) throw new UnauthorizedError("Неверный секрет события");

    const parsed = callbackBodySchema.safeParse(body);
    if (!parsed.success) throw new ValidationError("Непонятное событие VK");
    const event = parsed.data;
    const type = KNOWN_TYPES.has(event.type) ? event.type : "other";

    if (event.type === "confirmation") {
      const answer = await this.confirmation(event.group_id);
      this.record(type, "confirmed");
      return answer;
    }
    if (event.type !== "message_new") {
      this.record(type, "ignored");
      return OK;
    }
    const message = messageEventOf(event);
    if (message === null) {
      this.record(type, "ignored");
      return OK;
    }
    try {
      await this.queue.enqueue(message);
    } catch (error: unknown) {
      // Не записано — `ok` не отвечаем: VK повторит доставку, а повтор отсечёт id
      // задания, если запись всё же дошла.
      this.logger.warn(JSON.stringify({ module: "vk", event: "vk_enqueue_failed", reason: error instanceof Error ? error.message : "unknown" }));
      this.record(type, "queue_failed");
      throw new UnavailableError("Очередь событий недоступна");
    }
    this.record(type, "queued");
    return OK;
  }

  /** Строка подтверждения — только для своего сообщества: чужому серверу VK мы не отвечаем. */
  private async confirmation(groupId: number): Promise<string> {
    const community = this.community.ref();
    const answer = this.community.confirmation();
    if (community === null || answer === null) throw new DisabledError("Подтверждение сервера VK не настроено");
    const own = community.id ?? (await this.ownGroupId(community.screenName));
    if (String(groupId) !== own) throw new UnauthorizedError("Событие другого сообщества");
    return answer;
  }

  /** Сообщество в настройке задано коротким именем: числовой id событий VK спрашивается у самого VK. */
  private async ownGroupId(screenName: string): Promise<string> {
    try {
      return await this.api.groupId(screenName);
    } catch (error: unknown) {
      this.logger.warn(JSON.stringify({ module: "vk", event: "vk_group_id_failed", reason: error instanceof Error ? error.message : "unknown" }));
      throw new UnavailableError("VK не назвал сообщество — повторите подтверждение");
    }
  }

  private record(type: string, result: string): void {
    this.logger.log(JSON.stringify({ module: "vk", event: "vk_callback", type, result }));
  }
}

/** Поле `secret` тела; не строка или нет тела — пустая строка, которая с секретом не совпадёт. */
function secretOf(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "";
  const secret: unknown = (body as Record<string, unknown>).secret;
  return typeof secret === "string" ? secret : "";
}

/**
 * Сравнение за постоянное время: по времени ответа секрет не подбирается.
 * Сравниваются отпечатки, а не строки: у них одна длина, и `timingSafeEqual`
 * не бросает на секрете другой длины.
 */
function sameSecret(received: string, expected: string): boolean {
  const left = createHash("sha256").update(received).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}
