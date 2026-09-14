import type { ReactNode } from "react";
import { Diamond, Gem, Menu, Plus } from "lucide-react";
import { Avatar } from "../design-system/components";
import { t } from "../i18n";
import { useNavigation } from "../state/navigation";
import { uiFeedback } from "../state/ui-feedback";
import { useShell } from "../state/shell";

/**
 * Шапка разделов нижней панели: кто играет, сколько у него валюты и одна
 * кнопка меню, за которой всё остальное — профиль, гайдбук, настройки
 * (docs/27-design-system-and-app-shell.md §6).
 *
 * Имя и аватар — из параметров запуска площадки и только для отображения:
 * это не проверенная личность (docs/08-web-and-identity.md §4). Валюты —
 * заглушки с нулём до экономики; «плюс» ведёт в магазин, а не в пустоту.
 */
export function AppHeader(props: { onMenu(): void }): ReactNode {
  const user = useShell((state) => state.adapter.displayUser);
  const name = user?.displayName ?? t("profile.guest");

  return (
    <header className="shrink-0 px-3 pt-[calc(0.5rem+var(--app-inset-top))] pr-[calc(0.75rem+var(--app-inset-right))] pb-2 pl-[calc(0.75rem+var(--app-inset-left))]">
      <div className="mx-auto flex w-full max-w-[640px] items-center gap-2">
        <button
          type="button"
          onClick={() => useNavigation.getState().push("profile")}
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-pill pr-2 text-left transition-transform duration-(--duration-fast) ease-base active:scale-[0.98]"
        >
          <span className="rounded-full ring-2 ring-accent/60">
            <Avatar name={name} url={user?.avatarUrl} size={36} />
          </span>
          <span className="min-w-0 truncate font-display text-sm font-bold text-text">{name}</span>
        </button>

        <CurrencyButton icon={<Gem size={14} />} tone="info" label={t("currency.shards")} value={0} />
        <CurrencyButton icon={<Diamond size={14} />} tone="passive" label={t("currency.premium")} value={0} />

        <button
          type="button"
          aria-label={t("menu.title")}
          onClick={() => {
            uiFeedback("tap");
            props.onMenu();
          }}
          className="btn-secondary relative inline-flex size-11 shrink-0 items-center justify-center rounded-md transition-transform duration-(--duration-fast) ease-base active:scale-90"
        >
          <Menu size={22} />
        </button>
      </div>
    </header>
  );
}

/**
 * Валюта с «плюсом»: вся плашка — одна кнопка в магазин. Маленький «плюс»
 * отдельной целью нажатия был бы меньше 44 px (§4.6).
 */
function CurrencyButton(props: {
  icon: ReactNode;
  tone: "info" | "passive";
  label: string;
  value: number;
}): ReactNode {
  return (
    <button
      type="button"
      aria-label={`${props.label}: ${props.value}`}
      onClick={() => useNavigation.getState().resetTo("shop")}
      className="surface-sunken inline-flex min-h-11 shrink-0 items-center gap-1 rounded-pill py-1 pr-1 pl-1 transition-transform duration-(--duration-fast) ease-base active:scale-95"
    >
      <span
        className={[
          "inline-flex size-6 items-center justify-center rounded-full",
          props.tone === "info" ? "bg-info/15 text-info" : "bg-passive/15 text-passive",
        ].join(" ")}
      >
        {props.icon}
      </span>
      <span className="min-w-6 font-display text-sm font-bold tabular-nums text-text">{props.value}</span>
      <span className="inline-flex size-5 items-center justify-center rounded-full bg-accent text-on-accent">
        <Plus size={14} strokeWidth={3} />
      </span>
    </button>
  );
}
