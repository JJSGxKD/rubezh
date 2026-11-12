import { Logger } from "@nestjs/common";
import { buildXrayConfig, type PlacedNode } from "@bh/proxy-kit";
import type { SubscriptionRepository } from "./subscription.repository.js";
import type { ConfigPart, ConfigWriter } from "./xray-config-writer.js";

/**
 * Сборка общего `config.json` спутника из частей подписок (docs/35-stage4-plan.md
 * Р192, tasks/T-0384). Узлы каждой подписки лежат отдельным файлом-частью в томе
 * (`xray-config-writer.ts`), а конфиг — один: так обновление или сбой одной
 * подписки не теряет узлы остальных.
 *
 * Звать только под общим замком `proxy-subscription:refresh:lock`: сборка читает
 * части и пишет конфиг, и две параллельные сборки затёрли бы друг друга.
 *
 * Учёт трафика (Р192, tasks/T-0386): с `xray.statsPort` в конфиг входят счётчики
 * выходов и служба их чтения. После записи Xray перезапускается и счётчики
 * обнуляются, поэтому перед записью зовётся `beforeWrite` — сборщик успевает их снять.
 */

/** Внутри сети tunnel вход слушает на всех интерфейсах: API живёт в другом контейнере. Порты наружу не публикуются. */
export const XRAY_LISTEN = "0.0.0.0";

export interface AssemblyDeps {
  repository: Pick<SubscriptionRepository, "list">;
  writer: ConfigWriter;
  /** `statsPort` не задан — конфиг без счётчиков трафика */
  xray: { basePort: number; slotCount: number; statsPort?: number };
  /** снять счётчики перед записью конфига; его сбой запись не останавливает */
  beforeWrite?: () => Promise<void>;
}

export interface AssemblyResult {
  /** включённые подписки, чьей части нет, она не читается или не по входам: их узлы в конфиг не попали */
  missing: string[];
}

/** Узлы включённых подписок и ключи тех из них, чьей частью воспользоваться нельзя. */
async function collect(deps: AssemblyDeps, override?: { key: string; part: ConfigPart }): Promise<{ placed: PlacedNode[]; missing: string[] }> {
  const placed: PlacedNode[] = [];
  const missing: string[] = [];
  for (const { subscription } of await deps.repository.list()) {
    if (!subscription.enabled) continue;
    const part = override?.key === subscription.key ? override.part : await deps.writer.readPart(subscription.key);
    // Слот за пределами входов (XRAY_SLOT_COUNT уменьшили) конфигу не годится: такую часть обновление пересоберёт.
    if (part === null || part.nodes.some((entry) => entry.slot >= deps.xray.slotCount)) {
      missing.push(subscription.key);
      continue;
    }
    for (const entry of part.nodes) placed.push({ group: subscription.key, node: entry.node, slot: entry.slot });
  }
  return { placed, missing };
}

/**
 * Собрать `config.json` из частей включённых подписок. `override` — часть, которую
 * вызывающий только что записал: берётся она, а не файл. Выключенные подписки в
 * конфиг не входят, но их части и слоты остаются на месте: включение назад
 * мгновенное, без загрузки.
 */
export async function assembleConfig(deps: AssemblyDeps, override?: { key: string; part: ConfigPart }): Promise<AssemblyResult> {
  const { placed, missing } = await collect(deps, override);
  const { basePort, slotCount, statsPort } = deps.xray;
  const config = buildXrayConfig(placed, { basePort, slotCount, listen: XRAY_LISTEN, ...(statsPort === undefined ? {} : { stats: { port: statsPort } }) });
  await flushBefore(deps);
  await deps.writer.write(config);
  return { missing };
}

/** Снятие счётчиков не стоит конфига: ошибка уходит в лог без текста, запись идёт дальше. */
async function flushBefore(deps: AssemblyDeps): Promise<void> {
  if (deps.beforeWrite === undefined) return;
  try {
    await deps.beforeWrite();
  } catch (error: unknown) {
    new Logger("proxy-traffic").warn(JSON.stringify({ module: "proxy-traffic", event: "flush_failed", reason: error instanceof Error ? error.name : "unknown" }));
  }
}

/** Включённые подписки без годной части — без записи конфига: расписание по ним решает, кого обновить. */
export async function missingParts(deps: AssemblyDeps): Promise<string[]> {
  return (await collect(deps)).missing;
}
