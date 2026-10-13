import { Suspense, useEffect, useState, type ReactNode } from "react";
import { BookOpen, ChevronRight, History, MessageSquareHeart, Play } from "lucide-react";
import { Button, Card, ContentColumn, Modal, Screen } from "../design-system/components";
import { formatDuration, t } from "../i18n";
import { shouldAskFeedback, useFeedback } from "../state/feedback";
import { useMeta } from "../state/meta";
import { useNavigation } from "../state/navigation";
import { PreRunSheetLazy, preloadScreens } from "../app/lazy-screens";
import { preloadRunEngine, useRun } from "../state/run";
import { useSavedRun, type SavedRun } from "../state/run-save";
import { useShell } from "../state/shell";
import { ItemTile } from "./item-icons";

/**
 * Через сколько после захода в лобби начинается предзагрузка движка, если
 * браузер не сообщает о простое сам. Сразу нельзя: первые секунды после
 * запуска сеть и поток нужны самой главной.
 */
const PRELOAD_DELAY_MS = 1500;

/**
 * Лобби: карусель «Сейчас в игре», виджеты — награда дня, колесо, задания,
 * рекорд и друзья — и «Играть», которая открывает лист «Перед забегом»
 * (docs/27-design-system-and-app-shell.md §6,
 * docs/35-stage4-plan.md WP42). Карусель и виджеты — одним чанком после
 * первого кадра (`home-live.ts`): первой загрузке они не нужны.
 */
export function LobbyScreen(): ReactNode {
  const navigation = useNavigation();
  const runs = useMeta((state) => state.runs);
  const saved = useSavedRun((state) => state.saved);
  const [confirmingNewRun, setConfirmingNewRun] = useState(false);
  const [preRunOpen, setPreRunOpen] = useState(false);
  const askFeedback = shouldAskFeedback(runs, useFeedback((state) => state.sentAtRuns));
  usePreloadEngine();

  return (
    <div className="relative h-full">
    <Screen
      footer={
        saved === null ? (
          <Button size="l" block glow onClick={() => setPreRunOpen(true)}>
            <Play size={22} fill="currentColor" />
            {t("lobby.play")}
          </Button>
        ) : (
          // Прерванный забег главнее нового: игрок, вернувшийся после звонка,
          // хочет доиграть, а не начинать с нуля.
          <div className="grid gap-1">
            <Button
              size="l"
              block
              glow
              onClick={() => {
                useRun.getState().intend({ kind: "resume", snapshot: saved });
                navigation.push("run");
              }}
            >
              <Play size={22} fill="currentColor" />
              {t("lobby.continue")}
            </Button>
            <Button variant="ghost" block onClick={() => setConfirmingNewRun(true)}>
              {t("lobby.newRun")}
            </Button>
          </div>
        )
      }
    >
      <ContentColumn>
        {/* Бренда на главной нет — он на заставке и в «Об игре»: игрок и так
            знает, что открыл (Р76). На его месте — что можно сделать сейчас. */}
        <div className="mt-3">
          <CarouselSlot />
        </div>

        {saved === null ? null : <SavedRunCard saved={saved} />}

        <WidgetsSlot />

        {/* Гайдбук на главной, а не только в меню: новичок не пойдёт искать
            его по меню, пока не проиграет пару забегов непонятно кому. */}
        <div className="mt-3">
          <Card appearIndex={4} onClick={() => navigation.push("guide")}>
            <div className="flex items-center gap-3">
              <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-passive/15 text-passive">
                <BookOpen size={22} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-display text-sm font-bold text-text">{t("guide.lobby.title")}</span>
                <span className="mt-0.5 block text-xs text-text-muted">{t("guide.lobby.hint")}</span>
              </span>
              <ChevronRight size={20} aria-hidden="true" className="shrink-0 text-text-muted" />
            </div>
          </Card>
        </div>

        {/* Отзыв зовут оставить после первого же забега и дальше раз в
            десяток: спрашивать в каждый запуск — верный способ, чтобы форму
            перестали замечать (docs/29-admin-panel.md §6). */}
        {askFeedback ? (
          <div className="mt-3">
            <Card appearIndex={5} stripe="accent" onClick={() => navigation.push("feedback")}>
              <div className="flex items-center gap-3">
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                  <MessageSquareHeart size={22} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-display text-sm font-bold text-text">{t("feedback.lobby.title")}</span>
                  <span className="mt-0.5 block text-xs text-text-muted">{t("feedback.lobby.hint")}</span>
                </span>
                <ChevronRight size={20} aria-hidden="true" className="shrink-0 text-text-muted" />
              </div>
            </Card>
          </div>
        ) : null}
      </ContentColumn>
    </Screen>

    {confirmingNewRun ? (
      <Modal
        title={t("lobby.newRun.title")}
        placement="bottom"
        onDismiss={() => setConfirmingNewRun(false)}
        footer={
          <>
            <Button
              variant="danger"
              block
              onClick={() => {
                useSavedRun.getState().clear();
                setConfirmingNewRun(false);
                setPreRunOpen(true);
              }}
            >
              {t("lobby.newRun.confirm")}
            </Button>
            <Button variant="ghost" block onClick={() => setConfirmingNewRun(false)}>
              {t("app.cancel")}
            </Button>
          </>
        }
      >
        <p className="text-sm text-text-muted">{t("lobby.newRun.text")}</p>
      </Modal>
    ) : null}

    {/* Лист поверх главной: сложность, оружие и бусты, «В бой» — второе касание
        (Р88). Чанк лобби подтягивает в простое, поэтому заглушки нет. */}
    {preRunOpen ? (
      <Suspense fallback={null}>
        <PreRunSheetLazy onClose={() => setPreRunOpen(false)} />
      </Suspense>
    ) : null}
    </div>
  );
}

type HomeLive = typeof import("./home-live");

/** Приехавший чанк главной: на главную возвращаются после каждого забега, и заглушки не должны мигать. */
let loadedLive: HomeLive | null = null;
let loadingLive: Promise<HomeLive> | null = null;

/** Чанк главной один на оба слота; не приехал — следующий заход попробует снова. */
function loadHomeLive(): Promise<HomeLive> {
  loadingLive ??= import("./home-live").then(
    (module) => (loadedLive = module),
    (error: unknown) => {
      loadingLive = null;
      throw error;
    },
  );
  return loadingLive;
}

function useHomeLive(): HomeLive | null {
  const [live, setLive] = useState<HomeLive | null>(() => loadedLive);
  useEffect(() => {
    if (loadedLive !== null) return;
    let alive = true;
    loadHomeLive().then(
      (module) => {
        if (alive) setLive(module);
      },
      (error: unknown) => console.warn("Чанк главной не загрузился:", error),
    );
    return () => {
      alive = false;
    };
  }, []);
  return live;
}

/**
 * Карусель главной (WP42) — с чанком главной после первого кадра. Пока он
 * едет, место держит заглушка той же высоты, что у самой карусели
 * (`home-carousel.tsx`). Гостю без входа карусели нет: слайды собирает
 * сервер по аккаунту. В низком ландшафте телефона под всё остальное
 * полторы сотни пикселей — там её тоже нет.
 */
function CarouselSlot(): ReactNode {
  const withAccount = useShell((state) => state.capabilities.auth !== undefined);
  const live = useHomeLive();
  if (!withAccount) return null;
  return (
    <div className="[@media(max-height:480px)]:hidden">
      {live === null ? (
        <div aria-hidden="true" className="mb-3">
          <div className="surface-sunken h-20 rounded-lg" />
          <div className="h-6" />
        </div>
      ) : (
        <live.HomeCarousel />
      )}
    </div>
  );
}

/**
 * Виджеты главной (WP42, часть 3) — тем же чанком. Заглушка — сетка без
 * готового к забору: рекорд во всю ширину и две пары плиток, высоты — из
 * токенов, как у самих виджетов (`home-widgets.tsx`). Гостю виджеты тоже
 * есть: рекорд — с устройства, остальные ведут на свои экраны.
 */
function WidgetsSlot(): ReactNode {
  const live = useHomeLive();
  if (live !== null) return <live.HomeWidgets />;
  return (
    <div aria-hidden="true" className="mb-3 grid grid-cols-2 gap-3">
      <div className="surface-sunken col-span-2 h-(--widget-hero-h) rounded-lg" />
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="surface-sunken h-(--widget-tile-h) rounded-lg" />
      ))}
    </div>
  );
}

/** Прерванный забег: сколько продержался и с чем — чтобы игрок узнал свой забег. */
function SavedRunCard(props: { saved: SavedRun }): ReactNode {
  const { summary } = props.saved;

  return (
    <div className="mb-3">
      <Card appearIndex={0} stripe="accent">
        <div className="flex items-center gap-3">
          <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
            <History size={24} />
          </span>
          <div className="min-w-0 flex-1">
            <span className="font-display text-xs font-semibold tracking-wide text-text-muted uppercase">
              {t("lobby.saved.title")}
            </span>
            <p className="font-display text-lg font-bold text-text tabular-nums">
              {t("lobby.saved.meta", { time: formatDuration(summary.survivalSec), level: summary.level })}
            </p>
          </div>
          <div className="flex shrink-0 -space-x-2">
            {summary.weapons.map((weapon) => (
              <ItemTile key={weapon.id} kind="weapon" id={weapon.id} size="s" />
            ))}
          </div>
        </div>
      </Card>
    </div>
  );
}

/**
 * Предзагрузка чанка движка из лобби, когда браузер простаивает
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
function usePreloadEngine(): void {
  useEffect(() => {
    if (typeof globalThis.requestIdleCallback === "function") {
      const id = globalThis.requestIdleCallback(() => preloadEverything(), {
        timeout: PRELOAD_DELAY_MS,
      });
      return () => globalThis.cancelIdleCallback(id);
    }
    // В Safari простоя не сообщают — ждём фиксированно.
    const timer = setTimeout(() => preloadEverything(), PRELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
}

/**
 * Движок и ленивые экраны — одним заходом: и то и другое игроку понадобится
 * через минуту, а сеть в лобби простаивает. Там же — SDK рекламных сетей для
 * учёта аудитории (Р78): своим чанком, первая загрузка за него не платит.
 */
function preloadEverything(): void {
  preloadRunEngine();
  preloadScreens();
  // Чанк не пришёл — как с экранами выше: следующий заход на главную попробует снова.
  import("../state/ad-networks")
    .then(async (module) => await module.prepareAdNetworks())
    .catch(() => undefined);
}
