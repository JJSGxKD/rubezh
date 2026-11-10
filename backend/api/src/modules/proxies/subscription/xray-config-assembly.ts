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
 */

/** Внутри сети tunnel вход слушает на всех интерфейсах: API живёт в другом контейнере. Порты наружу не публикуются. */
export const XRAY_LISTEN = "0.0.0.0";

export interface AssemblyDeps {
  repository: Pick<SubscriptionRepository, "list">;
  writer: ConfigWriter;
  xray: { basePort: number; slotCount: number };
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
  await deps.writer.write(buildXrayConfig(placed, { ...deps.xray, listen: XRAY_LISTEN }));
  return { missing };
}

/** Включённые подписки без годной части — без записи конфига: расписание по ним решает, кого обновить. */
export async function missingParts(deps: AssemblyDeps): Promise<string[]> {
  return (await collect(deps)).missing;
}
