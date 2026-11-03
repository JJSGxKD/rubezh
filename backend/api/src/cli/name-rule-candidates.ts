import { pathToFileURL } from "node:url";
import { Redis } from "ioredis";
import { configFromEnvironment } from "../config/app-config.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { createPrisma } from "../infra/database.js";
import { PrismaNameRuleCandidatesRepository } from "../modules/name-rules/name-rule-candidates.repository.js";
import { NameRuleCandidatesService, type CandidateRunResult } from "../modules/name-rules/name-rule-candidates.service.js";

/**
 * Посчитать кандидатов в правила фильтра имён сразу, не дожидаясь ночи
 * (tasks/T-0341, Р168):
 *
 *   pnpm --filter backend-api names:candidates --dry-run   — посчитать и не писать
 *   pnpm --filter backend-api names:candidates             — посчитать и записать
 *
 * В контейнере — `node dist/cli/name-rule-candidates.js [--dry-run]`. Печатает
 * одну строку JSON с числами — слов в ней нет: они могут быть чужими брендами.
 * Идёт под тем же замком, что и ночное задание: пока оно считает, команда
 * отвечает `skipped`.
 */

export interface CandidatesArgs {
  dryRun: boolean;
}

export function parseCandidatesArgs(argv: readonly string[]): CandidatesArgs {
  const unknown = argv.filter((arg) => arg !== "--dry-run");
  if (unknown.length > 0) throw new Error(`Неизвестные параметры: ${unknown.join(" ")}. Допустим только --dry-run`);
  return { dryRun: argv.includes("--dry-run") };
}

export async function runCandidates(prisma: PrismaClient, redis: Redis, args: CandidatesArgs): Promise<CandidateRunResult> {
  return await new NameRuleCandidatesService(prisma, redis, new PrismaNameRuleCandidatesRepository(prisma)).run({ dryRun: args.dryRun });
}

async function main(): Promise<void> {
  const args = parseCandidatesArgs(process.argv.slice(2));
  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  if (config.redisUrl === "") throw new Error("Нужен REDIS_URL");
  const prisma = createPrisma(config);
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 1 });
  try {
    const result = await runCandidates(prisma, redis, args);
    console.log(JSON.stringify({ module: "names", event: "name_candidates_computed", dryRun: args.dryRun, status: result.status, scanned: result.scanned, kept: result.kept, capped: result.capped }));
  } finally {
    redis.disconnect();
    await prisma.$disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
