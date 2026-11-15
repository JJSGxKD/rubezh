import { canonicalJson } from "./content-hash.js";

/**
 * Разница черновика с базой (docs/19-content-admin.md §4.3, tasks/T-0303):
 * список `{ path, from, to }` только по тому, что отличается. Путь пишется так же,
 * как путь правки, поэтому любую строку можно применить к базе правкой и
 * получить черновик. `null` в `from` — поля или элемента в базе не было, в `to` —
 * в черновике нет. В снимке своих `null` нет (схема их не допускает), поэтому
 * путаницы со значением не бывает.
 */

export interface SnapshotChange {
  path: string;
  from: unknown;
  to: unknown;
}

export interface SnapshotDiff {
  changes: SnapshotChange[];
  /** отличий больше предела: показаны первые, остальные не перечислены */
  truncated: boolean;
}

/** Предел перечня: копия всего снимка вместо правки читается не как разница, а как шум. */
export const DIFF_LIMIT = 2_000;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

class Collector {
  readonly changes: SnapshotChange[] = [];
  full = false;
  constructor(private readonly limit: number) {}
  add(path: string, from: unknown, to: unknown): void {
    if (this.changes.length >= this.limit) {
      this.full = true;
      return;
    }
    this.changes.push({ path, from, to });
  }
  get done(): boolean {
    return this.full;
  }
}

export function diffSnapshots(base: unknown, draft: unknown, limit = DIFF_LIMIT): SnapshotDiff {
  const collector = new Collector(limit);
  walk(base, draft, "", collector);
  return { changes: collector.changes, truncated: collector.full };
}

const join = (prefix: string, key: string): string => (prefix === "" ? key : `${prefix}.${key}`);

function walk(a: unknown, b: unknown, path: string, out: Collector): void {
  if (out.done) return;
  if (isObject(a) && isObject(b)) {
    for (const key of Object.keys(a)) {
      if (!Object.hasOwn(b, key)) out.add(join(path, key), a[key], null);
      else walk(a[key], b[key], join(path, key), out);
    }
    for (const key of Object.keys(b)) {
      if (!Object.hasOwn(a, key)) out.add(join(path, key), null, b[key]);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const idsA = idsOf(a);
    const idsB = idsOf(b);
    if (idsA !== null && idsB !== null) walkById(a, b, idsA, idsB, path, out);
    else walkByIndex(a, b, path, out);
    return;
  }
  if (a !== b && canonicalJson(a) !== canonicalJson(b)) out.add(path, a, b);
}

function walkByIndex(a: unknown[], b: unknown[], path: string, out: Collector): void {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const at = `${path}[${String(index)}]`;
    if (index >= b.length) out.add(at, a[index], null);
    else if (index >= a.length) out.add(at, null, b[index]);
    else walk(a[index], b[index], at, out);
  }
}

/**
 * Список объектов с уникальными `id` сравнивается по `id`: добавленный и убранный
 * враг — отдельные отличия, а не сдвиг всех, что идут за ним. Смена порядка
 * общих элементов — отдельное отличие на самом списке: от порядка зависят
 * индексы типов, а значит и ход забега.
 */
function walkById(a: unknown[], b: unknown[], idsA: string[], idsB: string[], path: string, out: Collector): void {
  const inB = new Map(idsB.map((id, index) => [id, index]));
  const inA = new Map(idsA.map((id, index) => [id, index]));
  idsA.forEach((id, index) => {
    const at = `${path}[id=${id}]`;
    const other = inB.get(id);
    if (other === undefined) out.add(at, a[index], null);
    else walk(a[index], b[other], at, out);
  });
  idsB.forEach((id, index) => {
    if (!inA.has(id)) out.add(`${path}[id=${id}]`, null, b[index]);
  });
  const orderA = idsA.filter((id) => inB.has(id));
  const orderB = idsB.filter((id) => inA.has(id));
  if (orderA.join("\n") !== orderB.join("\n")) out.add(path, orderA, orderB);
}

function idsOf(list: unknown[]): string[] | null {
  if (list.length === 0) return null;
  const ids: string[] = [];
  for (const item of list) {
    if (!isObject(item) || typeof item.id !== "string") return null;
    ids.push(item.id);
  }
  return new Set(ids).size === ids.length ? ids : null;
}
