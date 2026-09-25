import { configFromEnvironment } from "../config/app-config.js";
import { createPrisma } from "../infra/database.js";
import { walletMismatches } from "../modules/wallet/wallet-reconcile.js";

/**
 * Сверка балансов кошелька с журналом (docs/35-stage4-plan.md, WP3).
 *
 *   pnpm --filter backend-api wallet:reconcile
 *
 * Только чтение. Код выхода 1 при расхождении — чтобы ночная проверка могла
 * поднять тревогу. В контейнере — `node dist/cli/wallet-reconcile.js`.
 */
async function main(): Promise<void> {
  const config = configFromEnvironment();
  if (config.databaseUrl === "") throw new Error("Нужен DATABASE_URL");
  const prisma = createPrisma(config);
  try {
    const mismatches = await walletMismatches(prisma);
    if (mismatches.length === 0) {
      console.log("балансы сходятся с журналом");
      return;
    }
    console.table(mismatches);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
