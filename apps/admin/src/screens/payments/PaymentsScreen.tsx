import { fetchPaymentJobs, fetchReconcileOverview } from "../../api/payments";
import { api } from "../../services";
import { can } from "../../state/session";
import { useSession } from "../../state/use-session";
import { navigate } from "../../ui/router";
import { TabBar } from "../../ui/tab-bar";
import { useApi } from "../../ui/use-api";
import { PaymentCardView } from "./PaymentCardView";
import { PaymentDiscrepancies } from "./PaymentDiscrepancies";
import { PaymentJobs } from "./PaymentJobs";
import { PaymentsFeed } from "./PaymentsFeed";
import { PAYMENTS_TABS, tabId, tabOfRoute, type PaymentsTab } from "./payments-tabs";

/**
 * Раздел «Платежи» (tasks/T-0437, T-0438): три вкладки — лента, расхождения
 * сверки и брошенные задания очереди; платёж — карточкой без вкладок. Адреса:
 * `#/payments`, `#/payments/discrepancies`, `#/payments/jobs`,
 * `#/payments/<номер покупки>`.
 */
export function PaymentsScreen({ id }: { id: string | null }) {
  const tab = tabOfRoute(id);
  if (tab === null && id !== null) return <PaymentCardView key={id} purchaseId={id} />;
  return <PaymentsTabs tab={tab ?? "feed"} />;
}

function PaymentsTabs({ tab }: { tab: PaymentsTab }) {
  // Данные обеих вкладок грузятся сразу: числа у вкладок видны, пока открыта лента.
  const overview = useApi(() => fetchReconcileOverview(api), []);
  const jobs = useApi(() => fetchPaymentJobs(api), []);
  const canSupport = useSession((session) => can(session.view, "payments.support"));
  const counts: Partial<Record<PaymentsTab, number>> = {};
  if (overview.state.status === "ok") counts.discrepancies = overview.state.data.open.length;
  if (jobs.state.status === "ok") counts.jobs = jobs.state.data.jobs.length;

  return (
    <div className="flex flex-col gap-4">
      <TabBar label="Платежи" tabs={PAYMENTS_TABS} active={tab} counts={counts} onSelect={(next) => navigate({ section: "payments", id: tabId(next) })} />
      {tab === "feed" ? <PaymentsFeed /> : null}
      {tab === "discrepancies" ? <PaymentDiscrepancies state={overview.state} reload={overview.reload} canSupport={canSupport} /> : null}
      {tab === "jobs" ? <PaymentJobs state={jobs.state} reload={jobs.reload} canSupport={canSupport} /> : null}
    </div>
  );
}
