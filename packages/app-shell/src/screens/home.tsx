import { useEffect, type ReactNode } from "react";
import { Gem, Infinity as InfinityIcon, Lock, Map as MapIcon, Play, Settings, Trophy, User } from "lucide-react";
import { WEAPONS } from "@bh/core-game";
import {
  Badge,
  Button,
  Card,
  ContentColumn,
  CurrencyChip,
  Emblem,
  FullscreenButton,
  IconButton,
  Screen,
  Stat,
  Wordmark,
} from "../design-system/components";
import { formatDuration, t } from "../i18n";
import { useMeta } from "../state/meta";
import { useNavigation } from "../state/navigation";
import { preloadRunEngine } from "../state/run";
import { ItemTile } from "./item-icons";

/**
 * Через сколько после захода в лобби начинается предзагрузка движка, если
 * браузер не сообщает о простое сам. Сразу нельзя: первые секунды после
 * запуска сеть и поток нужны самой главной.
 */
const PRELOAD_DELAY_MS = 1500;

/**
 * Лобби. Кнопка «Играть» — единственное настоящее действие этапа 2; превью
 * персонажа и валюта нарисованы, но ведут в заглушки
 * (docs/27-design-system-and-app-shell.md §6).
 */
export function LobbyScreen(): ReactNode {
  const navigation = useNavigation();
  const meta = useMeta();
  usePreloadEngine();

  return (
    <Screen
      actions={
        <>
          <CurrencyChip icon={<Gem size={14} />} value="0" />
          <FullscreenButton />
          <IconButton label={t("profile.title")} onClick={() => navigation.push("profile")}>
            <User size={20} />
          </IconButton>
          <IconButton label={t("settings.title")} onClick={() => navigation.push("settings")}>
            <Settings size={20} />
          </IconButton>
        </>
      }
      footer={
        <Button size="l" block glow onClick={() => navigation.push("mode")}>
          <Play size={22} fill="currentColor" />
          {t("lobby.play")}
        </Button>
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

        <Card appearIndex={1}>
          <div className="flex items-center gap-4">
            <span className="inline-flex size-12 shrink-0 items-center justify-center rounded-md bg-elite/15 text-elite">
              <Trophy size={24} />
            </span>
            <div className="min-w-0 flex-1">
              <Stat
                label={t("lobby.record")}
                value={meta.bestSurvivalSec > 0 ? formatDuration(meta.bestSurvivalSec) : "—"}
                large
                tone={meta.bestSurvivalSec > 0 ? "accent" : undefined}
              />
              {meta.bestSurvivalSec > 0 ? null : (
                <p className="mt-0.5 text-xs text-text-muted">{t("lobby.noRecord")}</p>
              )}
            </div>
            <Badge>{t("lobby.runs", { count: meta.runs })}</Badge>
          </div>
        </Card>
      </ContentColumn>
    </Screen>
  );
}

/**
 * Предзагрузка чанка движка из лобби, когда браузер простаивает
 * (docs/27-design-system-and-app-shell.md §3.4).
 */
function usePreloadEngine(): void {
  useEffect(() => {
    if (typeof globalThis.requestIdleCallback === "function") {
      const id = globalThis.requestIdleCallback(() => preloadRunEngine(), {
        timeout: PRELOAD_DELAY_MS,
      });
      return () => globalThis.cancelIdleCallback(id);
    }
    // В Safari простоя не сообщают — ждём фиксированно.
    const timer = setTimeout(() => preloadRunEngine(), PRELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
}

/** Выбор режима. «Бесконечный» рабочий, «Кампания» — заглушка. */
export function ModeScreen(): ReactNode {
  const navigation = useNavigation();

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
          <Card appearIndex={1} disabled>
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
 * Выбор стартового оружия: три карточки, последний выбор запомнен
 * (решение Р12 `docs/26-stage2-plan.md` §2).
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
      title={t("weapon.select.title")}
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
            navigation.replace("run");
          }}
        >
          {t("weapon.select.start")}
        </Button>
      }
    >
      <ContentColumn>
        <p className="mt-2 mb-3 text-xs text-text-muted">{t("weapon.select.hint")}</p>
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
