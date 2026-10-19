/**
 * Счётчики забега, прочитанные из тела снимка мира без его восстановления.
 *
 * Оболочка засчитывает забег, снятый другой сборкой (tasks/T-0163): мир
 * такого снимка не восстановить — формат или контент уже другие, — но убийства
 * лежат в нём простыми числами. Сохранение прошлой сборки счётчиков в `summary`
 * не несёт, поэтому их берут отсюда.
 *
 * Путь `stats.scalars.*` стабилен между форматами мира 7 и 8: все числовые
 * поля пула статистики кладутся в `scalars` одним правилом (`encodeRecord` в
 * `game/run/snapshot.ts`), а `enemiesKilled` и `xpCollected` называются так же
 * в обеих сборках.
 *
 * Файл ничего не импортирует: он попадает в первую загрузку оболочки вместе с
 * `index.ts`, а тот не должен тянуть за собой движок и Phaser.
 */
export interface SnapshotCounters {
  enemiesKilled: number;
  xpCollected: number;
}

/** Счётчики забега из тела мира снимка. Не бросает: непригодное тело — нули. */
export function readSnapshotCounters(world: unknown): SnapshotCounters {
  const scalars = scalarsOf(world);
  const killed = scalars?.enemiesKilled;
  const xp = scalars?.xpCollected;
  return {
    enemiesKilled: typeof killed === "number" && Number.isFinite(killed) && killed > 0 ? Math.floor(killed) : 0,
    xpCollected: typeof xp === "number" && Number.isFinite(xp) && xp > 0 ? xp : 0,
  };
}

function scalarsOf(world: unknown): Record<string, unknown> | null {
  const stats = recordOf(recordOf(world)?.stats);
  return recordOf(stats?.scalars);
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
