import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowDownUp, Combine, Package, Swords } from "lucide-react";
import {
  Button,
  ContentColumn,
  ErrorState,
  PageTitle,
  Screen,
  SectionTitle,
  StubNotice,
} from "../../design-system/components";
import { formatNumber, hasTranslation, t } from "../../i18n";
import "../../i18n/arsenal";
import type { ApiFailure } from "../../state/api-request";
import { useItems } from "../../state/items";
import {
  loadInventory,
  runItemAction,
  type ItemAction,
  type ItemView,
} from "../../state/items-api";
import { useSession } from "../../state/session";
import { ItemSheet } from "./arsenal-item";
import {
  CostLabel,
  EquipSlot,
  ItemTile,
  LEFT_SLOTS,
  RARITIES,
  RIGHT_SLOTS,
  rarityName,
  rarityRank,
  toneOf,
} from "./arsenal-parts";

/**
 * «Арсенал» — снаряжение персонажа (docs/35-stage4-plan.md §3.4, WP7).
 *
 * Персонаж в центре, шесть слотов вокруг, мощь надетого, инвентарь с
 * редкостью. Всё — с сервера: значения, мощь и цены он присылает
 * посчитанными, а результат каждой операции решает сам. После операции
 * арсенал, снимок надетого для следующего забега и кошелёк перечитываются.
 *
 * Сундуков со случайным снаряжением за деньги нет: предметы выпадают за игру
 * (docs/03-notes-and-risks.md).
 */

type Status = "loading" | "ready" | "failed" | "disabled";
type Sort = "rarity" | "new";

const MERGE_COUNT = 3;

export function ArsenalScreen(): ReactNode {
  const inventory = useItems((state) => state.inventory);
  const session = useSession((state) => state.status);
  const [status, setStatus] = useState<Status>(
    inventory === null ? "loading" : "ready",
  );
  const [sort, setSort] = useState<Sort>("rarity");
  const [merging, setMerging] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    const failure = await loadInventory();
    setStatus(
      failure === null
        ? "ready"
        : failure === "disabled"
          ? "disabled"
          : "failed",
    );
  };

  // Вход наладился — арсенал загружается заново, как профиль.
  useEffect(() => {
    void load();
  }, [session === "ready"]);

  const items = inventory?.items ?? [];
  const worn = useMemo(
    () =>
      new Map(
        items.filter((item) => item.equipped).map((item) => [item.slot, item]),
      ),
    [items],
  );
  const bag = useMemo(
    () =>
      sorted(
        items.filter((item) => !item.equipped),
        sort,
      ),
    [items, sort],
  );
  const open =
    openId === null ? undefined : items.find((item) => item.itemId === openId);
  const mergeRarity =
    picked.length === 0
      ? null
      : (items.find((item) => item.itemId === picked[0])?.rarity ?? null);
  const mergeCost =
    mergeRarity === null ? undefined : inventory?.merge[mergeRarity];

  const act = async (action: ItemAction): Promise<void> => {
    setBusy(true);
    setError(null);
    const result = await runItemAction(action);
    setBusy(false);
    if (!result.ok) {
      setError(errorText(result.failure, result.code));
      return;
    }
    if (action.kind === "salvage") setOpenId(null);
    if (action.kind === "merge") {
      setMerging(false);
      setPicked([]);
    }
  };

  const press = (item: ItemView): void => {
    if (!merging) {
      setError(null);
      setOpenId(item.itemId);
      return;
    }
    setPicked((current) => {
      if (current.includes(item.itemId))
        return current.filter((id) => id !== item.itemId);
      if (
        current.length >= MERGE_COUNT ||
        !mergeable(item, current, items, inventory?.merge)
      )
        return current;
      return [...current, item.itemId];
    });
  };

  if (status === "disabled") {
    return (
      <Screen>
        <ContentColumn>
          <PageTitle>{t("arsenal.title")}</PageTitle>
          <StubNotice text={t("arsenal.disabled")} />
        </ContentColumn>
      </Screen>
    );
  }

  if (status === "failed" && inventory === null) {
    return (
      <Screen>
        <ContentColumn>
          <PageTitle>{t("arsenal.title")}</PageTitle>
          <ErrorState text={t("arsenal.failed")} onRetry={() => void load()} />
        </ContentColumn>
      </Screen>
    );
  }

  return (
    <>
      <Screen>
        <ContentColumn>
          <PageTitle>{t("arsenal.title")}</PageTitle>

          <div className="mt-4 grid grid-cols-2 gap-2">
            <StatChip
              icon={<Swords size={18} aria-hidden="true" />}
              label={t("arsenal.power")}
              value={formatNumber(inventory?.power ?? 0)}
            />
            <StatChip
              icon={<Package size={18} aria-hidden="true" />}
              label={t("arsenal.capacity")}
              value={t("arsenal.capacityValue", {
                count: items.length,
                capacity: inventory?.capacity ?? 0,
              })}
            />
          </div>

          <div className="surface-card relative mt-3 grid grid-cols-[auto_1fr_auto] items-center gap-3 overflow-hidden rounded-xl p-3">
            <span
              aria-hidden="true"
              className="halo-accent pointer-events-none absolute inset-x-8 top-1/4 bottom-0 opacity-40"
            />
            <div className="relative grid gap-3">
              {LEFT_SLOTS.map((slot) => (
                <EquipSlot
                  key={slot}
                  slot={slot}
                  item={worn.get(slot)}
                  onOpen={press}
                />
              ))}
            </div>
            <div className="relative flex justify-center">
              <HeroFigure />
            </div>
            <div className="relative grid gap-3">
              {RIGHT_SLOTS.map((slot) => (
                <EquipSlot
                  key={slot}
                  slot={slot}
                  item={worn.get(slot)}
                  onOpen={press}
                />
              ))}
            </div>
          </div>
          {inventory === null ? null : (
            <p className="mt-2 text-center text-xs text-text-muted">
              {t("arsenal.levelCap", { level: inventory.levelCap })}
            </p>
          )}

          <SectionTitle>{t("arsenal.inventory")}</SectionTitle>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Button
              variant="secondary"
              block
              disabled={bag.length < 2}
              onClick={() => setSort(sort === "rarity" ? "new" : "rarity")}
            >
              <ArrowDownUp size={18} aria-hidden="true" />
              {sort === "rarity"
                ? t("arsenal.sort.rarity")
                : t("arsenal.sort.new")}
            </Button>
            <Button
              variant={merging ? "primary" : "secondary"}
              block
              disabled={!merging && bag.length < MERGE_COUNT}
              onClick={() => {
                setMerging(!merging);
                setPicked([]);
                setError(null);
              }}
            >
              <Combine size={18} aria-hidden="true" />
              {merging ? t("arsenal.merge.cancel") : t("arsenal.merge")}
            </Button>
          </div>

          {merging ? (
            <div className="surface-sunken mb-3 grid gap-2 rounded-lg p-3 text-sm">
              <p className="text-text-muted">{t("arsenal.merge.hint")}</p>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-text">
                  {t("arsenal.merge.picked", { count: picked.length })}
                </span>
                {mergeCost === undefined || mergeRarity === null ? null : (
                  <CostLabel cost={mergeCost} rarity={mergeRarity} />
                )}
              </div>
              {error === null || openId !== null ? null : (
                <p role="alert" className="text-danger">
                  {error}
                </p>
              )}
              <Button
                block
                disabled={busy || picked.length !== MERGE_COUNT}
                onClick={() => void act({ kind: "merge", itemIds: picked })}
              >
                {t("arsenal.merge.confirm")}
              </Button>
            </div>
          ) : null}

          {status === "ready" && bag.length === 0 ? (
            <p className="surface-sunken rounded-lg px-3 py-4 text-center text-sm text-text-muted">
              {t("arsenal.empty")}
            </p>
          ) : (
            <ul className="grid grid-cols-5 gap-2">
              {bag.map((item) => (
                <li key={item.itemId}>
                  <ItemTile
                    item={item}
                    selected={picked.includes(item.itemId)}
                    dimmed={
                      merging &&
                      !picked.includes(item.itemId) &&
                      !mergeable(item, picked, items, inventory?.merge)
                    }
                    onPress={press}
                  />
                </li>
              ))}
            </ul>
          )}

          <ul className="mt-4 flex flex-wrap justify-center gap-x-3 gap-y-1">
            {RARITIES.map((rarity) => (
              <li
                key={rarity}
                className={`inline-flex items-center gap-1 text-xs font-semibold ${toneOf(rarity).text}`}
              >
                <span
                  aria-hidden="true"
                  className="size-2 rounded-full bg-current"
                />
                {rarityName(rarity)}
              </li>
            ))}
          </ul>
        </ContentColumn>
      </Screen>

      {open === undefined ? null : (
        <ItemSheet
          item={open}
          worn={worn.get(open.slot)}
          busy={busy}
          error={error}
          onAction={(action) => void act(action)}
          onClose={() => {
            setOpenId(null);
            setError(null);
          }}
        />
      )}
    </>
  );
}

/** Старшая редкость и высокий уровень — первыми; «новые» — как прислал сервер. */
function sorted(items: ItemView[], sort: Sort): ItemView[] {
  if (sort === "new") return items;
  return [...items].sort(
    (a, b) =>
      rarityRank(b.rarity) - rarityRank(a.rarity) ||
      b.level - a.level ||
      b.power - a.power,
  );
}

/** Можно ли добавить предмет к выбранным: та же редкость, и её объединение собирает. */
function mergeable(
  item: ItemView,
  picked: readonly string[],
  items: readonly ItemView[],
  costs: Record<string, unknown> | undefined,
): boolean {
  if (costs?.[item.rarity] === undefined) return false;
  const first = items.find((candidate) => candidate.itemId === picked[0]);
  return first === undefined || first.rarity === item.rarity;
}

function errorText(failure: ApiFailure, code: string | undefined): string {
  const key = `arsenal.error.${code ?? ""}`;
  if (code !== undefined && hasTranslation(key)) return t(key);
  return failure === "offline"
    ? t("arsenal.error.offline")
    : t("arsenal.error.generic");
}

function StatChip(props: {
  icon: ReactNode;
  label: string;
  value: string;
}): ReactNode {
  return (
    <div className="surface-sunken flex items-center gap-2 rounded-lg px-3 py-2">
      <span className="text-weapon">{props.icon}</span>
      <span className="text-xs text-text-muted">{props.label}</span>
      <span className="ml-auto font-display text-lg font-bold tabular-nums text-text">
        {props.value}
      </span>
    </div>
  );
}

/**
 * Персонаж в центре — силуэт из фигур, пока нет ассетов. Цвета — токены через
 * `currentColor`: смена стиля не требует править рисунок.
 */
function HeroFigure(): ReactNode {
  return (
    <svg
      viewBox="0 0 120 160"
      className="h-44 w-auto animate-float"
      aria-hidden="true"
    >
      <ellipse
        cx="60"
        cy="150"
        rx="38"
        ry="7"
        className="fill-current text-bg"
        opacity="0.6"
      />
      <path
        d="M30 70 Q60 60 90 70 L98 140 Q60 150 22 140 Z"
        className="fill-current text-accent-edge"
      />
      <path
        d="M36 72 Q60 64 84 72 L88 132 Q60 140 32 132 Z"
        className="fill-current text-surface-raised"
      />
      <path
        d="M60 68 V136"
        strokeWidth="3"
        className="stroke-current text-border-strong"
      />
      <circle
        cx="60"
        cy="42"
        r="28"
        className="fill-current text-surface-raised"
      />
      <path
        d="M36 38 Q60 22 84 38 L84 48 L36 48 Z"
        className="fill-current text-info"
      />
      <rect
        x="44"
        y="52"
        width="10"
        height="6"
        rx="2"
        className="fill-current text-text"
      />
      <rect
        x="66"
        y="52"
        width="10"
        height="6"
        rx="2"
        className="fill-current text-text"
      />
      <path
        d="M90 90 L112 66"
        strokeWidth="7"
        strokeLinecap="round"
        className="stroke-current text-weapon"
      />
    </svg>
  );
}
