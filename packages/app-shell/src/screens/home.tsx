import type { ReactNode } from "react";
import { Gem, Play, Settings, User } from "lucide-react";
import { WEAPONS } from "@bh/core-game";
import {
  Button,
  Card,
  ContentColumn,
  CurrencyChip,
  IconButton,
  Screen,
  Stat,
} from "../design-system/components";
import { formatDuration, t } from "../i18n";
import { useMeta } from "../state/meta";
import { useNavigation } from "../state/navigation";

/**
 * Лобби. Кнопка «Играть» — единственное настоящее действие этапа 2; превью
 * персонажа и валюта нарисованы, но ведут в заглушки
 * (docs/27-design-system-and-app-shell.md §6).
 */
export function LobbyScreen(): ReactNode {
  const navigation = useNavigation();
  const meta = useMeta();

  return (
    <Screen
      actions={
        <>
          <CurrencyChip icon={<Gem size={14} />} value="0" />
          <IconButton label={t("profile.title")} onClick={() => navigation.push("profile")}>
            <User size={20} />
          </IconButton>
          <IconButton label={t("settings.title")} onClick={() => navigation.push("settings")}>
            <Settings size={20} />
          </IconButton>
        </>
      }
      footer={
        <Button size="l" block onClick={() => navigation.push("mode")}>
          <Play size={20} />
          {t("lobby.play")}
        </Button>
      }
    >
      <ContentColumn>
        <h1 className="mt-6 mb-6 text-center font-display text-3xl text-text">{t("app.name")}</h1>

        <Card>
          <div className="flex items-center justify-between gap-4">
            <Stat
              label={t("lobby.record")}
              value={
                meta.bestSurvivalSec > 0
                  ? formatDuration(meta.bestSurvivalSec)
                  : t("lobby.noRecord")
              }
              large
            />
            <span className="text-xs text-text-muted">
              {t("lobby.runs", { count: meta.runs })}
            </span>
          </div>
        </Card>
      </ContentColumn>
    </Screen>
  );
}

/** Выбор режима. «Бесконечный» рабочий, «Кампания» — заглушка. */
export function ModeScreen(): ReactNode {
  const navigation = useNavigation();

  return (
    <Screen title={t("mode.title")} onBack={() => navigation.pop()}>
      <ContentColumn>
        <div className="mt-2 grid gap-3">
          <Card onClick={() => navigation.push("weapon")}>
            <span className="font-display text-base text-text">{t("mode.endless")}</span>
            <p className="mt-1 text-xs text-text-muted">{t("mode.endless.description")}</p>
          </Card>
          <Card disabled>
            <div className="flex items-center justify-between gap-2">
              <span className="font-display text-base text-text">{t("mode.campaign")}</span>
              <span className="text-xs text-warning">{t("app.inDevelopment")}</span>
            </div>
            <p className="mt-1 text-xs text-text-muted">{t("mode.campaign.description")}</p>
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
          {starting.map((weapon) => (
            <Card
              key={weapon.id}
              selected={weapon.id === selected}
              onClick={() => meta.rememberWeapon(weapon.id)}
            >
              <span className="font-display text-base text-text">{t(weapon.nameKey)}</span>
              <p className="mt-1 text-xs text-text-muted">{t(weapon.descriptionKey)}</p>
            </Card>
          ))}
        </div>
      </ContentColumn>
    </Screen>
  );
}
