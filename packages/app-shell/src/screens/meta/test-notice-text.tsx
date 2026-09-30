import type { ReactNode } from "react";
import { t } from "../../i18n";
import "../../i18n/test-notice";

/**
 * Текст предупреждения о тесте — один и тот же на экране предупреждения и в
 * «Об игре» (docs/35-stage4-plan.md WP33). Отдельным файлом: «Об игре» не
 * должна тянуть за собой клиент API предупреждения.
 */
export function TestNoticeText(): ReactNode {
  return (
    <div className="grid gap-3 text-sm text-text-muted">
      <p>{t("testNotice.changes")}</p>
      <p className="font-semibold text-text">{t("testNotice.progress")}</p>
      <p>{t("testNotice.purchases")}</p>
      <p>{t("testNotice.feedback")}</p>
    </div>
  );
}
