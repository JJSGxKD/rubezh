import { blockReaches, blockShapeProblem, keysProblem, missingKeys, profileOf } from "./ad-networks.js";
import type { AdPlace, NetworkCandidate } from "./ads-rules.js";
import type { AdBlockRow } from "./ads.repository.js";
import type { AdViewer } from "./ads.service.js";

/**
 * Какие блоки выдача вправе предложить (docs/35-stage4-plan.md §3.7, WP12):
 * место, площадка и устройство зрителя, профиль сети и её ключи. Чистые
 * функции — их проверяют тесты, а сервис подставляет блоки из базы.
 */

/** Блоки места для площадки и устройства зрителя: пустой список площадок — везде, где работает сеть, устройств — везде. */
export function eligibleBlocks(blocks: readonly AdBlockRow[], place: AdPlace, viewer: Pick<AdViewer, "platform" | "device">): AdBlockRow[] {
  return blocks.filter(
    (block) =>
      block.place === place &&
      servable(block) &&
      blockReaches(block, viewer.platform) &&
      (block.devices.length === 0 || (viewer.device !== null && block.devices.includes(viewer.device))),
  );
}

/**
 * Блок, который SDK сможет показать: он по профилю своей сети, и у сети
 * заданы ключи. Панель такого не сохранит, но блок, заведённый до профилей, —
 * мог: выдача его пропускает, а панель показывает, что с ним не так.
 */
export function servable(block: Pick<AdBlockRow, "networkKey" | "place" | "externalId" | "success" | "platforms" | "networkKeys">): boolean {
  const profile = profileOf(block.networkKey);
  if (profile === undefined || blockShapeProblem(block) !== null) return false;
  return missingKeys(profile, block.networkKeys).length === 0 && keysProblem(profile, block.networkKeys) === null;
}

export function networksOf(blocks: readonly AdBlockRow[]): NetworkCandidate[] {
  const networks = new Map<string, NetworkCandidate>();
  for (const block of blocks) networks.set(block.networkKey, { networkKey: block.networkKey, priority: block.priority });
  return [...networks.values()];
}
