import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LeaderboardEntry } from "@bh/shared-types";
import { EmblemChip } from "../src/screens/meta/emblem-chip";
import { LeaderboardRow } from "../src/screens/meta/rating";
import type { ApiRequest, ApiResult } from "../src/state/api-request";
import { createFriendsApi } from "../src/state/friends-api";
import { leaderboardSchema } from "../src/state/runs-api";

// Знак у имени (tasks/T-0236): чип, строка рейтинга со знаком и без него,
// схемы строк списков.

const EMBLEM = { id: "emb_vip", title: "VIP", tier: "legendary", category: "status" as const };
const chip = (props: Record<string, unknown>): string => renderToStaticMarkup(createElement(EmblemChip, { emblem: EMBLEM, size: "s", ...props } as never));

describe("чип знака", () => {
  it("с названием: значок и текст, тон — из тона редкости", () => {
    const html = chip({ fit: "full" });

    expect(html).toContain(">VIP<");
    expect(html).toContain("--emblem-tone:var(--color-elite)");
    expect(html).toContain("<svg");
  });

  it("сезонный знак — с номером сезона", () => {
    expect(chip({ fit: "full", emblem: { ...EMBLEM, id: "emb_season_champion", title: "Чемпион", category: "season", season: 3 } })).toContain("Чемпион · сезон 3");
  });

  it("только значок: названия в разметке нет, у значка — подпись для диктора", () => {
    const html = chip({ fit: "glyph" });

    expect(html).not.toContain(">VIP<");
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="VIP"');
  });

  it("у `team` — бирюза, у `partner` — акцент", () => {
    expect(chip({ fit: "full", emblem: { ...EMBLEM, id: "emb_team", title: "Команда", tier: "team" } })).toContain("--emblem-tone:var(--color-secondary)");
    expect(chip({ fit: "full", emblem: { ...EMBLEM, id: "emb_partner", title: "Партнёр", tier: "partner" } })).toContain("--emblem-tone:var(--color-accent)");
  });

  it("закрытый знак — силуэт: без тона редкости", () => {
    const html = chip({ fit: "full", closed: true });

    expect(html).not.toContain("--emblem-tone");
    expect(html).toContain("text-text-muted");
  });

  it("знак, которого нет в карте значков, рисуется значком категории, а не пустотой", () => {
    const html = chip({ fit: "full", emblem: { ...EMBLEM, id: "ach_future", title: "Новый", category: "merit" } });

    expect(html).toContain("<svg");
    expect(html).toContain(">Новый<");
  });
});

const ENTRY: LeaderboardEntry = { rank: 3, name: "Мира", photoUrl: null, survivalSec: 700, level: 12, startingWeaponId: "spark", enemiesKilled: 300, isMe: false };
const row = (patch: Partial<LeaderboardEntry> = {}, fit?: "full" | "glyph"): string =>
  renderToStaticMarkup(createElement(LeaderboardRow, { entry: { ...ENTRY, ...patch }, index: 0, ...(fit === undefined ? {} : { emblemFit: fit }) }));

describe("знак в строке рейтинга", () => {
  it("строка без `emblem` (старый сервер) рисует прежнюю метку «Тестер»", () => {
    const html = row({ tester: true });

    expect(html).toContain("Тестер");
    expect(html).not.toContain("--emblem-tone");
  });

  it("со знаком — знак под именем, а прежняя метка не рисуется: знаков не два", () => {
    const html = row({ tester: true, supporter: true, emblem: EMBLEM }, "full");

    expect(html).toContain("--emblem-tone:var(--color-elite)");
    expect(html).toContain(">VIP<");
    expect(html).not.toContain("Тестер");
    expect(html).not.toContain("Меценат");
  });

  it("на узкой строке — только значок с подписью для диктора", () => {
    const html = row({ emblem: EMBLEM }, "glyph");

    expect(html).toContain('aria-label="VIP"');
    expect(html).not.toContain(">VIP<");
  });

  it("строка без знака и без меток не рисует ничего лишнего", () => {
    expect(row()).not.toContain("--emblem-tone");
  });
});

describe("схемы строк списков", () => {
  it("рейтинг: `emblem` необязателен, а с ним — разбирается", () => {
    const board = (entries: unknown[]) => ({ difficultyId: "hard", entries, me: null, totalPlayers: entries.length });

    expect(leaderboardSchema.safeParse(board([ENTRY])).success).toBe(true);
    const withEmblem = leaderboardSchema.safeParse(board([{ ...ENTRY, emblem: { ...EMBLEM, season: 2 } }]));
    expect(withEmblem.success && withEmblem.data.entries[0]?.emblem?.id).toBe("emb_vip");
    expect(leaderboardSchema.safeParse(board([{ ...ENTRY, emblem: { id: 5 } }])).success).toBe(false);
  });

  it("друзья: `emblem` у друга и у заявки необязателен", async () => {
    const view = {
      friends: [{ accountId: "f1", displayName: "Дым", photoUrl: null, since: "2026-09-29T10:00:00.000Z", source: "link", emblem: EMBLEM }],
      incoming: [{ accountId: "r1", displayName: "Лис", photoUrl: null, at: "2026-09-30T08:00:00.000Z" }],
      outgoing: [],
      limits: { maxFriends: 100 },
      gifts: { sentToday: [], pending: 0, claimableToday: 0, coins: 20 },
      bonus: { qualified: 0, steps: [], readyCoins: 0 },
    };
    const request: ApiRequest = async <T,>(_path: string, schema: object): Promise<ApiResult<T>> => {
      const { z } = await import("zod/mini");
      const parsed = z.object({ data: schema as never }).safeParse({ data: view });
      return parsed.success ? { ok: true, data: (parsed.data as { data: T }).data } : { ok: false, failure: "unavailable" };
    };

    const response = await createFriendsApi(request).view();

    expect(response.ok && response.data.friends[0]?.emblem?.title).toBe("VIP");
    expect(response.ok && response.data.incoming[0]?.emblem).toBeUndefined();
  });
});
