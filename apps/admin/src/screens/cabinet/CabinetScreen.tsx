import { useState } from "react";
import { CABINET_TEXTS, fetchCabinet, viewBanner } from "../../api/cabinet";
import { api } from "../../services";
import { HELP } from "../../ui/help";
import { Help, Loading, Notice } from "../../ui/kit";
import { useApi } from "../../ui/use-api";
import { LinksTab } from "./LinksTab";
import { PromosTab } from "./PromosTab";

const TABS = [
  { id: "links", title: "Ссылки" },
  { id: "promos", title: "Промокоды" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/**
 * Кабинет партнёра (docs/35-stage4-plan.md Р136, tasks/T-0218): свои ссылки и промокоды. `partnerId` из адреса
 * (`#/cabinet/<id>`) — команда смотрит кабинет глазами партнёра, только чтение; без него — собственный кабинет.
 * Вкладки следующих задач (воронка, начисления, материалы) добавятся вместе с ними: пустых вкладок нет.
 */
export function CabinetScreen({ partnerId }: { partnerId: string | null }) {
  const [tab, setTab] = useState<TabId>("links");
  const { state } = useApi(() => fetchCabinet(api, partnerId), [partnerId]);

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") {
    // Команда без карточки партнёра заходит в «Кабинет» по меню — это не поломка, а подсказка, где смотреть.
    if (partnerId === null && state.error.kind === "forbidden") return <Notice tone="info">{CABINET_TEXTS.notPartner}</Notice>;
    return <Notice>{state.error.message}</Notice>;
  }
  const { partner } = state.data;

  return (
    <div className="flex max-w-4xl flex-col gap-4">
      {partnerId === null ? (
        <h2 className="font-display text-lg">{partner.name}</h2>
      ) : (
        <Notice tone="info">{viewBanner(partner.name)} — здесь можно только смотреть.</Notice>
      )}
      <div role="tablist" aria-label="Кабинет партнёра" className="flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none]">
        {TABS.map((item) => {
          const selected = item.id === tab;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setTab(item.id)}
              className={`-mb-px flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-sm font-medium transition-colors ${selected ? "border-accent text-text" : "border-transparent text-text-muted hover:text-text"}`}
            >
              {item.title}
            </button>
          );
        })}
        <span className="ml-auto flex items-center pr-1">
          <Help text={HELP.cabinet.section} />
        </span>
      </div>
      {tab === "links" ? <LinksTab partnerId={partnerId} /> : <PromosTab partnerId={partnerId} />}
    </div>
  );
}
