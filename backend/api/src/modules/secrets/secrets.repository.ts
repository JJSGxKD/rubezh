import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { SealedSecret } from "./secret-cipher.js";

/** Ключи интеграций в базе (`integration_secret`) — только шифртекстом. Их единицы — читаются целиком. */

export interface StoredSecret extends SealedSecret {
  key: string;
  updatedBy: string | null;
  updatedAt: Date;
}

export const SECRETS_REPOSITORY = Symbol("SECRETS_REPOSITORY");

export interface SecretsRepository {
  all(): Promise<StoredSecret[]>;
  save(key: string, sealed: SealedSecret, updatedBy: string): Promise<StoredSecret>;
  /** Удалённая строка; `null` — её и не было. */
  remove(key: string): Promise<StoredSecret | null>;
}

@Injectable()
export class PrismaSecretsRepository implements SecretsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async all(): Promise<StoredSecret[]> {
    return await this.prisma.integrationSecret.findMany({ orderBy: { key: "asc" } });
  }

  async save(key: string, sealed: SealedSecret, updatedBy: string): Promise<StoredSecret> {
    const data = { keyId: sealed.keyId, iv: Uint8Array.from(sealed.iv), authTag: Uint8Array.from(sealed.authTag), ciphertext: Uint8Array.from(sealed.ciphertext), updatedBy };
    return await this.prisma.integrationSecret.upsert({ where: { key }, create: { key, ...data }, update: data });
  }

  async remove(key: string): Promise<StoredSecret | null> {
    const before = await this.prisma.integrationSecret.findUnique({ where: { key } });
    if (before === null) return null;
    const { count } = await this.prisma.integrationSecret.deleteMany({ where: { key } });
    return count > 0 ? before : null;
  }
}
