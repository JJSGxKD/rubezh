import { useEffect, useId, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button, Modal } from "../../design-system/components";
import { formatDuration, t } from "../../i18n";
import "../../i18n/run-interrupted";
import { useNavigation } from "../../state/navigation";
import { useInterruptedNotice } from "../../state/run-interrupted";

/**
 * Карточка «Игра обновилась — забег засчитан» (tasks/T-0163): игрок один раз
 * видит, что забег, прерванный обновлением, не пропал. Окно не ходит в сеть —
 * забег уже стоит в очереди итогов, а числа лежат в памяти.
 *
 * Закрывается «Понятно» и «Назад»: окно сообщает, а не требует решения.
 */
export function RunInterruptedScreen(): ReactNode {
  const navigation = useNavigation();
  const notice = useInterruptedNotice((state) => state.notice);
  const titleId = useId();

  // Открыли без уведомления (повтор, перезапуск экрана) — показывать нечего.
  const empty = notice === null;
  useEffect(() => {
    if (empty) navigation.pop();
  }, [empty, navigation]);
  if (notice === null) return null;

  const close = (): void => {
    useInterruptedNotice.getState().dismiss();
    navigation.pop();
  };

  return (
    <Modal
      labelledBy={titleId}
      icon={<RefreshCw size={26} aria-hidden="true" />}
      onDismiss={close}
      footer={
        <Button track="close" size="l" block onClick={close}>
          {t("runInterrupted.ok")}
        </Button>
      }
    >
      <div className="flex flex-col gap-2.5 text-center">
        <h2 id={titleId} className="font-display text-[22px] leading-tight text-text">
          {t("runInterrupted.title")}
        </h2>
        <p className="text-[13px] leading-snug text-text-muted">{t("runInterrupted.text")}</p>
        <p className="font-display text-base text-text">
          {t("runInterrupted.result", { time: formatDuration(notice.survivalSec), level: notice.level })}
        </p>
      </div>
    </Modal>
  );
}
