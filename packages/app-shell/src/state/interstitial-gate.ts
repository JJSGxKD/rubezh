import { interstitialExpected } from "./ad-networks";
import type { BeforeNewRun } from "./run";
import { reportError, useShell } from "./shell";

/**
 * Межстраничная перед новым забегом (docs/35-stage4-plan.md WP12, часть 10)
 * — то, что экран забега отдаёт стору как `beforeNewRun`. Здесь, а не в
 * сторе: стор живёт в первой загрузке, а дорога к рекламе ей не нужна.
 *
 * Ждать нечего (`null`), если площадка не показывает рекламу сетей, игрок
 * не вошёл или, по словам сервера на запуске, он вне доли выката: забег
 * стартует сразу, без запроса. Так контрольная доля живёт как раньше, и
 * сравнение долей честное. Остальное — новичок, VIP, частота — решает
 * выдача. Чанк не пришёл или показ сломался — забег идёт без неё.
 */
export const interstitialBeforeNewRun: BeforeNewRun = (alive) => {
  const { adapter, capabilities } = useShell.getState();
  if (adapter.showAd === undefined || !capabilities.platformAvailable || capabilities.auth === undefined) return null;
  if (interstitialExpected() === false) return null;
  return import("./interstitial")
    .then(async ({ interstitialBeforeRun }) => await interstitialBeforeRun("run_start", alive))
    .catch((error: unknown) => {
      reportError("ads", `межстраничная: ${String(error)}`);
      return "skipped" as const;
    });
};
