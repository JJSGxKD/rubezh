import { useState, type ReactNode } from "react";
import { BadgePercent, CalendarDays, Crown, Gift, Megaphone, Newspaper, Rocket, Sparkles, Target, Trophy, UserPlus } from "lucide-react";
// Компонент из общего входа дизайн-системы держит ядро значков в общем чанке
// первой загрузки: без него сборщик выносит ядро в отдельный файл
// (docs/27-design-system-and-app-shell.md §3.4).
import { Badge } from "../design-system/components";
import { CoinIcon, GemIcon } from "../design-system/components/CurrencyIcons";
import { formatNumber, t } from "../i18n";
import "../i18n/home";
import type { HomeSlide } from "../state/home-api";
import { formatCountdown } from "./meta/schedule";

/**
 * Слайд карусели главной (docs/35-stage4-plan.md WP42) — только вид: что
 * нарисовать и что сказать диктору. Куда ведёт касание и что уходит в
 * аналитику, решает карусель; предпросмотр в панели рисует этот же слайд
 * без сети и навигации (Р83).
 */

const TONE: Record<HomeSlide["kind"], string> = {
  promo: "bg-danger/15 text-danger",
  changelog: "bg-info/15 text-info",
  vip: "bg-elite/15 text-elite",
  starter: "bg-success/15 text-success",
  invite: "bg-accent/15 text-accent",
  channel: "bg-info/15 text-info",
  task: "bg-passive/15 text-passive",
  team: "bg-accent/15 text-accent",
};

/**
 * Слайд команды — тоном своего значка: турнир золотом элиты, подарок цветом
 * награды, событие — информации, новинка — пассивок; объявление — фирменным.
 */
const TEAM_TONE: Record<string, string> = {
  trophy: "bg-elite/15 text-elite",
  gift: "bg-success/15 text-success",
  calendar: "bg-info/15 text-info",
  sparkles: "bg-passive/15 text-passive",
};

function toneOf(slide: HomeSlide): string {
  return slide.kind === "team" ? (TEAM_TONE[slide.icon] ?? TONE.team) : TONE[slide.kind];
}

function TeamIcon(props: { icon: string }): ReactNode {
  switch (props.icon) {
    case "trophy":
      return <Trophy size={30} />;
    case "gift":
      return <Gift size={30} />;
    case "calendar":
      return <CalendarDays size={30} />;
    case "sparkles":
      return <Sparkles size={30} />;
    default:
      return <Megaphone size={30} />;
  }
}

function SlideIcon(props: { slide: HomeSlide }): ReactNode {
  switch (props.slide.kind) {
    case "promo":
      return <BadgePercent size={30} />;
    case "changelog":
      return <Newspaper size={30} />;
    case "vip":
      return <Crown size={30} />;
    case "starter":
      return <Rocket size={30} />;
    case "invite":
      return <UserPlus size={30} />;
    case "channel":
      return <Megaphone size={30} />;
    case "task":
      return <Target size={30} />;
    case "team":
      return <TeamIcon icon={props.slide.icon} />;
  }
}

/**
 * Слайд целиком — кнопка: касание по всему слайду. Картинка не загрузилась —
 * значок вида; запоминается сам адрес, и новая картинка пробуется заново.
 */
export function SlideView(props: { slide: HomeSlide; now: number; image: string | null; wide: boolean; onOpen: () => void }): ReactNode {
  const { slide } = props;
  const [failed, setFailed] = useState<string | null>(null);
  const image = props.image === failed ? null : props.image;

  return (
    <button
      type="button"
      aria-label={slideLabel(slide, props.now)}
      onClick={props.onOpen}
      className={[
        "surface-card flex h-20 shrink-0 snap-start items-center gap-3 rounded-lg px-3 text-left",
        "transition-transform duration-(--duration-fast) ease-base active:scale-[0.98]",
        props.wide ? "w-full" : "w-[88%]",
      ].join(" ")}
    >
      {image === null ? (
        <span className={`inline-flex size-14 shrink-0 items-center justify-center rounded-md ${toneOf(slide)}`}>
          <SlideIcon slide={slide} />
        </span>
      ) : (
        <img src={image} alt="" width={56} height={56} decoding="async" onError={() => setFailed(image)} className="size-14 shrink-0 rounded-md bg-surface-sunken object-cover" />
      )}
      <span aria-hidden="true" className="min-w-0 flex-1">
        <span className="block truncate font-display text-sm font-bold text-text">{titleOf(slide)}</span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
          <SlideChip slide={slide} now={props.now} />
          <span className="truncate">{textOf(slide, props.now)}</span>
        </span>
      </span>
    </button>
  );
}

/** Слайд словами для экранного диктора: заголовок, скидка или награда, подпись. */
export function slideLabel(slide: HomeSlide, now: number): string {
  return [titleOf(slide), chipLabel(slide, now), textOf(slide, now)].filter((part) => part !== null).join(". ");
}

/**
 * Перед подписью — то, ради чего стоит нажать: скидка акции или награда
 * задания. Цены здесь нет: на главной цепляет выгода, цену игрок увидит в
 * магазине.
 */
function SlideChip(props: { slide: HomeSlide; now: number }): ReactNode {
  const { slide } = props;
  if (slide.kind === "promo" && Date.parse(slide.endsAt) > props.now) {
    return (
      <span className="shrink-0 tabular-nums">
        <Badge tone="danger">{t("home.slide.promo.discount", { percent: slide.percent })}</Badge>
      </span>
    );
  }
  if (slide.kind === "task" && taskPrize(slide) !== null) {
    const gems = slide.reward.gems > 0;
    return (
      <span className="inline-flex shrink-0 items-center gap-1 font-display font-bold text-text tabular-nums">
        {gems ? <GemIcon size={14} /> : <CoinIcon size={14} />}+{formatNumber(gems ? slide.reward.gems : slide.reward.coins)}
      </span>
    );
  }
  return null;
}

/** Награда задания, которую стоит показать числом: самоцветы важнее монет; одни осколки — словами. */
function taskPrize(slide: Extract<HomeSlide, { kind: "task" }>): number | null {
  if (slide.reward.gems > 0) return slide.reward.gems;
  return slide.reward.coins > 0 ? slide.reward.coins : null;
}

/** То же, что значок перед подписью, — словами для экранного диктора. */
function chipLabel(slide: HomeSlide, now: number): string | null {
  if (slide.kind === "promo") return Date.parse(slide.endsAt) > now ? t("home.slide.promo.discountLabel", { percent: slide.percent }) : null;
  if (slide.kind !== "task") return null;
  const prize = taskPrize(slide);
  if (prize === null) return null;
  return t(slide.reward.gems > 0 ? "home.slide.gems" : "home.slide.coins", { n: prize });
}

export function titleOf(slide: HomeSlide): string {
  if (slide.kind === "promo") return slide.title ?? t("home.slide.promo.title");
  if (slide.kind === "task") return slide.title ?? t("home.slide.task.title");
  if (slide.kind === "team") return slide.title;
  return t(`home.slide.${slide.kind}.title`);
}

/** Подпись слайда; у акции — сколько ей осталось: скидка стоит плашкой перед подписью. */
export function textOf(slide: HomeSlide, now = Date.now()): string {
  switch (slide.kind) {
    case "promo": {
      const left = Date.parse(slide.endsAt) - now;
      return left > 0 ? t("home.slide.promo.text", { time: formatCountdown(left) }) : t("home.slide.promo.over");
    }
    case "changelog":
      return t("home.slide.changelog.text", { versions: slide.versions });
    case "task":
      return t(taskPrize(slide) === null ? "home.slide.task.text" : "home.slide.task.prize");
    case "team":
      return slide.text;
    default:
      return t(`home.slide.${slide.kind}.text`);
  }
}
