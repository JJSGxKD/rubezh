import type { RateStore } from "../ports/store.js";
import { currentAcceptedRates } from "./collector.js";
import type { FreshnessRules } from "./freshness.js";
import { createSnapshot, type RateSnapshot } from "./snapshot.js";

/**
 * Снимок из хранилища: принятые с рынка и действующие заданные курсы на
 * момент. Сохраняется под своим идентификатором — цены и платежи ссылаются
 * на него, поэтому снимок не пересобирают, а читают по id.
 */
export interface MaterializeSnapshotInput {
  store: RateStore;
  id: string;
  now: number;
  freshness: FreshnessRules;
}

export async function materializeSnapshot(input: MaterializeSnapshotInput): Promise<RateSnapshot> {
  const accepted = await currentAcceptedRates(input.store, input.now);
  const snapshot = createSnapshot({ id: input.id, at: input.now, accepted, freshness: input.freshness });
  await input.store.saveSnapshot(snapshot);
  return snapshot;
}
