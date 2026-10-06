import type { FlagSplitGroup } from "../../src/modules/funnel/flag-split-report.js";

/** Пустая доля — у отчёта без единого игрока в ней. */
export const EMPTY_SPLIT_GROUP: FlagSplitGroup = {
  players: 0,
  d1Eligible: 0,
  d1Returned: 0,
  d7Eligible: 0,
  d7Returned: 0,
  payers: 0,
  stars: { sum: 0, sumSq: 0 },
  runs: { sum: 0, sumSq: 0 },
  interstitials: { sum: 0, sumSq: 0 },
  rewarded: { sum: 0, sumSq: 0 },
};
