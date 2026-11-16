import { useState, type ReactNode } from "react";
import { ContentColumn, ListGroup, ListItem, Screen, SectionTitle } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/gallery";
import type { PlayerCardView } from "../../state/player-card-api";
import { PlayerCardSheetView, type PlayerCardState } from "./player-card";
import type { CardFrom } from "./player-card-rules";

/**
 * Витрина карточки игрока (tasks/T-0248): лист на тестовых данных — своя, друга,
 * чужая с заявкой и встречной заявкой, без арта у зрителя, загрузка и отказы
 * (нет игрока, слишком часто, нет связи). Лист открывается настоящим окном
 * поверх витрины. Лежит в чанке витрины компонентов — игроку не нужна.
 */

const EMBLEMS = [
  { id: "emb_season_champion", title: "Чемпион", tier: "mythic", category: "season" as const, season: 3 },
  { id: "ach_no_hit_10", title: "Без царапины", tier: "epic", category: "merit" as const },
  { id: "ach_boss_25", title: "Гроза боссов", tier: "rare", category: "merit" as const },
  { id: "ach_runs_200", title: "Двести забегов", tier: "uncommon", category: "merit" as const },
  { id: "emb_tester", title: "Тестер", tier: "common", category: "status" as const },
];

const CARD: PlayerCardView = {
  publicId: "0a1b2c3d4e5f",
  name: "Велимир",
  appearance: "vityaz",
  emblem: EMBLEMS[0],
  emblems: { held: 12, top: EMBLEMS },
  level: 41,
  power: 1_830,
  season: { place: 3 },
  stats: { runs: 214, totalKills: 9_000, bestSurvivalSec: 760 },
  prestige: 120,
  favorites: [
    { id: "ach_boss_25", title: "Гроза боссов", category: "boss" },
    { id: "ach_no_hit_10", title: "Без единой царапины", category: "survival" },
  ],
  relation: "none",
};

interface Case {
  id: string;
  titleKey: string;
  from: CardFrom;
  state: PlayerCardState;
  viewerArt: boolean;
  signedIn?: boolean;
  /** у экрана друзей — с «Убрать из друзей» */
  removable?: boolean;
}

const ready = (card: Partial<PlayerCardView>): PlayerCardState => ({ status: "ready", card: { ...CARD, ...card } });

const CASES: readonly Case[] = [
  { id: "other", titleKey: "gallery.playerCard.other", from: "rating", state: ready({}), viewerArt: true },
  { id: "incoming", titleKey: "gallery.playerCard.incoming", from: "season", state: ready({ relation: "incoming", appearance: "navi" }), viewerArt: true },
  { id: "friend", titleKey: "gallery.playerCard.friend", from: "friends", state: ready({ relation: "friend", appearance: "ohotnitsa" }), viewerArt: true, removable: true },
  { id: "own", titleKey: "gallery.playerCard.own", from: "profile", state: ready({ relation: "self", name: "Я", appearance: "keeper", season: null }), viewerArt: true },
  { id: "noArt", titleKey: "gallery.playerCard.noArt", from: "rating", state: ready({}), viewerArt: false },
  { id: "newbie", titleKey: "gallery.playerCard.newbie", from: "rating", state: ready({ name: "Лис", appearance: "keeper", emblem: undefined, emblems: { held: 0, top: [] }, level: 1, power: 0, season: null, stats: { runs: 0, totalKills: 0, bestSurvivalSec: 0 }, prestige: 0, favorites: [] }), viewerArt: true },
  { id: "guest", titleKey: "gallery.playerCard.guest", from: "rating", state: ready({}), viewerArt: true, signedIn: false },
  { id: "loading", titleKey: "gallery.playerCard.loading", from: "rating", state: { status: "loading" }, viewerArt: true },
  { id: "notFound", titleKey: "gallery.playerCard.notFound", from: "rating", state: { status: "failed", reason: "not_found" }, viewerArt: true },
  { id: "tooOften", titleKey: "gallery.playerCard.tooOften", from: "rating", state: { status: "failed", reason: "too_often" }, viewerArt: true },
  { id: "offline", titleKey: "gallery.playerCard.offline", from: "rating", state: { status: "failed", reason: "offline" }, viewerArt: true },
];

export function PlayerCardPreview(): ReactNode {
  const [open, setOpen] = useState<Case | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  return (
    <Screen title={t("gallery.preview.playerCard")}>
      <ContentColumn>
        <SectionTitle>{t("gallery.playerCard.states")}</SectionTitle>
        <ListGroup>
          {CASES.map((entry) => (
            <ListItem
              key={entry.id}
              title={t(entry.titleKey)}
              onClick={() => {
                setFailure(null);
                setOpen(entry);
              }}
            />
          ))}
          <ListItem title={t("gallery.playerCard.requestFailed")} onClick={() => {
            setFailure("playerCard.requestFailed");
            setOpen(CASES[0] ?? null);
          }} />
        </ListGroup>
      </ContentColumn>
      {open === null ? null : (
        <PlayerCardSheetView
          from={open.from}
          state={open.state}
          viewerArt={open.viewerArt}
          signedIn={open.signedIn ?? true}
          requesting={false}
          requestFailure={failure}
          onClose={() => setOpen(null)}
          onRetry={open.state.status === "failed" && open.state.reason !== "not_found" ? () => setOpen(null) : undefined}
          onAction={() => undefined}
          {...(open.removable === true ? { onRemove: () => setOpen(null) } : {})}
        />
      )}
    </Screen>
  );
}
