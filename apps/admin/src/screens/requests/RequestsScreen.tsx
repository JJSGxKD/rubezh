import { useState } from "react";
import { PERIODS, type RequestPeriod } from "../../api/requests";
import { InboundTab } from "./InboundTab";
import { OutboundTab } from "./OutboundTab";

const TABS = [
  { id: "outbound", title: "Исходящие" },
  { id: "inbound", title: "Входящие" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Кнопка-«таблетка» вкладки или периода: тот же вид, что у фильтров других разделов. */
function Pill({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`rounded-pill border px-3 py-1 text-xs transition-colors ${selected ? "border-accent bg-accent/15 text-accent" : "border-border text-text-muted hover:border-border-strong hover:text-text"}`}
    >
      {children}
    </button>
  );
}

/**
 * «Запросы» (docs/35-stage4-plan.md Р92): куда ходит сервер и что к нему
 * приходит. Период общий для обеих вкладок — час, сутки или неделя, окно
 * считает сервер от «сейчас».
 */
export function RequestsScreen() {
  const [tab, setTab] = useState<TabId>("outbound");
  const [period, setPeriod] = useState<RequestPeriod>("day");

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Вид запросов">
          {TABS.map((item) => (
            <Pill key={item.id} selected={tab === item.id} onClick={() => setTab(item.id)}>
              {item.title}
            </Pill>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Период">
          {PERIODS.map((item) => (
            <Pill key={item.id} selected={period === item.id} onClick={() => setPeriod(item.id)}>
              {item.title}
            </Pill>
          ))}
        </div>
      </div>
      {tab === "outbound" ? <OutboundTab period={period} /> : <InboundTab period={period} />}
    </div>
  );
}
