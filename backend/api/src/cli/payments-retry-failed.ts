import { Queue } from "bullmq";
import { z } from "zod";
import { configFromEnvironment } from "../config/app-config.js";
import { createQueueConnection } from "../infra/queues.js";

/**
 * Повторить брошенные задания очереди оплаты (`payments`): то, что не прошло
 * все десять попыток и пришло команде сообщением «Задание оплаты брошено после
 * всех попыток». Задание повторяется целиком — запись оплаты идемпотентна по
 * идентификатору оплаты, выдача — по ключу покупки, так что повтор ничего не
 * удваивает. Брошенные задания очередь хранит (`removeOnFail: 1000`).
 *
 *   node dist/cli/payments-retry-failed.js            — показать, что повторится
 *   node dist/cli/payments-retry-failed.js --apply    — повторить
 *
 * Запускать после выката исправления причины, иначе задание снова упадёт.
 */

const QUEUE_NAME = "payments";
const LIMIT = 1000;

// Данные задания из Redis — граница системы: разбираем схемой, а не приведением.
const jobData = z
  .object({
    kind: z.string().catch("?"),
    payment: z.object({ payload: z.string() }).partial().optional().catch(undefined),
    order: z.object({ purchaseId: z.string() }).partial().optional().catch(undefined),
    chargeId: z.string().optional().catch(undefined),
  })
  .catch({ kind: "?" });

interface JobView {
  id: string;
  kind: string;
  purchaseId: string;
  failedReason: string;
}

function view(job: { id?: string; data: unknown; failedReason?: string }): JobView {
  const data = jobData.parse(job.data);
  return {
    id: job.id ?? "",
    kind: data.kind,
    purchaseId: data.payment?.payload ?? data.order?.purchaseId ?? data.chargeId ?? "",
    failedReason: (job.failedReason ?? "").split(/\r?\n/).find((line) => line.trim() !== "")?.slice(0, 120) ?? "",
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const config = configFromEnvironment();
  const connection = createQueueConnection(config, "worker");
  const queue = new Queue(QUEUE_NAME, { connection });
  try {
    const failed = await queue.getFailed(0, LIMIT - 1);
    if (failed.length === 0) {
      console.log("брошенных заданий оплаты нет");
      return;
    }
    console.table(failed.map(view));
    if (!apply) {
      console.log(`повторится заданий: ${String(failed.length)}. Запустите с --apply`);
      return;
    }
    for (const job of failed) {
      await job.retry("failed");
      console.log(`повторено: ${job.id ?? "?"}`);
    }
  } finally {
    await queue.close();
    connection.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
