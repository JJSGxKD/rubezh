import type { Audience, ContentPublishRepository } from "./content-publish.repository.js";

/**
 * Версия «из кода» после выката (docs/19-content-admin.md §4.5, tasks/T-0306):
 * выкат завёл её командой `content:import`, а становится ли она текущей —
 * решает то, что в игре сейчас.
 *
 * - Текущая версия тоже из кода (или никакой ещё нет — до первой публикации из
 *   панели): указатель идёт за кодом, как и раньше, когда контент жил только в
 *   репозитории.
 * - Текущая версия из панели: правки геймдизайнера новее кода, поэтому версия
 *   из кода только ставится рядом — её видно в «Истории» как «из кода — новое
 *   понятие», а поля сливает в черновик «Взять из кода».
 *
 * Решается у каждой аудитории отдельно: у команды может стоять версия из
 * панели, которую смотрят глазами, пока «всем» идёт за кодом.
 */
export async function adoptRepoVersion(repository: ContentPublishRepository, versionNo: number, now: Date): Promise<{ adopted: Audience[] }> {
  return { adopted: await repository.adopt(versionNo, now) };
}
