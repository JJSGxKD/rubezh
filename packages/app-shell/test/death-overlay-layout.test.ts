import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunResult } from "@bh/shared-types";
import "../src/i18n/run";
import { DeathOverlay, type DeathOverlayProps } from "../src/screens/run/DeathOverlay";

// Раскладка итогов забега (tasks/T-0186): кнопки закреплены в подвале, прокрутка
// одна — тело модалки, дубля кнопок для ландшафта нет.

const result: RunResult = {
  runId: "run-1",
  seed: 42,
  outcome: "died",
  startingWeaponId: "spark",
  mapId: "frontier",
  difficultyId: "normal",
  contentHash: "abc",
  waveReached: 3,
  survivalSec: 250,
  level: 9,
  xpCollected: 300,
  enemiesKilled: 400,
  killsByEnemy: { swarm_rat: 400 },
  damageDealt: 5000,
  damageTaken: 200,
  damageByElement: {},
  noHitSec: 0,
  noKillSec: 0,
  killsByElement: {},
  bossKills: 0,
  eliteKills: 0,
  chestsOpened: 0,
  crystalsCollected: 0,
  weapons: [{ id: "spark", level: 4, damage: 5000 }],
  passives: [],
  deathCause: "swarm_rat",
  distance: 9000,
  peakEnemies: 80,
  cheats: false,
  continues: [],
};

const noop = (): void => undefined;

function render(patch: Partial<DeathOverlayProps> = {}): string {
  return renderToStaticMarkup(
    createElement(DeathOverlay, { result, isNewRecord: false, diagnostics: false, reward: { status: "pending" }, onDecline: noop, onRestart: noop, onMenu: noop, onShare: () => Promise.resolve(null), ...patch }),
  );
}

const count = (markup: string, text: string): number => markup.split(text).length - 1;

describe("итоги забега: раскладка", () => {
  it("каждая кнопка встречается ровно один раз — дубля для ландшафта нет", () => {
    const markup = render();

    for (const label of ["Ещё раз", "На главную", "Поделиться"]) expect(count(markup, `>${label}<`), label).toBe(1);
  });

  it("прокручивается одно тело модалки, у карточек нет своего max-h по высоте окна", () => {
    const markup = render();

    expect(count(markup, "overflow-y-auto")).toBe(1);
    expect(markup).not.toContain("max-h-[calc(100dvh");
  });

  it("кнопки идут после прокручиваемого тела — подвал закреплён", () => {
    const markup = render();
    const body = markup.indexOf("overflow-y-auto");
    const again = markup.indexOf(">Ещё раз<");

    expect(body).toBeGreaterThan(-1);
    // Закреплённый подвал модалки — отдельный блок `shrink-0` после тела, а не внутри него.
    const footer = markup.lastIndexOf("grid shrink-0 gap-2", again);

    expect(footer).toBeGreaterThan(body);
  });

  it("шаг второго шанса: кнопок итогов нет", () => {
    const markup = render({ secondChance: { onDevContinue: noop } });

    expect(markup).not.toContain(">На главную<");
    expect(markup).not.toContain(">Поделиться<");
  });
});

// Новый рекорд — награда и выглядит наградой: за короной лучи, как за
// сундуком (design/art/effects.md §6.3). У обычного итога лучей нет.
describe("лучи нового рекорда", () => {
  it("за короной рекорда — лучи, у обычного итога — нет", () => {
    expect(render({ isNewRecord: true })).toContain("animate-chest-rays-spin");
    expect(render({ isNewRecord: false })).not.toContain("animate-chest-rays-spin");
  });
});
