import { draftArtAllowed, useDraftArtAllowed } from "./flags";
import { useGraphics } from "./graphics";

/**
 * Видит ли зритель арт обликов (tasks/T-0238, docs/35-stage4-plan.md Р143):
 * черновой арт разрешён флагом (`draftArtAllowed`) **и** игрок не выключил его
 * в «Графике». Облики — это арт: портреты, головы и экран «Облик» видит только
 * тот, у кого он включён; остальные — прежнюю фигуру, фото и инициалы.
 *
 * Отдельным маленьким модулем: его читает кружок аватара из первой загрузки.
 */
export function viewerArt(): boolean {
  return draftArtAllowed() && useGraphics.getState().art;
}

/** То же для экрана: меняется, когда пришли флаги или игрок переключил «Графику». */
export function useViewerArt(): boolean {
  const allowed = useDraftArtAllowed();
  const art = useGraphics((state) => state.art);
  return allowed && art;
}
