import type { InvitePayload, InviteResult } from "@bh/shared-types";
import { on, postEvent } from "@tma.js/sdk";

/**
 * Приглашение — отдельным чанком: адаптер берёт этот модуль по нажатию
 * кнопки, первому кадру он не нужен.
 */

/**
 * Приглашение вне Telegram: системный лист «поделиться», если браузер его
 * даёт, иначе копия ссылки в буфер. Отмена листа игроком — не ошибка.
 */
export async function inviteFromBrowser(invite: InvitePayload): Promise<InviteResult> {
  const nav = globalThis.navigator as Navigator | undefined;
  if (nav?.share !== undefined) {
    try {
      await nav.share({ url: invite.url, text: invite.text });
      return "shared";
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === "AbortError") return "shared";
      // Лист не открылся — пробуем скопировать ссылку ниже.
    }
  }
  if (nav?.clipboard !== undefined) {
    try {
      await nav.clipboard.writeText(`${invite.text} ${invite.url}`);
      return "copied";
    } catch {
      // Буфер обмена запрещён (нет фокуса или разрешения) — сообщаем, что не вышло.
      return "unavailable";
    }
  }
  return "unavailable";
}

/** Что нужно от SDK Telegram для сообщения от бота — подменяется в тестах. */
export interface PreparedMessageSdk {
  isAvailable(): boolean;
  share(messageId: string): Promise<void>;
}

/** Игрок закрыл окно выбора чата сам — это не сбой, и «не получилось» здесь врало бы. */
const DECLINED = /USER_DECLINED/;

/**
 * Сообщение, подготовленное ботом (`savePreparedInlineMessage`), — через
 * `shareMessage` Mini Apps 8.0: Telegram открывает выбор чата, пишет игрок.
 */
export async function sharePreparedWith(sdk: PreparedMessageSdk, messageId: string): Promise<InviteResult> {
  if (!sdk.isAvailable()) return "unavailable";
  try {
    await sdk.share(messageId);
    return "shared";
  } catch (error: unknown) {
    if (error instanceof Error && DECLINED.test(`${error.name} ${error.message}`)) return "cancelled";
    // Сообщение устарело или Telegram его не отправил — игрок увидит «не вышло» и попробует снова.
    console.warn("Сообщение от бота не отправилось:", error);
    return "unavailable";
  }
}


/**
 * Сообщение от бота — прямо событием моста, а не `shareMessage` из SDK: мост и
 * так в сборке, а обёртка SDK — лишний код ради одной кнопки.
 */
const bridge: PreparedMessageSdk = {
  isAvailable: () => true,
  share(messageId) {
    return new Promise<void>((resolve, reject) => {
      const stop = (): void => {
        offSent();
        offFailed();
      };
      const offSent = on("prepared_message_sent", () => {
        stop();
        resolve();
      });
      const offFailed = on("prepared_message_failed", (payload) => {
        stop();
        reject(new Error(payload.error));
      });
      try {
        postEvent("web_app_send_prepared_message", { id: messageId });
      } catch (error: unknown) {
        stop();
        reject(error instanceof Error ? error : new Error("мост Telegram не принял событие"));
      }
    });
  },
};

/** Доступность уже проверил адаптер (`inviteMethods`) — здесь только отправка. */
export async function sharePrepared(messageId: string): Promise<InviteResult> {
  return await sharePreparedWith(bridge, messageId);
}
