import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";

export interface FeedbackRecord {
  feedbackId: string;
  installId: string;
  platformUserId: string | null;
  platform: "telegram" | "max" | "vk" | "web";
  appVersion: string;
  answers: Record<string, string>;
  text: string;
  runs: number;
}

export interface StoredFeedback extends FeedbackRecord {
  createdAt: Date;
}

export const FEEDBACK_REPOSITORY = Symbol("FEEDBACK_REPOSITORY");

export interface FeedbackRepository {
  insert(record: FeedbackRecord): Promise<void>;
  /** последние отзывы для выгрузки администратору, новые первыми */
  recent(limit: number): Promise<StoredFeedback[]>;
}

@Injectable()
export class PrismaFeedbackRepository implements FeedbackRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async insert(record: FeedbackRecord): Promise<void> {
    await this.prisma.feedback.create({ data: { ...record, answers: record.answers } });
  }

  async recent(limit: number): Promise<StoredFeedback[]> {
    const rows = await this.prisma.feedback.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    // JSON из базы — граница системы: ответы кладём как есть, но приводим к
    // строкам, а не доверяем типу `Json`.
    return rows.map((row) => ({
      feedbackId: row.feedbackId,
      installId: row.installId,
      platformUserId: row.platformUserId,
      platform: row.platform,
      appVersion: row.appVersion,
      answers: answersOf(row.answers),
      text: row.text,
      runs: row.runs,
      createdAt: row.createdAt,
    }));
  }
}

function answersOf(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      typeof item === "string" ? [[key, item] as const] : [],
    ),
  );
}
