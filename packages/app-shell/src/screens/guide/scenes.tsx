import { useId, type CSSProperties, type ReactNode } from "react";
import type { EnemyPattern, WeaponBehavior } from "@bh/shared-types";
import { ENEMY_LOOKS, enemyColor, GEM_TIERS, PICKUP_LOOKS, WORLD_COLORS, type ShapeKind } from "@bh/core-game";

/**
 * Мини-сцены гайдбука: как ведёт себя враг или бьёт оружие — циклом в
 * несколько секунд, а не абзацем текста.
 *
 * Формы и цвета — те же данные, по которым движок рисует канву
 * (`core-game/src/game/render/looks.ts`): картинка в гайдбуке совпадает с
 * тем, что игрок увидит в забеге. Анимации — только transform и opacity, из
 * токенов (`tokens.css`, `guide-*`); при «уменьшить движение» сцена стоит.
 */

const VIEW_W = 160;
const VIEW_H = 96;
const PLAYER_R = 6;
const MOTION = "motion-reduce:animate-none";

/** Цвет канвы числом — в цвет SVG. */
export function hex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** Смещение для анимаций сцены: откуда пришёл или куда летит элемент. */
function offset(x: number, y: number): CSSProperties {
  return { "--guide-x": `${x}px`, "--guide-y": `${y}px` } as CSSProperties;
}

/**
 * Фигура мира в точке (0, 0) — те же пропорции, что у текстур движка
 * (`render/shapes.ts`): фигура вписана в круг радиуса `r`.
 */
export function WorldShape(props: { shape: ShapeKind; color: number; r: number }): ReactNode {
  const { r } = props;
  const fill = hex(props.color);
  const light = hex(WORLD_COLORS.pickupLight);

  switch (props.shape) {
    case "square":
      return <rect x={-r * 0.85} y={-r * 0.85} width={r * 1.7} height={r * 1.7} fill={fill} />;
    case "triangle":
      return <polygon points={`0,${-r} ${r},${r} ${-r},${r}`} fill={fill} />;
    case "diamond":
      return <polygon points={`0,${-r} ${r * 0.75},0 0,${r} ${-r * 0.75},0`} fill={fill} />;
    case "hexagon":
      return (
        <polygon
          points={[
            [0.5, -0.866],
            [1, 0],
            [0.5, 0.866],
            [-0.5, 0.866],
            [-1, 0],
            [-0.5, -0.866],
          ]
            .map(([x, y]) => `${x * r},${y * r}`)
            .join(" ")}
          fill={fill}
        />
      );
    case "ring":
      return <circle r={r * 0.8} fill="none" stroke={fill} strokeWidth={Math.max(1.5, r * 0.35)} />;
    case "double":
      return (
        <>
          <circle cx={-r * 0.35} cy={-r * 0.25} r={r * 0.6} fill={fill} />
          <circle cx={r * 0.35} cy={r * 0.25} r={r * 0.6} fill={fill} />
        </>
      );
    case "medkit":
      return (
        <>
          <rect x={-r * 0.9} y={-r * 0.9} width={r * 1.8} height={r * 1.8} rx={r * 0.35} fill={light} />
          <rect x={-r * 0.22} y={-r * 0.6} width={r * 0.44} height={r * 1.2} fill={fill} />
          <rect x={-r * 0.6} y={-r * 0.22} width={r * 1.2} height={r * 0.44} fill={fill} />
        </>
      );
    case "magnet":
      return (
        <>
          <path
            d={`M ${-r * 0.6} ${-r * 0.05} A ${r * 0.6} ${r * 0.6} 0 0 0 ${r * 0.6} ${-r * 0.05}`}
            fill="none"
            stroke={fill}
            strokeWidth={r * 0.5}
          />
          <rect x={-r * 0.85} y={-r * 0.75} width={r * 0.5} height={r * 0.7} fill={fill} />
          <rect x={r * 0.35} y={-r * 0.75} width={r * 0.5} height={r * 0.7} fill={fill} />
          <rect x={-r * 0.85} y={-r * 0.9} width={r * 0.5} height={r * 0.35} fill={light} />
          <rect x={r * 0.35} y={-r * 0.9} width={r * 0.5} height={r * 0.35} fill={light} />
        </>
      );
    case "dynamite":
      return (
        <>
          <rect x={-r * 0.45} y={-r * 0.5} width={r * 0.9} height={r * 1.45} rx={r * 0.2} fill={fill} />
          <rect x={-r * 0.45} y={-r * 0.15} width={r * 0.9} height={r * 0.15} fill={hex(WORLD_COLORS.dynamiteBand)} />
          <rect x={-r * 0.45} y={r * 0.45} width={r * 0.9} height={r * 0.15} fill={hex(WORLD_COLORS.dynamiteBand)} />
          <line x1={0} y1={-r * 0.5} x2={r * 0.3} y2={-r * 0.8} stroke={light} strokeWidth={Math.max(1, r * 0.12)} />
          <circle cx={r * 0.35} cy={-r * 0.82} r={r * 0.2} fill={hex(WORLD_COLORS.dynamiteSpark)} />
        </>
      );
    default:
      return <circle r={r} fill={fill} />;
  }
}

/** Рамка сцены: земля забега с сеткой, как на канве. */
function Stage(props: { label: string; children: ReactNode }): ReactNode {
  // Сцен на экране много, а id узора в SVG общий на весь документ. Служебные
  // символы из id React вычищаются: внутри `url(#…)` их разбирают не везде.
  const groundId = `guide-ground-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label={props.label}
      className="block h-auto w-full overflow-hidden rounded-md"
    >
      <defs>
        <pattern id={groundId} width="16" height="16" patternUnits="userSpaceOnUse">
          <rect width="16" height="16" fill={hex(WORLD_COLORS.ground)} />
          <path d="M 16 0 L 0 0 0 16" fill="none" stroke={hex(WORLD_COLORS.groundLine)} strokeWidth="1" />
        </pattern>
      </defs>
      <rect width={VIEW_W} height={VIEW_H} fill={`url(#${groundId})`} />
      {props.children}
    </svg>
  );
}

function Player(props: { x: number; y: number }): ReactNode {
  return <circle cx={props.x} cy={props.y} r={PLAYER_R} fill={hex(WORLD_COLORS.player)} />;
}

/** Элемент сцены в точке (x, y) с анимацией на вложенной группе. */
function At(props: { x: number; y: number; className?: string; style?: CSSProperties; children: ReactNode }): ReactNode {
  return (
    <g transform={`translate(${props.x} ${props.y})`}>
      <g className={props.className === undefined ? undefined : `${props.className} ${MOTION}`} style={props.style}>
        {props.children}
      </g>
    </g>
  );
}

/** Анимация по кругу с задержкой: несколько врагов не должны шагать в ногу. */
function delayed(seconds: number, style: CSSProperties = {}): CSSProperties {
  return { ...style, animationDelay: `${seconds}s` };
}

export function EnemyScene(props: {
  pattern: EnemyPattern;
  elite: boolean;
  label: string;
  /** на кого распадается делящийся — мелочь в сцене его формы и цвета */
  child?: EnemyPattern;
}): ReactNode {
  const look = ENEMY_LOOKS[props.pattern];
  const color = enemyColor(props.pattern, props.elite);
  const size = props.elite ? 11 : 7;
  const px = 118;
  const py = 48;
  const enemy = <WorldShape shape={look.shape} color={color} r={size} />;

  switch (props.pattern) {
    case "swarm":
      return (
        <Stage label={props.label}>
          <Player x={px} y={py} />
          {[
            [100, 40, -80, -20, 0],
            [102, 56, -86, 14, 0.4],
            [96, 48, -70, 2, 0.8],
            [106, 34, -60, -26, 1.2],
          ].map(([x, y, dx, dy, delay]) => (
            <At key={`${x}-${y}`} x={x} y={y} className="animate-guide-approach" style={delayed(delay, offset(dx, dy))}>
              <WorldShape shape={look.shape} color={color} r={size * 0.8} />
            </At>
          ))}
        </Stage>
      );
    case "chase":
      return (
        <Stage label={props.label}>
          <Player x={px} y={py} />
          <At x={96} y={py} className="animate-guide-approach" style={offset(-66, 26)}>
            {enemy}
          </At>
        </Stage>
      );
    case "kite_and_shoot":
      return (
        <Stage label={props.label}>
          <Player x={px} y={py} />
          <At x={40} y={40}>{enemy}</At>
          {/* Прицел заполняется к игроку — заполнился, снаряд вылетел. */}
          <line x1={48} y1={42} x2={px} y2={py} stroke={hex(WORLD_COLORS.enemyProjectile)} strokeOpacity={0.18} strokeWidth={1.5} />
          <line
            x1={48}
            y1={42}
            x2={px}
            y2={py}
            stroke={hex(WORLD_COLORS.enemyProjectile)}
            strokeWidth={1.5}
            className={`animate-guide-aim [transform-box:fill-box] origin-left ${MOTION}`}
          />
          <At x={48} y={42} className="animate-guide-shot-late" style={offset(64, 5)}>
            <circle r={3} fill={hex(WORLD_COLORS.enemyProjectile)} />
          </At>
          {/* Пунктир — дистанция, которую стрелок держит. */}
          <line x1={52} y1={py + 18} x2={px - 8} y2={py + 18} stroke={hex(color)} strokeOpacity={0.35} strokeDasharray="3 3" />
        </Stage>
      );
    case "dash":
      return (
        <Stage label={props.label}>
          <Player x={px} y={py} />
          {/* Полоса рывка заполняется от волка: дошла до конца — сорвался. */}
          <rect x={34} y={py - 5} width={70} height={10} rx={5} fill={hex(WORLD_COLORS.dashLane)} fillOpacity={0.14} />
          <rect
            x={34}
            y={py - 5}
            width={70}
            height={10}
            rx={5}
            fill={hex(WORLD_COLORS.dashLane)}
            fillOpacity={0.55}
            className={`animate-guide-fill [transform-box:fill-box] origin-left ${MOTION}`}
          />
          <At x={34} y={py} className="animate-guide-lunge" style={offset(66, 0)}>
            {enemy}
          </At>
        </Stage>
      );
    case "orbit":
      return (
        <Stage label={props.label}>
          <circle cx={80} cy={py} r={34} fill="none" stroke={hex(color)} strokeOpacity={0.25} strokeDasharray="4 4" />
          <Player x={80} y={py} />
          <At x={80} y={py} className="animate-guide-spin">
            <g transform="translate(34 0)">{enemy}</g>
            <g transform="translate(-34 0)">
              <WorldShape shape={look.shape} color={color} r={size * 0.8} />
            </g>
          </At>
        </Stage>
      );
    case "exploder":
      return (
        <Stage label={props.label}>
          <Player x={px} y={py} />
          {/* Кольцо взрыва сразу, внутри растёт второе: сомкнулись — взрыв. */}
          <At x={96} y={py} className="animate-guide-fuse-ring">
            <circle r={30} fill="none" stroke={hex(WORLD_COLORS.threat)} strokeOpacity={0.5} strokeWidth={1.5} />
          </At>
          <At x={96} y={py} className="animate-guide-fuse-grow">
            <circle r={30} fill={hex(WORLD_COLORS.threat)} fillOpacity={0.2} stroke={hex(WORLD_COLORS.threat)} strokeWidth={2} />
          </At>
          <At x={96} y={py} className="animate-guide-fuse" style={offset(-70, -10)}>
            {enemy}
          </At>
          <At x={96} y={py} className="animate-guide-blast">
            <circle r={30} fill={hex(WORLD_COLORS.blast)} fillOpacity={0.15} stroke={hex(WORLD_COLORS.blast)} strokeWidth={3} />
          </At>
        </Stage>
      );
    case "splitter":
      return (
        <Stage label={props.label}>
          <Player x={px + 14} y={py} />
          {/* Снаряд, который добивает делящегося. */}
          <At x={px + 6} y={py} className="animate-guide-shot" style={offset(-56, 0)}>
            <circle r={2.5} fill={hex(WORLD_COLORS.projectile)} />
          </At>
          <At x={58} y={py} className="animate-guide-split">
            <WorldShape shape={look.shape} color={color} r={size + 3} />
          </At>
          {[
            [-24, -20],
            [-28, 18],
            [18, -24],
          ].map(([dx, dy]) => (
            <At key={`${dx}-${dy}`} x={58} y={py} className="animate-guide-scatter" style={offset(dx, dy)}>
              <WorldShape shape={ENEMY_LOOKS[props.child ?? "swarm"].shape} color={ENEMY_LOOKS[props.child ?? "swarm"].color} r={5} />
            </At>
          ))}
        </Stage>
      );
    default:
      return (
        <Stage label={props.label}>
          <Player x={px} y={py} />
          <At x={50} y={py}>{enemy}</At>
        </Stage>
      );
  }
}

export function WeaponScene(props: { behavior: WeaponBehavior; label: string }): ReactNode {
  const px = 44;
  const py = 48;
  const target = ENEMY_LOOKS.swarm;
  const foe = (x: number, y: number): ReactNode => (
    <g transform={`translate(${x} ${y})`}>
      <WorldShape shape={target.shape} color={target.color} r={6} />
    </g>
  );
  const shot = hex(WORLD_COLORS.projectile);

  switch (props.behavior) {
    case "projectile_nearest":
      return (
        <Stage label={props.label}>
          <Player x={px} y={py} />
          {foe(112, 30)}
          {foe(136, 70)}
          <At x={px} y={py} className="animate-guide-shot" style={offset(66, -17)}>
            <circle r={3} fill={shot} />
          </At>
          <At x={px} y={py} className="animate-guide-shot" style={delayed(0.6, offset(66, -17))}>
            <circle r={3} fill={shot} />
          </At>
        </Stage>
      );
    case "projectile_facing":
      return (
        <Stage label={props.label}>
          {/* Стрелка — куда бежит персонаж: туда и летит веер. */}
          <path d={`M ${px - 26} ${py} L ${px - 12} ${py}`} stroke={hex(WORLD_COLORS.player)} strokeOpacity={0.5} strokeWidth={2} strokeDasharray="3 3" />
          <Player x={px} y={py} />
          {foe(128, 36)}
          {foe(132, 62)}
          {[-18, 0, 18].map((dy) => (
            <At key={dy} x={px + 8} y={py} className="animate-guide-shot" style={offset(96, dy)}>
              <rect x={-4} y={-1.5} width={8} height={3} rx={1.5} fill={shot} />
            </At>
          ))}
        </Stage>
      );
    case "orbit":
      return (
        <Stage label={props.label}>
          <circle cx={80} cy={py} r={28} fill="none" stroke={hex(WORLD_COLORS.orbiter)} strokeOpacity={0.2} />
          <Player x={80} y={py} />
          {foe(116, 30)}
          {foe(44, 70)}
          <At x={80} y={py} className="animate-guide-spin">
            {[
              [28, 0],
              [-28, 0],
            ].map(([x, y]) => (
              <circle key={x} cx={x} cy={y} r={5} fill={hex(WORLD_COLORS.orbiter)} />
            ))}
          </At>
        </Stage>
      );
    case "aura":
      return (
        <Stage label={props.label}>
          <At x={80} y={py} className="animate-guide-pulse">
            <circle r={34} fill={hex(WORLD_COLORS.blast)} fillOpacity={0.35} stroke={hex(WORLD_COLORS.blast)} strokeWidth={2} />
          </At>
          <Player x={80} y={py} />
          {foe(106, 36)}
          {foe(58, 64)}
          {foe(140, 20)}
        </Stage>
      );
    case "area_strike":
      return (
        <Stage label={props.label}>
          <Player x={px} y={py} />
          {foe(118, 34)}
          {foe(130, 46)}
          {foe(110, 52)}
          <At x={120} y={44} className="animate-guide-strike">
            <circle r={24} fill={hex(WORLD_COLORS.strike)} fillOpacity={0.2} stroke={hex(WORLD_COLORS.strike)} strokeWidth={3} />
          </At>
        </Stage>
      );
    default:
      return (
        <Stage label={props.label}>
          <Player x={px} y={py} />
        </Stage>
      );
  }
}

/** Подбор или кристалл отдельным значком: для списков, без сцены. */
export function PickupIcon(props: { id: "medkit" | "magnet" | "dynamite"; size?: number }): ReactNode {
  const look = PICKUP_LOOKS.find((entry) => entry.id === props.id) ?? PICKUP_LOOKS[0];
  const size = props.size ?? 40;
  return (
    <svg viewBox="-12 -12 24 24" width={size} height={size} aria-hidden="true" className="shrink-0">
      <WorldShape shape={look.shape} color={look.color} r={10} />
    </svg>
  );
}

/** Ступени кристаллов по возрастанию ценности, с порогом опыта под каждой. */
export function GemRow(props: { caption: (minValue: number) => string }): ReactNode {
  // Самый крупный кристалл задаёт общий масштаб: ступени видно в сравнении.
  const largest = Math.max(...GEM_TIERS.map((tier) => tier.radiusUnits));
  return (
    <ul className="flex items-end justify-around gap-2">
      {GEM_TIERS.map((tier) => (
        <li key={tier.minValue} className="flex flex-col items-center gap-1">
          <svg viewBox={`${-largest} ${-largest} ${largest * 2} ${largest * 2}`} className="size-9" aria-hidden="true">
            <WorldShape shape={tier.shape} color={tier.color} r={tier.radiusUnits} />
          </svg>
          <span className="font-display text-xs tabular-nums text-text-muted">{props.caption(tier.minValue)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Значок врага без сцены — для строки списка и элит. */
export function EnemyIcon(props: { pattern: EnemyPattern; elite: boolean; size?: number }): ReactNode {
  const size = props.size ?? 40;
  const look = ENEMY_LOOKS[props.pattern];
  return (
    <svg viewBox="-12 -12 24 24" width={size} height={size} aria-hidden="true" className="shrink-0">
      <WorldShape shape={look.shape} color={enemyColor(props.pattern, props.elite)} r={9} />
    </svg>
  );
}
