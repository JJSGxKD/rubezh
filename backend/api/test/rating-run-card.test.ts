import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it } from "vitest";
import { bundledExpectedTable, expectedRowOf, type ExpectedTable } from "../src/modules/rating/expected-table.js";
import { RUN_CARD_REPOSITORY, RunCardService, type RunCardRepository, type RunCardRow } from "../src/modules/rating/run-card.service.js";
import { EXPECTED_TABLE_SOURCE } from "../src/modules/rating/expected-table.js";
import { AccountRestrictions } from "../src/modules/restrictions/account-restrictions.js";
import { SETTINGS_READER } from "../src/modules/settings/settings.service.js";
import { RunScorer } from "../src/modules/rating/run-scorer.service.js";
import { AXIS_IDS } from "../src/modules/rating/score-rules.js";
import type { RestrictionRow } from "../src/modules/restrictions/restrictions.repository.js";
import { SETTINGS } from "../src/modules/settings/setting-catalog.js";
import { panelSettings } from "./helpers/settings.js";

/**
 * Карточка забега без базы (tasks/T-0297): правила видимости и состав ответа.
 * Живую проверку на Postgres делает `rating-run-card.integration.test.ts`.
 */

const table = bundledExpectedTable() as ExpectedTable;
const OWNER = "00000000-0000-4000-8000-000000000001";
const VIEWER = "00000000-0000-4000-8000-000000000002";
const NOW = Date.UTC(2026, 10, 3);

function row(patch: Partial<RunCardRow> = {}): RunCardRow {
  return {
    runId: "run-card-aaaa",
    accountId: OWNER,
    difficulty: "hard",
    finishedAt: new Date(NOW),
    ranked: true,
    survivalSec: 1_908,
    level: 41,
    enemiesKilled: 12_000,
    startingWeaponId: "spark",
    weapons: [
      { id: "spark", level: 8, damage: 1_000 },
      { id: "storm", level: 8 },
    ],
    details: { passives: [{ id: "might", level: 5 }], damageTaken: 400, xpCollected: 1, waveReached: 30, topKills: [], bossKills: 6, eliteKills: 58 },
    points: 4_100,
    axes: { t: 3.18, k: 1.42, h: 1.28, c: 1.38, b: 1.12 },
    style: "t",
    band: "average",
    scoreInput: { power: 2.2, huntLog: null, buildScore: null },
    displayName: "Велимир",
    photoUrl: null,
    tester: false,
    ...patch,
  };
}

function build(options: { rows?: RunCardRow[]; boosts?: string[]; restricted?: string[]; source?: ExpectedTable | null; settings?: Record<string, number> } = {}): RunCardService {
  const rows = options.rows ?? [row()];
  const repository: RunCardRepository = {
    find: async (runId) => rows.find((candidate) => candidate.runId === runId) ?? null,
    boostsOf: async () => options.boosts ?? [],
  };
  const source = options.source === undefined ? table : options.source;
  const settings = panelSettings(options.settings ?? {});
  const restricted = new Set(options.restricted ?? []);
  const restrictions = { status: async (accountId: string) => (restricted.has(accountId) ? ({ kind: "leaderboard" } as RestrictionRow) : null) };
  return new RunCardService(repository, { get: () => source }, new RunScorer({ get: () => source }, settings, null), settings, restrictions);
}

describe("карточка забега: видимость", () => {
  it("чужой рейтинговый забег виден", async () => {
    const card = await build().card(VIEWER, "run-card-aaaa");

    expect(card.mine).toBe(false);
    expect(card.player.name).toBe("Велимир");
  });

  it("свой виден всегда, в том числе нерейтинговый и снятый", async () => {
    const card = await build({ rows: [row({ ranked: false })] }).card(OWNER, "run-card-aaaa");

    expect(card.mine).toBe(true);
  });

  it("чужой нерейтинговый — 404", async () => {
    await expect(build({ rows: [row({ ranked: false })] }).card(VIEWER, "run-card-aaaa")).rejects.toMatchObject({ status: 404, code: "run_not_found" });
  });

  it("чужой забег на нерейтинговой сложности — 404, даже с ranked = true", async () => {
    await expect(build({ rows: [row({ difficulty: "normal" })] }).card(VIEWER, "run-card-aaaa")).rejects.toMatchObject({ status: 404 });
  });

  it("забег раньше отсечки рейтинга чужому не виден, хозяину виден", async () => {
    const since = { "rating.since-date": 20261104 };

    await expect(build({ settings: since }).card(VIEWER, "run-card-aaaa")).rejects.toMatchObject({ status: 404 });
    expect((await build({ settings: since }).card(OWNER, "run-card-aaaa")).mine).toBe(true);
  });

  it("игрок под ограничением рейтинга: чужому 404, ему самому 200", async () => {
    const service = build({ restricted: [OWNER] });

    await expect(service.card(VIEWER, "run-card-aaaa")).rejects.toMatchObject({ status: 404 });
    expect((await service.card(OWNER, "run-card-aaaa")).mine).toBe(true);
  });

  it("незнакомый ключ — 404", async () => {
    await expect(build().card(VIEWER, "run-card-zzzz")).rejects.toMatchObject({ status: 404 });
  });

  it("забег без очков или с битыми осями — 404 даже хозяину", async () => {
    await expect(build({ rows: [row({ points: null })] }).card(OWNER, "run-card-aaaa")).rejects.toMatchObject({ status: 404 });
    await expect(build({ rows: [row({ axes: { t: "x" } })] }).card(OWNER, "run-card-aaaa")).rejects.toMatchObject({ status: 404 });
    await expect(build({ rows: [row({ style: "z" })] }).card(OWNER, "run-card-aaaa")).rejects.toMatchObject({ status: 404 });
  });
});

describe("карточка забега: состав ответа", () => {
  it("пять осей в порядке Стойкость, Натиск, Охота, Чистота, Сборка; слагаемые по весам панели", async () => {
    const service = build();
    const card = await service.card(VIEWER, "run-card-aaaa");
    const params = new RunScorer({ get: () => table }, panelSettings(), null).scoreParams();

    expect(card.axes.map((axis) => axis.axis)).toEqual([...AXIS_IDS]);
    expect(card.cap).toBe(params.cap);
    const t = card.axes[0];
    // Стойкость 3,18 при потолке 3 даёт слагаемое по потолку, а не по индексу.
    expect(t?.points).toBe(Math.round(1_000 * params.weights.t * Math.min(3.18, params.cap)));
    expect(t?.expectedPoints).toBe(Math.round(1_000 * params.weights.t));
    expect(t?.index).toBe(3.18);
    const k = card.axes[1];
    expect(k?.points).toBe(Math.round(1_000 * params.weights.k * 1.42));
  });

  it("ключ панели rating.weight-hunt меняет слагаемые карточки", async () => {
    const base = await build().card(VIEWER, "run-card-aaaa");
    const heavy = await build({ settings: { [SETTINGS.ratingWeightHunt.key]: 60 } }).card(VIEWER, "run-card-aaaa");

    expect((heavy.axes[2]?.points ?? 0) / (heavy.axes[2]?.expectedPoints ?? 1)).toBeCloseTo((base.axes[2]?.points ?? 0) / (base.axes[2]?.expectedPoints ?? 1), 1);
    expect(heavy.axes[2]?.points).toBeGreaterThan(base.axes[2]?.points ?? 0);
  });

  it("шапка: очки из строки, сила, стиль, полоса, ожидаемые очки по Стойкости", async () => {
    const card = await build().card(VIEWER, "run-card-aaaa");

    expect(card).toMatchObject({ runId: "run-card-aaaa", points: 4_100, power: 2.2, style: "t", band: "average", survivalSec: 1_908, level: 41 });
    expect(card.expectedPoints).toBeGreaterThan(1_000);
  });

  it("числа для подписей: убийств в минуту, боссы, элиты и урон против ожидаемого", async () => {
    const card = await build().card(VIEWER, "run-card-aaaa");
    const expected = expectedRowOf(table, "average", 32).damageTakenPerMin;

    expect(card.facts.killsPerMin).toBe(Math.round(12_000 / (1_908 / 60)));
    expect(card.facts.bossKills).toBe(6);
    expect(card.facts.eliteKills).toBe(58);
    expect(card.facts.damageDeltaPct).toBe(Math.round((400 / (1_908 / 60) / expected - 1) * 100));
  });

  it("забег прошлой сборки: счётчиков нет — null, а не нули", async () => {
    const card = await build({ rows: [row({ details: null, weapons: null, scoreInput: null })] }).card(VIEWER, "run-card-aaaa");

    expect(card.facts.bossKills).toBeNull();
    expect(card.facts.eliteKills).toBeNull();
    expect(card.facts.damageDeltaPct).toBeNull();
    expect(card.power).toBeNull();
    expect(card.build).toEqual({ weapons: [], passives: [], boosts: [] });
  });

  it("таблицы нет — процент урона null, остальное на месте", async () => {
    const card = await build({ source: null }).card(VIEWER, "run-card-aaaa");

    expect(card.facts.damageDeltaPct).toBeNull();
    expect(card.facts.killsPerMin).toBeGreaterThan(0);
  });

  it("полоса, которой нет в таблице, не роняет карточку", async () => {
    const card = await build({ rows: [row({ band: "legacy" })] }).card(VIEWER, "run-card-aaaa");

    expect(card.facts.damageDeltaPct).toBeNull();
  });

  it("сборка: оружие и навыки с уровнями, без урона; бусты из покупки", async () => {
    const card = await build({ boosts: ["aegis"] }).card(VIEWER, "run-card-aaaa");

    expect(card.build.weapons).toEqual([
      { id: "spark", level: 8 },
      { id: "storm", level: 8 },
    ]);
    expect(card.build.passives).toEqual([{ id: "might", level: 5 }]);
    expect(card.build.boosts).toEqual(["aegis"]);
  });

  it("знак «Тестер» передаётся, дата знака и аккаунт — нет", async () => {
    const card = await build({ rows: [row({ tester: true })] }).card(VIEWER, "run-card-aaaa");

    expect(card.player.tester).toBe(true);
    const text = JSON.stringify(card);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain("accountId");
    expect(text).not.toContain("finishedAt");
  });
});

describe("сборка в контейнере Nest", () => {
  it("контейнер собирает RunCardService из провайдеров модуля рейтинга", async () => {
    const restrictions = { status: async () => null };
    @Module({
      providers: [
        RunCardService,
        { provide: RunScorer, useValue: new RunScorer({ get: () => table }, panelSettings({}), null) },
        { provide: RUN_CARD_REPOSITORY, useValue: { find: async () => null, boostsOf: async () => [] } },
        { provide: EXPECTED_TABLE_SOURCE, useValue: { get: () => table } },
        { provide: SETTINGS_READER, useValue: panelSettings({}) },
        { provide: AccountRestrictions, useValue: restrictions },
      ],
    })
    class Root {}
    const context = await NestFactory.createApplicationContext(Root, { logger: false, abortOnError: false });
    try {
      expect(context.get(RunCardService)).toBeInstanceOf(RunCardService);
    } finally {
      await context.close();
    }
  });
});
