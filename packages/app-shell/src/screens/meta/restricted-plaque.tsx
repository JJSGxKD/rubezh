import { useEffect, type ReactNode } from "react";
import { Lock } from "lucide-react";
import { SectionTitle } from "../../design-system/components";
import { t } from "../../i18n";
import "../../i18n/restrictions";
import { useNavigation } from "../../state/navigation";
import { activeOf, loadRestrictions, useRestrictions, type PlayerRestriction } from "../../state/restrictions";

/**
 * Ограничение там, где игрок упёрся (docs/35-stage4-plan.md WP44): что
 * закрыто, до какого числа и почему — словами сервера, теми же, что видел
 * модератор в предпросмотре (Р83), — и «Написать нам». Плашка спокойная, а
 * не красная: это не сбой, и остальная игра работает.
 *
 * Экран ставит её заранее, а не после отказа: закрыто — игрок видит это до
 * нажатия. Нечего показать — не рисует ничего.
 */
export function RestrictedPlaque({ kinds, compact = false, className = "" }: { kinds: readonly string[] | null; compact?: boolean; className?: string }): ReactNode {
  const list = useRestrictions((state) => state.list);
  useEffect(() => {
    void loadRestrictions();
  }, []);
  const rows = activeOf(list, kinds, Date.now());
  if (rows.length === 0) return null;
  return (
    <div className={`grid gap-2 ${className}`}>
      {rows.map((row) => (
        <RestrictionCard key={row.kind} row={row} compact={compact} />
      ))}
    </div>
  );
}

/** Профиль: все действующие, о которых сообщили, — своим разделом; нет ни одного — нет и раздела. */
export function RestrictionsSection(): ReactNode {
  const any = useRestrictions((state) => activeOf(state.list, null, Date.now()).length > 0);
  return (
    <>
      {any ? <SectionTitle>{t("restricted.section")}</SectionTitle> : null}
      <RestrictedPlaque kinds={null} />
    </>
  );
}

/**
 * Одно ограничение. `compact` — там, где места мало и уходить с экрана
 * некуда (итог забега): без кнопки «Написать нам», она есть в профиле.
 */
export function RestrictionCard({ row, compact = false }: { row: PlayerRestriction; compact?: boolean }): ReactNode {
  const navigation = useNavigation();
  return (
    <div role="status" className="surface-sunken flex items-start gap-3 rounded-lg px-3 py-3 text-left">
      <Lock size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text">{row.title}</p>
        <p className="mt-0.5 text-xs text-text">{t("restricted.until", { until: row.until })}</p>
        <p className="mt-0.5 text-xs text-text-muted">{t("restricted.reason", { reason: row.reason })}</p>
        {compact ? null : (
          <>
            <p className="mt-2 text-xs text-text-muted">{t("restricted.rest")}</p>
            <button type="button" className="mt-1 min-h-11 text-sm font-semibold text-accent" onClick={() => navigation.push("feedback")}>
              {t("restricted.write")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
