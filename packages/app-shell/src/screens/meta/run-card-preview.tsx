import type { ReactNode } from "react";
import { ContentColumn, Screen, SectionTitle } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/run-card";
import type { RunCard } from "../../state/runs-api";
import { RunCardBody } from "./run-card";

/**
 * Витрина карточки забега (tasks/T-0297): сильный забег, забег ниже ожидаемого
 * и забег без эволюций. Отдельным файлом и ленивым чанком: витрина компонентов
 * игроку не едет, а её замер идёт отдельной строкой бюджета, и числа карточек
 * не должны раздувать её.
 */
const BASE: RunCard = {
  runId: "preview-run",
  mine: false,
  player: { name: "Велимир", photoUrl: null },
  survivalSec: 1_908,
  level: 41,
  power: 2.4,
  startingWeaponId: "spark",
  points: 9_812,
  expectedPoints: 5_400,
  style: "t",
  band: "average",
  cap: 3,
  axes: [
    { axis: "t", index: 3.18, points: 1_200, expectedPoints: 400 },
    { axis: "k", index: 1.42, points: 284, expectedPoints: 200 },
    { axis: "h", index: 1.28, points: 256, expectedPoints: 200 },
    { axis: "c", index: 1.38, points: 138, expectedPoints: 100 },
    { axis: "b", index: 1.12, points: 112, expectedPoints: 100 },
  ],
  facts: { killsPerMin: 412, bossKills: 6, eliteKills: 58, damageDeltaPct: -38 },
  build: {
    weapons: [
      { id: "spark", level: 8 },
      { id: "starfall", level: 1 },
      { id: "storm", level: 8 },
    ],
    passives: [
      { id: "might", level: 5 },
      { id: "ward", level: 5 },
    ],
    boosts: ["aegis"],
  },
};

const BELOW: RunCard = {
  ...BASE,
  mine: true,
  survivalSec: 372,
  points: 640,
  style: "k",
  axes: [
    { axis: "t", index: 0.52, points: 208, expectedPoints: 400 },
    { axis: "k", index: 0.9, points: 180, expectedPoints: 200 },
    { axis: "h", index: 0.4, points: 80, expectedPoints: 200 },
    { axis: "c", index: 0.6, points: 60, expectedPoints: 100 },
    { axis: "b", index: 0.3, points: 30, expectedPoints: 100 },
  ],
  facts: { killsPerMin: 190, bossKills: 0, eliteKills: 2, damageDeltaPct: 64 },
  build: { weapons: [{ id: "spark", level: 3 }], passives: [{ id: "might", level: 1 }], boosts: [] },
};

const PLAIN: RunCard = {
  ...BASE,
  points: 4_100,
  style: "h",
  power: null,
  facts: { killsPerMin: 300, bossKills: null, eliteKills: null, damageDeltaPct: null },
  build: {
    weapons: [
      { id: "spark", level: 8 },
      { id: "storm", level: 7 },
    ],
    passives: [{ id: "might", level: 4 }],
    boosts: [],
  },
};

export function RunCardPreview(): ReactNode {
  return (
    <Screen title={t("gallery.preview.runCard")}>
      <ContentColumn>
        <SectionTitle>{t("runCard.preview.strong")}</SectionTitle>
        <RunCardBody card={BASE} />
        <SectionTitle>{t("runCard.preview.below")}</SectionTitle>
        <RunCardBody card={BELOW} />
        <SectionTitle>{t("runCard.preview.plain")}</SectionTitle>
        <RunCardBody card={PLAIN} />
      </ContentColumn>
    </Screen>
  );
}
