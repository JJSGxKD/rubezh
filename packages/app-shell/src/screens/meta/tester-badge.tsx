import type { ReactNode } from "react";
import { FlaskConical } from "lucide-react";
import { t } from "../../i18n";

/**
 * Знак «Тестер» (docs/35-stage4-plan.md Р87): играл на открытом тесте до
 * вайпа. Тон элиты, а не акцента: метка «Вы» в рейтинге — акцентом, и знак не
 * должен с ней спорить. `size="l"` — в профиле.
 */
export function TesterBadge(props: { size?: "s" | "l" }): ReactNode {
  const large = props.size === "l";
  return (
    <span
      className={[
        "inline-flex shrink-0 items-center rounded-sm bg-elite/15 font-display text-elite ring-1 ring-elite/40",
        large ? "gap-1 px-2 py-0.5 text-[12px]" : "gap-[3px] px-1.5 py-px text-[10.5px]",
      ].join(" ")}
    >
      <FlaskConical size={large ? 13 : 11} aria-hidden="true" />
      {t("tester.badge")}
    </span>
  );
}
