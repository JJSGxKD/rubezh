import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { Prisma } from "../../generated/prisma/client.js";
import { PRISMA } from "../../infra/database.js";
import type { AccountPlatform } from "../auth/access-token.js";
import type { DeviceClass } from "./client-class.js";
import type { StartKind } from "./start-param.js";

/**
 * Сессии и касания в Postgres (docs/34-stage3-plan.md, WP6). Запрос к базе
 * живёт здесь, а не в сервисе (docs/15-engineering-standards.md §2.3).
 */

/** Сессия — в виде, который переживает очередь: время строкой ISO. */
export interface SessionRecord {
  sessionId: string;
  accountId: string;
  platform: AccountPlatform;
  place: "miniapp" | "web" | "channel";
  startKind: StartKind;
  startParam: string | null;
  startRef: string | null;
  clientPlatform: string | null;
  clientVersion: string | null;
  deviceClass: DeviceClass;
  os: string;
  ipPrefix: string | null;
  startedAt: string;
}

export interface AcquisitionView {
  firstAt: Date;
  firstStartKind: StartKind;
  firstStartRef: string | null;
  lastSeenAt: Date;
  lastTouchAt: Date | null;
  lastStartKind: StartKind | null;
  lastStartRef: string | null;
}

export const SESSIONS_REPOSITORY = Symbol("SESSIONS_REPOSITORY");

export interface SessionsRepository {
  /** Записать сессию и пересчитать касания. Повтор той же сессии — не ошибка. */
  record(session: SessionRecord): Promise<"recorded" | "duplicate">;
  acquisition(accountId: string): Promise<AcquisitionView | null>;
}

@Injectable()
export class PrismaSessionsRepository implements SessionsRepository {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async record(session: SessionRecord): Promise<"recorded" | "duplicate"> {
    const startedAt = new Date(session.startedAt);
    // Касание — запуск по ссылке. Органический запуск последнее касание не трогает.
    const touch = session.startKind !== "organic";
    try {
      // Сессия и касания — одной транзакцией: половина записи хуже никакой.
      await this.prisma.$transaction([
        this.prisma.accountSession.create({
          data: {
            sessionId: session.sessionId,
            accountId: session.accountId,
            platform: session.platform,
            place: session.place,
            startKind: session.startKind,
            startParam: session.startParam,
            startRef: session.startRef,
            clientPlatform: session.clientPlatform,
            clientVersion: session.clientVersion,
            deviceClass: session.deviceClass,
            os: session.os,
            ipPrefix: session.ipPrefix,
            startedAt,
          },
        }),
        // Одна вставка с `ON CONFLICT` вместо блокировки строки: параллельные
        // сессии одного игрока сходятся в базе, а не в коде. Все выражения
        // `SET` видят строку до обновления, поэтому первое касание сравнивается
        // по старому `first_at`. Первым остаётся самое раннее: задание,
        // повторённое очередью позже соседнего, первое касание не перепишет.
        this.prisma.$executeRaw`
          INSERT INTO acquisition (
            account_id, first_at, first_start_kind, first_start_param, first_start_ref,
            first_client_platform, first_device_class, last_seen_at,
            last_touch_at, last_start_kind, last_start_param, last_start_ref
          ) VALUES (
            ${session.accountId}::uuid, ${startedAt}, ${session.startKind}::"StartKind", ${session.startParam}, ${session.startRef},
            ${session.clientPlatform}, ${session.deviceClass}::"DeviceClass", ${startedAt},
            ${touch ? startedAt : null}, ${touch ? session.startKind : null}::"StartKind",
            ${touch ? session.startParam : null}, ${touch ? session.startRef : null}
          )
          ON CONFLICT (account_id) DO UPDATE SET
            first_at = LEAST(acquisition.first_at, EXCLUDED.first_at),
            first_start_kind = CASE WHEN EXCLUDED.first_at < acquisition.first_at THEN EXCLUDED.first_start_kind ELSE acquisition.first_start_kind END,
            first_start_param = CASE WHEN EXCLUDED.first_at < acquisition.first_at THEN EXCLUDED.first_start_param ELSE acquisition.first_start_param END,
            first_start_ref = CASE WHEN EXCLUDED.first_at < acquisition.first_at THEN EXCLUDED.first_start_ref ELSE acquisition.first_start_ref END,
            first_client_platform = CASE WHEN EXCLUDED.first_at < acquisition.first_at THEN EXCLUDED.first_client_platform ELSE acquisition.first_client_platform END,
            first_device_class = CASE WHEN EXCLUDED.first_at < acquisition.first_at THEN EXCLUDED.first_device_class ELSE acquisition.first_device_class END,
            last_seen_at = GREATEST(acquisition.last_seen_at, EXCLUDED.last_seen_at),
            last_touch_at = CASE WHEN ${touch} AND (acquisition.last_touch_at IS NULL OR EXCLUDED.last_touch_at > acquisition.last_touch_at) THEN EXCLUDED.last_touch_at ELSE acquisition.last_touch_at END,
            last_start_kind = CASE WHEN ${touch} AND (acquisition.last_touch_at IS NULL OR EXCLUDED.last_touch_at > acquisition.last_touch_at) THEN EXCLUDED.last_start_kind ELSE acquisition.last_start_kind END,
            last_start_param = CASE WHEN ${touch} AND (acquisition.last_touch_at IS NULL OR EXCLUDED.last_touch_at > acquisition.last_touch_at) THEN EXCLUDED.last_start_param ELSE acquisition.last_start_param END,
            last_start_ref = CASE WHEN ${touch} AND (acquisition.last_touch_at IS NULL OR EXCLUDED.last_touch_at > acquisition.last_touch_at) THEN EXCLUDED.last_start_ref ELSE acquisition.last_start_ref END
        `,
      ]);
      return "recorded";
    } catch (error: unknown) {
      // Очередь повторила задание, которое уже записалось: первичный ключ
      // сессии не пустил вторую строку, а касания откатились вместе с ней.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return "duplicate";
      throw error;
    }
  }

  async acquisition(accountId: string): Promise<AcquisitionView | null> {
    return await this.prisma.acquisition.findUnique({
      where: { accountId },
      select: {
        firstAt: true,
        firstStartKind: true,
        firstStartRef: true,
        lastSeenAt: true,
        lastTouchAt: true,
        lastStartKind: true,
        lastStartRef: true,
      },
    });
  }
}
