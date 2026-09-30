import { readFileSync } from "node:fs";
import { configFromEnvironment } from "../config/app-config.js";
import { createPrisma } from "../infra/database.js";
import { importDrafts, parseImportFile } from "../modules/changelog/changelog-import.js";
import { PrismaChangelogRepository } from "../modules/changelog/changelog.repository.js";
import { PrismaRolesRepository } from "../modules/roles/roles.repository.js";

/**
 * Черновики журнала обновлений из релиза (docs/35-stage4-plan.md WP31,
 * docs/09-ci-cd.md §10): выкат скачивает `changelog-<версия>.json` и отдаёт
 * его на вход.
 *
 *   node dist/cli/changelog-import.js < changelog-v0.6.0-rc.3.json      — в контейнере
 *   pnpm --filter backend-api changelog:import changelog.json          — локально
 *
 * Правила — `modules/changelog/changelog-import.ts`: черновиками, без дублей,
 * правленное человеком и удалённое не трогается.
 */

async function main(): Promise<void> {
  const path = process.argv[2];
  const entries = parseImportFile(readFileSync(path ?? 0, "utf8"));
  if (entries.length === 0) {
    console.log("журнал: строк для игроков в релизе нет");
    return;
  }

  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  const prisma = createPrisma(config);
  try {
    const roles = new PrismaRolesRepository(prisma);
    const summary = await importDrafts(new PrismaChangelogRepository(prisma), (entry) => roles.append(entry), entries);
    console.log(
      `журнал ${entries[0]?.version ?? ""}: заведено ${String(summary.created)}, поправлено ${String(summary.updated)}, ` +
        `без изменений ${String(summary.kept)}, удалено в панели ${String(summary.removed)}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
