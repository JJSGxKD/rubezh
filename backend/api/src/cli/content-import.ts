import { configFromEnvironment } from "../config/app-config.js";
import { createPrisma } from "../infra/database.js";
import { ContentImportError, importContentVersion, parseContentExport, readContentExport } from "../modules/content/content-import.js";
import { PrismaContentRepository } from "../modules/content/content.repository.js";
import { PrismaRolesRepository } from "../modules/roles/roles.repository.js";

/**
 * Версия «из кода» из выгрузки контента (docs/19-content-admin.md §3,
 * tasks/T-0303): выкат кладёт файлы `pnpm content:export` рядом и вызывает
 * команду.
 *
 *   node dist/cli/content-import.js /srv/content                       — в контейнере, каталог выгрузки
 *   pnpm --filter backend-api content:import ../../dist/content-snapshot.json — локально, файл снимка
 *
 * Тот же хэш — ничего не меняется: выкат можно повторять. Новый хэш заводит
 * следующую версию с источником `repo`; сделать её текущей — дело публикации (T-0306).
 */

async function main(): Promise<void> {
  const argument = process.argv[2];
  if (argument === undefined || argument === "") throw new ContentImportError("Укажите каталог выгрузки или файл content-snapshot.json: content:import <путь>");
  const parsed = parseContentExport(readContentExport(argument));

  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  const prisma = createPrisma(config);
  try {
    const outcome = await importContentVersion(new PrismaContentRepository(prisma), parsed, new Date());
    if (outcome.created) {
      // Аудит пишет система, а не человек: версию заводит выкат.
      await new PrismaRolesRepository(prisma).append({
        actorAccountId: null,
        action: "content.version.import",
        target: String(outcome.versionNo),
        after: { contentHash: outcome.contentHash, source: "repo" },
      });
      console.log(`контент: заведена версия ${String(outcome.versionNo)} (хэш ${outcome.contentHash})`);
    } else {
      console.log(`контент: версия ${String(outcome.versionNo)} с хэшем ${outcome.contentHash} уже есть — ничего не менял`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
