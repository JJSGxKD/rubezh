import { useEffect, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CoinIcon, GemIcon } from "../design-system/components/CurrencyIcons";
import { ShardIcon } from "../design-system/components/ShardIcon";
import { shardColor } from "../design-system/components/shard-tones";
import { formatNumber } from "../i18n";
import { burstVectors, COIN_BURST, type BurstIcon } from "./reward-burst-rules";

/**
 * Забор награды — событие, а не строка: значки веером вылетают из места
 * награды и осыпаются, над ним всплывает сумма. Слой — порталом в `body`:
 * экраны въезжают трансформом, и `fixed` внутри них считался бы от экрана.
 */

export type { BurstIcon };

export interface Burst {
  key: number;
  x: number;
  y: number;
  amount: number;
  icon: BurstIcon;
  /** редкость осколка — значок и сумма её цветом */
  rarity?: string;
}

/**
 * Выброс из центра элемента. Без движения системы выброса нет: награду и
 * так называет строка «Получено».
 */
export function burstAt(target: Element | null, amount: number, icon: BurstIcon, rarity?: string): Burst | null {
  if (target === null || amount <= 0) return null;
  if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return null;
  const rect = target.getBoundingClientRect();
  const burst: Burst = { key: performance.now(), x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, amount, icon };
  if (rarity !== undefined) burst.rarity = rarity;
  return burst;
}

const FLOAT_TONE: Record<BurstIcon, string> = { coin: "text-coin", gem: "text-gem", shard: "text-text" };

export function RewardBurst(props: { burst: Burst; onDone(): void }): ReactNode {
  const { burst, onDone } = props;
  useEffect(() => {
    const timer = setTimeout(onDone, 1200);
    return () => clearTimeout(timer);
  }, [onDone]);
  return createPortal(
    <div aria-hidden="true" className="pointer-events-none fixed" style={{ left: burst.x, top: burst.y, zIndex: "var(--z-toast)" }}>
      {burstVectors(COIN_BURST.coins).map((coin, index) => (
        <span
          key={index}
          className="absolute -mt-2.5 -ml-2.5 animate-coin-burst"
          style={{ "--burst-x": `${String(coin.x)}px`, "--burst-y": `${String(coin.y)}px`, animationDelay: `${String(coin.delayMs)}ms` } as CSSProperties}
        >
          <BurstGlyph icon={burst.icon} rarity={burst.rarity ?? "common"} />
        </span>
      ))}
      <span className="absolute -top-4 left-0 -translate-x-1/2">
        <span
          className={`block animate-reward-float font-display text-2xl font-bold whitespace-nowrap tabular-nums ${FLOAT_TONE[burst.icon]}`}
          style={burst.icon === "shard" ? { color: shardColor(burst.rarity ?? "common") } : undefined}
        >
          +{formatNumber(burst.amount)}
        </span>
      </span>
    </div>,
    document.body,
  );
}

function BurstGlyph(props: { icon: BurstIcon; rarity: string }): ReactNode {
  if (props.icon === "gem") return <GemIcon size={20} />;
  if (props.icon === "shard") return <ShardIcon rarity={props.rarity} size={20} />;
  return <CoinIcon size={20} />;
}
