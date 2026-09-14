import type { InvitePayload, InviteResult } from "@bh/shared-types";

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
