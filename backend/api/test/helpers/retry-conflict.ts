import { Prisma } from "../../src/generated/prisma/client.js";

/**
 * Повтор запроса, который столкнулся с соседним тестом общей базы.
 *
 * Интеграционные файлы идут параллельно в одной базе (docs/17-testing-strategy.md §4.2).
 * Уборка в `afterAll` удаляет аккаунты с каскадом по десяткам таблиц, и Postgres иногда
 * снимает её как deadlock или конфликт записи (`P2034`). Транзакция при этом откатилась
 * сама, поэтому повторить безопасно; иначе уборка роняет файл, все кейсы которого прошли.
 */
export async function retryOnConflict<T>(run: () => Promise<T>, attempts = 5): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const conflict = error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
      if (!conflict || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}
