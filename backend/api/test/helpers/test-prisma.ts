import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.js";
import { schemaOf } from "../../src/infra/database.js";

/**
 * Клиент Prisma для интеграционного теста — с той же схемой из адреса, что
 * `createPrisma`: исполнитель гоняет тесты в своей схеме тестовой базы
 * (`?schema=t0104`), и без неё тест читал бы `public` и чистил чужие таблицы.
 */
export function testPrisma(databaseUrl: string, max: number): PrismaClient {
  const schema = schemaOf(databaseUrl);
  const adapter = new PrismaPg(
    {
      connectionString: databaseUrl,
      max,
      connectionTimeoutMillis: 30_000,
      ...(schema === null ? {} : { options: `-c search_path=${schema}` }),
    },
    schema === null ? undefined : { schema },
  );
  return new PrismaClient({ adapter });
}
