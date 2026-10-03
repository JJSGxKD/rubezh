import { useEffect, useState, type ReactNode } from "react";

/**
 * Картинка слева от задания — 44 px, как значок вида (docs/35-stage4-plan.md
 * Р82): у задания ленты сети — из ленты, у своего партнёрского — из панели.
 * Нет картинки или она не загрузилась — значок, который передал вызывающий:
 * пустой квадрат читался бы как поломка.
 */
export function TaskImage(props: { src: string | null; fallback: ReactNode }): ReactNode {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [props.src]);
  if (props.src === null || broken) return props.fallback;
  return <img src={props.src} alt="" width={44} height={44} loading="lazy" decoding="async" onError={() => setBroken(true)} className="size-11 shrink-0 rounded-md bg-surface-sunken object-cover" />;
}
