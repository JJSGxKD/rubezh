import { PLACE_TITLES, blockServable, type AdBlock, type AdsView } from "../../api/ads";

/**
 * Список «Блоки мест» (docs/35-stage4-plan.md Р200, tasks/T-0409): блок в
 * архиве виден только во вкладке «Архив», остальные — во вкладке «Действующие».
 * Всё, что можно посчитать без экрана, — здесь, чтобы таблица, окно «В архив»
 * и тесты называли состояние блока одними словами.
 */

export type BlocksTab = "current" | "archive";

export const BLOCKS_TABS: readonly { id: BlocksTab; title: string }[] = [
  { id: "current", title: "Действующие" },
  { id: "archive", title: "Архив" },
];

/** Блоки вкладки в прежнем порядке сервера. */
export function blocksOfTab(blocks: readonly AdBlock[], tab: BlocksTab): AdBlock[] {
  return blocks.filter((block) => (block.archivedAt === null) === (tab === "current"));
}

/** Сколько блоков во вкладках — числа для чипов; нуль показывается. */
export function blocksTabCounts(blocks: readonly AdBlock[]): Record<BlocksTab, number> {
  const archive = blocks.filter((block) => block.archivedAt !== null).length;
  return { current: blocks.length - archive, archive };
}

/** Как блок участвует в выдаче: от «не по правилам» (важнее всего) до «в выдаче». */
export type BlockState = "problem" | "off" | "served" | "waiting";

export function blockStateOf(view: Pick<AdsView, "networks">, block: Pick<AdBlock, "networkKey" | "active" | "problem">): BlockState {
  if (block.problem !== null) return "problem";
  if (!block.active) return "off";
  return blockServable(view, block) ? "served" : "waiting";
}

const STATE_TEXT: Record<BlockState, string> = { problem: "не по правилам сети", off: "выключен", served: "в выдаче", waiting: "ждёт сеть" };

/** Что значит состояние для выдачи — хвост бейджа в таблице; в окне подтверждения хватает слов состояния. */
export const BLOCK_STATE_HINTS: Record<BlockState, string> = { problem: " — не выдаётся", off: "", served: "", waiting: ": включить и задать ключи" };

/** Состояние блока словами — то же, что колонка «Состояние»; для подтверждения «было → станет». */
export function blockStateText(view: Pick<AdsView, "networks">, block: Pick<AdBlock, "networkKey" | "active" | "problem">): string {
  return STATE_TEXT[blockStateOf(view, block)];
}

/** Чего касается окно «В архив»: «место · сеть · блок в кабинете или «по ключам сети»». */
export function blockSubject(view: Pick<AdsView, "networks">, block: Pick<AdBlock, "networkKey" | "place" | "externalId">): string {
  const network = view.networks.find((candidate) => candidate.networkKey === block.networkKey)?.name ?? block.networkKey;
  return `${PLACE_TITLES[block.place]} · ${network} · ${block.externalId ?? "по ключам сети"}`;
}

/** «В архив» может снять блок с выдачи — тогда кнопка красная; выключенный и так не выдаётся. */
export function archiveTone(view: Pick<AdsView, "networks">, block: Pick<AdBlock, "networkKey" | "active" | "problem">): "danger" | "primary" {
  return blockStateOf(view, block) === "served" ? "danger" : "primary";
}
