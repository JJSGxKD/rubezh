import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { LeaderboardEntry } from "@bh/shared-types";
import { t } from "../src/i18n";
import "../src/i18n/player-card";
import { appearanceCardUrl } from "../src/screens/meta/appearance-art";
import { PlayerCardActions, PlayerCardBody } from "../src/screens/meta/player-card";
import { closePlayerCard, openPlayerCard, usePlayerCardTarget } from "../src/screens/meta/player-card-link";
import { LeaderboardRow } from "../src/screens/meta/rating";
import type { PlayerCardView } from "../src/state/player-card-api";

// Вход в карточку игрока и сама карточка (tasks/T-0248): строка с публичным id
// нажимается, без него — нет; карточка рисует облик, знаки, числа и витрину, а
// действие зависит от отношения. Рендер в строку, без браузера.

const ID = "0a1b2c3d4e5f";
const ROW: LeaderboardEntry = {
  rank: 4,
  name: "Велимир",
  photoUrl: null,
  survivalSec: 760,
  level: 41,
  startingWeaponId: "bolt",
  enemiesKilled: 900,
  isMe: false,
};
const row = (entry: LeaderboardEntry & { runId?: string }, props: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(createElement("ol", null, createElement(LeaderboardRow, { entry, index: 0, scoring: "points", ...props } as never)));

describe("строка рейтинга открывает карточку", () => {
  it("с публичным id строка нажимается: кнопка на всю строку с именем игрока для диктора", () => {
    const html = row({ ...ROW, publicId: ID });

    expect(html).toContain(`aria-label="${t("playerCard.open", { name: "Велимир" })}"`);
  });

  it("без публичного id (старый сервер) и без забега строка не нажимается", () => {
    expect(row(ROW)).not.toContain("<button");
  });

  it("без публичного id, но с забегом — как раньше: открывает карточку забега", () => {
    const html = row({ ...ROW, runId: "run-1" });

    expect(html).toContain(`aria-label="${t("runCard.open", { name: "Велимир" })}"`);
    expect(html).not.toContain(t("playerCard.open", { name: "Велимир" }));
  });

  it("и публичный id, и забег — обе кнопки: карточка игрока на строку, карточка забега на очки", () => {
    const html = row({ ...ROW, publicId: ID, runId: "run-1" });

    expect(html).toContain(t("playerCard.open", { name: "Велимир" }));
    expect(html).toContain(t("runCard.open", { name: "Велимир" }));
  });
});

describe("хранилище открытой карточки", () => {
  beforeEach(() => closePlayerCard());

  it("открыть — запомнить игрока и откуда; закрыть — забыть", () => {
    openPlayerCard(ID, "friends");
    expect(usePlayerCardTarget.getState().target).toEqual({ publicId: ID, from: "friends" });

    closePlayerCard();
    expect(usePlayerCardTarget.getState().target).toBeNull();
  });

  it("чужая строка вместо публичного id не открывает ничего", () => {
    openPlayerCard("../friends", "rating");
    expect(usePlayerCardTarget.getState().target).toBeNull();
  });
});

const EMBLEM = { id: "emb_champion", title: "Чемпион", tier: "mythic", category: "season" as const, season: 3 };
const CARD: PlayerCardView = {
  publicId: ID,
  name: "Велимир",
  appearance: "navi",
  emblem: EMBLEM,
  emblems: { held: 12, top: [EMBLEM, { id: "emb_a", title: "А", tier: "epic", category: "merit" }, { id: "emb_b", title: "Б", tier: "rare", category: "merit" }, { id: "emb_c", title: "В", tier: "rare", category: "merit" }, { id: "emb_d", title: "Г", tier: "rare", category: "merit" }] },
  level: 41,
  power: 1_830,
  season: { place: 3 },
  stats: { runs: 214, totalKills: 9_000, bestSurvivalSec: 760 },
  prestige: 120,
  favorites: [{ id: "ach_boss", title: "Гроза боссов", category: "boss" }],
  relation: "none",
};
const body = (card: Partial<PlayerCardView>, props: Record<string, unknown> = {}): string => {
  const shared = { card: { ...CARD, ...card }, viewerArt: true, signedIn: true, requesting: false, requestFailure: null, onAction: () => undefined, ...props } as never;
  // Тело листа и подвал с действием — две части одного листа: подвал закреплён под прокруткой.
  return renderToStaticMarkup(createElement(Fragment, null, createElement(PlayerCardBody, shared), createElement(PlayerCardActions, shared)));
};

describe("карточка игрока", () => {
  it("сцена — карточка облика игрока; имя, знак и уровень под ней", () => {
    const html = body({});

    expect(html).toContain(`src="${appearanceCardUrl("navi")}"`);
    expect(html).toContain("Велимир");
    expect(html).toContain("Чемпион · сезон 3");
    expect(html).toContain(t("playerCard.level", { level: 41 }));
  });

  it("зритель без арта — крупный аватар вместо портрета облика", () => {
    const html = body({}, { viewerArt: false });

    expect(html).not.toContain(appearanceCardUrl("navi"));
    expect(html).toContain(">В<");
  });

  it("четыре числа: лучший забег, место, забеги, мощь", () => {
    const html = body({});

    for (const key of ["playerCard.best", "playerCard.place", "playerCard.runs", "playerCard.power"]) expect(html).toContain(t(key));
    expect(html).toContain("12:40");
  });

  it("нет места в сезоне — «—»", () => {
    expect(body({ season: null })).toContain(">—<");
  });

  it("знаки: пять и «+7»", () => {
    const html = body({});

    expect(html).toContain(t("playerCard.moreEmblems", { count: 7 }));
  });

  it("знаков не больше пяти — «+N» нет", () => {
    expect(body({ emblems: { held: 5, top: CARD.emblems.top } })).not.toContain("+");
  });

  it("витрина: любимые и престиж; пустая — без раздела", () => {
    const html = body({});
    expect(html).toContain("Гроза боссов");
    expect(html).toContain(t("playerCard.prestige", { points: "120" }));

    expect(body({ favorites: [], prestige: 0 })).not.toContain(t("playerCard.showcase"));
  });

  it("none — «В друзья»", () => {
    expect(body({ relation: "none" })).toContain(t("playerCard.addFriend"));
  });

  it("outgoing — «Заявка отправлена», кнопка выключена", () => {
    const html = body({ relation: "outgoing" });

    expect(html).toContain(t("playerCard.requested"));
    expect(html).toMatch(/<button[^>]*disabled[^>]*>/);
  });

  it("incoming — «Принять заявку»", () => {
    expect(body({ relation: "incoming" })).toContain(t("playerCard.accept"));
  });

  it("friend — метка без кнопки действия", () => {
    const html = body({ relation: "friend" });

    expect(html).toContain(t("playerCard.friends"));
    expect(html).not.toContain(t("playerCard.addFriend"));
    expect(html).not.toContain("<button");
  });

  it("friend из списка друзей — ещё и «Убрать из друзей»", () => {
    const html = body({ relation: "friend" }, { onRemove: () => undefined });

    expect(html).toContain(t("playerCard.remove"));
  });

  it("своя карточка — действий нет, даже убрать из друзей", () => {
    const html = body({ relation: "self" }, { onRemove: () => undefined });

    expect(html).not.toContain("<button");
  });

  it("гость — карточка есть, «В друзья» нет", () => {
    const html = body({ relation: "none" }, { signedIn: false });

    expect(html).toContain("Велимир");
    expect(html).not.toContain(t("playerCard.addFriend"));
  });

  it("заявка не ушла — строка ошибки с role=alert", () => {
    const html = body({ relation: "none" }, { requestFailure: "playerCard.requestFailed" });

    expect(html).toContain('role="alert"');
    expect(html).toContain(t("playerCard.requestFailed"));
  });
});
