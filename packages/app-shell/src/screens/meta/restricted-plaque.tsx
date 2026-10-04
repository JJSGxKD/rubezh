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
 * нажатия. Нечего показать — не рисует ничего. Закрыто несколько — одной
 * рамкой: «остальное работает» и «Написать нам» говорятся один раз.
 *
 * `kinds` — что закрывает этот экран; `null` — всё (профиль). `compact` —
 * там, где места мало и уходить с экрана некуда (итог забега): без кнопки,
 * она есть в профиле.
 */
export function RestrictedPlaque({ kinds, compact = false, className = "" }: { kinds: readonly string[] | null; compact?: boolean; className?: string }): ReactNode {
  const list = useRestrictions((state) => state.list);
  const navigation = useNavigation();
  useEffect(() => {
    void loadRestrictions();
  }, []);
  const rows = activeOf(list, kinds, Date.now());
  if (rows.length === 0) return null;
  return (
    <div role="status" className={`surface-sunken rounded-lg px-3 py-3 text-left ${className}`}>
      <ul className="grid gap-3">
        {rows.map((row) => (
          <RestrictionRow key={row.kind} row={row} />
        ))}
      </ul>
      {compact ? null : (
        // Отступ — под текст строк: иконка 18 px и зазор 12 px.
        <div className="mt-2 pl-7.5">
          <p className="text-xs text-text-muted">{t("restricted.rest")}</p>
          <button type="button" className="mt-1 min-h-11 text-sm font-semibold text-accent" onClick={() => navigation.push("feedback")}>
            {t("restricted.write")}
          </button>
        </div>
      )}
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

function RestrictionRow({ row }: { row: PlayerRestriction }): ReactNode {
  return (
    <li className="flex items-start gap-3">
      <Lock size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-text">{row.title}</p>
        <p className="mt-0.5 text-xs text-text">{t("restricted.until", { until: row.until })}</p>
        <p className="mt-0.5 text-xs text-text-muted">{t("restricted.reason", { reason: row.reason })}</p>
      </div>
    </li>
  );
}
