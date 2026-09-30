import type { ReactNode } from "react";
import { Bell, Menu, Plus } from "lucide-react";
import { Avatar } from "../design-system/components";
import { CoinIcon, GemIcon } from "../design-system/components/CurrencyIcons";
import { formatCompact, formatNumber, t } from "../i18n";
import { useNavigation, type ScreenId } from "../state/navigation";
import { badgeText, useBadges } from "../state/badges";
import { useProgress } from "../state/progress";
import { uiFeedback } from "../state/ui-feedback";
import { useShell } from "../state/shell";
import { useWallet } from "../state/wallet";

/**
 * Шапка разделов нижней панели (docs/27-design-system-and-app-shell.md §6,
 * docs/35-stage4-plan.md Р60, WP30): аватар — в профиль, валюты,
 * колокольчик, меню. Лежит поверх прокрутки стеклом: содержимое уходит под
 * размытие, а не обрезается краем.
 *
 * Шапка обязана уместиться в 320 px при любых балансах:
 * - имени нет — оно в профиле и в меню;
 * - валюты от десяти тысяч — короткой записью, полное число — в подписи для
 *   экранного чтения и в истории;
 * - колокольчик — только когда строке хватает места (контейнерный запрос по
 *   ширине строки, а не экрана: поля и вырез камеры тоже её съедают). Где его
 *   нет, уведомления — пунктом меню, а число непрочитанного — знаком на
 *   кнопке меню. Меню — на виду всегда: это главная кнопка.
 *
 * Монеты не продаются (Р2), поэтому у них нет «плюса» и они ведут в историю
 * имущества; самоцветы с «плюсом» ведут в магазин.
 *
 * Имя и аватар — из параметров запуска площадки и только для отображения:
 * это не проверенная личность (docs/08-web-and-identity.md §4).
 */
export function AppHeader(props: { onMenu(): void }): ReactNode {
  const user = useShell((state) => state.adapter.displayUser);
  const name = user?.displayName ?? t("profile.guest");
  const balances = useWallet((state) => state.balances);
  const unread = useBadges((state) => state.notifications);
  const withAccount = useShell((state) => state.capabilities.auth !== undefined);

  return (
    <header className="surface-glass absolute inset-x-0 top-0 z-(--z-header) pt-[calc(0.5rem+var(--app-inset-top))] pr-[calc(0.75rem+var(--app-inset-right))] pb-2 pl-[calc(0.75rem+var(--app-inset-left))]">
      <div className="@container mx-auto flex w-full max-w-[640px] items-center gap-1.5">
        <button
          type="button"
          aria-label={t("header.profile", { name })}
          onClick={() => {
            uiFeedback("tap");
            useNavigation.getState().push("profile");
          }}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-transform duration-(--duration-fast) ease-base active:scale-95"
        >
          <LevelAvatar name={name} url={user?.avatarUrl} />
        </button>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          <CurrencyButton icon={<CoinIcon size={20} />} label={t("currency.coins")} value={balances?.coins ?? 0} target="history" />
          <CurrencyButton icon={<GemIcon size={20} />} label={t("currency.premium")} value={balances?.gems ?? 0} target="shop" buy />
        </div>

        {/* Лента — только с входом: без аккаунта уведомлениям неоткуда взяться.
            Число — только когда есть новое (Р50): знаков «для внимания» нет. */}
        {withAccount ? (
          <button
            type="button"
            aria-label={unread > 0 ? t("notifications.bell.unread", { count: unread }) : t("notifications.bell")}
            onClick={() => {
              uiFeedback("tap");
              useNavigation.getState().push("notifications");
            }}
            className="btn-secondary relative hidden size-11 shrink-0 items-center justify-center rounded-md transition-transform duration-(--duration-fast) ease-base active:scale-90 @min-[21.5rem]:inline-flex"
          >
            <Bell size={22} />
            <CountBadge count={unread} />
          </button>
        ) : null}

        <button
          type="button"
          aria-label={withAccount && unread > 0 ? t("menu.title.unread", { count: unread }) : t("menu.title")}
          onClick={() => {
            uiFeedback("tap");
            props.onMenu();
          }}
          className="btn-secondary relative inline-flex size-11 shrink-0 items-center justify-center rounded-md transition-transform duration-(--duration-fast) ease-base active:scale-90"
        >
          <Menu size={22} />
          {/* Знак на меню — только там, где колокольчика в шапке нет: одно и то
              же число в двух местах читалось бы как два разных. */}
          {withAccount ? <CountBadge count={unread} className="@min-[21.5rem]:hidden" /> : null}
        </button>
      </div>
    </header>
  );
}

function CountBadge(props: { count: number; className?: string }): ReactNode {
  const text = badgeText(props.count);
  if (text === undefined) return null;
  return (
    <span
      className={`absolute -top-1 -right-1 inline-flex min-w-5 items-center justify-center rounded-pill bg-accent px-1 font-display text-xs font-bold tabular-nums text-on-accent ${props.className ?? ""}`}
    >
      {text}
    </span>
  );
}

const RING = 20;
const RING_LENGTH = 2 * Math.PI * RING;

/**
 * Аватар с уровнем. Уровень — не знаком-кружком: круглый яркий знак в углу у
 * нас значит «здесь есть что забрать или прочитать» (Р50), и уровень в нём
 * путали с уведомлением. Поэтому уровень — кольцом опыта вокруг аватара и
 * спокойной табличкой с числом снизу, в цвет поверхности. Кольцо заполнено
 * настолько, насколько набран опыт уровня; пока его не спрашивали — только
 * дорожка.
 */
function LevelAvatar(props: { name: string; url: string | null | undefined }): ReactNode {
  const level = useProgress((state) => state.progress?.level ?? state.runLevel);
  const share = useProgress((state) => {
    const progress = state.progress;
    if (progress === null || progress.xpForNext === null) return progress === null ? 0 : 1;
    return progress.xpForNext === 0 ? 1 : Math.min(1, progress.xpIntoLevel / progress.xpForNext);
  });

  return (
    <span className="relative inline-flex size-11 items-center justify-center">
      <svg aria-hidden="true" viewBox="0 0 44 44" className="absolute inset-0 size-11 -rotate-90">
        <circle cx="22" cy="22" r={RING} fill="none" stroke="var(--color-border-strong)" strokeWidth="2.5" />
        {share > 0 ? (
          <circle
            cx="22"
            cy="22"
            r={RING}
            fill="none"
            stroke="var(--color-xp)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${String(RING_LENGTH * share)} ${String(RING_LENGTH)}`}
          />
        ) : null}
      </svg>
      <Avatar name={props.name} url={props.url} size={34} />
      {level === null ? null : (
        <span
          aria-hidden="true"
          className="absolute -bottom-1 left-1/2 -translate-x-1/2 rounded-sm border border-border-strong bg-surface-raised px-1 font-display text-xs leading-4 font-bold tabular-nums text-text"
        >
          {level}
        </span>
      )}
    </span>
  );
}

/**
 * Валюта — одна кнопка на всю плашку: маленький «плюс» отдельной целью
 * нажатия был бы меньше 44 px (§4.6). Цель нажатия — 44 px в высоту, а
 * плашка — 32: вытянутая на всю цель, она выглядела бы кнопкой-столбиком.
 */
function CurrencyButton(props: { icon: ReactNode; label: string; value: number; target: ScreenId; buy?: boolean }): ReactNode {
  const open = (): void => {
    uiFeedback("tap");
    if (props.target === "shop") useNavigation.getState().resetTo("shop");
    else useNavigation.getState().push(props.target);
  };
  return (
    <button type="button" aria-label={`${props.label}: ${formatNumber(props.value)}`} onClick={open} className="group inline-flex min-h-11 shrink-0 items-center">
      <span
        className={`surface-sunken inline-flex h-8 items-center gap-1 rounded-pill pl-1 transition-transform duration-(--duration-fast) ease-base group-active:scale-95 ${props.buy === true ? "pr-1" : "pr-2.5"}`}
      >
        <span className="inline-flex size-6 items-center justify-center">{props.icon}</span>
        <span className="min-w-6 font-display text-sm font-bold whitespace-nowrap tabular-nums text-text">{formatCompact(props.value)}</span>
        {props.buy === true ? (
          <span className="inline-flex size-5 items-center justify-center rounded-full bg-accent text-on-accent">
            <Plus size={14} strokeWidth={3} />
          </span>
        ) : null}
      </span>
    </button>
  );
}
