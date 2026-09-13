import type { ReactNode } from "react";
import { Diamond, Gem, Rocket, Shirt } from "lucide-react";
import { t } from "../../i18n";
import type { Reward, RewardKind } from "./stub-content";

/**
 * Награда значком и подписью. Вид награды различается и цветом, и формой
 * значка — одним цветом он не передаётся (docs/27-design-system-and-app-shell.md §4.4).
 */
const TEXT_TONE: Record<RewardKind, string> = {
  shards: "text-info",
  premium: "text-passive",
  boost: "text-accent",
  skin: "text-elite",
};

const TONE: Record<RewardKind, string> = {
  shards: "bg-info/15 text-info",
  premium: "bg-passive/15 text-passive",
  boost: "bg-accent/15 text-accent",
  skin: "bg-elite/15 text-elite",
};

export function RewardIcon(props: { kind: RewardKind; size?: number }): ReactNode {
  const size = props.size ?? 18;
  switch (props.kind) {
    case "shards":
      return <Gem size={size} aria-hidden="true" />;
    case "premium":
      return <Diamond size={size} aria-hidden="true" />;
    case "boost":
      return <Rocket size={size} aria-hidden="true" />;
    default:
      return <Shirt size={size} aria-hidden="true" />;
  }
}

export function rewardLabel(reward: Reward): string {
  return t(`reward.${reward.kind}`, { amount: reward.amount });
}

/** Подпись награды в строке задания: значок в цветной плашке и количество. */
export function RewardChip(props: { reward: Reward }): ReactNode {
  return (
    <span
      role="img"
      aria-label={rewardLabel(props.reward)}
      className="inline-flex shrink-0 items-center gap-1.5"
    >
      <span
        className={`inline-flex size-7 items-center justify-center rounded-md ${TONE[props.reward.kind]}`}
      >
        <RewardIcon kind={props.reward.kind} size={16} />
      </span>
      <span className="font-display text-sm font-bold tabular-nums text-text">
        {rewardAmount(props.reward)}
      </span>
    </span>
  );
}

/** Коротко для плиток: число, а у облика — ничего, он и так один. */
export function rewardAmount(reward: Reward): string {
  if (reward.kind === "skin") return "";
  return reward.kind === "boost" ? `×${reward.amount}` : String(reward.amount);
}

/** Плашка под значком: цвет вида награды на подложке того же цвета. */
export function rewardTone(kind: RewardKind): string {
  return TONE[kind];
}

/** Только цвет значка — там, где подложкой служит сам сектор или строка. */
export function rewardTextTone(kind: RewardKind): string {
  return TEXT_TONE[kind];
}
