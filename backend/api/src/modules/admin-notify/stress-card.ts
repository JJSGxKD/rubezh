import { clientLabel, formatDuration, formFactorLabel, osLabel, pluralRu, stressOutcomeLabel } from "../../common/card/labels.js";
import { estimateWidth, PALETTE, rect, renderPng, SERIES, svgDocument, text } from "../../common/card/svg.js";
import type { BenchSummary } from "../diagnostics/diagnostics-summary.js";
import type { StoredDevice } from "../diagnostics/dto/device.dto.js";
import type { BenchSubmission } from "../diagnostics/dto/report-envelope.dto.js";
import { niceCeil, niceFpsMax, round } from "./chart-scale.js";

/**
 * Карточка стресс-теста для чата администраторов: на каком устройстве,
 * чем кончилось, где предел — и график таймлайна, по которому видно, на какой
 * нагрузке FPS пошёл вниз. Подпись дублирует главное текстом: на машине без
 * шрифтов с кириллицей картинка останется без букв.
 */

const WIDTH = 1200;
const HEIGHT = 760;
const PAD = 56;
/** Порог плавности из вердикта стенда: ниже 50 FPS корзина считается просадкой. */
const SMOOTH_FPS = 50;

export interface StressCardInput {
  reportId: string;
  appVersion: string;
  device: StoredDevice;
  summary: BenchSummary;
  payload: BenchSubmission;
}

const OUTCOME_COLORS: Record<string, string> = {
  degradation: PALETTE.accent,
  duration: PALETTE.success,
  pool_exhausted: PALETTE.success,
  manual: PALETTE.faint,
};

export function deviceLine(device: StoredDevice): string {
  const client = device.clientPlatform === null ? null : `${clientLabel(device.clientPlatform)}${device.clientVersion === null ? "" : ` ${device.clientVersion}`}`;
  return [
    osLabel(device.os),
    formFactorLabel(device.formFactor),
    client,
    `${device.screenWidth}×${device.screenHeight} ×${device.pixelRatio}`,
    device.cores === null ? null : `${device.cores} ядер`,
    device.memoryGb === null ? null : `${device.memoryGb} ГБ`,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function renderStressCardSvg(input: StressCardInput): string {
  const { summary, device } = input;
  const outcomeColor = OUTCOME_COLORS[summary.outcome] ?? PALETTE.muted;
  const outcome = stressOutcomeLabel(summary.outcome);
  const parts: string[] = [];

  parts.push(text(PAD, PAD + 34, "Стресс-тест", { size: 44, fill: PALETTE.text, weight: 800 }));
  const chipX = PAD + estimateWidth("Стресс-тест", 44) + 36;
  const chipWidth = estimateWidth(outcome, 26) + 40;
  parts.push(rect(chipX, PAD - 4, chipWidth, 48, { fill: PALETTE.raised, stroke: outcomeColor, radius: 24 }));
  parts.push(text(chipX + chipWidth / 2, PAD + 28, outcome, { size: 26, fill: outcomeColor, weight: 700, anchor: "middle" }));
  parts.push(text(WIDTH - PAD, PAD + 28, `сборка ${input.appVersion}`, { size: 24, fill: PALETTE.faint, anchor: "end" }));
  parts.push(text(PAD, PAD + 84, deviceLine(device), { size: 26, fill: PALETTE.muted }));

  // Единицы — в подписях, а не в числах: иначе широкое значение наезжает на соседнее.
  const stats: [string, string][] = [
    ["пик объектов", String(summary.peakObjects)],
    ["врагов плавно", summary.sustainedLoad > 0 ? String(summary.sustainedLoad) : "—"],
    ["средний FPS", String(summary.avgFps)],
    ["кадр 95%, мс", String(summary.p95FrameMs)],
    ["экран, Гц", summary.displayHz === null ? "—" : String(summary.displayHz)],
    ["длительность", formatDuration(summary.durationSec)],
  ];
  const cellWidth = (WIDTH - PAD * 2) / stats.length;
  stats.forEach(([label, value], index) => {
    const x = PAD + index * cellWidth;
    parts.push(text(x, PAD + 170, value, { size: index === 0 ? 48 : 38, fill: index === 0 ? PALETTE.accent : PALETTE.text, weight: 800 }));
    parts.push(text(x, PAD + 206, label, { size: 22, fill: PALETTE.faint }));
  });

  parts.push(...timelineChart(input, PAD, PAD + 250, WIDTH - PAD * 2, HEIGHT - PAD - (PAD + 250) - 40));

  const footer = [`отчёт ${input.reportId.slice(0, 8)}`, summary.interruptions > 0 ? `${interruptionsLine(summary.interruptions)} — цифры неточны` : null]
    .filter((part): part is string => part !== null)
    .join(" · ");
  parts.push(text(PAD, HEIGHT - PAD + 18, footer, { size: 20, fill: summary.interruptions > 0 ? PALETTE.danger : PALETTE.faint }));

  return svgDocument(WIDTH, HEIGHT, parts);
}

/**
 * FPS линией по левой шкале и объекты на экране областью по правой. Одна шкала
 * на ось, подписи — только тех значений, до которых график доходит.
 */
function timelineChart(input: StressCardInput, x: number, y: number, width: number, height: number): string[] {
  const timeline = input.payload.report.timeline;
  const parts: string[] = [rect(x, y, width, height, { fill: PALETTE.surface, stroke: PALETTE.border, radius: 18 })];
  if (timeline.length < 2) {
    parts.push(text(x + width / 2, y + height / 2, "таймлайн слишком короткий для графика", { size: 24, fill: PALETTE.faint, anchor: "middle" }));
    return parts;
  }

  const inner = { left: x + 70, right: x + width - 90, top: y + 40, bottom: y + height - 44 };
  const last = timeline[timeline.length - 1];
  const duration = Math.max(1, (last?.startSec ?? 0) + (last?.durationSec ?? 0));
  const fpsMax = niceFpsMax(Math.max(input.summary.displayHz ?? 60, ...timeline.map((bucket) => bucket.avgFps)));
  const objectsMax = niceCeil(Math.max(1, ...timeline.map((bucket) => bucket.load + bucket.projectiles)));
  const px = (sec: number): number => inner.left + (sec / duration) * (inner.right - inner.left);
  const pyFps = (fps: number): number => inner.bottom - (Math.min(fps, fpsMax) / fpsMax) * (inner.bottom - inner.top);
  const pyObjects = (count: number): number => inner.bottom - (count / objectsMax) * (inner.bottom - inner.top);
  const mid = (bucket: (typeof timeline)[number]): number => bucket.startSec + bucket.durationSec / 2;

  // Сетка и подписи шкал: низ, середина, верх.
  for (const fraction of [0, 0.5, 1]) {
    const lineY = inner.bottom - fraction * (inner.bottom - inner.top);
    parts.push(`<line x1="${inner.left}" y1="${lineY}" x2="${inner.right}" y2="${lineY}" stroke="${PALETTE.border}" stroke-width="1"/>`);
    parts.push(text(inner.left - 12, lineY + 7, String(Math.round(fpsMax * fraction)), { size: 20, fill: PALETTE.accent, anchor: "end" }));
    parts.push(text(inner.right + 12, lineY + 7, String(Math.round(objectsMax * fraction)), { size: 20, fill: SERIES[0], anchor: "start" }));
  }
  // Названия шкал — над шкалами: внизу их место занимают отметки времени.
  parts.push(text(inner.left, y + 20, "FPS", { size: 18, fill: PALETTE.accent, anchor: "end" }));
  parts.push(text(inner.right, y + 20, "объектов на экране", { size: 18, fill: SERIES[0], anchor: "end" }));
  for (const sec of [0, duration / 2, duration]) {
    parts.push(text(px(sec), y + height - 14, formatDuration(sec), { size: 18, fill: PALETTE.faint, anchor: "middle" }));
  }

  const area = timeline.map((bucket) => `${round(px(mid(bucket)))},${round(pyObjects(bucket.load + bucket.projectiles))}`);
  const firstX = round(px(mid(timeline[0]!)));
  const lastX = round(px(mid(last!)));
  parts.push(`<polygon points="${firstX},${inner.bottom} ${area.join(" ")} ${lastX},${inner.bottom}" fill="${SERIES[0]}" fill-opacity="0.18" stroke="${SERIES[0]}" stroke-width="2"/>`);

  const smoothY = round(pyFps(SMOOTH_FPS));
  parts.push(`<line x1="${inner.left}" y1="${smoothY}" x2="${inner.right}" y2="${smoothY}" stroke="${PALETTE.danger}" stroke-width="2" stroke-dasharray="8 8" stroke-opacity="0.7"/>`);

  const fpsLine = timeline.map((bucket) => `${round(px(mid(bucket)))},${round(pyFps(bucket.avgFps))}`);
  parts.push(`<polyline points="${fpsLine.join(" ")}" fill="none" stroke="${PALETTE.accent}" stroke-width="4" stroke-linejoin="round"/>`);

  const breaking = input.payload.verdict.breakingPoint;
  if (breaking !== null) {
    const markX = round(px(breaking.atSec));
    parts.push(`<line x1="${markX}" y1="${inner.top}" x2="${markX}" y2="${inner.bottom}" stroke="${PALETTE.text}" stroke-width="2" stroke-dasharray="4 6"/>`);
    const label = `просадка на ${Math.round(breaking.load)} врагах`;
    const anchor = markX > inner.right - estimateWidth(label, 20) ? "end" : "start";
    // Подпись у нижнего края: наверху её пересекала бы линия FPS, которая
    // как раз здесь начинает падать.
    parts.push(text(anchor === "end" ? markX - 10 : markX + 10, inner.bottom - 14, label, { size: 20, fill: PALETTE.text, anchor }));
  }
  return parts;
}

export function renderStressCardPng(input: StressCardInput): Buffer {
  return renderPng(renderStressCardSvg(input));
}

/** Подпись к фото — главное текстом, до 1024 знаков Telegram. */
export function stressCaption(input: StressCardInput): string {
  const { summary } = input;
  return [
    `Стресс-тест · ${stressOutcomeLabel(summary.outcome)} · сборка ${input.appVersion}`,
    deviceLine(input.device),
    `Пик ${summary.peakObjects} объектов, плавно ${summary.sustainedLoad} врагов, FPS ${summary.avgFps}, p95 ${summary.p95FrameMs} мс, экран ${summary.displayHz ?? "—"} Гц, ${formatDuration(summary.durationSec)}`,
    summary.interruptions > 0 ? `Приложение ${interruptionsLine(summary.interruptions)} — цифры неточны` : null,
    `Отчёт ${input.reportId}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
    .slice(0, 1024);
}

function interruptionsLine(count: number): string {
  return `сворачивали ${count} ${pluralRu(count, "раз", "раза", "раз")}`;
}
