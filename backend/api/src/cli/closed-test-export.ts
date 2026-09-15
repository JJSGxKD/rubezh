import { copyFile, mkdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { configFromEnvironment } from "../config/app-config.js";
import { createPrisma } from "../infra/database.js";
import { PrismaExportRepository } from "../modules/export/export.repository.js";
import { ExportService } from "../modules/export/export.service.js";

/**
 * Запасной путь выгрузки, если бот недоступен (docs/28-diagnostics.md §6):
 * тот же сервис, что у кнопки в боте, запускается внутри контейнера API.
 * Порт Postgres в проде не публикуется, и открывать его ради выгрузки нельзя.
 *
 *   pnpm closed-test:export -- --days 1
 *   pnpm closed-test:export -- --from 2026-09-01 --to 2026-09-15
 *   pnpm closed-test:export -- --all --out var/exports
 *
 * В контейнере — `node dist/cli/closed-test-export.js --days 7`.
 */
function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}

function periodFromArguments(now: Date): { from: Date | null; to: Date } {
  if (process.argv.includes("--all")) return { from: null, to: now };
  const days = argument("days");
  if (days !== null) {
    const count = Number(days);
    if (!Number.isInteger(count) || count <= 0) throw new Error("--days — целое число дней");
    return { from: new Date(now.getTime() - count * 24 * 60 * 60 * 1000), to: now };
  }
  const from = argument("from");
  const to = argument("to");
  if (from !== null) {
    const start = new Date(from);
    const end = to === null ? now : new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start >= end) throw new Error("--from и --to — даты ISO, начало раньше конца");
    return { from: start, to: end };
  }
  throw new Error("Укажите период: --days N, --from ДАТА [--to ДАТА] или --all");
}

async function main(): Promise<void> {
  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  const prisma = createPrisma(config);
  try {
    const service = new ExportService(config, new PrismaExportRepository(prisma));
    const artifact = await service.build({ period: periodFromArguments(new Date()), source: "cli", requestedBy: "cli" });
    try {
      const outDir = resolve(argument("out") ?? "var/exports");
      await mkdir(outDir, { recursive: true });
      for (const part of artifact.parts) await copyFile(part, resolve(outDir, basename(part)));
      await service.finish(artifact.exportId, {
        status: "sent",
        events: artifact.counts.events,
        reports: artifact.counts.reports,
        sizeBytes: artifact.sizeBytes,
        parts: artifact.parts.length,
        error: null,
      });
      console.log(
        [
          `Выгрузка ${artifact.exportId}: событий ${artifact.counts.events}, отчётов ${artifact.counts.reports}, забегов ${artifact.counts.runs}`,
          `Сборки: ${artifact.appVersions.join(", ") || "—"}`,
          ...artifact.parts.map((part) => `→ ${resolve(outDir, basename(part))}`),
        ].join("\n"),
      );
    } finally {
      await artifact.cleanup();
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
