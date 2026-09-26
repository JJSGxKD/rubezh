import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { FlagRule } from "./flag-rollout.js";

/** Флаги в базе (docs/09-ci-cd.md §11). Их десятки — читаются целиком. */

export interface FlagRecord extends FlagRule {
  note: string | null;
  updatedBy: string | null;
  updatedAt: Date;
}

export const FLAGS_REPOSITORY = Symbol("FLAGS_REPOSITORY");

export interface FlagsRepository {
  all(): Promise<FlagRecord[]>;
  byKey(key: string): Promise<FlagRecord | null>;
  save(flag: FlagRule & { note: string | null; updatedBy: string }): Promise<FlagRecord>;
  remove(key: string): Promise<boolean>;
}

@Injectable()
export class PrismaFlagsRepository implements FlagsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async all(): Promise<FlagRecord[]> {
    return await this.prisma.featureFlag.findMany({ orderBy: { key: "asc" } });
  }

  async byKey(key: string): Promise<FlagRecord | null> {
    return await this.prisma.featureFlag.findUnique({ where: { key } });
  }

  async save(flag: FlagRule & { note: string | null; updatedBy: string }): Promise<FlagRecord> {
    const data = { enabled: flag.enabled, platforms: [...flag.platforms], percent: flag.percent, note: flag.note, updatedBy: flag.updatedBy };
    return await this.prisma.featureFlag.upsert({ where: { key: flag.key }, create: { key: flag.key, ...data }, update: data });
  }

  async remove(key: string): Promise<boolean> {
    const { count } = await this.prisma.featureFlag.deleteMany({ where: { key } });
    return count > 0;
  }
}
