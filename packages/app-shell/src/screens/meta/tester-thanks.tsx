import { useEffect, useState, type ReactNode } from "react";
import { FlaskConical, Gift, Heart, ArrowUp, Star, type LucideIcon } from "lucide-react";
import { Button, Modal } from "../../design-system/components";
import { GemIcon } from "../../design-system/components/CurrencyIcons";
import { formatNumber, t } from "../../i18n";
import "../../i18n/tester";
import { useBackLayer } from "../../state/back-stack";
import { claimCompensation, compensationLines, useCompensation } from "../../state/compensation";
import { useNavigation } from "../../state/navigation";
import { TesterBadge } from "./tester-badge";

/**
 * Окно «Спасибо за тест» (docs/35-stage4-plan.md Р87, design/screens/tester-thanks.html):
 * после вайпа тестер видит, что вернулось из купленного и что дали сверху.
 *
 * Закрыть окно до забора нельзя: у него нет ни крестика, ни закрытия по
 * затемнению, а «Назад» гасится пустым слоем. Окно обещает то, что уже лежит
 * на сервере; не забрал и закрыл приложение — оно придёт при следующем входе.
 */
export function TesterThanksScreen(): ReactNode {
  const navigation = useNavigation();
  const view = useCompensation((state) => state.pending);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  // «Назад» ничего не делает: слой есть, а обработчик пустой.
  useBackLayer(() => undefined);

  // Открыли экран без компенсации (забрана на другом устройстве, повторный
  // вход) — показывать нечего.
  const empty = view === null;
  useEffect(() => {
    if (empty) navigation.pop();
  }, [empty, navigation]);
  if (view === null) return null;

  const lines = compensationLines(view);
  const claim = async (): Promise<void> => {
    setPending(true);
    setFailed(false);
    const done = await claimCompensation();
    if (done) {
      navigation.pop();
      return;
    }
    setPending(false);
    setFailed(true);
  };

  return (
    <Modal
      footer={
        <>
          {failed ? (
            <p role="alert" className="text-center text-sm text-danger">
              {t("tester.failed")}
            </p>
          ) : null}
          <Button size="l" block glow loading={pending} onClick={() => void claim()}>
            {pending ? t("tester.claiming") : t("tester.claim")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2.5">
        <span
          aria-hidden="true"
          className="mx-auto inline-flex size-16 items-center justify-center rounded-full bg-elite/15 text-elite ring-1 ring-elite/40 short:hidden landscape:hidden"
        >
          {view.tester ? <FlaskConical size={30} /> : <Gift size={30} />}
        </span>
        <h2 className="text-center font-display text-[22px] leading-tight text-text">
          {view.tester ? t("tester.thanks.title") : t("tester.returned.title")}
        </h2>
        <p className="text-center text-[13px] leading-snug text-text-muted">
          {view.tester ? t("tester.thanks.text") : t("tester.returned.text")}
        </p>

        <ul className="mt-1 flex flex-col gap-1.5">
          {lines.restoredGems > 0 ? (
            <Line tone="text-gem" icon={Star} label={t("tester.line.restored")} value={lines.restoredGems} />
          ) : null}
          {lines.continueGems > 0 ? (
            <Line tone="text-hp" icon={Heart} label={t("tester.line.continue")} hint={t("tester.line.continue.hint")} value={lines.continueGems} />
          ) : null}
          {lines.bonusGems > 0 ? (
            <Line tone="text-xp" icon={ArrowUp} label={t("tester.line.bonus", { level: view.level })} value={lines.bonusGems} />
          ) : null}
          {lines.badge ? (
            <Line tone="text-elite" icon={FlaskConical} label={t("tester.line.badge")} hint={t("tester.line.badge.hint")} badge />
          ) : null}
        </ul>

        <div className="flex items-center justify-between px-1 text-[13px] text-text-muted">
          <span>{t("tester.total")}</span>
          <span className="inline-flex items-center gap-1.5 font-display text-lg text-text tabular-nums">
            +{formatNumber(lines.total)}
            <GemIcon size={16} />
          </span>
        </div>
      </div>
    </Modal>
  );
}

function Line(props: { tone: string; icon: LucideIcon; label: string; hint?: string; value?: number; badge?: boolean }): ReactNode {
  const Icon = props.icon;
  return (
    <li className="surface-sunken flex items-center gap-2.5 rounded-lg px-3 py-2.5">
      <span className={`inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-current/15 ${props.tone}`}>
        <Icon size={18} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-text">{props.label}</p>
        {props.hint === undefined ? null : <p className="text-[11.5px] text-text-muted">{props.hint}</p>}
      </div>
      {props.badge === true ? (
        <TesterBadge />
      ) : (
        <span className="inline-flex items-center gap-1 font-display text-base text-text tabular-nums">
          +{formatNumber(props.value ?? 0)}
          <GemIcon size={14} />
        </span>
      )}
    </li>
  );
}
