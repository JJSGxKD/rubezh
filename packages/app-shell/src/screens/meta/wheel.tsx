import { useRef, useState, type ReactNode, type TransitionEvent } from "react";
import { LoaderPinwheel, Tv } from "lucide-react";
import {
  Button,
  ContentColumn,
  ListGroup,
  ListItem,
  Screen,
  SectionTitle,
  StubNotice,
} from "../../design-system/components";
import { formatDecimal, t } from "../../i18n";
import { useNavigation } from "../../state/navigation";
import { useSettings } from "../../state/settings";
import { useShell } from "../../state/shell";
import { RewardIcon, rewardAmount, rewardLabel, rewardTextTone } from "./reward";
import { WHEEL_SECTORS } from "./stub-content";
import { pickSector, sectorCenterDeg, sectorOdds, spinRotationDeg } from "./wheel-math";

/**
 * Колесо удачи (docs/07-monetization-and-ads.md §7): одна бесплатная крутка в
 * день и одна за рекламу, за валюту — никогда.
 *
 * Заглушка с демо-круткой: колесо крутится по-настоящему, но результат
 * выбирает клиент и награда не начисляется. В рабочей версии сектор выберет
 * сервер, а колесо только докрутит до него — поэтому выбор и поворот разделены
 * (`wheel-math.ts`). Шансы показаны на том же экране: игрок видит, на что
 * крутит.
 */
const WEIGHTS = WHEEL_SECTORS.map((sector) => sector.weight);
const ODDS = sectorOdds(WEIGHTS);
/** Полных оборотов за крутку, помимо докрутки до сектора. */
const SPIN_TURNS = 5;

export function WheelScreen(): ReactNode {
  const navigation = useNavigation();
  const haptics = useSettings((state) => state.haptics);
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<number | null>(null);
  const pending = useRef(0);

  const spin = (): void => {
    if (spinning) return;
    // Демо: в рабочей версии индекс придёт с сервера.
    const index = pickSector(WEIGHTS, Math.random());
    pending.current = index;
    setResult(null);
    setSpinning(true);
    setRotation((current) => spinRotationDeg(current, index, WHEEL_SECTORS.length, SPIN_TURNS));
  };

  const onSpinEnd = (event: TransitionEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || event.propertyName !== "transform") return;
    setSpinning(false);
    setResult(pending.current);
    if (haptics) useShell.getState().adapter.haptic("medium");
  };

  const won = result === null ? undefined : WHEEL_SECTORS[result];

  return (
    <Screen
      title={t("wheel.title")}
      onBack={() => navigation.pop()}
      footer={
        <div className="grid gap-2">
          <Button size="l" block glow={!spinning} disabled={spinning} onClick={spin}>
            {t("wheel.spin.free")}
          </Button>
          <Button variant="secondary" block disabled>
            <Tv size={18} aria-hidden="true" />
            {t("wheel.spin.ad")}
          </Button>
        </div>
      }
    >
      <ContentColumn>
        <p className="mt-2 mb-3 text-center text-sm text-text-muted">{t("wheel.text")}</p>
        <StubNotice text={t("wheel.stub")} />

        <div className="relative mx-auto mt-6 aspect-square w-full max-w-[300px] landscape:max-w-[220px]">
          {/* Круглая маска вокруг вращения: повёрнутый квадрат колеса по
              диагонали шире себя, и без маски после крутки у экрана
              появлялась горизонтальная прокрутка. */}
          <div className="absolute inset-0 overflow-hidden rounded-full">
            <div
              onTransitionEnd={onSpinEnd}
              className="size-full transition-transform duration-(--duration-spin) ease-spin"
              style={{ transform: `rotate(${rotation}deg)` }}
            >
              <WheelFace />
            </div>
          </div>
          {/* Стрелка и ступица не вращаются: стрелка — точка отсчёта. */}
          <span
            aria-hidden="true"
            className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/3 text-accent"
          >
            <svg viewBox="0 0 24 30" className="h-8 w-7 fill-current">
              <path d="M2 2h20L12 28z" />
            </svg>
          </span>
          <span
            aria-hidden="true"
            className="surface-card absolute top-1/2 left-1/2 inline-flex size-14 -translate-1/2 items-center justify-center rounded-full text-accent"
          >
            <LoaderPinwheel size={26} />
          </span>
        </div>

        <div role="status" className="mt-4 min-h-14 text-center">
          {won === undefined ? null : (
            <div className="animate-pop-in">
              <p className="font-display text-lg font-bold text-text">
                {t("wheel.result", { reward: rewardLabel(won.reward) })}
              </p>
              <p className="text-xs text-text-muted">{t("wheel.demo")}</p>
            </div>
          )}
        </div>

        <SectionTitle>{t("wheel.odds")}</SectionTitle>
        <ListGroup>
          {WHEEL_SECTORS.map((sector, index) => ({ sector, odds: ODDS[index] ?? 0 }))
            .sort((left, right) => right.odds - left.odds)
            .map(({ sector, odds }) => (
              <ListItem
                key={`${sector.reward.kind}-${sector.reward.amount}`}
                icon={<RewardIcon kind={sector.reward.kind} />}
                title={rewardLabel(sector.reward)}
                value={t("wheel.percent", { value: formatDecimal(odds, 1) })}
              />
            ))}
        </ListGroup>
      </ContentColumn>
    </Screen>
  );
}

/** Радиус секторов в единицах viewBox; обод и огни — снаружи него. */
const R = 108;
const RIM_LIGHTS = 16;

/** Лицо колеса: сектора, значки наград и обод. Геометрия — в единицах viewBox. */
function WheelFace(): ReactNode {
  const count = WHEEL_SECTORS.length;

  return (
    <svg viewBox="-120 -120 240 240" className="size-full" aria-hidden="true">
      <circle r={118} className="fill-current text-surface-sunken" />
      {WHEEL_SECTORS.map((sector, index) => (
        <path
          key={index}
          d={sectorPath(index, count)}
          className={`fill-current ${index % 2 === 0 ? "text-surface-raised" : "text-surface"}`}
        />
      ))}
      {/* Цветная дуга у обода — вид награды читается издалека, пока колесо крутится. */}
      {WHEEL_SECTORS.map((sector, index) => (
        <path
          key={index}
          d={arcPath(index, count, R - 4)}
          fill="none"
          strokeWidth={6}
          strokeOpacity={0.7}
          className={`stroke-current ${rewardTextTone(sector.reward.kind)}`}
        />
      ))}
      {WHEEL_SECTORS.map((_, index) => {
        const [x, y] = polar(R, (index * 360) / count);
        return (
          <line
            key={index}
            x2={x}
            y2={y}
            strokeWidth={1.5}
            className="stroke-current text-border-strong"
          />
        );
      })}
      {WHEEL_SECTORS.map((sector, index) => (
        <g key={index} transform={`rotate(${sectorCenterDeg(index, count)})`}>
          <svg
            x={-12}
            y={-R + 16}
            width={24}
            height={24}
            overflow="visible"
            className={rewardTextTone(sector.reward.kind)}
          >
            <RewardIcon kind={sector.reward.kind} size={24} />
          </svg>
          <text
            y={-R + 58}
            textAnchor="middle"
            className="fill-current font-display text-sm font-bold text-text"
          >
            {rewardAmount(sector.reward)}
          </text>
        </g>
      ))}
      <circle r={R + 5} fill="none" strokeWidth={6} className="stroke-current text-border-strong" />
      {Array.from({ length: RIM_LIGHTS }, (_, index) => {
        const [x, y] = polar(R + 5, (index * 360) / RIM_LIGHTS);
        return (
          <circle
            key={index}
            cx={x}
            cy={y}
            r={2.2}
            className={`fill-current ${index % 2 === 0 ? "text-accent" : "text-accent-glow"}`}
          />
        );
      })}
    </svg>
  );
}

/** Точка на окружности: угол от верха по часовой стрелке, ось y вниз, как в SVG. */
function polar(radius: number, deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [radius * Math.sin(rad), -radius * Math.cos(rad)];
}

function sectorPath(index: number, count: number): string {
  return `M0 0L${arcPath(index, count, R).slice(1)}Z`;
}

function arcPath(index: number, count: number, radius: number): string {
  const [x1, y1] = polar(radius, (index * 360) / count);
  const [x2, y2] = polar(radius, ((index + 1) * 360) / count);
  return `M${x1} ${y1}A${radius} ${radius} 0 0 1 ${x2} ${y2}`;
}
