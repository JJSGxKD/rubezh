import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Lock, Wrench } from "lucide-react";
import type { DifficultyId } from "@bh/shared-types";
import { ACCOUNT_UNLOCKS, DIFFICULTIES, unlockLevelOf, unlocksAt, WEAPONS } from "@bh/core-game";
import { Button, Card, Modal, SegmentedControl } from "../design-system/components";
import { CoinIcon, GemIcon } from "../design-system/components/CurrencyIcons";
import { formatNumber, t } from "../i18n";
import "../i18n/boosts";
import { buyBoosts, type BoostCatalog } from "../state/boosts-api";
import { hasCheats, useDevMode } from "../state/dev-mode";
import { createId } from "../state/ids";
import { useMeta } from "../state/meta";
import { useNavigation } from "../state/navigation";
import { useProgress } from "../state/progress";
import { useRun } from "../state/run";
import { useShell } from "../state/shell";
import { useToolsAccess } from "../state/tools";
import { BoostPicker } from "./boost-picker";
import { ItemIcon } from "./item-icons";
import { PickTile } from "./pick-tile";
import { boostCost, preRunModes, type PreRunMode } from "./pre-run-rules";
import { DevSheetLazy } from "./run/dev-sheet-lazy";

/*
 * Окно «Перед забегом» — своим чанком (docs/27-design-system-and-app-shell.md
 * §3.4): первой загрузке хватает лобби, а лист с оружием, бустами и каталогом
 * ей не нужен. Лобби подтягивает его в простое вместе с остальными экранами,
 * так что к нажатию «Играть» он уже здесь.
 */

/**
 * Уровень, с которым пойдёт следующий забег (WP25): из подписанного снимка на
 * устройстве. Снимок читается лениво — модуль снаряжения не нужен первой
 * загрузке, — а до ответа лист считает уровень первым.
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

const MODE_LABEL: Record<PreRunMode, string> = {
  endless: "mode.endless",
  dev: "prerun.mode.dev",
  stress: "prerun.mode.stress",
};

/**
 * Сложность, стартовое оружие и бусты одним листом поверх главной
 * (docs/35-stage4-plan.md, Р88, меняет Р57): «Играть» и сразу «В бой».
 * Последний выбор сложности и оружия запомнен (Р12), закрытое оружие видно с
 * уровнем, на котором откроется (Р41, Р42). Бусты покупаются на сервере, так
 * что есть только с входом; не купились — лист остаётся открытым с причиной.
 */
export function PreRunSheet(props: { onClose: () => void }): ReactNode {
  const { onClose } = props;
  const navigation = useNavigation();
  const meta = useMeta();
  const level = useRunLevel();
  const access = useToolsAccess();
  const modes = preRunModes(access);
  const [chosenMode, setMode] = useState<PreRunMode>("endless");
  const mode = modes.includes(chosenMode) ? chosenMode : "endless";
  const devSettings = useDevMode((state) => state.settings);
  const [devOpen, setDevOpen] = useState(false);
  const withAccount = useShell((state) => state.capabilities.auth !== undefined);

  const [boosts, setBoosts] = useState<string[]>([]);
  const [touched, setTouched] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<BoostCatalog | null>(null);
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const onCatalog = useCallback((next: BoostCatalog | null) => setCatalog(next), []);

  // Лист всегда открывается на обычном забеге: режим разработчика включается
  // вкладкой и не залипает с прошлого раза.
  useEffect(() => {
    useDevMode.getState().arm(false);
  }, []);

  const open = unlocksAt(ACCOUNT_UNLOCKS, level).weapons;
  const weapons = [...WEAPONS].sort((a, b) => (unlockLevelOf(ACCOUNT_UNLOCKS, "weapon", a.id) ?? 1) - (unlockLevelOf(ACCOUNT_UNLOCKS, "weapon", b.id) ?? 1));
  const selectedId = open.has(meta.lastWeaponId) ? meta.lastWeaponId : (weapons.find((weapon) => open.has(weapon.id))?.id ?? "");
  const selectedWeapon = weapons.find((weapon) => weapon.id === selectedId);
  const cost = catalog === null ? {} : boostCost(boosts, catalog.boosts);

  const start = async (): Promise<void> => {
    // Запоминаем даже выбор по умолчанию: забег должен стартовать с тем
    // оружием, которое подсвечено в листе.
    meta.rememberWeapon(selectedId);
    let bought: { runId: string; ids: string[] } | undefined;
    if (boosts.length > 0 && catalog !== null) {
      setBuying(true);
      setBuyError(null);
      const result = await buyBoosts(createId(), boosts, catalog);
      setBuying(false);
      if (!result.ok) {
        setBuyError(result.code === "insufficient_funds" ? "boosts.error.funds" : result.failure === "offline" ? "boosts.error.offline" : "boosts.error.generic");
        return;
      }
      bought = { runId: result.runId, ids: result.boosts };
    }
    useRun.getState().intend(bought === undefined ? { kind: "new" } : { kind: "new", boosts: bought });
    // Лист закрывается, и забег встаёт над главной: назад из него — на главную.
    onClose();
    navigation.push("run");
  };

  return (
    <>
      <Modal
        title={t("weapon.select.screen")}
        placement="bottom"
        // Пока идёт покупка, лист не закрывается: списанные бусты остались бы без забега.
        onDismiss={buying ? () => undefined : onClose}
        {...(mode === "stress"
          ? {}
          : {
              footer: (
                <>
                  {buyError === null ? null : (
                    <p role="alert" className="text-center text-sm text-danger">
                      {t(buyError)}
                    </p>
                  )}
                  <Button size="l" block glow loading={buying} disabled={buying} onClick={() => void start()}>
                    <span className="flex flex-col items-center gap-1 leading-none">
                      <span>{t("boosts.start")}</span>
                      {cost.coins === undefined && cost.gems === undefined ? null : (
                        <span className="flex items-center gap-1.5 text-[11.5px] font-semibold tracking-normal normal-case">
                          {t("prerun.cost")}
                          {cost.coins === undefined ? null : (
                            <span className="inline-flex items-center gap-1 tabular-nums">
                              <CoinIcon size={12} />
                              {formatNumber(cost.coins)}
                            </span>
                          )}
                          {cost.gems === undefined ? null : (
                            <span className="inline-flex items-center gap-1 tabular-nums">
                              <GemIcon size={12} />
                              {formatNumber(cost.gems)}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </Button>
                </>
              ),
            })}
      >
        {/* Прокручивается только содержимое: шапка листа и кнопка «В бой» остаются
            на месте, а сам лист не уезжает под шапку приложения. Запас — высота
            шапки Modal, подвала с кнопкой и нижней панели. */}
        <div className="grid max-h-[max(10rem,calc(100dvh-20rem-var(--app-inset-top)-var(--app-inset-bottom)))] gap-1.5 overflow-y-auto overscroll-contain">
          {modes.length > 0 ? (
            <SegmentedControl
              label={t("weapon.select.screen")}
              activeId={mode}
              onSelect={(id) => {
                setMode(id as PreRunMode);
                useDevMode.getState().arm(id === "dev");
              }}
              items={modes.map((id) => ({ id, label: t(MODE_LABEL[id]) }))}
            />
          ) : null}

          {mode === "stress" ? (
            <>
              <p className="mt-2 text-xs text-text-muted">{t("mode.stress.description")}</p>
              <Button
                size="l"
                block
                onClick={() => {
                  onClose();
                  navigation.push("stress");
                }}
              >
                {t("prerun.stress.open")}
              </Button>
            </>
          ) : (
            <>
              {mode === "dev" ? (
                <Card stripe="passive" onClick={() => setDevOpen(true)}>
                  <div className="flex items-center gap-3">
                    <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-passive/15 text-passive">
                      <Wrench size={20} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="font-display text-base font-bold text-text">{t("dev.setup")}</span>
                      <p className="mt-0.5 text-xs text-text-muted">
                        {hasCheats(devSettings) ? (devSettings.countInRating ? t("dev.cheats.counted") : t("dev.cheats.notCounted")) : t("dev.setup.clean")}
                      </p>
                    </div>
                    <ChevronRight size={18} className="shrink-0 text-text-disabled" />
                  </div>
                </Card>
              ) : null}

              <SegmentedControl
                label={t("difficulty.title")}
                activeId={meta.lastDifficultyId}
                onSelect={(id) => meta.rememberDifficulty(id as DifficultyId)}
                items={DIFFICULTIES.map((difficulty) => ({ id: difficulty.id, label: t(difficulty.nameKey) }))}
              />
              <p className="text-xs text-text-muted">{t(`difficulty.${meta.lastDifficultyId}.description`)}</p>

              <h2 className="mt-2 font-display text-xs font-semibold tracking-widest text-text-muted uppercase">{t("weapon.select.title")}</h2>
              <ul className="grid grid-cols-3 gap-1.5">
                {weapons.map((weapon) => {
                  const unlocked = open.has(weapon.id);
                  return (
                    <li key={weapon.id} className="min-w-0">
                      <PickTile
                        icon={<ItemIcon kind="weapon" id={weapon.id} size={16} />}
                        tone="weapon"
                        name={t(weapon.nameKey)}
                        selected={weapon.id === selectedId}
                        locked={!unlocked}
                        {...(unlocked
                          ? { onClick: () => meta.rememberWeapon(weapon.id) }
                          : {
                              corner: (
                                <>
                                  <Lock size={11} aria-hidden="true" className="max-[359px]:hidden" />
                                  {t("weapon.select.locked.short", { level: unlockLevelOf(ACCOUNT_UNLOCKS, "weapon", weapon.id) ?? 1 })}
                                </>
                              ),
                            })}
                      />
                    </li>
                  );
                })}
              </ul>
              {selectedWeapon === undefined ? null : (
                <div className="surface-sunken rounded-md px-2.5 py-2 text-xs leading-snug text-text-muted">
                  <b className="mr-1.5 font-display text-[13px] font-normal text-text">{t(selectedWeapon.nameKey)}</b>
                  {t(selectedWeapon.descriptionKey)}
                </div>
              )}

              {withAccount ? <BoostPicker selected={boosts} touched={touched} onChange={setBoosts} onTouch={setTouched} onCatalog={onCatalog} /> : null}
            </>
          )}
        </div>
      </Modal>
      {devOpen ? <DevSheetLazy inRun={false} onClose={() => setDevOpen(false)} /> : null}
    </>
  );
}
