import type { ReactNode } from "react";
import { Bell, Plus } from "lucide-react";
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
 * docs/35-stage4-plan.md Р60): аватар с уровнем, валюты, колокольчик.
 *
 * Шапка обязана уместиться в 320 px при любых балансах. Поэтому имени в ней
 * нет — оно в профиле и в меню; отдельной кнопки меню нет — меню открывает
 * аватар, и первой строкой в нём карточка профиля; валюты — короткой записью
 * от десяти тысяч, полное число — в подписи для экранного чтения и в
 * истории. Итог на 320 px с колокольчиком — около 300 px.
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
  // Уровень — с сервера, когда его уже спрашивали, иначе из подписанного
  // снимка на устройстве: лишнего запроса ради значка шапка не делает.
  const level = useProgress((state) => state.progress?.level ?? state.runLevel);

  return (
    <header className="shrink-0 pt-[calc(0.5rem+var(--app-inset-top))] pr-[calc(0.75rem+var(--app-inset-right))] pb-2 pl-[calc(0.75rem+var(--app-inset-left))]">
      <div className="mx-auto flex w-full max-w-[640px] items-center gap-1.5">
        <button
          type="button"
          aria-label={level === null ? t("header.menu", { name }) : t("header.menu.level", { name, level })}
          onClick={() => {
            uiFeedback("tap");
            props.onMenu();
          }}
          className="relative inline-flex size-11 shrink-0 items-center justify-center rounded-full transition-transform duration-(--duration-fast) ease-base active:scale-95"
        >
          <span className="rounded-full ring-2 ring-accent/60">
            <Avatar name={name} url={user?.avatarUrl} size={36} />
          </span>
          {level === null ? null : (
            <span
              aria-hidden="true"
              className="absolute -right-1 -bottom-1 inline-flex min-w-5 items-center justify-center rounded-pill bg-accent px-1 font-display text-xs font-bold tabular-nums text-on-accent"
            >
              {level}
            </span>
          )}
        </button>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          <CurrencyButton icon={<CoinIcon size={22} />} label={t("currency.coins")} value={balances?.coins ?? 0} target="history" />
          <CurrencyButton icon={<GemIcon size={22} />} label={t("currency.premium")} value={balances?.gems ?? 0} target="shop" buy />
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
            className="btn-secondary relative inline-flex size-11 shrink-0 items-center justify-center rounded-md transition-transform duration-(--duration-fast) ease-base active:scale-90"
          >
            <Bell size={22} />
            {unread > 0 ? (
              <span className="absolute -top-1 -right-1 inline-flex min-w-5 items-center justify-center rounded-pill bg-accent px-1 font-display text-xs font-bold tabular-nums text-on-accent">
                {badgeText(unread)}
              </span>
            ) : null}
          </button>
        ) : null}
      </div>
    </header>
  );
}

/**
 * Валюта — одна кнопка на всю плашку: маленький «плюс» отдельной целью
 * нажатия был бы меньше 44 px (§4.6). Число — коротким, полное — в подписи.
 */
function CurrencyButton(props: { icon: ReactNode; label: string; value: number; target: ScreenId; buy?: boolean }): ReactNode {
  const open = (): void => {
    uiFeedback("tap");
    if (props.target === "shop") useNavigation.getState().resetTo("shop");
    else useNavigation.getState().push(props.target);
  };
  return (
    <button
      type="button"
      aria-label={`${props.label}: ${formatNumber(props.value)}`}
      onClick={open}
      className={`surface-sunken inline-flex min-h-11 shrink-0 items-center gap-1 rounded-pill py-1 pl-1 transition-transform duration-(--duration-fast) ease-base active:scale-95 ${props.buy === true ? "pr-1" : "pr-2.5"}`}
    >
      <span className="inline-flex size-6 items-center justify-center">{props.icon}</span>
      <span className="min-w-6 font-display text-sm font-bold whitespace-nowrap tabular-nums text-text">{formatCompact(props.value)}</span>
      {props.buy === true ? (
        <span className="inline-flex size-5 items-center justify-center rounded-full bg-accent text-on-accent">
          <Plus size={14} strokeWidth={3} />
        </span>
      ) : null}
    </button>
  );
}
