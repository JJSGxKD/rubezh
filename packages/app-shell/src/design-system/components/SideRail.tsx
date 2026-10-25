import { useRef, type ReactNode, type RefObject } from "react";
import { Bell, Plus } from "lucide-react";
import { t } from "../../i18n";
import { trackGroupClick } from "../../state/ui-clicks";
import { uiFeedback } from "../../state/ui-feedback";
import { Wordmark } from "./Brand";
import { Avatar, ProgressBar } from "./Data";
import { CoinIcon, GemIcon } from "./CurrencyIcons";
import type { TabItem } from "./Layout";

/**
 * Боковое меню для ПК (с 1024 px, tasks/T-0298, docs/27-design-system-and-app-shell.md
 * §5.3): знак игры, карточка игрока, те же разделы, что у нижней панели, и
 * внизу настройки с помощью. Само ничего не знает о сторах — данные игрока и
 * действия приходят снаружи, поэтому меню проверяется как обычная разметка.
 *
 * Отступы от выреза и кнопок площадки — `--app-inset-*`, ширина — токен
 * `--rail-width`. Анимируется только `transform`/`opacity` (§3.3).
 */
export interface RailPlayer {
  name: string;
  avatarUrl?: string | null | undefined;
  /** `null` — уровень ещё не пришёл */
  level: number | null;
  /** доля опыта текущего уровня, от 0 до 1 */
  xpShare: number;
}

export interface RailAction {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect(): void;
}

export interface SideRailProps {
  items: readonly TabItem[];
  activeId: string | null;
  /** имя группы для события `ui_clicked`: нажатие пункта — `<track>.<id пункта>` (Р141) */
  track: string;
  player: RailPlayer;
  onSelect(id: string): void;
  onProfile(): void;
  /** настройки и помощь — внизу, отдельно от разделов */
  bottom: readonly RailAction[];
}

export function SideRail(props: SideRailProps): ReactNode {
  const { player } = props;
  return (
    <nav
      aria-label={t("rail.label")}
      className="relative z-(--z-header) flex w-(--rail-width) shrink-0 flex-col gap-1.5 border-r border-border bg-surface/80 pt-[calc(1.25rem+var(--app-inset-top))] pr-4 pb-[calc(1rem+var(--app-inset-bottom))] pl-[calc(1rem+var(--app-inset-left))]"
    >
      <div className="mb-4 pl-1.5">
        <Wordmark />
      </div>

      <button
        type="button"
        aria-label={t("header.profile", { name: player.name })}
        onClick={() => {
          uiFeedback("tap");
          props.onProfile();
        }}
        className="surface-card mb-3 flex w-full items-center gap-2.5 rounded-lg p-2.5 text-left transition-transform duration-(--duration-fast) ease-base active:scale-[0.98]"
      >
        <Avatar name={player.name} url={player.avatarUrl} size={40} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-sm font-bold text-text">{player.name}</span>
          {player.level === null ? null : (
            <span className="mt-0.5 mb-1.5 block text-xs text-text-muted">{t("profile.level", { level: player.level })}</span>
          )}
          <ProgressBar value={player.xpShare * 100} max={100} tone="xp" height="thin" label={t("rail.xp")} />
        </span>
      </button>

      {props.items.map((item) => {
        const active = item.id === props.activeId;
        return (
          <button
            key={item.id}
            type="button"
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (!active) uiFeedback("select");
              trackGroupClick(props.track, item.id);
              props.onSelect(item.id);
            }}
            className={[
              "relative flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left font-display text-[15px] font-semibold",
              "transition-colors duration-(--duration-fast) ease-base",
              active ? "bg-accent/15 text-text shadow-[inset_3px_0_0_var(--color-accent)]" : "text-text-muted hover:text-text",
            ].join(" ")}
          >
            <span aria-hidden="true" className={active ? "text-accent" : ""}>
              {item.icon}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.badge === undefined ? null : (
              <span className="min-w-5 rounded-pill bg-danger px-1.5 text-center font-display text-xs font-bold text-text">{item.badge}</span>
            )}
          </button>
        );
      })}

      <div className="mt-auto grid gap-0.5">
        {props.bottom.map((action) => (
          <button
            key={action.id}
            type="button"
            onClick={() => {
              uiFeedback("tap");
              trackGroupClick(props.track, action.id);
              action.onSelect();
            }}
            className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left font-text text-sm text-text-muted transition-colors duration-(--duration-fast) ease-base hover:text-text"
          >
            <span aria-hidden="true">{action.icon}</span>
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

export interface WideHeaderProps {
  /** название раздела крупно слева */
  title: string;
  /**
   * Число на плашке кошелька рисует вызывающий (набегающий счёт): плашка
   * отдаёт ему значок, который подпрыгивает, когда счёт начался.
   */
  coins(bump: RefObject<HTMLElement | null>): ReactNode;
  gems(bump: RefObject<HTMLElement | null>): ReactNode;
  coinsLabel: string;
  gemsLabel: string;
  onCoins(): void;
  onGems(): void;
  /** `null` — колокольчика нет (сборка без входа) */
  bell: { unread: number; label: string; onOpen(): void } | null;
  /** без связи числа на плашках — последние известные */
  offline?: boolean;
}

/**
 * Шапка раздела на wide: название слева, кошелёк и колокольчик справа. Лежит в
 * потоке, а не поверх прокрутки: на широком экране содержимое под стеклом
 * уходить некуда.
 */
export function WideHeader(props: WideHeaderProps): ReactNode {
  return (
    <header className="shrink-0 pt-[calc(1.25rem+var(--app-inset-top))] pr-[calc(1.75rem+var(--app-inset-right))] pb-4 pl-7">
      <div className="mx-auto flex w-full max-w-(--wide-column) items-center justify-between gap-4">
        <h1 className="min-w-0 truncate font-display text-3xl font-bold text-text">{props.title}</h1>
        <div className={`flex shrink-0 items-center gap-2.5 transition-opacity duration-(--duration-base) ease-base ${props.offline === true ? "opacity-60" : ""}`}>
          <WalletPill label={props.coinsLabel} icon={<CoinIcon size={22} />} onClick={props.onCoins} value={props.coins} />
          <WalletPill label={props.gemsLabel} icon={<GemIcon size={22} />} onClick={props.onGems} value={props.gems} buy />
          {props.bell === null ? null : (
            <button
              type="button"
              aria-label={props.bell.label}
              onClick={() => {
                uiFeedback("tap");
                props.bell?.onOpen();
              }}
              className="btn-secondary relative inline-flex size-11 items-center justify-center rounded-md transition-transform duration-(--duration-fast) ease-base active:scale-90"
            >
              <Bell size={22} />
              {props.bell.unread > 0 ? (
                <span className="absolute -top-1 -right-1 inline-flex min-w-5 items-center justify-center rounded-pill bg-accent px-1 font-display text-xs font-bold tabular-nums text-on-accent">
                  {props.bell.unread > 99 ? "99+" : props.bell.unread}
                </span>
              ) : null}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

/** Плашка валюты — одна кнопка на всю плашку, как в шапке телефона (цель нажатия — 44 px). */
function WalletPill(props: {
  label: string;
  icon: ReactNode;
  onClick(): void;
  value(bump: RefObject<HTMLElement | null>): ReactNode;
  buy?: boolean;
}): ReactNode {
  const icon = useRef<HTMLSpanElement>(null);
  return (
    <button type="button" aria-label={props.label} onClick={props.onClick} className="group inline-flex min-h-11 shrink-0 items-center">
      <span
        className={`surface-sunken inline-flex h-9 items-center gap-1.5 rounded-pill pl-1.5 transition-transform duration-(--duration-fast) ease-base group-active:scale-95 ${props.buy === true ? "pr-1.5" : "pr-3.5"}`}
      >
        <span ref={icon} className="inline-flex size-6 items-center justify-center">
          {props.icon}
        </span>
        <span className="min-w-6 font-display text-[15px] font-bold whitespace-nowrap tabular-nums text-text">{props.value(icon)}</span>
        {props.buy === true ? (
          <span className="inline-flex size-5.5 items-center justify-center rounded-full bg-accent text-on-accent">
            <Plus size={14} strokeWidth={3} />
          </span>
        ) : null}
      </span>
    </button>
  );
}
