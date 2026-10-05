import { describe, expect, it } from "vitest";
import type { AccessTokenClaims } from "../src/modules/auth/access-token.js";
import { FriendInviteService, inviteMessage } from "../src/modules/friends/friend-invite.service.js";
import { InviteUnavailableError } from "../src/modules/friends/friends-errors.js";
import type { FriendsService } from "../src/modules/friends/friends.service.js";
import { AppLinks } from "../src/platforms/ports/app-links.js";
import { MessagePreparers, type MessagePreparer, type PreparedMessage, type PreparedMessageInput } from "../src/platforms/ports/prepared-message.js";
import { TelegramMessagePreparer, type PreparerBotApi } from "../src/platforms/telegram/telegram-message-preparer.js";

/**
 * Приглашение друга сообщением (docs/35-stage4-plan.md Р63): бот готовит
 * сообщение с кнопкой по ссылке дружбы, игрок отправляет его сам. Площадка
 * без этого способа, несобранная ссылка и сбой Bot API — понятный отказ, а не
 * необработанная ошибка.
 */

const ME: AccessTokenClaims = { accountId: "00000000-0000-4000-8000-00000000f001", platform: "telegram", platformUserId: "424242" };
const friends = { link: async () => ({ code: "Qw3rTy12Zx", startParam: "f-Qw3rTy12Zx" }) } as unknown as FriendsService;
const links = new AppLinks([{ platform: "telegram", launch: (param) => `https://t.me/rubezh_bot/play?startapp=${param}`, chat: () => null }]);

class FakePreparer implements MessagePreparer {
  readonly platform = "telegram" as const;
  readonly configured = true;
  readonly asked: { user: string; message: PreparedMessageInput }[] = [];
  answer: PreparedMessage | null | Error = { id: "prepared-1", expiresAt: new Date(Date.UTC(2026, 9, 1, 12)) };

  async prepare(platformUserId: string, message: PreparedMessageInput): Promise<PreparedMessage | null> {
    this.asked.push({ user: platformUserId, message });
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

function service(preparer: MessagePreparer | null, appLinks = links): FriendInviteService {
  return new FriendInviteService(friends, appLinks, new MessagePreparers(preparer === null ? [] : [preparer]));
}

describe("приглашение сообщением", () => {
  it("бот готовит сообщение с кнопкой по ссылке дружбы — тому, кто зовёт", async () => {
    const preparer = new FakePreparer();
    expect(await service(preparer).preparedMessage(ME)).toEqual({ messageId: "prepared-1", expiresAt: "2026-10-01T12:00:00.000Z" });
    expect(preparer.asked).toHaveLength(1);
    expect(preparer.asked[0]?.user).toBe("424242");
    expect(preparer.asked[0]?.message.button).toEqual({ text: "▶ Играть", url: "https://t.me/rubezh_bot/play?startapp=f-Qw3rTy12Zx" });
  });

  it("текст — без рода и разметки: пишет игрок от своего имени", () => {
    const message = inviteMessage("https://example.test");
    expect(message.text).not.toMatch(/позвал|позвала|[*_<>]/);
    expect(message.title.length).toBeLessThanOrEqual(64);
  });

  it("площадка так не умеет, ссылка не собрана, аккаунт не её — понятный отказ", async () => {
    await expect(service(null).preparedMessage(ME)).rejects.toBeInstanceOf(InviteUnavailableError);
    await expect(service(new FakePreparer(), new AppLinks([])).preparedMessage(ME)).rejects.toBeInstanceOf(InviteUnavailableError);

    const stranger = new FakePreparer();
    stranger.answer = null;
    await expect(service(stranger).preparedMessage(ME)).rejects.toThrow(/скопируйте ссылку/);
  });

  it("сбой Bot API — отказ с просьбой повторить, а не необработанная ошибка", async () => {
    const broken = new FakePreparer();
    broken.answer = new Error("Bot API savePreparedInlineMessage: 0 сеть недоступна");
    await expect(service(broken).preparedMessage(ME)).rejects.toThrow(/попробуйте ещё раз/);
  });
});

describe("подготовка сообщения в Telegram", () => {
  it("статья с текстом и кнопкой-ссылкой; аккаунту разработчика — ничего", async () => {
    const calls: { userId: number; button: unknown; text: string }[] = [];
    const api: PreparerBotApi = {
      savePreparedInlineMessage: async (userId, article) => {
        calls.push({ userId, button: article.button, text: article.text });
        return { id: "tg-1", expiresAt: null };
      },
    };
    const preparer = new TelegramMessagePreparer(api, true);
    const message = inviteMessage("https://t.me/rubezh_bot/play?startapp=f-x");

    expect(await preparer.prepare("dev-1", message)).toBeNull();
    expect(await preparer.prepare("424242", message)).toEqual({ id: "tg-1", expiresAt: null });
    expect(calls).toEqual([{ userId: 424242, button: { text: "▶ Играть", url: "https://t.me/rubezh_bot/play?startapp=f-x" }, text: message.text }]);
  });
});
