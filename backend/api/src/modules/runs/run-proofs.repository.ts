import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

/**
 * Хранилище записей забегов для проверки (tasks/T-0317): одна строка на
 * забег, сжатые байты как есть. Запись — одним `INSERT … ON CONFLICT DO
 * NOTHING`: две одинаковые записи разом дают одну строку без ошибки уникальности.
 */

export const RUN_PROOFS_REPOSITORY = Symbol("RUN_PROOFS_REPOSITORY");

export interface StoredProof {
  proof: Uint8Array;
  receivedAt: Date;
  keepUntil: Date;
}

export interface RunProofsRepository {
  /** хэш контента забега этого аккаунта; `null` — забега нет или он чужой */
  ownRun(runId: string, accountId: string): Promise<{ contentHash: string } | null>;
  /** `true` — строка записана; `false` — запись к этому забегу уже есть */
  insert(runId: string, proof: Uint8Array, receivedAt: Date, keepUntil: Date): Promise<boolean>;
  find(runId: string): Promise<StoredProof | null>;
  /** удалить до `limit` просроченных записей, самые давние первыми; сколько удалено */
  deleteExpired(now: Date, limit: number): Promise<number>;
}

@Injectable()
export class PrismaRunProofsRepository implements RunProofsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async ownRun(runId: string, accountId: string): Promise<{ contentHash: string } | null> {
    return await this.prisma.run.findFirst({ where: { runId, accountId }, select: { contentHash: true } });
  }

  async insert(runId: string, proof: Uint8Array, receivedAt: Date, keepUntil: Date): Promise<boolean> {
    const inserted = await this.prisma.$executeRaw`
      INSERT INTO run_proof (run_id, proof, size_bytes, received_at, keep_until)
      VALUES (${runId}, ${proof}, ${proof.byteLength}, ${receivedAt}, ${keepUntil})
      ON CONFLICT (run_id) DO NOTHING`;
    return inserted > 0;
  }

  async find(runId: string): Promise<StoredProof | null> {
    const row = await this.prisma.runProof.findUnique({ where: { runId }, select: { proof: true, receivedAt: true, keepUntil: true } });
    return row;
  }

  async deleteExpired(now: Date, limit: number): Promise<number> {
    return await this.prisma.$executeRaw`
      DELETE FROM run_proof
      WHERE run_id IN (SELECT run_id FROM run_proof WHERE keep_until < ${now} ORDER BY keep_until LIMIT ${limit})`;
  }
}
