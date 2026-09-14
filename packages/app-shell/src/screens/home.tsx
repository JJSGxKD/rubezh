import { useEffect, useState, type ReactNode } from "react";
import {
  BookOpen,
  CalendarCheck,
  ChevronRight,
  Flame,
  History,
  Infinity as InfinityIcon,
  LoaderPinwheel,
  Lock,
  Map as MapIcon,
  Play,
  Trophy,
} from "lucide-react";
import type { DifficultyId } from "@bh/shared-types";
import { DIFFICULTIES, WEAPONS } from "@bh/core-game";
import {
  Badge,
  Button,
  Card,
  ContentColumn,
  Emblem,
  Modal,
  Screen,
  SectionTitle,
  SegmentedControl,
  Stat,
  Wordmark,
} from "../design-system/components";
import { formatDuration, t } from "../i18n";
import { useMeta } from "../state/meta";
import { useNavigation } from "../state/navigation";
import { usePlaytestAccess } from "../state/playtest";
import { preloadScreens } from "../app/lazy-screens";
import { preloadRunEngine, useRun } from "../state/run";
import { useSavedRun, type SavedRun } from "../state/run-save";
import { ItemTile } from "./item-icons";

/**
 * Через сколько после захода в лобби начинается предзагрузка движка, если
 * браузер не сообщает о простое сам. Сразу нельзя: первые секунды после
 * запуска сеть и поток нужны самой главной.
 */
const PRELOAD_DELAY_MS = 1500;

/**
 * Лобби. Кнопка «Играть» — единственное настоящее действие этапа 2; валюта,
 * награда дня и колесо нарисованы, но ведут в заглушки
 * (docs/27-design-system-and-app-shell.md §6).
 */
export function LobbyScreen(): ReactNode {
  const navigation = useNavigation();
  const meta = useMeta();
  const saved = useSavedRun((state) => state.saved);
  const [confirmingNewRun, setConfirmingNewRun] = useState(false);
  const best = meta.best[meta.lastDifficultyId];
  usePreloadEngine();

  return (
    <div className="relative h-full">
    <Screen
      footer={
        saved === null ? (
          <Button size="l" block glow onClick={() => navigation.push("mode")}>
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
                useRun.getState().prepareResume(saved);
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
        {/* В ландшафте телефона под контент остаётся полторы сотни пикселей:
            знак и слоган уходят, остаются имя и рекорд (§5.3). */}
        <div className="mt-6 mb-8 flex flex-col items-center gap-3 text-center landscape:mt-1 landscape:mb-3">
          <span className="landscape:hidden">
            <Emblem size={104} animated />
          </span>
          <Wordmark size="l" />
          <p className="max-w-[300px] text-sm text-text-muted landscape:hidden">{t("lobby.tagline")}</p>
        </div>

        {saved === null ? null : <SavedRunCard saved={saved} />}

        <Card appearIndex={1}>
          <div className="flex items-center gap-4">
            <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-md bg-elite/15 text-elite">
              <Trophy size={24} />
            </span>
            <div className="min-w-0 flex-1">
              {/* Рекорд — на той сложности, что выбрана сейчас: время на разных
                  сложностях несравнимо, и общий рекорд обманывал бы. */}
              <Stat
                label={t("lobby.record.on", { difficulty: t(`difficulty.${meta.lastDifficultyId}.name`) })}
                value={best > 0 ? formatDuration(best) : "—"}
                large
                tone={best > 0 ? "accent" : undefined}
              />
              {best > 0 ? null : (
                <p className="mt-0.5 text-xs text-text-muted">{t("lobby.noRecord")}</p>
              )}
            </div>
            <Badge>{t("lobby.runs", { count: meta.runs })}</Badge>
          </div>
        </Card>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <LobbyTile
            appearIndex={2}
            tone="accent"
            icon={<CalendarCheck size={22} />}
            title={t("lobby.daily")}
            hint={t("lobby.daily.hint")}
            onClick={() => navigation.push("daily")}
          />
          <LobbyTile
            appearIndex={3}
            tone="info"
            icon={<LoaderPinwheel size={22} />}
            title={t("lobby.wheel")}
            hint={t("lobby.wheel.hint")}
            onClick={() => navigation.push("wheel")}
          />
        </div>

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
                navigation.push("mode");
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
 * Плитка быстрого раздела лобби: награда дня, колесо. Точка зовёт зайти — как
 * на вкладках нижней панели.
 */
function LobbyTile(props: {
  appearIndex: number;
  tone: "accent" | "info";
  icon: ReactNode;
  title: string;
  hint: string;
  onClick(): void;
}): ReactNode {
  return (
    <Card appearIndex={props.appearIndex} onClick={props.onClick}>
      <span aria-hidden="true" className="absolute top-2.5 right-2.5 inline-flex size-2.5">
        <span className="absolute inset-0 animate-ping-dot rounded-full bg-accent" />
        <span className="relative size-full rounded-full bg-accent" />
      </span>
      {/* Значок над подписью, а не сбоку: в половине ширины телефона рядом со
          значком «Колесо удачи» переносилось на две строки. В ландшафте места
          хватает — значок возвращается в строку. */}
      <div className="flex flex-col items-start gap-2 landscape:flex-row landscape:items-center landscape:gap-3">
        <span
          className={[
            "inline-flex size-10 shrink-0 items-center justify-center rounded-md",
            props.tone === "accent" ? "bg-accent/15 text-accent" : "bg-info/15 text-info",
          ].join(" ")}
        >
          {props.icon}
        </span>
        <span className="min-w-0">
          <span className="block font-display text-sm font-bold text-text">{props.title}</span>
          <span className="mt-0.5 block text-xs text-text-muted">{props.hint}</span>
        </span>
      </div>
    </Card>
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
 * через минуту, а сеть в лобби простаивает.
 */
function preloadEverything(): void {
  preloadRunEngine();
  preloadScreens();
}

/** Выбор режима. «Бесконечный» рабочий, «Кампания» — заглушка. */
export function ModeScreen(): ReactNode {
  const navigation = useNavigation();
  // Стресс-тест открыт всем на плейтесте и команде вне его: правило решает
  // сервер (docs/28-diagnostics.md §2.3), здесь только не показываем лишнего.
  const access = usePlaytestAccess();

  return (
    <Screen title={t("mode.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <div className="mt-2 grid gap-3">
          <Card appearIndex={0} stripe="accent" onClick={() => navigation.push("weapon")}>
            <div className="flex items-center gap-4">
              <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent">
                <InfinityIcon size={26} />
              </span>
              <div className="min-w-0 flex-1">
                <span className="font-display text-lg font-bold text-text">{t("mode.endless")}</span>
                <p className="mt-1 text-xs text-text-muted">{t("mode.endless.description")}</p>
              </div>
            </div>
          </Card>
          {access.stressTest ? (
            <Card appearIndex={1} stripe="info" onClick={() => navigation.push("stress")}>
              <div className="flex items-center gap-4">
                <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-md bg-info/15 text-info">
                  <Flame size={24} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-lg font-bold text-text">{t("mode.stress")}</span>
                    <Badge tone="info">{t("mode.stress.badge")}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-text-muted">{t("mode.stress.description")}</p>
                </div>
              </div>
            </Card>
          ) : null}
          <Card appearIndex={2} disabled>
            <div className="flex items-center gap-4">
              <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-md bg-surface-raised text-text-muted">
                <MapIcon size={24} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-display text-lg font-bold text-text">{t("mode.campaign")}</span>
                  <Badge tone="warning">
                    <Lock size={12} />
                    {t("app.inDevelopment")}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-text-muted">{t("mode.campaign.description")}</p>
              </div>
            </div>
          </Card>
        </div>
      </ContentColumn>
    </Screen>
  );
}

/**
 * Выбор перед забегом: сложность и стартовое оружие, последний выбор того и
 * другого запомнен (решение Р12 `docs/26-stage2-plan.md` §2).
 */
export function WeaponScreen(): ReactNode {
  const navigation = useNavigation();
  const meta = useMeta();
  const starting = WEAPONS.filter((weapon) => weapon.starting === true);
  const selected = starting.some((weapon) => weapon.id === meta.lastWeaponId)
    ? meta.lastWeaponId
    : (starting[0]?.id ?? "");

  return (
    <Screen
      title={t("weapon.select.screen")}
      onBack={() => navigation.pop()}
      footer={
        <Button
          size="l"
          block
          glow
          onClick={() => {
            // Запоминаем даже выбор по умолчанию: забег должен стартовать с
            // тем оружием, которое подсвечено на экране.
            meta.rememberWeapon(selected);
            useRun.getState().prepareResume(null);
            navigation.replace("run");
          }}
        >
          {t("weapon.select.start")}
        </Button>
      }
    >
      <ContentColumn>
        <SectionTitle>{t("difficulty.title")}</SectionTitle>
        <SegmentedControl
          label={t("difficulty.title")}
          activeId={meta.lastDifficultyId}
          onSelect={(id) => meta.rememberDifficulty(id as DifficultyId)}
          items={DIFFICULTIES.map((difficulty) => ({ id: difficulty.id, label: t(difficulty.nameKey) }))}
        />
        <p className="mt-2 text-xs text-text-muted">{t(`difficulty.${meta.lastDifficultyId}.description`)}</p>

        <SectionTitle>{t("weapon.select.title")}</SectionTitle>
        <p className="mb-3 text-xs text-text-muted">{t("weapon.select.hint")}</p>
        <div className="grid gap-3 landscape:grid-cols-3">
          {starting.map((weapon, index) => (
            <Card
              key={weapon.id}
              appearIndex={index}
              stripe="weapon"
              selected={weapon.id === selected}
              onClick={() => meta.rememberWeapon(weapon.id)}
            >
              <div className="flex items-start gap-3 pr-7">
                <ItemTile kind="weapon" id={weapon.id} />
                <div className="min-w-0 flex-1">
                  <span className="font-display text-lg font-bold text-text">{t(weapon.nameKey)}</span>
                  <p className="mt-1 text-xs text-text-muted">{t(weapon.descriptionKey)}</p>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </ContentColumn>
    </Screen>
  );
}
