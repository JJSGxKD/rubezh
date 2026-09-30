import { z } from "zod";
import { PLATFORM_IDS } from "../../platforms/ports/platform.js";
import type { AuditEntry } from "../roles/roles.repository.js";
import { CHANGELOG_KINDS, CHANGELOG_TEXT_MAX, VERSION_PATTERN } from "./changelog-rules.js";
import type { ChangelogRepository, ImportOutcome, ImportedEntry } from "./changelog.repository.js";

/**
 * Черновики журнала обновлений из разделов «Для игроков» влитых PR
 * (docs/35-stage4-plan.md WP31). Файл собирает релизный джоб
 * (`scripts/release/player-notes.mjs`) и кладёт в релиз, выкат скачивает его
 * и отдаёт `cli/changelog-import.ts`.
 *
 * Строки заводятся черновиками — игрок их не видит, публикует человек в
 * панели: публикация пишет всем игрокам. Повтор того же файла ничего не
 * меняет; черновик, который правил человек, и опубликованная строка не
 * трогаются, удалённая в панели не возвращается.
 */

const fileSchema = z.object({
  version: z.string().regex(VERSION_PATTERN),
  entries: z
    .array(
      z.object({
        key: z.string().regex(/^pr-\d{1,7}-\d{1,3}$/),
        kind: z.enum(CHANGELOG_KINDS),
        platforms: z.array(z.enum(PLATFORM_IDS)).max(PLATFORM_IDS.length),
        text: z.string().trim().min(1).max(CHANGELOG_TEXT_MAX),
      }),
    )
    .max(500),
});

export type ChangelogImportFile = z.input<typeof fileSchema>;

export type ImportSummary = Record<ImportOutcome, number>;

/** Файл из релиза — граница: в базу уходит только то, что прошло схему. Мусор — исключение с причиной. */
export function parseImportFile(raw: string): ImportedEntry[] {
  const file = fileSchema.parse(JSON.parse(raw));
  return file.entries.map((entry) => ({ sourceKey: entry.key, version: file.version, kind: entry.kind, platforms: [...new Set(entry.platforms)], text: entry.text }));
}

/** Завести строки по одной и записать сводку в аудит от имени системы — если что-то изменилось. */
export async function importDrafts(
  repository: Pick<ChangelogRepository, "importDraft">,
  audit: (entry: AuditEntry) => Promise<void>,
  entries: readonly ImportedEntry[],
  now = new Date(),
): Promise<ImportSummary> {
  const summary: ImportSummary = { created: 0, updated: 0, kept: 0, removed: 0 };
  for (const entry of entries) summary[await repository.importDraft(entry, now)]++;
  if (summary.created + summary.updated > 0) {
    const versions = [...new Set(entries.map((entry) => entry.version))].join(", ");
    await audit({ actorAccountId: null, action: "changelog.import", target: versions, after: { ...summary, via: "deploy" } });
  }
  return summary;
}
