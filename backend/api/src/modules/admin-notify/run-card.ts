import { formatDuration, pluralRu, runProblemLabel } from "../../common/card/labels.js";
import { estimateWidth, PALETTE, rect, renderPng, SERIES, svgDocument, text } from "../../common/card/svg.js";
import type { RunSummary } from "../diagnostics/diagnostics-summary.js";
import type { StoredDevice } from "../diagnostics/dto/device.dto.js";
import type { RunSubmission } from "../diagnostics/dto/run-report.dto.js";
import { niceCeil, niceFpsMax, round } from "./chart-scale.js";
import { deviceLine } from "./stress-card.js";

/**
 * Карточка проблемного забега для чата администраторов (docs/28-diagnostics.md
 * §6.2): чем забег проблемный, на каком устройстве, и таймлайн — FPS линией,
 * объекты областью, а снизу красным — где симуляция догоняла время. Подпись
 * дублирует главное текстом и даёт команду повтора.
 */

const WIDTH = 1200;
const HEIGHT = 760;
const PAD = 56;
const SMOOTH_FPS = 50;

export interface RunCardInput {
  reportId: string;
  appVersion: string;
  device: StoredDevice;
  summary: RunSummary;
  payload: RunSubmission;
}

const DIFFICULTY_LABELS: Record<string, string> = { easy: "лёгкая", normal: "нормальная", hard: "сложная" };

const BLOCKER_LABELS: Record<string, string> = {
  resumed: "не повторить: продолжен из снимка",
  dev: "не повторить: забег разработчика",
  input_overflow: "не повторить: лог ввода обрезан",
};

export function renderRunCardSvg(input: RunCardInput): string {
  const { summary } = input;
  const parts: string[] = [];

  parts.push(text(PAD, PAD + 34, "Забег", { size: 44, fill: PALETTE.text, weight: 800 }));
  let chipX = PAD + estimateWidth("Забег", 44) + 36;
  for (const problem of summary.problems) {
    const label = runProblemLabel(problem);
    const chipWidth = estimateWidth(label, 24) + 36;
    parts.push(rect(chipX, PAD - 2, chipWidth, 44, { fill: PALETTE.raised, stroke: PALETTE.danger, radius: 22 }));
    parts.push(text(chipX + chipWidth / 2, PAD + 28, label, { size: 24, fill: PALETTE.danger, weight: 700, anchor: "middle" }));
    chipX += chipWidth + 12;
  }
  parts.push(text(WIDTH - PAD, PAD + 28, `сборка ${input.appVersion}`, { size: 24, fill: PALETTE.faint, anchor: "end" }));
  parts.push(text(PAD, PAD + 84, deviceLine(input.device), { size: 26, fill: PALETTE.muted }));

  const stats: [string, string, boolean][] = [
    ["время забега", formatDuration(summary.survivalSec), false],
    ["средний FPS", String(summary.avgFps), false],
    ["кадр 95%, мс", String(summary.p95FrameMs), summary.problems.includes("frame_drops")],
    ["рывков, %", percent(summary.over33Ratio), summary.problems.includes("frame_drops")],
    ["догоняние, %", percent(summary.catchUpRatio), summary.problems.includes("catch_up")],
    ["ошибок", String(summary.clientErrors), summary.problems.includes("client_errors")],
  ];
  const cellWidth = (WIDTH - PAD * 2) / stats.length;
  stats.forEach(([label, value, bad], index) => {
    const x = PAD + index * cellWidth;
    parts.push(text(x, PAD + 170, value, { size: 40, fill: bad ? PALETTE.danger : PALETTE.text, weight: 800 }));
    parts.push(text(x, PAD + 206, label, { size: 22, fill: PALETTE.faint }));
  });

  parts.push(...timelineChart(input, PAD, PAD + 250, WIDTH - PAD * 2, HEIGHT - PAD - (PAD + 250) - 40));

  const recording = input.payload.recording;
  const outcome = recording.outcome === "died" ? `погиб${recording.result.deathCause === null ? "" : ` от ${recording.result.deathCause}`}` : "сдался";
  const footer = [
    `${DIFFICULTY_LABELS[summary.difficulty] ?? summary.difficulty}, ${outcome}`,
    summary.replayBlocker === null ? "повторяется" : (BLOCKER_LABELS[summary.replayBlocker] ?? summary.replayBlocker),
    summary.interruptions > 0 ? `сворачивали ${summary.interruptions} ${pluralRu(summary.interruptions, "раз", "раза", "раз")}` : null,
    `отчёт ${input.reportId.slice(0, 8)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  parts.push(text(PAD, HEIGHT - PAD + 18, footer, { size: 20, fill: PALETTE.faint }));

  return svgDocument(WIDTH, HEIGHT, parts);
}

/** FPS линией по левой шкале, объекты областью по правой, догоняние — полосой у оси времени. */
function timelineChart(input: RunCardInput, x: number, y: number, width: number, height: number): string[] {
  const timeline = input.payload.recording.timeline;
  const parts: string[] = [rect(x, y, width, height, { fill: PALETTE.surface, stroke: PALETTE.border, radius: 18 })];
  if (timeline.length < 2) {
    parts.push(text(x + width / 2, y + height / 2, "забег слишком короткий для графика", { size: 24, fill: PALETTE.faint, anchor: "middle" }));
    return parts;
  }

  const inner = { left: x + 70, right: x + width - 90, top: y + 40, bottom: y + height - 58 };
  const bucketSec = (bucket: (typeof timeline)[number]): number => (bucket.avgFps > 0 ? bucket.frames / bucket.avgFps : 0);
  const last = timeline[timeline.length - 1]!;
  const duration = Math.max(1, last.startSec + bucketSec(last));
  const fpsMax = niceFpsMax(Math.max(input.summary.displayHz ?? 60, ...timeline.map((bucket) => bucket.avgFps)));
  const objectsMax = niceCeil(Math.max(1, ...timeline.map((bucket) => bucket.maxObjects)));
  const px = (sec: number): number => inner.left + (sec / duration) * (inner.right - inner.left);
  const pyFps = (fps: number): number => inner.bottom - (Math.min(fps, fpsMax) / fpsMax) * (inner.bottom - inner.top);
  const pyObjects = (count: number): number => inner.bottom - (Math.min(count, objectsMax) / objectsMax) * (inner.bottom - inner.top);
  const mid = (bucket: (typeof timeline)[number]): number => bucket.startSec + bucketSec(bucket) / 2;

  for (const fraction of [0, 0.5, 1]) {
    const lineY = inner.bottom - fraction * (inner.bottom - inner.top);
    parts.push(`<line x1="${inner.left}" y1="${lineY}" x2="${inner.right}" y2="${lineY}" stroke="${PALETTE.border}" stroke-width="1"/>`);
    parts.push(text(inner.left - 12, lineY + 7, String(Math.round(fpsMax * fraction)), { size: 20, fill: PALETTE.accent, anchor: "end" }));
    parts.push(text(inner.right + 12, lineY + 7, String(Math.round(objectsMax * fraction)), { size: 20, fill: SERIES[0], anchor: "start" }));
  }
  parts.push(text(inner.left, y + 20, "FPS", { size: 18, fill: PALETTE.accent, anchor: "end" }));
  parts.push(text(inner.right, y + 20, "объектов на экране", { size: 18, fill: SERIES[0], anchor: "end" }));
  for (const sec of [0, duration / 2, duration]) {
    parts.push(text(px(sec), y + height - 14, formatDuration(sec), { size: 18, fill: PALETTE.faint, anchor: "middle" }));
  }

  const area = timeline.map((bucket) => `${round(px(mid(bucket)))},${round(pyObjects(bucket.enemies + bucket.projectiles))}`);
  parts.push(
    `<polygon points="${round(px(mid(timeline[0]!)))},${inner.bottom} ${area.join(" ")} ${round(px(mid(last)))},${inner.bottom}" fill="${SERIES[0]}" fill-opacity="0.18" stroke="${SERIES[0]}" stroke-width="2"/>`,
  );

  const smoothY = round(pyFps(SMOOTH_FPS));
  parts.push(`<line x1="${inner.left}" y1="${smoothY}" x2="${inner.right}" y2="${smoothY}" stroke="${PALETTE.danger}" stroke-width="2" stroke-dasharray="8 8" stroke-opacity="0.7"/>`);
  const fpsLine = timeline.map((bucket) => `${round(px(mid(bucket)))},${round(pyFps(bucket.avgFps))}`);
  parts.push(`<polyline points="${fpsLine.join(" ")}" fill="none" stroke="${PALETTE.accent}" stroke-width="4" stroke-linejoin="round"/>`);

  // Догоняние — полосой под осью: яркость — доля таких кадров в корзине.
  const stripY = inner.bottom + 8;
  let caughtUp = false;
  for (const bucket of timeline) {
    if (bucket.catchUpFrames === 0 || bucket.frames === 0) continue;
    caughtUp = true;
    const share = Math.min(1, bucket.catchUpFrames / bucket.frames / 0.2);
    const left = px(bucket.startSec);
    const right = px(bucket.startSec + bucketSec(bucket));
    const opacity = round(0.35 + 0.65 * share);
    parts.push(`<rect x="${round(left)}" y="${stripY}" width="${Math.max(2, round(right - left))}" height="10" rx="3" fill="${PALETTE.danger}" fill-opacity="${opacity}"/>`);
  }
  // Пояснение — в шапке графика: под осью его место занимают отметки времени.
  if (caughtUp) parts.push(text(x + width / 2, y + 20, "красная полоса у оси — игра догоняла время", { size: 18, fill: PALETTE.danger, anchor: "middle" }));
  return parts;
}

export function renderRunCardPng(input: RunCardInput): Buffer {
  return renderPng(renderRunCardSvg(input));
}

/** Подпись к фото — главное текстом и команда повтора, до 1024 знаков Telegram. */
export function runCaption(input: RunCardInput): string {
  const { summary } = input;
  return [
    `Забег · ${summary.problems.map(runProblemLabel).join(", ")} · сборка ${input.appVersion}`,
    deviceLine(input.device),
    `${formatDuration(summary.survivalSec)} на сложности ${DIFFICULTY_LABELS[summary.difficulty] ?? summary.difficulty}, FPS ${summary.avgFps}, p95 ${summary.p95FrameMs} мс, рывков ${percent(summary.over33Ratio)}%, догоняние ${percent(summary.catchUpRatio)}%, ошибок ${summary.clientErrors}`,
    summary.replayBlocker === null
      ? `Повтор: pnpm replay ${input.reportId} --from diagnostic_reports.ndjson`
      : (BLOCKER_LABELS[summary.replayBlocker] ?? summary.replayBlocker),
  ]
    .join("\n")
    .slice(0, 1024);
}

function percent(ratio: number): string {
  return String(Math.round(ratio * 1000) / 10);
}
