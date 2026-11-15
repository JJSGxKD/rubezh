/**
 * Версия ядра Xray и диапазон версий, на которых наш конфиг проверен (Р202).
 * Панель берёт запущенную версию из файла статуса контейнера и спрашивает
 * `xrayCompatibility`. Ничего из монорепо: пакет берут в другие проекты.
 */

/** Версия ядра Xray: три числа, как в метке выпуска без «v». */
export type XrayVersion = readonly [number, number, number];

/** Самая старая версия, на которой золотые конфиги прошли check-config.sh. Опускать — только после прогона на ней. */
export const XRAY_CORE_MIN = "26.11.9";
/** Версия образа в infra/prod/xray/Dockerfile. Строку правит workflow обновления ядра (xray-bump.yml): одна строка, этот вид. */
export const XRAY_CORE_MAX = "26.11.9";

export interface XrayCoreBlock {
  /** с этой версии включительно */
  readonly from: string;
  /** до этой версии, не включая; `null` — и все новее */
  readonly until: string | null;
  /** почему наш конфиг не принят — словами для панели */
  readonly reason: string;
}

/** Версии, на которых наш конфиг не принят. Пополняется, когда CI обновления упал, а код ещё не поправлен. */
export const XRAY_CORE_BLOCKS: readonly XrayCoreBlock[] = [];

export type XrayCompatibility =
  | { readonly kind: "tested" }
  | { readonly kind: "untested" }
  | { readonly kind: "older" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "unknown" };

const VERSION_RE = /^v?(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;

/** Три числа через точку, ведущая `v` допустима; всё прочее — `null`. */
export function parseXrayVersion(text: string): XrayVersion | null {
  const m = VERSION_RE.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function formatXrayVersion(version: XrayVersion): string {
  return `${version[0]}.${version[1]}.${version[2]}`;
}

export function compareXrayVersions(a: XrayVersion, b: XrayVersion): -1 | 0 | 1 {
  for (let i = 0; i < 3; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** Как версия соотносится с проверенным диапазоном и блоками. */
export function xrayCompatibility(
  version: string,
  range: { min: string; max: string } = { min: XRAY_CORE_MIN, max: XRAY_CORE_MAX },
  blocks: readonly XrayCoreBlock[] = XRAY_CORE_BLOCKS,
): XrayCompatibility {
  const v = parseXrayVersion(version);
  const min = parseXrayVersion(range.min);
  const max = parseXrayVersion(range.max);
  if (!v || !min || !max) return { kind: "unknown" };
  for (const block of blocks) {
    const from = parseXrayVersion(block.from);
    const until = block.until === null ? null : parseXrayVersion(block.until);
    if (!from || (block.until !== null && !until)) continue;
    if (compareXrayVersions(v, from) >= 0 && (until === null || compareXrayVersions(v, until) < 0)) {
      return { kind: "blocked", reason: block.reason };
    }
  }
  if (compareXrayVersions(v, min) < 0) return { kind: "older" };
  if (compareXrayVersions(v, max) > 0) return { kind: "untested" };
  return { kind: "tested" };
}

/** Ошибки данных: каждая строка называет поле. Пусто — всё верно. */
export function findXrayCoreProblems(range: { min: string; max: string }, blocks: readonly XrayCoreBlock[]): string[] {
  const problems: string[] = [];
  const min = parseXrayVersion(range.min);
  const max = parseXrayVersion(range.max);
  if (!min) problems.push("min не разбирается как версия");
  if (!max) problems.push("max не разбирается как версия");
  if (min && max && compareXrayVersions(min, max) > 0) problems.push("min новее max");
  blocks.forEach((block, i) => {
    const label = `блок ${i + 1}`;
    const from = parseXrayVersion(block.from);
    const until = block.until === null ? null : parseXrayVersion(block.until);
    if (!from) problems.push(`${label}: from не разбирается как версия`);
    if (block.until !== null && !until) problems.push(`${label}: until не разбирается как версия`);
    if (from && until && compareXrayVersions(until, from) <= 0) problems.push(`${label}: until не новее from`);
    const reason = block.reason.trim();
    if (reason.length === 0) problems.push(`${label}: reason пустая`);
    else if (reason.length > 200) problems.push(`${label}: reason длиннее 200 знаков`);
    if (from && min && max && (block.until === null || until)) {
      // блок [from, until) задевает [min, max], если from ≤ max и until > min
      const touchesMax = compareXrayVersions(from, max) <= 0;
      const touchesMin = until === null || compareXrayVersions(until, min) > 0;
      if (touchesMax && touchesMin) problems.push(`${label}: задевает проверенный отрезок min…max`);
    }
  });
  return problems;
}
