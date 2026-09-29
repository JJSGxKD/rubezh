import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Lock, Wrench } from "lucide-react";
import type { DifficultyId } from "@bh/shared-types";
import { ACCOUNT_UNLOCKS, DIFFICULTIES, unlockLevelOf, unlocksAt, WEAPONS } from "@bh/core-game";
import { Button, Card, ContentColumn, Screen, SectionTitle, SegmentedControl } from "../design-system/components";
import { t } from "../i18n";
import { hasCheats, useDevMode } from "../state/dev-mode";
import { useMeta } from "../state/meta";
import { useNavigation } from "../state/navigation";
import { useProgress } from "../state/progress";
import { useRun } from "../state/run";
import { useShell } from "../state/shell";
import { useToolsAccess } from "../state/tools";
import { ItemTile } from "./item-icons";
import { DevSheetLazy } from "./run/dev-sheet-lazy";

/*
 * Выбор перед забегом — своим чанком (docs/27-design-system-and-app-shell.md
 * §3.4): после таблицы разблокировок (WP25) он заметно вырос, а первой
 * загрузке хватает лобби и выбора режима. Лобби подтягивает его в простое
 * вместе с остальными экранами, так что к нажатию «Бесконечный» он уже здесь.
 */

/**
 * Уровень, с которым пойдёт следующий забег (WP25): из подписанного снимка на
 * устройстве. Снимок читается лениво — модуль снаряжения не нужен первой
 * загрузке, — а до ответа экран считает уровень первым.
 */
function useRunLevel(): number {
  const runLevel = useProgress((state) => state.runLevel);
  useEffect(() => {
    if (runLevel !== null) return;
    import("../state/run-loadouts")
      .then(({ equippedLoadout, runLevelOf }) => {
        if (useProgress.getState().runLevel === null) useProgress.setState({ runLevel: runLevelOf(equippedLoadout()) });
      })
      .catch((error: unknown) => console.warn("Снимок снаряжения не загрузился:", error));
  }, [runLevel]);
  return runLevel ?? 1;
}

/**
 * Выбор перед забегом: сложность и стартовое оружие, последний выбор того и
 * другого запомнен (решение Р12 `docs/26-stage2-plan.md` §2). Стартовым
 * берётся любое открытое уровнем аккаунта; закрытое видно с уровнем, на
 * котором откроется (Р41, Р42).
 */
export function WeaponScreen(): ReactNode {
  const navigation = useNavigation();
  const meta = useMeta();
  const level = useRunLevel();
  const open = unlocksAt(ACCOUNT_UNLOCKS, level).weapons;
  const weapons = [...WEAPONS].sort((a, b) => (unlockLevelOf(ACCOUNT_UNLOCKS, "weapon", a.id) ?? 1) - (unlockLevelOf(ACCOUNT_UNLOCKS, "weapon", b.id) ?? 1));
  const selected = open.has(meta.lastWeaponId) ? meta.lastWeaponId : (weapons.find((weapon) => open.has(weapon.id))?.id ?? "");
  const access = useToolsAccess();
  const devArmed = useDevMode((state) => state.armed) && access.devMode;
  const devSettings = useDevMode((state) => state.settings);
  const [devOpen, setDevOpen] = useState(false);
  // С входом следующий шаг — бусты на забег (Р57): покупка идёт на сервер.
  // Без входа покупать нечем, и «В бой» остаётся здесь.
  const withAccount = useShell((state) => state.capabilities.auth !== undefined);

  const next = (): void => {
    // Запоминаем даже выбор по умолчанию: забег должен стартовать с
    // тем оружием, которое подсвечено на экране.
    meta.rememberWeapon(selected);
    if (withAccount) {
      navigation.push("boosts");
      return;
    }
    useRun.getState().intend({ kind: "new" });
    navigation.replace("run");
  };

  return (
    <>
    <Screen
      title={devArmed ? t("mode.dev") : t("weapon.select.screen")}
      onBack={() => navigation.pop()}
      footer={
        <Button size="l" block glow onClick={next}>
          {withAccount ? t("weapon.select.next") : t("weapon.select.start")}
        </Button>
      }
    >
      <ContentColumn>
        {devArmed ? (
          <div className="mt-2">
            <Card stripe="passive" onClick={() => setDevOpen(true)}>
              <div className="flex items-center gap-3">
                <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-passive/15 text-passive">
                  <Wrench size={20} />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="font-display text-base font-bold text-text">{t("dev.setup")}</span>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {hasCheats(devSettings)
                      ? devSettings.countInRating
                        ? t("dev.cheats.counted")
                        : t("dev.cheats.notCounted")
                      : t("dev.setup.clean")}
                  </p>
                </div>
                <ChevronRight size={18} className="shrink-0 text-text-disabled" />
              </div>
            </Card>
          </div>
        ) : null}
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
          {weapons.map((weapon, index) => {
            const unlocked = open.has(weapon.id);
            return (
              <Card
                key={weapon.id}
                appearIndex={index}
                stripe="weapon"
                selected={weapon.id === selected}
                disabled={!unlocked}
                {...(unlocked ? { onClick: () => meta.rememberWeapon(weapon.id) } : {})}
              >
                <div className="flex items-start gap-3 pr-7">
                  <ItemTile kind="weapon" id={weapon.id} />
                  <div className="min-w-0 flex-1">
                    <span className="font-display text-lg font-bold text-text">{t(weapon.nameKey)}</span>
                    <p className="mt-1 text-xs text-text-muted">{t(weapon.descriptionKey)}</p>
                    {unlocked ? null : (
                      <p className="mt-1.5 flex items-center gap-1 text-xs text-text-muted">
                        <Lock size={12} aria-hidden="true" />
                        {t("weapon.select.locked", { level: unlockLevelOf(ACCOUNT_UNLOCKS, "weapon", weapon.id) ?? 1 })}
                      </p>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </ContentColumn>
    </Screen>
    {devOpen ? <DevSheetLazy inRun={false} onClose={() => setDevOpen(false)} /> : null}
    </>
  );
}
