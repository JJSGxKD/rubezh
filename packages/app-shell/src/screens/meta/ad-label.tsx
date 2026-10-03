import type { ReactNode } from "react";
import { Badge } from "../../design-system/components";
import { t } from "../../i18n";

/**
 * Пометка строки задания сети — «Реклама · AdsGram» (docs/35-stage4-plan.md
 * Р80): у каждой строки сети, как бы сеть её ни рисовала — своим элементом
 * или нашей строкой по ленте.
 */
export function AdLabel(props: { network: string }): ReactNode {
  return (
    <p className="mb-2 flex items-center gap-2 text-xs text-text-muted">
      <Badge tone="muted">{t("tasks.network.ad")}</Badge>
      {props.network}
    </p>
  );
}
