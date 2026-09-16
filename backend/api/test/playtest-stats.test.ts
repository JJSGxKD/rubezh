import { describe, expect, it } from "vitest";
import {
  dayLabel,
  escapeXml,
  formatDuration,
  offsetLabel,
  renderStatsCaption,
  renderStatsPng,
  renderStatsSvg,
} from "../src/modules/playtest/playtest-stats.image.js";
import { dayKey, durationBucket, type StatsSnapshot } from "../src/modules/playtest/playtest-stats.store.js";
import { bucketLabel, buildStatsSummary, shares } from "../src/modules/playtest/playtest-stats.summary.js";

// Сводка статистики плейтеста для чата администраторов (docs/26-stage2-plan.md, WP14).

const NOW = Date.parse("2026-09-14T18:00:00Z");

function snapshot(patch: Partial<StatsSnapshot> = {}): StatsSnapshot {
  const empty = { runs: 0, totalSurvivalSec: 0, totalLevel: 0, abandoned: 0, buckets: [0, 0, 0, 0, 0, 0, 0] };
  return {
    playersSeen: 14,
    playersPlayed: 11,
    playersSeenToday: 6,
    playersPlayedToday: 5,
    installs: 17,
    runsToday: 23,
    byOs: { android: 9, ios: 6, windows: 2 },
    byFormFactor: { phone: 15, desktop: 2 },
    byClient: { android: 9, ios: 6, tdesktop: 2 },
    difficulties: {
      easy: { runs: 10, totalSurvivalSec: 2400, totalLevel: 90, abandoned: 1, buckets: [1, 2, 4, 3, 0, 0, 0] },
      normal: { runs: 4, totalSurvivalSec: 700, totalLevel: 26, abandoned: 2, buckets: [2, 1, 1, 0, 0, 0, 0] },
      hard: empty,
    },
    startingWeapons: { spark: 7, knife: 5, storm: 2 },
    deathCauses: { swarm_rat: 6, bomber_imp: 4 },
    stress: {
      reports: 3,
      byOs: {
        android: { reports: 2, totalPeak: 1700, outcomes: { degradation: 2 } },
        ios: { reports: 1, totalPeak: 900, outcomes: { manual: 1 } },
      },
    },
    ...patch,
  };
}

describe("сводка плейтеста", () => {
  it("считает сутки и время в поясе команды, а не в UTC сервера", () => {
    // 22:30 UTC — уже следующие сутки по Москве.
    const late = Date.parse("2026-09-14T22:30:00Z");
    expect(dayKey(late, 180)).toBe("2026-09-15");
    expect(dayKey(late, 0)).toBe("2026-09-14");
    expect(buildStatsSummary(snapshot(), { easy: null, normal: null, hard: null }, late, 180)).toMatchObject({
      day: "2026-09-15",
      time: "01:30",
    });
  });

  it("раскладывает длину забега по корзинам и находит типичную", () => {
    expect(durationBucket(0)).toBe(0);
    expect(durationBucket(60)).toBe(1);
    expect(durationBucket(299)).toBe(2);
    expect(durationBucket(3600)).toBe(6);
    expect(bucketLabel(0)).toBe("0–1 мин");
    expect(bucketLabel(6)).toBe("20+ мин");

    const summary = buildStatsSummary(snapshot(), { easy: 612, normal: null, hard: null }, NOW, 180);
    const [easy, normal, hard] = summary.difficulties;
    // Лёгкая: 1 + 2 + 4 = 7 из 10 — медиана в «3–5 мин».
    expect(easy).toMatchObject({ runs: 10, avgSurvivalSec: 240, avgLevel: 9, medianRange: "3–5 мин", abandonShare: 0.1, bestSurvivalSec: 612 });
    // Нормальная: ровно половина в первой корзине — медиана там же.
    expect(normal?.medianRange).toBe("0–1 мин");
    expect(hard).toMatchObject({ runs: 0, avgSurvivalSec: 0, medianRange: null, abandonShare: 0 });
    expect(summary.runsTotal).toBe(14);
  });

  it("сортирует доли по убыванию, равные — по ключу, и не показывает нули", () => {
    expect(shares({ b: 2, a: 2, c: 4, z: 0 })).toEqual([
      { key: "c", count: 4, share: 0.5 },
      { key: "a", count: 2, share: 0.25 },
      { key: "b", count: 2, share: 0.25 },
    ]);
    expect(shares({})).toEqual([]);
  });

  it("собирает стресс-тест по ОС со средним пиком", () => {
    const summary = buildStatsSummary(snapshot(), { easy: null, normal: null, hard: null }, NOW, 180);
    expect(summary.stress.byOs[0]).toMatchObject({ os: "android", reports: 2, avgPeak: 850 });
    expect(renderStatsSvg(summary, 180)).toContain("предел найден 2");
  });
});

describe("картинка сводки", () => {
  const summary = buildStatsSummary(snapshot(), { easy: 612, normal: 305, hard: null }, NOW, 180);

  it("подписывает даты, пояс и длительность по-русски", () => {
    expect(dayLabel("2026-09-14")).toBe("14 сентября");
    expect(offsetLabel(180)).toBe("UTC+3");
    expect(offsetLabel(-210)).toBe("UTC−3:30");
    expect(formatDuration(245)).toBe("4:05");
    expect(formatDuration(3760)).toBe("1:02:40");
  });

  it("экранирует ключи от клиента: причина смерти не ломает разметку", () => {
    expect(escapeXml(`<script>&"'`)).toBe("&#60;script&#62;&#38;&#34;&#39;");
    const svg = renderStatsSvg(
      buildStatsSummary(snapshot({ deathCauses: { "</text><script>": 3 } }), { easy: null, normal: null, hard: null }, NOW, 180),
      180,
    );
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&#60;/text&#62;&#60;script&#62;");
  });

  it("рисует пустую сводку без падения: первый день плейтеста", () => {
    const empty = snapshot({
      playersSeen: 0,
      playersPlayed: 0,
      installs: 0,
      runsToday: 0,
      byOs: {},
      byFormFactor: {},
      byClient: {},
      startingWeapons: {},
      deathCauses: {},
      stress: { reports: 0, byOs: {} },
    });
    const svg = renderStatsSvg(buildStatsSummary(empty, { easy: null, normal: null, hard: null }, NOW, 180), 180);
    expect(svg).toContain("нет данных");
    expect(svg).toContain("Отчётов пока нет");
  });

  it("растеризует в PNG", () => {
    const png = renderStatsPng(renderStatsSvg(summary, 180));
    expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(png.length).toBeGreaterThan(10_000);
  });

  it("дублирует главное подписью к фото в пределах лимита Telegram", () => {
    const caption = renderStatsCaption(summary);
    expect(caption).toContain("Открыли игру: 14 (сегодня 6)");
    expect(caption).toContain("ОС: Android 9, iOS 6, Windows 2");
    expect(caption).toContain("Лёгкая: 10 забегов, в среднем 4:00, рекорд 10:12");
    expect(caption).not.toContain("Сложная");
    expect(caption.length).toBeLessThanOrEqual(1024);
  });
});
