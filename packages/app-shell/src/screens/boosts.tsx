import { useCallback, useState, type ReactNode } from "react";
import { Button, ContentColumn, Screen } from "../design-system/components";
import { t } from "../i18n";
import "../i18n/boosts";
import { buyBoosts, type BoostCatalog } from "../state/boosts-api";
import { createId } from "../state/ids";
import { useNavigation } from "../state/navigation";
import { useRun } from "../state/run";
import { BoostPicker } from "./boost-picker";

/**
 * Бусты на забег — отдельный шаг после выбора оружия (`35-stage4-plan.md`,
 * Р57, Р39): выбор «как играть» и покупка усиления — разные решения, и в
 * одном экране они смешивались. Шаг есть только с входом: бусты покупаются
 * на сервере.
 *
 * Покупка — на «В бой»: id забега заводит оболочка, и итог придёт с ним же.
 * Не купилось — игрок остаётся здесь и видит причину.
 */
export function BoostsScreen(): ReactNode {
  const navigation = useNavigation();
  const [boosts, setBoosts] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<BoostCatalog | null>(null);
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const onCatalog = useCallback((next: BoostCatalog | null) => setCatalog(next), []);

  const toRun = (bought?: { runId: string; ids: string[] }): void => {
    useRun.getState().intend(bought === undefined ? { kind: "new" } : { kind: "new", boosts: bought });
    // Выбор оружия и бусты уходят из стека вместе: назад из забега — к режиму.
    navigation.pop();
    navigation.replace("run");
  };

  const start = async (withBoosts: boolean): Promise<void> => {
    if (!withBoosts || boosts.length === 0 || catalog === null) {
      toRun();
      return;
    }
    setBuying(true);
    setBuyError(null);
    const bought = await buyBoosts(createId(), boosts, catalog);
    setBuying(false);
    if (!bought.ok) {
      setBuyError(bought.code === "insufficient_funds" ? "boosts.error.funds" : bought.failure === "offline" ? "boosts.error.offline" : "boosts.error.generic");
      return;
    }
    toRun({ runId: bought.runId, ids: bought.boosts });
  };

  return (
    <Screen
      title={t("boosts.title")}
      onBack={() => navigation.pop()}
      footer={
        <div className="grid gap-2">
          <Button size="l" block glow loading={buying} disabled={buying} onClick={() => void start(true)}>
            {t("boosts.start")}
          </Button>
          {boosts.length === 0 ? null : (
            <Button variant="ghost" block disabled={buying} onClick={() => void start(false)}>
              {t("boosts.skip")}
            </Button>
          )}
        </div>
      }
    >
      <ContentColumn>
        <BoostPicker selected={boosts} onChange={setBoosts} onCatalog={onCatalog} error={buyError} heading={false} />
      </ContentColumn>
    </Screen>
  );
}
