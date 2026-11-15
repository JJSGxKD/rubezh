import { Api, InputFile } from "grammy";
import { z } from "zod";
import { chatTargetOf, type ChatRef } from "../ports/chat-target.js";
import { callBotApi, chatFields, ephemeralFields, TelegramApiError, type Ephemeral } from "./telegram-api-call.js";
import { TelegramRichApi } from "./telegram-rich-api.js";
import { updateSchema, type TelegramUpdate } from "./telegram-update-schema.js";
import { TelegramWidgetApi } from "./telegram-widget-api.js";
import { readBounded } from "../ports/source-avatar.js";

/**
 * Методы Bot API, которые нужны боту, — поверх клиента grammY
 * (docs/16-tech-stack-decisions.md §5): обновления, сообщения с кнопками,
 * картинки, документы, команды меню, вебхук и оплата в Stars.
 *
 * **grammY — транспорт, а не каркас бота.** Он даёт методы и типы Bot API,
 * которые отслеживают спецификацию, многочастную отправку файлов и разбор
 * ошибок; модули же зависят от этого класса, а не от grammY, и подменяют его
 * в тестах узким срезом (`Pick<TelegramBotApi, …>`). Маршрутизация
 * (`BotRouter`), распределённый лок опроса и вебхук с секретом остаются
 * нашими: у grammY нет лока на несколько процессов.
 *
 * Ответы Telegram — граница системы: то, что мы из них берём, по-прежнему
 * разбирается схемой, типы grammY — не проверка. Токен живёт в URL запроса, и
 * grammY его в ошибки не выносит (`sensitiveLogs` выключен).
 */

/**
 * Токен внедрения клиента. Живёт рядом с самим клиентом, а не в модуле:
 * модуль импортирует провайдеров, и всякий провайдер, которому нужен токен,
 * замкнул бы круг импортов — в ESM это не предупреждение, а падение на старте
 * («Cannot access before initialization»).
 */
export const TELEGRAM_BOT_API = Symbol("TELEGRAM_BOT_API");

export { chatFields };
export type { Ephemeral };

/** Запас сверх long polling: Telegram держит запрос до `timeout` секунд и отвечает чуть позже. */
const POLL_GRACE_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
/** Документ до 50 МБ по мобильному каналу сервера — ждём дольше обычного запроса. */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
/**
 * На предварительную проверку оплаты Telegram ждёт ответа десять секунд, а
 * дальше срывает оплату. Свой срок вдвое короче: часть окна уже ушла на
 * доставку обновления и чтение покупки.
 */
const PRE_CHECKOUT_TIMEOUT_MS = 5_000;

/**
 * Какие обновления бот читает: команды, нажатия кнопок и предварительная
 * проверка оплаты. Подтверждение и возврат оплаты приходят сообщениями.
 * Остальное Telegram не шлёт вовсе.
 */
/**
 * `widget_query` и `shared_widget_query` — запросы из живых карточек (Bot API
 * 10.4): без них в `allowed_updates` Telegram их не пришлёт.
 * `my_chat_member` — игрок заблокировал или разблокировал бота: без него
 * рассылка шла бы тем, кто нас уже не слушает (docs/35-stage4-plan.md, §3.10).
 */
export const ALLOWED_UPDATES = [
  "message",
  "callback_query",
  "pre_checkout_query",
  "my_chat_member",
  "subscription",
  "widget_query",
  "shared_widget_query",
] as const;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Разметка кнопок под сообщением — в том виде, в каком её ждёт grammY. */
type ReplyMarkup = { reply_markup?: { inline_keyboard: InlineButton[][] } };

/** Языки меню команд — те, на которых говорит бот. */
export type CommandsLanguage = "ru" | "en";

export { TelegramApiError } from "./telegram-api-call.js";
export { updateSchema, type TelegramUpdate, type TelegramUser } from "./telegram-update-schema.js";

const chatInfoSchema = z.object({
  id: z.number().int(),
  type: z.string(),
  first_name: z.string().max(256).optional(),
  last_name: z.string().max(256).optional(),
  bio: z.string().max(512).optional(),
});

const sentMessageSchema = z.object({
  message_id: z.number().int(),
  photo: z.array(z.object({ file_id: z.string() })).optional(),
});

export interface BotCommand {
  command: string;
  description: string;
  /** команда отвечает эфемерным сообщением — его видит только вызвавший */
  is_ephemeral?: boolean;
}

/** Встроенные кнопки под сообщением: запуск Mini App или нажатие с данными. */
/**
 * Кнопка под сообщением: Mini App (только HTTPS и только в личном чате),
 * обычная ссылка или ответ боту.
 */
export type InlineButton =
  | { text: string; web_app: { url: string } }
  | { text: string; url: string }
  | { text: string; callback_data: string };

export interface SendOptions {
  keyboard?: InlineButton[][];
  /** без звука уведомления */
  silent?: boolean;
  /** эфемерное сообщение: видно одному игроку */
  ephemeral?: Ephemeral;
}

/** Счёт в Telegram Stars: одна позиция, сумма целыми звёздами. */
export interface StarsInvoice {
  /** 1–32 знака: заголовок окна оплаты */
  title: string;
  /** 1–255 знаков */
  description: string;
  /** 1–128 байт; игрок его не видит, он возвращается в проверке и подтверждении оплаты */
  payload: string;
  /** подпись позиции в счёте */
  label: string;
  stars: number;
  /** подписка: Telegram списывает `stars` раз в этот период сам; сейчас он всегда 30 суток */
  subscriptionPeriodSec?: number;
}

/**
 * Сообщение, которое игрок отправит из Mini App сам (`shareMessage`): текст и
 * кнопка-ссылка. Готовит его бот — `savePreparedInlineMessage`.
 */
export interface PreparedArticle {
  /** 1–64 байта, уникален в пределах запроса */
  id: string;
  /** заголовок в окне выбора чата */
  title: string;
  /** подпись под заголовком в окне выбора чата */
  description: string;
  text: string;
  button: InlineButton;
}

const preparedSchema = z.object({ id: z.string().min(1), expiration_date: z.number().int().optional() });

/** Ответ на предварительную проверку: отказ Telegram покажет игроку этим текстом. */
export type PreCheckoutAnswer = { ok: true } | { ok: false; errorMessage: string };

export interface SentPhoto {
  messageId: number;
  /** идентификатор файла на серверах Telegram — повторная отправка без загрузки */
  fileId: string | null;
}

/** Путь файла в ответе `getFile`: без `..`, запроса и якоря — он вставляется в адрес как есть. */
const FILE_PATH = /^[A-Za-z0-9_\-./]{1,256}$/;

export class TelegramBotApi {
  private readonly api: Api;
  /** Оформленные сообщения и темы (Bot API 10.x). */
  readonly rich: TelegramRichApi;
  /** Виджеты Bot API 10.4 — сырыми вызовами, в grammY их нет. */
  readonly widgets: TelegramWidgetApi;

  constructor(
    private readonly token: string,
    /**
     * Адрес Bot API. Не константа: у локального сервера Bot API свой хост, а
     * методы и пути те же (docs/20-env-and-ports.md §3.1).
     */
    private readonly apiRoot: string,
    /**
     * Сеть — нативный `fetch` (undici), а не `node-fetch`, который grammY
     * берёт на Node по умолчанию: один HTTP-клиент на бэкенд
     * (docs/16-tech-stack-decisions.md §5), и тесты подменяют его так же.
     */
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.api = new Api(token, {
      apiRoot,
      fetch: fetchImpl as typeof fetch,
      // Срок задаёт каждый вызов своим сигналом: у долгого опроса и загрузки
      // документа он другой, а свой таймер grammY оборвал бы их раньше.
      timeoutSeconds: UPLOAD_TIMEOUT_MS / 1000,
    });
    this.rich = new TelegramRichApi(this.api);
    this.widgets = new TelegramWidgetApi(token, apiRoot, fetchImpl);
  }

  /** Кто этот бот: имя нужно для ссылки на Mini App (`t.me/<бот>?startapp`). */
  async getMe(signal?: AbortSignal): Promise<{ id: number; username: string | null; topicsEnabled: boolean }> {
    const result = await callBotApi("getMe", REQUEST_TIMEOUT_MS, signal, (abort) => this.api.getMe(abort));
    const me = z.object({ id: z.number().int(), username: z.string().optional(), has_topics_enabled: z.boolean().optional() }).parse(result);
    return { id: me.id, username: me.username ?? null, topicsEnabled: me.has_topics_enabled ?? false };
  }

  /**
   * Long polling. Нераспознанное обновление пропускается, а не роняет цикл:
   * Telegram добавляет поля, и схема обязана быть к этому терпима.
   */
  async getUpdates(offset: number | null, timeoutSec: number, signal?: AbortSignal): Promise<{ updates: TelegramUpdate[]; lastUpdateId: number | null }> {
    const result = await callBotApi("getUpdates", timeoutSec * 1000 + POLL_GRACE_MS, signal, (abort) =>
      this.api.getUpdates({ ...(offset === null ? {} : { offset }), timeout: timeoutSec, allowed_updates: allowedUpdatesParam() }, abort),
    );
    const raw = z.array(z.unknown()).parse(result);
    const updates: TelegramUpdate[] = [];
    let lastUpdateId: number | null = null;
    for (const item of raw) {
      const id = z.object({ update_id: z.number().int() }).safeParse(item);
      if (id.success) lastUpdateId = Math.max(lastUpdateId ?? id.data.update_id, id.data.update_id);
      const parsed = updateSchema.safeParse(item);
      if (parsed.success) updates.push(parsed.data);
    }
    return { updates, lastUpdateId };
  }

  async sendMessage(chat: ChatRef, text: string, signal?: AbortSignal, options: SendOptions = {}): Promise<number> {
    const { chat_id, ...thread } = chatFields(chat);
    const result = await callBotApi("sendMessage", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.sendMessage(chat_id, text, { ...thread, ...replyMarkup(options), ...sendFlags(options) }, abort),
    );
    return sentMessageSchema.parse(result).message_id;
  }

  async editMessageText(chat: ChatRef, messageId: number, text: string, signal?: AbortSignal): Promise<void> {
    await callBotApi("editMessageText", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.editMessageText(chatTargetOf(chat).chatId, messageId, text, undefined, abort),
    );
  }

  /**
   * Картинка байтами или уже загруженным `file_id`. Отправка по `file_id` не
   * гоняет файл второй раз — так кэш карточек отдаёт их мгновенно.
   */
  async sendPhoto(chat: ChatRef, photo: Buffer | string, caption: string, signal?: AbortSignal, options: SendOptions = {}): Promise<SentPhoto> {
    const { chat_id, ...thread } = chatFields(chat);
    const file = typeof photo === "string" ? photo : new InputFile(photo, "card.png");
    const sent = await callBotApi("sendPhoto", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.sendPhoto(chat_id, file, { ...thread, caption, ...replyMarkup(options) }, abort),
    );
    const result = sentMessageSchema.parse(sent);
    // Telegram отдаёт несколько размеров; самый крупный — последний.
    return { messageId: result.message_id, fileId: result.photo?.at(-1)?.file_id ?? null };
  }

  /** Документ с диска потоком: архив выгрузки не читается в память целиком. */
  async sendDocument(chat: ChatRef, path: string, fileName: string, caption: string, signal?: AbortSignal): Promise<void> {
    const { chat_id, ...thread } = chatFields(chat);
    await callBotApi("sendDocument", UPLOAD_TIMEOUT_MS, signal, (abort) =>
      this.api.sendDocument(chat_id, new InputFile(path, fileName), { ...thread, caption }, abort),
    );
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string, signal?: AbortSignal): Promise<void> {
    await callBotApi("answerCallbackQuery", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.answerCallbackQuery(callbackQueryId, text === undefined ? {} : { text }, abort),
    );
  }

  /**
   * Команды меню. Без чата — для всех; с чатом — только в нём: меню
   * администратора не показывается остальным (docs/28-diagnostics.md §6.1.2).
   */
  async setMyCommands(commands: BotCommand[], chat: ChatRef | null, signal?: AbortSignal, languageCode?: CommandsLanguage): Promise<void> {
    await callBotApi("setMyCommands", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.setMyCommands(
        commands,
        {
          scope: chat === null ? { type: "default" } : { type: "chat", chat_id: chatTargetOf(chat).chatId },
          ...(languageCode === undefined ? {} : { language_code: languageCode }),
        },
        abort,
      ),
    );
  }

  /**
   * Ссылка на счёт для `openInvoice` в Mini App. Валюта — `XTR`, токен
   * провайдера для Stars пустой: платёж идёт через Telegram, а не эквайринг.
   */
  /**
   * Профиль бота: имя, описание в пустом чате и короткое описание в профиле
   * и при пересылке. Без языка — по умолчанию для всех, с языком — для тех,
   * у кого такой язык интерфейса (bot-profile.ts).
   */
  async setMyName(name: string, languageCode: CommandsLanguage | null, signal?: AbortSignal): Promise<void> {
    await callBotApi("setMyName", REQUEST_TIMEOUT_MS, signal, (abort) => this.api.setMyName(name, languageOf(languageCode), abort));
  }

  async setMyDescription(description: string, languageCode: CommandsLanguage | null, signal?: AbortSignal): Promise<void> {
    await callBotApi("setMyDescription", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.setMyDescription(description, languageOf(languageCode), abort),
    );
  }

  async setMyShortDescription(shortDescription: string, languageCode: CommandsLanguage | null, signal?: AbortSignal): Promise<void> {
    await callBotApi("setMyShortDescription", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.setMyShortDescription(shortDescription, languageOf(languageCode), abort),
    );
  }

  /**
   * Кнопка меню — открыть Mini App. Без чата — по умолчанию для всех; у
   * кнопки нет языка, поэтому своя надпись на языке игрока ставится на его чат.
   */
  async setMenuWebApp(text: string, url: string, chatId: string | null, signal?: AbortSignal): Promise<void> {
    await callBotApi("setChatMenuButton", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.setChatMenuButton(
        { ...(chatId === null ? {} : { chat_id: Number(chatId) }), menu_button: { type: "web_app", text, web_app: { url } } },
        abort,
      ),
    );
  }

  /** Фото профиля бота — PNG; загрузка, поэтому срок как у документа. */
  async setMyProfilePhoto(png: Buffer, signal?: AbortSignal): Promise<void> {
    await callBotApi("setMyProfilePhoto", UPLOAD_TIMEOUT_MS, signal, (abort) =>
      this.api.setMyProfilePhoto({ type: "static", photo: new InputFile(png, "avatar.png") }, abort),
    );
  }

  async createInvoiceLink(invoice: StarsInvoice, signal?: AbortSignal): Promise<string> {
    const result = await callBotApi("createInvoiceLink", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.createInvoiceLink(
        invoice.title,
        invoice.description,
        invoice.payload,
        "",
        "XTR",
        [{ label: invoice.label, amount: invoice.stars }],
        invoice.subscriptionPeriodSec === undefined ? undefined : { subscription_period: invoice.subscriptionPeriodSec },
        abort,
      ),
    );
    return z.url().parse(result);
  }

  /**
   * Подготовить сообщение для `shareMessage` в Mini App. Отправить его сможет
   * только этот игрок — в личку, группу или канал по своему выбору; живёт
   * сообщение ограниченное время, срок отдаёт Telegram.
   */
  async savePreparedInlineMessage(userId: number, article: PreparedArticle, signal?: AbortSignal): Promise<{ id: string; expiresAt: Date | null }> {
    const result = await callBotApi("savePreparedInlineMessage", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.savePreparedInlineMessage(
        userId,
        {
          type: "article",
          id: article.id,
          title: article.title,
          description: article.description,
          input_message_content: { message_text: article.text },
          reply_markup: { inline_keyboard: [[article.button]] },
        },
        { allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true, allow_bot_chats: false },
        abort,
      ),
    );
    const prepared = preparedSchema.parse(result);
    return { id: prepared.id, expiresAt: prepared.expiration_date === undefined ? null : new Date(prepared.expiration_date * 1000) };
  }

  async answerPreCheckoutQuery(queryId: string, answer: PreCheckoutAnswer, signal?: AbortSignal): Promise<void> {
    await callBotApi("answerPreCheckoutQuery", PRE_CHECKOUT_TIMEOUT_MS, signal, (abort) =>
      this.api.answerPreCheckoutQuery(queryId, answer.ok, answer.ok ? undefined : { error_message: answer.errorMessage }, abort),
    );
  }

  /**
   * Состояние игрока в канале или чате: `member`, `administrator`, `creator`,
   * `restricted` (с признаком `is_member`), `left`, `kicked`. Канал отвечает,
   * только если бот в нём администратор.
   */
  async getChatMember(chat: string, userId: number, signal?: AbortSignal): Promise<{ status: string; isMember: boolean | null }> {
    const result = await callBotApi("getChatMember", REQUEST_TIMEOUT_MS, signal, (abort) => this.api.getChatMember(chat, userId, abort));
    const member = z.object({ status: z.string().max(32), is_member: z.boolean().optional() }).parse(result);
    return { status: member.status, isMember: member.is_member ?? null };
  }

  /**
   * Данные личного чата с игроком (`ChatFullInfo`): имя, фамилия и «о себе».
   * `bio` нет, если оно пустое или закрыто настройкой приватности — Telegram
   * эти случаи не различает.
   */
  async getChat(chatId: number, signal?: AbortSignal): Promise<{ firstName: string | null; lastName: string | null; bio: string | null }> {
    const result = await callBotApi("getChat", REQUEST_TIMEOUT_MS, signal, (abort) => this.api.getChat(chatId, abort));
    const chat = chatInfoSchema.parse(result);
    return { firstName: chat.first_name ?? null, lastName: chat.last_name ?? null, bio: chat.bio ?? null };
  }

  /**
   * Крупная аватарка канала или чата (`big_file_id`, 640×640); `null` — фото
   * нет. Чужой чат без бота внутри отвечает 400 или 403: вызывающий решает,
   * что с этим делать.
   */
  async getChatPhoto(chat: string, signal?: AbortSignal): Promise<string | null> {
    const result = await callBotApi("getChat", REQUEST_TIMEOUT_MS, signal, (abort) => this.api.getChat(chat, abort));
    const info = z.object({ photo: z.object({ big_file_id: z.string().min(1).max(256) }).optional() }).parse(result);
    return info.photo?.big_file_id ?? null;
  }

  /**
   * Файл по `file_id`: `getFile`, затем скачивание с файлового хоста Bot API.
   * `null` — Telegram пути не дал или файл больше `maxBytes` (читается не
   * дальше предела). Адрес файла несёт токен: наружу из ошибок он не уходит.
   */
  async downloadFile(fileId: string, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array | null> {
    const file = await callBotApi("getFile", REQUEST_TIMEOUT_MS, signal, (abort) => this.api.getFile(fileId, abort));
    const path = z.object({ file_path: z.string().optional() }).parse(file).file_path;
    if (path === undefined || !FILE_PATH.test(path) || path.split("/").includes("..")) return null;
    return await callBotApi("downloadFile", REQUEST_TIMEOUT_MS, signal, async (abort) => {
      const response = await this.fetchImpl(`${this.apiRoot}/file/bot${this.token}/${path}`, { method: "GET", signal: abort as unknown as AbortSignal, redirect: "manual" });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new TelegramApiError("downloadFile", response.status, "файл не отдан", null);
      }
      return await readBounded(response, maxBytes);
    });
  }

  /** Вернуть звёзды игроку. Отказ `CHARGE_ALREADY_REFUNDED` — повтор уже сделанного возврата. */
  async refundStarPayment(userId: number, chargeId: string, signal?: AbortSignal): Promise<void> {
    await callBotApi("refundStarPayment", REQUEST_TIMEOUT_MS, signal, (abort) => this.api.refundStarPayment(userId, chargeId, abort));
  }

  /** Выписка звёзд бота: операции по порядку времени, от старых к новым (`offset`, `limit` 1–100). Ответ разбирает адаптер выписки. */
  async getStarTransactions(offset: number, limit: number, signal?: AbortSignal): Promise<unknown> {
    return callBotApi("getStarTransactions", REQUEST_TIMEOUT_MS, signal, (abort) => this.api.getStarTransactions({ offset, limit }, abort));
  }

  /**
   * Отменить продление подписки игрока (`canceled: true`) или вернуть то,
   * что отменил бот. Отменённое игроком бот вернуть не может — только сам
   * игрок в Telegram.
   */
  async editUserStarSubscription(userId: number, chargeId: string, canceled: boolean, signal?: AbortSignal): Promise<void> {
    await callBotApi("editUserStarSubscription", REQUEST_TIMEOUT_MS, signal, (abort) => this.api.editUserStarSubscription(userId, chargeId, canceled, abort));
  }

  async setWebhook(url: string, secretToken: string, signal?: AbortSignal): Promise<void> {
    await callBotApi("setWebhook", REQUEST_TIMEOUT_MS, signal, (abort) =>
      this.api.setWebhook(url, { secret_token: secretToken, allowed_updates: allowedUpdatesParam(), drop_pending_updates: false }, abort),
    );
  }

  async deleteWebhook(signal?: AbortSignal): Promise<void> {
    await callBotApi("deleteWebhook", REQUEST_TIMEOUT_MS, signal, (abort) => this.api.deleteWebhook({ drop_pending_updates: false }, abort));
  }
}

/** Язык профиля: `null` — по умолчанию для всех, без поля в запросе. */
function languageOf(languageCode: CommandsLanguage | null): { language_code?: CommandsLanguage } {
  return languageCode === null ? {} : { language_code: languageCode };
}

function replyMarkup(options: SendOptions): ReplyMarkup {
  return options.keyboard === undefined ? {} : { reply_markup: { inline_keyboard: options.keyboard } };
}

/** Тихая отправка и эфемерность: поля попадают в запрос, только когда заданы. */
function sendFlags(options: SendOptions): { disable_notification?: boolean; ephemeral_message_parameters?: ReturnType<typeof ephemeralFields> } {
  return {
    ...(options.silent === undefined ? {} : { disable_notification: options.silent }),
    ...(options.ephemeral === undefined ? {} : { ephemeral_message_parameters: ephemeralFields(options.ephemeral) }),
  };
}

/**
 * Список обновлений для запроса. Типы grammY 1.46.0 не знают `widget_query`,
 * хотя Telegram их принимает; приведение уйдёт вместе с переходом на методы
 * grammY.
 */
function allowedUpdatesParam(): NonNullable<NonNullable<Parameters<Api["getUpdates"]>[0]>["allowed_updates"]> {
  return [...ALLOWED_UPDATES] as unknown as NonNullable<NonNullable<Parameters<Api["getUpdates"]>[0]>["allowed_updates"]>;
}
