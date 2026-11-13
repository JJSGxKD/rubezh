import { isPurchaseId } from "./feed-filters";
import { PaymentCardView } from "./PaymentCardView";
import { PaymentsFeed } from "./PaymentsFeed";

/**
 * Раздел «Платежи» (tasks/T-0437): лента всех покупок; платёж — карточкой.
 * Карточка открывается только по номеру покупки: слова `discrepancies` и
 * `jobs` во второй части адреса заняты под вкладки (T-0438), для них — лента.
 */
export function PaymentsScreen({ id }: { id: string | null }) {
  if (isPurchaseId(id)) return <PaymentCardView key={id} purchaseId={id} />;
  return <PaymentsFeed />;
}
