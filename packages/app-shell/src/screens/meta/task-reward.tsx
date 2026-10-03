import type { ReactNode } from "react";
import { CoinIcon, GemIcon } from "../../design-system/components/CurrencyIcons";
import { ShardIcon } from "../../design-system/components/ShardIcon";
import { formatNumber, t } from "../../i18n";
import type { TaskReward } from "../../state/tasks-api";

/**
 * Награда задания — значками и словами: её показывают и строки своих
 * заданий, и задания рекламных сетей (docs/35-stage4-plan.md WP13).
 */

/**
 * Награда значками: монеты, самоцветы и осколки различаются и формой, и
 * цветом (§4.4). Столбиком — справа от строки задания; в строку — под
 * заголовком задания сети, где её место отвела сеть.
 */
export function RewardChips(props: { reward: TaskReward; inline?: boolean }): ReactNode {
  const { coins, gems, shards } = props.reward;
  return (
    <span role="img" aria-label={rewardText(props.reward)} className={props.inline === true ? "flex flex-wrap items-center gap-x-3 gap-y-1" : "flex flex-col items-end gap-1"}>
      {coins > 0 ? <Chip icon={<CoinIcon size={16} />} amount={coins} /> : null}
      {gems > 0 ? <Chip icon={<GemIcon size={16} />} amount={gems} /> : null}
      {shards > 0 ? <Chip icon={<ShardIcon rarity="common" size={16} />} amount={shards} /> : null}
    </span>
  );
}

function Chip(props: { icon: ReactNode; amount: number }): ReactNode {
  return (
    <span className="inline-flex items-center gap-1.5">
      {props.icon}
      <span className="font-display text-sm font-bold tabular-nums text-text">{formatNumber(props.amount)}</span>
    </span>
  );
}

export function rewardText(reward: TaskReward): string {
  const parts = (["coins", "gems", "shards"] as const)
    .filter((resource) => reward[resource] > 0)
    .map((resource) => t(`task.reward.${resource}`, { amount: formatNumber(reward[resource]), n: reward[resource] }));
  return parts.join(t("tasks.and"));
}
