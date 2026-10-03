import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Hourglass } from "lucide-react";
import type { NetworkTaskHandle, NetworkTaskLook, NetworkTaskPart } from "@bh/shared-types";
import { Card } from "../../design-system/components";
import { t } from "../../i18n";
import { track, useShell } from "../../state/shell";
import { NETWORK_TASK_CHECKS_MS, createTasksApi, networkTaskConfirmed, type NetworkTaskItem } from "../../state/tasks-api";
import { loadWallet } from "../../state/wallet-api";
import { AdLabel } from "./ad-label";
import { formatCountdown } from "./schedule";
import { RewardChips } from "./task-reward";

/**
 * Задания рекламных сетей во вкладке «Партнёры» (docs/35-stage4-plan.md
 * WP13, часть 6). Задание выбирает, рисует и проверяет SDK сети — через
 * адаптер площадки, — а строка вокруг наша: пометка «Реклама» с именем
 * сети, награда и кнопки в цветах игры.
 *
 * Пока сеть не нарисовала задание, строки не видно: «заданий нет» звучало
 * бы как поломка, а пустое место — нет. Выполнила — элемент сети снимается,
 * и на его месте наша строка: награду даёт сервер по подтверждению сети,
 * экран спрашивает его несколько раз и говорит честно — получено или сеть
 * ещё проверяет.
 */

const api = createTasksApi();

/** Строка задания сети — того же размера, что строки своих заданий: иконка 44 px, заголовок 14 px. */
const LOOK: NetworkTaskLook = { fontSize: "var(--text-sm)", iconSize: "2.75rem", iconRadius: "var(--radius-md)", gap: "0.75rem", buttonWidth: "6rem" };

type Finished = { item: NetworkTaskItem; status: "checking" | "rewarded" | "waiting" };

export interface NetworkTasksProps {
  items: readonly NetworkTaskItem[];
  /** с какого номера идёт лесенка появления — после строк над ними */
  firstIndex: number;
  /** перечитать задания; `null` — не вышло */
  refresh: () => Promise<readonly NetworkTaskItem[] | null>;
  /** сколько строк сетей есть или ещё могут появиться — экран не скажет «пусто» раньше времени */
  onCount: (count: number) => void;
}

export function NetworkTasks(props: NetworkTasksProps): ReactNode {
  const [finished, setFinished] = useState<ReadonlyMap<string, Finished>>(new Map());
  // Сессии, у которых сеть не нашла задания, — до следующего открытия экрана.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const alive = useRef(true);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const live = props.items.filter((item) => item.offer !== null && !gone.has(item.offer.sessionId) && !finished.has(item.network));
  const done = [...finished.values()];
  const count = live.length + done.length;
  useEffect(() => props.onCount(count), [count]);

  const settle = (network: string, status: Finished["status"], item?: NetworkTaskItem) =>
    setFinished((current) => {
      const before = current.get(network);
      if (before === undefined) return current;
      return new Map(current).set(network, { item: item ?? before.item, status });
    });

  /** Сеть засчитала задание — спросить сервер, дошло ли её подтверждение. */
  const verify = async (item: NetworkTaskItem): Promise<void> => {
    const started = Date.now();
    for (const at of NETWORK_TASK_CHECKS_MS) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + at - Date.now())));
      if (!alive.current) return;
      const fresh = (await latest.current.refresh())?.find((candidate) => candidate.network === item.network);
      if (!alive.current) return;
      if (networkTaskConfirmed(item, fresh)) {
        settle(item.network, "rewarded", { ...item, ...fresh, reward: item.reward });
        track("ad_reward_claimed", { place: "task", source: "ad", network: item.network });
        void loadWallet();
        return;
      }
    }
    settle(item.network, "waiting");
  };

  const onDone = (item: NetworkTaskItem): void => {
    setFinished((current) => new Map(current).set(item.network, { item, status: "checking" }));
    void verify(item);
  };

  return (
    <>
      {done.map((entry, index) => (
        <DoneRow key={entry.item.network} entry={entry} index={props.firstIndex + index} />
      ))}
      {live.map((item, index) => (
        <LiveRow
          key={item.offer?.sessionId ?? item.network}
          item={item}
          index={props.firstIndex + done.length + index}
          onDone={() => onDone(item)}
          onGone={(sessionId) => setGone((current) => new Set(current).add(sessionId))}
        />
      ))}
    </>
  );
}

/** Узлы наших слотов — свои у каждой строки: сеть переносит их внутрь своего элемента. */
function partsOf(): Record<NetworkTaskPart, HTMLElement> {
  return { reward: document.createElement("span"), open: document.createElement("span"), claim: document.createElement("span"), done: document.createElement("span") };
}

function LiveRow(props: { item: NetworkTaskItem; index: number; onDone: () => void; onGone: (sessionId: string) => void }): ReactNode {
  const { item } = props;
  const offer = item.offer;
  const host = useRef<HTMLDivElement>(null);
  const [parts] = useState(partsOf);
  const [ready, setReady] = useState(false);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const node = host.current;
    if (offer === null || node === null) return;
    const { adapter } = useShell.getState();
    if (adapter.mountNetworkTask === undefined) {
      latest.current.onGone(offer.sessionId);
      return;
    }
    // Шаги — для воронки места «Задания» в панели. Выполнение отсюда не
    // сообщается: его засчитывает только подтверждение сети серверу.
    // Ручка приходит, когда код заданий загружен: строку могли снять раньше.
    let handle: NetworkTaskHandle | null = null;
    let unmounted = false;
    const mounting = adapter.mountNetworkTask({
      network: offer.network,
      blockId: offer.blockId,
      debug: offer.debug,
      host: node,
      parts,
      look: LOOK,
      onState: (state) => {
        if (state.kind === "ready") {
          setReady(true);
          void api.networkStep(offer.sessionId, "shown");
        } else if (state.kind === "done") {
          latest.current.onDone();
        } else {
          // Нет задания, отказ или «перезапустите приложение» — строки просто
          // нет. Сессия остаётся открытой: следующее открытие экрана спросит
          // сеть той же сессией, а не заведёт новую.
          latest.current.onGone(offer.sessionId);
        }
      },
    });
    mounting.then(
      (mounted) => {
        if (unmounted) mounted.unmount();
        else handle = mounted;
      },
      () => {
        if (!unmounted) latest.current.onGone(offer.sessionId);
      },
    );
    let clicked = false;
    const open = (): void => {
      if (clicked) return;
      clicked = true;
      track("task_link_opened", { task: offer.network, kind: "network", network: offer.network });
      void api.networkStep(offer.sessionId, "clicked");
    };
    parts.open.addEventListener("click", open);
    return () => {
      unmounted = true;
      parts.open.removeEventListener("click", open);
      handle?.unmount();
    };
  }, [offer?.sessionId]);

  return (
    // Пока сеть не нарисовала задание, строка стоит невидимой поверх списка:
    // элементу сети нужна раскладка, чтобы её размер сказал «готово».
    <div aria-hidden={!ready} className={ready ? "transition-opacity duration-(--duration-fast) ease-base" : "pointer-events-none absolute inset-x-0 top-0 opacity-0"}>
      <Card appearIndex={ready ? props.index : undefined}>
        <AdLabel network={item.title} />
        <div ref={host} />
      </Card>
      {createPortal(<RewardChips reward={item.reward} inline />, parts.reward)}
      {createPortal(<SlotButton>{t("tasks.go")}</SlotButton>, parts.open)}
      {createPortal(<SlotButton>{t("tasks.claim")}</SlotButton>, parts.claim)}
      {createPortal(
        <span className="inline-flex size-11 items-center justify-center rounded-md bg-accent/15 text-accent">
          <Check size={20} aria-label={t("tasks.done")} />
        </span>,
        parts.done,
      )}
    </div>
  );
}

/** Кнопка в слоте сети: нажатие ловит SDK, вид — наш. */
function SlotButton(props: { children: ReactNode }): ReactNode {
  return <span className="btn-primary inline-flex min-h-11 w-full items-center justify-center rounded-md px-3 font-display text-sm font-semibold">{props.children}</span>;
}

function DoneRow(props: { entry: Finished; index: number }): ReactNode {
  const { item, status } = props.entry;
  const rewarded = status === "rewarded";
  return (
    <Card appearIndex={props.index} stripe={rewarded ? "accent" : undefined}>
      <AdLabel network={item.title} />
      <div className="flex items-center gap-3" role="status">
        <span
          className={[
            "inline-flex size-11 shrink-0 items-center justify-center rounded-md",
            rewarded ? "bg-accent/15 text-accent" : "bg-surface-raised text-text-muted",
          ].join(" ")}
        >
          {rewarded ? <Check size={20} aria-hidden="true" /> : <Hourglass size={20} aria-hidden="true" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-sm font-bold text-text">{t(rewarded ? "tasks.network.rewarded" : "tasks.network.done")}</p>
          <p className="mt-0.5 text-xs text-text-muted">{doneDetail(item, status)}</p>
        </div>
        <RewardChips reward={item.reward} />
      </div>
    </Card>
  );
}

function doneDetail(item: NetworkTaskItem, status: Finished["status"]): string {
  if (status === "checking") return t("tasks.network.checking", { network: item.title });
  if (status === "waiting") return t("tasks.network.waiting", { network: item.title });
  if (item.nextAt === null) return "";
  if (item.doneToday >= item.dailyCap) return t("tasks.network.tomorrow", { network: item.title });
  return t("tasks.network.next", { network: item.title, time: formatCountdown(Date.parse(item.nextAt) - Date.now()) });
}
