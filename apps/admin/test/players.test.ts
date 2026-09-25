import { describe, expect, it } from "vitest";
import { AdminApi } from "../src/api/client";
import { adjustWallet, fetchPlayerCard, playerCardSchema, resourceName, searchPlayers, walletAdjustProblem, WALLET_MAX_OPERATION } from "../src/api/players";
import { SECTIONS } from "../src/routes";
import { fakeFetch, json } from "./helpers";

const ACCOUNT_ID = "3c8f3a52-2d4e-4c55-9d0e-6f3b2a1c0d9e";
const AT = "2026-09-26T12:00:00.000Z";

/**
 * Карточка в том виде, в каком её отдаёт `GET /admin/players/:id` владельцу:
 * поля и типы — из `PlayerCard` бэкенда, даты — строками после JSON.
 */
const FULL_CARD = {
  account: {
    accountId: ACCOUNT_ID,
    platform: "telegram",
    displayName: "Аня",
    photoUrl: "https://t.me/i/userpic/320/ann.jpg",
    createdAt: AT,
    banned: null,
    pii: { platformUserId: "555000111", username: "ann" },
  },
  roles: ["moderator"],
  funnel: {
    enteredAt: AT,
    appOpenedAt: AT,
    firstRunStartedAt: AT,
    firstRunFinishedAt: null,
    runsRecorded: 1,
    runs2At: null,
    runs5At: null,
    returnedD1At: null,
    returnedD7At: null,
    firstPurchaseAt: null,
  },
  acquisition: { firstAt: AT, firstStartKind: "link", firstStartRef: "ch-launch", lastSeenAt: AT, lastTouchAt: null, lastStartKind: null, lastStartRef: null },
  messaging: { canMessage: true, reason: "write_access", changedAt: AT },
  progress: { level: 3, xp: 420, xpIntoLevel: 120, xpForNext: 300, nextReward: { coins: 150, gems: 0 } },
  runs: {
    runs: 4,
    totalKills: 812,
    totalSurvivalSec: 1500,
    best: { easy: { survivalSec: 610, rank: 12 }, normal: null, hard: null },
    recent: [{ difficultyId: "easy", survivalSec: 610, level: 18, startingWeaponId: "spark_bolt", at: Date.parse(AT) }],
  },
  wallet: {
    balances: { coins: 150, gems: 5, shard_common: 0, shard_uncommon: 0, shard_rare: 0, shard_epic: 0, shard_legendary: 0 },
    entries: [{ entryId: "e1", resource: "coins", amount: 150, reason: "run_reward", source: "run:1", createdAt: AT }],
  },
  purchases: [
    {
      purchaseId: "p1",
      accountId: ACCOUNT_ID,
      runId: "r1",
      continueNo: 1,
      elapsedSec: 300,
      priceStars: 25,
      chargedStars: 25,
      mode: "live",
      status: "paid",
      telegramChargeId: "tg-1",
      invoicedAt: AT,
      paidAt: AT,
      refundReason: null,
      refundRequestedAt: null,
      refundedAt: null,
    },
  ],
};

describe("раздел «Игроки»", () => {
  it("разбирает карточку целиком, отбрасывая то, что панель не показывает", () => {
    const card = playerCardSchema.parse(FULL_CARD);
    expect(card.account.pii?.username).toBe("ann");
    expect(card.purchases?.[0]).not.toHaveProperty("telegramChargeId");
    expect(card.progress).not.toHaveProperty("nextReward");
  });

  it("карточка модератора: без персональных данных, платежей и вех — тоже карточка", () => {
    const card = playerCardSchema.parse({
      ...FULL_CARD,
      account: { ...FULL_CARD.account, pii: null, banned: { at: AT, reason: "читы" } },
      funnel: null,
      acquisition: null,
      messaging: null,
      purchases: null,
    });
    expect(card.account.pii).toBeNull();
    expect(card.purchases).toBeNull();
  });

  it("поиск и карточка — на нужные адреса; изменившийся тип поля — ошибка разбора", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { players: [FULL_CARD.account] } }), json(200, { data: { ...FULL_CARD, progress: { level: "3" } } }));
    const api = new AdminApi(fetch);

    const found = await searchPlayers(api, "@ann");
    expect(found.ok && found.data.players[0]?.displayName).toBe("Аня");
    expect(calls[0]?.url).toBe("/api/v1/admin/players?query=%40ann&limit=50");

    const card = await fetchPlayerCard(api, ACCOUNT_ID);
    expect(card.ok).toBe(false);
    expect(calls[1]?.url).toBe(`/api/v1/admin/players/${ACCOUNT_ID}`);
  });

  it("ручная операция уходит с ключом, заданным панелью", async () => {
    const { fetch, calls } = fakeFetch(json(200, { data: { applied: 50, balance: 200, duplicate: false } }));
    const result = await adjustWallet(new AdminApi(fetch), ACCOUNT_ID, { resource: "coins", delta: 50, note: "компенсация", idempotencyKey: "panel-abc12345" });

    expect(result).toEqual({ ok: true, data: { applied: 50, balance: 200, duplicate: false } });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ resource: "coins", delta: 50, note: "компенсация", idempotencyKey: "panel-abc12345" });
  });

  it("форма операции не отправляет заведомо отклонённое сервером", () => {
    expect(walletAdjustProblem(50, "компенсация")).toBeNull();
    expect(walletAdjustProblem(-20, "ошибка начисления")).toBeNull();
    expect(walletAdjustProblem(0, "компенсация")).not.toBeNull();
    expect(walletAdjustProblem(1.5, "компенсация")).not.toBeNull();
    expect(walletAdjustProblem(Number.NaN, "компенсация")).not.toBeNull();
    expect(walletAdjustProblem(WALLET_MAX_OPERATION + 1, "компенсация")).not.toBeNull();
    expect(walletAdjustProblem(10, "ок")).not.toBeNull();
  });

  it("имена ресурсов — как у игрока, неизвестный — своим id", () => {
    expect(resourceName("coins")).toBe("Монеты");
    expect(resourceName("shard_mythic")).toBe("shard_mythic");
  });

  it("раздел виден только с правом на просмотр игроков", () => {
    expect(SECTIONS.find((section) => section.id === "players")?.permission).toBe("players.view");
  });
});
