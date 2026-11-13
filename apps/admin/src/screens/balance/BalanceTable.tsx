import { Badge, Help } from "../../ui/kit";
import { HELP } from "../../ui/help";
import { errorLine } from "./balance-rules";
import { Cell, type CellContext } from "./balance-cells";
import { cellPaths, type RowModel, type TableModel } from "./balance-tables";

/**
 * Таблица раздела баланса (tasks/T-0304). Модель строит `balance-tables.ts`,
 * здесь — только вид: плотные строки, жёлтая черта у изменённой записи, под
 * записью с отказом сервера — красная строка с текстом и «Было {n}».
 */

/** Пояснения колонок: ключи из таблиц, тексты — общий словарь панели. */
const COLUMN_HELP: Readonly<Record<string, string>> = {
  hp: HELP.balance.hp,
  speed: HELP.balance.speed,
  damage: HELP.balance.damage,
  xp: HELP.balance.xp,
  threat: HELP.balance.threat,
  pattern: HELP.balance.pattern,
  resist: HELP.balance.resist,
  stageFrom: HELP.balance.stageFrom,
  stageWeight: HELP.balance.stageWeight,
  stageMul: HELP.balance.stageMul,
  segmentFrom: HELP.balance.segmentFrom,
  maxAlive: HELP.balance.maxAlive,
  spawnRate: HELP.balance.spawnRate,
  burst: HELP.balance.burst,
  events: HELP.balance.events,
  weaponDamage: HELP.balance.weaponDamage,
  cooldown: HELP.balance.cooldown,
  projectiles: HELP.balance.projectiles,
  pierce: HELP.balance.pierce,
  areaRadius: HELP.balance.areaRadius,
  projectileSpeed: HELP.balance.projectileSpeed,
  ttl: HELP.balance.ttl,
  statusChance: HELP.balance.statusChance,
  passiveCategory: HELP.balance.passiveCategory,
  passiveLevels: HELP.balance.passiveLevels,
  unlockSlots: HELP.balance.unlockSlots,
  difficultyMul: HELP.balance.difficultyMul,
};

/** Пояснения таблиц целиком — у заголовка над ней. */
const TABLE_HELP: Readonly<Record<string, string>> = {
  timeline: HELP.balance.timeline,
  endless: HELP.balance.endless,
  unlocks: HELP.balance.unlocks,
  drops: HELP.balance.drops,
  chests: HELP.balance.chests,
  levelCurve: HELP.balance.levelCurve,
  difficulty: HELP.balance.difficulty,
};

function Row({ row, columnCount, ctx }: { row: RowModel; columnCount: number; ctx: CellContext }) {
  if (row.heading === true) {
    return (
      <tr className="border-b border-border bg-surface-sunken">
        <th colSpan={columnCount} scope="colgroup" className="px-2 py-1.5 text-left text-sm font-semibold">
          <span className="inline-flex flex-wrap items-center gap-2">
            {row.title}
            {(row.badges ?? []).map((badge) => (
              <Badge key={badge} tone={badge.startsWith("эволюция") ? "accent" : "neutral"}>
                {badge}
              </Badge>
            ))}
          </span>
        </th>
      </tr>
    );
  }

  const paths = cellPaths(row);
  const edited = paths.some((path) => ctx.changes.has(path));
  const errors = paths.flatMap((path) => {
    const error = ctx.errors[path];
    return error === undefined ? [] : [{ path, error }];
  });
  return (
    <>
      <tr className={`border-b ${errors.length > 0 ? "border-danger/40" : "border-border/60"} ${edited ? "bg-warning/[0.04] shadow-[inset_3px_0_0_var(--color-warning)]" : ""}`}>
        <th scope="row" className="px-2 py-1.5 text-left font-normal">
          <span className="inline-flex flex-wrap items-center gap-1.5">
            {row.title}
            {(row.badges ?? []).map((badge) => (
              <Badge key={badge} tone="warning">
                {badge}
              </Badge>
            ))}
          </span>
        </th>
        {row.cells.map((cell, index) => (
          <td key={index} className="px-2 py-1 align-middle">
            <Cell cell={cell} ctx={ctx} />
          </td>
        ))}
      </tr>
      {errors.map(({ path, error }) => (
        <tr key={path} className="border-b border-danger/40">
          <td colSpan={columnCount} role="alert" className="px-2 pb-2 pl-6 text-xs text-danger">
            ✗ {errorLine(error)}
          </td>
        </tr>
      ))}
    </>
  );
}

export function BalanceTable({ model, ctx }: { model: TableModel; ctx: CellContext }) {
  const tableHelp = model.help === undefined ? undefined : TABLE_HELP[model.help];
  return (
    <section className="flex flex-col gap-2">
      {model.title === undefined ? null : (
        <h3 className="flex items-center gap-1.5 text-sm font-semibold">
          {model.title}
          {tableHelp === undefined ? null : <Help text={tableHelp} />}
        </h3>
      )}
      <div className="overflow-x-auto rounded-md border border-border bg-surface">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-text-muted">
              {model.columns.map((column) => {
                const help = column.help === undefined ? undefined : COLUMN_HELP[column.help];
                return (
                  <th key={column.key} scope="col" className="whitespace-nowrap px-2 py-1.5 font-medium">
                    <span className="inline-flex items-center gap-1">
                      {column.title}
                      {help === undefined ? null : <Help text={help} />}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <Row key={row.key} row={row} columnCount={model.columns.length} ctx={ctx} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
