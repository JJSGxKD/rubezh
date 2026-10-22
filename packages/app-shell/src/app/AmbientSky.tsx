import { memo, type CSSProperties, type ReactNode } from "react";
import { AMBIENT, emberLayout, starLayout } from "./ambient-rules";

const STARS = starLayout(AMBIENT.stars);
const EMBERS = emberLayout(AMBIENT.embers);

/**
 * Живой фон приложения (design/art/direction-v2.md §4.4): звёзды сумеречного
 * неба мерцают, искры очага медленно поднимаются, внизу — частокол рубежа.
 * Мало и медленно: фон живой, но не зовёт глаз.
 *
 * Только `transform` и `opacity`, всё — один раз отрисованный слой без
 * перерисовок React. Во время забега фона нет: под канвой он только жёг бы
 * батарею. «Меньше движения» останавливает анимации на первом кадре, где
 * искры прозрачны, а звёзды стоят.
 */
export const AmbientSky = memo(function AmbientSky(): ReactNode {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      {STARS.map((star, index) => (
        <span
          key={`s${String(index)}`}
          className="absolute animate-star-twinkle rounded-full bg-text"
          style={{
            left: `${String(star.x)}%`,
            top: `${String(star.y)}%`,
            width: star.size,
            height: star.size,
            animationDelay: `${String(star.delaySec)}s`,
            animationDuration: `${String(star.durationSec)}s`,
          }}
        />
      ))}
      {EMBERS.map((ember, index) => (
        <span
          key={`e${String(index)}`}
          className="absolute bottom-0 animate-ember-rise rounded-full bg-accent-glow"
          style={
            {
              left: `${String(ember.x)}%`,
              width: ember.size,
              height: ember.size,
              "--ember-drift": `${String(ember.drift)}px`,
              animationDelay: `${String(ember.delaySec)}s`,
              animationDuration: `${String(ember.durationSec)}s`,
            } as CSSProperties
          }
        />
      ))}
      <Palisade />
    </div>
  );
});

/**
 * Частокол рубежа по низу экрана — образ названия игры. Тёмным по тёмному:
 * его чувствуют, а не разглядывают.
 */
function Palisade(): ReactNode {
  const stakes: string[] = [];
  for (let i = 0; i < 40; i++) {
    const x = i * 10;
    const h = 22 + ((i * 7) % 5) * 3;
    stakes.push(`M${String(x)} 60V${String(60 - h)}l5-6 5 6V60z`);
  }
  return (
    <svg viewBox="0 0 400 60" preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-14 w-full opacity-60">
      <path d={stakes.join("")} fill="var(--color-surface-sunken)" />
      <path d="M0 46h400" stroke="var(--color-surface-sunken)" strokeWidth="3" />
    </svg>
  );
}
