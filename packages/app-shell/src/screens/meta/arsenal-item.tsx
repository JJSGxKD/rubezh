import { useState, type ReactNode } from "react";
import { Button, Modal } from "../../design-system/components";
import { formatNumber, t } from "../../i18n";
import type { ItemAction, ItemView } from "../../state/items-api";
import { CostLabel, rarityName, slotIcon, slotName, statName, statValue, toneOf } from "./arsenal-parts";

/**
 * Лист предмета: свойства, мощь против надетого в том же слоте и операции.
 * Цены и значения посчитаны сервером — лист их только показывает.
 *
 * Разбор — в два нажатия: предмет пропадает навсегда, и случайный тап по
 * кнопке не должен стоить легендарного оружия.
 */
export function ItemSheet(props: {
  item: ItemView;
  /** надетое в том же слоте — для сравнения мощи; у надетого самого — `undefined` */
  worn: ItemView | undefined;
  busy: boolean;
  error: string | null;
  onAction: (action: ItemAction) => void;
  onClose: () => void;
}): ReactNode {
  const { item, worn } = props;
  const [rerolling, setRerolling] = useState(false);
  const [salvaging, setSalvaging] = useState(false);
  const delta = worn === undefined || worn.itemId === item.itemId ? null : item.power - worn.power;

  return (
    <Modal
      placement="bottom"
      title={slotName(item.slot)}
      icon={<span className={`inline-flex size-14 items-center justify-center rounded-lg ring-2 ${toneOf(item.rarity).tile}`}>{slotIcon(item.slot, 28)}</span>}
      onDismiss={props.onClose}
      footer={
        <div className="grid gap-2">
          {props.error === null ? null : (
            <p role="alert" className="text-center text-sm text-danger">
              {props.error}
            </p>
          )}
          <Button block disabled={props.busy} onClick={() => props.onAction({ kind: item.equipped ? "unequip" : "equip", itemId: item.itemId })}>
            {item.equipped ? t("arsenal.item.unequip") : t("arsenal.item.equip")}
          </Button>
          {item.upgrade === null ? <p className="text-center text-xs text-text-muted">{t("arsenal.item.maxLevel")}</p> : null}
          <div className={`grid gap-2 ${item.upgrade !== null && item.reroll !== null ? "grid-cols-2" : "grid-cols-1"}`}>
            {item.upgrade === null ? null : (
              <Button variant="secondary" block disabled={props.busy} onClick={() => props.onAction({ kind: "upgrade", itemId: item.itemId })}>
                <span className="flex flex-col items-center leading-tight">
                  {t("arsenal.item.upgrade")}
                  <CostLabel cost={item.upgrade} rarity={item.rarity} />
                </span>
              </Button>
            )}
            {item.reroll === null ? null : (
              <Button variant="secondary" block disabled={props.busy} onClick={() => setRerolling((value) => !value)}>
                <span className="flex flex-col items-center leading-tight">
                  {t("arsenal.item.reroll")}
                  <CostLabel cost={item.reroll} rarity={item.rarity} />
                </span>
              </Button>
            )}
          </div>
          <Button
            variant={salvaging ? "danger" : "ghost"}
            block
            disabled={props.busy}
            onClick={() => (salvaging ? props.onAction({ kind: "salvage", itemId: item.itemId }) : setSalvaging(true))}
          >
            {salvaging ? t("arsenal.item.salvageConfirm") : t("arsenal.item.salvage")} · {t("arsenal.item.salvageGain", { count: item.salvage })}
          </Button>
        </div>
      }
    >
      <p className="text-center text-sm">
        <span className={`font-semibold ${toneOf(item.rarity).text}`}>{rarityName(item.rarity)}</span>
        <span className="text-text-muted"> · {t("arsenal.level", { level: item.level })}</span>
      </p>
      <div className="surface-sunken mt-3 flex items-center justify-between rounded-lg px-3 py-2">
        <span className="text-xs text-text-muted">{t("arsenal.power")}</span>
        <span className="font-display text-lg font-bold tabular-nums text-text">{formatNumber(item.power)}</span>
      </div>
      {item.equipped ? <p className="mt-2 text-center text-xs font-semibold text-accent">{t("arsenal.item.equipped")}</p> : null}
      {delta === null ? null : (
        <p className={`mt-2 text-center text-xs font-semibold ${delta >= 0 ? "text-success" : "text-danger"}`}>
          {t("arsenal.item.powerDelta", { delta: `${delta >= 0 ? "+" : ""}${formatNumber(delta)}` })}
        </p>
      )}

      <h3 className="mt-4 text-xs font-semibold text-text-muted">{t("arsenal.item.main")}</h3>
      <StatRow stat={item.main.stat} value={item.main.value} />

      <h3 className="mt-3 text-xs font-semibold text-text-muted">{t("arsenal.item.extras")}</h3>
      {rerolling ? <p className="mb-1 text-xs text-text-muted">{t("arsenal.item.rerollPick")}</p> : null}
      {item.extras.length === 0 ? <p className="text-sm text-text-muted">{t("arsenal.item.noExtras")}</p> : null}
      <ul className="grid gap-1">
        {item.extras.map((extra, index) => (
          <li key={`${extra.stat}-${index}`}>
            {rerolling ? (
              <button
                type="button"
                disabled={props.busy}
                onClick={() => {
                  setRerolling(false);
                  props.onAction({ kind: "reroll", itemId: item.itemId, index });
                }}
                className="w-full rounded-md ring-1 ring-accent/60 active:scale-[0.98]"
              >
                <StatRow stat={extra.stat} value={extra.value} />
              </button>
            ) : (
              <StatRow stat={extra.stat} value={extra.value} />
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function StatRow(props: { stat: string; value: number }): ReactNode {
  return (
    <div className="flex items-center justify-between px-2 py-1.5 text-sm">
      <span className="text-text">{statName(props.stat)}</span>
      <span className="font-semibold tabular-nums text-success">{statValue(props.stat, props.value)}</span>
    </div>
  );
}
